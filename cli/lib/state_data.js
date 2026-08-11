// @ts-check
"use strict";

const fs = require("fs");
const path = require("path");

const { nowIso } = require("./util");

/** @typedef {import("./types").State} State */
/** @typedef {import("./types").VerificationItem} VerificationItem */
/** @typedef {import("./types").Deviation} Deviation */
/** @typedef {import("./types").ReviewRecord} ReviewRecord */

/** @param {VerificationItem} verification */
function isVerificationRequiredForDone(verification) {
  const matrix = (verification && verification.matrix) ||
    /** @type {Partial<import("./types").VerificationMatrix>} */ ({});
  if (typeof matrix.requiredForDone === "boolean") return matrix.requiredForDone;
  return true;
}

/** @param {VerificationItem} verification */
function verificationIsClosedForAccounting(verification) {
  if (!verification) return false;
  if (verification.status === "pass") return true;
  if (!isVerificationRequiredForDone(verification) && ["skipped", "blocked"].includes(verification.status)) return true;
  return false;
}

/**
 * Find an already-recorded verification_command deviation for the same
 * (target, expected, actual) triple. Exposed so verify-run can honor an
 * existing intentional-equivalent justification instead of demanding the
 * agent retype the reason on every re-run.
 * @param {State} state
 * @param {string} targetId
 * @param {string|null|undefined} expectedCommand
 * @param {string} actualCommand
 * @returns {Deviation|null}
 */
function findVerificationCommandDeviation(state, targetId, expectedCommand, actualCommand) {
  return (state.deviations || []).find(entry =>
    entry.type === "verification_command"
    && entry.targetId === targetId
    && entry.details
    && entry.details.expectedCommand === expectedCommand
    && entry.details.actualCommand === actualCommand) || null;
}

/**
 * Record a deviation. Most types are append-only: an approval override or an
 * out-of-order completion is an event whose each occurrence (and its timing)
 * matters to the audit. `verification_command` is the exception: re-running
 * the same equivalent command against the same contract is one fact, not many
 * events - audited runs re-verified across rounds and drowned the deviation
 * report in duplicates of a single substitution. Identical triples therefore
 * collapse into the original entry (original id and summary kept) with an
 * occurrence counter and last-seen timestamp instead of a new row.
 * @param {State} state
 * @param {string} type
 * @param {string} targetId
 * @param {string} summary
 * @param {Object} [details]
 * @returns {Deviation}
 */
function recordDeviation(state, type, targetId, summary, details = {}) {
  if (!state.deviations) state.deviations = [];
  if (type === "verification_command") {
    const existing = findVerificationCommandDeviation(state, targetId, details.expectedCommand, details.actualCommand);
    if (existing) {
      existing.details.occurrences = (existing.details.occurrences || 1) + 1;
      existing.details.lastSeenAt = nowIso();
      return existing;
    }
    details = { ...details, occurrences: 1 };
  }
  const entry = {
    id: `D${state.deviations.length + 1}`,
    ts: nowIso(),
    type,
    targetId,
    summary,
    details,
  };
  state.deviations.push(entry);
  return entry;
}

/**
 * @param {State} state
 * @param {string} reason
 * @returns {ReviewRecord|null}
 */
function markFinalReviewStale(state, reason) {
  if (!state.finalReview || state.finalReview.status !== "pass") return null;
  state.finalReview.status = "stale";
  state.finalReview.staleAt = nowIso();
  state.finalReview.staleReason = reason;
  return state.finalReview;
}

/**
 * @param {State} state
 * @param {string} reason
 * @returns {ReviewRecord|null}
 */
function markRequirementsFidelityReviewStale(state, reason) {
  if (!state.requirementsFidelityReview || state.requirementsFidelityReview.status !== "pass") return null;
  state.requirementsFidelityReview.status = "stale";
  state.requirementsFidelityReview.staleAt = nowIso();
  state.requirementsFidelityReview.staleReason = reason;
  return state.requirementsFidelityReview;
}

