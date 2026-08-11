"use strict";

const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");

const { ACTIVE_PATH, NAMESPACE_ROOT, nowIso, cwd, runCommand, sha256File, sha256Text, normalizeRelPath, simpleHash } = require("./util");
const { matchesScopeGlob } = require("./scope_match");

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

/**
 * Audit/attribution snapshot of the dirty worktree: which paths were already
 * dirty, with hashes, for receipts and foreign-change disclosure (init's
 * initialWorktreeSnapshot, review records, the finalize receipt). This is NOT
 * a freshness input - every "is this recorded PASS/review still valid?"
 * decision goes through vouchedTreeFingerprint below.
 */
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

/**
 * THE freshness fingerprint: one content-based answer to "is this recorded
 * PASS/review still vouching for the current tree?", shared by every consumer
 * (gate staleness, the Stop-hook quick guard, verify-run/oracle digest
 * guards, finalize reverification skip, fresh-pass reuse, review freshness).
 * It replaced five divergent per-consumer fingerprints whose exclusion lists
 * watched each other's bookkeeping and deadlocked (verify re-run staled the
 * review, review record staled the verify pass, forever).
 *
 * Vouched set:
 * - Scoped mode (`scopeGlobs` non-empty): files matching the run's declared
 *   Scope globs, minus the agents/ namespace.
 * - Fallback mode (no globs): the whole repo minus the agents/ namespace and
 *   the run dir.
 * - Both modes exclude the ENTIRE `agents/**` namespace (AGENTS.md invariant:
 *   nothing under agents/** belongs in a freshness fingerprint). Spec docs
 *   (`agents/prd/<slug>/**`) used to ride the fingerprint as "judged inputs",
 *   and loose `agents/*` files (agents/config.json, test plumbing) rode the
 *   fallback set too - reproduced 2026-08-11: bookkeeping-adjacent churn under
 *   agents/ moved the fingerprint, disarming the verify rerun short-circuit
 *   and staling PASSes that vouched for unchanged source. The judged
 *   documents lose nothing: the gate pins the PRD/contract and every evidence
 *   file by content hash (GateRecord.inputs), and the implement state pins the
 *   PRD via prdSnapshot.sha256, so editing them still invalidates through
 *   those pins. Excluding all of agents/** is also what makes the old
 *   circular invalidation structurally impossible: no freshness consumer ever
 *   watches another consumer's writes.
 *
 * Content-based and commit-invariant: committed files are enumerated via
 * `git ls-tree -r HEAD` (blob SHAs for free) and dirty/untracked files are
 * hashed with `git hash-object`, which applies the same content filters as
 * `git add` - so committing dirty work does NOT move the fingerprint (the
 * dirty hash equals the post-commit ls-tree blob SHA). That property is what
 * deleted the old materialized-in-head rescue machinery. Known accepted blind
 * spots, unchanged from the legacy fingerprints: gitignored drift is
 * invisible (git status does not list it), and a dirty submodule pointer is
 * pinned by presence only.
 *
 * Returns `{ vouched, entryCount, mode, scopeGlobs? }` - deliberately a
 * different key set from the legacy `{ headSha, statusHash }` so a recorded
 * legacy fingerprint is detectable and always reads as stale. Returns null
 * when the project is not a git checkout. With `includeEntries: true` the
 * per-path pairs ride along for digest-guard diffs (see stripFingerprintEntries
 * before persisting).
 */
