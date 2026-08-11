"use strict";

const childProcess = require("child_process");
const path = require("path");

const { nowIso, cwd, resolveProjectPath, toProjectRelative, writeJson, simpleHash, safeTimestamp, writeMarkdown } = require("../util");
const { shellLikeTokens } = require("../inference");
const { worktreeSnapshot, vouchedTreeFingerprintForState, vouchedFingerprintsMatch, summarizeFingerprintDiff } = require("../git");
const { isFreshPass, latestCommandLog, declaredSideEffect } = require("../fresh_pass");
const { isVerificationRequiredForDone, executionPlanSummary, countState, rehearsalSummary, reviewProfileName, effectiveReviewPolicy } = require("../state_data");
const { readyExecutionPlan, nextItem } = require("../planning");
const { collectArtifacts, inspectArtifact } = require("../artifacts");
const { assertFinalReviewReport, assertRequirementsFidelityReport, validateArtifacts, completionViolations, requirementsFidelityHandoffViolations, finalReviewHandoffViolations, verifyGateStatus, verifyGateTerminallyBlocked } = require("../reviews");
const { writeImplementationReport, renderRequirementsReviewPrompt, renderReviewPrompt } = require("../render");
const { loadState, syncActive, persistState } = require("../state_store");
const { loadPending } = require("../rules");
const { computePhaseTimings } = require("../phase_timings");

// Gate ledger for receipt timings, tolerant on purpose: a run that never
// touched sasu gates (or a corrupt ledger) must not break finalize - the
// timings then simply report zero judge spend.
function loadGatesStateForTimings(state) {
  const projectRoot = state.projectRoot || cwd();
  if (!state.topicSlug) return null;
  try {
    const fs = require("fs");
    const gatesPath = path.join(projectRoot, "agents", "gates", state.topicSlug, "gates.json");
    if (!fs.existsSync(gatesPath)) return null;
    return JSON.parse(fs.readFileSync(gatesPath, "utf8"));
  } catch {
    return null;
  }
}

function cmdReviewPrompt(options) {
  const { statePath, state } = loadState(options);
  const reportPath = path.join(state.projectRoot || cwd(), state.runDir, "review", "final-review.md");
  process.stdout.write(renderReviewPrompt({
    state,
    statePath: toProjectRelative(statePath, state.projectRoot || cwd()),
    reportPath,
  }));
}

function cmdRequirementsReviewPrompt(options) {
  const { statePath, state } = loadState(options);
  const reportPath = path.join(state.projectRoot || cwd(), state.runDir, "review", "requirements-fidelity-review.md");
  process.stdout.write(renderRequirementsReviewPrompt({
    state,
    statePath: toProjectRelative(statePath, state.projectRoot || cwd()),
    reportPath,
  }));
}

// Structure defects in review reports are advisory (see the tier comment on
// the assert functions in ../reviews.js): print them loudly on stderr so a
// human scanning the run sees them, while stdout stays parseable JSON that
// carries the same list as `structureWarnings`.
function printStructureWarnings(label, warnings) {
  for (const warning of warnings || []) {
    process.stderr.write(`WARNING (${label} structure, advisory): ${warning}\n`);
  }
}

