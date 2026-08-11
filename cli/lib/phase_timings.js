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
// Honesty contract: this module only SUMS what was actually measured,
// REPORTS milestones that were actually recorded, and CUTS the wall clock at
// recorded instants. It never attributes the gaps: agent turns, user wait,
// and browser QA share the un-measured remainder of the wall clock, and
// pretending to split them by activity would be fabrication. Interpretation
// stays with the human reading the receipt.

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

// The earliest instant this task produced any recorded evidence.
//
// Min over the array, not entry[0]: a resumed run's evidence list is not
// guaranteed ascending (reconcile appends its own "status reset" entry, and a
// re-marked task appends after it), and one out-of-order entry must not be
// able to drag the run's boundary around.
function firstEvidenceMs(task) {
  let earliest = null;
  for (const entry of (task && task.evidence) || []) {
    const ms = toMs(entry && entry.ts);
    if (ms === null) continue;
    if (earliest === null || ms < earliest) earliest = ms;
  }
  return earliest;
}

// Where the closing stretch starts, and how much of the run it ate.
//
// Why this exists: item 2 ("verification must not outweigh implementation") is
// a budget rule, but the receipt could not state it as a number - the measured
// sums above cover 2-14% of a run and the rest came out as one
// undifferentiated lump (measured/wall clock: pokemon 281/14695s, tetris
// 2390/16804s, saju 305/4226s, modakbul 609/13720s). state.json already
// records enough to cut that clock at one honest instant: the moment no task
// was still waiting for its first evidence. Reconstructing that cut by hand
// over the same four runs gave closing:before ratios of 8.1, 8.3, 1.2 and 6.5
// to 1 - two flat item-2 violations that no receipt had ever reported.
//
// This is a BOUNDARY, not a measurement of implementation effort, and the
// field names are chosen so it cannot be read as one. In every one of the four
// audited runs the agent batch-marked its tasks in a single burst at the end
// of the work (pokemon stamped T1 through T8 inside 1.2 seconds), so a task's
// evidence `ts` is when the claim was RECORDED, not when the work happened.
// `beforeSeconds` is "clock elapsed before every task had been claimed"; it is
// never "time spent implementing", and quoting it as such would be exactly the
// overclaiming item 10 forbids.
//
// When the cut cannot be taken honestly there is no cut: `basis` names the
// refusal and the whole wall clock stays in the unattributed lump, because a
// wrong split is worse than a big one.
function computeTaskEvidenceBoundary({ state, initMs, finalizedMs, firstReviewMs }) {
  const refuse = basis => ({ basis, allTasksFirstEvidenceAt: null, beforeSeconds: null, afterSeconds: null, afterOverBeforeRatio: null });
  if (initMs === null || finalizedMs === null) return refuse("no-run-start");

  const tasks = (state && state.tasks) || [];
  // A task the run never resolved means "every task had been claimed" never
  // happened, so a blocked or partial receipt gets no boundary instead of a
  // cut taken at an arbitrary surviving task. `deferred` and `blocked` are
  // resolved outcomes that never carry implementation evidence, so they
  // neither block the boundary nor move it. (Same terminal set as the open-task
  // count in state_data, kept inline so this module stays dependency-free.)
  if (tasks.some(task => !["complete", "deferred", "blocked"].includes(task && task.status))) return refuse("tasks-unresolved");

  let boundaryMs = null;
  for (const task of tasks) {
    if (!task || task.status !== "complete") continue;
    const ms = firstEvidenceMs(task);
    if (ms === null) return refuse("no-task-evidence"); // a complete task with no usable stamp leaves the cut unknowable
    if (boundaryMs === null || ms > boundaryMs) boundaryMs = ms;
  }
  if (boundaryMs === null) return refuse("no-task-evidence");

  // A task first claimed after a review was already recorded means the closing
  // stretch had started before the boundary, so "after" is not the closing
  // window. Seen on resumed runs where reconcile introduced a new PRD task.
  if (firstReviewMs !== null && boundaryMs > firstReviewMs) return refuse("boundary-after-first-review");
  if (boundaryMs < initMs || boundaryMs > finalizedMs) return refuse("boundary-outside-run-window");

  const beforeSeconds = (boundaryMs - initMs) / 1000;
  const afterSeconds = (finalizedMs - boundaryMs) / 1000;
  return {
    basis: "all-tasks-first-evidence",
    allTasksFirstEvidenceAt: new Date(boundaryMs).toISOString(),
    beforeSeconds,
    afterSeconds,
    // No ratio against a zero-length window; the two seconds still stand alone.
    afterOverBeforeRatio: beforeSeconds > 0 ? afterSeconds / beforeSeconds : null,
  };
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

  const requirementsFidelityRecordedAt = state && state.requirementsFidelityReview ? state.requirementsFidelityReview.recordedAt || null : null;
  const finalReviewRecordedAt = state && state.finalReview ? state.finalReview.recordedAt || null : null;
  const reviewStamps = [requirementsFidelityRecordedAt, finalReviewRecordedAt].map(toMs).filter(ms => ms !== null);
  const boundary = computeTaskEvidenceBoundary({
    state,
    initMs: toMs(initAt),
    finalizedMs: toMs(finalizedAt),
    firstReviewMs: reviewStamps.length ? Math.min(...reviewStamps) : null,
  });

  return {
    schema: "hoyeon.phase-timings.v2",
    milestones: {
      initAt,
      allTasksFirstEvidenceAt: boundary.allTasksFirstEvidenceAt,
      firstVerificationRunAt,
      lastVerificationRunAt,
      requirementsFidelityRecordedAt,
      finalReviewRecordedAt,
      finalizedAt,
    },
    measured: {
      verificationCommandSeconds: round(verificationCommandSeconds),
      verificationCommandRuns,
      judgeSeconds: round(judge.totalSeconds),
      judgeCalls: judge.calls,
      judgeSecondsByGate: Object.fromEntries(Object.entries(judge.byPurpose).map(([key, value]) => [key, round(value)])),
      // Cumulative runs, not the retry-budget gauge: `attempts` resets to 0 on
      // PASS, so quoting it here made three live-session receipts all report 0
      // verify attempts on gates that had really run. Old gates.json files
      // without totalAttempts report null - the capped history is not a count.
      verifyGateAttempts: verifyGate && typeof verifyGate.totalAttempts === "number" ? verifyGate.totalAttempts : null,
    },
    wallClockSeconds: round(wallClockSeconds),
    // Same wall clock, cut once at a recorded instant instead of summed by
    // activity: `beforeSeconds` + `afterSeconds` == `wallClockSeconds`. See
    // computeTaskEvidenceBoundary for what the cut is and what it is not.
    taskEvidenceBoundary: {
      basis: boundary.basis,
      beforeSeconds: round(boundary.beforeSeconds),
      afterSeconds: round(boundary.afterSeconds),
      afterOverBeforeRatio: round(boundary.afterOverBeforeRatio),
    },
    // The remainder is agent turns + user wait + un-logged work (browser QA
    // and reviews are agent activity without start stamps). Reported as one
    // honest lump, never attributed.
    unattributedSeconds: wallClockSeconds === null ? null : round(Math.max(0, wallClockSeconds - measuredSeconds)),
  };
}

module.exports = { computePhaseTimings };
