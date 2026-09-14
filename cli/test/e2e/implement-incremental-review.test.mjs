import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CLI, PRD_PATH, REVIEW_PASS, defect, makeProject, ok, readState, registerEvidence, run, start, stub } from "../helpers/implement-fixture.mjs";

// These tests exercise the public CLI and the actual suite process with only
// the external reviewers stubbed. What they establish is the harness's side of
// the policy: which round is full, focused or a repair, what the reviewer is
// shown, what it may carry, and what the records say afterwards. Whether a
// live reviewer catches a planted defect in a focused round is measured with
// real judges (docs/plans/2026-09-14-incremental-review.md), not here.

const HELPER = "helper.txt";
const IMPL = "implementation.txt";
const satisfied = (requirementRefs, evidenceRefs, basis) => ({ requirementRefs, conclusion: "satisfied", rationale: `The fixture source ${evidenceRefs.join(", ")} implements ${requirementRefs.join(", ") || "the shared dispatch"}.`, evidenceRefs, ...(basis ? { basis } : {}) });
const withAssessments = (review, assessments, extra = {}) => ({ ...review, assessments, ...extra });

function roleStub(root, fidelity, code) {
  const env = stub(root);
  fs.rmSync(env.SASU_JUDGE_STUB_CAPTURE_DIR, { recursive: true, force: true });
  fs.writeFileSync(env.SASU_JUDGE_STUB_FILE, JSON.stringify({ byPurpose: { "implement:fidelity": fidelity, "implement:code": code } }));
  return env;
}
const prompt = (env, role) => fs.readFileSync(path.join(env.SASU_JUDGE_STUB_CAPTURE_DIR, `implement_${role}.prompt.txt`), "utf8");
const capturedRoles = (env) => fs.existsSync(env.SASU_JUDGE_STUB_CAPTURE_DIR) ? fs.readdirSync(env.SASU_JUDGE_STUB_CAPTURE_DIR).filter((name) => name.endsWith(".prompt.txt")).map((name) => name.replace(/^implement_|\.prompt\.txt$/g, "")).sort() : [];
const suiteCount = (root) => fs.readFileSync(path.join(root, "agents/suite-count.log"), "utf8").split("ran").length - 1;

function firstRound(root) {
  const workRoot = start(root);
  fs.writeFileSync(path.join(workRoot, HELPER), "shared helper v1\n");
  const fidelity = withAssessments(REVIEW_PASS, [satisfied(["B1", "B2"], [HELPER]), satisfied(["B3"], [IMPL])]);
  const code = withAssessments(REVIEW_PASS, [satisfied([], [IMPL, HELPER])]);
  const env = roleStub(root, fidelity, code);
  ok(run(root, ["implement", "verify"], { env }));
  const first = readState(root).verificationAttempts[0];
  assert.equal(first.reviewScope.mode, "full");
  assert.match(first.reviewScope.reason, /first review/);
  assert.equal(first.reviewContext.scope.mode, "full");
  assert.doesNotMatch(prompt(env, "fidelity"), /REVIEW SCOPE/);
  return { workRoot, first, fidelity, code };
}

