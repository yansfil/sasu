import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { planReview, reviewPrior, requirementGrounds, reviewPolicyFor, reviewPolicySha256, ledgerSnapshot } from "../../dist/implement/review-scope.js";
import { diffChunkPath } from "../../dist/implement/prompts.js";
import { loadConfig } from "../../dist/config.js";
import { stateFixture, attemptFixture, SHA, AT } from "../helpers/implement-state.mjs";

const POLICY = reviewPolicySha256({ contractVersion: "0.10.0", build: "b".repeat(64), judge: { profiles: {} }, reviewProfile: "standard" });
const HARNESS = { contractVersion: "0.10.0", build: "b".repeat(64) };

function withJudgeBackend(value, body) {
  const previous = process.env["SASU_JUDGE_BACKEND"];
  if (value === undefined) delete process.env["SASU_JUDGE_BACKEND"]; else process.env["SASU_JUDGE_BACKEND"] = value;
  try { return body(); } finally {
    if (previous === undefined) delete process.env["SASU_JUDGE_BACKEND"]; else process.env["SASU_JUDGE_BACKEND"] = previous;
  }
}

// The policy a settled judgment is reused under must name the judge that
// actually produced it. `SASU_JUDGE_BACKEND` pins the backend outside the
// project config, and a hash of the config alone read two rounds judged by
// different backends as the same policy (2026-09-14).
test("the review policy names the effective judge target, so a backend pinned by the environment is a different policy from the configured one", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-review-policy-"));
  const config = loadConfig(root);
  const configured = withJudgeBackend(undefined, () => reviewPolicyFor(config, "standard", HARNESS));
  const pinned = withJudgeBackend("claude", () => reviewPolicyFor(config, "standard", HARNESS));
  assert.equal(configured.judge.routine.primary.backend, "codex", "the code default routes routine review to Codex first");
  assert.equal(pinned.judge.routine.primary.backend, "claude");
  assert.equal(pinned.judge.routine.fallback, null, "an operator pin keeps no fallback into the bypassed backend");
  assert.equal(pinned.judge["high-risk"].primary.backend, "claude", "the risk lane's routing is part of the same policy");
  assert.notEqual(reviewPolicySha256(configured), reviewPolicySha256(pinned));
  assert.equal(reviewPolicySha256(configured), reviewPolicySha256(withJudgeBackend(undefined, () => reviewPolicyFor(config, "standard", HARNESS))), "the same environment reproduces the same policy");
  assert.notEqual(reviewPolicySha256(configured), reviewPolicySha256(reviewPolicyFor(config, "high-risk", HARNESS)), "the run's review profile is part of the policy");
  assert.notEqual(reviewPolicySha256(configured), reviewPolicySha256(reviewPolicyFor(config, "standard", { ...HARNESS, build: "c".repeat(64) })), "a different CLI build is a different policy under the same version string");
  assert.equal("retryBudget" in configured.judge, false, "the retry budget is a harness bound, not a review input");
});

// The build digest is the bytes of the JavaScript this process runs, by
// relative path, and nothing else: the same tree hashes the same twice, a
// copy with one changed file hashes differently, and a non-JavaScript file
// dropped beside it changes nothing.
test("the build digest follows the JavaScript bytes of the build", async () => {
  const { buildSha256 } = await import("../../dist/version.js");
  const own = buildSha256();
  assert.match(own, /^[0-9a-f]{64}$/);
  assert.equal(buildSha256(), own, "computed once per process");
  const dist = path.resolve(import.meta.dirname, "../../dist");
  const digestOf = (root) => {
    const files = [];
    const walk = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const absolute = path.join(dir, entry.name); if (entry.isDirectory()) walk(absolute); else if (entry.name.endsWith(".js")) files.push(absolute); } };
    walk(root);
    const hash = crypto.createHash("sha256");
    for (const file of files.map((entry) => path.relative(root, entry)).sort()) { hash.update(file.split(path.sep).join("/")); hash.update("\0"); hash.update(fs.readFileSync(path.join(root, file))); hash.update("\0"); }
    return hash.digest("hex");
  };
  assert.equal(own, digestOf(dist), "the digest is the sorted relative-path-and-bytes hash of dist");
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-build-digest-"));
  fs.cpSync(dist, copy, { recursive: true });
  fs.writeFileSync(path.join(copy, "notes.md"), "not code\n");
  assert.equal(digestOf(copy), own, "a non-JavaScript file is not part of the build");
  fs.appendFileSync(path.join(copy, "implement", "prompts.js"), "\n// changed\n");
  assert.notEqual(digestOf(copy), own, "one changed module is a different build");
});
const CONTRACT = "c".repeat(64);
const assessment = (requirementRefs, evidenceRefs = ["src/a.mjs"], conclusion = "satisfied") => ({ requirementRefs, conclusion, rationale: "grounds", evidenceRefs });
const lane = (result, verdict = "PASS") => ({ invocationId: `inv-${Math.random().toString(16).slice(2)}`, startedAt: AT, finishedAt: AT, durationMs: 1, verdict, result, judge: null, error: null });
const review = (assessments) => ({ summary: "s", findings: [], priorDispositions: [], assessments });
const context = (extra = {}) => ({ requirementRefs: ["B1", "B2"], requiredRequirementRefs: ["B1", "B2"], evidenceRefs: ["src/a.mjs", "src/b.mjs"], actualEvidenceRefs: ["src/a.mjs", "src/b.mjs"], priorFindingIds: [], humanSources: {}, scope: { mode: "full" }, ledgerSnapshot: { findings: [], riskFindings: [], claims: [] }, ...extra });
const manifest = (entries) => ({ source: entries.map(([path, sha]) => ({ path, state: "present", sha256: sha })), evidence: [] });

