#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");

// Namespace layout mirror of fulfill's util.js constants. Kept local so the
// deliver skill stays installable without a fulfill checkout, but the values
// must match; change both together. The legacy `.hoyeon` tree is a read-only
// fallback for runs started before the agents/ namespace migration.
const NAMESPACE_ROOT = "agents";
const IMPLEMENT_ROOT_REL = path.join(NAMESPACE_ROOT, "implement");
const SESSIONS_DIR_REL = path.join(IMPLEMENT_ROOT_REL, ".prd-implement-sessions");
const ACTIVE_PATH = path.join(IMPLEMENT_ROOT_REL, ".prd-implement-active.json");
const LEGACY_NAMESPACE_ROOT = ".hoyeon";
const LEGACY_IMPLEMENT_ROOT_REL = path.join(LEGACY_NAMESPACE_ROOT, "implement");
const LEGACY_SESSIONS_DIR_REL = path.join(LEGACY_IMPLEMENT_ROOT_REL, ".prd-implement-sessions");
const LEGACY_ACTIVE_PATH = path.join(LEGACY_IMPLEMENT_ROOT_REL, ".prd-implement-active.json");

// Resolve the sibling fulfill harness relative to this script so the same
// file works from the repo, ~/.codex/skills, and ~/.claude/skills. The
// pre-rename legacy directory name (prd-implement) is kept as a fallback for
// stale installs.
function defaultHarnessPath() {
  const selfPath = path.resolve(process.argv[1] || __filename);
  const roots = [path.dirname(path.dirname(path.dirname(selfPath)))];
  try {
    roots.push(path.dirname(path.dirname(path.dirname(fs.realpathSync(selfPath)))));
  } catch {
    // Keep the argv-based root only.
  }
  for (const root of roots) {
    for (const dir of ["fulfill", "prd-implement"]) {
      const candidate = path.join(root, dir, "scripts", "prd_state_harness.js");
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return path.join(roots[0], "fulfill", "scripts", "prd_state_harness.js");
}
const AGENT_FILL_PATTERN = /<!--\s*AGENT-FILL/i;
const ATTRIBUTION_PATTERNS = [
  /co-authored-by:.*\b(claude|codex|copilot|cursor|chatgpt|gpt|openai|anthropic|gemini)\b/i,
  /generated (?:by|with)\s+(?:an?\s+)?(?:ai\b|claude|codex|copilot|cursor|chatgpt|gpt|openai|anthropic|gemini)/i,
  /\u{1F916}/u,
];
const DEFAULT_CI_TIMEOUT_SECONDS = 240;
const DEFAULT_CI_INTERVAL_SECONDS = 15;

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseArgs(rest);
  try {
    if (command === "preflight") return cmdPreflight(options);
    if (command === "body") return cmdBody(options);
    if (command === "ship") return cmdShip(options);
    if (command === "watch-ci") return cmdWatchCi(options);
    if (command === "status") return cmdStatus(options);
    usage(1);
  } catch (error) {
    process.stderr.write(`${error && error.message ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

function usage(exitCode) {
  process.stderr.write(`Usage:
  node prd_ship.js preflight [--state <state.json>]
  node prd_ship.js body [--state <state.json>] [--output <file>] [--force]
  node prd_ship.js ship [--state <state.json>] [--title <title>] [--body <file>] [--branch <branch>] [--base <base>] [--draft] [--no-watch] [--no-gpg-sign] [--include <path>] [--override-mode --reason <why>] [--allow-stale --reason <why>] [--allow-stale-base --reason <why>] [--skip-rules --reason <why>]
  node prd_ship.js watch-ci [--state <state.json>] [--pr <number-or-url>] [--timeout <seconds>] [--interval <seconds>]
  node prd_ship.js status [--state <state.json>] [--pr <number-or-url>]

Exit codes: 0 ok, 1 error/refused, 2 CI failed, 3 CI still pending at timeout.
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
      appendOption(out, key, true);
    } else {
      appendOption(out, key, next);
      index += 1;
    }
  }
  return out;
}

function appendOption(out, key, value) {
  if (Object.prototype.hasOwnProperty.call(out, key)) {
    if (Array.isArray(out[key])) out[key].push(value);
    else out[key] = [out[key], value];
    return;
  }
  out[key] = value;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`);
}

function appendJsonl(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function resolveInput(input, baseDir = process.cwd()) {
  if (!input || typeof input !== "string") throw new Error("path argument is required");
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return path.resolve(baseDir, input);
}

function canonical(input) {
  const resolved = path.resolve(input);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function toRepoRelative(absPath, repoRoot) {
  const rel = path.relative(canonical(repoRoot), canonical(absPath));
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : absPath;
}

function run(command, args, options = {}) {
  const result = childProcess.spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    shell: false,
    encoding: "utf8",
    maxBuffer: options.maxBuffer || 20 * 1024 * 1024,
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error([
      `Command failed: ${[command, ...args].join(" ")}`,
      `cwd: ${options.cwd || process.cwd()}`,
      `exitCode: ${typeof result.status === "number" ? result.status : "unknown"}`,
      result.stdout ? `stdout:\n${result.stdout}` : "",
      result.stderr ? `stderr:\n${result.stderr}` : "",
      result.error && result.error.message ? `error: ${result.error.message}` : "",
    ].filter(Boolean).join("\n"));
  }
  return result;
}

function findGitRoot(startDir) {
  const result = run("git", ["rev-parse", "--show-toplevel"], { cwd: startDir, allowFailure: true });
  if (result.status !== 0) throw new Error(`Not inside a git repository: ${startDir}`);
  return result.stdout.trim();
}

function currentBranch(repoRoot) {
  return run("git", ["branch", "--show-current"], { cwd: repoRoot }).stdout.trim();
}

function branchExists(repoRoot, branch) {
  return run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd: repoRoot,
    allowFailure: true,
  }).status === 0;
}

function gitStatus(repoRoot) {
  return run("git", ["status", "--short"], { cwd: repoRoot }).stdout.trim();
}

function baseFreshness(repoRoot, baseBranch) {
  const base = baseBranch || "main";
  const fetch = run("git", ["fetch", "origin", base], { cwd: repoRoot, allowFailure: true });
  const counts = run("git", ["rev-list", "--left-right", "--count", `origin/${base}...HEAD`], {
    cwd: repoRoot,
    allowFailure: true,
  });
  let behindBy = null;
  let aheadBy = null;
  if (counts.status === 0) {
    const parts = counts.stdout.trim().split(/\s+/);
    behindBy = Number.parseInt(parts[0], 10);
    aheadBy = Number.parseInt(parts[1], 10);
    if (!Number.isFinite(behindBy)) behindBy = null;
    if (!Number.isFinite(aheadBy)) aheadBy = null;
  }
  return {
    base,
    fetched: fetch.status === 0,
    behindBy,
    aheadBy,
    fresh: behindBy === null ? null : behindBy === 0,
    note: behindBy === null
      ? "Could not compare against origin base (offline, missing remote, or unknown base branch); verify base freshness manually."
      : behindBy === 0
        ? "Branch is up to date with origin base."
        : `Branch is ${behindBy} commit(s) behind origin/${base}; rebase before opening the PR to avoid a DIRTY merge state and a wasted CI round.`,
  };
}

function gitStatusPaths(repoRoot) {
  const result = run("git", ["status", "--porcelain=v1", "-z", "-uall"], { cwd: repoRoot });
  const entries = result.stdout.split("\0").filter(Boolean);
  const paths = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const status = entry.slice(0, 2);
    const file = entry.slice(3);
    if (!file) continue;
    if (status.includes("R") || status.includes("C")) {
      const target = entries[index + 1];
      if (target) {
        paths.push(normalizeRepoPath(file));
        paths.push(normalizeRepoPath(target));
        index += 1;
      } else {
        paths.push(normalizeRepoPath(file));
      }
    } else {
      paths.push(normalizeRepoPath(file));
    }
  }
  return Array.from(new Set(paths.filter(Boolean))).sort();
}

function resolveState(options) {
  const repoRoot = findGitRoot(process.cwd());
  let statePath = options.state ? resolveInput(options.state, repoRoot) : null;
  if (!statePath) {
    const activePath = [ACTIVE_PATH, LEGACY_ACTIVE_PATH]
      .map(rel => path.join(repoRoot, rel))
      .find(candidate => fs.existsSync(candidate));
    if (!activePath) throw new Error(`No --state provided and no active file at ${ACTIVE_PATH} (or legacy ${LEGACY_ACTIVE_PATH})`);
    const active = readJson(activePath);
    statePath = resolveInput(active.statePath, repoRoot);
  }
  if (!fs.existsSync(statePath)) throw new Error(`State file not found: ${statePath}`);
  const state = readJson(statePath);
  const stateDir = path.dirname(statePath);
  const receiptPath = path.join(stateDir, "receipt.json");
  const resultPath = path.join(stateDir, "implementation-result.md");
  if (!fs.existsSync(receiptPath)) throw new Error(`Receipt file not found: ${receiptPath}`);
  const receipt = readJson(receiptPath);
  return {
    repoRoot: state.projectRoot ? resolveInput(state.projectRoot, repoRoot) : repoRoot,
    statePath,
    stateDir,
    state,
    receiptPath,
    receipt,
    resultPath,
  };
}

function assertCompleteReceipt(context) {
  if (context.receipt.status !== "complete") {
    throw new Error(`Cannot ship receipt status '${context.receipt.status}'. Run prd-implement to completion first.`);
  }
}

function deliveryConfig(context, options = {}) {
  const delivery = context.state.delivery || context.receipt.delivery || {};
  const base = String(options.base || delivery.baseBranch || "main");
  const branch = String(options.branch || delivery.branch || `prd/${context.state.topicSlug || "work"}`);
  const ci = delivery.ci && typeof delivery.ci === "object" ? delivery.ci : {};
  return {
    mode: String(delivery.mode || "local"),
    branch,
    baseBranch: base,
    ci: {
      watch: ci.watch !== undefined ? Boolean(ci.watch) : true,
      maxFixAttempts: Number.isFinite(Number(ci.maxFixAttempts)) ? Number(ci.maxFixAttempts) : 2,
      timeoutSeconds: Number.isFinite(Number(ci.timeoutSeconds)) ? Number(ci.timeoutSeconds) : DEFAULT_CI_TIMEOUT_SECONDS,
      intervalSeconds: Number.isFinite(Number(ci.intervalSeconds)) ? Number(ci.intervalSeconds) : DEFAULT_CI_INTERVAL_SECONDS,
    },
    staging: delivery.staging || { include: [], exclude: [] },
  };
}

function harnessPath() {
  const override = process.env.HOYEON_PRD_HARNESS;
  const candidate = override ? resolveInput(override) : defaultHarnessPath();
  if (!fs.existsSync(candidate)) {
    throw new Error(`prd-implement state harness not found at ${candidate}. Set HOYEON_PRD_HARNESS to override.`);
  }
  return candidate;
}

function verifyDelivery(context) {
  const result = run(process.execPath, [harnessPath(), "verify-delivery", "--state", context.statePath], {
    cwd: context.repoRoot,
    allowFailure: true,
  });
  let parsed = null;
  try {
    parsed = result.stdout.trim() ? JSON.parse(result.stdout) : null;
  } catch {
    parsed = null;
  }
  if (!parsed) {
    return {
      ok: false,
      violations: [`verify-delivery did not return JSON (exit ${result.status}): ${(result.stderr || result.stdout || "").trim()}`],
    };
  }
  return parsed;
}

function cleanupActive(context) {
  const result = run(process.execPath, [harnessPath(), "cleanup-active", "--state", context.statePath], {
    cwd: context.repoRoot,
    allowFailure: true,
  });
  try {
    return result.stdout.trim() ? JSON.parse(result.stdout) : { ok: result.status === 0 };
  } catch {
    return {
      ok: false,
      error: (result.stderr || result.stdout || "").trim(),
    };
  }
}

function requireReason(options, flag) {
  const reason = typeof options.reason === "string" ? options.reason.trim() : "";
  if (!reason) throw new Error(`--${flag} requires --reason "<why this override preserves the delivery contract>"`);
  return reason;
}

// --- PR body draft ------------------------------------------------------

function firstLine(text) {
  return String(text || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean)[0] || "";
}

function summarizeVerification(state) {
  return (state.verification || []).map(item => {
    const mode = item.mode || item.testMode || (item.matrix && item.matrix.mode) || "";
    const modeSuffix = mode ? ` (${mode})` : "";
    const artifactPaths = (item.artifacts || []).map(artifact => artifact.path).filter(Boolean);
    const evidence = artifactPaths.length ? artifactPaths.join(", ") : firstLine((item.evidence || []).map(entry => entry.text).join(" "));
    return `| ${item.id}${modeSuffix} | ${item.status || "unknown"} | ${firstLine(item.title || item.passIntent || item.text || "")} | ${evidence || "No artifact"} |`;
  }).join("\n") || "| N/A | N/A | No verification items found | N/A |";
}

function summarizeAcceptance(state) {
  return (state.acceptanceCriteria || []).map(item => {
    const evidence = firstLine((item.evidence || []).map(entry => entry.text).join(" "));
    return `| ${item.id} | ${item.status || "unknown"} | ${firstLine(item.text || item.title || "")}${evidence ? ` Evidence: ${evidence}` : ""} |`;
  }).join("\n") || "| N/A | N/A | No acceptance criteria found |";
}

function summarizeReviews(state) {
  const requirements = state.requirementsFidelityReview || {};
  const final = state.finalReview || {};
  const profile = state.reviewProfile && state.reviewProfile.profile ? state.reviewProfile.profile : "standard";
  const finalLine = profile === "trivial" && !final.status
    ? "- Final adversarial review: skipped by trivial review profile"
    : `- Final adversarial review: ${final.status || "unknown"}${final.reportPath ? ` - ${final.reportPath}` : ""}`;
  return [
    `- Requirements fidelity review: ${requirements.status || "unknown"}${requirements.reportPath ? ` - ${requirements.reportPath}` : ""}`,
    finalLine,
  ].join("\n");
}

function summarizeChangedFiles(context) {
  try {
    const plan = stageablePaths(context, deliveryConfig(context));
    return plan.stage.length ? plan.stage.map(item => `- ${item}`).join("\n") : "- No staged file paths planned";
  } catch {
    const status = gitStatusPaths(context.repoRoot).filter(item => !item.includes("/artifacts/"));
    return status.length ? status.map(item => `- ${item}`).join("\n") : "- No pending file paths found";
  }
}

function deliverySummary(context) {
  const delivery = context.state.delivery || context.receipt.delivery || {};
  const staging = delivery.staging || {};
  const include = optionList(staging.include);
  const exclude = optionList(staging.exclude);
  return [
    `- Mode: ${delivery.mode || "unknown"}`,
    `- Branch: ${delivery.branch || "unknown"}`,
    `- Base: ${delivery.baseBranch || "main"}`,
    `- Staging include: ${include.length ? include.join(", ") : "default allowlist"}`,
    `- Staging exclude: ${exclude.length ? exclude.join(", ") : "default volatile paths"}`,
  ].join("\n");
}

function agentFill(instructions) {
  return `<!-- AGENT-FILL: ${instructions} Ground it in implementation-result.md and the recorded reviews. Delete this comment after writing. -->`;
}

function buildBodyDraft(context) {
  const state = context.state;
  const receipt = context.receipt;
  const resultRel = fs.existsSync(context.resultPath) ? toRepoRelative(context.resultPath, context.repoRoot) : null;
  const implementationState = toRepoRelative(context.statePath, context.repoRoot);
  const receiptPath = toRepoRelative(context.receiptPath, context.repoRoot);
  const lines = [
    "## Summary",
    "",
    agentFill("Write 3-6 bullets describing what actually changed in this PR for a reviewer who has not read the PRD."),
    "",
    "## Result",
    "",
    agentFill("State the user-visible or developer-visible outcome, what the reviewer can now confirm, and what is explicitly not included."),
    "",
    "## Screenshots / Demo",
    "",
    agentFill("If this PR changes a visual UI, browser, mobile, desktop, chart, document, slide, or generated image surface, include inline Markdown images for the key current screenshots. Prefer `![Alt](https://github.com/user-attachments/assets/<id>)` or committed screenshot URLs like `![Alt](https://github.com/<owner>/<repo>/blob/<commit-or-branch>/<path>.png?raw=true)`. Do not use `raw.githubusercontent.com` image URLs for private repos. If no visual surface changed, write `N/A - no visual surface changed`."),
    "",
    "## Human Review Focus",
    "",
    agentFill("Separate what the recorded evidence already proves from what still needs reviewer judgment: product interpretation, UX/copy, risky files or flows, data/auth/security, deployment or rollback, and specific reviewer questions."),
    "",
    "## Product And Scope Result",
    "",
    `- PRD: ${state.prdPath || "unknown"}`,
    `- Implementation state: ${implementationState}`,
    `- Receipt: ${receiptPath} (status: ${receipt.status})`,
    resultRel ? `- Result report: ${resultRel}` : "- Result report: not found",
    "",
    "## Acceptance Result",
    "",
    "| ID | Status | Criterion And Evidence |",
    "| --- | --- | --- |",
    summarizeAcceptance(state),
    "",
    "## Verification Evidence",
    "",
    "| ID | Status | Check | Evidence |",
    "| --- | --- | --- | --- |",
    summarizeVerification(state),
    "",
    "## Review Verdicts",
    "",
    summarizeReviews(state),
    "",
    "## Delivery Staging",
    "",
    deliverySummary(context),
    "",
    "## Changed Paths Planned For This PR",
    "",
    summarizeChangedFiles(context),
    "",
    "## Risks, Rollback, And Human Review",
    "",
    agentFill("List known risks, the rollback or mitigation path, remaining human verification, and follow-ups. Mark unrun or blocked checks explicitly."),
  ];
  return lines.join("\n");
}

function defaultBodyPath(context) {
  return path.join(context.stateDir, "delivery", "pr-body.md");
}

function validateBodyText(text, bodyPath) {
  const problems = [];
  if (AGENT_FILL_PATTERN.test(text)) {
    problems.push("body still contains AGENT-FILL placeholders; write the prose sections from implementation-result.md first");
  }
  for (const pattern of ATTRIBUTION_PATTERNS) {
    if (pattern.test(text)) {
      problems.push(`body contains AI agent attribution matching ${pattern}; PR metadata must be written as project work`);
    }
  }
  if (!/receipt/i.test(text)) {
    problems.push("body does not reference the implementation receipt");
  }
  if (/!\[[^\]]*\]\(\s*https:\/\/raw\.githubusercontent\.com\//i.test(text)) {
    problems.push("body embeds raw.githubusercontent.com images; use GitHub user-attachments or github.com/<owner>/<repo>/blob/<commit-or-branch>/<path>?raw=true so private repo screenshots render for reviewers");
  }
  if (problems.length) {
    throw new Error(`PR body at ${bodyPath} is not ready:\n- ${problems.join("\n- ")}`);
  }
}

function resolveBodyPath(context, options) {
  const bodyPath = options.body ? resolveInput(options.body, context.repoRoot) : defaultBodyPath(context);
  if (!fs.existsSync(bodyPath)) {
    throw new Error([
      `PR body not found: ${bodyPath}`,
      "Run 'body' to generate the draft, fill the AGENT-FILL sections from implementation-result.md, then rerun ship.",
    ].join("\n"));
  }
  validateBodyText(fs.readFileSync(bodyPath, "utf8"), bodyPath);
  return bodyPath;
}

// --- staging allowlist --------------------------------------------------

function defaultExcludedPaths(context) {
  const runDir = context.state.runDir || path.dirname(toRepoRelative(context.statePath, context.repoRoot));
  return [
    ACTIVE_PATH,
    SESSIONS_DIR_REL,
    LEGACY_ACTIVE_PATH,
    LEGACY_SESSIONS_DIR_REL,
    path.join(runDir, "artifacts"),
  ];
}

function normalizeRepoPath(input) {
  return String(input || "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/g, "");
}

function optionList(value) {
  if (value === undefined || value === null || value === true || value === false) return [];
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap(item => String(item).split(","))
    .map(item => normalizeRepoPath(item.trim()))
    .filter(Boolean);
}

function pathMatches(candidate, patterns) {
  const rel = normalizeRepoPath(candidate);
  return patterns.some(pattern => {
    const normalized = normalizeRepoPath(pattern);
    if (!normalized) return false;
    return rel === normalized || rel.startsWith(`${normalized}/`);
  });
}

function nodeWriteScopes(context) {
  const nodes = context.state.executionPlan && Array.isArray(context.state.executionPlan.nodes)
    ? context.state.executionPlan.nodes
    : [];
  return nodes
    .flatMap(node => Array.isArray(node.writeScope) ? node.writeScope : [])
    .map(normalizeRepoPath)
    .filter(item => item && !item.startsWith("TBD:") && !path.isAbsolute(item))
    .filter(item => !isUnsafeBroadWriteScope(item));
}

function isUnsafeBroadWriteScope(item) {
  const rel = normalizeRepoPath(item);
  return rel === "." || rel === "/" || rel === NAMESPACE_ROOT || rel === LEGACY_NAMESPACE_ROOT;
}

function defaultAllowedPaths(context, config, options = {}) {
  const runDir = normalizeRepoPath(context.state.runDir || path.dirname(toRepoRelative(context.statePath, context.repoRoot)));
  const paths = [
    context.state.prdPath ? path.dirname(context.state.prdPath) : null,
    runDir,
    context.state.delivery && context.state.delivery.configPath,
    ...nodeWriteScopes(context),
    ...optionList(config.staging && config.staging.include),
    ...optionList(options.include),
  ];
  return Array.from(new Set(paths.map(normalizeRepoPath).filter(Boolean)));
}

function excludedPaths(context, config, options = {}) {
  return Array.from(new Set([
    ...defaultExcludedPaths(context),
    ...optionList(config.staging && config.staging.exclude),
    ...optionList(options.exclude),
  ].map(normalizeRepoPath).filter(Boolean)));
}

function stageablePaths(context, config, options = {}) {
  const changed = gitStatusPaths(context.repoRoot);
  const excluded = excludedPaths(context, config, options);
  const allowed = defaultAllowedPaths(context, config, options);
  const ignored = changed.filter(item => pathMatches(item, excluded));
  const candidates = changed.filter(item => !pathMatches(item, excluded));
  const unrelated = candidates.filter(item => !pathMatches(item, allowed));
  if (unrelated.length) {
    throw new Error([
      "Refusing to stage changes outside the PRD delivery allowlist.",
      `Allowed prefixes: ${allowed.length ? allowed.join(", ") : "(none)"}`,
      `Excluded prefixes: ${excluded.length ? excluded.join(", ") : "(none)"}`,
      `Unrelated paths: ${unrelated.join(", ")}`,
      "Move unrelated changes out of the worktree, add an approved delivery.staging.include entry, or pass --include for an intentional path.",
    ].join("\n"));
  }
  return { changed, allowed, excluded, ignored, stage: candidates };
}

function stageAndCommit(context, options, title) {
  const repoRoot = context.repoRoot;
  const config = deliveryConfig(context, options);
  const plan = stageablePaths(context, config, options);
  if (plan.stage.length) {
    run("git", ["add", "-A", "--", ...plan.stage], { cwd: repoRoot });
  }
  const staged = run("git", ["diff", "--cached", "--name-only"], { cwd: repoRoot }).stdout.trim();
  if (!staged) return { committed: false, commit: null, staged: [] };
  const message = String(options["commit-message"] || title || `Ship ${context.state.topicSlug || "PRD implementation"}`);
  const commitArgs = ["commit"];
  if (options["no-gpg-sign"]) commitArgs.push("--no-gpg-sign");
  commitArgs.push("-m", message);
  run("git", commitArgs, { cwd: repoRoot });
  const commit = run("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot }).stdout.trim();
  return {
    committed: true,
    commit,
    staged: staged.split(/\r?\n/).filter(Boolean),
    changed: plan.changed,
    ignored: plan.ignored,
    allowed: plan.allowed,
  };
}

// --- branch / PR / CI ---------------------------------------------------

function ensureBranch(context, config) {
  const repoRoot = context.repoRoot;
  const current = currentBranch(repoRoot);
  if (current === config.branch) return current;
  if (current === config.baseBranch || current === "main" || current === "master") {
    if (branchExists(repoRoot, config.branch)) {
      run("git", ["checkout", config.branch], { cwd: repoRoot });
    } else {
      run("git", ["checkout", "-b", config.branch], { cwd: repoRoot });
    }
    return config.branch;
  }
  throw new Error(`Current branch '${current}' does not match delivery branch '${config.branch}'. Checkout the intended branch or pass --branch.`);
}

function existingPrUrl(repoRoot, branch) {
  const result = run("gh", ["pr", "view", branch, "--json", "url", "--jq", ".url"], {
    cwd: repoRoot,
    allowFailure: true,
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function createOrUpdatePr(context, config, title, bodyPath, draft) {
  const repoRoot = context.repoRoot;
  const existing = existingPrUrl(repoRoot, config.branch);
  if (existing) {
    const editArgs = ["pr", "edit", existing, "--body-file", bodyPath];
    if (title) editArgs.push("--title", title);
    run("gh", editArgs, { cwd: repoRoot });
    return { url: existing, created: false, updated: true };
  }
  const args = [
    "pr",
    "create",
    "--base",
    config.baseBranch,
    "--head",
    config.branch,
    "--title",
    title,
    "--body-file",
    bodyPath,
  ];
  if (draft) args.push("--draft");
  const result = run("gh", args, { cwd: repoRoot });
  const url = result.stdout.trim().split(/\r?\n/).find(line => /^https?:\/\//.test(line.trim())) || result.stdout.trim();
  return { url, created: true, updated: false };
}

function prRefFromOptions(context, options) {
  if (options.pr) return String(options.pr);
  const config = deliveryConfig(context, options);
  const url = existingPrUrl(context.repoRoot, config.branch);
  return url || config.branch;
}

function fetchChecks(context, prRef) {
  const result = run("gh", ["pr", "checks", prRef, "--json", "name,state,link,bucket,workflow,startedAt,completedAt"], {
    cwd: context.repoRoot,
    allowFailure: true,
    maxBuffer: 20 * 1024 * 1024,
  });
  let checks = null;
  try {
    checks = result.stdout.trim() ? JSON.parse(result.stdout) : null;
  } catch {
    checks = null;
  }
  const noChecks = result.status !== 0 && /no checks reported|no checks/i.test(`${result.stderr}${result.stdout}`);
  return { checks, noChecks, exitCode: result.status, stderr: result.stderr };
}

function classifyChecks(checks) {
  if (!Array.isArray(checks) || checks.length === 0) return "pending";
  const buckets = checks.map(check => String(check.bucket || check.state || "").toLowerCase());
  if (buckets.some(bucket => ["fail", "cancel", "failure", "cancelled"].includes(bucket))) return "fail";
  if (buckets.every(bucket => ["pass", "skipping", "success", "skipped", "neutral"].includes(bucket))) return "pass";
  return "pending";
}

function watchCi(context, options = {}) {
  const config = deliveryConfig(context, options);
  const prRef = prRefFromOptions(context, options);
  const timeoutSeconds = Number.isFinite(Number(options.timeout)) ? Number(options.timeout) : config.ci.timeoutSeconds;
  const intervalSeconds = Math.max(5, Number.isFinite(Number(options.interval)) ? Number(options.interval) : config.ci.intervalSeconds);
  const deadline = Date.now() + timeoutSeconds * 1000;
  let last = fetchChecks(context, prRef);
  let verdict = last.noChecks ? "no-checks" : classifyChecks(last.checks);
  while (verdict === "pending" && Date.now() < deadline) {
    sleepMs(Math.min(intervalSeconds * 1000, Math.max(1000, deadline - Date.now())));
    last = fetchChecks(context, prRef);
    verdict = last.noChecks ? "no-checks" : classifyChecks(last.checks);
  }
  return {
    pr: prRef,
    verdict,
    ok: verdict === "pass" || verdict === "no-checks",
    timedOut: verdict === "pending",
    timeoutSeconds,
    intervalSeconds,
    checks: last.checks,
    noChecks: last.noChecks,
    stderr: last.stderr || null,
    note: verdict === "no-checks"
      ? "No CI checks are reported for this PR; confirm whether the repository is expected to run CI."
      : verdict === "pending"
        ? "Checks still pending at timeout; rerun watch-ci to keep waiting."
        : null,
  };
}

function ciExitCode(ci) {
  if (!ci || ci.ok) return 0;
  return ci.timedOut ? 3 : 2;
}

function shipLogPath(context) {
  return path.join(context.stateDir, "delivery", "ship-log.jsonl");
}

// --- commands -----------------------------------------------------------

function cmdPreflight(options) {
  const context = resolveState(options);
  assertCompleteReceipt(context);
  const config = deliveryConfig(context, options);
  const gh = run("gh", ["auth", "status"], { cwd: context.repoRoot, allowFailure: true });
  const bodyPath = options.body ? resolveInput(options.body, context.repoRoot) : defaultBodyPath(context);
  let bodyStatus = "missing";
  if (fs.existsSync(bodyPath)) {
    try {
      validateBodyText(fs.readFileSync(bodyPath, "utf8"), bodyPath);
      bodyStatus = "ready";
    } catch {
      bodyStatus = "draft-unfilled-or-invalid";
    }
  }
  const freshness = verifyDelivery(context);
  const base = baseFreshness(context.repoRoot, config.baseBranch);
  process.stdout.write(JSON.stringify({
    ok: true,
    repoRoot: context.repoRoot,
    statePath: toRepoRelative(context.statePath, context.repoRoot),
    receiptPath: toRepoRelative(context.receiptPath, context.repoRoot),
    delivery: config,
    modeOk: config.mode === "pr",
    deliveryFreshness: freshness,
    baseFreshness: base,
    body: { path: toRepoRelative(bodyPath, context.repoRoot), status: bodyStatus },
    currentBranch: currentBranch(context.repoRoot),
    gitStatus: gitStatus(context.repoRoot),
    stagePlan: stageablePaths(context, config, options),
    ghAuthOk: gh.status === 0,
  }, null, 2) + "\n");
}

function cmdBody(options) {
  const context = resolveState(options);
  assertCompleteReceipt(context);
  const output = options.output ? resolveInput(options.output, context.repoRoot) : defaultBodyPath(context);
  if (fs.existsSync(output) && !options.force) {
    throw new Error(`PR body already exists: ${output}. Edit it in place, or pass --force to regenerate the draft (this discards its content).`);
  }
  writeFile(output, buildBodyDraft(context));
  process.stdout.write(JSON.stringify({
    ok: true,
    bodyPath: toRepoRelative(output, context.repoRoot),
    resultReport: fs.existsSync(context.resultPath) ? toRepoRelative(context.resultPath, context.repoRoot) : null,
    next: "Fill every AGENT-FILL section with prose grounded in implementation-result.md and the recorded reviews, then run ship.",
  }, null, 2) + "\n");
}

function cmdShip(options) {
  const context = resolveState(options);
  assertCompleteReceipt(context);
  const config = deliveryConfig(context, options);
  const overrides = [];

  if (config.mode !== "pr") {
    if (!options["override-mode"]) {
      throw new Error([
        `Delivery mode is '${config.mode}', not 'pr'. PR delivery was not approved for this run.`,
        "Set delivery mode pr at init (PRD-approved), or pass --override-mode --reason \"<verbatim user approval>\" if the user explicitly approved PR delivery now.",
      ].join("\n"));
    }
    overrides.push({ kind: "mode", from: config.mode, reason: requireReason(options, "override-mode") });
  }

  const freshness = verifyDelivery(context);
  if (!freshness.ok) {
    if (!options["allow-stale"]) {
      throw new Error([
        "Implementation state is not delivery-fresh:",
        ...(freshness.violations || []).map(item => `- ${item}`),
        "Return to prd-implement (rerun verification and reviews, then finalize), or pass --allow-stale --reason \"<why shipping anyway is safe and user-approved>\".",
      ].join("\n"));
    }
    overrides.push({ kind: "stale", violations: freshness.violations || [], reason: requireReason(options, "allow-stale") });
  }

  const base = baseFreshness(context.repoRoot, config.baseBranch);
  if (base.fresh === false) {
    if (!options["allow-stale-base"]) {
      throw new Error([
        `Branch is ${base.behindBy} commit(s) behind origin/${base.base}. Opening the PR now will likely produce a DIRTY merge state and a wasted CI round.`,
        `Rebase first: git rebase origin/${base.base} (origin/${base.base} is already fetched), resolve conflicts, rerun the relevant verification, then rerun ship.`,
        "Or pass --allow-stale-base --reason \"<why shipping without rebase is intended>\".",
      ].join("\n"));
    }
    overrides.push({ kind: "stale-base", behindBy: base.behindBy, base: base.base, reason: requireReason(options, "allow-stale-base") });
  }

  const rulesGate = runRulesGate(context, options, overrides);

  const title = String(options.title || `Ship ${context.state.topicSlug || "PRD implementation"}`);
  const bodyPath = resolveBodyPath(context, options);
  const branch = ensureBranch(context, config);
  const commit = stageAndCommit(context, options, title);
  run("git", ["push", "-u", "origin", branch], { cwd: context.repoRoot });
  const pr = createOrUpdatePr(context, config, title, bodyPath, Boolean(options.draft));
  const ci = options["no-watch"] ? null : watchCi(context, { ...options, pr: pr.url });
  const ok = !ci || ci.ok;
  const deliveryChecksPassed = ci ? ci.ok : false;
  const result = {
    ok,
    branch,
    baseBranch: config.baseBranch,
    commit,
    pr,
    bodyPath: toRepoRelative(bodyPath, context.repoRoot),
    overrides,
    rules: rulesGate,
    ci,
    activeCleanup: deliveryChecksPassed
      ? cleanupActive(context)
      : { ok: false, skipped: true, reason: ci ? "delivery checks did not pass" : "delivery checks were not watched" },
  };
  appendJsonl(shipLogPath(context), {
    ts: new Date().toISOString(),
    event: "ship",
    branch,
    commit: commit.commit,
    pr: pr.url,
    prCreated: pr.created,
    prUpdated: Boolean(pr.updated),
    ciVerdict: ci ? ci.verdict : "not-watched",
    overrides,
    rules: rulesGate,
  });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exitCode = ciExitCode(ci);
}

// Learned-invariant gate: changed files are matched against agents/rules
// triggers and each armed check runs before anything is staged or pushed.
// Failures are fail-closed; --skip-rules needs a --reason and lands in the
// ship log like every other override.
function runRulesGate(context, options, overrides) {
  const result = run(process.execPath, [harnessPath(), "rules", "check"], {
    cwd: context.repoRoot,
    allowFailure: true,
  });
  let report;
  try {
    report = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error(`rules check did not return a readable report:\n${result.stderr || result.stdout}`);
  }
  const warnings = [];
  if (report.pending && report.pending.count > 0) {
    warnings.push(`agents/rules/pending/ holds ${report.pending.count} unlanded lesson(s): ${report.pending.items.map(item => item.id).join(", ")}. Land them (write the test or docs) or consciously defer.`);
  }
  for (const manual of report.manualConfirmations || []) {
    warnings.push(`Rule ${manual.id} needs human confirmation before delivery: ${manual.detail}`);
  }
  if (report.failures && report.failures.length > 0) {
    if (!options["skip-rules"]) {
      throw new Error([
        "Learned invariant checks failed for this change set:",
        ...report.failures.map(item => `- ${item.id}: ${item.summary}\n  ${item.detail}`),
        "Fix the violations, or pass --skip-rules --reason \"<why shipping despite a failed invariant is user-approved>\".",
      ].join("\n"));
    }
    overrides.push({ kind: "rules", failures: report.failures.map(item => item.id), reason: requireReason(options, "skip-rules") });
  }
  return {
    ok: report.ok,
    checked: (report.results || []).length,
    failures: (report.failures || []).map(item => item.id),
    pendingCount: report.pending ? report.pending.count : 0,
    warnings,
  };
}

function cmdWatchCi(options) {
  const context = resolveState(options);
  assertCompleteReceipt(context);
  const ci = watchCi(context, options);
  appendJsonl(shipLogPath(context), {
    ts: new Date().toISOString(),
    event: "watch-ci",
    pr: ci.pr,
    ciVerdict: ci.verdict,
    timedOut: ci.timedOut,
  });
  process.stdout.write(JSON.stringify(ci, null, 2) + "\n");
  process.exitCode = ciExitCode(ci);
}

function cmdStatus(options) {
  const context = resolveState(options);
  const config = deliveryConfig(context, options);
  const prRef = prRefFromOptions(context, options);
  const pr = run("gh", ["pr", "view", prRef, "--json", "number,url,state,isDraft,mergeStateStatus,headRefName,baseRefName,statusCheckRollup"], {
    cwd: context.repoRoot,
    allowFailure: true,
    maxBuffer: 20 * 1024 * 1024,
  });
  let prJson = null;
  try {
    prJson = pr.stdout.trim() ? JSON.parse(pr.stdout) : null;
  } catch {
    prJson = null;
  }
  process.stdout.write(JSON.stringify({
    ok: pr.status === 0,
    delivery: config,
    currentBranch: currentBranch(context.repoRoot),
    gitStatus: gitStatus(context.repoRoot),
    pr: prJson,
    error: pr.status === 0 ? null : pr.stderr,
  }, null, 2) + "\n");
  if (pr.status !== 0) process.exitCode = 2;
}

main();
