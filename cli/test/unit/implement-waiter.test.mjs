import assert from "node:assert/strict";
import test from "node:test";

import { waitForEvent } from "../../dist/implement/waiter.js";

const event = (id, at) => ({ id, at, kind: "task-status", actor: "implementor", subject: `T${id}`, summary: `T${id} closed` });

// A controllable clock: no test may depend on the ten-minute production bound.
function harness({ events = [], stallMs = 60_000, isAlive = undefined, script = [] } = {}) {
  let clock = Date.parse("2026-08-29T00:00:00.000Z");
  const log = [...events];
  let tick = 0;
  return {
    log,
    options: {
      loadState: () => ({ events: [...log], createdAt: "2026-08-29T00:00:00.000Z" }),
      stallMs,
      pollMs: 1_000,
      isAlive,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        const step = script[tick];
        tick += 1;
        if (typeof step === "function") step(log, clock);
      },
    },
    at: () => new Date(clock).toISOString(),
  };
}

test("AC23: events already past the cursor return without waiting", async () => {
  const h = harness({ events: [event(1, "2026-08-29T00:00:00.000Z"), event(2, "2026-08-29T00:00:01.000Z")] });
  const outcome = await waitForEvent({ ...h.options, since: 1 });
  assert.equal(outcome.reason, "event");
  assert.equal(outcome.waitedMs, 0, "no sleep may happen before a backlog is delivered");
  assert.deepEqual(outcome.events.map((entry) => entry.id), [2]);
  assert.equal(outcome.cursor, 2);
});

test("AC23: a cursor at the newest id does not replay, and the next event still arrives", async () => {
  const h = harness({
    events: [event(1, "2026-08-29T00:00:00.000Z")],
    script: [(log) => log.push(event(2, "2026-08-29T00:00:05.000Z"))],
  });
  const outcome = await waitForEvent({ ...h.options, since: 1 });
  assert.equal(outcome.reason, "event");
  assert.deepEqual(outcome.events.map((entry) => entry.id), [2], "only the new event, never the one already seen");
  assert.ok(outcome.waitedMs > 0);
});

test("AC22/AC25: silence past the bound ends the wait as a stall", async () => {
  const h = harness({ events: [event(1, "2026-08-29T00:00:00.000Z")], stallMs: 5_000 });
  const outcome = await waitForEvent({ ...h.options, since: 1 });
  assert.equal(outcome.reason, "stall");
  assert.deepEqual(outcome.events, []);
  assert.match(outcome.detail, /no event for \d+s, past the 5s no-progress bound/);
  assert.equal(outcome.cursor, 1, "a stall does not move the cursor");
});

// Re-arming must not reset the clock, or a supervisor that keeps re-arming
// could never observe a stall at all.
test("AC25: the stall clock runs from the last event, not from when the waiter started", async () => {
  const h = harness({ events: [event(1, "2026-08-29T00:00:00.000Z")], stallMs: 5_000 });
  h.options.now = () => Date.parse("2026-08-29T00:00:30.000Z");
  const outcome = await waitForEvent({ ...h.options, since: 1 });
  assert.equal(outcome.reason, "stall");
  assert.equal(outcome.waitedMs, 0, "already past the bound on arrival");
});

test("AC22: a dead implementor ends the wait as implementor-gone", async () => {
  const h = harness({ events: [event(1, "2026-08-29T00:00:00.000Z")], stallMs: 600_000, isAlive: () => false });
  const outcome = await waitForEvent({ ...h.options, since: 1 });
  assert.equal(outcome.reason, "implementor-gone");
  assert.match(outcome.detail, /can no longer be followed/);
});

test("AC22: exactly one reason, and an unavailable liveness probe is admitted rather than assumed", async () => {
  const reasons = new Set();
  for (const setup of [
    { events: [event(1, "2026-08-29T00:00:00.000Z"), event(2, "2026-08-29T00:00:01.000Z")], since: 1 },
    { events: [event(1, "2026-08-29T00:00:00.000Z")], stallMs: 5_000, since: 1 },
    { events: [event(1, "2026-08-29T00:00:00.000Z")], stallMs: 600_000, isAlive: () => false, since: 1 },
  ]) {
    const { since, ...rest } = setup;
    const h = harness(rest);
    const outcome = await waitForEvent({ ...h.options, since });
    assert.equal(typeof outcome.reason, "string");
    reasons.add(outcome.reason);
  }
  assert.deepEqual([...reasons].sort(), ["event", "implementor-gone", "stall"]);

  const h = harness({ events: [event(1, "2026-08-29T00:00:00.000Z")], stallMs: 5_000 });
  const outcome = await waitForEvent({ ...h.options, since: 1 });
  assert.match(outcome.detail, /liveness could not be probed/, "a missing probe is stated, not silently treated as alive");
});

