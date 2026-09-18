import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runTick } from "../../dist/supervisor/tick.js";
import { readIndex, enrollRun, MISSING_TICKS_BEFORE_CLEANUP } from "../../dist/supervisor/index.js";
import { WAKE_MARKER } from "../../dist/supervisor/wake.js";
import { agent, fakeTickHerdr, IMPLEMENTOR_PANE, makeSupervisedRun, OBSERVER_PANE, OBSERVER_SESSION, observerIdentity, patchState } from "../helpers/supervised-run.mjs";

const T0 = Date.parse("2026-09-18T10:00:00.000Z");
const MIN = 60_000;
const indexFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sasu-tick-")), "index.json");
const observer = (fields = {}) => agent(OBSERVER_PANE, { sessionId: OBSERVER_SESSION, terminalId: "term_obs", status: "idle", ...fields });
const implementor = (fields = {}) => agent(IMPLEMENTOR_PANE, { name: "impl", sessionId: "impl-sess", status: "working", activityAt: T0, ...fields });
const silent = () => {};

function tick(index, herdr, now) {
  return runTick({ indexFile: index, herdr: herdr.herdr, now: () => now, log: silent });
}

test("B8/B10: a settled implementor wakes exactly the recorded Observer once, with an identity note, and the index records the wake", () => {
  const index = indexFile();
  const run = makeSupervisedRun();
  enrollRun(index, { statePath: run.statePath, runInstanceId: "instance-1", at: "2026-09-18T10:00:00.000Z" });
  const herdr = fakeTickHerdr({ agents: { obs: observer(), impl: implementor({ status: "idle", activityAt: T0 }) } });

  const first = tick(index, herdr, T0 + 2 * MIN);
  assert.deepEqual(first.runs.map((entry) => entry.action), ["sent"]);
  assert.equal(herdr.prompts.length, 1);
  assert.equal(herdr.prompts[0].target, OBSERVER_PANE);
  assert.equal(herdr.prompts[0].sessionId, OBSERVER_SESSION);
  const body = herdr.prompts[0].text;
  assert.match(body, new RegExp(`^${WAKE_MARKER}\\n`));
  assert.match(body, new RegExp(`observer: ${OBSERVER_SESSION}`));
  assert.match(body, /run: fixture instance instance-1/);
  assert.match(body, /reason: settled/);
  assert.match(body, /inspect: sasu implement status --slug fixture --digest/);
  assert.doesNotMatch(body, /implementation\.txt|Requirement/, "no transcript, no PRD content: an identity note only");

  const recorded = readIndex(index);
  assert.equal(recorded.lastTickAt, new Date(T0 + 2 * MIN).toISOString());
  assert.deepEqual({ reasons: recorded.entries[0].lastWake.reasons, outcome: recorded.entries[0].lastWake.outcome, path: recorded.entries[0].lastWake.path }, { reasons: ["settled"], outcome: "accepted", path: "session-match" });
  assert.equal(recorded.entries[0].lastObservation.guardedPrompt, false);

  const second = tick(index, herdr, T0 + 3 * MIN);
  assert.deepEqual(second.runs.map((entry) => entry.action), ["none"]);
  assert.equal(herdr.prompts.length, 1, "the same settled episode is not woken twice");
});

test("B9: a replacement session in the Observer's pane receives nothing and status shows observer-gone", () => {
  const index = indexFile();
  const run = makeSupervisedRun();
  enrollRun(index, { statePath: run.statePath, runInstanceId: "instance-1", at: "2026-09-18T10:00:00.000Z" });
  const herdr = fakeTickHerdr({ agents: { obs: observer({ sessionId: "a-new-session" }), impl: implementor({ status: "blocked" }) } });
  const outcome = tick(index, herdr, T0 + MIN);
  assert.deepEqual(outcome.runs.map((entry) => entry.action), ["deferred"]);
  assert.match(outcome.runs[0].detail, /observer-gone/);
  assert.equal(herdr.prompts.length, 0, "zero input to the stranger");
  const entry = readIndex(index).entries[0];
  assert.match(entry.lastObservation.observer, /^observer-gone/);
  assert.equal(entry.lastWake, null);
  assert.match(entry.lastFailure.detail, /not the recorded Observer/);
});

