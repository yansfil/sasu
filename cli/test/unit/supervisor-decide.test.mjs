import assert from "node:assert/strict";
import test from "node:test";

import { decideRun, episodeKey, judgeObserver } from "../../dist/supervisor/decide.js";
import { STALL_THRESHOLD_MS } from "../../dist/implement/types.js";
import { TICK_INTERVAL_MS } from "../../dist/supervisor/paths.js";

// The expected answers below come from the PRD's Behaviors table (B5-B9,
// B15), not from reading decide.ts: each test names the row it holds to.
const T0 = Date.parse("2026-09-18T10:00:00.000Z");
const MIN = 60_000;

const OBSERVER = { runtime: "claude", sessionId: "obs-uuid", terminalId: "term_obs", paneId: "w1:p1", hostScope: "sock", recordedAt: new Date(T0).toISOString() };

function facts(overrides = {}) {
  return {
    slug: "fixture", status: "active", lastEventAt: T0, lastEventId: 3, lastEscalateId: null,
    dispatchedAt: T0, patrolIntervalMs: 15 * MIN, observer: OBSERVER,
    implementor: { paneId: "w2:p1", agent: "impl", sessionId: "impl-uuid", terminalId: "term_impl", hostScope: "sock", recordedAt: new Date(T0).toISOString() },
    ...overrides,
  };
}

const found = (fields) => ({ kind: "found", agent: { paneId: "w2:p1", name: "impl", kind: "claude", sessionId: "impl-uuid", terminalId: "term_impl", status: "working", activityAt: T0, stateChangeSeq: 7, inputGuard: null, ...fields } });
const observerFound = (fields = {}) => ({ kind: "found", agent: { paneId: "w1:p1", name: null, kind: "claude", sessionId: "obs-uuid", terminalId: "term_obs", status: "idle", activityAt: T0, stateChangeSeq: 2, inputGuard: null, ...fields } });

const decide = (f, implementor, now, { observer = observerFound(), lastWake = null } = {}) => decideRun(facts(f), { implementor, observer }, lastWake, now);
const reasons = (decision) => decision.due.map((entry) => entry.reason);

test("B5: a working implementor with no other cause wakes nobody before the patrol interval", () => {
  const decision = decide({}, found({ status: "working" }), T0 + 14 * MIN);
  assert.deepEqual(reasons(decision), []);
  assert.deepEqual(decision.candidates, []);
});

test("B7: a working implementor past the patrol interval wakes once with reason patrol, then not again until the next interval", () => {
  const first = decide({}, found({ status: "working" }), T0 + 15 * MIN);
  assert.deepEqual(reasons(first), ["patrol"]);
  const wake = { at: new Date(T0 + 15 * MIN).toISOString(), reasons: ["patrol"], episode: episodeKey(first.due), outcome: "accepted", path: "session-match", code: "submitted" };
  assert.deepEqual(reasons(decide({}, found({ status: "working" }), T0 + 16 * MIN, { lastWake: wake })), [], "the same patrol interval is not repeated");
  assert.deepEqual(reasons(decide({}, found({ status: "working" }), T0 + 30 * MIN, { lastWake: wake })), ["patrol"], "the next interval patrols again");
});

test("B7: the patrol interval is the run's own setting", () => {
  assert.deepEqual(reasons(decide({ patrolIntervalMs: 5 * MIN }, found({ status: "working" }), T0 + 5 * MIN)), ["patrol"]);
  assert.deepEqual(reasons(decide({ patrolIntervalMs: 30 * MIN }, found({ status: "working" }), T0 + 20 * MIN)), []);
});

