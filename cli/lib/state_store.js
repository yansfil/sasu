"use strict";

/** @typedef {import("./types").State} State */
/** @typedef {import("./types").ActiveRecord} ActiveRecord */

const fs = require("fs");
const path = require("path");

const { SCHEMA, ACTIVE_PATH, PRD_ROOT_REL, IMPLEMENT_ROOT_REL, nowIso, cwd, resolveProjectPath, toProjectRelative, canonicalPath, readJson, writeJson, appendJsonl, safeTimestamp } = require("./util");
const { primaryWorktreeRoot } = require("./git");
const { artifactManifestPath, inspectArtifact, assertArtifactPathIsEvidence } = require("./artifacts");

function activePath(baseDir = cwd()) {
  return path.join(baseDir, ACTIVE_PATH);
}

// Session ids arrive from Codex, Claude Code, or OpenCode; legacy state files
// may hold `codex:`-prefixed values. Canonicalize to the bare id so the same
// session compares equal regardless of which runtime supplied it.
function normalizeSessionId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^(codex|claude|opencode):/, "");
  return trimmed || null;
}

function sameSessionId(a, b) {
  const left = normalizeSessionId(a);
  return left !== null && left === normalizeSessionId(b);
}

function sessionIdFromHookPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  return normalizeSessionId(payload.session_id || payload.sessionId);
}

// Session identity of the current process environment. CLI commands run inside
// the agent session's shell, so these variables are the only identity a
// harness process has (hooks get theirs from the hook payload instead).
// CODEX_* and CLAUDE_SESSION_ID mirror the fallback chain `init --session-id`
// already reads; CLAUDE_CODE_SESSION_ID is Claude Code's per-session id,
// present in every Bash tool process.
const SESSION_ID_ENV_KEYS = ["CODEX_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID"];

function currentSessionIdentity(env = process.env) {
  for (const key of SESSION_ID_ENV_KEYS) {
    const value = normalizeSessionId(env[key]);
    if (value) return value;
  }
  return null;
}

function readActiveFile(file) {
  if (!fs.existsSync(file)) return null;
  const active = readJson(file);
  if (!active || typeof active.statePath !== "string") return null;
  return { file, active };
}

// A single active pointer per checkout (`.prd-implement-active.json`). Without a
// session id, return it as-is (statusline, prd-ship). With one, an unbound
// pointer is claimable (first-hook bootstrap) and a pointer bound to this session
// matches; a pointer bound to a different session is not this session's run.
// Concurrent runs in one checkout are not supported by design; use a worktree,
// which gets its own pointer.
function readActive(baseDir = cwd(), options = {}) {
  const active = readActiveFile(activePath(baseDir));
  if (!active) return null;
  const sessionId = normalizeSessionId(options.sessionId);
  if (!sessionId) return active;
  if (!active.active.activeSessionId || sameSessionId(active.active.activeSessionId, sessionId)) return active;
  return null;
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
  // Keep the first claim time while the same session refreshes its own
  // pointer; a different writer re-stamps (ownership follows the last writer).
  const previous = readActiveFile(activePath(baseDir));
  if (previous && previous.active.owner && record.owner
    && previous.active.owner.startedAt
    && sameSessionId(previous.active.owner.sessionId, record.owner.sessionId)) {
    record.owner.startedAt = previous.active.owner.startedAt;
  }
  writeJson(activePath(baseDir), record);
  return record;
}

function activeRecordStatePath(active, baseDir) {
  if (!active || typeof active.statePath !== "string") return null;
  return canonicalPath(resolveProjectPath(active.statePath, baseDir));
}

function removeActiveRecordForState(baseDir, statePath) {
  const removed = [];
  const target = canonicalPath(statePath);
  const pointerPath = activePath(baseDir);
  const pointer = readActiveFile(pointerPath);
  if (pointer && activeRecordStatePath(pointer.active, baseDir) === target) {
    fs.rmSync(pointerPath, { force: true });
    removed.push(pointerPath);
  }
  return removed;
}

function activeDiagnostics(baseDir, selectedStatePath) {
  const selected = canonicalPath(selectedStatePath);
  const pointer = readActiveFile(activePath(baseDir));
  const warnings = [];
  const info = pointer ? {
    file: toProjectRelative(pointer.file, baseDir),
    statePath: pointer.active.statePath,
    activeSessionId: pointer.active.activeSessionId || null,
    status: pointer.active.status || null,
    updatedAt: pointer.active.updatedAt || null,
    selected: activeRecordStatePath(pointer.active, baseDir) === selected,
  } : null;
  if (info && !info.selected) warnings.push("Active pointer does not match the selected state");
  return { baseDir, pointer: info, warnings };
}

// Implementation state files reachable under agents/implement/ (one directory
// per run; dot-entries are the pointer file and session bookkeeping, never
// runs). These are the candidates a refusal message offers for --state.
function implementStateCandidates(baseDir) {
  const root = path.join(baseDir, IMPLEMENT_ROOT_REL);
  const candidates = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return candidates;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const stateFile = path.join(root, entry.name, "state.json");
    if (fs.existsSync(stateFile)) candidates.push(toProjectRelative(stateFile, baseDir));
  }
  return candidates.sort();
}

/**
 * Cross-session pointer guard, applied only when state is resolved VIA the
 * shared pointer (an explicit --state pin is always honored).
 *
 * Live evidence this exists for: two concurrent sessions in one checkout.
 * Session P ran `init` (pointer -> pokemon); session T's later activity
 * re-pointed the shared pointer back to tetris; P's next UN-pinned
 * `reconcile`/`status` then silently operated on TETRIS state and only
 * no-op'd by luck. The agent survived by manually pinning --state on every
 * call - discipline where code should refuse.
 *
 * Rules, in order:
 * 1. Writer identity known on both sides and equal -> proceed (single-session
 *    UX unchanged, even with several runs in the checkout).
 * 2. Known on both sides and different -> a mutating command hard-errors
 *    naming both runs; a read-only command warns on stderr and proceeds.
 * 3. Identity unknowable on either side -> mutating commands refuse only when
 *    MORE THAN ONE state dir exists (the pointer might name someone else's
 *    run); zero or one run keeps the historical behavior.
 */
