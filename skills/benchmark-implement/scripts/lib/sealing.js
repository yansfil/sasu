"use strict";

// The sealing boundary.
//
// The scoring specification for a v3 case must be unreachable from inside the
// run. Two things enforce that, and both are needed:
//
//   1. The manifest resolves outside the project root, checked through realpath
//      so a symlink cannot smuggle an inside path out or an outside path in.
//   2. No blob anywhere in the repository carries the sealed schema.
//
// Check 2 is a history scan, not a worktree scan, and the difference is the
// whole point. Measured 2026-08-30 on a scratch repository: after committing a
// sealed manifest and then committing its deletion, `git ls-tree -r HEAD` no
// longer lists the path and `git grep` in the worktree finds nothing - yet
// `git show HEAD~1:<path>` returns the file verbatim. A worktree scan would
// have called that case sealed. `git log --all -S` finds both the commit that
// added it and the commit that removed it, so that is the instrument used here.
//
// The manifest is also hash-bound. Confidentiality without integrity is the
// SWE-Lancer failure: the specification was locked but could still be
// overwritten. The hash is recorded when the run is prepared and rechecked when
// the report is produced.

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { SEALED_SCHEMA, validateSealedManifest } = require("./case_contract.js");

function git(root, args) {
  const result = childProcess.spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return result;
}

