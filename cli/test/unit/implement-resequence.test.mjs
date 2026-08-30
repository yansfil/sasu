import assert from "node:assert/strict";
import test from "node:test";

import { recordVerb, rejectVerb, resequencePendingTasks } from "../../dist/implement/verbs.js";

const task = (id, status = "pending", dependsOn = []) => ({
  id, text: id, title: id, requirements: [], acceptanceCriteria: [], status, evidence: [], dependsOn,
});

const stateWith = (tasks) => ({ tasks, verbs: [] });

test("AC17: a permutation of exactly the pending set is accepted", () => {
  const state = stateWith([task("T1"), task("T2"), task("T3")]);
  assert.deepEqual(resequencePendingTasks(state, ["T3", "T1", "T2"]), ["T3", "T1", "T2"]);
  assert.deepEqual(state.tasks.map((entry) => entry.id), ["T3", "T1", "T2"]);
});

test("AC17: naming a non-pending task is refused and says why", () => {
  const state = stateWith([task("T1", "complete"), task("T2"), task("T3")]);
  assert.throws(
    () => resequencePendingTasks(state, ["T1", "T2", "T3"]),
    /T1 is not pending.*park or amendment, not resequence/s,
  );
  assert.throws(() => resequencePendingTasks(state, ["T9", "T2", "T3"]), /unknown task\(s\) in resequence: T9/);
});

test("AC17: a partial order or a duplicate is refused", () => {
  const state = stateWith([task("T1"), task("T2"), task("T3")]);
  assert.throws(() => resequencePendingTasks(state, ["T3", "T1"]), /missing T2/);
  assert.throws(() => resequencePendingTasks(state, ["T1", "T1", "T2"]), /lists T1 more than once/);
  assert.deepEqual(state.tasks.map((entry) => entry.id), ["T1", "T2", "T3"], "a refused order changes nothing");
});

// AC18 rests on this: dependsOn is materialized when the PRD is parsed, so
// array position carries no dependency meaning and moving a task cannot
// change what gates it.
test("AC18: reordering moves no dependency and touches no evidence", () => {
  const state = stateWith([
    task("T1", "pending", []),
    task("T2", "pending", ["T1"]),
    task("T3", "pending", ["T1"]),
  ]);
  state.tasks[1].evidence = [{ at: "t", text: "prior evidence" }];
  resequencePendingTasks(state, ["T3", "T2", "T1"]);
  const byId = Object.fromEntries(state.tasks.map((entry) => [entry.id, entry]));
  assert.deepEqual(byId.T2.dependsOn, ["T1"], "T2 still waits on T1 after being moved ahead of it");
  assert.deepEqual(byId.T3.dependsOn, ["T1"]);
  assert.deepEqual(byId.T1.dependsOn, []);
  assert.deepEqual(byId.T2.evidence, [{ at: "t", text: "prior evidence" }]);
  for (const entry of state.tasks) assert.equal(entry.status, "pending");
});

test("completed and blocked tasks keep their slots while pending ones move around them", () => {
  const state = stateWith([task("T1"), task("T2", "complete"), task("T3"), task("T4", "blocked"), task("T5")]);
  resequencePendingTasks(state, ["T5", "T3", "T1"]);
  assert.deepEqual(state.tasks.map((entry) => entry.id), ["T5", "T2", "T3", "T4", "T1"]);
  assert.equal(state.tasks[1].status, "complete");
  assert.equal(state.tasks[3].status, "blocked");
});

test("verb history records refusals with the check that refused, and ids stay monotonic", () => {
  const state = stateWith([task("T1")]);
  let flushed = 0;
  recordVerb(state, { at: "t1", verb: "resequence", issuer: "observer", target: null, reason: "r", outcome: "accepted" });
  assert.throws(
    () => rejectVerb(state, { verb: "park", issuer: "observer", target: "AC7", reason: "r", at: "t2" }, "authority", "not yours to park", () => { flushed += 1; }),
    /not yours to park/,
  );
  assert.equal(flushed, 1, "the refusal is flushed before it is thrown, or the history never learns about it");
  assert.deepEqual(state.verbs.map((entry) => entry.id), [1, 2]);
  assert.equal(state.verbs[0].rejection, null);
  assert.equal(state.verbs[1].outcome, "rejected");
  assert.equal(state.verbs[1].rejection.check, "authority");
});
