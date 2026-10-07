import { currentGit, type CurrentGit } from "./worktree";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../config";
import { readGateStatus } from "../gates/commands";
import { prelintPrd } from "../gates/prelint";
import { runDirRel } from "../runs/paths";
import { parseImplementContract, reviewProfile, suiteCommands } from "./contract";
import { planRunUnits, runBatch, parseCommandArgv, type RunUnit, type RunUnitResult } from "./runner";
import { suiteScore } from "./suite";
import { effectiveVerdict, identicalInputFailures } from "./verdict";
import { isIssuedCommand, recordVerb, resolveIssuer, VerbRejected } from "./verbs";
import { recordEvent } from "./events";
import { AmendmentRejected, applyAmendment } from "./amend";
import { assertNoActiveVerification, recoverVerification, beginVerification, progressVerification, finishVerification, verificationExecutionHooks } from "./verification-activity";
import { runVerifyPreview } from "./preview";
import { assertNotImplementor, assertObserverForRun } from "./hide";
import { DispatchRejected, assertDispatchablePrd, assertHandoff, buildImplementorPrompt, buildSpawnInstruction } from "./dispatch";
import { intentSource, resolveIntakePath } from "./intent";
import { pinnedPrd, PrdDriftError, prdSnapshotPath, requirePinnedPrd, writePrdSnapshot } from "./prd-snapshot";
import { artifactIntegrityProblems, captureBaselineSnapshot, captureSourceSnapshot, changedPathsSince, dirtySourcePaths, loadState, normalizeProjectPath, nowIso, persistState, persistClose, jsonText, repositoryHead, requireWorkRoot, sha256, statePathFor, runRoleInputs, changedPathsFromGit, requireRunContext, recordContext, resolveStatePath, writeTextAtomic, StateConflictError } from "./store";
import { IMPLEMENT_SCHEMA, type DirtyAttribution, type PrdJudgeRecord, type ImplementCommandResult, type ImplementState, type MechanicalRunRecord, type RegisteredArtifact, type UnifiedVerificationAttempt, type IssuedCommand, type EvidenceReplacement, type IssuerLabel, type SpawnIntent, type EscalationRecord, ESCALATE_LIMIT_PER_RUN } from "./types";

export interface ImplementArgs {
  positional: string[];
  flags: Map<string, string | true>;
  /** Every value of a repeated flag, in order; absent when the caller parsed none. */
  values?: Map<string, string[]>;
}

const ARTIFACT_KINDS = new Set(["screenshot", "image", "browser", "api", "db", "log", "file", "command-log"]);

export const DIRTY_INTAKE_QUESTION = "커밋되지 않은 판정 대상 파일이 있습니다. 이 작업을 어떻게 시작할까요?";
export const DIRTY_INTAKE_OPTIONS = [
  {
    value: "commit-first",
    label: "먼저 커밋하고 시작",
    description: "표시된 변경을 먼저 커밋한 뒤 그 커밋을 깨끗한 기준선으로 사용합니다.",
  },
  {
    value: "pre-existing",
    label: "기존 작업으로 이어서 시작",
    description: "현재 바이트는 기준선에 포함하고 이번 런의 변경에서는 제외합니다.",
  },
  {
    value: "run-owned",
    label: "이번 작업에 포함",
    description: "현재 바이트부터 이번 런이 만든 변경으로 검증합니다.",
  },
] as const;

function result(
  action: string,
  ok: boolean,
  message: string,
  detail?: Record<string, unknown>,
  summary?: string[],
): ImplementCommandResult {
  return {
    ok,
    action,
    exitCode: ok ? 0 : 1,
    message,
    ...(detail !== undefined ? { detail } : {}),
    ...(summary !== undefined ? { summary } : {}),
  };
}

