import type { JudgeCallRecord, JudgeFailureCause } from "../judge/types";

// v7: adds the supervision ledgers - event log, observer verb history,
// amendment history, sealed suite list with its results, QA trails, and solver
// escalations. Older shapes are not migrated because completion authority must
// never guess missing bindings, attempts, human approvals, or - now - which
// suite commands a run was sealed against. A v6 run has no sealed suite list,
// so a v7 CLI cannot tell "no orphan suite failures" from "never sealed", and
// the honest answer is to refuse rather than assume (PRINCIPLES 10).
export const IMPLEMENT_SCHEMA = "sasu.implement.state.v7" as const;
export const IMPLEMENT_ACTIVE_SCHEMA = "sasu.implement.active.v3" as const;

export type ItemStatus = "pending" | "complete" | "blocked";
export type VerificationStatus = "NOT_RUN" | "PASS" | "FAIL" | "BLOCKED" | "ERROR" | "STALE";
export type ReviewProfile = "trivial" | "standard" | "high-risk";

export interface JudgeLaneError {
  code: string;
  message: string;
  /** Structured identity used by the backend survival circuit breaker. */
  cause?: JudgeFailureCause;
}

export interface EvidenceNote {
  at: string;
  text: string;
}

export interface ContractItem {
  id: string;
  text: string;
  title: string;
  requirements: string[];
  acceptanceCriteria: string[];
  status: ItemStatus;
  evidence: EvidenceNote[];
}

export type AcceptanceJudgment = "machine" | "judged" | "machine+gate:human";
export type AcceptanceCheckStatus = "pending" | "green" | "parked";

export interface CheckBinding {
  id: string;
  command: string;
  argv: string[];
  cwd: string;
  classification: "asset" | "labor";
  boundAt: string;
  reason: string | null;
}

export interface CheckTreeFingerprint {
  all: string;
  product: string;
  bookkeeping: string;
}

export interface CheckAttempt {
  id: string;
  bindingId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number;
  timedOut: boolean;
  signal: NodeJS.Signals | null;
  outcome: "green" | "failed";
  outputFingerprint: string;
  failureClass: string | null;
  tree: CheckTreeFingerprint;
  humanWindow: { evidence: string; recordedAt: string; criterionId: string } | null;
}

export interface CheckDecisionPoint {
  id: string;
  kind: "same-class" | "five-failures" | "tools-only";
  openedAt: string;
  attemptId: string;
  message: string;
  resolvedAt: string | null;
  // "amended" closes a decision point the amendment made moot: the criterion
  // it was posted against is no longer the same question (R5).
  resolution: "green" | "parked" | "rebound" | "amended" | null;
}

export interface CheckParkRecord {
  parkedAt: string;
  /**
   * "human" parks carry a verbatim approval; "observer" parks carry a posted
   * decision point instead. The supervisor may set aside a criterion the
   * harness has already flagged as stuck, but it may not invent the judgment
   * that it is stuck (AC20).
   */
  parkedBy: "human" | "observer";
  /** Verbatim human approval; empty for an observer park. */
  approval: string;
  reason: string;
  evidence: string | null;
  resumedAt: string | null;
}

export interface AcceptanceCheckLedger {
  status: AcceptanceCheckStatus;
  bindings: CheckBinding[];
  attempts: CheckAttempt[];
  consecutiveFailures: number;
  decisionPoints: CheckDecisionPoint[];
  parks: CheckParkRecord[];
}

export interface AcceptanceCriterionItem extends ContractItem {
  judgment: AcceptanceJudgment | null;
  evidenceDeclaration: string | null;
  check: AcceptanceCheckLedger;
}

export interface TaskItem extends ContractItem {
  // Task ids this task's close is gated on. Absent clause in the PRD means
  // "the previous task"; `Depends on: none` or an explicit list overrides it.
  dependsOn: string[];
}