test("B4: several runs - two repositories with one slug, and one Observer watching two runs - each wake reaches only its own Observer, bundled per Observer", () => {
  const index = indexFile();
  const a = makeSupervisedRun({ runInstanceId: "a" });
  const b = makeSupervisedRun({ runInstanceId: "b", observer: observerIdentity({ sessionId: "other-observer", paneId: "w9:p1", terminalId: "term_other" }), implementor: { paneId: "w9:p2", agent: "impl" } });
  const c = makeSupervisedRun({ runInstanceId: "c", implementor: { paneId: "w3:p1", agent: "impl-c" } });
  for (const [run, id] of [[a, "a"], [b, "b"], [c, "c"]]) enrollRun(index, { statePath: run.statePath, runInstanceId: id, at: "2026-09-18T10:00:00.000Z" });
  const herdr = fakeTickHerdr({ agents: {
    obs: observer(),
    other: agent("w9:p1", { sessionId: "other-observer", terminalId: "term_other", status: "idle" }),
    implA: implementor({ status: "blocked", stateChangeSeq: 2 }),
    implB: agent("w9:p2", { name: "impl", status: "blocked", stateChangeSeq: 3 }),
    implC: agent("w3:p1", { name: "impl-c", status: "idle", activityAt: T0, stateChangeSeq: 4 }),
  } });
  const outcome = tick(index, herdr, T0 + 2 * MIN);
  assert.deepEqual(outcome.runs.map((entry) => entry.action), ["sent", "sent", "sent"]);
  assert.equal(herdr.prompts.length, 2, "one prompt per Observer, not per run");
  const mine = herdr.prompts.find((prompt) => prompt.sessionId === OBSERVER_SESSION);
  const theirs = herdr.prompts.find((prompt) => prompt.sessionId === "other-observer");
  assert.match(mine.text, /run: fixture instance a[\s\S]*run: fixture instance c/, "both of this Observer's runs in one note");
  assert.doesNotMatch(mine.text, /instance b/);
  assert.match(theirs.text, /instance b/);
  assert.doesNotMatch(theirs.text, /instance a|instance c/);
});