class VerifyInvariantError extends Error {
  constructor(readonly reason: "empty-run-owned-change-set", message: string) {
    super(message);
    this.name = "VerifyInvariantError";
  }
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

function dirtyAttributionRefusal(paths: string[]): Error {
  const mixedExample = Object.fromEntries(paths.map((entry, index) => [
    entry,
    index === 0 ? "pre-existing" : "run-owned",
  ]));
  return new Error(
    `implement start found dirty judged paths and will not guess their ownership:\n` +
    `${paths.map((entry) => `- ${entry}`).join("\n")}\n` +
    `Use \`sasu implement intake\` in the specification-owning session and ask once. Commit the listed changes first for a clean committed baseline, ` +
    `or re-run with --dirty-attribution pre-existing to exclude all of these bytes from this run, or --dirty-attribution run-owned to include all of them as this run's work. ` +
    `For mixed ownership, map every listed path exactly: --dirty-attribution '${JSON.stringify(mixedExample)}'.`,
  );
}

function intake(projectRoot: string): ImplementCommandResult {
  const paths = dirtySourcePaths(projectRoot);
  return result(
    "intake",
    true,
    paths.length === 0 ? "judged source tree is clean; no dirty disposition is required" : "dirty source disposition is required before implementation dispatch",
    paths.length === 0
      ? { required: false, paths: [], question: null, options: [] }
      : { required: true, paths, question: DIRTY_INTAKE_QUESTION, options: DIRTY_INTAKE_OPTIONS },
  );
}

function resolveDirtyAttributions(
  paths: string[],
  input: string | undefined,
): Array<{ path: string; disposition: DirtyAttribution }> {
  // The disposition is answered by a person at the pipeline's pre-dispatch
  // intake (DIRTY_INTAKE_QUESTION) and carried into the run. Only someone who
  // watched the tree can say whether uncommitted bytes are a sibling's work or
  // this run's own earlier attempt; the harness cannot tell those apart from
  // content, and guessing is what misattributed a sibling's 16 files to the
  // 2026-08-24 x-twitter run and failed its fidelity lane three rounds running.
  // This function only expands and validates that answer, so the enforceable
  // boundary here is exact path coverage and value validation, including
  // mixed-ownership trees. Cross-session retirement, not attribution, is the
  // surface that requires verbatim user evidence.
  if (input === undefined) return [];
  if (input === "pre-existing" || input === "run-owned") {
    return paths.map((entry) => ({ path: entry, disposition: input }));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error("--dirty-attribution must be pre-existing, run-owned, or a JSON object mapping every dirty path to one of those values");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--dirty-attribution JSON must be an object mapping every dirty path to pre-existing or run-owned");
  }
  const record = parsed as Record<string, unknown>;
  const expected = new Set(paths);
  const unknown = Object.keys(record).filter((entry) => !expected.has(entry)).sort();
  const missing = paths.filter((entry) => !Object.prototype.hasOwnProperty.call(record, entry));
  const invalid = Object.entries(record)
    .filter(([, value]) => value !== "pre-existing" && value !== "run-owned")
    .map(([entry]) => entry)
    .sort();
  if (unknown.length > 0 || missing.length > 0 || invalid.length > 0) {
    const details = [
      ...(missing.length > 0 ? [`missing: ${missing.join(", ")}`] : []),
      ...(unknown.length > 0 ? [`unknown: ${unknown.join(", ")}`] : []),
      ...(invalid.length > 0 ? [`invalid value: ${invalid.join(", ")}`] : []),
    ].join("; ");
    throw new Error(`--dirty-attribution JSON must map every dirty path exactly to pre-existing or run-owned (${details})`);
  }
  return paths.map((entry) => ({ path: entry, disposition: record[entry] as DirtyAttribution }));
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
  const slug = slugFromPrd(prd.absolute);
  resolveIntakePath(projectRoot, contract);
  const sourceIntake = contract.frontmatter["source_intake"] ?? "";
  const gateViews = readGateStatus(projectRoot, config, slug);
  const activePrdGates = (["gap-audit", "spec"] as const).filter((gate) => gateViews[gate].inFlight);
  if (activePrdGates.length > 0) {
    throw new Error(
      `implement start refused: PRD review still in flight (${activePrdGates.join(", ")}); wait for the gate to finish and inspect its final status`,
    );
  }
  const qaLogBacked = sourceIntake !== "" && path.basename(sourceIntake) === "qa-log.md";
  if (qaLogBacked) {
    const incomplete = (["gap-audit", "spec"] as const).filter((gate) => gateViews[gate].effective !== "PASS");
    if (incomplete.length > 0) {
      const statuses = incomplete.map((gate) => `${gate}=${gateViews[gate].effective}`).join(", ");
      throw new Error(
        `implement start refused: qa-log-backed PRD requires live PASS for gap-audit and spec; got ${statuses}`,
      );
    }
  }
  const prdJudge: PrdJudgeRecord = qaLogBacked
    ? { required: true, skippedReason: null, gapAudit: gateViews["gap-audit"].effective, spec: gateViews.spec.effective }
    : {
        required: false,
        skippedReason: `judge not run: no user utterances to judge against (source_intake is ${sourceIntake === "" ? "empty" : JSON.stringify(sourceIntake)}, not an interview qa-log)`,
        gapAudit: null,
        spec: null,
      };
  const context = recordContext(statePathFor(projectRoot, slug));
  // A new record, sealed contract and suite must share the selected checkout.
  if (context.recordRoot !== fs.realpathSync(projectRoot)) {
    throw new Error("implement start requires its run record in the selected checkout; restore agents/runs there and retry");
  }
  const statePath = context.statePath;
  const existingPath = resolveStatePath(projectRoot, { slug });
  if (fs.existsSync(existingPath)) {
    let existingSchema = "unknown";
    try {
      existingSchema = String((JSON.parse(fs.readFileSync(existingPath, "utf8")) as { schema?: unknown }).schema ?? "missing");
    } catch {
      existingSchema = "malformed";
    }
    throw new Error(`implement state already exists for ${slug} (${existingSchema}); choose a new slug or remove the obsolete run explicitly`);
  }
  // Hide owns checkout creation. Seal the approved checkout itself so suite
  // cwd and judged source remain the same when Hide reuses its branch/path.
  const requestedAttribution = flag(args, "dirty-attribution");
  const sourceDirty = dirtySourcePaths(projectRoot);
  if (sourceDirty.length > 0 && requestedAttribution === undefined) throw dirtyAttributionRefusal(sourceDirty);
  const pathAttributions = resolveDirtyAttributions(sourceDirty, requestedAttribution);
  const workRoot = projectRoot;
  const baseline = captureBaselineSnapshot(workRoot, pathAttributions);
  const dispositions = new Set(pathAttributions.map((entry) => entry.disposition));
  const aggregateAttribution = pathAttributions.length === 0
    ? "clean"
    : dispositions.size === 1
      ? pathAttributions[0]!.disposition
      : "mixed";
  const snapshotPath = prdSnapshotPath(runDirRel(slug));
  const createdAt = nowIso();
  const state: ImplementState = {
    schema: IMPLEMENT_SCHEMA,
    status: "active",
    topicSlug: slug,
    runDir: runDirRel(slug),
    prdPath: prd.relative,
    prd: {
      sha256: sha256(text),
      snapshotPath,
      status: contract.frontmatter["status"] ?? null,
      approval: frontmatterApproval === "approved"
        ? { source: "frontmatter", evidence: "human_approval: approved" }
        : { source: "conversation", evidence: approval },
      reviewProfile: reviewProfile(contract),
      reviewRationale: contract.frontmatter["review_rationale"] ?? "",
      sourceIntake,
      judge: prdJudge,
    },
    initialSource: baseline,
    baselineAttribution: {
      disposition: aggregateAttribution,
      paths: pathAttributions,
      baselineDigest: baseline.digest,
      head: baseline.head,
    },
    dispatchIntent: null,
    requirements: contract.rows.map(({ id, behavior, decisionIds }) => ({ id, behavior, decisionIds })),
    artifacts: [],
    verificationAttempts: [],
    deviations: [],
    events: [],
    verbs: [],
    amendments: [],
    evidenceReplacements: [],
    // Sealed here, at start, and never re-derived: a mid-run edit of
    // agents/config.json must not change what this run is measured
    // against (AC5). From this point the sealed list is the authority and
    // the config file is only the source it was taken from.
    suite: {
      sealedAt: createdAt,
      commands: suiteCommands(projectRoot, workRoot).map((entry, index) => ({
        id: `S${index + 1}`,
        command: entry.command,
        argv: parseCommandArgv(entry.command),
        cwd: entry.cwd,
      })),
      exclusions: [],
      results: [],
    },
    escalations: [],
    retirement: null,
    verificationReport: null,
    createdAt,
    updatedAt: createdAt,
  };
  fs.mkdirSync(path.join(projectRoot, state.runDir, "artifacts", "logs"), { recursive: true });
  writePrdSnapshot(projectRoot, snapshotPath, text);
  // state.json is the commit point. No runtime process or checkout is owned here.
  persistState(statePath, state);
  return result("start", true, `implement run started: ${slug}`, publicState(state), [
    `Prepare dispatch with sasu implement dispatch --slug ${slug} --name <unique-agent-name> --prd ${prd.relative} and a handoff packet on stdin; run its printed Hide command from the Observer pane.`,
  ]);
}

function assertMutableRun(statePath: string, state: ImplementState): void {
  if (state.status === "retired") throw new Error("implement run is retired; start a new approved PRD under a new slug");
  if (assertNoActiveVerification(state)) persistState(statePath, state);
}

function retire(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  const { statePath, state } = loadState(projectRoot, stateOptions(args));
  if (state.status === "retired") return result("retire", true, `implement run is already retired: ${state.topicSlug}`, { status: state.status, retirement: state.retirement });
  assertMutableRun(statePath, state);
  state.status = "retired";
  state.retirement = { retiredAt: nowIso() };
  state.verificationReport = null;
  recordVerb(state, { verb: "retire", issuer: resolveIssuer(flag(args, "issuer")), target: null, reason: flag(args, "reason") ?? "run retired", at: state.retirement.retiredAt, outcome: "accepted" });
  persistState(statePath, state);
  return result("retire", true, `implement run retired: ${state.topicSlug}; end its child/watch directly through Hide`, { status: state.status, retirement: state.retirement });
}

function readHandoffPacket(): string {
  return process.stdin.isTTY === true ? "" : fs.readFileSync(0, "utf8").trim();
}

function runIntentKey(state: ImplementState): string {
  return sha256(JSON.stringify({ root: requireWorkRoot(state), slug: state.topicSlug, createdAt: state.createdAt })).slice(0, 24);
}

/** Checkout creation belongs to Hide; pass the existing branch/path exactly. */
function spawnCheckout(state: ImplementState): { repo: string; branch: string; path: string } {
  const root = requireWorkRoot(state);
  const gitIdentity = currentGit(root);
  if (!gitIdentity.available) throw new DispatchRejected(`dispatch requires a committed Git checkout: ${gitIdentity.reason}`);
  const branch = spawnSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root, encoding: "utf8", timeout: 15_000 });
  if (branch.error !== undefined || branch.status !== 0 || branch.stdout.trim() === "") {
    throw new DispatchRejected("dispatch requires an existing checkout on an attached branch; choose the approved run branch before preparing Hide instructions");
  }
  // Hide rejects a linked checkout as --repo (linked_worktree_source).
  // Git lists the main checkout first; -z preserves paths containing whitespace.
  const listed = spawnSync("git", ["worktree", "list", "--porcelain", "-z"], { cwd: root, encoding: "utf8", timeout: 15_000 });
  const main = listed.stdout?.split("\0\0", 1)[0]?.split("\0") ?? [];
  const entry = main[0];
  if (listed.error !== undefined || listed.status !== 0 || entry === undefined || !entry.startsWith("worktree ") || main.includes("bare")) {
    throw new DispatchRejected("cannot resolve the repository's main checkout for Hide; inspect `git worktree list` and restore the approved checkout before retrying");
  }
  const repo = entry.slice("worktree ".length);
  if (!fs.existsSync(repo)) throw new DispatchRejected(`repository main checkout is missing: ${repo}; restore it before preparing Hide instructions`);
  return { repo: fs.realpathSync(repo), branch: branch.stdout.trim(), path: root };
}

