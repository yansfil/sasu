import type { JudgeCallRecord, JudgeFailureCause } from "../judge/types";
import type { MechanicalOutcome } from "./verdict";

// v8: the run is a list of Behaviors rows, each settled by exactly one of
// `check:` (exit code), `judge:` (acceptance lane), or `human:` (confirm).
// The task ledger, requirement list, AC check bindings and V rows are gone
// with the five-axis template (PRD prd-template R5, R10). Older shapes are
// not migrated: a v7 run's AC bindings and task statuses have no row to map
// onto, and completion authority must never guess (PRINCIPLES 10), so every
// command refuses v5-v7 with one explicit error.
export const IMPLEMENT_SCHEMA = "sasu.implement.state.v8" as const;
export const IMPLEMENT_ACTIVE_SCHEMA = "sasu.implement.active.v3" as const;

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

/**
 * How one Behaviors row is settled, read from its 검사 방법 cell at start
 * and sealed with the PRD snapshot (D-06). The cell is the whole contract:
 * a `check:` row is proved by its command's exit code and nothing else, a
 * `judge:` row only by the acceptance lane, a `human:` row only by the
 * person's own words through `confirm`.
 */
export type RowCheck =
  | { kind: "check"; command: string; argv: string[] }
  | { kind: "judge"; evidence: string }
  | { kind: "human"; confirmation: string };

/**
 * One row's state as `status` shows it. `check:` rows move
 * pending -> green | fail (| parked); `judge:` rows pending -> PASS | FAIL;
 * `human:` rows OPEN -> PASS. The words are the PRD's (R5, R7).
 */
export type RowStatus = "pending" | "green" | "fail" | "parked" | "OPEN" | "PASS" | "FAIL";

export interface BehaviorRow {
  /** `B<n>` as written in the PRD. */
  id: string;
  behavior: string;
  check: RowCheck;
  decisionIds: string[];
  status: RowStatus;
  /** `check:` rows only; every run of the row's command, oldest first. */
  attempts: CheckAttempt[];
  consecutiveFailures: number;
  parks: CheckParkRecord[];
  /** Latest judge reason for a `judge:` row; null until verify rules. */
  verdict: { attemptId: string; verdict: "PASS" | "FAIL"; reason: string } | null;
  /** Set by `confirm` on a `human:` row; null while OPEN. */
  human: { confirmedAt: string; evidence: string } | null;
  /** Every `confirm --reject`, oldest first; the receipt shows the latest. */
  rejections: Array<{ at: string; evidence: string }>;
}

export interface CheckTreeFingerprint {
  all: string;
  product: string;
  bookkeeping: string;
}

export interface CheckAttempt {
  id: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number;
  timedOut: boolean;
  signal: NodeJS.Signals | null;
  /** Input to `outcome`, recorded beside the exit code it qualifies. */
  mutatedTree: boolean;
  /** Derived by `mechanicalOutcome` from the four fields above; never set by hand. */
  outcome: MechanicalOutcome;
  outputFingerprint: string;
  /** Non-null exactly when outcome is "failed"; a moved tree is not an output class. */
  failureClass: string | null;
  tree: CheckTreeFingerprint;
}

/**
 * A `check:` row set aside with the human's approval on record. Nobody but
 * the person may decide a row is proved later: the observer's park used to
 * rest on a harness-posted decision point, and decision points left with the
 * check ledger (R5), so a park now always carries the approval quote.
 */
