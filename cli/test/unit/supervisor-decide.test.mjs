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
    slug: "fixture", status: "active", lastEventAt: T0, lastEventId: 3, lastEscalateId: null, lastPlan: null, repeatedFail: null,
    dispatchedAt: T0, patrolIntervalMs: 15 * MIN, observer: OBSERVER,
    implementor: { paneId: "w2:p1", agent: "impl", sessionId: "impl-uuid", terminalId: "term_impl", hostScope: "sock", recordedAt: new Date(T0).toISOString() },
    ...overrides,
  };
}

const found = (fields) => ({ kind: "found", agent: { paneId: "w2:p1", name: "impl", kind: "claude", sessionId: "impl-uuid", terminalId: "term_impl", status: "working", activityAt: T0, stateChangeSeq: 7, inputGuard: null, ...fields } });
const observerFound = (fields = {}) => ({ kind: "found", agent: { paneId: "w1:p1", name: null, kind: "claude", sessionId: "obs-uuid", terminalId: "term_obs", status: "idle", activityAt: T0, stateChangeSeq: 2, inputGuard: null, ...fields } });
/** The run's git tree as the tick reads it: nothing committed or changed since dispatch unless a test says so. */
const work = (fields = {}) => ({ kind: "read", head: "h0", commitsSinceDispatch: 0, outsideBoundary: [], outsideSince: null, uncommittedFiles: 0, newestChangeAt: null, ...fields });

const decide = (f, implementor, now, { observer = observerFound(), lastWake = null, tree = work() } = {}) => decideRun(facts(f), { implementor, observer, work: tree }, lastWake, now);
const reasons = (decision) => decision.due.map((entry) => entry.reason);
const accepted = (decision, at) => ({ at: new Date(at).toISOString(), reasons: reasons(decision), episode: episodeKey(decision.due), outcome: "accepted", path: "session-match", code: "submitted" });
const detailOf = (decision, reason) => decision.due.find((entry) => entry.reason === reason)?.detail;

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

test("plan: a registered plan wakes once per plan event while the implementor keeps working, and a run without one wakes for nothing", () => {
  const none = decide({}, found({ status: "working" }), T0 + MIN);
  assert.deepEqual(reasons(none), [], "no plan event is not a signal");
  const first = decide({ lastPlan: { id: 4, path: "agents/runs/fixture/plan.md" } }, found({ status: "working" }), T0 + MIN);
  assert.deepEqual(reasons(first), ["plan"]);
  assert.match(first.due[0].detail, /agents\/runs\/fixture\/plan\.md/);
  const wake = { at: new Date(T0 + MIN).toISOString(), reasons: ["plan"], episode: episodeKey(first.due), outcome: "accepted", path: "session-match", code: "submitted" };
  assert.deepEqual(reasons(decide({ lastPlan: { id: 4, path: "agents/runs/fixture/plan.md" } }, found({ status: "working" }), T0 + 2 * MIN, { lastWake: wake })), [], "the same plan is not repeated");
  assert.deepEqual(reasons(decide({ lastPlan: { id: 9, path: "agents/runs/fixture/plan.md" } }, found({ status: "working" }), T0 + 2 * MIN, { lastWake: wake })), ["plan"], "a rewritten plan is a new episode");
});

// The commit and drift rows below hold to the 2026-09-25 observer-drift
// design (docs/plans/2026-09-25-observer-drift-advisor.md), not to decide.ts.
test("commit: a new head since dispatch wakes once, several commits between two ticks are one wake, and no commit wakes nothing", () => {
  assert.deepEqual(reasons(decide({}, found({ status: "working" }), T0 + MIN)), [], "nothing committed since dispatch");
  const first = decide({}, found({ status: "working" }), T0 + MIN, { tree: work({ head: "c1", commitsSinceDispatch: 1 }) });
  assert.deepEqual(reasons(first), ["commit"]);
  const wake = accepted(first, T0 + MIN);
  assert.deepEqual(reasons(decide({}, found({ status: "working" }), T0 + 2 * MIN, { lastWake: wake, tree: work({ head: "c1", commitsSinceDispatch: 1 }) })), [], "the same head is answered once");
  const burst = decide({}, found({ status: "working" }), T0 + 3 * MIN, { lastWake: wake, tree: work({ head: "c3", commitsSinceDispatch: 3 }) });
  assert.deepEqual(reasons(burst), ["commit"], "two new commits since the last look are one wake");
  assert.notEqual(episodeKey(burst.due), episodeKey(first.due));
});

