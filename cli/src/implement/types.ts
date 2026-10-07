// Implementation state records the sealed contract and deterministic execution facts.
export const IMPLEMENT_SCHEMA = "sasu.implement.state.v14.current-git" as const;
export const RETIRED_IMPLEMENT_SUPPORT_COMMIT = "9149d9826fad2af3ba7200761e674b5228ef9b7d";
export const RETIRED_PARALLEL_REVIEW_SUPPORT_COMMIT = "2b1f638dd587261be7e7b0e600db16657421971d";
export const RETIRED_COORDINATION_SUPPORT_COMMIT = "fbdf62913b4fbe5fde1ebce26c3e290c8eac0e92";
export const RETIRED_RUNTIME_SUPPORT_COMMIT = "6f75d9352e3b5b93aa7df8b81b93476246c68aaf";
export const RETIRED_CONTRACT_SUPPORT_COMMIT = "ba58f5dfe93720d2f757ef0f55201b8845f81f06";
export function retiredImplementSupportCommit(schema: unknown): string {
  if (schema === "sasu.implement.state.v13.contract-only") return RETIRED_CONTRACT_SUPPORT_COMMIT;
  if (schema === "sasu.implement.state.v12.hide") return RETIRED_RUNTIME_SUPPORT_COMMIT;
  if (schema === "sasu.implement.state.v11.stateless-verification") return RETIRED_COORDINATION_SUPPORT_COMMIT;
  return schema === "sasu.implement.state.v9.parallel-review" || schema === "sasu.implement.receipt.v5.parallel-review"
    ? RETIRED_PARALLEL_REVIEW_SUPPORT_COMMIT : RETIRED_IMPLEMENT_SUPPORT_COMMIT;
}
export type VerificationStatus = "NOT_RUN" | "PASS" | "FAIL" | "BLOCKED" | "ERROR" | "STALE";
export type ReviewProfile = "trivial" | "standard" | "high-risk";
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
export type ImplementEventKind = "amendment" | "escalate" | "artifact" | "verify" | "dispatch";
export interface ImplementEvent {
  id: number; at: string; kind: ImplementEventKind; actor: IssuerLabel;
  subject: string | null; summary: string;
}
export type IssuedCommand = "artifact" | "verify" | "escalate" | "amend" | "retire";
export type VerbRejectionCheck = "arguments" | "transition";
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
  issuer: IssuerLabel;
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

/** Requested launch inputs only; Hide owns the child, lineage and watch. */
export interface SpawnIntent {
  intent: string;
  at: string;
  name: string;
  kind: string;
  model: string | null;
  effort: string;
  promptPath: string;
  promptSha256: string;
  /** Complete requested checkout inputs, fixed for retries of this intent. */
  checkout: { repo: string; branch: string; path: string };
}

export interface EscalationRecord extends SpawnIntent {
  id: number;
  target: string | null;
  reason: string;
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
  /** Stable requested launch, never a copy of Hide's execution identity. */
  dispatchIntent: SpawnIntent | null;
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
  } | null;
  verificationReport: VerificationReportIdentity | null;
  createdAt: string;
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

/** Three distinct advisor intents per run; retries reuse their reservation. */
export const ESCALATE_LIMIT_PER_RUN = 3;
