import type { JudgeCallRecord, JudgeFailureCause } from "../judge/types";

// Implementation state records reproducible execution facts and run authority.
export const IMPLEMENT_SCHEMA = "sasu.implement.state.v11.stateless-verification" as const;
export const IMPLEMENT_ACTIVE_SCHEMA = "sasu.implement.active.v3" as const;
export const RETIRED_IMPLEMENT_SUPPORT_COMMIT = "9149d9826fad2af3ba7200761e674b5228ef9b7d";
export const RETIRED_PARALLEL_REVIEW_SUPPORT_COMMIT = "2b1f638dd587261be7e7b0e600db16657421971d";
export function retiredImplementSupportCommit(schema: unknown): string {
  return schema === "sasu.implement.state.v9.parallel-review" || schema === "sasu.implement.receipt.v5.parallel-review"
    ? RETIRED_PARALLEL_REVIEW_SUPPORT_COMMIT : RETIRED_IMPLEMENT_SUPPORT_COMMIT;
}
export type VerificationStatus = "NOT_RUN" | "PASS" | "FAIL" | "BLOCKED" | "ERROR" | "STALE";
export type ReviewProfile = "trivial" | "standard" | "high-risk";
export interface JudgeLaneError { code: string; message: string; cause?: JudgeFailureCause }
export interface BehaviorRequirement { id: string; behavior: string; decisionIds: string[] }
export interface ExecutionTreeFingerprint { product: string }
export interface SourceEntry {
  path: string;
  state: string;
  sha256: string | null;
}

export interface SourceSnapshot {
  head: string | null;
  digest: string;
  entries: SourceEntry[];
}

export type DirtyAttribution = "pre-existing" | "run-owned";

export interface BaselineAttribution {
  disposition: "clean" | DirtyAttribution | "mixed";
  paths: Array<{ path: string; disposition: DirtyAttribution }>;
  baselineDigest: string;
  head: string | null;
}

export interface RegisteredArtifact {
  kind: string;
  path: string;
  description: string;
  sha256: string;
  bytes: number;
  registeredAt: string;
  provenance: string;
  observedAt: string;
  /**
   * Product source digest at registration, so a review can tell an artifact
   * observed on an earlier source from one observed on the source under
   * review. Absent only on records made before it was recorded.
   */
  sourceDigest?: string;
  target?: string;
  environment?: string;
  requirementRefs?: string[];
  command?: string;
  cwd?: string;
  exitCode?: number;
}
export interface MechanicalRunRecord {
  command: string;
  cwd: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** The real exit code, even when the record is FAIL for a moved tree. */
  exitCode: number;
  mutatedTree: boolean;
  status: "PASS" | "FAIL";
  logPath: string;
}

export interface LaneRecord<T> {
  invocationId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  verdict: VerificationStatus;
  result: T | null;
  judge: JudgeCallRecord | null;
  error: JudgeLaneError | null;
}

export interface UnifiedVerificationAttempt {
  id: string;
  prdSha256: string;
  inputFingerprint: string;
  sourceFingerprint: string;
  intentInput: { routing: "decisions" | "full-qa-log"; contentSha256: string };
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  phase: "preflight" | "mechanical" | "evidence" | "complete";
  verdict: VerificationStatus;
  prelint: { ok: boolean; findings: unknown[] };
  mechanical: MechanicalRunRecord[];
  error: { stage: string; code: string; message: string } | null;
}

