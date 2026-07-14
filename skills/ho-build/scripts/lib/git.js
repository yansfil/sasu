"use strict";

const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");

const { ACTIVE_PATH, nowIso, cwd, runCommand, sha256File, normalizeRelPath, simpleHash } = require("./util");

function runGit(projectRoot, args, options = {}) {
  return runCommand("git", args, { ...options, cwd: projectRoot });
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

function isLinkedWorktree(projectRoot) {
  const result = childProcess.spawnSync("git", ["rev-parse", "--git-dir"], {
    cwd: projectRoot,
    shell: false,
    encoding: "utf8",
  });
  if (result.status !== 0) return false;
  return result.stdout.trim().replace(/\\/g, "/").includes("/worktrees/");
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

function snapshotMaterializedInHead(savedSnapshot, currentSnapshot, state) {
  if (!savedSnapshot || !currentSnapshot || !savedSnapshot.headSha || !currentSnapshot.headSha) return false;
  if (savedSnapshot.headSha === currentSnapshot.headSha) return false;
  if ((currentSnapshot.entries || []).length !== 0) return false;
  const projectRoot = state.projectRoot || cwd();
  const diff = childProcess.spawnSync(
    "git",
    ["diff", "--no-renames", "--name-only", "-z", savedSnapshot.headSha, currentSnapshot.headSha, "--"],
    { cwd: projectRoot, shell: false, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
  );
  if (diff.status !== 0) return false;

  const excludedPrefixes = [
    normalizeRelPath(state.runDir || ""),
    normalizeRelPath(ACTIVE_PATH),
  ].filter(Boolean);
  const allChanged = diff.stdout.split("\0").map(normalizeRelPath).filter(Boolean);
  const sourceChanged = allChanged.filter(rel =>
    !excludedPrefixes.some(prefix => rel === prefix || rel.startsWith(`${prefix}/`)));
  const expected = [];
  for (const entry of savedSnapshot.entries || []) {
    if (entry.path) expected.push(normalizeRelPath(entry.path));
    if (entry.originalPath) expected.push(normalizeRelPath(entry.originalPath));
  }
  const actualSet = new Set(sourceChanged);
  const expectedSet = new Set(expected.filter(Boolean));
  if (actualSet.size !== expectedSet.size || [...actualSet].some(rel => !expectedSet.has(rel))) return false;
  if (expectedSet.size === 0 && !allChanged.some(rel =>
    excludedPrefixes.some(prefix => rel === prefix || rel.startsWith(`${prefix}/`)))) return false;

  for (const entry of savedSnapshot.entries || []) {
    const rel = normalizeRelPath(entry.path || "");
    if (!rel) return false;
    const abs = path.join(projectRoot, rel);
    if (entry.sha256) {
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return false;
      if (sha256File(abs) !== entry.sha256) return false;
      if ((entry.bytes ?? null) !== fs.statSync(abs).size) return false;
    } else if (fs.existsSync(abs)) {
      return false;
    }
    if (entry.originalPath && fs.existsSync(path.join(projectRoot, normalizeRelPath(entry.originalPath)))) return false;
  }
  return true;
}

module.exports = {
  runGit,
  currentBranch,
  branchExists,
  isLinkedWorktree,
  gitWorktreeRoots,
  primaryWorktreeRoot,
  gitTracked,
  gitIgnored,
  parseGitStatusEntry,
  worktreeSnapshot,
  snapshotMaterializedInHead,
};
