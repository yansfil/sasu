"use strict";

const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");

const { SCHEMA, PROJECT_CONFIG_PATH, SELF_PATH, nowIso, cwd, resolveProjectPath, toProjectRelative, canonicalPath, ensureDir, writeJson, appendJsonl, runCommand, sha256Text, slugFromPrdPath } = require("../util");
const { runGit, branchExists, isLinkedWorktree, gitWorktreeRoots } = require("../git");
const { readProjectConfig, normalizeDeliveryConfig, normalizeExecutionConfig, classifyReviewProfile } = require("../config");
const { recordDeviation, verificationPlanSummary, executionPlanSummary, countState } = require("../state_data");
const { stripFrontmatter, extractFirstSection, extractFirstNestedSection, parseMarkdownItems, buildIntentTrace, parseVerification, parseTestModeContract, applyTestModeDefaults } = require("../prd_parser");
const { taskGraphSummary, verificationContractHash, buildVerificationPlan, readyExecutionPlan, nextItem } = require("../planning");
const { ensureRunDirs } = require("../artifacts");
const { activePath, normalizeSessionId, writeActiveRecord, persistStateAndArtifacts } = require("../state_store");

function cmdInit(options) {
  const prdInput = options.prd;
  if (!prdInput) throw new Error("--prd is required");
  const projectRoot = cwd();
  const initialSessionId = normalizeSessionId(
    options["session-id"] ||
    options.sessionId ||
    process.env.CODEX_SESSION_ID ||
    process.env.CODEX_THREAD_ID ||
    process.env.CLAUDE_SESSION_ID,
  );
  const prdAbs = resolveProjectPath(prdInput, projectRoot);
  if (!fs.existsSync(prdAbs)) throw new Error(`PRD not found: ${prdAbs}`);
  const prdText = fs.readFileSync(prdAbs, "utf8");
  const parsed = stripFrontmatter(prdText);
  const approvalRaw = String(parsed.frontmatter.human_approval || "").toLowerCase();
  const approvalOverride = typeof options["allow-unapproved-prd"] === "string"
    ? options["allow-unapproved-prd"].trim()
    : "";
  if (approvalRaw !== "approved" && !approvalOverride) {
    throw new Error([
      `PRD is not human-approved: ${prdAbs}`,
      `Frontmatter 'human_approval' is '${approvalRaw || "missing"}'; expected 'approved'.`,
      "Ask the user to review the PRD and approve it, then set frontmatter 'human_approval: \"approved\"' before init.",
      "If the user already gave explicit approval in conversation, rerun init with --allow-unapproved-prd \"<verbatim user approval>\" to record that approval as a deviation.",
    ].join("\n"));
  }
  const slug = slugFromPrdPath(prdAbs);
  const projectConfig = readProjectConfig(projectRoot);
  const deliveryConfig = normalizeDeliveryConfig(projectRoot, options, projectConfig, slug);
  const executionConfig = normalizeExecutionConfig(projectConfig, options);
  const worktreePreparation = prepareDeliveryWorktree(projectRoot, prdAbs, deliveryConfig, options, approvalOverride, initialSessionId);
  if (worktreePreparation && worktreePreparation.active === false) {
    const pointerRunDir = path.join(".hoyeon", "implement", slug);
    const pointerRecord = {
      schema: "hoyeon.prd-implement.active.v1",
      pointer: true,
      statePath: path.join(worktreePreparation.path, pointerRunDir, "state.json"),
      prdPath: toProjectRelative(prdAbs, projectRoot),
      runDir: pointerRunDir,
      status: worktreePreparation.resumed ? "resumed" : "active",
      delivery: {
        mode: deliveryConfig.mode,
        branch: deliveryConfig.branch,
        worktreePath: worktreePreparation.path,
      },
      activeSessionId: initialSessionId || null,
      updatedAt: nowIso(),
    };
    writeJson(activePath(projectRoot), pointerRecord);
    process.stdout.write(JSON.stringify({
      ok: true,
      delivery: deliveryConfig,
      worktreePrepared: worktreePreparation,
      mainRootPointerWritten: true,
      message: worktreePreparation.resumed
        ? `PR delivery worktree already has implementation state. Continue the existing run from ${worktreePreparation.path} (use init --force there to reset it).`
        : `PR delivery worktree prepared. Continue implementation from ${worktreePreparation.path}.`,
    }, null, 2) + "\n");
    return;
  }
  const runDirRel = path.join(".hoyeon", "implement", slug);
  const runDirAbs = path.join(projectRoot, runDirRel);
  const existingStatePath = path.join(runDirAbs, "state.json");
  if (fs.existsSync(existingStatePath) && !options.force) {
    throw new Error([
      `Implementation state already exists: ${toProjectRelative(existingStatePath, projectRoot)}`,
      "Use status/next to resume the existing run, or rerun init with --force to reinitialize and reset its progress.",
    ].join("\n"));
  }
  ensureRunDirs(runDirAbs);

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
  const intentTrace = buildIntentTrace(parsed, projectRoot);
  const technicalStructure = extractFirstSection(parsed.body, [
    "5. Major Technical Structure Changes",
    "Major Technical Structure Changes",
    "2. Technical Structure And Changes",
    "Technical Structure And Changes",
  ]);
  const implementationNotes = extractFirstSection(parsed.body, [
    "11. Implementation Guardrails",
    "Implementation Guardrails",
    "14. Implementation Notes",
    "Implementation Notes",
  ]);
  const reviewProfile = classifyReviewProfile({
    tasks,
    acceptanceCriteria,
    verification,
    technicalStructure,
    implementationNotes,
  }, options["review-profile"], projectConfig.review ? projectConfig.review.profile : null);

  const state = {
    schema: SCHEMA,
    status: "active",
    topicSlug: slug,
    projectRoot,
	    prdPath: toProjectRelative(prdAbs, projectRoot),
	    prdStatus: parsed.frontmatter.status || null,
	    prdApproval: {
	      source: approvalRaw === "approved" ? "frontmatter" : "override",
	      value: approvalRaw || null,
	      overrideNote: approvalOverride || null,
	      recordedAt: nowIso(),
	    },
	    prdSnapshot: {
	      path: toProjectRelative(prdAbs, projectRoot),
	      sha256: sha256Text(prdText),
	      taskIds: tasks.map(item => item.id),
	      acceptanceCriteriaIds: acceptanceCriteria.map(item => item.id),
	      requirementIds: requirements.map(item => item.id),
	      verificationIds: verification.map(item => item.id),
	      testModeIds: testModeContract.map(item => item.id),
	      decisionTraceHash: intentTrace.prdDecisionTraceHash,
	      verificationContractHash: verificationContractHash({ verification, testModeContract }),
	    },
	    runDir: runDirRel,
    delivery: (() => {
      const linkedWorktree = isLinkedWorktree(projectRoot);
      return {
        ...deliveryConfig,
        initializedAt: nowIso(),
        worktree: {
          ...deliveryConfig.worktree,
          ...(linkedWorktree ? { path: projectRoot, root: path.dirname(projectRoot) } : {}),
          current: linkedWorktree ||
            (deliveryConfig.worktree.enabled &&
              canonicalPath(projectRoot) === canonicalPath(deliveryConfig.worktree.path)),
          skipped: Boolean(options["skip-worktree"]),
          preparation: worktreePreparation,
        },
      };
    })(),
    reviewProfile,
    execution: executionConfig,
    intentTrace,
    technicalStructure,
    implementationNotes,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    activeSessionId: initialSessionId,
    tasks,
    acceptanceCriteria,
    requirements,
    verification,
    testModeContract,
    verificationPlan: null,
    executionPlan: null,
	    taskGraph: null,
	    deviations: [],
	    requirementsFidelityReview: null,
	    finalReview: null,
    finalReceipt: null,
  };

  if (approvalRaw !== "approved" && approvalOverride) {
    recordDeviation(state, "prd_approval_override", "PRD", approvalOverride, {
      frontmatterValue: approvalRaw || "missing",
    });
  }

  const statePath = path.join(runDirAbs, "state.json");
  state.verificationPlan = buildVerificationPlan(state, statePath);
  persistStateAndArtifacts(statePath, state);
  writeActiveRecord(projectRoot, statePath, state);
  appendJsonl(path.join(runDirAbs, "ledger.jsonl"), {
    ts: nowIso(),
    event: "initialized",
    prdPath: state.prdPath,
    taskCount: tasks.length,
    acceptanceCriteriaCount: acceptanceCriteria.length,
    verificationCount: verification.length,
    verificationPlanStatus: state.verificationPlan.status,
    verificationPlanGapCount: state.verificationPlan.gaps.length,
  });

  const counts = countState(state);
  process.stdout.write(JSON.stringify({
    ok: true,
    statePath: toProjectRelative(statePath, projectRoot),
    runDir: state.runDir,
    prdPath: state.prdPath,
    counts,
    verificationPlan: verificationPlanSummary(state),
    executionPlan: executionPlanSummary(state),
    taskGraph: taskGraphSummary(state),
    ready: readyExecutionPlan(state),
    next: nextItem(state),
  }, null, 2) + "\n");
}

