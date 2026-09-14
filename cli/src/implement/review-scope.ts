import type { SasuConfig } from "../config";
import { effectiveJudgeProfile } from "../judge/runner";
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
  if (previous.reviewPolicySha256 === undefined || previous.reviewContext.ledgerSnapshot === undefined) return `attempt ${previous.id} predates repair records`;
  if (previous.reviewPolicySha256 !== policySha256) return `review policy changed since attempt ${previous.id}`;
  const lastVerify = state.verbs.map((verb) => verb.verb === "verify" && verb.outcome === "accepted").lastIndexOf(true);
  if (state.verbs.slice(lastVerify + 1).some((verb) => verb.outcome === "accepted")) return `a domain command was accepted after attempt ${previous.id}`;
  return null;
}

/**
 * The anchor a focused round builds on: the latest attempt that settled every
 * required lane without error. A later attempt that settled only one lane is
 * not it - its surviving grounds are newer but not whole - and the delta a
 * carried ground is checked against runs from the anchor, so everything that
 * changed across the intervening attempts counts as changed.
 */
export function focusAnchor(state: ImplementState, attempts: readonly UnifiedVerificationAttempt[]): UnifiedVerificationAttempt | null {
  const required = requiredLanes(state);
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const attempt = attempts[index]!;
    const settled = settledLanes(attempt);
    if (attempt.error === null && required.every((lane) => settled.includes(lane))) return attempt;
  }
  return null;
}

function focusedObstacle(current: UnifiedVerificationAttempt, anchor: UnifiedVerificationAttempt | null, policySha256: string): string | null {
  if (anchor === null) return "no earlier attempt settled every lane without error";
  if (anchor.contractFingerprint === undefined || anchor.reviewPolicySha256 === undefined || anchor.reviewContext?.scope === undefined) return `attempt ${anchor.id} predates scoped review records`;
  if (anchor.contractFingerprint !== current.contractFingerprint) return `contract inputs changed since attempt ${anchor.id}: PRD, intent, suite ledger or amendments`;
  if (anchor.reviewPolicySha256 !== policySha256) return `review policy changed since attempt ${anchor.id}`;
  return null;
}

export function planReview(
  state: ImplementState,
  current: UnifiedVerificationAttempt,
  options: { policySha256: string; ledger: ReviewLedgerSnapshot },
): ReviewPlan {
  const priorAttempts = state.verificationAttempts.filter((entry) => entry.id !== current.id);
  const previous = priorAttempts.at(-1);
  const required = requiredLanes(state);
  // This decision is final. There used to be a second gate after input
  // preparation - an `identity` digest of the prepared review context,
  // compared against the reference attempt's - but on a repair the context
  // is built from the reference's own pinned snapshot and scope, and its other
  // parts derive from the fingerprint and policy compared above, so the two
  // digests were the same records hashed twice and the gate could not fire.
  // Sameness is proven here or not at all.
  if (repairObstacle(state, current, previous, options.policySha256) === null) {
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
  const anchor = focusAnchor(state, priorAttempts);
  const obstacle = priorAttempts.length === 0 ? "first review of this run" : focusedObstacle(current, anchor, options.policySha256);
  if (obstacle !== null) {
    const roundContext = verificationRoundContext(current.inputManifest, reviewPrior(priorAttempts));
    return { record: { mode: "full", reason: obstacle, referenceAttemptId: null, executedLanes: required, carriedLanes: [] }, scope: { mode: "full" }, ledger: options.ledger, reference: null, roundContext };
  }
  const roundContext = verificationRoundContext(current.inputManifest, anchor!);
  const invalidated = new Set<string>();
  for (const path of roundContext.changedPaths) { invalidated.add(path); invalidated.add(diffChunkPath(path)); }
  // New evidence invalidates its own path AND reopens the requirements it was
  // registered against. Adding only the path let a contradicting observation
  // pass untouched: no anchor assessment cited a file that did not exist when
  // the anchor ran, so nothing was invalidated (2026-09-14).
  const reopened = new Set(blockingRequirementRefs(options.ledger));
  for (const entry of roundContext.newEvidence) {
    invalidated.add(entry.path);
    for (const ref of state.artifacts.find((artifact) => artifact.path === entry.path)?.requirementRefs ?? []) reopened.add(ref);
  }
  const anchorAssessments = Object.fromEntries(ROUTINE_REVIEW_ROLES.map((role) => [role, structuredClone(anchor!.reviews[role]!.result!.assessments)])) as Record<RoutineReviewRole, ReviewAssessment[]>;
  const scope: ReviewScope = { mode: "focused", anchorAttemptId: anchor!.id, anchorAssessments, invalidatedEvidenceRefs: [...invalidated].sort(), reopenedRequirementRefs: [...reopened].sort() };
  return {
    record: { mode: "focused", reason: `attempt ${anchor!.id} settled every lane on the same contract and policy; ${roundContext.changedPaths.length} path(s) and ${roundContext.newEvidence.length} evidence file(s) changed since`,
      referenceAttemptId: anchor!.id, executedLanes: required, carriedLanes: [] },
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
export interface ReviewPolicy {
  contractVersion: string;
  judge: unknown;
  reviewProfile: string;
}

/**
 * The policy the next review would run under. The routing is the effective
 * one - after `SASU_JUDGE_BACKEND` has pinned a backend and dropped the
 * fallback - because that is the judge that produces the judgment; hashing
 * the configured profiles read a Claude-pinned round and a Codex round as
 * one policy (2026-09-14). retryBudget is a harness bound, not a review input.
 */
export function reviewPolicyFor(config: SasuConfig, reviewProfile: string, contractVersion: string): ReviewPolicy {
  const { retryBudget: _budget, profiles: _profiles, ...bounds } = config.judge;
  const judge = { ...bounds, routine: effectiveJudgeProfile(config, "routine"), "high-risk": effectiveJudgeProfile(config, "high-risk") };
  return { contractVersion, judge, reviewProfile };
}

export function reviewPolicySha256(policy: ReviewPolicy): string {
  return sha256(JSON.stringify(policy));
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
