"use strict";

// Phase timings for the completion receipt.
//
// Why this exists: "verification must not dwarf implementation" is a real
// budget rule, but until now checking it meant excavating session transcripts
// (the learners-page audit reconstructed a 313-minute run by hand: 21min of
// implementation against 70min of user wait and a 22min gate/review stretch).
// The state file and gate ledger already carry honest timestamps - command-log
// artifacts record startedAt/finishedAt, reviews record recordedAt, judge
// calls record durationMs - so the receipt can stamp the same picture for
// free on every run.
//
// Honesty contract: this module only SUMS what was actually measured and
// REPORTS milestones that were actually recorded. It never attributes the
// gaps: agent turns, user wait, and browser QA share the un-measured
// remainder of the wall clock, and pretending to split them would be
// fabrication. Interpretation stays with the human reading the receipt.

function toMs(value) {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function secondsBetween(startIso, endIso) {
  const start = toMs(startIso);
  const end = toMs(endIso);
  if (start === null || end === null || end < start) return null;
  return (end - start) / 1000;
}

/**
 * @param {object} options
 * @param {object} options.state - implement state (tasks/verification/reviews)
 * @param {object|null} [options.gatesState] - parsed agents/gates/<slug>/gates.json, when present
 * @param {string} [options.now] - ISO timestamp of receipt creation (finalize time)
 */
function computePhaseTimings({ state, gatesState = null, now }) {
  const finalizedAt = now || new Date().toISOString();
  const initAt = state && state.createdAt ? state.createdAt : null;

  // Measured verification command time: every command-log artifact carries the
  // start/finish of an actual harness-run command (verify-run and, via the
  // same shape, any reverification that registered a log).
  let verificationCommandSeconds = 0;
  let verificationCommandRuns = 0;
  let firstVerificationRunAt = null;
  let lastVerificationRunAt = null;
  for (const item of (state && state.verification) || []) {
    for (const artifact of item.artifacts || []) {
      if (artifact.kind !== "command-log") continue;
      const duration = secondsBetween(artifact.startedAt, artifact.finishedAt);
      if (duration === null) continue;
      verificationCommandSeconds += duration;
      verificationCommandRuns += 1;
      if (!firstVerificationRunAt || artifact.startedAt < firstVerificationRunAt) firstVerificationRunAt = artifact.startedAt;
      if (!lastVerificationRunAt || artifact.finishedAt > lastVerificationRunAt) lastVerificationRunAt = artifact.finishedAt;
    }
  }

  // Judge spend from the gate ledger, split by gate so a verify-heavy run and
  // a document-gate-heavy run read differently at a glance.
  const judge = { totalSeconds: 0, calls: 0, byPurpose: {} };
  for (const call of (gatesState && gatesState.judgeCalls) || []) {
    if (typeof call.durationMs !== "number") continue;
    const seconds = call.durationMs / 1000;
    judge.totalSeconds += seconds;
    judge.calls += 1;
    // "gate:verify-semantic" / "gate:verify-semantic:lane:..." both count as
    // verify; document gates keep their own buckets.
    const purpose = typeof call.purpose === "string" ? call.purpose : "unknown";
    const bucket = purpose.startsWith("gate:verify") ? "verify"
      : purpose.startsWith("gate:spec") ? "spec"
        : purpose.startsWith("gate:gap-audit") ? "gap-audit"
          : "other";
    judge.byPurpose[bucket] = (judge.byPurpose[bucket] || 0) + seconds;
  }
  const verifyGate = gatesState && gatesState.gates && gatesState.gates.verify ? gatesState.gates.verify : null;

  const round = value => (value === null ? null : Math.round(value * 10) / 10);
  const wallClockSeconds = secondsBetween(initAt, finalizedAt);
  const measuredSeconds = verificationCommandSeconds + judge.totalSeconds;

  return {
    schema: "hoyeon.phase-timings.v1",
    milestones: {
      initAt,
      firstVerificationRunAt,
      lastVerificationRunAt,
      requirementsFidelityRecordedAt: state && state.requirementsFidelityReview ? state.requirementsFidelityReview.recordedAt || null : null,
      finalReviewRecordedAt: state && state.finalReview ? state.finalReview.recordedAt || null : null,
      finalizedAt,
    },
    measured: {
      verificationCommandSeconds: round(verificationCommandSeconds),
      verificationCommandRuns,
      judgeSeconds: round(judge.totalSeconds),
      judgeCalls: judge.calls,
      judgeSecondsByGate: Object.fromEntries(Object.entries(judge.byPurpose).map(([key, value]) => [key, round(value)])),
      verifyGateAttempts: verifyGate ? verifyGate.attempts ?? null : null,
    },
    wallClockSeconds: round(wallClockSeconds),
    // The remainder is agent turns + user wait + un-logged work (browser QA
    // and reviews are agent activity without start stamps). Reported as one
    // honest lump, never attributed.
    unattributedSeconds: wallClockSeconds === null ? null : round(Math.max(0, wallClockSeconds - measuredSeconds)),
  };
}

module.exports = { computePhaseTimings };
