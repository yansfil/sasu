"use strict";

const fs = require("fs");
const path = require("path");

const { nowIso, cwd, resolveProjectPath, toProjectRelative, appendJsonl, sha256Text, slugFromPrdPath, runDirRelFor } = require("../util");
const { markCompletionReviewsStale, verificationPlanSummary, executionPlanSummary } = require("../state_data");
const { stripFrontmatter, extractFirstSection, extractFirstNestedSection, parseMarkdownItems, parseVerification, parseTestModeContract, applyTestModeDefaults } = require("../prd_parser");
const { taskGraphSummary, buildVerificationPlan, buildExecutionPlan, readyExecutionPlan, rollupTasksFromExecutionPlan, nextItem } = require("../planning");
const { loadState, syncActive, persistStateAndArtifacts } = require("../state_store");

function cmdPlanVerificationCheck(options) {
  const projectRoot = cwd();
  const prdAbs = resolveProjectPath(String(options.prd), projectRoot);
  if (!fs.existsSync(prdAbs)) throw new Error(`PRD not found: ${prdAbs}`);
  const prdText = fs.readFileSync(prdAbs, "utf8");
  const parsed = stripFrontmatter(prdText);

  const tasks = parseMarkdownItems(extractFirstSection(parsed.body, [
    "8. PRD-Level Tasks",
    "PRD-Level Tasks",
    "13. Tasks",
    "Tasks",
  ]), "T", "Task");
  const acceptanceCriteria = parseMarkdownItems(extractFirstSection(parsed.body, [
    "7. Acceptance Criteria",
    "Acceptance Criteria",
    "12. Acceptance Criteria",
  ]), "AC", "AC");
  const requirements = parseMarkdownItems(extractFirstSection(parsed.body, [
    "6. Requirements",
    "Requirements",
  ]), "R", "R");
  const verificationSection = extractFirstSection(parsed.body, [
    "9. Verification Contract",
    "Verification Contract",
    "5. Verification - Agent",
    "Verification - Agent",
  ]);
  const verification = parseVerification(verificationSection);
  const testModeSection = extractFirstNestedSection(verificationSection, [
    "9.1 Test Mode Contract",
    "Test Mode Contract",
  ]);
  const testModeContract = parseTestModeContract(testModeSection || verificationSection);
  applyTestModeDefaults(verification, testModeContract);

  const syntheticState = {
    projectRoot,
    prdPath: toProjectRelative(prdAbs, projectRoot),
    prdSnapshot: { sha256: sha256Text(prdText) },
    tasks,
    acceptanceCriteria,
    requirements,
    verification,
    testModeContract,
  };
  const plan = buildVerificationPlan(
    syntheticState,
    path.join(projectRoot, runDirRelFor(slugFromPrdPath(prdAbs)), "state.json"),
  );
  const blocking = plan.gaps.filter(gap => gap.severity === "blocking");
  process.stdout.write(JSON.stringify({
    ok: blocking.length === 0,
    mode: "prd-precheck",
    prdPath: syntheticState.prdPath,
    parsed: {
      taskCount: tasks.length,
      acceptanceCriteriaCount: acceptanceCriteria.length,
      verificationCount: verification.length,
      testModeCount: testModeContract.length,
    },
    status: plan.status,
    checkCount: plan.checks.length,
    blockingGaps: blocking,
    warnings: plan.gaps.filter(gap => gap.severity !== "blocking"),
    note: blocking.length
      ? "The PRD verification contract is not harness-ready. Fix the PRD (Method/Artifact/Pass Intent, coverage, artifact strategy) before approval; init/plan-verification would block on these gaps."
      : "PRD verification contract is harness-ready; plan-verification after init should produce a ready plan.",
  }, null, 2) + "\n");
  if (blocking.length) process.exitCode = 2;
}

function cmdPlanVerification(options) {
  if (options.prd) return cmdPlanVerificationCheck(options);
  const { statePath, state } = loadState(options);
	  state.verificationPlan = buildVerificationPlan(state, statePath);
	  if (state.executionPlan) {
	    state.executionPlan = buildExecutionPlan(state, statePath);
	    rollupTasksFromExecutionPlan(state);
	  }
	  markCompletionReviewsStale(state, "Verification plan was regenerated after review");
	  state.updatedAt = nowIso();
  persistStateAndArtifacts(statePath, state);
  appendJsonl(path.join(path.dirname(statePath), "ledger.jsonl"), {
    ts: nowIso(),
    event: "verification_plan_generated",
    status: state.verificationPlan.status,
    checkCount: state.verificationPlan.checks.length,
    gapCount: state.verificationPlan.gaps.length,
    executionPlanRefreshed: Boolean(state.executionPlan),
  });
  syncActive(statePath, state);
  process.stdout.write(JSON.stringify({
    ok: true,
    statePath: toProjectRelative(statePath),
    verificationPlan: verificationPlanSummary(state),
    taskGraph: taskGraphSummary(state),
    executionPlan: executionPlanSummary(state),
    ready: readyExecutionPlan(state),
    planPath: toProjectRelative(path.join(path.dirname(statePath), "verification-plan.json"), state.projectRoot || cwd()),
    planMarkdownPath: toProjectRelative(path.join(path.dirname(statePath), "verification-plan.md"), state.projectRoot || cwd()),
    next: nextItem(state),
  }, null, 2) + "\n");
}

function cmdPlanExecution(options) {
  const { statePath, state } = loadState(options);
	  state.executionPlan = buildExecutionPlan(state, statePath);
	  rollupTasksFromExecutionPlan(state);
	  markCompletionReviewsStale(state, "Execution plan was regenerated after review");
	  state.updatedAt = nowIso();
  persistStateAndArtifacts(statePath, state);
  appendJsonl(path.join(path.dirname(statePath), "ledger.jsonl"), {
    ts: nowIso(),
    event: "execution_plan_generated",
    status: state.executionPlan.status,
    nodeCount: state.executionPlan.nodes.length,
    gapCount: state.executionPlan.gaps.length,
  });
  syncActive(statePath, state);
  process.stdout.write(JSON.stringify({
    ok: true,
    statePath: toProjectRelative(statePath),
    executionPlan: executionPlanSummary(state),
    taskGraph: taskGraphSummary(state),
    ready: readyExecutionPlan(state),
    planPath: toProjectRelative(path.join(path.dirname(statePath), "execution-plan.json"), state.projectRoot || cwd()),
    planMarkdownPath: toProjectRelative(path.join(path.dirname(statePath), "execution-plan.md"), state.projectRoot || cwd()),
    next: nextItem(state),
  }, null, 2) + "\n");
}

module.exports = {
  cmdPlanVerificationCheck,
  cmdPlanVerification,
  cmdPlanExecution,
};