export interface VerificationItem {
  id: string;
  text: string;
  title: string;
  mode: string;
  covers: string[];
  requiredForDone: boolean;
  canBeBlocked: boolean;
  passIntent: string;
  status: VerificationStatus;
  evidence: EvidenceNote[];
}

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
  verificationId?: string;
  acceptanceCriterionId?: string;
  kind: string;
  path: string;
  description: string;
  sha256: string;
  bytes: number;
  // Legacy v5 records may carry this removed per-artifact freshness pin.
  // It is accepted for additive-tolerant reads but ignored; new records omit it.
  sourceFingerprint?: string;
  registeredAt: string;
  command?: string;
  cwd?: string;
  exitCode?: number;
}

export interface MechanicalBinding {
  command: string;
  cwd: string;
  verificationIds: string[];
}

export interface MechanicalRunRecord extends MechanicalBinding {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number;
  status: "PASS" | "FAIL";
  logPath: string;
}

export interface AcLaneResult {
  id: string;
  verdict: "PASS" | "FAIL";
  reason: string;
  evidence: string;
  priorDisposition?: PriorDisposition;
  origin?: FindingOrigin;
  deltaBasis?: DeltaBasis;
}

export type FindingOrigin = "prior-unresolved" | "new";

export interface PriorDisposition {
  status: "resolved" | "unresolved";
  reason: string;
}

export interface DeltaBasis {
  kind: "changed-path" | "new-evidence";
  value: string;
}

export interface AcceptanceCriterionInvocation {
  criterionId: string;
  invocationId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  verdict: VerificationStatus;
  judge: JudgeCallRecord | null;
  error: JudgeLaneError | null;
  // Names the ERROR'd attempt this settled verdict was carried over from.
  // Timestamps and judge record stay those of the original judgment.
  reusedFrom?: string;
}

// The risk lane keeps its local verdict so each attempt records exactly what
// the judge returned. It is not a unified-verdict voter: findings are folded
// into ImplementState.riskFindings, where open blocking entries stop finalize
// and every entry has an explicit fixed/accepted closing transition.
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
}

// The design lane is a reviewer, not a judge: it returns comments and no
// verdict, so there is nothing for it to pass or fail. What replaces the
// verdict is disposition - `finalize --status complete` refuses while an open
// comment has no answer (see DesignComment). The convergence bound
// (PRINCIPLES 13) is structural rather than a severity floor: a comment is
// keyed by `area::path`, so re-wording the same defect cannot mint a new one,
// and the only way to open work is for the lane to still see the defect.
//
// 2026-08-20, herdr-remote-handoff: 12 design lanes across one run reported
// the same duplicated remote-boundary check, in two languages and four
// phrasings, and none of the 12 was ever answered. An advisory lane that
// nothing must reply to is a wall poster, not a reviewer.
export interface DesignComment {
  area: string;
  /**
   * Project-relative file the comment is anchored to. Structured rather than
   * left inside `text` because it is half the identity key: prose matching
   * across re-runs is a coin flip (PRINCIPLES 11), a path is not.
   */
  path: string;
  text: string;
  suggestion: string;
}

/**
 * One design comment tracked across attempts, with its answer.
 *
 * `fixed` is deliberately not a disposition anyone records. Fixing is proved
 * by the lane no longer seeing the defect, which flips `status` to "resolved"
 * on its own; a hand-typed "fixed" would be an unverified claim competing
 * with a measurement. That leaves exactly one thing a human or agent writes:
 * why a comment is being left alone.
 */
export interface TrackedDesignComment extends DesignComment {
  /** Stable `D<n>`, assigned once per key and never reused. */
  id: string;
  /** `${area}::${path}` - the identity that survives re-wording. */
  key: string;
  /** "open" while the lane still reports it; "resolved" once it stops. */
  status: "open" | "resolved";
  /** Non-null once someone answered "not fixing, because ..."; carried across attempts. */
  accepted: { at: string; note: string } | null;
  firstSeenAt: string;
  lastSeenAt: string;
  lastSeenAttemptId: string;
}

export interface FidelityCheckResult {
  id: "F1" | "F2" | "F3" | "F4" | "F5";
  verdict: "PASS" | "FAIL";
  reason: string;
  evidence: string;
  priorDisposition?: PriorDisposition;
  origin?: FindingOrigin;
  deltaBasis?: DeltaBasis;
}