function settledAttempt(id, overrides = {}) {
  return attemptFixture({ id, verdict: "PASS", phase: "complete", contractFingerprint: CONTRACT, reviewPolicySha256: POLICY, reviewContext: context(),
    inputManifest: manifest([["src/a.mjs", "1".repeat(64)], ["src/b.mjs", "2".repeat(64)]]),
    reviews: { fidelity: lane(review([assessment(["B1"]), assessment(["B2"], ["src/b.mjs"])])), code: lane(review([assessment([], ["src/a.mjs"])])) }, ...overrides });
}
function currentAttempt(id, overrides = {}) {
  return attemptFixture({ id, contractFingerprint: CONTRACT, reviewPolicySha256: POLICY, inputFingerprint: SHA, inputManifest: manifest([["src/a.mjs", "1".repeat(64)], ["src/b.mjs", "3".repeat(64)]]), ...overrides });
}
const options = (state, extra = {}) => ({ policySha256: POLICY, ledger: ledgerSnapshot(state), ...extra });

test("the first review of a run is full, and a settled prior on the same contract and policy makes the next round focused on what changed", () => {
  const first = stateFixture("/tmp/x", { requirements: [{ id: "B1", behavior: "a", decisionIds: [] }, { id: "B2", behavior: "b", decisionIds: [] }] });
  const current = currentAttempt("V1");
  first.verificationAttempts = [current];
  assert.equal(planReview(first, current, options(first)).record.mode, "full");
  const state = stateFixture("/tmp/x", { requirements: first.requirements, verificationAttempts: [settledAttempt("V1"), currentAttempt("V2")] });
  const plan = planReview(state, state.verificationAttempts[1], options(state));
  assert.equal(plan.record.mode, "focused");
  assert.equal(plan.record.referenceAttemptId, "V1");
  assert.deepEqual(plan.record.executedLanes, ["fidelity", "code"]);
  assert.deepEqual(plan.roundContext.changedPaths, ["src/b.mjs"], "the delta is measured against the anchor");
  assert.deepEqual(plan.scope.invalidatedEvidenceRefs, [diffChunkPath("src/b.mjs"), "src/b.mjs"]);
  assert.deepEqual(plan.scope.anchorAssessments.fidelity.map((entry) => entry.requirementRefs), [["B1"], ["B2"]]);
  assert.deepEqual(plan.scope.reopenedRequirementRefs, []);
});