/**
 * Move the review record a new recording is about to replace into the run's
 * round log, and return the entry (null when there was nothing to supersede).
 *
 * The failure this closes: every `requirements-review-record` and
 * `review-record` call overwrote a single field, so a run that reviewed five
 * times left exactly one record and the harness could not tell it from a run
 * that reviewed once. In an audited run the agent summoned five adversarial
 * review rounds over 92 minutes and recorded a review ten times, and neither
 * `state.json` nor the receipt held any trace of it (2026-08-11). PRINCIPLES
 * item 13 says a stage that cannot converge on its own needs a bound the
 * harness owns, and a loop the harness cannot see is a loop it cannot bound -
 * so being able to count the rounds is the prerequisite for every bound.
 *
 * Only SUPERSEDED rounds go here; the live round stays in its own field. That
 * keeps item 10 intact: each round is recorded exactly once, in one place, so
 * there is no second ledger to drift from `state.json`. Callers that need the
 * total ask reviewRoundCount, which derives it and stores nothing.
 *
 * A REJECTED recording is not a round and never reaches here: it returns before
 * touching state, which is right - the audited run's ten records included
 * several rejections, one of them for a report-shape rule that no longer exists.
 *
 * What this log deliberately does NOT decide is where one round ends and the
 * next begins. Measured on the same run, the ten records form five clusters
 * whose boundaries line up exactly with the five adversarial reviewer spawns,
 * but two accepted records 23 seconds apart carried different report content
 * inside ONE cluster - so neither the timestamps nor `reportSha256` separate "a
 * new round" from "the same round's report, corrected". Splitting them needs the
 * question "did anything other than the report change since the last accepted
 * record", whose material is the review's pinned input set. Until that pin
 * exists, this records every accepted round with its time and hash and leaves
 * the grouping to the reader (item 7: the harness records what it can observe
 * and does not guess meaning).
 *
 * @param {State} state
 * @param {"fidelity"|"final"} kind
 */
function supersedeReviewRound(state, kind) {
  const field = kind === "fidelity" ? "requirementsFidelityReview" : "finalReview";
  const current = state[field];
  if (!current) return null;
  if (!Array.isArray(state.supersededReviews)) state.supersededReviews = [];
  const entry = {
    kind,
    status: current.status,
    reportPath: current.reportPath || null,
    reportSha256: current.reportSha256 || null,
    recordedAt: current.recordedAt || null,
    supersededAt: nowIso(),
    ...(current.staleReason ? { staleReason: current.staleReason } : {}),
  };
  state.supersededReviews.push(entry);
  return entry;
}

/**
 * How many review rounds this run has spent, derived - never stored, so it
 * cannot drift from the record it counts (item 10). A round is one recorded
 * review: the superseded ones plus the live one, per axis.
 *
 * `distinctReports` counts unique report hashes, which separates "reviewed five
 * times" from "recorded the same document five times" and nothing more. It is
 * NOT a round-boundary signal: measured, one review round produced two
 * different reports within 23 seconds.
 *
 * @param {State} state
 */
/**
 * The bound PRINCIPLES item 13 requires on the review loop, in rounds.
 *
 * A test suite converges; a fresh adversarial reviewer does not - handed any
 * codebase it produces findings - so "re-review whenever anything changed" has
 * no fixed point and the only brake was the agent deciding to stop. Item 13
 * names three admissible bounds (a delta contract, a severity floor, an explicit
 * round cap); this is the third, and it is the one that needs nothing from the
 * documents the human and the reviewer write.
 *
 * Four, from the arithmetic of an honest run: a high-risk profile records two
 * rounds for one clean pass (fidelity, then final), and four leaves room for one
 * complete redo after a reviewer finds something real. The audited run recorded
 * ten across five reviewer rounds and its last two rounds returned only LOW
 * items, so a cap here would have ended it after the second cluster and saved
 * roughly 70 of those 92 minutes (2026-08-11).
 *
 * Not a config knob on purpose (item 7: the harness absorbs complexity, it does
 * not hand the workflow user another dial), and deliberately NOT a refusal - see
 * reviewRoundCapReached.
 */
const REVIEW_ROUND_CAP = 4;

/**
 * Has the autonomous review loop reached its bound?
 *
 * This redirects; it never blocks. Reaching the cap does not fail a command, add
 * a completion blocker, or suppress a staleness rule - a review that is
 * genuinely stale still has to be re-recorded, because the cap bounds a loop, it
 * does not license a receipt built on a dead review. What it does is tell the
 * agent, at the moment it just recorded a round, that further adversarial rounds
 * are not part of the autonomous flow: carry what is left into the receipt as
 * follow-up items instead. Recording an open LOW finding is more honest than a
 * fifth round that pretends to close it (item 10).
 *
 * A refusal here would be the wrong shape twice over: it would trap a run whose
 * review really must be re-recorded, and a cap that can strand a run is a worse
 * failure than the loop it bounds. A user who asks for another round always gets
 * one - same rule as the verify retry budget, where the bound stops the
 * autonomous loop and never the human.
 *
 * @param {State} state
 */