export interface VerificationInputManifest {
  source: SourceEntry[];
  evidence: Array<{ verificationId?: string; acceptanceCriterionId?: string; path: string; sha256: string }>;
  checkLedger: {
    sha256: string;
    bindings: Array<{ criterionId: string; bindingId: string; command: string; argv: string[]; cwd: string; classification: "asset" | "labor" }>;
  };
}

export interface VerificationRoundContext {
  priorAttemptId: string | null;
  changedPaths: string[];
  newEvidence: Array<{ verificationId?: string; acceptanceCriterionId?: string; path: string; sha256: string }>;
}

export interface VerificationRoundContexts {
  acceptance: Record<string, VerificationRoundContext>;
  fidelity: VerificationRoundContext;
  risk: VerificationRoundContext | null;
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
  reusedFrom?: string;
}

export interface UnifiedVerificationAttempt {
  id: string;
  inputFingerprint: string;
  sourceFingerprint: string;
  inputManifest: VerificationInputManifest;
  /** Exact prior-result/delta context used by each semantic judge unit. */
  roundContexts: VerificationRoundContexts;
  fidelityInput: {
    routing: "decision-traceability" | "full-qa-log";
    contentSha256: string;
  };
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  verdict: VerificationStatus;
  prelint: { ok: boolean; findings: unknown[] };
  mechanical: MechanicalRunRecord[];
  /** Criteria deliberately excluded from this attempt by a recorded park. */
  skippedAcceptanceCriteria: Array<{ id: string; reason: string }>;
  lanes: {
    acceptance: LaneRecord<{
      verdict: "PASS" | "FAIL";
      criteria: AcLaneResult[];
      invocations: AcceptanceCriterionInvocation[];
    }> | null;
    fidelity: LaneRecord<{ verdict: "PASS" | "FAIL"; checks: FidelityCheckResult[] }> | null;
    risk: LaneRecord<RiskLaneResult> | null;
    // Optional: attempts recorded before the design lane existed lack the key.
    design?: LaneRecord<{ comments: DesignComment[] }> | null;
  };
  error: { stage: string; code: string; message: string } | null;
}

// ---------------------------------------------------------------------------
// v7 supervision ledgers
//
// Six append-only ledgers give the observer a channel and the run a memory.
// Every one of them is a plain array on ImplementState with a monotonic
// numeric `id` derived as max(existing) + 1. There is deliberately no
// `nextId` counter anywhere: a counter is a second record of the same fact
// and drifts from the array the first time a write is interrupted
// (PRINCIPLES 10, "records stay honest and singular").
//
// State-transition table (what T3/T6/T7/T8/T9/T12/T13 enforce; this file only
// fixes the shapes those transitions read and write):
//
//   suite command   sealed -> excluded          human approval quote required
//                   sealed -> (never parked)    park of a suite command is refused
//   acceptance AC   pending -> green            all bound checks green
//                   green   -> pending          amendment changed that AC's row hash
//                   pending -> parked           decision point posted + reason
//                   parked  -> pending          resume, or amendment changed the row
//   task            pending -> complete/blocked unchanged from v6
//                   pending -> pending          resequence permutes order only
//   amendment       accepted only while no task is in progress; never reverted
//   escalation      accepted while count < ESCALATE_LIMIT_PER_RUN; then refused
//   trail           accepted -> superseded      a later accepted trail for the same AC
//
// The one rule with no transition: events. Once appended, an event is never
// edited or removed for the life of the run (AC24).
// ---------------------------------------------------------------------------

/**
 * Who a state change is attributed to. The physical write path is the CLI
 * alone (R7); this label says on whose authority the write happened.
 *
 * `solver` is absent by design: the solver diagnoses and never writes state
 * (AC33), so it can never be an issuer. It appears only as a ClaimOrigin.
 */
export type IssuerLabel = "implementor" | "observer" | "human";

/**
 * Provenance of a narrative claim in the judge envelope's claims section.
 * `human` marks an exercise of authority; `observer` and `solver` mark
 * unverified assertions. None of the three may be a basis for a verdict - the
 * envelope says so in as many words (AC9).
 */
export type ClaimOrigin = "human" | "observer" | "solver";

