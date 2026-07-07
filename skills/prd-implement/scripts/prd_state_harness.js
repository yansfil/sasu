#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const childProcess = require("child_process");

const SCHEMA = "hoyeon.prd-implement.state.v1";
const ACTIVE_PATH = path.join(".hoyeon", "implement", ".prd-implement-active.json");
const ACTIVE_SESSIONS_DIR = path.join(".hoyeon", "implement", ".prd-implement-sessions");
const PROJECT_CONFIG_PATH = path.join(".hoyeon", "config.json");
const DEFAULT_HOOK_TIMEOUT_MS = 9000;

function main() {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "init") return cmdInit(parseArgs(args));
    if (command === "status") return cmdStatus(parseArgs(args));
    if (command === "verify-delivery") return cmdVerifyDelivery(parseArgs(args));
    if (command === "doctor") return cmdDoctor();
    if (command === "next") return cmdNext(parseArgs(args));
    if (command === "plan-verification") return cmdPlanVerification(parseArgs(args));
    if (command === "plan-execution") return cmdPlanExecution(parseArgs(args));
    if (command === "ready") return cmdReady(parseArgs(args));
    if (command === "mark-node") return cmdMarkNode(parseArgs(args));
    if (command === "assign-node") return cmdAssignNode(parseArgs(args));
    if (command === "mark") return cmdMark(parseArgs(args));
    if (command === "record-artifact") return cmdRecordArtifact(parseArgs(args));
    if (command === "refresh-artifacts") return cmdRefreshArtifacts(parseArgs(args));
    if (command === "verify-run") return cmdVerifyRun(args);
    if (command === "requirements-review-prompt") return cmdRequirementsReviewPrompt(parseArgs(args));
    if (command === "requirements-review-record") return cmdRequirementsReviewRecord(parseArgs(args));
    if (command === "review-prompt") return cmdReviewPrompt(parseArgs(args));
    if (command === "review-record") return cmdReviewRecord(parseArgs(args));
    if (command === "finalize") return cmdFinalize(parseArgs(args));
    if (command === "cleanup-active") return cmdCleanupActive(parseArgs(args));
    if (command === "hook") return cmdHook(args[0] || "stop");
    usage(1);
  } catch (error) {
    process.stderr.write(`${error && error.message ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

function usage(exitCode) {
  const script = "~/.codex/skills/prd-implement/scripts/prd_state_harness.js";
  process.stderr.write(`Usage:
  node ${script} init --prd <path> [--session-id <codex-session-id>] [--allow-unapproved-prd "<verbatim user approval>"] [--delivery local|pr] [--branch <branch>] [--review-profile trivial|standard|high-risk] [--skip-worktree] [--force]
  node ${script} status [--state <path>]
  node ${script} verify-delivery [--state <path>]
  node ${script} doctor
  node ${script} next [--state <path>]
  node ${script} plan-verification [--state <path>]
  node ${script} plan-verification --prd <path>   (stateless PRD contract precheck; no init, no writes)
  node ${script} plan-execution [--state <path>]
  node ${script} ready [--state <path>]
  node ${script} mark-node --id <Nn[,Nn...]> --status pending|in_progress|complete|blocked|deferred --evidence <text>
  node ${script} assign-node --id <Nn> --owner coordinator|subagent:<id>|<short-owner>
  node ${script} mark --kind task|ac|verification --id <id[,id...]> --status <status> --evidence <text>
  node ${script} verify-run --id <Vn> -- <command...>
  node ${script} record-artifact --id <id> --kind screenshot|log|browser|api|db|file --path <path> --description <text>
  node ${script} refresh-artifacts [--id <id>] [--state <path>]
  node ${script} requirements-review-prompt [--state <path>]
  node ${script} requirements-review-record --status pass|fail --report <path> --summary <text>
  node ${script} review-prompt [--state <path>]
  node ${script} review-record --status pass|fail --report <path> --summary <text>
  node ${script} finalize --status complete|partial|blocked --summary <text>
  node ${script} cleanup-active [--state <path>]
  node ${script} hook stop|subagent-stop|pretool-use
`);
  process.exit(exitCode);
}

function parseArgs(args) {
  const out = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      if (!out._) out._ = [];
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      index += 1;
    }
  }
  return out;
}

function parseIdList(value, normalize = item => item) {
  return String(value || "")
    .split(/[,\s]+/)
    .map(item => normalize(item.trim()))
    .filter(Boolean);
}

function nowIso() {
  return new Date().toISOString();
}

function cwd() {
  return process.cwd();
}

function resolveProjectPath(input, baseDir = cwd()) {
  if (!input || typeof input !== "string") throw new Error("path argument is required");
  const expanded = input.startsWith("~/") ? path.join(os.homedir(), input.slice(2)) : input;
  return path.resolve(baseDir, expanded);
}

function toProjectRelative(absPath, baseDir = cwd()) {
  const rel = path.relative(canonicalPath(baseDir), canonicalPath(absPath));
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : absPath;
}

function canonicalPath(input) {
  const resolved = path.resolve(input);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function appendJsonl(file, value) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

function safeTimestamp() {
  return nowIso().replace(/[:.]/g, "-");
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function formatCommandArgs(args) {
  return args.map(shellQuote).join(" ");
}

function commandArgsForCompare(args) {
  const command = String(args[0] || "");
  if (args.length >= 3 && /^(?:bash|sh|zsh)$/.test(path.basename(command)) && args[1] === "-c") {
    return args.slice(2).join(" ");
  }
  if (args.length >= 4 && /^(?:bash|sh|zsh)$/.test(path.basename(command)) && args[1] === "-l" && args[2] === "-c") {
    return args.slice(3).join(" ");
  }
  if (args.length >= 3 && /^(?:bash|sh|zsh)$/.test(path.basename(command)) && args[1] === "-lc") {
    return args.slice(2).join(" ");
  }
  return formatCommandArgs(args);
}

function runCommand(command, args, options = {}) {
  const result = childProcess.spawnSync(command, args, {
    cwd: options.cwd || cwd(),
    shell: options.shell === true,
    encoding: "utf8",
    maxBuffer: options.maxBuffer || 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const rendered = options.shell === true ? command : formatCommandArgs([command, ...args]);
    const details = [
      `Command failed: ${rendered}`,
      `cwd: ${options.cwd || cwd()}`,
      `exitCode: ${typeof result.status === "number" ? result.status : "unknown"}`,
      result.stdout ? `stdout:\n${result.stdout}` : "",
      result.stderr ? `stderr:\n${result.stderr}` : "",
      result.error && result.error.message ? `error: ${result.error.message}` : "",
    ].filter(Boolean);
    throw new Error(details.join("\n"));
  }
  return result;
}

function runGit(projectRoot, args, options = {}) {
  return runCommand("git", args, { ...options, cwd: projectRoot });
}

function readProjectConfig(projectRoot) {
  const configPath = path.join(projectRoot, PROJECT_CONFIG_PATH);
  if (!fs.existsSync(configPath)) return {};
  const parsed = readJson(configPath);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${PROJECT_CONFIG_PATH} must contain a JSON object`);
  }
  return parsed;
}

function stringArray(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("Expected an array of strings");
  return value.map(item => {
    if (typeof item !== "string" || !item.trim()) throw new Error("Expected an array of non-empty strings");
    return item.trim();
  });
}

function commandArray(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("Expected an array of setup command strings");
  return value.map(item => {
    if (typeof item !== "string" || !item.trim()) throw new Error("Expected an array of non-empty setup command strings");
    return item.trim();
  });
}

function safeBranchSegment(value) {
  return String(value || "")
    .replace(/[\\/]+/g, "-")
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "prd-work";
}

function currentBranch(projectRoot) {
  const result = childProcess.spawnSync("git", ["branch", "--show-current"], {
    cwd: projectRoot,
    shell: false,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function branchExists(projectRoot, branch) {
  if (!branch) return false;
  const result = childProcess.spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd: projectRoot,
    shell: false,
    encoding: "utf8",
  });
  return result.status === 0;
}

function normalizeDeliveryConfig(projectRoot, options, projectConfig, slug) {
  const deliveryInput = projectConfig && typeof projectConfig.delivery === "object" && projectConfig.delivery
    ? projectConfig.delivery
    : {};
  const worktreeInput = projectConfig && typeof projectConfig.worktree === "object" && projectConfig.worktree
    ? projectConfig.worktree
    : {};
  const mode = String(options.delivery || deliveryInput.mode || deliveryInput.default || "local").trim().toLowerCase();
  if (!["local", "pr"].includes(mode)) throw new Error(`Unsupported delivery mode '${mode}'. Expected local or pr.`);
  const branchPrefix = String(deliveryInput.branchPrefix || "prd").replace(/\/+$/g, "") || "prd";
  const branch = String(options.branch || deliveryInput.branch || `${branchPrefix}/${slug}`).trim();
  const stagingInput = deliveryInput.staging && typeof deliveryInput.staging === "object"
    ? deliveryInput.staging
    : {};
  const repoName = path.basename(canonicalPath(projectRoot));
  const worktreeRoot = worktreeInput.root
    ? resolveProjectPath(String(worktreeInput.root), projectRoot)
    : path.resolve(projectRoot, "..", `${repoName}.worktrees`);
  const worktreePath = worktreeInput.path
    ? resolveProjectPath(String(worktreeInput.path), projectRoot)
    : path.join(worktreeRoot, safeBranchSegment(branch));
  return {
    schema: "hoyeon.delivery.v1",
    mode,
    branch,
    baseBranch: String(deliveryInput.baseBranch || currentBranch(projectRoot) || "main"),
    prTemplate: deliveryInput.prTemplate ? String(deliveryInput.prTemplate) : null,
    ci: {
      watch: deliveryInput.ci && typeof deliveryInput.ci === "object" && deliveryInput.ci.watch !== undefined
        ? Boolean(deliveryInput.ci.watch)
        : mode === "pr",
      maxFixAttempts: Number.isFinite(Number(deliveryInput.ci && deliveryInput.ci.maxFixAttempts))
        ? Number(deliveryInput.ci.maxFixAttempts)
        : 2,
    },
    staging: {
      include: stringArray(stagingInput.include),
      exclude: stringArray(stagingInput.exclude),
    },
    worktree: {
      enabled: Boolean(worktreeInput.enabled),
      path: worktreePath,
      root: worktreeRoot,
      link: stringArray(worktreeInput.link),
      copy: stringArray(worktreeInput.copy),
      setup: commandArray(worktreeInput.setup),
    },
    configPath: fs.existsSync(path.join(projectRoot, PROJECT_CONFIG_PATH)) ? PROJECT_CONFIG_PATH : null,
  };
}

// Execution behavior is sequential/atomic by default. Parallel ready-group
// suggestions are opt-in through `.hoyeon/config.json` `execution.parallel` (or
// `--parallel` at init), so a simple run never carries parallel scaffolding and
// a user who wants it turns it on via prd-setup.
function normalizeExecutionConfig(projectConfig, options) {
  const input = projectConfig && typeof projectConfig.execution === "object" && projectConfig.execution
    ? projectConfig.execution
    : {};
  const flag = options ? options.parallel : undefined;
  const parallel = flag !== undefined
    ? flag === true || String(flag).toLowerCase() === "true"
    : Boolean(input.parallel);
  return { schema: "hoyeon.execution.v1", parallel };
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

function isLinkedWorktree(projectRoot) {
  const result = childProcess.spawnSync("git", ["rev-parse", "--git-dir"], {
    cwd: projectRoot,
    shell: false,
    encoding: "utf8",
  });
  if (result.status !== 0) return false;
  return result.stdout.trim().replace(/\\/g, "/").includes("/worktrees/");
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
  const childArgs = [__filename, "init", "--prd", prdRel, "--delivery", deliveryConfig.mode, "--branch", deliveryConfig.branch, "--skip-worktree"];
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

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(String(text || "")).digest("hex");
}

function assertReviewReportStatus(reportAbs, status) {
  const expected = status === "pass" ? "PASS" : "FAIL";
  const text = fs.readFileSync(reportAbs, "utf8");
  const match = text.match(/^\s*Status:\s*(PASS|FAIL)\s*$/im);
  if (!match) {
    throw new Error(`Review report must include a standalone 'Status: ${expected}' line`);
  }
  if (match[1].toUpperCase() !== expected) {
    throw new Error(`Review report status ${match[1].toUpperCase()} does not match --status ${status}`);
  }
}

function assertFinalReviewReport(reportAbs, status, state) {
  assertReviewReportStatus(reportAbs, status);
  const text = fs.readFileSync(reportAbs, "utf8");
  const violations = [];
  for (const heading of ["Fidelity Review Checked", "Findings", "Checklist Coverage", "Artifact Audit", "Deviation Audit", "Verdict"]) {
    if (!meaningfulReviewSection(extractSection(text, heading))) {
      violations.push(`Final review section '${heading}' is missing or empty`);
    }
  }
  // The final review audits the requirements fidelity review as the primary
  // semantic proof; it deliberately does not repeat a per-V# checklist (the
  // fidelity report already enforces one). Forcing every V# id here contradicted
  // the skill's own "keep the Artifact Audit thin" guidance, so it is not checked.
  const fidelity = state.requirementsFidelityReview;
  if (status === "pass") {
    if (!fidelity || fidelity.status !== "pass") {
      violations.push("Final review cannot pass before a recorded passing requirements fidelity review");
    } else {
      const shaPrefix = String(fidelity.reportSha256 || "").slice(0, 12);
      if (shaPrefix && !text.includes(shaPrefix)) {
        violations.push(`Final review must cite the recorded requirements fidelity review report sha256 prefix ${shaPrefix} in the 'Fidelity Review Checked' section; read it from state.json after the fidelity review is recorded`);
      }
      const recordedAt = Date.parse(fidelity.recordedAt || "");
      const reportMtime = fs.statSync(reportAbs).mtimeMs;
      if (Number.isFinite(recordedAt) && reportMtime + 2000 < recordedAt) {
        violations.push("Final review report was written before the requirements fidelity review was recorded; run the independent final reviewer after the fidelity review is recorded");
      }
    }
    if (/\b(?:TODO|TBD|FIXME)\b/i.test(text)) {
      violations.push("Passing final review must not contain TODO, TBD, or FIXME placeholders");
    }
  }
  if (status === "fail" && reviewBulletCount(extractSection(text, "Findings")) < 1) {
    violations.push("Failing final review must include at least one finding");
  }
  if (violations.length) {
    throw new Error(`Invalid final review report:\n- ${violations.join("\n- ")}`);
  }
}

function assertRequirementsFidelityReport(reportAbs, status, state) {
  assertReviewReportStatus(reportAbs, status);
  const text = fs.readFileSync(reportAbs, "utf8");
  const requiredSections = [
    "Intent Sources Read",
    "Decision Trace",
    "Findings",
    "Verification Intent Checklist",
    "Coverage Judgment",
    "Verdict",
  ];
  const violations = [];
  for (const heading of requiredSections) {
    const section = extractSection(text, heading);
    if (!meaningfulReviewSection(section)) {
      violations.push(`Requirements fidelity report section '${heading}' is missing or empty`);
    }
  }

  const intentSources = extractSection(text, "Intent Sources Read");
  if (reviewBulletCount(intentSources) < 1) {
    violations.push("Requirements fidelity report must list at least one intent source read");
  }

  const decisionTrace = extractSection(text, "Decision Trace");
  // Require a small floor of traced entries rather than one bullet per parsed
  // decision: a PRD with many decisions should not force the reviewer to
  // enumerate dozens of bullets, and a table trace is valid. The reviewer owns
  // how thoroughly to group; the coverage judgment below is the real gate.
  const decisionCount = state.intentTrace ? state.intentTrace.decisionCount || 0 : 0;
  const expectedDecisionCount = Math.min(Math.max(1, decisionCount), 3);
  const decisionTraceEntryCount = reviewEntryCount(decisionTrace);
  if (decisionTraceEntryCount < expectedDecisionCount) {
    violations.push(`Requirements fidelity report Decision Trace must include at least ${expectedDecisionCount} traced decision/proposal entr${expectedDecisionCount === 1 ? "y" : "ies"} (bullets or table rows); found ${decisionTraceEntryCount}`);
  }

  const coverage = extractSection(text, "Coverage Judgment");
  for (const label of ["Requirements", "Acceptance Criteria", "User-visible behavior", "Non-goals and rejected options", "Human verification"]) {
    const re = new RegExp(`^\\s*[-*]\\s*${escapeRegExp(label)}\\s*:\\s*\\S`, "im");
    if (!re.test(coverage)) violations.push(`Requirements fidelity report Coverage Judgment must include a non-empty '${label}:' line`);
  }

  const verificationChecklist = extractSection(text, "Verification Intent Checklist");
  for (const verification of state.verification || []) {
    if (!isVerificationRequiredForDone(verification)) continue;
    const re = new RegExp(`\\b${escapeRegExp(verification.id)}\\b`, "i");
    if (!re.test(verificationChecklist)) {
      violations.push(`Requirements fidelity report Verification Intent Checklist must include required verification ${verification.id}`);
    }
  }

  if (status === "pass") {
    // Strip fenced and inline code so legitimate generics/tags (`Array<string>`,
    // `<button>`) do not read as unfilled template placeholders. Only angle
    // tokens that carry a placeholder-style separator (space, slash, hash, or
    // hyphen) after a leading letter are treated as leftover `<topic-slug>`-style
    // markers.
    const prose = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
    const hasLeftoverPlaceholder = /<[A-Za-z][^>\n]*[ \/#-][^>\n]*>/.test(prose);
    if (/\b(?:TODO|TBD|FIXME)\b/i.test(prose) || hasLeftoverPlaceholder) {
      violations.push("Passing requirements fidelity report must not contain leftover <template> placeholders, TODO, TBD, or FIXME (code spans are exempt)");
    }
    const unresolvedGap = decisionTrace
      .split(/\r?\n/)
      .some(line => /\bgap\s*:\s*(?=\S)(?!none\b|no\b|n\/a\b|없음\b|-+\s*$).+/i.test(line.trim()));
    if (unresolvedGap) {
      violations.push("Passing requirements fidelity report Decision Trace contains a non-none gap");
    }
  }

  if (status === "fail" && reviewBulletCount(extractSection(text, "Findings")) < 1) {
    violations.push("Failing requirements fidelity report must include at least one finding");
  }

  if (violations.length) {
    throw new Error(`Invalid requirements fidelity report:\n- ${violations.join("\n- ")}`);
  }
}

function meaningfulReviewSection(section) {
  const cleaned = String(section || "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
  if (!cleaned) return false;
  if (/<[^>\n]+>/.test(cleaned) && cleaned.split(/\s+/).length < 12) return false;
  return true;
}

function reviewBulletCount(section) {
  return String(section || "")
    .split(/\r?\n/)
    .filter(line => /^\s*[-*]\s+\S/.test(line.trim()))
    .length;
}

// Count decision entries whether the reviewer used bullets or a markdown table,
// so a concise or tabular trace is not mechanically rejected. Table header rows
// may be counted too; that leniency is intentional.
function reviewEntryCount(section) {
  let count = 0;
  for (const raw of String(section || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (/^[-*]\s+\S/.test(line)) {
      count += 1;
    } else if (/^\|.*\|$/.test(line)) {
      const cells = parseMarkdownTableRow(line);
      if (!isTableSeparator(cells) && cells.some(cell => /[A-Za-z0-9]/.test(cell))) count += 1;
    }
  }
  return count;
}

function artifactManifestPath(statePath) {
  return path.join(path.dirname(statePath), "artifacts", "manifest.jsonl");
}

function reviewDir(statePath) {
  return path.join(path.dirname(statePath), "review");
}

function worktreeSnapshot(state) {
  const projectRoot = state.projectRoot || cwd();
  const gitDir = childProcess.spawnSync("git", ["rev-parse", "--git-dir"], {
    cwd: projectRoot,
    shell: false,
    encoding: "utf8",
  });
  if (gitDir.status !== 0) return null;
  const head = childProcess.spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: projectRoot,
    shell: false,
    encoding: "utf8",
  });
  const headSha = head.status === 0 ? head.stdout.trim() : null;
  const status = childProcess.spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: projectRoot,
    shell: false,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (status.status !== 0) return null;
  const excludedPrefixes = [
    normalizeRelPath(state.runDir || ""),
    normalizeRelPath(ACTIVE_PATH),
    normalizeRelPath(ACTIVE_SESSIONS_DIR),
  ].filter(Boolean);
  const entries = [];
  for (const raw of status.stdout.split("\0")) {
    if (!raw) continue;
    const parsed = parseGitStatusEntry(raw);
    if (!parsed.path) continue;
    const rel = normalizeRelPath(parsed.path);
    if (!rel || excludedPrefixes.some(prefix => rel === prefix || rel.startsWith(`${prefix}/`))) continue;
    const abs = path.join(projectRoot, rel);
    let fileHash = null;
    let fileBytes = null;
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      fileHash = sha256File(abs);
      fileBytes = fs.statSync(abs).size;
    }
    entries.push({
      status: parsed.status,
      path: rel,
      originalPath: parsed.originalPath ? normalizeRelPath(parsed.originalPath) : null,
      sha256: fileHash,
      bytes: fileBytes,
    });
  }
  entries.sort((a, b) => `${a.path}\0${a.status}`.localeCompare(`${b.path}\0${b.status}`));
  return {
    capturedAt: nowIso(),
    headSha,
    statusHash: simpleHash(JSON.stringify(entries)),
    entryCount: entries.length,
    entries,
  };
}

function normalizeRelPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/g, "");
}

function parseGitStatusEntry(raw) {
  const status = raw.slice(0, 2);
  let rest = raw.slice(3);
  let originalPath = null;
  if (rest.includes(" -> ")) {
    const parts = rest.split(" -> ");
    originalPath = parts[0];
    rest = parts.slice(1).join(" -> ");
  }
  return { status, path: rest, originalPath };
}

function ensureRunDirs(runDirAbs) {
  ensureDir(runDirAbs);
  ensureDir(path.join(runDirAbs, "artifacts"));
  ensureDir(path.join(runDirAbs, "artifacts", "logs"));
  ensureDir(path.join(runDirAbs, "artifacts", "screenshots"));
  ensureDir(path.join(runDirAbs, "artifacts", "browser"));
  ensureDir(path.join(runDirAbs, "artifacts", "api"));
  ensureDir(path.join(runDirAbs, "artifacts", "db"));
  ensureDir(path.join(runDirAbs, "review"));
}

function collectArtifacts(state) {
  const artifacts = [];
  for (const group of [
    ["execution_node", state.executionPlan && state.executionPlan.nodes ? state.executionPlan.nodes : []],
    ["task", state.tasks || []],
    ["ac", state.acceptanceCriteria || []],
    ["verification", state.verification || []],
  ]) {
    const [kind, items] = group;
    for (const item of items) {
      for (const artifact of item.artifacts || []) {
        artifacts.push({ ownerKind: kind, ownerId: item.id, artifact });
      }
    }
  }
  return artifacts;
}

function isVerificationRequiredForDone(verification) {
  const matrix = verification && verification.matrix ? verification.matrix : {};
  if (typeof matrix.requiredForDone === "boolean") return matrix.requiredForDone;
  return true;
}

function verificationIsClosedForAccounting(verification) {
  if (!verification) return false;
  if (verification.status === "pass") return true;
  if (!isVerificationRequiredForDone(verification) && ["skipped", "blocked"].includes(verification.status)) return true;
  return false;
}

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

function markFinalReviewStale(state, reason) {
  if (!state.finalReview || state.finalReview.status !== "pass") return null;
  state.finalReview.status = "stale";
  state.finalReview.staleAt = nowIso();
  state.finalReview.staleReason = reason;
  return state.finalReview;
}

function markRequirementsFidelityReviewStale(state, reason) {
  if (!state.requirementsFidelityReview || state.requirementsFidelityReview.status !== "pass") return null;
  state.requirementsFidelityReview.status = "stale";
  state.requirementsFidelityReview.staleAt = nowIso();
  state.requirementsFidelityReview.staleReason = reason;
  return state.requirementsFidelityReview;
}

function markCompletionReviewsStale(state, reason) {
  markRequirementsFidelityReviewStale(state, reason);
  markFinalReviewStale(state, reason);
}

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

function verificationPlanBlocksImplementation(state) {
  const summary = verificationPlanSummary(state);
  return summary.status === "missing" || summary.blockingGapCount > 0;
}

function executionPlanSummary(state) {
  const plan = state.executionPlan;
  if (!plan) {
    return {
      status: "missing",
      nodeCount: 0,
      openNodeCount: 1,
      blockingGapCount: 1,
      warningCount: 0,
    };
  }
  const nodes = plan.nodes || [];
  const gaps = plan.gaps || [];
  return {
    status: plan.status || "unknown",
    nodeCount: nodes.length,
    openNodeCount: nodes.filter(node => !["complete", "blocked", "deferred"].includes(node.status)).length,
    blockingGapCount: gaps.filter(gap => gap.severity === "blocking").length,
    warningCount: gaps.filter(gap => gap.severity !== "blocking").length,
    generatedAt: plan.generatedAt,
  };
}

