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
