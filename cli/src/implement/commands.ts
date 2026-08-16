import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../config";
import { readGateStatus } from "../gates/commands";
import { prelintPrd } from "../gates/prelint";
import { CHECK_TAIL_RENDER_MAX_CHARS, EVIDENCE_RENDER_MAX_CHARS, type CheckResult, type EvidenceMaterial } from "../gates/prompts";
import { runJudge, judgeCallRecordFrom } from "../judge/runner";
import { JudgeError, validateSemanticVerdict } from "../judge/types";
import { runDirRel } from "../runs/paths";
import { mechanicalBindings, parseImplementContract, reviewProfile, type ImplementContract } from "./contract";
import { acceptancePrompt, designPrompt, fidelityPrompt, fidelitySource, riskPrompt, type AcceptancePromptMaterial } from "./prompts";
import {
  artifactIntegrityProblems,
  captureBaselineSnapshot,
  captureSourceSnapshot,
  changedPathsSince,
  loadState,
  normalizeProjectPath,
  nowIso,
  persistState,
  sha256,
  statePathFor,
  writeActivePointer,
  writeJsonAtomic,
  writeTextAtomic,
} from "./store";
import {
  IMPLEMENT_SCHEMA,
  type AcceptanceCriterionInvocation,
  type AcLaneResult,
  type ContractItem,
  type DesignFinding,
  type FidelityCheckResult,
  type ImplementCommandResult,
  type ImplementState,
  type LaneRecord,
  type MechanicalBinding,
  type MechanicalRunRecord,
  type RegisteredArtifact,
  type RiskFinding,
  type TaskItem,
  type UnifiedVerificationAttempt,
  type VerificationItem,
  type VerificationStatus,
} from "./types";

export interface ImplementArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

const ARTIFACT_KINDS = new Set(["screenshot", "image", "browser", "api", "db", "log", "file", "command-log"]);

function result(action: string, ok: boolean, message: string, detail?: Record<string, unknown>): ImplementCommandResult {
  return { ok, action, exitCode: ok ? 0 : 1, message, ...(detail !== undefined ? { detail } : {}) };
}

/**
 * What a command response says about a verification attempt: the verdict, the
 * pins, and what still needs fixing - never the full lane transcripts. A raw
 * attempt measured 42,944 chars (~12k tokens) on a real 16-criterion run
 * because every PASS criterion carried its judge's full reasoning; those
 * transcripts stay in `state.json`, the only machine record (PRINCIPLES 10).
 * What survives here is the next-action information that keeps agents from
 * re-polling `status` between commands: failing criteria with reasons,
 * failing fidelity checks, blocking risk findings, mechanical runs, errors.
 */
function attemptSummary(attempt: UnifiedVerificationAttempt): Record<string, unknown> {
  const lane = <T>(record: LaneRecord<T> | null, slim: (laneResult: T) => Record<string, unknown>): Record<string, unknown> | null =>
    record === null
      ? null
      : {
          verdict: record.verdict,
          invocationId: record.invocationId,
          startedAt: record.startedAt,
          finishedAt: record.finishedAt,
          durationMs: record.durationMs,
          ...(record.reusedFrom !== undefined ? { reusedFrom: record.reusedFrom } : {}),
          ...(record.error !== null ? { error: record.error } : {}),
          ...(record.result !== null ? slim(record.result) : {}),
        };
  return {
    id: attempt.id,
    verdict: attempt.verdict,
    inputFingerprint: attempt.inputFingerprint,
    sourceFingerprint: attempt.sourceFingerprint,
    fidelityInput: attempt.fidelityInput,
    startedAt: attempt.startedAt,
    finishedAt: attempt.finishedAt,
    durationMs: attempt.durationMs,
    prelint: attempt.prelint,
    mechanical: attempt.mechanical,
    error: attempt.error,
    lanes: {
      acceptance: lane(attempt.lanes.acceptance, (laneResult) => ({
        criteriaCount: laneResult.criteria.length,
        failing: laneResult.criteria.filter((criterion) => criterion.verdict !== "PASS"),
      })),
      fidelity: lane(attempt.lanes.fidelity, (laneResult) => ({
        checkCount: laneResult.checks.length,
        failing: laneResult.checks.filter((check) => check.verdict !== "PASS"),
      })),
      risk: lane(attempt.lanes.risk, (laneResult) => ({
        blocking: laneResult.findings.filter((finding) => finding.severity === "blocking"),
        advisoryCount: laneResult.findings.filter((finding) => finding.severity === "advisory").length,
      })),
    },
  };
}

