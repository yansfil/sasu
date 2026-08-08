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
 * @param {State} state
 * @param {string} type
 * @param {string} targetId
 * @param {string} summary
 * @param {Object} [details]
 * @returns {Deviation}
 */
function recordDeviation(state, type, targetId, summary, details = {}) {
  if (!state.deviations) state.deviations = [];
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
  recordDeviation,
  markFinalReviewStale,
  markRequirementsFidelityReviewStale,
  markCompletionReviewsStale,
  findTrackedItem,
  countState,
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