function cmdRequirementsReviewRecord(options) {
  const status = String(options.status || "");
  const reportInput = String(options.report || "");
  const summary = String(options.summary || "").trim();
  if (!["pass", "fail"].includes(status)) throw new Error("--status must be pass or fail");
  if (!reportInput) throw new Error("--report is required");
  if (!summary) throw new Error("--summary is required");
  const { statePath, state } = loadState(options);
  const reportAbs = resolveProjectPath(reportInput, state.projectRoot || cwd());
  const info = inspectArtifact(reportAbs, "log");
  const structureWarnings = assertRequirementsFidelityReport(reportAbs, status, state);
  printStructureWarnings("requirements fidelity report", structureWarnings);
  const reportPath = toProjectRelative(reportAbs, state.projectRoot || cwd());

  if (status === "pass") {
    const violations = completionViolations(statePath, state, {
      includeRequirementsFidelityReview: false,
      includeFinalReview: false,
      // A terminally blocked gate (BLOCKED, budget spent) must not veto the
      // record: this run's only exit is `finalize --status blocked`, which
      // itself requires the recorded review - vetoing here made the two
      // errors point at each other with no escape but a dishonest --status
      // fail (reproduced 2026-08-11). With budget remaining the gate still
      // rejects a pass: fix the findings and re-run `sasu verify` first.
      allowTerminallyBlockedVerifyGate: true,
    }).filter(violation => violation !== "Requirements fidelity review report hash changed");
    if (violations.length) {
      process.stdout.write(JSON.stringify({ ok: false, status: "rejected", violations }, null, 2) + "\n");
      process.exitCode = 2;
      return;
    }
  }

  state.requirementsFidelityReview = {
    status,
    summary,
    reportPath,
    reportBytes: info.bytes,
    reportSha256: info.sha256,
    // Audit/attribution record of the dirty tree at review time (kept in
    // receipts); freshness is decided by the vouched fingerprint below.
    worktreeSnapshot: worktreeSnapshot(state),
    vouchedTreeFingerprint: vouchedTreeFingerprintForState(state),
    recordedAt: nowIso(),
  };
  state.finalReview = null;
  state.updatedAt = nowIso();
  persistState(statePath, state);
  syncActive(statePath, state);
  process.stdout.write(JSON.stringify({
    ok: true,
    structureWarnings,
    requirementsFidelityReview: state.requirementsFidelityReview,
    finalReview: state.finalReview,
    counts: countState(state),
    executionPlan: executionPlanSummary(state),
    ready: readyExecutionPlan(state),
    next: nextItem(state),
  }, null, 2) + "\n");
}

function cmdReviewRecord(options) {
  const status = String(options.status || "");
  const reportInput = String(options.report || "");
  const summary = String(options.summary || "").trim();
  if (!["pass", "fail"].includes(status)) throw new Error("--status must be pass or fail");
  if (!reportInput) throw new Error("--report is required");
  if (!summary) throw new Error("--summary is required");
  const { statePath, state } = loadState(options);
  const reportAbs = resolveProjectPath(reportInput, state.projectRoot || cwd());
  const info = inspectArtifact(reportAbs, "log");
  const structureWarnings = assertFinalReviewReport(reportAbs, status, state);
  printStructureWarnings("final review report", structureWarnings);
  const reportPath = toProjectRelative(reportAbs, state.projectRoot || cwd());

  if (status === "pass") {
    const violations = completionViolations(statePath, state, {
      includeFinalReview: false,
      // Same scoping as requirements-review-record above: a terminally
      // blocked gate means a blocked handoff, and on a high-risk profile
      // that handoff requires this review's honest verdict in the receipt.
      allowTerminallyBlockedVerifyGate: true,
    });
    if (violations.length) {
      process.stdout.write(JSON.stringify({ ok: false, status: "rejected", violations }, null, 2) + "\n");
      process.exitCode = 2;
      return;
    }
  }

  state.finalReview = {
    status,
    summary,
    reportPath,
    reportBytes: info.bytes,
    reportSha256: info.sha256,
    // Same split as the fidelity review: worktreeSnapshot is audit trail,
    // vouchedTreeFingerprint is the freshness decision input.
    worktreeSnapshot: worktreeSnapshot(state),
    vouchedTreeFingerprint: vouchedTreeFingerprintForState(state),
    recordedAt: nowIso(),
  };
  state.updatedAt = nowIso();
  persistState(statePath, state);
  syncActive(statePath, state);
  process.stdout.write(JSON.stringify({
    ok: true,
    structureWarnings,
    finalReview: state.finalReview,
    counts: countState(state),
    executionPlan: executionPlanSummary(state),
    ready: readyExecutionPlan(state),
    next: nextItem(state),
  }, null, 2) + "\n");
}

// A hung command must fail the reverification rather than hang the receipt.
const REVERIFY_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Final reverification: re-run every required command-backed verification at
 * receipt time, on the harness's clock instead of the agent's.
 *
 * verify-run scores honestly but the agent chooses when to call it, so a pass
 * recorded at task 3 says nothing about the code as it stands at finalize
 * (audited runs: 50 executions, zero recorded failures - submission bias, and
 * no freshness link between evidence and later edits). Re-running the exact
 * recorded commands closes both holes deterministically: no LLM, no judgment,
 * just the same command on the final tree.
 *
 * Only mechanical proof is re-runnable: items whose evidence carries an
 * executed command and whose contract declares no side effect. Everything
 * else (browser/db/api evidence, side-effectful checks) is skipped with the
 * reason stamped into the receipt - a skip must be legible, never silent.
 */
