import crypto from "node:crypto";
import os from "node:os";
import { loadState, nowIso, persistState, StateConflictError } from "./store";
import { reconcileParallelReviewFindings, reconcileRiskFindings } from "./convergence";
import type { ImplementState, UnifiedVerificationAttempt } from "./types";

export function preserveSettledFindings(state: ImplementState, attempt: UnifiedVerificationAttempt, at: string): void {
  // The verdict and shared ledger are committed together. NOT_RUN means the
  // owner died before that write; retain any independently settled exceptions
  // so the next repair cannot forget them. Never apply a settled round twice.
  if (attempt.verdict !== "NOT_RUN") return;
  state.findings = reconcileParallelReviewFindings(state.findings, {
    fidelity: attempt.reviews.fidelity?.result ?? null, code: attempt.reviews.code?.result ?? null,
  }, attempt.id, at);
  if (attempt.risk?.result) state.riskFindings = reconcileRiskFindings(state.riskFindings, attempt.risk.result, attempt.id, at);
}

/**
 * ESRCH is the only answer that means "not there". Everything else is a
 * signal we are not allowed to read, and the caller must not convert it into
 * absence - a recycled process-group id answers EPERM, and reading that as
 * "the group is gone" is exactly the fail-open this file exists to refuse.
 *
 * The throw names the pid and the errno because the same uncertainty used to
 * leave by two different doors: the owner probes wrap their catch and replace
 * the message, while the group probes inside `recoverVerification` do not, so
 * a group EPERM arrived as a bare errno with nothing identifying which pid it
 * came from. Observed once, 2026-09-11, in one of four whole-unit-suite runs
 * at load 12.35, and not reproducible on demand - so this carries identity
 * for the next occurrence rather than guessing at a fix. Measured the same
 * day: probing a process group owned by another user answers EPERM, an absent
 * group answers ESRCH. `code` is preserved so callers that key on the errno
 * still see it.
 */
function processPresent(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    const target = pid < 0 ? `process group ${-pid}` : `pid ${pid}`;
    throw Object.assign(new Error(`liveness probe of ${target} failed with ${code ?? "an unknown errno"}`, { cause: error }), { code });
  }
}

function assertChildrenExited(state: ImplementState): void {
  const active = state.activeVerification;
  if (active === undefined) return;
  if (active.hostname !== os.hostname() || active.pendingSpawns > 0) {
    throw new Error(`verification still active or uninspectable: ${active.attemptId}; process registration or host is uncertain`);
  }
  for (const pid of active.executionPids) {
    if (process.platform === "win32") throw new Error(`verification process group ${pid} is uninspectable on this platform`);
    let alive: boolean;
    try { alive = processPresent(-pid); }
    catch (error) { throw new Error(`verification process group ${pid} is uninspectable; execution lease retained (${(error as Error).message})`); }
    if (alive) throw new Error(`verification still active: process group ${pid} survives; execution lease retained`);
  }
}

/** A dead owner proves nothing while a registered child group can still run. */
export function assertNoActiveVerification(state: ImplementState): boolean {
  const active = state.activeVerification;
  if (active === undefined) return false;
  if (active.hostname !== os.hostname()) throw new Error(`verification still active or uninspectable on ${active.hostname}`);
  let alive: boolean;
  try { alive = processPresent(active.pid); }
  catch (error) { throw new Error(`verification owner liveness is uninspectable; execution lease retained (${(error as Error).message})`); }
  if (alive) throw new Error(`verification still active: ${active.attemptId} (pid ${active.pid}); retry after it finishes`);
  assertChildrenExited(state);
  const attempt = state.verificationAttempts.find((entry) => entry.id === active.attemptId);
  if (attempt === undefined) throw new Error("active verification attempt is missing");
  const at = nowIso();
  preserveSettledFindings(state, attempt, at);
  attempt.verdict = "ERROR";
  attempt.finishedAt = at;
  attempt.durationMs = Math.max(0, Date.parse(at) - Date.parse(attempt.startedAt));
  attempt.error = { stage: attempt.phase, code: "verification-interrupted", message: "Verification owner and all registered process groups exited without recording a result" };
  delete state.activeVerification;
  state.deviations.push({ at, type: "interrupted-verification", summary: attempt.error.message });
  return true;
}

export function beginVerification(statePath: string, state: ImplementState, attempt: UnifiedVerificationAttempt): ImplementState {
  assertNoActiveVerification(state);
  if (state.status !== "active") throw new Error("verification requires an active run");
  if (state.verificationAttempts.some((entry) => entry.id === attempt.id)) throw new Error(`verification attempt ${attempt.id} already exists`);
  if (attempt.prdSha256 !== state.prd.sha256) throw new Error("verification attempt PRD identity does not match the current sealed contract");
  state.verificationAttempts.push(attempt);
  state.activeVerification = {
    token: crypto.randomUUID(), attemptId: attempt.id, pid: process.pid,
    hostname: os.hostname(), startedAt: attempt.startedAt,
    inputFingerprint: attempt.inputFingerprint, prdSha256: attempt.prdSha256,
    executionPids: [], pendingSpawns: 0,
  };
  persistState(statePath, state);
  return state;
}