export interface VerificationReportIdentity {
  schema: "sasu.verification-report.v1";
  inputFingerprint: string;
  prdSha256: string;
  baseSha: string | null;
  headSha: string | null;
  sourceFingerprint: string;
  generatedAt: string;
  status: "PASS" | "FAIL" | "ERROR";
  jsonPath: string;
  markdownPath: string;
  /** Hash of the complete verification-report.json bytes. */
  reportSha256: string;
}
export type IssuerLabel = "implementor" | "observer" | "human";
export type ImplementEventKind = "amendment" | "escalate" | "artifact" | "verify" | "dispatch" | "handover";
export interface ImplementEvent {
  id: number; at: string; kind: ImplementEventKind; actor: IssuerLabel;
  subject: string | null; summary: string;
}
export type IssuedCommand = "artifact" | "verify" | "escalate" | "amend" | "retire";
export type VerbRejectionCheck = "arguments" | "authority" | "transition";
export interface VerbRecord {
  id: number;
  at: string;
  verb: IssuedCommand;
  issuer: IssuerLabel;
  /** Row the verb was aimed at; null for run-wide verbs. */
  target: string | null;
  reason: string;
  outcome: "accepted" | "rejected";
  /** Non-null exactly when outcome is "rejected". */
  rejection: { check: VerbRejectionCheck; message: string } | null;
}

export interface EvidenceReplacement {
  id: number; at: string; kind: "artifact";
  previous: string; next: string; priorDisposition: "invalidated";
}
export interface AmendmentRecord {
  id: number;
  at: string;
  issuer: "human";
  approval: string;
  reason: string;
  prdSha256: string;
  snapshotPath: string;
  previousSnapshotPath: string;
  changedRequirements: string[];
  addedRequirements: string[];
  removedRequirements: string[];
  closedHumanFindings: string[];
  suiteSnapshotUpdated: boolean;
  excludedSuiteCommands?: Array<{ commandId: string; command: string; priorResult: "GREEN" | "RED" | "none" }>;
}
export interface SuiteCommand {
  /** Stable `S<n>` within the sealed list. */
  id: string;
  command: string;
  argv: string[];
  cwd: string;
}

export interface SuiteExclusion {
  at: string;
  commandId: string;
  /** Verbatim human approval; an exclusion without one is refused (AC6). */
  approval: string;
  reason: string;
}

export interface SuiteResult {
  commandId: string;
  /** Verification attempt this result was produced in. */
  attemptId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number;
  mutatedTree: boolean;
  status: "GREEN" | "RED";
  logPath: string;
}

/**
 * The suite list is sealed at `start` so a mid-run edit of agents/config.json
 * cannot change what this run is measured against (AC5). The sealed list is
 * the authority; `agents/config.json` is only its source at seal time.
 */
export interface SuiteLedger {
  sealedAt: string;
  commands: SuiteCommand[];
  exclusions: SuiteExclusion[];
  /** Latest result per command, replaced whole on each verify attempt. */
  results: SuiteResult[];
}

export interface SolverHandoff { prdSnapshotPath: string; diagnosisPath: string; verificationPath: string }
export interface EscalationRecord {
  id: number;
  at: string;
  /** Finding the implementor was stuck on, or the whole run. */
  target: string | null;
  reason: string;
  /** Judge routing profile reused for the solver (R12); no new knob. */
  profile: ReviewProfile;
  model: string | null;
  /** Actual solver backend executions, including retries and fallback. */
  judge: JudgeCallRecord | null;
  /** Measured solver invocation duration; a refused backend may make zero calls. */
  durationMs: number;
  outcome: "diagnosed" | "summon-failed";
  /** Diagnosis text on success; null when the summon failed. */
  diagnosis: string | null;
  /** Failure detail on summon-failed; null on success. */
  error: string | null;
  /** Non-null only on success, when a replacement was actually briefed. */
  handoff: SolverHandoff | null;
}

/**
 * One implementor started for this run by `dispatch` or by an escalation's
 * reset. The pane is recorded so a replacement can be placed in the same
 * workspace and a second dispatch can ask herdr whether the last one is
 * still alive before it opens another pane.
 */
export interface DispatchRecord {
  id: number;
  at: string;
  agent: string;
  kind: string;
  paneId: string;
  workspaceId: string;
  tabId: string;
  /** The tree the implementor's shell starts in: the run's worktree, else the record tree. */
  cwd: string;
  /** Who handed the run over; null when the run was unowned at dispatch. */
  fromSessionId: string | null;
}

