"use strict";

const fs = require("fs");
const path = require("path");

const { SELF_PATH, nowIso, cwd, resolveProjectPath, toProjectRelative, appendJsonl, sha256Text, slugFromPrdPath, runDirRelFor, formatCommandArgs } = require("../util");
const { markCompletionReviewsStale, verificationPlanSummary, executionPlanSummary } = require("../state_data");
const { stripFrontmatter } = require("../prd_parser");
const { parsePrdContract } = require("./init");
const { buildVerificationPlan, buildExecutionPlan, readyExecutionPlan, nextItem } = require("../planning");
const { loadState, syncActive, persistState } = require("../state_store");
const { renderViews } = require("../render");
const { invariantsForWriteScopes } = require("../rules");

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
  if (state.executionPlan) state.executionPlan = buildExecutionPlan(state, statePath);
  markCompletionReviewsStale(state, "Verification plan was regenerated after review");
  state.updatedAt = nowIso();
  persistState(statePath, state);
  renderViews(statePath, state);
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
    executionPlan: executionPlanSummary(state),
    ready: readyExecutionPlan(state),
    planPath: toProjectRelative(path.join(path.dirname(statePath), "verification-plan.json"), state.projectRoot || cwd()),
    planMarkdownPath: toProjectRelative(path.join(path.dirname(statePath), "verification-plan.md"), state.projectRoot || cwd()),
    next: nextItem(state),
  }, null, 2) + "\n");
}

function cmdPlanExecution(options) {
  const { statePath, state } = loadState(options);
  const taskPlanInput = readTaskPlanInput(options, state);
  state.executionPlan = buildExecutionPlan(state, statePath, taskPlanInput ? taskPlanInput.tasks : null);
  const injectedRules = injectRuleVerification(state);
  if (injectedRules.length && state.verificationPlan) {
    state.verificationPlan = buildVerificationPlan(state, statePath);
    state.executionPlan = buildExecutionPlan(state, statePath, taskPlanInput ? taskPlanInput.tasks : null);
  }
  markCompletionReviewsStale(state, "Execution plan was regenerated after review");
  state.updatedAt = nowIso();
  persistState(statePath, state);
  renderViews(statePath, state);
  appendJsonl(path.join(path.dirname(statePath), "ledger.jsonl"), {
    ts: nowIso(),
    event: "execution_plan_generated",
    status: state.executionPlan.status,
    taskCount: (state.tasks || []).length,
    gapCount: state.executionPlan.gaps.length,
    taskPlanSource: taskPlanInput ? taskPlanInput.path : null,
    injectedRules: injectedRules.map(item => item.sourceRuleId),
  });
  syncActive(statePath, state);
  process.stdout.write(JSON.stringify({
    ok: true,
    statePath: toProjectRelative(statePath),
    executionPlan: executionPlanSummary(state),
    ready: readyExecutionPlan(state),
    taskPlanSource: taskPlanInput ? taskPlanInput.path : null,
    injectedRules: injectedRules.map(item => ({ id: item.id, rule: item.sourceRuleId, title: item.title })),
    planPath: toProjectRelative(path.join(path.dirname(statePath), "execution-plan.json"), state.projectRoot || cwd()),
    planMarkdownPath: toProjectRelative(path.join(path.dirname(statePath), "execution-plan.md"), state.projectRoot || cwd()),
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

// Best-effort learned-rule injection (R11 of the agents-remember contract):
// invariants whose triggers prefix-overlap any task write scope become
// verification items, so passing them is part of the receipt. The exact,
// changed-file-based enforcement stays with the ship gate; this match is
// conservative and says so in the injected item text.
function injectRuleVerification(state) {
  const projectRoot = state.projectRoot || cwd();
  const tasks = state.tasks || [];
  const scopes = tasks
    .flatMap(task => Array.isArray(task.writeScope) ? task.writeScope : [])
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
    const coveredTasks = tasks
      .filter(task => {
        try {
          return invariantsForWriteScopes(projectRoot, task.writeScope || [])
            .some(candidate => candidate.id === rule.id);
        } catch {
          return false;
        }
      })
      .map(task => task.id)
      .filter(Boolean);
    const nextIndex = state.verification.filter(item => item.source === "rules_injection").length + 1;
    const manual = rule.check.type === "manual";
    const method = rule.check.type === "command"
      ? rule.check.run
      : rule.check.type === "grep"
        ? formatCommandArgs([
          process.execPath,
          SELF_PATH,
          "rules",
          "check",
          "--id",
          rule.id,
          "--all",
        ])
        : `human confirmation: ${rule.check.confirm}`;
    const item = {
      id: `RV${nextIndex}`,
      level: "rule",
      title: `Learned invariant ${rule.id}`,
      text: `${rule.summary} (auto-injected: write scope overlaps trigger ${rule.trigger.paths.join(", ")}; full targeted check required, changed files rechecked at deliver)`,
      status: "pending",
      evidence: [],
      artifacts: [],
      source: "rules_injection",
      sourceRuleId: rule.id,
      testMode: manual ? "human" : "build/static",
      matrix: {
        mode: manual ? "human" : "build/static",
        covers: coveredTasks.length ? coveredTasks.join(", ") : rule.id,
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
  readTaskPlanInput,
};