function reviewRoundCapReached(state) {
  return reviewRoundCount(state).total >= REVIEW_ROUND_CAP;
}

/**
 * The redirect to hand the agent once the bound is reached, or null before it.
 *
 * Lives next to the cap so the wording and the number cannot disagree, and says
 * the two things the agent has to act on: stop summoning rounds, and put what is
 * left in the receipt rather than dropping it. It names the user escape for the
 * same reason the retry budget does - the bound stops the autonomous loop, never
 * a human who asks for one more round.
 *
 * @param {State} state
 */
function reviewRoundCapNotice(state) {
  const rounds = reviewRoundCount(state);
  if (!rounds.capReached) return null;
  return `Review round cap reached: ${rounds.total} of ${rounds.cap} recorded rounds `
    + `(requirements fidelity ${rounds.fidelity.rounds}, final ${rounds.final.rounds}). `
    + `Do not summon another adversarial review round on your own - a fresh reviewer produces findings on any codebase, so this loop has no fixed point of its own. `
    + `Finish the findings you already have: fix what blocks the acceptance criteria, and record every remaining advisory finding as a follow-up item in the receipt instead of opening a round to close it. `
    + `An open finding written down is more honest than a round that pretends to close it. `
    + `If the USER asks for another review round, run it - this bounds the autonomous loop, not them.`;
}

function reviewRoundCount(state) {
  const superseded = Array.isArray(state.supersededReviews) ? state.supersededReviews : [];
  const count = kind => {
    const field = kind === "fidelity" ? "requirementsFidelityReview" : "finalReview";
    const past = superseded.filter(entry => entry && entry.kind === kind);
    const live = state[field] ? 1 : 0;
    const hashes = new Set([
      ...past.map(entry => entry.reportSha256).filter(Boolean),
      ...(state[field] && state[field].reportSha256 ? [state[field].reportSha256] : []),
    ]);
    return { rounds: past.length + live, distinctReports: hashes.size };
  };
  const fidelity = count("fidelity");
  const final = count("final");
  const total = fidelity.rounds + final.rounds;
  return {
    fidelity,
    final,
    total,
    cap: REVIEW_ROUND_CAP,
    // Reported with the counts so no consumer re-derives the comparison and
    // drifts from it; see reviewRoundCapReached for why this redirects and
    // never blocks.
    capReached: total >= REVIEW_ROUND_CAP,
  };
}

/**
 * @param {State} state
 * @param {string} reason
 */
function markCompletionReviewsStale(state, reason) {
  markRequirementsFidelityReviewStale(state, reason);
  markFinalReviewStale(state, reason);
}

/**
 * @param {State} state
 * @param {string} id
 * @param {string|null} [preferredKind]
 */
function findTrackedItem(state, id, preferredKind = null) {
  const normalized = String(id || "").toUpperCase();
  const groups = [
    { kind: "task", list: state.tasks || [] },
    { kind: "ac", list: state.acceptanceCriteria || [] },
    { kind: "verification", list: state.verification || [] },
  ];
  const searchGroups = preferredKind ? groups.filter(group => group.kind === preferredKind) : groups;
  for (const group of searchGroups) {
    const item = group.list.find(entry => String(entry.id).toUpperCase() === normalized);
    if (item) return { kind: group.kind, item };
  }
  return null;
}

/** @param {State} state */
function countState(state) {
  const tasksOpen = state.tasks.filter(item => !["complete", "deferred", "blocked"].includes(item.status)).length;
  const acOpen = state.acceptanceCriteria.filter(item => !["met", "not_met", "blocked"].includes(item.status)).length;
  const verificationOpen = state.verification.filter(item => !verificationIsClosedForAccounting(item)).length;
  const blocked = {
    tasks: state.tasks.filter(item => item.status === "blocked").length,
    acceptanceCriteria: state.acceptanceCriteria.filter(item => item.status === "blocked" || item.status === "not_met").length,
    verification: state.verification.filter(item => item.status === "blocked" || item.status === "fail").length,
    requiredVerification: state.verification.filter(item => isVerificationRequiredForDone(item) && item.status !== "pass").length,
  };
  return {
    tasksOpen,
    acOpen,
    verificationOpen,
    totalOpen: tasksOpen + acOpen + verificationOpen,
    blocked,
    requiredVerificationNotPassed: blocked.requiredVerification,
  };
}

