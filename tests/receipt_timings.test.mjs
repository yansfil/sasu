// Phase-timings computer: sums only what was measured, attributes nothing.
// (Wiring into the finalize receipt is asserted separately once the receipt
// builder lands; this file pins the pure computation contract.)
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const requireModule = createRequire(import.meta.url);
const { computePhaseTimings } = requireModule(path.join(repoRoot, "cli", "lib", "phase_timings.js"));

const state = {
  createdAt: "2026-08-10T10:00:00.000Z",
  tasks: [
    // Batch-marked in one burst, exactly as every audited run did: the ts is
    // when the claim was recorded, not when the work happened.
    { id: "T1", status: "complete", evidence: [{ ts: "2026-08-10T10:20:00.000Z", text: "done" }] },
    {
      id: "T2",
      status: "complete",
      evidence: [
        { ts: "2026-08-10T10:20:01.000Z", text: "done" },
        // A reconcile reset plus its re-mark land later; the boundary is the
        // FIRST claim, so neither may drag it.
        { ts: "2026-08-10T10:45:00.000Z", text: "PRD reconcile: definition changed; status reset from 'complete' to 'pending'." },
        { ts: "2026-08-10T10:46:00.000Z", text: "re-done" },
      ],
    },
    // A resolved-but-unimplemented task carries no evidence and must not
    // refuse the boundary.
    { id: "T3", status: "deferred", evidence: [] },
  ],
  verification: [
    {
      id: "V1",
      artifacts: [
        { kind: "command-log", startedAt: "2026-08-10T10:10:00.000Z", finishedAt: "2026-08-10T10:10:30.000Z" },
        // A later re-run of the same item counts too.
        { kind: "command-log", startedAt: "2026-08-10T10:40:00.000Z", finishedAt: "2026-08-10T10:40:20.000Z" },
        // Non-command evidence carries no duration and must not count.
        { kind: "screenshot", path: "x.png" },
      ],
    },
    {
      id: "V2",
      artifacts: [
        // Malformed timestamps are skipped, never NaN-poisoning the sum.
        { kind: "command-log", startedAt: "not-a-date", finishedAt: "2026-08-10T10:11:00.000Z" },
        { kind: "command-log", startedAt: "2026-08-10T10:12:00.000Z", finishedAt: "2026-08-10T10:12:40.000Z" },
      ],
    },
  ],
  requirementsFidelityReview: { recordedAt: "2026-08-10T10:50:00.000Z" },
  finalReview: null,
};

const gatesState = {
  judgeCalls: [
    { purpose: "gate:verify-semantic", durationMs: 15000 },
    { purpose: "gate:verify-semantic:lane:2", durationMs: 14000 },
    { purpose: "gate:spec:lane:fidelity", durationMs: 5000 },
    { purpose: "gate:gap-audit:lane:goal-scope", durationMs: 4000 },
    { purpose: "gate:verify-semantic", durationMs: "broken" },
  ],
  // attempts is the retry-budget gauge (reset to 0 by the final PASS);
  // totalAttempts is the cumulative run counter the receipt must quote.
  gates: { verify: { attempts: 0, totalAttempts: 3 } },
};

test("sums command-log durations and judge calls, bucketed by gate", () => {
  const timings = computePhaseTimings({ state, gatesState, now: "2026-08-10T11:00:00.000Z" });
  assert.equal(timings.schema, "hoyeon.phase-timings.v2");
  assert.equal(timings.measured.verificationCommandSeconds, 90); // 30 + 20 + 40
  assert.equal(timings.measured.verificationCommandRuns, 3);
  assert.equal(timings.measured.judgeSeconds, 38);
  assert.equal(timings.measured.judgeCalls, 4);
  assert.deepEqual(timings.measured.judgeSecondsByGate, { verify: 29, spec: 5, "gap-audit": 4 });
  assert.equal(
    timings.measured.verifyGateAttempts,
    3,
    "the receipt reports the cumulative counter, not the PASS-reset budget gauge",
  );
  assert.equal(timings.wallClockSeconds, 3600);
  // 3600 - 90 - 38: the un-measured remainder stays one honest lump.
  assert.equal(timings.unattributedSeconds, 3472);
});

test("milestones reflect recorded stamps and tolerate absences", () => {
  const timings = computePhaseTimings({ state, gatesState, now: "2026-08-10T11:00:00.000Z" });
  assert.equal(timings.milestones.initAt, "2026-08-10T10:00:00.000Z");
  assert.equal(timings.milestones.allTasksFirstEvidenceAt, "2026-08-10T10:20:01.000Z");
  assert.equal(timings.milestones.firstVerificationRunAt, "2026-08-10T10:10:00.000Z");
  assert.equal(timings.milestones.lastVerificationRunAt, "2026-08-10T10:40:20.000Z");
  assert.equal(timings.milestones.requirementsFidelityRecordedAt, "2026-08-10T10:50:00.000Z");
  assert.equal(timings.milestones.finalReviewRecordedAt, null);
  assert.equal(timings.milestones.finalizedAt, "2026-08-10T11:00:00.000Z");
});

test("cuts the wall clock at the last first-time task claim, and the two windows re-add to it", () => {
  const timings = computePhaseTimings({ state, gatesState, now: "2026-08-10T11:00:00.000Z" });
  const boundary = timings.taskEvidenceBoundary;
  assert.equal(boundary.basis, "all-tasks-first-evidence");
  assert.equal(boundary.beforeSeconds, 1201); // 10:00:00 -> 10:20:01, the LAST task's FIRST claim
  assert.equal(boundary.afterSeconds, 2399); // 10:20:01 -> 11:00:00
  assert.equal(boundary.beforeSeconds + boundary.afterSeconds, timings.wallClockSeconds, "a cut, not a second sum");
  assert.equal(boundary.afterOverBeforeRatio, 2);
  // The cut is orthogonal to the measured sums, so the honest lump is untouched.
  assert.equal(timings.unattributedSeconds, 3472);
});