function reverifyRequiredVerifications(statePath, state) {
  const projectRoot = state.projectRoot || cwd();
  const currentFingerprint = vouchedTreeFingerprintForState(state);
  const results = [];
  for (const item of state.verification || []) {
    if (!isVerificationRequiredForDone(item)) continue;
    if (item.status !== "pass") continue; // open/blocked items are already violations elsewhere
    // Selection and skip rules shared with the gate's fresh-pass reuse
    // (fresh_pass.js): one place decides what a command log is, whether a
    // side effect disqualifies it, and when a pass is still fresh.
    const lastLog = latestCommandLog(item);
    if (!lastLog) {
      results.push({ id: item.id, skipped: "no recorded command (non-shell evidence)" });
      continue;
    }
    const sideEffect = declaredSideEffect(item);
    if (sideEffect) {
      results.push({ id: item.id, skipped: `declared side effect: ${sideEffect}` });
      continue;
    }
    // A pass earned on the identical tree would re-run the identical
    // experiment; skip it. The common honest flow (final suite, then
    // finalize) therefore costs nothing - only stale passes re-run.
    // Shared predicate with the verify gate's mechanical stage (fresh_pass.js).
    if (isFreshPass(lastLog, currentFingerprint)) {
      results.push({ id: item.id, skipped: `fresh pass: worktree unchanged since the recorded pass (${currentFingerprint.vouched})` });
      continue;
    }
    const command = lastLog.command;
    const tokens = shellLikeTokens(command);
    // Same workspace digest guard as verify-run: a reverification command that
    // mutates the tree it is certifying is reward hacking, not proof, even at
    // exit 0. Side-effectful contracts were already skipped above, so every
    // command that reaches here promised to leave the tree alone. Recomputed
    // per item because a violating command changes the tree for the next one.
    // Scoped runs share verify-run's tradeoff: only in-scope mutations are
    // seen, which is where the code under test - and therefore reward
    // hacking - lives.
    // Entries ride along (free - computed inside the fingerprint either way)
    // so a violation names the moved paths; nothing here is persisted beyond
    // the bounded changedPaths list.
    const preFingerprint = vouchedTreeFingerprintForState(state, { includeEntries: true });
    const startedAt = nowIso();
    const spawned = childProcess.spawnSync(tokens[0], tokens.slice(1), {
      cwd: projectRoot,
      shell: false,
      encoding: "utf8",
      timeout: REVERIFY_TIMEOUT_MS,
      maxBuffer: 20 * 1024 * 1024,
    });
    const postFingerprint = vouchedTreeFingerprintForState(state, { includeEntries: true });
    const digestViolation = Boolean(preFingerprint && postFingerprint
      && !vouchedFingerprintsMatch(preFingerprint, postFingerprint));
    const digestDiff = digestViolation ? summarizeFingerprintDiff(preFingerprint, postFingerprint) : null;
    const exitCode = typeof spawned.status === "number" ? spawned.status : 1;
    // Not under artifacts/: reverify logs are receipt provenance, not agent
    // evidence, so they must not trip unregistered-artifact validation.
    const logRel = path.join(state.runDir, "reverify", `${item.id}-${safeTimestamp()}.log`);
    writeMarkdown(path.join(projectRoot, logRel), [
      `command: ${command}`,
      `phase: final reverification (finalize)`,
      `startedAt: ${startedAt}`,
      `finishedAt: ${nowIso()}`,
      `exitCode: ${exitCode}`,
      `digestGuard: ${digestViolation ? `VIOLATED - workspace changed during reverification (${digestDiff ? digestDiff.text : "changed paths unavailable"})` : "clean"}`,
      spawned.signal ? `signal: ${spawned.signal}` : "",
      spawned.error && spawned.error.message ? `error: ${spawned.error.message}` : "",
      "",
      "--- stdout ---",
      spawned.stdout || "",
      "",
      "--- stderr ---",
      spawned.stderr || "",
    ].filter(line => line !== "").join("\n"));
    results.push({
      id: item.id, command, exitCode, digestViolation,
      ...(digestDiff ? { changedPaths: digestDiff.paths } : {}),
      logPath: logRel,
    });
  }
  return {
    ranAt: nowIso(),
    results,
    failures: results.filter(result =>
      (typeof result.exitCode === "number" && result.exitCode !== 0) || result.digestViolation === true),
  };
}

