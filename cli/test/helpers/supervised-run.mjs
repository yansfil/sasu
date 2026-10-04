// Fixtures for supervisor tests: a real run record made by the real CLI,
// with a supervision record patched in the way `dispatch` writes it, so the
// digest reads exactly what production reads.
import fs from "node:fs";
import path from "node:path";
import { makeProject, run, PRD_PATH, STATE_PATH } from "./implement-fixture.mjs";

export const OBSERVER_SESSION = "0b5e7e1e-0000-4000-8000-00000000000a";
export const OBSERVER_PANE = "w1:p1";
export const IMPLEMENTOR_PANE = "w2:p1";

export function observerIdentity(overrides = {}) {
  return { runtime: "claude", sessionId: OBSERVER_SESSION, terminalId: "term_obs", paneId: OBSERVER_PANE, hostScope: "sock", recordedAt: "2026-09-18T10:00:00.000Z", ...overrides };
}

export function implementorIdentity(overrides = {}) {
  return { paneId: IMPLEMENTOR_PANE, agent: "impl", sessionId: "impl-sess", terminalId: "term", hostScope: "sock", recordedAt: "2026-09-18T10:00:00.000Z", ...overrides };
}

/** Start a run in a fresh project and record it as dispatched; returns the absolute state path. */
export function makeSupervisedRun({ slug = "fixture", runInstanceId = "instance-1", dispatchedAt = "2026-09-18T10:00:00.000Z", observer = observerIdentity(), implementor = implementorIdentity(), project } = {}) {
  const root = project ?? fs.realpathSync(makeProject());
  const statePath = path.join(root, STATE_PATH);
  if (!fs.existsSync(statePath)) {
    const started = run(root, ["implement", "start", "--prd", PRD_PATH, "--dirty-attribution", "run-owned"], { env: { CLAUDE_SESSION_ID: OBSERVER_SESSION } });
    if (started.status !== 0) throw new Error(started.stderr + started.stdout);
  }
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.supervision = { runInstanceId, observer, implementor, canonicalRepository: root, prdPath: state.prdPath, dispatchHead: null, dispatchedAt, handovers: [] };
  state.ownerSessionId = null;
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return { root, statePath, slug };
}

export function patchState(statePath, mutate) {
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  mutate(state);
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

export const agent = (paneId, fields = {}) => ({ paneId, name: null, kind: "claude", sessionId: "sess", terminalId: "term", status: "idle", activityAt: 0, stateChangeSeq: 1, inputGuard: null, ...fields });