function prepareDeliveryWorktree(projectRoot, prdAbs, deliveryConfig, options, approvalOverride, initialSessionId) {
  if (deliveryConfig.mode !== "pr" || !deliveryConfig.worktree.enabled || options["skip-worktree"]) return null;
  const targetRoot = deliveryConfig.worktree.path;
  if (canonicalPath(projectRoot) === canonicalPath(targetRoot)) {
    return { active: true, path: targetRoot, branch: deliveryConfig.branch, created: false, setup: [] };
  }

  const setupResults = [];
  let created = false;
  if (!fs.existsSync(targetRoot)) {
    ensureDir(path.dirname(targetRoot));
    if (branchExists(projectRoot, deliveryConfig.branch)) {
      runGit(projectRoot, ["worktree", "add", targetRoot, deliveryConfig.branch]);
    } else {
      runGit(projectRoot, ["worktree", "add", "-b", deliveryConfig.branch, targetRoot, "HEAD"]);
    }
    created = true;
  } else {
    runGit(targetRoot, ["rev-parse", "--git-dir"]);
    const ownedRoots = gitWorktreeRoots(projectRoot).map(item => canonicalPath(item));
    if (!ownedRoots.includes(canonicalPath(targetRoot))) {
      throw new Error([
        `Existing worktree at ${targetRoot} is not registered under the current checkout.`,
        "Refusing to resume a PRD implementation from another repository or stale worktree root.",
        "Remove the stale worktree, choose a different worktree.path, or run init from the checkout that owns it.",
      ].join("\n"));
    }
    const worktreeBranch = runGit(targetRoot, ["branch", "--show-current"]).stdout.trim();
    if (worktreeBranch !== deliveryConfig.branch) {
      throw new Error([
        `Existing worktree at ${targetRoot} is on branch '${worktreeBranch || "(detached)"}', expected delivery branch '${deliveryConfig.branch}'.`,
        "Checkout the delivery branch in that worktree, remove the stale worktree, or configure worktree.path/branch explicitly.",
      ].join("\n"));
    }
  }

  const worktreeStatePath = path.join(targetRoot, ".hoyeon", "implement", slugFromPrdPath(prdAbs), "state.json");
  const resuming = fs.existsSync(worktreeStatePath) && !options.force;
  const syncResults = copyRequiredInitInputsToWorktree(projectRoot, targetRoot, prdAbs, deliveryConfig, resuming);
  if (!resuming) {
    for (const command of deliveryConfig.worktree.setup) {
      runCommand(command, [], { cwd: targetRoot, shell: true });
      setupResults.push({ command, status: "passed" });
    }
  }

  if (resuming) {
    return {
      active: false,
      resumed: true,
      path: targetRoot,
      branch: deliveryConfig.branch,
      created,
      sync: syncResults,
      setup: setupResults,
      child: { skipped: true, reason: "state-exists", statePath: worktreeStatePath },
    };
  }

  const prdRel = toProjectRelative(prdAbs, projectRoot);
  const childArgs = [SELF_PATH, "init", "--prd", prdRel, "--delivery", deliveryConfig.mode, "--branch", deliveryConfig.branch, "--skip-worktree"];
  if (initialSessionId) childArgs.push("--session-id", initialSessionId);
  if (approvalOverride) childArgs.push("--allow-unapproved-prd", approvalOverride);
  if (options.force) childArgs.push("--force");
  const child = childProcess.spawnSync(process.execPath, childArgs, {
    cwd: targetRoot,
    shell: false,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (child.status !== 0) {
    throw new Error([
      `Worktree init failed at ${targetRoot}`,
      child.stdout ? `stdout:\n${child.stdout}` : "",
      child.stderr ? `stderr:\n${child.stderr}` : "",
      child.error && child.error.message ? `error: ${child.error.message}` : "",
    ].filter(Boolean).join("\n"));
  }
  let childResult = null;
  try {
    childResult = JSON.parse(child.stdout);
  } catch {
    childResult = { raw: child.stdout.trim() };
  }
  return {
    active: false,
    resumed: false,
    path: targetRoot,
    branch: deliveryConfig.branch,
    created,
    sync: syncResults,
    setup: setupResults,
    child: childResult,
  };
}

function syncPathForWorktree(sourceRoot, targetRoot, relPath, mode, results) {
  const source = path.join(sourceRoot, relPath);
  const target = path.join(targetRoot, relPath);
  if (!fs.existsSync(source)) {
    results.push({ path: relPath, mode, status: "missing-source" });
    return;
  }
  ensureDir(path.dirname(target));
  let targetStat = null;
  try {
    targetStat = fs.lstatSync(target);
  } catch {
    targetStat = null;
  }
  if (mode === "link") {
    if (targetStat) {
      if (targetStat.isSymbolicLink()) {
        const linkTarget = path.resolve(path.dirname(target), fs.readlinkSync(target));
        if (canonicalPath(linkTarget) === canonicalPath(source)) {
          results.push({ path: relPath, mode, status: "already-linked" });
        } else {
          results.push({ path: relPath, mode, status: "target-exists" });
        }
      } else {
        results.push({ path: relPath, mode, status: "target-exists" });
      }
      return;
    }
    fs.symlinkSync(path.relative(path.dirname(target), source), target);
    results.push({ path: relPath, mode, status: "linked" });
    return;
  }
  if (targetStat) {
    results.push({ path: relPath, mode, status: "target-exists" });
    return;
  }
  fs.cpSync(source, target, { recursive: true, force: false });
  results.push({ path: relPath, mode, status: "copied" });
}

function copyRequiredInitInputsToWorktree(sourceRoot, targetRoot, prdAbs, deliveryConfig, resuming = false) {
  const results = [];
  const prdRel = toProjectRelative(prdAbs, sourceRoot);
  if (!path.isAbsolute(prdRel)) {
    const prdSourceDir = path.dirname(path.join(sourceRoot, prdRel));
    const prdTargetDir = path.dirname(path.join(targetRoot, prdRel));
    if (resuming && fs.existsSync(prdTargetDir)) {
      results.push({ path: path.dirname(prdRel), mode: "copy", status: "kept-existing-prd" });
    } else {
      ensureDir(prdTargetDir);
      fs.cpSync(prdSourceDir, prdTargetDir, { recursive: true, force: true });
      results.push({ path: path.dirname(prdRel), mode: "copy", status: "copied-prd" });
    }
  }
  if (deliveryConfig.configPath) {
    const configTarget = path.join(targetRoot, PROJECT_CONFIG_PATH);
    if (resuming && fs.existsSync(configTarget)) {
      results.push({ path: PROJECT_CONFIG_PATH, mode: "copy", status: "kept-existing-config" });
    } else {
      ensureDir(path.dirname(configTarget));
      fs.copyFileSync(path.join(sourceRoot, PROJECT_CONFIG_PATH), configTarget);
      results.push({ path: PROJECT_CONFIG_PATH, mode: "copy", status: "copied-config" });
    }
  }
  for (const rel of deliveryConfig.worktree.link) syncPathForWorktree(sourceRoot, targetRoot, rel, "link", results);
  for (const rel of deliveryConfig.worktree.copy) syncPathForWorktree(sourceRoot, targetRoot, rel, "copy", results);
  return results;
}

module.exports = {
  cmdInit,
  prepareDeliveryWorktree,
  syncPathForWorktree,
  copyRequiredInitInputsToWorktree,
};