function executionPlanBlocksImplementation(state) {
  const summary = executionPlanSummary(state);
  return summary.status === "missing" || summary.blockingGapCount > 0;
}

function taskGraphSummary(state) {
  const graph = state.taskGraph && state.taskGraph.schema === "hoyeon.prd-implement.taskgraph.v2"
    ? state.taskGraph
    : buildTaskGraph(state);
  return {
    status: graph.status || "unknown",
    nodeCount: graph.summary ? graph.summary.nodeCount : (graph.nodes || []).length,
    edgeCount: graph.summary ? graph.summary.edgeCount : (graph.edges || []).length,
    openNodeCount: graph.summary ? graph.summary.openNodeCount : (graph.nodes || []).filter(node => !node.closed).length,
    blockingGapCount: graph.summary ? graph.summary.blockingGapCount : verificationPlanSummary(state).blockingGapCount,
    generatedAt: graph.generatedAt,
  };
}

function findTrackedItem(state, id, preferredKind = null) {
  const normalized = String(id || "").toUpperCase();
  const groups = [
    { kind: "execution_node", list: state.executionPlan && state.executionPlan.nodes ? state.executionPlan.nodes : [] },
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

function inspectArtifact(absPath, kind) {
  if (!fs.existsSync(absPath)) throw new Error(`Artifact not found: ${absPath}`);
  const stat = fs.statSync(absPath);
  if (!stat.isFile()) throw new Error(`Artifact is not a file: ${absPath}`);
  if (stat.size <= 0) throw new Error(`Artifact is empty: ${absPath}`);

  const buffer = fs.readFileSync(absPath);
  const lower = absPath.toLowerCase();
  const info = {
    bytes: stat.size,
    sha256: sha256File(absPath),
    mimeHint: "application/octet-stream",
  };

  const isPng = buffer.length >= 24
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
    && buffer[4] === 0x0d
    && buffer[5] === 0x0a
    && buffer[6] === 0x1a
    && buffer[7] === 0x0a;
  const isJpeg = buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;

  if (isPng) {
    info.mimeHint = "image/png";
    info.width = buffer.readUInt32BE(16);
    info.height = buffer.readUInt32BE(20);
  } else if (isJpeg) {
    info.mimeHint = "image/jpeg";
  } else if (lower.endsWith(".log") || lower.endsWith(".txt") || lower.endsWith(".json") || lower.endsWith(".md")) {
    info.mimeHint = "text/plain";
  }

  if (kind === "screenshot" || kind === "image") {
    if (!isPng && !isJpeg) throw new Error(`Screenshot artifact must be PNG or JPEG: ${absPath}`);
    if (!/\.(png|jpe?g)$/i.test(absPath)) throw new Error(`Screenshot artifact must use .png, .jpg, or .jpeg extension: ${absPath}`);
  }

  return info;
}

function validateArtifacts(statePath, state) {
  const violations = [];
  for (const entry of collectArtifacts(state)) {
    const artifact = entry.artifact || {};
    if (!artifact.path) {
      violations.push(`${entry.ownerKind} ${entry.ownerId} has artifact without path`);
      continue;
    }
    try {
      const abs = resolveProjectPath(artifact.path, state.projectRoot || cwd());
      const info = inspectArtifact(abs, artifact.kind || "file");
      if (artifact.sha256 && artifact.sha256 !== info.sha256) {
        violations.push(`${entry.ownerKind} ${entry.ownerId} artifact ${artifact.artifactId || artifact.path} hash changed`);
      }
    } catch (error) {
      violations.push(`${entry.ownerKind} ${entry.ownerId} artifact invalid: ${error.message}`);
    }
  }
  const requirementsReview = state.requirementsFidelityReview;
  if (requirementsReview && requirementsReview.reportPath) {
    try {
      const abs = resolveProjectPath(requirementsReview.reportPath, state.projectRoot || cwd());
      inspectArtifact(abs, "log");
      if (requirementsReview.reportSha256 && requirementsReview.reportSha256 !== sha256File(abs)) {
        violations.push("Requirements fidelity review report hash changed");
      }
    } catch (error) {
      violations.push(`Requirements fidelity review report invalid: ${error.message}`);
    }
  }
  const finalReview = state.finalReview;
	  if (finalReview && finalReview.reportPath) {
    try {
      const abs = resolveProjectPath(finalReview.reportPath, state.projectRoot || cwd());
      inspectArtifact(abs, "log");
      if (finalReview.reportSha256 && finalReview.reportSha256 !== sha256File(abs)) {
        violations.push("Final review report hash changed");
      }
    } catch (error) {
      violations.push(`Final review report invalid: ${error.message}`);
    }
	  }
	  violations.push(...unregisteredArtifactViolations(statePath, state));
	  violations.push(...verificationEvidenceKindViolations(state));
	  violations.push(...requirementsFidelityReviewFreshnessViolations(state));
	  violations.push(...finalReviewFreshnessViolations(state));
	  violations.push(...reviewWorktreeSnapshotViolations(state));
	  return violations;
	}

const REQUIRED_EVIDENCE_KINDS_BY_CATEGORY = {
  command: ["command-log"],
  automated: ["command-log"],
  browser: ["screenshot", "image", "browser"],
  server: ["log", "command-log", "api", "screenshot"],
  api: ["api", "command-log", "log"],
  db: ["db", "command-log", "log"],
  // A required check that classified as manual-agent still needs a concrete
  // captured artifact; a hand-authored file/markdown must not satisfy it.
  "manual-agent": ["screenshot", "image", "browser", "api", "db", "log", "command-log"],
};

function verificationCategory(state, verification) {
  const checks = (state.verificationPlan && state.verificationPlan.checks) || [];
  const check = checks.find(item => item.verificationId === verification.id);
  if (check && check.category) return check.category;
  const mode = inferVerificationMode(verification, state.testModeContract || []);
  return classifyVerification(verification, mode);
}

function verificationEvidenceKindViolations(state) {
  const violations = [];
  for (const verification of state.verification || []) {
    if (!isVerificationRequiredForDone(verification)) continue;
    if (verification.status !== "pass") continue;
    const category = verificationCategory(state, verification);
    const allowed = REQUIRED_EVIDENCE_KINDS_BY_CATEGORY[category];
    if (!allowed) continue;
    const qualifying = (verification.artifacts || []).filter(artifact => {
      if (!artifact || !artifact.path) return false;
      if (/\.(md|markdown)$/i.test(artifact.path)) return false;
      return allowed.includes(artifact.kind);
    });
    if (!qualifying.length) {
      violations.push(`Required verification ${verification.id} (${category}) has no qualifying evidence artifact: expected kind ${allowed.join("/")} captured from the actual run; markdown summaries and prose files do not count`);
    }
  }
  return violations;
}

function unregisteredArtifactViolations(statePath, state) {
  const violations = [];
  const projectRoot = state.projectRoot || cwd();
  const artifactsDir = path.join(path.dirname(statePath), "artifacts");
  if (!fs.existsSync(artifactsDir)) return violations;
  const registered = new Set();
  for (const entry of collectArtifacts(state)) {
    if (entry.artifact && entry.artifact.path) {
      registered.add(toProjectRelative(resolveProjectPath(entry.artifact.path, projectRoot), projectRoot));
    }
  }
  for (const rel of readManifestArtifactPaths(artifactManifestPath(statePath), projectRoot)) registered.add(rel);
  for (const abs of listFilesRecursive(artifactsDir)) {
    const rel = toProjectRelative(abs, projectRoot);
    if (rel === toProjectRelative(artifactManifestPath(statePath), projectRoot)) continue;
    if (!registered.has(rel)) violations.push(`Unregistered artifact file: ${rel}`);
  }
  return violations;
}

function readManifestArtifactPaths(file, projectRoot) {
  const paths = [];
  if (!fs.existsSync(file)) return paths;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.path) paths.push(toProjectRelative(resolveProjectPath(entry.path, projectRoot), projectRoot));
    } catch {
      // Ignore malformed historical lines; validateArtifacts handles state-backed evidence.
    }
  }
  return paths;
}

function listFilesRecursive(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(abs));
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

function finalReviewFreshnessViolations(state) {
  const review = state.finalReview;
  if (!review || !review.recordedAt || review.status !== "pass") return [];
  const reviewedAt = Date.parse(review.recordedAt);
  if (!Number.isFinite(reviewedAt)) return ["Final review recordedAt is invalid"];
  const requirementsReview = state.requirementsFidelityReview;
  if (requirementsReview && requirementsReview.status === "pass" && requirementsReview.recordedAt) {
    const requirementsReviewedAt = Date.parse(requirementsReview.recordedAt);
    if (Number.isFinite(requirementsReviewedAt) && requirementsReviewedAt > reviewedAt) {
      return ["Final review is stale: requirements fidelity review was recorded after final review"];
    }
  }
  const latest = latestEvidenceTimestamp(state);
  if (latest && latest.time > reviewedAt) {
    return [`Final review is stale: ${latest.label} was recorded after final review`];
  }
  return [];
}

function requirementsFidelityReviewFreshnessViolations(state) {
  const review = state.requirementsFidelityReview;
  if (!review || !review.recordedAt || !["pass", "fail"].includes(review.status)) return [];
  const reviewedAt = Date.parse(review.recordedAt);
  if (!Number.isFinite(reviewedAt)) return ["Requirements fidelity review recordedAt is invalid"];
  const latest = latestEvidenceTimestamp(state);
  if (latest && latest.time > reviewedAt) {
    return [`Requirements fidelity review is stale: ${latest.label} was recorded after requirements fidelity review`];
  }
  return [];
}

function reviewWorktreeSnapshotViolations(state) {
  const violations = [];
  const current = worktreeSnapshot(state);
  if (!current) return violations;
  const check = (review, label) => {
    if (!review || !["pass", "fail"].includes(review.status) || !review.worktreeSnapshot) return;
    const headChanged = Boolean(review.worktreeSnapshot.headSha && current.headSha
      && review.worktreeSnapshot.headSha !== current.headSha);
    if ((headChanged || review.worktreeSnapshot.statusHash !== current.statusHash)
      && !reviewSnapshotMatchesCurrent(review.worktreeSnapshot, current, state)) {
      violations.push(`${label} is stale: worktree source snapshot changed after review`);
    }
  };
  check(state.requirementsFidelityReview, "Requirements fidelity review");
  check(state.finalReview, "Final review");
  return violations;
}

function reviewSnapshotMatchesCurrent(savedSnapshot, currentSnapshot, state) {
  const projectRoot = state.projectRoot || cwd();
  // A commit that leaves the working tree clean would otherwise produce an
  // identical status snapshot; comparing HEAD catches commit-only source changes
  // after a review. Only enforced when both snapshots recorded a HEAD (backward
  // compatible with snapshots captured before this field existed).
  if (savedSnapshot && currentSnapshot && savedSnapshot.headSha && currentSnapshot.headSha
    && savedSnapshot.headSha !== currentSnapshot.headSha) {
    return false;
  }
  const savedEntries = Array.isArray(savedSnapshot && savedSnapshot.entries) ? savedSnapshot.entries : [];
  const currentEntries = Array.isArray(currentSnapshot && currentSnapshot.entries) ? currentSnapshot.entries : [];
  const savedByPath = new Map(savedEntries.map(entry => [normalizeRelPath(entry.path), entry]));
  const currentByPath = new Map(currentEntries.map(entry => [normalizeRelPath(entry.path), entry]));

  for (const saved of savedEntries) {
    const rel = normalizeRelPath(saved.path);
    const current = currentByPath.get(rel);
    if (current) {
      if ((saved.sha256 || null) !== (current.sha256 || null)) return false;
      if ((saved.bytes ?? null) !== (current.bytes ?? null)) return false;
      continue;
    }
    if (saved.sha256) {
      const abs = path.join(projectRoot, rel);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return false;
      if (sha256File(abs) !== saved.sha256) return false;
      if ((saved.bytes ?? null) !== fs.statSync(abs).size) return false;
    } else {
      const abs = path.join(projectRoot, rel);
      if (fs.existsSync(abs)) return false;
    }
  }

  for (const current of currentEntries) {
    const rel = normalizeRelPath(current.path);
    const saved = savedByPath.get(rel);
    if (!saved) return false;
    if ((saved.sha256 || null) !== (current.sha256 || null)) return false;
    if ((saved.bytes ?? null) !== (current.bytes ?? null)) return false;
  }

  return true;
}

function latestEvidenceTimestamp(state) {
  let latest = null;
  const consider = (value, label) => {
    const time = Date.parse(value || "");
    if (!Number.isFinite(time)) return;
    if (!latest || time > latest.time) latest = { time, label };
  };
  const groups = [
    ["execution node", state.executionPlan && state.executionPlan.nodes ? state.executionPlan.nodes : []],
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

function assertArtifactPathIsEvidence(state, statePath, absPath) {
  const runDirAbs = path.dirname(statePath);
  const relToRunDir = path.relative(runDirAbs, absPath);
  const insideRunDir = relToRunDir && !relToRunDir.startsWith("..") && !path.isAbsolute(relToRunDir);
  if (!insideRunDir) return;
  const segments = relToRunDir.split(path.sep);
  if (segments[0] !== "artifacts") {
    throw new Error(`Run-dir file is not evidence: ${relToRunDir}. Harness state, plans, reviews, and self-authored run documents cannot be registered as artifacts; only captured evidence under ${state.runDir}/artifacts qualifies.`);
  }
  if (segments.length === 2 && segments[1] === "manifest.jsonl") {
    throw new Error("The artifact manifest itself cannot be registered as an artifact");
  }
}

function attachArtifact(statePath, state, match, kind, inputPath, description, extra = {}) {
  const artifactKinds = ["screenshot", "image", "log", "command-log", "browser", "api", "db", "file"];
  if (!artifactKinds.includes(kind)) throw new Error(`--kind must be one of: ${artifactKinds.join(", ")}`);
  const cleanDescription = String(description || "").trim();
  if (!cleanDescription) throw new Error("--description is required");
  const absPath = resolveProjectPath(inputPath, state.projectRoot || cwd());
  assertArtifactPathIsEvidence(state, statePath, absPath);
  const info = inspectArtifact(absPath, kind);
  const relPath = toProjectRelative(absPath, state.projectRoot || cwd());
  const artifact = {
    artifactId: `${match.item.id}-${kind}-${safeTimestamp()}`,
    kind,
    path: relPath,
    description: cleanDescription,
    createdAt: nowIso(),
    bytes: info.bytes,
    sha256: info.sha256,
    mimeHint: info.mimeHint,
    ...extra,
  };
  if (info.width) artifact.width = info.width;
  if (info.height) artifact.height = info.height;
  if (!match.item.artifacts) match.item.artifacts = [];
  if (!match.item.evidence) match.item.evidence = [];
  match.item.artifacts.push(artifact);
  match.item.evidence.push({
    ts: nowIso(),
    text: `Artifact recorded: ${artifact.kind} ${artifact.path} (${artifact.sha256.slice(0, 12)}) - ${cleanDescription}`,
  });
  appendJsonl(artifactManifestPath(statePath), {
    ts: nowIso(),
    attachedTo: { kind: match.kind, id: match.item.id },
    ...artifact,
  });
  return artifact;
}

function slugFromPrdPath(prdPath) {
  const parts = prdPath.split(path.sep);
  const prdIndex = parts.lastIndexOf("prd.md");
  if (prdIndex > 1 && parts[prdIndex - 2] === "prd") return parts[prdIndex - 1];
  const parent = path.basename(path.dirname(prdPath));
  if (parent && parent !== "." && parent !== path.basename(cwd())) return slugify(parent);
  return slugify(path.basename(prdPath, path.extname(prdPath)));
}

function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "prd-implementation";
}

function stripFrontmatter(markdown) {
  if (!markdown.startsWith("---\n")) return { frontmatter: {}, body: markdown };
  const end = markdown.indexOf("\n---", 4);
  if (end < 0) return { frontmatter: {}, body: markdown };
  const raw = markdown.slice(4, end).trim();
  const frontmatter = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    frontmatter[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
  }
  return { frontmatter, body: markdown.slice(end + 5) };
}

function extractSection(markdown, heading) {
  const lines = markdown.split(/\r?\n/);
  const headingRe = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "i");
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (headingRe.test(lines[index].trim())) {
      start = index + 1;
      break;
    }
  }
  if (start < 0) return "";
  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

function extractFirstSection(markdown, headings) {
  for (const heading of headings) {
    const section = extractSection(markdown, heading);
    if (section.trim()) return section;
  }
  return "";
}

