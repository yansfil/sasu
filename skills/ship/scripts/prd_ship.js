#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");
const { isDeepStrictEqual } = require("node:util");

// Current CLI run paths are fixed under agents/runs. Keeping a configurable
// reader here would select a different completion authority from implement.
const NAMESPACE_ROOT = "agents";
// Gate and implement records share the current run namespace.
const RUNS_ROOT_REL = path.join(NAMESPACE_ROOT, "runs");
const ACTIVE_PATH = path.join(RUNS_ROOT_REL, ".prd-implement-active.json");
const SESSION_POINTER_DIR_REL = path.join(RUNS_ROOT_REL, ".active");

// Session-scoped pointer mirror of cli/src/runs/session.ts + runs/paths.ts;
// the key list and sanitizer must match SESSION_ID_ENV_KEYS there. Kept local
// so the ship skill stays installable without an implement checkout.
const SESSION_ID_ENV_KEYS = ["CODEX_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID"];
function currentSessionId() {
  for (const key of SESSION_ID_ENV_KEYS) {
    const value = (process.env[key] || "").trim();
    if (value) return value.replace(/[^A-Za-z0-9._-]/g, "-");
  }
  return null;
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
    if (options["allow-stale"]) throw new Error("--allow-stale is retired; delivery requires a current verification and receipt");
    if (command === "preflight") return cmdPreflight(options);
    if (command === "body") return cmdBody(options);
    if (command === "local") return cmdLocal(options);
    if (command === "ship") return cmdShip(options);
    if (command === "watch-ci") return cmdWatchCi(options);
    if (command === "merge") return cmdMerge(options);
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
  node prd_ship.js local [--state <state.json>] [--commit-message <message>] [--no-gpg-sign] [--include <path>] [--skip-rules --reason <why>]
  node prd_ship.js ship [--state <state.json>] [--title <title>] [--body <file>] [--branch <branch>] [--base <base>] [--draft] [--no-watch] [--no-gpg-sign] [--include <path>] [--override-mode --reason <why>] [--allow-stale-base --reason <why>] [--skip-rules --reason <why>]
  node prd_ship.js watch-ci [--state <state.json>] [--pr <number-or-url>] [--timeout <seconds>] [--interval <seconds>]
  node prd_ship.js merge [--state <state.json>] [--pr <number-or-url>] --approval <verbatim-user-approval> [--method squash|merge|rebase] [--delete-branch]
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

function currentHead(repoRoot) {
  return run("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).stdout.trim();
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
    const sessionId = currentSessionId();
    let activePath = sessionId === null ? null : path.join(repoRoot, SESSION_POINTER_DIR_REL, `${sessionId}.json`);
    if (activePath === null || !fs.existsSync(activePath)) activePath = path.join(repoRoot, ACTIVE_PATH);
    if (!fs.existsSync(activePath)) throw new Error(`No --state provided and no active pointer for this session; pass --state <path>`);
    const active = readJson(activePath);
    // A pointer inside a run's worktree names its record tree explicitly.
    statePath = resolveInput(active.statePath, active.projectRoot || repoRoot);
  }
  if (!fs.existsSync(statePath)) throw new Error(`State file not found: ${statePath}`);
  const state = readJson(statePath);
  assertSchema(state, "sasu.implement.state.v10", "state");
  const stateDir = path.dirname(statePath);
  const receiptPath = path.join(stateDir, "receipt.json");
  const resultPath = path.join(stateDir, "implementation-result.md");
  if (!fs.existsSync(receiptPath)) throw new Error(`Receipt file not found: ${receiptPath}`);
  const receipt = readJson(receiptPath);
  assertSchema(receipt, "sasu.implement.receipt.v6", "receipt");
  return {
    // Git operations (staging, commit, push) happen in the JUDGED tree: the
    // run's worktree when isolated, else the record tree. Records (state,
    // receipt, result) are always read from the record tree via statePath.
    repoRoot: state.worktree && state.worktree.path
      ? resolveInput(state.worktree.path, repoRoot)
      : state.projectRoot
        ? resolveInput(state.projectRoot, repoRoot)
        : repoRoot,
    statePath,
    stateDir,
    state,
    receiptPath,
    receipt,
    resultPath,
  };
}

const SHIPPABLE_RECEIPT_STATUSES = new Set(["complete", "complete-pending-human"]);
const LAST_SUPPORTED_COMMIT = "3f549dcfff71fe1f7fa974a383f6e8a055ce8463";
const LAST_EXPERIMENTAL_COMMIT = "2b1f638dd587261be7e7b0e600db16657421971d";

function assertSchema(value, expected, label) {
  if (value?.schema !== expected) {
    const supportCommit = ["sasu.implement.state.v9.parallel-review", "sasu.implement.receipt.v5.parallel-review"].includes(value?.schema)
      ? LAST_EXPERIMENTAL_COMMIT : LAST_SUPPORTED_COMMIT;
    throw new Error(`${label} received schema ${value?.schema ?? "missing"}; expected ${expected}; last supported commit ${supportCommit}. Start a new run with the current contract.`);
  }
}

function assertCompleteReceipt(context) {
  if (!SHIPPABLE_RECEIPT_STATUSES.has(context.receipt.status)) {
    throw new Error(`Cannot ship receipt status '${context.receipt.status}'. Run implement to completion first.`);
  }
  // Eligibility is derived by the CLI from current human responses and open
  // blockers. Status alone cannot distinguish pending consent from rejection.
  if (context.receipt.delivery?.eligible !== true) {
    throw new Error(`Receipt is not delivery-eligible: ${(context.receipt.delivery?.reasons || ["missing eligibility"]).join("; ")}`);
  }
  for (const role of ["fidelity", "code"]) {
    const review = context.receipt.reviews?.[role];
    // Human confirmation and accepted risk can settle a historical FAIL.
    // Require both actual results without replacing the CLI's eligibility gate.
    if (!review?.result || !["PASS", "FAIL"].includes(review.verdict)) {
      throw new Error(`Receipt ${role} review has no completed result. Run implement to completion first.`);
    }
  }
  const verification = verifyDelivery(context);
  if (!verification.ok) throw new Error(`Receipt verification failed: ${verification.violations.join("; ")}`);
}

function projectDeliveryConfig(context) {
  const projectRoot = context.state && typeof context.state.projectRoot === "string"
    ? context.state.projectRoot
    : context.repoRoot;
  const configPath = path.join(projectRoot, "agents", "config.json");
  if (!fs.existsSync(configPath)) return {};
  let parsed;
  try {
    parsed = readJson(configPath);
  } catch {
    throw new Error(`agents/config.json is not valid JSON: ${configPath}`);
  }
  if (parsed.delivery === undefined) return {};
  if (!parsed.delivery || typeof parsed.delivery !== "object" || Array.isArray(parsed.delivery)) {
    throw new Error(`agents/config.json delivery must be an object: ${configPath}`);
  }
  return parsed.delivery;
}

function deliveryConfig(context, options = {}) {
  // A run-level declaration is authoritative because it is part of the
  // reviewed delivery contract; project config supplies the default when the
  // run does not declare a delivery override.
  const project = projectDeliveryConfig(context);
  const stateDelivery = context.state.delivery && typeof context.state.delivery === "object"
    ? context.state.delivery
    : {};
  const receiptDelivery = context.receipt.delivery && typeof context.receipt.delivery === "object"
    ? context.receipt.delivery
    : {};
  const delivery = { ...project, ...stateDelivery, ...receiptDelivery };
  const staging = {
    ...(project.staging && typeof project.staging === "object" ? project.staging : {}),
    ...(stateDelivery.staging && typeof stateDelivery.staging === "object" ? stateDelivery.staging : {}),
    ...(receiptDelivery.staging && typeof receiptDelivery.staging === "object" ? receiptDelivery.staging : {}),
  };
  const ci = {
    ...(project.ci && typeof project.ci === "object" ? project.ci : {}),
    ...(stateDelivery.ci && typeof stateDelivery.ci === "object" ? stateDelivery.ci : {}),
    ...(receiptDelivery.ci && typeof receiptDelivery.ci === "object" ? receiptDelivery.ci : {}),
  };
  const mode = String(delivery.mode || "local").trim().toLowerCase();
  if (!["local", "pr"].includes(mode)) {
    throw new Error(`Unsupported delivery mode '${mode}'. Expected local or pr.`);
  }
  return {
    mode,
    branch: String(options.branch || delivery.branch || `${String(delivery.branchPrefix || "prd").replace(/\/+$/, "")}/${context.state.topicSlug || "work"}`),
    baseBranch: String(options.base || delivery.baseBranch || "main"),
    ci: {
      watch: ci.watch !== undefined ? Boolean(ci.watch) : true,
      maxFixAttempts: Number.isFinite(Number(ci.maxFixAttempts)) ? Number(ci.maxFixAttempts) : 2,
      timeoutSeconds: Number.isFinite(Number(ci.timeoutSeconds)) ? Number(ci.timeoutSeconds) : DEFAULT_CI_TIMEOUT_SECONDS,
      intervalSeconds: Number.isFinite(Number(ci.intervalSeconds)) ? Number(ci.intervalSeconds) : DEFAULT_CI_INTERVAL_SECONDS,
    },
    staging,
  };
}

function verifyDelivery(context) {
  if (context.verifiedDelivery) return context.verifiedDelivery;
  // sasu confines --state to the tree it runs in, and the state lives in the
  // record tree, so status runs there even when the judged tree is a linked
  // worktree; sasu finds that worktree from the state itself.
  const result = run("sasu", ["implement", "status", "--state", context.statePath, "--json"], {
    cwd: context.state.projectRoot || context.repoRoot,
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
      violations: [`sasu implement status did not return JSON (exit ${result.status}): ${(result.stderr || result.stdout || "").trim()}`],
    };
  }
  const detail = parsed.detail || {};
  const violations = [];
  if (result.status !== 0 || parsed.ok !== true) violations.push(parsed.message || `status exited ${result.status}`);
  if (!SHIPPABLE_RECEIPT_STATUSES.has(detail.status)) violations.push(`implement state is ${detail.status || "unknown"}, not complete or complete-pending-human`);
  if (!detail.verification || detail.verification.verdict !== "PASS") {
    violations.push(`implementation verification is ${detail.verification ? detail.verification.verdict : "missing"}, not PASS`);
  }
  for (const problem of detail.artifactProblems || []) violations.push(problem);
  if (detail.delivery?.eligible !== true) violations.push(`implement delivery is ineligible: ${(detail.delivery?.reasons || ["missing eligibility"]).join("; ")}`);
  if (!detail.completion || detail.completion.fingerprint !== context.receipt.completionFingerprint) {
    violations.push("receipt completion fingerprint does not match sasu implement status");
  }
  // The installed ship script cannot import a checkout-specific validator.
  // The current CLI owns validation; bind the derived receipt to its exact
  // settled judgments so an edited receipt cannot invent coverage or grounds.
  const latest = detail.verification?.latest;
  if (!latest || context.receipt.verificationAttemptId !== latest.id
      || context.receipt.prdSha256 !== latest.prdSha256
      || context.receipt.inputFingerprint !== latest.inputFingerprint
      || context.receipt.sourceFingerprint !== latest.sourceFingerprint
      || !isDeepStrictEqual(context.receipt.reviewContext, latest.reviewContext)) {
    violations.push("receipt review input identity does not match sasu implement status");
  }
  for (const role of ["fidelity", "code"]) {
    if (!isDeepStrictEqual(context.receipt.reviews?.[role], latest?.reviews?.[role])) {
      violations.push(`receipt ${role} review does not match the CLI's settled judgment`);
    }
  }
  context.verifiedDelivery = { ok: violations.length === 0, violations, status: detail };
  return context.verifiedDelivery;
}

function requireReason(options, flag) {
  const reason = typeof options.reason === "string" ? options.reason.trim() : "";
  if (!reason) throw new Error(`--${flag} requires --reason "<why this override preserves the delivery contract>"`);
  return reason;
}

// --- PR body draft ------------------------------------------------------

function cell(text) {
  return String(text || "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function summarizeHumanConfirmations(receipt) {
  const open = receipt.humanConfirmations.filter(finding => finding.status === "open");
  if (open.length === 0) return "- No outstanding human confirmations.";
  return [
    "| ID | Pending judgment | Contract source | Next action |",
    "| --- | --- | --- | --- |",
    ...open.map(finding => `| ${cell(finding.id)} | ${cell(finding.problem)} | ${cell(finding.human?.sourceRef)} | ${cell(finding.nextAction)} |`),
    "",
    "The permitted post-completion judgments above remain open. The user responds with `sasu implement confirm --issuer human --id <id> --evidence \"<user words>\"`. An explicit rejection makes delivery ineligible.",
  ].join("\n");
}

function summarizeVerification(receipt) {
  return [
    ...[["fidelity", "Fidelity"], ["code", "Code"]].flatMap(([role, label]) => {
      const review = receipt.reviews?.[role];
      return [
        `- ${label} review: ${review?.verdict || "NOT_RUN"}`,
        review?.result?.summary ? `- ${label} summary: ${review.result.summary}` : `- No ${label} review summary recorded.`,
      ];
    }),
    `- Reviewed source: ${receipt.sourceFingerprint} (attempt ${receipt.verificationAttemptId})`,
    `- Completion fingerprint: ${receipt.completionFingerprint}`,
    `- Distinct risk review: ${receipt.risk?.verdict || "NOT_REQUIRED"}`,
    ...receipt.riskFindings.map(finding => `- ${finding.id} (risk ${finding.severity}, ${finding.status}): ${finding.text}${finding.resolution ? ` - ${finding.resolution.evidence}` : ""}`),
    ...receipt.findings.filter(finding => finding.status === "open")
      .map(finding => `- ${finding.id} (${finding.kind}): ${finding.problem} ${finding.nextAction}`),
  ].join("\n");
}

function summarizeEvidence(receipt) {
  if (!receipt.artifacts.length) return "- No registered observation files. This is not a claim of runtime or visual verification.";
  return receipt.artifacts.map(artifact => `- ${artifact.path}: ${artifact.description}${artifact.provenance ? ` (source: ${artifact.provenance}; observed: ${artifact.observedAt})` : ""}`).join("\n");
}

function summarizeTests(receipt) {
  const commands = receipt.mechanical;
  if (!commands.length) return "- No suite commands executed in the final verification attempt.";
  return commands.map(command => `- \`${command.command}\` (cwd: ${command.cwd}, exit ${command.exitCode}, ${command.finishedAt})`).join("\n");
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
    "## Actual Tests",
    "",
    summarizeTests(receipt),
    "",
    "## Actual Observations",
    "",
    summarizeEvidence(receipt),
    "",
    "## Comprehensive Review",
    "",
    summarizeVerification(receipt),
    "",
    "## Open Human Confirmations",
    "",
    summarizeHumanConfirmations(receipt),
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
    path.join(runDir, "artifacts"),
    // Gate state shares the unified run dir but was never delivery material:
    // it is runtime bookkeeping, never a verification input (AGENTS.md).
    path.join(runDir, "gates"),
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

/** Product paths come from the CLI-owned reviewed attribution, including its
 * exclusion of dirty changes that existed before this run. */
function runOwnedPaths(context) {
  if (!Array.isArray(context.receipt.ownedFiles)) throw new Error("receipt.ownedFiles must be an array");
  return context.receipt.ownedFiles.map(item => {
    const normalized = normalizeRepoPath(item);
    if (!normalized || path.isAbsolute(normalized) || normalized.split("/").includes("..") || isUnsafeBroadWriteScope(normalized)
        || normalized.startsWith(`${NAMESPACE_ROOT}/`)) throw new Error(`Invalid run-owned product path: ${item}`);
    return normalized;
  });
}

function isUnsafeBroadWriteScope(item) {
  const rel = normalizeRepoPath(item);
  return rel === "." || rel === "/" || rel === NAMESPACE_ROOT;
}

function defaultAllowedPaths(context, config, options = {}) {
  const runDir = normalizeRepoPath(context.state.runDir || path.dirname(toRepoRelative(context.statePath, context.repoRoot)));
  const paths = [
    context.state.prdPath ? path.dirname(context.state.prdPath) : null,
    runDir,
    context.state.delivery && context.state.delivery.configPath,
    ...runOwnedPaths(context),
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

function deliveryPathPolicy(context, config, options = {}) {
  const includes = Array.from(new Set([
    ...optionList(config.staging && config.staging.include),
    ...optionList(options.include),
  ].map(normalizeRepoPath).filter(Boolean)));
  const excluded = excludedPaths(context, config, options)
    .filter(item => !includes.some(include => include === item || include.startsWith(`${item}/`) || item.startsWith(`${include}/`)));
  return {
    includes,
    excluded,
    allowed: defaultAllowedPaths(context, config, options),
  };
}

function stagedPaths(repoRoot) {
  return run("git", ["diff", "--cached", "--name-only"], { cwd: repoRoot }).stdout
    .split(/\r?\n/)
    .map(normalizeRepoPath)
    .filter(Boolean);
}

function assertStagedPathsArePlanned(plan, staged) {
  const planned = new Set(plan.stage);
  const unexpected = staged.filter(item => !planned.has(item));
  if (unexpected.length > 0) {
    throw new Error([
      "Refusing to commit pre-staged paths outside the delivery plan.",
      `Unexpected staged paths: ${unexpected.join(", ")}`,
      "Unstage them or include them through the approved delivery allowlist before retrying.",
    ].join("\n"));
  }
}

function stageablePaths(context, config, options = {}) {
  const changed = gitStatusPaths(context.repoRoot);
  const policy = deliveryPathPolicy(context, config, options);
  const { includes, excluded, allowed } = policy;
  for (const include of includes) {
    if (!changed.some(item => pathMatches(item, [include]))) {
      process.stderr.write(`warning: include entry '${include}' matches no changed path; it will stage nothing\n`);
    }
  }
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
  assertStagedPathsArePlanned(plan, stagedPaths(repoRoot));
  if (plan.stage.length) {
    run("git", ["add", "-A", "--", ...plan.stage], { cwd: repoRoot });
  }
  const stagedPathsAfterAdd = stagedPaths(repoRoot);
  assertStagedPathsArePlanned(plan, stagedPathsAfterAdd);
  if (!stagedPathsAfterAdd.length) return { committed: false, commit: null, staged: [] };
  const message = String(options["commit-message"] || title || `Ship ${context.state.topicSlug || "PRD implementation"}`);
  const commitArgs = ["commit"];
  if (options["no-gpg-sign"]) commitArgs.push("--no-gpg-sign");
  commitArgs.push("-m", message);
  run("git", commitArgs, { cwd: repoRoot });
  const commit = run("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot }).stdout.trim();
  return {
    committed: true,
    commit,
    staged: stagedPathsAfterAdd,
    changed: plan.changed,
    ignored: plan.ignored,
    allowed: plan.allowed,
  };
}

function baselineHead(context) {
  const candidates = [
    context.state.initialSource && context.state.initialSource.head,
    context.state.baselineAttribution && context.state.baselineAttribution.head,
  ];
  return candidates.find(item => typeof item === "string" && item.trim() !== "") || null;
}

function isAncestor(repoRoot, ancestor, descendant) {
  return run("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd: repoRoot,
    allowFailure: true,
  }).status === 0;
}

function pathsBetween(repoRoot, from, to) {
  const result = run("git", ["diff", "--name-only", from, to], {
    cwd: repoRoot,
    allowFailure: true,
  });
  if (result.status !== 0) {
    throw new Error(`Could not inspect the implementation range ${from}..${to}: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.split(/\r?\n/).map(normalizeRepoPath).filter(Boolean);
}

function remoteRefsContainingHead(repoRoot) {
  const result = run("git", ["branch", "-r", "--contains", "HEAD"], {
    cwd: repoRoot,
    allowFailure: true,
  });
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
}

function commitSubject(repoRoot) {
  return run("git", ["log", "-1", "--format=%s"], { cwd: repoRoot }).stdout.trim();
}

function commitInfo(repoRoot) {
  return {
    commit: currentHead(repoRoot),
    short: run("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot }).stdout.trim(),
    subject: commitSubject(repoRoot),
  };
}

function assertDeliveryPaths(context, config, paths, options, label) {
  const policy = deliveryPathPolicy(context, config, options);
  const forbidden = paths.filter(item => pathMatches(item, policy.excluded) || !pathMatches(item, policy.allowed));
  if (forbidden.length > 0) {
    throw new Error([
      `${label} includes paths outside the PRD delivery allowlist.`,
      `Allowed prefixes: ${policy.allowed.length ? policy.allowed.join(", ") : "(none)"}`,
      `Excluded prefixes: ${policy.excluded.length ? policy.excluded.join(", ") : "(none)"}`,
      `Unexpected paths: ${forbidden.join(", ")}`,
      "Move unrelated changes out of the worktree or add an approved delivery include before retrying.",
    ].join("\n"));
  }
  return policy;
}

function checkpointPromotion(context, config, options) {
  if (!/^checkpoint:\s*/i.test(commitSubject(context.repoRoot))) return null;
  const baseline = baselineHead(context);
  if (!baseline) {
    return { eligible: false, reason: "the run has no recorded baseline HEAD" };
  }
  const head = currentHead(context.repoRoot);
  if (!isAncestor(context.repoRoot, baseline, head)) {
    return { eligible: false, reason: `HEAD ${head} is not descended from baseline ${baseline}` };
  }
  const remoteRefs = remoteRefsContainingHead(context.repoRoot);
  if (remoteRefs === null) {
    return { eligible: false, reason: "could not prove that the checkpoint is absent from all remotes" };
  }
  if (remoteRefs.length > 0) {
    return { eligible: false, reason: `the checkpoint is already reachable from ${remoteRefs.join(", ")}` };
  }
  const paths = pathsBetween(context.repoRoot, baseline, head);
  assertDeliveryPaths(context, config, paths, options, "Existing checkpoint");
  return { eligible: true, baseline, paths };
}

function existingLocalCommit(context, config, options) {
  const baseline = baselineHead(context);
  const head = currentHead(context.repoRoot);
  if (!baseline || baseline === head) return null;
  if (!isAncestor(context.repoRoot, baseline, head)) {
    throw new Error(`Cannot record an existing local commit: HEAD ${head} is not descended from baseline ${baseline}.`);
  }
  const paths = pathsBetween(context.repoRoot, baseline, head);
  if (!paths.length) return null;
  assertDeliveryPaths(context, config, paths, options, "Existing implementation history");
  const remoteRefs = remoteRefsContainingHead(context.repoRoot);
  if (remoteRefs === null) {
    throw new Error("Cannot record an existing local commit because remote reachability could not be checked.");
  }
  if (remoteRefs.length > 0) {
    throw new Error(`Existing implementation HEAD is already reachable from ${remoteRefs.join(", ")}; local delivery will not claim an externally pushed commit.`);
  }
  const info = commitInfo(context.repoRoot);
  return {
    committed: false,
    existing: true,
    promotedCheckpoint: false,
    commit: info.commit,
    short: info.short,
    subject: info.subject,
    staged: [],
    changed: paths,
    ignored: [],
    allowed: deliveryPathPolicy(context, config, options).allowed,
  };
}

function localStageAndCommit(context, options) {
  const repoRoot = context.repoRoot;
  const config = deliveryConfig(context, options);
  const plan = stageablePaths(context, config, options);
  assertStagedPathsArePlanned(plan, stagedPaths(repoRoot));
  if (plan.stage.length) run("git", ["add", "-A", "--", ...plan.stage], { cwd: repoRoot });
  const staged = stagedPaths(repoRoot);
  assertStagedPathsArePlanned(plan, staged);

  const checkpoint = checkpointPromotion(context, config, options);
  if (checkpoint && !checkpoint.eligible) {
    throw new Error(`Cannot promote the automatic checkpoint into the local delivery commit: ${checkpoint.reason}. Commit the implementation manually after reviewing its history.`);
  }
  if (!staged.length && !checkpoint) {
    const existing = existingLocalCommit(context, config, options);
    if (existing) return existing;
    throw new Error("Local delivery found no allowlisted implementation changes to commit. The receipt may have been finalized after the implementation was already committed.");
  }

  const message = String(options["commit-message"] || `Implement ${context.state.topicSlug || "PRD implementation"}`).trim();
  if (!message) throw new Error("--commit-message must not be empty");
  const commitArgs = ["commit"];
  if (checkpoint) commitArgs.push("--amend");
  if (options["no-gpg-sign"]) commitArgs.push("--no-gpg-sign");
  commitArgs.push("-m", message);
  run("git", commitArgs, { cwd: repoRoot });
  const info = commitInfo(repoRoot);
  return {
    committed: true,
    existing: false,
    promotedCheckpoint: Boolean(checkpoint),
    commit: info.commit,
    short: info.short,
    subject: info.subject,
    staged,
    changed: checkpoint ? Array.from(new Set([...checkpoint.paths, ...plan.changed])) : plan.changed,
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

function deliveryResultPath(context) {
  return path.join(context.stateDir, "delivery", "delivery-result.json");
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

function readDeliveryResult(context) {
  const resultPath = deliveryResultPath(context);
  if (!fs.existsSync(resultPath)) return null;
  let result;
  try {
    result = readJson(resultPath);
  } catch {
    throw new Error(`Local delivery result is not valid JSON: ${resultPath}`);
  }
  return result;
}

function localResult(context, config, freshness, commit, rules) {
  return {
    schema: "hoyeon.prd-delivery-result.v1",
    status: "committed",
    mode: "local",
    recordedAt: new Date().toISOString(),
    receipt: {
      path: toRepoRelative(context.receiptPath, context.repoRoot),
      status: context.receipt.status,
      completionFingerprint: context.receipt.completionFingerprint || null,
    },
    branch: currentBranch(context.repoRoot),
    implementationHead: commit.commit,
    commit,
    freshness: {
      verified: freshness.ok,
      violations: freshness.violations || [],
    },
    rules,
  };
}

function cmdLocal(options) {
  const context = resolveState(options);
  assertCompleteReceipt(context);
  const config = deliveryConfig(context, options);
  if (config.mode !== "local") {
    throw new Error([
      `Delivery mode is '${config.mode}', not 'local'.`,
      "Use PR delivery for a run explicitly configured for PRs, or change the reviewed delivery mode before running local.",
    ].join("\n"));
  }

  const freshness = verifyDelivery(context);
  if (!freshness.ok) {
    throw new Error([
      "Implementation state is not local-delivery-fresh:",
      ...(freshness.violations || []).map(item => `- ${item}`),
      "Return to implement, rerun affected verification and reviews, finalize a fresh receipt, then retry local delivery.",
    ].join("\n"));
  }

  const recorded = readDeliveryResult(context);
  if (recorded) {
    if (recorded.mode !== "local" || recorded.status !== "committed" || !recorded.implementationHead) {
      throw new Error(`Existing delivery result is not a completed local delivery: ${deliveryResultPath(context)}`);
    }
    const head = currentHead(context.repoRoot);
    if (recorded.implementationHead !== head) {
      throw new Error(`Local delivery result points to ${recorded.implementationHead}, but current HEAD is ${head}; reconcile the tree before retrying.`);
    }
    const dirty = gitStatus(context.repoRoot);
    if (dirty) {
      throw new Error(`Local delivery was already recorded at ${head}, but the worktree is dirty. Review or move these changes before retrying:\n${dirty}`);
    }
    process.stdout.write(JSON.stringify({
      ok: true,
      ...recorded,
      alreadyCommitted: true,
      resultPath: toRepoRelative(deliveryResultPath(context), context.repoRoot),
    }, null, 2) + "\n");
    return;
  }

  const overrides = [];
  const rules = runRulesGate(context, options, overrides);
  const commit = localStageAndCommit(context, options);
  const result = localResult(context, config, freshness, commit, { ...rules, overrides });
  writeFile(deliveryResultPath(context), JSON.stringify(result, null, 2));
  appendJsonl(shipLogPath(context), {
    ts: result.recordedAt,
    event: "local",
    mode: "local",
    implementationHead: result.implementationHead,
    commit: commit.commit,
    created: commit.committed,
    existing: Boolean(commit.existing),
    promotedCheckpoint: Boolean(commit.promotedCheckpoint),
    overrides,
    rules,
  });
  process.stdout.write(JSON.stringify({
    ok: true,
    ...result,
    alreadyCommitted: false,
    resultPath: toRepoRelative(deliveryResultPath(context), context.repoRoot),
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
    throw new Error([
      "Implementation state is not delivery-fresh:",
      ...(freshness.violations || []).map(item => `- ${item}`),
      "Return to implement, refresh verification and finalize a current receipt before delivery.",
    ].join("\n"));
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
  const checkArgs = ["rules", "check"];
  if (options.base) checkArgs.push("--base", String(options.base));
  const result = run("sasu", checkArgs, {
    cwd: context.repoRoot,
    allowFailure: true,
  });
  let report;
  try {
    report = JSON.parse(result.stdout.trim());
  } catch {
    if (options["skip-rules"]) {
      overrides.push({ kind: "rules-unreadable", reason: requireReason(options, "skip-rules") });
      return { ok: false, checked: 0, failures: [], pendingCount: 0, unreadable: true };
    }
    throw new Error(`rules check did not return a readable report:\n${result.stderr || result.stdout}\nFix the malformed rule/report, or pass --skip-rules --reason "<user-approved reason>".`);
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

function fetchPr(context, prRef) {
  const result = run("gh", [
    "pr", "view", prRef,
    "--json", "number,url,state,isDraft,mergeStateStatus,mergeable,headRefName,headRefOid,baseRefName,statusCheckRollup,mergedAt,mergeCommit",
  ], {
    cwd: context.repoRoot,
    allowFailure: true,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`Could not inspect pull request ${prRef}: ${(result.stderr || result.stdout).trim()}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`Pull request inspection did not return JSON: ${result.stdout}`);
  }
}

function mergeMethod(options) {
  const method = String(options.method || "squash").toLowerCase();
  if (!["squash", "merge", "rebase"].includes(method)) {
    throw new Error(`Unsupported merge method '${method}'. Expected squash, merge, or rebase.`);
  }
  return method;
}

function cmdMerge(options) {
  const context = resolveState(options);
  assertCompleteReceipt(context);
  const config = deliveryConfig(context, options);
  const approval = typeof options.approval === "string" ? options.approval.trim() : "";
  if (!approval) {
    throw new Error("merge requires --approval \"<verbatim user approval to merge>\"; PR creation or CI success alone is not merge approval");
  }
  const overrides = [];
  if (config.mode !== "pr") {
    if (!options["override-mode"]) {
      throw new Error([
        `Delivery mode is '${config.mode}', not 'pr'. Merge is not approved for this implementation run.`,
        "Pass --override-mode --reason \"<verbatim user approval>\" only when the user explicitly approved PR delivery after implementation.",
      ].join("\n"));
    }
    overrides.push({ kind: "mode", from: config.mode, reason: requireReason(options, "override-mode") });
  }

  const freshness = verifyDelivery(context);
  if (!freshness.ok) {
    throw new Error([
      "Implementation state is not merge-fresh:",
      ...(freshness.violations || []).map(item => `- ${item}`),
      "Return to implement, rerun verification with Fidelity and Code review, finalize a fresh receipt, then ship again.",
    ].join("\n"));
  }
  const base = baseFreshness(context.repoRoot, config.baseBranch);
  if (base.fresh !== true) {
    throw new Error(base.fresh === false
      ? `Branch is ${base.behindBy} commit(s) behind origin/${base.base}; rebase, refresh implement verification/reviews/receipt, and re-ship before merge.`
      : `Could not prove freshness against origin/${base.base}; merge fails closed until the base comparison succeeds.`);
  }
  if (currentBranch(context.repoRoot) !== config.branch) {
    throw new Error(`Current branch '${currentBranch(context.repoRoot)}' does not match delivery branch '${config.branch}'.`);
  }

  const prRef = prRefFromOptions(context, options);
  const pr = fetchPr(context, prRef);
  const headSha = currentHead(context.repoRoot);
  if (pr.state !== "OPEN") throw new Error(`Pull request is '${pr.state}', not OPEN: ${pr.url || prRef}`);
  if (pr.isDraft) throw new Error(`Pull request is still a draft: ${pr.url || prRef}`);
  if (pr.headRefName !== config.branch || pr.baseRefName !== config.baseBranch) {
    throw new Error(`Pull request branch mismatch: expected ${config.branch} -> ${config.baseBranch}, got ${pr.headRefName} -> ${pr.baseRefName}`);
  }
  if (!pr.headRefOid || pr.headRefOid !== headSha) {
    throw new Error(`Pull request head ${pr.headRefOid || "unknown"} does not match local reviewed HEAD ${headSha}; fetch and reconcile before merge.`);
  }
  if (pr.mergeable !== "MERGEABLE") {
    throw new Error(`Pull request mergeability is '${pr.mergeable || "unknown"}', not MERGEABLE: ${pr.url || prRef}`);
  }
  if (["BEHIND", "BLOCKED", "DIRTY", "DRAFT", "UNKNOWN"].includes(String(pr.mergeStateStatus || "UNKNOWN"))) {
    throw new Error(`Pull request merge state is '${pr.mergeStateStatus || "UNKNOWN"}'; resolve it before merge.`);
  }

  const checks = fetchChecks(context, pr.url || prRef);
  const ciVerdict = checks.noChecks ? "no-checks" : classifyChecks(checks.checks);
  if (!["pass", "no-checks"].includes(ciVerdict)) {
    throw new Error(`Required CI is '${ciVerdict}'. Wait for a pass or return to implement for source fixes before merge.`);
  }
  // The tree is clean by merge time; examine the PR's actual change set.
  const rules = runRulesGate(context, { base: `origin/${deliveryConfig(context, options).baseBranch}` }, []);
  const method = mergeMethod(options);
  const mergeArgs = ["pr", "merge", pr.url || prRef, `--${method}`, "--match-head-commit", headSha];
  if (options["delete-branch"]) mergeArgs.push("--delete-branch");
  run("gh", mergeArgs, { cwd: context.repoRoot });

  const mergedPr = fetchPr(context, pr.url || prRef);
  if (mergedPr.state !== "MERGED") {
    throw new Error(`GitHub did not report the pull request as MERGED after the merge command: ${mergedPr.state || "unknown"}`);
  }
  const result = {
    schema: "hoyeon.prd-delivery-result.v1",
    status: "merged",
    recordedAt: new Date().toISOString(),
    approval,
    receipt: {
      path: toRepoRelative(context.receiptPath, context.repoRoot),
      status: context.receipt.status,
    },
    branch: config.branch,
    baseBranch: config.baseBranch,
    implementationHead: headSha,
    pr: {
      number: mergedPr.number,
      url: mergedPr.url,
      mergedAt: mergedPr.mergedAt || null,
    },
    ci: {
      verdict: ciVerdict,
      checks: checks.checks || [],
      noChecks: checks.noChecks,
    },
    rules,
    overrides,
    merge: {
      method,
      commit: mergedPr.mergeCommit && mergedPr.mergeCommit.oid ? mergedPr.mergeCommit.oid : null,
      matchedHeadCommit: headSha,
    },
  };
  writeFile(deliveryResultPath(context), JSON.stringify(result, null, 2));
  appendJsonl(shipLogPath(context), {
    ts: result.recordedAt,
    event: "merge",
    pr: result.pr.url,
    ciVerdict,
    method,
    implementationHead: headSha,
    mergeCommit: result.merge.commit,
    approval,
    overrides,
  });
  const output = {
    ok: true,
    ...result,
    resultPath: toRepoRelative(deliveryResultPath(context), context.repoRoot),
  };
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

function cmdStatus(options) {
  const context = resolveState(options);
  const config = deliveryConfig(context, options);
  if (config.mode === "local") {
    process.stdout.write(JSON.stringify({
      ok: true,
      delivery: config,
      currentBranch: currentBranch(context.repoRoot),
      gitStatus: gitStatus(context.repoRoot),
      pr: null,
      deliveryResult: readDeliveryResult(context),
      error: null,
    }, null, 2) + "\n");
    return;
  }
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
    deliveryResult: fs.existsSync(deliveryResultPath(context)) ? readJson(deliveryResultPath(context)) : null,
    error: pr.status === 0 ? null : pr.stderr,
  }, null, 2) + "\n");
  if (pr.status !== 0) process.exitCode = 2;
}

main();