function realpathOrSelf(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    // A manifest that does not exist yet still has to be judged on where it
    // would land, so fall back to the resolved parent plus the basename.
    const parent = path.dirname(target);
    try {
      return path.join(fs.realpathSync(parent), path.basename(target));
    } catch {
      return path.resolve(target);
    }
  }
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// Resolves the declared sealed path and refuses anything that lands inside the
// project. Both sides go through realpath: comparing unresolved strings would
// accept `outside/../inside` and a symlink pointing back into the repository.
function resolveSealedPath(projectRoot, sealedPath, label = "case.sealedPath") {
  if (typeof sealedPath !== "string" || !sealedPath.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  const expanded = sealedPath.startsWith("~")
    ? path.join(process.env.HOME || "", sealedPath.slice(1))
    : sealedPath;
  const absolute = path.resolve(projectRoot, expanded);
  const resolvedRoot = realpathOrSelf(projectRoot);
  const resolved = realpathOrSelf(absolute);
  if (isInside(resolvedRoot, resolved)) {
    throw new Error(
      `${label} must resolve outside the project root; ${resolved} is inside ${resolvedRoot}`,
    );
  }
  return resolved;
}

function hashFile(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// Loads, validates and hashes the manifest in one step so no caller can hold a
// manifest it has not hashed or a hash it has not validated.
function loadSealedManifest(projectRoot, sealedPath, { caseId } = {}) {
  const resolved = resolveSealedPath(projectRoot, sealedPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`sealed manifest not found: ${resolved}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (error) {
    throw new Error(`sealed manifest is not valid JSON: ${error.message}`);
  }
  const manifest = validateSealedManifest(parsed, { caseId });
  return { manifest, resolvedPath: resolved, hash: hashFile(resolved) };
}

// Every place a sealed blob could still be read from inside the repository:
// any commit on any ref, the index, the working tree, and untracked files. An
// untracked copy counts - it is one `git add -f` from being committed and is
// readable by the run right now either way.
//
// The scan runs in two stages on purpose. Stage one finds every blob that
// mentions the sealed schema; stage two keeps only the ones that actually are a
// manifest - a JSON document whose top-level `schema` is the sealed schema.
// Without stage two the harness's own source and tests would register as leaks
// merely for naming the constant, and a check that cries wolf on its own
// implementation gets switched off. Keying on the document's shape rather than
// on how some file happened to spell the string is also what keeps this from
// being a detector tuned to one sample (AGENTS.md Review Guide 11).
function isSealedManifestBlob(text, needle) {
  if (!text || !text.includes(needle)) return false;
  try {
    const parsed = JSON.parse(text);
    return Boolean(parsed) && typeof parsed === "object" && parsed.schema === needle;
  } catch {
    return false;
  }
}

function showBlob(projectRoot, revision) {
  const result = git(projectRoot, ["show", revision]);
  return result.status === 0 ? result.stdout : null;
}

function scanRepositoryForSealedSchema(projectRoot, { needle = SEALED_SCHEMA } = {}) {
  const leaks = [];

  const history = git(projectRoot, ["log", "--all", "--format=COMMIT %H", "--name-only", `-S${needle}`]);
  if (history.status !== 0) {
    throw new Error(`sealed history scan failed: ${history.stderr.trim() || "git log rejected the scan"}`);
  }
  let commit = null;
  const seen = new Set();
  for (const raw of history.stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("COMMIT ")) {
      commit = line.slice("COMMIT ".length);
      continue;
    }
    if (!commit) continue;
    const key = `${commit}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // A deletion commit names the path but no longer carries the blob, so the
    // parent is checked too; either side holding a manifest is a leak.
    for (const revision of [`${commit}:${line}`, `${commit}^:${line}`]) {
      if (isSealedManifestBlob(showBlob(projectRoot, revision), needle)) {
        leaks.push({ where: "history", commit, path: line });
        break;
      }
    }
  }

  for (const [where, args] of [
    ["index", ["grep", "-l", "--cached", "-F", needle]],
    ["worktree", ["grep", "-l", "--untracked", "-F", needle]],
  ]) {
    const result = git(projectRoot, args);
    // git grep exits 1 with no output when nothing matches; that is the clean
    // answer, not an error. Any other non-zero status is a real failure and is
    // surfaced rather than read as "nothing found".
    if (result.status !== 0 && result.status !== 1) {
      throw new Error(`sealed ${where} scan failed: ${result.stderr.trim() || `git grep exited ${result.status}`}`);
    }
    for (const file of result.stdout.split("\n").map(value => value.trim()).filter(Boolean)) {
      const text = where === "index"
        ? showBlob(projectRoot, `:${file}`)
        : (() => {
            try {
              return fs.readFileSync(path.join(projectRoot, file), "utf8");
            } catch {
              return null;
            }
          })();
      if (isSealedManifestBlob(text, needle)) leaks.push({ where, path: file });
    }
  }

  return leaks;
}

// The case is invalid, not merely warned about, when the specification is
// reachable: a benchmark whose scoring key leaked produces numbers that look
// like measurements and are not.
function assertSealIntact(projectRoot, caseId) {
  const leaks = scanRepositoryForSealedSchema(projectRoot);
  if (leaks.length === 0) return;
  const detail = leaks
    .map(leak => (leak.where === "history" ? `history:${leak.commit}:${leak.path}` : `${leak.where}:${leak.path}`))
    .join(", ");
  throw new Error(
    `case ${caseId} is invalid: the sealed scoring specification is reachable from the repository (${detail})`,
  );
}

// Report-time integrity check. Returns a verdict rather than throwing so the
// reporter can mark the run invalid and withhold scores, which is the required
// behaviour: a changed manifest must not produce a scoreboard at all.
function verifySealedHash(projectRoot, sealedPath, expectedHash) {
  try {
    const resolved = resolveSealedPath(projectRoot, sealedPath);
    if (!fs.existsSync(resolved)) {
      return { valid: false, reason: `sealed manifest is missing at report time: ${resolved}`, hash: null };
    }
    const hash = hashFile(resolved);
    if (hash !== expectedHash) {
      return {
        valid: false,
        reason: `sealed manifest changed between preparation and reporting (expected ${expectedHash}, found ${hash})`,
        hash,
      };
    }
    return { valid: true, reason: null, hash };
  } catch (error) {
    return { valid: false, reason: error.message, hash: null };
  }
}

module.exports = {
  isSealedManifestBlob,
  resolveSealedPath,
  loadSealedManifest,
  scanRepositoryForSealedSchema,
  assertSealIntact,
  verifySealedHash,
  hashFile,
};