function extractNestedSection(markdown, heading) {
  const lines = markdown.split(/\r?\n/);
  const headingRe = new RegExp(`^(#{2,6})\\s+${escapeRegExp(heading)}\\s*$`, "i");
  let start = -1;
  let level = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].trim().match(headingRe);
    if (match) {
      start = index + 1;
      level = match[1].length;
      break;
    }
  }
  if (start < 0) return "";
  let end = lines.length;
  const nextHeadingRe = /^(#{2,6})\s+/;
  for (let index = start; index < lines.length; index += 1) {
    const match = lines[index].trim().match(nextHeadingRe);
    if (match && match[1].length <= level) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

function extractFirstNestedSection(markdown, headings) {
  for (const heading of headings) {
    const section = extractNestedSection(markdown, heading);
    if (section.trim()) return section;
  }
  return "";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseMarkdownItems(section, prefix, fallbackLabel) {
  const items = [];
  let counter = 1;
  for (const rawLine of section.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("```") || /^#+\s+/.test(line)) continue;
    const match = line.match(/^(?:[-*]\s*(?:\[[ xX]\]\s*)?|(?:\d+[.)])\s+)(.+)$/);
    if (!match) continue;
    let text = match[1].replace(/^\*\*|\*\*$/g, "").trim();
    if (!text) continue;
    const explicit = text.match(new RegExp(`^(${prefix}\\d+|${prefix}-\\d+|${fallbackLabel}\\s*\\d+)\\b[.)?:\\s-]*`, "i"));
    let id;
    if (explicit) {
      id = explicit[1].replace(/\s+/g, "").replace("-", "").toUpperCase();
      text = text.slice(explicit[0].length).trim();
    } else {
      id = `${prefix}${counter}`;
    }
    counter += 1;
    items.push({
      id,
      title: firstSentence(text),
      text,
      requirements: uniqueMatches(text, /\bR\d+\b/gi),
      acceptanceCriteria: uniqueMatches(text, /\bAC\d+\b/gi),
      status: "pending",
      evidence: [],
      artifacts: [],
    });
  }
  return items;
}

function buildIntentTrace(parsed, projectRoot) {
  const prdDecisionTraceSection = extractFirstSection(parsed.body, [
    "4.3 Decision Traceability For Fidelity Review",
    "Decision Traceability For Fidelity Review",
  ]);
  const prdDecisionItems = parseDecisionTraceItems(prdDecisionTraceSection, "prd");
  const sourceFiles = intentSourceFiles(parsed.frontmatter, projectRoot);
  const sourceDecisionItems = [];
  const sources = [];
  for (const source of sourceFiles) {
    const sourceText = fs.readFileSync(source.abs, "utf8");
    const sourceSection = extractFirstSection(sourceText, [
      "Decision Traceability Seeds",
      "Axis Decisions",
      "Human Decisions Needed Before PRD Approval",
      "Human Decisions Before PRD Approval",
    ]);
    const items = parseDecisionTraceItems(sourceSection, source.rel);
    sourceDecisionItems.push(...items);
    sources.push({
      path: source.rel,
      sha256: sha256Text(sourceText),
      decisionCount: items.length,
    });
  }
  const decisions = [...prdDecisionItems, ...sourceDecisionItems];
  return {
    prdDecisionTraceHash: sha256Text(prdDecisionTraceSection),
    prdDecisionCount: prdDecisionItems.length,
    sourceDecisionCount: sourceDecisionItems.length,
    decisionCount: decisions.length,
    sources,
    decisions: decisions.slice(0, 80),
  };
}

function intentSourceFiles(frontmatter, projectRoot) {
  const files = [];
  for (const key of ["source_intake", "source_clarity"]) {
    for (const candidate of splitIntentSourceValue(frontmatter[key])) {
      const abs = resolveProjectPath(candidate, projectRoot);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
      const rel = toProjectRelative(abs, projectRoot);
      if (!files.some(file => file.rel === rel)) files.push({ abs, rel });
    }
  }
  return files;
}

function splitIntentSourceValue(value) {
  return String(value || "")
    .split(/[|,]/)
    .map(part => part.trim().replace(/^['"`]+|['"`]+$/g, ""))
    .filter(part => part && !/^(?:none|current conversation)$/i.test(part));
}

function parseDecisionTraceItems(section, source) {
  const items = [];
  let tableHeaders = null;
  const push = (text, stance = null, target = null) => {
    const cleaned = String(text || "").replace(/\s+/g, " ").trim();
    if (!cleaned || /^none\b/i.test(cleaned) || /^없음\b/.test(cleaned)) return;
    if (/^(?:decision\s*\/\s*proposal|---+)\b/i.test(cleaned)) return;
    if (/^accepted\s*\/\s*rejected\s*\/\s*deferred\s*\/\s*open\b/i.test(cleaned)) return;
    items.push({
      id: `D${items.length + 1}`,
      source,
      stance: stance || inferDecisionStance(cleaned),
      target: target || null,
      text: firstSentence(cleaned),
      hash: sha256Text(cleaned).slice(0, 16),
    });
  };

  for (const rawLine of String(section || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("```") || /^#+\s+/.test(line)) {
      if (!line) tableHeaders = null;
      continue;
    }
    if (looksLikeMarkdownTable(line, tableHeaders)) {
      const cells = parseMarkdownTableRow(line);
      if (!cells.length || isTableSeparator(cells)) continue;
      if (!tableHeaders) {
        tableHeaders = cells.map(normalizeTableHeader);
        continue;
      }
      const decision = cells[0] || "";
      const stance = cells[1] || "";
      const target = cells[2] || "";
      push(`${decision} | ${stance} | ${target}`, stance, target);
      continue;
    }
    tableHeaders = null;
    const bullet = line.match(/^(?:[-*]\s*(?:\[[ xX]\]\s*)?|(?:\d+[.)])\s+)(.+)$/);
    if (bullet) push(bullet[1]);
  }
  return items;
}

function inferDecisionStance(text) {
  if (/\b(reject|rejected|declined|not doing|non-goal|거절|제외|하지 않)/i.test(text)) return "rejected";
  if (/\b(defer|deferred|later|follow-up|보류|나중)/i.test(text)) return "deferred";
  if (/\b(open|blocking|question|미정|질문|확인 필요)/i.test(text)) return "open";
  if (/\b(accept|accepted|approved|decided|선택|승인|확정)/i.test(text)) return "accepted";
  return "unspecified";
}

function parseVerification(section) {
  const fallbackItems = [];
  const matrixItems = [];
  let currentLevel = "General";
  let currentSubsection = "";
  let fallbackCounter = 1;
  let matrixCounter = 1;
  let tableHeaders = null;
  for (const rawLine of section.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("```")) {
      if (!line) tableHeaders = null;
      continue;
    }
    const heading = line.match(/^#{3,4}\s*([^#]+)$/);
    if (heading) {
      currentSubsection = heading[1].trim();
      const level = currentSubsection.match(/^(Level\s*\d+.*)$/i);
      if (level) currentLevel = level[1].trim();
      tableHeaders = null;
      continue;
    }
    if (/^Evidence\s+To\s+Report$/i.test(currentSubsection)) {
      tableHeaders = null;
      continue;
    }
    if (looksLikeMarkdownTable(line, tableHeaders)) {
      const cells = parseMarkdownTableRow(line);
      if (!cells.length) continue;
      if (!tableHeaders) {
        if (isTableSeparator(cells)) continue;
        tableHeaders = cells.map(normalizeTableHeader);
        continue;
      }
      if (isTableSeparator(cells)) continue;
      const item = matrixVerificationItem(tableHeaders, cells, currentLevel, matrixCounter);
      if (item) {
        matrixItems.push(item);
        matrixCounter += 1;
      }
      continue;
    }
    tableHeaders = null;
    const bullet = line.match(/^(?:[-*]\s*(?:\[[ xX]\]\s*)?|(?:\d+[.)])\s+)(.+)$/);
    const command = line.match(/^`([^`]+)`$/);
    const text = bullet ? bullet[1].trim() : command ? command[1].trim() : "";
    if (!text) continue;
    fallbackItems.push({
      id: `V${fallbackCounter}`,
      level: currentLevel,
      title: firstSentence(text),
      text,
      status: "pending",
      evidence: [],
      artifacts: [],
      source: "verification_bullet",
    });
    fallbackCounter += 1;
  }
  const items = matrixItems.length ? matrixItems : fallbackItems;
  if (items.length === 0 && section.trim()) {
    items.push({
      id: "V1",
      level: "Verification Contract",
      title: "Run PRD Verification Contract section",
      text: section.trim(),
      status: "pending",
      evidence: [],
      artifacts: [],
      source: "verification_section",
    });
  }
  return items;
}

function looksLikeMarkdownTable(line, tableHeaders) {
  if (!line.includes("|")) return false;
  if (line.startsWith("|") || line.endsWith("|")) return true;
  if (tableHeaders) return true;
  return /\b(id|covers|coverage)\b\s*\|/i.test(line) && /\|\s*(method|check|command|artifact|artifacts|pass)/i.test(line);
}

function parseMarkdownTableRow(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map(cleanTableCell);
}

function cleanTableCell(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "; ")
    .replace(/\\\|/g, "|")
    .replace(/&nbsp;/gi, " ")
    .replace(/\*\*/g, "")
    .trim();
}

function isTableSeparator(cells) {
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell.trim()));
}

function normalizeTableHeader(value) {
  return cleanTableCell(value)
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function headerIndex(headers, aliases) {
  const normalizedAliases = aliases.map(normalizeTableHeader);
  return headers.findIndex(header => normalizedAliases.includes(header));
}

function tableValue(headers, cells, aliases) {
  const index = headerIndex(headers, aliases);
  return index >= 0 ? cleanTableCell(cells[index]) : "";
}

function parseBooleanCell(value, defaultValue) {
  const text = cleanTableCell(value).toLowerCase();
  if (!text) return defaultValue;
  if (/^(yes|y|true|required|must|done|blocker|필수|예|네|완료필수)$/.test(text)) return true;
  if (/^(no|n|false|optional|not required|skip|skippable|아니오|아님|선택|선택사항)$/.test(text)) return false;
  if (/^no\s*\/\s*blockable$/.test(text)) return false;
  return defaultValue;
}

function normalizeVerificationId(value, counter) {
  const compact = cleanTableCell(value)
    .replace(/\s+/g, "")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .toUpperCase();
  return compact || `V${counter}`;
}

function matrixVerificationItem(headers, cells, currentLevel, counter) {
  const idCell = tableValue(headers, cells, ["id", "check id", "verification id"]);
  const mode = tableValue(headers, cells, ["mode", "test mode", "verification mode"]);
  const covers = tableValue(headers, cells, ["covers", "coverage", "mapped ids"]);
  const method = tableValue(headers, cells, ["method", "check", "command", "command / method", "tool / method", "scenario", "flow"]);
  const artifact = tableValue(headers, cells, ["artifact", "artifacts", "evidence", "expected artifact", "expected artifacts"]);
  const passCriteria = tableValue(headers, cells, ["pass intent", "pass criteria", "pass", "expected", "expected result", "success criteria", "proof intent"]);
  const environment = tableValue(headers, cells, ["environment", "env", "runtime"]);
  const requiredForDoneRaw = tableValue(headers, cells, ["required for done", "required", "done gate", "required_for_done"]);
  const canBeBlockedRaw = tableValue(headers, cells, ["can be blocked", "blockable", "can block", "blocker semantics", "can_be_blocked"]);
  const safeProbe = tableValue(headers, cells, ["safe probe", "probe", "safe_probe"]);
  const liveProof = tableValue(headers, cells, ["live proof", "live check", "real proof", "live_proof"]);
  const sideEffect = tableValue(headers, cells, ["side effect", "side effects", "external side effect", "side_effect"]);
  const sensitiveDataPolicy = tableValue(headers, cells, ["sensitive data policy", "pii policy", "secret policy", "sensitive data", "sensitive_data_policy"]);
  if (!idCell && mode && !method && !artifact && !passCriteria) return null;
  if (!covers && !method && !artifact && !passCriteria) return null;

  const textParts = [];
  if (mode) textParts.push(`Mode: ${mode}`);
  if (covers) textParts.push(`Covers: ${covers}`);
  if (method) textParts.push(`Check: ${method}`);
  if (artifact) textParts.push(`Artifact: ${artifact}`);
  if (passCriteria) textParts.push(`Pass: ${passCriteria}`);
  if (environment) textParts.push(`Environment: ${environment}`);
  if (requiredForDoneRaw) textParts.push(`Required For Done: ${requiredForDoneRaw}`);
  if (canBeBlockedRaw) textParts.push(`Can Be Blocked: ${canBeBlockedRaw}`);
  if (safeProbe) textParts.push(`Safe Probe: ${safeProbe}`);
  if (liveProof) textParts.push(`Live Proof: ${liveProof}`);
  if (sideEffect) textParts.push(`Side Effect: ${sideEffect}`);
  if (sensitiveDataPolicy) textParts.push(`Sensitive Data Policy: ${sensitiveDataPolicy}`);
  let text = textParts.join(". ");
  if (text && !/[.!?]$/.test(text)) text = `${text}.`;
  const id = normalizeVerificationId(idCell, counter);

  return {
    id,
    level: currentLevel,
    title: firstSentence(method || covers || passCriteria || id),
    text,
    status: "pending",
    evidence: [],
    artifacts: [],
    source: "verification_matrix",
    matrix: {
      mode,
      covers,
      method,
      artifact,
      passCriteria,
      environment,
      requiredForDone: parseBooleanCell(requiredForDoneRaw, true),
      requiredForDoneRaw,
      canBeBlocked: parseBooleanCell(canBeBlockedRaw, false),
      canBeBlockedRaw,
      safeProbe,
      liveProof,
      sideEffect,
      sensitiveDataPolicy,
    },
  };
}

function parseTestModeContract(section) {
  const rows = [];
  let tableHeaders = null;
  let counter = 1;
  for (const rawLine of section.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("```")) {
      if (!line) tableHeaders = null;
      continue;
    }
    if (!looksLikeMarkdownTable(line, tableHeaders)) {
      tableHeaders = null;
      continue;
    }
    const cells = parseMarkdownTableRow(line);
    if (!cells.length) continue;
    if (!tableHeaders) {
      if (isTableSeparator(cells)) continue;
      tableHeaders = cells.map(normalizeTableHeader);
      const modeIndex = headerIndex(tableHeaders, ["mode", "test mode", "verification mode"]);
      const requiredIndex = headerIndex(tableHeaders, ["required for done", "required", "done gate"]);
      if (modeIndex < 0 || requiredIndex < 0) tableHeaders = null;
      continue;
    }
    if (isTableSeparator(cells)) continue;
    const mode = tableValue(tableHeaders, cells, ["mode", "test mode", "verification mode"]);
    if (!mode) continue;
    const requiredRaw = tableValue(tableHeaders, cells, ["required for done", "required", "done gate"]);
    rows.push({
      id: `TM${counter}`,
      mode,
      normalizedMode: normalizeMode(mode),
      requiredForDone: parseTestModeRequired(requiredRaw),
      requiredForDoneRaw: requiredRaw,
      canBeBlocked: /blockable|blocked|blocker|차단|막힘/i.test(requiredRaw),
      covers: tableValue(tableHeaders, cells, ["covers", "coverage", "mapped ids"]),
      humanDecision: tableValue(tableHeaders, cells, ["human decision", "human review", "approval", "decision"]),
    });
    counter += 1;
  }
  return rows;
}

function applyTestModeDefaults(verificationItems, testModes) {
  for (const item of verificationItems || []) {
    if (!item.matrix) continue;
    const mode = inferVerificationMode(item, testModes || []);
    if (!mode) continue;
    item.testMode = mode.mode;
    item.matrix.mode = item.matrix.mode || mode.mode;
    if (!item.matrix.requiredForDoneRaw) {
      item.matrix.requiredForDone = Boolean(mode.requiredForDone);
      item.matrix.requiredForDoneRaw = mode.requiredForDoneRaw || (mode.requiredForDone ? "yes" : "no");
    }
    if (!item.matrix.canBeBlockedRaw) {
      item.matrix.canBeBlocked = Boolean(mode.canBeBlocked);
      item.matrix.canBeBlockedRaw = mode.canBeBlocked ? "yes" : "no";
    }
  }
  return verificationItems;
}

function parseTestModeRequired(value) {
  const text = cleanTableCell(value).toLowerCase();
  if (/^no\s*\/\s*blockable$/.test(text)) return false;
  return parseBooleanCell(text, true);
}

function normalizeMode(value) {
  return cleanTableCell(value)
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function firstSentence(text) {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
}

function uniqueMatches(text, re) {
  const matches = [];
  for (const match of text.matchAll(re)) matches.push(match[0].toUpperCase());
  return Array.from(new Set(matches));
}

function repoSignals(projectRoot) {
  const rootPackagePath = path.join(projectRoot, "package.json");
  const appPackagePath = path.join(projectRoot, "app", "package.json");
  const packagePath = fs.existsSync(rootPackagePath)
    ? rootPackagePath
    : fs.existsSync(appPackagePath)
      ? appPackagePath
      : rootPackagePath;
  const packageRoot = path.dirname(packagePath);
  const packageJson = fs.existsSync(packagePath) ? readJson(packagePath) : null;
  const scripts = packageJson && packageJson.scripts ? packageJson.scripts : {};
  const composeFiles = [
    "docker-compose.yml",
    "docker-compose.yaml",
    "compose.yml",
    "compose.yaml",
    "app/docker-compose.yml",
    "app/docker-compose.yaml",
    "app/compose.yml",
    "app/compose.yaml",
  ].filter(file => fs.existsSync(path.join(projectRoot, file)));
  const packageManager = fs.existsSync(path.join(packageRoot, "pnpm-lock.yaml"))
    ? "pnpm"
    : fs.existsSync(path.join(packageRoot, "yarn.lock"))
      ? "yarn"
      : fs.existsSync(path.join(packageRoot, "bun.lockb")) || fs.existsSync(path.join(packageRoot, "bun.lock"))
        ? "bun"
        : fs.existsSync(path.join(packageRoot, "package-lock.json"))
          ? "npm"
          : packageJson ? "npm" : null;
  return {
    packageRoot: toProjectRelative(packageRoot, projectRoot),
    packageManager,
    packageScripts: Object.keys(scripts).sort(),
    dockerComposeFiles: composeFiles,
    hasAppRouter: fs.existsSync(path.join(projectRoot, "app")),
    hasPagesRouter: fs.existsSync(path.join(projectRoot, "pages")),
    hasSupabase: fs.existsSync(path.join(projectRoot, "supabase")),
    hasPlaywrightConfig: [
      "playwright.config.ts",
      "playwright.config.js",
      "playwright.config.mjs",
      "app/playwright.config.ts",
      "app/playwright.config.js",
      "app/playwright.config.mjs",
    ].some(file => fs.existsSync(path.join(projectRoot, file))),
  };
}

function verificationContractHash(state) {
  return sha256Text(JSON.stringify({
    verification: (state.verification || []).map(item => ({
      id: item.id,
      level: item.level,
      text: item.text,
      source: item.source,
      matrix: item.matrix || null,
    })),
    testModeContract: state.testModeContract || [],
  }));
}

function buildVerificationPlan(state, statePath) {
  const projectRoot = state.projectRoot || cwd();
  const signals = repoSignals(projectRoot);
  const checks = state.verification.map((verification, index) => {
	    const mode = inferVerificationMode(verification, state.testModeContract || []);
	    const category = classifyVerification(verification, mode);
	    const explicitCommand = verification.matrix && !verification.matrix.method
	      ? null
	      : commandFromText(verification.text);
	    const command = category === "command" || category === "automated"
	      ? explicitCommand || commandForMode(mode, category, signals)
	      : null;
	    const covers = coverageFromText(verification.text);
	    const artifacts = artifactsForVerification(verification, category, mode);
	    const passCriteria = verification.matrix && verification.matrix.passCriteria
	      ? verification.matrix.passCriteria
	      : passCriteriaFromText(verification.text, category);
    return {
      id: `VP${index + 1}`,
      verificationId: verification.id,
      level: verification.level,
      source: verification.source || "verification_item",
      category,
      tool: toolForVerification(category, signals),
      command,
      target: targetForVerification(category, signals),
      covers,
      artifactKinds: artifacts,
      passCriteria,
      requiredForDone: isVerificationRequiredForDone(verification),
      canBeBlocked: verification.matrix ? Boolean(verification.matrix.canBeBlocked) : false,
      testMode: mode ? mode.mode : null,
      testModeContract: mode || null,
      contract: verification.matrix || null,
      contractHash: sha256Text(JSON.stringify({
        id: verification.id,
        text: verification.text,
        matrix: verification.matrix || null,
      })),
      status: plannedCheckStatus({ verification, category, command, covers, artifacts, mode }),
      notes: plannerNotes({ verification, category, command, covers, signals, mode }),
    };
  });
  const coverage = buildCoverageMatrix(state, checks);
  const gaps = buildVerificationGaps(state, checks, coverage, signals);
  return {
    schema: "hoyeon.prd-implement.verification-plan.v1",
    status: gaps.some(gap => gap.severity === "blocking") ? "needs_review" : "ready",
    generatedAt: nowIso(),
    prdPath: state.prdPath,
    prdSha256: state.prdSnapshot ? state.prdSnapshot.sha256 : null,
    verificationContractHash: verificationContractHash(state),
    statePath: toProjectRelative(statePath, projectRoot),
    environment: {
      packageManager: signals.packageManager,
      packageScripts: signals.packageScripts,
      browserTool: "chromux",
      serverStrategy: signals.dockerComposeFiles.length
        ? `docker-compose available: ${signals.dockerComposeFiles.join(", ")}`
        : signals.packageScripts.includes("dev")
          ? `${signals.packageManager || "npm"} dev`
          : "no dev server script detected",
      serviceStrategy: signals.dockerComposeFiles.length ? "prefer docker-compose for service dependencies" : "use repo-local dev/test commands; ask if services are required",
      dbStrategy: signals.hasSupabase ? "local/sandbox Supabase or non-production DB with query-log artifact" : "no DB surface detected",
    },
    checks,
    coverage,
    gaps,
  };
}

function buildExecutionPlan(state, statePath) {
  const previous = state.executionPlan && Array.isArray(state.executionPlan.nodes)
    ? new Map(state.executionPlan.nodes.map(node => [node.id, node]))
    : new Map();
  const gaps = [];
  const nodes = [];
  const taskToNodeId = new Map();
  for (const [index, task] of (state.tasks || []).entries()) {
    taskToNodeId.set(task.id, `N${index + 1}`);
  }

  for (const [index, task] of (state.tasks || []).entries()) {
    const id = `N${index + 1}`;
    const prior = previous.get(id) || {};
    const writeScope = inferWriteScope(task, state);
    const risk = inferRisk(task, state);
    const dependsOn = inferDependsOn(task, state, taskToNodeId, index);
    const covers = executionCoverageForTask(state, task);
    if (writeScope.length === 0) {
      gaps.push({
        severity: "warning",
        code: "missing_write_scope",
        item: task.id,
        message: "Write scope could not be inferred; node is not parallel-safe until the coordinator narrows scope",
      });
    }
    if ((task.requirements || []).length === 0) {
      gaps.push({
        severity: "warning",
        code: "task_without_requirement",
        item: task.id,
        message: "Task has no explicit requirement mapping",
      });
    }
    if (covers.acceptanceCriteria.length === 0) {
      gaps.push({
        severity: "warning",
        code: "task_without_acceptance_mapping",
        item: task.id,
        message: "Task has no acceptance-criterion mapping",
      });
    }
    nodes.push({
      id,
      kind: "implementation",
      sourceTask: task.id,
      title: task.title,
      dependsOn,
      writeScope,
      covers,
      parallelSafe: risk !== "high" && writeScope.length > 0,
      risk,
      owner: prior.owner || null,
      status: prior.status || "pending",
      evidence: Array.isArray(prior.evidence) ? prior.evidence : [],
      artifacts: Array.isArray(prior.artifacts) ? prior.artifacts : [],
    });
  }

  if ((state.tasks || []).length === 0) {
    gaps.push({
      severity: "blocking",
      code: "no_prd_tasks",
      item: "Tasks",
      message: "PRD section 13 produced no implementation tasks",
    });
  }

	  const rollups = { tasks: {} };
	  for (const task of state.tasks || []) {
	    const node = nodes.find(candidate => candidate.sourceTask === task.id);
	    rollups.tasks[task.id] = {
	      nodes: node ? [node.id] : [],
	      acceptanceCriteria: node ? node.covers.acceptanceCriteria : task.acceptanceCriteria || [],
	      verification: node ? node.covers.verification : [],
	    };
	  }
	  addExecutionGraphQualityGaps(nodes, gaps);
	  const traceMatrix = buildTraceMatrix(state, nodes, rollups);

	  return {
    schema: "hoyeon.prd-implement.execution-plan.v1",
    status: gaps.some(gap => gap.severity === "blocking") ? "needs_review" : "ready",
    generatedAt: nowIso(),
    prdPath: state.prdPath,
    statePath: toProjectRelative(statePath, state.projectRoot || cwd()),
	    nodes,
	    rollups,
	    traceMatrix,
	    gaps,
	  };
	}

function buildTraceMatrix(state, nodes, rollups) {
  const verificationById = new Map((state.verification || []).map(item => [item.id, item]));
  return (state.tasks || []).map(task => {
    const rollup = rollups.tasks[task.id] || { nodes: [], acceptanceCriteria: [], verification: [] };
    const requiredVerification = rollup.verification.filter(id => {
      const item = verificationById.get(id);
      return item ? isVerificationRequiredForDone(item) : true;
    });
    const optionalVerification = rollup.verification.filter(id => !requiredVerification.includes(id));
    return {
      taskId: task.id,
      nodeIds: rollup.nodes || [],
      requirements: task.requirements || [],
      acceptanceCriteria: rollup.acceptanceCriteria || [],
      verification: rollup.verification || [],
      requiredVerification,
      optionalVerification,
      nodeStatuses: (rollup.nodes || []).map(id => {
        const node = nodes.find(candidate => candidate.id === id);
        return { id, status: node ? node.status : "missing" };
      }),
    };
  });
}

function refreshExecutionTraceMatrix(state) {
  if (!state.executionPlan || !state.executionPlan.rollups || !Array.isArray(state.executionPlan.nodes)) return;
  state.executionPlan.traceMatrix = buildTraceMatrix(state, state.executionPlan.nodes, state.executionPlan.rollups);
}

function addExecutionGraphQualityGaps(nodes, gaps) {
  if (nodes.length >= 5 && nodes.every(node => !node.dependsOn || node.dependsOn.length === 0)) {
    gaps.push({
      severity: "warning",
      code: "weak_graph_no_dependencies",
      item: "execution-plan",
      message: "Execution plan has five or more nodes and no dependencies; confirm this is genuinely parallelizable or record a deviation",
    });
  }
  const scopeCounts = new Map();
  for (const node of nodes) {
    const key = (node.writeScope || []).join("\n") || "unknown";
    scopeCounts.set(key, (scopeCounts.get(key) || 0) + 1);
  }
  for (const [scope, count] of scopeCounts.entries()) {
    if (nodes.length >= 4 && count >= Math.ceil(nodes.length * 0.75)) {
      gaps.push({
        severity: "warning",
        code: "weak_graph_repeated_write_scope",
        item: "execution-plan",
        message: `Most execution nodes share the same write scope (${scope === "unknown" ? "unknown" : scope}); narrow scopes before relying on parallel guidance`,
      });
      break;
    }
  }
  if (nodes.length >= 4 && nodes.every(node => node.risk === "high" && node.parallelSafe === false)) {
    gaps.push({
      severity: "warning",
      code: "weak_graph_all_high_risk",
      item: "execution-plan",
      message: "All execution nodes are high risk and not parallel-safe; treat ready guidance as sequential only",
    });
  }
}

function executionCoverageForTask(state, task) {
  const requirements = Array.from(new Set(task.requirements || []));
  const acceptanceCriteria = Array.from(new Set([
    ...(task.acceptanceCriteria || []),
    ...(state.acceptanceCriteria || [])
      .filter(ac => (ac.requirements || []).some(id => requirements.includes(id)))
      .map(ac => ac.id),
  ]));
  const verification = [];
  for (const item of state.verification || []) {
    const check = ((state.verificationPlan && state.verificationPlan.checks) || [])
      .find(candidate => candidate.verificationId === item.id);
    const covers = check ? check.covers : coverageFromText(item.text || "");
    const matchesTask = (covers.tasks || []).includes(task.id);
    const matchesAc = (covers.acceptanceCriteria || []).some(id => acceptanceCriteria.includes(id));
    const matchesRequirement = (covers.requirements || []).some(id => requirements.includes(id));
    if (matchesTask || matchesAc || matchesRequirement) verification.push(item.id);
  }
  return {
    requirements,
    acceptanceCriteria,
    verification: Array.from(new Set(verification)),
  };
}

function inferWriteScope(task, state) {
  const taskHints = extractPathHints(task.text || task.title || "");
  if (taskHints.length) return taskHints;
  const structureHints = extractPathHints([
    state.technicalStructure || "",
    state.implementationNotes || "",
  ].join("\n"));
  return structureHints;
}

function extractPathHints(text) {
  const hints = [];
  const add = value => {
    const normalized = normalizePathHint(value);
    if (!normalized || !isPotentialPathHint(normalized)) return;
    if (!hints.includes(normalized)) hints.push(normalized);
  };
  for (const match of String(text || "").matchAll(/`([^`]+)`/g)) add(match[1]);
  for (const match of String(text || "").matchAll(/(?:^|\s)((?:\.{1,2}\/|\/)?[A-Za-z0-9_.@가-힣-]+(?:\/[A-Za-z0-9_.@가-힣-]+)*\.[A-Za-z0-9]{1,8})/g)) {
    add(match[1]);
  }
  for (const match of String(text || "").matchAll(/(?:^|\s)(\/[A-Za-z0-9_.@가-힣-]+(?:\/[A-Za-z0-9_.@가-힣-]+)+)/g)) {
    add(match[1]);
  }
  return hints.slice(0, 12);
}

function normalizePathHint(value) {
  return String(value || "")
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/[),.;:]+$/g, "");
}

function isPotentialPathHint(value) {
  const text = String(value || "").trim();
  if (!text || /^https?:\/\//i.test(text)) return false;
  if (/^(?:pnpm|npm|yarn|bun|pytest|python|node|go|cargo|make|docker|docker-compose)\b/i.test(text)) return false;
  if (/^(?:R|AC|T|V)\d+$/i.test(text)) return false;
  return text.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(text);
}

function inferRisk(task, state) {
  const text = `${task.text || ""}\n${state.technicalStructure || ""}`
    .split(/\r?\n/)
    .filter(line => {
      const lower = line.toLowerCase();
      const sensitive = /(auth|rls|migration|migrate|database|postgres|supabase|sql|schema|security|credential|secret|config|env|production|prod data|billing|permission|권한|마이그레이션|보안)/.test(lower);
      const negated = /\b(no|none|without|not|does not|is not|없음|아님|불필요)\b/.test(lower);
      return !(sensitive && negated);
    })
    .join("\n")
    .toLowerCase();
  if (/(auth|rls|migration|migrate|database|postgres|supabase|sql|schema|security|credential|secret|config|env|production|prod data|billing|permission|권한|마이그레이션|보안)/.test(text)) {
    return "high";
  }
  if (/(api|server|service|integration|browser|runtime|route|endpoint|db|data|external|서버|브라우저|라우트)/.test(text)) {
    return "medium";
  }
  return "low";
}

function inferDependsOn(task, state, taskToNodeId, index) {
  const dependencies = [];
  for (const taskId of uniqueMatches(task.text || "", /\bT\d+\b/gi)) {
    if (taskId === task.id) continue;
    const nodeId = taskToNodeId.get(taskId);
    if (nodeId && !dependencies.includes(nodeId)) dependencies.push(nodeId);
  }
  if (dependencies.length === 0 && index > 0 && /\b(after|following|depends on|blocked by|이후|다음|뒤에|완료 후)\b/i.test(task.text || "")) {
    dependencies.push(`N${index}`);
  }
  return dependencies;
}

function readyExecutionPlan(state) {
  const plan = state.executionPlan;
  const planSummary = executionPlanSummary(state);
  const verificationSummary = verificationPlanSummary(state);
  if (!plan || !Array.isArray(plan.nodes)) {
    return {
      readySequential: [],
      readyParallelGroups: [],
      parallelEnabled: Boolean(state.execution && state.execution.parallel),
      blocked: [{ id: "EP0", waitingFor: verificationPlanBlocksImplementation(state) ? ["VP0"] : ["plan-execution"] }],
      plan: planSummary,
    };
  }
  const nodesById = new Map(plan.nodes.map(node => [node.id, node]));
  const blocked = [];
  const ready = [];
  for (const node of plan.nodes) {
    if (!["pending", "in_progress"].includes(node.status)) continue;
    const waitingFor = [];
    if (verificationSummary.status !== "ready" || verificationSummary.blockingGapCount > 0) waitingFor.push("VP0");
    if (plan.status !== "ready" || planSummary.blockingGapCount > 0) waitingFor.push("EP0");
    for (const depId of node.dependsOn || []) {
      const dep = nodesById.get(depId);
      if (!dep || dep.status !== "complete") waitingFor.push(depId);
    }
    if (waitingFor.length) blocked.push({ id: node.id, waitingFor: Array.from(new Set(waitingFor)) });
    else ready.push(node);
  }
  const parallelEnabled = Boolean(state.execution && state.execution.parallel);
  return {
    readySequential: ready.map(node => node.id),
    readyParallelGroups: parallelEnabled ? buildParallelGroups(ready) : [],
    parallelEnabled,
    blocked,
    plan: planSummary,
  };
}

function buildParallelGroups(readyNodes) {
  const candidates = readyNodes.filter(node => {
    if (!node.parallelSafe) return false;
    if (!["low", "medium"].includes(node.risk)) return false;
    return Array.isArray(node.writeScope) && node.writeScope.length > 0;
  });
  const groups = [];
  let remaining = [...candidates];
  while (remaining.length) {
    const group = [remaining.shift()];
    remaining = remaining.filter(candidate => {
      const compatible = group.every(member => !writeScopesOverlap(member.writeScope, candidate.writeScope));
      if (compatible) group.push(candidate);
      return !compatible;
    });
    if (group.length > 1) groups.push(group.map(node => node.id));
  }
  return groups;
}

function writeScopesOverlap(left = [], right = []) {
  for (const a of left) {
    for (const b of right) {
      if (a === b) return true;
      if (a.startsWith("TBD:") || b.startsWith("TBD:")) return true;
      if (a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) return true;
    }
  }
  return false;
}

function rollupTasksFromExecutionPlan(state, options = {}) {
  const recordEvidence = options.recordEvidence !== false;
  const plan = state.executionPlan;
  if (!plan || !plan.rollups || !plan.rollups.tasks) return;
  const nodesById = new Map((plan.nodes || []).map(node => [node.id, node]));
  const acById = new Map((state.acceptanceCriteria || []).map(ac => [ac.id, ac]));
  const verificationById = new Map((state.verification || []).map(item => [item.id, item]));
  for (const task of state.tasks || []) {
    if (["blocked", "deferred"].includes(task.status)) continue;
    const rollup = plan.rollups.tasks[task.id];
    if (!rollup || !rollup.nodes || rollup.nodes.length === 0) continue;
    const nodes = rollup.nodes.map(id => nodesById.get(id)).filter(Boolean);
    if (nodes.some(node => node.status === "blocked")) {
      task.status = "blocked";
      if (recordEvidence && !task.evidence.some(entry => /Execution roll-up/.test(entry.text))) {
        task.evidence.push({ ts: nowIso(), text: `Execution roll-up: blocked by ${nodes.filter(node => node.status === "blocked").map(node => node.id).join(", ")}` });
      }
      continue;
    }
	    const allNodesComplete = nodes.length > 0 && nodes.every(node => node.status === "complete");
	    const mappedAcs = (rollup.acceptanceCriteria || []).map(id => acById.get(id)).filter(Boolean);
	    const mappedVerification = (rollup.verification || []).map(id => verificationById.get(id)).filter(Boolean);
	    const acsMet = mappedAcs.every(ac => ac.status === "met");
	    const verificationClosed = mappedVerification.every(item => verificationIsClosedForAccounting(item));
	    if (allNodesComplete && acsMet && verificationClosed) {
	      task.status = "complete";
	      if (recordEvidence && !task.evidence.some(entry => /Execution roll-up/.test(entry.text))) {
	        task.evidence.push({
	          ts: nowIso(),
	          text: `Execution roll-up: ${nodes.map(node => node.id).join(", ")} complete; ACs ${mappedAcs.map(ac => ac.id).join(", ") || "none"} met; required Verification ${mappedVerification.filter(item => isVerificationRequiredForDone(item)).map(item => item.id).join(", ") || "none"} passed.`,
	        });
	      }
	    } else if (task.status === "complete") {
	      task.status = "in_progress";
	      if (recordEvidence) task.evidence.push({
	        ts: nowIso(),
	        text: "Execution roll-up reopened: mapped ACs must be met and all required Verification items must pass before task completion.",
	      });
	    } else if (nodes.some(node => ["in_progress", "complete"].includes(node.status)) && task.status === "pending") {
	      task.status = "in_progress";
	    }
  }
}

function buildTaskGraph(state) {
  const verificationPlan = verificationPlanSummary(state);
  const executionPlan = executionPlanSummary(state);
  const nodes = [];
  const edges = [];
  const addNode = node => {
    nodes.push({
      ...node,
      evidenceCount: Array.isArray(node.evidence) ? node.evidence.length : node.evidenceCount || 0,
      artifactCount: Array.isArray(node.artifacts) ? node.artifacts.length : node.artifactCount || 0,
    });
  };
  const addEdge = (from, to, type, reason) => {
    if (!from || !to || from === to) return;
    const key = `${from}->${to}:${type}`;
    if (edges.some(edge => edge.key === key)) return;
    edges.push({ key, from, to, type, reason });
  };

  addNode({
    id: "VP0",
    kind: "verification_plan",
    title: "Generate and resolve verification plan",
    status: verificationPlan.status,
    closed: verificationPlan.status === "ready" && verificationPlan.blockingGapCount === 0,
    blockingGapCount: verificationPlan.blockingGapCount,
    checkCount: verificationPlan.checkCount,
  });
  addNode({
    id: "EP0",
    kind: "execution_plan",
    title: "Generate execution plan from PRD tasks",
    status: executionPlan.status,
    closed: executionPlan.status === "ready" && executionPlan.blockingGapCount === 0,
    blockingGapCount: executionPlan.blockingGapCount,
    nodeCount: executionPlan.nodeCount,
  });
  addEdge("VP0", "EP0", "unblocks", "execution planning starts after verification planning");

  const tasks = state.tasks || [];
  const acceptanceCriteria = state.acceptanceCriteria || [];
  const verificationItems = state.verification || [];
  const executionNodes = state.executionPlan && Array.isArray(state.executionPlan.nodes) ? state.executionPlan.nodes : [];

  for (const task of tasks) {
    addNode({
      id: task.id,
      kind: "task_rollup",
      title: task.title,
      status: task.status,
      closed: task.status === "complete",
      requirements: task.requirements || [],
      acceptanceCriteria: task.acceptanceCriteria || [],
      evidence: task.evidence || [],
      artifacts: task.artifacts || [],
    });
  }

  for (const node of executionNodes) {
    addNode({
      id: node.id,
      kind: "execution_node",
      title: node.title,
      status: node.status,
      closed: node.status === "complete",
      sourceTask: node.sourceTask,
      dependsOn: node.dependsOn || [],
      writeScope: node.writeScope || [],
      parallelSafe: node.parallelSafe,
      risk: node.risk,
      owner: node.owner || null,
      covers: node.covers || { requirements: [], acceptanceCriteria: [], verification: [] },
      evidence: node.evidence || [],
      artifacts: node.artifacts || [],
    });
    addEdge("EP0", node.id, "unblocks", "execution node comes from the execution plan");
    addEdge(node.sourceTask, node.id, "decomposes_to", "PRD task is executed through this implementation node");
    for (const depId of node.dependsOn || []) addEdge(depId, node.id, "depends_on", "execution dependency");
    for (const acId of (node.covers && node.covers.acceptanceCriteria) || []) addEdge(node.id, acId, "satisfies", "execution node covers this acceptance criterion");
    for (const verificationId of (node.covers && node.covers.verification) || []) addEdge(node.id, verificationId, "verified_by", "execution node is proven by this verification item");
  }

  for (const ac of acceptanceCriteria) {
    addNode({
      id: ac.id,
      kind: "acceptance_criterion",
      title: ac.title,
      status: ac.status,
      closed: ac.status === "met",
      requirements: ac.requirements || [],
      evidence: ac.evidence || [],
      artifacts: ac.artifacts || [],
    });
  }

  const checksByVerificationId = new Map();
  for (const check of (state.verificationPlan && state.verificationPlan.checks) || []) {
    checksByVerificationId.set(check.verificationId, check);
  }

  for (const verification of verificationItems) {
    const check = checksByVerificationId.get(verification.id);
    const covers = check ? check.covers : coverageFromText(verification.text || "");
    addNode({
      id: verification.id,
	      kind: "verification",
	      title: verification.title,
	      status: verification.status,
	      closed: verificationIsClosedForAccounting(verification),
      level: verification.level,
	      category: check ? check.category : null,
	      tool: check ? check.tool : null,
	      requiredForDone: isVerificationRequiredForDone(verification),
	      covers,
      evidence: verification.evidence || [],
      artifacts: verification.artifacts || [],
    });
    addEdge("VP0", verification.id, "plans", "verification check comes from the verification plan");
    for (const taskId of covers.tasks || []) addEdge(taskId, verification.id, "verified_by", "verification covers this task");
    for (const acId of covers.acceptanceCriteria || []) addEdge(acId, verification.id, "verified_by", "verification covers this acceptance criterion");
    for (const reqId of covers.requirements || []) {
      for (const task of tasks.filter(item => (item.requirements || []).includes(reqId))) {
        addEdge(task.id, verification.id, "verified_by", `verification covers ${reqId}`);
      }
      for (const ac of acceptanceCriteria.filter(item => (item.requirements || []).includes(reqId))) {
        addEdge(ac.id, verification.id, "verified_by", `verification covers ${reqId}`);
      }
    }
  }

  addNode({
    id: "REQ_FIDELITY_REVIEW",
    kind: "requirements_fidelity_review",
    title: "Requirements fidelity review",
    status: state.requirementsFidelityReview ? state.requirementsFidelityReview.status : "pending",
    closed: Boolean(state.requirementsFidelityReview && state.requirementsFidelityReview.status === "pass"),
    evidenceCount: state.requirementsFidelityReview ? 1 : 0,
    artifactCount: state.requirementsFidelityReview && state.requirementsFidelityReview.reportPath ? 1 : 0,
  });
  const finalReviewRequired = finalReviewRequiredForState(state);
  addNode({
    id: "REVIEW",
    kind: "final_review",
    title: "Adversarial final review",
    status: state.finalReview ? state.finalReview.status : finalReviewRequired ? "pending" : "skipped",
    closed: finalReviewRequired ? Boolean(state.finalReview && state.finalReview.status === "pass") : true,
    requiredForDone: finalReviewRequired,
    evidenceCount: state.finalReview ? 1 : 0,
    artifactCount: state.finalReview && state.finalReview.reportPath ? 1 : 0,
  });
  addNode({
    id: "FINALIZE",
    kind: "receipt",
    title: "Final receipt",
    status: state.finalReceipt ? state.finalReceipt.status : "pending",
    closed: Boolean(state.finalReceipt),
    evidenceCount: state.finalReceipt ? 1 : 0,
    artifactCount: state.finalReceipt ? 1 : 0,
  });

  for (const item of [...tasks, ...executionNodes, ...acceptanceCriteria, ...verificationItems]) {
    addEdge(item.id, "REQ_FIDELITY_REVIEW", "requirements_review_input", "requirements reviewer must audit this item against original user intent and PRD decisions");
    addEdge(item.id, "REVIEW", "review_input", "final reviewer must audit this item and its evidence");
  }
  addEdge("REQ_FIDELITY_REVIEW", "REVIEW", "review_input", finalReviewRequired
    ? "final reviewer must audit the requirements fidelity verdict"
    : "trivial profile skips mandatory final review after requirements fidelity passes");
  addEdge("REVIEW", "FINALIZE", "gates", finalReviewRequired
    ? "receipt can be written only after passing final review"
    : "receipt can be written after requirements fidelity review and mechanical gates pass");

  const openNodeCount = nodes.filter(node => !node.closed).length;
  return {
    schema: "hoyeon.prd-implement.taskgraph.v2",
    generatedAt: nowIso(),
    prdPath: state.prdPath,
    status: state.finalReceipt
      ? "complete"
      : verificationPlanBlocksImplementation(state)
        ? "blocked_by_verification_plan"
        : executionPlanBlocksImplementation(state)
          ? "blocked_by_execution_plan"
          : "active",
    summary: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      openNodeCount,
      blockingGapCount: verificationPlan.blockingGapCount + executionPlan.blockingGapCount,
      executionNodeCount: executionPlan.nodeCount,
      openExecutionNodeCount: executionPlan.openNodeCount,
    },
    nodes,
    edges: edges.map(({ key, ...edge }) => edge),
  };
}

function inferVerificationMode(verification, testModes) {
  const explicit = verification.matrix && verification.matrix.mode ? normalizeMode(verification.matrix.mode) : "";
  if (explicit) {
    return testModes.find(row => row.normalizedMode === explicit) || {
      mode: verification.matrix.mode,
      normalizedMode: explicit,
      requiredForDone: isVerificationRequiredForDone(verification),
      canBeBlocked: verification.matrix ? Boolean(verification.matrix.canBeBlocked) : false,
    };
  }
  const text = `${verification.level || ""} ${verification.text || ""}`.toLowerCase();
  const candidates = testModes || [];
  const direct = candidates.find(row => {
    const mode = row.normalizedMode || normalizeMode(row.mode);
    if (!mode) return false;
    const words = mode.split("-").filter(Boolean);
    return words.length && words.every(word => text.includes(word));
  });
  if (direct) return direct;
  const fallbackName = inferredModeNameFromText(text);
  if (!fallbackName) return null;
  const normalized = normalizeMode(fallbackName);
  return candidates.find(row => row.normalizedMode === normalized)
    || candidates.find(row => (row.normalizedMode || "").includes(normalized) || normalized.includes(row.normalizedMode || ""))
    || { mode: fallbackName, normalizedMode: normalized, requiredForDone: isVerificationRequiredForDone(verification), canBeBlocked: false };
}

function inferredModeNameFromText(text) {
  if (/(build|static|typecheck|type check|lint|compile|repo health)/.test(text)) return "build/static";
  if (/(automated|unit|integration|e2e|regression|test|spec)/.test(text)) return "automated behavior";
  if (/(browser|runtime|chromux|screenshot|viewport|dom|console|network|main flow|user flow)/.test(text)) return "browser/runtime";
  if (/(db|database|postgres|supabase|sql|query|row|migration)/.test(text)) return "db";
  if (/(api|endpoint|request|response|webhook|external|live|credential|sandbox)/.test(text)) return "live external API";
  return null;
}

function modeMatches(mode, patterns) {
  const text = `${mode && mode.normalizedMode ? mode.normalizedMode : ""} ${mode && mode.mode ? mode.mode : ""}`.toLowerCase();
  return patterns.some(pattern => pattern.test(text));
}

function classifyVerification(verification, mode = null) {
  const text = `${mode && mode.mode ? mode.mode : ""} ${verification.level} ${verification.text}`.toLowerCase();
  const command = commandFromText(verification.text);
  if (command && hasCommandLogArtifact(verification)) {
    if (modeMatches(mode, [/automated/, /behavior/, /test/])) return "automated";
    return "command";
  }
  if (modeMatches(mode, [/build/, /static/])) return "command";
  if (modeMatches(mode, [/automated/, /behavior/, /test/])) return "automated";
  if (modeMatches(mode, [/browser/, /runtime/])) return "browser";
  if (modeMatches(mode, [/^db$/, /database/, /sql/])) return "db";
  if (modeMatches(mode, [/api/, /external/, /live/])) return "api";
  if (command && /level\s*2|test|spec|e2e|integration|unit|regression/.test(text)) return "automated";
  if (command && !/(chromux|browser|screenshot|viewport|click|dom|console|network)/.test(text)) return "command";
  if (/(chromux|browser|screenshot|viewport|click|dom|console|network|page|route|url)/.test(text)) return "browser";
  if (/\b(docker|compose|service|server|healthcheck|localhost|port)\b/.test(text)) return "server";
  if (/(db|database|postgres|supabase|sql|query|row|migration|rls)/.test(text)) return "db";
  if (/(api|endpoint|request|response|status code|webhook)/.test(text)) return "api";
  if (/level\s*2|test|spec|e2e|integration|unit|regression/.test(text)) return "automated";
  if (command) return "command";
  return "manual-agent";
}

function hasCommandLogArtifact(verification) {
  const artifact = verification && verification.matrix && verification.matrix.artifact
    ? verification.matrix.artifact
    : "";
  return /\bcommand-log\b/i.test(`${artifact} ${verification && verification.text ? verification.text : ""}`);
}

function commandFromText(text) {
  const runnerCommands = "(?:pnpm|npm|npx|yarn|bun|pytest|python|node|tsx|ts-node|deno|go|cargo|make|docker|docker-compose|bash|sh|zsh|test|sed|cat|curl|jq|uv|uvx|php|ruby|perl|mvn|gradle)";
  const envAssignment = "(?:[A-Za-z_][A-Za-z0-9_]*=(?:\"[^\"]*\"|'[^']*'|\\S+)\\s+)*";
  const commandPrefix = new RegExp(`^${envAssignment}${runnerCommands}\\b`, "i");
  for (const backtick of String(text).matchAll(/`([^`]+)`/g)) {
    const candidate = backtick[1].trim();
    if (commandPrefix.test(candidate)) return candidate;
  }
  const command = String(text).match(new RegExp(`\\b(${envAssignment}${runnerCommands}\\s+[^\\n.;]+)`, "i"));
  return command ? command[1].trim() : null;
}

function commandForMode(mode, category, signals) {
  if (!mode) return null;
  const modeText = `${mode.mode || ""} ${mode.normalizedMode || ""}`.toLowerCase();
  if (category === "command" || /build|static|repo health/.test(modeText)) {
    return bestPackageScriptCommand(signals, ["verify", "check", "build", "typecheck", "type-check", "lint", "test"]);
  }
  if (category === "automated" || /automated|behavior|test|regression/.test(modeText)) {
    return bestPackageScriptCommand(signals, ["test", "test:unit", "test:integration", "test:e2e", "e2e"]);
  }
  return null;
}

function bestPackageScriptCommand(signals, candidates) {
  const scripts = new Set(signals.packageScripts || []);
  const script = candidates.find(candidate => scripts.has(candidate));
  if (!script || !signals.packageManager) return null;
  return scriptCommand(signals.packageManager, script);
}

function scriptCommand(packageManager, script) {
  if (packageManager === "npm") {
    if (script === "test") return "npm test";
    return `npm run ${script}`;
  }
  if (packageManager === "yarn") return `yarn ${script}`;
  if (packageManager === "bun") return `bun run ${script}`;
  return `${packageManager} ${script}`;
}

function plannedCommandForVerification(state, verificationId) {
  const check = ((state.verificationPlan && state.verificationPlan.checks) || [])
    .find(candidate => String(candidate.verificationId).toUpperCase() === String(verificationId).toUpperCase());
  if (check && check.command) return check.command;
  const item = (state.verification || [])
    .find(candidate => String(candidate.id).toUpperCase() === String(verificationId).toUpperCase());
  return item ? commandFromText(item.text || "") : null;
}

function shellLikeTokens(command) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaped = false;
  for (const char of String(command || "")) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaped) current += "\\";
  if (current) tokens.push(current);
  return tokens;
}

