// The `hcoord` these tests drive is the one hide installs on PATH
// (~/.local/bin/hcoord); sasu ships no copy. A test that needs a coordinator
// declares it with HCOORD_SKIP so a machine without one reports the suite as
// skipped, never as passed. Every test that starts a daemon gives it its own
// HCOORD_HOME, which relocates the ledger, socket and outbox, so nothing
// reaches the data folder of the daemon that runs on a developer's machine.
import fs from "node:fs";
import path from "node:path";

export function hcoordOnPath(searchPath = process.env.PATH ?? "") {
  for (const dir of searchPath.split(path.delimiter)) {
    if (dir === "") continue;
    const candidate = path.join(dir, "hcoord");
    try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return candidate; } catch { /* next directory */ }
  }
  return null;
}

export const HCOORD_SKIP = hcoordOnPath() === null
  ? "hcoord is not on PATH; hide installs it at ~/.local/bin/hcoord, and these tests drive that coordinator"
  : false;

/** A PATH holding only the given directory and a `node` link, so a spawned `hcoord` cannot be found. */
export function pathWithoutHcoord(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const node = path.join(dir, "node");
  if (!fs.existsSync(node)) fs.symlinkSync(process.execPath, node);
  return dir;
}