function flag(args: ImplementArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function requiredFlag(args: ImplementArgs, name: string): string {
  const value = flag(args, name);
  if (value === undefined || value.trim() === "") throw new Error(`missing required --${name} <value>`);
  return value;
}

function stateOptions(args: ImplementArgs): { slug?: string; state?: string } {
  const slug = flag(args, "slug");
  const state = flag(args, "state");
  return { ...(slug !== undefined ? { slug } : {}), ...(state !== undefined ? { state } : {}) };
}

function slugFromPrd(prdPath: string): string {
  const slug = path.basename(path.dirname(prdPath)).trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error(`PRD directory must be a lowercase slug: ${slug}`);
  return slug;
}

function inputFingerprint(
  state: ImplementState,
  sourceDigest: string,
  fidelityInput: UnifiedVerificationAttempt["fidelityInput"],
): string {
  // Command-produced artifacts (mechanical run logs) are the attempt's own
  // byproducts, not judgment inputs: their bytes carry per-run noise such as
  // timestamps, so including them makes the fingerprint unequal between two
  // attempts over an identical tree. The mechanical proof itself is compared
  // as [command, cwd, exitCode, status] wherever it matters.
  const artifacts = state.artifacts
    .filter((entry) => entry.command === undefined)
    .map((entry) => ({ verificationId: entry.verificationId, path: entry.path, sha256: entry.sha256, sourceFingerprint: entry.sourceFingerprint }))
    .sort((left, right) => `${left.verificationId}:${left.path}`.localeCompare(`${right.verificationId}:${right.path}`));
  return sha256(JSON.stringify({
    schema: state.schema,
    prdSha256: state.prd.sha256,
    sourceDigest,
    artifacts,
    tasks: state.tasks.map((entry) => [entry.id, entry.status]),
    deviations: state.deviations,
    fidelityInput,
  }));
}

interface VerificationBudgetView {
  fixAttempts: number;
  totalAttempts: number;
  budget: number;
  budgetExhausted: boolean;
  consecutiveErrors: number;
  judgeErrorLoop: boolean;
  grants: number;
}

function verificationBudget(state: ImplementState, budget: number): VerificationBudgetView {
  let fixAttempts = 0;
  let consecutiveErrors = 0;
  const grants = state.budgetGrants ?? [];
  // A recorded user grant opens a fresh budget: attempts before the latest
  // grant no longer count against either gauge.
  const countFrom = grants.length === 0 ? 0 : grants[grants.length - 1]!.attemptCountBefore;
  for (const attempt of state.verificationAttempts.slice(countFrom)) {
    if (attempt.verdict === "PASS") {
      fixAttempts = 0;
      consecutiveErrors = 0;
      continue;
    }
    if (attempt.verdict === "ERROR") {
      consecutiveErrors += 1;
      continue;
    }
    // Prelint is a free structural correction. Any other settled non-PASS
    // gave the implementation session something concrete to fix.
    if (attempt.error?.stage === "prelint") continue;
    fixAttempts += 1;
    consecutiveErrors = 0;
  }
  return {
    fixAttempts,
    totalAttempts: state.verificationAttempts.length,
    budget,
    budgetExhausted: fixAttempts > 0 && fixAttempts >= budget,
    consecutiveErrors,
    judgeErrorLoop: consecutiveErrors > 0 && consecutiveErrors >= budget,
    grants: grants.length,
  };
}

function terminalBudgetMessage(view: VerificationBudgetView): string | null {
  // Both terminal states name every honest exit: without them, sessions
  // improvise side doors (2026-08-13 creator-assist ran `gate verify --prd`
  // against an exhausted implement run, then archived state.json three times
  // to mint fresh runs when the user said to keep going).
  const exits = "close the run honestly with `sasu implement finalize --status blocked`, or, if the user explicitly approved more verification, record their words verbatim with `sasu implement verify --grant-budget \"<the user's words>\"`";
  if (view.budgetExhausted) {
    return `unified verification fix budget exhausted (${view.fixAttempts}/${view.budget}); ${exits}`;
  }
  if (view.judgeErrorLoop) {
    return `unified judge failed ${view.consecutiveErrors} times in a row without a verdict; ${exits}`;
  }
  return null;
}

function publicState(
  state: ImplementState,
  retryBudget: number,
  currentSourceDigest?: string,
  currentInputFingerprint?: string,
): Record<string, unknown> {
  const latest = state.verificationAttempts.at(-1) ?? null;
  const effectiveVerdict = latest === null
    ? "NOT_RUN"
    : (currentSourceDigest !== undefined && latest.sourceFingerprint !== currentSourceDigest)
        || (currentInputFingerprint !== undefined && latest.inputFingerprint !== currentInputFingerprint)
      ? "STALE"
      : latest.verdict;
  return {
    schema: state.schema,
    status: state.status,
    topicSlug: state.topicSlug,
    prdPath: state.prdPath,
    reviewProfile: state.prd.reviewProfile,
    counts: {
      tasksOpen: state.tasks.filter((entry) => entry.status !== "complete").length,
      acceptanceOpen: state.acceptanceCriteria.filter((entry) => entry.status !== "complete").length,
      verificationNotPassed: state.verification.filter((entry) => entry.requiredForDone && entry.status !== "PASS").length,
    },
    verification: {
      verdict: effectiveVerdict,
      attempts: state.verificationAttempts.length,
      budget: verificationBudget(state, retryBudget),
      latest: latest === null ? null : attemptSummary(latest),
    },
    artifacts: state.artifacts,
    completion: state.completion,
  };
}

function start(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  const config = loadConfig(projectRoot);
  const prdInput = requiredFlag(args, "prd");
  const prd = normalizeProjectPath(projectRoot, prdInput);
  if (!fs.existsSync(prd.absolute)) throw new Error(`PRD not found: ${prd.relative}`);
  const text = fs.readFileSync(prd.absolute, "utf8");
  const contract = parseImplementContract(text);
  if ((contract.frontmatter["status"] ?? "") !== "ready") throw new Error(`PRD status must be ready, got ${contract.frontmatter["status"] ?? "missing"}`);
  const frontmatterApproval = (contract.frontmatter["human_approval"] ?? "").toLowerCase();
  const approval = flag(args, "allow-unapproved-prd")?.trim() ?? "";
  if (frontmatterApproval !== "approved" && approval === "") {
    throw new Error("PRD human_approval is pending; pass --allow-unapproved-prd with the user's verbatim approval");
  }
  if (contract.tasks.length === 0 || contract.acceptanceCriteria.length === 0 || contract.verification.length === 0) {
    throw new Error("PRD is missing tasks, acceptance criteria, or verification items");
  }
  const slug = slugFromPrd(prd.absolute);
  const statePath = statePathFor(projectRoot, slug);
  if (fs.existsSync(statePath)) {
    let existingSchema = "unknown";
    try {
      existingSchema = String((JSON.parse(fs.readFileSync(statePath, "utf8")) as { schema?: unknown }).schema ?? "missing");
    } catch {
      existingSchema = "malformed";
    }
    throw new Error(`implement state already exists for ${slug} (${existingSchema}); choose a new slug or remove the obsolete run explicitly`);
  }
  const createdAt = nowIso();
  const state: ImplementState = {
    schema: IMPLEMENT_SCHEMA,
    status: "active",
    topicSlug: slug,
    projectRoot,
    runDir: runDirRel(slug),
    prdPath: prd.relative,
    prd: {
      sha256: sha256(text),
      status: contract.frontmatter["status"] ?? null,
      approval: frontmatterApproval === "approved"
        ? { source: "frontmatter", evidence: "human_approval: approved" }
        : { source: "conversation", evidence: approval },
      reviewProfile: reviewProfile(contract),
      reviewRationale: contract.frontmatter["review_rationale"] ?? "",
      sourceIntake: contract.frontmatter["source_intake"] ?? "",
    },
    initialSource: captureBaselineSnapshot(projectRoot),
    tasks: contract.tasks,
    requirements: contract.requirements,
    acceptanceCriteria: contract.acceptanceCriteria,
    verification: contract.verification,
    artifacts: [],
    verificationAttempts: [],
    budgetGrants: [],
    deviations: [],
    completion: null,
    createdAt,
    updatedAt: createdAt,
  };
  fs.mkdirSync(path.join(projectRoot, state.runDir, "artifacts", "logs"), { recursive: true });
  writeJsonAtomic(statePath, state);
  writeActivePointer(projectRoot, state);
  return result("start", true, `implement run started: ${slug}`, publicState(state, config.judge.retryBudget));
}

function task(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  const config = loadConfig(projectRoot);
  const { statePath, state } = loadState(projectRoot, stateOptions(args));
  if (state.status === "complete") throw new Error("implement run is already complete");
  const id = requiredFlag(args, "id").toUpperCase();
  const nextStatus = flag(args, "status") ?? "complete";
  if (nextStatus !== "complete" && nextStatus !== "pending" && nextStatus !== "blocked") {
    throw new Error("--status must be complete, pending, or blocked");
  }
  const item = state.tasks.find((entry) => entry.id === id);
  if (item === undefined) throw new Error(`unknown task: ${id}`);
  const evidence = flag(args, "evidence")?.trim() ?? "";
  if (nextStatus !== "pending" && evidence === "") throw new Error("--evidence is required when closing or blocking a task");
  if (nextStatus === "complete") {
    const byId = new Map(state.tasks.map((entry) => [entry.id, entry]));
    const openDeps = item.dependsOn.filter((dep) => byId.get(dep)?.status !== "complete");
    if (openDeps.length > 0) throw new Error(`cannot close ${id}: depends on ${openDeps.join(", ")} (not complete)`);
  }
  item.status = nextStatus;
  if (evidence !== "" && !item.evidence.some((entry) => entry.text === evidence)) item.evidence.push({ at: nowIso(), text: evidence });
  persistState(statePath, state);
  const complete = new Set(state.tasks.filter((entry) => entry.status === "complete").map((entry) => entry.id));
  const remaining = state.tasks.filter((entry) => entry.status !== "complete");
  const describe = (entry: TaskItem): string => {
    const waits = entry.dependsOn.filter((dep) => !complete.has(dep));
    const note = entry.status === "blocked" ? "blocked" : waits.length === 0 ? "ready" : `waiting on ${waits.join(", ")}`;
    // The recorded title is the full task text; the one-line response only
    // needs the leading description, not the Covers/Depends on clauses.
    const label = entry.title.split(". ")[0]!.replace(/\.$/, "");
    return `${entry.id} (${label}, ${note})`;
  };
  const remainingLine = remaining.length === 0
    ? "remaining: none - all tasks closed"
    : `remaining: ${remaining.map(describe).join(", ")}`;
  return result("task", true, `${id} is ${nextStatus}; ${remainingLine}`, {
    ...publicState(state, config.judge.retryBudget),
    remainingTasks: remaining.map((entry) => ({
      id: entry.id,
      title: entry.title,
      status: entry.status,
      dependsOn: entry.dependsOn,
      ready: entry.status !== "blocked" && entry.dependsOn.every((dep) => complete.has(dep)),
    })),
  });
}

function inspectArtifactFile(absolute: string, kind: string): { sha256: string; bytes: number } {
  if (!fs.existsSync(absolute)) throw new Error(`artifact not found: ${absolute}`);
  const stat = fs.statSync(absolute);
  if (!stat.isFile() || stat.size <= 0) throw new Error(`artifact must be a non-empty file: ${absolute}`);
  const buffer = fs.readFileSync(absolute);
  if (kind === "screenshot" || kind === "image") {
    const png = buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const jpeg = buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer.at(-2) === 0xff && buffer.at(-1) === 0xd9;
    if (!png && !jpeg) throw new Error("image artifact must contain valid PNG or JPEG bytes");
  }
  return { sha256: sha256(buffer), bytes: stat.size };
}

function artifact(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  const { statePath, state } = loadState(projectRoot, stateOptions(args));
  if (state.status === "complete") throw new Error("implement run is already complete");
  const verificationId = requiredFlag(args, "id").toUpperCase();
  if (!state.verification.some((entry) => entry.id === verificationId)) throw new Error(`unknown verification item: ${verificationId}`);
  const kind = requiredFlag(args, "kind").toLowerCase();
  if (!ARTIFACT_KINDS.has(kind) || kind === "command-log") throw new Error(`--kind must be one of: screenshot, image, browser, api, db, log, file`);
  const target = normalizeProjectPath(projectRoot, requiredFlag(args, "path"));
  const description = requiredFlag(args, "description").trim();
  const inspected = inspectArtifactFile(target.absolute, kind);
  const source = captureSourceSnapshot(projectRoot);
  const previous = state.artifacts.find((entry) => entry.verificationId === verificationId && entry.path === target.relative);
  const registered: RegisteredArtifact = {
    verificationId,
    kind,
    path: target.relative,
    description,
    ...inspected,
    sourceFingerprint: source.digest,
    registeredAt:
      previous !== undefined && previous.sha256 === inspected.sha256 && previous.sourceFingerprint === source.digest
        ? previous.registeredAt
        : nowIso(),
  };
  state.artifacts = state.artifacts.filter((entry) => !(entry.verificationId === verificationId && entry.path === target.relative));
  state.artifacts.push(registered);
  persistState(statePath, state);
  return result("artifact", true, `artifact registered for ${verificationId}: ${target.relative}`, { artifact: registered });
}

function status(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  const config = loadConfig(projectRoot);
  const { state } = loadState(projectRoot, stateOptions(args));
  const source = captureSourceSnapshot(projectRoot);
  const problems = artifactIntegrityProblems(projectRoot, state, source);
  const prdAbsolute = normalizeProjectPath(projectRoot, state.prdPath).absolute;
  if (!fs.existsSync(prdAbsolute)) throw new Error(`PRD missing: ${state.prdPath}`);
  const prdText = fs.readFileSync(prdAbsolute, "utf8");
  const prdStale = sha256(prdText) !== state.prd.sha256;
  const contract = parseImplementContract(prdText);
  const sourceContext = fidelitySource(projectRoot, contract, specGateIsFresh(projectRoot, state));
  const fidelityInput = { routing: sourceContext.routing, contentSha256: sha256(sourceContext.content) };
  const currentInput = inputFingerprint(state, source.digest, fidelityInput);
  return result("status", true, `${state.topicSlug}: ${state.status}`, {
    ...publicState(state, config.judge.retryBudget, source.digest, prdStale ? "PRD_STALE" : currentInput),
    artifactProblems: problems,
    prdProblem: prdStale ? "PRD changed after implement start" : null,
  });
}

function writeMechanicalLog(
  projectRoot: string,
  state: ImplementState,
  binding: MechanicalBinding,
  run: Omit<MechanicalRunRecord, "logPath">,
  stdout: string,
  stderr: string,
): string {
  const key = sha256(`${binding.cwd}\0${binding.command}`).slice(0, 16);
  const relative = `${state.runDir}/artifacts/logs/mechanical-${key}.log`;
  const absolute = path.join(projectRoot, relative);
  writeTextAtomic(absolute, [
    `command: ${binding.command}`,
    `cwd: ${binding.cwd}`,
    `startedAt: ${run.startedAt}`,
    `finishedAt: ${run.finishedAt}`,
    `durationMs: ${run.durationMs}`,
    `exitCode: ${run.exitCode}`,
    `verificationIds: ${binding.verificationIds.join(",")}`,
    "",
    "--- stdout ---",
    stdout,
    "",
    "--- stderr ---",
    stderr,
    "",
  ].join("\n"));
  return relative;
}

function upsertCommandArtifacts(state: ImplementState, run: MechanicalRunRecord, sourceFingerprint: string, projectRoot: string): void {
  const inspected = inspectArtifactFile(path.join(projectRoot, run.logPath), "log");
  for (const verificationId of run.verificationIds) {
    const artifact: RegisteredArtifact = {
      verificationId,
      kind: "command-log",
      path: run.logPath,
      description: `mechanical ${run.status}: ${run.command}`,
      ...inspected,
      sourceFingerprint,
      registeredAt: run.finishedAt,
      command: run.command,
      cwd: run.cwd,
      exitCode: run.exitCode,
    };
    state.artifacts = state.artifacts.filter((entry) => !(entry.verificationId === verificationId && entry.command === run.command && entry.cwd === run.cwd));
    state.artifacts.push(artifact);
  }
}

// Progress lines go to stderr so --json stdout stays parseable. Verify runs
// minutes of judge work; silent, it forces callers to invent their own
// polling (2026-08-13 creator-assist: 31 minutes of agent wall-clock spent on
// nohup + sleep + ps loops watching an opaque verify).
function progress(line: string): void {
  process.stderr.write(`[implement:verify] ${line}\n`);
}

function runMechanicalBindings(projectRoot: string, state: ImplementState, bindings: MechanicalBinding[], sourceFingerprint: string): MechanicalRunRecord[] {
  const records: MechanicalRunRecord[] = [];
  const timeoutMs = loadConfig(projectRoot).verify.commandTimeoutMs;
  for (const binding of bindings) {
    const before = captureSourceSnapshot(projectRoot);
    const started = Date.now();
    const startedAt = nowIso();
    const commandCwd = normalizeProjectPath(projectRoot, binding.cwd).absolute;
    const executed = spawnSync(binding.command, {
      cwd: commandCwd,
      shell: true,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: timeoutMs,
      env: process.env,
    });
    const after = captureSourceSnapshot(projectRoot);
    const timedOut = (executed.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || executed.signal === "SIGTERM";
    const mutated = before.digest !== after.digest;
    const exitCode = timedOut ? 124 : (executed.status ?? 1);
    const finishedAt = nowIso();
    const base: Omit<MechanicalRunRecord, "logPath"> = {
      ...binding,
      startedAt,
      finishedAt,
      durationMs: Date.now() - started,
      exitCode: mutated && exitCode === 0 ? 1 : exitCode,
      status: !timedOut && !mutated && exitCode === 0 ? "PASS" : "FAIL",
    };
    const extra = [
      timedOut ? `\n[sasu] command timed out after ${timeoutMs}ms` : "",
      mutated ? "\n[sasu] command changed judged source files and was rejected" : "",
    ].join("");
    const logPath = writeMechanicalLog(projectRoot, state, binding, base, executed.stdout ?? "", `${executed.stderr ?? ""}${extra}`);
    const record: MechanicalRunRecord = { ...base, logPath };
    progress(`mechanical ${record.status} in ${(record.durationMs / 1000).toFixed(1)}s: ${record.command}`);
    records.push(record);
    upsertCommandArtifacts(state, record, sourceFingerprint, projectRoot);
    if (record.status === "FAIL") break;
  }
  return records;
}

function changeMaterial(projectRoot: string, state: ImplementState, current: ReturnType<typeof captureSourceSnapshot>): string {
  const paths = changedPathsSince(state.initialSource, current);
  if (paths.length === 0) return "No run-owned source changes were detected.";
  const sections: string[] = [`Changed paths since implement start:\n${paths.map((entry) => `- ${entry}`).join("\n")}`];
  for (const relative of paths) {
    const absolute = path.join(projectRoot, relative);
    if (!fs.existsSync(absolute)) {
      sections.push(`FILE ${relative}\n[deleted]`);
      continue;
    }
    const buffer = fs.readFileSync(absolute);
    if (buffer.includes(0)) {
      sections.push(`FILE ${relative}\n[binary ${buffer.length} bytes]`);
      continue;
    }
    const text = buffer.toString("utf8");
    sections.push(`FILE ${relative}\n${text.length > 24_000 ? `${text.slice(0, 12_000)}\n[... truncated ...]\n${text.slice(-12_000)}` : text}`);
  }
  return sections.join("\n\n");
}

function changedFileManifest(projectRoot: string, paths: string[]): string {
  if (paths.length === 0) return "- none";
  return paths.map((relative) => {
    const absolute = path.join(projectRoot, relative);
    if (!fs.existsSync(absolute)) return `- ${relative} [deleted]`;
    const buffer = fs.readFileSync(absolute);
    return `- ${relative} [${buffer.includes(0) ? "binary" : "text"}, ${buffer.length} bytes]`;
  }).join("\n");
}

function boundedExcerpt(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  const marker = `\n\n[... ${text.length - limit} chars omitted by sasu ...]\n\n`;
  const side = Math.max(1, Math.floor((limit - marker.length) / 2));
  return { text: `${text.slice(0, side)}${marker}${text.slice(-side)}`, truncated: true };
}

function isImageBytes(buffer: Buffer): boolean {
  const png = buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer.at(-2) === 0xff && buffer.at(-1) === 0xd9;
  return png || jpeg;
}

function acceptanceMaterial(
  projectRoot: string,
  state: ImplementState,
  criterion: ContractItem,
  changedFiles: string,
  runs: MechanicalRunRecord[],
  scenarios: ContractItem[],
): AcceptancePromptMaterial {
  const coveringRows = state.verification.filter((entry) => entry.covers.includes(criterion.id));
  const verificationIds = new Set(coveringRows.map((entry) => entry.id));
  // Scenario cards travel with the criterion: the cards a V row covers are
  // judged alongside every criterion that same row covers. Derived from the
  // pinned PRD at verify time, never persisted in state.
  const coveredScenarioIds = new Set(coveringRows.flatMap((entry) => entry.covers.filter((id) => id.startsWith("SC"))));
  const mappedScenarios = scenarios.filter((entry) => coveredScenarioIds.has(entry.id));
  const checks: CheckResult[] = runs
    .filter((run) => run.verificationIds.some((id) => verificationIds.has(id)))
    .map((run) => {
      const log = fs.readFileSync(path.join(projectRoot, run.logPath), "utf8");
      const tail = boundedExcerpt(log, CHECK_TAIL_RENDER_MAX_CHARS);
      return {
        criterionId: criterion.id,
        command: run.command,
        exitCode: run.exitCode,
        tail: tail.text,
        provenance: `the harness ran \`${run.command}\` at ${run.startedAt} from cwd=${run.cwd}; recorded log=${run.logPath}`,
      };
    });
  const evidence: EvidenceMaterial[] = [];
  const readableArtifacts: AcceptancePromptMaterial["readableArtifacts"] = [];
  for (const artifact of state.artifacts.filter(
    (entry) => entry.command === undefined && verificationIds.has(entry.verificationId),
  )) {
    const absolute = normalizeProjectPath(projectRoot, artifact.path).absolute;
    const buffer = fs.readFileSync(absolute);
    if (isImageBytes(buffer)) {
      readableArtifacts.push({
        path: artifact.path,
        kind: artifact.kind,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
        description: artifact.description,
      });
      continue;
    }
    if (buffer.includes(0)) {
      throw new Error(`${criterion.id}: registered artifact is binary but not a PNG or JPEG the judge can inspect: ${artifact.path}`);
    }
    const excerpt = boundedExcerpt(buffer.toString("utf8"), EVIDENCE_RENDER_MAX_CHARS);
    evidence.push({
      criterionId: criterion.id,
      path: artifact.path,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
      text: excerpt.text,
      provenance: `registered by the implementing session at ${artifact.registeredAt}; hash-pinned by the harness; description: ${artifact.description}`,
      ...(excerpt.truncated ? { truncated: true } : {}),
    });
  }
  return { changedFiles, checks, evidence, readableArtifacts, scenarios: mappedScenarios };
}

function validateFidelity(value: unknown): { verdict: "PASS" | "FAIL"; checks: FidelityCheckResult[] } | string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "output is not an object";
  const raw = value as { verdict?: unknown; checks?: unknown };
  if (raw.verdict !== "PASS" && raw.verdict !== "FAIL") return "verdict must be PASS or FAIL";
  if (!Array.isArray(raw.checks)) return "checks must be an array";
  const expected = ["F1", "F2", "F3", "F4", "F5"];
  const checks: FidelityCheckResult[] = [];
  for (const [index, entry] of raw.checks.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return `checks[${index}] is not an object`;
    const check = entry as Record<string, unknown>;
    if (!expected.includes(String(check["id"]))) return `checks[${index}].id must be F1 through F5`;
    if (check["verdict"] !== "PASS" && check["verdict"] !== "FAIL") return `checks[${index}].verdict must be PASS or FAIL`;
    if (typeof check["reason"] !== "string" || typeof check["evidence"] !== "string") return `checks[${index}] needs reason and evidence strings`;
    checks.push({
      id: check["id"] as FidelityCheckResult["id"],
      verdict: check["verdict"],
      reason: check["reason"],
      evidence: check["evidence"],
    });
  }
  if (new Set(checks.map((entry) => entry.id)).size !== 5 || expected.some((id) => !checks.some((entry) => entry.id === id))) {
    return "checks must contain F1 through F5 exactly once";
  }
  const anyFail = checks.some((entry) => entry.verdict === "FAIL");
  if ((raw.verdict === "PASS") === anyFail) return "top-level verdict contradicts checks";
  return { verdict: raw.verdict, checks };
}

function validateDesign(value: unknown): { verdict: "PASS" | "FAIL"; findings: DesignFinding[] } | string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "output is not an object";
  const raw = value as { verdict?: unknown; findings?: unknown };
  if (raw.verdict !== "PASS") return "the design lane is advisory: verdict must be PASS";
  if (!Array.isArray(raw.findings)) return "findings must be an array";
  const findings: DesignFinding[] = [];
  for (const [index, entry] of raw.findings.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return `findings[${index}] must be an object`;
    const finding = entry as Record<string, unknown>;
    if (typeof finding["area"] !== "string" || finding["area"].trim() === "") return `findings[${index}].area must be a non-empty string`;
    if (typeof finding["text"] !== "string" || finding["text"].trim() === "") return `findings[${index}].text must be a non-empty string`;
    if (typeof finding["suggestion"] !== "string") return `findings[${index}].suggestion must be a string`;
    findings.push({ area: finding["area"], text: finding["text"], suggestion: finding["suggestion"] });
  }
  return { verdict: "PASS", findings };
}

