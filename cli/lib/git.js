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

function parseGitStatusZ(output) {
  const records = String(output || "").split("\0");
  const entries = [];
  for (let index = 0; index < records.length; index += 1) {
    const raw = records[index];
    if (!raw) continue;
    const parsed = parseGitStatusEntry(raw);
    if (/[RC]/.test(parsed.status)) {
      const originalPath = records[index + 1] || "";
      if (originalPath) {
        parsed.originalPath = originalPath;
        index += 1;
      }
    }
    entries.push(parsed);
  }
  return entries;
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
  for (const parsed of parseGitStatusZ(status.stdout)) {
    if (!parsed.path) continue;
    const rel = normalizeRelPath(parsed.path);
    if (!rel || excludedPrefixes.some(prefix => rel === prefix || rel.startsWith(`${prefix}/`))) continue;
    const abs = path.join(projectRoot, rel);
    const metadata = snapshotPathMetadata(abs);
    entries.push({
      status: parsed.status,
      path: rel,
      originalPath: parsed.originalPath ? normalizeRelPath(parsed.originalPath) : null,
      sha256: metadata.sha256,
      bytes: metadata.bytes,
      kind: metadata.kind,
      executable: metadata.executable,
      symlinkTarget: metadata.symlinkTarget,
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
  const projectRoot = state.projectRoot || cwd();
  const savedByPath = new Map((savedSnapshot.entries || [])
    .map(entry => [normalizeRelPath(entry.path || ""), entry])
    .filter(([rel]) => Boolean(rel)));
  const initialByPath = new Map((((state.initialWorktreeSnapshot || {}).entries) || [])
    .map(entry => [normalizeRelPath(entry.path || ""), entry])
    .filter(([rel]) => Boolean(rel)));
  const preservedBaselinePaths = new Set();
  for (const current of currentSnapshot.entries || []) {
    const rel = normalizeRelPath(current.path || "");
    const saved = savedByPath.get(rel);
    const initial = initialByPath.get(rel);
    if (!saved || !initial
      || !snapshotEntriesEqual(saved, current)
      || !snapshotEntriesEqual(initial, current)) return false;
    preservedBaselinePaths.add(rel);
  }
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
    if (preservedBaselinePaths.has(normalizeRelPath(entry.path || ""))) continue;
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
    if (preservedBaselinePaths.has(rel)) continue;
    const abs = path.join(projectRoot, rel);
    if (!snapshotPathMatches(entry, abs)) return false;
    if (entry.originalPath
      && snapshotPathMetadata(path.join(projectRoot, normalizeRelPath(entry.originalPath))).kind !== "missing") return false;
  }
  return true;
}

function snapshotEntriesEqual(left, right) {
  return String(left && left.status || "") === String(right && right.status || "")
    && normalizeRelPath(left && left.path || "") === normalizeRelPath(right && right.path || "")
    && normalizeRelPath(left && left.originalPath || "") === normalizeRelPath(right && right.originalPath || "")
    && (left && left.sha256 || null) === (right && right.sha256 || null)
    && ((left && left.bytes) ?? null) === ((right && right.bytes) ?? null)
    && optionalSnapshotFieldEqual(left, right, "kind")
    && optionalSnapshotFieldEqual(left, right, "executable")
    && optionalSnapshotFieldEqual(left, right, "symlinkTarget");
}

function snapshotPathMetadata(abs) {
  let stats;
  try {
    stats = fs.lstatSync(abs);
  } catch (error) {
    return {
      sha256: null,
      bytes: null,
      kind: error && error.code === "ENOENT" ? "missing" : "unreadable",
      executable: undefined,
      symlinkTarget: undefined,
    };
  }
  if (stats.isSymbolicLink()) {
    const symlinkTarget = fs.readlinkSync(abs);
    try {
      const targetStats = fs.statSync(abs);
      return {
        sha256: targetStats.isFile() ? sha256File(abs) : null,
        bytes: targetStats.isFile() ? targetStats.size : null,
        kind: "symlink",
        executable: undefined,
        symlinkTarget,
      };
    } catch {
      return { sha256: null, bytes: null, kind: "symlink", executable: undefined, symlinkTarget };
    }
  }
  if (stats.isFile()) {
    return {
      sha256: sha256File(abs),
      bytes: stats.size,
      kind: "file",
      executable: Boolean(stats.mode & 0o111),
      symlinkTarget: undefined,
    };
  }
  return {
    sha256: null,
    bytes: null,
    kind: stats.isDirectory() ? "directory" : "other",
    executable: undefined,
    symlinkTarget: undefined,
  };
}

function snapshotPathMatches(snapshotEntry, abs) {
  const current = snapshotPathMetadata(abs);
  if (snapshotEntry.sha256) {
    if (current.sha256 !== snapshotEntry.sha256) return false;
    if ((snapshotEntry.bytes ?? null) !== (current.bytes ?? null)) return false;
  } else if (snapshotEntry.kind === undefined && current.kind !== "missing") {
    return false;
  }
  return optionalSnapshotFieldEqual(snapshotEntry, current, "kind")
    && optionalSnapshotFieldEqual(snapshotEntry, current, "executable")
    && optionalSnapshotFieldEqual(snapshotEntry, current, "symlinkTarget");
}

function optionalSnapshotFieldEqual(left, right, field) {
  if (!left || !right || left[field] === undefined || right[field] === undefined) return true;
  return left[field] === right[field];
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
  parseGitStatusZ,
  worktreeSnapshot,
  snapshotMaterializedInHead,
  snapshotEntriesEqual,
  snapshotPathMatches,
};