test("after a full first review, a local change gets a focused round that shows each role its own anchor grounds and records what it carried", () => {
  const root = makeProject({ count: 3 });
  const { workRoot, first } = firstRound(root);
  fs.appendFileSync(path.join(workRoot, IMPL), "second value fixed\n");
  const fidelity = withAssessments(REVIEW_PASS, [satisfied(["B1", "B2"], [HELPER], "carried"), satisfied(["B3"], [IMPL])], { scope: { basis: "focused", reason: "the change is confined to the public implementation file; the helper's callers are unchanged" } });
  const code = withAssessments(REVIEW_PASS, [satisfied([], [IMPL, HELPER])]);
  const env = roleStub(root, fidelity, code);
  const verified = ok(run(root, ["implement", "verify"], { env }));
  const state = readState(root);
  const second = state.verificationAttempts[1];
  assert.equal(second.reviewScope.mode, "focused");
  assert.equal(second.reviewScope.referenceAttemptId, first.id);
  assert.deepEqual(second.reviewScope.carriedLanes, []);
  assert.deepEqual(second.roundContext.changedPaths, [IMPL]);
  assert.equal(second.reviewContext.scope.anchorAttemptId, first.id);
  assert.ok(second.reviewContext.scope.invalidatedEvidenceRefs.includes(IMPL));
  assert.equal(second.reviews.fidelity.result.assessments[0].basis, "carried");
  assert.equal(second.reviews.fidelity.result.scope.basis, "focused");
  assert.equal(second.verdict, "PASS");
  for (const role of ["fidelity", "code"]) {
    const text = prompt(env, role);
    assert.match(text, new RegExp(`REVIEW SCOPE .*focused round after anchor attempt ${first.id}`));
    assert.match(text, new RegExp(`YOUR OWN ${role.toUpperCase()} GROUNDS AT ANCHOR ATTEMPT ${first.id}`));
    assert.match(text, /"basis":"reviewed\|carried"/);
    assert.match(text, /Changed paths since that attempt:\n- implementation.txt/);
  }
  assert.doesNotMatch(prompt(env, "fidelity"), /YOUR OWN CODE GROUNDS/, "a role never sees the peer's grounds");
  assert.match(prompt(env, "fidelity"), /cites changed evidence \(implementation.txt\); re-review/);
  assert.match(prompt(env, "fidelity"), /cited evidence unchanged; may be carried/);
  assert.deepEqual(verified.detail.requirementGrounds, [
    { requirementRef: "B1", conclusion: "satisfied", reviewedInAttempt: first.id, carriedThrough: 1 },
    { requirementRef: "B2", conclusion: "satisfied", reviewedInAttempt: first.id, carriedThrough: 1 },
    { requirementRef: "B3", conclusion: "satisfied", reviewedInAttempt: second.id, carriedThrough: 0 },
  ]);
  const status = ok(run(root, ["implement", "status"]));
  assert.ok(status.summary.some((line) => line.startsWith("Review scope: focused")), JSON.stringify(status.summary));
  assert.ok(status.summary.some((line) => /Requirement grounds: 1 reviewed in this attempt, 2 carried from/.test(line)), JSON.stringify(status.summary));
  ok(run(root, ["implement", "finalize"]));
  const receipt = JSON.parse(fs.readFileSync(path.join(root, readState(root).completion.receiptPath), "utf8"));
  assert.equal(receipt.reviewScope.mode, "focused");
  assert.equal(receipt.requirementGrounds[0].reviewedInAttempt, first.id);
  assert.equal(suiteCount(root), 2, "the sealed suite runs on every attempt; nothing about it is carried");
});

test("a carried ground on changed evidence, on a reopened requirement, or outside a focused round is refused as reviewer output, never accepted as a past PASS", () => {
  const root = makeProject({ count: 3 });
  const { workRoot, first } = firstRound(root);
  fs.writeFileSync(path.join(workRoot, HELPER), "shared helper v2: behavior changed\n");
  const fidelity = withAssessments(REVIEW_PASS, [satisfied(["B1", "B2"], [HELPER], "carried"), satisfied(["B3"], [IMPL])]);
  const code = withAssessments(REVIEW_PASS, [satisfied([], [IMPL, HELPER])]);
  let env = roleStub(root, fidelity, code);
  assert.notEqual(run(root, ["implement", "verify"], { env }).status, 0);
  let latest = readState(root).verificationAttempts.at(-1);
  assert.equal(latest.reviewScope.mode, "focused");
  assert.equal(latest.reviews.fidelity.verdict, "ERROR");
  assert.match(latest.reviews.fidelity.error.message, /citing evidence that changed since attempt .*helper.txt/);
  assert.equal(latest.reviews.code.verdict, "PASS", "the valid peer is retained");
  assert.equal(latest.verdict, "ERROR");
  // The same input again, with the carried ground dropped, is a repair: only Fidelity reruns.
  env = roleStub(root, withAssessments(REVIEW_PASS, [satisfied(["B1", "B2", "B3"], [HELPER, IMPL])]), code);
  ok(run(root, ["implement", "verify"], { env }));
  latest = readState(root).verificationAttempts.at(-1);
  assert.equal(latest.reviewScope.mode, "repair");
  assert.deepEqual(capturedRoles(env), ["fidelity"]);
  assert.equal(latest.reviews.code.carriedFrom, readState(root).verificationAttempts.at(-2).id);
  assert.equal(latest.verdict, "PASS");
  assert.notEqual(first.id, latest.id);
});

