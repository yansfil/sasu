"use strict";

const { vouchedTreeFingerprintForState, vouchedFingerprintsMatch } = require("./git");

/**
 * The fresh-pass rule, shared by finalize's reverification
 * (cli/lib/commands/review.js) and the verify gate's mechanical stage
 * (cli/src/gates/commands.ts): a command-backed verification pass vouches for
 * the CURRENT tree only while the post-command fingerprint recorded with the
 * pass still matches it exactly. One predicate, two consumers - the two layers
 * must never disagree about what "already proven" means.
 *
 * Fingerprints are vouchedTreeFingerprint records; a legacy
 * `{ headSha, statusHash }` log entry never matches, so passes recorded
 * before the freshness consolidation simply re-run instead of crashing or
 * reading as fresh.
 */

function fingerprintsMatch(recorded, current) {
  return vouchedFingerprintsMatch(recorded, current);
}

/** Latest command-log artifact with an executed command, or null. */
function latestCommandLog(item) {
  const artifacts = item && Array.isArray(item.artifacts) ? item.artifacts : [];
  const logs = artifacts.filter(artifact => artifact && typeof artifact === "object"
    && artifact.kind === "command-log" && typeof artifact.command === "string" && artifact.command.trim() !== "");
  return logs.length ? logs[logs.length - 1] : null;
}

/**
 * True when this command log records a pass earned on a tree identical to
 * `currentFingerprint`. verify-run only pins `treeFingerprint` on a clean
 * pass (digest-guard violations are demoted to fail with a null fingerprint),
 * so a non-null fingerprint already implies guard-clean execution.
 */
function isFreshPass(log, currentFingerprint) {
  return Boolean(log && log.exitCode === 0 && fingerprintsMatch(log.treeFingerprint, currentFingerprint));
}

/**
 * A verification's contract-declared side effect, or "" when none. Shared by
 * finalize's reverification skip and the gate's fresh-pass reuse so the two
 * layers read the matrix column identically (mark.js applies the same rule
 * when deciding whether to run the digest guard).
 */
function declaredSideEffect(item) {
  const text = item && item.matrix && typeof item.matrix.sideEffect === "string" ? item.matrix.sideEffect.trim() : "";
  return text && !/^(none|없음|-|n\/a)$/i.test(text) ? text : "";
}

/**
 * Fresh verify-run passes of an implement run, for consumers that only know
 * the command they are about to run: [{ verificationId, command, logPath }].
 *
 * `projectRoot` overrides the absolute root recorded in state.json (the repo
 * may have moved; the caller knows where it actually lives). Items must still
 * be in `pass` status: a later manual fail/blocked judgment on the item is a
 * human signal the recorded log must not override. Side-effect-declared items
 * never qualify: their pass was earned against the pre-command tree (the
 * digest guard was skipped), so the pinned post-command fingerprint proves
 * less than it does for guard-clean runs - symmetric with finalize, which
 * also refuses to lean on them. Optional (non-required-for-done) items DO
 * qualify: required-ness selects what finalize must re-run, not whether a
 * recorded pass is real proof of this command on this tree.
 */
function freshVerifyRunPasses(state, projectRoot) {
  const current = vouchedTreeFingerprintForState({ ...state, projectRoot: projectRoot || state.projectRoot });
  if (!current) return [];
  const entries = [];
  // Shape-tolerant on purpose: a hand-damaged state.json (valid JSON, wrong
  // shape) must degrade to "no reuse", never crash the consumer.
  const items = Array.isArray(state.verification) ? state.verification : [];
  for (const item of items) {
    if (!item || item.status !== "pass") continue;
    if (declaredSideEffect(item)) continue;
    const log = latestCommandLog(item);
    if (!isFreshPass(log, current)) continue;
    entries.push({ verificationId: item.id, command: log.command, cwd: log.cwd || ".", logPath: log.path || null });
  }
  return entries;
}

module.exports = {
  fingerprintsMatch,
  latestCommandLog,
  isFreshPass,
  declaredSideEffect,
  freshVerifyRunPasses,
};