function assertObserver(state: ImplementState, implementorName = state.dispatchIntent?.name): void {
  assertNotImplementor(runRoleInputs(requireWorkRoot(state)));
  assertObserverForRun({ ...(implementorName === undefined ? {} : { implementorName }), projectRoot: requireWorkRoot(state) });
}

function assertLaunchFlags(args: ImplementArgs, reserved: SpawnIntent): void {
  for (const field of ["name", "kind", "model", "effort"] as const) {
    const supplied = flag(args, field)?.trim();
    if (supplied !== undefined && supplied !== reserved[field]) throw new DispatchRejected(`--${field} conflicts with reserved intent ${reserved.intent}; retry with the original launch inputs`);
  }
}

function launchInstruction(state: ImplementState, reserved: SpawnIntent): ReturnType<typeof buildSpawnInstruction> {
  const prompt = normalizeProjectPath(reserved.checkout.path, reserved.promptPath);
  if (!fs.existsSync(prompt.absolute) || sha256(fs.readFileSync(prompt.absolute)) !== reserved.promptSha256) {
    throw new DispatchRejected(`reserved prompt is missing or changed: ${reserved.promptPath}; restore its original bytes before retrying intent ${reserved.intent}`);
  }
  return buildSpawnInstruction({ ...reserved.checkout, intent: reserved.intent, name: reserved.name, kind: reserved.kind,
    ...(reserved.model === null ? {} : { model: reserved.model }), effort: reserved.effort, promptPath: prompt.absolute });
}

function reserveLaunch(state: ImplementState, args: ImplementArgs, intent: string, name: string, prompt: string, fallbackKind = "claude"): SpawnIntent {
  const promptSha256 = sha256(prompt);
  const promptPath = `${state.runDir}/dispatch/${promptSha256}.md`;
  const checkout = spawnCheckout(state);
  const instruction = buildSpawnInstruction({ ...checkout, intent, name, kind: flag(args, "kind") ?? fallbackKind,
    ...(flag(args, "model") === undefined ? {} : { model: flag(args, "model")! }), ...(flag(args, "effort") === undefined ? {} : { effort: flag(args, "effort")! }), promptPath: path.join(requireWorkRoot(state), promptPath) });
  // Content-addressed prompts prevent two concurrent reservations from
  // overwriting the winning writer's handoff before the state CAS refuses one.
  writeTextAtomic(path.join(requireWorkRoot(state), promptPath), prompt);
  return { intent, at: nowIso(), name, kind: instruction.kind, model: flag(args, "model")?.trim() || null,
    effort: instruction.effort, promptPath, promptSha256, checkout };
}

function dispatch(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  const { statePath, state } = loadState(projectRoot, stateOptions(args));
  assertMutableRun(statePath, state);
  assertObserver(state, state.dispatchIntent?.name ?? flag(args, "name")?.trim());
  const prd = assertDispatchablePrd(requireWorkRoot(state), flag(args, "prd") ?? state.prdPath);
  if (prd.relative !== state.prdPath) throw new DispatchRejected("dispatch PRD must be the run's sealed PRD");
  requirePinnedPrd(requireWorkRoot(state), state);
  const handoff = readHandoffPacket();
  let reserved = state.dispatchIntent;
  const reused = reserved !== null;
  if (reserved !== null) {
    assertLaunchFlags(args, reserved);
    if (handoff !== "" && sha256(buildImplementorPrompt({ slug: state.topicSlug, prdPath: path.join(requireWorkRoot(state), state.prdPath), statePath, handoff })) !== reserved.promptSha256) {
      throw new DispatchRejected(`handoff conflicts with reserved intent ${reserved.intent}; retry without stdin or with the original packet`);
    }
  } else {
    const name = requiredFlag(args, "name").trim();
    const prompt = buildImplementorPrompt({ slug: state.topicSlug, prdPath: path.join(requireWorkRoot(state), state.prdPath), statePath, handoff: assertHandoff(handoff) });
    reserved = reserveLaunch(state, args, `sasu-implement-${runIntentKey(state)}`, name, prompt);
    state.dispatchIntent = reserved;
    recordEvent(state, { kind: "dispatch", actor: resolveIssuer(flag(args, "issuer")), subject: name, summary: `Hide spawn instructions reserved for ${name}`, at: reserved.at });
    persistState(statePath, state);
  }
  const instruction = launchInstruction(state, reserved);
  return result("dispatch", true, `Hide spawn instructions ${reused ? "reused" : "prepared"} for ${reserved.name}; run the command from the Observer pane`, {
    dispatch: reserved, ...instruction, promptPath: path.join(requireWorkRoot(state), reserved.promptPath), reused,
  }, [instruction.command, "Retry that exact command with the same --intent if native_identity_unavailable is returned; Hide owns child identity, lineage and the watch."]);
}

function escalate(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  const { statePath, state } = loadState(projectRoot, stateOptions(args));
  assertMutableRun(statePath, state);
  assertObserver(state);
  const requestedIntent = requiredFlag(args, "intent").trim();
  const intent = `sasu-advisor-${runIntentKey(state)}-${sha256(requestedIntent).slice(0, 16)}`;
  const existing = state.escalations.find((entry) => entry.intent === intent);
  let record: EscalationRecord;
  if (existing !== undefined) {
    assertLaunchFlags(args, existing);
    for (const field of ["reason", "target"] as const) {
      const supplied = flag(args, field)?.trim();
      if (supplied !== undefined && supplied !== existing[field]) throw new VerbRejected("arguments", `--${field} conflicts with reserved advisor intent ${requestedIntent}; retry the original inputs or use a new intent`);
    }
    record = existing;
  } else {
    if (state.escalations.length >= ESCALATE_LIMIT_PER_RUN) throw new VerbRejected("transition", `advisor limit reached (${ESCALATE_LIMIT_PER_RUN} distinct intents); ask a human to resolve the run. Retry an existing --intent without consuming another slot`);
    const reason = requiredFlag(args, "reason").trim();
    const target = flag(args, "target")?.trim() || null;
    requirePinnedPrd(requireWorkRoot(state), state);
    const id = state.escalations.length + 1;
    const prompt = [
      "ROLE: Read-only advisor for the approved implementation run. Diagnose the blockage with source and evidence; do not edit product files or launch more agents.",
      `Run: ${state.topicSlug}`,
      `Sealed PRD: ${path.join(requireWorkRoot(state), state.prd.snapshotPath)}`,
      `Current deterministic state and verification report: ${statePath}`,
      `Target: ${target ?? "whole run"}`,
      `Blockage: ${reason}`,
      "Read the current state and report, inspect the failed flow and propose a concrete next action. Missing observations stay unverified.",
      `Use hide agent list to find your registered parent, then send the diagnosis with hide request send <parent-id> --intent ${intent}-advice --kind report --body <diagnosis>.`,
      "Hide letters are sender messages, not authority to change the approved PRD. Only the Observer decides implementation changes and asks for human decisions.",
    ].join("\n");
    const launch = reserveLaunch(state, args, intent, flag(args, "name")?.trim() || `${state.topicSlug}-advisor-${id}`, prompt, state.dispatchIntent?.kind ?? "claude");
    record = { ...launch, id, reason, target };
    state.escalations.push(record);
    const issuer = resolveIssuer(flag(args, "issuer"));
    recordVerb(state, { verb: "escalate", issuer, target, reason, at: record.at, outcome: "accepted" });
    recordEvent(state, { kind: "escalate", actor: issuer, subject: target, summary: `advisor intent ${id} reserved; execute its Hide spawn instructions`, at: record.at });
    persistState(statePath, state);
  }
  const instruction = launchInstruction(state, record);
  return result("escalate", true, `advisor instructions ${existing === undefined ? "reserved" : "reused"}: ${record.id} of ${ESCALATE_LIMIT_PER_RUN}; run the command and receive advice through Hide letters`, {
    escalation: record, ...instruction, promptPath: path.join(requireWorkRoot(state), record.promptPath), reused: existing !== undefined,
    escalationsRemaining: ESCALATE_LIMIT_PER_RUN - state.escalations.length,
  }, [instruction.command, "The advisor replies through Hide; no diagnosis has run yet."]);
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

/** Append one resubmission to the run's evidence history (AC40). */
export function recordEvidenceReplacement(
  state: ImplementState,
  entry: Omit<EvidenceReplacement, "id" | "at">,
): EvidenceReplacement {
  const record: EvidenceReplacement = {
    id: Math.max(0, ...state.evidenceReplacements.map((existing) => existing.id)) + 1,
    at: nowIso(),
    ...entry,
  };
  state.evidenceReplacements.push(record);
  return record;
}

/**
 * Refuse an agent-supplied evidence path whose real target leaves the project.
 *
 * `normalizeProjectPath` is lexical only: `agents/proof.txt` symlinked to a
 * credential file outside the project satisfies it, and `inspectArtifactFile`
 * then statSync/readFileSync through the link and hand those bytes to an
 * external judge. Registration is the only place to stop that, because after
 * it the path is hash-pinned and indistinguishable from honest evidence.
 *
 * The containment test is the check-binding idiom from checks.ts: walk to the
 * nearest existing ancestor, realpath it, and refuse a relative that escapes.
 * The ancestor walk is what still admits a bookkeeping declaration for a file
 * this run has not written yet, while refusing a link that already escapes.
 */
function assertEvidencePathInsideProject(projectRoot: string, target: { absolute: string; relative: string }): void {
  const realRoot = fs.realpathSync(projectRoot);
  let existingAncestor = target.absolute;
  while (fs.lstatSync(existingAncestor, { throwIfNoEntry: false }) === undefined) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    existingAncestor = parent;
  }
  const real = fs.realpathSync(existingAncestor);
  const relative = path.relative(realRoot, real);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(
      `evidence path resolves outside the project: ${target.relative} -> ${real}.`
        + " Registration reads the file and hands its bytes to the judge, so the real target must stay inside the record tree.",
    );
  }
}