function assertPointerAccess(record, statePath, baseDir, accessIntent) {
  const readOnly = accessIntent === "read";
  const ownerSessionId = normalizeSessionId((record.owner && record.owner.sessionId) || record.activeSessionId);
  const sessionId = currentSessionIdentity();
  const candidates = implementStateCandidates(baseDir);
  const pinHint = `Pass --state <path> to name the run explicitly${candidates.length ? ` (candidates: ${candidates.join(", ")})` : ""}.`;
  if (ownerSessionId && sessionId) {
    if (sameSessionId(ownerSessionId, sessionId)) return;
    const message = [
      `Active pointer ${ACTIVE_PATH} belongs to another session.`,
      `  pointer owner: session ${ownerSessionId} -> ${toProjectRelative(statePath, baseDir)}`,
      `  this session:  ${sessionId}`,
      readOnly
        ? "Reading that session's state anyway; this output may describe a run this session does not own."
        : `Refusing to mutate another session's run through the shared pointer. ${pinHint}`,
    ].join("\n");
    if (readOnly) {
      process.stderr.write(`Warning: ${message}\n`);
      return;
    }
    throw new Error(message);
  }
  if (readOnly) return;
  if (candidates.length > 1) {
    throw new Error([
      `Active pointer ownership cannot be verified (no session identity available) and ${candidates.length} implementation states exist under ${IMPLEMENT_ROOT_REL}.`,
      `The pointer currently names ${toProjectRelative(statePath, baseDir)}, which may be another session's run.`,
      pinHint,
    ].join("\n"));
  }
}

/**
 * @param {Object} [options] parsed CLI options; supports options.state
 * @param {string} [baseDir]
 * @param {"mutate"|"read"} [accessIntent] pointer-guard posture; defaults to
 *   the conservative "mutate" so every caller that does not declare itself
 *   read-only gets the cross-session refusal
 */
function resolveStatePath(options = {}, baseDir = cwd(), accessIntent = "mutate") {
  if (options.state) return resolveProjectPath(options.state, baseDir);
  const active = readActive(baseDir);
  if (!active) throw new Error(`No active PRD implementation state found at ${ACTIVE_PATH}`);
  const statePath = resolveProjectPath(active.active.statePath, baseDir);
  assertPointerAccess(active.active, statePath, baseDir, accessIntent);
  return statePath;
}

/**
 * @param {Object} [options] parsed CLI options; supports options.state
 * @param {string} [baseDir]
 * @param {"mutate"|"read"} [accessIntent]
 * @returns {{statePath: string, state: State}}
 */
function loadState(options = {}, baseDir = cwd(), accessIntent = "mutate") {
  const statePath = resolveStatePath(options, baseDir, accessIntent);
  const state = readJson(statePath);
  if (state.schema !== SCHEMA) throw new Error(`Unsupported state schema in ${statePath}`);
  return { statePath, state };
}

// Ownership stamp for the pointer: the identity of the LAST WRITER. The
// writer's own env identity wins (a session pinning --state onto a run
// re-points the pointer to itself - ownership follows the last legitimate
// writer); env-less writers (hook processes) fall back to the run's bound
// session, which is the identity the hook just adopted or matched. pid and
// startedAt are debugging breadcrumbs, never compared.
function pointerOwnerStamp(state) {
  return {
    sessionId: currentSessionIdentity() || normalizeSessionId(state.activeSessionId),
    pid: process.pid,
    startedAt: nowIso(),
  };
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
    owner: pointerOwnerStamp(state),
    updatedAt: nowIso(),
  };
}

/**
 * @param {string} statePath
 * @param {State} state
 */
function syncActive(statePath, state) {
  for (const root of activeRootsForState(state)) {
    writeActiveRecord(root, statePath, state);
  }
}

/**
 * Single write path for state.json, the run's only machine record; `status`
 * renders it on demand instead of any derived view files.
 * @param {string} statePath
 * @param {State} state
 */
function persistState(statePath, state) {
  // Every real mutation command flows through here, so progress on the run
  // implicitly resumes a paused stop-hook loop (see commands/lifecycle.js).
  if (state.paused) delete state.paused;
  writeJson(statePath, state);
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

function latestPrdSlug(projectRoot) {
  let latest = null;
  const prdRoot = path.join(projectRoot, PRD_ROOT_REL);
  if (!fs.existsSync(prdRoot)) return null;
  for (const entry of fs.readdirSync(prdRoot)) {
    const prdFile = path.join(prdRoot, entry, "prd.md");
    if (!fs.existsSync(prdFile)) continue;
    const mtime = fs.statSync(prdFile).mtimeMs;
    if (!latest || mtime > latest.mtime) latest = { slug: entry, mtime };
  }
  return latest ? latest.slug : null;
}

module.exports = {
  activePath,
  normalizeSessionId,
  sameSessionId,
  sessionIdFromHookPayload,
  currentSessionIdentity,
  implementStateCandidates,
  readActiveFile,
  readActive,
  activeRootsForState,
  writeActiveRecord,
  activeRecordStatePath,
  removeActiveRecordForState,
  activeDiagnostics,
  resolveStatePath,
  loadState,
  activeRecordForState,
  syncActive,
  persistState,
  attachArtifact,
  latestPrdSlug,
};