// The review policy must name the code that shaped the judgment, not the
// version string a human remembered to bump: the prompts and validators
// changed on 2026-09-14 under an unchanged `0.10.0`, and a policy keyed on the
// version alone would have let a round judged under the old prompt anchor a
// focused round or a repair under the new one.
test("a CLI build whose bytes differ is a different review policy: the next round is full, and the same build stays focused", () => {
  const root = makeProject({ count: 3 });
  const { workRoot, first, fidelity, code } = firstRound(root);
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-rebuilt-cli-"));
  // The built CLI reads its package.json and the shared helpers in cli/lib next to dist.
  fs.cpSync(path.dirname(CLI), path.join(copy, "dist"), { recursive: true });
  fs.cpSync(path.join(path.dirname(CLI), "..", "lib"), path.join(copy, "lib"), { recursive: true });
  fs.copyFileSync(path.join(path.dirname(CLI), "..", "package.json"), path.join(copy, "package.json"));
  fs.appendFileSync(path.join(copy, "dist", "implement", "prompts.js"), "\n// a one-line change to the prompt module; the version string is unchanged\n");
  fs.appendFileSync(path.join(workRoot, IMPL), "second value fixed\n");
  const rebuilt = path.join(copy, "dist", "cli.js");
  let env = roleStub(root, fidelity, code);
  ok(run(root, ["implement", "verify"], { env, cli: rebuilt }));
  let latest = readState(root).verificationAttempts.at(-1);
  assert.equal(latest.reviewScope.mode, "full");
  assert.match(latest.reviewScope.reason, /review policy changed since attempt/);
  assert.notEqual(latest.reviewPolicySha256, first.reviewPolicySha256);
  assert.doesNotMatch(prompt(env, "fidelity"), /REVIEW SCOPE/);
  // The rebuilt CLI, run again on a further change, is the same policy as itself.
  fs.appendFileSync(path.join(workRoot, IMPL), "third value fixed\n");
  env = roleStub(root, fidelity, code);
  ok(run(root, ["implement", "verify"], { env, cli: rebuilt }));
  const again = readState(root).verificationAttempts.at(-1);
  assert.equal(again.reviewScope.mode, "focused");
  assert.equal(again.reviewScope.referenceAttemptId, latest.id);
  assert.equal(again.reviewPolicySha256, latest.reviewPolicySha256);
});

