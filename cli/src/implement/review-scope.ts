import { verificationRoundContext } from "./convergence";
import { diffChunkPath } from "./prompts";
import { sha256 } from "./store";
import {
  ROUTINE_REVIEW_ROLES,
  type ImplementState,
  type ReviewAssessment,
  type ReviewExecutionRecord,
  type ReviewLedgerSnapshot,
  type ReviewScope,
  type RoutineReviewRole,
  type UnifiedVerificationAttempt,
  type VerificationLane,
  type VerificationRoundContext,
} from "./types";

/**
 * How one verify attempt spends its review.
 *
 * Three shapes, decided here from the record and nowhere else:
 *
 *   full     every lane runs and reviews the whole contract from scratch.
 *   focused  every lane runs; each may carry a ground it settled at the
 *            anchor attempt when the bytes it cites have not moved since,
 *            and must re-review the changes, their reach, and every
 *            requirement an open blocking finding names.
 *   repair   the same review input as the previous attempt, which settled
 *            some lanes and lost the others to a backend error; only the
 *            lost lanes run, the settled ones are reused with `carriedFrom`.
 *
 * Measured motivation (herdr guarded-agent-prompt, 2026-09-14): after a
 * two-file fix the harness re-reviewed all 2,478 product files - 513s, 63 and
 * 31 reads, 228,754 and 425,684 chars of read output - and the attempt before
 * it had lost a 763s Code review to a turn cap while Fidelity's 451s FAIL was
 * valid and then discarded with it. Both costs are the whole-review policy,
 * not the reviewers.
 *
 * The suite is outside this decision on purpose: its purity cannot be proven
 * from the tree (PRINCIPLES 5), so every attempt executes it.
 */
export interface ReviewPlan {
  record: ReviewExecutionRecord;
  scope: ReviewScope;
  /** The findings, risks and claims the reviewers are shown. */
  ledger: ReviewLedgerSnapshot;
  /** focused: the anchor; repair: the attempt whose settled lanes are reused. */
  reference: UnifiedVerificationAttempt | null;
  roundContext: VerificationRoundContext;
}

export function requiredLanes(state: ImplementState): VerificationLane[] {
  return state.prd.reviewProfile === "high-risk" ? [...ROUTINE_REVIEW_ROLES, "risk"] : [...ROUTINE_REVIEW_ROLES];
}

export function laneRecord(attempt: UnifiedVerificationAttempt, lane: VerificationLane) {
  return lane === "risk" ? attempt.risk : attempt.reviews[lane];
}

export function settledLanes(attempt: UnifiedVerificationAttempt): VerificationLane[] {
  return (["fidelity", "code", "risk"] as const).filter((lane) => laneRecord(attempt, lane)?.result != null);
}

/**
 * The attempt a new round is measured against: the latest one a reviewer
 * actually saw, not merely the latest one recorded. The 2026-09-14 run's
 * final attempt reported "changed paths since the prior attempt: none"
 * because the prior attempt had been interrupted before review; the two
 * files that had actually changed since the last review were invisible.
 */
export function reviewPrior(attempts: readonly UnifiedVerificationAttempt[]): UnifiedVerificationAttempt | null {
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    if (settledLanes(attempts[index]!).length > 0) return attempts[index]!;
  }
  return attempts.at(-1) ?? null;
}

export function ledgerSnapshot(state: ImplementState): ReviewLedgerSnapshot {
  return {
    findings: structuredClone(state.findings),
    riskFindings: structuredClone(state.riskFindings),
    claims: state.escalations.filter((entry) => entry.diagnosis !== null).map((entry) => ({ origin: "solver" as const, subject: `escalation ${entry.id}`, text: entry.diagnosis! })),
  };
}

function blockingRequirementRefs(ledger: ReviewLedgerSnapshot): string[] {
  return [...new Set(ledger.findings
    .filter((entry) => entry.status === "open" && (entry.kind === "defect" || (entry.kind === "human-confirmation" && entry.human?.timing === "prerequisite")))
    .flatMap((entry) => entry.requirementRefs))].sort();
}