test("AC24: the waiter only reads; it never edits or removes an event", async () => {
  const original = [event(1, "2026-08-29T00:00:00.000Z"), event(2, "2026-08-29T00:00:01.000Z")];
  const snapshot = JSON.stringify(original);
  const h = harness({ events: original, stallMs: 5_000 });
  await waitForEvent({ ...h.options, since: null });
  await waitForEvent({ ...h.options, since: 2 });
  assert.equal(JSON.stringify(h.log), snapshot);
});

test("a null cursor delivers the whole log so a fresh supervisor is not born blind", async () => {
  const h = harness({ events: [event(1, "2026-08-29T00:00:00.000Z"), event(2, "2026-08-29T00:00:01.000Z")] });
  const outcome = await waitForEvent({ ...h.options, since: null });
  assert.deepEqual(outcome.events.map((entry) => entry.id), [1, 2]);
});

test("observation errors and unknown answers never become a lost target", async () => {
  for (const isAlive of [() => null, () => { throw new Error("socket unavailable"); }]) {
    const h = harness({ events: [event(1, "2026-08-29T00:00:00.000Z")], stallMs: 2_000, isAlive });
    const stalled = await waitForEvent({ ...h.options, since: 1 });
    assert.equal(stalled.reason, "stall");
    assert.match(stalled.detail, /observation.*(unavailable|failed)/);
    h.options.sleep = async () => h.log.push(event(2, h.at()));
    const changed = await waitForEvent({ ...h.options, since: 1, notifyAfter: stalled.notifyAfter });
    assert.equal(changed.reason, "event");
    assert.match(changed.detail, /observation/);
  }
});

test("stall re-arms carry a next notification time without changing the silence clock", async () => {
  const h = harness({ events: [event(1, "2026-08-29T00:00:00.000Z")], stallMs: 5_000 });
  let outcome = await waitForEvent({ ...h.options, since: 1 });
  for (let round = 0; round < 3; round += 1) {
    outcome = await waitForEvent({ ...h.options, since: outcome.cursor, notifyAfter: outcome.notifyAfter });
    assert.equal(outcome.reason, "stall");
    assert.equal(outcome.waitedMs, 5_000);
    assert.match(outcome.detail, new RegExp(`no event for ${(round + 2) * 5}s`));
  }
  h.log.push(event(2, h.at()));
  const pending = await waitForEvent({ ...h.options, since: 1, notifyAfter: outcome.notifyAfter });
  assert.equal(pending.reason, "event");
  assert.equal(pending.waitedMs, 0);
  assert.equal(pending.notifyAfter, undefined, "a new event resets notification scheduling");
});

// Tier 2: a named target is watched by one bounded child instead of a probe
// per second. Every test below drives that child through the `observe` seam,
// because the race between an event and a child exit has no other seam and a
// test that had to spawn herdr to reach it would not have been written.

const silentRun = (minutesAgo = 11) => {
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return { createdAt: at, events: [{ id: 4, at, kind: "row-status" }] };
};

const observing = (observation, { onCall } = {}) => (input) => {
  onCall?.(input);
  return Promise.resolve(observation);
};

// herdr may report a settled state it only saw in passing, so this can never
// mean "the target is stopped now" - only "look sooner".
test("a settled observation brings the stall forward and says the conclusion is not settled", async () => {
  const outcome = await waitForEvent({
    loadState: () => silentRun(1), since: 4, stallMs: 10 * 60_000, agent: "impl",
    observe: observing({ kind: "settled", detail: "settled was observed, possibly transiently" }),
  });
  assert.equal(outcome.reason, "stall");
  assert.match(outcome.detail, /early inspection candidate/);
  assert.match(outcome.detail, /no per-second target-loss detection remains/, "the wake must state the trade it just made");
  assert.equal(typeof outcome.notifyAfter, "number");
});