function cmdFinalize(options) {
  const status = String(options.status || "");
  const summary = String(options.summary || "").trim();
  if (!["complete", "partial", "blocked"].includes(status)) throw new Error("--status must be complete, partial, or blocked");
  if (!summary) throw new Error("--summary is required");
  const { statePath, state } = loadState(options);
  const counts = countState(state);
  // Computed once and stamped into the receipt below: the blocker predicate
  // and the receipt must describe the same gate reading.
  const verifyGate = verifyGateStatus(state);
  const violations = [];
  if (status === "complete") {
    violations.push(...completionViolations(statePath, state, { includeFinalReview: true }));
  } else {
    violations.push(...requirementsFidelityHandoffViolations(state));
    // High-risk work handed off partial/blocked still owes the independent
    // final review's verdict in the receipt (pass or fail both acceptable).
    violations.push(...finalReviewHandoffViolations(state));
    const blockers = [
      ...state.tasks.filter(item => item.status === "blocked"),
      ...state.acceptanceCriteria.filter(item => item.status === "blocked" || item.status === "not_met"),
      ...state.verification.filter(item => item.status === "blocked" || item.status === "fail"),
    ];
    // The verify gate itself qualifies as the blocker, but only when it is
    // terminal: verdict recorded AND retry budget spent. Two live sessions
    // deadlocked here with every task/AC complete - complete was refused
    // (gate BLOCKED), blocked was refused (zero blocked items), and override
    // was the only exit. With budget remaining the refusal stands: the agent
    // still has attempts to spend, so a cheap early "blocked" stays closed.
    // Shared predicate with the review-record scoping (reviews.js): the
    // blocked exit and the review record it requires must open together.
    const gateTerminallyBlocked = verifyGateTerminallyBlocked(verifyGate);
    if (status === "blocked" && blockers.length === 0 && !gateTerminallyBlocked) {
      violations.push(verifyGate.effective === "BLOCKED"
        ? `Blocked finalization with no blocked tracked item: the verify gate is BLOCKED but its retry budget is not exhausted (attempts ${verifyGate.attempts}/${verifyGate.budget}); fix the cited findings and re-run \`sasu verify\``
        : "Blocked finalization requires at least one task, acceptance, or verification item marked blocked/fail/not_met");
    }
    for (const blocker of blockers) {
      if (!blocker.evidence.length) violations.push(`Blocked item ${blocker.id} has no evidence`);
    }
    if (status === "partial") {
      const completed = [
        ...state.tasks.filter(item => item.status === "complete" && item.evidence.length),
        ...state.acceptanceCriteria.filter(item => item.status === "met" && item.evidence.length),
        ...state.verification.filter(item => item.status === "pass" && item.evidence.length),
      ];
      const incomplete = [
        ...state.tasks.filter(item => item.status !== "complete"),
        ...state.acceptanceCriteria.filter(item => item.status !== "met"),
        ...state.verification.filter(item => isVerificationRequiredForDone(item) && item.status !== "pass"),
      ];
      if (completed.length === 0) violations.push("Partial finalization requires at least one completed, evidenced implementation/AC/verification item");
      if (incomplete.length === 0) violations.push("Partial finalization requires at least one incomplete, blocked, failed, or not-met tracked item");
    }
    violations.push(...validateArtifacts(statePath, state));
  }
  // Reverify only when the cheap checks pass and completion is claimed; the
  // re-run is the last gate before the receipt, on the harness's clock.
  let finalReverification = null;
  if (status === "complete" && violations.length === 0) {
    finalReverification = reverifyRequiredVerifications(statePath, state);
    for (const failure of finalReverification.failures) {
      violations.push(failure.digestViolation && failure.exitCode === 0
        ? `Final reverification digest guard: ${failure.id} re-ran \`${failure.command}\` at exit 0 but the command mutated the workspace (${failure.changedPaths && failure.changedPaths.length ? `changed: ${failure.changedPaths.slice(0, 5).join(", ")}${failure.changedPaths.length > 5 ? ` (+${failure.changedPaths.length - 5} more)` : ""}` : "changed paths unavailable"}); a verifier that edits the tree it certifies cannot vouch for it (log: ${failure.logPath})`
        : `Final reverification failed: ${failure.id} exited ${failure.exitCode} re-running \`${failure.command}\` (log: ${failure.logPath})`);
    }
  }
  const uniqueViolations = Array.from(new Set(violations));
  if (uniqueViolations.length) {
    process.stdout.write(JSON.stringify({ ok: false, status: "rejected", violations: uniqueViolations, finalReverification }, null, 2) + "\n");
    process.exitCode = 2;
    return;
  }

  state.status = status;
  state.updatedAt = nowIso();
  const receipt = {
    schema: "hoyeon.prd-implement.receipt.v1",
    status,
    summary,
    verifiedAt: nowIso(),
    reviewProfile: state.reviewProfile || { profile: reviewProfileName(state), source: "default" },
    reviewPolicy: effectiveReviewPolicy(state),
    counts,
    delivery: state.delivery || null,
    initialWorktreeSnapshot: state.initialWorktreeSnapshot || null,
    worktreeSnapshot: worktreeSnapshot(state),
    executionPlan: executionPlanSummary(state),
    // Visible even when NOT_RUN: a skipped verify gate must be readable from
    // the receipt, not silently absent. On a blocked handoff this snapshot
    // (attempts/budget/findings) is the receipt's why; gates.json stays the
    // source of record.
    verifyGate,
    // Measured time picture: sums of what the harness actually clocked
    // (command runs, judge calls) against the wall clock, milestones included.
    // "Verification must not dwarf implementation" becomes checkable from the
    // receipt alone instead of from session-transcript archaeology.
    phaseTimings: computePhaseTimings({ state, gatesState: loadGatesStateForTimings(state), now: nowIso() }),
    // Side-door failure history per verification (rehearsals.jsonl). A check
    // that never failed anywhere never demonstrated it can fail; make that
    // legible in the completion proof.
    rehearsals: rehearsalSummary(statePath),
    // Receipt-time re-run of required command verifications on the final
    // tree, harness-timed. Skips carry their reason - never silent.
    finalReverification,
    artifactCount: collectArtifacts(state).length,
    requirementsFidelityReview: state.requirementsFidelityReview,
    finalReview: state.finalReview,
    evidenceHash: simpleHash(JSON.stringify({
      tasks: state.tasks,
      executionPlan: state.executionPlan,
      acceptanceCriteria: state.acceptanceCriteria,
      verification: state.verification,
      requirementsFidelityReview: state.requirementsFidelityReview,
      finalReview: state.finalReview,
      artifacts: collectArtifacts(state),
    })),
  };
  state.finalReceipt = receipt;
  persistState(statePath, state);
  writeJson(path.join(path.dirname(statePath), "receipt.json"), receipt);
  writeImplementationReport(statePath, state);
  syncActive(statePath, state);
  process.stdout.write(JSON.stringify({
    ok: true,
    status,
    receiptPath: toProjectRelative(path.join(path.dirname(statePath), "receipt.json")),
    reportPath: toProjectRelative(path.join(path.dirname(statePath), "implementation-result.md")),
    rememberSuggestions: rememberSuggestions(state),
  }, null, 2) + "\n");
}

