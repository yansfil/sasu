"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");

const { PROJECT_CONFIG_PATH, displayPath, shipScriptPath, cwd, resolveProjectPath, toProjectRelative, canonicalPath, readJson } = require("../util");
const { gitTracked, gitIgnored } = require("../git");
const { readProjectConfig, normalizeDeliveryConfig, normalizeExecutionConfig } = require("../config");
const { verificationPlanSummary, executionPlanSummary, countState, reviewProfileName, finalReviewRequiredForState } = require("../state_data");
const { taskGraphSummary, refreshExecutionTraceMatrix, readyExecutionPlan, buildTaskGraph, nextItem } = require("../planning");
const { collectArtifacts } = require("../artifacts");
const { validateArtifacts, reviewWorktreeSnapshotViolations, prdCopyDriftWarnings, completionReadiness, prdSnapshotViolations } = require("../reviews");
const { activePath, activeRootsForState, removeActiveRecordForState, activeDiagnostics, loadState, latestPrdSlug } = require("../state_store");
const { deliveryShipPending } = require("../hooks");

function cmdStatus(options) {
  const { statePath, state } = loadState(options);
  refreshExecutionTraceMatrix(state);
  state.taskGraph = buildTaskGraph(state);
  process.stdout.write(JSON.stringify({
    ok: true,
    statePath: toProjectRelative(statePath),
    status: state.status,
    reviewProfile: state.reviewProfile || { profile: reviewProfileName(state), source: "default" },
    prdPath: state.prdPath,
    runDir: state.runDir,
    delivery: state.delivery || null,
    counts: countState(state),
    verificationPlan: verificationPlanSummary(state),
    executionPlan: executionPlanSummary(state),
    taskGraph: taskGraphSummary(state),
    ready: readyExecutionPlan(state),
    active: activeDiagnostics(cwd(), statePath),
    warnings: prdCopyDriftWarnings(state),
	    artifactCount: collectArtifacts(state).length,
	    artifactViolations: validateArtifacts(statePath, state),
	    completion: completionReadiness(statePath, state, { includeFinalReview: true }),
	    requirementsFidelityReview: state.requirementsFidelityReview,
	    finalReview: state.finalReview,
	    next: nextItem(state),
    finalReceipt: state.finalReceipt,
  }, null, 2) + "\n");
}

function cmdVerifyDelivery(options) {
  const { statePath, state } = loadState(options);
  const violations = [];
  if (!state.finalReceipt || state.finalReceipt.status !== "complete") {
    violations.push(`Final receipt status is '${state.finalReceipt ? state.finalReceipt.status : "missing"}'; delivery requires a complete receipt`);
  }
  const requirePass = (review, label) => {
    if (!review || review.status !== "pass") {
      violations.push(`${label} status is '${review ? review.status : "missing"}'; delivery requires a recorded pass`);
    }
  };
  requirePass(state.requirementsFidelityReview, "Requirements fidelity review");
  if (finalReviewRequiredForState(state)) requirePass(state.finalReview, "Final review");
  violations.push(...reviewWorktreeSnapshotViolations(state));
  violations.push(...prdSnapshotViolations(statePath, state));
  process.stdout.write(JSON.stringify({
    ok: violations.length === 0,
    statePath: toProjectRelative(statePath),
    status: state.status,
    reviewProfile: state.reviewProfile || { profile: reviewProfileName(state), source: "default" },
    delivery: state.delivery || null,
    receiptStatus: state.finalReceipt ? state.finalReceipt.status : null,
    violations,
  }, null, 2) + "\n");
  if (violations.length) process.exitCode = 2;
}

