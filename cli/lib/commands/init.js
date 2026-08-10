"use strict";

const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");

const { SCHEMA, PROJECT_CONFIG_PATH, SELF_PATH, nowIso, cwd, resolveProjectPath, toProjectRelative, canonicalPath, ensureDir, writeJson, runCommand, sha256Text, slugFromPrdPath, runDirRelFor } = require("../util");
const { runGit, branchExists, isLinkedWorktree, gitWorktreeRoots, worktreeSnapshot } = require("../git");
const { readProjectConfig, normalizeDeliveryConfig, normalizeExecutionConfig, classifyReviewProfile } = require("../config");
const { recordDeviation, verificationPlanSummary, executionPlanSummary, countState, isVerificationRequiredForDone } = require("../state_data");
const { stripFrontmatter, extractFirstSection, extractFirstNestedSection, parseMarkdownItems, parseAcOracle, parsePreWorkChecklist, buildIntentTrace, parseVerification, parseTestModeContract, applyTestModeDefaults } = require("../prd_parser");
const { verificationContractHash, buildVerificationPlan, applyExecutionPlan, readyExecutionPlan, nextItem } = require("../planning");
const { ensureRunDirs } = require("../artifacts");
const { activePath, normalizeSessionId, writeActiveRecord, persistState } = require("../state_store");
const { ensureContextNotes } = require("../render");

function cmdInit(options) {
  const inputs = resolveInitInputs(options);
  const contract = parsePrdContract(inputs.parsed, inputs.projectRoot);
  assertNonCircularDeliveryContract(inputs.deliveryConfig, contract);
  const worktreePreparation = prepareDeliveryWorktree(
    inputs.projectRoot, inputs.prdAbs, inputs.deliveryConfig, options,
    inputs.approvalOverride, inputs.initialSessionId,
  );
  // In PR delivery the real run lives inside the worktree (initialized by the
  // child re-exec); the main checkout only keeps a pointer to it.
  if (worktreePreparation && worktreePreparation.active === false) {
    writeWorktreePointer(inputs, worktreePreparation);
    return;
  }

  const runDirRel = runDirRelFor(inputs.slug);
  const runDirAbs = path.join(inputs.projectRoot, runDirRel);
  const existingStatePath = path.join(runDirAbs, "state.json");
  if (fs.existsSync(existingStatePath) && !options.force) {
    throw new Error([
      `Implementation state already exists: ${toProjectRelative(existingStatePath, inputs.projectRoot)}`,
      "Use status/next to resume the existing run, or rerun init with --force to reinitialize and reset its progress.",
    ].join("\n"));
  }
  ensureRunDirs(runDirAbs);

  const state = buildInitialState(inputs, contract, worktreePreparation, options, runDirRel);
  state.initialWorktreeSnapshot = worktreeSnapshot(state);
  if (inputs.approvalRaw !== "approved" && inputs.approvalOverride) {
    recordDeviation(state, "prd_approval_override", "PRD", inputs.approvalOverride, {
      frontmatterValue: inputs.approvalRaw || "missing",
    });
  }

  const statePath = path.join(runDirAbs, "state.json");
  state.verificationPlan = buildVerificationPlan(state, statePath);
  // The default sequential execution plan needs no agent input, so init builds
  // it directly; `plan-execution --task-plan` reruns it for parallel scoping.
  applyExecutionPlan(state, statePath);
  persistState(statePath, state);
  ensureContextNotes(statePath, state);
  writeActiveRecord(inputs.projectRoot, statePath, state);

  process.stdout.write(JSON.stringify({
    ok: true,
    statePath: toProjectRelative(statePath, inputs.projectRoot),
    runDir: state.runDir,
    prdPath: state.prdPath,
    counts: countState(state),
    // Surfaced in the same tool result the agent already reads so unresolved
    // human-only pre-work is seen before implementation, not mid-run.
    preWorkChecklist: state.preWorkChecklist,
    verificationPlan: verificationPlanSummary(state),
    executionPlan: executionPlanSummary(state),
    ready: readyExecutionPlan(state),
    next: nextItem(state),
  }, null, 2) + "\n");
}