/**
 * Auto-close acceptance criteria whose entire verification coverage is
 * settled. An AC's runtime status is derivable bookkeeping: the PRD contract
 * (enforced by prelint) maps every AC to covering V rows, and the real
 * guarantees are the covering V passes plus the judge gate - a manual
 * `mark ac met` after the covering V passed only re-states what the harness
 * already knows, and forgetting it is what the acceptance sweep existed to
 * catch. Deriving the close removes that ceremony and the sweep leftovers.
 *
 * Conservative rule: only `pending` ACs close (a manual met/not_met/blocked
 * judgment is never overridden), every covering verification must be closed
 * for accounting, and at least one must be a pass.
 * @param {State} state
 * @returns {string[]} ids of ACs closed by this call
 */
function autoCloseAcceptanceCriteria(state) {
  const plan = state.verificationPlan;
  if (!plan || !plan.coverage) return [];
  const checksById = new Map((plan.checks || []).map(check => [check.id, check]));
  const verificationById = new Map((state.verification || []).map(item => [item.id, item]));
  const closed = [];
  for (const ac of state.acceptanceCriteria || []) {
    if (ac.status !== "pending") continue;
    // Oracle-backed ACs never auto-close on V coverage: oracle-run is their
    // only path to met. Incidental coverage (a V row that happens to name the
    // AC) used to auto-met an oracle AC without its declared check ever
    // running - the exact bypass the oracle grammar exists to prevent, and
    // finalize now rejects the resulting met as evidence-free anyway.
    if (ac.oracle && typeof ac.oracle === "object") continue;
    const coveredBy = (plan.coverage[ac.id] && plan.coverage[ac.id].coveredBy) || [];
    if (!coveredBy.length) continue;
    const covering = coveredBy.map(checkId => {
      const check = checksById.get(checkId);
      return check ? verificationById.get(check.verificationId) : null;
    });
    if (covering.some(item => !item)) continue;
    if (!covering.every(item => verificationIsClosedForAccounting(item))) continue;
    const passes = covering.filter(item => item.status === "pass");
    if (!passes.length) continue;
    ac.status = "met";
    ac.evidence.push({
      ts: nowIso(),
      text: `Auto-met: covering verification ${passes.map(item => item.id).join(", ")} passed (harness-derived)`,
    });
    closed.push(ac.id);
  }
  return closed;
}

/**
 * Per-verification rehearsal history from the PostToolUse observer's
 * rehearsals.jsonl (side-door Bash runs of contract commands - see
 * runPostToolUseHook). This is the signal countState cannot give: a required
 * check whose entire history is green never demonstrated it can fail.
 * @param {string} statePath
 */
function rehearsalSummary(statePath) {
  const file = path.join(path.dirname(statePath), "rehearsals.jsonl");
  if (!fs.existsSync(file)) return { recorded: false, byVerification: {} };
  /** @type {Record<string, {runs: number, failures: number, unknown: number, lastExitCode: number|null}>} */
  const byVerification = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const id = String(entry.verificationId || "").toUpperCase();
    if (!id) continue;
    const bucket = byVerification[id] || (byVerification[id] = { runs: 0, failures: 0, unknown: 0, lastExitCode: null });
    bucket.runs += 1;
    if (typeof entry.exitCode === "number") {
      if (entry.exitCode !== 0) bucket.failures += 1;
      bucket.lastExitCode = entry.exitCode;
    } else {
      bucket.unknown += 1;
    }
  }
  return { recorded: true, byVerification };
}

/** @param {State} state */
function reviewProfileName(state) {
  const profile = state && state.reviewProfile && typeof state.reviewProfile.profile === "string"
    ? state.reviewProfile.profile
    : "";
  return ["trivial", "standard", "high-risk"].includes(profile) ? profile : "standard";
}

// Only `high-risk` carries a required final adversarial review; trivial and
// standard finalize on the requirements fidelity review alone.
/** @param {State} state */
function finalReviewRequiredForState(state) {
  return reviewProfileName(state) === "high-risk";
}