function validateRisk(value: unknown): { verdict: "PASS" | "FAIL"; findings: RiskFinding[] } | string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "output is not an object";
  const raw = value as { verdict?: unknown; findings?: unknown };
  if (raw.verdict !== "PASS" && raw.verdict !== "FAIL") return "verdict must be PASS or FAIL";
  if (!Array.isArray(raw.findings)) return "findings must be an array";
  const findings: RiskFinding[] = [];
  for (const [index, entry] of raw.findings.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return `findings[${index}] must be an object with severity and text`;
    }
    const finding = entry as Record<string, unknown>;
    if (finding["severity"] !== "blocking" && finding["severity"] !== "advisory") {
      return `findings[${index}].severity must be blocking or advisory`;
    }
    if (typeof finding["text"] !== "string" || finding["text"].trim() === "") {
      return `findings[${index}].text must be a non-empty string`;
    }
    findings.push({ severity: finding["severity"], text: finding["text"] });
  }
  // The verdict is a pure function of the severity floor, never a separate
  // judgment: FAIL means at least one blocking finding, PASS means none.
  const blocking = findings.some((entry) => entry.severity === "blocking");
  if (raw.verdict === "PASS" && blocking) return "PASS cannot carry a blocking finding";
  if (raw.verdict === "FAIL" && !blocking) return "FAIL requires at least one blocking finding";
  return { verdict: raw.verdict, findings };
}