// Post-receipt learning nudge (R13 of the agents-remember contract): the
// deviations recorded during this run are the raw material for `remember`.
// Recurring types are invariant candidates; one-offs are still worth a fact.
function rememberSuggestions(state) {
  const suggestions = [];
  const byType = new Map();
  for (const deviation of state.deviations || []) {
    if (!byType.has(deviation.type)) byType.set(deviation.type, []);
    byType.get(deviation.type).push(deviation);
  }
  for (const [type, items] of byType) {
    if (items.length >= 2) {
      suggestions.push(`Deviation type '${type}' recurred ${items.length}x (${items.map(item => item.id).join(", ")}): consider /remember as an invariant with a trigger and check.`);
    }
  }
  if (suggestions.length === 0 && (state.deviations || []).length > 0) {
    suggestions.push(`${state.deviations.length} deviation(s) recorded this run: skim them for a lesson worth landing via /remember (fact, invariant, or regression test).`);
  }
  try {
    const pending = loadPending(state.projectRoot || cwd());
    if (pending.length > 0) {
      suggestions.push(`agents/rules/pending/ still holds ${pending.length} unlanded lesson(s): ${pending.map(item => item.id).join(", ")}.`);
    }
  } catch {
    // Unreadable rules tree is doctor's problem, not finalize's.
  }
  return suggestions;
}

module.exports = {
  cmdReviewPrompt,
  cmdRequirementsReviewPrompt,
  cmdRequirementsReviewRecord,
  cmdReviewRecord,
  cmdFinalize,
};