function cmdDoctor() {
  const projectRoot = cwd();
  const checks = [];
  const add = (level, id, message) => checks.push({ level, id, message });

  const { gitOk, originUrl } = doctorCheckGitRepository(projectRoot, add);
  const projectConfig = doctorCheckProjectConfig(projectRoot, add);
  const slug = latestPrdSlug(projectRoot) || "<topic-slug>";
  const delivery = doctorCheckDeliveryConfig(projectRoot, projectConfig, slug, add);
  const prMode = Boolean(delivery && delivery.mode === "pr");
  if (prMode && gitOk && !originUrl) {
    add("error", "origin", "Delivery mode is pr but no 'origin' remote is configured; push and PR creation will fail");
  }
  if (gitOk) doctorCheckGitignorePolicy(projectRoot, add);
  doctorCheckGithubCli(projectRoot, prMode, add);
  doctorCheckWorktreeSyncSources(projectRoot, delivery, gitOk, add);
  if (prMode) doctorCheckPrDeliveryAssets(projectRoot, delivery, add);
  doctorCheckHookRegistration(add);
  const activeRun = doctorCollectActiveRun(projectRoot, add);

  const errors = checks.filter(item => item.level === "error").length;
  const warnings = checks.filter(item => item.level === "warn").length;
  process.stdout.write(JSON.stringify({
    ok: errors === 0,
    projectRoot,
    effectiveDelivery: delivery,
    latestPrdSlug: slug === "<topic-slug>" ? null : slug,
    activeRun,
    summary: { errors, warnings },
    checks,
  }, null, 2) + "\n");
  if (errors) process.exitCode = 2;
}

function doctorCheckGitRepository(projectRoot, add) {
  const gitTop = childProcess.spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: projectRoot,
    shell: false,
    encoding: "utf8",
  });
  if (gitTop.status !== 0) {
    add("error", "git", "Not inside a git repository; the PRD pipeline requires one");
    return { gitOk: false, originUrl: null };
  }
  add("ok", "git", `Git repository: ${gitTop.stdout.trim()}`);
  const origin = childProcess.spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: projectRoot,
    shell: false,
    encoding: "utf8",
  });
  let originUrl = null;
  if (origin.status === 0) {
    originUrl = origin.stdout.trim();
    add("ok", "origin", `origin remote: ${originUrl}`);
  }
  return { gitOk: true, originUrl };
}

function doctorCheckProjectConfig(projectRoot, add) {
  const configPath = path.join(projectRoot, PROJECT_CONFIG_PATH);
  let projectConfig = {};
  if (!fs.existsSync(configPath)) {
    add("warn", "config", `${PROJECT_CONFIG_PATH} not found; defaults apply (delivery mode local, worktree disabled)`);
  } else {
    try {
      projectConfig = readProjectConfig(projectRoot);
      add("ok", "config", `${PROJECT_CONFIG_PATH} parsed`);
    } catch (error) {
      add("error", "config", error.message);
      projectConfig = {};
    }
  }

  const knownKeys = {
    delivery: new Set(["mode", "default", "branchPrefix", "branch", "baseBranch", "prTemplate", "staging", "ci"]),
    "delivery.staging": new Set(["include", "exclude"]),
    "delivery.ci": new Set(["watch", "maxFixAttempts", "timeoutSeconds", "intervalSeconds"]),
    worktree: new Set(["enabled", "root", "path", "link", "copy", "setup"]),
    execution: new Set(["parallel"]),
    review: new Set(["profile"]),
  };
  const flagUnknown = (section, value) => {
    if (!value || typeof value !== "object") return;
    for (const key of Object.keys(value)) {
      if (!knownKeys[section].has(key)) {
        add("warn", "config-keys", `Unknown key '${section}.${key}' is ignored by the PRD pipeline; check for a typo`);
      } else if (knownKeys[`${section}.${key}`]) {
        flagUnknown(`${section}.${key}`, value[key]);
      }
    }
  };
  flagUnknown("delivery", projectConfig.delivery);
  flagUnknown("worktree", projectConfig.worktree);
  flagUnknown("execution", projectConfig.execution);
  flagUnknown("review", projectConfig.review);
  return projectConfig;
}

