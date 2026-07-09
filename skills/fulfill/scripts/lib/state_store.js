"use strict";

const fs = require("fs");
const path = require("path");

const { SCHEMA, ACTIVE_PATH, nowIso, cwd, resolveProjectPath, toProjectRelative, canonicalPath, readJson, writeJson, appendJsonl, safeTimestamp } = require("./util");
const { primaryWorktreeRoot } = require("./git");
const { refreshExecutionTraceMatrix, buildTaskGraph } = require("./planning");
const { artifactManifestPath, inspectArtifact, assertArtifactPathIsEvidence } = require("./artifacts");
const { writeArtifacts } = require("./render");

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

module.exports = {
  activePath,
  normalizeSessionId,
  sameSessionId,
  sessionIdFromHookPayload,
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
  activeRecordMatchesState,
  syncActive,
  persistStateAndArtifacts,
  attachArtifact,
  latestPrdSlug,
};