function unwrapShellCommandTokens(tokens) {
  if (tokens.length >= 3 && /^(?:bash|sh|zsh)$/.test(path.basename(tokens[0])) && tokens[1] === "-c") {
    return shellLikeTokens(tokens.slice(2).join(" "));
  }
  if (tokens.length >= 4 && /^(?:bash|sh|zsh)$/.test(path.basename(tokens[0])) && tokens[1] === "-l" && tokens[2] === "-c") {
    return shellLikeTokens(tokens.slice(3).join(" "));
  }
  if (tokens.length >= 3 && /^(?:bash|sh|zsh)$/.test(path.basename(tokens[0])) && tokens[1] === "-lc") {
    return shellLikeTokens(tokens.slice(2).join(" "));
  }
  return tokens;
}

function normalizeCommandForCompare(command) {
  return unwrapShellCommandTokens(shellLikeTokens(command)).join(" ").trim();
}

function commandsMatchContract(actual, expected) {
  if (!expected) return true;
  return normalizeCommandForCompare(actual) === normalizeCommandForCompare(expected);
}

function coverageFromText(text) {
  return {
    requirements: expandCoverageIds(text, "R"),
    acceptanceCriteria: expandCoverageIds(text, "AC"),
    tasks: expandCoverageIds(text, "T"),
  };
}

function expandCoverageIds(text, prefix) {
  const source = String(text || "");
  const ids = uniqueMatches(source, new RegExp(`\\b${prefix}\\d+\\b`, "gi"));
  const seen = new Set(ids);
  const ranges = new RegExp(`\\b${prefix}(\\d+)\\s*-\\s*(?:${prefix})?(\\d+)\\b`, "gi");
  for (const match of source.matchAll(ranges)) {
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    if (start <= 0 || end <= 0 || Math.abs(end - start) > 100) continue;
    const step = start <= end ? 1 : -1;
    for (let value = start; step > 0 ? value <= end : value >= end; value += step) {
      seen.add(`${prefix}${value}`);
    }
  }
  return Array.from(seen).sort((left, right) => {
    const a = Number(left.replace(/^\D+/, ""));
    const b = Number(right.replace(/^\D+/, ""));
    return a - b || left.localeCompare(right);
  });
}

function artifactsForVerification(verification, category, mode = null) {
  const text = `${verification.level} ${verification.text}`.toLowerCase();
  const artifacts = new Set();
  if (category === "command" || category === "automated") artifacts.add("command-log");
  if (category === "browser") {
    artifacts.add("screenshot");
    artifacts.add("console-log");
  }
  if (category === "server") artifacts.add("server-log");
  if (category === "api") artifacts.add("api-log");
  if (category === "db") artifacts.add("db-log");
  if (/screenshot/.test(text)) artifacts.add("screenshot");
  if (/console/.test(text)) artifacts.add("console-log");
  if (/network/.test(text)) artifacts.add("network-log");
  if (/dom/.test(text)) artifacts.add("dom-log");
  if (/(^|[^A-Za-z-])log\b/.test(text) && !Array.from(artifacts).some(kind => kind.endsWith("-log"))) artifacts.add("log");
  if (modeMatches(mode, [/build/, /static/, /automated/, /behavior/, /test/])) artifacts.add("command-log");
  if (modeMatches(mode, [/browser/, /runtime/])) {
    artifacts.add("screenshot");
    artifacts.add("console-log");
  }
  if (modeMatches(mode, [/api/, /external/, /live/])) artifacts.add("api-log");
  if (modeMatches(mode, [/^db$/, /database/, /sql/])) artifacts.add("db-log");
  if (artifacts.size === 0) artifacts.add("log");
  return Array.from(artifacts);
}

function passCriteriaFromText(text, category) {
  const explicit = String(text).match(/(?:pass criteria|pass|then|expected):\s*([^.;\n]+)/i);
  if (explicit) return explicit[1].trim();
  if (category === "command" || category === "automated") return "command exits 0 and log artifact is recorded";
  if (category === "browser") return "target user-visible state is proven by screenshot/DOM evidence and console has no new errors";
  if (category === "server") return "service starts or healthcheck/API call succeeds with log artifact";
  if (category === "api") return "API response status/body matches expected contract and response log is recorded";
  if (category === "db") return "query/migration result matches expected row/schema state and DB log is recorded";
  return "agent-verifiable evidence artifact proves the check";
}

function toolForVerification(category, signals) {
  if (category === "browser") return "chromux";
  if (category === "server" && signals.dockerComposeFiles.length) return "docker-compose";
  if (category === "db" && signals.hasSupabase) return "supabase/local-db";
  if (category === "command" || category === "automated") return "verify-run";
  return "record-artifact";
}

function targetForVerification(category, signals) {
  if (category === "browser") return signals.packageScripts.includes("dev") ? "local dev server route from PRD" : "browser target URL must be supplied";
  if (category === "server") return signals.dockerComposeFiles.length ? signals.dockerComposeFiles.join(", ") : "repo dev/service command";
  if (category === "db") return signals.hasSupabase ? "local/sandbox Supabase" : "non-production DB target if required";
  return null;
}

function plannedCheckStatus(details) {
  const { verification, category, command, covers, artifacts, mode } = details;
  if ((category === "command" || category === "automated") && !command) return "needs_command";
  if (!hasDeclaredArtifact(verification) && !artifactDerivableFromMode(mode, category, artifacts)) return "needs_artifact";
  if (!artifacts.length) return "needs_artifact";
  if (!covers.requirements.length && !covers.acceptanceCriteria.length && !covers.tasks.length) return "needs_coverage_mapping";
  return "planned";
}

function artifactDerivableFromMode(mode, category, artifacts) {
  if (!mode || !artifacts || artifacts.length === 0) return false;
  if (category === "command" || category === "automated" || category === "browser" || category === "api" || category === "db" || category === "server") return true;
  return false;
}

function hasDeclaredArtifact(verification) {
  if (verification.matrix) return Boolean(verification.matrix.artifact);
  return /\bartifacts?:\s*\S/i.test(verification.text);
}

function plannerNotes(details) {
  const notes = [];
  const { verification, category, command, covers, signals, mode } = details;
  if ((category === "command" || category === "automated") && !command) notes.push("No concrete command found; planner must bind this to an existing script or add an approved verifier.");
  if (!hasDeclaredArtifact(verification) && !artifactDerivableFromMode(mode, category, artifactsForVerification(verification, category, mode))) notes.push("No explicit Artifact field found; the PRD must declare the evidence file type to record.");
  if (mode && !hasDeclaredArtifact(verification)) notes.push(`Artifact kinds were derived from Test Mode Contract mode: ${mode.mode}.`);
  if (!covers.requirements.length && !covers.acceptanceCriteria.length && !covers.tasks.length) notes.push("No R/AC/T coverage IDs found in the PRD verification item.");
  if (category === "browser" && !signals.packageScripts.includes("dev")) notes.push("No package.json dev script detected; target URL/server startup must be supplied before runtime QA.");
  if (category === "server" && !signals.dockerComposeFiles.length) notes.push("No docker-compose file detected; use repo-local service command or ask for service startup instructions.");
  if (/human|manual/i.test(verification.text)) notes.push("Check text includes manual language; ensure the agent-verifiable part is explicit.");
  return notes;
}

