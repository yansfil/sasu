import type { JudgeCallRecord, JudgeFailureCause, ReviewFinding, ReviewResult } from "../judge/types";

// Experimental records cannot be adopted by the installed unified reviewer.
// Each role keeps its real execution; no existing run is migrated for comparison.
export const IMPLEMENT_SCHEMA = "sasu.implement.state.v9.parallel-review" as const;
export const IMPLEMENT_ACTIVE_SCHEMA = "sasu.implement.active.v3" as const;
export const RETIRED_IMPLEMENT_SUPPORT_COMMIT = "3f549dcfff71fe1f7fa974a383f6e8a055ce8463";
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

export type FindingOrigin = "prior-unresolved" | "new";
export type DeltaBasis =
  | { kind: "changed-path" | "new-evidence"; value: string }
  | { kind: "contract-counterevidence"; value: string; requirementRefs: string[]; evidenceRefs: string[] };
export interface HumanResponse { at: string; response: "confirmed" | "rejected"; evidence: string }
export interface FindingDispositionRecord {
  at: string;
  attemptId: string | null;
  status: "open" | "resolved" | "confirmed" | "amended";
  reason: string;
  evidenceRefs: string[];
  amendmentId?: number;
}
export interface TrackedReviewFinding extends ReviewFinding {
  id: string;
  originAttemptId: string;
  status: "open" | "resolved" | "confirmed" | "amended";
  history: FindingDispositionRecord[];
  responses: HumanResponse[];
}
export interface RiskFinding {
  id: string;
  severity: "blocking" | "advisory";
  text: string;
  origin?: FindingOrigin;
  priorFindingId?: string;
  deltaBasis?: DeltaBasis;
}

export interface RiskDisposition {
  id: string;
  status: "resolved" | "unresolved";
  reason: string;
  /** Required when resolving a prior blocking risk. */
  deltaBasis?: DeltaBasis;
}

export interface RiskLaneResult {
  verdict: "PASS" | "FAIL";
  findings: RiskFinding[];
  priorDispositions?: RiskDisposition[];
}

/** One risk finding tracked across attempts in the state-owned ledger. */
export interface TrackedRiskFinding {
  /** Stable `RF<n>`, assigned once and never reused. */
  id: string;
  severity: "blocking" | "advisory";
  text: string;
  /** Attempt where this finding first entered the ledger. */
  originAttemptId: string;
  status: "open" | "fixed" | "accepted";
  /** Judge delta proof for fixed, or verbatim user approval for accepted. */
  resolution?: { at: string; evidence: string };
  /**
   * Declared unfixable, so no further judge round can change it (R16 ③).
   *
   * The finding STAYS open - that is the point. It does not release
   * `finalize --status complete`; it releases the honest `--status blocked`
   * close without first burning rounds whose outcome is already known.
   *
   * The declaration is a human's, quoted verbatim, because whether a defect
   * is structural is a judgment and the harness has no instrument for it
   * (D-39). `roundsUnchanged` is the one structural fact the harness DOES
   * own - how many judged attempts the finding survived - and it rides along
   * as corroboration in the receipt, never as the gate.
   */
  nonConvergence?: { at: string; approval: string; reason: string; declaredBy: IssuerLabel; roundsUnchanged: number };
}

export interface VerificationInputManifest {
  source: SourceEntry[];
  evidence: Array<{ path: string; sha256: string }>;
}
export interface VerificationRoundContext {
  priorAttemptId: string | null;
  changedPaths: string[];
  newEvidence: Array<{ path: string; sha256: string }>;
  /** Exact references available for a newly discovered risk, even on unchanged source. */
  requirementRefs?: string[];
  evidenceRefs?: string[];
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
  // Names the ERROR'd attempt this settled lane was carried over from.
}

export type RoutineReviewRole = "fidelity" | "code";
export const ROUTINE_REVIEW_ROLES: readonly RoutineReviewRole[] = ["fidelity", "code"];
export type RoutineReviews = Record<RoutineReviewRole, LaneRecord<ReviewResult> | null>;

export interface UnifiedVerificationAttempt {
  id: string;
  inputFingerprint: string;
  sourceFingerprint: string;
  inputManifest: VerificationInputManifest;
  roundContext: VerificationRoundContext;
  intentInput: { routing: "decisions" | "full-qa-log"; contentSha256: string };
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  phase: "preflight" | "mechanical" | "evidence" | "review" | "complete";
  verdict: VerificationStatus;
  prelint: { ok: boolean; findings: unknown[] };
  mechanical: MechanicalRunRecord[];
  reviews: RoutineReviews;
  risk: LaneRecord<RiskLaneResult> | null;
  error: { stage: string; code: string; message: string } | null;
}
export type IssuerLabel = "implementor" | "observer" | "human";
export type ClaimOrigin = "human" | "observer" | "solver";
export type ImplementEventKind = "amendment" | "escalate" | "artifact" | "risk" | "verify" | "finalize" | "confirm";
export interface ImplementEvent {
  id: number; at: string; kind: ImplementEventKind; actor: IssuerLabel;
  subject: string | null; summary: string;
}
export type IssuedCommand = "artifact" | "verify" | "finalize" | "risk" | "confirm" | "escalate" | "risk-non-convergent" | "amend" | "retire";
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

export interface SolverHandoff { prdSnapshotPath: string; diagnosisPath: string; findingsPath: string }
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
  status: "active" | "complete-pending-human" | "complete" | "blocked" | "retired";
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
  requirements: BehaviorRequirement[];
  activeVerification?: ActiveVerification;
  findings: TrackedReviewFinding[];
  artifacts: RegisteredArtifact[];
  verificationAttempts: UnifiedVerificationAttempt[];
  budgetGrants?: { at: string; evidence: string; attemptCountBefore: number }[];
  deviations: { at: string; type: string; summary: string }[];
  riskFindings: TrackedRiskFinding[];
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
  completion: {
    fingerprint: string;
    completedAt: string;
    receiptPath: string;
    implementationResultPath: string;
  } | null;
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
 * Wake the observer when the implementor has produced no event for this long.
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