/**
 * The identity a wake is addressed to. A wake is sent only when `agent get`
 * on the recorded pane still answers with this session UUID and terminal
 * (D-06); the same name, pane, cwd or PID in a new session is a stranger.
 * Measured 2026-09-18: a herdr server restart keeps pane ids and session
 * UUIDs but rotates terminal ids, so after a restart every run reads as
 * `observer-gone` until an explicit handover re-records the identity. That
 * is the contract's chosen failure direction: silence over a misrouted wake.
 */
export interface ObserverIdentity {
  /** Agent kind herdr reports for the pane (claude, codex). */
  runtime: string;
  /** The runtime's own session UUID (`agent_session.value`). */
  sessionId: string;
  terminalId: string;
  paneId: string;
  /** The herdr socket the identity was read from; two servers never share ids. */
  hostScope: string;
  recordedAt: string;
}

/**
 * Explicit re-recording of the Observer after the original session is gone
 * (B18). Verbatim user words, like every other takeover the harness accepts.
 */
export interface ObserverHandover {
  at: string;
  from: ObserverIdentity;
  to: ObserverIdentity;
  approval: string;
}

/**
 * What the supervisor tick and `status --digest` read about a dispatched
 * run (D-04). Written by `dispatch`, refreshed by an escalation's replacement
 * and by a handover; never written by the tick, which only reads (D-02).
 */
export interface SupervisionRecord {
  /** Random per dispatch; the child pane carries it as SASU_RUN_INSTANCE_ID. */
  runInstanceId: string;
  observer: ObserverIdentity;
  /** Exact identity captured after start and before the handoff is submitted. */
  implementor: { paneId: string; agent: string; sessionId: string; terminalId: string; hostScope: string; recordedAt: string };
  /** Realpath of the repository's common git dir, so two worktrees of one repository and two repositories with one slug never collide. */
  canonicalRepository: string;
  prdPath: string;
  /** HEAD of the judged tree when the implementor was dispatched; the digest measures from here. */
  dispatchHead: string | null;
  dispatchedAt: string;
  patrolIntervalMs: number;
  /** Who replaces a dead Observer: only one loop may input into a session (D-15). */
  recoveryOwner: "supervisor" | "task-factory";
  handovers: ObserverHandover[];
}

export interface PendingDispatch {
  runInstanceId: string;
  observer: ObserverIdentity;
  plannedAgent: string;
  phase: "planned" | "prepared" | "started";
  /** Exact pane created before an agent is started, so crash recovery owns it. */
  prepared: {
    paneId: string;
    workspaceId: string;
    tabId: string;
    cwd: string;
    kind: string;
    placement: "workspace" | "tab";
    hostScope: string;
    parentPaneId: string;
    preparedAt: string;
  } | null;
  implementor: SupervisionRecord["implementor"] | null;
  canonicalRepository: string;
  prdPath: string;
  dispatchHead: string | null;
  dispatchedAt: string;
  patrolIntervalMs: number;
  recoveryOwner: "supervisor" | "task-factory";
  /** Human-approved recovery-authority transfers before supervision exists. */
  handovers?: ObserverHandover[];
}

export type PrdJudgeRecord =
  | { required: true; skippedReason: null; gapAudit: string; spec: string }
  | { required: false; skippedReason: string; gapAudit: null; spec: null };