function doctorCheckDeliveryConfig(projectRoot, projectConfig, slug, add) {
  let delivery = null;
  try {
    delivery = normalizeDeliveryConfig(projectRoot, {}, projectConfig, slug);
  } catch (error) {
    add("error", "delivery-config", error.message);
  }
  const execution = normalizeExecutionConfig(projectConfig, {});
  add("ok", "execution", `Execution mode: ${execution.parallel ? "parallel opt-in enabled (execution.parallel)" : "sequential (default; set execution.parallel to enable parallel ready groups)"}`);
  const reviewProfileConfig = projectConfig.review && projectConfig.review.profile
    ? String(projectConfig.review.profile).toLowerCase()
    : "auto";
  if (!["auto", "trivial", "standard", "high-risk"].includes(reviewProfileConfig)) {
    add("error", "review-profile", `config review.profile '${reviewProfileConfig}' is invalid; use trivial, standard, high-risk, or auto`);
  } else {
    add("ok", "review-profile", `Review profile: ${reviewProfileConfig === "auto" ? "auto-classified from the PRD (default)" : `forced to ${reviewProfileConfig} by config review.profile`}`);
  }
  return delivery;
}

function doctorCheckGitignorePolicy(projectRoot, add) {
  const prdProbe = path.join(".hoyeon", "prd", "__doctor-probe__", "prd.md");
  const implementProbe = path.join(".hoyeon", "implement", "__doctor-probe__", "state.json");
  if (gitIgnored(projectRoot, prdProbe)) {
    add("warn", "gitignore", ".hoyeon/prd/** is ignored; PRD source files should be trackable");
  } else {
    add("ok", "gitignore", ".hoyeon/prd/** is trackable");
  }
  if (gitIgnored(projectRoot, PROJECT_CONFIG_PATH)) {
    add("warn", "gitignore", `${PROJECT_CONFIG_PATH} is ignored; prd-setup project configuration should be trackable`);
  } else {
    add("ok", "gitignore", `${PROJECT_CONFIG_PATH} is trackable`);
  }
  if (gitIgnored(projectRoot, implementProbe)) {
    add("ok", "gitignore", ".hoyeon/implement/** is ignored");
  } else {
    add("warn", "gitignore", ".hoyeon/implement/** is not ignored; implementation state and evidence should stay out of normal commits");
  }
}

function doctorCheckGithubCli(projectRoot, prMode, add) {
  const ghVersion = childProcess.spawnSync("gh", ["--version"], { shell: false, encoding: "utf8" });
  if (ghVersion.status !== 0) {
    add(prMode ? "error" : "warn", "gh", "GitHub CLI (gh) is not available");
    return;
  }
  const ghAuth = childProcess.spawnSync("gh", ["auth", "status"], { cwd: projectRoot, shell: false, encoding: "utf8" });
  if (ghAuth.status === 0) add("ok", "gh", "gh installed and authenticated");
  else add(prMode ? "error" : "warn", "gh", "gh is installed but not authenticated (gh auth login)");
}

function doctorCheckWorktreeSyncSources(projectRoot, delivery, gitOk, add) {
  if (!delivery || !delivery.worktree.enabled) return;
  for (const rel of [...delivery.worktree.link, ...delivery.worktree.copy]) {
    if (!fs.existsSync(path.join(projectRoot, rel))) {
      add("warn", "worktree-sync", `worktree link/copy source '${rel}' does not exist in this checkout`);
    } else if (gitOk && gitTracked(projectRoot, rel)) {
      add("warn", "worktree-sync", `'${rel}' is tracked by git; link/copy is meant for gitignored local files`);
    }
  }
}