async function judgeLane<T>(
  invocationId: string,
  run: () => Promise<{ value: T; record: LaneRecord<T>["judge"] }>,
): Promise<LaneRecord<T>> {
  const started = Date.now();
  const startedAt = nowIso();
  try {
    const outcome = await run();
    const value = outcome.value as T & { verdict?: string };
    const verdict: VerificationStatus = value.verdict === "PASS" ? "PASS" : "FAIL";
    return {
      invocationId,
      startedAt,
      finishedAt: nowIso(),
      durationMs: Date.now() - started,
      verdict,
      result: outcome.value,
      judge: outcome.record,
      error: null,
    };
  } catch (error) {
    const code = error instanceof JudgeError ? error.code : "judge-runtime";
    return {
      invocationId,
      startedAt,
      finishedAt: nowIso(),
      durationMs: Date.now() - started,
      verdict: "ERROR",
      result: null,
      judge: judgeCallRecordFrom(error),
      error: { code, message: error instanceof Error ? error.message : String(error) },
    };
  }
}

/**
 * A settled judge verdict is a pure function of its pinned inputs: the PRD
 * (prdSha256), the judged tree (sourceFingerprint), the registered artifacts
 * (per-artifact sha256 inside inputFingerprint), and the fidelity source.
 * Mechanical log text is the one unpinned input a criterion prompt carries,
 * so reuse additionally requires the mechanical commands to have re-run with
 * identical outcomes; residual log noise (timestamps, durations) cannot
 * change which commands passed. Reuse is limited to the immediately
 * preceding ERROR'd attempt: 2026-08-13 creator-assist, one criterion's
 * judge timeout discarded 21 settled verdicts and the full re-judgment
 * spent budget wall-clock on infrastructure instead of on the two real
 * findings.
 */
