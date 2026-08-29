import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../config";
import { readGateStatus } from "../gates/commands";
import { prelintPrd } from "../gates/prelint";
import { CHECK_TAIL_RENDER_MAX_CHARS, EVIDENCE_RENDER_MAX_CHARS, type CheckResult, type EvidenceMaterial } from "../gates/prompts";
import { runJudge, judgeCallRecordFrom } from "../judge/runner";
import { judgeFanoutLimit, mapWithConcurrency } from "../judge/fanout";
import {
  JUDGE_ERROR_LOOP_THRESHOLD,
  JudgeError,
  describeJudgeFailureCause,
  judgeFailureCause,
  validateSemanticVerdict,
  type JudgeFailureCause,
} from "../judge/types";
import { runDirRel } from "../runs/paths";
import { currentSessionId } from "../runs/session";
import {
  latestAttemptResult,
  reconcileRiskFindings,
  validateRiskVerdict,
  validateVerdictDelta,
  verificationInputManifest,
  verificationRoundContext,
} from "./convergence";
import { provisionWorktree, type WorktreeProvision } from "./worktree";
import { mechanicalBindings, parseImplementContract, reviewProfile, type ImplementContract } from "./contract";
import { planRunUnits, runBatch, type RunUnit, type RunUnitResult } from "./runner";
import {
  bindCriterionCheck,
  checkLedgerForCriterion,
  checkLedgerPayload,
  criterionCheckIsGreen,
  parkCriterion,
  resumeCriterion,
  runCriterionCheck,
  validateCheckBinding,
  parseCommandArgv,
  fingerprintCheckOutput,
} from "./checks";
import {
  acceptancePrompt,
  agentRegisteredArtifactProvenance,
  designPrompt,
  fidelityPrompt,
  fidelitySource,
  IMPLEMENT_REVIEW_DIFF_MAX_CHARS,
  riskPrompt,
  type AcceptancePromptMaterial,
} from "./prompts";
import { pinnedPrd, PrdDriftError, prdSnapshotPath, requirePinnedPrd, writePrdSnapshot } from "./prd-snapshot";
import {
  artifactIntegrityProblems,
  captureBaselineSnapshot,
  captureSourceSnapshot,
  changedPathsSince,
  dirtySourcePaths,
  loadState,
  normalizeProjectPath,
  nowIso,
  persistState,
  requireWorkRoot,
  sha256,
  statePathFor,
  writeActivePointer,
  writeJsonAtomic,
  writeTextAtomic,
} from "./store";
import {
  IMPLEMENT_SCHEMA,
  type AcceptanceCriterionItem,
  type AcceptanceCriterionInvocation,
  type AcLaneResult,
  type ContractItem,
  type DesignComment,
  type DirtyAttribution,
  type TrackedDesignComment,
  type FidelityCheckResult,
  type ImplementCommandResult,
  type ImplementState,
  type LaneRecord,
  type MechanicalBinding,
  type MechanicalRunRecord,
  type RegisteredArtifact,
  type RiskLaneResult,
  type TaskItem,
  type TrackedRiskFinding,
  type UnifiedVerificationAttempt,
  type VerificationItem,
  type VerificationStatus,
  type VerificationInputManifest,
  type VerificationRoundContext,
  type VerificationRoundContexts,
} from "./types";