function doctorCheckPrDeliveryAssets(projectRoot, delivery, add) {
  const templateCandidates = [
    delivery && delivery.prTemplate,
    ".github/pull_request_template.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
    "docs/pull_request_template.md",
    "pull_request_template.md",
    "PULL_REQUEST_TEMPLATE.md",
  ].filter(Boolean);
  const found = templateCandidates.find(rel => fs.existsSync(path.join(projectRoot, rel)));
  const fallback = path.join(os.homedir(), ".codex", "templates", "pull_request_template.md");
  if (found) add("ok", "pr-template", `Repository PR template: ${found}`);
  else if (fs.existsSync(fallback)) add("ok", "pr-template", `No repository PR template; global fallback exists: ${fallback}`);
  else add("warn", "pr-template", "No repository or global PR template found");

  const shipScript = shipScriptPath();
  if (fs.existsSync(shipScript)) add("ok", "prd-ship", `deliver (prd-ship) script found: ${displayPath(shipScript)}`);
  else add("error", "prd-ship", `Delivery mode is pr but ${displayPath(shipScript)} is missing`);
}

function doctorCheckHookRegistration(add) {
  for (const { runtime, file } of [
    { runtime: "codex", file: path.join(os.homedir(), ".codex", "hooks.json") },
    { runtime: "claude", file: path.join(os.homedir(), ".claude", "settings.json") },
  ]) {
    let hooksRegistered = false;
    try {
      hooksRegistered = fs.existsSync(file) && fs.readFileSync(file, "utf8").includes("prd_state_harness.js");
    } catch {
      hooksRegistered = false;
    }
    if (hooksRegistered) add("ok", "hooks", `Harness hooks are registered for ${runtime} in ${displayPath(file)}`);
    else add("warn", "hooks", `Harness hooks are not registered for ${runtime} in ${displayPath(file)}; in ${runtime} sessions the continuation loop and ship handoff rely on skill instructions only`);
  }
}

function doctorCollectActiveRun(projectRoot, add) {
  const activeFile = activePath(projectRoot);
  if (!fs.existsSync(activeFile)) return null;
  try {
    const active = readJson(activeFile);
    const stateAbs = resolveProjectPath(active.statePath, projectRoot);
    if (!fs.existsSync(stateAbs)) {
      add("warn", "active-run", `Active file points to missing state: ${active.statePath}`);
      return { statePath: active.statePath, status: "state-file-missing", pointer: Boolean(active.pointer) };
    }
    const state = readJson(stateAbs);
    return {
      statePath: active.statePath,
      runDir: active.runDir,
      status: state.status,
      delivery: active.delivery || null,
      pointer: Boolean(active.pointer),
      receipt: state.finalReceipt ? state.finalReceipt.status : null,
      shipPending: deliveryShipPending(stateAbs, state),
    };
  } catch (error) {
    add("warn", "active-run", `Active file unreadable: ${error.message}`);
    return null;
  }
}

function cmdNext(options) {
  const { statePath, state } = loadState(options);
  process.stdout.write(JSON.stringify({
    ok: true,
    statePath: toProjectRelative(statePath),
    next: nextItem(state),
    counts: countState(state),
    verificationPlan: verificationPlanSummary(state),
    executionPlan: executionPlanSummary(state),
    taskGraph: taskGraphSummary(state),
    ready: readyExecutionPlan(state),
  }, null, 2) + "\n");
}

function cmdReady(options) {
  const { statePath, state } = loadState(options);
  process.stdout.write(JSON.stringify({
    ok: true,
    statePath: toProjectRelative(statePath),
    executionPlan: executionPlanSummary(state),
    ready: readyExecutionPlan(state),
    next: nextItem(state),
  }, null, 2) + "\n");
}

function cmdCleanupActive(options) {
  const { statePath, state } = loadState(options);
  const removed = [];
  const roots = Array.from(new Set([cwd(), ...activeRootsForState(state)].map(item => canonicalPath(item))));
  for (const root of roots) {
    removed.push(...removeActiveRecordForState(root, statePath));
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    statePath: toProjectRelative(statePath, state.projectRoot || cwd()),
    removed: removed.map(item => toProjectRelative(item, state.projectRoot || cwd())),
  }, null, 2) + "\n");
}

module.exports = {
  cmdStatus,
  cmdVerifyDelivery,
  cmdDoctor,
  cmdNext,
  cmdReady,
  cmdCleanupActive,
};