/**
 * Why a repair is not on: null means it is. Every clause is a fact the
 * record can show; none is a judgment about whether the settled result was
 * good. "Same input" is the whole of it - contract, source, evidence, the
 * ledger the reviewers saw, the review policy - and one accepted domain verb
 * since that attempt is enough to say the ledger may have moved.
 */
function repairObstacle(state: ImplementState, current: UnifiedVerificationAttempt, previous: UnifiedVerificationAttempt | undefined, policySha256: string): string | null {
  if (previous === undefined) return "no previous attempt";
  if (previous.error === null || previous.error.stage !== "review" || previous.reviewContext === null) return `attempt ${previous.id} did not fail inside review`;
  const settled = settledLanes(previous);
  const required = requiredLanes(state);
  const lost = required.filter((lane) => !settled.includes(lane));
  if (settled.length === 0) return `attempt ${previous.id} settled no lane`;
  if (lost.length === 0) return `attempt ${previous.id} settled every lane`;
  if (previous.inputFingerprint !== current.inputFingerprint) return `inputs changed since attempt ${previous.id}`;
  if (previous.reviewPolicySha256 === undefined || previous.reviewContext.identity === undefined || previous.reviewContext.ledgerSnapshot === undefined) return `attempt ${previous.id} predates repair records`;
  if (previous.reviewPolicySha256 !== policySha256) return `review policy changed since attempt ${previous.id}`;
  const lastVerify = state.verbs.map((verb) => verb.verb === "verify" && verb.outcome === "accepted").lastIndexOf(true);
  if (state.verbs.slice(lastVerify + 1).some((verb) => verb.outcome === "accepted")) return `a domain command was accepted after attempt ${previous.id}`;
  return null;
}

function focusedObstacle(state: ImplementState, current: UnifiedVerificationAttempt, prior: UnifiedVerificationAttempt | null, policySha256: string): string | null {
  if (prior === null) return "first review of this run";
  const settled = settledLanes(prior);
  const missing = requiredLanes(state).filter((lane) => !settled.includes(lane));
  if (missing.length > 0) return `attempt ${prior.id} did not settle ${missing.join(", ")}`;
  if (prior.error !== null) return `attempt ${prior.id} ended in error after its lanes settled`;
  if (prior.contractFingerprint === undefined || prior.reviewPolicySha256 === undefined || prior.reviewContext?.scope === undefined) return `attempt ${prior.id} predates scoped review records`;
  if (prior.contractFingerprint !== current.contractFingerprint) return `contract inputs changed since attempt ${prior.id}: PRD, intent, suite ledger or amendments`;
  if (prior.reviewPolicySha256 !== policySha256) return `review policy changed since attempt ${prior.id}`;
  return null;
}

