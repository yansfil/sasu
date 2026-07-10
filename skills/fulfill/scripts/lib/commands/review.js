"use strict";

const path = require("path");

const { nowIso, cwd, resolveProjectPath, toProjectRelative, writeJson, appendJsonl, simpleHash } = require("../util");
const { worktreeSnapshot } = require("../git");
const { isVerificationRequiredForDone, executionPlanSummary, countState, reviewProfileName } = require("../state_data");
const { taskGraphSummary, readyExecutionPlan, rollupTasksFromExecutionPlan, nextItem } = require("../planning");
const { collectArtifacts, inspectArtifact } = require("../artifacts");
const { assertFinalReviewReport, assertRequirementsFidelityReport, validateArtifacts, completionViolations, requirementsFidelityHandoffViolations } = require("../reviews");
const { writeImplementationReport, renderRequirementsReviewPrompt, renderReviewPrompt } = require("../render");
const { loadState, syncActive, persistStateAndArtifacts } = require("../state_store");
const { loadPending } = require("../rules");

function cmdReviewPrompt(options) {
  const { statePath, state } = loadState(options);
  const reportPath = path.join(state.projectRoot || cwd(), state.runDir, "review", "final-review.md");
  process.stdout.write(renderReviewPrompt({
    state,
    statePath: toProjectRelative(statePath, state.projectRoot || cwd()),
    reportPath,
  }));
}

function cmdRequirementsReviewPrompt(options) {
  const { statePath, state } = loadState(options);
  const reportPath = path.join(state.projectRoot || cwd(), state.runDir, "review", "requirements-fidelity-review.md");
  process.stdout.write(renderRequirementsReviewPrompt({
    state,
    statePath: toProjectRelative(statePath, state.projectRoot || cwd()),
    reportPath,
  }));
}

function cmdRequirementsReviewRecord(options) {
  const status = String(options.status || "");
  const reportInput = String(options.report || "");
  const summary = String(options.summary || "").trim();
  if (!["pass", "fail"].includes(status)) throw new Error("--status must be pass or fail");
  if (!reportInput) throw new Error("--report is required");
  if (!summary) throw new Error("--summary is required");
  const { statePath, state } = loadState(options);
  const reportAbs = resolveProjectPath(reportInput, state.projectRoot || cwd());
  const info = inspectArtifact(reportAbs, "log");
  assertRequirementsFidelityReport(reportAbs, status, state);
  const reportPath = toProjectRelative(reportAbs, state.projectRoot || cwd());

  if (status === "pass") {
    const violations = completionViolations(statePath, state, {
      includeRequirementsFidelityReview: false,
      includeFinalReview: false,
    }).filter(violation => violation !== "Requirements fidelity review report hash changed");
    if (violations.length) {
      process.stdout.write(JSON.stringify({ ok: false, status: "rejected", violations }, null, 2) + "\n");
      process.exitCode = 2;
      return;
    }
  }

  state.requirementsFidelityReview = {
    status,
    summary,
    reportPath,
    reportBytes: info.bytes,
    reportSha256: info.sha256,
    worktreeSnapshot: worktreeSnapshot(state),
    recordedAt: nowIso(),
  };
  state.finalReview = null;
  state.updatedAt = nowIso();
  persistStateAndArtifacts(statePath, state);
  appendJsonl(path.join(path.dirname(statePath), "ledger.jsonl"), {
    ts: nowIso(),
    event: "requirements_fidelity_review_recorded",
    review: state.requirementsFidelityReview,
  });
  syncActive(statePath, state);
  process.stdout.write(JSON.stringify({
    ok: true,
    requirementsFidelityReview: state.requirementsFidelityReview,
    finalReview: state.finalReview,
    counts: countState(state),
    executionPlan: executionPlanSummary(state),
    ready: readyExecutionPlan(state),
    taskGraph: taskGraphSummary(state),
    next: nextItem(state),
  }, null, 2) + "\n");
}