test("an amended contract sends the next round back to a full review with the reason recorded", () => {
  const root = makeProject({ count: 3 });
  const { workRoot, first, fidelity, code } = firstRound(root);
  const oldText = fs.readFileSync(path.join(root, PRD_PATH), "utf8");
  fs.writeFileSync(path.join(root, PRD_PATH), oldText.replace("Requirement 1: the public command preserves value 1.", "Requirement 1: the public command preserves value 1 and its label."));
  ok(run(root, ["implement", "amend", "--issuer", "human", "--approval", "I approve the corrected requirement.", "--reason", "B1 gained a label."]));
  fs.appendFileSync(path.join(workRoot, IMPL), "label preserved\n");
  const env = roleStub(root, withAssessments(REVIEW_PASS, [satisfied(["B1", "B2"], [HELPER], "carried"), satisfied(["B3"], [IMPL])]), code);
  assert.notEqual(run(root, ["implement", "verify"], { env }).status, 0, "a carried ground under a full round is refused");
  let latest = readState(root).verificationAttempts.at(-1);
  assert.equal(latest.reviewScope.mode, "full");
  assert.match(latest.reviewScope.reason, /contract inputs changed since attempt/);
  assert.match(latest.reviews.fidelity.error.message, /cannot carry grounds outside a focused round/);
  assert.doesNotMatch(prompt(env, "fidelity"), /REVIEW SCOPE/);
  ok(run(root, ["implement", "verify"], { env: roleStub(root, fidelity, code) }));
  latest = readState(root).verificationAttempts.at(-1);
  assert.equal(latest.reviewScope.mode, "repair", "the refused carried ground was a Fidelity error on an unchanged input, so Code is reused");
  assert.equal(latest.reviewContext.scope.mode, "full");
  assert.notEqual(latest.prdSha256, first.prdSha256);
});

