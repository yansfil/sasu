// Fixtures for supervisor tests: a real run record made by the real CLI,
// with a supervision record patched in the way `dispatch` writes it, so the
// tick reads exactly what production reads.
import fs from "node:fs";
import path from "node:path";
import { makeProject, run, PRD_PATH, STATE_PATH } from "./implement-fixture.mjs";

export const OBSERVER_SESSION = "0b5e7e1e-0000-4000-8000-00000000000a";
export const OBSERVER_PANE = "w1:p1";
export const IMPLEMENTOR_PANE = "w2:p1";

export function observerIdentity(overrides = {}) {
  return { runtime: "claude", sessionId: OBSERVER_SESSION, terminalId: "term_obs", paneId: OBSERVER_PANE, hostScope: "sock", recordedAt: "2026-09-18T10:00:00.000Z", ...overrides };
}

/** Start a run in a fresh project and record it as dispatched; returns the absolute state path. */
export function makeSupervisedRun({ slug = "fixture", runInstanceId = "instance-1", dispatchedAt = "2026-09-18T10:00:00.000Z", patrolIntervalMs = 15 * 60 * 1000, observer = observerIdentity(), implementor = { paneId: IMPLEMENTOR_PANE, agent: "impl" }, recoveryOwner = "supervisor", project } = {}) {
  const root = project ?? fs.realpathSync(makeProject());
  const statePath = path.join(root, STATE_PATH);
  if (!fs.existsSync(statePath)) {
    const started = run(root, ["implement", "start", "--prd", PRD_PATH, "--dirty-attribution", "run-owned"], { env: { CLAUDE_SESSION_ID: OBSERVER_SESSION } });
    if (started.status !== 0) throw new Error(started.stderr + started.stdout);
  }
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.supervision = { runInstanceId, observer, implementor, canonicalRepository: root, prdPath: state.prdPath, dispatchHead: null, dispatchedAt, patrolIntervalMs, recoveryOwner, handovers: [] };
  state.ownerSessionId = null;
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return { root, statePath, slug };
}

export function patchState(statePath, mutate) {
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  mutate(state);
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

/** An in-process herdr double for runTick: agents by pane id, a log of prompts, and a switch for "not answering". */
export function fakeTickHerdr({ agents = {}, guardSupport = false } = {}) {
  const prompts = [];
  const state = { agents: { ...agents }, down: false, guardSupport };
  const lookup = (target) => {
    if (state.down) return { kind: "unavailable", detail: "socket down" };
    const agent = Object.values(state.agents).find((entry) => entry.paneId === target || entry.name === target);
    return agent === undefined ? { kind: "absent", detail: `no agent at ${target}` } : { kind: "found", agent };
  };
  return {
    state,
    prompts,
    herdr: {
      probe: () => state.down ? { available: false, detail: "socket down" } : { available: true, detail: null },
      getAgent: lookup,
      promptAgent: (input) => {
        const looked = lookup(input.target);
        if (input.expectedInputGuard !== null && !state.guardSupport) return { outcome: "rejected", path: "guarded", code: "guarded_prompt_unsupported", detail: "unknown option" };
        if (looked.kind !== "found") return { outcome: "rejected", path: input.expectedInputGuard === null ? "session-match" : "guarded", code: "agent_not_found", detail: "not found" };
        if (looked.agent.status === "blocked") return { outcome: "rejected", path: "session-match", code: "agent_blocked", detail: "blocked" };
        if (input.expectedInputGuard !== null && looked.agent.inputGuard !== input.expectedInputGuard) return { outcome: "rejected", path: "guarded", code: "agent_input_guard_mismatch", detail: "guard mismatch" };
        prompts.push({ target: input.target, text: input.text, guard: input.expectedInputGuard, sessionId: looked.agent.sessionId });
        return { outcome: "accepted", path: input.expectedInputGuard === null ? "session-match" : "guarded", code: "submitted", detail: "ok" };
      },
    },
  };
}

export const agent = (paneId, fields = {}) => ({ paneId, name: null, kind: "claude", sessionId: "sess", terminalId: "term", status: "idle", activityAt: 0, stateChangeSeq: 1, inputGuard: null, ...fields });