test("commit: a commit wake the Observer received counts as a look, so patrol waits a full interval after it", () => {
  const tree = work({ head: "c1", commitsSinceDispatch: 1 });
  const commit = decide({}, found({ status: "working" }), T0 + 10 * MIN, { tree });
  assert.deepEqual(reasons(commit), ["commit"]);
  const wake = accepted(commit, T0 + 10 * MIN);
  assert.deepEqual(reasons(decide({}, found({ status: "working" }), T0 + 15 * MIN, { lastWake: wake, tree })), [], "15 minutes after dispatch but 5 after the commit wake");
  assert.deepEqual(reasons(decide({}, found({ status: "working" }), T0 + 25 * MIN, { lastWake: wake, tree })), ["patrol"], "no commit for a patrol interval after the last look");
});

test("drift: repeated FAIL attempts on one input raise at once and again every 10 minutes while that attempt stands; a new attempt is a new fact", () => {
  const stuck = { repeatedFail: { attemptId: "V8", count: 3, finishedAt: T0 + 5 * MIN } };
  assert.equal(reasons(decide({}, found({ status: "working" }), T0 + 6 * MIN)).includes("drift"), false, "no repeated failure, no drift");
  const first = decide(stuck, found({ status: "working" }), T0 + 6 * MIN);
  assert.deepEqual(reasons(first), ["drift"]);
  assert.match(detailOf(first, "drift"), /repeated-fail/);
  const firstWake = accepted(first, T0 + 6 * MIN);
  assert.deepEqual(reasons(decide(stuck, found({ status: "working" }), T0 + 14 * MIN, { lastWake: firstWake })), [], "inside the same 10 minutes it is answered");
  const again = decide(stuck, found({ status: "working" }), T0 + 15 * MIN, { lastWake: firstWake });
  assert.deepEqual(reasons(again), ["drift"], "10 minutes after the fact began it is raised again");
  assert.notEqual(episodeKey(again.due), episodeKey(first.due));
  const againWake = accepted(again, T0 + 15 * MIN);
  assert.deepEqual(reasons(decide(stuck, found({ status: "working" }), T0 + 24 * MIN, { lastWake: againWake })), []);
  assert.deepEqual(reasons(decide(stuck, found({ status: "working" }), T0 + 25 * MIN, { lastWake: againWake })), ["drift"]);
  const newer = { repeatedFail: { attemptId: "V9", count: 4, finishedAt: T0 + 8 * MIN } };
  assert.deepEqual(reasons(decide(newer, found({ status: "working" }), T0 + 9 * MIN, { lastWake: firstWake })), ["drift"], "another identical FAIL is a new fact");
});

test("drift: changed paths outside the delivery boundary raise drift naming them; a different set is a new fact; a persisting set re-raises", () => {
  const leaked = work({ outsideBoundary: ["agents/runs/fixture/plan.md"], outsideSince: T0 + MIN });
  const first = decide({}, found({ status: "working" }), T0 + 2 * MIN, { tree: leaked });
  assert.deepEqual(reasons(first), ["drift"]);
  assert.match(detailOf(first, "drift"), /outside-boundary/);
  assert.match(detailOf(first, "drift"), /agents\/runs\/fixture\/plan\.md/);
  const wake = accepted(first, T0 + 2 * MIN);
  assert.deepEqual(reasons(decide({}, found({ status: "working" }), T0 + 3 * MIN, { lastWake: wake, tree: leaked })), []);
  const wider = work({ outsideBoundary: ["agents/runs/fixture/plan.md", "agents/runs/fixture/state.json"], outsideSince: T0 + MIN });
  assert.deepEqual(reasons(decide({}, found({ status: "working" }), T0 + 3 * MIN, { lastWake: wake, tree: wider })), ["drift"]);
  assert.deepEqual(reasons(decide({}, found({ status: "working" }), T0 + 11 * MIN, { lastWake: wake, tree: leaked })), ["drift"], "the same set 10 minutes on");
});