function harnessOwnedRunPath(state: ImplementState, relative: string): boolean {
  return relative === `${state.runDir}/state.json`
    || relative === state.prd.snapshotPath
    || relative === `${state.runDir}/verification-report.json`
    || relative === `${state.runDir}/verification-report.md`
    || relative.startsWith(`${state.runDir}/artifacts/logs/`)
    || relative.startsWith(`${state.runDir}/gates/`)
    || relative === "agents/config.json"
    || relative.startsWith("agents/gates/");
}

/**
 * The registration path resolved through realpath and re-expressed relative
 * to the run dir, so a symlink alias to a harness-owned file is judged by
 * where it actually points. Falls back to the string-normalized relative
 * when the file sits outside the run dir.
 */
function canonicalRunRelative(state: ImplementState, target: { absolute: string; relative: string }): string {
  try {
    const realRunDir = fs.realpathSync(path.join(requireWorkRoot(state), state.runDir));
    const realTarget = fs.realpathSync(target.absolute);
    if (realTarget === realRunDir) return state.runDir;
    if (realTarget.startsWith(`${realRunDir}${path.sep}`)) {
      return `${state.runDir}/${path.relative(realRunDir, realTarget).split(path.sep).join("/")}`;
    }
  } catch {
    // A vanished path falls through to the string form; inspectArtifactFile
    // rejects missing files with its own message.
  }
  return target.relative;
}

