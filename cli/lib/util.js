"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const childProcess = require("child_process");

// Bumped when the persisted shape changes incompatibly. v2 moved executor
// fields onto `state.tasks` and dropped the execution-node and taskGraph
// layers; loadState and the hooks reject older files rather than misread them.
const SCHEMA = "hoyeon.prd-implement.state.v2";

// Single source of truth for where harness artifacts live inside a target
// project. Every path the harness builds must derive from these constants;
// scattered literals make namespace migrations unsafe.
//
// `agents/` is the visible agent namespace: prd/ and rules/ are committed,
// implement/ is runtime state and stays gitignored.
// Projects whose codebase already owns an `agents/` directory can move the
// harness namespace with `namespace.root` in the pipeline config. The config
// file itself stays at a fixed bootstrap location (agents/config.json) so the
// override can be found at all; harness commands read it relative to the
// working directory, which is always the project root.
function readNamespaceOverride() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(process.cwd(), "agents", "config.json"), "utf8"));
    const root = parsed && parsed.namespace && typeof parsed.namespace.root === "string"
      ? parsed.namespace.root.trim()
      : "";
    if (root && /^[A-Za-z0-9._-]+$/.test(root)) return root;
  } catch {
    // Missing or invalid config falls back to the default namespace.
  }
  return null;
}

const NAMESPACE_ROOT = readNamespaceOverride() || "agents";
const PRD_ROOT_REL = path.join(NAMESPACE_ROOT, "prd");
const IMPLEMENT_ROOT_REL = path.join(NAMESPACE_ROOT, "implement");
const SESSIONS_DIR_REL = path.join(IMPLEMENT_ROOT_REL, ".prd-implement-sessions");
const RULES_ROOT_REL = path.join(NAMESPACE_ROOT, "rules");

const ACTIVE_PATH = path.join(IMPLEMENT_ROOT_REL, ".prd-implement-active.json");

const PROJECT_CONFIG_PATH = path.join("agents", "config.json");

function runDirRelFor(slug) {
  return path.join(IMPLEMENT_ROOT_REL, slug);
}

const DEFAULT_HOOK_TIMEOUT_MS = 9000;

// The harness is installed under more than one skills root (~/.codex/skills,
// ~/.claude/skills) with runtime-specific directory names. Every emitted
// command and sibling-script lookup must derive from the invoked script path,
// never from a hardcoded install location.
const SELF_PATH = path.resolve(process.argv[1] || __filename);

function displayPath(absPath) {
  const home = os.homedir();
  return absPath === home || absPath.startsWith(home + path.sep)
    ? `~${absPath.slice(home.length)}`
    : absPath;
}

function harnessCommand() {
  return `node ${displayPath(SELF_PATH)}`;
}

// Resolve a sibling skill's script against the invoked path first so emitted
// paths match the current install, then fall back through the symlink target
// to the repo layout.
function siblingSkillScript(skillDir, scriptName) {
  const roots = [path.dirname(path.dirname(path.dirname(SELF_PATH)))];
  try {
    roots.push(path.dirname(path.dirname(path.dirname(fs.realpathSync(SELF_PATH)))));
  } catch {
    // Keep the argv-based root only.
  }
  for (const root of roots) {
    const candidate = path.join(root, skillDir, "scripts", scriptName);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(roots[0], skillDir, "scripts", scriptName);
}

function shipScriptPath() {
  return siblingSkillScript("ship", "prd_ship.js");
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

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(String(text || "")).digest("hex");
}

function simpleHash(text) {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(index);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function normalizeRelPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/g, "");
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

function writeMarkdown(file, body) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, body.endsWith("\n") ? body : `${body}\n`);
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

module.exports = {
  SCHEMA,
  NAMESPACE_ROOT,
  PRD_ROOT_REL,
  IMPLEMENT_ROOT_REL,
  SESSIONS_DIR_REL,
  RULES_ROOT_REL,
  runDirRelFor,
  ACTIVE_PATH,
  PROJECT_CONFIG_PATH,
  DEFAULT_HOOK_TIMEOUT_MS,
  SELF_PATH,
  displayPath,
  harnessCommand,
  siblingSkillScript,
  shipScriptPath,
  parseIdList,
  nowIso,
  cwd,
  resolveProjectPath,
  toProjectRelative,
  canonicalPath,
  ensureDir,
  readJson,
  writeJson,
  appendJsonl,
  safeTimestamp,
  shellQuote,
  formatCommandArgs,
  commandArgsForCompare,
  runCommand,
  stringArray,
  commandArray,
  safeBranchSegment,
  sha256File,
  sha256Text,
  simpleHash,
  escapeRegExp,
  firstSentence,
  uniqueMatches,
  normalizeRelPath,
  listFilesRecursive,
  writeMarkdown,
  slugFromPrdPath,
  slugify,
  parseArgs,
};