function buildCoverageMatrix(state, checks) {
  const coverage = {};
  for (const ac of state.acceptanceCriteria) {
    const coveredBy = checks
      .filter(check => check.covers.acceptanceCriteria.includes(ac.id) || check.covers.requirements.some(id => ac.requirements.includes(id)))
      .map(check => check.id);
    coverage[ac.id] = {
      title: ac.title,
      requirements: ac.requirements || [],
      coveredBy,
      status: coveredBy.length ? "covered" : "uncovered",
    };
  }
  return coverage;
}

function hasAppStartupSignal(signals) {
  const startupScripts = ["dev", "start", "serve", "preview", "dev:web", "start:dev", "web", "develop"];
  if ((signals.packageScripts || []).some(script => startupScripts.includes(script))) return true;
  if ((signals.dockerComposeFiles || []).length) return true;
  return false;
}

// Structural integrity of the parsed PRD. Exact-heading parsing degrades
// silently to empty arrays, and IDs referenced in one section may never be
// defined in another. These are blocking because they mean whole gates would
// otherwise vacuously pass (e.g. zero Acceptance Criteria enforced) or a user
// decision recorded only as an R#/AC# would drop out with no trace.
function structuralParseGaps(state) {
  const gaps = [];
  const tasks = state.tasks || [];
  const acs = state.acceptanceCriteria || [];
  const verifications = state.verification || [];
  const requirements = state.requirements || [];

  if (tasks.length > 0 && acs.length === 0) {
    gaps.push({
      severity: "blocking",
      code: "acceptance-section-empty",
      item: "acceptance-criteria",
      message: "PRD-Level Tasks parsed but no Acceptance Criteria were parsed; check the '## 7. Acceptance Criteria' heading text and bullet IDs",
    });
  }
  if (tasks.length > 0 && verifications.length === 0) {
    gaps.push({
      severity: "blocking",
      code: "verification-section-empty",
      item: "verification",
      message: "PRD-Level Tasks parsed but no Verification items were parsed; check the '## 9. Verification Contract' / Required Agent Verification table",
    });
  }

  const acIds = new Set(acs.map(item => String(item.id).toUpperCase()));
  const referencedAc = new Set();
  for (const task of tasks) for (const id of task.acceptanceCriteria || []) referencedAc.add(String(id).toUpperCase());
  for (const verification of verifications) for (const id of uniqueMatches(verification.text || "", /\bAC\d+\b/gi)) referencedAc.add(id.toUpperCase());
  if (acs.length > 0) {
    for (const id of referencedAc) {
      if (!acIds.has(id)) {
        gaps.push({
          severity: "blocking",
          code: "dangling-ac-reference",
          item: id,
          message: `${id} is referenced by a task or verification item but is not defined in Acceptance Criteria`,
        });
      }
    }
  }

  if (requirements.length > 0) {
    const referencedR = new Set();
    for (const task of tasks) for (const id of task.requirements || []) referencedR.add(String(id).toUpperCase());
    for (const verification of verifications) for (const id of uniqueMatches(verification.text || "", /\bR\d+\b/gi)) referencedR.add(id.toUpperCase());
    for (const ac of acs) for (const id of uniqueMatches(ac.text || "", /\bR\d+\b/gi)) referencedR.add(id.toUpperCase());
    for (const requirement of requirements) {
      if (!referencedR.has(String(requirement.id).toUpperCase())) {
        gaps.push({
          severity: "blocking",
          code: "requirement-uncovered",
          item: requirement.id,
          message: `${requirement.id} is defined in Requirements but is not covered by any task, acceptance criterion, or verification item`,
        });
      }
    }
  }

  return gaps;
}

function buildVerificationGaps(state, checks, coverage, signals) {
  const gaps = structuralParseGaps(state);
  for (const [acId, item] of Object.entries(coverage)) {
    if (!item.coveredBy.length) {
      gaps.push({
        severity: "blocking",
        code: "acceptance-uncovered",
        item: acId,
        message: `${acId} has no verification check mapped by AC/R coverage IDs`,
      });
    }
  }
	  for (const check of checks) {
    if (check.status === "needs_command") {
      gaps.push({
        severity: "blocking",
        code: "command-missing",
        item: check.id,
        message: `${check.id}/${check.verificationId} needs a concrete command or approved verifier`,
      });
    }
    if (check.status === "needs_coverage_mapping") {
      gaps.push({
        severity: "blocking",
        code: "coverage-missing",
        item: check.id,
        message: `${check.id}/${check.verificationId} has no R/AC/T coverage mapping`,
      });
    }
	    if (check.status === "needs_artifact") {
	      gaps.push({
	        severity: "blocking",
	        code: "artifact-missing",
	        item: check.id,
	        message: `${check.id}/${check.verificationId} has no explicit artifact requirement`,
	      });
	    }
	    const contractValues = check.contract ? Object.values(check.contract).filter(value => typeof value === "string").join(" ") : "";
	    const contractText = `${check.level || ""} ${contractValues} ${check.passCriteria || ""} ${check.target || ""}`.toLowerCase();
	    if ((check.category === "api" || /external|live|credential|secret|pii|phone|production/.test(contractText)) && check.contract) {
	      if (!check.contract.safeProbe) {
	        gaps.push({
	          severity: "warning",
	          code: "external-safe-probe-missing",
	          item: check.id,
	          message: `${check.id}/${check.verificationId} touches API/external/live behavior but has no Safe Probe column`,
	        });
	      }
	      if (!check.contract.sensitiveDataPolicy) {
	        gaps.push({
	          severity: "warning",
	          code: "sensitive-data-policy-missing",
	          item: check.id,
	          message: `${check.id}/${check.verificationId} touches API/external/live behavior but has no Sensitive Data Policy column`,
	        });
	      }
	    }
	  }
  if (checks.some(check => check.category === "browser") && !hasAppStartupSignal(signals)) {
    gaps.push({
      severity: "warning",
      code: "browser-server-missing",
      item: "environment",
      message: "Browser QA is required but no obvious app startup was detected (no dev/start/serve/preview script or docker-compose); confirm a startup command before browser verification",
    });
  }
  if (checks.some(check => check.category === "server") && !signals.dockerComposeFiles.length) {
    gaps.push({
      severity: "warning",
      code: "compose-missing",
      item: "environment",
      message: "Server/service verification exists but no docker-compose file was detected; use equivalent local service startup if available",
    });
  }
  return gaps;
}

function countState(state) {
  const executionOpen = state.executionPlan && Array.isArray(state.executionPlan.nodes)
    ? state.executionPlan.nodes.filter(item => !["complete", "deferred", "blocked"].includes(item.status)).length
    : 1;
  const tasksOpen = state.tasks.filter(item => !["complete", "deferred", "blocked"].includes(item.status)).length;
  const acOpen = state.acceptanceCriteria.filter(item => !["met", "not_met", "blocked"].includes(item.status)).length;
  const verificationOpen = state.verification.filter(item => !verificationIsClosedForAccounting(item)).length;
  const blocked = {
    execution: state.executionPlan && Array.isArray(state.executionPlan.nodes)
      ? state.executionPlan.nodes.filter(item => item.status === "blocked").length
      : 0,
    tasks: state.tasks.filter(item => item.status === "blocked").length,
    acceptanceCriteria: state.acceptanceCriteria.filter(item => item.status === "blocked" || item.status === "not_met").length,
    verification: state.verification.filter(item => item.status === "blocked" || item.status === "fail").length,
    requiredVerification: state.verification.filter(item => isVerificationRequiredForDone(item) && item.status !== "pass").length,
  };
  return {
    executionOpen,
    tasksOpen,
    acOpen,
    verificationOpen,
    totalOpen: executionOpen + tasksOpen + acOpen + verificationOpen,
    blocked,
    requiredVerificationNotPassed: blocked.requiredVerification,
  };
}

function reviewProfileName(state) {
  const profile = state && state.reviewProfile && typeof state.reviewProfile.profile === "string"
    ? state.reviewProfile.profile
    : "";
  return ["trivial", "standard", "high-risk"].includes(profile) ? profile : "standard";
}

function finalReviewRequiredForState(state) {
  return reviewProfileName(state) !== "trivial";
}

function classifyReviewProfile(input, explicitProfile, configProfile) {
  const explicit = String(explicitProfile || "").trim();
  if (explicit) {
    if (!["trivial", "standard", "high-risk"].includes(explicit)) {
      throw new Error("--review-profile must be trivial, standard, or high-risk");
    }
    return { profile: explicit, source: "explicit", reason: "set by --review-profile" };
  }
  const configured = String(configProfile || "").trim().toLowerCase();
  if (configured && configured !== "auto") {
    if (!["trivial", "standard", "high-risk"].includes(configured)) {
      throw new Error("config review.profile must be trivial, standard, high-risk, or auto");
    }
    return { profile: configured, source: "config", reason: "set by .hoyeon/config.json review.profile" };
  }
  const tasks = input.tasks || [];
  const acceptanceCriteria = input.acceptanceCriteria || [];
  const verification = input.verification || [];
  const haystack = [
    input.technicalStructure,
    input.implementationNotes,
    ...tasks.map(item => item.text || item.title || ""),
    ...acceptanceCriteria.map(item => item.text || item.title || ""),
    ...verification.map(item => item.text || item.passIntent || item.title || ""),
  ].join("\n").toLowerCase();
  if (/\b(db|database|migration|schema|auth|security|payment|billing|credential|secret|production|external|live api|provider|pii|token|deploy|rollback)\b/.test(haystack)) {
    return { profile: "high-risk", source: "auto", reason: "risk keywords found in PRD structure, tasks, ACs, or verification" };
  }
  if (tasks.length <= 2 && acceptanceCriteria.length <= 5 && verification.length <= 3) {
    return { profile: "trivial", source: "auto", reason: "small PRD surface with at most 2 tasks, 5 ACs, and 3 verification items" };
  }
  return { profile: "standard", source: "auto", reason: "default profile for non-trivial work without high-risk signals" };
}

function nextItem(state) {
  if (verificationPlanBlocksImplementation(state)) {
    const summary = verificationPlanSummary(state);
    return {
      kind: "verification_plan",
      item: {
        id: "VP0",
        title: `Resolve verification plan gaps before implementation (${summary.blockingGapCount} blocking)`,
        status: summary.status,
      },
    };
  }
  if (executionPlanBlocksImplementation(state)) {
    const summary = executionPlanSummary(state);
    return {
      kind: "execution_plan",
      item: {
        id: "EP0",
        title: `Generate or resolve execution plan before implementation (${summary.blockingGapCount} blocking)`,
        status: summary.status,
      },
    };
  }
  const ready = readyExecutionPlan(state);
	  if (ready.readySequential.length) {
	    const nodeId = ready.readySequential[0];
	    const node = state.executionPlan.nodes.find(item => item.id === nodeId);
	    return { kind: "execution_node", item: node };
	  }
	  const ac = state.acceptanceCriteria.find(item => !["met", "not_met", "blocked"].includes(item.status));
	  if (ac) return { kind: "ac", item: ac };
	  const verification = state.verification.find(item => !verificationIsClosedForAccounting(item));
	  if (verification) return { kind: "verification", item: verification };
	  const task = state.tasks.find(item => !["complete", "deferred", "blocked"].includes(item.status));
	  if (task) return { kind: "task_rollup", item: task };
	  if (!state.requirementsFidelityReview || state.requirementsFidelityReview.status !== "pass") {
	    return {
	      kind: "requirements_fidelity_review",
	      item: {
	        id: "REQ_FIDELITY_REVIEW",
	        title: "Run read-only requirements fidelity review before final adversarial review",
	        status: state.requirementsFidelityReview ? state.requirementsFidelityReview.status : "pending",
	      },
	    };
	  }
	  if (!finalReviewRequiredForState(state)) return null;
	  if (!state.finalReview || state.finalReview.status !== "pass") {
	    return {
	      kind: "final_review",
	      item: {
	        id: "REVIEW",
	        title: "Run final adversarial review before finalizing receipt",
	        status: state.finalReview ? state.finalReview.status : "pending",
	      },
	    };
	  }
	  return null;
	}

// Compact view of the next required item for per-mutation command output. The
// full execution-node object (writeScope, covers, evidence history) is large and
// unchanged between marks; callers that need the whole graph run `status`.
function nextBrief(state) {
  const next = nextItem(state);
  if (!next) return null;
  return { kind: next.kind, id: next.item.id, title: next.item.title, status: next.item.status };
}

function activePath(baseDir = cwd()) {
  return path.join(baseDir, ACTIVE_PATH);
}

function activeSessionsDir(baseDir = cwd()) {
  return path.join(baseDir, ACTIVE_SESSIONS_DIR);
}

function sessionActivePath(baseDir = cwd(), sessionId) {
  const normalized = normalizeCodexSessionId(sessionId);
  if (!normalized) throw new Error("session id is required for session active path");
  return path.join(activeSessionsDir(baseDir), `${encodeSessionPathSegment(normalized)}.json`);
}

function encodeSessionPathSegment(value) {
  return encodeURIComponent(value).replace(/\./g, "%2E");
}

function normalizeCodexSessionId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^(codex|opencode):/.test(trimmed)) return trimmed;
  return `codex:${trimmed}`;
}

function sessionIdFromHookPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  return normalizeCodexSessionId(payload.session_id || payload.sessionId);
}

function readActiveFile(file) {
  if (!fs.existsSync(file)) return null;
  const active = readJson(file);
  if (!active || typeof active.statePath !== "string") return null;
  return { file, active };
}

function readActive(baseDir = cwd(), options = {}) {
  const sessionId = normalizeCodexSessionId(options.sessionId);
  if (sessionId) {
    const sessionActive = readActiveFile(sessionActivePath(baseDir, sessionId));
    if (sessionActive && (!sessionActive.active.activeSessionId || sessionActive.active.activeSessionId === sessionId)) {
      return sessionActive;
    }
    const legacy = readActiveFile(activePath(baseDir));
    if (legacy && legacy.active.activeSessionId === sessionId) return legacy;
    if (legacy && !legacy.active.activeSessionId && options.allowUnboundLegacy === true) return legacy;
    return null;
  }
  return readActiveFile(activePath(baseDir));
}

function gitWorktreeRoots(projectRoot) {
  const result = childProcess.spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: projectRoot,
    shell: false,
    encoding: "utf8",
  });
  if (result.status !== 0) return [];
  const roots = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/^worktree\s+(.+)$/);
    if (match) roots.push(path.resolve(match[1]));
  }
  return roots;
}

function primaryWorktreeRoot(projectRoot) {
  const roots = gitWorktreeRoots(projectRoot);
  return roots.length ? roots[0] : null;
}

function activeRootsForState(state) {
  const projectRoot = state.projectRoot || cwd();
  const roots = [projectRoot];
  const primary = primaryWorktreeRoot(projectRoot);
  if (primary && canonicalPath(primary) !== canonicalPath(projectRoot)) roots.push(primary);
  return Array.from(new Set(roots.map(item => canonicalPath(item))));
}

function writeActiveRecord(baseDir, statePath, state) {
  const record = activeRecordForState(statePath, state, baseDir);
  writeJson(activePath(baseDir), record);
  if (state.activeSessionId) writeSessionActive(baseDir, state.activeSessionId, record);
  return record;
}

function activeRecordStatePath(active, baseDir) {
  if (!active || typeof active.statePath !== "string") return null;
  return canonicalPath(resolveProjectPath(active.statePath, baseDir));
}

function removeActiveRecordForState(baseDir, statePath) {
  const removed = [];
  const target = canonicalPath(statePath);
  const legacyPath = activePath(baseDir);
  const legacy = readActiveFile(legacyPath);
  if (legacy && activeRecordStatePath(legacy.active, baseDir) === target) {
    fs.rmSync(legacyPath, { force: true });
    removed.push(legacyPath);
  }
  const sessionsDir = activeSessionsDir(baseDir);
  if (fs.existsSync(sessionsDir)) {
    for (const entry of fs.readdirSync(sessionsDir)) {
      if (!entry.endsWith(".json")) continue;
      const file = path.join(sessionsDir, entry);
      const active = readActiveFile(file);
      if (active && activeRecordStatePath(active.active, baseDir) === target) {
        fs.rmSync(file, { force: true });
        removed.push(file);
      }
    }
  }
  return removed;
}

function activeDiagnostics(baseDir, selectedStatePath) {
  const selected = canonicalPath(selectedStatePath);
  const legacy = readActiveFile(activePath(baseDir));
  const sessions = [];
  const warnings = [];
  const sessionsDir = activeSessionsDir(baseDir);
  if (fs.existsSync(sessionsDir)) {
    for (const entry of fs.readdirSync(sessionsDir)) {
      if (!entry.endsWith(".json")) continue;
      const file = path.join(sessionsDir, entry);
      const active = readActiveFile(file);
      if (!active) continue;
      sessions.push({
        file: toProjectRelative(file, baseDir),
        statePath: active.active.statePath,
        activeSessionId: active.active.activeSessionId || null,
        status: active.active.status || null,
        updatedAt: active.active.updatedAt || null,
        selected: activeRecordStatePath(active.active, baseDir) === selected,
      });
    }
  }
  sessions.sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
  if (legacy) {
    const legacySelected = activeRecordStatePath(legacy.active, baseDir) === selected;
    const newerDifferent = sessions.find(item => !item.selected && item.updatedAt && legacy.active.updatedAt && item.updatedAt > legacy.active.updatedAt);
    if (!legacySelected) warnings.push("Legacy active pointer does not match the selected state");
    if (newerDifferent) warnings.push(`A newer session active file points at another state: ${newerDifferent.statePath}`);
  }
  return {
    baseDir,
    legacy: legacy ? {
      file: toProjectRelative(legacy.file, baseDir),
      statePath: legacy.active.statePath,
      activeSessionId: legacy.active.activeSessionId || null,
      status: legacy.active.status || null,
      updatedAt: legacy.active.updatedAt || null,
      selected: activeRecordStatePath(legacy.active, baseDir) === selected,
    } : null,
    sessions,
    warnings,
  };
}

function prdCopyDriftWarnings(state) {
  const projectRoot = state.projectRoot || cwd();
  const primary = primaryWorktreeRoot(projectRoot);
  if (!primary || canonicalPath(primary) === canonicalPath(projectRoot)) return [];
  const prdPath = state.prdPath || (state.prdSnapshot && state.prdSnapshot.path);
  if (!prdPath || path.isAbsolute(prdPath)) return [];
  const worktreePrd = path.join(projectRoot, prdPath);
  const primaryPrd = path.join(primary, prdPath);
  if (!fs.existsSync(worktreePrd) || !fs.existsSync(primaryPrd)) return [];
  const worktreeHash = sha256File(worktreePrd);
  const primaryHash = sha256File(primaryPrd);
  if (worktreeHash === primaryHash) return [];
  return [`PRD copy drift: ${toProjectRelative(primaryPrd, primary)} in primary checkout differs from worktree source of truth ${toProjectRelative(worktreePrd, projectRoot)}`];
}

function resolveStatePath(options = {}, baseDir = cwd()) {
  if (options.state) return resolveProjectPath(options.state, baseDir);
  const active = readActive(baseDir);
  if (!active) throw new Error(`No active PRD implementation state found at ${ACTIVE_PATH}`);
  return resolveProjectPath(active.active.statePath, baseDir);
}

function loadState(options = {}, baseDir = cwd()) {
  const statePath = resolveStatePath(options, baseDir);
  const state = readJson(statePath);
  if (state.schema !== SCHEMA) throw new Error(`Unsupported state schema in ${statePath}`);
  return { statePath, state };
}