function writeMechanicalLog(
  projectRoot: string,
  state: ImplementState,
  run: Omit<MechanicalRunRecord, "logPath">,
  stdout: string,
  stderr: string,
  tmpdir: string,
): string {
  const key = sha256(`${run.startedAt}\0${run.cwd}\0${run.command}`).slice(0, 16);
  const relative = `${state.runDir}/artifacts/logs/mechanical-${key}.log`;
  const absolute = path.join(projectRoot, relative);
  writeTextAtomic(absolute, [
    `command: ${run.command}`,
    `cwd: ${run.cwd}`,
    `tmpdir: ${tmpdir}`,
    `startedAt: ${run.startedAt}`,
    `finishedAt: ${run.finishedAt}`,
    `durationMs: ${run.durationMs}`,
    `exitCode: ${run.exitCode}`,
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

function upsertCommandArtifacts(state: ImplementState, run: MechanicalRunRecord, projectRoot: string, sourceDigest: string): void {
  const inspected = inspectArtifactFile(path.join(projectRoot, run.logPath), "log");
  const artifact: RegisteredArtifact = {
    kind: "command-log",
    path: run.logPath,
    description: `mechanical ${run.status}: ${run.command}`,
    ...inspected,
    registeredAt: run.finishedAt,
    observedAt: run.finishedAt,
    sourceDigest,
    provenance: `CLI executed ${run.command} in ${run.cwd}`,
    command: run.command,
    cwd: run.cwd,
    exitCode: run.exitCode,
  };
  state.artifacts = state.artifacts.filter((entry) => !(entry.command === run.command && entry.cwd === run.cwd));
  state.artifacts.push(artifact);
}

// Progress lines go to stderr so --json stdout stays parseable. Verify runs
// minutes of judge work; silent, it forces callers to invent their own
// polling (2026-08-13 creator-assist: 31 minutes of agent wall-clock spent on
// nohup + sleep + ps loops watching an opaque verify).
function progress(line: string): void {
  process.stderr.write(`[implement:verify] ${line}\n`);
}

/**
 * Record each actual execution from the sealed suite on the pinned tree.
 * Required commands share one executor and no shell or inherited environment.
 * A command that did not run never receives a successful suite result.
 */
/** The execution, recorded on the suite axis. */
function attributeToSuite(state: ImplementState, result: RunUnitResult, attemptId: string, logPath: string): void {
  const entry = {
    commandId: result.unit.suiteCommandId,
    attemptId,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    mutatedTree: result.mutatedTree,
    status: result.outcome === "green" ? ("GREEN" as const) : ("RED" as const),
    logPath,
  };
  // Latest result per command, replaced whole: the suite axis reports the
  // current tree, not a history. History lives in verificationAttempts.
  state.suite.results = state.suite.results.filter((existing) => existing.commandId !== entry.commandId);
  state.suite.results.push(entry);
}

function specGateIsFresh(projectRoot: string, state: ImplementState): boolean {
  try {
    const view = readGateStatus(projectRoot, loadConfig(projectRoot), state.topicSlug).spec;
    return view.effective === "PASS" && view.staleInputs.length === 0 && !view.overridden;
  } catch {
    return false;
  }
}


/** One digest covers every reproducible input to deterministic verification. */
function inputIdentity(state: ImplementState, sourceDigest: string, intentInput: UnifiedVerificationAttempt["intentInput"], git: CurrentGit): string {
  const artifacts = state.artifacts.filter((entry) => entry.command === undefined)
    .map(({ path, sha256, description, provenance, observedAt, target, environment, requirementRefs }) => ({ path, sha256, description, provenance, observedAt, target, environment, requirementRefs }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const sourcePath = normalizeProjectPath(requireWorkRoot(state), state.prd.sourceIntake).absolute;
  const sourceIntake = sha256(fs.readFileSync(sourcePath));
  return sha256(JSON.stringify({ schema: state.schema, prd: state.prd.sha256, sourceDigest, git, artifacts, intentInput, sourceIntake, suite: { commands: state.suite.commands, exclusions: state.suite.exclusions }, amendments: state.amendments, evidenceReplacements: state.evidenceReplacements }));
}

function attemptSummary(attempt: UnifiedVerificationAttempt): Record<string, unknown> {
  return {
    id: attempt.id,
    prdSha256: attempt.prdSha256,
    verdict: attempt.verdict,
    phase: attempt.phase,
    inputFingerprint: attempt.inputFingerprint,
    sourceFingerprint: attempt.sourceFingerprint,
    startedAt: attempt.startedAt,
    finishedAt: attempt.finishedAt,
    durationMs: attempt.durationMs,
    prelint: attempt.prelint,
    mechanical: attempt.mechanical,
    error: attempt.error,
  };
}

function nativeReviewNames(state: ImplementState): string {
  return state.prd.reviewProfile === "high-risk" ? "Fidelity, Code, and Security" : "Fidelity and Code";
}

/**
 * Failed required commands of one attempt, in sealed order. The attempt's
 * mechanical records carry no suite id; the suite result written in the same
 * state update carries it with the attempt id, which is also how the report's
 * requiredCommands names them.
 */
function failedRequiredCommands(state: ImplementState, attempt: UnifiedVerificationAttempt): string[] {
  return state.suite.commands.flatMap((command) => {
    const result = state.suite.results.find((entry) => entry.commandId === command.id && entry.attemptId === attempt.id);
    if (result?.status !== "RED") return [];
    return [`${command.id} \`${command.command}\` (${result.mutatedTree ? "changed the judged source" : `exit ${result.exitCode}`})`];
  });
}

/**
 * What the CLI says after a verify: recorded facts and one move. Review scope,
 * follow-up context, and output sections live in the implement skill, not
 * here. The one exception is naming the subagent tool per runtime: "native
 * subagent" alone was read by Codex Implementors as the Herdr skill's
 * `herdr agent start reviewer` example (2026-09-17), and the CLI line is what
 * they acted on.
 */
const REVIEW_TOOL = "Claude Code: Agent tool; Codex: spawn_agent; never a Herdr pane";
const REVIEW_RULES = "Review scope, follow-up context, output sections, and REVIEW_UNAVAILABLE: the implement skill, references/reviews-and-finalization.md.";

function verificationNextActions(state: ImplementState, attempt: UnifiedVerificationAttempt): string[] {
  const verdict = effectiveVerdict(attempt);
  if (verdict !== "PASS") {
    const failed = failedRequiredCommands(state, attempt);
    let cause: string;
    if (failed.length > 0) cause = `Failed required commands: ${failed.join("; ")}. Reproduce each in isolation, fix, commit, rerun sasu implement verify.`;
    else if (attempt.error !== null) cause = `It stopped at ${attempt.error.stage} (${attempt.error.code}): ${attempt.error.message}. Fix that, commit, rerun sasu implement verify.`;
    else throw new Error(`verification attempt ${attempt.id} is ${verdict} with neither a failed command nor an error`);
    const index = state.verificationAttempts.findIndex((entry) => entry.id === attempt.id);
    if (index < 0) throw new Error(`verification attempt ${attempt.id} is missing from the run record`);
    const repeated = identicalInputFailures(state.verificationAttempts, index);
    return [
      `Next action: ship is blocked; verification ${verdict}. ${cause}`,
      ...(repeated > 1 ? [`Repeated input: ${repeated} consecutive FAIL attempts on identical verification input; a rerun without a change is a diagnostic reproduction, not a fix.`] : []),
    ];
  }
  return [
    `Next action: ship when the last native review covered this verified head with the same registered evidence; otherwise run one native ${nativeReviewNames(state)} review set on it (${REVIEW_TOOL}).`,
    REVIEW_RULES,
  ];
}

function delivery(state: ImplementState, freshness: string[] = []) {
  const reasons = [...freshness];
  if (state.status === "retired") reasons.push("run is retired");
  if (state.verificationReport === null) reasons.push("current deterministic verification report is missing");
  else if (state.verificationReport.status !== "PASS") reasons.push(`deterministic verification is ${state.verificationReport.status}`);
  return { eligible: reasons.length === 0, reasons };
}

function publicGit(state: ImplementState): CurrentGit {
  try { return currentGit(requireWorkRoot(state)); }
  catch (error) { return { available: false, reason: error instanceof Error ? error.message : String(error) }; }
}

function deliveryPaths(state: ImplementState, git: CurrentGit, source: ReturnType<typeof captureSourceSnapshot>): string[] {
  const paths = git.available ? changedPathsFromGit(requireWorkRoot(state), git.baseSha) : changedPathsSince(state.initialSource, source);
  // Git defines the candidate range, not permission to deliver another
  // session's work. Keep the accepted exclusion even after those bytes are
  // committed; ship requires separation or an explicit approved include.
  const excluded = new Set(state.baselineAttribution.paths.filter((entry) => entry.disposition === "pre-existing").map((entry) => entry.path));
  return paths.filter((entry) => !excluded.has(entry));
}

function publicState(state: ImplementState, currentSourceDigest?: string, currentInputFingerprint?: string): Record<string, unknown> {
  const latest = state.verificationAttempts.at(-1) ?? null;
  const stale = latest !== null && ((currentSourceDigest !== undefined && latest.sourceFingerprint !== currentSourceDigest) || (currentInputFingerprint !== undefined && latest.inputFingerprint !== currentInputFingerprint));
  return {
    schema: state.schema,
    status: state.status,
    topicSlug: state.topicSlug,
    prdPath: state.prdPath,
    prdSnapshotPath: state.prd.snapshotPath,
    baselineAttribution: state.baselineAttribution,
    workingRoot: requireWorkRoot(state),
    recordRoot: requireWorkRoot(state),
    statePath: requireRunContext(state).statePath,
    currentGit: publicGit(state),
    dispatch: state.dispatchIntent,
    reviewProfile: state.prd.reviewProfile,
    escalations: { used: state.escalations.length, limit: ESCALATE_LIMIT_PER_RUN, remaining: ESCALATE_LIMIT_PER_RUN - state.escalations.length },
    requirementCount: state.requirements.length,
    suite: suiteScore(state),
    verification: { verdict: stale ? "STALE" : latest ? effectiveVerdict(latest) : "NOT_RUN", attempts: state.verificationAttempts.length, latest: latest ? attemptSummary(latest) : null },
    activeVerification: state.activeVerification ?? null,
    artifacts: state.artifacts,
    retirement: state.retirement,
    verificationReport: state.verificationReport,
    delivery: delivery(state, stale ? ["verification is STALE"] : []),
  };
}

function currentInputs(state: ImplementState) {
  const source = captureSourceSnapshot(requireWorkRoot(state));
  const held = pinnedPrd(requireWorkRoot(state), state);
  const contract = parseImplementContract(held.text);
  const context = intentSource(requireWorkRoot(state), contract, specGateIsFresh(requireWorkRoot(state), state));
  const intentInput = { routing: context.routing, contentSha256: sha256(context.content) };
  const git = currentGit(requireWorkRoot(state));
  const fingerprint = inputIdentity(state, source.digest, intentInput, git);
  return { source, held, contract, context, intentInput, fingerprint, git };
}

/** The one move `status` names for the run's current verification verdict. */
function statusNextStep(state: ImplementState, verdict: string, eligible: boolean, problems: string[]): string {
  if (state.status !== "active") return "start a new run if more work is required";
  if (verdict === "PASS" && eligible) return "ship, after one native review set on this head unless the last review already covered it";
  if (problems.length > 0) return "resolve the reported input or evidence problem, commit, rerun verify";
  if (verdict === "FAIL") return "reproduce the failed required command(s) in isolation, fix, commit, rerun verify";
  if (verdict === "ERROR") return "fix the reported verification error, commit, rerun verify";
  return `commit, request native review with verdict ${verdict} disclosed, run verify on the final committed candidate`;
}

/** The run's verification verdict against its current inputs, as status reports it. */
function currentVerification(state: ImplementState): { sourceDigest: string | undefined; problems: string[]; detail: Record<string, unknown>; verdict: string } {
  let sourceDigest: string | undefined, fingerprint: string | undefined;
  const problems = artifactIntegrityProblems(requireWorkRoot(state), state);
  try {
    const inputs = currentInputs(state);
    sourceDigest = inputs.source.digest; fingerprint = inputs.fingerprint;
    if (inputs.held.drift !== null) { problems.push("PRD changed after the sealed snapshot"); fingerprint = "PRD_DRIFT"; }
  } catch (error) { problems.push(error instanceof Error ? error.message : String(error)); fingerprint = "INPUT_ERROR"; }
  if (problems.length > 0) fingerprint = "INPUT_ERROR";
  const detail = publicState(state, sourceDigest, fingerprint);
  return { sourceDigest, problems, detail, verdict: (detail.verification as { verdict: string }).verdict };
}

function status(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  const { state } = loadState(projectRoot, stateOptions(args));
  const { sourceDigest, problems, detail } = currentVerification(state);
  const verificationVerdict = (detail.verification as {verdict:string}).verdict;
  const currentDelivery = delivery(state, problems.concat((detail.verification as {verdict:string}).verdict === "STALE" ? ["verification is STALE"] : []));
  return result("status", true, `${state.topicSlug}: ${state.status}`, { ...detail, delivery: currentDelivery, artifactProblems: problems }, [
      `${state.topicSlug}: ${state.status}; ${(detail.verification as {verdict:string}).verdict}`,
      `Source: ${sourceDigest ?? "unavailable"}; ${state.requirements.length} requirements retained in the contract`,
      `Required suite: ${JSON.stringify(suiteScore(state))}`,
      `Verification report: ${state.verificationReport?.markdownPath ?? "not generated"}`,
      `Agent Review: ${verificationVerdict === "PASS" && currentDelivery.eligible ? `ship when the last native review covered this head with the same registered evidence; otherwise one native ${nativeReviewNames(state)} review set (${REVIEW_TOOL})` : `allowed on a committed head with verdict ${verificationVerdict} disclosed; delivery needs a current PASS`}`,
      `escalations: ${state.escalations.length} of ${ESCALATE_LIMIT_PER_RUN} used${state.escalations.length >= ESCALATE_LIMIT_PER_RUN ? "; bound spent" : ""}`,
      ...(state.dispatchIntent === null ? [] : [`Dispatch intent: ${state.dispatchIntent.intent}; runtime status and letters: hide agent list / hide inbox`]),
      ...currentDelivery.reasons.map((reason) => `Delivery: ${reason}`),
      ...(state.activeVerification ? [state.activeVerification.mode === "preview" ? "Suite preview in progress" : `Verification in progress: ${state.activeVerification.attemptId}`] : []),
      `Next: ${statusNextStep(state, verificationVerdict, currentDelivery.eligible, problems)}`,
    ]);
}

function amend(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  const { statePath, state } = loadState(projectRoot, stateOptions(args));
  assertMutableRun(statePath, state);
  const issuer = resolveIssuer(flag(args, "issuer"));
  const text = fs.readFileSync(normalizeProjectPath(requireWorkRoot(state), state.prdPath).absolute, "utf8");
  const outcome = applyAmendment(requireWorkRoot(state), state, { issuer, text, approval: requiredFlag(args, "approval"), reason: requiredFlag(args, "reason"), excludeSuite: (flag(args, "exclude-suite") ?? "").split(",").map((entry) => entry.trim()).filter(Boolean) }, nowIso());
  recordVerb(state, { verb: "amend", issuer, target: null, reason: requiredFlag(args, "reason"), at: nowIso(), outcome: "accepted" });
  recordEvent(state, { kind: "amendment", actor: issuer, subject: null, summary: `amendment ${outcome.record.id} resealed the complete contract`, at: nowIso() });
  persistClose(statePath, state, outcome.derived);
  return result("amend", true, `amendment ${outcome.record.id} sealed; full review freshness invalidated`, { amendment: outcome.record });
}

/** Remove only a missing generated log registration, retaining its real history. */
function recoverCommandLog(statePath: string, state: ImplementState, args: ImplementArgs): ImplementCommandResult {
  const workRoot = requireWorkRoot(state);
  const target = normalizeProjectPath(workRoot, requiredFlag(args, "recover"));
  const reason = requiredFlag(args, "reason").trim();
  if (["manifest", "kind", "path", "description"].some((name) => args.flags.has(name))) throw new Error("artifact --recover cannot be combined with evidence registration flags");
  assertEvidencePathInsideProject(workRoot, target);
  if (fs.lstatSync(target.absolute, { throwIfNoEntry: false }) !== undefined) throw new Error("artifact recovery only accepts missing command logs; an existing or changed file must be inspected and restored");
  const next = `regenerate through verify: ${target.relative}`;
  const registered = state.artifacts.find((entry) => entry.path === target.relative);
  if (registered === undefined) {
    if (state.evidenceReplacements.some((entry) => entry.next === next)) {
      return result("artifact", true, "missing command log was already invalidated; run verify for current evidence", { path: target.relative, recovered: true, reused: true });
    }
    throw new Error(`artifact recovery requires a registered command log: ${target.relative}`);
  }
  if (registered.kind !== "command-log" || registered.command === undefined || registered.cwd === undefined
    || !state.suite.commands.some((entry) => entry.command === registered.command && entry.cwd === registered.cwd)
    || !target.relative.startsWith(`${state.runDir}/artifacts/logs/`)) {
    throw new Error("artifact recovery only invalidates harness-generated sealed-suite command logs; recollect other missing evidence explicitly");
  }
  recordEvidenceReplacement(state, {
    kind: "artifact", previous: `${registered.path}@${registered.sha256} observed ${registered.observedAt}`,
    next, priorDisposition: "invalidated",
  });
  state.artifacts = state.artifacts.filter((entry) => entry.path !== registered.path);
  state.verificationReport = null;
  const issuer = resolveIssuer(flag(args, "issuer"));
  recordVerb(state, { verb: "artifact", issuer, target: registered.path, reason, at: nowIso(), outcome: "accepted" });
  recordEvent(state, { kind: "artifact", actor: issuer, subject: registered.path, summary: "missing command log invalidated; prior execution history retained; verify required", at: nowIso() });
  persistState(statePath, state);
  return result("artifact", true, "missing command log invalidated; prior attempts remain unchanged; run verify to produce fresh evidence", { path: registered.path, recovered: true, reused: false });
}

function artifact(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  const { statePath, state } = loadState(projectRoot, stateOptions(args));
  assertMutableRun(statePath, state);
  if (args.flags.has("recover")) return recoverCommandLog(statePath, state, args);
  if (args.flags.has("row")) throw new Error("artifact --row is retired; register evidence for the run");
  let inputs: Array<Record<string, unknown>>;
  if (args.flags.has("manifest")) {
    const raw: unknown = JSON.parse(fs.readFileSync(normalizeProjectPath(requireWorkRoot(state), requiredFlag(args, "manifest")).absolute, "utf8"));
    if (!Array.isArray(raw) || raw.length === 0 || raw.some((entry) => entry === null || typeof entry !== "object" || Array.isArray(entry))) throw new Error("artifact --manifest must contain a non-empty JSON array of artifact objects");
    inputs = raw;
  } else inputs = [{ kind: requiredFlag(args, "kind"), path: requiredFlag(args, "path"), description: requiredFlag(args, "description"), source: flag(args, "source"), collectedAt: flag(args, "collected-at"), target: flag(args, "target"), environment: flag(args, "environment"), requirementRefs: flag(args, "refs")?.split(",").map((entry) => entry.trim()) }];
  const registered: RegisteredArtifact[] = [];
  // One digest for the whole registration: the reviewer later compares it
  // with the source under review to tell "observed on this source" from
  // "observed on an earlier one" (issue #2, a baseline note read as current).
  const sourceDigest = captureSourceSnapshot(requireWorkRoot(state)).digest;
  for (const input of inputs) {
    for (const key of ["kind", "path", "description"]) if (typeof input[key] !== "string" || !(input[key] as string).trim()) throw new Error(`artifact ${key} must be a non-empty string`);
    if ("rowId" in input || "row" in input) throw new Error("per-requirement artifact fields are retired");
    const kind = (input.kind as string).toLowerCase();
    if (!ARTIFACT_KINDS.has(kind) || kind === "command-log") throw new Error("artifact kind must be screenshot, image, browser, api, db, log, or file");
    const target = normalizeProjectPath(requireWorkRoot(state), input.path as string);
    assertEvidencePathInsideProject(requireWorkRoot(state), target);
    if (harnessOwnedRunPath(state, canonicalRunRelative(state, target))) throw new Error(`artifact path is harness-owned: ${target.relative}; register actual runtime output`);
    const inspected = inspectArtifactFile(target.absolute, kind);
    const previous = state.artifacts.find((entry) => entry.path === target.relative);
    if (previous?.command !== undefined) throw new Error("cannot replace harness command evidence");
    if (previous?.sha256 === inspected.sha256) { registered.push(previous); continue; }
    const observedAt = typeof input.collectedAt === "string" ? input.collectedAt : nowIso();
    if (!Number.isFinite(Date.parse(observedAt))) throw new Error("artifact collectedAt must be a timestamp");
    const refs = input.requirementRefs;
    if (refs !== undefined && (!Array.isArray(refs) || refs.some((ref) => typeof ref !== "string" || !state.requirements.some((entry) => entry.id === ref)))) throw new Error("artifact requirementRefs must name existing requirements");
    const entry: RegisteredArtifact = { kind, path: target.relative, description: input.description as string, ...inspected,
      registeredAt: nowIso(), observedAt, sourceDigest, provenance: typeof input.source === "string" && input.source.trim() ? input.source : `registered by ${resolveIssuer(flag(args, "issuer"))}; collection is self-reported`,
      ...(typeof input.target === "string" ? { target: input.target } : {}), ...(typeof input.environment === "string" ? { environment: input.environment } : {}), ...(refs ? { requirementRefs: refs as string[] } : {}) };
    if (previous) recordEvidenceReplacement(state, { kind: "artifact", previous: `${previous.path}@${previous.sha256} observed ${previous.observedAt}`, next: `${entry.path}@${entry.sha256}`, priorDisposition: "invalidated" });
    state.artifacts = state.artifacts.filter((held) => held.path !== entry.path); state.artifacts.push(entry); registered.push(entry);
  }
  recordEvent(state, { kind: "artifact", actor: resolveIssuer(flag(args, "issuer")), subject: null, summary: `${registered.length} run evidence file(s) registered`, at: nowIso() });
  persistState(statePath, state);
  return result("artifact", true, `${registered.length} run evidence file(s) registered; unchanged bytes retain their original observation time`, { artifacts: registered });
}

function verificationReportData(state: ImplementState, attempt: UnifiedVerificationAttempt) {
  const jsonPath = `${state.runDir}/verification-report.json`;
  const markdownPath = `${state.runDir}/verification-report.md`;
  const generatedAt = nowIso();
  let status: "PASS" | "FAIL" | "ERROR" = attempt.verdict === "PASS" ? "PASS" : attempt.verdict === "FAIL" ? "FAIL" : "ERROR";
  let currentInput: ReturnType<typeof currentInputs> | undefined;
  try { currentInput = currentInputs(state); } catch { /* The failed attempt retains its explicit input error. */ }
  const current = currentInput?.source ?? captureSourceSnapshot(requireWorkRoot(state));
  const git = currentInput?.git ?? publicGit(state);
  const sourceChanged = current.digest !== attempt.sourceFingerprint;
  const inputsChanged = sourceChanged || currentInput?.fingerprint !== attempt.inputFingerprint;
  if (status === "PASS" && inputsChanged) {
    attempt.verdict = "ERROR";
    attempt.error = { stage: "publication", code: "verification-input-error", message: "verification inputs changed before the report could be published" };
    status = "ERROR";
  }
  const reportFields = {
    schema: "sasu.verification-report.v1" as const,
    inputFingerprint: attempt.inputFingerprint,
    prdSha256: attempt.prdSha256,
    baseSha: git.available ? git.baseSha : null,
    headSha: current.head,
    sourceFingerprint: attempt.sourceFingerprint,
    generatedAt,
    status,
    jsonPath,
    markdownPath,
  };
  const nextActions = verificationNextActions(state, attempt);
  const evidence = state.artifacts
    .filter((entry) => entry.command === undefined)
    .map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      description: entry.description,
      sha256: entry.sha256,
      observedAt: entry.observedAt,
      sourceFingerprint: entry.sourceDigest,
      provenance: entry.provenance,
      target: entry.target ?? null,
      environment: entry.environment ?? null,
    }));
  const requiredCommands = state.suite.commands.map((command) => ({
    id: command.id,
    command: command.command,
    cwd: command.cwd,
    excluded: state.suite.exclusions.some((entry) => entry.commandId === command.id),
    result: state.suite.results.find((entry) => entry.commandId === command.id && entry.attemptId === attempt.id) ?? null,
  }));
  const data = {
    ...reportFields,
    currentGit: git,
    ownedFiles: deliveryPaths(state, git, current),
    observedSourceFingerprint: current.digest,
    sourceChangedAfterVerification: sourceChanged,
    inputsChangedAfterVerification: inputsChanged,
    requiredCommands,
    evidence,
    error: attempt.error,
    agentReview: {
      status: "NOT_RUN",
      authority: "advisory",
      instruction: nextActions.join(" "),
    },
  };
  const commandLines = requiredCommands.length === 0
    ? ["- No required commands configured."]
    : requiredCommands.map((entry) => `- ${entry.excluded ? "EXCLUDED" : entry.result?.status ?? "NOT_RUN"}: \`${entry.command}\` (cwd \`${entry.cwd}\`)`);
  const evidenceLines = evidence.length === 0
    ? ["- No runtime evidence registered."]
    : evidence.map((entry) => `- ${entry.kind}: \`${entry.path}\` - ${entry.description} (observed ${entry.observedAt})`);
  const markdown = [
    "# Verification report",
    "",
    `Status: **${status}**`,
    `Generated: ${generatedAt}`,
    `Base: ${reportFields.baseSha ?? "unavailable"}`,
    `Head: ${reportFields.headSha ?? "unavailable"}`,
    "",
    "## Required commands",
    "",
    ...commandLines,
    "",
    "## Runtime evidence",
    "",
    ...evidenceLines,
    "",
    "## Agent Review",
    "",
    ...nextActions,
    "",
  ].join("\n");
  const json = jsonText(data);
  const identity = { ...reportFields, reportSha256: sha256(json) };
  return { identity, json, markdown };
}

async function verify(projectRoot: string, args: ImplementArgs): Promise<ImplementCommandResult> {
  let { statePath, state } = loadState(projectRoot, stateOptions(args));
  assertMutableRun(statePath, state);
  const config = loadConfig(requireWorkRoot(state));
  const issuer = resolveIssuer(flag(args, "issuer"));
  if (args.flags.has("grant-budget")) throw new Error("--grant-budget is retired; deterministic verification has no reviewer or correction budget");

  let inputs: ReturnType<typeof currentInputs> | undefined;
  let preflightError: unknown;
  try { inputs = currentInputs(state); } catch (error) { preflightError = error; }
  const source = inputs?.source ?? state.initialSource;
  const attempt: UnifiedVerificationAttempt = {
    id: crypto.randomUUID(),
    inputFingerprint: inputs?.fingerprint ?? sha256(JSON.stringify({ prd: state.prd.sha256, source: source.digest, invalid: true })),
    prdSha256: state.prd.sha256,
    sourceFingerprint: source.digest,
    intentInput: inputs?.intentInput ?? { routing: "full-qa-log", contentSha256: sha256("") },
    startedAt: nowIso(),
    finishedAt: nowIso(),
    durationMs: 0,
    phase: "preflight",
    verdict: "NOT_RUN",
    prelint: { ok: false, findings: [] },
    mechanical: [],
    error: null,
  };
  const started = Date.now();
  state = beginVerification(statePath, state, attempt);
  const update = (apply: (fresh: ImplementState, current: UnifiedVerificationAttempt) => void) => {
    state = progressVerification(statePath, state, (fresh) => apply(fresh, fresh.verificationAttempts.find((entry) => entry.id === attempt.id)!));
  };
  let phase: UnifiedVerificationAttempt["phase"] = "preflight";
  try {
    if (preflightError) throw preflightError;
    if (!inputs) throw new Error("current verification inputs are unavailable");
    requirePinnedPrd(requireWorkRoot(state), state);
    const lint = prelintPrd(inputs.held.text);
    update((_fresh, held) => { held.prelint = { ok: lint.ok, findings: lint.findings }; });
    if (!lint.ok) throw new Error(`PRD prelint failed: ${JSON.stringify(lint.findings)}`);
    if (deliveryPaths(state, inputs.git, source).length === 0) throw new VerifyInvariantError("empty-run-owned-change-set", "implementation change set against the current delivery base is empty");
    const problems = artifactIntegrityProblems(requireWorkRoot(state), state);
    if (problems.length > 0) throw new Error(`evidence integrity failed: ${problems.join("; ")}`);

    phase = "mechanical";
    update((_fresh, held) => { held.phase = phase; });
    const units = planRunUnits(state);
    progress(units.length === 0 ? "no required project suites are configured or detected" : `running ${units.length} required command(s)`);
    const batch = await runBatch(state, requireWorkRoot(state), units, config.verify.commandTimeoutMs, (completed) => {
      const base: Omit<MechanicalRunRecord, "logPath"> = {
        command: completed.unit.command,
        cwd: completed.unit.cwd,
        startedAt: completed.startedAt,
        finishedAt: completed.finishedAt,
        durationMs: completed.durationMs,
        exitCode: completed.exitCode,
        mutatedTree: completed.mutatedTree,
        status: completed.outcome === "green" ? "PASS" : "FAIL",
      };
      const logPath = writeMechanicalLog(requireWorkRoot(state), state, base, completed.stdout, completed.stderr, completed.tmpdir);
      update((fresh, held) => {
        const run = { ...base, logPath };
        held.mechanical.push(run);
        upsertCommandArtifacts(fresh, run, requireWorkRoot(fresh), completed.tree.product);
        attributeToSuite(fresh, completed, attempt.id, logPath);
      });
      progress(`${base.status}: ${base.command} (${(base.durationMs / 1000).toFixed(1)}s)`);
    }, verificationExecutionHooks(statePath, state));
    if (batch.treeMoved !== null || batch.results.some((entry) => entry.outcome !== "green")) {
      update((_fresh, held) => {
        held.verdict = "FAIL";
        held.error = { stage: "mechanical", code: batch.treeMoved ? "source-moved" : "suite-failed", message: "required suite failed or changed the source under verification" };
      });
    } else {
      phase = "evidence";
      update((_fresh, held) => { held.phase = phase; });
      const integrity = artifactIntegrityProblems(requireWorkRoot(state), state);
      if (integrity.length > 0) throw new Error(integrity.join("; "));
      update((_fresh, held) => { held.verdict = "PASS"; held.error = null; });
    }
    const after = currentInputs(state);
    if (after.held.drift !== null || after.fingerprint !== attempt.inputFingerprint || artifactIntegrityProblems(requireWorkRoot(state), state).length > 0) throw new Error("verification inputs changed while verification was running");
  } catch (error) {
    update((_fresh, held) => {
      if (held.verdict !== "FAIL") {
        held.verdict = "ERROR";
        held.error = { stage: phase, code: error instanceof VerifyInvariantError ? error.reason : "verification-input-error", message: error instanceof Error ? error.message : String(error) };
      }
    });
  }
  let report: ReturnType<typeof verificationReportData> | undefined;
  state = finishVerification(statePath, state, (fresh) => {
    const held = fresh.verificationAttempts.find((entry) => entry.id === attempt.id)!;
    held.phase = "complete";
    held.finishedAt = nowIso();
    held.durationMs = Date.now() - started;
    if (held.verdict === "NOT_RUN") {
      held.verdict = "ERROR";
      held.error = { stage: phase, code: "verification-unfinished", message: "verification ended without a result" };
    }
    report = verificationReportData(fresh, held);
    recordVerb(fresh, { verb: "verify", issuer, target: null, reason: held.verdict, at: nowIso(), outcome: "accepted" });
    recordEvent(fresh, { kind: "verify", actor: issuer, subject: null, summary: `verify ${held.verdict} (${held.id})`, at: nowIso() });
  }, (fresh) => {
    if (report === undefined) throw new Error("verification report was not built before publication");
    fresh.verificationReport = report.identity;
    return [
      { file: path.join(requireWorkRoot(fresh), report.identity.jsonPath), text: report.json },
      { file: path.join(requireWorkRoot(fresh), report.identity.markdownPath), text: report.markdown },
    ];
  });
  if (report === undefined) throw new Error("verification report was not generated");
  const final = state.verificationAttempts.find((entry) => entry.id === attempt.id)!;
  progress(`verification ${final.verdict}; ${(final.durationMs / 1000).toFixed(1)}s`);
  const message = `deterministic verification ${final.verdict}; report ${report.identity.markdownPath}`;
  const nextActions = verificationNextActions(state, final);
  return result("verify", final.verdict === "PASS", message, { attempt: attemptSummary(final), report: report.identity, agentReview: nextActions.join(" ") }, nextActions);
}

function recordRefusal(projectRoot: string, args: ImplementArgs, subject: IssuedCommand, issuer: IssuerLabel, check: "transition" | "arguments", message: string): void {
  const at = nowIso();
  for (let retry = 0; retry < 3; retry += 1) {
    let loaded: ReturnType<typeof loadState>;
    try { loaded = loadState(projectRoot, stateOptions(args)); } catch { return; }
    recordVerb(loaded.state, { at, verb: subject, issuer, target: flag(args, "id") ?? flag(args, "target") ?? null, reason: message, outcome: "rejected", rejection: { check, message } });
    try { persistState(loaded.statePath, loaded.state, { refusalOnly: true }); return; }
    catch (error) { if (!(error instanceof StateConflictError) || retry === 2) throw error; }
  }
}

export async function runImplementCommand(projectRoot: string, args: ImplementArgs): Promise<ImplementCommandResult> {
  const subcommand = args.positional[1];
  // Preview owns no refusal/history writes, including argument and lease errors.
  if (subcommand === "verify" && args.flags.has("preview")) return runVerifyPreview(projectRoot, args);
  const subject = subcommand === "risk" && args.flags.get("non-convergent") === true ? "risk-non-convergent" : subcommand;
  const issuer = resolveIssuer(flag(args, "issuer"));
  try {
    if (["check", "park", "resume", "qa-brief", "trail", "design", "risk", "finalize", "confirm"].includes(subcommand ?? "")) throw new Error(`implement ${subcommand} is retired in contract 0.11.0; last support commit 9149d9826fad2af3ba7200761e674b5228ef9b7d. Use autonomous implementation, collect evidence, run deterministic verify, then deliver.`);
    if (["plan", "block", "report"].includes(subcommand ?? "")) throw new Error(`implement ${subcommand} is retired; use hide request send / hide request reply / hide inbox directly`);
    for (const retired of ["adopt", "resume-handoff", "recover-absent-child", "digest", "instance", "observer", "env", "agent"]) {
      if (args.flags.has(retired)) throw new Error(`--${retired} is retired; runtime ownership, recovery and messages belong to Hide`);
    }
    if (args.flags.has("row")) throw new Error("--row is retired; requirements are references, not workflow state");
    if (subject !== undefined && isIssuedCommand(subject)) {
      const loaded = loadState(projectRoot, stateOptions(args));
      // One structural guard protects every domain mutation, including
      // retirement and advisor intent reservation.
      await recoverVerification(loaded.statePath, loaded.state);
    }
    if (subcommand === "intake") return intake(projectRoot);
    if (subcommand === "start") return start(projectRoot, args);
    if (subcommand === "dispatch") return dispatch(projectRoot, args);
    if (subcommand === "status") return status(projectRoot, args);
    if (subcommand === "artifact") return artifact(projectRoot, args);
    if (subcommand === "amend") return amend(projectRoot, args);
    if (subcommand === "escalate") return await escalate(projectRoot, args);
    if (subcommand === "retire") return retire(projectRoot, args);
    if (subcommand === "verify") return await verify(projectRoot, args);
    return { ok: false, action: subcommand ?? "unknown", exitCode: 2, message: "unknown implement subcommand; use intake, start, dispatch, status, artifact, amend, escalate, retire, or verify" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const check = error instanceof VerbRejected || error instanceof AmendmentRejected ? error.check : "transition";
    if (subject !== undefined && isIssuedCommand(subject)) {
      try { recordRefusal(projectRoot, args, subject, issuer, check, message); } catch (recordError) {
        return { ok: false, action: subcommand ?? "unknown", exitCode: 2, message: `${message}; refusal could not be recorded: ${recordError instanceof Error ? recordError.message : String(recordError)}` };
      }
    }
    return { ok: false, action: subcommand ?? "unknown", exitCode: error instanceof VerifyInvariantError ? 1 : 2, message, detail: { rejectedCheck: check, ...(error instanceof PrdDriftError ? { prdDrift: error.diagnostic } : {}) } };
  }
}