function vouchedTreeFingerprint(options) {
  const opts = options || {};
  const projectRoot = opts.projectRoot || cwd();
  const scopeGlobs = Array.isArray(opts.scopeGlobs)
    ? Array.from(new Set(opts.scopeGlobs.map(glob => String(glob || "").trim()).filter(Boolean)))
    : [];
  const scoped = scopeGlobs.length > 0;

  // ONE exclusion: the whole agents/ namespace, in both modes (see the
  // vouched-set comment above). Two options are now inert and kept only so no
  // caller has to change: `slug` (the per-slug prd carve-out died with the
  // namespace-wide rule - the same tree must never fingerprint differently
  // depending on who asks) and `runDir`, which the harness always sets to
  // `agents/implement/<slug>` or `agents/quick/<slug>` and is therefore already
  // inside NAMESPACE_ROOT. runDir stays in the list as a cheap guard in case a
  // caller ever points a run dir outside the namespace; neither option may grow
  // new meaning without re-reading that comment.
  const excludedPrefixes = [
    normalizeRelPath(NAMESPACE_ROOT),
    normalizeRelPath(opts.runDir || ""),
  ].filter(Boolean);
  const underAny = (rel, prefixes) => prefixes.some(prefix => rel === prefix || rel.startsWith(`${prefix}/`));
  const vouches = rel => {
    if (!rel || underAny(rel, excludedPrefixes)) return false;
    if (scoped) return scopeGlobs.some(glob => matchesScopeGlob(rel, glob));
    return true;
  };

  const status = childProcess.spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: projectRoot,
    shell: false,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (status.status !== 0) return null;

  // Committed side. A failing ls-tree with a working status means an unborn
  // HEAD (no commits yet): the committed set is simply empty.
  const modeFlag = mode => (mode === "100755" ? "x" : mode === "120000" ? "l" : mode === "160000" ? "s" : "");
  const entryByPath = new Map();
  const lsTree = childProcess.spawnSync("git", ["ls-tree", "-r", "-z", "HEAD"], {
    cwd: projectRoot,
    shell: false,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (lsTree.status === 0) {
    for (const record of String(lsTree.stdout || "").split("\0")) {
      if (!record) continue;
      const tab = record.indexOf("\t");
      if (tab < 0) continue;
      const [mode, , sha] = record.slice(0, tab).split(/\s+/);
      const rel = normalizeRelPath(record.slice(tab + 1));
      if (!sha || !vouches(rel)) continue;
      entryByPath.set(rel, `${sha}${modeFlag(mode)}`);
    }
  }

  // Dirty overlay: every status-listed vouched path is re-derived from the
  // worktree - the ls-tree entry is dropped and, when the path still exists,
  // its current content is hashed. Deletions simply drop out; renames list
  // both sides, so the old path drops and the new one is hashed.
  const dirtyPaths = new Set();
  for (const parsed of parseGitStatusZ(status.stdout)) {
    for (const raw of [parsed.path, parsed.originalPath]) {
      const rel = raw ? normalizeRelPath(raw) : "";
      if (!rel || !vouches(rel)) continue;
      entryByPath.delete(rel);
      dirtyPaths.add(rel);
    }
  }
  const toBatchHash = [];
  for (const rel of [...dirtyPaths].sort()) {
    const abs = path.join(projectRoot, rel);
    let stats;
    try {
      stats = fs.lstatSync(abs);
    } catch {
      continue; // deleted: drops out of the vouched set
    }
    if (stats.isFile()) {
      toBatchHash.push({ rel, flag: stats.mode & 0o111 ? "x" : "" });
    } else if (stats.isSymbolicLink()) {
      // git's blob for a symlink is the link target string; hash-object on the
      // path would follow the link, so hash the target text via --stdin.
      let target = null;
      try {
        target = fs.readlinkSync(abs);
      } catch {
        target = null;
      }
      if (target === null) continue;
      const hashed = childProcess.spawnSync("git", ["hash-object", "--stdin"], {
        cwd: projectRoot,
        shell: false,
        encoding: "utf8",
        input: target,
      });
      if (hashed.status === 0) entryByPath.set(rel, `${hashed.stdout.trim()}l`);
    } else {
      // Directory (dirty submodule) or other unhashable kind: pin presence so
      // appearing/disappearing still registers.
      entryByPath.set(rel, `unhashable:${stats.isDirectory() ? "dir" : "other"}`);
    }
  }
  if (toBatchHash.length) {
    // Batched for performance; --stdin-paths applies the same convert-to-git
    // filters as `git add`, which is what makes the fingerprint survive the
    // commit of this exact content.
    const hashed = childProcess.spawnSync("git", ["hash-object", "--stdin-paths"], {
      cwd: projectRoot,
      shell: false,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      input: toBatchHash.map(file => file.rel).join("\n"),
    });
    const shas = hashed.status === 0 ? hashed.stdout.trim().split("\n") : [];
    if (hashed.status === 0 && shas.length === toBatchHash.length) {
      toBatchHash.forEach((file, index) => entryByPath.set(file.rel, `${shas[index]}${file.flag}`));
    } else {
      // Batch anomaly (e.g. a path git could not read): fall back per file so
      // one odd path degrades to a presence pin instead of poisoning the set.
      for (const file of toBatchHash) {
        const single = childProcess.spawnSync("git", ["hash-object", "--", file.rel], {
          cwd: projectRoot,
          shell: false,
          encoding: "utf8",
        });
        entryByPath.set(file.rel, single.status === 0 ? `${single.stdout.trim()}${file.flag}` : "unhashable:unreadable");
      }
    }
  }

  const pairs = [...entryByPath.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return {
    vouched: simpleHash(JSON.stringify(pairs)),
    entryCount: pairs.length,
    mode: scoped ? "scoped" : "fallback",
    ...(scoped ? { scopeGlobs } : {}),
    // Per-path evidence for digest-guard diffs, opt-in only: the [path, blob]
    // pairs are computed above either way (only their JSON hash was kept), so
    // retaining them costs nothing at capture time - but they are large, so
    // the default return shape stays byte-identical and callers that persist
    // a fingerprint strip them first (stripFingerprintEntries).
    ...(opts.includeEntries ? { entries: pairs } : {}),
  };
}

/**
 * A fingerprint safe to persist: identical to the input minus the opt-in
 * `entries` payload, which exists to be diffed at violation time, never to be
 * written into state files or artifacts (thousands of paths per snapshot).
 */
function stripFingerprintEntries(fingerprint) {
  if (!fingerprint || typeof fingerprint !== "object" || !("entries" in fingerprint)) return fingerprint;
  const { entries, ...rest } = fingerprint;
  return rest;
}

/**
 * Which vouched paths moved between two fingerprints captured with
 * `includeEntries: true`. Returns null when either side carries no entries
 * (legacy or default-shape fingerprints): "unknown" must stay distinguishable
 * from "no differences" so a guard never reports a clean diff it cannot see.
 */
function vouchedFingerprintDiff(before, after) {
  if (!before || !Array.isArray(before.entries) || !after || !Array.isArray(after.entries)) return null;
  const beforeByPath = new Map(before.entries);
  const afterByPath = new Map(after.entries);
  const added = [];
  const removed = [];
  const changed = [];
  for (const [rel, blob] of afterByPath) {
    if (!beforeByPath.has(rel)) added.push(rel);
    else if (beforeByPath.get(rel) !== blob) changed.push(rel);
  }
  for (const rel of beforeByPath.keys()) {
    if (!afterByPath.has(rel)) removed.push(rel);
  }
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

/**
 * One bounded rendering of a fingerprint diff for every digest-guard consumer
 * (verify-run, oracle-run, gate oracles, finalize reverification), so the
 * "name the violating paths" contract cannot drift per site. `paths` is capped
 * for persistence (fallback-mode churn can touch thousands of files), `text`
 * is capped tighter for messages; both carry the true total.
 */
function summarizeFingerprintDiff(before, after, options = {}) {
  const diff = vouchedFingerprintDiff(before, after);
  if (diff === null) return null;
  const labeled = [
    ...diff.changed.map(rel => `~${rel}`),
    ...diff.added.map(rel => `+${rel}`),
    ...diff.removed.map(rel => `-${rel}`),
  ];
  const textLimit = options.textLimit || 5;
  const pathsLimit = options.pathsLimit || 20;
  const shown = labeled.slice(0, textLimit);
  return {
    total: labeled.length,
    paths: labeled.slice(0, pathsLimit),
    text: labeled.length === 0
      ? "no vouched-path difference recorded"
      : `${shown.join(", ")}${labeled.length > shown.length ? ` (+${labeled.length - shown.length} more)` : ""}`,
  };
}

/**
 * Run-level scope for an implement run: the union of every task's declared
 * Scope globs, but only when EVERY task declared one - a partial union would
 * blind the fingerprint to the undeclared tasks' writes, so any Scope-less
 * task drops the whole run to fallback mode. Mirrors the verify gate's
 * scopeForLane rule for partial declarations.
 */
function runScopeGlobs(state) {
  const tasks = Array.isArray(state && state.tasks) ? state.tasks : [];
  if (!tasks.length) return null;
  const globs = [];
  for (const task of tasks) {
    const taskGlobs = Array.isArray(task && task.scopeGlobs) ? task.scopeGlobs.filter(Boolean) : [];
    if (!taskGlobs.length) return null;
    globs.push(...taskGlobs);
  }
  return globs;
}

/** vouchedTreeFingerprint keyed off an implement state object (the lib-side callers' shape). */
function vouchedTreeFingerprintForState(state, options) {
  const source = state || {};
  return vouchedTreeFingerprint({
    projectRoot: source.projectRoot || cwd(),
    runDir: source.runDir || null,
    slug: source.topicSlug || null,
    scopeGlobs: runScopeGlobs(source),
    includeEntries: Boolean(options && options.includeEntries),
  });
}

/**
 * The one comparison rule for recorded-vs-current fingerprints: match only on
 * an identical non-empty `vouched` hash. Anything else - a legacy
 * `{ headSha, statusHash }` record, a missing/null/malformed value - is NOT a
 * match, so every legacy or damaged record degrades to stale/re-run, never to
 * a crash and never to accidentally-fresh.
 */
function vouchedFingerprintsMatch(recorded, current) {
  return Boolean(
    recorded && typeof recorded === "object"
    && current && typeof current === "object"
    && typeof recorded.vouched === "string" && recorded.vouched !== ""
    && recorded.vouched === current.vouched,
  );
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

/**
 * Machine-generated dependency lockfiles, by basename, at any depth. They are
 * enormous, carry no evidence for any acceptance criterion, and in the audited
 * run (2026-08) a nested app/pnpm-lock.yaml alone was worth tens of thousands
 * of diff chars that crowded the code out of the judge's window.
 */
const DIFF_EXCLUDED_LOCKFILES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "composer.lock",
  "Gemfile.lock",
];

/**
 * The single exclusion predicate for the judge's diff, applied to BOTH sides
 * (tracked pathspecs and the untracked listing - they previously disagreed,
 * and agents/prd + agents/interview leaked into the tracked diff). The whole
 * agents/ namespace is out: the PRD, qa-log, contract, and evidence artifacts
 * are already pinned as gate inputs, and the gate's own past verdict JSONs
 * sort alphabetically ahead of most app code, so replaying any of it into the
 * diff shows the judge documents instead of the change under judgment.
 */
function isExcludedFromDiff(file) {
  const normalized = String(file || "").replace(/\\/g, "/");
  if (normalized === "agents" || normalized.startsWith("agents/")) return true;
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  return DIFF_EXCLUDED_LOCKFILES.includes(base);
}

/** The same exclusions as git pathspecs, so the tracked diff is curated by git itself. */
const DIFF_EXCLUDE_PATHSPECS = [
  ":(exclude)agents",
  ...DIFF_EXCLUDED_LOCKFILES.map(name => `:(glob,exclude)**/${name}`),
];

/**
 * The change under judgment, including files the run created.
 *
 * `git diff` only knows about tracked paths, so a new module - the most common
 * shape of a small task - would be invisible to the judge, and a run that only
 * adds files would produce no diff at all. Untracked files are therefore
 * rendered as add-diffs and appended. Both sides are curated by
 * isExcludedFromDiff (see its comment for what is out and why).
 *
 * Lives in lib rather than in the gate's TypeScript because it is now read
 * twice: the gate produces the diff it judges, and the freshness consumers
 * reproduce it to ask whether that judgment still describes the tree. Two
 * copies of this rule would be the freshness deadlock again (PRINCIPLES item
 * 3), and the Stop hook must be able to ask without a dist build.
 */
function judgedDiff(projectRoot, baseRef) {
  const tracked = childProcess.spawnSync("git", ["diff", baseRef || "HEAD", "--", ".", ...DIFF_EXCLUDE_PATHSPECS], {
    cwd: projectRoot,
    shell: false,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (tracked.status !== 0) return null;
  const listed = childProcess.spawnSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: projectRoot,
    shell: false,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (listed.status !== 0) return null;
  const additions = [];
  for (const file of String(listed.stdout || "").split("\0")) {
    if (file === "" || isExcludedFromDiff(file)) continue;
    // --no-index exits 1 when the files differ, which is always here, so the
    // payload is on stdout either way.
    const added = childProcess.spawnSync("git", ["diff", "--no-index", "--", "/dev/null", file], {
      cwd: projectRoot,
      shell: false,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    const stdout = String(added.stdout || "");
    if (stdout.trim() !== "") additions.push(stdout);
  }
  return [String(tracked.stdout || ""), ...additions].filter(part => part.trim() !== "").join("\n");
}

/**
 * What a verify verdict vouches for: the sha256 of the exact diff the judge was
 * shown, against the base the verdict recorded.
 *
 * This replaced the gate's vouched tree fingerprint. The fingerprint answered
 * "did any file in the run's scope change", which is a different question from
 * the one the verdict actually answered, and it answered it differently
 * depending on who asked: the gate recorded it in fallback mode (whole repo)
 * while the reviews recorded it scoped, so unrelated churn killed a gate PASS
 * that vouched for untouched code - the exact thing cli/lib/git.js already
 * claims cannot happen ("the same tree must never fingerprint differently
 * depending on who asks", see vouchedTreeFingerprint). Measured 2026-08-11 on
 * project modakbul: gate {vouched 45644585, 535 entries, fallback} against
 * reviews {vouched bd743ad6, 57 entries, scoped} on one tree.
 *
 * Pinning the diff body instead covers exactly what was judged, no more and no
 * less: untracked files ride along as add-diffs, files that declare no `Scope:`
 * are included (a scope pin structurally cannot see those - the reason
 * unscopedFiles warnings exist), and a per-lane slice of an identical diff is
 * itself identical, so lane scoping needs no separate pin.
 *
 * Accepted blind spot, named because it is a real narrowing: a change confined
 * to files isExcludedFromDiff filters out - the agents/** namespace and
 * dependency lockfiles - no longer stales a PASS. The namespace is bookkeeping
 * that must never be a freshness input (AGENTS.md), and a lockfile the judge
 * never saw cannot change a semantic verdict; command-backed verification gets
 * its own re-run on the final tree at finalize, which is where a lockfile
 * change would actually show up. Gitignored drift stays invisible, unchanged
 * from the fingerprint it replaces.
 */
function judgedDiffSha256(projectRoot, baseRef) {
  const diff = judgedDiff(projectRoot, baseRef);
  return diff === null ? null : judgedDiffHash(diff);
}

/**
 * Hash a diff the caller already has. The gate records the pin from the exact
 * string it handed the judge (which may be the injected test seam, with no git
 * provenance to reproduce), while the freshness consumers reproduce the diff
 * first - so both must reach this one function or the pin and its comparison
 * can drift while looking identical.
 *
 * Hashes a canonical form rather than the string itself, to keep the property
 * the vouched tree fingerprint had and must not lose: committing the dirty work
 * does not move the pin. Measured 2026-08-11 - committing an untracked file
 * changes the assembled diff by exactly one character, the "\n" that joins the
 * add-diff section onto the tracked section, because git then emits both from
 * one `git diff`; a commit can also reorder the two sections, since untracked
 * add-diffs are appended while git sorts its own output by path. Both are
 * presentation, not content, so the canonical form is the file blocks trimmed
 * and sorted. Losing commit-invariance here would resurrect the
 * materialize-in-HEAD rescue machinery that property deleted.
 *
 * A body line that literally reads `diff --git ...` splits a block spuriously,
 * which costs nothing: the same text splits the same way on both sides of the
 * comparison, so identity - the only thing being asked - still holds.
 */
function judgedDiffHash(diffText) {
  const blocks = String(diffText || "")
    .split(/(?=^diff --git )/m)
    .map(block => block.trim())
    .filter(Boolean)
    .sort();
  return sha256Text(blocks.join("\n"));
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
  isExcludedFromDiff,
  judgedDiff,
  judgedDiffHash,
  judgedDiffSha256,
  vouchedTreeFingerprint,
  vouchedTreeFingerprintForState,
  vouchedFingerprintsMatch,
  stripFingerprintEntries,
  vouchedFingerprintDiff,
  summarizeFingerprintDiff,
  snapshotEntriesEqual,
};