function cmdReviewRecord(options) {
  const status = String(options.status || "");
  const reportInput = String(options.report || "");
  const summary = String(options.summary || "").trim();
  if (!["pass", "fail"].includes(status)) throw new Error("--status must be pass or fail");
  if (!reportInput) throw new Error("--report is required");
  if (!summary) throw new Error("--summary is required");
  const { statePath, state } = loadState(options);
  const reportAbs = resolveProjectPath(reportInput, state.projectRoot || cwd());
  const info = inspectArtifact(reportAbs, "log");
  assertFinalReviewReport(reportAbs, status, state);
  const reportPath = toProjectRelative(reportAbs, state.projectRoot || cwd());

  if (status === "pass") {
    const violations = completionViolations(statePath, state, { includeFinalReview: false });
    if (violations.length) {
      process.stdout.write(JSON.stringify({ ok: false, status: "rejected", violations }, null, 2) + "\n");
      process.exitCode = 2;
      return;
    }
  }

  state.finalReview = {
    status,
    summary,
    reportPath,
    reportBytes: info.bytes,
    reportSha256: info.sha256,
    worktreeSnapshot: worktreeSnapshot(state),
    recordedAt: nowIso(),
  };
  state.updatedAt = nowIso();
  persistStateAndArtifacts(statePath, state);
  appendJsonl(path.join(path.dirname(statePath), "ledger.jsonl"), {
    ts: nowIso(),
    event: "final_review_recorded",
    review: state.finalReview,
  });
  syncActive(statePath, state);
  process.stdout.write(JSON.stringify({
    ok: true,
    finalReview: state.finalReview,
    counts: countState(state),
    executionPlan: executionPlanSummary(state),
    ready: readyExecutionPlan(state),
    taskGraph: taskGraphSummary(state),
    next: nextItem(state),
  }, null, 2) + "\n");
}

