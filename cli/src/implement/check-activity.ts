import crypto from "node:crypto";
import os from "node:os";
import { loadState, nowIso, persistState, sha256 } from "./store";
import type { ImplementState } from "./types";

function processPresent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

/** A failed attempt is history; only a running command prevents amendment. */
export function assertNoActiveCheck(state: ImplementState): void {
  const active = state.activeCheck;
  if (active === undefined) return;
  const description = `${active.rowId} (pid ${active.pid} on ${active.hostname}, started ${active.startedAt})`;
  if (active.hostname !== os.hostname()) {
    throw new Error(`check still active or uninspectable: ${description}; resume on its host after that command exits`);
  }
  let ownerAlive: boolean;
  try {
    ownerAlive = processPresent(active.pid);
  } catch {
    throw new Error(`check still active or uninspectable: ${description}; process liveness could not be established`);
  }
  if (ownerAlive) throw new Error(`check still active: ${description}; retry after the command exits`);

  // A dead CLI may leave the command or its descendants alive. Only ESRCH
  // for its recorded, detached POSIX process group proves execution ended.
  // A crash before PID registration leaves uncertainty, never permission.
  if (active.executionPid === undefined || process.platform === "win32") {
    throw new Error(`check still active or uninspectable: ${description}; its command process group cannot be inspected`);
  }
  let executionAlive: boolean;
  try {
    executionAlive = processPresent(-active.executionPid);
  } catch {
    throw new Error(`check still active or uninspectable: ${description}; command process group ${active.executionPid} liveness could not be established`);
  }
  if (executionAlive) {
    throw new Error(`check still active: ${description}; command process group ${active.executionPid} survives its owner`);
  }
  delete state.activeCheck;
  state.deviations.push({
    at: nowIso(),
    type: "interrupted-check",
    summary: `${description} and command process group ${active.executionPid} exited without recording a result; its interrupted execution proves nothing`,
  });
}

export function beginCheck(statePath: string, state: ImplementState, rowId: string): void {
  assertNoActiveCheck(state);
  const row = state.rows.find((candidate) => candidate.id === rowId);
  if (row === undefined || row.check.kind !== "check") throw new Error(`cannot begin check: ${rowId} is not a check row`);
  state.activeCheck = {
    token: crypto.randomUUID(),
    rowId,
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: nowIso(),
    prdSha256: state.prd.sha256,
    rowSha256: sha256(JSON.stringify(row)),
  };
  persistState(statePath, state);
}

/** Record the spawned process group before accepting any execution result. */
export function recordCheckExecution(statePath: string, state: ImplementState, pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("cannot record check execution: pid must be a positive integer");
  const active = state.activeCheck;
  if (active === undefined) throw new Error("cannot record check execution: this command holds no active check");
  const fresh = loadState(state.projectRoot, { state: statePath }).state;
  if (fresh.activeCheck?.token !== active.token) {
    throw new Error(`cannot record ${active.rowId} execution: its active check was replaced or cleared`);
  }
  if (fresh.activeCheck.executionPid !== undefined && fresh.activeCheck.executionPid !== pid) {
    throw new Error(`cannot replace ${active.rowId} execution process group ${fresh.activeCheck.executionPid} with ${pid}`);
  }
  fresh.activeCheck.executionPid = pid;
  persistState(statePath, fresh);
  state.activeCheck = fresh.activeCheck;
}

/**
 * Reload before accepting the result: rejected observer commands can append
 * verbs while a check runs, and overwriting the initial snapshot loses them.
 * Clear and result land together through the existing state compare-and-swap.
 */
export function finishCheck(
  statePath: string,
  state: ImplementState,
  applyResult?: (fresh: ImplementState) => void,
): ImplementState {
  const active = state.activeCheck;
  if (active === undefined) throw new Error("cannot finish check: this command holds no active check");
  const fresh = loadState(state.projectRoot, { state: statePath }).state;
  if (fresh.activeCheck?.token !== active.token) {
    throw new Error(`cannot accept ${active.rowId} result: its active check was replaced or cleared`);
  }
  const execution = fresh.activeCheck;
  // Even cleanup after a spawn/registration failure must not erase the
  // marker while a detached command or descendant still runs.
  if (execution.executionPid !== undefined && process.platform !== "win32") {
    let executionAlive: boolean;
    try {
      if (execution.hostname !== os.hostname()) throw new Error("execution belongs to another host");
      executionAlive = processPresent(-execution.executionPid);
    } catch {
      throw new Error(`cannot finish ${active.rowId}: command process group ${execution.executionPid} is uninspectable; active check retained`);
    }
    if (executionAlive) {
      throw new Error(`cannot finish ${active.rowId}: command process group ${execution.executionPid} is still active; active check retained`);
    }
  }
  delete fresh.activeCheck;
  if (applyResult !== undefined) {
    const row = fresh.rows.find((candidate) => candidate.id === active.rowId);
    if (fresh.status !== state.status || fresh.prd.sha256 !== active.prdSha256 || sha256(JSON.stringify(row) ?? "") !== active.rowSha256) {
      persistState(statePath, fresh);
      throw new Error(`cannot accept ${active.rowId} result: its run, PRD, or row changed during execution; rerun against the current record`);
    }
    try {
      applyResult(fresh);
    } catch (error) {
      // The callback may have partly mutated its fresh object. Reload for
      // cleanup so none of that partial result can become accepted evidence.
      finishCheck(statePath, state);
      throw error;
    }
  }
  persistState(statePath, fresh);
  return fresh;
}
