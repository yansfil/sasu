import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * One exclusive-lock primitive for every run record (gate judge admission,
 * implement close). A lock is a file created with `wx`, carrying the owner's
 * pid, host and a token; release deletes it only while the token still
 * matches. A lock whose owner is a demonstrably dead pid on this host is
 * recovered; live and remote owners stand.
 */
export function tryAcquireLock(lockPath: string, options: { recoverDeadOwner: boolean; topic: string }): (() => void) | null {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const token = crypto.randomUUID();
  const metadata = {
    token,
    pid: process.pid,
    hostname: os.hostname(),
    topic: options.topic,
    startedAt: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lockPath, `${JSON.stringify(metadata)}\n`, { flag: "wx" });
      return () => {
        try {
          const current = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { token?: string };
          if (current.token === token) fs.unlinkSync(lockPath);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
      };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      if (!options.recoverDeadOwner || !removeDeadOwnerLock(lockPath)) return null;
    }
  }
  return null;
}

/** Recover only a demonstrably dead PID on this host. Live and remote locks stand. */
export function removeDeadOwnerLock(lockPath: string): boolean {
  let owner: { pid?: unknown; hostname?: unknown; token?: unknown };
  try {
    owner = JSON.parse(fs.readFileSync(lockPath, "utf8")) as typeof owner;
  } catch {
    return false;
  }
  if (owner.hostname !== os.hostname() || !Number.isInteger(owner.pid)) return false;
  try {
    process.kill(owner.pid as number, 0);
    return false;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) return false;
  }
  try {
    const latest = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { token?: unknown };
    if (latest.token !== owner.token) return false;
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * `tryAcquireLock` with a bounded wait: polls until the lock is taken or
 * `waitMs` elapses, then returns null so the caller can name what it was
 * waiting for. Contention on a run record is rare and short (one state write),
 * so a waiting writer normally gets its turn and is then judged by the
 * compare-and-swap on what it loaded.
 */
export function acquireLock(lockPath: string, options: { recoverDeadOwner: boolean; topic: string; waitMs: number }): (() => void) | null {
  const deadline = Date.now() + options.waitMs;
  while (true) {
    const release = tryAcquireLock(lockPath, options);
    if (release !== null) return release;
    if (Date.now() >= deadline) return null;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}