function reusableErrorAttempt(
  state: ImplementState,
  currentInputFingerprint: string,
  sourceDigest: string,
  mechanical: MechanicalRunRecord[],
): UnifiedVerificationAttempt | null {
  const prior = state.verificationAttempts.at(-1);
  if (prior === undefined || prior.verdict !== "ERROR") return null;
  if (prior.inputFingerprint !== currentInputFingerprint || prior.sourceFingerprint !== sourceDigest) return null;
  const outcomes = (runs: MechanicalRunRecord[]) =>
    JSON.stringify(runs.map((run) => [run.command, run.cwd, run.exitCode, run.status]));
  if (outcomes(prior.mechanical) !== outcomes(mechanical)) return null;
  return prior;
}

function settledAcceptanceInvocations(
  attempt: UnifiedVerificationAttempt,
): Map<string, { invocation: AcceptanceCriterionInvocation; criteria: AcLaneResult[] }> {
  const settled = new Map<string, { invocation: AcceptanceCriterionInvocation; criteria: AcLaneResult[] }>();
  const lane = attempt.lanes.acceptance;
  if (lane === null || lane.result === null) return settled;
  for (const invocation of lane.result.invocations) {
    if (invocation.verdict === "ERROR") continue;
    const criteria = lane.result.criteria.filter((entry) => entry.id === invocation.criterionId);
    if (criteria.length > 0) settled.set(invocation.criterionId, { invocation, criteria });
  }
  return settled;
}

async function acceptanceLane(
  config: ReturnType<typeof loadConfig>,
  projectRoot: string,
  state: ImplementState,
  scenarios: ContractItem[],
  changedFiles: string,
  changedPaths: string[],
  mechanical: MechanicalRunRecord[],
  reuse: UnifiedVerificationAttempt | null,
): Promise<NonNullable<UnifiedVerificationAttempt["lanes"]["acceptance"]>> {
  const invocationId = crypto.randomUUID();
  const started = Date.now();
  const startedAt = nowIso();
  const settled = reuse === null
    ? new Map<string, { invocation: AcceptanceCriterionInvocation; criteria: AcLaneResult[] }>()
    : settledAcceptanceInvocations(reuse);
  const perCriterion = await Promise.all(state.acceptanceCriteria.map(async (criterion) => {
    const prior = settled.get(criterion.id);
    if (reuse !== null && prior !== undefined) {
      progress(`acceptance ${criterion.id}: ${prior.invocation.verdict} (reused from the ERROR'd attempt)`);
      return {
        invocation: { ...prior.invocation, reusedFrom: reuse.id },
        criteria: prior.criteria,
      };
    }
    const record = await judgeLane(crypto.randomUUID(), async () => {
      const material = acceptanceMaterial(projectRoot, state, criterion, changedFiles, mechanical, scenarios);
      // With no inlined check, artifact, or image, the only honest basis for
      // a PASS is the code itself - and the agentic probe measured judges
      // reading zero to two files, zero included. A PASS with a known-zero
      // read trace is rejected through the normal invalid-output ladder
      // (retry with the reason, then backend fallback). An unknown trace
      // (toolRounds null) never rejects: absence of a signal is not evidence
      // of absence.
      const inlinedProof = material.checks.length > 0 || material.evidence.length > 0 || material.readableArtifacts.length > 0;
      return runJudge(
        config,
        `implement:acceptance:${criterion.id}`,
        "routine",
        acceptancePrompt(state, criterion, material),
        (value, activity) => {
          const verdict = validateSemanticVerdict(value, [criterion.id]);
          if (typeof verdict === "string") return verdict;
          const passed = verdict.criteria.some((entry) => entry.verdict === "PASS");
          if (!inlinedProof && passed && activity.commands.length === 0 && activity.toolRounds === 0) {
            return `${criterion.id} has no inlined check or artifact, so a PASS must rest on reading the implementation; no file read was recorded - read the files you cite as evidence, then judge again`;
          }
          return verdict;
        },
        // 2026-08-13 live probe: 16 Luna xhigh calls across direct proof,
        // code PASS/FAIL, a 21-file noisy manifest, allowlisted dependencies,
        // and prompt injection were correct with zero to two exact-path reads.
        {
          agentic: true,
          cwd: projectRoot,
          evidencePaths: [...changedPaths, ...material.readableArtifacts.map((artifact) => artifact.path)],
          ...(material.readableArtifacts.length > 0
            ? { images: material.readableArtifacts.map((artifact) => normalizeProjectPath(projectRoot, artifact.path).absolute) }
            : {}),
        },
      );
    });
    progress(`acceptance ${criterion.id}: ${record.verdict} (${(record.durationMs / 1000).toFixed(0)}s)`);
    const invocation: AcceptanceCriterionInvocation = {
      criterionId: criterion.id,
      invocationId: record.invocationId,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      durationMs: record.durationMs,
      verdict: record.verdict,
      judge: record.judge,
      error: record.error,
    };
    return { invocation, criteria: record.result?.criteria ?? [] };
  }));
  const criteria = perCriterion.flatMap((entry) => entry.criteria);
  const invocations = perCriterion.map((entry) => entry.invocation);
  const verdict: VerificationStatus = invocations.some((entry) => entry.verdict === "ERROR")
    ? "ERROR"
    : invocations.every((entry) => entry.verdict === "PASS")
      ? "PASS"
      : "FAIL";
  return {
    invocationId,
    startedAt,
    finishedAt: nowIso(),
    durationMs: Date.now() - started,
    verdict,
    result: { verdict: verdict === "PASS" ? "PASS" : "FAIL", criteria, invocations },
    judge: null,
    error: verdict === "ERROR"
      ? { code: "acceptance-criterion-error", message: invocations.map((entry) => entry.error?.message).filter(Boolean).join("; ") }
      : null,
  };
}

function specGateIsFresh(projectRoot: string, state: ImplementState): boolean {
  try {
    const view = readGateStatus(projectRoot, loadConfig(projectRoot), state.topicSlug).spec;
    return view.effective === "PASS" && view.staleInputs.length === 0 && !view.overridden;
  } catch {
    return false;
  }
}

function verificationNeedsJudge(item: VerificationItem): boolean {
  return item.mode.toLowerCase().includes("live judge");
}

function setVerificationStatuses(
  state: ImplementState,
  bindings: MechanicalBinding[],
  runs: MechanicalRunRecord[],
  sourceDigest: string,
): string[] {
  const problems: string[] = [];
  for (const item of state.verification) {
    if (verificationNeedsJudge(item)) continue;
    const ownedBindings = bindings.filter((binding) => binding.verificationIds.includes(item.id));
    if (ownedBindings.length > 0) {
      const ownedRuns = runs.filter((run) => run.verificationIds.includes(item.id));
      item.status = ownedRuns.length === ownedBindings.length && ownedRuns.every((run) => run.status === "PASS") ? "PASS" : "FAIL";
      if (item.status !== "PASS") problems.push(`${item.id}: mechanical proof did not pass`);
      continue;
    }
    const artifacts = state.artifacts.filter((entry) => entry.verificationId === item.id && entry.command === undefined);
    if (artifacts.length === 0) {
      item.status = "NOT_RUN";
      if (item.requiredForDone) problems.push(`${item.id}: no command binding or registered runtime artifact proves ${item.passIntent}`);
    } else if (artifacts.every((entry) => entry.sourceFingerprint === sourceDigest)) {
      item.status = "PASS";
    } else {
      item.status = "STALE";
      problems.push(`${item.id}: registered runtime evidence is stale`);
    }
  }
  return problems;
}

