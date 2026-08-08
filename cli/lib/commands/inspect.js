"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");

const { PROJECT_CONFIG_PATH, PRD_ROOT_REL, IMPLEMENT_ROOT_REL, RULES_ROOT_REL, NAMESPACE_ROOT, displayPath, shipScriptPath, cwd, resolveProjectPath, toProjectRelative, canonicalPath, readJson } = require("../util");
const { readLedger, loadInvariants, loadPending, globLiteralPrefix } = require("../rules");
const { gitTracked, gitIgnored } = require("../git");
const { readProjectConfig, normalizeDeliveryConfig, normalizeExecutionConfig } = require("../config");
const { verificationPlanSummary, executionPlanSummary, countState, reviewProfileName, finalReviewRequiredForState, effectiveReviewPolicy } = require("../state_data");
const { readyExecutionPlan, nextItem } = require("../planning");
const { collectArtifacts } = require("../artifacts");
const { validateArtifacts, reviewWorktreeSnapshotViolations, prdCopyDriftWarnings, completionReadiness, prdSnapshotViolations } = require("../reviews");
const { activePath, activeRootsForState, removeActiveRecordForState, activeDiagnostics, loadState, latestPrdSlug } = require("../state_store");
const { deliveryShipPending } = require("../hooks");

function cmdStatus(options) {
  const { statePath, state } = loadState(options);
  process.stdout.write(JSON.stringify({
    ok: true,
    statePath: toProjectRelative(statePath),
    status: state.status,
    reviewProfile: state.reviewProfile || { profile: reviewProfileName(state), source: "default" },
    reviewPolicy: effectiveReviewPolicy(state),
    prdPath: state.prdPath,
    runDir: state.runDir,
    delivery: state.delivery || null,
    counts: countState(state),
    verificationPlan: verificationPlanSummary(state),
    executionPlan: executionPlanSummary(state),
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
    reviewPolicy: effectiveReviewPolicy(state),
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
  doctorCheckAgentsMdConvention(projectRoot, add);
  doctorCheckRulesLedger(projectRoot, add);
  doctorCheckGithubCli(projectRoot, prMode, add);
  doctorCheckWorktreeSyncSources(projectRoot, delivery, gitOk, add);
  if (prMode) doctorCheckPrDeliveryAssets(projectRoot, delivery, add);
  doctorCheckHookRegistration(add);
  doctorCheckSasuCli(projectRoot, add);
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
    delivery: new Set(["mode", "default", "branchPrefix", "branch", "baseBranch", "staging", "ci"]),
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
    add("ok", "review-profile", `Review profile: ${reviewProfileConfig === "auto" ? "agent-declared by PRD, with standard fallback (default)" : `${reviewProfileConfig} safety floor from config review.profile`}`);
  }
  return delivery;
}

function doctorCheckGitignorePolicy(projectRoot, add) {
  const prdProbe = path.join(PRD_ROOT_REL, "__doctor-probe__", "prd.md");
  const implementProbe = path.join(IMPLEMENT_ROOT_REL, "__doctor-probe__", "state.json");
  const prdGlob = `${PRD_ROOT_REL}/**`;
  const implementGlob = `${IMPLEMENT_ROOT_REL}/**`;
  if (gitIgnored(projectRoot, prdProbe)) {
    add("warn", "gitignore", `${prdGlob} is ignored; PRD source files should be trackable`);
  } else {
    add("ok", "gitignore", `${prdGlob} is trackable`);
  }
  if (gitIgnored(projectRoot, PROJECT_CONFIG_PATH)) {
    add("warn", "gitignore", `${PROJECT_CONFIG_PATH} is ignored; prd-setup project configuration should be trackable`);
  } else {
    add("ok", "gitignore", `${PROJECT_CONFIG_PATH} is trackable`);
  }
  if (gitIgnored(projectRoot, implementProbe)) {
    add("ok", "gitignore", `${implementGlob} is ignored`);
  } else {
    add("warn", "gitignore", `${implementGlob} is not ignored; implementation state and evidence should stay out of normal commits`);
  }
  const gatesProbe = path.join("agents", "gates", "__doctor-probe__", "gates.json");
  if (gitIgnored(projectRoot, gatesProbe)) {
    add("ok", "gitignore", "agents/gates/** is ignored");
  } else {
    add("warn", "gitignore", "agents/gates/** is not ignored; sasu gate state and judge artifacts should stay out of normal commits");
  }
}

function doctorCheckAgentsMdConvention(projectRoot, add) {
  const agentsMd = path.join(projectRoot, "AGENTS.md");
  const claudeMd = path.join(projectRoot, "CLAUDE.md");
  let claudeStat = null;
  try {
    claudeStat = fs.lstatSync(claudeMd);
  } catch {
    claudeStat = null;
  }
  const agentsExists = fs.existsSync(agentsMd);
  if (!agentsExists && !claudeStat) return;
  if (!claudeStat) {
    add("warn", "agents-md", "AGENTS.md exists but CLAUDE.md does not; run seed-agents-md to add the symlink so both runtimes read one file");
    return;
  }
  if (!claudeStat.isSymbolicLink()) {
    add("warn", "agents-md", agentsExists
      ? "CLAUDE.md is a regular file next to AGENTS.md; merge it into AGENTS.md and replace it with a symlink (AGENTS.md is the main file)"
      : "CLAUDE.md is a regular file and AGENTS.md is missing; run seed-agents-md --adopt-claude-md after confirming with the user");
    return;
  }
  const target = fs.readlinkSync(claudeMd);
  if (path.basename(target) === "AGENTS.md") {
    add("ok", "agents-md", "CLAUDE.md is a symlink to AGENTS.md");
  } else {
    add("warn", "agents-md", `CLAUDE.md is a symlink to '${target}', not AGENTS.md`);
  }
}

// Rot check for the learned-rules ledger: every row must still point at a
// real landing, and active invariants must still arm on something real.
function doctorCheckRulesLedger(projectRoot, add) {
  const rulesRootAbs = path.join(projectRoot, RULES_ROOT_REL);
  const namespaceDir = path.join(projectRoot, NAMESPACE_ROOT);
  if (!fs.existsSync(rulesRootAbs)) {
    if (fs.existsSync(namespaceDir)) {
      const known = new Set(["prd", "implement", "rules", "intake", "clarify", "config.json"]);
      const entries = fs.readdirSync(namespaceDir).filter(entry => !entry.startsWith("."));
      if (entries.length > 0 && entries.every(entry => !known.has(entry))) {
        add("warn", "agents-namespace", `${NAMESPACE_ROOT}/ exists but holds none of the harness layout (${entries.slice(0, 5).join(", ")}); if it belongs to the application, set namespace.root in ${PROJECT_CONFIG_PATH} to relocate harness artifacts`);
      }
    }
    return;
  }
  let ledger;
  let invariants;
  try {
    ledger = readLedger(projectRoot);
    invariants = loadInvariants(projectRoot);
  } catch (error) {
    add("error", "rules", `rules tree is unreadable: ${error.message}`);
    return;
  }
  let rotten = 0;
  for (const row of ledger) {
    if (!fs.existsSync(path.join(projectRoot, row.landing))) {
      rotten += 1;
      add("warn", "rules", `Ledger row ${row.id} points at a missing landing: ${row.landing}; re-land the lesson or retire the row via rules add`);
    }
  }
  for (const rule of invariants) {
    if (rule.status !== "active") continue;
    const arms = rule.trigger.paths.some(glob => {
      const prefix = globLiteralPrefix(glob);
      return prefix === "" || fs.existsSync(path.join(projectRoot, prefix));
    });
    if (!arms) {
      rotten += 1;
      add("warn", "rules", `Invariant ${rule.id} triggers on paths that no longer exist (${rule.trigger.paths.join(", ")}); update or retire it`);
    }
  }
  const pendingCount = loadPending(projectRoot).length;
  if (pendingCount > 0) {
    add("warn", "rules", `${pendingCount} lesson(s) in ${RULES_ROOT_REL}/pending/ have not landed as docs or tests yet`);
  }
  if (rotten === 0) {
    add("ok", "rules", `Rules ledger healthy: ${ledger.length} rule(s), ${invariants.filter(rule => rule.status === "active").length} active invariant(s), ${pendingCount} pending`);
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

// Sasu gate CLI readiness (PRD mini-cli-llm-boundary R10): binary +
// contract version, judge backends, and verify-command configuration. All
// findings are warnings because gates degrade to recorded fallbacks.
function doctorCheckSasuCli(projectRoot, add) {
  const version = childProcess.spawnSync("sasu", ["--contract-version"], { shell: false, encoding: "utf8" });
  if (version.status !== 0) {
    add("warn", "sasu", "sasu CLI is not on PATH; judge gates (gap-audit/spec/verify) will fall back (run scripts/install-local-skills.mjs in the harness repo)");
    return;
  }
  add("ok", "sasu", `sasu contract version ${String(version.stdout || "").trim()}`);
  const claude = childProcess.spawnSync("claude", ["--version"], { shell: false, encoding: "utf8" });
  const codex = childProcess.spawnSync("codex", ["--version"], { shell: false, encoding: "utf8" });
  if (claude.status !== 0 && codex.status !== 0) {
    add("warn", "sasu-judge", "no judge backend found (neither claude nor codex on PATH); gates fail closed until one is installed and logged in");
  } else {
    const backends = [claude.status === 0 ? "claude" : null, codex.status === 0 ? "codex" : null].filter(Boolean).join(", ");
    add("ok", "sasu-judge", `judge backends available: ${backends}`);
  }
  let verifyCommands = null;
  try {
    const projectConfig = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "config.json"), "utf8"));
    verifyCommands = projectConfig && projectConfig.verify && projectConfig.verify.commands ? projectConfig.verify.commands : null;
  } catch {
    verifyCommands = null;
  }
  if (verifyCommands && Object.keys(verifyCommands).length > 0) {
    add("ok", "sasu-verify", `verify commands declared in agents/config.json: ${Object.keys(verifyCommands).join(", ")}`);
  } else {
    add("warn", "sasu-verify", "no verify.commands in agents/config.json; sasu verify will detect from manifests and suggest pinning");
  }
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
  if (fs.existsSync(shipScript)) add("ok", "prd-ship", `ship script found: ${displayPath(shipScript)}`);
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
  cmdReady,
  cmdCleanupActive,
};
