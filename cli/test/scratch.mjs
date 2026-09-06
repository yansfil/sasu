import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A scratch root that is not inside any git checkout.
 *
 * Fixtures that model a standalone project (a git repository of their own, or
 * deliberately no repository at all) must not be nested in another checkout:
 * the enclosing repository's HEAD, .gitignore and work-tree boundary leak into
 * the fixture and change what the code under test observes. The harness's own
 * check runtime makes this concrete - `sasu implement verify` runs the sealed
 * suite with TMPDIR under `agents/runs/<slug>/check-runtime/tmp`, inside the
 * judged repository where `agents/runs/` is gitignored. Measured 2026-09-06 on
 * the prd-template run: 8 unit tests that assert "non-git directory", "source
 * snapshot excludes only agents/" or "tree moved" failed under that TMPDIR and
 * passed under the default one.
 *
 * Candidates are tried in order; the first that is writable and outside a
 * work tree wins. If none qualifies the default temp dir is used and the
 * affected tests fail loudly rather than being skipped.
 */
let scratchRoot = null;

function insideWorkTree(dir) {
  const probe = spawnSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  return probe.status === 0 && probe.stdout.trim() === "true";
}

function resolveScratchRoot() {
  if (scratchRoot !== null) return scratchRoot;
  const candidates = [os.tmpdir(), "/tmp", path.join(os.homedir(), ".cache")];
  for (const candidate of candidates) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      fs.accessSync(candidate, fs.constants.W_OK);
    } catch {
      continue;
    }
    if (!insideWorkTree(candidate)) {
      scratchRoot = candidate;
      return scratchRoot;
    }
  }
  scratchRoot = os.tmpdir();
  return scratchRoot;
}

/** `fs.mkdtempSync` rooted outside any git checkout. */
export function scratchDir(prefix) {
  return fs.mkdtempSync(path.join(resolveScratchRoot(), prefix));
}