test("a role lost to a backend error is repaired on the same input without rerunning its peer, without showing it the peer's findings, and without duplicating them", () => {
  const root = makeProject({ count: 3 });
  const { workRoot } = firstRound(root);
  fs.appendFileSync(path.join(workRoot, IMPL), "regression introduced\n");
  const found = defect({ ref: "B3", problem: "The third value is dropped after the regression." });
  const fidelityFail = withAssessments({ ...REVIEW_PASS, findings: [found] }, [satisfied(["B1", "B2"], [HELPER], "carried"), { requirementRefs: ["B3"], conclusion: "unresolved", rationale: "The regression drops the third value.", evidenceRefs: [IMPL] }]);
  let env = roleStub(root, fidelityFail, "not json at all");
  assert.notEqual(run(root, ["implement", "verify"], { env }).status, 0);
  let state = readState(root);
  const errored = state.verificationAttempts.at(-1);
  assert.equal(errored.verdict, "ERROR");
  assert.equal(errored.reviews.fidelity.verdict, "FAIL");
  assert.equal(errored.reviews.code.verdict, "ERROR");
  assert.deepEqual(state.findings.map((entry) => [entry.id, entry.status]), [["F1", "open"]]);
  const budgetBefore = ok(run(root, ["implement", "status"])).detail.verification.budget;

  env = roleStub(root, fidelityFail, withAssessments(REVIEW_PASS, [satisfied([], [IMPL, HELPER])]));
  const repaired = run(root, ["implement", "verify"], { env });
  assert.notEqual(repaired.status, 0, "the open defect still fails the round");
  state = readState(root);
  const repair = state.verificationAttempts.at(-1);
  assert.equal(repair.reviewScope.mode, "repair");
  assert.equal(repair.reviewScope.referenceAttemptId, errored.id);
  assert.deepEqual(repair.reviewScope.carriedLanes, ["fidelity"]);
  assert.deepEqual(repair.reviewScope.executedLanes, ["code"]);
  assert.deepEqual(capturedRoles(env), ["code"], "only the lost role is invoked");
  assert.equal(repair.reviews.fidelity.carriedFrom, errored.id);
  assert.equal(repair.reviews.fidelity.invocationId, errored.reviews.fidelity.invocationId);
  assert.deepEqual(repair.reviews.fidelity.result, errored.reviews.fidelity.result);
  assert.equal(repair.reviews.code.verdict, "PASS");
  assert.equal(repair.verdict, "FAIL");
  assert.equal(repair.inputFingerprint, errored.inputFingerprint);
  assert.equal(repair.reviewContext.identity, undefined, "the repair is licensed by the fingerprint, the policy and the verb log; no recomputed digest of those same records is pinned");
  assert.deepEqual(repair.roundContext.changedPaths, errored.roundContext.changedPaths);
  const codePrompt = prompt(env, "code");
  assert.doesNotMatch(codePrompt, new RegExp(found.problem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the rerun role must not see its peer's verdict");
  assert.match(codePrompt, /REVIEW FINDING HISTORY[\s\S]*\[\]/);
  assert.match(codePrompt, new RegExp(`mechanical PASS: npm test \\(attempt ${errored.id}\\)`), "the peer's suite log stays readable and citable");
  assert.deepEqual(state.findings.map((entry) => [entry.id, entry.problem, entry.status]), [["F1", found.problem, "open"]], "the reused role's finding keeps its id and is not entered twice");
  assert.equal(state.findings[0].originAttemptId, repair.id);
  assert.equal(suiteCount(root), 3, "the suite is executed again: its purity is not provable");
  const budgetAfter = ok(run(root, ["implement", "status"])).detail.verification.budget;
  assert.equal(budgetBefore.fixAttempts, 0, "a backend error is not a correction round");
  assert.equal(budgetAfter.fixAttempts, 1, "the repaired round is the one correction round on this input");
  const status = ok(run(root, ["implement", "status"]));
  assert.ok(status.summary.some((line) => line.startsWith("Review scope: repair")), JSON.stringify(status.summary));
  assert.ok(status.summary.some((line) => line.startsWith("Reused settled lanes: fidelity; executed: code")), JSON.stringify(status.summary));
  assert.notEqual(run(root, ["implement", "finalize"]).status, 0);

  // The fix: a focused round after the repair, both roles resolving F1.
  fs.appendFileSync(path.join(workRoot, IMPL), "third value restored\n");
  const resolved = { findingId: "F1", status: "resolved", reason: "The third value is restored by the public implementation.", evidenceRefs: [IMPL] };
  env = roleStub(root, withAssessments({ ...REVIEW_PASS, priorDispositions: [resolved] }, [satisfied(["B1", "B2"], [HELPER], "carried"), satisfied(["B3"], [IMPL])]), withAssessments({ ...REVIEW_PASS, priorDispositions: [resolved] }, [satisfied([], [IMPL, HELPER])]));
  ok(run(root, ["implement", "verify"], { env }));
  state = readState(root);
  const fixed = state.verificationAttempts.at(-1);
  assert.equal(fixed.reviewScope.mode, "focused");
  assert.equal(fixed.reviewScope.referenceAttemptId, repair.id, "the repaired attempt settled every lane and anchors the next round");
  assert.equal(state.findings[0].status, "resolved");
  assert.equal(JSON.stringify(state.verificationAttempts[1]), JSON.stringify(errored), "the errored attempt's records are untouched");
  ok(run(root, ["implement", "finalize"]));
});

test("a repair is refused when the input moved: new evidence makes both roles run and the round stays focused on the delta", () => {
  const root = makeProject({ count: 3 });
  const { first } = firstRound(root);
  let env = roleStub(root, withAssessments(REVIEW_PASS, [satisfied(["B1", "B2", "B3"], [HELPER, IMPL])]), "not json at all");
  assert.notEqual(run(root, ["implement", "verify"], { env }).status, 0);
  const errored = readState(root).verificationAttempts.at(-1);
  assert.equal(errored.reviews.code.verdict, "ERROR");
  const evidence = registerEvidence(root);
  env = roleStub(root, withAssessments(REVIEW_PASS, [satisfied(["B1", "B2", "B3"], [HELPER, IMPL])]), withAssessments(REVIEW_PASS, [satisfied([], [IMPL])]));
  ok(run(root, ["implement", "verify"], { env }));
  const latest = readState(root).verificationAttempts.at(-1);
  assert.notEqual(latest.reviewScope.mode, "repair");
  assert.equal(latest.reviewScope.mode, "focused");
  assert.equal(latest.reviewScope.referenceAttemptId, first.id, "the anchor is the last attempt that settled every lane, not the errored one");
  assert.deepEqual(capturedRoles(env), ["code", "fidelity"]);
  assert.deepEqual(latest.roundContext.newEvidence.map((entry) => entry.path), [evidence]);
  assert.ok(latest.reviewContext.scope.invalidatedEvidenceRefs.includes(evidence));
});