test("out-of-order evidence cannot drag the boundary", () => {
  const scrambled = {
    createdAt: "2026-08-10T10:00:00.000Z",
    verification: [],
    tasks: [
      {
        id: "T1",
        status: "complete",
        evidence: [
          { ts: "2026-08-10T10:50:00.000Z", text: "appended out of order by a resumed run" },
          { ts: "not-a-date", text: "unparseable entries are skipped, never NaN-poisoning the min" },
          { ts: "2026-08-10T10:05:00.000Z", text: "the real first claim" },
        ],
      },
    ],
  };
  const timings = computePhaseTimings({ state: scrambled, now: "2026-08-10T11:00:00.000Z" });
  assert.equal(timings.milestones.allTasksFirstEvidenceAt, "2026-08-10T10:05:00.000Z");
  assert.equal(timings.taskEvidenceBoundary.beforeSeconds, 300);
});

// Each refusal is a branch that would otherwise ship a plausible-looking wrong
// number, so each one names itself in `basis` and keeps the whole wall clock
// in the unattributed lump.
for (const [reason, boundaryState] of [
  ["no-task-evidence", { createdAt: "2026-08-10T10:00:00.000Z", tasks: [] }],
  ["no-task-evidence", { createdAt: "2026-08-10T10:00:00.000Z", tasks: [{ id: "T1", status: "complete", evidence: [] }] }],
  [
    // A blocked/partial receipt never reached "every task claimed", so it gets
    // no cut rather than one taken at an arbitrary surviving task.
    "tasks-unresolved",
    {
      createdAt: "2026-08-10T10:00:00.000Z",
      tasks: [
        { id: "T1", status: "complete", evidence: [{ ts: "2026-08-10T10:20:00.000Z" }] },
        { id: "T2", status: "pending", evidence: [] },
      ],
    },
  ],
  [
    // Resumed run: reconcile introduced T2 after the fidelity review was
    // recorded, so "after the boundary" is not the closing window.
    "boundary-after-first-review",
    {
      createdAt: "2026-08-10T10:00:00.000Z",
      requirementsFidelityReview: { recordedAt: "2026-08-10T10:30:00.000Z" },
      tasks: [
        { id: "T1", status: "complete", evidence: [{ ts: "2026-08-10T10:20:00.000Z" }] },
        { id: "T2", status: "complete", evidence: [{ ts: "2026-08-10T10:40:00.000Z" }] },
      ],
    },
  ],
  [
    "boundary-outside-run-window",
    {
      createdAt: "2026-08-10T10:00:00.000Z",
      tasks: [{ id: "T1", status: "complete", evidence: [{ ts: "2026-08-10T09:00:00.000Z" }] }],
    },
  ],
  ["no-run-start", { createdAt: null, tasks: [{ id: "T1", status: "complete", evidence: [{ ts: "2026-08-10T10:20:00.000Z" }] }] }],
]) {
  test(`refuses the cut and says why: ${reason}`, () => {
    const timings = computePhaseTimings({ state: { verification: [], ...boundaryState }, now: "2026-08-10T11:00:00.000Z" });
    assert.equal(timings.taskEvidenceBoundary.basis, reason);
    assert.equal(timings.taskEvidenceBoundary.beforeSeconds, null);
    assert.equal(timings.taskEvidenceBoundary.afterSeconds, null);
    assert.equal(timings.taskEvidenceBoundary.afterOverBeforeRatio, null);
    assert.equal(timings.milestones.allTasksFirstEvidenceAt, null, "no cut means no milestone to claim");
  });
}

test("a zero-length first window reports both seconds but no ratio", () => {
  const timings = computePhaseTimings({
    state: {
      createdAt: "2026-08-10T10:00:00.000Z",
      verification: [],
      tasks: [{ id: "T1", status: "complete", evidence: [{ ts: "2026-08-10T10:00:00.000Z" }] }],
    },
    now: "2026-08-10T11:00:00.000Z",
  });
  assert.equal(timings.taskEvidenceBoundary.beforeSeconds, 0);
  assert.equal(timings.taskEvidenceBoundary.afterSeconds, 3600);
  assert.equal(timings.taskEvidenceBoundary.afterOverBeforeRatio, null);
});

test("degrades to nulls without gates state or timestamps instead of guessing", () => {
  const timings = computePhaseTimings({ state: { createdAt: null, verification: [] }, now: "2026-08-10T11:00:00.000Z" });
  assert.equal(timings.wallClockSeconds, null);
  assert.equal(timings.unattributedSeconds, null);
  assert.equal(timings.taskEvidenceBoundary.basis, "no-run-start");
  assert.equal(timings.measured.verificationCommandSeconds, 0);
  assert.equal(timings.measured.judgeSeconds, 0);
  assert.equal(timings.measured.verifyGateAttempts, null);
});

test("an old gates.json without totalAttempts reports null, never the reset gauge or a history-derived guess", () => {
  const timings = computePhaseTimings({
    state: { createdAt: null, verification: [] },
    gatesState: { judgeCalls: [], gates: { verify: { attempts: 2, history: [{}, {}, {}] } } },
    now: "2026-08-10T11:00:00.000Z",
  });
  assert.equal(timings.measured.verifyGateAttempts, null);
});