// The early inspection is spent once per silence interval. Re-arming with the
// value the CLI just handed back must not start another short observation,
// because that either spins on settled or opens a blind window.
test("a re-arm after an early inspection starts no second observation for the same silence", async () => {
  let started = 0;
  const outcome = await waitForEvent({
    loadState: () => silentRun(11), since: 4, stallMs: 10 * 60_000, agent: "impl", notifyAfter: Date.now() - 1,
    observe: observing({ kind: "settled", detail: "x" }, { onCall: () => { started += 1; } }),
  });
  assert.equal(started, 0, "the consumed interval must not observe again");
  assert.match(outcome.detail, /early inspection is consumed for this silence interval/);
});

// A target that cannot be followed is not a dead process: a moved pane reports
// the same way, so the wake must send the supervisor to look, not to replace.
test("a lost target wakes as implementor-gone without claiming the process died", async () => {
  const outcome = await waitForEvent({
    loadState: () => silentRun(1), since: 4, stallMs: 10 * 60_000, agent: "impl",
    observe: observing({ kind: "gone", detail: "watched target can no longer be followed (agent_not_running); this does not prove process death" }),
  });
  assert.equal(outcome.reason, "implementor-gone");
  assert.match(outcome.detail, /does not prove process death/);
});

// An observation that failed is not an answer. Collapsing it into absence is
// the defect that reported a live implementor as gone and dropped the re-arm.
test("an unavailable observation never becomes absence and never ends the wait", async () => {
  const outcome = await waitForEvent({
    loadState: () => silentRun(0), since: 4, stallMs: 250, pollMs: 20, agent: "impl",
    observe: observing({ kind: "unavailable", detail: "observation unavailable (server_not_running); event and time monitoring continue" }),
  });
  assert.equal(outcome.reason, "stall", "an unreadable screen must not end the wait as a loss");
  assert.match(outcome.detail, /observation unavailable/);
});

// Events are the only evidence of progress, so a wake that could be either
// must be the event.
test("an event that lands with an observation is reported as the event", async () => {
  const at = new Date().toISOString();
  const state = { createdAt: at, events: [{ id: 4, at, kind: "row-status" }, { id: 5, at, kind: "check-attempt" }] };
  const outcome = await waitForEvent({
    loadState: () => state, since: 4, stallMs: 10 * 60_000, agent: "impl",
    observe: observing({ kind: "settled", detail: "x" }),
  });
  assert.equal(outcome.reason, "event");
  assert.equal(outcome.cursor, 5);
});

// One exit path owns cancellation. A one-shot that returned while its child
// still ran would leak a herdr process per wake.
test("every exit cancels the observation exactly once, including the event race", async () => {
  const at = new Date().toISOString();
  const state = { createdAt: at, events: [{ id: 4, at, kind: "row-status" }] };
  let aborts = 0;
  let reads = 0;
  const outcome = await waitForEvent({
    // The event lands only after the child is already waiting, which is the
    // race the single cleanup path exists for.
    loadState: () => {
      reads += 1;
      if (reads > 2) return { ...state, events: [...state.events, { id: 9, at, kind: "verify" }] };
      return state;
    },
    since: 4, stallMs: 10 * 60_000, pollMs: 10, agent: "impl",
    observe: ({ signal }) => new Promise((resolve) => {
      signal.addEventListener("abort", () => { aborts += 1; resolve({ kind: "unavailable", detail: "cancelled" }); }, { once: true });
    }),
  });
  assert.equal(outcome.reason, "event");
  assert.equal(aborts, 1, "the child must be cancelled exactly once when the event wins");
});

test("a failed spawn is reported as an unreadable observation, not raised at the supervisor", async () => {
  const outcome = await waitForEvent({
    loadState: () => silentRun(0), since: 4, stallMs: 250, pollMs: 20, agent: "impl",
    observe: () => Promise.resolve({ kind: "unavailable", detail: "observation unavailable: spawn ENOENT" }),
  });
  assert.equal(outcome.reason, "stall");
  assert.match(outcome.detail, /spawn ENOENT/);
});
