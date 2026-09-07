import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { laneEffortFor, loadConfig } from "../config";
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
import { parseImplementContract, reviewProfile, suiteCommands, type ImplementContract } from "./contract";
import { planRunUnits, runBatch, type RunUnit, type RunUnitResult } from "./runner";
import { suiteCommandNamed, suiteScore } from "./suite";
import { runScore, scoreLine } from "./score";
import { assertCommandAuthority, isIssuedCommand, recordVerb, rejectVerb, resolveIssuer, VerbRejected } from "./verbs";
import { recordEvent } from "./events";
import { AmendmentRejected, applyAmendment, sealRow } from "./amend";
import { assertNoActiveCheck, beginCheck, finishCheck, recordCheckExecution } from "./check-activity";
import { issueQaBrief, latestBriefFor, registerTrail, resolveDriverRole, TrailRejected } from "./qa";
import {
  assertEscalateBudget,
  buildHandoffBriefing,
  EscalateRejected,
  recordEscalation,
  renderDiagnosis,
  solverPrompt,
  validateDiagnosis,
} from "./solver";
import { waitForEvent } from "./waiter";
import { herdrCapabilities, isAgentAlive, readPane, spawnImplementor } from "./herdr";
import { DispatchRejected, dispatchImplementor } from "./dispatch";
import {
  assertCheckRow,
  checkLedgerForRow,
  checkLedgerPayload,
  latestCountedAttempt,
  parkRow,
  resumeRow,
  rowCheckIsGreen,
  rowCheckPayload,
  runRowCheck,
  parseCommandArgv,
  validateContractCheckCommands,
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
  type ChangeFile,
  type EnvelopeClaim,
  type EnvelopeFacts,
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
  persistClose,
  jsonText,
  requireWorkRoot,
  sha256,
  statePathFor,
  writeActivePointer,
  writeJsonAtomic,
  writeTextAtomic,

  parseImplementState,
} from "./store";
import {
  IMPLEMENT_SCHEMA,
  type AcceptanceCriterionInvocation,
  type AcLaneResult,
  type BehaviorRow,
  type DesignComment,
  type DirtyAttribution,
  type PrdJudgeRecord,
  type TrackedDesignComment,
  type FidelityCheckResult,
  type ImplementCommandResult,
  type ImplementState,
  type LaneRecord,
  type MechanicalRunRecord,
  type RegisteredArtifact,
  type ReviewProfile,
  type RiskLaneResult,
  type SolverHandoff,
  type TrackedRiskFinding,
  type UnifiedVerificationAttempt,
  type VerificationStatus,
  type VerificationInputManifest,
  type VerificationRoundContext,
  type VerificationRoundContexts,
  type IssuedCommand,
  type EvidenceReplacement,
  type IssuerLabel,
  ESCALATE_LIMIT_PER_RUN,
  STALL_THRESHOLD_MS,
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
    parkedRows: attempt.parkedRows,
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
    .map((entry) => ({ rowId: entry.rowId ?? null, path: entry.path, sha256: entry.sha256 }))
    .sort((left, right) => `${left.rowId}:${left.path}`.localeCompare(`${right.rowId}:${right.path}`));
  return sha256(JSON.stringify({
    schema: state.schema,
    prdSha256: state.prd.sha256,
    sourceDigest,
    artifacts,
    checkLedger: checkLedgerPayload(state).sha256,
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
  const parked = state.rows.filter((entry) => entry.status === "parked");
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
      rows: state.rows.length,
      rowsUnproved: state.rows.filter((entry) => entry.check.kind !== "human" && entry.status !== "green" && entry.status !== "PASS").length,
      humanOpen: state.rows.filter((entry) => entry.status === "OPEN").length,
      riskFindingsOpen: openRisk.length,
      rowsParked: parked.length,
    },
    rows: state.rows.map((entry) => ({
      id: entry.id,
      kind: entry.check.kind,
      payload: rowCheckPayload(entry),
      status: entry.status,
      attempts: entry.attempts.length,
      consecutiveFailures: entry.consecutiveFailures,
      verdict: entry.verdict,
      human: entry.human,
      rejections: entry.rejections.length,
    })),
    parked: parked.map((entry) => ({ id: entry.id, park: entry.parks.at(-1) })),
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
  validateContractCheckCommands(projectRoot, contract.rows);
  if ((contract.frontmatter["status"] ?? "") !== "ready") throw new Error(`PRD status must be ready, got ${contract.frontmatter["status"] ?? "missing"}`);
  const frontmatterApproval = (contract.frontmatter["human_approval"] ?? "").toLowerCase();
  const approval = flag(args, "allow-unapproved-prd")?.trim() ?? "";
  if (frontmatterApproval !== "approved" && approval === "") {
    throw new Error("PRD human_approval is pending; pass --allow-unapproved-prd with the user's verbatim approval");
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
    validateContractCheckCommands(workRoot, contract.rows);
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
        judge: prdJudge,
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
      rows: contract.rows.map(sealRow),
      artifacts: [],
      verificationAttempts: [],
      budgetGrants: [],
      deviations: [],
      riskFindings: [],
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
      `${occupant !== null ? ` because run '${occupant}' is active in this tree` : ""} - implement the rows there; records stay in this tree's agents/`;
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
  // Closed for implementation the moment finalize accepts it: only the
  // human's confirm may still write, and a closed run never reopens (R8).
  if (state.status === "complete-pending-human") throw new Error("implement run is closed (complete-pending-human); only `sasu implement confirm --row B<n>` may still write, and a closed run never reopens");
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

/**
 * Park is for `check:` rows only. Without this the attempt fails as "unknown
 * row S1", which is a refusal but not a reason - and the reason is the
 * point: a suite command has no row to prove later, so the only way to stop
 * running one is to remove it from the sealed list through an amendment.
 */
function assertNotSuiteCommand(state: ImplementState, args: ImplementArgs): void {
  const id = (flag(args, "row") ?? "").trim();
  if (id === "") return;
  const command = suiteCommandNamed(state, id);
  if (command === null) return;
  throw new Error(`${command.id} (${command.command}) is a sealed suite command, not a Behaviors row; suite commands cannot be parked. Fix the command, or exclude it from the sealed list through an amendment carrying verbatim human approval.`);
}

function rowNamed(state: ImplementState, args: ImplementArgs): BehaviorRow {
  const id = requiredFlag(args, "row").toUpperCase();
  const row = state.rows.find((entry) => entry.id === id);
  if (row === undefined) throw new Error(`unknown row: ${id}; this run has ${state.rows.map((entry) => entry.id).join(", ")}`);
  return row;
}

/**
 * Run one `check:` row's command and record the exit code (R3). Nothing is
 * bound here: the command is the PRD's own cell, sealed at start, and the
 * only thing an agent supplies is which row to run.
 */
async function check(projectRoot: string, args: ImplementArgs): Promise<ImplementCommandResult> {
  const { statePath, state } = loadState(projectRoot, stateOptions(args));
  assertRunOpenForMutation(state);
  assertRunOwnership(statePath, state, args);
  const row = rowNamed(state, args);
  const workRoot = requireWorkRoot(state);
  for (const forbidden of ["outcome", "exit-code", "output-fingerprint", "failure-class", "tree-fingerprint"]) {
    if (args.flags.has(forbidden)) {
      throw new Error(`--${forbidden} is harness-owned and cannot be supplied; \`sasu implement check\` records the real execution result`);
    }
  }
  assertCheckRow(row);
  beginCheck(statePath, state, row.id);
  let attempt;
  try {
    attempt = await runRowCheck(state, workRoot, row, (pid) => recordCheckExecution(statePath, state, pid));
  } catch (error) {
    finishCheck(statePath, state);
    throw error;
  }
  const at = nowIso();
  const actor = resolveIssuer(flag(args, "issuer"));
  finishCheck(statePath, state, (fresh) => {
    fresh.rows = fresh.rows.map((entry) => entry.id === row.id ? row : entry);
    recordEvent(fresh, { kind: "check-attempt", actor, subject: row.id, summary: `${row.id} check ${attempt.outcome} (exit ${attempt.exitCode})`, at });
    recordEvent(fresh, { kind: "row-status", actor, subject: row.id, summary: `${row.id} is ${row.status}`, at });
  });
  return result("check", attempt.outcome === "green", `${row.id} check ${attempt.outcome} (exit ${attempt.exitCode}) -> ${row.status}; consecutive failures ${row.consecutiveFailures}`, {
    rowId: row.id,
    command: (row.check as { command: string }).command,
    status: row.status,
    attempt,
  });
}

function park(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  const { statePath, state } = loadState(projectRoot, stateOptions(args));
  assertRunOpenForMutation(state);
  assertRunOwnership(statePath, state, args);
  assertNotSuiteCommand(state, args);
  const issuer = resolveIssuer(flag(args, "issuer"));
  assertCommandAuthority("park", issuer);
  const row = rowNamed(state, args);
  const at = nowIso();
  const entry = { verb: "park" as const, issuer, target: row.id, reason: flag(args, "reason")?.trim() ?? "", at };
  try {
    parkRow(row, {
      approval: flag(args, "approval")?.trim() ?? "",
      reason: flag(args, "reason")?.trim() ?? "",
      evidence: flag(args, "evidence")?.trim() || null,
    });
  } catch (error) {
    rejectVerb(state, entry, "transition", error instanceof Error ? error.message : String(error), () => persistState(statePath, state));
  }
  recordVerb(state, { ...entry, outcome: "accepted" });
  recordEvent(state, { kind: "park", actor: issuer, subject: row.id, summary: `${row.id} parked by ${issuer}`, at });
  recordEvent(state, { kind: "row-status", actor: issuer, subject: row.id, summary: `${row.id} is parked`, at });
  persistState(statePath, state);
  return result("park", true, `${row.id} parked by ${issuer} on recorded human approval; finalize remains blocked until resume and proof`, {
    rowId: row.id,
    issuer,
    park: row.parks.at(-1),
  });
}

/**
 * Wait once, in the background, for the run to do something.
 *
 * Read-only, and therefore absent from COMMAND_AUTHORITY: anyone may watch.
 *
 * Concurrency note (D-45 re-read against the code): the decision record says
 * the event log "reuses the existing state write lock". There is no such
 * lock - implement state is written by a plain atomic rename (persistState),
 * and the only lock in the repository belongs to the gate store. The decision
 * is therefore honoured as what it can mean here: the log lives INSIDE
 * state.json and is written through the one existing CLI write path, so this
 * PRD adds no second record and no second concurrency mechanism. The waiter
 * only reads.
 */
async function awaitEvent(projectRoot: string, args: ImplementArgs): Promise<ImplementCommandResult> {
  const { statePath } = loadState(projectRoot, stateOptions(args));
  const sinceFlag = flag(args, "since")?.trim();
  const since = sinceFlag === undefined || sinceFlag === "" ? null : Number(sinceFlag);
  if (since !== null && (!Number.isInteger(since) || since < 0)) {
    throw new Error(`--since must be a non-negative integer event id, got ${sinceFlag}`);
  }
  const pidFlag = flag(args, "pid")?.trim();
  const pid = pidFlag === undefined || pidFlag === "" ? null : Number(pidFlag);
  if (pid !== null && (!Number.isInteger(pid) || pid <= 0)) throw new Error(`--pid must be a positive integer, got ${pidFlag}`);
  const agent = flag(args, "agent")?.trim() || null;
  if (agent !== null && pid !== null) throw new Error("--agent and --pid are two answers to the same question; give one");
  const notifyFlag = flag(args, "notify-after");
  const notifyAfter = notifyFlag === undefined ? undefined : Number(notifyFlag);
  if (notifyAfter !== undefined && (!Number.isSafeInteger(notifyAfter) || notifyAfter < 0)) {
    throw new Error("--notify-after must be a non-negative integer timestamp from the previous re-arm command");
  }

  // Named targets use one long wait, not synchronous per-second list calls.
  // PID-only callers retain their direct process probe.
  const probe = pid !== null
    ? { probe: "pid", isAlive: () => { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; } } }
    : { probe: agent === null ? "unavailable" : "herdr-wait", isAlive: null };

  const outcome = await waitForEvent({
    loadState: () => parseImplementState(fs.readFileSync(statePath, "utf8")),
    since,
    stallMs: STALL_THRESHOLD_MS,
    notifyAfter,
    isAlive: probe.isAlive,
    agent: agent ?? undefined,
  });

  // The supervision loop's one unguarded link: the waiter is a one-shot, so a
  // supervisor that wakes, handles the event, and forgets to re-arm leaves the
  // implementor working with nobody watching - silently, with no error to
  // notice. Nothing in the harness can force the re-arm (the waiter is a
  // detached process the CLI cannot see), so the cheapest real reduction is to
  // hand the next command back fully assembled, with the cursor already
  // advanced and the same probe flag carried over, instead of asking the
  // supervisor to remember and rebuild it. Omitted on `implementor-gone`:
  // the target must be inspected before deciding how to recover.
  const rearm = outcome.reason === "implementor-gone"
    ? null
    : [
      "sasu implement await",
      ...(flag(args, "slug") !== undefined ? [`--slug ${flag(args, "slug")}`] : []),
      ...(flag(args, "state") !== undefined ? [`--state ${flag(args, "state")}`] : []),
      `--since ${outcome.cursor}`,
      ...(outcome.notifyAfter !== undefined ? [`--notify-after ${outcome.notifyAfter}`] : []),
      ...(agent !== null ? [`--agent ${agent}`] : pid !== null ? [`--pid ${pid}`] : []),
    ].join(" ");

  const message = `woke on ${outcome.reason}: ${outcome.detail}`;
  return result("await", true, rearm === null ? message : `${message}; re-arm in the background with: ${rearm}`, {
    reason: outcome.reason,
    cursor: outcome.cursor,
    waitedMs: outcome.waitedMs,
    events: outcome.events,
    livenessProbe: probe.probe,
    rearm,
  });
}

/**
 * Correct the question paper (R6).
 *
 * `amend` is the ONLY sanctioned way past the PRD drift guard. Everywhere
 * else a source PRD that no longer matches its pinned snapshot is a hard
 * error, because a question paper that changes under a run makes every green
 * on it unreadable. Amendment does not weaken that rule; it re-seals, and
 * pays for the change by taking back exactly the proofs whose cells moved.
 *
 * Authority is decided on the diff inside applyAmendment: a check-cell-only
 * diff is the observer's or the human's, anything that changes what the
 * user observes is the human's alone, and the implementor is refused
 * outright. The label is a declaration, not an authentication (D-39); what
 * it buys is that the ledger records the authority the change was accepted
 * under.
 */
function amend(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  const { statePath, state } = loadState(projectRoot, stateOptions(args));
  assertRunOpenForMutation(state);
  const issuer = resolveIssuer(flag(args, "issuer"));
  // The observer edits the measurement contract, not the implementation.
  // Taking ownership here forced two adoptions (or a retired run) for one
  // corrected command. The diff authority below still refuses scope changes.
  const source = normalizeProjectPath(projectRoot, state.prdPath);
  if (!fs.existsSync(source.absolute) || !fs.statSync(source.absolute).isFile()) {
    throw new Error(`amended PRD not found at ${state.prdPath}; edit the source PRD first, then amend`);
  }
  const text = fs.readFileSync(source.absolute, "utf8");
  const excludeSuite = (flag(args, "exclude-suite") ?? "").split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
  // An exclusion IS the amendment's substance, so it does not also need a PRD
  // edit to justify itself (AC42). Without one, an identical PRD means there
  // is nothing to correct.
  if (sha256(text) === state.prd.sha256 && excludeSuite.length === 0) {
    throw new AmendmentRejected("arguments", `${state.prdPath} is byte-identical to the pinned snapshot; there is nothing to amend. Edit the PRD first, or name a sealed suite command with --exclude-suite.`);
  }
  const at = nowIso();
  const entry = { verb: "amend" as const, issuer, target: null, reason: flag(args, "reason")?.trim() ?? "", at };
  let outcome;
  try {
    try {
      assertNoActiveCheck(state);
    } catch (error) {
      throw new AmendmentRejected("transition", error instanceof Error ? error.message : String(error));
    }
    if (issuer !== "observer") assertRunOwnership(statePath, state, args);
    outcome = applyAmendment(projectRoot, state, {
      issuer,
      approval: flag(args, "approval")?.trim() ?? "",
      reason: flag(args, "reason")?.trim() ?? "",
      text,
      excludeSuite,
    }, at);
  } catch (error) {
    // Recorded before it is thrown: an observer whose behaviors amendment
    // was refused must be able to read why from the run's history.
    if (error instanceof AmendmentRejected) {
      rejectVerb(state, entry, error.check, error.message, () => persistState(statePath, state));
    }
    throw error;
  }
  const { record, plan, derived } = outcome;
  const summary = [
    `${plan.scope}`,
    `${plan.invalidatedRows.length} invalidated`,
    `${plan.addedRows.length} added`,
    `${plan.removedRows.length} removed`,
    `${plan.unchangedRows.length} untouched`,
    ...(record.suiteSnapshotUpdated ? [`${record.excludedSuiteCommands!.length} suite command(s) excluded`] : []),
  ].join(", ");
  recordVerb(state, { ...entry, outcome: "accepted" });
  recordEvent(state, { kind: "amendment", actor: issuer, subject: null, summary: `amendment ${record.id} by ${issuer}: ${summary}`, at });
  for (const rowId of [...plan.invalidatedRows, ...plan.addedRows]) {
    const row = state.rows.find((candidate) => candidate.id === rowId);
    if (row !== undefined) recordEvent(state, { kind: "row-status", actor: issuer, subject: row.id, summary: `${row.id} is ${row.status}`, at });
  }
  persistClose(statePath, state, derived);
  return result("amend", true, `amendment ${record.id} sealed by ${issuer}; rows ${summary}. Previous snapshot archived at ${record.previousSnapshotPath}`, {
    amendment: record,
    scope: plan.scope,
    invalidatedRows: plan.invalidatedRows,
    addedRows: plan.addedRows,
    removedRows: plan.removedRows,
    unparkedRows: plan.unparkedRows,
    unchangedRows: plan.unchangedRows,
  });
}

/**
 * Issue the numbered script for a driven criterion (R11, AC30).
 *
 * This is the ONLY briefing channel by construction, not by instruction: a
 * trail can only name a briefId this command minted, so a drive carried out
 * on instructions from anywhere else has nothing to register against.
 */
function qaBrief(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  const { statePath, state } = loadState(projectRoot, stateOptions(args));
  assertRunOpenForMutation(state);
  assertRunOwnership(statePath, state, args);
  const row = rowNamed(state, args);
  const at = nowIso();
  const previous = latestBriefFor(state, row.id);
  const brief = issueQaBrief(state, row, at);
  recordEvent(state, {
    kind: "trail",
    actor: resolveIssuer(flag(args, "issuer")),
    subject: row.id,
    summary: `qa brief ${brief.briefId} issued for ${row.id} (${brief.steps.length} step(s))`,
    at,
  });
  persistState(statePath, state);
  const reissue = previous === null ? "" : `; supersedes ${previous.briefId}`;
  return result("qa-brief", true, `brief ${brief.briefId} issued for ${row.id} with ${brief.steps.length} step(s)${reissue}. Register the drive with \`sasu implement trail --row ${row.id} --brief ${brief.briefId} --steps ${brief.steps.map((step) => step.id).join(",")} --driver <human|observer|qa-agent>\``, {
    brief,
    supersedes: previous?.briefId ?? null,
  });
}

/**
 * Register a drive against its brief (R11, AC31, AC32).
 *
 * The driver role is a declaration and not an authentication, exactly like
 * the issuer label (PRD 10장). What the check buys is that an implementor
 * driving its own work must lie in the record to do it, and the record is
 * what a human audits.
 */
function trail(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  const { statePath, state } = loadState(projectRoot, stateOptions(args));
  assertRunOpenForMutation(state);
  assertRunOwnership(statePath, state, args);
  const row = rowNamed(state, args);
  const driverRole = resolveDriverRole(flag(args, "driver"));
  const artifactPaths = (flag(args, "artifacts") ?? "").split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
  const at = nowIso();
  const record = registerTrail(state, {
    rowId: row.id,
    briefId: requiredFlag(args, "brief").trim(),
    driverRole,
    coveredStepIds: (flag(args, "steps") ?? "").split(","),
    artifactPaths,
  }, at);
  recordEvent(state, {
    kind: "trail",
    actor: resolveIssuer(flag(args, "issuer")),
    subject: row.id,
    summary: `trail ${record.id} accepted for ${row.id} against ${record.briefId}, driven by ${driverRole}`,
    at,
  });
  persistState(statePath, state);
  return result("trail", true, `trail ${record.id} accepted for ${row.id}: every step of ${record.briefId} covered, driven by ${driverRole} (declared, not authenticated)`, {
    trail: record,
    superseded: state.trails.filter((entry) => entry.rowId === row.id && entry.status === "superseded").map((entry) => entry.id),
  });
}

/**
 * Summon the solver, then reset the implementor (R12, AC33-AC35).
 *
 * The ordering is the guarantee. Everything before `runJudge` reads; the
 * judge call itself runs on the read-only backend every other lane uses; and
 * the first state write happens after it has returned. So "zero state writes
 * during solver execution" (AC33) is a property of the call graph, not a rule
 * somebody has to remember.
 */
/**
 * Read the handoff packet the supervisor is sending.
 *
 * stdin, because the packet is a multi-line document with the user's verbatim
 * words in it and argv is the wrong place for that: a failing wrapper may echo
 * argv, and the spawn hole already redacts the prompt for the same reason.
 * A terminal with nothing piped into it would block forever, so it is read as
 * empty and refused by name instead.
 */
function readHandoffPacket(): string {
  if (process.stdin.isTTY === true) return "";
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function dispatch(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  try {
    const dispatched = dispatchImplementor(projectRoot, {
      name: requiredFlag(args, "name"),
      prdPath: requiredFlag(args, "prd"),
      handoff: readHandoffPacket(),
      cwd: projectRoot,
      kind: flag(args, "kind")?.trim() || undefined,
      model: flag(args, "model")?.trim() || undefined,
      effort: flag(args, "effort")?.trim() || undefined,
    });
    return result(
      "dispatch",
      true,
      `implementor ${dispatched.agent} (${dispatched.kind}) started in ${dispatched.paneId} from ${dispatched.prd}`,
      { ...dispatched },
      [
        `Wake on its events with \`sasu implement await --agent ${dispatched.agent}\`.`,
        `Read its pane with \`herdr agent read ${dispatched.agent} --source recent-unwrapped --lines 120\` for diagnosis only.`,
      ],
    );
  } catch (error) {
    // A refused dispatch created nothing, so it is a message and an exit code,
    // not a recorded run event: there is no run yet to record it against.
    if (error instanceof DispatchRejected) return { ok: false, action: "dispatch", exitCode: 1, message: `dispatch refused: ${error.message}` };
    throw error;
  }
}

async function escalate(projectRoot: string, args: ImplementArgs): Promise<ImplementCommandResult> {
  const { statePath, state } = loadState(projectRoot, stateOptions(args));
  assertRunOpenForMutation(state);
  assertRunOwnership(statePath, state, args);
  const config = loadConfig(state.projectRoot);
  const issuer = resolveIssuer(flag(args, "issuer"));
  assertEscalateBudget(state);
  const reason = flag(args, "reason")?.trim() ?? "";
  if (reason === "") throw new EscalateRejected("arguments", "escalate requires --reason <what the implementor is stuck on>");
  const target = flag(args, "target")?.trim().toUpperCase() || null;
  if (target !== null && !state.rows.some((entry) => entry.id === target)) {
    throw new EscalateRejected("arguments", `unknown --target ${target}; name a Behaviors row in this run`);
  }
  const agent = flag(args, "agent")?.trim() || null;

  // Read-only preparation. `readPane` is diagnosis input and nothing else: a
  // missing pane degrades the envelope, it does not stop the escalation (R9).
  const prd = requirePinnedPrd(projectRoot, state);
  const ledger = JSON.stringify(checkLedgerPayload(state), null, 2);
  const pane = agent === null
    ? { ok: false, value: null, problem: "no --agent given, so there is no pane to read" }
    : readPane({ name: agent });

  const profile: ReviewProfile = "high-risk";
  const lane = await judgeLane(crypto.randomUUID(), () => runJudge(
    config,
    "implement:solver",
    // The solver reuses the high-risk profile's routing rather than adding a
    // model knob of its own (R12, D-46): one routing table, not two.
    profile,
    solverPrompt({
      target,
      reason,
      prd,
      checkLedger: ledger,
      paneExcerpt: pane.value,
      paneProblem: pane.problem,
    }),
    (value) => validateDiagnosis(value),
  ));

  const at = nowIso();
  if (lane.verdict === "ERROR" || lane.result === null) {
    const failure = lane.error?.message ?? "the solver returned nothing usable";
    const record = recordEscalation(state, {
      at, target, reason, profile,
      model: lane.judge?.model ?? null,
      outcome: "summon-failed",
      diagnosis: null,
      error: failure,
      handoff: null,
    });
    recordEvent(state, { kind: "escalate", actor: issuer, subject: target, summary: `escalation ${record.id} failed to summon a solver`, at });
    persistState(statePath, state);
    // A failed summon is a recorded outcome, not a thrown error: the
    // supervisor asked a question and the honest answer is "nobody came",
    // which belongs in the ledger where the next decision is made (AC35).
    return result("escalate", false, `escalation ${record.id} failed: ${failure}. The implementor was NOT reset. ${ESCALATE_LIMIT_PER_RUN - state.escalations.length} escalation(s) remain.`, {
      escalation: record,
      escalationsRemaining: ESCALATE_LIMIT_PER_RUN - state.escalations.length,
    });
  }

  const diagnosis = lane.result;
  const solverDir = `${state.runDir}/artifacts/solver`;
  const id = Math.max(0, ...state.escalations.map((entry) => entry.id)) + 1;
  const handoff: SolverHandoff = {
    prdSnapshotPath: state.prd.snapshotPath,
    diagnosisPath: `${solverDir}/diagnosis-${id}.md`,
    checkLedgerPath: `${solverDir}/check-ledger-${id}.json`,
  };
  fs.mkdirSync(path.join(projectRoot, solverDir), { recursive: true });
  writeTextAtomic(path.join(projectRoot, handoff.diagnosisPath), renderDiagnosis({ id, at, target, reason }, diagnosis));
  writeTextAtomic(path.join(projectRoot, handoff.checkLedgerPath), `${ledger}\n`);

  const briefing = buildHandoffBriefing(handoff);
  const reset = agent === null
    ? { ok: false, value: null, problem: "no --agent given; reset the implementor's context yourself and hand it the three artifacts below" }
    : spawnImplementor({ name: `${agent}-r${id}`, cwd: state.worktree?.path ?? projectRoot, prompt: briefing });

  const record = recordEscalation(state, {
    at, target, reason, profile,
    model: lane.judge?.model ?? null,
    outcome: "diagnosed",
    diagnosis: diagnosis.summary,
    error: null,
    handoff,
  });
  recordEvent(state, {
    kind: "escalate",
    actor: issuer,
    subject: target,
    summary: `escalation ${record.id} diagnosed${reset.ok ? " and the implementor was reset" : "; the context reset is the supervisor's to perform"}`,
    at,
  });
  persistState(statePath, state);
  return result("escalate", true, `escalation ${record.id} diagnosed: ${diagnosis.summary}. ${reset.ok ? "A replacement implementor was started with the three handoff artifacts." : `Context reset not performed automatically (${reset.problem}).`}`, {
    escalation: record,
    handoff,
    briefing,
    contextReset: reset.ok,
    contextResetProblem: reset.problem,
    escalationsRemaining: ESCALATE_LIMIT_PER_RUN - state.escalations.length,
  });
}

function resume(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  const { statePath, state } = loadState(projectRoot, stateOptions(args));
  assertRunOpenForMutation(state);
  assertRunOwnership(statePath, state, args);
  const issuer = resolveIssuer(flag(args, "issuer"));
  assertCommandAuthority("resume", issuer);
  const row = rowNamed(state, args);
  const at = nowIso();
  const entry = { verb: "resume" as const, issuer, target: row.id, reason: flag(args, "reason")?.trim() ?? "", at };
  try {
    resumeRow(row);
  } catch (error) {
    rejectVerb(state, entry, "transition", error instanceof Error ? error.message : String(error), () => persistState(statePath, state));
  }
  recordVerb(state, { ...entry, outcome: "accepted" });
  recordEvent(state, { kind: "resume", actor: issuer, subject: row.id, summary: `${row.id} resumed by ${issuer}`, at });
  recordEvent(state, { kind: "row-status", actor: issuer, subject: row.id, summary: `${row.id} is pending`, at });
  persistState(statePath, state);
  return result("resume", true, `${row.id} resumed to pending; consecutive failure counter reset to 0`, {
    rowId: row.id,
    status: row.status,
    consecutiveFailures: row.consecutiveFailures,
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
  while (!fs.existsSync(existingAncestor)) {
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
  const rowId = flag(args, "row")?.trim().toUpperCase();
  if (rowId !== undefined && !state.rows.some((entry) => entry.id === rowId)) {
    throw new Error(`unknown row: ${rowId}; this run has ${state.rows.map((entry) => entry.id).join(", ")}`);
  }
  const targetLabel = rowId ?? "run";
  const kind = requiredFlag(args, "kind").toLowerCase();
  if (!ARTIFACT_KINDS.has(kind) || kind === "command-log") throw new Error(`--kind must be one of: screenshot, image, browser, api, db, log, file`);
  // Artifact paths live in the RECORD tree (normally under the run dir):
  // the receipt cites them, and the record must outlive the worktree.
  const target = normalizeProjectPath(state.projectRoot, requiredFlag(args, "path"));
  assertEvidencePathInsideProject(state.projectRoot, target);
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
  const previous = state.artifacts.find((entry) => entry.rowId === rowId && entry.path === target.relative);
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
    ...(rowId !== undefined ? { rowId } : {}),
    kind,
    path: target.relative,
    description,
    ...inspected,
    registeredAt: nowIso(),
  };
  // Replacing evidence is the move after a rejection, and it used to leave no
  // trace: the old row was dropped and the record could not tell a criterion
  // proved once from one proved on the third try (R15 ①, AC40).
  if (previous !== undefined) {
    recordEvidenceReplacement(state, {
      rowId: rowId ?? "run",
      kind: "artifact",
      previous: `${previous.path} @ ${previous.sha256} registered ${previous.registeredAt}`,
      next: `${registered.path} @ ${registered.sha256}`,
      // The file no longer holds those bytes, so the old vouch is not merely
      // superseded - it is false, and a false vouch must not survive.
      priorDisposition: "invalidated",
    });
  }
  state.artifacts = state.artifacts.filter((entry) => !(entry.rowId === rowId && entry.path === target.relative));
  state.artifacts.push(registered);
  persistState(statePath, state);
  return result("artifact", true, `artifact registered for ${targetLabel}: ${target.relative}`, { artifact: registered });
}

/**
 * Routes a supervisor's remark into the design lane's ledger (R10).
 *
 * No new lane, no new blocker, no second review surface: the remark becomes a
 * `TrackedDesignComment` like any other, so it inherits the disposition
 * command and the `finalize --status complete` refusal that already exist
 * (D-25, AGENTS.md Review Guide 4 - this adds a verb and deletes the case for
 * a supervisor-remark lane).
 *
 * The key is minted from the comment id rather than from `area::path`, which
 * is the lane's identity rule. That rule exists so a re-worded lane comment
 * matches its previous self across attempts; a raised comment is never
 * re-derived, and reusing the lane key would collide a supervisor's second
 * remark on one file with the first, and with any lane comment on it.
 */
function raiseDesignComment(
  statePath: string,
  state: ImplementState,
  args: ImplementArgs,
): ImplementCommandResult {
  const issuer = resolveIssuer(flag(args, "issuer"));
  const at = nowIso();
  const area = requiredFlag(args, "area").trim();
  const target = normalizeProjectPath(state.projectRoot, requiredFlag(args, "path"));
  const text = requiredFlag(args, "text").trim();
  const suggestion = requiredFlag(args, "suggestion").trim();
  // No emptiness check here: `requiredFlag` already refuses a blank value, and
  // a second one would be an unreachable branch pretending to be a guard.
  const entry = { verb: "design-raise" as const, issuer, target: target.relative, reason: text, at };
  const tracked = state.designComments ?? [];
  const id = `D${tracked.reduce((high, existing) => Math.max(high, Number(existing.id.slice(1)) || 0), 0) + 1}`;
  const comment: TrackedDesignComment = {
    area,
    path: target.relative,
    text,
    suggestion,
    id,
    key: `raised::${id}`,
    status: "open",
    raisedBy: issuer,
    accepted: null,
    firstSeenAt: at,
    lastSeenAt: at,
    lastSeenAttemptId: "",
  };
  tracked.push(comment);
  state.designComments = tracked;
  recordVerb(state, { ...entry, outcome: "accepted" });
  recordEvent(state, {
    kind: "comment",
    actor: issuer,
    subject: id,
    summary: `${id} raised by ${issuer} on ${target.relative}`,
    at,
  });
  persistState(statePath, state);
  const open = openDesignComments(state);
  return result("design", true, `${id} raised by ${issuer} on ${target.relative}; ${open.length} design comment(s) await a disposition`, {
    comment,
    open,
  });
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
  if (args.flags.get("raise") === true) return raiseDesignComment(statePath, state, args);
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
/**
 * Declares one open finding structurally unfixable (R16 ③, AC46).
 *
 * 2026-08-29, interview-anchor: the run is still active today because the
 * blocked close only asked whether the judge budget was spent. Three rounds
 * whose outcome nobody disputed stood between a known-terminal run and an
 * honest record, so the record stayed a lie by omission instead.
 *
 * This is deliberately not `--accept`. Accepting says "we are shipping with
 * this"; declaring non-convergence says "this cannot be fixed and we are
 * closing blocked", and the finding stays OPEN in the receipt to say so.
 */
function riskNonConvergent(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  const { statePath, state } = loadState(projectRoot, stateOptions(args));
  assertRunOpenForMutation(state);
  assertRunOwnership(statePath, state, args);
  const id = requiredFlag(args, "id").toUpperCase();
  const approval = requiredFlag(args, "approval");
  const reason = requiredFlag(args, "reason");
  const entry = state.riskFindings.find((candidate) => candidate.id === id);
  if (entry === undefined) {
    const known = openRiskFindings(state).map((candidate) => candidate.id);
    throw new Error(`unknown risk finding: ${id}${known.length === 0 ? "" : ` (open: ${known.join(", ")})`}`);
  }
  if (entry.status !== "open") {
    throw new Error(`${id} is ${entry.status}, not open: only an open finding can be declared non-convergent`);
  }
  // The structural fact the harness owns: how many judged attempts this
  // finding has already survived. Corroboration in the record, never the gate.
  const originIndex = state.verificationAttempts.findIndex((attempt) => attempt.id === entry.originAttemptId);
  const roundsUnchanged = originIndex === -1 ? 0 : state.verificationAttempts.length - originIndex - 1;
  entry.nonConvergence = { at: nowIso(), approval, reason, declaredBy: "human", roundsUnchanged };
  persistState(statePath, state);
  return result(
    "risk",
    true,
    `${id} declared non-convergent after ${roundsUnchanged} judged round(s) unchanged; it stays open and `
      + `\`finalize --status complete\` stays refused, but \`--status blocked\` no longer waits for the judge budget`,
    { finding: entry, open: openRiskFindings(state) },
  );
}

function risk(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  if (args.flags.get("non-convergent") === true) return riskNonConvergent(projectRoot, args);
  if (args.flags.get("accept") !== true) throw new Error("risk requires --accept or --non-convergent");
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

/**
 * What a person asks `status` for, in the order they ask it.
 *
 * 2026-08-29, interview-anchor: the parked criterion's reason was in the
 * output and nobody could find it, because the output was 491 lines of JSON.
 * The fix is not a shorter record - it is answering the question above the
 * record (AC47). Sections with nothing to say print nothing, so a healthy run
 * stays short and an unhealthy one is all signal.
 */
/**
 * Write the refusal into the run's own history before it reaches the caller.
 *
 * 2026-08-29, interview-anchor (R16 ②): the gate refused a supervisor and the
 * run's record said nothing had been attempted. An audit trail that only
 * remembers what succeeded cannot answer "who tried to close this task?",
 * which is the whole reason the issuer label exists (PRD 10장: the mitigation
 * for a false declaration is the record, so the record has to exist).
 *
 * A missing or unreadable run is not an error here. The command is being
 * refused either way, and replacing the authority message with a bookkeeping
 * one would hide the answer the caller asked for.
 */
function recordAuthorityRefusal(
  projectRoot: string,
  args: ImplementArgs,
  subject: IssuedCommand,
  issuer: IssuerLabel,
  message: string,
): void {
  let statePath: string;
  let state: ImplementState;
  try {
    ({ statePath, state } = loadState(projectRoot, stateOptions(args)));
  } catch {
    return;
  }
  recordVerb(state, {
    at: nowIso(),
    verb: subject,
    issuer,
    target: flag(args, "row")?.toUpperCase() ?? flag(args, "id")?.toUpperCase() ?? null,
    reason: `refused: ${subject}`,
    outcome: "rejected",
    rejection: { check: "authority", message },
  });
  persistState(statePath, state);
}

function statusSummary(state: ImplementState, herdr: { available: boolean; holes: Record<"spawn" | "read" | "alive", boolean> }): string[] {
  const lines: string[] = [scoreLine(runScore(state))];
  const verdict = state.verificationAttempts.at(-1)?.verdict ?? "NOT_RUN";
  lines.push(`verify: ${verdict}`);

  // One line per row: the PRD's own words for the state (R5).
  lines.push("", `rows (${state.rows.length}):`);
  for (const row of state.rows) {
    const detail = row.check.kind === "check"
      ? (latestCountedAttempt(row) === null ? "not run" : `exit ${latestCountedAttempt(row)!.exitCode}, ${row.attempts.length} attempt(s)`)
      : row.check.kind === "judge"
        ? (row.verdict === null ? "awaiting verify" : row.verdict.reason)
        : (row.human === null ? (row.rejections.at(-1) === undefined ? "awaiting confirm" : `rejected: ${row.rejections.at(-1)!.evidence}`) : `confirmed: ${row.human.evidence}`);
    lines.push(`  ${row.id} ${row.check.kind}: ${row.status} - ${detail}`);
  }

  const parked = state.rows.filter((entry) => entry.status === "parked");
  if (parked.length > 0) {
    lines.push("", `parked (${parked.length}) - each must be resumed and proved before a complete finalize:`);
    for (const entry of parked) {
      const park = entry.parks.at(-1);
      lines.push(`  ${entry.id} ${park?.reason ?? "no reason recorded"}`);
      if (park?.evidence) lines.push(`    evidence: ${park.evidence}`);
    }
  }

  const comments = openDesignComments(state);
  if (comments.length > 0) {
    lines.push("", `design comments awaiting a disposition (${comments.length}):`);
    for (const entry of comments) lines.push(`  ${entry.id} [${entry.area} @ ${entry.path}] ${entry.text}`);
  }

  const risks = openRiskFindings(state);
  if (risks.length > 0) {
    lines.push("", `open risk findings (${risks.length}):`);
    for (const entry of risks) {
      lines.push(`  ${entry.id} [${entry.severity}] ${entry.text}`);
      if (entry.nonConvergence !== undefined) {
        lines.push(`    declared non-convergent by ${entry.nonConvergence.declaredBy} after ${entry.nonConvergence.roundsUnchanged} unchanged round(s): ${entry.nonConvergence.reason}`);
      }
    }
  }


  // AC41: what happened to the escalations, and - once the bound is spent -
  // the fact that no further machine move exists. The refusal message says
  // this too, but a supervisor deciding what to do next reads status, not the
  // message from a command it has not run yet.
  if (state.escalations.length > 0) {
    const spent = state.escalations.length;
    const roster = state.escalations.map((entry) => `#${entry.id} ${entry.outcome}`).join(", ");
    lines.push("", `escalations: ${spent} of ${ESCALATE_LIMIT_PER_RUN} used (${roster})`);
    if (spent >= ESCALATE_LIMIT_PER_RUN) {
      lines.push(
        "  the bound is spent - a fourth solver on the same problem is not a plan.",
        "  this needs an operator decision: park the blocked row with a verbatim approval,",
        "  amend the PRD, or close the run with `finalize --status blocked`.",
      );
    }
    const failed = state.escalations.filter((entry) => entry.outcome === "summon-failed");
    if (failed.length > 0) {
      lines.push(`  ${failed.length} summon(s) failed, so the implementor was never reset for ${failed.map((entry) => `#${entry.id}`).join(", ")}`);
    }
  }

  const replacements = state.evidenceReplacements;
  if (replacements.length > 0) {
    lines.push("", `evidence resubmitted (${replacements.length}):`);
    for (const entry of replacements.slice(-5)) {
      lines.push(`  ${entry.rowId} ${entry.kind}: ${entry.next} (previous ${entry.priorDisposition})`);
    }
  }

  const excluded = state.suite.exclusions;
  if (excluded.length > 0) {
    lines.push("", `suite commands excluded by amendment (${excluded.length}) - no longer scored, their last result kept as history:`);
    for (const entry of excluded) lines.push(`  ${entry.commandId}: ${entry.reason}`);
  }

  // AC38 ②: what the supervisor may do about all of the above, right now.
  // Derived from state rather than listed as prose, so it cannot describe a
  // verb the gate would refuse. What it deliberately does not carry is the
  // recommended move - that is the supervisor's judgment, not the harness's.
  const offers: string[] = [];
  const parkable = state.rows.filter((entry) => entry.check.kind === "check" && entry.status === "fail").map((entry) => entry.id);
  if (parkable.length > 0) offers.push(`park with the human's approval (${parkable.join(", ")})`);
  if (parked.length > 0) offers.push(`resume (${parked.map((entry) => entry.id).join(", ")})`);
  const escalationsLeft = ESCALATE_LIMIT_PER_RUN - state.escalations.length;
  if (escalationsLeft > 0) offers.push(`escalate (${escalationsLeft} of ${ESCALATE_LIMIT_PER_RUN} left)`);
  const drivable = state.rows.filter((entry) => entry.check.kind === "judge" && entry.status !== "PASS").map((entry) => entry.id);
  if (drivable.length > 0) offers.push(`qa-brief (${drivable.join(", ")})`);
  const openHuman = state.rows.filter((entry) => entry.status === "OPEN").map((entry) => entry.id);
  if (openHuman.length > 0 && state.status === "complete-pending-human") offers.push(`confirm --issuer human (${openHuman.join(", ")})`);
  offers.push("amend --issuer observer (check cells only)", "design --raise");
  lines.push("", `supervisor verbs available now: ${offers.join(" | ")}`);

  if (!herdr.available) {
    const missing = (["spawn", "read", "alive"] as const).filter((hole) => !herdr.holes[hole]);
    lines.push("", `herdr unavailable - no ${missing.join(", ")}; pane diagnosis and implementor replacement are the supervisor's to perform by hand`);
  }
  lines.push("", "full record: re-run with --json");
  return lines;
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
  // Which of the three herdr holes are open. Named per hole rather than as one
  // boolean because "herdr is unavailable" does not tell a supervisor whether
  // it has lost pane diagnosis or the ability to start a replacement (AC27).
  const herdr = herdrCapabilities();
  return result("status", true, `${state.topicSlug}: ${state.status}`, {
    ...publicState(state, config.judge.retryBudget, source.digest, heldPrd.drift === null ? currentInput : "PRD_DRIFT"),
    herdr: {
      available: herdr.available,
      unavailableHoles: (["spawn", "read", "alive"] as const).filter((hole) => !herdr.holes[hole]),
      reason: herdr.reason,
    },
    artifactProblems: problems,
    prdProblem: heldPrd.drift === null ? null : "PRD changed after implement start",
    prdDrift: heldPrd.drift,
  }, statusSummary(state, herdr));
}

function writeMechanicalLog(
  projectRoot: string,
  state: ImplementState,
  run: Omit<MechanicalRunRecord, "logPath">,
  stdout: string,
  stderr: string,
): string {
  const key = sha256(`${run.cwd}\0${run.command}`).slice(0, 16);
  const relative = `${state.runDir}/artifacts/logs/mechanical-${key}.log`;
  const absolute = path.join(projectRoot, relative);
  writeTextAtomic(absolute, [
    `command: ${run.command}`,
    `cwd: ${run.cwd}`,
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

function upsertCommandArtifacts(state: ImplementState, run: MechanicalRunRecord, projectRoot: string): void {
  const inspected = inspectArtifactFile(path.join(projectRoot, run.logPath), "log");
  const artifact: RegisteredArtifact = {
    kind: "command-log",
    path: run.logPath,
    description: `mechanical ${run.status}: ${run.command}`,
    ...inspected,
    registeredAt: run.finishedAt,
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
 * Run the sealed suite once, on one frozen tree, and record every result on
 * the suite axis. `check:` rows are not in this batch: they run one at a
 * time through `sasu implement check --row` and verify reads their ledger.
 * Three properties carry over from the unification: no shell and no
 * inherited environment, no stop-at-first-failure (a run that declined to
 * execute a command cannot honestly say "suite 3/3"), and one executor.
 */
async function runUnifiedBatch(
  recordRoot: string,
  workRoot: string,
  state: ImplementState,
  units: RunUnit[],
  attemptId: string,
): Promise<{ records: MechanicalRunRecord[]; results: RunUnitResult[]; treeMoved: { before: string; after: string } | null }> {
  const timeoutMs = loadConfig(recordRoot).verify.commandTimeoutMs;
  const records: MechanicalRunRecord[] = [];
  const outcome = await runBatch(state, workRoot, units, timeoutMs, (result) => {
    const base: Omit<MechanicalRunRecord, "logPath"> = {
      command: result.unit.command,
      cwd: result.unit.cwd,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      durationMs: result.durationMs,
      // The real exit code; `mutatedTree` carries the moved-tree reason so
      // the code can stay true (PRINCIPLES 10).
      exitCode: result.exitCode,
      mutatedTree: result.mutatedTree,
      status: result.outcome === "green" ? "PASS" : "FAIL",
    };
    const logPath = writeMechanicalLog(recordRoot, state, base, result.stdout, result.stderr);
    const record: MechanicalRunRecord = { ...base, logPath };
    progress(`mechanical ${record.status} in ${(record.durationMs / 1000).toFixed(1)}s: ${record.command}`);
    records.push(record);
    upsertCommandArtifacts(state, record, recordRoot);
    attributeToSuite(state, result, attemptId, logPath);
  });
  return { records, results: outcome.results, treeMoved: outcome.treeMoved };
}

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

function changeMaterial(projectRoot: string, state: ImplementState, current: ReturnType<typeof captureSourceSnapshot>): ChangeFile[] {
  return changedPathsSince(state.initialSource, current).map((relative) => {
    const absolute = path.join(projectRoot, relative);
    if (!fs.existsSync(absolute)) return { path: relative, body: "[deleted]" };
    const buffer = fs.readFileSync(absolute);
    if (buffer.includes(0)) return { path: relative, body: `[binary ${buffer.length} bytes]` };
    const text = buffer.toString("utf8");
    return { path: relative, body: text.length > 24_000 ? `${text.slice(0, 12_000)}\n[... truncated ...]\n${text.slice(-12_000)}` : text };
  });
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
  row: BehaviorRow,
  changedFiles: string,
  runs: MechanicalRunRecord[],
  contract: ImplementContract,
): AcceptancePromptMaterial {
  const criterion = { id: row.id };
  // The suite's failing logs reach every judge row: a red regression guard
  // is context for any row, while a green one is already summarised in the
  // facts section. Nothing maps a suite command to one row any more.
  const checks: CheckResult[] = runs
    .filter((run) => run.status === "FAIL")
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
  const cited = new Set(row.decisionIds);
  for (const artifact of state.artifacts.filter((entry) => entry.command === undefined && entry.rowId === row.id)) {
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
    decisions: contract.decisions.filter((entry) => cited.has(entry.id)),
    facts: envelopeFacts(state, row),
    claims: envelopeClaims(state),
  };
}

/**
 * Section 2 of the envelope: what the harness executed or wrote itself (AC8).
 *
 * The four the requirement names - check ledger, suite results, rebind and
 * amendment history, parked list - are here because each answers a question a
 * judge would otherwise have to guess at: what ran, what else is red, whether
 * the oracle was swapped mid-run, whether the question changed, and what was
 * deliberately not proven. A judge missing the rebind history cannot tell a
 * criterion that passed from one whose check was replaced until it passed.
 */
function envelopeFacts(state: ImplementState, row: BehaviorRow): EnvelopeFacts {
  const byId = new Map(state.suite.commands.map((entry) => [entry.id, entry]));
  return {
    checkLedger: JSON.stringify({ thisRow: JSON.parse(checkLedgerForRow(row)) as unknown, allRows: checkLedgerPayload(state).rows }, null, 2),
    suiteResults: state.suite.results.map((entry) => ({
      commandId: entry.commandId,
      command: byId.get(entry.commandId)?.command ?? entry.commandId,
      status: entry.status,
      exitCode: entry.exitCode,
    })),
    suiteExclusions: state.suite.exclusions.map((entry) => ({ commandId: entry.commandId, at: entry.at })),
    amendments: state.amendments.map((entry) => ({
      id: entry.id,
      at: entry.at,
      scope: entry.scope,
      issuer: entry.issuer,
      invalidatedRows: entry.invalidatedRows,
      addedRows: entry.addedRows,
      unparkedRows: entry.unparkedRows,
    })),
    parked: state.rows
      .filter((entry) => entry.status === "parked")
      .map((entry) => ({ id: entry.id, at: entry.parks.at(-1)?.parkedAt ?? "unknown" })),
  };
}

/**
 * Section 3: every sentence a person or an agent wrote, with its origin (AC8).
 *
 * Collected run-wide rather than per criterion on purpose. A park reason on a
 * neighbouring criterion is context for why this run looks the way it does,
 * and withholding it would leave the judge reconstructing the run from
 * fragments - which is when a judge starts inferring. What it must never do
 * is rest a verdict on any of it, and Section 3's own text says so (AC9).
 */
function envelopeClaims(state: ImplementState): EnvelopeClaim[] {
  const claims: EnvelopeClaim[] = [];
  for (const row of state.rows) {
    for (const park of row.parks) {
      claims.push({ origin: "human", subject: `${row.id} park`, text: `${park.reason} (approval quoted: ${park.approval})` });
    }
    for (const rejection of row.rejections) {
      claims.push({ origin: "human", subject: `${row.id} confirm rejected`, text: rejection.evidence });
    }
  }
  for (const amendment of state.amendments) {
    claims.push({ origin: amendment.issuer, subject: `amendment ${amendment.id} (${amendment.scope})`, text: `${amendment.reason} (approval quoted: ${amendment.approval})` });
  }
  for (const exclusion of state.suite.exclusions) {
    claims.push({ origin: "human", subject: `suite exclusion ${exclusion.commandId}`, text: `${exclusion.reason} (approval quoted: ${exclusion.approval})` });
  }
  for (const verb of state.verbs) {
    if (verb.issuer !== "observer" || verb.reason.trim() === "") continue;
    claims.push({ origin: "observer", subject: `${verb.verb}${verb.target === null ? "" : ` ${verb.target}`} (${verb.outcome})`, text: verb.reason });
  }
  for (const escalation of state.escalations) {
    claims.push({ origin: "observer", subject: `escalation ${escalation.id} reason`, text: escalation.reason });
    if (escalation.diagnosis !== null) {
      claims.push({ origin: "solver", subject: `escalation ${escalation.id} diagnosis`, text: escalation.diagnosis });
    }
  }
  for (const grant of state.budgetGrants ?? []) {
    claims.push({ origin: "human", subject: "budget grant", text: grant.evidence });
  }
  return claims;
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

/**
 * Deliberately NOT scoped to the round's re-review paths (designReviewPaths),
 * unlike the risk lane's deltaBasis rule. The lane misses a real defect
 * roughly one attempt in eight (measured 2026-08-20, see
 * reconcileDesignComments), so a comment at an unchanged path on a later
 * round is as likely a late catch as a re-read; rejecting it would discard a
 * finding to save a re-read, for a lane whose only consequence is a
 * disposition. The round contract narrows attention in the prompt and the
 * chunker; identity by path (designCommentKey) bounds the damage of a repeat.
 */
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
    // Normalized here and nowhere else: `path` is half the identity key, so
    // a leading "./" would silently fork one comment into two.
    const commentPath = (comment["path"] as string).trim().replace(/^\.\//, "");
    comments.push({
      area: (comment["area"] as string).trim(),
      path: commentPath,
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
        raisedBy: null,
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
  // Only a lane comment resolves by absence. A supervisor-raised comment has
  // no lane reporting it, so "the lane stopped saying it" is not evidence of
  // anything about it; auto-resolving it here would have quietly deleted the
  // remark on the next verify (R10: it must be answered, not outlived).
  for (const entry of next) if (entry.raisedBy === null && !seen.has(entry.key)) entry.status = "resolved";
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
    const criteria = lane.result.criteria.filter((entry) => entry.id === invocation.rowId);
    if (criteria.length > 0) settled.set(invocation.rowId, { invocation, criteria });
  }
  return settled;
}

async function acceptanceLane(
  config: ReturnType<typeof loadConfig>,
  recordRoot: string,
  workRoot: string,
  state: ImplementState,
  contract: ImplementContract,
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
  // The acceptance JUDGE sees judge: rows only (R4). A check: row already
  // has an exit code against its sealed command, and asking a judge to
  // re-read it is asking a weaker instrument to second-guess a stronger one
  // (AGENTS.md Review Guide 1). Its ledger still reaches every judge as a
  // fact in Section 2. It stays IN the lane's result, settled from that
  // ledger with `source: "harness"`, so a lane with no judge: rows cannot
  // print green over a red check: row (`every(PASS)` over an empty list).
  // human: rows are neither: they are the person's to close, and the lane
  // neither judges nor counts them.
  const judgeRows = state.rows.filter((row) => row.status !== "parked" && row.check.kind === "judge");
  const ledgerRows = state.rows.filter((row) => row.status !== "parked" && row.check.kind === "check");
  const perRow = await mapWithConcurrency(judgeRows, judgeFanoutLimit(), async (row) => {
    const prior = settled.get(row.id);
    if (reuse !== null && prior !== undefined) {
      progress(`acceptance ${row.id}: ${prior.invocation.verdict} (reused from the ERROR'd attempt)`);
      return {
        invocation: { ...prior.invocation, reusedFrom: reuse.id },
        criteria: prior.criteria,
      };
    }
    if (!state.artifacts.some((artifact) => artifact.rowId === row.id)) {
      const at = nowIso();
      const reason = `the evidence the judge: cell declares is not registered for this row: ${(row.check as { evidence: string }).evidence}`;
      progress(`acceptance ${row.id}: FAIL (${reason})`);
      return {
        invocation: {
          rowId: row.id,
          invocationId: crypto.randomUUID(),
          startedAt: at,
          finishedAt: at,
          durationMs: 0,
          verdict: "FAIL" as const,
          judge: null,
          error: null,
          // No judge was summoned: the declared evidence is missing, and a
          // judge asked to rule without it would be guessing.
          source: "harness" as const,
        },
        criteria: [{ id: row.id, verdict: "FAIL" as const, reason, evidence: `none registered for ${row.id}; register with \`sasu implement artifact --row ${row.id} ...\`` }],
      };
    }
    const record = await judgeLane(crypto.randomUUID(), async () => {
      const material = acceptanceMaterial(recordRoot, state, row, changedFiles, mechanical, contract);
      const priorInput = priorInputs.get(row.id)!;
      const priorCriterion = priorInput.result;
      const rowRoundContext = priorInput.context;
      // With no inlined artifact or image, the only honest basis for a PASS
      // is the code itself - and the agentic probe measured judges reading
      // zero to two files, zero included. A PASS with a known-zero read
      // trace is rejected through the normal invalid-output ladder. An
      // unknown trace (toolRounds null) never rejects.
      const inlinedProof = material.evidence.length > 0 || material.readableArtifacts.length > 0;
      return runJudge(
        config,
        `implement:acceptance:${row.id}`,
        "routine",
        acceptancePrompt(row, material, priorCriterion, rowRoundContext),
        (value, activity) => {
          const verdict = validateSemanticVerdict(value, [row.id]);
          if (typeof verdict === "string") return verdict;
          const rawCriteria = (value as { criteria?: unknown }).criteria;
          const rawCriterion = Array.isArray(rawCriteria)
            ? rawCriteria.find((entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry) && (entry as Record<string, unknown>)["id"] === row.id)
            : undefined;
          if (rawCriterion === undefined) return `${row.id} raw result is missing`;
          const delta = validateVerdictDelta(
            rawCriterion as Record<string, unknown>,
            verdict.criteria[0]!.verdict,
            priorCriterion?.verdict ?? null,
            rowRoundContext,
            row.id,
          );
          if (typeof delta === "string") return delta;
          const passed = verdict.criteria.some((entry) => entry.verdict === "PASS");
          if (!inlinedProof && passed && activity.commands.length === 0 && activity.toolRounds === 0) {
            return `${row.id} has no inlined artifact, so a PASS must rest on reading the implementation; no file read was recorded - read the files you cite as evidence, then judge again`;
          }
          return {
            ...verdict,
            criteria: verdict.criteria.map((entry) => entry.id === row.id ? { ...entry, ...delta } : entry),
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
    progress(`acceptance ${row.id}: ${record.verdict} (${(record.durationMs / 1000).toFixed(0)}s)`);
    const invocation: AcceptanceCriterionInvocation = {
      rowId: row.id,
      invocationId: record.invocationId,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      durationMs: record.durationMs,
      verdict: record.verdict,
      judge: record.judge,
      error: record.error,
      source: "judge",
    };
    return { invocation, criteria: record.result?.criteria ?? [] };
  });
  // Ledger-settled rows. No judge is called, so these cost nothing and are
  // recomputed every attempt rather than reused from an ERROR'd one: there is
  // nothing expensive to carry over, and a stale carry-over would be a second
  // record of a fact state.json already holds. verify has already refused a
  // stale or red check: row, so these are green by construction; the row is
  // still listed so the lane result names every row it covers.
  const fromLedger = ledgerRows.map((row) => {
    const at = nowIso();
    const green = rowCheckIsGreen(row);
    const attempt = latestCountedAttempt(row);
    progress(`acceptance ${row.id}: ${green ? "PASS" : "FAIL"} (from the check ledger, no judge call)`);
    return {
      invocation: {
        rowId: row.id,
        invocationId: crypto.randomUUID(),
        startedAt: at,
        finishedAt: at,
        durationMs: 0,
        verdict: (green ? "PASS" : "FAIL") as VerificationStatus,
        judge: null,
        error: null,
        source: "harness" as const,
      },
      criteria: [{
        id: row.id,
        verdict: green ? ("PASS" as const) : ("FAIL" as const),
        reason: green ? "the harness ran the check: command and it exited 0" : attempt === null ? "the check: command has not been run" : `the check: command exited ${attempt.exitCode}`,
        evidence: `${(row.check as { command: string }).command}${attempt === null ? "" : ` (attempt ${attempt.id}, tree ${attempt.tree.product.slice(0, 12)})`}`,
      }],
    };
  });
  const criteria = [...perRow, ...fromLedger].flatMap((entry) => entry.criteria);
  const invocations = [...perRow, ...fromLedger].map((entry) => entry.invocation);
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
      ? { code: "acceptance-row-error", message: invocations.map((entry) => entry.error?.message).filter(Boolean).join("; ") }
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

function parkedRows(state: ImplementState): UnifiedVerificationAttempt["parkedRows"] {
  return state.rows
    .filter((row) => row.status === "parked")
    .map((row) => ({ id: row.id, reason: row.parks.at(-1)?.reason ?? "parked by recorded human approval" }));
}

/**
 * Why verify may not start yet, per `check:` row (R3, R4): every unparked
 * check: row must be green on the tree being judged. A green earned on an
 * earlier tree is stale - the row's proof names the tree it was earned on
 * (AGENTS.md 10), and a verify that accepted it would be judging one tree
 * with another's exit codes.
 */
function checkRowBlockers(state: ImplementState, productDigest: string): string[] {
  const blockers: string[] = [];
  for (const row of state.rows) {
    if (row.check.kind !== "check" || row.status === "parked") continue;
    if (!rowCheckIsGreen(row)) {
      blockers.push(`${row.id} is ${row.status}`);
      continue;
    }
    const attempt = latestCountedAttempt(row)!;
    if (attempt.tree.product !== productDigest) {
      blockers.push(`${row.id} is green on tree ${attempt.tree.product.slice(0, 12)}, but the judged tree is now ${productDigest.slice(0, 12)}`);
    }
  }
  return blockers;
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
    parkedRows: parkedRows(state),
    lanes: { acceptance: null, fidelity: null, risk: null },
    error: { stage, code, message },
  };
}

async function verify(projectRoot: string, args: ImplementArgs): Promise<ImplementCommandResult> {
  const { statePath, state } = loadState(projectRoot, stateOptions(args));
  assertRunOpenForMutation(state);
  assertRunOwnership(statePath, state, args);
  const recordRoot = state.projectRoot;
  const workRoot = requireWorkRoot(state);
  const source = captureSourceSnapshot(workRoot);
  const rowBlockers = checkRowBlockers(state, source.digest);
  if (rowBlockers.length > 0) {
    throw new Error(`verify requires every check: row green on the current tree; ${rowBlockers.join("; ")}. Run \`sasu implement check --row B<n>\` on each, or park it with the human's verbatim approval.`);
  }
  const changedPaths = changedPathsSince(state.initialSource, source);
  if (changedPaths.length === 0) {
    // 2026-08-25 creator-studio spent eight judge rounds on zero changed files
    // after a post-commit start captured the implementation in the baseline.
    // Refusing here moves that contradiction out of judge discretion and into
    // the code-owned invariant before any verification budget can be spent.
    throw new VerifyInvariantError(
      "empty-run-owned-change-set",
      `implement verify refused [empty-run-owned-change-set]: the run-owned change set is empty. Two causes produce this: (a) \`sasu implement start\` ran after the implementation was committed, contaminating the baseline with it, or (b) every dirty path was dispositioned pre-existing at start, absorbing the work into the baseline. Either way there is no run-owned change for a judge to verify. Run \`sasu implement retire\`, then restart with \`sasu implement start\` before implementation begins (attribute genuinely run-owned dirty work as run-owned, not pre-existing).`,
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
  const acceptancePriorInputs = new Map(state.rows.filter((row) => row.check.kind !== "human").map((row) => [
    row.id,
    priorLaneInput(state, inputManifest, (attempt) =>
      attempt.lanes.acceptance?.result?.criteria.find((entry) => entry.id === row.id)),
  ]));
  const fidelityPriorInput = priorLaneInput(state, inputManifest, (attempt) => attempt.lanes.fidelity?.result);
  const riskLineageInput = priorLaneInput(state, inputManifest, (attempt) => attempt.lanes.risk?.result);
  const priorRiskResult = riskLedgerPriorResult(state, riskLineageInput.result);
  const designPriorInput = priorLaneInput(state, inputManifest, (attempt) => attempt.lanes.design?.result);
  // One id for this attempt, minted before the mechanical batch so a suite
  // result can name the attempt it was produced in while it is being produced.
  const attemptId = crypto.randomUUID();
  const roundContexts: VerificationRoundContexts = {
    acceptance: Object.fromEntries([...acceptancePriorInputs].map(([id, input]) => [id, input.context])),
    fidelity: fidelityPriorInput.context,
    risk: state.prd.reviewProfile === "high-risk" ? riskLineageInput.context : null,
    design: state.prd.reviewProfile === "trivial" ? null : designPriorInput.context,
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
    progress(`dropped ${poisoned.length} agent-registered artifact(s) on harness-owned path(s): ${poisoned.map((entry) => `${entry.rowId ?? "run"}:${entry.path}`).join(", ")}`);
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
  const batch = await runUnifiedBatch(recordRoot, workRoot, state, units, attemptId);
  const mechanical = batch.records;
  // The suite axis is independent of the row score: a red suite command is
  // a regression guard no row is watching, so it blocks the run on its own
  // even with every row proved.
  const failedMechanical = mechanical.find((entry) => entry.status === "FAIL");
  if (batch.treeMoved !== null || failedMechanical !== undefined) {
    // A tree that moved mid-batch invalidates the whole batch: the results
    // were not all earned on one tree, so none of them names a tree honestly.
    // Reported ahead of individual failures because it explains them.
    const score = suiteScore(state);
    const message = batch.treeMoved !== null
      ? `judged source changed while mechanical commands were running (${batch.treeMoved.before.slice(0, 12)} -> ${batch.treeMoved.after.slice(0, 12)}); no result was earned on a single frozen tree`
      : failedMechanical!.mutatedTree
        ? `${failedMechanical!.command} rewrote judged source while it ran (exit ${failedMechanical!.exitCode}); a command may not move the tree it is proving`
        : `suite ${score.green}/${score.total} GREEN; ${failedMechanical!.command} failed with exit ${failedMechanical!.exitCode}. Fix it, or exclude it from the sealed list through an amendment carrying verbatim human approval.`;
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
  progress(`judging ${state.rows.filter((row) => row.check.kind === "judge" && row.status !== "parked").length} judge: row(s) and fidelity in parallel (profile: ${state.prd.reviewProfile})`);
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
  // What the re-review carries: the lane's own open comments. A supervisor-
  // raised comment has no lane behind it, so it is neither re-examined nor
  // droppable by the lane (see reconcileDesignComments).
  const openLaneComments = (state.designComments ?? [])
    .filter((entry) => entry.status === "open" && entry.raisedBy === null)
    .map((entry) => ({ id: entry.id, area: entry.area, path: entry.path, text: entry.text }));
  const designRoundContext = designPriorInput.context;
  const designPending: Promise<LaneRecord<{ comments: DesignComment[] }> | null> = !runDesignLane
    ? Promise.resolve(null)
    : judgeLane(crypto.randomUUID(), () =>
        runJudge(
          config,
          "implement:design",
          "routine",
          designPrompt(prdText, reviewDiff, material, reviewEvidencePaths, openLaneComments, designRoundContext),
          validateDesign,
          {
            // The lane's own measured budget, below the profile's: it has no
            // verdict to carry (LANE_EFFORT in config.ts has the numbers).
            effort: laneEffortFor(config, "design"),
            ...(reviewNeedsAgentic
              ? { agentic: true, cwd: workRoot, evidencePaths: reviewEvidencePaths }
              : {}),
          },
        ),
      ).then((record) => {
        const summary = record.verdict === "ERROR"
          ? `ERROR (${record.error?.message ?? "unknown"})`
          : `${record.result?.comments.length ?? 0} comment(s)`;
        progress(`design: ${summary} (${(record.durationMs / 1000).toFixed(0)}s)`);
        return record;
      });
  const [acceptance, fidelity] = await Promise.all([
    acceptanceLane(config, recordRoot, workRoot, state, contract, changedFiles, changedPaths, mechanical, reuse, acceptancePriorInputs),
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
  // judge: rows take the lane's verdict as their status, in the PRD's own
  // words (PASS/FAIL), and each transition is an event the observer wakes on.
  for (const criterion of acceptance.result?.criteria ?? []) {
    const row = state.rows.find((entry) => entry.id === criterion.id);
    if (row === undefined || row.check.kind !== "judge") continue;
    const before = row.status;
    row.verdict = { attemptId, verdict: criterion.verdict, reason: `${criterion.reason} (${criterion.evidence})` };
    row.status = criterion.verdict;
    if (before !== row.status) recordEvent(state, { kind: "row-status", actor: "implementor", subject: row.id, summary: `${row.id} is ${row.status}`, at: nowIso() });
  }
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
    parkedRows: parkedRows(state),
    lanes: { acceptance, fidelity, risk, design },
    error: verdict === "ERROR"
      ? { stage: "judge", code: "judge-error", message: [acceptance.error?.message, fidelity.error?.message].filter(Boolean).join("; ") }
      : null,
  };
  state.verificationAttempts.push(attempt);
  recordEvent(state, { kind: "verify", actor: "implementor", subject: null, summary: `verify ${verdict} (attempt ${attemptId})`, at: nowIso() });
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
    const declaration = entry.nonConvergence === undefined
      ? ""
      : `\n  Non-convergent: declared by ${entry.nonConvergence.declaredBy} at ${entry.nonConvergence.at} after `
        + `${entry.nonConvergence.roundsUnchanged} judged round(s) unchanged - ${entry.nonConvergence.reason}`
        + `\n  Approval: "${entry.nonConvergence.approval}"`;
    return `- ${entry.id} [${entry.severity}] ${entry.text}\n  Origin attempt: ${entry.originAttemptId}\n  Status: ${entry.status}\n  Resolution: ${resolution}${declaration}`;
  };
  return [laneNote, state.riskFindings.map(line).join("\n")].filter((entry) => entry !== null).join("\n\n");
}

/** One row's result the way the receipt states it (R7). */
function rowResult(row: BehaviorRow): Record<string, unknown> {
  switch (row.check.kind) {
    case "check": {
      const attempt = latestCountedAttempt(row);
      return attempt === null
        ? { kind: "check", command: row.check.command, status: row.status, exitCode: null, finishedAt: null, tree: null }
        : { kind: "check", command: row.check.command, status: row.status, exitCode: attempt.exitCode, finishedAt: attempt.finishedAt, durationMs: attempt.durationMs, tree: attempt.tree.product };
    }
    case "judge":
      return { kind: "judge", evidence: row.check.evidence, status: row.status, verdict: row.verdict?.verdict ?? null, reason: row.verdict?.reason ?? null, attemptId: row.verdict?.attemptId ?? null };
    case "human": {
      const rejected = row.rejections.at(-1) ?? null;
      return {
        kind: "human",
        confirmation: row.check.confirmation,
        status: row.human === null ? (rejected === null ? "OPEN" : `OPEN (rejected: ${rejected.evidence})`) : "PASS",
        confirmedAt: row.human?.confirmedAt ?? null,
        evidence: row.human?.evidence ?? null,
        rejections: row.rejections,
      };
    }
  }
}

/** The Behaviors table with every row's result, the receipt's body (R7). */
function receiptRows(state: ImplementState): Array<Record<string, unknown>> {
  return state.rows.map((row) => ({
    id: row.id,
    behavior: row.behavior,
    check: `${row.check.kind}: ${rowCheckPayload(row)}`,
    decisions: row.decisionIds,
    parked: row.status === "parked" ? row.parks.at(-1)?.reason ?? "parked" : null,
    result: rowResult(row),
  }));
}

/** The run's closing status from its rows alone (R8). */
function closingStatus(state: ImplementState): "complete" | "complete-pending-human" {
  return state.rows.some((row) => row.status === "OPEN") ? "complete-pending-human" : "complete";
}

function rowLine(row: BehaviorRow): string {
  const result = rowResult(row);
  const detail = row.check.kind === "check"
    ? (result["exitCode"] === null ? "not run" : `exit ${String(result["exitCode"])} at ${String(result["finishedAt"])}, tree ${String(result["tree"]).slice(0, 12)}`)
    : row.check.kind === "judge"
      ? (row.verdict === null ? "not judged" : row.verdict.reason)
      : String(result["status"]) + (row.human === null ? "" : ` - "${row.human.evidence}" at ${row.human.confirmedAt}`);
  return `| ${row.id} | ${row.behavior.replace(/\|/g, "\\|")} | ${row.check.kind}: ${rowCheckPayload(row).replace(/\|/g, "\\|")} | ${row.status} | ${detail.replace(/\|/g, "\\|")} |`;
}

function implementationReport(
  state: ImplementState,
  attempt: UnifiedVerificationAttempt,
  fingerprint: string,
  blocked?: { terminalReason: string; openItems: string[] },
): string {
  const rowTable = [
    "| # | 사용자가 관찰하는 행동 | 검사 방법 | 상태 | 결과 |",
    "| --- | --- | --- | --- | --- |",
    ...state.rows.map(rowLine),
  ].join("\n");
  const mechanicalLines = attempt.mechanical.length === 0
    ? "- none"
    : attempt.mechanical.map((run) => `- ${run.status}: \`${run.command}\` in \`${run.cwd}\`, exit ${run.exitCode}, ${run.durationMs}ms, log ${run.logPath}`).join("\n");
  const laneLine = (name: string, lane: LaneRecord<unknown> | null): string => lane === null
    ? `- ${name}: NOT_REQUIRED`
    : `- ${name}: ${lane.verdict}, invocation ${lane.invocationId}, ${lane.startedAt} to ${lane.finishedAt}, ${lane.durationMs}ms`;
  const status = blocked === undefined ? closingStatus(state) : "blocked";
  const statusLine = blocked === undefined
    ? (status === "complete" ? "Status: Done" : "Status: Done, pending human confirmation")
    : `Status: Blocked (${blocked.terminalReason})`;
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
  const parkedLines = attempt.parkedRows.length === 0
    ? "None."
    : attempt.parkedRows.map((entry) => `- ${entry.id}: ${entry.reason}`).join("\n");
  const score = runScore(state);
  const open = score.rows.open;
  const humanSection = open.length === 0
    ? "No human: row is open."
    : `${open.length} human: row(s) still OPEN. Each closes only with the user's own words:\n\n${open.map((entry) => `- ${entry.id}: \`sasu implement confirm --issuer human --row ${entry.id} --evidence "<user words>"\`${entry.rejected === null ? "" : ` (last rejected: ${entry.rejected})`}`).join("\n")}`;
  return `# Implementation Result: ${state.topicSlug}\n\n${statusLine}\n\n${openItemsSection}## Score\n\n${scoreLine(score)}\n\n${score.rows.unproven.length === 0 ? "Unproven rows: none." : `Unproven rows: ${score.rows.unproven.join(", ")}.`}\n\n## Behaviors\n\n${rowTable}\n\n### Parked Rows\n\n${parkedLines}\n\n### Human Confirmation\n\n${humanSection}\n\n## Structure\n\n\`state.json\` is the only machine record; the receipt and this report are derived outputs.\n\nPinned PRD: \`${state.prd.snapshotPath}\` (${state.prd.sha256}).\n\nBaseline attribution: ${state.baselineAttribution.disposition}, digest ${state.baselineAttribution.baselineDigest}.\n\n## Verification\n\nUnified verdict: ${attempt.verdict}.\n\nInput fingerprint: ${attempt.inputFingerprint}.\n\nSource fingerprint: ${attempt.sourceFingerprint}.\n\n### Suite\n\n${mechanicalLines}\n\n### Judge Lanes\n\n${laneLine("acceptance", attempt.lanes.acceptance)}\n${laneLine("fidelity", attempt.lanes.fidelity)}\n${laneLine("risk", attempt.lanes.risk)}\n${laneLine("design", attempt.lanes.design ?? null)}\n\nMechanical failures call zero judges by contract and regression test.\n\nFinalize execution calls: 0.\n\nCompletion fingerprint: ${fingerprint}.\n\n## Design Comments\n\nComments from the design lane and how each was answered. A comment is answered by being fixed (the lane stops reporting it) or by a recorded acceptance; \`finalize --status complete\` refuses while any comment is unanswered.\n\n${designSection(state, attempt)}\n\n## Risk Findings\n\nFindings from the risk lane and each ledger disposition. A blocking finding must be fixed by a later delta-grounded review or accepted with verbatim user approval before \`finalize --status complete\`. Advisory findings remain visible but do not block finalize.\n\n${riskSection(state, attempt)}\n\n## Deviations, Risks, And Follow-Ups\n\n${followUpLines.length === 0 ? "None." : followUpLines.join("\n")}\n`;
}

const RECEIPT_SCHEMA = "sasu.implement.receipt.v4";

function finalize(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  const requestedStatus = flag(args, "status") ?? "complete";
  if (requestedStatus !== "complete" && requestedStatus !== "blocked") {
    throw new Error("finalize --status must be complete or blocked");
  }
  const { statePath, state } = loadState(projectRoot, stateOptions(args));
  if (state.status === "retired") throw new Error("implement run is retired and cannot be finalized");
  // A closed run never reopens (R8): the human rows are closed by confirm,
  // and nothing else may write a second receipt over the first.
  if (state.status === "complete-pending-human") throw new Error("implement run is already closed (complete-pending-human); the remaining human: rows close through `sasu implement confirm`, not a second finalize");
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
  blockers.push(...state.rows
    .filter((entry) => entry.status === "parked")
    .map((entry) => `${entry.id} is parked and was skipped by verification; resume and prove it before finalize`));
  // check: and judge: rows must be proved; human: rows may stay OPEN, and
  // decide only which closing status the run gets (R8).
  blockers.push(...checkRowBlockers(state, source.digest));
  blockers.push(...state.rows.filter((entry) => entry.check.kind === "judge" && entry.status !== "PASS").map((entry) => `${entry.id} is ${entry.status}`));
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
    // The third terminal reason (R16 ③). Budget exhaustion asks "can another
    // round run?"; this asks "could another round change anything?" - and
    // when a human has declared every remaining finding structurally
    // unfixable, spending the rounds only delays an honest record. It is
    // deliberately all-or-nothing: one undeclared finding means a round could
    // still matter, so the run is not terminal.
    const openBlocking = openRiskFindings(state).filter((entry) => entry.severity === "blocking");
    const nonConvergent = openBlocking.length > 0
      && openBlocking.every((entry) => entry.nonConvergence !== undefined)
      && openDesignComments(state).length === 0;
    if (!view.budgetExhausted && !view.judgeErrorLoop && !nonConvergent) {
      const undeclared = openBlocking.filter((entry) => entry.nonConvergence === undefined).map((entry) => entry.id);
      throw new Error(
        "finalize --status blocked refused: verification can still run - fix the recorded findings and re-run `sasu implement verify`"
          + (undeclared.length === 0
            ? ""
            : `, or declare each structurally unfixable finding with \`sasu implement risk --non-convergent --issuer human --id <RF#> --approval "<verbatim user approval>" --reason "<why no round can fix it>"\` (undeclared: ${undeclared.join(", ")})`),
      );
    }
    const terminalReason = view.budgetExhausted
      ? "budget-exhausted"
      : view.judgeErrorLoop ? "judge-error-loop" : "non-convergent-findings";
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
      schema: RECEIPT_SCHEMA,
      status: "blocked",
      terminalReason,
      topicSlug: state.topicSlug,
      prdPath: state.prdPath,
      prdSnapshotPath: state.prd.snapshotPath,
      ...(state.prd.judge !== undefined ? { prdJudge: state.prd.judge } : {}),
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
      behaviors: receiptRows(state),
      parkedRows: latest.parkedRows,
      score: runScore(state),
      scoreLine: scoreLine(runScore(state)),
      openItems: blockers,
      // Who declared each finding terminal, in their own words, next to the
      // structural fact that corroborates it. A blocked close that cannot say
      // WHY it was terminal is the record the old guard produced.
      nonConvergentFindings: openRiskFindings(state)
        .filter((entry) => entry.nonConvergence !== undefined)
        .map((entry) => ({ id: entry.id, severity: entry.severity, text: entry.text, ...entry.nonConvergence })),
      ...((state.adoptions ?? []).length > 0 ? { adoptions: state.adoptions } : {}),
      ...(state.worktree ? { worktree: state.worktree } : {}),
      executionCallsDuringFinalize: 0,
    };
    state.status = "blocked";
    state.completion = { fingerprint, completedAt: blockedAt, receiptPath, implementationResultPath };
    persistClose(statePath, state, [
      { file: path.join(recordRoot, receiptPath), text: jsonText(receipt) },
      { file: path.join(recordRoot, implementationResultPath), text: implementationReport(state, latest, fingerprint, { terminalReason, openItems: blockers }) },
    ]);
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
  const closing = closingStatus(state);
  const receipt = {
    schema: RECEIPT_SCHEMA,
    status: closing,
    topicSlug: state.topicSlug,
    prdPath: state.prdPath,
    prdSnapshotPath: state.prd.snapshotPath,
    ...(state.prd.judge !== undefined ? { prdJudge: state.prd.judge } : {}),
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
    behaviors: receiptRows(state),
    parkedRows: latest.parkedRows,
    score: runScore(state),
    scoreLine: scoreLine(runScore(state)),
    ...((state.adoptions ?? []).length > 0 ? { adoptions: state.adoptions } : {}),
    ...(state.worktree ? { worktree: state.worktree } : {}),
    executionCallsDuringFinalize: 0,
  };
  state.status = closing;
  state.completion = { fingerprint, completedAt, receiptPath, implementationResultPath };
  recordEvent(state, { kind: "finalize", actor: resolveIssuer(flag(args, "issuer")), subject: null, summary: `run closed ${closing}`, at: completedAt });
  persistClose(statePath, state, [
    { file: path.join(recordRoot, receiptPath), text: jsonText(receipt) },
    { file: path.join(recordRoot, implementationResultPath), text: implementationReport(state, latest, fingerprint) },
  ]);
  // A worktree run's code lives only on its branch until someone collects it;
  // the close must say so or the work silently strands in the worktree.
  const handoff = state.worktree
    ? `; the implementation lives on branch ${state.worktree.branch} at ${state.worktree.path} - merge it (\`git merge ${state.worktree.branch}\`) or deliver with $ship, and keep the worktree until then`
    : "";
  const pending = state.rows.filter((row) => row.status === "OPEN").map((row) => row.id);
  const humanNote = pending.length === 0 ? "" : `; ${pending.length} human: row(s) OPEN (${pending.join(", ")}) - the user closes each with \`sasu implement confirm --issuer human --row B<n> --evidence "<user words>"\``;
  return result("finalize", true, `implementation finalized ${closing} from fresh unified PASS${humanNote}${handoff}`, { completion: state.completion, receipt, executionCalls: 0 });
}

/**
 * Close a `human:` row with the user's own words (R8). Human-only by
 * authority; the harness records the words and never decides. A rejection
 * keeps the row OPEN with the words beside it; the last confirmation moves
 * the run from complete-pending-human to complete. Both rewrite the receipt
 * so the record and its derived outputs never disagree, and the completion
 * fingerprint stays what finalize earned: confirm changes no judged input.
 */
function confirm(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  const { statePath, state } = loadState(projectRoot, stateOptions(args));
  if (state.status !== "complete-pending-human") {
    throw new Error(state.status === "complete"
      ? "implement run is already complete; every human: row is confirmed"
      : `confirm is valid only on a run closed complete-pending-human; ${state.topicSlug} is ${state.status}`);
  }
  assertRunOwnership(statePath, state, args);
  const issuer = resolveIssuer(flag(args, "issuer"));
  const row = rowNamed(state, args);
  const evidence = flag(args, "evidence")?.trim() ?? "";
  const reject = args.flags.get("reject") === true;
  const at = nowIso();
  const entry = { verb: "confirm" as const, issuer, target: row.id, reason: evidence, at };
  const refuse = (message: string): never => rejectVerb(state, entry, "transition", message, () => persistState(statePath, state));
  if (row.check.kind !== "human") refuse(`${row.id} is a ${row.check.kind}: row; confirm closes human: rows only`);
  if (evidence === "") refuse(`confirm requires --evidence "<the user's own words>"; the record carries the words, not a checkbox`);
  if (row.status === "PASS") refuse(`${row.id} is already confirmed at ${row.human!.confirmedAt}; a closed row never reopens`);
  if (reject) {
    row.rejections.push({ at, evidence });
  } else {
    row.human = { confirmedAt: at, evidence };
    row.status = "PASS";
  }
  recordVerb(state, { ...entry, outcome: "accepted" });
  recordEvent(state, { kind: "confirm", actor: issuer, subject: row.id, summary: reject ? `${row.id} confirmation rejected: ${evidence}` : `${row.id} confirmed: ${evidence}`, at });
  if (!reject) recordEvent(state, { kind: "row-status", actor: issuer, subject: row.id, summary: `${row.id} is PASS`, at });
  const closing = closingStatus(state);
  if (closing !== state.status) {
    state.status = closing;
    recordEvent(state, { kind: "finalize", actor: issuer, subject: null, summary: `run closed ${closing}`, at });
  }
  const completion = state.completion;
  if (completion === null) throw new Error("closed run has no completion record");
  // The receipt is rewritten in place: same fingerprint, same attempt, the
  // rows and status refreshed from the record (R8, R9); `persistClose` lands
  // the state before the receipt.
  const receiptFile = path.join(state.projectRoot, completion.receiptPath);
  const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8")) as Record<string, unknown>;
  receipt["status"] = closing;
  receipt["behaviors"] = receiptRows(state);
  receipt["score"] = runScore(state);
  receipt["scoreLine"] = scoreLine(runScore(state));
  receipt["confirmedAt"] = at;
  const latest = state.verificationAttempts.at(-1)!;
  persistClose(statePath, state, [
    { file: receiptFile, text: jsonText(receipt) },
    { file: path.join(state.projectRoot, completion.implementationResultPath), text: implementationReport(state, latest, completion.fingerprint) },
  ]);
  const open = state.rows.filter((candidate) => candidate.status === "OPEN").map((candidate) => candidate.id);
  return result("confirm", true, reject
    ? `${row.id} stays OPEN (rejected: ${evidence}); ${open.length} human: row(s) still OPEN`
    : `${row.id} confirmed; run is ${closing}${open.length === 0 ? "" : `, ${open.length} human: row(s) still OPEN (${open.join(", ")})`}`, {
    rowId: row.id,
    status: row.status,
    runStatus: state.status,
    openRows: open,
    receiptPath: completion.receiptPath,
  });
}

export async function runImplementCommand(projectRoot: string, args: ImplementArgs): Promise<ImplementCommandResult> {
  const subcommand = args.positional[1];
  try {
    // Authority is checked once, here, for every state-changing command
    // rather than inside each one. Per-command checks are a rule that has to
    // be remembered at each new command; one gate is a rule the code keeps
    // (AGENTS.md Review Guide 7). Read-only surfaces - intake, status - are
    // absent from the table on purpose: anyone may look.
    // `design --raise` and `design --accept` are opposite ends of one comment
    // with opposite authorities (R10), so the subject the gate asks about is
    // the operation, not the subcommand word. Resolving that here keeps the
    // single gate; asserting it inside `design` instead would have put the
    // rule back in the place the gate exists to empty.
    if (subcommand !== undefined) {
      const subject = subcommand === "design" && args.flags.get("raise") === true
        ? "design-raise"
        : subcommand === "risk" && args.flags.get("non-convergent") === true
          ? "risk-non-convergent"
          : subcommand;
      const issuer = resolveIssuer(flag(args, "issuer"));
      try {
        assertCommandAuthority(subject, issuer);
      } catch (error) {
        if (error instanceof VerbRejected && isIssuedCommand(subject)) {
          recordAuthorityRefusal(projectRoot, args, subject, issuer, error.message);
        }
        throw error;
      }
    }
    if (subcommand === "intake") return intake(projectRoot);
    if (subcommand === "start") return start(projectRoot, args);
    if (subcommand === "check") return await check(projectRoot, args);
    if (subcommand === "park") return park(projectRoot, args);
    if (subcommand === "resume") return resume(projectRoot, args);
    if (subcommand === "confirm") return confirm(projectRoot, args);
    if (subcommand === "amend") return amend(projectRoot, args);
    if (subcommand === "qa-brief") return qaBrief(projectRoot, args);
    if (subcommand === "trail") return trail(projectRoot, args);
    if (subcommand === "dispatch") return dispatch(projectRoot, args);
    if (subcommand === "escalate") return await escalate(projectRoot, args);
    if (subcommand === "await") return await awaitEvent(projectRoot, args);
    if (subcommand === "artifact") return artifact(projectRoot, args);
    if (subcommand === "status") return status(projectRoot, args);
    if (subcommand === "verify") return await verify(projectRoot, args);
    if (subcommand === "design") return design(projectRoot, args);
    if (subcommand === "risk") return risk(projectRoot, args);
    if (subcommand === "retire") return retire(projectRoot, args);
    if (subcommand === "finalize") return finalize(projectRoot, args);
    return { ok: false, action: subcommand ?? "unknown", exitCode: 2, message: "unknown implement subcommand; use intake, start, check, park, resume, confirm, amend, qa-brief, trail, dispatch, escalate, await, artifact, status, design, risk, verify, retire, or finalize" };
  } catch (error) {
    return {
      ok: false,
      action: subcommand ?? "unknown",
      exitCode: error instanceof SyntaxError || error instanceof VerifyInvariantError ? 1 : 2,
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof VerbRejected ? { detail: { rejectedCheck: error.check } } : {}),
      ...(error instanceof AmendmentRejected ? { detail: { rejectedCheck: error.check } } : {}),
      ...(error instanceof TrailRejected ? { detail: { rejectedCheck: error.check } } : {}),
      ...(error instanceof EscalateRejected ? { detail: { rejectedCheck: error.check } } : {}),
      ...(error instanceof PrdDriftError ? { detail: { prdDrift: error.diagnostic } } : {}),
      ...(error instanceof VerifyInvariantError ? { detail: { reason: error.reason } } : {}),
    };
  }
}