const DELIVERY_RECEIPT_PATTERNS = [
  {
    label: "PR creation or PR URL",
    pattern: /\b(?:pull\s+request|pr)\s*(?:url|link|number|created|creation|opened|opening|exists?|published|posted)\b|\b(?:open|create|publish)\s+(?:a\s+)?(?:pull\s+request|pr)\b|(?:pr|pull\s+request|풀\s*리퀘스트)\s*(?:생성|오픈|열기|게시|url|링크)/iu,
  },
  {
    label: "CI or required-check verdict",
    pattern: /\b(?:ci(?:\s+checks?)?|github\s+actions?|required\s+checks?|status\s+checks?)\s*(?:pass(?:es|ed|ing)?|green|succeeds?|succeeded|success(?:ful)?)\b|(?:ci|github\s+actions?|체크|검사)\s*(?:통과|성공|완료)/iu,
  },
  {
    label: "merge result or merge commit",
    pattern: /\b(?:merge\s+commit|merged?\s+(?:into|to)\s+(?:main|master)|(?:pr|pull\s+request)\s+(?:is\s+)?merged)\b|(?:pr|pull\s+request|풀\s*리퀘스트|main|master)\s*(?:머지|병합)|(?:머지|병합)\s*(?:커밋|완료)/iu,
  },
];

function assertNonCircularDeliveryContract(deliveryConfig, contract) {
  if (!deliveryConfig || deliveryConfig.mode !== "pr") return;
  const receiptGates = [
    ...(contract.tasks || []).map(item => ({ kind: "task", item })),
    ...(contract.acceptanceCriteria || []).map(item => ({ kind: "acceptance criterion", item })),
    ...(contract.verification || [])
      .filter(isVerificationRequiredForDone)
      .map(item => ({ kind: "required verification", item })),
  ];
  const violations = [];
  for (const gate of receiptGates) {
    const text = String(gate.item.text || gate.item.title || "");
    for (const matcher of DELIVERY_RECEIPT_PATTERNS) {
      if (matcher.pattern.test(text)) {
        violations.push(`${gate.item.id} (${gate.kind}) requires ${matcher.label}: ${text}`);
        break;
      }
    }
  }
  if (!violations.length) return;
  throw new Error([
    "PRD has a circular PR-delivery completion contract.",
    "implement must create the complete implementation receipt before ship can open the PR, observe CI, or merge it.",
    ...violations.map(item => `- ${item}`),
    "Move these outcomes to a post-receipt Delivery section. They must not be PRD tasks, acceptance criteria, or Required For Done verification items.",
  ].join("\n"));
}

// Resolve and validate everything init needs before any side effect:
// PRD text/frontmatter, approval, session binding, and normalized configs.
function resolveInitInputs(options) {
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
  return {
    projectRoot,
    initialSessionId,
    prdAbs,
    prdText,
    parsed,
    approvalRaw,
    approvalOverride,
    slug,
    projectConfig,
    deliveryConfig: normalizeDeliveryConfig(projectRoot, options, projectConfig, slug),
    executionConfig: normalizeExecutionConfig(projectConfig, options),
  };
}