export function planReview(
  state: ImplementState,
  current: UnifiedVerificationAttempt,
  options: { policySha256: string; ledger: ReviewLedgerSnapshot; allowRepair: boolean },
): ReviewPlan {
  const priorAttempts = state.verificationAttempts.filter((entry) => entry.id !== current.id);
  const previous = priorAttempts.at(-1);
  const required = requiredLanes(state);
  if (options.allowRepair) {
    const obstacle = repairObstacle(state, current, previous, options.policySha256);
    if (obstacle === null) {
      const settled = settledLanes(previous!).filter((lane) => required.includes(lane));
      return {
        record: { mode: "repair", reason: `attempt ${previous!.id} settled ${settled.join(", ")} on this exact input and lost ${required.filter((lane) => !settled.includes(lane)).join(", ")} to a backend error`,
          referenceAttemptId: previous!.id, executedLanes: required.filter((lane) => !settled.includes(lane)), carriedLanes: settled },
        scope: previous!.reviewContext!.scope ?? { mode: "full" },
        ledger: structuredClone(previous!.reviewContext!.ledgerSnapshot!),
        reference: previous!,
        roundContext: structuredClone(previous!.roundContext),
      };
    }
  }
  const prior = reviewPrior(priorAttempts);
  const roundContext = verificationRoundContext(current.inputManifest, prior);
  const obstacle = focusedObstacle(state, current, prior, options.policySha256);
  if (obstacle !== null) {
    return { record: { mode: "full", reason: obstacle, referenceAttemptId: null, executedLanes: required, carriedLanes: [] }, scope: { mode: "full" }, ledger: options.ledger, reference: null, roundContext };
  }
  const anchor = prior!;
  const invalidated = new Set<string>();
  for (const path of roundContext.changedPaths) { invalidated.add(path); invalidated.add(diffChunkPath(path)); }
  for (const entry of roundContext.newEvidence) invalidated.add(entry.path);
  const anchorAssessments = Object.fromEntries(ROUTINE_REVIEW_ROLES.map((role) => [role, structuredClone(anchor.reviews[role]!.result!.assessments)])) as Record<RoutineReviewRole, ReviewAssessment[]>;
  const scope: ReviewScope = { mode: "focused", anchorAttemptId: anchor.id, anchorAssessments, invalidatedEvidenceRefs: [...invalidated].sort(), reopenedRequirementRefs: blockingRequirementRefs(options.ledger) };
  return {
    record: { mode: "focused", reason: `attempt ${anchor.id} settled every lane on the same contract and policy; ${roundContext.changedPaths.length} path(s) and ${roundContext.newEvidence.length} evidence file(s) changed since`,
      referenceAttemptId: anchor.id, executedLanes: required, carriedLanes: [] },
    scope, ledger: options.ledger, reference: anchor, roundContext,
  };
}

/**
 * The review policy a settled judgment was produced under: the harness
 * contract version (which fixes the prompts and validators), the judge
 * routing, and the profile. Backend binary versions are deliberately not
 * probed: the model named in the routing is what judges, and a probe would
 * make every verify depend on two more executables answering.
 */
export function reviewPolicySha256(contractVersion: string, judge: unknown, reviewProfile: string): string {
  return sha256(JSON.stringify({ contractVersion, judge, reviewProfile }));
}

/**
 * Where each requirement's current Fidelity ground was actually inspected.
 * A carried ground points back through its anchor until an attempt that
 * reviewed it; the chain length is reported so "carried" never reads as
 * "current" by omission.
 */
export interface RequirementGround {
  requirementRef: string;
  conclusion: ReviewAssessment["conclusion"] | null;
  reviewedInAttempt: string | null;
  carriedThrough: number;
}

export function requirementGrounds(state: ImplementState, latest: UnifiedVerificationAttempt | null = state.verificationAttempts.at(-1) ?? null): RequirementGround[] {
  const byId = new Map(state.verificationAttempts.map((entry) => [entry.id, entry]));
  return state.requirements.map((requirement) => {
    let attempt = latest;
    let carriedThrough = 0;
    let conclusion: ReviewAssessment["conclusion"] | null = null;
    while (attempt !== null) {
      const assessment = attempt.reviews.fidelity?.result?.assessments.find((entry) => entry.requirementRefs.includes(requirement.id));
      if (assessment === undefined) return { requirementRef: requirement.id, conclusion, reviewedInAttempt: null, carriedThrough };
      conclusion ??= assessment.conclusion;
      const scope = attempt.reviewContext?.scope;
      if (assessment.basis !== "carried" || scope?.mode !== "focused") return { requirementRef: requirement.id, conclusion, reviewedInAttempt: attempt.id, carriedThrough };
      carriedThrough += 1;
      attempt = byId.get(scope.anchorAttemptId) ?? null;
    }
    return { requirementRef: requirement.id, conclusion, reviewedInAttempt: null, carriedThrough };
  });
}