function cmdInit(options) {
  const prdInput = options.prd;
  if (!prdInput) throw new Error("--prd is required");
  const projectRoot = cwd();
  const initialSessionId = normalizeCodexSessionId(
    options["session-id"] ||
    options.sessionId ||
    process.env.CODEX_SESSION_ID ||
    process.env.CODEX_THREAD_ID,
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
    if (initialSessionId) writeSessionActive(projectRoot, initialSessionId, pointerRecord);
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

function latestPrdSlug(projectRoot) {
  const prdRoot = path.join(projectRoot, ".hoyeon", "prd");
  if (!fs.existsSync(prdRoot)) return null;
  let latest = null;
  for (const entry of fs.readdirSync(prdRoot)) {
    const prdFile = path.join(prdRoot, entry, "prd.md");
    if (!fs.existsSync(prdFile)) continue;
    const mtime = fs.statSync(prdFile).mtimeMs;
    if (!latest || mtime > latest.mtime) latest = { slug: entry, mtime };
  }
  return latest ? latest.slug : null;
}

function gitTracked(projectRoot, relPath) {
  return childProcess.spawnSync("git", ["ls-files", "--error-unmatch", "--", relPath], {
    cwd: projectRoot,
    shell: false,
    encoding: "utf8",
  }).status === 0;
}

function gitIgnored(projectRoot, relPath) {
  return childProcess.spawnSync("git", ["check-ignore", "--quiet", "--no-index", "--", relPath], {
    cwd: projectRoot,
    shell: false,
    encoding: "utf8",
  }).status === 0;
}

function cmdDoctor() {
  const projectRoot = cwd();
  const checks = [];
  const add = (level, id, message) => checks.push({ level, id, message });

  let gitOk = false;
  let originUrl = null;
  const gitTop = childProcess.spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: projectRoot,
    shell: false,
    encoding: "utf8",
  });
  if (gitTop.status === 0) {
    gitOk = true;
    add("ok", "git", `Git repository: ${gitTop.stdout.trim()}`);
    const origin = childProcess.spawnSync("git", ["remote", "get-url", "origin"], {
      cwd: projectRoot,
      shell: false,
      encoding: "utf8",
    });
    if (origin.status === 0) {
      originUrl = origin.stdout.trim();
      add("ok", "origin", `origin remote: ${originUrl}`);
    }
  } else {
    add("error", "git", "Not inside a git repository; the PRD pipeline requires one");
  }

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

  const slug = latestPrdSlug(projectRoot) || "<topic-slug>";
  let delivery = null;
  try {
    delivery = normalizeDeliveryConfig(projectRoot, {}, projectConfig, slug);
  } catch (error) {
    add("error", "delivery-config", error.message);
  }
  const prMode = Boolean(delivery && delivery.mode === "pr");
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

  if (prMode && gitOk && !originUrl) {
    add("error", "origin", "Delivery mode is pr but no 'origin' remote is configured; push and PR creation will fail");
  }

  if (gitOk) {
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

  const ghVersion = childProcess.spawnSync("gh", ["--version"], { shell: false, encoding: "utf8" });
  if (ghVersion.status !== 0) {
    add(prMode ? "error" : "warn", "gh", "GitHub CLI (gh) is not available");
  } else {
    const ghAuth = childProcess.spawnSync("gh", ["auth", "status"], { cwd: projectRoot, shell: false, encoding: "utf8" });
    if (ghAuth.status === 0) add("ok", "gh", "gh installed and authenticated");
    else add(prMode ? "error" : "warn", "gh", "gh is installed but not authenticated (gh auth login)");
  }

  if (delivery && delivery.worktree.enabled) {
    for (const rel of [...delivery.worktree.link, ...delivery.worktree.copy]) {
      if (!fs.existsSync(path.join(projectRoot, rel))) {
        add("warn", "worktree-sync", `worktree link/copy source '${rel}' does not exist in this checkout`);
      } else if (gitOk && gitTracked(projectRoot, rel)) {
        add("warn", "worktree-sync", `'${rel}' is tracked by git; link/copy is meant for gitignored local files`);
      }
    }
  }

  if (prMode) {
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

    const shipScript = path.join(os.homedir(), ".codex", "skills", "prd-ship", "scripts", "prd_ship.js");
    if (fs.existsSync(shipScript)) add("ok", "prd-ship", "prd-ship script found");
    else add("error", "prd-ship", `Delivery mode is pr but ${shipScript} is missing`);

    const hooksFile = path.join(os.homedir(), ".codex", "hooks.json");
    let hooksRegistered = false;
    try {
      hooksRegistered = fs.existsSync(hooksFile) && fs.readFileSync(hooksFile, "utf8").includes("prd_state_harness.js");
    } catch {
      hooksRegistered = false;
    }
    if (hooksRegistered) add("ok", "hooks", "Harness Stop/PreToolUse hooks are registered in ~/.codex/hooks.json");
    else add("warn", "hooks", "Harness hooks are not registered in ~/.codex/hooks.json; ship handoff will rely on skill instructions only");
  }

  let activeRun = null;
  const activeFile = activePath(projectRoot);
  if (fs.existsSync(activeFile)) {
    try {
      const active = readJson(activeFile);
      const stateAbs = resolveProjectPath(active.statePath, projectRoot);
      let ship = null;
      if (fs.existsSync(stateAbs)) {
        const state = readJson(stateAbs);
        ship = {
          receipt: state.finalReceipt ? state.finalReceipt.status : null,
          shipPending: deliveryShipPending(stateAbs, state),
        };
        activeRun = {
          statePath: active.statePath,
          runDir: active.runDir,
          status: state.status,
          delivery: active.delivery || null,
          pointer: Boolean(active.pointer),
          ...ship,
        };
      } else {
        activeRun = { statePath: active.statePath, status: "state-file-missing", pointer: Boolean(active.pointer) };
        add("warn", "active-run", `Active file points to missing state: ${active.statePath}`);
      }
    } catch (error) {
      add("warn", "active-run", `Active file unreadable: ${error.message}`);
    }
  }

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
    path.join(projectRoot, ".hoyeon", "implement", slugFromPrdPath(prdAbs), "state.json"),
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

function cmdMarkNode(options) {
  const ids = parseIdList(options.id, value => value.toUpperCase());
  const status = String(options.status || "");
  const evidence = String(options.evidence || "").trim();
  if (!ids.length) throw new Error("--id is required");
  if (!status) throw new Error("--status is required");
  if (!evidence) throw new Error("--evidence is required");
  assertAllowedExecutionStatus(status);
  const { statePath, state } = loadState(options);
	  if (!state.executionPlan || !Array.isArray(state.executionPlan.nodes)) throw new Error("Execution plan is missing; run plan-execution first");
  const marked = [];
  for (const id of ids) {
	    const node = state.executionPlan.nodes.find(entry => String(entry.id).toUpperCase() === id);
	    if (!node) throw new Error(`Execution node ${id} not found`);
	    let deviationEntry = null;
	    if (status === "complete") {
	      const ready = readyExecutionPlan(state);
	      const wasAlreadyStarted = node.status === "in_progress";
	      if (!wasAlreadyStarted && !ready.readySequential.includes(node.id)) {
	        const blocker = ready.blocked.find(item => item.id === node.id);
	        deviationEntry = recordDeviation(state, "ready_order", node.id, "Execution node completed outside ready guidance", {
	          waitingFor: blocker ? blocker.waitingFor : [],
	          readySequential: ready.readySequential,
	        });
	      }
	    }
	    node.status = status;
	    if (!node.evidence) node.evidence = [];
	    node.evidence.push({ ts: nowIso(), text: evidence });
    marked.push({ kind: "execution_node", id, status, sourceTask: node.sourceTask, deviation: deviationEntry });
  }
	  rollupTasksFromExecutionPlan(state);
	  markCompletionReviewsStale(state, `Execution node(s) ${ids.join(", ")} were marked after review`);
	  state.updatedAt = nowIso();
  persistStateAndArtifacts(statePath, state);
  appendJsonl(path.join(path.dirname(statePath), "ledger.jsonl"), {
    ts: nowIso(),
    event: "execution_node_marked",
    ids,
    status,
	    evidence,
	    marked,
	  });
  syncActive(statePath, state);
  process.stdout.write(JSON.stringify({
    ok: true,
    marked,
    counts: countState(state),
    next: nextBrief(state),
  }, null, 2) + "\n");
}

function cmdAssignNode(options) {
  const id = String(options.id || "").toUpperCase();
  const owner = String(options.owner || "").trim();
  if (!id) throw new Error("--id is required");
  if (!owner) throw new Error("--owner is required");
  const { statePath, state } = loadState(options);
  if (!state.executionPlan || !Array.isArray(state.executionPlan.nodes)) throw new Error("Execution plan is missing; run plan-execution first");
  const node = state.executionPlan.nodes.find(entry => String(entry.id).toUpperCase() === id);
  if (!node) throw new Error(`Execution node ${id} not found`);
	  node.owner = owner;
	  markCompletionReviewsStale(state, `Execution node ${id} assignment changed after review`);
	  state.updatedAt = nowIso();
  persistStateAndArtifacts(statePath, state);
  appendJsonl(path.join(path.dirname(statePath), "ledger.jsonl"), {
    ts: nowIso(),
    event: "node_assigned",
    id,
    sourceTask: node.sourceTask,
    owner,
  });
  syncActive(statePath, state);
  process.stdout.write(JSON.stringify({
    ok: true,
    assigned: { id, owner },
    next: nextBrief(state),
  }, null, 2) + "\n");
}

function cmdMark(options) {
  const kind = options.kind;
  const ids = parseIdList(options.id, value => value.toUpperCase());
  const status = String(options.status || "");
  const evidence = String(options.evidence || "").trim();
  if (!["task", "ac", "verification"].includes(kind)) throw new Error("--kind must be task, ac, or verification");
  if (!ids.length) throw new Error("--id is required");
  if (!status) throw new Error("--status is required");
  if (!evidence) throw new Error("--evidence is required");

  const { statePath, state } = loadState(options);
  const list = kind === "task" ? state.tasks : kind === "ac" ? state.acceptanceCriteria : state.verification;
  assertAllowedStatus(kind, status);
  const marked = [];
  for (const id of ids) {
    const item = list.find(entry => String(entry.id).toUpperCase() === id);
    if (!item) throw new Error(`${kind} ${id} not found`);
	  item.status = status;
	  item.evidence.push({ ts: nowIso(), text: evidence });
    marked.push({ kind, id, status });
  }
	  rollupTasksFromExecutionPlan(state);
	  markCompletionReviewsStale(state, `${kind} ${ids.join(", ")} marked after review`);
	  state.updatedAt = nowIso();
  persistStateAndArtifacts(statePath, state);
  appendJsonl(path.join(path.dirname(statePath), "ledger.jsonl"), {
    ts: nowIso(),
    event: "marked",
    kind,
    ids,
    status,
    evidence,
  });
  syncActive(statePath, state);
  process.stdout.write(JSON.stringify({
    ok: true,
    marked,
    counts: countState(state),
    next: nextBrief(state),
  }, null, 2) + "\n");
}

function cmdRecordArtifact(options) {
  const id = String(options.id || "").toUpperCase();
  const kind = String(options.kind || "");
  const artifactPath = String(options.path || "");
  const description = String(options.description || "").trim();
  if (!id) throw new Error("--id is required");
  if (!kind) throw new Error("--kind is required");
  if (!artifactPath) throw new Error("--path is required");
  if (!description) throw new Error("--description is required");

  const { statePath, state } = loadState(options);
  const match = findTrackedItem(state, id);
  if (!match) throw new Error(`Tracked item ${id} not found`);
	  const artifact = attachArtifact(statePath, state, match, kind, artifactPath, description);
	  rollupTasksFromExecutionPlan(state);
	  markCompletionReviewsStale(state, `Artifact was recorded for ${match.kind} ${match.item.id} after review`);
	  state.updatedAt = nowIso();
  persistStateAndArtifacts(statePath, state);
  appendJsonl(path.join(path.dirname(statePath), "ledger.jsonl"), {
    ts: nowIso(),
    event: "artifact_recorded",
    attachedTo: { kind: match.kind, id: match.item.id },
    artifact,
  });
  syncActive(statePath, state);
  process.stdout.write(JSON.stringify({
    ok: true,
    attachedTo: { kind: match.kind, id: match.item.id },
    artifact,
    counts: countState(state),
    next: nextBrief(state),
  }, null, 2) + "\n");
}

function cmdRefreshArtifacts(options) {
  const filterId = options.id ? String(options.id).toUpperCase() : null;
  const { statePath, state } = loadState(options);
  const projectRoot = state.projectRoot || cwd();
  const refreshed = [];
  const missing = [];
  let unchanged = 0;
  let matched = 0;

  for (const entry of collectArtifacts(state)) {
    if (filterId && String(entry.ownerId).toUpperCase() !== filterId) continue;
    matched += 1;
    const artifact = entry.artifact || {};
    if (!artifact.path) continue;
    const abs = resolveProjectPath(artifact.path, projectRoot);
    let info;
    try {
      info = inspectArtifact(abs, artifact.kind || "file");
    } catch (error) {
      missing.push({ owner: entry.ownerId, path: artifact.path, error: error.message });
      continue;
    }
    if (artifact.sha256 === info.sha256 && artifact.bytes === info.bytes) {
      unchanged += 1;
      continue;
    }
    const previousSha = artifact.sha256 || null;
    artifact.bytes = info.bytes;
    artifact.sha256 = info.sha256;
    artifact.mimeHint = info.mimeHint;
    if (info.width) artifact.width = info.width;
    if (info.height) artifact.height = info.height;
    artifact.refreshedAt = nowIso();
    const owner = findTrackedItem(state, entry.ownerId);
    if (owner && owner.item) {
      if (!owner.item.evidence) owner.item.evidence = [];
      owner.item.evidence.push({
        ts: nowIso(),
        text: `Artifact refreshed after in-place overwrite: ${artifact.kind} ${artifact.path} (${String(previousSha).slice(0, 12)} -> ${info.sha256.slice(0, 12)})`,
      });
    }
    refreshed.push({
      owner: entry.ownerId,
      path: artifact.path,
      previousSha256: previousSha,
      sha256: info.sha256,
    });
  }

  if (filterId && !matched) throw new Error(`Tracked item ${filterId} not found or has no artifacts`);

  if (refreshed.length) {
    markCompletionReviewsStale(state, "Registered artifacts were refreshed after review");
    state.updatedAt = nowIso();
    persistStateAndArtifacts(statePath, state);
    appendJsonl(path.join(path.dirname(statePath), "ledger.jsonl"), {
      ts: nowIso(),
      event: "artifacts_refreshed",
      filterId,
      refreshed,
      missing,
    });
    syncActive(statePath, state);
  }

  process.stdout.write(JSON.stringify({
    ok: missing.length === 0,
    refreshedCount: refreshed.length,
    unchangedCount: unchanged,
    refreshed,
    missing,
    note: refreshed.length
      ? "Completion reviews were marked stale; rerun requirements fidelity review and final review before finalize."
      : "No registered artifact hashes changed.",
  }, null, 2) + "\n");
  if (missing.length) process.exitCode = 2;
}

function cmdVerifyRun(rawArgs) {
  const separatorIndex = rawArgs.indexOf("--");
  if (separatorIndex < 0) throw new Error("verify-run requires -- before the command");
  const options = parseArgs(rawArgs.slice(0, separatorIndex));
  const commandArgs = rawArgs.slice(separatorIndex + 1);
  const id = String(options.id || "").toUpperCase();
  if (!id) throw new Error("--id is required");
  if (!commandArgs.length) throw new Error("verification command is required after --");

	  const { statePath, state } = loadState(options);
	  const match = findTrackedItem(state, id, "verification");
	  if (!match) throw new Error(`Verification ${id} not found`);
	  const commandText = formatCommandArgs(commandArgs);
	  const commandCompareText = commandArgsForCompare(commandArgs);
	  const plannedCommand = plannedCommandForVerification(state, id);
	  const deviation = String(options.deviation || "").trim();
	  let deviationEntry = null;
	  if (!commandsMatchContract(commandCompareText, plannedCommand)) {
	    if (!deviation) {
	      throw new Error(`Verification ${id} command differs from PRD contract. Expected: ${plannedCommand}. Actual: ${commandText}. Re-run with --deviation <reason> if this is an intentional equivalent verifier.`);
	    }
	    deviationEntry = recordDeviation(state, "verification_command", id, deviation, {
	      expectedCommand: plannedCommand,
	      actualCommand: commandText,
	    });
	  }
	  const startedAt = nowIso();
  const result = childProcess.spawnSync(commandArgs[0], commandArgs.slice(1), {
    cwd: state.projectRoot || cwd(),
    shell: false,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  const finishedAt = nowIso();
  const exitCode = typeof result.status === "number" ? result.status : 1;
  const signal = result.signal || null;
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const errorMessage = result.error && result.error.message ? result.error.message : "";
  const logRel = path.join(state.runDir, "artifacts", "logs", `${id}-${safeTimestamp()}.log`);
  const logAbs = path.join(state.projectRoot || cwd(), logRel);
  writeMarkdown(logAbs, [
    `command: ${commandText}`,
    `cwd: ${state.projectRoot || cwd()}`,
    `startedAt: ${startedAt}`,
    `finishedAt: ${finishedAt}`,
    `exitCode: ${exitCode}`,
    signal ? `signal: ${signal}` : "",
    errorMessage ? `error: ${errorMessage}` : "",
    "",
    "--- stdout ---",
    stdout,
    "",
    "--- stderr ---",
    stderr,
  ].filter(line => line !== "").join("\n"));

  const description = `verify-run ${exitCode === 0 ? "passed" : "failed"}: ${commandText}`;
	  const artifact = attachArtifact(statePath, state, match, "command-log", logAbs, description, {
	    command: commandText,
	    contractCommand: plannedCommand || null,
	    deviationId: deviationEntry ? deviationEntry.id : null,
	    exitCode,
	    startedAt,
	    finishedAt,
	  });
  match.item.status = exitCode === 0 ? "pass" : "fail";
  match.item.evidence.push({
    ts: nowIso(),
    text: `Command ${exitCode === 0 ? "passed" : "failed"} with exit code ${exitCode}: ${commandText}. Log: ${artifact.path}`,
  });
	  rollupTasksFromExecutionPlan(state);
	  markCompletionReviewsStale(state, `Verification ${id} was run after review`);
	  state.updatedAt = nowIso();
  persistStateAndArtifacts(statePath, state);
  appendJsonl(path.join(path.dirname(statePath), "ledger.jsonl"), {
    ts: nowIso(),
    event: "verification_run",
    id,
	    command: commandText,
	    contractCommand: plannedCommand || null,
	    deviation: deviationEntry,
	    exitCode,
    logPath: artifact.path,
  });
  syncActive(statePath, state);
  process.stdout.write(JSON.stringify({
    ok: exitCode === 0,
    id,
    status: match.item.status,
    command: commandText,
    exitCode,
    logPath: artifact.path,
    counts: countState(state),
    next: nextBrief(state),
  }, null, 2) + "\n");
  if (exitCode !== 0) process.exitCode = 2;
}

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

function assertAllowedStatus(kind, status) {
  const allowed = {
    task: ["pending", "in_progress", "complete", "deferred", "blocked"],
    ac: ["pending", "met", "not_met", "blocked"],
    verification: ["pending", "pass", "fail", "skipped", "blocked"],
  }[kind];
  if (!allowed.includes(status)) throw new Error(`Invalid ${kind} status '${status}'. Allowed: ${allowed.join(", ")}`);
}

function assertAllowedExecutionStatus(status) {
  const allowed = ["pending", "in_progress", "complete", "blocked", "deferred"];
  if (!allowed.includes(status)) throw new Error(`Invalid execution node status '${status}'. Allowed: ${allowed.join(", ")}`);
}

function completionReadiness(statePath, state, options = {}) {
  const violations = completionViolations(statePath, state, options);
  return {
    receiptEligible: violations.length === 0 && Boolean(state.finalReceipt),
    finalizationEligible: violations.length === 0,
    violationCount: violations.length,
    violations,
  };
}

function completionViolations(statePath, state, options = {}) {
  const includeFinalReview = options.includeFinalReview !== false;
  const includeRequirementsFidelityReview = options.includeRequirementsFidelityReview !== false;
  const violations = [];
  violations.push(...prdSnapshotViolations(statePath, state));
  const verificationPlan = verificationPlanSummary(state);
  if (verificationPlan.status === "missing") {
    violations.push("Verification plan is missing");
  } else if (verificationPlan.blockingGapCount > 0) {
    violations.push(`Verification plan has ${verificationPlan.blockingGapCount} blocking gap(s)`);
  }
  const executionPlan = executionPlanSummary(state);
  if (executionPlan.status === "missing") {
    violations.push("Execution plan is missing");
  } else if (executionPlan.blockingGapCount > 0) {
    violations.push(`Execution plan has ${executionPlan.blockingGapCount} blocking gap(s)`);
  }
  for (const node of (state.executionPlan && state.executionPlan.nodes) || []) {
    if (node.status !== "complete") violations.push(`Execution node ${node.id} is ${node.status}`);
    if (!node.evidence || node.evidence.length === 0) violations.push(`Execution node ${node.id} has no evidence`);
  }
  for (const task of state.tasks || []) {
    const rollup = state.executionPlan && state.executionPlan.rollups && state.executionPlan.rollups.tasks
      ? state.executionPlan.rollups.tasks[task.id]
      : null;
    if (!rollup || !rollup.nodes || rollup.nodes.length === 0) {
      violations.push(`Task ${task.id} has no execution node mapping`);
    }
  }
  violations.push(...taskGraphViolations(state));
  for (const task of state.tasks) {
    if (task.status !== "complete") violations.push(`Task ${task.id} is ${task.status}`);
    if (!task.evidence.length) violations.push(`Task ${task.id} has no evidence`);
  }
  for (const ac of state.acceptanceCriteria) {
    if (ac.status !== "met") violations.push(`Acceptance ${ac.id} is ${ac.status}`);
    if (!ac.evidence.length) violations.push(`Acceptance ${ac.id} has no evidence`);
  }
	  for (const verification of state.verification) {
	    if (isVerificationRequiredForDone(verification)) {
	      if (verification.status !== "pass") violations.push(`Required verification ${verification.id} is ${verification.status}`);
	    } else if (!["pass", "skipped", "blocked"].includes(verification.status)) {
	      violations.push(`Optional verification ${verification.id} is ${verification.status}`);
	    }
	    if (!verification.evidence.length) violations.push(`Verification ${verification.id} has no evidence`);
	    if (verification.status === "pass" && (!verification.artifacts || verification.artifacts.length === 0)) {
	      violations.push(`Verification ${verification.id} has no artifact-backed evidence`);
	    }
  }
  violations.push(...validateArtifacts(statePath, state));
  if (includeRequirementsFidelityReview) {
    if (!state.requirementsFidelityReview || state.requirementsFidelityReview.status !== "pass") {
      violations.push("Requirements fidelity review has not passed");
    } else if (!state.requirementsFidelityReview.reportPath) {
      violations.push("Requirements fidelity review has no report path");
    }
  }
  if (includeFinalReview && finalReviewRequiredForState(state)) {
    if (!state.finalReview || state.finalReview.status !== "pass") {
      violations.push("Final adversarial review has not passed");
    } else if (!state.finalReview.reportPath) {
      violations.push("Final adversarial review has no report path");
    }
  }
	  return violations;
	}

function prdSnapshotViolations(statePath, state) {
  const snapshot = state.prdSnapshot;
  if (!snapshot) return [];
  const violations = [];
  try {
    const prdAbs = resolveProjectPath(state.prdPath, state.projectRoot || cwd());
    const currentText = fs.readFileSync(prdAbs, "utf8");
    if (snapshot.sha256 && snapshot.sha256 !== sha256Text(currentText)) {
      violations.push("PRD file changed after implementation state was initialized; rerun init --force or explicitly reconcile the PRD snapshot");
    }
  } catch (error) {
    violations.push(`PRD snapshot cannot be validated: ${error.message}`);
  }
  const taskIds = (state.tasks || []).map(item => item.id).join(",");
  const snapshotTaskIds = (snapshot.taskIds || []).join(",");
  if (snapshotTaskIds && taskIds !== snapshotTaskIds) violations.push("State task IDs differ from PRD snapshot task IDs");
  const acIds = (state.acceptanceCriteria || []).map(item => item.id).join(",");
  const snapshotAcIds = (snapshot.acceptanceCriteriaIds || []).join(",");
  if (snapshotAcIds && acIds !== snapshotAcIds) violations.push("State acceptance IDs differ from PRD snapshot acceptance IDs");
  const verificationIds = (state.verification || []).map(item => item.id).join(",");
  const snapshotVerificationIds = (snapshot.verificationIds || []).join(",");
  if (snapshotVerificationIds && verificationIds !== snapshotVerificationIds) violations.push("State verification IDs differ from PRD snapshot verification IDs");
  if (snapshot.verificationContractHash && snapshot.verificationContractHash !== verificationContractHash(state)) {
    violations.push("State verification contract hash differs from PRD snapshot");
  }
  return violations;
}

function taskGraphViolations(state) {
  const graph = state.taskGraph;
  const violations = [];
  if (!graph) return ["Task graph is missing"];
  const nodeIds = new Set((graph.nodes || []).map(node => node.id));
  if (!nodeIds.has("EP0")) violations.push("Task graph is missing EP0 execution-plan node");
  for (const node of (state.executionPlan && state.executionPlan.nodes) || []) {
    if (!nodeIds.has(node.id)) violations.push(`Task graph is missing execution node ${node.id}`);
  }
  for (const task of state.tasks || []) {
    if (!nodeIds.has(task.id)) violations.push(`Task graph is missing task node ${task.id}`);
  }
  for (const ac of state.acceptanceCriteria || []) {
    if (!nodeIds.has(ac.id)) violations.push(`Task graph is missing acceptance node ${ac.id}`);
  }
  for (const verification of state.verification || []) {
    if (!nodeIds.has(verification.id)) violations.push(`Task graph is missing verification node ${verification.id}`);
  }
  if (!nodeIds.has("REQ_FIDELITY_REVIEW")) violations.push("Task graph is missing REQ_FIDELITY_REVIEW node");
  if (!nodeIds.has("REVIEW")) violations.push("Task graph is missing REVIEW node");
  if (!nodeIds.has("FINALIZE")) violations.push("Task graph is missing FINALIZE node");
  return violations;
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

function requirementsFidelityHandoffViolations(state) {
  const review = state.requirementsFidelityReview;
  if (!review) return ["Requirements fidelity review must be recorded before blocked/partial finalization"];
  const violations = [];
  if (!["pass", "fail"].includes(review.status)) {
    violations.push(`Requirements fidelity review status must be pass or fail before blocked/partial finalization; got ${review.status || "unknown"}`);
  }
  if (!review.reportPath) violations.push("Requirements fidelity review has no report path");
  if (!review.summary) violations.push("Requirements fidelity review has no summary");
  if (!review.recordedAt) violations.push("Requirements fidelity review has no recordedAt timestamp");
  if (review.reportPath) {
    try {
      const abs = resolveProjectPath(review.reportPath, state.projectRoot || cwd());
      inspectArtifact(abs, "log");
      if (review.reportSha256 && review.reportSha256 !== sha256File(abs)) {
        violations.push("Requirements fidelity review report hash changed");
      }
    } catch (error) {
      violations.push(`Requirements fidelity review report invalid: ${error.message}`);
    }
  }
  violations.push(...requirementsFidelityReviewFreshnessViolations(state));
  violations.push(...reviewWorktreeSnapshotViolations(state));
  return violations;
}

function simpleHash(text) {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(index);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function activeRecordForState(statePath, state, projectRoot = state.projectRoot || cwd()) {
  return {
    schema: "hoyeon.prd-implement.active.v1",
    statePath: toProjectRelative(statePath, projectRoot),
    prdPath: state.prdPath,
    runDir: state.runDir,
    status: state.status,
    delivery: state.delivery ? {
      mode: state.delivery.mode,
      branch: state.delivery.branch,
      worktreePath: state.delivery.worktree && state.delivery.worktree.path,
    } : null,
    activeSessionId: state.activeSessionId || null,
    updatedAt: nowIso(),
  };
}

function activeRecordMatchesState(active, statePath, baseDir) {
  if (!active || typeof active.statePath !== "string") return false;
  return canonicalPath(resolveProjectPath(active.statePath, baseDir)) === canonicalPath(statePath);
}

function writeSessionActive(projectRoot, sessionId, record) {
  const normalized = normalizeCodexSessionId(sessionId);
  if (!normalized) return;
  writeJson(sessionActivePath(projectRoot, normalized), {
    ...record,
    activeSessionId: normalized,
  });
}

function syncActive(statePath, state) {
  for (const root of activeRootsForState(state)) {
    writeActiveRecord(root, statePath, state);
  }
}

function persistStateAndArtifacts(statePath, state) {
  refreshExecutionTraceMatrix(state);
  state.taskGraph = buildTaskGraph(state);
  writeJson(statePath, state);
  writeArtifacts(statePath, state);
}

function writeArtifacts(statePath, state) {
  const runDir = path.dirname(statePath);
  const taskGraph = state.taskGraph || buildTaskGraph(state);
  writeMarkdown(path.join(runDir, "checklist.md"), renderChecklist(state));
  writeJson(path.join(runDir, "taskgraph.json"), taskGraph);
  writeMarkdown(path.join(runDir, "taskgraph.md"), renderTaskGraph(state, taskGraph));
  if (state.executionPlan) {
    writeJson(path.join(runDir, "execution-plan.json"), state.executionPlan);
    writeMarkdown(path.join(runDir, "execution-plan.md"), renderExecutionPlan(state));
  }
  if (state.verificationPlan) {
    writeJson(path.join(runDir, "verification-plan.json"), state.verificationPlan);
    writeMarkdown(path.join(runDir, "verification-plan.md"), renderVerificationPlan(state));
  }
  if (!fs.existsSync(path.join(runDir, "context-notes.md"))) {
    writeMarkdown(path.join(runDir, "context-notes.md"), `# Context Notes\n\n- PRD: ${state.prdPath}\n`);
  }
  writeMarkdown(path.join(runDir, "verification.md"), renderVerification(state));
}

function writeMarkdown(file, body) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, body.endsWith("\n") ? body : `${body}\n`);
}

function checkbox(done) {
  return done ? "[x]" : "[ ]";
}

function evidenceText(item) {
  if (!item.evidence || item.evidence.length === 0) return "";
  return item.evidence.map(entry => `    - ${entry.ts}: ${entry.text}`).join("\n");
}

function artifactText(item) {
  if (!item.artifacts || item.artifacts.length === 0) return "";
  return item.artifacts.map(artifact => `    - ${artifact.kind}: ${artifact.path} (${String(artifact.sha256 || "").slice(0, 12)})`).join("\n");
}

function renderExecutionPlan(state) {
  const plan = state.executionPlan;
  if (!plan) return "# Execution Plan\n\nStatus: missing\n";
  const ready = readyExecutionPlan(state);
  const lines = [
    `# Execution Plan: ${state.topicSlug}`,
    "",
    `- PRD: ${state.prdPath}`,
    `- Status: ${plan.status}`,
    `- Generated: ${plan.generatedAt}`,
    `- Nodes: ${(plan.nodes || []).length}`,
    `- Blocking gaps: ${(plan.gaps || []).filter(gap => gap.severity === "blocking").length}`,
    `- Warnings: ${(plan.gaps || []).filter(gap => gap.severity !== "blocking").length}`,
    "",
    "## Ready Guidance",
    "",
    `- Ready sequential: ${ready.readySequential.length ? ready.readySequential.join(", ") : "none"}`,
    `- Ready parallel groups: ${ready.readyParallelGroups.length ? ready.readyParallelGroups.map(group => `[${group.join(", ")}]`).join(", ") : "none"}`,
    "",
    "## Nodes",
    "",
  ];
  for (const node of plan.nodes || []) {
    lines.push(`### ${node.id}. ${node.title}`);
    lines.push("");
    lines.push(`- Status: ${node.status}`);
    lines.push(`- Source task: ${node.sourceTask}`);
    lines.push(`- Owner: ${node.owner || "unassigned"}`);
    lines.push(`- Depends on: ${(node.dependsOn || []).length ? node.dependsOn.join(", ") : "none"}`);
    lines.push(`- Write scope: ${(node.writeScope || []).length ? node.writeScope.join(", ") : "unknown"}`);
    lines.push(`- Parallel safe: ${node.parallelSafe ? "yes" : "no"}`);
    lines.push(`- Risk: ${node.risk}`);
    lines.push(`- Covers: ${formatCoverage(node.covers)}`);
    if (node.evidence && node.evidence.length) {
      lines.push("- Evidence:");
      for (const entry of node.evidence) lines.push(`  - ${entry.ts}: ${entry.text}`);
    }
    if (node.artifacts && node.artifacts.length) {
      lines.push("- Artifacts:");
      for (const artifact of node.artifacts) lines.push(`  - ${artifact.kind}: ${artifact.path} (${String(artifact.sha256 || "").slice(0, 12)})`);
    }
    lines.push("");
  }
	  lines.push("## Rollups", "");
	  for (const [taskId, rollup] of Object.entries((plan.rollups && plan.rollups.tasks) || {})) {
	    lines.push(`- ${taskId}: nodes ${rollup.nodes.length ? rollup.nodes.join(", ") : "none"}; AC ${rollup.acceptanceCriteria.length ? rollup.acceptanceCriteria.join(", ") : "none"}; Verification ${rollup.verification.length ? rollup.verification.join(", ") : "none"}`);
	  }
	  lines.push("", "## Trace Matrix", "");
	  for (const row of plan.traceMatrix || []) {
	    lines.push(`- ${row.taskId}: N ${row.nodeIds.length ? row.nodeIds.join(", ") : "none"}; R ${row.requirements.length ? row.requirements.join(", ") : "none"}; AC ${row.acceptanceCriteria.length ? row.acceptanceCriteria.join(", ") : "none"}; required V ${row.requiredVerification.length ? row.requiredVerification.join(", ") : "none"}; optional V ${row.optionalVerification.length ? row.optionalVerification.join(", ") : "none"}`);
	  }
	  lines.push("", "## Gaps", "");
  if (!plan.gaps || plan.gaps.length === 0) {
    lines.push("- None");
  } else {
    for (const gap of plan.gaps) lines.push(`- ${gap.severity}: ${gap.code} ${gap.item} - ${gap.message}`);
  }
  return lines.join("\n");
}

function renderTaskGraph(state, graph = state.taskGraph || buildTaskGraph(state)) {
  const lines = [
    `# Task Graph: ${state.topicSlug}`,
    "",
    `- PRD: ${state.prdPath}`,
    `- Status: ${graph.status}`,
    `- Generated: ${graph.generatedAt}`,
    `- Nodes: ${graph.summary.nodeCount}`,
    `- Edges: ${graph.summary.edgeCount}`,
    `- Open nodes: ${graph.summary.openNodeCount}`,
    `- Verification blocking gaps: ${graph.summary.blockingGapCount}`,
    "",
    "## Nodes",
    "",
  ];
  for (const node of graph.nodes || []) {
    lines.push(`- ${node.closed ? "[x]" : "[ ]"} ${node.id} (${node.kind}) - ${node.status}: ${node.title}`);
    if (node.requirements && node.requirements.length) lines.push(`  - Requirements: ${node.requirements.join(", ")}`);
    if (node.acceptanceCriteria && node.acceptanceCriteria.length) lines.push(`  - Acceptance Criteria: ${node.acceptanceCriteria.join(", ")}`);
    if (node.sourceTask) lines.push(`  - Source Task: ${node.sourceTask}`);
    if (node.dependsOn && node.dependsOn.length) lines.push(`  - Depends On: ${node.dependsOn.join(", ")}`);
    if (node.writeScope && node.writeScope.length) lines.push(`  - Write Scope: ${node.writeScope.join(", ")}`);
    if (node.risk) lines.push(`  - Risk: ${node.risk}`);
    if (typeof node.parallelSafe === "boolean") lines.push(`  - Parallel Safe: ${node.parallelSafe ? "yes" : "no"}`);
    if (node.owner) lines.push(`  - Owner: ${node.owner}`);
    if (node.covers) lines.push(`  - Covers: ${formatCoverage(node.covers)}`);
	    if (node.tool) lines.push(`  - Tool: ${node.tool}`);
	    if (typeof node.requiredForDone === "boolean") lines.push(`  - Required For Done: ${node.requiredForDone ? "yes" : "no"}`);
	    lines.push(`  - Evidence: ${node.evidenceCount}`);
    lines.push(`  - Artifacts: ${node.artifactCount}`);
  }
  lines.push("", "## Edges", "");
  if (!graph.edges || graph.edges.length === 0) {
    lines.push("- None");
  } else {
    for (const edge of graph.edges) {
      lines.push(`- ${edge.from} -> ${edge.to} (${edge.type}): ${edge.reason}`);
    }
  }
  return lines.join("\n");
}

function renderChecklist(state) {
  const lines = [`# PRD Implementation Checklist: ${state.topicSlug}`, "", `Source PRD: ${state.prdPath}`, ""];
  lines.push("## Execution Nodes", "");
  if (state.executionPlan && state.executionPlan.nodes && state.executionPlan.nodes.length) {
    for (const node of state.executionPlan.nodes) {
	      lines.push(`- ${checkbox(node.status === "complete")} ${node.id}. ${node.title}`);
      lines.push(`  - Status: ${node.status}`);
      lines.push(`  - Source Task: ${node.sourceTask}`);
      if (node.dependsOn && node.dependsOn.length) lines.push(`  - Depends On: ${node.dependsOn.join(", ")}`);
      if (node.writeScope && node.writeScope.length) lines.push(`  - Write Scope: ${node.writeScope.join(", ")}`);
      lines.push(`  - Parallel Safe: ${node.parallelSafe ? "yes" : "no"}`);
      lines.push(`  - Risk: ${node.risk}`);
      lines.push(`  - Covers: ${formatCoverage(node.covers)}`);
      if (node.evidence && node.evidence.length) lines.push("  - Evidence:", evidenceText(node));
      if (node.artifacts && node.artifacts.length) lines.push("  - Artifacts:", artifactText(node));
    }
  } else {
    lines.push("- [ ] EP0. Run `plan-execution`");
  }
  lines.push("");
  lines.push("## Tasks", "");
	  for (const task of state.tasks) {
	    lines.push(`- ${checkbox(task.status === "complete")} ${task.id}. ${task.title}`);
    lines.push(`  - Status: ${task.status}`);
    if (task.requirements.length) lines.push(`  - Requirements: ${task.requirements.join(", ")}`);
    if (task.acceptanceCriteria.length) lines.push(`  - Acceptance Criteria: ${task.acceptanceCriteria.join(", ")}`);
    if (task.evidence.length) lines.push("  - Evidence:", evidenceText(task));
    if (task.artifacts && task.artifacts.length) lines.push("  - Artifacts:", artifactText(task));
  }
  lines.push("", "## Acceptance Criteria", "");
	  for (const ac of state.acceptanceCriteria) {
	    lines.push(`- ${checkbox(ac.status === "met")} ${ac.id}. ${ac.title}`);
    lines.push(`  - Status: ${ac.status}`);
    if (ac.requirements.length) lines.push(`  - Requirements: ${ac.requirements.join(", ")}`);
    if (ac.evidence.length) lines.push("  - Evidence:", evidenceText(ac));
    if (ac.artifacts && ac.artifacts.length) lines.push("  - Artifacts:", artifactText(ac));
  }
  lines.push("", "## Verification Evidence", "");
	  for (const verification of state.verification) {
	    lines.push(`- ${checkbox(verificationIsClosedForAccounting(verification))} ${verification.id}. ${verification.level}: ${verification.title}`);
	    lines.push(`  - Status: ${verification.status}`);
	    lines.push(`  - Required For Done: ${isVerificationRequiredForDone(verification) ? "yes" : "no"}`);
    if (verification.evidence.length) lines.push("  - Evidence:", evidenceText(verification));
    if (verification.artifacts && verification.artifacts.length) lines.push("  - Artifacts:", artifactText(verification));
  }
  lines.push("", "## Requirements Fidelity Review", "");
  lines.push(`- ${checkbox(Boolean(state.requirementsFidelityReview && state.requirementsFidelityReview.status === "pass"))} REQ_FIDELITY_REVIEW. Requirements fidelity review`);
  lines.push(`  - Status: ${state.requirementsFidelityReview ? state.requirementsFidelityReview.status : "pending"}`);
  if (state.requirementsFidelityReview) {
    lines.push(`  - Report: ${state.requirementsFidelityReview.reportPath}`);
    lines.push(`  - Summary: ${state.requirementsFidelityReview.summary}`);
  }
  lines.push("", "## Final Adversarial Review", "");
  const finalReviewRequired = finalReviewRequiredForState(state);
  lines.push(`- ${checkbox(!finalReviewRequired || Boolean(state.finalReview && state.finalReview.status === "pass"))} REVIEW. Final adversarial review${finalReviewRequired ? "" : " (skipped for trivial profile)"}`);
  lines.push(`  - Status: ${state.finalReview ? state.finalReview.status : finalReviewRequired ? "pending" : "skipped"}`);
  if (state.finalReview) {
    lines.push(`  - Report: ${state.finalReview.reportPath}`);
    lines.push(`  - Summary: ${state.finalReview.summary}`);
  }
  return lines.join("\n");
}

function renderVerificationPlan(state) {
  const plan = state.verificationPlan;
  if (!plan) return "# Verification Plan\n\nStatus: missing\n";
  const lines = [
    `# Verification Plan: ${state.topicSlug}`,
    "",
    `- Status: ${plan.status}`,
    `- Generated: ${plan.generatedAt}`,
    `- PRD: ${plan.prdPath}`,
    "",
    "## Environment",
    "",
    `- Package manager: ${plan.environment.packageManager || "unknown"}`,
    `- Browser tool: ${plan.environment.browserTool}`,
    `- Server strategy: ${plan.environment.serverStrategy}`,
    `- Service strategy: ${plan.environment.serviceStrategy}`,
    `- DB strategy: ${plan.environment.dbStrategy}`,
    "",
    "## Test Mode Contract",
    "",
  ];
  if (state.testModeContract && state.testModeContract.length) {
    for (const mode of state.testModeContract) {
      lines.push(`- ${mode.mode}: required=${mode.requiredForDone ? "yes" : "no"}; blockable=${mode.canBeBlocked ? "yes" : "no"}; covers=${mode.covers || "unspecified"}; human=${mode.humanDecision || "none"}`);
    }
  } else {
    lines.push("- None parsed");
  }
  lines.push(
    "",
    "## Checks",
    "",
  );
  for (const check of plan.checks || []) {
    lines.push(`### ${check.id}. ${check.verificationId} - ${check.category}`);
    lines.push("");
    lines.push(`- Level: ${check.level}`);
    lines.push(`- Source: ${check.source}`);
    if (check.testMode) lines.push(`- Test mode: ${check.testMode}`);
    lines.push(`- Tool: ${check.tool}`);
    if (check.command) lines.push(`- Command: \`${check.command}\``);
    if (check.target) lines.push(`- Target: ${check.target}`);
	    lines.push(`- Covers: ${formatCoverage(check.covers)}`);
	    lines.push(`- Artifacts: ${check.artifactKinds.join(", ")}`);
	    lines.push(`- Pass criteria: ${check.passCriteria}`);
	    lines.push(`- Required for done: ${check.requiredForDone ? "yes" : "no"}`);
	    lines.push(`- Can be blocked: ${check.canBeBlocked ? "yes" : "no"}`);
	    if (check.contract) {
	      lines.push(`- Contract method: ${check.contract.method || "missing"}`);
	      lines.push(`- Contract artifact: ${check.contract.artifact || "missing"}`);
	      if (check.contract.environment) lines.push(`- Contract environment: ${check.contract.environment}`);
	      if (check.contract.safeProbe) lines.push(`- Safe probe: ${check.contract.safeProbe}`);
	      if (check.contract.liveProof) lines.push(`- Live proof: ${check.contract.liveProof}`);
	      if (check.contract.sideEffect) lines.push(`- Side effect: ${check.contract.sideEffect}`);
	      if (check.contract.sensitiveDataPolicy) lines.push(`- Sensitive data policy: ${check.contract.sensitiveDataPolicy}`);
	    }
    lines.push(`- Status: ${check.status}`);
    if (check.notes.length) {
      lines.push("- Notes:");
      for (const note of check.notes) lines.push(`  - ${note}`);
    }
    lines.push("");
  }
  lines.push("## Acceptance Coverage", "");
  for (const [id, entry] of Object.entries(plan.coverage || {})) {
    lines.push(`- ${id}: ${entry.status} (${entry.coveredBy.length ? entry.coveredBy.join(", ") : "no checks"}) - ${entry.title}`);
  }
  lines.push("", "## Gaps", "");
  if (!plan.gaps || plan.gaps.length === 0) {
    lines.push("- None");
  } else {
    for (const gap of plan.gaps) lines.push(`- ${gap.severity}: ${gap.code} ${gap.item} - ${gap.message}`);
  }
  return lines.join("\n");
}

function formatCoverage(covers) {
  covers = covers || {};
  const parts = [];
  if ((covers.requirements || []).length) parts.push(`R: ${covers.requirements.join(", ")}`);
  if ((covers.acceptanceCriteria || []).length) parts.push(`AC: ${covers.acceptanceCriteria.join(", ")}`);
  if ((covers.tasks || []).length) parts.push(`T: ${covers.tasks.join(", ")}`);
  if ((covers.verification || []).length) parts.push(`V: ${covers.verification.join(", ")}`);
  return parts.length ? parts.join("; ") : "unmapped";
}

function renderVerification(state) {
  const lines = [`# Verification`, "", `PRD: ${state.prdPath}`, ""];
  for (const item of state.verification) {
    lines.push(`## ${item.id}. ${item.level}`);
    lines.push("");
    lines.push(`- Status: ${item.status}`);
    if (item.source) lines.push(`- Source: ${item.source}`);
    lines.push(`- Check: ${item.text}`);
    if (item.evidence.length) {
      lines.push("- Evidence:");
      for (const entry of item.evidence) lines.push(`  - ${entry.ts}: ${entry.text}`);
    }
    if (item.artifacts && item.artifacts.length) {
      lines.push("- Artifacts:");
      for (const artifact of item.artifacts) lines.push(`  - ${artifact.kind}: ${artifact.path} (${String(artifact.sha256 || "").slice(0, 12)})`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function writeImplementationReport(statePath, state) {
  const lines = [`# Implementation Result: ${state.topicSlug}`, "", `Status: ${state.status}`, "", `PRD: ${state.prdPath}`, `Receipt: ${state.runDir}/receipt.json`, ""];
  const executionPlan = executionPlanSummary(state);
  lines.push("## Execution Plan", "");
  lines.push(`- Status: ${executionPlan.status}`);
  lines.push(`- Nodes: ${executionPlan.nodeCount}`);
  lines.push(`- Open nodes: ${executionPlan.openNodeCount}`);
  lines.push(`- Artifact: ${state.runDir}/execution-plan.md`);
  if (state.executionPlan && state.executionPlan.nodes) {
    for (const node of state.executionPlan.nodes) {
      lines.push(`- ${node.id}: ${node.status} - ${node.title} (source: ${node.sourceTask}, risk: ${node.risk}, parallelSafe: ${node.parallelSafe ? "yes" : "no"})`);
    }
  }
  lines.push("");
  const graph = taskGraphSummary(state);
  lines.push("## Task Graph", "");
  lines.push(`- Status: ${graph.status}`);
  lines.push(`- Nodes: ${graph.nodeCount}`);
  lines.push(`- Edges: ${graph.edgeCount}`);
  lines.push(`- Open nodes: ${graph.openNodeCount}`);
  lines.push(`- Artifact: ${state.runDir}/taskgraph.md`);
  lines.push("## Tasks", "");
  for (const task of state.tasks) lines.push(`- ${task.id}: ${task.status} - ${task.title}`);
  lines.push("", "## Acceptance Criteria", "");
  for (const ac of state.acceptanceCriteria) lines.push(`- ${ac.id}: ${ac.status} - ${ac.title}`);
  lines.push("", "## Verification Evidence", "");
  for (const item of state.verification) lines.push(`- ${item.id}: ${item.status} - ${item.level}: ${item.title}`);
  lines.push("", "## Artifact Evidence", "");
  for (const entry of collectArtifacts(state)) {
    lines.push(`- ${entry.ownerKind} ${entry.ownerId}: ${entry.artifact.kind} - ${entry.artifact.path}`);
  }
  lines.push("", "## Requirements Fidelity Review", "");
  if (state.requirementsFidelityReview) {
    lines.push(`- Status: ${state.requirementsFidelityReview.status}`);
    lines.push(`- Report: ${state.requirementsFidelityReview.reportPath}`);
    lines.push(`- Summary: ${state.requirementsFidelityReview.summary}`);
  } else {
    lines.push("- Status: pending");
  }
  lines.push("", "## Final Adversarial Review", "");
  if (state.finalReview) {
    lines.push(`- Status: ${state.finalReview.status}`);
    lines.push(`- Report: ${state.finalReview.reportPath}`);
    lines.push(`- Summary: ${state.finalReview.summary}`);
  } else {
    lines.push("- Status: pending");
  }
  lines.push("", "## Final Receipt", "", "```json", JSON.stringify(state.finalReceipt, null, 2), "```", "");
  writeMarkdown(path.join(path.dirname(statePath), "implementation-result.md"), lines.join("\n"));
}

function renderRequirementsReviewPrompt(context) {
  const { state, statePath, reportPath } = context;
  const intentTrace = state.intentTrace || {};
  const decisionLines = (intentTrace.decisions || [])
    .slice(0, 40)
    .map(item => `  - ${item.source} ${item.id} [${item.stance || "unspecified"}]: ${item.text}`)
    .join("\n") || "  - No structured decision trace items were captured; treat missing traceability as a finding unless the PRD explicitly says none were needed.";
  return `You are the requirements fidelity reviewer for a PRD implementation.

Your job is to verify that the implementation still satisfies the user's original intent, accepted decisions, rejected alternatives, and PRD contract. Be strict. Find semantic drift, missing user-visible behavior, diluted acceptance criteria, hidden scope, and "technically complete but not what the user asked for" failures.

Do not implement fixes. Do not mark anything complete. Review only.

Source of truth:
- PRD: \`${state.prdPath}\`
- State JSON: \`${statePath}\`
- Checklist: \`${state.runDir}/checklist.md\`
- Context notes: \`${state.runDir}/context-notes.md\`
- Execution plan: \`${state.runDir}/execution-plan.json\` and \`${state.runDir}/execution-plan.md\`
- Task graph: \`${state.runDir}/taskgraph.json\` and \`${state.runDir}/taskgraph.md\`
- Verification plan: \`${state.runDir}/verification-plan.json\` and \`${state.runDir}/verification-plan.md\`
- Verification: \`${state.runDir}/verification.md\`
- Ledger: \`${state.runDir}/ledger.jsonl\`
- Artifact manifest: \`${state.runDir}/artifacts/manifest.jsonl\`
- Git diff/worktree: inspect current repository state
- Original intent sources: read the PRD frontmatter and sections for \`source_intake\`, \`source_clarity\`, Pre-Work, Human Decisions, Scope, Non-Goals, Requirements, Acceptance Criteria, Risks, Guardrails, and any referenced \`.hoyeon/intake/**\` or \`.hoyeon/clarify/**\` files that exist.
- Intent trace snapshot: ${intentTrace.decisionCount || 0} decision/proposal item(s) captured at init (${intentTrace.prdDecisionCount || 0} from PRD, ${intentTrace.sourceDecisionCount || 0} from intake/clarity sources).
${decisionLines}

Required checks:
1. Every explicit user decision from intake/clarify/current conversation is represented in PRD Scope, Non-Goals, Requirements, ACs, Verification, or Human Verification.
2. Every accepted initial proposal is either implemented and evidenced or explicitly deferred/non-goal with user approval.
3. Every rejected option, non-goal, and guardrail stayed rejected; implementation did not reintroduce it indirectly.
4. PRD Requirements and ACs did not dilute the user's intended outcome into easier proxy checks.
5. User-visible flows, copy, data behavior, runtime behavior, and external/live proof expectations match the user's goal, not only the executor's tasks.
6. Each AC has evidence that proves the user intent behind the AC, not just a superficial DOM/file/test condition.
7. Every required Verification item has a Verification Intent Checklist entry that maps Pass Intent and covered R#/AC# to concrete registered artifact paths.
8. Any missing source artifact, ambiguous decision, or human taste judgment is called out as blocking unless the PRD explicitly made it non-required.
9. No hidden scope, architecture, storage, API, auth, billing, production-data, or external-service decision was added without approval.
10. The implementation result report does not overclaim Done when user intent is partially met, blocked, or still needs human judgment.

Write the report to:
\`${reportPath}\`

This is an absolute path inside the current run checkout. Write the file at exactly this absolute path; never use a relative path, because the editing tool may resolve it against a different checkout. If the report was accidentally created elsewhere, move the existing file with \`mv\` instead of re-authoring its content.

Use this format:

# Requirements Fidelity Review

Status: PASS | FAIL

## Intent Sources Read

- <source path or PRD section>

## Decision Trace

- <user decision or proposal>: represented by <R/AC/T/V/non-goal/evidence> | gap: <none or issue>

Include at least ${Math.max(1, intentTrace.decisionCount || 0)} concrete Decision Trace bullet(s). Do not collapse accepted, rejected, deferred, or open decisions into a generic statement.

## Findings

- <severity>: <finding with source, PRD, implementation, evidence, or artifact reference>

## Verification Intent Checklist

- <V#>: Pass Intent: <PRD pass intent or derived pass criteria>; Covers: <R#/AC#>; Artifacts checked: <registered artifact paths>; Judgment: PASS|FAIL; Gap: <none or issue>

Include every required Verification item. A passing review must fail if a required V# is missing, has no registered artifact path, or the artifact does not actually prove the covered R#/AC#.

## Coverage Judgment

- Requirements:
- Acceptance Criteria:
- User-visible behavior:
- Non-goals and rejected options:
- Human verification:

## Verdict

PASS only if the user's original intent, accepted decisions, rejected alternatives, PRD scope, ACs, verification evidence, and implementation result all align. FAIL on any material semantic drift, missing decision, diluted AC, hidden scope, or overclaimed result.
`;
}

function renderReviewPrompt(context) {
  const { state, statePath, reportPath } = context;
  const fidelity = state.requirementsFidelityReview || {};
  const profile = reviewProfileName(state);
  const profileGuidance = profile === "high-risk"
    ? "Review profile: high-risk. Run the full adversarial review and reopen any risky semantic, security, data, migration, external-service, or delivery proof."
    : profile === "standard"
      ? "Review profile: standard. Keep this as a thin final gate: audit freshness, state consistency, artifact validity, deviations, and overclaiming; reopen full V-by-V proof only when the fidelity review is weak, generic, inconsistent, or suspicious."
      : "Review profile: trivial. Final adversarial review is optional for receipt; if requested, keep it to a short freshness, artifact, and overclaim check.";
  const fidelityLine = fidelity.reportSha256
    ? `Recorded fidelity review: status ${fidelity.status}, report \`${fidelity.reportPath}\`, sha256 \`${fidelity.reportSha256}\`, recorded at ${fidelity.recordedAt}.`
    : "No requirements fidelity review is recorded yet; a passing final review is impossible until one is recorded.";
  return `You are the adversarial final reviewer for a PRD implementation.

${profileGuidance}

Your job is to audit the recorded requirements fidelity review, then find missing work, weak evidence, fake verification, and PRD drift that survived that review.
Do not implement fixes. Do not mark anything complete. Review only.
Do not repeat the full V-by-V semantic artifact proof from scratch when the requirements fidelity review already contains it and you agree with it.
Instead, verify that the fidelity review is fresh, specific, and trustworthy, then focus on disagreement, omission, weak reasoning, risky artifacts, and final-report overclaiming.

You are running AFTER the requirements fidelity review was recorded. ${fidelityLine}
Read \`${statePath}\` yourself, confirm the recorded fidelity review status and report sha256, and cite that sha256 (at least its first 12 characters) in the 'Fidelity Review Checked' section of your report. Do not write the report from memory of earlier turns.

Source of truth:
- PRD: \`${state.prdPath}\`
- State JSON: \`${statePath}\`
- Checklist: \`${state.runDir}/checklist.md\`
- Execution plan: \`${state.runDir}/execution-plan.json\` and \`${state.runDir}/execution-plan.md\`
- Task graph: \`${state.runDir}/taskgraph.json\` and \`${state.runDir}/taskgraph.md\`
- Verification plan: \`${state.runDir}/verification-plan.json\` and \`${state.runDir}/verification-plan.md\`
- Verification: \`${state.runDir}/verification.md\`
- Ledger: \`${state.runDir}/ledger.jsonl\`
- Artifact manifest: \`${state.runDir}/artifacts/manifest.jsonl\`
- Requirements fidelity review: \`${state.runDir}/review/requirements-fidelity-review.md\`
- Git diff/worktree: inspect current repository state

Required checks:
0. Requirements fidelity review exists, passed, is fresh, and its findings are either resolved or explicitly reflected in the final verdict.
0a. Requirements fidelity review is the primary semantic artifact proof. Audit it as the proof owner, and only reopen full V-by-V artifact reasoning where it is missing, generic, inconsistent with state, or suspicious.
1. The PRD stayed clean: product requirements, ACs, high-level tasks, and verification contract only; no executor-only fields such as writeScope, owner, parallelSafe, or low-level dependsOn.
2. Every PRD Task maps to one or more execution-plan nodes.
3. Every execution node maps back to a PRD task or approved verification/release hygiene and has evidence.
4. Every PRD Task is complete and its roll-up is supported by execution node, AC, and verification evidence.
5. Every Acceptance Criterion is met in state and is covered by evidence or by a credible fidelity-review judgment. Open the underlying artifacts for risky, user-critical, or suspicious items instead of duplicating the entire fidelity checklist.
6. The Task Graph accounts for execution nodes, Task rollups, ACs, Verification items, final review, and receipt gate.
7. The Verification Plan is ready, maps every AC to checks, and has no blocking gaps.
8. Every required agent verification item passed with an artifact file, not just prose, and every required V# appears in the fidelity review's Verification Intent Checklist. Optional skipped/blocked verification must be explicitly marked non-required by the PRD contract and have evidence.
9. The executed verification commands match the PRD Verification Contract or derived verification plan. Any command, order, or scope deviation must be recorded in \`state.deviations\` and justified by equivalent coverage.
10. Screenshots, logs, browser dumps, API logs, or DB/query logs referenced in state actually exist and are non-empty. Screenshots must be real PNG/JPEG files.
11. No artifact under \`${state.runDir}/artifacts\` is unregistered in state or \`artifacts/manifest.jsonl\`.
12. The final review is not stale: no evidence, artifact, plan, or deviation was recorded after review.
13. Ready parallel groups, if used, had disjoint write scopes and no high-risk DB/auth/security/config/migration/production-data work.
14. The implementation follows the PRD's Major Technical Structure Changes or documented structure lock and does not add unmapped scope.
15. The final report can be trusted by a human who only reads the PRD, state, ledger, and artifacts.

Write the report to:
\`${reportPath}\`

This is an absolute path inside the current run checkout. Write the file at exactly this absolute path; never use a relative path, because the editing tool may resolve it against a different checkout. If the report was accidentally created elsewhere, move the existing file with \`mv\` instead of re-authoring its content.

Use this format:

# Final Adversarial Review

Status: PASS | FAIL

## Fidelity Review Checked

- Report: <recorded requirements fidelity review report path>
- Sha256: <recorded reportSha256 read from state.json>
- Status: <recorded status>
- Recorded at: <recordedAt>
- Findings resolved or reflected: <how>

## Findings

- <severity>: <finding with file/artifact/state reference>

## Checklist Coverage

- Tasks:
- Acceptance Criteria:
- Verification: <reference every required V#; say whether it is accepted from the fidelity checklist or reopened here due to a specific concern>
- Execution Plan:
- Task Graph:

## Artifact Audit

- Harness-visible validity: <missing, empty, invalid, unregistered, hash drift, stale review, or wrong evidence kind findings, or none>
- Spot-checks performed: <risky or user-critical artifacts opened, or why the fidelity checklist was sufficient>
- Missing or weak artifacts: <only list semantic proof gaps or artifact concerns not already handled by the fidelity review>

## Deviation Audit

- Recorded deviations:
- Accepted deviations:
- Rejected deviations:

## Verdict

PASS only if all tracked work is complete, the requirements fidelity review is trustworthy, every required verification item has valid artifact-backed evidence, optional verification exceptions are explicitly non-required and justified, no stale review/artifact drift remains, and no PRD drift remains.`;
}

function cmdHook(kind) {
  if (kind !== "stop" && kind !== "subagent-stop" && kind !== "pretool-use") return;
  const started = Date.now();
  readStdinJson(DEFAULT_HOOK_TIMEOUT_MS, payload => {
    try {
      const output = kind === "pretool-use"
        ? runPreToolUseHook(payload)
        : runStopHook(payload, started);
      if (output) process.stdout.write(output);
    } catch {
      // Hooks must fail open. The skill and finalizer remain the source of enforcement.
    }
  });
}

function readStdinJson(timeoutMs, callback) {
  let raw = "";
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    if (!raw.trim()) return callback(null);
    try {
      callback(JSON.parse(raw));
    } catch {
      callback(null);
    }
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { raw += chunk; });
  process.stdin.on("end", finish);
  process.stdin.on("error", finish);
  setTimeout(finish, timeoutMs).unref();
}

function deliveryShipPending(statePath, state) {
  if (state.status !== "complete") return false;
  if (!state.delivery || state.delivery.mode !== "pr") return false;
  if (!state.finalReceipt || state.finalReceipt.status !== "complete") return false;
  const logPath = path.join(path.dirname(statePath), "delivery", "ship-log.jsonl");
  if (!fs.existsSync(logPath)) return true;
  const lines = fs.readFileSync(logPath, "utf8").trim().split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const entry = JSON.parse(lines[index]);
      if (entry.event === "ship" && entry.pr) {
        return !["pass", "no-checks"].includes(String(entry.ciVerdict || ""));
      }
    } catch {
      // ignore malformed lines
    }
  }
  return true;
}

function renderShipHandoffDirective(statePath, state, hookCwd) {
  return JSON.stringify({
    decision: "block",
    reason: `<prd-ship-handoff-guard>
Implementation receipt is complete, but delivery mode is 'pr' and no pull request has been shipped.

PRD: \`${state.prdPath}\`
State: \`${toProjectRelative(statePath, hookCwd)}\`

The thread is not done until \`$prd-ship\` opens the PR and required CI passes or the delivery is explicitly reported as blocked. Run:

  node ~/.codex/skills/prd-ship/scripts/prd_ship.js body --state ${toProjectRelative(statePath, hookCwd)}
  (fill the AGENT-FILL prose sections from implementation-result.md)
  node ~/.codex/skills/prd-ship/scripts/prd_ship.js ship --state ${toProjectRelative(statePath, hookCwd)} --title "<PR title>"

If delivery is genuinely blocked, report the blocker explicitly to the user instead of stopping silently.
</prd-ship-handoff-guard>`,
  });
}

function runStopHook(payload, started) {
  if (!payload || typeof payload !== "object") return "";
	  const event = payload.hook_event_name;
	  if (event !== "Stop" && event !== "SubagentStop") return "";
  if (event === "SubagentStop") return "";
	  if (payload.stop_hook_active === true) return "";
  const hookCwd = typeof payload.cwd === "string" ? payload.cwd : cwd();
  const sessionId = sessionIdFromHookPayload(payload);
  if (!sessionId) return "";
  const active = readActive(hookCwd, { sessionId, allowUnboundLegacy: true });
  if (!active) return "";
  const statePath = resolveProjectPath(active.active.statePath, hookCwd);
  if (!fs.existsSync(statePath)) return "";
  const state = readJson(statePath);
  if (state.schema !== SCHEMA) return "";
  if (state.activeSessionId && state.activeSessionId !== sessionId) return "";
  if (state.status !== "active") {
    if (deliveryShipPending(statePath, state)) {
      return renderShipHandoffDirective(statePath, state, hookCwd);
    }
    return "";
  }
  if (!state.activeSessionId) {
    state.activeSessionId = sessionId;
    state.updatedAt = nowIso();
    writeJson(statePath, state);
    syncActive(statePath, state);
  }
  const counts = countState(state);
  const next = nextItem(state);
  if (!next && state.finalReceipt) return "";
  // Re-inject the full step-by-step procedure only when the phase changes;
  // otherwise emit the compact State block so the loop does not burn ~1.7k
  // tokens repeating an unchanged procedure every turn.
  const phase = directivePhase(next);
  const verbose = state.lastStopPhase !== phase;
  if (verbose) {
    state.lastStopPhase = phase;
    state.updatedAt = nowIso();
    try {
      writeJson(statePath, state);
    } catch {
      // Non-fatal: persistence of the phase marker is best-effort. Worst case is
      // one extra verbose directive next turn.
    }
  }
  const directive = renderContinuationDirective({
    event,
    hookCwd,
    stateAbsPath: statePath,
    statePath: toProjectRelative(statePath, hookCwd),
    state,
    counts,
    next,
    verbose,
    recentLedger: recentLedgerEvents(path.dirname(statePath)),
    elapsedMs: Date.now() - started,
  });
  return JSON.stringify({ decision: "block", reason: directive });
}

function directivePhase(next) {
  return next ? next.kind : "finalize";
}

function recentLedgerEvents(runDirAbs, limit = 3) {
  try {
    const file = path.join(runDirAbs, "ledger.jsonl");
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean);
    return lines.slice(-limit).map(line => {
      try {
        const entry = JSON.parse(line);
        const idPart = entry.id ? ` ${entry.id}` : Array.isArray(entry.ids) ? ` ${entry.ids.join(",")}` : "";
        return `${entry.event || "event"}${idPart}`;
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function runPreToolUseHook(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (payload.hook_event_name !== "PreToolUse") return "";
  if (!isUpdateGoalCompleteAttempt(payload)) return "";
  const hookCwd = typeof payload.cwd === "string" ? payload.cwd : cwd();
  const sessionId = sessionIdFromHookPayload(payload);
  if (!sessionId) return "";
  const active = readActive(hookCwd, { sessionId, allowUnboundLegacy: true });
  if (!active) return "";
  const statePath = resolveProjectPath(active.active.statePath, hookCwd);
  if (!fs.existsSync(statePath)) return "";
  const state = readJson(statePath);
  if (state.schema !== SCHEMA) return "";
  if (state.activeSessionId && state.activeSessionId !== sessionId) return "";
  if (state.status !== "active") {
    if (deliveryShipPending(statePath, state)) {
      return renderShipHandoffDirective(statePath, state, hookCwd);
    }
    return "";
  }
  if (!state.activeSessionId) {
    state.activeSessionId = sessionId;
    state.updatedAt = nowIso();
    writeJson(statePath, state);
    syncActive(statePath, state);
  }
  const counts = countState(state);
  const violations = completionViolations(statePath, state, { includeFinalReview: true });
  if (state.finalReceipt && counts.totalOpen === 0 && violations.length === 0) return "";
  const finalReviewRequired = finalReviewRequiredForState(state);
  const finalReviewRequirement = finalReviewRequired
    ? "record a passing final review"
    : "confirm the trivial review profile does not require final adversarial review";
  return JSON.stringify({
    decision: "block",
    reason: `<prd-implement-goal-guard>
Blocked premature update_goal complete.

PRD: \`${state.prdPath}\`
State: \`${toProjectRelative(statePath, hookCwd)}\`
	Open tracked items: ${counts.totalOpen}
	Required verification not passed: ${counts.requiredVerificationNotPassed}
	Verification plan: ${verificationPlanSummary(state).status} (${verificationPlanSummary(state).blockingGapCount} blocking gaps)
	Execution plan: ${executionPlanSummary(state).status} (${executionPlanSummary(state).openNodeCount} open nodes, ${executionPlanSummary(state).blockingGapCount} blocking gaps)
	Requirements fidelity review: ${state.requirementsFidelityReview ? state.requirementsFidelityReview.status : "pending"}
	Final review: ${state.finalReview ? state.finalReview.status : finalReviewRequired ? "pending" : "skipped by trivial profile"}
	Receipt: ${state.finalReceipt ? "present" : "missing"}

	Run \`node ~/.codex/skills/prd-implement/scripts/prd_state_harness.js status\`, close all execution nodes and PRD items with artifact-backed evidence, record a passing requirements fidelity review, ${finalReviewRequirement}, then finalize before marking the Codex goal complete.
	</prd-implement-goal-guard>`,
  });
}

function isUpdateGoalCompleteAttempt(payload) {
  const toolName = String(payload.tool_name || payload.toolName || payload.name || payload.tool || "");
  if (!/update_goal/i.test(toolName)) return false;
  const input = payload.tool_input || payload.toolInput || payload.input || payload.arguments || {};
  if (input && typeof input === "object" && input.status === "complete") return true;
  return /"status"\s*:\s*"complete"/.test(JSON.stringify(input));
}

function renderContinuationDirective(context) {
  const { state, counts, next } = context;
  const requirementsReviewStatus = state.requirementsFidelityReview ? state.requirementsFidelityReview.status : "pending";
  const finalReviewRequired = finalReviewRequiredForState(state);
  const finalReviewStatus = state.finalReview ? state.finalReview.status : finalReviewRequired ? "pending" : "skipped by trivial profile";
  const verificationPlan = verificationPlanSummary(state);
  const executionPlan = executionPlanSummary(state);
  const ready = readyExecutionPlan(state);
  const taskGraph = taskGraphSummary(state);
  const finalGateViolations = next ? [] : completionViolations(context.stateAbsPath, state, { includeFinalReview: true });
  const nextLine = next
    ? `${next.kind.toUpperCase()} ${next.item.id}: ${next.item.title}`
    : requirementsReviewStatus !== "pass"
      ? `REQUIREMENTS FIDELITY REVIEW: tracked items are closed; run strict intent review before ${finalReviewRequired ? "final adversarial review" : "finalize"}`
    : finalReviewRequired && finalReviewStatus !== "pass"
      ? "FINAL REVIEW: tracked items are closed; run adversarial review before finalizing"
      : finalReviewRequired
        ? "FINALIZE: final review passed; write receipt"
        : "FINALIZE: trivial profile gates passed; write receipt";
  const finalGateBlock = finalGateViolations.length
    ? `\n# Final gate gaps\n\n${finalGateViolations.map(item => `- ${item}`).join("\n")}\n`
    : "";
  const recentActivity = Array.isArray(context.recentLedger) && context.recentLedger.length
    ? context.recentLedger.join(" -> ")
    : "none";
  const proceduresBlock = context.verbose === false
    ? `# This turn

The phase has not changed since the last directive, so the full procedure is not repeated. Follow the step-by-step procedure already given for this phase (also in SKILL.md sections 6-12).

Drive the Next required item above to done, then record it with the matching harness command: \`mark-node\` for execution nodes, \`mark --kind ac\` for acceptance criteria, \`verify-run\` for command verification, \`record-artifact\` for browser/API/DB evidence, \`requirements-review-record\` / \`review-record\` for reviews, then \`finalize\`. Run \`status\` if you need the full graph again.`
    : `# Required procedure this turn

1. Ensure the Codex Goal exists when goal tools are available: call \`get_goal\`; if no active goal exists, call \`create_goal\` for this PRD implementation. \`update_plan\` does not replace Goal state.
2. Treat the State block above and \`${context.statePath}\` as the source of truth. Read \`${state.runDir}/execution-plan.md\` and \`${state.runDir}/taskgraph.md\` only when planning changed, and consult \`${state.runDir}/ledger.jsonl\` only when the recent-activity summary above is not enough. Do not re-read unchanged plan views every turn.
3. If the next item is \`VERIFICATION_PLAN VP0\`, read \`${state.runDir}/verification-plan.md\`, fix the PRD verification contract or planner inputs, and rerun \`node ~/.codex/skills/prd-implement/scripts/prd_state_harness.js plan-verification\` before implementation.
4. If the next item is \`EXECUTION_PLAN EP0\`, run \`node ~/.codex/skills/prd-implement/scripts/prd_state_harness.js plan-execution\`, inspect \`ready\`, and use \`${state.runDir}/execution-plan.md\` as the work map.
5. After \`plan-execution\` and before material code edits, the main agent performs the coverage check. Inspect PRD/state/plan/taskgraph paths for intent, ambiguity, coverage, TaskGraph, and structure-lock drift; record material findings in \`${state.runDir}/context-notes.md\`.
6. Work sequentially on the next ready execution node. Parallel execution is opt-in via config (\`execution.parallel\`); only when the State block shows a Ready parallel groups line may the coordinator assign a safe disjoint group to subagents.
7. Use the PRD's Major Technical Structure Changes or documented structure lock. Stop for approval before material deviations.
8. Register artifacts immediately after producing them. Do not leave files under \`${state.runDir}/artifacts\` unregistered; record valid artifacts with \`record-artifact\` before using them as evidence.
9. After evidence exists, update state with:
   - \`node ~/.codex/skills/prd-implement/scripts/prd_state_harness.js mark-node --id <Nn> --status complete --evidence "<command/test/file/screenshot evidence>"\`
   - \`node ~/.codex/skills/prd-implement/scripts/prd_state_harness.js mark --kind ac --id <ACn> --status met --evidence "<evidence>"\`
   - \`node ~/.codex/skills/prd-implement/scripts/prd_state_harness.js verify-run --id <Vn> -- <command>\`
   - \`node ~/.codex/skills/prd-implement/scripts/prd_state_harness.js record-artifact --id <Vn> --kind screenshot|log|browser|api|db|file --path <artifact> --description "<what it proves>"\`
10. Let task status roll up from execution nodes, ACs, and verification. Use \`mark --kind task\` only for an explicit blocked/deferred/manual correction with evidence.
11. Do not call \`update_goal({status:"complete"})\` until \`${state.runDir}/receipt.json\` exists, requirements fidelity review is pass, ${finalReviewRequired ? "final review is pass, " : ""}verification plan is ready, execution plan nodes are complete, every required verification item is pass, artifact validation has no violations, runtime processes started for verification are stopped or explicitly reported, and \`node ~/.codex/skills/prd-implement/scripts/prd_state_harness.js status\` reports no open items or final gate violations.
    If delivery mode is \`pr\`, do not call \`update_goal({status:"complete"})\` after receipt alone. Run \`$prd-ship\` and wait for PR creation plus required CI pass or an explicit delivery blocker.
12. When no open items remain, run the final AC + Verification sweep, then run the strict requirements fidelity review:
   - \`node ~/.codex/skills/prd-implement/scripts/prd_state_harness.js requirements-review-prompt\`
   - The main agent writes this review by default. Do not spawn a requirements fidelity sidecar unless the user explicitly asks for one. It must compare original user intent, accepted decisions, rejected alternatives, PRD scope, ACs, verification evidence, and implementation result.
   - Write \`${state.runDir}/review/requirements-fidelity-review.md\`.
   - \`node ~/.codex/skills/prd-implement/scripts/prd_state_harness.js requirements-review-record --status pass|fail --report ${state.runDir}/review/requirements-fidelity-review.md --summary "<requirements fidelity verdict>"\`
13. Before finalization${finalReviewRequired ? " or final adversarial review" : ""}, stop runtime servers, browser sessions, tunnels, or background processes started only for verification, unless explicitly left running and reported.
${finalReviewRequired ? `14. Only after \`requirements-review-record --status pass\`, run:
   - \`node ~/.codex/skills/prd-implement/scripts/prd_state_harness.js review-prompt\`
   - Spawn a fresh independent adversarial reviewer sidecar with that prompt when multi-agent tools are available. This is the only required reviewer sidecar in the default workflow. Omit \`agent_type\`; do not use \`hoyeon-*\` roles unless the user explicitly asked for one.
   - Write \`${state.runDir}/review/final-review.md\`.
   - \`node ~/.codex/skills/prd-implement/scripts/prd_state_harness.js review-record --status pass|fail --report ${state.runDir}/review/final-review.md --summary "<review verdict>"\`
15. Only after \`review-record --status pass\`, finalize:
` : `14. This run uses the trivial review profile; final adversarial review is optional. After \`requirements-review-record --status pass\`, finalize:
`}
   - \`node ~/.codex/skills/prd-implement/scripts/prd_state_harness.js finalize --status complete --summary "<short evidence-backed summary>"\`
   - If delivery mode is \`pr\`, immediately hand off to \`$prd-ship\` with \`${context.statePath}\`.
${finalReviewRequired ? "16" : "15"}. If completion is impossible and the next user-facing report will be blocked or partial, run the same requirements fidelity review first and record it before handoff:
   - \`node ~/.codex/skills/prd-implement/scripts/prd_state_harness.js requirements-review-prompt\`
   - Write \`${state.runDir}/review/requirements-fidelity-review.md\` with \`Status: FAIL\` when intent/PRD/evidence do not fully align.
   - \`node ~/.codex/skills/prd-implement/scripts/prd_state_harness.js requirements-review-record --status fail --report ${state.runDir}/review/requirements-fidelity-review.md --summary "<requirements fidelity blocker verdict>"\`
   - Then use \`finalize --status blocked\` or \`finalize --status partial\`; do not report \`Done\`.`;
  return `<prd-implement-continuation>

You are continuing an active PRD implementation. Do not ask whether to continue. The PRD and state files are the source of truth.

# State

- PRD: \`${state.prdPath}\`
- State JSON: \`${context.statePath}\`
- Run dir: \`${state.runDir}\`
- Delivery mode: ${(state.delivery && state.delivery.mode) || "local"}
- Verification plan: ${verificationPlan.status} (${verificationPlan.checkCount} checks, ${verificationPlan.blockingGapCount} blocking gaps)
- Execution plan: ${executionPlan.status} (${executionPlan.nodeCount} nodes, ${executionPlan.openNodeCount} open, ${executionPlan.blockingGapCount} blocking gaps)
- Task graph: ${taskGraph.status} (${taskGraph.nodeCount} nodes, ${taskGraph.edgeCount} edges, ${taskGraph.openNodeCount} open)
- Ready execution nodes: ${ready.readySequential.length ? ready.readySequential.join(", ") : "none"}${ready.parallelEnabled ? `\n- Ready parallel groups: ${ready.readyParallelGroups.length ? ready.readyParallelGroups.map(group => `[${group.join(", ")}]`).join(", ") : "none"}` : ""}
- Blocked execution nodes: ${ready.blocked.length ? ready.blocked.map(item => `${item.id} waits for ${item.waitingFor.join(", ")}`).join("; ") : "none"}
- Open execution nodes: ${counts.executionOpen}
	- Open tasks: ${counts.tasksOpen}
	- Open acceptance criteria: ${counts.acOpen}
	- Open verification items: ${counts.verificationOpen}
	- Required verification not passed: ${counts.requiredVerificationNotPassed}
	- Blocked items: execution ${counts.blocked.execution}, tasks ${counts.blocked.tasks}, AC ${counts.blocked.acceptanceCriteria}, verification ${counts.blocked.verification}
	- Artifact count: ${collectArtifacts(state).length}
- Requirements fidelity review: ${requirementsReviewStatus}
- Final review: ${finalReviewStatus}
- Recent activity: ${recentActivity}
- Next required item: ${nextLine}
${finalGateBlock}

${proceduresBlock}

# Completion rule

The turn may end only after one tracked item is marked with evidence, artifact-backed verification is recorded, a concrete blocker is marked, or the final receipt is written.
If delivery mode is \`pr\`, a final completion answer also requires the \`prd-ship\` PR URL and CI verdict.
Do not provide a final completion answer before the receipt exists.

</prd-implement-continuation>
`;
}

main();