function cmdFinalize(options) {
  const status = String(options.status || "");
  const summary = String(options.summary || "").trim();
  if (!["complete", "partial", "blocked"].includes(status)) throw new Error("--status must be complete, partial, or blocked");
  if (!summary) throw new Error("--summary is required");
  const { statePath, state } = loadState(options);
  rollupTasksFromExecutionPlan(state, { recordEvidence: false });
  const counts = countState(state);
  const violations = [];
  if (status === "complete") {
    violations.push(...completionViolations(statePath, state, { includeFinalReview: true }));
  } else {
    violations.push(...requirementsFidelityHandoffViolations(state));
    const blockers = [
      ...state.tasks.filter(item => item.status === "blocked"),
      ...state.acceptanceCriteria.filter(item => item.status === "blocked" || item.status === "not_met"),
      ...state.verification.filter(item => item.status === "blocked" || item.status === "fail"),
    ];
    if (status === "blocked" && blockers.length === 0) {
      violations.push("Blocked finalization requires at least one task, acceptance, or verification item marked blocked/fail/not_met");
    }
    for (const blocker of blockers) {
      if (!blocker.evidence.length) violations.push(`Blocked item ${blocker.id} has no evidence`);
    }
    if (status === "partial") {
      const completed = [
        ...((state.executionPlan && state.executionPlan.nodes) || []).filter(item => item.status === "complete" && item.evidence && item.evidence.length),
        ...state.tasks.filter(item => item.status === "complete" && item.evidence.length),
        ...state.acceptanceCriteria.filter(item => item.status === "met" && item.evidence.length),
        ...state.verification.filter(item => item.status === "pass" && item.evidence.length),
      ];
      const incomplete = [
        ...((state.executionPlan && state.executionPlan.nodes) || []).filter(item => item.status !== "complete"),
        ...state.tasks.filter(item => item.status !== "complete"),
        ...state.acceptanceCriteria.filter(item => item.status !== "met"),
        ...state.verification.filter(item => isVerificationRequiredForDone(item) && item.status !== "pass"),
      ];
      if (completed.length === 0) violations.push("Partial finalization requires at least one completed, evidenced implementation/AC/verification item");
      if (incomplete.length === 0) violations.push("Partial finalization requires at least one incomplete, blocked, failed, or not-met tracked item");
    }
    violations.push(...validateArtifacts(statePath, state));
  }
  const uniqueViolations = Array.from(new Set(violations));
  if (uniqueViolations.length) {
    process.stdout.write(JSON.stringify({ ok: false, status: "rejected", violations: uniqueViolations }, null, 2) + "\n");
    process.exitCode = 2;
    return;
  }

  state.status = status;
  state.updatedAt = nowIso();
  const receipt = {
    schema: "hoyeon.prd-implement.receipt.v1",
    status,
    summary,
    verifiedAt: nowIso(),
    reviewProfile: state.reviewProfile || { profile: reviewProfileName(state), source: "default" },
    counts,
    delivery: state.delivery || null,
    worktreeSnapshot: worktreeSnapshot(state),
    executionPlan: executionPlanSummary(state),
    taskGraph: null,
    artifactCount: collectArtifacts(state).length,
    requirementsFidelityReview: state.requirementsFidelityReview,
    finalReview: state.finalReview,
    evidenceHash: simpleHash(JSON.stringify({
      tasks: state.tasks,
      executionPlan: state.executionPlan,
      acceptanceCriteria: state.acceptanceCriteria,
      verification: state.verification,
      requirementsFidelityReview: state.requirementsFidelityReview,
      finalReview: state.finalReview,
      artifacts: collectArtifacts(state),
    })),
  };
  state.finalReceipt = receipt;
  receipt.taskGraph = taskGraphSummary(state);
  persistStateAndArtifacts(statePath, state);
  state.finalReceipt.taskGraph = taskGraphSummary(state);
  writeJson(statePath, state);
  writeJson(path.join(path.dirname(statePath), "receipt.json"), receipt);
  writeImplementationReport(statePath, state);
  appendJsonl(path.join(path.dirname(statePath), "ledger.jsonl"), {
    ts: nowIso(),
    event: "finalized",
    status,
    receipt,
  });
  syncActive(statePath, state);
  process.stdout.write(JSON.stringify({
    ok: true,
    status,
    receiptPath: toProjectRelative(path.join(path.dirname(statePath), "receipt.json")),
    reportPath: toProjectRelative(path.join(path.dirname(statePath), "implementation-result.md")),
    rememberSuggestions: rememberSuggestions(state),
  }, null, 2) + "\n");
}

// Post-receipt learning nudge (R13 of the agents-remember contract): the
// deviations recorded during this run are the raw material for `remember`.
// Recurring types are invariant candidates; one-offs are still worth a fact.
function rememberSuggestions(state) {
  const suggestions = [];
  const byType = new Map();
  for (const deviation of state.deviations || []) {
    if (!byType.has(deviation.type)) byType.set(deviation.type, []);
    byType.get(deviation.type).push(deviation);
  }
  for (const [type, items] of byType) {
    if (items.length >= 2) {
      suggestions.push(`Deviation type '${type}' recurred ${items.length}x (${items.map(item => item.id).join(", ")}): consider /remember as an invariant with a trigger and check.`);
    }
  }
  if (suggestions.length === 0 && (state.deviations || []).length > 0) {
    suggestions.push(`${state.deviations.length} deviation(s) recorded this run: skim them for a lesson worth landing via /remember (fact, invariant, or regression test).`);
  }
  try {
    const pending = loadPending(state.projectRoot || cwd());
    if (pending.length > 0) {
      suggestions.push(`agents/rules/pending/ still holds ${pending.length} unlanded lesson(s): ${pending.map(item => item.id).join(", ")}.`);
    }
  } catch {
    // Unreadable rules tree is doctor's problem, not finalize's.
  }
  return suggestions;
}

module.exports = {
  cmdReviewPrompt,
  cmdRequirementsReviewPrompt,
  cmdRequirementsReviewRecord,
  cmdReviewRecord,
  cmdFinalize,
};
