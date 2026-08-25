import type { JudgeCallRecord } from "../judge/types";

// v5: the run owns its approved PRD snapshot, baseline attribution, retirement
// transition, and round-to-round judge delta record. Older shapes are not
// migrated because completion authority must never guess missing provenance.
export const IMPLEMENT_SCHEMA = "sasu.implement.state.v5" as const;
export const IMPLEMENT_ACTIVE_SCHEMA = "sasu.implement.active.v3" as const;

export type ItemStatus = "pending" | "complete" | "blocked";
export type VerificationStatus = "NOT_RUN" | "PASS" | "FAIL" | "BLOCKED" | "ERROR" | "STALE";
export type ReviewProfile = "trivial" | "standard" | "high-risk";

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
  verificationId: string;
  kind: string;
  path: string;
  description: string;
  sha256: string;
  bytes: number;
  sourceFingerprint: string;
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
  error: { code: string; message: string } | null;
  // Names the ERROR'd attempt this settled verdict was carried over from.
  // Timestamps and judge record stay those of the original judgment.
  reusedFrom?: string;
}

// The severity floor is the risk lane's convergence bound: a fresh
// adversarial judge always finds something new (2026-08-13 creator-assist: 17
// risk rounds, 89 findings, zero repeats, every round FAIL), so only findings
// the judge stakes as blocking may fail the lane. Advisory findings are
// recorded without invalidating the run.
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
  evidence: Array<{ verificationId: string; path: string; sha256: string }>;
}

export interface VerificationRoundContext {
  priorAttemptId: string | null;
  changedPaths: string[];
  newEvidence: Array<{ verificationId: string; path: string; sha256: string }>;
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
  error: { code: string; message: string } | null;
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
  acceptanceCriteria: ContractItem[];
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
  // Design comments tracked across attempts with their dispositions. Absent on
  // states recorded before dispositions existed (= no tracked comments).
  designComments?: TrackedDesignComment[];
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