// `standard` is the one profile whose fidelity review must come from a fresh
// independent reviewer rather than the main agent.
/** @param {State} state */
function independentFidelityRequiredForState(state) {
  return reviewProfileName(state) === "standard";
}

/** @param {State} state */
function effectiveReviewPolicy(state) {
  const profile = reviewProfileName(state);
  return {
    profile,
    fidelityOwner: independentFidelityRequiredForState(state) ? "independent" : "main-agent",
    fidelityDepth: profile === "trivial" ? "compact" : "full",
    finalReviewRequired: finalReviewRequiredForState(state),
  };
}

/** @param {State} state */
function verificationPlanSummary(state) {
  const plan = state.verificationPlan;
  if (!plan) {
    return {
      status: "missing",
      checkCount: 0,
      blockingGapCount: 1,
      warningCount: 0,
    };
  }
  const gaps = plan.gaps || [];
  return {
    status: plan.status || "unknown",
    checkCount: (plan.checks || []).length,
    blockingGapCount: gaps.filter(gap => gap.severity === "blocking").length,
    warningCount: gaps.filter(gap => gap.severity !== "blocking").length,
    generatedAt: plan.generatedAt,
  };
}

/** @param {State} state */
function verificationPlanBlocksImplementation(state) {
  const summary = verificationPlanSummary(state);
  return summary.status === "missing" || summary.blockingGapCount > 0;
}

/** @param {State} state */
function executionPlanSummary(state) {
  const plan = state.executionPlan;
  if (!plan) {
    return {
      status: "missing",
      taskCount: 0,
      openTaskCount: 1,
      blockingGapCount: 1,
      warningCount: 0,
    };
  }
  const tasks = state.tasks || [];
  const gaps = plan.gaps || [];
  return {
    status: plan.status || "unknown",
    taskCount: tasks.length,
    openTaskCount: tasks.filter(task => !["complete", "blocked", "deferred"].includes(task.status)).length,
    blockingGapCount: gaps.filter(gap => gap.severity === "blocking").length,
    warningCount: gaps.filter(gap => gap.severity !== "blocking").length,
    generatedAt: plan.generatedAt,
  };
}

/** @param {State} state */
function executionPlanBlocksImplementation(state) {
  const summary = executionPlanSummary(state);
  return summary.status === "missing" || summary.blockingGapCount > 0;
}

/** @param {State} state */
function latestEvidenceTimestamp(state) {
  /** @type {{time: number, label: string}|null} */
  let latest = null;
  /** @type {(value: string|undefined, label: string) => void} */
  const consider = (value, label) => {
    const time = Date.parse(value || "");
    if (!Number.isFinite(time)) return;
    if (!latest || time > latest.time) latest = { time, label };
  };
  /** @type {Array<[string, Array<import("./types").TrackedItem|import("./types").VerificationItem>]>} */
  const groups = [
    ["task", state.tasks || []],
    ["acceptance", state.acceptanceCriteria || []],
    ["verification", state.verification || []],
  ];
  for (const [kind, items] of groups) {
    for (const item of items) {
      for (const entry of item.evidence || []) consider(entry.ts, `${kind} ${item.id} evidence`);
      for (const artifact of item.artifacts || []) consider(artifact.createdAt, `${kind} ${item.id} artifact`);
    }
  }
  for (const deviation of state.deviations || []) consider(deviation.ts, `deviation ${deviation.id}`);
  return latest;
}

module.exports = {
  isVerificationRequiredForDone,
  verificationIsClosedForAccounting,
  findVerificationCommandDeviation,
  recordDeviation,
  markFinalReviewStale,
  markRequirementsFidelityReviewStale,
  markCompletionReviewsStale,
  supersedeReviewRound,
  reviewRoundCount,
  reviewRoundCapReached,
  reviewRoundCapNotice,
  REVIEW_ROUND_CAP,
  findTrackedItem,
  countState,
  autoCloseAcceptanceCriteria,
  rehearsalSummary,
  reviewProfileName,
  finalReviewRequiredForState,
  independentFidelityRequiredForState,
  effectiveReviewPolicy,
  verificationPlanSummary,
  verificationPlanBlocksImplementation,
  executionPlanSummary,
  executionPlanBlocksImplementation,
  latestEvidenceTimestamp,
};
