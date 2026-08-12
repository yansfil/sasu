"use strict";

/** @typedef {import("./types").State} State */
/** @typedef {import("./types").ActiveRecord} ActiveRecord */

const fs = require("fs");
const path = require("path");

const { SCHEMA, ACTIVE_PATH, PRD_ROOT_REL, IMPLEMENT_ROOT_REL, nowIso, cwd, resolveProjectPath, toProjectRelative, canonicalPath, readJson, writeJson, appendJsonl, safeTimestamp } = require("./util");
const { primaryWorktreeRoot } = require("./git");
const { recordDeviation } = require("./state_data");
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

/**
 * The run's owner as the pointer reports it. The pointer mirrors
 * `state.ownerSessionId` and never records an owner of its own, so this and
 * `state.ownerSessionId` cannot disagree - see pointerOwnerStamp for the
 * incident that rule exists for.
 */
function pointerOwnerSessionId(record) {
  return normalizeSessionId(record && record.owner && record.owner.sessionId);
}

// A single active pointer per checkout (`.prd-implement-active.json`). Without a
// session id, return it as-is (statusline, prd-ship). With one, an unowned
// pointer is claimable (first-hook bootstrap) and a pointer owned by this session
// matches; a pointer owned by a different session is not this session's run.
// Concurrent runs in one checkout are not supported by design; use a worktree,
// which gets its own pointer.
function readActive(baseDir = cwd(), options = {}) {
  const active = readActiveFile(activePath(baseDir));
  if (!active) return null;
  const sessionId = normalizeSessionId(options.sessionId);
  if (!sessionId) return active;
  const owner = pointerOwnerSessionId(active.active);
  if (!owner || sameSessionId(owner, sessionId)) return active;
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
    ownerSessionId: pointerOwnerSessionId(pointer.active),
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
 * Cross-session guard for state resolved VIA the shared pointer. The question
 * it answers is "which run does this pointer name, and is it mine?" - naming a
 * run with --state answers the first half, so that path gets the narrower
 * assertPinnedAccess below instead.
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
  const ownerSessionId = pointerOwnerSessionId(record);
  const sessionId = currentSessionIdentity();
  const candidates = implementStateCandidates(baseDir);
  const pinHint = `Pass --state <path> to name the run explicitly${candidates.length ? ` (candidates: ${candidates.join(", ")})` : ""}. Add --adopt to that pinned command to take ownership of a run whose session is gone.`;
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
 * Ownership check for an explicit `--state` pin. Deliberately narrower than the
 * pointer guard: naming the run removes the "which run is this?" ambiguity that
 * the pointer guard's unverifiable-identity rule exists for, so the only
 * question left is whether this session may write to THAT run.
 *
 * Two consequences, both load-bearing:
 * - An unverifiable caller proceeds (CI, a bare shell, any process without a
 *   session env var). The pointer guard's multi-run refusal points at --state
 *   as its exit, and an exit that also refuses is a deadlock, not a guard.
 * - A foreign owner refuses, but --adopt always gets through. A run whose
 *   session is gone must stay rescuable - an honest `finalize --status blocked`
 *   can never be the thing ownership locks out.
 *
 * Until 2026-08-12 this path had no check at all: `--state` returned before the
 * guard ran, and the pointer guard's own refusal message advertised it. Measured
 * on pokemon-rpg-run-1 - the working session, refused by the pointer at 03:05:59,
 * pinned --state on every call afterwards, and each pinned write re-stamped the
 * pointer's owner (mark.js calls syncActive) while never touching the state's
 * binding. By 03:09:45 the pointer named the working session and the state still
 * named a bystander. Not one record wrong: two records of one fact, taking turns.
 */
function assertPinnedAccess(statePath, options, baseDir, accessIntent) {
  if (accessIntent === "read") return;
  let owner = null;
  try {
    owner = normalizeSessionId(readJson(statePath).ownerSessionId);
  } catch {
    // Unreadable or malformed: let the caller's own read produce the real
    // error instead of masking it with an ownership complaint.
    return;
  }
  const sessionId = currentSessionIdentity();
  if (!owner || !sessionId || sameSessionId(owner, sessionId) || options.adopt) return;
  throw new Error([
    `${toProjectRelative(statePath, baseDir)} belongs to another session.`,
    `  run owner:    session ${owner}`,
    `  this session: ${sessionId}`,
    "Refusing to mutate another session's run. Re-run with --adopt to take ownership; the handover is recorded as a deviation.",
  ].join("\n"));
}

/**
 * @param {Object} [options] parsed CLI options; supports options.state, options.adopt
 * @param {string} [baseDir]
 * @param {"mutate"|"read"} [accessIntent] guard posture; defaults to
 *   the conservative "mutate" so every caller that does not declare itself
 *   read-only gets the cross-session refusal
 */
function resolveStatePath(options = {}, baseDir = cwd(), accessIntent = "mutate") {
  if (options.state) {
    const pinned = resolveProjectPath(options.state, baseDir);
    assertPinnedAccess(pinned, options, baseDir, accessIntent);
    return pinned;
  }
  const active = readActive(baseDir);
  if (!active) throw new Error(`No active PRD implementation state found at ${ACTIVE_PATH}`);
  const statePath = resolveProjectPath(active.active.statePath, baseDir);
  assertPointerAccess(active.active, statePath, baseDir, accessIntent);
  return statePath;
}

/**
 * One owner per run, moved only deliberately.
 *
 * An unowned run is claimed by the first identified writer. This is DESIGNED,
 * not incidental: `init` from a process with no session env (CI, a bare shell)
 * must still produce a run someone can finish, so an ownerless run cannot be
 * allowed to deadlock. The cost is real and named here - until a run is claimed,
 * any session that writes to it becomes its owner, which is exactly how
 * pokemon-rpg-run-1 came to belong to a session that never started it (init
 * resolved no identity, leaving the field null; the first Stop hook to fire in
 * the checkout claimed it, and that hook belonged to a bystander). Narrowing the
 * window is init's job - resolving identity from the one shared resolver so a
 * run is owned from birth - not this function's, which must keep the escape open.
 *
 * An owned run changes hands only under --adopt, and the handover lands in
 * `state.deviations` so the record says
 * a takeover happened instead of leaving it to be inferred from who wrote last.
 *
 * The refusal already happened in resolveStatePath; this only performs what the
 * guard let through.
 */
function claimOrAdoptOwnership(state, options) {
  const sessionId = currentSessionIdentity();
  if (!sessionId) return;
  const owner = normalizeSessionId(state.ownerSessionId);
  if (sameSessionId(owner, sessionId)) return;
  if (!owner) {
    state.ownerSessionId = sessionId;
    return;
  }
  if (!options.adopt) return;
  state.ownerSessionId = sessionId;
  recordDeviation(state, "run_adopted", "RUN", `Run ownership adopted by session ${sessionId} (previous owner ${owner}).`, {
    previousSessionId: owner,
    sessionId,
  });
}

/**
 * @param {Object} [options] parsed CLI options; supports options.state, options.adopt
 * @param {string} [baseDir]
 * @param {"mutate"|"read"} [accessIntent]
 * @returns {{statePath: string, state: State}}
 */
function loadState(options = {}, baseDir = cwd(), accessIntent = "mutate") {
  const statePath = resolveStatePath(options, baseDir, accessIntent);
  const state = readJson(statePath);
  if (state.schema !== SCHEMA) throw new Error(`Unsupported state schema in ${statePath}`);
  if (accessIntent !== "read") claimOrAdoptOwnership(state, options);
  return { statePath, state };
}

// The pointer MIRRORS the run's owner; it never records an owner of its own.
//
// This used to stamp the last writer's env identity instead. That made THREE
// records of one fact - `state.activeSessionId` (write-once), this stamp
// (write-always), and the pointer's own `activeSessionId` - and the old guard
// read `owner.sessionId || activeSessionId`, so a single env-less write (a hook
// process) slid authority quietly onto the fallback.
//
// Measured 2026-08-12 on pokemon-rpg-run-1. One session drove the run start to
// finish and never received a continuation directive; a bystander session that
// started nothing received every one of them and could not act on any, because
// each record named a different session and they took turns being right
// (03:05:59 pointer said the bystander, 03:09:45 it said the worker, the state
// said the bystander throughout). Ownership now moves in exactly one place
// (claimOrAdoptOwnership) and every other site reads it.
//
// pid and startedAt stay last-writer breadcrumbs, never compared.
function pointerOwnerStamp(state) {
  return {
    sessionId: normalizeSessionId(state.ownerSessionId),
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
  // Re-registering the same path on the same owner supersedes the old entry
  // instead of appending a duplicate. The manual refresh-artifacts re-blessing
  // command was deleted as a self-certification surface, so re-running
  // record-artifact is the only supported way to clear the "hash changed"
  // completion violation after a legitimate in-place re-capture; an appended
  // duplicate would strand the stale entry's hash as a permanent violation.
  const supersededIndex = match.item.artifacts.findIndex(entry => entry && entry.path === relPath);
  const superseded = supersededIndex >= 0 ? match.item.artifacts[supersededIndex] : null;
  if (superseded) {
    // Keep the original identity and registration time; the refresh timestamp
    // records that the bytes were honestly re-inspected, not re-blessed.
    if (superseded.artifactId) artifact.artifactId = superseded.artifactId;
    if (superseded.createdAt) artifact.createdAt = superseded.createdAt;
    artifact.refreshedAt = nowIso();
    match.item.artifacts[supersededIndex] = artifact;
  } else {
    match.item.artifacts.push(artifact);
  }
  match.item.evidence.push({
    ts: nowIso(),
    text: superseded
      ? `Artifact re-recorded in place: ${artifact.kind} ${artifact.path} (${String(superseded.sha256).slice(0, 12)} -> ${artifact.sha256.slice(0, 12)}) - ${cleanDescription}`
      : `Artifact recorded: ${artifact.kind} ${artifact.path} (${artifact.sha256.slice(0, 12)}) - ${cleanDescription}`,
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