function writeWorktreePointer(inputs, worktreePreparation) {
  const pointerRunDir = runDirRelFor(inputs.slug);
  const pointerRecord = {
    schema: "hoyeon.prd-implement.active.v1",
    pointer: true,
    statePath: path.join(worktreePreparation.path, pointerRunDir, "state.json"),
    prdPath: toProjectRelative(inputs.prdAbs, inputs.projectRoot),
    runDir: pointerRunDir,
    status: worktreePreparation.resumed ? "resumed" : "active",
    delivery: {
      mode: inputs.deliveryConfig.mode,
      branch: inputs.deliveryConfig.branch,
      worktreePath: worktreePreparation.path,
    },
    activeSessionId: inputs.initialSessionId || null,
    updatedAt: nowIso(),
  };
  writeJson(activePath(inputs.projectRoot), pointerRecord);
  process.stdout.write(JSON.stringify({
    ok: true,
    delivery: inputs.deliveryConfig,
    worktreePrepared: worktreePreparation,
    warnings: worktreePreparation.warnings || [],
    mainRootPointerWritten: true,
    message: worktreePreparation.resumed
      ? `PR delivery worktree already has implementation state. Continue the existing run from ${worktreePreparation.path} (use init --force there to reset it).`
      : `PR delivery worktree prepared. Continue implementation from ${worktreePreparation.path}.`,
  }, null, 2) + "\n");
}

// Parse every tracked collection out of the PRD body. Section headings accept
// both the numbered canonical form and its unnumbered variant.
function parsePrdContract(parsed, projectRoot) {
  const tasks = parseMarkdownItems(extractFirstSection(parsed.body, [
    "8. PRD-Level Tasks",
    "PRD-Level Tasks",
  ]), "T", "Task");
  const acceptanceCriteria = parseMarkdownItems(extractFirstSection(parsed.body, [
    "7. Acceptance Criteria",
    "Acceptance Criteria",
  ]), "AC", "AC");
  // Machine oracle tails (Check:/Artifact:) declared on AC bullets: the
  // harness settles these ACs mechanically via `oracle-run` instead of a
  // judge or a manual mark, so the declaration must survive into state.
  for (const criterion of acceptanceCriteria) {
    const oracle = parseAcOracle(criterion.text);
    if (oracle) criterion.oracle = oracle;
  }
  const requirements = parseMarkdownItems(extractFirstSection(parsed.body, [
    "6. Requirements",
    "Requirements",
  ]), "R", "R");
  const verificationSection = extractFirstSection(parsed.body, [
    "9. Verification Contract",
    "Verification Contract",
  ]);
  const verification = parseVerification(verificationSection);
  const testModeSection = extractFirstNestedSection(verificationSection, [
    "9.1 Test Mode Contract",
    "Test Mode Contract",
  ]);
  const testModeContract = parseTestModeContract(testModeSection || verificationSection);
  applyTestModeDefaults(verification, testModeContract);
  const preWorkItems = parsePreWorkChecklist(parsed.body);
  return {
    tasks,
    acceptanceCriteria,
    requirements,
    verification,
    testModeContract,
    // Human-only §4 items surfaced at init (not a gate: unresolved items must
    // never fail init) so the skill can ask about all of them in one batched
    // message instead of stalling on each serially mid-implementation.
    preWorkChecklist: {
      items: preWorkItems,
      unresolvedCount: preWorkItems.filter(item => !item.resolved).length,
    },
    intentTrace: buildIntentTrace(parsed, projectRoot),
    technicalStructure: extractFirstSection(parsed.body, [
      "5. Major Technical Structure Changes",
      "Major Technical Structure Changes",
    ]),
    implementationNotes: extractFirstSection(parsed.body, [
      "11. Implementation Guardrails",
      "Implementation Guardrails",
    ]),
  };
}