export interface CheckParkRecord {
  parkedAt: string;
  /** Verbatim human approval. */
  approval: string;
  reason: string;
  evidence: string | null;
  resumedAt: string | null;
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
  /** Behaviors row this evidence is registered for; absent for a run-wide capture. */
  rowId?: string;
  kind: string;
  path: string;
  description: string;
  sha256: string;
  bytes: number;
  registeredAt: string;
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
  rowId: string;
  invocationId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  verdict: VerificationStatus;
  judge: JudgeCallRecord | null;
  error: JudgeLaneError | null;
  /**
   * Whether a judge was asked at all. "judge" means the acceptance judge read
   * an envelope and ruled. "harness" means the harness settled the criterion
   * from its own records and summoned nobody - a machine criterion read off
   * its Check exit code (R3, AC7), or a judged criterion refused before the
   * call because its declared evidence was never registered.
   *
   * Stated rather than inferred from `judge: null`, because a null judge
   * record is also what a judge call whose record was lost looks like. A
   * reader has to be able to tell "nobody was asked" from "somebody was asked
   * and the record is missing". Absent on invocations written before the
   * acceptance lane was narrowed, which were all judge calls.
   */
  source?: "judge" | "harness";
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
  /**
   * `null` for a comment the design lane produced; the issuer label for one a
   * supervisor raised by hand (R10).
   *
   * It decides who may retire the comment. A lane comment resolves by
   * measurement - the lane stops reporting it. A raised comment has no lane
   * behind it, so nothing ever stops reporting it, and auto-resolving it on
   * the next attempt would erase the remark instead of answering it. A raised
   * comment therefore leaves only through a recorded disposition.
   */
  raisedBy: IssuerLabel | null;
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
  evidence: Array<{ rowId?: string; path: string; sha256: string }>;
  /** Every row's sealed check cell plus the `check:` rows' ledger state. */
  checkLedger: {
    sha256: string;
    rows: Array<{ rowId: string; kind: RowCheck["kind"]; payload: string; status: RowStatus }>;
  };
}

export interface VerificationRoundContext {
  priorAttemptId: string | null;
  changedPaths: string[];
  newEvidence: Array<{ rowId?: string; path: string; sha256: string }>;
}

export interface VerificationRoundContexts {
  acceptance: Record<string, VerificationRoundContext>;
  fidelity: VerificationRoundContext;
  risk: VerificationRoundContext | null;
  /**
   * Null when the lane did not run (trivial profile); absent on attempts
   * recorded before the design lane had a round context, the same way
   * `lanes.design` is absent on attempts that predate the lane.
   */
  design?: VerificationRoundContext | null;
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
    routing: "decisions" | "full-qa-log";
    contentSha256: string;
  };
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  verdict: VerificationStatus;
  prelint: { ok: boolean; findings: unknown[] };
  mechanical: MechanicalRunRecord[];
  /** Rows deliberately excluded from this attempt by a recorded park. */
  parkedRows: Array<{ id: string; reason: string }>;
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
//   check: row      pending -> green | fail     `check --row` exit code
//                   green   -> pending          amendment changed that row's cells
//                   pending -> parked           human approval quote + reason
//                   parked  -> pending          resume, or amendment changed the row
//   judge: row      pending -> PASS | FAIL      acceptance lane verdict
//   human: row      OPEN    -> PASS             `confirm --row` (human); never reopened
//   run             active  -> complete-pending-human | complete   finalize
//                   complete-pending-human -> complete              last confirm
//   amendment       check-cells: observer or human; behaviors: human; never reverted
//   escalation      accepted while count < ESCALATE_LIMIT_PER_RUN; then refused
//   trail           accepted -> superseded      a later accepted trail for the same row
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
  | "row-status"
  | "check-attempt"
  | "park"
  | "resume"
  | "amendment"
  | "escalate"
  | "trail"
  | "comment"
  | "verify"
  | "finalize"
  | "confirm";

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
  /** Row id this event is about; null for run-wide events. */
  subject: string | null;
  summary: string;
}

/**
 * Every command that passes the authority gate, which is the same set the
 * verb history records.
 *
 * One vocabulary, not two. The verb list and the authority table used to be
 * separate spellings of the same idea, and the gap between them is where a
 * refused command went unrecorded: the gate knew it had refused an observer,
 * and the run's history did not (R16 ②, AC45). `COMMAND_AUTHORITY` is typed
 * against this union, so a new command cannot join one list and miss the
 * other.
 */
export type IssuedCommand =
  | "check"
  | "artifact"
  | "verify"
  | "finalize"
  | "design"
  | "design-raise"
  | "risk"
  | "park"
  | "resume"
  | "confirm"
  | "qa-brief"
  | "trail"
  | "escalate"
  | "risk-non-convergent"
  | "amend";

/** Which of the three CLI checks refused a verb (R7). */
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

