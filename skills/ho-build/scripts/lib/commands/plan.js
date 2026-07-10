"use strict";

const fs = require("fs");
const path = require("path");

const { nowIso, cwd, resolveProjectPath, toProjectRelative, appendJsonl, sha256Text, slugFromPrdPath, runDirRelFor } = require("../util");
const { markCompletionReviewsStale, verificationPlanSummary, executionPlanSummary } = require("../state_data");
const { stripFrontmatter, extractFirstSection, extractFirstNestedSection, parseMarkdownItems, parseVerification, parseTestModeContract, applyTestModeDefaults } = require("../prd_parser");
const { taskGraphSummary, buildVerificationPlan, buildExecutionPlan, readyExecutionPlan, rollupTasksFromExecutionPlan, nextItem } = require("../planning");
const { loadState, syncActive, persistStateAndArtifacts } = require("../state_store");
const { invariantsForWriteScopes } = require("../rules");

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
	  const injectedRules = injectRuleVerification(state);
	  if (injectedRules.length && state.verificationPlan) {
	    state.verificationPlan = buildVerificationPlan(state, statePath);
	  }
	  markCompletionReviewsStale(state, "Execution plan was regenerated after review");
	  state.updatedAt = nowIso();
  persistStateAndArtifacts(statePath, state);
  appendJsonl(path.join(path.dirname(statePath), "ledger.jsonl"), {
    ts: nowIso(),
    event: "execution_plan_generated",
    status: state.executionPlan.status,
    nodeCount: state.executionPlan.nodes.length,
    gapCount: state.executionPlan.gaps.length,
    injectedRules: injectedRules.map(item => item.sourceRuleId),
  });
  syncActive(statePath, state);
  process.stdout.write(JSON.stringify({
    ok: true,
    statePath: toProjectRelative(statePath),
    executionPlan: executionPlanSummary(state),
    taskGraph: taskGraphSummary(state),
    ready: readyExecutionPlan(state),
    injectedRules: injectedRules.map(item => ({ id: item.id, rule: item.sourceRuleId, title: item.title })),
    planPath: toProjectRelative(path.join(path.dirname(statePath), "execution-plan.json"), state.projectRoot || cwd()),
    planMarkdownPath: toProjectRelative(path.join(path.dirname(statePath), "execution-plan.md"), state.projectRoot || cwd()),
    next: nextItem(state),
  }, null, 2) + "\n");
}

// Best-effort learned-rule injection (R11 of the agents-remember contract):
// invariants whose triggers prefix-overlap any execution write scope become
// verification items, so passing them is part of the receipt. The exact,
// changed-file-based enforcement stays with the deliver gate; this match is
// conservative and says so in the injected item text.
function injectRuleVerification(state) {
  const projectRoot = state.projectRoot || cwd();
  const scopes = (state.executionPlan && state.executionPlan.nodes ? state.executionPlan.nodes : [])
    .flatMap(node => Array.isArray(node.writeScope) ? node.writeScope : [])
    .filter(scope => typeof scope === "string" && !scope.startsWith("TBD:"));
  let matched;
  try {
    matched = invariantsForWriteScopes(projectRoot, scopes);
  } catch {
    // An unreadable rules tree must not block planning; doctor reports it.
    return [];
  }
  const injected = [];
  for (const rule of matched) {
    if (state.verification.some(item => item.sourceRuleId === rule.id)) continue;
    const nextIndex = state.verification.filter(item => item.source === "rules_injection").length + 1;
    const manual = rule.check.type === "manual";
    const method = rule.check.type === "command"
      ? rule.check.run
      : rule.check.type === "grep"
        ? `rules check --files <changed files> (grep ${rule.check.expect || "present"}: ${rule.check.pattern} in ${rule.check.files})`
        : `human confirmation: ${rule.check.confirm}`;
    const item = {
      id: `RV${nextIndex}`,
      level: "rule",
      title: `Learned invariant ${rule.id}`,
      text: `${rule.summary} (auto-injected: write scope overlaps trigger ${rule.trigger.paths.join(", ")}; best-effort match, exact enforcement at deliver)`,
      status: "pending",
      evidence: [],
      artifacts: [],
      source: "rules_injection",
      sourceRuleId: rule.id,
      testMode: manual ? "human" : "build/static",
      matrix: {
        mode: manual ? "human" : "build/static",
        covers: rule.id,
        method,
        artifact: manual ? "none" : "command-log",
        passCriteria: manual ? rule.check.confirm : "check passes (exit 0 / pattern expectation holds)",
        environment: "local shell",
        requiredForDone: !manual,
        requiredForDoneRaw: manual ? "no" : "yes",
        canBeBlocked: manual,
        canBeBlockedRaw: manual ? "yes" : "no",
        safeProbe: "none (local check)",
        liveProof: "command log",
        sideEffect: "none",
        sensitiveDataPolicy: "no secrets",
      },
    };
    state.verification.push(item);
    injected.push(item);
  }
  return injected;
}

module.exports = {
  cmdPlanVerificationCheck,
  cmdPlanVerification,
  cmdPlanExecution,
};