function failedAttempt(
  state: ImplementState,
  sourceDigest: string,
  fidelityInput: UnifiedVerificationAttempt["fidelityInput"],
  started: number,
  startedAt: string,
  prelint: UnifiedVerificationAttempt["prelint"],
  mechanical: MechanicalRunRecord[],
  stage: string,
  code: string,
  message: string,
  verdict: VerificationStatus,
): UnifiedVerificationAttempt {
  return {
    id: crypto.randomUUID(),
    inputFingerprint: inputFingerprint(state, sourceDigest, fidelityInput),
    sourceFingerprint: sourceDigest,
    fidelityInput,
    startedAt,
    finishedAt: nowIso(),
    durationMs: Date.now() - started,
    verdict,
    prelint,
    mechanical,
    lanes: { acceptance: null, fidelity: null, risk: null },
    error: { stage, code, message },
  };
}

async function verify(projectRoot: string, args: ImplementArgs): Promise<ImplementCommandResult> {
  const { statePath, state } = loadState(projectRoot, stateOptions(args));
  if (state.status === "complete") throw new Error("implement run is already complete");
  const openTasks = state.tasks.filter((entry) => entry.status !== "complete");
  if (openTasks.length > 0) throw new Error(`verify requires all tasks complete; open: ${openTasks.map((entry) => entry.id).join(", ")}`);
  const config = loadConfig(projectRoot);
  if (args.flags.has("grant-budget")) {
    const evidence = flag(args, "grant-budget")?.trim() ?? "";
    if (evidence === "") throw new Error("--grant-budget requires the user's verbatim approval text");
    const view = verificationBudget(state, config.judge.retryBudget);
    if (!view.budgetExhausted && !view.judgeErrorLoop) {
      // A grant is only meaningful at a terminal gauge; anywhere else it
      // would silently widen the budget the user configured.
      throw new Error("--grant-budget refused: the verification budget is not exhausted; run `sasu implement verify` without it");
    }
    state.budgetGrants = [
      ...(state.budgetGrants ?? []),
      { at: nowIso(), evidence, attemptCountBefore: state.verificationAttempts.length },
    ];
    persistState(statePath, state);
  }
  const budgetBefore = verificationBudget(state, config.judge.retryBudget);
  const terminalBefore = terminalBudgetMessage(budgetBefore);
  if (terminalBefore !== null) {
    return result(
      "verify",
      false,
      `${terminalBefore}; no mechanical command or judge was called`,
      { verificationBudget: budgetBefore, judgeCalls: 0, terminalReason: budgetBefore.budgetExhausted ? "budget-exhausted" : "judge-error-loop" },
    );
  }
  // A blocked close is superseded the moment verification can run again
  // (e.g. the user raised judge.retryBudget): every path below records a
  // fresh attempt, so the run is live again and the next finalize decides
  // the new terminal state.
  if (state.status === "blocked") {
    state.status = "active";
    state.completion = null;
  }
  const started = Date.now();
  const startedAt = nowIso();
  const prdAbsolute = normalizeProjectPath(projectRoot, state.prdPath).absolute;
  if (!fs.existsSync(prdAbsolute)) throw new Error(`PRD missing: ${state.prdPath}`);
  const prdText = fs.readFileSync(prdAbsolute, "utf8");
  if (sha256(prdText) !== state.prd.sha256) throw new Error("PRD changed after implement start; start a new run with the approved PRD");
  const contract = parseImplementContract(prdText);
  const sourceContext = fidelitySource(projectRoot, contract, specGateIsFresh(projectRoot, state));
  const fidelityInput = { routing: sourceContext.routing, contentSha256: sha256(sourceContext.content) };
  const lint = prelintPrd(prdText);
  const prelint = { ok: lint.ok, findings: lint.findings };
  const source = captureSourceSnapshot(projectRoot);
  if (!lint.ok) {
    const attempt = failedAttempt(state, source.digest, fidelityInput, started, startedAt, prelint, [], "prelint", "prd-prelint", "PRD prelint failed", "FAIL");
    state.verificationAttempts.push(attempt);
    persistState(statePath, state);
    return result("verify", false, "PRD prelint failed before mechanical verification; no judge was called", {
      attempt: attemptSummary(attempt),
      verificationBudget: verificationBudget(state, config.judge.retryBudget),
    });
  }
  const runtimeArtifactProblems = artifactIntegrityProblems(projectRoot, { ...state, artifacts: state.artifacts.filter((entry) => entry.command === undefined) }, source);
  if (runtimeArtifactProblems.length > 0) {
    const attempt = failedAttempt(state, source.digest, fidelityInput, started, startedAt, prelint, [], "artifact", "artifact-stale", runtimeArtifactProblems.join("; "), "STALE");
    state.verificationAttempts.push(attempt);
    persistState(statePath, state);
    const budget = verificationBudget(state, config.judge.retryBudget);
    const terminal = terminalBudgetMessage(budget);
    return result("verify", false, `runtime artifact preflight failed; no mechanical command or judge was called${terminal === null ? "" : `; ${terminal}`}`, {
      attempt: attemptSummary(attempt),
      problems: runtimeArtifactProblems,
      verificationBudget: budget,
    });
  }
  const bindings = mechanicalBindings(projectRoot, state.verification);
  const mechanical = runMechanicalBindings(projectRoot, state, bindings, source.digest);
  const failedMechanical = mechanical.find((entry) => entry.status === "FAIL");
  const proofProblems = setVerificationStatuses(state, bindings, mechanical, source.digest);
  if (failedMechanical !== undefined || proofProblems.length > 0) {
    const message = failedMechanical !== undefined
      ? `${failedMechanical.command} failed with exit ${failedMechanical.exitCode}`
      : proofProblems.join("; ");
    const attempt = failedAttempt(state, source.digest, fidelityInput, started, startedAt, prelint, mechanical, "mechanical", "mechanical-failed", message, "FAIL");
    state.verificationAttempts.push(attempt);
    persistState(statePath, state);
    const budget = verificationBudget(state, config.judge.retryBudget);
    const terminal = terminalBudgetMessage(budget);
    return result("verify", false, `${message}; no judge was called${terminal === null ? "" : `; ${terminal}`}`, {
      attempt: attemptSummary(attempt),
      judgeCalls: 0,
      verificationBudget: budget,
    });
  }

  const material = changeMaterial(projectRoot, state, source);
  const changedPaths = changedPathsSince(state.initialSource, source);
  const changedFiles = changedFileManifest(projectRoot, changedPaths);
  const reuse = reusableErrorAttempt(state, inputFingerprint(state, source.digest, fidelityInput), source.digest, mechanical);
  const priorFidelity = reuse !== null && reuse.lanes.fidelity !== null && reuse.lanes.fidelity.verdict !== "ERROR"
    ? { ...reuse.lanes.fidelity, reusedFrom: reuse.id }
    : null;
  const fidelityInvocationId = crypto.randomUUID();
  progress(`judging ${state.acceptanceCriteria.length} acceptance criteria and fidelity in parallel (profile: ${state.prd.reviewProfile})`);
  if (priorFidelity !== null) progress(`fidelity: ${priorFidelity.verdict} (reused from the ERROR'd attempt)`);
  // The design lane is advisory: always re-run (never reused - it is one cheap
  // call and its findings should describe the current tree), skipped for
  // trivial profiles, and excluded from the attempt verdict below. Its
  // guaranteed consumption points are the verify command response (finding
  // count) and the Design Advisory section of implementation-result.md -
  // a lane whose output only lived inside a prompt would never be read.
  const runDesignLane = state.prd.reviewProfile !== "trivial";
  const [acceptance, fidelity, design] = await Promise.all([
    acceptanceLane(config, projectRoot, state, contract.scenarios, changedFiles, changedPaths, mechanical, reuse),
    priorFidelity !== null
      ? Promise.resolve(priorFidelity)
      : judgeLane(fidelityInvocationId, () =>
          runJudge(config, "implement:fidelity", "routine", fidelityPrompt(prdText, contract, state, sourceContext, material), validateFidelity),
        ).then((record) => {
          progress(`fidelity: ${record.verdict} (${(record.durationMs / 1000).toFixed(0)}s)`);
          return record;
        }),
    !runDesignLane
      ? Promise.resolve(null)
      : judgeLane(crypto.randomUUID(), () =>
          runJudge(config, "implement:design", "routine", designPrompt(prdText, material), validateDesign),
        ).then((record) => {
          progress(`design (advisory): ${record.result?.findings.length ?? 0} finding(s) (${(record.durationMs / 1000).toFixed(0)}s)`);
          return record;
        }),
  ]);

  // The risk lane is never reused: its prompt consumes acceptance.result and
  // fidelity.result. If both upstream lanes were fully reused, the prior
  // attempt's ERROR was the risk lane itself; otherwise a fresh upstream
  // judgment changed the risk lane's inputs. Either way it must re-run.
  let risk: LaneRecord<{ verdict: "PASS" | "FAIL"; findings: RiskFinding[] }> | null = null;
  if (state.prd.reviewProfile === "high-risk") {
    progress("risk: judging residual risk");
    risk = await judgeLane(crypto.randomUUID(), () =>
      runJudge(config, "implement:risk", "high-risk", riskPrompt(prdText, material, acceptance.result, fidelity.result), validateRisk),
    );
    const blocking = risk.result?.findings.filter((entry) => entry.severity === "blocking").length ?? 0;
    const advisory = risk.result?.findings.filter((entry) => entry.severity === "advisory").length ?? 0;
    progress(`risk: ${risk.verdict} (${blocking} blocking, ${advisory} advisory, ${(risk.durationMs / 1000).toFixed(0)}s)`);
  }
  const laneVerdicts = [acceptance.verdict, fidelity.verdict, ...(risk !== null ? [risk.verdict] : [])];
  const verdict: VerificationStatus = laneVerdicts.includes("ERROR") ? "ERROR" : laneVerdicts.every((entry) => entry === "PASS") ? "PASS" : "FAIL";
  for (const criterion of acceptance.result?.criteria ?? []) {
    const item = state.acceptanceCriteria.find((entry) => entry.id === criterion.id);
    if (item === undefined) continue;
    item.status = criterion.verdict === "PASS" ? "complete" : "blocked";
    const note = `${criterion.verdict}: ${criterion.reason} (${criterion.evidence})`;
    if (!item.evidence.some((entry) => entry.text === note)) item.evidence.push({ at: nowIso(), text: note });
  }
  for (const item of state.verification.filter(verificationNeedsJudge)) item.status = verdict === "PASS" ? "PASS" : verdict;
  const attempt: UnifiedVerificationAttempt = {
    id: crypto.randomUUID(),
    inputFingerprint: inputFingerprint(state, source.digest, fidelityInput),
    sourceFingerprint: source.digest,
    fidelityInput,
    startedAt,
    finishedAt: nowIso(),
    durationMs: Date.now() - started,
    verdict,
    prelint,
    mechanical,
    lanes: { acceptance, fidelity, risk, design },
    error: verdict === "ERROR"
      ? { stage: "judge", code: "judge-error", message: [acceptance.error?.message, fidelity.error?.message, risk?.error?.message].filter(Boolean).join("; ") }
      : null,
  };
  state.verificationAttempts.push(attempt);
  persistState(statePath, state);
  progress(`unified verification ${verdict} in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  const budget = verificationBudget(state, config.judge.retryBudget);
  const terminal = terminalBudgetMessage(budget);
  return result("verify", verdict === "PASS", `unified verification ${verdict}${terminal === null ? "" : `; ${terminal}`}`, {
    attempt: attemptSummary(attempt),
    sourceRouting: sourceContext.routing,
    verificationBudget: budget,
    // Guaranteed render point: the orchestrating agent sees advisory findings
    // in this response without any prompt needing to be invoked.
    designAdvisory: design === null
      ? { ran: false, findings: [] }
      : { ran: true, findings: design.result?.findings ?? [] },
  });
}

function completionFingerprint(
  state: ImplementState,
  sourceDigest: string,
  attempt: UnifiedVerificationAttempt,
  fidelityInput: UnifiedVerificationAttempt["fidelityInput"],
): string {
  return sha256(JSON.stringify({
    schema: state.schema,
    topicSlug: state.topicSlug,
    inputFingerprint: inputFingerprint(state, sourceDigest, fidelityInput),
    attemptId: attempt.id,
    attemptVerdict: attempt.verdict,
  }));
}

function designAdvisorySection(attempt: UnifiedVerificationAttempt): string {
  const lane = attempt.lanes.design ?? null;
  if (lane === null) return "Not run (trivial profile or pre-design-lane attempt).";
  if (lane.verdict === "ERROR") return `Lane errored: ${lane.error?.message ?? "unknown"}. Advisory only; the run is unaffected.`;
  const findings = lane.result?.findings ?? [];
  if (findings.length === 0) return "No findings.";
  return findings.map((entry) => `- [${entry.area}] ${entry.text}\n  Suggestion: ${entry.suggestion}`).join("\n");
}

function implementationReport(
  state: ImplementState,
  attempt: UnifiedVerificationAttempt,
  fingerprint: string,
  blocked?: { terminalReason: string; openItems: string[] },
): string {
  const taskLines = state.tasks.map((entry) => `- ${entry.id}: ${entry.status} - ${entry.title}`).join("\n");
  const requirementLines = state.requirements.map((entry) => {
    const mapped = state.acceptanceCriteria.filter((criterion) => criterion.requirements.includes(entry.id));
    const status = mapped.length > 0 && mapped.every((criterion) => criterion.status === "complete") ? "PASS" : "NOT_PROVEN";
    return `- ${entry.id}: ${status} - ${entry.title}`;
  }).join("\n");
  const acLines = state.acceptanceCriteria.map((entry) => {
    const proofs = state.verification.filter((verification) => verification.covers.includes(entry.id)).map((verification) => verification.id);
    return `- ${entry.id}: ${entry.status === "complete" ? "PASS" : entry.status.toUpperCase()} - verification ${proofs.join(", ") || "none"}`;
  }).join("\n");
  const verificationLines = state.verification.map((entry) => {
    const artifacts = state.artifacts.filter((artifact) => artifact.verificationId === entry.id).map((artifact) => artifact.path);
    return `- ${entry.id}: ${entry.status} (${entry.mode}) - ${entry.passIntent} - artifacts: ${artifacts.join(", ") || "none"}`;
  }).join("\n");
  const mechanicalLines = attempt.mechanical.length === 0
    ? "- none"
    : attempt.mechanical.map((run) => `- ${run.status}: \`${run.command}\` in \`${run.cwd}\`, exit ${run.exitCode}, ${run.durationMs}ms, log ${run.logPath}`).join("\n");
  const laneLine = (name: string, lane: LaneRecord<unknown> | null): string => lane === null
    ? `- ${name}: NOT_REQUIRED`
    : `- ${name}: ${lane.verdict}, invocation ${lane.invocationId}, ${lane.startedAt} to ${lane.finishedAt}, ${lane.durationMs}ms`;
  const statusLine = blocked === undefined ? "Status: Done" : `Status: Blocked (${blocked.terminalReason})`;
  const openItemsSection = blocked === undefined
    ? ""
    : `## Open Items\n\nThis run closed without a verification PASS. A person must settle each item before the work can be called done:\n\n${blocked.openItems.length === 0 ? "- none recorded" : blocked.openItems.map((item) => `- ${item}`).join("\n")}\n\n`;
  return `# Implementation Result: ${state.topicSlug}\n\n${statusLine}\n\n${openItemsSection}## Public Flow\n\nImplementation complete -> final evidence registered -> \`sasu implement verify\` -> \`sasu implement finalize\`.\n\n## Structure And Removal\n\nThe TypeScript CLI owns implement state, artifact registration, unified verification, and state-only finalization.\n\nThe old dispatcher, manual review recording, separate completion ledgers, and final reverification are not completion surfaces.\n\n\`state.json\` is the only machine record and the receipt plus this report are derived outputs.\n\n## Tasks\n\n${taskLines}\n\n## Requirements\n\n${requirementLines}\n\n## Acceptance Criteria\n\n${acLines}\n\n## Verification\n\n${verificationLines}\n\nUnified verdict: ${attempt.verdict}.\n\nInput fingerprint: ${attempt.inputFingerprint}.\n\nSource fingerprint: ${attempt.sourceFingerprint}.\n\n### Mechanical Runs\n\n${mechanicalLines}\n\n### Judge Lanes\n\n${laneLine("acceptance", attempt.lanes.acceptance)}\n${laneLine("fidelity", attempt.lanes.fidelity)}\n${laneLine("risk", attempt.lanes.risk)}\n${laneLine("design (advisory)", attempt.lanes.design ?? null)}\n\nMechanical failures call zero judges by contract and regression test.\n\nFinalize execution calls: 0.\n\nCompletion fingerprint: ${fingerprint}.\n\n## Design Advisory\n\nAdvisory findings from the design lane. They never block the run; a human decides what is worth acting on.\n\n${designAdvisorySection(attempt)}\n\n## Deviations, Risks, And Follow-Ups\n\n${state.deviations.length === 0 ? "None." : state.deviations.map((entry) => `- ${entry.type}: ${entry.summary}`).join("\n")}\n`;
}