/**
 * One piece of evidence replaced by another, and what became of the first
 * (R15 ①, AC40).
 *
 * Every rejection path in this PRD defined what gets refused and stopped
 * there. The move a person actually makes next is to replace the evidence and
 * resubmit, and until now that left no trace: registering a new capture for a
 * criterion silently dropped the old row, so a reader could not tell a
 * criterion proved once from one proved on the third try with two discarded
 * captures behind it.
 *
 * `priorDisposition` is the honest half. A superseded trail is PRESERVED - it
 * stays in the record marked superseded. A replaced artifact is INVALIDATED -
 * the registration is gone, because the file it vouched for no longer has
 * those bytes and a stale vouch is worse than none.
 */
export interface EvidenceReplacement {
  /** Monotonic from 1, never reused. */
  id: number;
  at: string;
  rowId: string;
  kind: "artifact" | "trail";
  /** The evidence that was superseded, named the way its record names it. */
  previous: string;
  /** What replaced it. */
  next: string;
  priorDisposition: "preserved" | "invalidated";
}

export interface AmendmentRecord {
  id: number;
  at: string;
  /**
   * The authority the amendment was accepted under (R6). "observer" only
   * ever appears on a `check-cells` amendment: a supervisor may repair how a
   * row is checked, never what the user observes. The implementor is refused
   * before it reaches this ledger.
   */
  issuer: "observer" | "human";
  /**
   * What the diff touched. `check-cells` means only 검사 방법 cells changed;
   * `behaviors` means a behavior cell, the row set, Non-goals or the
   * Decisions table moved, which is a scope change and human-only.
   */
  scope: "check-cells" | "behaviors";
  /** Verbatim approval quote. */
  approval: string;
  reason: string;
  prdSha256: string;
  snapshotPath: string;
  previousSnapshotPath: string;
  /** Rows whose check cell or behavior changed and therefore lost their proof. */
  invalidatedRows: string[];
  /** Rows that did not exist before and join unproven. */
  addedRows: string[];
  /** Parked rows whose row changed, so their park lifted. */
  unparkedRows: string[];
  /** True when this amendment also excluded a sealed suite command (AC42). */
  suiteSnapshotUpdated: boolean;
  /**
   * Suite commands this amendment dropped from the sealed list (R15 ③, AC42).
   *
   * The sealed list minus its exclusions stays the scoring authority; the
   * excluded command's last result stays in `suite.results` as the fact that
   * it happened, and simply stops being counted. Deleting it would erase a
   * red the run really saw.
   */
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
  rowId: string;
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
  rowId: string;
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
  /** Row the implementor was stuck on. */
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

export type PrdJudgeRecord =
  | { required: true; skippedReason: null; gapAudit: string; spec: string }
  | { required: false; skippedReason: string; gapAudit: null; spec: null };

export interface ImplementState {
  schema: typeof IMPLEMENT_SCHEMA;
  /**
   * `complete-pending-human`: every check:/judge: row proved and at least
   * one human: row still OPEN (R8). Closed for implementation like
   * `complete`; only `confirm` still writes.
   */
  status: "active" | "complete-pending-human" | "complete" | "blocked" | "retired";
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
    /**
     * Whether the PRD's specification gates (gap-audit, spec) judged it
     * before this run started, recorded at start and copied into the
     * receipt (PRD gate-loop R9). A PRD with no interview qa-log has no
     * user utterances for a fidelity judge to compare against, so the gates
     * are not required for it and the receipt says so instead of implying
     * a judgment that never happened. Absent on runs recorded before the
     * field existed; the receipt omits it rather than guessing.
     */
    judge?: PrdJudgeRecord;
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
  /** The Behaviors table, sealed at start, in PRD order. */
  rows: BehaviorRow[];
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
  /** Append-only; every resubmission after a rejection (R15 ①). */
  evidenceReplacements: EvidenceReplacement[];
  /** Every observer verb, accepted or refused, with which check refused it. */
  verbs: VerbRecord[];
  amendments: AmendmentRecord[];
  suite: SuiteLedger;
  /** Issued briefs, newest last; a row may have several over a run. */
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
