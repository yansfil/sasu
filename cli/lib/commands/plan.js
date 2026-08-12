"use strict";

const fs = require("fs");
const path = require("path");

const { nowIso, cwd, resolveProjectPath, toProjectRelative, sha256Text, slugFromPrdPath, runDirRelFor } = require("../util");
const { markCompletionReviewsStale, verificationPlanSummary, executionPlanSummary } = require("../state_data");
const { stripFrontmatter, findPrdImplementationBindings } = require("../prd_parser");
const { parsePrdContract } = require("./init");
const { buildVerificationPlan, buildExecutionPlan, applyExecutionPlan, readyExecutionPlan, nextItem } = require("../planning");
const { loadState, syncActive, persistState } = require("../state_store");

function cmdPlanVerificationCheck(options) {
  const projectRoot = cwd();
  const prdAbs = resolveProjectPath(String(options.prd), projectRoot);
  if (!fs.existsSync(prdAbs)) throw new Error(`PRD not found: ${prdAbs}`);
  const prdText = fs.readFileSync(prdAbs, "utf8");
  const parsed = stripFrontmatter(prdText);
  // One parser for both the stateless precheck and init: a PRD this precheck
  // calls harness-ready must parse identically at init time.
  const { tasks, acceptanceCriteria, requirements, verification, testModeContract } = parsePrdContract(parsed, projectRoot);

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
  const bindingDefects = findPrdImplementationBindings(prdText).map(defect => ({
    severity: "blocking",
    phase: "contract",
    code: defect.code,
    item: `line ${defect.line}`,
    message: defect.message,
  }));
  const semanticGaps = [...bindingDefects, ...plan.gaps.filter(gap => gap.phase !== "binding")];
  const blocking = semanticGaps.filter(gap => gap.severity === "blocking");
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
    status: blocking.length ? "needs_review" : "ready",
    checkCount: plan.checks.length,
    blockingGaps: blocking,
    warnings: semanticGaps.filter(gap => gap.severity !== "blocking"),
    deferredBindings: plan.gaps
      .filter(gap => gap.phase === "binding")
      .map(gap => {
        const check = plan.checks.find(candidate => candidate.id === gap.item);
        return {
          verificationId: check ? check.verificationId : gap.item,
          category: check ? check.category : null,
          missing: check && !check.command ? ["command", "cwd"] : [],
          artifactKinds: check ? check.artifactKinds : [],
          bindAt: "first verify-run after implementation creates the verifier",
          message: gap.message,
        };
      }),
    note: blocking.length
      ? "The PRD semantic verification contract is not harness-ready. Fix coverage, mode, pass intent, or safety semantics before approval."
      : "The PRD semantic verification contract is harness-ready. Concrete commands, cwd, and evidence paths are bound from repository reality during implementation.",
  }, null, 2) + "\n");
  if (blocking.length) process.exitCode = 2;
}

function cmdPlanVerification(options) {
  if (options.prd) return cmdPlanVerificationCheck(options);
  const { statePath, state } = loadState(options);
  state.verificationPlan = buildVerificationPlan(state, statePath);
  if (state.executionPlan) state.executionPlan = buildExecutionPlan(state, statePath);
  markCompletionReviewsStale(state, "Verification plan was regenerated after review");
  state.updatedAt = nowIso();
  persistState(statePath, state);
  syncActive(statePath, state);
  process.stdout.write(JSON.stringify({
    ok: true,
    statePath: toProjectRelative(statePath),
    verificationPlan: verificationPlanSummary(state),
    executionPlan: executionPlanSummary(state),
    ready: readyExecutionPlan(state),
    next: nextItem(state),
  }, null, 2) + "\n");
}

function cmdPlanExecution(options) {
  const { statePath, state } = loadState(options);
  const taskPlanInput = readTaskPlanInput(options, state);
  const injectedRules = applyExecutionPlan(state, statePath, taskPlanInput ? taskPlanInput.tasks : null);
  markCompletionReviewsStale(state, "Execution plan was regenerated after review");
  state.updatedAt = nowIso();
  persistState(statePath, state);
  syncActive(statePath, state);
  process.stdout.write(JSON.stringify({
    ok: true,
    statePath: toProjectRelative(statePath),
    executionPlan: executionPlanSummary(state),
    ready: readyExecutionPlan(state),
    taskPlanSource: taskPlanInput ? taskPlanInput.path : null,
    injectedRules: injectedRules.map(item => ({ id: item.id, rule: item.sourceRuleId, title: item.title })),
    next: nextItem(state),
  }, null, 2) + "\n");
}

function readTaskPlanInput(options, state) {
  const inputPath = options["task-plan"];
  if (!inputPath) return null;
  const projectRoot = state.projectRoot || cwd();
  const absolute = resolveProjectPath(String(inputPath), projectRoot);
  if (!fs.existsSync(absolute)) throw new Error(`Task plan not found: ${absolute}`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(absolute, "utf8"));
  } catch (error) {
    throw new Error(`Task plan must contain valid JSON: ${error.message}`);
  }
  const tasks = parsed && parsed.tasks && typeof parsed.tasks === "object" && !Array.isArray(parsed.tasks)
    ? parsed.tasks
    : parsed;
  if (!tasks || typeof tasks !== "object" || Array.isArray(tasks)) {
    throw new Error("Task plan must be an object keyed by PRD task ID, or an object with a tasks map");
  }
  const known = new Set((state.tasks || []).map(task => String(task.id).toUpperCase()));
  for (const id of Object.keys(tasks)) {
    if (!known.has(String(id).toUpperCase())) throw new Error(`Task plan contains unknown PRD task '${id}'`);
  }
  const normalized = Object.fromEntries(Object.entries(tasks).map(([id, entry]) => [String(id).toUpperCase(), entry]));
  return { tasks: normalized, path: toProjectRelative(absolute, projectRoot) };
}

module.exports = {
  cmdPlanVerificationCheck,
  cmdPlanVerification,
  cmdPlanExecution,
  readTaskPlanInput,
};