test("B12: one run's broken state.json, missing file or instance mismatch is its own failure; the others are still judged", () => {
  const index = indexFile();
  const good = makeSupervisedRun({ runInstanceId: "good" });
  const broken = makeSupervisedRun({ runInstanceId: "broken" });
  const mismatched = makeSupervisedRun({ runInstanceId: "recorded" });
  const vanished = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sasu-gone-")), "agents", "runs", "gone", "state.json");
  fs.writeFileSync(broken.statePath, "{ not json");
  for (const [statePath, id] of [[good.statePath, "good"], [broken.statePath, "broken"], [mismatched.statePath, "indexed-differently"], [vanished, "vanished"]]) enrollRun(index, { statePath, runInstanceId: id, at: "2026-09-18T10:00:00.000Z" });
  const herdr = fakeTickHerdr({ agents: { obs: observer(), impl: implementor({ status: "blocked" }) } });

  const outcome = tick(index, herdr, T0 + MIN);
  const byPath = Object.fromEntries(outcome.runs.map((entry) => [entry.statePath, entry]));
  assert.equal(byPath[good.statePath].action, "sent");
  assert.equal(byPath[broken.statePath].action, "failed");
  assert.match(byPath[broken.statePath].detail, /malformed implement state JSON/);
  assert.equal(byPath[mismatched.statePath].action, "failed");
  assert.match(byPath[mismatched.statePath].detail, /run instance recorded in state.json is not the indexed indexed-differently/);
  assert.equal(byPath[vanished].action, "failed");
  assert.match(byPath[vanished].detail, /missing \(1 consecutive tick/);
  assert.equal(herdr.prompts.length, 1);
  const recorded = readIndex(index);
  assert.equal(recorded.entries.length, 4, "nothing is dropped on a first failure");
  assert.equal(recorded.entries.find((entry) => entry.statePath === vanished).missingTicks, 1);
});

test("B15: a state.json that stays missing is removed after N consecutive ticks with its cause, and a file that comes back resets the count", () => {
  const index = indexFile();
  const run = makeSupervisedRun();
  enrollRun(index, { statePath: run.statePath, runInstanceId: "instance-1", at: "2026-09-18T10:00:00.000Z" });
  const bytes = fs.readFileSync(run.statePath);
  const herdr = fakeTickHerdr({ agents: { obs: observer(), impl: implementor() } });
  fs.rmSync(run.statePath);
  tick(index, herdr, T0 + MIN);
  fs.writeFileSync(run.statePath, bytes);
  tick(index, herdr, T0 + 2 * MIN);
  assert.equal(readIndex(index).entries[0].missingTicks, 0, "a readable file resets the count");
  fs.rmSync(run.statePath);
  for (let i = 0; i < MISSING_TICKS_BEFORE_CLEANUP - 1; i += 1) tick(index, herdr, T0 + (3 + i) * MIN);
  assert.equal(readIndex(index).entries.length, 1, "one tick short of the bound keeps the entry");
  const final = tick(index, herdr, T0 + 10 * MIN);
  assert.equal(final.runs[0].action, "removed");
  const recorded = readIndex(index);
  assert.equal(recorded.entries.length, 0);
  assert.match(recorded.removed.at(-1).cause, new RegExp(`missing for ${MISSING_TICKS_BEFORE_CLEANUP} consecutive ticks`));
});

test("B15: a retired run is woken once with reason terminal and then leaves the index", () => {
  const index = indexFile();
  const run = makeSupervisedRun();
  enrollRun(index, { statePath: run.statePath, runInstanceId: "instance-1", at: "2026-09-18T10:00:00.000Z" });
  patchState(run.statePath, (state) => { state.status = "retired"; state.retirement = { retiredAt: "2026-09-18T10:05:00.000Z", retiredBySessionId: null }; });
  const herdr = fakeTickHerdr({ agents: { obs: observer(), impl: implementor() } });
  const outcome = tick(index, herdr, T0 + 6 * MIN);
  assert.equal(outcome.runs[0].action, "sent");
  assert.match(herdr.prompts[0].text, /reason: terminal/);
  const recorded = readIndex(index);
  assert.equal(recorded.entries.length, 0);
  assert.match(recorded.removed.at(-1).cause, /run retired; terminal wake accepted/);
  assert.equal(tick(index, herdr, T0 + 7 * MIN).runs.length, 0);
  assert.equal(herdr.prompts.length, 1);
});

test("B8: a working Observer is not interrupted; the same condition is delivered on the next tick it is idle", () => {
  const index = indexFile();
  const run = makeSupervisedRun();
  enrollRun(index, { statePath: run.statePath, runInstanceId: "instance-1", at: "2026-09-18T10:00:00.000Z" });
  const herdr = fakeTickHerdr({ agents: { obs: observer({ status: "working" }), impl: implementor({ status: "blocked" }) } });
  const deferred = tick(index, herdr, T0 + MIN);
  assert.equal(deferred.runs[0].action, "deferred");
  assert.equal(herdr.prompts.length, 0);
  herdr.state.agents.obs = observer({ status: "idle" });
  const delivered = tick(index, herdr, T0 + 2 * MIN);
  assert.equal(delivered.runs[0].action, "sent");
  assert.equal(herdr.prompts.length, 1);
});

test("B11: when herdr returns an input_guard for the Observer the wake goes guarded, and a guard the server then refuses is a routing failure, never a plain resend", () => {
  const index = indexFile();
  const run = makeSupervisedRun();
  enrollRun(index, { statePath: run.statePath, runInstanceId: "instance-1", at: "2026-09-18T10:00:00.000Z" });
  const guardedHerdr = fakeTickHerdr({ guardSupport: true, agents: { obs: observer({ inputGuard: "guard-1" }), impl: implementor({ status: "blocked" }) } });
  const sent = tick(index, guardedHerdr, T0 + MIN);
  assert.equal(sent.runs[0].action, "sent");
  assert.equal(guardedHerdr.prompts[0].guard, "guard-1");
  assert.equal(readIndex(index).entries[0].lastWake.path, "guarded");
  assert.equal(readIndex(index).entries[0].lastObservation.guardedPrompt, true);

  const index2 = indexFile();
  enrollRun(index2, { statePath: run.statePath, runInstanceId: "instance-1", at: "2026-09-18T10:00:00.000Z" });
  const refusingHerdr = fakeTickHerdr({ guardSupport: false, agents: { obs: observer({ inputGuard: "guard-1" }), impl: implementor({ status: "blocked" }) } });
  const failed = tick(index2, refusingHerdr, T0 + MIN);
  assert.equal(failed.runs[0].action, "failed");
  assert.equal(refusingHerdr.prompts.length, 0, "no unguarded fallback");
  const entry = readIndex(index2).entries[0];
  assert.equal(entry.lastWake.code, "guarded_prompt_unsupported");
  assert.match(entry.lastFailure.detail, /guarded_prompt_unsupported/);
});

test("B12: when herdr is not answering, the tick judges from state.json, sends nothing, and says observation was impossible", () => {
  const index = indexFile();
  const run = makeSupervisedRun({ dispatchedAt: "2026-09-18T09:00:00.000Z" });
  enrollRun(index, { statePath: run.statePath, runInstanceId: "instance-1", at: "2026-09-18T09:00:00.000Z" });
  const herdr = fakeTickHerdr({ agents: { obs: observer(), impl: implementor() } });
  herdr.state.down = true;
  const outcome = tick(index, herdr, Date.parse("2026-09-18T10:30:00.000Z"));
  assert.equal(outcome.herdr.available, false);
  assert.equal(outcome.runs[0].action, "deferred");
  assert.deepEqual(outcome.runs[0].decision.due.map((entry) => entry.reason), ["stall"], "state.json alone still yields the stall judgment");
  assert.match(outcome.runs[0].detail, /observer unobservable/);
  assert.equal(herdr.prompts.length, 0);
  assert.deepEqual(readIndex(index).lastHerdr, { available: false, detail: "socket down" });
});

test("D-09: a wake herdr rejected before input is retried next tick; one it may have delivered is not", () => {
  const index = indexFile();
  const run = makeSupervisedRun();
  enrollRun(index, { statePath: run.statePath, runInstanceId: "instance-1", at: "2026-09-18T10:00:00.000Z" });
  const herdr = fakeTickHerdr({ agents: { obs: observer(), impl: implementor({ status: "blocked" }) } });
  herdr.herdr.promptAgent = () => ({ outcome: "rejected", path: "session-match", code: "agent_not_ready", detail: "not ready" });
  assert.equal(tick(index, herdr, T0 + MIN).runs[0].action, "failed");
  herdr.herdr.promptAgent = () => ({ outcome: "unknown", path: "session-match", code: "herdr_prompt_timeout", detail: "timeout" });
  assert.equal(tick(index, herdr, T0 + 2 * MIN).runs[0].action, "sent", "retried after a rejection");
  assert.equal(tick(index, herdr, T0 + 3 * MIN).runs[0].action, "none", "not retried after an unknown outcome");
});