/** Latest-state merge preserves refusals appended while suites or judges run. */
export function progressVerification(
  statePath: string, state: ImplementState, apply: (fresh: ImplementState) => void,
): ImplementState {
  const active = state.activeVerification;
  if (active === undefined) throw new Error("this command holds no verification execution lease");
  for (let retry = 0; retry < 3; retry += 1) {
    const fresh = loadState(state.projectRoot, { state: statePath }).state;
    if (fresh.activeVerification?.token !== active.token) throw new Error("verification execution lease was replaced or cleared");
    if (fresh.status !== "active" || fresh.prd.sha256 !== active.prdSha256
      || fresh.activeVerification.inputFingerprint !== active.inputFingerprint) throw new Error("verification pinned input changed during execution");
    apply(fresh);
    try { persistState(statePath, fresh, { verificationToken: active.token }); }
    catch (error) {
      if (error instanceof StateConflictError && retry < 2) continue;
      throw error;
    }
    state.activeVerification = fresh.activeVerification;
    return fresh;
  }
  throw new Error("verification state remained busy after three compare-and-swap attempts");
}

export function prepareVerificationExecution(statePath: string, state: ImplementState): void {
  progressVerification(statePath, state, (fresh) => { fresh.activeVerification!.pendingSpawns += 1; });
}

export function recordVerificationExecution(statePath: string, state: ImplementState, pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("execution pid must be a positive integer");
  progressVerification(statePath, state, (fresh) => {
    const active = fresh.activeVerification!;
    if (active.pendingSpawns <= 0) throw new Error("execution spawn was not prepared");
    active.pendingSpawns -= 1;
    if (!active.executionPids.includes(pid)) active.executionPids.push(pid);
  });
}

/** A failed spawn has no process group; its prepared slot must close explicitly. */
export function cancelVerificationExecution(statePath: string, state: ImplementState): void {
  progressVerification(statePath, state, (fresh) => {
    if (fresh.activeVerification!.pendingSpawns <= 0) throw new Error("no pending verification spawn to cancel");
    fresh.activeVerification!.pendingSpawns -= 1;
  });
}

export function finishVerification(
  statePath: string, state: ImplementState, applyResult?: (fresh: ImplementState) => void,
): ImplementState {
  return progressVerification(statePath, state, (fresh) => {
    assertChildrenExited(fresh);
    applyResult?.(fresh);
    delete fresh.activeVerification;
  });
}

/**
 * A dead owner can leave its known groups running. Terminate only those
 * groups, then prove absence before making the interrupted attempt durable.
 * Unknown registration/host/liveness never grants cleanup or new execution.
 */
export async function recoverVerification(statePath: string, state: ImplementState): Promise<ImplementState> {
  const active = state.activeVerification;
  if (active === undefined) return state;
  if (active.hostname !== os.hostname()) throw new Error(`verification still active or uninspectable on ${active.hostname}`);
  let ownerAlive: boolean;
  try { ownerAlive = processPresent(active.pid); }
  catch (error) { throw new Error(`verification owner liveness is uninspectable; execution lease retained (${(error as Error).message})`); }
  if (ownerAlive) throw new Error(`verification still active: ${active.attemptId} (pid ${active.pid})`);
  if (active.pendingSpawns > 0 || (process.platform === "win32" && active.executionPids.length > 0)) throw new Error("verification still active or uninspectable: process registration is uncertain");
  // Inspect every group before sending any signal; EPERM is not authority.
  const alive = active.executionPids.filter((pid) => processPresent(-pid));
  const signal = (pid: number, value: NodeJS.Signals): void => {
    try { process.kill(-pid, value); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  for (const pid of alive) signal(pid, "SIGTERM");
  const grace = Date.now() + 250;
  while (alive.some((pid) => processPresent(-pid)) && Date.now() < grace) await new Promise((done) => setTimeout(done, 10));
  for (const pid of alive) if (processPresent(-pid)) signal(pid, "SIGKILL");
  const deadline = Date.now() + 1000;
  while (alive.some((pid) => processPresent(-pid)) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
  return progressVerification(statePath, state, (fresh) => {
    assertChildrenExited(fresh);
    const attempt = fresh.verificationAttempts.find((entry) => entry.id === active.attemptId)!;
    const at = nowIso();
    preserveSettledFindings(fresh, attempt, at);
    attempt.verdict = "ERROR";
    attempt.finishedAt = at;
    attempt.durationMs = Math.max(0, Date.parse(at) - Date.parse(attempt.startedAt));
    attempt.error = { stage: attempt.phase, code: "verification-interrupted", message: "Verification owner exited; registered child groups were terminated and confirmed gone before recovery" };
    fresh.deviations.push({ at, type: "interrupted-verification", summary: attempt.error.message });
    delete fresh.activeVerification;
  });
}

/** Track only live owned groups, so a long verify never follows a recycled pid. */
export function completeVerificationExecution(statePath: string, state: ImplementState, pid: number): void {
  progressVerification(statePath, state, (fresh) => {
    const active = fresh.activeVerification!;
    if (!active.executionPids.includes(pid)) throw new Error(`verification process group ${pid} was not registered`);
    if (active.hostname !== os.hostname() || process.platform === "win32") throw new Error(`verification process group ${pid} cannot be attested gone`);
    if (processPresent(-pid)) throw new Error(`verification process group ${pid} is still active; execution lease retained`);
    active.executionPids = active.executionPids.filter((entry) => entry !== pid);
  });
}