export type ImplementEventKind =
  | "task-status"
  | "check-bound"
  | "check-attempt"
  | "criterion-status"
  | "park"
  | "resume"
  | "amendment"
  | "resequence"
  | "escalate"
  | "trail"
  | "comment"
  | "verify"
  | "finalize";

/**
 * One thing that happened, in the order it happened. This is what the
 * background waiter (`sasu implement await`) blocks on: the observer wakes on
 * a semantic unit the harness owns, never on pane text (D-16/D-19).
 */
export interface ImplementEvent {
  /** Monotonic from 1, never reused, never renumbered. */
  id: number;
  at: string;
  kind: ImplementEventKind;
  actor: IssuerLabel;
  /** Task or criterion id this event is about; null for run-wide events. */
  subject: string | null;
  summary: string;
}

export type ObserverVerb = "park" | "resequence" | "escalate" | "resume";

/** Which of the three CLI checks refused a verb (R7). */
export type VerbRejectionCheck = "arguments" | "authority" | "transition";

export interface VerbRecord {
  id: number;
  at: string;
  verb: ObserverVerb;
  issuer: IssuerLabel;
  /** Task or criterion the verb was aimed at; null for run-wide verbs. */
  target: string | null;
  reason: string;
  outcome: "accepted" | "rejected";
  /** Non-null exactly when outcome is "rejected". */
  rejection: { check: VerbRejectionCheck; message: string } | null;
}

export interface AmendmentRecord {
  id: number;
  at: string;
  /**
   * Always "human". Kept as a field rather than assumed so the record states
   * the authority it was accepted under; a supervisor-issued amendment is
   * refused before it ever reaches this ledger (AC12).
   */
  issuer: "human";
  /** Verbatim user approval quote. */
  approval: string;
  reason: string;
  prdSha256: string;
  snapshotPath: string;
  previousSnapshotPath: string;
  /** Criteria whose normalized row hash changed and therefore lost green. */
  invalidatedCriteria: string[];
  /** Criteria that did not exist before and join unproven. */
  addedCriteria: string[];
  /** Parked criteria whose row changed, so their park lifted. */
  unparkedCriteria: string[];
  /** True when this amendment also excluded a sealed suite command (AC42). */
  suiteSnapshotUpdated: boolean;
}