test("a changed contract, a changed policy, an unsettled lane or an errored anchor all widen to a full review with the reason recorded", () => {
  const base = () => stateFixture("/tmp/x", { requirements: [{ id: "B1", behavior: "a", decisionIds: [] }, { id: "B2", behavior: "b", decisionIds: [] }] });
  const cases = [
    ["contract inputs changed", { verificationAttempts: [settledAttempt("V1", { contractFingerprint: "e".repeat(64) }), currentAttempt("V2")] }, {}],
    ["review policy changed", { verificationAttempts: [settledAttempt("V1"), currentAttempt("V2")] }, { policySha256: "f".repeat(64) }],
    ["no earlier attempt settled every lane", { verificationAttempts: [settledAttempt("V1", { reviews: { fidelity: lane(review([assessment(["B1", "B2"])])), code: null } }), currentAttempt("V2")] }, {}],
    ["no earlier attempt settled every lane without error", { verificationAttempts: [settledAttempt("V1", { verdict: "ERROR", error: { stage: "complete", code: "verification-input-error", message: "inputs moved" } }), currentAttempt("V2")] }, {}],
    ["predates scoped review records", { verificationAttempts: [settledAttempt("V1", { contractFingerprint: undefined }), currentAttempt("V2")] }, {}],
  ];
  for (const [reason, overrides, extra] of cases) {
    const state = base();
    Object.assign(state, overrides);
    const plan = planReview(state, state.verificationAttempts.at(-1), options(state, extra));
    assert.equal(plan.record.mode, "full", reason);
    assert.match(plan.record.reason, new RegExp(reason), reason);
    assert.deepEqual(plan.scope, { mode: "full" });
  }
});

test("open blocking findings pin their requirements to re-review and the high-risk profile requires the risk lane to have settled", () => {
  const state = stateFixture("/tmp/x", { requirements: [{ id: "B1", behavior: "a", decisionIds: [] }, { id: "B2", behavior: "b", decisionIds: [] }],
    findings: [{ id: "F1", kind: "defect", requirementRefs: ["B2"], problem: "p", evidenceRefs: ["src/b.mjs"], nextAction: "n", originAttemptId: "V1", status: "open", history: [], responses: [] },
      { id: "F2", kind: "advisory", requirementRefs: ["B1"], problem: "p", evidenceRefs: ["src/a.mjs"], nextAction: "n", originAttemptId: "V1", status: "open", history: [], responses: [] }],
    verificationAttempts: [settledAttempt("V1"), currentAttempt("V2")] });
  const plan = planReview(state, state.verificationAttempts[1], options(state));
  assert.equal(plan.record.mode, "focused");
  assert.deepEqual(plan.scope.reopenedRequirementRefs, ["B2"], "an advisory does not force re-review; a defect does");
  state.prd.reviewProfile = "high-risk";
  const widened = planReview(state, state.verificationAttempts[1], options(state));
  assert.equal(widened.record.mode, "full");
  assert.match(widened.record.reason, /no earlier attempt settled every lane/);
});