export interface ActiveVerification {
  token: string;
  attemptId: string;
  pid: number;
  hostname: string;
  startedAt: string;
  inputFingerprint: string;
  prdSha256: string;
  executionPids: number[];
  /** Persisted before a spawn; an unregistered orphan cannot be assumed dead. */
  pendingSpawns: number;
}
export interface ImplementState {
  schema: typeof IMPLEMENT_SCHEMA;
  status: "active" | "retired";
  topicSlug: string;
  projectRoot: string;
  worktree?: { path: string; branch: string } | null;
  runDir: string;
  prdPath: string;
  prd: {
    sha256: string;
    snapshotPath: string;
    status: string | null;
    approval: { source: "frontmatter" | "conversation"; evidence: string };
    reviewProfile: ReviewProfile;
    reviewRationale: string;
    sourceIntake: string;
      judge?: PrdJudgeRecord;
  };
  initialSource: SourceSnapshot;
  baselineAttribution: BaselineAttribution;
  ownerSessionId?: string | null;
  adoptions?: { at: string; fromSessionId: string; evidence: string }[];
  /** Absent on records written before dispatch recorded itself; read as none. */
  dispatches?: DispatchRecord[];
  /** Absent until a Herdr dispatch enrolls the run for supervision; read as none. */
  supervision?: SupervisionRecord | null;
  /** Durable dispatch intent, cleared only after the handoff submission succeeds. */
  pendingDispatch?: PendingDispatch | null;
  requirements: BehaviorRequirement[];
  activeVerification?: ActiveVerification;
  artifacts: RegisteredArtifact[];
  verificationAttempts: UnifiedVerificationAttempt[];
  deviations: { at: string; type: string; summary: string }[];
  events: ImplementEvent[];
  evidenceReplacements: EvidenceReplacement[];
  verbs: VerbRecord[];
  amendments: AmendmentRecord[];
  suite: SuiteLedger;
  escalations: EscalationRecord[];
  retirement: {
    retiredAt: string;
    retiredBySessionId: string | null;
    adoptedFromSessionId?: string;
    adoptionEvidence?: string;
  } | null;
  verificationReport: VerificationReportIdentity | null;
  createdAt: string;
  updatedAt: string;
}

export interface ImplementActivePointer {
  schema: typeof IMPLEMENT_ACTIVE_SCHEMA;
  statePath: string;
  topicSlug: string;
  /**
   * Absolute record-tree root, present only on pointers written OUTSIDE the
   * record tree (the copy inside a run's worktree): `statePath` then resolves
   * against it, so bare commands typed from inside the worktree reach the
   * same record every other surface reads. Pointers inside the record tree
   * omit it and keep resolving relative to their own tree.
   */
  projectRoot?: string;
  updatedAt: string;
}

// No `state` field by design: every command once echoed the whole
// ImplementState back to stdout, and the echo grew with verificationAttempts
// until one `implement artifact --json` registration (12 useful lines) cost
// ~420k chars / ~117k tokens on a real run (exploration-collection-depth,
// 2026-08-15). `state.json` is the only machine record (PRINCIPLES 10);
// callers that need history read it from disk.
export interface ImplementCommandResult {
  ok: boolean;
  action: string;
  exitCode: number;
  message: string;
  detail?: Record<string, unknown>;
  /**
   * The human-readable answer, one line per fact, printed INSTEAD of the
   * detail dump when the caller did not ask for `--json` (R16 ③, AC47).
   *
   * 2026-08-29, interview-anchor: `status` answered "which criterion is
   * parked and why" with 491 lines of JSON, so the reason was present and
   * unreadable. A record that has the answer and buries it has not answered.
   */
  summary?: string[];
}

/**
 * A run has stalled when BOTH its event log and the implementor's Herdr
 * activity have been silent this long (D-08). Herdr working counts as
 * activity, so an implementor that only codes and commits never trips it.
 *
 * NOT a measured value - an agent's initial default (D-18). The incident it
 * is sized against is the 2026-08-28 herdr-ide session, where an implementor
 * burned 4.3 hours over 8 rounds without emitting a single state event and
 * nothing woke up. Ten minutes is short enough to catch that and long enough
 * that a normal build-and-test cycle does not trip it. Retune by editing this
 * constant after observing a false wake or a missed stall on a real run; it is
 * deliberately not a config knob (AGENTS.md Review Guide 7).
 */
export const STALL_THRESHOLD_MS = 10 * 60 * 1000;

/**
 * Escalations allowed per run before further attempts are refused.
 *
 * Also an unmeasured initial default (D-46). The bound exists because a fresh
 * adversarial diagnosis is a stage that cannot converge on its own
 * (PRINCIPLES 13): without a cap, "reset the implementor and try again" is an
 * unbounded loop. Three is the point past which the honest move is to stop and
 * ask a human rather than reset a fourth time.
 */
export const ESCALATE_LIMIT_PER_RUN = 3;