function buildInitialState(inputs, contract, worktreePreparation, options, runDirRel) {
  const { projectRoot, prdAbs, prdText, parsed, approvalRaw, approvalOverride } = inputs;
  const { tasks, acceptanceCriteria, requirements, verification, testModeContract, intentTrace, preWorkChecklist } = contract;
  const reviewProfile = classifyReviewProfile({
    reviewProfile: parsed.frontmatter.review_profile,
    reviewRationale: parsed.frontmatter.review_rationale,
  }, options["review-profile"], inputs.projectConfig.review ? inputs.projectConfig.review.profile : null);
  const linkedWorktree = isLinkedWorktree(projectRoot);
  return {
    schema: SCHEMA,
    status: "active",
    topicSlug: inputs.slug,
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
    delivery: {
      ...inputs.deliveryConfig,
      initializedAt: nowIso(),
      worktree: {
        ...inputs.deliveryConfig.worktree,
        ...(linkedWorktree ? { path: projectRoot, root: path.dirname(projectRoot) } : {}),
        current: linkedWorktree ||
          (inputs.deliveryConfig.worktree.enabled &&
            canonicalPath(projectRoot) === canonicalPath(inputs.deliveryConfig.worktree.path)),
        skipped: Boolean(options["skip-worktree"]),
        preparation: worktreePreparation,
      },
    },
    reviewProfile,
    execution: inputs.executionConfig,
    // Durable copy so `status` and later phases can re-surface unresolved
    // human-only pre-work without re-parsing the PRD.
    preWorkChecklist,
    intentTrace,
    technicalStructure: contract.technicalStructure,
    implementationNotes: contract.implementationNotes,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    activeSessionId: inputs.initialSessionId,
    tasks,
    acceptanceCriteria,
    requirements,
    verification,
    testModeContract,
    verificationPlan: null,
    executionPlan: null,
    deviations: [],
    requirementsFidelityReview: null,
    finalReview: null,
    finalReceipt: null,
  };
}

function prepareDeliveryWorktree(projectRoot, prdAbs, deliveryConfig, options, approvalOverride, initialSessionId) {
  if (deliveryConfig.mode !== "pr" || !deliveryConfig.worktree.enabled || options["skip-worktree"]) return null;
  const targetRoot = deliveryConfig.worktree.path;
  if (canonicalPath(projectRoot) === canonicalPath(targetRoot)) {
    return { active: true, path: targetRoot, branch: deliveryConfig.branch, created: false, setup: [], warnings: [] };
  }

  const setupResults = [];
  const warnings = [];
  const sourceStatus = runGit(projectRoot, ["status", "--porcelain=v1"]).stdout.trim();
  if (sourceStatus) {
    warnings.push("Source checkout has uncommitted changes. Git worktrees do not copy them; commit, stash, or deliberately reapply the required changes in the delivery worktree.");
  }
  let baseSha;
  try {
    baseSha = runGit(projectRoot, ["rev-parse", "--verify", `${deliveryConfig.baseBranch}^{commit}`]).stdout.trim();
  } catch {
    throw new Error(`Configured delivery.baseBranch '${deliveryConfig.baseBranch}' does not resolve to a local commit`);
  }
  let created = false;
  if (!fs.existsSync(targetRoot)) {
    ensureDir(path.dirname(targetRoot));
    if (branchExists(projectRoot, deliveryConfig.branch)) {
      runGit(projectRoot, ["worktree", "add", targetRoot, deliveryConfig.branch]);
    } else {
      runGit(projectRoot, ["worktree", "add", "-b", deliveryConfig.branch, targetRoot, deliveryConfig.baseBranch]);
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

  const worktreeStatePath = path.join(targetRoot, runDirRelFor(slugFromPrdPath(prdAbs)), "state.json");
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
      baseRef: deliveryConfig.baseBranch,
      baseSha,
      warnings,
      sync: syncResults,
      setup: setupResults,
      child: { skipped: true, reason: "state-exists", statePath: worktreeStatePath },
    };
  }

  const prdRel = toProjectRelative(prdAbs, projectRoot);
  const childArgs = [SELF_PATH, "init", "--prd", prdRel, "--delivery", deliveryConfig.mode, "--branch", deliveryConfig.branch, "--skip-worktree"];
  if (initialSessionId) childArgs.push("--session-id", initialSessionId);
  if (approvalOverride) childArgs.push("--allow-unapproved-prd", approvalOverride);
  if (options["review-profile"]) childArgs.push("--review-profile", String(options["review-profile"]));
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
    baseRef: deliveryConfig.baseBranch,
    baseSha,
    warnings,
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
  parsePrdContract,
  prepareDeliveryWorktree,
  syncPathForWorktree,
  copyRequiredInitInputsToWorktree,
};