test("B8: settled needs the idle state to be older than one tick interval, so a momentary idle between two ticks does not wake", () => {
  const justIdle = decide({}, found({ status: "idle", activityAt: T0 + 10 * MIN }), T0 + 10 * MIN + TICK_INTERVAL_MS - 1);
  assert.deepEqual(reasons(justIdle), []);
  const confirmed = decide({}, found({ status: "idle", activityAt: T0 + 10 * MIN }), T0 + 10 * MIN + TICK_INTERVAL_MS);
  assert.deepEqual(reasons(confirmed), ["settled"]);
  assert.match(confirmed.due[0].detail, /possibly transient/);
  assert.deepEqual(reasons(decide({}, found({ status: "done", activityAt: T0 }), T0 + MIN)), ["settled"], "done settles the same way");
});

test("B8: settled is answered once per lifecycle episode and again for a new one", () => {
  const first = decide({}, found({ status: "idle", activityAt: T0, stateChangeSeq: 7 }), T0 + MIN);
  const wake = { at: new Date(T0 + MIN).toISOString(), reasons: ["settled"], episode: episodeKey(first.due), outcome: "accepted", path: "session-match", code: "submitted" };
  assert.deepEqual(reasons(decide({}, found({ status: "idle", activityAt: T0, stateChangeSeq: 7 }), T0 + 2 * MIN, { lastWake: wake })), []);
  assert.deepEqual(reasons(decide({}, found({ status: "idle", activityAt: T0 + 2 * MIN, stateChangeSeq: 9 }), T0 + 3 * MIN, { lastWake: wake })), ["settled"], "worked, then settled again: a new episode");
});

test("B8: blocked wakes at once and is not repeated while the same block lasts", () => {
  const first = decide({}, found({ status: "blocked", stateChangeSeq: 4 }), T0 + MIN);
  assert.deepEqual(reasons(first), ["blocked"]);
  const wake = { at: new Date(T0 + MIN).toISOString(), reasons: ["blocked"], episode: episodeKey(first.due), outcome: "accepted", path: "session-match", code: "submitted" };
  assert.deepEqual(reasons(decide({}, found({ status: "blocked", stateChangeSeq: 4 }), T0 + 2 * MIN, { lastWake: wake })), []);
});

test("B8/D-09: an unaccepted wake does not count as answered, so bounded delivery policy can retry it", () => {
  const first = decide({}, found({ status: "blocked", stateChangeSeq: 4 }), T0 + MIN);
  const rejected = { at: new Date(T0 + MIN).toISOString(), reasons: ["blocked"], episode: episodeKey(first.due), outcome: "rejected", path: "session-match", code: "agent_blocked" };
  assert.deepEqual(reasons(decide({}, found({ status: "blocked", stateChangeSeq: 4 }), T0 + 2 * MIN, { lastWake: rejected })), ["blocked"]);
  const unknown = { ...rejected, outcome: "unknown", code: "herdr_prompt_timeout" };
  assert.deepEqual(
    reasons(decide({}, found({ status: "blocked", stateChangeSeq: 4 }), T0 + 2 * MIN, { lastWake: unknown })),
    ["blocked"],
    "an unknown outcome remains due; the tick layer applies the two-attempt delivery cap",
  );
});

test("B8: an escalate event wakes once per event", () => {
  const first = decide({ lastEscalateId: 5 }, found({ status: "working" }), T0 + MIN);
  assert.deepEqual(reasons(first), ["escalate"]);
  const wake = { at: new Date(T0 + MIN).toISOString(), reasons: ["escalate"], episode: episodeKey(first.due), outcome: "accepted", path: "session-match", code: "submitted" };
  assert.deepEqual(reasons(decide({ lastEscalateId: 5 }, found({ status: "working" }), T0 + 2 * MIN, { lastWake: wake })), []);
  assert.deepEqual(reasons(decide({ lastEscalateId: 6 }, found({ status: "working" }), T0 + 2 * MIN, { lastWake: wake })), ["escalate"]);
});

test("B6: ten minutes without events while herdr shows the implementor working is not a stall", () => {
  const decision = decide({ lastEventAt: T0 - 11 * MIN }, found({ status: "working", activityAt: T0 - 11 * MIN }), T0);
  assert.deepEqual(reasons(decision), []);
});