export interface ImplementArgs {
  positional: string[];
  flags: Map<string, string | true>;
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

function result(action: string, ok: boolean, message: string, detail?: Record<string, unknown>): ImplementCommandResult {
  return { ok, action, exitCode: ok ? 0 : 1, message, ...(detail !== undefined ? { detail } : {}) };
}

class VerifyInvariantError extends Error {
  constructor(readonly reason: "empty-run-owned-change-set", message: string) {
    super(message);
    this.name = "VerifyInvariantError";
  }
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
    skippedAcceptanceCriteria: attempt.skippedAcceptanceCriteria,
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
    .map((entry) => ({
      verificationId: entry.verificationId ?? null,
      acceptanceCriterionId: entry.acceptanceCriterionId ?? null,
      path: entry.path,
      sha256: entry.sha256,
    }))
    .sort((left, right) => `${left.acceptanceCriterionId ?? left.verificationId}:${left.path}`.localeCompare(`${right.acceptanceCriterionId ?? right.verificationId}:${right.path}`));
  return sha256(JSON.stringify({
    schema: state.schema,
    prdSha256: state.prd.sha256,
    sourceDigest,
    artifacts,
    checkLedger: checkLedgerPayload(state).sha256,
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
  judgeErrorThreshold: number;
  judgeErrorCause: string | null;
  judgeErrorLoop: boolean;
  grants: number;
}

/**
 * A round that never reached a judge. Prelint or a mechanical command settles
 * before any lane is invoked, so the round costs no judge call and its failure
 * is a deterministic exit code rather than a fresh generative opinion.
 */
function calledNoJudge(attempt: UnifiedVerificationAttempt): boolean {
  return attempt.lanes.acceptance === null && attempt.lanes.fidelity === null && attempt.lanes.risk === null;
}

function verificationJudgeErrorCause(
  attempt: UnifiedVerificationAttempt,
): { key: string; label: string } | null {
  const causes: JudgeFailureCause[] = [];
  for (const invocation of attempt.lanes.acceptance?.result?.invocations ?? []) {
    if (invocation.verdict === "ERROR" && invocation.error?.cause !== undefined) {
      causes.push(invocation.error.cause);
    }
  }
  if (attempt.lanes.fidelity?.verdict === "ERROR" && attempt.lanes.fidelity.error?.cause !== undefined) {
    causes.push(attempt.lanes.fidelity.error.cause);
  }
  const unique = new Map(causes.map((cause) => [
    `${cause.backend}\0${cause.code}\0${cause.reason ?? ""}`,
    cause,
  ]));
  const ordered = [...unique.entries()].sort(([left], [right]) => left.localeCompare(right));
  if (ordered.length === 0) return null;
  return {
    key: ordered.map(([key]) => key).join("|"),
    label: ordered.map(([, cause]) => describeJudgeFailureCause(cause)).join(", "),
  };
}

function verificationBudget(state: ImplementState, budget: number): VerificationBudgetView {
  let fixAttempts = 0;
  let consecutiveErrors = 0;
  let consecutiveErrorKey: string | null = null;
  let consecutiveErrorLabel: string | null = null;
  const grants = state.budgetGrants ?? [];
  // A recorded user grant opens a fresh budget: attempts before the latest
  // grant no longer count against either gauge.
  const countFrom = grants.length === 0 ? 0 : grants[grants.length - 1]!.attemptCountBefore;
  for (let index = countFrom; index < state.verificationAttempts.length; index += 1) {
    const attempt = state.verificationAttempts[index]!;
    if (attempt.verdict === "PASS") {
      fixAttempts = 0;
      consecutiveErrors = 0;
      consecutiveErrorKey = null;
      consecutiveErrorLabel = null;
      continue;
    }
    if (attempt.verdict === "ERROR") {
      const cause = verificationJudgeErrorCause(attempt);
      if (cause === null) {
        // Pre-structured records cannot prove that two errors were the same
        // failure class. They stay fail-closed as ERROR but never manufacture
        // a circuit-breaker diagnosis from prose.
        consecutiveErrors = 0;
        consecutiveErrorKey = null;
        consecutiveErrorLabel = null;
        continue;
      }
      consecutiveErrors = consecutiveErrorKey === cause.key ? consecutiveErrors + 1 : 1;
      consecutiveErrorKey = cause.key;
      consecutiveErrorLabel = cause.label;
      continue;
    }
    // Prelint is a free structural correction.
    if (attempt.error?.stage === "prelint") continue;
    // The budget bounds repeated non-PASS generative voting lanes. The open-
    // ended risk reviewer no longer votes; its findings converge through the
    // ledger instead (PRINCIPLES 13). A round that called no judge is not that
    // stage - a failing test suite or
    // a mis-declared binding converges on a fixed exit code - so it is free,
    // provided the tree or the pinned inputs actually moved since the last
    // attempt. That proviso is the whole bound: without new work there is no
    // new answer, and the round is charged exactly like a judged one.
    // 2026-08-17 herdr-remote-handoff: deterministic pre-judge failures (a
    // 17ms mis-declared binding and a 10.6s own test failure) spent the budget
    // intended for generative opinions and helped close a finished run blocked.
    const previous = index > countFrom ? state.verificationAttempts[index - 1]! : null;
    // The first no-judge round has no generative verdict to bound and no prior
    // attempt against which progress could be measured. Charging it was the
    // observed off-by-one: a deterministic pre-judge failure spent budget
    // before any judge existed. Later identical no-judge rounds are still
    // charged so an unfixed command cannot loop forever.
    const advanced = previous === null
      || previous.sourceFingerprint !== attempt.sourceFingerprint
      || previous.inputFingerprint !== attempt.inputFingerprint;
    if (calledNoJudge(attempt) && advanced) continue;
    fixAttempts += 1;
    consecutiveErrors = 0;
    consecutiveErrorKey = null;
    consecutiveErrorLabel = null;
  }
  return {
    fixAttempts,
    totalAttempts: state.verificationAttempts.length,
    budget,
    budgetExhausted: fixAttempts > 0 && fixAttempts >= budget,
    consecutiveErrors,
    judgeErrorThreshold: JUDGE_ERROR_LOOP_THRESHOLD,
    judgeErrorCause: consecutiveErrorLabel,
    judgeErrorLoop: consecutiveErrors >= JUDGE_ERROR_LOOP_THRESHOLD,
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
    return `unified judge failed ${view.consecutiveErrors}/${view.judgeErrorThreshold} times in a row with the same cause (${view.judgeErrorCause ?? "unknown"}) and without a verdict; ${exits}`;
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
  const openRisk = state.riskFindings.filter((entry) => entry.status === "open");
  const parked = state.acceptanceCriteria.filter((entry) => entry.check.status === "parked");
  const decisionPoints = state.acceptanceCriteria.flatMap((entry) => entry.check.decisionPoints
    .filter((point) => point.resolvedAt === null)
    .map((point) => ({ criterionId: entry.id, ...point })));
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
    prdSnapshotPath: state.prd.snapshotPath,
    baselineAttribution: state.baselineAttribution,
    // The judged tree: agents edit files here, never in the record tree.
    workingRoot: state.worktree?.path ?? state.projectRoot,
    worktree: state.worktree ?? null,
    reviewProfile: state.prd.reviewProfile,
    counts: {
      tasksOpen: state.tasks.filter((entry) => entry.status !== "complete").length,
      acceptanceOpen: state.acceptanceCriteria.filter((entry) => entry.status !== "complete").length,
      verificationNotPassed: state.verification.filter((entry) => entry.requiredForDone && entry.status !== "PASS").length,
      riskFindingsOpen: openRisk.length,
      acceptanceParked: parked.length,
      decisionPointsOpen: decisionPoints.length,
    },
    acceptanceChecks: state.acceptanceCriteria.map((entry) => ({
      id: entry.id,
      judgment: entry.judgment,
      status: entry.check.status,
      binding: entry.check.bindings.at(-1) ?? null,
      attempts: entry.check.attempts.length,
      consecutiveFailures: entry.check.consecutiveFailures,
    })),
    parked: parked.map((entry) => ({ id: entry.id, park: entry.check.parks.at(-1) })),
    decisionPoints,
    riskFindings: {
      openCount: openRisk.length,
      open: openRisk.map((entry) => ({ id: entry.id, severity: entry.severity, text: entry.text.slice(0, 80) })),
    },
    verification: {
      verdict: effectiveVerdict,
      attempts: state.verificationAttempts.length,
      budget: verificationBudget(state, retryBudget),
      latest: latest === null ? null : attemptSummary(latest),
    },
    artifacts: state.artifacts,
    retirement: state.retirement,
    completion: state.completion,
  };
}

/**
 * One working tree hosts at most one active in-place run: a second run in
 * the same tree shares its freshness digests and judged diff, so both runs'
 * verifications poison each other (2026-08-17 dual-implement live run: two
 * concurrent codex sessions, both FAILed fidelity on each other's files).
 * The occupant is read from the harness's own records, never guessed.
 */
function activeInPlaceRun(projectRoot: string): string | null {
  const runsDir = path.join(projectRoot, "agents", "runs");
  if (!fs.existsSync(runsDir)) return null;
  for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const statePath = path.join(runsDir, entry.name, "state.json");
    if (!fs.existsSync(statePath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as Partial<ImplementState>;
      if (parsed.schema === IMPLEMENT_SCHEMA && parsed.status === "active" && (parsed.worktree ?? null) === null) return entry.name;
    } catch {
      // A malformed state is not an occupancy signal.
    }
  }
  return null;
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
  if (contract.tasks.length === 0 || contract.acceptanceCriteria.length === 0 || contract.verification.length === 0) {
    throw new Error("PRD is missing tasks, acceptance criteria, or verification items");
  }
  const incompleteAcceptance = contract.acceptanceCriteria.filter((criterion) =>
    criterion.judgment === null || (criterion.judgment === "judged" && criterion.evidenceDeclaration === null));
  if (incompleteAcceptance.length > 0) {
    throw new Error(
      `PRD acceptance contract is incomplete: ${incompleteAcceptance.map((criterion) => criterion.id).join(", ")}. `
      + "Every AC must use the canonical table with Judgment, and judged ACs require Evidence Declaration.",
    );
  }
  const slug = slugFromPrd(prd.absolute);
  const sourceIntake = contract.frontmatter["source_intake"] ?? "";
  const gateViews = readGateStatus(projectRoot, config, slug);
  const activePrdGates = (["gap-audit", "spec"] as const).filter((gate) => gateViews[gate].inFlight);
  if (activePrdGates.length > 0) {
    throw new Error(
      `implement start refused: PRD review still in flight (${activePrdGates.join(", ")}); wait for the gate to finish and inspect its final status`,
    );
  }
  if (sourceIntake !== "" && path.basename(sourceIntake) === "qa-log.md") {
    const incomplete = (["gap-audit", "spec"] as const).filter((gate) => gateViews[gate].effective !== "PASS");
    if (incomplete.length > 0) {
      const statuses = incomplete.map((gate) => `${gate}=${gateViews[gate].effective}`).join(", ");
      throw new Error(
        `implement start refused: qa-log-backed PRD requires live PASS for gap-audit and spec; got ${statuses}`,
      );
    }
  }
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
  // Isolation decision: worktree.enabled isolates every run; otherwise a run
  // only diverts when this tree already hosts an active in-place run.
  const occupant = activeInPlaceRun(projectRoot);
  const isolate = config.worktree.enabled || occupant !== null;
  const requestedAttribution = flag(args, "dirty-attribution");
  // In-place runs can reject before provisioning. An isolated worktree starts
  // from committed bytes but configured copy/setup steps may dirty it, so the
  // provisioner validates the prepared tree inside its all-or-nothing cleanup
  // boundary. Either way ownership is explicit before state exists
  // (PRINCIPLES 4, 10, 11).
  const sourceDirty = dirtySourcePaths(projectRoot);
  if (sourceDirty.length > 0 && requestedAttribution === undefined) {
    throw dirtyAttributionRefusal(sourceDirty);
  }
  const initializeState = (
    worktree: WorktreeProvision | null,
    pathAttributions: Array<{ path: string; disposition: DirtyAttribution }>,
  ): ImplementState => {
    const workRoot = worktree?.path ?? projectRoot;
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
      projectRoot,
      worktree,
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
      },
      initialSource: baseline,
      baselineAttribution: {
        disposition: aggregateAttribution,
        paths: pathAttributions,
        baselineDigest: baseline.digest,
        head: baseline.head,
      },
      ownerSessionId: currentSessionId(),
      adoptions: [],
      tasks: contract.tasks,
      requirements: contract.requirements,
      acceptanceCriteria: contract.acceptanceCriteria,
      verification: contract.verification,
      artifacts: [],
      verificationAttempts: [],
      budgetGrants: [],
      deviations: [],
      riskFindings: [],
      events: [],
      verbs: [],
      amendments: [],
      // Sealed here, at start, and never re-derived: a mid-run edit of
      // agents/config.json must not change what this run is measured
      // against (AC5). From this point the sealed list is the authority and
      // the config file is only the source it was taken from.
      suite: {
        sealedAt: createdAt,
        commands: mechanicalBindings(projectRoot, workRoot, contract.verification).map((binding, index) => ({
          id: `S${index + 1}`,
          command: binding.command,
          argv: parseCommandArgv(binding.command),
          cwd: binding.cwd,
          verificationIds: binding.verificationIds,
        })),
        exclusions: [],
        results: [],
      },
      qaBriefs: [],
      trails: [],
      escalations: [],
      retirement: null,
      completion: null,
      createdAt,
      updatedAt: createdAt,
    };
    fs.mkdirSync(path.join(projectRoot, state.runDir, "artifacts", "logs"), { recursive: true });
    writePrdSnapshot(projectRoot, snapshotPath, text);
    // state.json is the commit point. Until this atomic write succeeds, an
    // isolated provision remains inside the cleanup boundary. Navigation
    // pointers are written afterward because they are not run authority.
    writeJsonAtomic(statePath, state);
    return state;
  };
  const runDirAbsolute = path.join(projectRoot, runDirRel(slug));
  const state = isolate
    ? provisionWorktree(
        projectRoot,
        slug,
        runDirAbsolute,
        config.worktree,
        config.verify.commandTimeoutMs,
        sourceDirty,
        (prepared) => {
          const dirtyPaths = dirtySourcePaths(prepared.path);
          if (dirtyPaths.length > 0 && requestedAttribution === undefined) throw dirtyAttributionRefusal(dirtyPaths);
          return initializeState(prepared, resolveDirtyAttributions(dirtyPaths, requestedAttribution));
        },
      )
    : initializeState(null, resolveDirtyAttributions(sourceDirty, requestedAttribution));
  writeActivePointer(projectRoot, state);
  const startedWorktree = state.worktree ?? null;
  const message = startedWorktree === null
    ? `implement run started: ${slug}`
    : `implement run started: ${slug} in isolated worktree ${startedWorktree.path} (branch ${startedWorktree.branch})` +
      `${occupant !== null ? ` because run '${occupant}' is active in this tree` : ""} - implement the tasks there; records stay in this tree's agents/`;
  return result("start", true, message, publicState(state, config.judge.retryBudget));
}

/**
 * Ownership guard for every mutating command; `status` stays open. The run's
 * owner is `state.ownerSessionId` alone (see types.ts for the incident that
 * bans a second copy). An unowned run is claimed by the first mutating
 * session - the claim rides the command's own persist, so a command that
 * fails leaves no trace. A run owned by another session is refused unless
 * the user's approval arrives verbatim via --adopt, the same shape as every
 * other user-granted waiver (--grant-budget, --allow-unapproved-prd). These
 * strings are durable audit evidence supplied by the trusted orchestrating
 * session, not an authentication factor: the CLI has no authoritative chat
 * identity to validate. Adding transcript attestation or a nonce would change
 * that trust contract rather than strengthen this local ownership guard.
 */
function assertRunOwnership(statePath: string, state: ImplementState, args: ImplementArgs): void {
  const sessionId = currentSessionId();
  const owner = state.ownerSessionId ?? null;
  if (owner === sessionId) return;
  if (owner === null) {
    state.ownerSessionId = sessionId;
    return;
  }
  const evidence = flag(args, "adopt")?.trim() ?? "";
  if (evidence === "") {
    throw new Error(
      `run '${state.topicSlug}' is owned by another session (${owner}); if the user approved taking it over, re-run with --adopt "<the user's verbatim words>"`,
    );
  }
  state.adoptions = [...(state.adoptions ?? []), { at: nowIso(), fromSessionId: owner, evidence }];
  state.ownerSessionId = sessionId;
  persistState(statePath, state);
}

function assertRunOpenForMutation(state: ImplementState): void {
  if (state.status === "retired") throw new Error("implement run is retired; start a new approved PRD under a new slug");
  if (state.status === "complete") throw new Error("implement run is already complete");
}

function retire(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  const { statePath, state } = loadState(projectRoot, stateOptions(args));
  if (state.status === "retired") {
    return result("retire", true, `implement run is already retired: ${state.topicSlug}`, {
      status: state.status,
      retirement: state.retirement,
      occupancyReleased: true,
    });
  }
  if (state.status !== "active") {
    throw new Error(`only an active unfinished run can be retired; ${state.topicSlug} is ${state.status}`);
  }
  const previousOwner = state.ownerSessionId ?? null;
  const sessionId = currentSessionId();
  const adoptionEvidence = flag(args, "adopt")?.trim() ?? "";
  assertRunOwnership(statePath, state, args);
  state.status = "retired";
  state.retirement = {
    retiredAt: nowIso(),
    retiredBySessionId: sessionId,
    ...(previousOwner !== null && previousOwner !== sessionId
      ? { adoptedFromSessionId: previousOwner, adoptionEvidence }
      : {}),
  };
  state.completion = null;
  persistState(statePath, state);
  return result("retire", true, `implement run retired and tree occupancy released: ${state.topicSlug}`, {
    status: state.status,
    retirement: state.retirement,
    occupancyReleased: true,
  });
}

function task(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  const { statePath, state } = loadState(projectRoot, stateOptions(args));
  assertRunOpenForMutation(state);
  const config = loadConfig(state.projectRoot);
  assertRunOwnership(statePath, state, args);
  const id = requiredFlag(args, "id").toUpperCase();
  const nextStatus = flag(args, "status") ?? "complete";
  if (nextStatus !== "complete" && nextStatus !== "pending" && nextStatus !== "blocked") {
    throw new Error("--status must be complete, pending, or blocked");
  }
  const item = state.tasks.find((entry) => entry.id === id);
  if (item === undefined) throw new Error(`unknown task: ${id}`);
  const evidence = flag(args, "evidence")?.trim() ?? "";
  if (nextStatus === "complete") {
    const byId = new Map(state.tasks.map((entry) => [entry.id, entry]));
    const openDeps = item.dependsOn.filter((dep) => byId.get(dep)?.status !== "complete");
    if (openDeps.length > 0) throw new Error(`cannot close ${id}: depends on ${openDeps.join(", ")} (not complete)`);
    const mechanicalBlockers = state.acceptanceCriteria
      .filter((criterion) => item.acceptanceCriteria.includes(criterion.id))
      .filter((criterion) => criterion.judgment === "machine" || criterion.judgment === "machine+gate:human")
      .flatMap((criterion) => {
        if (criterion.check.status === "parked") return [];
        const binding = criterion.check.bindings.at(-1);
        if (binding === undefined) return [`${criterion.id}: no Check binding; bind with \`sasu implement check --ac ${criterion.id} --bind "<command>"\`, or park with verbatim human approval`];
        if (!criterionCheckIsGreen(criterion)) {
          return [`${criterion.id}: latest Check is not green; run \`sasu implement check --ac ${criterion.id}\` or park with verbatim human approval`];
        }
        return [];
      });
    if (mechanicalBlockers.length > 0) {
      throw new Error(`cannot close ${id}; blocking acceptance criteria:\n- ${mechanicalBlockers.join("\n- ")}. Free-text --evidence is optional context and cannot satisfy this guard.`);
    }
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

function acceptanceCriterion(state: ImplementState, args: ImplementArgs) {
  const id = requiredFlag(args, "ac").toUpperCase();
  const criterion = state.acceptanceCriteria.find((entry) => entry.id === id);
  if (criterion === undefined) throw new Error(`unknown acceptance criterion: ${id}`);
  return criterion;
}

function check(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  const { statePath, state } = loadState(projectRoot, stateOptions(args));
  assertRunOpenForMutation(state);
  assertRunOwnership(statePath, state, args);
  const criterion = acceptanceCriterion(state, args);
  const workRoot = requireWorkRoot(state);
  for (const forbidden of ["outcome", "exit-code", "output-fingerprint", "failure-class", "tree-fingerprint"]) {
    if (args.flags.has(forbidden)) {
      throw new Error(`--${forbidden} is harness-owned and cannot be supplied; \`sasu implement check\` records the real execution result`);
    }
  }
  const command = flag(args, "bind")?.trim();
  if (command !== undefined) {
    const validated = validateCheckBinding(workRoot, command, flag(args, "cwd") ?? ".");
    const binding = bindCriterionCheck(criterion, {
      ...validated,
      reason: flag(args, "reason")?.trim() || null,
    });
    persistState(statePath, state);
    return result("check", true, `${criterion.id} Check ${binding.id} bound (${binding.classification}); run \`sasu implement check --ac ${criterion.id}\``, {
      criterionId: criterion.id,
      binding,
      checkStatus: criterion.check.status,
      decisionPoints: criterion.check.decisionPoints,
    });
  }
  if (args.flags.has("cwd") || args.flags.has("reason")) {
    throw new Error("--cwd and --reason are valid only with --bind");
  }
  const attempt = runCriterionCheck(state, workRoot, criterion, flag(args, "human-window")?.trim() || null);
  persistState(statePath, state);
  const open = criterion.check.decisionPoints.filter((point) => point.resolvedAt === null);
  return result("check", attempt.outcome === "green", `${criterion.id} Check ${attempt.outcome} (exit ${attempt.exitCode}); consecutive failures ${criterion.check.consecutiveFailures}${open.length > 0 ? `; decision point: ${open.map((point) => point.kind).join(", ")}` : ""}`, {
    criterionId: criterion.id,
    checkStatus: criterion.check.status,
    attempt,
    decisionPoints: open,
  });
}

function park(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  const { statePath, state } = loadState(projectRoot, stateOptions(args));
  assertRunOpenForMutation(state);
  assertRunOwnership(statePath, state, args);
  const criterion = acceptanceCriterion(state, args);
  parkCriterion(criterion, {
    approval: flag(args, "approval")?.trim() ?? "",
    reason: flag(args, "reason")?.trim() ?? "",
    evidence: flag(args, "evidence")?.trim() || null,
  });
  persistState(statePath, state);
  return result("park", true, `${criterion.id} parked by recorded human approval; finalize remains blocked until resume and proof`, {
    criterionId: criterion.id,
    park: criterion.check.parks.at(-1),
  });
}

function resume(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  const { statePath, state } = loadState(projectRoot, stateOptions(args));
  assertRunOpenForMutation(state);
  assertRunOwnership(statePath, state, args);
  const criterion = acceptanceCriterion(state, args);
  resumeCriterion(criterion);
  persistState(statePath, state);
  return result("resume", true, `${criterion.id} resumed to pending; consecutive failure counter reset to 0`, {
    criterionId: criterion.id,
    checkStatus: criterion.check.status,
    consecutiveFailures: criterion.check.consecutiveFailures,
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

/**
 * Every path the harness itself writes during a run's lifetime. Registering
 * one as runtime evidence is self-invalidating (see the refusal site), so
 * the whole class is refused at registration and purged from legacy state.
 */
function harnessOwnedRunPath(state: ImplementState, relative: string): boolean {
  return relative === `${state.runDir}/state.json`
    || relative === state.prd.snapshotPath
    || relative === `${state.runDir}/receipt.json`
    || relative === `${state.runDir}/implementation-result.md`
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
    const realRunDir = fs.realpathSync(path.join(state.projectRoot, state.runDir));
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

function artifact(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  const { statePath, state } = loadState(projectRoot, stateOptions(args));
  assertRunOpenForMutation(state);
  assertRunOwnership(statePath, state, args);
  const verificationId = flag(args, "id")?.trim().toUpperCase();
  const acceptanceCriterionId = flag(args, "ac")?.trim().toUpperCase();
  if (verificationId === undefined && acceptanceCriterionId === undefined) {
    throw new Error("artifact requires --id <Vn>, --ac <ACn>, or both");
  }
  if (verificationId !== undefined && !state.verification.some((entry) => entry.id === verificationId)) {
    throw new Error(`unknown verification item: ${verificationId}`);
  }
  if (acceptanceCriterionId !== undefined && !state.acceptanceCriteria.some((entry) => entry.id === acceptanceCriterionId)) {
    throw new Error(`unknown acceptance criterion: ${acceptanceCriterionId}`);
  }
  const targetLabel = [verificationId, acceptanceCriterionId].filter(Boolean).join("+");
  const kind = requiredFlag(args, "kind").toLowerCase();
  if (!ARTIFACT_KINDS.has(kind) || kind === "command-log") throw new Error(`--kind must be one of: screenshot, image, browser, api, db, log, file`);
  // Artifact paths live in the RECORD tree (normally under the run dir):
  // the receipt cites them, and the record must outlive the worktree.
  const target = normalizeProjectPath(state.projectRoot, requiredFlag(args, "path"));
  // A file the harness itself rewrites can never be frozen evidence: the
  // next harness write invalidates the frozen sha and the integrity
  // preflight fails forever with no unregister. 2026-08-27 crawler-arena hit
  // this with the mechanical log; the same species one directory up is
  // state.json itself. The refusal keys on the harness-owned class, resolved
  // through realpath so a symlink alias to this run's own files cannot slip
  // past it (PRINCIPLES 3: the class, not the one incident directory). The
  // realpath canonicalization covers the runDir-scoped members; the global
  // members (agents/config.json, legacy agents/gates/) are matched by string
  // only - nothing in this CLI rewrites them during a run, so an alias to
  // them is stale-evidence hygiene, not the self-invalidation deadlock.
  if (harnessOwnedRunPath(state, canonicalRunRelative(state, target))) {
    throw new Error(`artifact path is harness-owned and rewritten by the harness: ${target.relative}. Register your own runtime output instead.`);
  }
  if (state.artifacts.some((entry) => entry.command !== undefined && entry.path === target.relative)) {
    throw new Error(`artifact path is already registered as harness command evidence: ${target.relative}. Register your own runtime output instead.`);
  }
  const description = requiredFlag(args, "description").trim();
  const inspected = inspectArtifactFile(target.absolute, kind);
  const previous = state.artifacts.find((entry) =>
    entry.verificationId === verificationId
    && entry.acceptanceCriterionId === acceptanceCriterionId
    && entry.path === target.relative);
  // Re-registration was the 2026-08-25 workaround: 28 unchanged records were
  // stamped again, making an old log look current. Equal bytes carry no new
  // observation, so preserve the entire prior record and its original clock.
  if (previous !== undefined && previous.sha256 === inspected.sha256) {
    return result(
      "artifact",
      true,
      `artifact unchanged since ${previous.registeredAt}; registration timestamp preserved for ${targetLabel}: ${target.relative}`,
      { artifact: previous, unchanged: true },
    );
  }
  const registered: RegisteredArtifact = {
    ...(verificationId !== undefined ? { verificationId } : {}),
    ...(acceptanceCriterionId !== undefined ? { acceptanceCriterionId } : {}),
    kind,
    path: target.relative,
    description,
    ...inspected,
    registeredAt: nowIso(),
  };
  state.artifacts = state.artifacts.filter((entry) => !(
    entry.verificationId === verificationId
    && entry.acceptanceCriterionId === acceptanceCriterionId
    && entry.path === target.relative
  ));
  state.artifacts.push(registered);
  persistState(statePath, state);
  return result("artifact", true, `artifact registered for ${targetLabel}: ${target.relative}`, { artifact: registered });
}

/**
 * Records the one disposition a human or agent writes by hand: why a design
 * comment is being left alone. There is deliberately no `--fixed`: a claimed
 * fix is an assertion, while a comment the lane stops reporting is a
 * measurement, and only one of those belongs in the record (PRINCIPLES 1, 10).
 */
function design(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  const { statePath, state } = loadState(projectRoot, stateOptions(args));
  assertRunOpenForMutation(state);
  assertRunOwnership(statePath, state, args);
  const id = requiredFlag(args, "id").toUpperCase();
  const note = requiredFlag(args, "accept").trim();
  if (note === "") throw new Error("--accept requires the reason the comment is being left alone");
  const tracked = state.designComments ?? [];
  const entry = tracked.find((candidate) => candidate.id === id);
  if (entry === undefined) {
    const known = tracked.filter((candidate) => candidate.status === "open").map((candidate) => candidate.id);
    throw new Error(`unknown design comment: ${id}${known.length === 0 ? "" : ` (open: ${known.join(", ")})`}`);
  }
  if (entry.status === "resolved") {
    throw new Error(`${id} is already resolved: the design lane no longer reports it, so there is nothing to accept`);
  }
  entry.accepted = { at: nowIso(), note };
  state.designComments = tracked;
  persistState(statePath, state);
  const open = openDesignComments(state);
  return result("design", true, `${id} accepted; ${open.length} design comment(s) still await a disposition`, {
    comment: entry,
    open,
  });
}

/** Records the user's verbatim decision to leave one risk finding unresolved. */
function risk(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  if (args.flags.get("accept") !== true) throw new Error("risk requires --accept");
  const { statePath, state } = loadState(projectRoot, stateOptions(args));
  assertRunOpenForMutation(state);
  assertRunOwnership(statePath, state, args);
  const id = requiredFlag(args, "id").toUpperCase();
  const evidence = requiredFlag(args, "evidence");
  const entry = state.riskFindings.find((candidate) => candidate.id === id);
  if (entry === undefined) {
    const known = openRiskFindings(state).map((candidate) => candidate.id);
    throw new Error(`unknown risk finding: ${id}${known.length === 0 ? "" : ` (open: ${known.join(", ")})`}`);
  }
  if (entry.status === "accepted") {
    if (entry.resolution?.evidence !== evidence) throw new Error(`${id} is already accepted with different evidence`);
    // Ownership adoption is itself state even when the finding transition is
    // already settled, so the idempotent path must not discard it.
    persistState(statePath, state);
    return result("risk", true, `${id} was already accepted with the same evidence`, {
      finding: entry,
      open: openRiskFindings(state),
    });
  }
  if (entry.status === "fixed") throw new Error(`${id} is already fixed by a later risk review`);
  entry.status = "accepted";
  entry.resolution = { at: nowIso(), evidence };
  persistState(statePath, state);
  const open = openRiskFindings(state);
  return result("risk", true, `${id} accepted; ${open.length} risk finding(s) remain open`, {
    finding: entry,
    open,
  });
}

function status(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  const { state } = loadState(projectRoot, stateOptions(args));
  const recordRoot = state.projectRoot;
  const config = loadConfig(recordRoot);
  const source = captureSourceSnapshot(requireWorkRoot(state));
  const problems = artifactIntegrityProblems(recordRoot, state);
  const heldPrd = pinnedPrd(recordRoot, state);
  const prdText = heldPrd.text;
  const contract = parseImplementContract(prdText);
  const sourceContext = fidelitySource(recordRoot, contract, specGateIsFresh(recordRoot, state));
  const fidelityInput = { routing: sourceContext.routing, contentSha256: sha256(sourceContext.content) };
  const currentInput = inputFingerprint(state, source.digest, fidelityInput);
  return result("status", true, `${state.topicSlug}: ${state.status}`, {
    ...publicState(state, config.judge.retryBudget, source.digest, heldPrd.drift === null ? currentInput : "PRD_DRIFT"),
    artifactProblems: problems,
    prdProblem: heldPrd.drift === null ? null : "PRD changed after implement start",
    prdDrift: heldPrd.drift,
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

function upsertCommandArtifacts(state: ImplementState, run: MechanicalRunRecord, projectRoot: string): void {
  const inspected = inspectArtifactFile(path.join(projectRoot, run.logPath), "log");
  for (const verificationId of run.verificationIds) {
    const artifact: RegisteredArtifact = {
      verificationId,
      kind: "command-log",
      path: run.logPath,
      description: `mechanical ${run.status}: ${run.command}`,
      ...inspected,
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

/**
 * Run the union of AC Check bindings and the sealed suite list once each, on
 * one frozen tree, and attribute every result to BOTH destinations (R1).
 *
 * Replaces the old shell-based suite loop. Three behaviour changes come with
 * the unification, each deliberate:
 *   - no shell and no inherited environment: the stricter Check semantics win;
 *   - no stop-at-first-failure: a run that declined to execute a command
 *     cannot honestly say "suites 3/3" (R4);
 *   - a criterion named by a unit gets a real CheckAttempt appended to its
 *     ledger, so the AC score and the suite axis are the same measurement
 *     read two ways rather than two measurements that can disagree.
 */
function runUnifiedBatch(
  recordRoot: string,
  workRoot: string,
  state: ImplementState,
  units: RunUnit[],
  attemptId: string,
): { records: MechanicalRunRecord[]; treeMoved: { before: string; after: string } | null } {
  const timeoutMs = loadConfig(recordRoot).verify.commandTimeoutMs;
  const records: MechanicalRunRecord[] = [];
  const outcome = runBatch(state, workRoot, units, timeoutMs, (result) => {
    const binding: MechanicalBinding = {
      command: result.unit.command,
      cwd: result.unit.cwd,
      verificationIds: result.unit.verificationIds,
    };
    const base: Omit<MechanicalRunRecord, "logPath"> = {
      ...binding,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      durationMs: result.durationMs,
      exitCode: result.green ? 0 : (result.exitCode === 0 ? 1 : result.exitCode),
      status: result.green ? "PASS" : "FAIL",
    };
    const logPath = writeMechanicalLog(recordRoot, state, binding, base, result.stdout, result.stderr);
    const record: MechanicalRunRecord = { ...base, logPath };
    progress(`mechanical ${record.status} in ${(record.durationMs / 1000).toFixed(1)}s: ${record.command}`);
    // `attempt.mechanical` keeps its established meaning - the suite axis,
    // the record V rows are proved from. A unit that only an AC named is
    // executed by the same batch and scored into the AC ledger, but it does
    // not enter this list: mixing the two would blur which record proves a V
    // row and would pollute the attempt-reuse comparison that reads it.
    if (result.unit.suiteCommandIds.length > 0) {
      records.push(record);
      upsertCommandArtifacts(state, record, recordRoot);
      attributeToSuite(state, result, attemptId, logPath);
    }
    attributeToCriteria(state, result);
  });
  return { records, treeMoved: outcome.treeMoved };
}

/** One execution, appended to every criterion ledger that named it (R1). */
function attributeToCriteria(state: ImplementState, result: RunUnitResult): void {
  for (const criterionId of result.unit.criterionIds) {
    const criterion = state.acceptanceCriteria.find((entry) => entry.id === criterionId);
    if (criterion === undefined) continue;
    const binding = criterion.check.bindings.at(-1);
    if (binding === undefined) continue;
    const fingerprints = fingerprintCheckOutput(result.stdout, result.stderr);
    criterion.check.attempts.push({
      id: `A${criterion.check.attempts.length + 1}`,
      bindingId: binding.id,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      signal: result.signal,
      outcome: result.green ? "green" : "failed",
      outputFingerprint: fingerprints.outputFingerprint,
      failureClass: result.green ? null : fingerprints.failureClass,
      tree: result.tree,
      humanWindow: null,
    });
    if (result.green) {
      criterion.check.status = "green";
      criterion.check.consecutiveFailures = 0;
    } else {
      criterion.check.status = "pending";
      criterion.check.consecutiveFailures += 1;
    }
  }
}

/** The same execution, recorded on the suite axis (R1, R2). */
function attributeToSuite(state: ImplementState, result: RunUnitResult, attemptId: string, logPath: string): void {
  for (const commandId of result.unit.suiteCommandIds) {
    const entry = {
      commandId,
      attemptId,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      status: result.green ? ("GREEN" as const) : ("RED" as const),
      logPath,
      attributedCriteria: [...result.unit.criterionIds],
    };
    // Latest result per command, replaced whole: the suite axis reports the
    // current tree, not a history. History lives in verificationAttempts.
    state.suite.results = state.suite.results.filter((existing) => existing.commandId !== commandId);
    state.suite.results.push(entry);
  }
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

/**
 * The run's own changes as a real diff, against the commit HEAD pointed at
 * when the run started. The design lane cannot do its job without this: shown
 * only whole current files, it has no way to tell a duplication this run
 * introduced from one that predates the run, so it reports both and its
 * accretion charter degrades into whole-repository commentary.
 *
 * Bounded by `--stat`-free plain diff over exactly the changed paths, so
 * generated trees excluded from the snapshot stay excluded here too. Without
 * git (or when git fails) there is no diff to show and the lane falls back to
 * the file bodies alone, which is what it always had.
 */
function runOwnedDiff(projectRoot: string, state: ImplementState, paths: string[]): string {
  const head = state.initialSource.head;
  if (head === null || paths.length === 0) return "No diff available (the project is not a git repository, or nothing changed).";
  const tracked = spawnSync("git", ["ls-tree", "-r", "--name-only", head], {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (tracked.error !== undefined || tracked.status !== 0) return `No diff available (git ls-tree ${head} failed).`;
  const atHead = new Set(tracked.stdout.split("\n").filter((entry) => entry !== ""));
  const sections: string[] = [];
  const known = paths.filter((entry) => atHead.has(entry));
  if (known.length > 0) {
    const executed = spawnSync("git", ["diff", head, "--", ...known], {
      cwd: projectRoot,
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
    });
    if (executed.error !== undefined || executed.status !== 0) return `No diff available (git diff against ${head} failed).`;
    if (executed.stdout.trim() !== "") sections.push(executed.stdout.trimEnd());
  }
  // Files absent from the pre-run commit are the run's newest work and the
  // most likely place for accretion, yet `git diff <head>` never shows them:
  // untracked paths are invisible to it, and `git add -N` would buy their
  // visibility by mutating the index of a tree under judgment. --no-index
  // against /dev/null reads the same diff without touching any repository state.
  for (const relative of paths) {
    if (atHead.has(relative)) continue;
    if (!fs.existsSync(path.join(projectRoot, relative))) continue;
    const added = spawnSync("git", ["diff", "--no-index", "--", "/dev/null", relative], {
      cwd: projectRoot,
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
    });
    // --no-index exits 1 when the inputs differ, which is the normal case here.
    if (added.error === undefined && added.stdout.trim() !== "") sections.push(added.stdout.trimEnd());
  }
  return sections.length === 0 ? "The changed files are byte-identical to the pre-run commit." : sections.join("\n");
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

function textEvidencePaths(projectRoot: string, paths: string[]): string[] {
  // Binary images are visual evidence, not source text. Passing them to a
  // read-only judge lets a tool response inflate the model context by their
  // raw bytes. Registered visual artifacts travel through `images` instead.
  return paths.filter((relative) => {
    const absolute = path.join(projectRoot, relative);
    return !fs.existsSync(absolute) || !isImageBytes(fs.readFileSync(absolute));
  });
}

function acceptanceMaterial(
  projectRoot: string,
  state: ImplementState,
  criterion: AcceptanceCriterionItem,
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
    (entry) => entry.command === undefined
      && (entry.acceptanceCriterionId === criterion.id || (entry.verificationId !== undefined && verificationIds.has(entry.verificationId))),
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
        registeredAt: artifact.registeredAt,
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
      provenance: `${agentRegisteredArtifactProvenance(artifact.registeredAt)}; hash-pinned by the harness; description: ${artifact.description}`,
      ...(excerpt.truncated ? { truncated: true } : {}),
    });
  }
  return {
    changedFiles,
    checks,
    evidence,
    readableArtifacts,
    scenarios: mappedScenarios,
    checkLedger: checkLedgerForCriterion(criterion),
  };
}

function validateFidelity(
  value: unknown,
  prior: { verdict: "PASS" | "FAIL"; checks: FidelityCheckResult[] } | null = null,
  context: VerificationRoundContext = { priorAttemptId: null, changedPaths: [], newEvidence: [] },
): { verdict: "PASS" | "FAIL"; checks: FidelityCheckResult[] } | string {
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
    const id = check["id"] as FidelityCheckResult["id"];
    const previous = prior?.checks.find((entry) => entry.id === id) ?? null;
    const delta = validateVerdictDelta(check, check["verdict"], previous?.verdict ?? null, context, id);
    if (typeof delta === "string") return delta;
    checks.push({
      id,
      verdict: check["verdict"],
      reason: check["reason"],
      evidence: check["evidence"],
      ...delta,
    });
  }
  if (new Set(checks.map((entry) => entry.id)).size !== 5 || expected.some((id) => !checks.some((entry) => entry.id === id))) {
    return "checks must contain F1 through F5 exactly once";
  }
  const anyFail = checks.some((entry) => entry.verdict === "FAIL");
  if ((raw.verdict === "PASS") === anyFail) return "top-level verdict contradicts checks";
  return { verdict: raw.verdict, checks };
}

function validateDesign(value: unknown): { comments: DesignComment[] } | string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "output is not an object";
  const raw = value as { comments?: unknown };
  if (!Array.isArray(raw.comments)) return "comments must be an array";
  const comments: DesignComment[] = [];
  for (const [index, entry] of raw.comments.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return `comments[${index}] must be an object`;
    const comment = entry as Record<string, unknown>;
    for (const field of ["area", "path", "text"]) {
      const held = comment[field];
      if (typeof held !== "string" || held.trim() === "") return `comments[${index}].${field} must be a non-empty string`;
    }
    if (typeof comment["suggestion"] !== "string") return `comments[${index}].suggestion must be a string`;
    comments.push({
      area: (comment["area"] as string).trim(),
      // Normalized here and nowhere else: `path` is half the identity key, so
      // a leading "./" would silently fork one comment into two.
      path: (comment["path"] as string).trim().replace(/^\.\//, ""),
      text: (comment["text"] as string).trim(),
      suggestion: comment["suggestion"] as string,
    });
  }
  // Two comments on one file would collide into a single tracked entry and one
  // of them would vanish without ever being answered. Reject at the boundary
  // instead of picking a winner; the prompt asks for one comment per file.
  const keys = comments.map(designCommentKey);
  const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
  if (duplicate !== undefined) return `two comments target the same file (${duplicate}); report one comment per file`;
  return { comments };
}

/**
 * A comment's identity across attempts. `path` alone, deliberately.
 *
 * Measured 2026-08-20 on gpt-5.6-luna xhigh, 10 live calls on one fixed diff:
 * the path was identical in 10/10, while `area` split 5/5 between
 * "structure-drift" and "one-cause-n-symptoms" for the same duplication. An
 * area in the key would therefore have re-minted that comment on roughly every
 * other attempt, dropping its recorded acceptance each time - a guard that
 * behaves like a coin flip (PRINCIPLES 11). `area` stays a descriptive label
 * and is free to drift.
 */
export function designCommentKey(comment: DesignComment): string {
  return comment.path;
}

/**
 * Folds one attempt's comments into the tracked list. Identity is the key, so
 * a re-worded repeat keeps its id and its recorded acceptance; a comment the
 * lane stopped reporting becomes "resolved" without anyone claiming a fix.
 *
 * Silence is trusted on a single attempt, which is a deliberate looseness, not
 * an oversight: measured 2026-08-20 on gpt-5.6-luna xhigh over 8 live calls on
 * one fixed diff, the lane reported both real defects 7 times and dropped the
 * minor one once. So roughly one attempt in eight can resolve a comment nobody
 * answered. Requiring K consecutive silences would close that at the cost of
 * keeping genuinely fixed comments open for K more rounds - a worse trade for a
 * gate whose job is to force an answer, not to prove a defect's absence.
 */
export function reconcileDesignComments(
  tracked: TrackedDesignComment[],
  comments: DesignComment[],
  attemptId: string,
  at: string,
): TrackedDesignComment[] {
  const next = tracked.map((entry) => ({ ...entry }));
  const seen = new Set<string>();
  for (const comment of comments) {
    const key = designCommentKey(comment);
    seen.add(key);
    const existing = next.find((entry) => entry.key === key);
    if (existing === undefined) {
      next.push({
        ...comment,
        // Ids are minted from the high-water mark, never from the array
        // length: a numbering that reuses a resolved comment's id would make
        // an old acceptance note read as an answer to a new comment.
        id: `D${next.reduce((high, entry) => Math.max(high, Number(entry.id.slice(1)) || 0), 0) + 1}`,
        key,
        status: "open",
        accepted: null,
        firstSeenAt: at,
        lastSeenAt: at,
        lastSeenAttemptId: attemptId,
      });
      continue;
    }
    existing.area = comment.area;
    existing.path = comment.path;
    existing.text = comment.text;
    existing.suggestion = comment.suggestion;
    existing.status = "open";
    existing.lastSeenAt = at;
    existing.lastSeenAttemptId = attemptId;
  }
  for (const entry of next) if (!seen.has(entry.key)) entry.status = "resolved";
  return next;
}

export function openDesignComments(state: ImplementState): TrackedDesignComment[] {
  return (state.designComments ?? []).filter((entry) => entry.status === "open" && entry.accepted === null);
}

export function openRiskFindings(state: ImplementState): TrackedRiskFinding[] {
  return state.riskFindings.filter((entry) => entry.status === "open");
}

function riskLedgerPriorResult(state: ImplementState, lineage: RiskLaneResult | null): RiskLaneResult | null {
  if (lineage === null) return null;
  const findings = openRiskFindings(state).map((entry) => ({
    id: entry.id,
    severity: entry.severity,
    text: entry.text,
  }));
  return {
    verdict: findings.some((entry) => entry.severity === "blocking") ? "FAIL" : "PASS",
    findings,
  };
}

function nextRiskFindingNumber(state: ImplementState): number {
  return state.riskFindings.reduce(
    (high, entry) => Math.max(high, Number(entry.id.replace(/^RF/, "")) || 0),
    0,
  ) + 1;
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
    const cause = error instanceof JudgeError
      ? judgeFailureCause(error)
      : { code, backend: "unknown", reason: null };
    return {
      invocationId,
      startedAt,
      finishedAt: nowIso(),
      durationMs: Date.now() - started,
      verdict: "ERROR",
      result: null,
      judge: judgeCallRecordFrom(error),
      error: { code, message: error instanceof Error ? error.message : String(error), cause },
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
  recordRoot: string,
  workRoot: string,
  state: ImplementState,
  scenarios: ContractItem[],
  changedFiles: string,
  changedPaths: string[],
  mechanical: MechanicalRunRecord[],
  reuse: UnifiedVerificationAttempt | null,
  priorInputs: Map<string, PriorLaneInput<AcLaneResult>>,
): Promise<NonNullable<UnifiedVerificationAttempt["lanes"]["acceptance"]>> {
  const invocationId = crypto.randomUUID();
  const started = Date.now();
  const startedAt = nowIso();
  const settled = reuse === null
    ? new Map<string, { invocation: AcceptanceCriterionInvocation; criteria: AcLaneResult[] }>()
    : settledAcceptanceInvocations(reuse);
  // Bounded rather than unbounded: see judgeFanoutLimit for the measurement.
  // Criteria still all judge in one round and the lane still costs its
  // slowest one - the ceiling only stops a 22-criterion PRD from putting 22
  // heavyweight judge subprocesses on a box that already runs the project.
  const runnableCriteria = state.acceptanceCriteria.filter((criterion) => criterion.check.status !== "parked");
  const perCriterion = await mapWithConcurrency(runnableCriteria, judgeFanoutLimit(), async (criterion) => {
    const prior = settled.get(criterion.id);
    if (reuse !== null && prior !== undefined) {
      progress(`acceptance ${criterion.id}: ${prior.invocation.verdict} (reused from the ERROR'd attempt)`);
      return {
        invocation: { ...prior.invocation, reusedFrom: reuse.id },
        criteria: prior.criteria,
      };
    }
    if (criterion.judgment === "judged"
      && !state.artifacts.some((artifact) => artifact.acceptanceCriterionId === criterion.id)) {
      const at = nowIso();
      const reason = `required judged evidence is not registered: ${criterion.evidenceDeclaration ?? "no evidence declaration"}`;
      progress(`acceptance ${criterion.id}: FAIL (${reason})`);
      return {
        invocation: {
          criterionId: criterion.id,
          invocationId: crypto.randomUUID(),
          startedAt: at,
          finishedAt: at,
          durationMs: 0,
          verdict: "FAIL" as const,
          judge: null,
          error: null,
        },
        criteria: [{ id: criterion.id, verdict: "FAIL" as const, reason, evidence: "none registered for this acceptance criterion" }],
      };
    }
    const record = await judgeLane(crypto.randomUUID(), async () => {
      const material = acceptanceMaterial(recordRoot, state, criterion, changedFiles, mechanical, scenarios);
      const priorInput = priorInputs.get(criterion.id)!;
      const priorCriterion = priorInput.result;
      const criterionRoundContext = priorInput.context;
      // With no inlined check, artifact, or image, the only honest basis for
      // a PASS is the code itself - and the agentic probe measured judges
      // reading zero to two files, zero included. A PASS with a known-zero
      // read trace is rejected through the normal invalid-output ladder
      // (retry with the reason, then backend fallback). An unknown trace
      // (toolRounds null) never rejects: absence of a signal is not evidence
      // of absence.
      const inlinedProof = criterion.check.attempts.length > 0
        || material.checks.length > 0
        || material.evidence.length > 0
        || material.readableArtifacts.length > 0;
      return runJudge(
        config,
        `implement:acceptance:${criterion.id}`,
        "routine",
        acceptancePrompt(state, criterion, material, priorCriterion, criterionRoundContext),
        (value, activity) => {
          const verdict = validateSemanticVerdict(value, [criterion.id]);
          if (typeof verdict === "string") return verdict;
          const rawCriteria = (value as { criteria?: unknown }).criteria;
          const rawCriterion = Array.isArray(rawCriteria)
            ? rawCriteria.find((entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry) && (entry as Record<string, unknown>)["id"] === criterion.id)
            : undefined;
          if (rawCriterion === undefined) return `${criterion.id} raw result is missing`;
          const delta = validateVerdictDelta(
            rawCriterion as Record<string, unknown>,
            verdict.criteria[0]!.verdict,
            priorCriterion?.verdict ?? null,
            criterionRoundContext,
            criterion.id,
          );
          if (typeof delta === "string") return delta;
          const passed = verdict.criteria.some((entry) => entry.verdict === "PASS");
          if (!inlinedProof && passed && activity.commands.length === 0 && activity.toolRounds === 0) {
            return `${criterion.id} has no inlined check or artifact, so a PASS must rest on reading the implementation; no file read was recorded - read the files you cite as evidence, then judge again`;
          }
          return {
            ...verdict,
            criteria: verdict.criteria.map((entry) => entry.id === criterion.id ? { ...entry, ...delta } : entry),
          };
        },
        // 2026-08-13 live probe: 16 Luna xhigh calls across direct proof,
        // code PASS/FAIL, a 21-file noisy manifest, allowlisted dependencies,
        // and prompt injection were correct with zero to two exact-path reads.
        {
          agentic: true,
          // Judges read the JUDGED tree; registered artifacts live in the
          // record tree and reach the judge inlined (text) or as absolute
          // image paths, so a missing copy in the work tree is expected.
          cwd: workRoot,
          evidencePaths: textEvidencePaths(workRoot, changedPaths),
          ...(material.readableArtifacts.length > 0
            ? { images: material.readableArtifacts.map((artifact) => normalizeProjectPath(recordRoot, artifact.path).absolute) }
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
  });
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

/**
 * Verification items whose PASS authority is the unified judge verdict, not a
 * mechanical exit code: live-judge items by declaration, and items whose only
 * proof is agent-registered runtime evidence. The latter used to be stamped
 * PASS here on the mere existence of an artifact, while the acceptance judge
 * was simultaneously told the same artifact is "the implementer's claim, not
 * a harness observation" - two authorities over one proof, disagreeing
 * forever (2026-08-27 crawler-arena, 66 hours without a receipt). One
 * authority now: the judges weigh the artifact, and the item inherits the
 * judged verdict exactly like a live-judge item.
 */
function judgeDeferred(state: ImplementState, item: VerificationItem, bindings: MechanicalBinding[]): boolean {
  if (verificationNeedsJudge(item)) return true;
  if (bindings.some((binding) => binding.verificationIds.includes(item.id))) return false;
  return state.artifacts.some((entry) => entry.verificationId === item.id && entry.command === undefined);
}

function setVerificationStatuses(
  state: ImplementState,
  bindings: MechanicalBinding[],
  runs: MechanicalRunRecord[],
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
    // No mechanical authority over this item. With registered evidence it is
    // judge-deferred (stamped from the unified verdict after the lanes run);
    // with nothing at all there is nothing for any authority to weigh.
    item.status = "NOT_RUN";
    const artifacts = state.artifacts.filter((entry) => entry.verificationId === item.id && entry.command === undefined);
    if (artifacts.length === 0 && item.requiredForDone) {
      problems.push(`${item.id}: no command binding or registered runtime artifact proves ${item.passIntent}`);
    }
  }
  return problems;
}

function firstRoundContext(): VerificationRoundContext {
  return { priorAttemptId: null, changedPaths: [], newEvidence: [] };
}

interface PriorLaneInput<T> {
  result: T | null;
  context: VerificationRoundContext;
}

function priorLaneInput<T>(
  state: ImplementState,
  inputManifest: VerificationInputManifest,
  select: (attempt: UnifiedVerificationAttempt) => T | null | undefined,
): PriorLaneInput<T> {
  const prior = latestAttemptResult(state.verificationAttempts, select);
  return prior === null
    ? { result: null, context: firstRoundContext() }
    : { result: prior.result, context: verificationRoundContext(inputManifest, prior.attempt) };
}

function skippedAcceptanceCriteria(state: ImplementState): UnifiedVerificationAttempt["skippedAcceptanceCriteria"] {
  return state.acceptanceCriteria
    .filter((criterion) => criterion.check.status === "parked")
    .map((criterion) => ({
      id: criterion.id,
      reason: criterion.check.parks.at(-1)?.reason ?? "parked by recorded human approval",
    }));
}

function failedAttempt(
  attemptId: string,
  state: ImplementState,
  sourceDigest: string,
  fidelityInput: UnifiedVerificationAttempt["fidelityInput"],
  inputManifest: VerificationInputManifest,
  roundContexts: VerificationRoundContexts,
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
    id: attemptId,
    inputFingerprint: inputFingerprint(state, sourceDigest, fidelityInput),
    sourceFingerprint: sourceDigest,
    inputManifest,
    roundContexts,
    fidelityInput,
    startedAt,
    finishedAt: nowIso(),
    durationMs: Date.now() - started,
    verdict,
    prelint,
    mechanical,
    skippedAcceptanceCriteria: skippedAcceptanceCriteria(state),
    lanes: { acceptance: null, fidelity: null, risk: null },
    error: { stage, code, message },
  };
}

async function verify(projectRoot: string, args: ImplementArgs): Promise<ImplementCommandResult> {
  const { statePath, state } = loadState(projectRoot, stateOptions(args));
  assertRunOpenForMutation(state);
  assertRunOwnership(statePath, state, args);
  const openTasks = state.tasks.filter((entry) => entry.status !== "complete");
  if (openTasks.length > 0) throw new Error(`verify requires all tasks complete; open: ${openTasks.map((entry) => entry.id).join(", ")}`);
  const completeTaskCount = state.tasks.filter((entry) => entry.status === "complete").length;
  const recordRoot = state.projectRoot;
  const workRoot = requireWorkRoot(state);
  const source = captureSourceSnapshot(workRoot);
  const changedPaths = changedPathsSince(state.initialSource, source);
  if (completeTaskCount > 0 && changedPaths.length === 0) {
    // 2026-08-25 creator-studio spent eight judge rounds on zero changed files
    // after a post-commit start captured the implementation in the baseline.
    // Refusing here moves that contradiction out of judge discretion and into
    // the code-owned invariant before any verification budget can be spent.
    throw new VerifyInvariantError(
      "empty-run-owned-change-set",
      `implement verify refused [empty-run-owned-change-set]: the run-owned change set is empty after ${completeTaskCount} complete task(s). Two causes produce this: (a) \`sasu implement start\` ran after the implementation was committed, contaminating the baseline with it, or (b) every dirty path was dispositioned pre-existing at start, absorbing the work into the baseline. Either way there is no run-owned change for a judge to verify. Run \`sasu implement retire\`, then restart with \`sasu implement start\` before implementation begins (attribute genuinely run-owned dirty work as run-owned, not pre-existing).`,
    );
  }
  const config = loadConfig(recordRoot);
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
  const prdText = requirePinnedPrd(recordRoot, state);
  const contract = parseImplementContract(prdText);
  const sourceContext = fidelitySource(recordRoot, contract, specGateIsFresh(recordRoot, state));
  const fidelityInput = { routing: sourceContext.routing, contentSha256: sha256(sourceContext.content) };
  const lint = prelintPrd(prdText);
  const prelint = { ok: lint.ok, findings: lint.findings };
  const inputManifest = verificationInputManifest(state.initialSource, source, state.artifacts, checkLedgerPayload(state));
  const acceptancePriorInputs = new Map(state.acceptanceCriteria.map((criterion) => [
    criterion.id,
    priorLaneInput(state, inputManifest, (attempt) =>
      attempt.lanes.acceptance?.result?.criteria.find((entry) => entry.id === criterion.id)),
  ]));
  const fidelityPriorInput = priorLaneInput(state, inputManifest, (attempt) => attempt.lanes.fidelity?.result);
  const riskLineageInput = priorLaneInput(state, inputManifest, (attempt) => attempt.lanes.risk?.result);
  const priorRiskResult = riskLedgerPriorResult(state, riskLineageInput.result);
  // One id for this attempt, minted before the mechanical batch so a suite
  // result can name the attempt it was produced in while it is being produced.
  const attemptId = crypto.randomUUID();
  const roundContexts: VerificationRoundContexts = {
    acceptance: Object.fromEntries([...acceptancePriorInputs].map(([id, input]) => [id, input.context])),
    fidelity: fidelityPriorInput.context,
    risk: state.prd.reviewProfile === "high-risk" ? riskLineageInput.context : null,
  };
  if (!lint.ok) {
    const attempt = failedAttempt(attemptId, state, source.digest, fidelityInput, inputManifest, roundContexts, started, startedAt, prelint, [], "prelint", "prd-prelint", "PRD prelint failed", "FAIL");
    state.verificationAttempts.push(attempt);
    persistState(statePath, state);
    return result("verify", false, "PRD prelint failed before mechanical verification; no judge was called", {
      attempt: attemptSummary(attempt),
      verificationBudget: verificationBudget(state, config.judge.retryBudget),
    });
  }
  // Repair path for runs poisoned before registration refused harness-owned
  // paths: an agent-registered copy of a file the harness rewrites can never
  // satisfy the integrity preflight, and no unregister command exists
  // (2026-08-27 crawler-arena, permanently deadlocked on its mechanical log).
  // Judged through the same canonicalization as registration: a legacy entry
  // whose stored string is a symlink alias to a harness-owned file is the
  // same poison and must not survive the repair on a naming technicality.
  const poisonedEntry = (entry: RegisteredArtifact): boolean =>
    entry.command === undefined
    && harnessOwnedRunPath(state, canonicalRunRelative(state, { absolute: path.join(state.projectRoot, entry.path), relative: entry.path }));
  const poisoned = state.artifacts.filter(poisonedEntry);
  if (poisoned.length > 0) {
    state.artifacts = state.artifacts.filter((entry) => !poisonedEntry(entry));
    persistState(statePath, state);
    progress(`dropped ${poisoned.length} agent-registered artifact(s) on harness-owned path(s): ${poisoned.map((entry) => `${[entry.verificationId, entry.acceptanceCriterionId].filter(Boolean).join("+")}:${entry.path}`).join(", ")}`);
  }
  const runtimeArtifactProblems = artifactIntegrityProblems(recordRoot, { ...state, artifacts: state.artifacts.filter((entry) => entry.command === undefined) });
  if (runtimeArtifactProblems.length > 0) {
    return result("verify", false, "runtime artifact integrity preflight failed; no verification attempt, mechanical command, or judge was called", {
      problems: runtimeArtifactProblems,
      judgeCalls: 0,
      verificationBudget: verificationBudget(state, config.judge.retryBudget),
    });
  }
  const units = planRunUnits(state);
  const bindings: MechanicalBinding[] = state.suite.commands
    .filter((command) => !state.suite.exclusions.some((exclusion) => exclusion.commandId === command.id))
    .map((command) => ({ command: command.command, cwd: command.cwd, verificationIds: command.verificationIds }));
  const batch = runUnifiedBatch(recordRoot, workRoot, state, units, attemptId);
  const mechanical = batch.records;
  const failedMechanical = mechanical.find((entry) => entry.status === "FAIL");
  const proofProblems = setVerificationStatuses(state, bindings, mechanical);
  if (batch.treeMoved !== null || failedMechanical !== undefined || proofProblems.length > 0) {
    // A tree that moved mid-batch invalidates the whole batch: the results
    // were not all earned on one tree, so none of them names a tree honestly
    // (AC2). Reported ahead of individual failures because it explains them.
    const message = batch.treeMoved !== null
      ? `judged source changed while mechanical commands were running (${batch.treeMoved.before.slice(0, 12)} -> ${batch.treeMoved.after.slice(0, 12)}); no result was earned on a single frozen tree`
      : failedMechanical !== undefined
        ? `${failedMechanical.command} failed with exit ${failedMechanical.exitCode}`
        : proofProblems.join("; ");
    const attempt = failedAttempt(attemptId, state, source.digest, fidelityInput, inputManifest, roundContexts, started, startedAt, prelint, mechanical, "mechanical", "mechanical-failed", message, "FAIL");
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

  const material = changeMaterial(workRoot, state, source);
  const changedFiles = changedFileManifest(workRoot, changedPaths);
  const reviewDiff = runOwnedDiff(workRoot, state, changedPaths);
  const reviewEvidencePaths = textEvidencePaths(workRoot, changedPaths);
  const reviewNeedsAgentic = reviewDiff.length > IMPLEMENT_REVIEW_DIFF_MAX_CHARS;
  const reuse = reusableErrorAttempt(state, inputFingerprint(state, source.digest, fidelityInput), source.digest, mechanical);
  const priorFidelityResult = fidelityPriorInput.result;
  const fidelityRoundContext = fidelityPriorInput.context;
  const reusedFidelity = reuse !== null && reuse.lanes.fidelity !== null && reuse.lanes.fidelity.verdict !== "ERROR"
    ? { ...reuse.lanes.fidelity, reusedFrom: reuse.id }
    : null;
  const fidelityInvocationId = crypto.randomUUID();
  progress(`judging ${state.acceptanceCriteria.length} acceptance criteria and fidelity in parallel (profile: ${state.prd.reviewProfile})`);
  if (reusedFidelity !== null) progress(`fidelity: ${reusedFidelity.verdict} (reused from the ERROR'd attempt)`);
  // The design lane always re-runs (never reused - its comments must describe
  // the CURRENT tree: a reused comment set would let a fixed defect keep
  // blocking finalize, and a fresh one keep passing). Skipped for trivial
  // profiles and excluded from the attempt verdict: it has no verdict to
  // contribute. What makes it consequential is disposition, not a vote - see
  // reconcileDesignComments and the finalize blocker.
  //
  // It is NOT a cheap call, and it is deliberately outside the barrier that
  // gates risk. Measured across the 8 verify attempts of the 2026-08-27
  // crawler-arena run: design 264/423/545/648/655s against acceptance
  // 119-531s and fidelity 31-101s - the slowest lane in 4 of 5 judged
  // attempts. `riskPrompt` never receives its result and `laneVerdicts` never
  // reads it, so holding risk behind it bought nothing and cost 23.1 minutes
  // of pure wait, 41% of that run's total verify wall clock (PRINCIPLES 5).
  // It settles alongside risk and is awaited once, after.
  const runDesignLane = state.prd.reviewProfile !== "trivial";
  const designPending: Promise<LaneRecord<{ comments: DesignComment[] }> | null> = !runDesignLane
    ? Promise.resolve(null)
    : judgeLane(crypto.randomUUID(), () =>
        runJudge(
          config,
          "implement:design",
          "routine",
          designPrompt(prdText, reviewDiff, material, reviewEvidencePaths),
          validateDesign,
          reviewNeedsAgentic
            ? { agentic: true, cwd: workRoot, evidencePaths: reviewEvidencePaths }
            : {},
        ),
      ).then((record) => {
        const summary = record.verdict === "ERROR"
          ? `ERROR (${record.error?.message ?? "unknown"})`
          : `${record.result?.comments.length ?? 0} comment(s)`;
        progress(`design: ${summary} (${(record.durationMs / 1000).toFixed(0)}s)`);
        return record;
      });
  const [acceptance, fidelity] = await Promise.all([
    acceptanceLane(config, recordRoot, workRoot, state, contract.scenarios, changedFiles, changedPaths, mechanical, reuse, acceptancePriorInputs),
    reusedFidelity !== null
      ? Promise.resolve(reusedFidelity)
      : judgeLane(fidelityInvocationId, () =>
          runJudge(
            config,
            "implement:fidelity",
            "routine",
            fidelityPrompt(prdText, contract, state, sourceContext, material, priorFidelityResult, fidelityRoundContext),
            (value) => validateFidelity(value, priorFidelityResult, fidelityRoundContext),
          ),
        ).then((record) => {
          progress(`fidelity: ${record.verdict} (${(record.durationMs / 1000).toFixed(0)}s)`);
          return record;
        }),
  ]);

  // The risk lane is never reused: its prompt consumes this attempt's
  // acceptance/fidelity results and the current open ledger. A risk ERROR is
  // itself harmless to the unified verdict, but it also proves nothing and
  // therefore cannot mutate or stand in for a later ledger review.
  let risk: LaneRecord<RiskLaneResult> | null = null;
  if (state.prd.reviewProfile === "high-risk") {
    progress("risk: judging residual risk");
    const riskRoundContext = riskLineageInput.context;
    risk = await judgeLane(crypto.randomUUID(), () =>
      runJudge(
        config,
        "implement:risk",
        "high-risk",
        // A complete diff is smaller and more honest than clamped whole-file
        // bodies: it includes every run-owned changed line, including new
        // files, without inviting the risk judge to block on pre-existing
        // context that this run did not change.
        riskPrompt(
          prdText,
          reviewDiff,
          acceptance.result,
          fidelity.result,
          state.artifacts,
          priorRiskResult,
          riskRoundContext,
          reviewEvidencePaths,
        ),
        (value) => validateRiskVerdict(value, priorRiskResult, riskRoundContext, nextRiskFindingNumber(state)),
        reviewNeedsAgentic
          ? { agentic: true, cwd: workRoot, evidencePaths: reviewEvidencePaths }
          : {},
      ),
    );
    const blocking = risk.result?.findings.filter((entry) => entry.severity === "blocking").length ?? 0;
    const advisory = risk.result?.findings.filter((entry) => entry.severity === "advisory").length ?? 0;
    progress(`risk: ${risk.verdict} (${blocking} blocking, ${advisory} advisory, ${(risk.durationMs / 1000).toFixed(0)}s)`);
  }
  // judgeLane never rejects (it records ERROR), so this pending lane cannot
  // become an unhandled rejection while risk runs.
  const design = await designPending;
  // Risk is a recorded review feeding the state-owned ledger, not a voter.
  // A fresh adversarial question has no fixed point; acceptance and fidelity
  // remain the only unified verdict inputs (PRINCIPLES 10 and 13).
  const laneVerdicts = [acceptance.verdict, fidelity.verdict];
  const verdict: VerificationStatus = laneVerdicts.includes("ERROR") ? "ERROR" : laneVerdicts.every((entry) => entry === "PASS") ? "PASS" : "FAIL";
  for (const criterion of acceptance.result?.criteria ?? []) {
    const item = state.acceptanceCriteria.find((entry) => entry.id === criterion.id);
    if (item === undefined) continue;
    item.status = criterion.verdict === "PASS" ? "complete" : "blocked";
    const note = `${criterion.verdict}: ${criterion.reason} (${criterion.evidence})`;
    if (!item.evidence.some((entry) => entry.text === note)) item.evidence.push({ at: nowIso(), text: note });
  }
  for (const item of state.verification.filter((entry) => judgeDeferred(state, entry, bindings))) item.status = verdict === "PASS" ? "PASS" : verdict;
  const attempt: UnifiedVerificationAttempt = {
    id: attemptId,
    inputFingerprint: inputFingerprint(state, source.digest, fidelityInput),
    sourceFingerprint: source.digest,
    inputManifest,
    roundContexts,
    fidelityInput,
    startedAt,
    finishedAt: nowIso(),
    durationMs: Date.now() - started,
    verdict,
    prelint,
    mechanical,
    skippedAcceptanceCriteria: skippedAcceptanceCriteria(state),
    lanes: { acceptance, fidelity, risk, design },
    error: verdict === "ERROR"
      ? { stage: "judge", code: "judge-error", message: [acceptance.error?.message, fidelity.error?.message].filter(Boolean).join("; ") }
      : null,
  };
  state.verificationAttempts.push(attempt);
  // ERROR means the risk reviewer produced no trustworthy result. The attempt
  // still records that error, while the ledger remains byte-for-byte intact.
  if (risk?.result != null) {
    state.riskFindings = reconcileRiskFindings(state.riskFindings, risk.result, attempt.id, nowIso());
  }
  // Only a lane that actually produced a comment set may reconcile. On ERROR
  // the lane saw nothing, and treating "saw nothing" as "reported nothing"
  // would silently resolve every open comment.
  if (design?.result != null) {
    state.designComments = reconcileDesignComments(state.designComments ?? [], design.result.comments, attempt.id, nowIso());
  }
  persistState(statePath, state);
  progress(`unified verification ${verdict} in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  const open = openDesignComments(state);
  const openRisk = openRiskFindings(state);
  if (open.length > 0) progress(`design: ${open.length} comment(s) await a disposition before finalize`);
  const openBlockingRisk = openRisk.filter((entry) => entry.severity === "blocking");
  if (openBlockingRisk.length > 0) progress(`risk: ${openBlockingRisk.length} blocking finding(s) await resolution before finalize`);
  const budget = verificationBudget(state, config.judge.retryBudget);
  const terminal = terminalBudgetMessage(budget);
  const designNote = open.length === 0 ? "" : `; ${open.length} design comment(s) await a disposition`;
  const riskNote = openBlockingRisk.length === 0 ? "" : `; ${openBlockingRisk.length} blocking risk finding(s) await resolution`;
  return result("verify", verdict === "PASS", `unified verification ${verdict}${terminal === null ? "" : `; ${terminal}`}${designNote}${riskNote}`, {
    attempt: attemptSummary(attempt),
    sourceRouting: sourceContext.routing,
    verificationBudget: budget,
    // Guaranteed render point: the orchestrating agent sees the comments it
    // owes an answer for in this response, in full, without any prompt needing
    // to be invoked - and the message line above repeats the count so a caller
    // reading only `message` cannot miss the debt.
    design: design === null
      ? { ran: false, open: [], acceptedCount: 0, resolvedCount: 0 }
      : {
          ran: true,
          ...(design.verdict === "ERROR" ? { error: design.error?.message ?? "unknown" } : {}),
          open,
          acceptedCount: (state.designComments ?? []).filter((entry) => entry.status === "open" && entry.accepted !== null).length,
          resolvedCount: (state.designComments ?? []).filter((entry) => entry.status === "resolved").length,
          howToAnswer: open.length === 0
            ? null
            : "fix it and re-run `sasu implement verify` (the comment disappears on its own), or record `sasu implement design --id <D#> --accept \"<why it is being left alone>\"`",
        },
    riskFindings: {
      openCount: openRisk.length,
      open: openRisk,
      fixedCount: state.riskFindings.filter((entry) => entry.status === "fixed").length,
      acceptedCount: state.riskFindings.filter((entry) => entry.status === "accepted").length,
      ...(risk?.verdict === "ERROR" ? { error: risk.error?.message ?? "unknown" } : {}),
      howToCloseBlocking: openBlockingRisk.length === 0
        ? null
        : "fix it and re-run `sasu implement verify`, or record verbatim user approval with `sasu implement risk --accept --id <RF#> --evidence \"<verbatim user approval>\"`",
    },
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

function designSection(state: ImplementState, attempt: UnifiedVerificationAttempt): string {
  const lane = attempt.lanes.design ?? null;
  if (lane === null) return "Not run (trivial profile or pre-design-lane attempt).";
  if (lane.verdict === "ERROR") return `Lane errored: ${lane.error?.message ?? "unknown"}. No comments were reconciled from this attempt.`;
  const tracked = state.designComments ?? [];
  if (tracked.length === 0) return "No comments.";
  const line = (entry: TrackedDesignComment): string => {
    const disposition = entry.status === "resolved"
      ? "resolved (the lane no longer reports it)"
      : entry.accepted !== null
        ? `accepted ${entry.accepted.at}: ${entry.accepted.note}`
        : "OPEN - no disposition";
    return `- ${entry.id} [${entry.area}] ${entry.path}\n  ${entry.text}\n  Suggestion: ${entry.suggestion}\n  Disposition: ${disposition}`;
  };
  return tracked.map(line).join("\n");
}

function riskSection(state: ImplementState, attempt: UnifiedVerificationAttempt): string {
  const lane = attempt.lanes.risk;
  const laneNote = lane?.verdict === "ERROR"
    ? `Latest lane errored: ${lane.error?.message ?? "unknown"}. The ledger was not changed by that attempt.`
    : null;
  if (state.riskFindings.length === 0) {
    if (laneNote !== null) return `${laneNote}\n\nNo findings.`;
    return lane === null ? "Not run (non-high-risk profile)." : "No findings.";
  }
  const line = (entry: TrackedRiskFinding): string => {
    const resolution = entry.resolution === undefined
      ? "none"
      : `${entry.resolution.at}: ${entry.resolution.evidence}`;
    return `- ${entry.id} [${entry.severity}] ${entry.text}\n  Origin attempt: ${entry.originAttemptId}\n  Status: ${entry.status}\n  Resolution: ${resolution}`;
  };
  return [laneNote, state.riskFindings.map(line).join("\n")].filter((entry) => entry !== null).join("\n\n");
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
  // Adoptions must reach a human surface: they deliberately do not move the
  // input fingerprint (ownership is process metadata, not judged material),
  // so this report and the receipt are the only places a reader learns the
  // close was delivered by a different session than the one that started it.
  const followUpLines = [
    ...(state.adoptions ?? []).map((entry) => `- ownership-adopted: taken over from session ${entry.fromSessionId} at ${entry.at} - "${entry.evidence}"`),
    ...state.deviations.map((entry) => `- ${entry.type}: ${entry.summary}`),
  ];
  const openItemsSection = blocked === undefined
    ? ""
    : `## Open Items\n\nThis run closed without a verification PASS. A person must settle each item before the work can be called done:\n\n${blocked.openItems.length === 0 ? "- none recorded" : blocked.openItems.map((item) => `- ${item}`).join("\n")}\n\n`;
  const skippedLines = attempt.skippedAcceptanceCriteria.length === 0
    ? "None."
    : attempt.skippedAcceptanceCriteria.map((entry) => `- ${entry.id}: ${entry.reason}`).join("\n");
  return `# Implementation Result: ${state.topicSlug}\n\n${statusLine}\n\n${openItemsSection}## Public Flow\n\nBind and run AC Checks -> implementation complete -> final evidence registered -> \`sasu implement verify\` -> \`sasu implement finalize\`.\n\n## Structure And Removal\n\nThe TypeScript CLI owns implement state, AC Check bindings and attempts, artifact registration, unified verification, and state-only finalization.\n\nThe old dispatcher, manual review recording, separate completion ledgers, and final reverification are not completion surfaces.\n\n\`state.json\` is the only machine record and the receipt plus this report are derived outputs.\n\nPinned PRD: \`${state.prd.snapshotPath}\` (${state.prd.sha256}).\n\nBaseline attribution: ${state.baselineAttribution.disposition}, digest ${state.baselineAttribution.baselineDigest}.\n\n## Tasks\n\n${taskLines}\n\n## Requirements\n\n${requirementLines}\n\n## Acceptance Criteria\n\n${acLines}\n\n### Skipped Acceptance Criteria\n\n${skippedLines}\n\n## Verification\n\n${verificationLines}\n\nUnified verdict: ${attempt.verdict}.\n\nInput fingerprint: ${attempt.inputFingerprint}.\n\nSource fingerprint: ${attempt.sourceFingerprint}.\n\n### Mechanical Runs\n\n${mechanicalLines}\n\n### Judge Lanes\n\n${laneLine("acceptance", attempt.lanes.acceptance)}\n${laneLine("fidelity", attempt.lanes.fidelity)}\n${laneLine("risk", attempt.lanes.risk)}\n${laneLine("design", attempt.lanes.design ?? null)}\n\nMechanical failures call zero judges by contract and regression test.\n\nFinalize execution calls: 0.\n\nCompletion fingerprint: ${fingerprint}.\n\n## Design Comments\n\nComments from the design lane and how each was answered. A comment is answered by being fixed (the lane stops reporting it) or by a recorded acceptance; \`finalize --status complete\` refuses while any comment is unanswered.\n\n${designSection(state, attempt)}\n\n## Risk Findings\n\nFindings from the risk lane and each ledger disposition. A blocking finding must be fixed by a later delta-grounded review or accepted with verbatim user approval before \`finalize --status complete\`. Advisory findings remain visible but do not block finalize.\n\n${riskSection(state, attempt)}\n\n## Deviations, Risks, And Follow-Ups\n\n${followUpLines.length === 0 ? "None." : followUpLines.join("\n")}\n`;
}

function finalize(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  const requestedStatus = flag(args, "status") ?? "complete";
  if (requestedStatus !== "complete" && requestedStatus !== "blocked") {
    throw new Error("finalize --status must be complete or blocked");
  }
  const { statePath, state } = loadState(projectRoot, stateOptions(args));
  if (state.status === "retired") throw new Error("implement run is retired and cannot be finalized");
  assertRunOwnership(statePath, state, args);
  const recordRoot = state.projectRoot;
  const source = captureSourceSnapshot(requireWorkRoot(state));
  const latest = state.verificationAttempts.at(-1);
  if (latest === undefined) throw new Error("finalize requires a unified verify attempt");
  const prdText = requirePinnedPrd(recordRoot, state);
  const contract = parseImplementContract(prdText);
  const sourceContext = fidelitySource(recordRoot, contract, specGateIsFresh(recordRoot, state));
  const currentFidelityInput = { routing: sourceContext.routing, contentSha256: sha256(sourceContext.content) };
  const fingerprint = completionFingerprint(state, source.digest, latest, currentFidelityInput);
  const blockers: string[] = [];
  blockers.push(...state.tasks.filter((entry) => entry.status !== "complete").map((entry) => `${entry.id} is ${entry.status}`));
  blockers.push(...state.acceptanceCriteria
    .filter((entry) => entry.check.status === "parked")
    .map((entry) => `${entry.id} is parked and was skipped by verification; resume and prove it before finalize`));
  blockers.push(...state.acceptanceCriteria.filter((entry) => entry.status !== "complete").map((entry) => `${entry.id} is ${entry.status}`));
  blockers.push(...state.verification.filter((entry) => entry.requiredForDone && entry.status !== "PASS").map((entry) => `${entry.id} is ${entry.status}`));
  blockers.push(...artifactIntegrityProblems(recordRoot, state));
  if (latest.verdict !== "PASS") blockers.push(`unified verify is ${latest.verdict}`);
  if (latest.sourceFingerprint !== source.digest) {
    // The attempt pin remains completion authority. The bounded path list
    // keeps the diagnosis the removed per-artifact tree fingerprints tried to
    // provide, without coupling every artifact to every source edit.
    const changedPaths = verificationRoundContext(
      verificationInputManifest(state.initialSource, source, state.artifacts, checkLedgerPayload(state)),
      latest,
    ).changedPaths;
    const shown = changedPaths.slice(0, 20);
    const count = changedPaths.length > 20 ? `first 20 of ${changedPaths.length}` : `${changedPaths.length} total`;
    blockers.push(
      `unified verify is STALE because judged source changed; changed paths since judged attempt ${latest.id} (${count}): ${shown.join(", ") || "none detected"}`,
    );
  }
  if (latest.inputFingerprint !== inputFingerprint(state, source.digest, currentFidelityInput)) {
    blockers.push("unified verify input fingerprint no longer matches current state, artifacts, or fidelity source");
  }
  blockers.push(...openRiskFindings(state)
    .filter((entry) => entry.severity === "blocking")
    .map((entry) =>
      `risk finding ${entry.id} (blocking) is open: fix it and re-run \`sasu implement verify\`, or \`sasu implement risk --accept --id ${entry.id} --evidence "<verbatim user approval>"\``,
    ));
  // The design lane's whole consequence. Not a verdict: the comment does not
  // have to be fixed, it has to be answered. Fixing answers it by making the
  // lane stop reporting it; the escape hatch is one recorded sentence, and
  // the record keeps that sentence next to the run forever.
  blockers.push(...openDesignComments(state).map(
    (entry) => `design comment ${entry.id} (${entry.area} @ ${entry.path}) has no disposition: fix it and re-verify, or \`sasu implement design --id ${entry.id} --accept "<why>"\``,
  ));
  if (requestedStatus === "blocked") {
    // The blocked close exists for runs whose verification machinery is
    // terminally stuck, never as a shortcut past fixable findings: it stays
    // refused while the budget predicate says another verify could run.
    const view = verificationBudget(state, loadConfig(recordRoot).judge.retryBudget);
    if (!view.budgetExhausted && !view.judgeErrorLoop) {
      throw new Error(
        "finalize --status blocked refused: verification can still run - fix the recorded findings and re-run `sasu implement verify`",
      );
    }
    const terminalReason = view.budgetExhausted ? "budget-exhausted" : "judge-error-loop";
    if (state.status === "blocked" && state.completion?.fingerprint === fingerprint) {
      const receipt = path.join(recordRoot, state.completion.receiptPath);
      const report = path.join(recordRoot, state.completion.implementationResultPath);
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
      prdSnapshotPath: state.prd.snapshotPath,
      baselineAttribution: state.baselineAttribution,
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
      verificationBudget: {
        fixAttempts: view.fixAttempts,
        budget: view.budget,
        consecutiveErrors: view.consecutiveErrors,
        judgeErrorThreshold: view.judgeErrorThreshold,
        judgeErrorCause: view.judgeErrorCause,
        judgeErrorLoop: view.judgeErrorLoop,
        grants: view.grants,
      },
      skippedAcceptanceCriteria: latest.skippedAcceptanceCriteria,
      openItems: blockers,
      ...((state.adoptions ?? []).length > 0 ? { adoptions: state.adoptions } : {}),
      ...(state.worktree ? { worktree: state.worktree } : {}),
      executionCallsDuringFinalize: 0,
    };
    writeJsonAtomic(path.join(recordRoot, receiptPath), receipt);
    writeTextAtomic(
      path.join(recordRoot, implementationResultPath),
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
    const receipt = path.join(recordRoot, state.completion.receiptPath);
    const report = path.join(recordRoot, state.completion.implementationResultPath);
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
    prdSnapshotPath: state.prd.snapshotPath,
    baselineAttribution: state.baselineAttribution,
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
    skippedAcceptanceCriteria: latest.skippedAcceptanceCriteria,
    ...((state.adoptions ?? []).length > 0 ? { adoptions: state.adoptions } : {}),
    ...(state.worktree ? { worktree: state.worktree } : {}),
    executionCallsDuringFinalize: 0,
  };
  writeJsonAtomic(path.join(recordRoot, receiptPath), receipt);
  writeTextAtomic(path.join(recordRoot, implementationResultPath), implementationReport(state, latest, fingerprint));
  state.status = "complete";
  state.completion = { fingerprint, completedAt, receiptPath, implementationResultPath };
  persistState(statePath, state);
  // A worktree run's code lives only on its branch until someone collects it;
  // the close must say so or the work silently strands in the worktree.
  const handoff = state.worktree
    ? `; the implementation lives on branch ${state.worktree.branch} at ${state.worktree.path} - merge it (\`git merge ${state.worktree.branch}\`) or deliver with $ship, and keep the worktree until then`
    : "";
  return result("finalize", true, `implementation finalized from fresh unified PASS${handoff}`, { completion: state.completion, receipt, executionCalls: 0 });
}

export async function runImplementCommand(projectRoot: string, args: ImplementArgs): Promise<ImplementCommandResult> {
  const subcommand = args.positional[1];
  try {
    if (subcommand === "intake") return intake(projectRoot);
    if (subcommand === "start") return start(projectRoot, args);
    if (subcommand === "check") return check(projectRoot, args);
    if (subcommand === "park") return park(projectRoot, args);
    if (subcommand === "resume") return resume(projectRoot, args);
    if (subcommand === "task") return task(projectRoot, args);
    if (subcommand === "artifact") return artifact(projectRoot, args);
    if (subcommand === "status") return status(projectRoot, args);
    if (subcommand === "verify") return await verify(projectRoot, args);
    if (subcommand === "design") return design(projectRoot, args);
    if (subcommand === "risk") return risk(projectRoot, args);
    if (subcommand === "retire") return retire(projectRoot, args);
    if (subcommand === "finalize") return finalize(projectRoot, args);
    return { ok: false, action: subcommand ?? "unknown", exitCode: 2, message: "unknown implement subcommand; use intake, start, check, park, resume, task, artifact, status, design, risk, verify, retire, or finalize" };
  } catch (error) {
    return {
      ok: false,
      action: subcommand ?? "unknown",
      exitCode: error instanceof SyntaxError || error instanceof VerifyInvariantError ? 1 : 2,
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof PrdDriftError ? { detail: { prdDrift: error.diagnostic } } : {}),
      ...(error instanceof VerifyInvariantError ? { detail: { reason: error.reason } } : {}),
    };
  }
}
