"use strict";

const path = require("path");

const { nowIso, writeJson, appendJsonl } = require("../util");
const { recordDeviation, effectiveReviewPolicy } = require("../state_data");
const { loadState, syncActive, persistState } = require("../state_store");

// Mute the stop-hook continuation loop while the user has redirected the
// conversation away from the implementation (unrelated questions, "wrap it up
// for now"). Any subsequent harness mutation clears the pause automatically,
// so forgetting to resume cannot silently kill an active run.
function cmdPause(options) {
  const { statePath, state } = loadState(options);
  const ledgerPath = path.join(path.dirname(statePath), "ledger.jsonl");
  if (options.clear) {
    const wasPaused = Boolean(state.paused);
    delete state.paused;
    state.updatedAt = nowIso();
    writeJson(statePath, state);
    syncActive(statePath, state);
    if (wasPaused) appendJsonl(ledgerPath, { ts: nowIso(), event: "resumed" });
    process.stdout.write(JSON.stringify({ ok: true, paused: false }, null, 2) + "\n");
    return;
  }
  const reason = String(options.reason || "").trim();
  if (!reason) throw new Error("--reason is required; quote the user's redirect or wrap-up request");
  state.paused = { at: nowIso(), reason };
  state.updatedAt = nowIso();
  // Deliberately not persistState: that path clears `paused` as
  // the auto-resume signal for every real mutation command.
  writeJson(statePath, state);
  syncActive(statePath, state);
  appendJsonl(ledgerPath, { ts: nowIso(), event: "paused", reason });
  process.stdout.write(JSON.stringify({
    ok: true,
    paused: true,
    reason,
    note: "Stop-hook continuation is muted. Any mark/verify/plan/review/finalize command resumes the loop; `pause --clear` resumes it explicitly.",
  }, null, 2) + "\n");
}

// Record a user-directed review-profile change as a first-class deviation
// instead of forcing the agent to either ignore the user or silently skip
// gates. The reason must be the user's own words.
function cmdReviewPolicy(options) {
  const profile = String(options.profile || "").trim().toLowerCase();
  if (!["trivial", "standard", "high-risk"].includes(profile)) {
    throw new Error("--profile must be trivial, standard, or high-risk");
  }
  const reason = String(options.reason || "").trim();
  if (!reason) throw new Error("--reason is required; quote the user's verbatim instruction");
  const { statePath, state } = loadState(options);
  const previous = state.reviewProfile || null;
  const deviation = recordDeviation(state, "review_profile_override", "PRD", reason, {
    from: previous ? previous.profile : null,
    to: profile,
    previousSource: previous ? previous.source : null,
  });
  state.reviewProfile = {
    profile,
    source: "user-override",
    reason,
    signals: previous && Array.isArray(previous.signals) ? previous.signals : [],
    policyVersion: previous && Number.isInteger(previous.policyVersion) ? previous.policyVersion : 2,
    overriddenAt: nowIso(),
    previous: previous ? { profile: previous.profile, source: previous.source } : null,
  };
  state.updatedAt = nowIso();
  persistState(statePath, state);
  appendJsonl(path.join(path.dirname(statePath), "ledger.jsonl"), {
    ts: nowIso(),
    event: "review_profile_overridden",
    from: previous ? previous.profile : null,
    to: profile,
    reason,
    deviationId: deviation.id,
  });
  syncActive(statePath, state);
  process.stdout.write(JSON.stringify({
    ok: true,
    reviewProfile: state.reviewProfile,
    effectivePolicy: effectiveReviewPolicy(state),
    deviationId: deviation.id,
  }, null, 2) + "\n");
}

module.exports = {
  cmdPause,
  cmdReviewPolicy,
};