test("B6: ten minutes without events AND without herdr activity is one stall wake", () => {
  const decision = decide({ lastEventAt: T0 - 11 * MIN, lastEventId: 3 }, found({ status: "unknown", activityAt: T0 - 11 * MIN }), T0);
  assert.deepEqual(reasons(decision), ["stall"]);
  const wake = { at: new Date(T0).toISOString(), reasons: ["stall"], episode: episodeKey(decision.due), outcome: "accepted", path: "session-match", code: "submitted" };
  assert.deepEqual(reasons(decide({ lastEventAt: T0 - 11 * MIN, lastEventId: 3 }, found({ status: "unknown", activityAt: T0 - 11 * MIN }), T0 + MIN, { lastWake: wake })), [], "the same silence is one wake");
  assert.deepEqual(reasons(decide({ lastEventAt: T0 - 11 * MIN, lastEventId: 4 }, found({ status: "unknown", activityAt: T0 - 11 * MIN }), T0 + 12 * MIN, { lastWake: wake })), ["stall"], "a new event followed by new silence is a new stall");
});

test("B6: recent herdr activity alone keeps a run out of stall, and recent events alone do too", () => {
  assert.deepEqual(reasons(decide({ lastEventAt: T0 - 11 * MIN }, found({ status: "unknown", activityAt: T0 - 9 * MIN }), T0)), []);
  assert.deepEqual(reasons(decide({ lastEventAt: T0 - 9 * MIN }, found({ status: "unknown", activityAt: T0 - 11 * MIN }), T0)), []);
  assert.deepEqual(reasons(decide({ lastEventAt: T0 - STALL_THRESHOLD_MS }, found({ status: "unknown", activityAt: T0 - STALL_THRESHOLD_MS }), T0)), ["stall"], "the threshold itself is inclusive");
});

test("B6/B8: an idle or blocked implementor that is also ten minutes silent wakes for its settled or blocked state only, not additionally for stall", () => {
  // The mutation pass showed this pair was unasserted: dropping the
  // suppression clause left every test green while a settled run would
  // have been reported twice, as settled and as stall, in one wake.
  assert.deepEqual(reasons(decide({ lastEventAt: T0 - 11 * MIN }, found({ status: "idle", activityAt: T0 - 11 * MIN }), T0)), ["settled"]);
  assert.deepEqual(reasons(decide({ lastEventAt: T0 - 11 * MIN }, found({ status: "blocked", activityAt: T0 - 11 * MIN }), T0)), ["blocked"]);
  assert.deepEqual(reasons(decide({ lastEventAt: T0 - 11 * MIN }, { kind: "absent" }, T0)), ["implementor-gone"]);
});

test("B12: with herdr unobservable the stall is judged from state.json alone, and the wake waits for the Observer to be verifiable", () => {
  const unavailable = { kind: "unavailable", detail: "socket down" };
  const decision = decideRun(facts({ lastEventAt: T0 - 11 * MIN }), { implementor: unavailable, observer: unavailable }, null, T0);
  assert.deepEqual(reasons(decision), ["stall"]);
  assert.match(decision.deferral, /observer unobservable/);
  assert.equal(decision.implementor.kind, "unobservable");
});

test("B8: an implementor that left its pane, or whose pane holds another agent, wakes implementor-gone once", () => {
  const gone = decide({}, { kind: "absent", detail: "nobody" }, T0 + MIN);
  assert.deepEqual(reasons(gone), ["implementor-gone"]);
  const replaced = decide({}, found({ name: "someone-else" }), T0 + MIN);
  assert.deepEqual(reasons(replaced), ["implementor-gone"]);
  const wake = { at: new Date(T0 + MIN).toISOString(), reasons: ["implementor-gone"], episode: episodeKey(gone.due), outcome: "accepted", path: "session-match", code: "submitted" };
  assert.deepEqual(reasons(decide({}, { kind: "absent", detail: "nobody" }, T0 + 2 * MIN, { lastWake: wake })), []);
});