test("a previous attempt that lost one lane to a backend error on this exact input is repaired: only the lost lane runs and the settled one is reused", () => {
  const settledFidelity = lane(review([assessment(["B1", "B2"])]), "FAIL");
  const snapshot = { findings: [{ id: "F1", kind: "defect", requirementRefs: ["B1"], problem: "old", evidenceRefs: ["src/a.mjs"], nextAction: "n", originAttemptId: "V0", status: "open", history: [], responses: [] }], riskFindings: [], claims: [] };
  const errored = settledAttempt("V1", { verdict: "ERROR", error: { stage: "review", code: "judge-error", message: "code lane failed" }, inputFingerprint: SHA,
    reviewContext: context({ scope: { mode: "full" }, ledgerSnapshot: snapshot, priorFindingIds: ["F1"] }), roundContext: { priorAttemptId: "V0", changedPaths: ["src/a.mjs"], newEvidence: [] },
    reviews: { fidelity: settledFidelity, code: { ...lane(null, "ERROR"), error: { code: "judge-timeout", message: "t" } } } });
  const state = stateFixture("/tmp/x", { requirements: [{ id: "B1", behavior: "a", decisionIds: [] }, { id: "B2", behavior: "b", decisionIds: [] }],
    findings: [...snapshot.findings, { id: "F2", kind: "defect", requirementRefs: ["B2"], problem: "new from fidelity", evidenceRefs: ["src/a.mjs"], nextAction: "n", originAttemptId: "V1", status: "open", history: [], responses: [] }],
    verbs: [{ id: 1, at: AT, verb: "verify", issuer: "implementor", target: null, reason: "ERROR", outcome: "accepted", rejection: null }],
    verificationAttempts: [errored, currentAttempt("V2", { inputFingerprint: SHA })] });
  const plan = planReview(state, state.verificationAttempts[1], options(state));
  assert.equal(plan.record.mode, "repair");
  assert.deepEqual(plan.record.carriedLanes, ["fidelity"]);
  assert.deepEqual(plan.record.executedLanes, ["code"]);
  assert.equal(plan.record.referenceAttemptId, "V1");
  assert.deepEqual(plan.ledger, snapshot, "the rerun role sees the ledger its peer saw, not the peer's new finding");
  assert.deepEqual(plan.roundContext, errored.roundContext);
  assert.equal(plan.reference.id, "V1");

  // Any accepted domain command since that attempt means the ledger may have moved: no repair.
  state.verbs.push({ id: 2, at: AT, verb: "confirm", issuer: "human", target: "F1", reason: "confirmed", outcome: "accepted", rejection: null });
  assert.notEqual(planReview(state, state.verificationAttempts[1], options(state)).record.mode, "repair");
  state.verbs.pop();
  // Every human decision on the ledger, not only `confirm`. A repair rebuilds
  // the ledger from the reference attempt's pinned snapshot, so an acceptance
  // recorded after that attempt is not in it: the approval reverted to open
  // with its evidence gone (2026-09-14). These verbs are what makes the guard
  // above see them at all.
  for (const verb of ["risk", "risk-non-convergent"]) {
    state.verbs.push({ id: 2, at: AT, verb, issuer: "human", target: "RF1", reason: "accepted", outcome: "accepted", rejection: null });
    assert.notEqual(planReview(state, state.verificationAttempts[1], options(state)).record.mode, "repair", `${verb} after the reference attempt must not be repaired over`);
    state.verbs.pop();
  }
  state.verbs.push({ id: 2, at: AT, verb: "amend", issuer: "human", target: null, reason: "refused", outcome: "rejected", rejection: { check: "authority", message: "m" } });
  assert.equal(planReview(state, state.verificationAttempts[1], options(state)).record.mode, "repair", "a refused command changed nothing");
  // Different input or a different policy: no repair.
  assert.notEqual(planReview(state, { ...state.verificationAttempts[1], inputFingerprint: "9".repeat(64) }, options(state)).record.mode, "repair");
  assert.notEqual(planReview(state, state.verificationAttempts[1], options(state, { policySha256: "9".repeat(64) })).record.mode, "repair");
  // The record above pins no `identity` digest: the repair is licensed by the
  // input fingerprint, the policy and the verb log, and by nothing the
  // preparation step recomputes from those same records. A context that
  // still carries the retired digest is refused by the state reader, not
  // read around (see implement-store.test.mjs).
  assert.equal(planReview(state, state.verificationAttempts[1], options(state)).record.mode, "repair", "a repair needs no identity digest on the reference attempt");
});

test("the round context is measured against the last attempt a reviewer saw, not a later interrupted one", () => {
  const settled = settledAttempt("V1");
  const interrupted = attemptFixture({ id: "V2", verdict: "ERROR", phase: "mechanical", error: { stage: "mechanical", code: "verification-interrupted", message: "owner died" } });
  assert.equal(reviewPrior([settled, interrupted]).id, "V1");
  assert.equal(reviewPrior([interrupted]).id, "V2", "with nothing settled the latest attempt is still the prior");
  assert.equal(reviewPrior([]), null);
});

test("requirement grounds follow carried assessments back to the attempt that actually reviewed them", () => {
  const anchor = settledAttempt("V1");
  const focused = settledAttempt("V2", { reviewContext: context({ scope: { mode: "focused", anchorAttemptId: "V1", anchorAssessments: { fidelity: [], code: [] }, invalidatedEvidenceRefs: [], reopenedRequirementRefs: [] } }),
    reviews: { fidelity: lane(review([{ ...assessment(["B1"]), basis: "carried" }, assessment(["B2"], ["src/b.mjs"])])), code: lane(review([assessment([])])) } });
  const state = stateFixture("/tmp/x", { requirements: [{ id: "B1", behavior: "a", decisionIds: [] }, { id: "B2", behavior: "b", decisionIds: [] }, { id: "B3", behavior: "c", decisionIds: [] }], verificationAttempts: [anchor, focused] });
  assert.deepEqual(requirementGrounds(state), [
    { requirementRef: "B1", conclusion: "satisfied", reviewedInAttempt: "V1", carriedThrough: 1 },
    { requirementRef: "B2", conclusion: "satisfied", reviewedInAttempt: "V2", carriedThrough: 0 },
    { requirementRef: "B3", conclusion: null, reviewedInAttempt: null, carriedThrough: 0 },
  ]);
});
