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
  assert.equal(timings.schema, "hoyeon.phase-timings.v1");
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
  assert.equal(timings.milestones.firstVerificationRunAt, "2026-08-10T10:10:00.000Z");
  assert.equal(timings.milestones.lastVerificationRunAt, "2026-08-10T10:40:20.000Z");
  assert.equal(timings.milestones.requirementsFidelityRecordedAt, "2026-08-10T10:50:00.000Z");
  assert.equal(timings.milestones.finalReviewRecordedAt, null);
  assert.equal(timings.milestones.finalizedAt, "2026-08-10T11:00:00.000Z");
});

test("degrades to nulls without gates state or timestamps instead of guessing", () => {
  const timings = computePhaseTimings({ state: { createdAt: null, verification: [] }, now: "2026-08-10T11:00:00.000Z" });
  assert.equal(timings.wallClockSeconds, null);
  assert.equal(timings.unattributedSeconds, null);
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