function finalize(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  const requestedStatus = flag(args, "status") ?? "complete";
  if (requestedStatus !== "complete" && requestedStatus !== "blocked") {
    throw new Error("finalize --status must be complete or blocked");
  }
  const { statePath, state } = loadState(projectRoot, stateOptions(args));
  const source = captureSourceSnapshot(projectRoot);
  const latest = state.verificationAttempts.at(-1);
  if (latest === undefined) throw new Error("finalize requires a unified verify attempt");
  const prdAbsolute = normalizeProjectPath(projectRoot, state.prdPath).absolute;
  if (!fs.existsSync(prdAbsolute)) throw new Error(`PRD missing: ${state.prdPath}`);
  const prdText = fs.readFileSync(prdAbsolute, "utf8");
  const prdStale = sha256(prdText) !== state.prd.sha256;
  const contract = parseImplementContract(prdText);
  const sourceContext = fidelitySource(projectRoot, contract, specGateIsFresh(projectRoot, state));
  const currentFidelityInput = { routing: sourceContext.routing, contentSha256: sha256(sourceContext.content) };
  const fingerprint = completionFingerprint(state, source.digest, latest, currentFidelityInput);
  const blockers: string[] = [];
  if (prdStale) blockers.push("PRD changed after implement start");
  blockers.push(...state.tasks.filter((entry) => entry.status !== "complete").map((entry) => `${entry.id} is ${entry.status}`));
  blockers.push(...state.acceptanceCriteria.filter((entry) => entry.status !== "complete").map((entry) => `${entry.id} is ${entry.status}`));
  blockers.push(...state.verification.filter((entry) => entry.requiredForDone && entry.status !== "PASS").map((entry) => `${entry.id} is ${entry.status}`));
  blockers.push(...artifactIntegrityProblems(projectRoot, state, source));
  if (latest.verdict !== "PASS") blockers.push(`unified verify is ${latest.verdict}`);
  if (latest.sourceFingerprint !== source.digest) blockers.push("unified verify is STALE because judged source changed");
  if (latest.inputFingerprint !== inputFingerprint(state, source.digest, currentFidelityInput)) {
    blockers.push("unified verify input fingerprint no longer matches current state, artifacts, or fidelity source");
  }
  if (state.prd.reviewProfile === "high-risk" && latest.lanes.risk?.verdict !== "PASS") blockers.push("high-risk final judge is not PASS");
  if (requestedStatus === "blocked") {
    // The blocked close exists for runs whose verification machinery is
    // terminally stuck, never as a shortcut past fixable findings: it stays
    // refused while the budget predicate says another verify could run.
    const view = verificationBudget(state, loadConfig(projectRoot).judge.retryBudget);
    if (!view.budgetExhausted && !view.judgeErrorLoop) {
      throw new Error(
        "finalize --status blocked refused: verification can still run - fix the recorded findings and re-run `sasu implement verify`",
      );
    }
    const terminalReason = view.budgetExhausted ? "budget-exhausted" : "judge-error-loop";
    if (state.status === "blocked" && state.completion?.fingerprint === fingerprint) {
      const receipt = path.join(projectRoot, state.completion.receiptPath);
      const report = path.join(projectRoot, state.completion.implementationResultPath);
      if (!fs.existsSync(receipt) || !fs.existsSync(report)) throw new Error("blocked state is missing a derived receipt or implementation result");
      return result("finalize", true, "already closed blocked with the same completion fingerprint", { completion: state.completion, executionCalls: 0 });
    }
    const blockedAt = nowIso();
    const receiptPath = `${state.runDir}/receipt.json`;
    const implementationResultPath = `${state.runDir}/implementation-result.md`;
    const receipt = {
      schema: "sasu.implement.receipt.v3",
      status: "blocked",
      terminalReason,
      topicSlug: state.topicSlug,
      prdPath: state.prdPath,
      blockedAt,
      completionFingerprint: fingerprint,
      sourceFingerprint: source.digest,
      verificationAttemptId: latest.id,
      unifiedVerdict: latest.verdict,
      lanes: {
        acceptance: latest.lanes.acceptance?.verdict ?? "NOT_RUN",
        fidelity: latest.lanes.fidelity?.verdict ?? "NOT_RUN",
        risk: latest.lanes.risk?.verdict ?? "NOT_REQUIRED",
      },
      verificationBudget: { fixAttempts: view.fixAttempts, budget: view.budget, consecutiveErrors: view.consecutiveErrors, grants: view.grants },
      openItems: blockers,
      executionCallsDuringFinalize: 0,
    };
    writeJsonAtomic(path.join(projectRoot, receiptPath), receipt);
    writeTextAtomic(
      path.join(projectRoot, implementationResultPath),
      implementationReport(state, latest, fingerprint, { terminalReason, openItems: blockers }),
    );
    state.status = "blocked";
    state.completion = { fingerprint, completedAt: blockedAt, receiptPath, implementationResultPath };
    persistState(statePath, state);
    return result(
      "finalize",
      true,
      `implementation closed blocked (${terminalReason}); the receipt records ${blockers.length} open item(s) and is not deliverable`,
      { completion: state.completion, receipt, executionCalls: 0 },
    );
  }
  if (blockers.length > 0) throw new Error(`finalize refused:\n- ${blockers.join("\n- ")}`);
  if (state.status === "complete" && state.completion?.fingerprint === fingerprint) {
    const receipt = path.join(projectRoot, state.completion.receiptPath);
    const report = path.join(projectRoot, state.completion.implementationResultPath);
    if (!fs.existsSync(receipt) || !fs.existsSync(report)) throw new Error("completed state is missing a derived receipt or implementation result");
    return result("finalize", true, "already finalized with the same completion fingerprint", { completion: state.completion, executionCalls: 0 });
  }
  const completedAt = nowIso();
  const receiptPath = `${state.runDir}/receipt.json`;
  const implementationResultPath = `${state.runDir}/implementation-result.md`;
  const receipt = {
    schema: "sasu.implement.receipt.v3",
    status: "complete",
    topicSlug: state.topicSlug,
    prdPath: state.prdPath,
    completedAt,
    completionFingerprint: fingerprint,
    sourceFingerprint: source.digest,
    verificationAttemptId: latest.id,
    unifiedVerdict: latest.verdict,
    lanes: {
      acceptance: latest.lanes.acceptance?.verdict ?? "NOT_RUN",
      fidelity: latest.lanes.fidelity?.verdict ?? "NOT_RUN",
      risk: latest.lanes.risk?.verdict ?? "NOT_REQUIRED",
    },
    executionCallsDuringFinalize: 0,
  };
  writeJsonAtomic(path.join(projectRoot, receiptPath), receipt);
  writeTextAtomic(path.join(projectRoot, implementationResultPath), implementationReport(state, latest, fingerprint));
  state.status = "complete";
  state.completion = { fingerprint, completedAt, receiptPath, implementationResultPath };
  persistState(statePath, state);
  return result("finalize", true, "implementation finalized from fresh unified PASS", { completion: state.completion, receipt, executionCalls: 0 });
}

export async function runImplementCommand(projectRoot: string, args: ImplementArgs): Promise<ImplementCommandResult> {
  const subcommand = args.positional[1];
  try {
    if (subcommand === "start") return start(projectRoot, args);
    if (subcommand === "task") return task(projectRoot, args);
    if (subcommand === "artifact") return artifact(projectRoot, args);
    if (subcommand === "status") return status(projectRoot, args);
    if (subcommand === "verify") return await verify(projectRoot, args);
    if (subcommand === "finalize") return finalize(projectRoot, args);
    return { ok: false, action: subcommand ?? "unknown", exitCode: 2, message: "unknown implement subcommand; use start, task, artifact, status, verify, or finalize" };
  } catch (error) {
    return {
      ok: false,
      action: subcommand ?? "unknown",
      exitCode: error instanceof SyntaxError ? 1 : 2,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