export interface SuiteCommand {
  /** Stable `S<n>` within the sealed list. */
  id: string;
  command: string;
  argv: string[];
  cwd: string;
  /**
   * Verification rows this command proves, frozen with the list. Sealed
   * rather than re-derived per attempt for the same reason the command list
   * is: a mid-run PRD edit must not silently remap which V row a green
   * belongs to (AC5).
   */
  verificationIds: string[];
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
  status: "GREEN" | "RED";
  logPath: string;
  /**
   * Criteria that share this exact `(cwd, command)` and were scored from the
   * same single execution. Empty means the command is an orphan suite entry -
   * the case whose failure blocks the run on its own axis (R2).
   */
  attributedCriteria: string[];
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

export interface QaBriefStep {
  /** `S1`..`Sn`, the identity the coverage check compares as a set (D-31). */
  id: string;
  text: string;
}

/**
 * The only briefing window for a judged driving criterion (R11). Reissuing for
 * the same criterion mints a new briefId, so a trail echoing a stale one is
 * refused (AC30/AC31).
 */
export interface QaBrief {
  briefId: string;
  criterionId: string;
  issuedAt: string;
  /** PRD snapshot the script was derived from. */
  prdSha256: string;
  steps: QaBriefStep[];
}

/**
 * Self-declared, never authenticated. The CLI checks the declaration and
 * records it for audit; it cannot tell an implementor calling itself a QA
 * agent from a real one. Same accepted trust model as D-39 (10장).
 */
export type DriverRole = "human" | "observer" | "qa-agent";

export interface TrailRecord {
  id: number;
  at: string;
  criterionId: string;
  briefId: string;
  driverRole: DriverRole;
  /** Step ids the driver covered; compared as a set against the brief. */
  coveredStepIds: string[];
  /** Registered artifact paths carrying the capture. */
  artifactPaths: string[];
  /** "superseded" once a later trail is accepted for the same criterion. */
  status: "accepted" | "superseded";
}

/**
 * Three artifacts and nothing else go to a replacement implementor (D-22).
 * The previous implementor's conversation is deliberately absent: escalate
 * exists because that context stopped converging (PRINCIPLES 13).
 */
export interface SolverHandoff {
  prdSnapshotPath: string;
  diagnosisPath: string;
  checkLedgerPath: string;
}

export interface EscalationRecord {
  id: number;
  at: string;
  /** Task or criterion the implementor was stuck on. */
  target: string | null;
  reason: string;
  /** Judge routing profile reused for the solver (R12); no new knob. */
  profile: ReviewProfile;
  model: string | null;
  outcome: "diagnosed" | "summon-failed";
  /** Diagnosis text on success; null when the summon failed. */
  diagnosis: string | null;
  /** Failure detail on summon-failed; null on success. */
  error: string | null;
  /** Non-null only on success, when a replacement was actually briefed. */
  handoff: SolverHandoff | null;
}

export interface ImplementState {
  schema: typeof IMPLEMENT_SCHEMA;
  status: "active" | "complete" | "blocked" | "retired";
  topicSlug: string;
  /**
   * The RECORD tree: where agents/ bookkeeping (this state, receipt, PRD,
   * config, rules) lives and where judges read their pinned inputs from.
   */
  projectRoot: string;
  /**
   * The JUDGED tree, when the run is isolated into a git worktree. Snapshots,
   * baselines, mechanical commands, and judged diffs all read this tree;
   * `null` means the run works in place and the record tree is also the
   * judged tree. Records never live here: removing the worktree may lose
   * uncommitted code but never the run's record.
   */
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
  };
  initialSource: SourceSnapshot;
  baselineAttribution: BaselineAttribution;
  // Session allowed to mutate this run, stamped at start from the shared
  // resolver (runs/session.ts). This is the ONLY record of ownership: the v2
  // guard kept three copies and an `||` fallback, and one env-less write was
  // enough to silently move authority between them (2026-08-12
  // pokemon-rpg-run-1). `null` means started without a session identity; the
  // first mutating session claims such a run so bare-shell/CI runs stay
  // finishable. Absent on states recorded before ownership existed (= null).
  ownerSessionId?: string | null;
  // User-approved takeovers of a run owned by another session, evidence
  // verbatim like budgetGrants. Not a deviation: ownership is process
  // metadata, not judged material, and must not stale a settled verdict.
  adoptions?: { at: string; fromSessionId: string; evidence: string }[];
  tasks: TaskItem[];
  requirements: ContractItem[];
  acceptanceCriteria: AcceptanceCriterionItem[];
  verification: VerificationItem[];
  artifacts: RegisteredArtifact[];
  verificationAttempts: UnifiedVerificationAttempt[];
  // Explicit user go-aheads that opened a fresh fix budget after exhaustion.
  // Recording them here keeps one state file authoritative: without this
  // path, sessions improvised `mv state.json` + a fresh start, scattering the
  // record across files (2026-08-13 creator-assist: three archived states,
  // each new run re-judging every criterion from zero).
  budgetGrants?: { at: string; evidence: string; attemptCountBefore: number }[];
  deviations: { at: string; type: string; summary: string }[];
  // Risk findings are a ledger, not votes. Missing on early v5 states and
  // normalized to [] by loadState so the additive v5 shape stays readable.
  riskFindings: TrackedRiskFinding[];
  // Design comments tracked across attempts with their dispositions. Absent on
  // states recorded before dispositions existed (= no tracked comments).
  designComments?: TrackedDesignComment[];
  // --- v7 supervision ledgers. Required, not optional: a run that cannot say
  // what suite it was sealed against or what happened in it is exactly the
  // state v7 refuses to guess at (see IMPLEMENT_SCHEMA).
  /** Append-only; the waiter's `--since` cursor indexes into this (R8). */
  events: ImplementEvent[];
  /** Every observer verb, accepted or refused, with which check refused it. */
  verbs: VerbRecord[];
  amendments: AmendmentRecord[];
  suite: SuiteLedger;
  /** Issued briefs, newest last; a criterion may have several over a run. */
  qaBriefs: QaBrief[];
  trails: TrailRecord[];
  /** Escalation count is `escalations.length`, never a separate counter. */
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
