import type { JudgeCallRecord } from "../judge/types";

// v4: task entries carry dependsOn (PRD-declared execution dependencies).
export const IMPLEMENT_SCHEMA = "sasu.implement.state.v4" as const;
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
}

export interface FidelityCheckResult {
  id: "F1" | "F2" | "F3" | "F4" | "F5";
  verdict: "PASS" | "FAIL";
  reason: string;
  evidence: string;
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
}

export interface UnifiedVerificationAttempt {
  id: string;
  inputFingerprint: string;
  sourceFingerprint: string;
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
    risk: LaneRecord<{ verdict: "PASS" | "FAIL"; findings: string[] }> | null;
  };
  error: { stage: string; code: string; message: string } | null;
}

export interface ImplementState {
  schema: typeof IMPLEMENT_SCHEMA;
  status: "active" | "complete";
  topicSlug: string;
  projectRoot: string;
  runDir: string;
  prdPath: string;
  prd: {
    sha256: string;
    status: string | null;
    approval: { source: "frontmatter" | "conversation"; evidence: string };
    reviewProfile: ReviewProfile;
    reviewRationale: string;
    sourceIntake: string;
  };
  initialSource: SourceSnapshot;
  tasks: TaskItem[];
  requirements: ContractItem[];
  acceptanceCriteria: ContractItem[];
  verification: VerificationItem[];
  artifacts: RegisteredArtifact[];
  verificationAttempts: UnifiedVerificationAttempt[];
  deviations: { at: string; type: string; summary: string }[];
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
  updatedAt: string;
}

export interface ImplementCommandResult {
  ok: boolean;
  action: string;
  exitCode: number;
  message: string;
  state?: ImplementState;
  detail?: Record<string, unknown>;
}