test("drift: uncommitted changes whose newest is 20 minutes old raise drift only while the implementor is working", () => {
  const piled = work({ uncommittedFiles: 2, newestChangeAt: T0 });
  assert.equal(reasons(decide({}, found({ status: "working" }), T0 + 20 * MIN - 1, { tree: piled })).includes("drift"), false, "younger than 20 minutes");
  assert.equal(reasons(decide({}, found({ status: "working" }), T0 + 20 * MIN, { tree: work({ newestChangeAt: T0 }) })).includes("drift"), false, "nothing uncommitted");
  const first = decide({}, found({ status: "working" }), T0 + 20 * MIN, { tree: piled });
  assert.deepEqual(reasons(first), ["drift"]);
  assert.match(detailOf(first, "drift"), /uncommitted-age/);
  const wake = accepted(first, T0 + 20 * MIN);
  assert.deepEqual(reasons(decide({}, found({ status: "working" }), T0 + 29 * MIN, { lastWake: wake, tree: piled })), []);
  assert.deepEqual(reasons(decide({}, found({ status: "working" }), T0 + 30 * MIN, { lastWake: wake, tree: piled })), ["drift"]);
  assert.deepEqual(reasons(decide({}, found({ status: "idle", activityAt: T0 + 24 * MIN }), T0 + 25 * MIN, { tree: piled })), ["settled"], "an idle implementor is settled, not piling up");
  assert.equal(reasons(decide({}, found({ status: "working" }), T0 + 31 * MIN, { lastWake: wake, tree: work({ uncommittedFiles: 3, newestChangeAt: T0 + 22 * MIN }) })).includes("drift"), false, "a newer change clears the fact");
});

test("drift rides along with settled, blocked, stall and a due patrol instead of being suppressed by them", () => {
  const stuck = { repeatedFail: { attemptId: "V8", count: 2, finishedAt: T0 } };
  const leaked = work({ outsideBoundary: ["agents/x.md"], outsideSince: T0 });
  assert.deepEqual(reasons(decide(stuck, found({ status: "blocked" }), T0 + MIN)).sort(), ["blocked", "drift"]);
  assert.deepEqual(reasons(decide({}, found({ status: "idle", activityAt: T0 }), T0 + MIN, { tree: leaked })).sort(), ["drift", "settled"]);
  assert.deepEqual(reasons(decide({ lastEventAt: T0 - 11 * MIN }, found({ status: "unknown", activityAt: T0 - 11 * MIN }), T0, { tree: leaked })).sort(), ["drift", "stall"]);
  const patrolDue = decide(stuck, found({ status: "working" }), T0 + 15 * MIN);
  assert.equal(reasons(patrolDue).includes("drift"), true, "the patrol interval elapsing does not replace drift");
  const both = decide(stuck, found({ status: "working" }), T0 + MIN, { tree: leaked });
  assert.deepEqual(reasons(both), ["drift"], "two drift facts are one reason");
  assert.match(detailOf(both, "drift"), /repeated-fail[\s\S]*outside-boundary|outside-boundary[\s\S]*repeated-fail/, "the detail names every fact present");
});

test("drift and commit: an unreadable git tree adds neither, and the state-derived reasons still decide", () => {
  const unreadable = { kind: "unavailable", detail: "git unavailable" };
  assert.deepEqual(reasons(decide({}, found({ status: "blocked" }), T0 + MIN, { tree: unreadable })), ["blocked"]);
  assert.deepEqual(reasons(decide({ repeatedFail: { attemptId: "V8", count: 2, finishedAt: T0 } }, found({ status: "working" }), T0 + MIN, { tree: unreadable })), ["drift"]);
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
  const decision = decideRun(facts({ lastEventAt: T0 - 11 * MIN }), { implementor: unavailable, observer: unavailable, work: work() }, null, T0);
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
  assert.deepEqual(reasons(decide({}, found({ name: null }), T0 + MIN)), ["implementor-gone"], "an unnamed agent is not the exact dispatched identity");
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