test("B8: a replacement implementor session in the same named pane is implementor-gone", () => {
  assert.deepEqual(reasons(decide({}, found({ sessionId: "replacement-session" }), T0 + MIN)), ["implementor-gone"]);
  assert.deepEqual(reasons(decide({}, found({ terminalId: "replacement-terminal" }), T0 + MIN)), ["implementor-gone"]);
});

test("B15: a retired run wakes with reason terminal and is marked to leave the index", () => {
  const decision = decide({ status: "retired" }, found({ status: "idle", activityAt: T0 }), T0 + MIN);
  assert.deepEqual(reasons(decision), ["terminal"]);
  assert.equal(decision.terminal, true);
  assert.equal(decision.candidates.length, 1, "a finished run reports nothing else");
});

test("B9/D-06: a different session UUID or terminal in the Observer's pane is observer-gone and defers every wake", () => {
  const otherSession = decide({}, found({ status: "blocked" }), T0 + MIN, { observer: observerFound({ sessionId: "someone-else" }) });
  assert.equal(otherSession.observer.kind, "observer-gone");
  assert.match(otherSession.deferral, /observer-gone/);
  assert.match(otherSession.observer.detail, /no input is sent to the replacement/);
  // The 2026-09-18 live smoke read this detail in `supervisor status` and
  // found no way out named; B18 says the way out is an explicit handover.
  assert.match(otherSession.observer.detail, /sasu supervisor handover --slug <slug> --approval/);
  const otherTerminal = decide({}, found({ status: "blocked" }), T0 + MIN, { observer: observerFound({ terminalId: "term_new" }) });
  assert.equal(otherTerminal.observer.kind, "observer-gone");
  assert.match(otherTerminal.observer.detail, /sasu supervisor handover/);
  const emptyPane = judgeObserver(OBSERVER, { kind: "absent", detail: "nobody" });
  assert.equal(emptyPane.kind, "observer-gone");
  assert.match(emptyPane.detail, /sasu supervisor handover/);
  assert.equal(judgeObserver(OBSERVER, { kind: "unavailable", detail: "down" }).kind, "unobservable", "an unanswered lookup proves nothing");
});

test("B8: a working Observer defers the wake to a later tick, a blocked one too, an idle one receives it", () => {
  assert.match(decide({}, found({ status: "blocked" }), T0 + MIN, { observer: observerFound({ status: "working" }) }).deferral, /observer is working/);
  assert.match(decide({}, found({ status: "blocked" }), T0 + MIN, { observer: observerFound({ status: "blocked" }) }).deferral, /observer is blocked/);
  assert.equal(decide({}, found({ status: "blocked" }), T0 + MIN, { observer: observerFound({ status: "idle" }) }).deferral, null);
  assert.equal(decide({}, found({ status: "blocked" }), T0 + MIN, { observer: observerFound({ status: "done" }) }).deferral, null);
});

test("B11: the guard herdr returns for the Observer rides on the match verdict", () => {
  const guarded = decide({}, found({ status: "blocked" }), T0 + MIN, { observer: observerFound({ inputGuard: "g-1" }) });
  assert.deepEqual(guarded.observer, { kind: "match", status: "idle", inputGuard: "g-1" });
});

test("B3: the decision is a function of the facts alone - the same inputs at the same instant agree", () => {
  const a = decide({ lastEscalateId: 2 }, found({ status: "blocked", stateChangeSeq: 3 }), T0 + 3 * MIN);
  const b = decide({ lastEscalateId: 2 }, found({ status: "blocked", stateChangeSeq: 3 }), T0 + 3 * MIN);
  assert.deepEqual(a, b);
  assert.deepEqual(reasons(a), ["blocked", "escalate"]);
  assert.equal(episodeKey(a.due), "blocked:3|escalate:2");
});
