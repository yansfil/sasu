import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { REVIEW_INPUT_PATHS } from "../../dist/implement/prompts.js";
import { setTimeout as delay } from "node:timers/promises";
import { PRD_PATH, REVIEW_PASS, defect, makeProject, ok, readState, registerEvidence, run, runAsync, start, stub, reviewWithAssessments } from "../helpers/implement-fixture.mjs";

function reviewFile(env, role, relative) {
  const { cwd } = JSON.parse(fs.readFileSync(path.join(env.SASU_JUDGE_STUB_CAPTURE_DIR, `implement_${role}.options.json`), "utf8"));
  return fs.readFileSync(path.join(cwd, relative), "utf8");
}

// These tests exercise the public CLI and actual suite process. Only the
// external reviewers are stubbed; their answers are not omission-detection proof.
function roleOutputs(root, fidelity, code) {
  const env = stub(root);
  fs.writeFileSync(env.SASU_JUDGE_STUB_FILE, JSON.stringify({ byPurpose: { "implement:fidelity": reviewWithAssessments(root, fidelity, "fidelity"), "implement:code": reviewWithAssessments(root, code, "code") } }));
  return env;
}

function captured(env, role, extension = "prompt.txt") {
  const value = fs.readFileSync(path.join(env.SASU_JUDGE_STUB_CAPTURE_DIR, `implement_${role}.${extension}`), "utf8");
  return extension === "prompt.txt" ? value : JSON.parse(value);
}

function assertSharedInputs(env) {
  const prompts = [captured(env, "fidelity"), captured(env, "code")];
  const marker = "FIXED REVIEW WORKSPACE:";
  assert.ok(prompts.every((prompt) => prompt.includes(marker)), "both roles must receive the complete fixed input envelope");
  assert.equal(prompts[0].slice(prompts[0].indexOf(marker)), prompts[1].slice(prompts[1].indexOf(marker)));
  assert.deepEqual(captured(env, "fidelity", "options.json"), captured(env, "code", "options.json"), "both roles must use the same isolated evidence root and read-only execution options");
  assert.equal(captured(env, "fidelity", "options.json").agentic, true);
  return prompts.map((prompt, index) => prompt + "\n" + Object.values(REVIEW_INPUT_PATHS).map((relative) => reviewFile(env, index === 0 ? "fidelity" : "code", relative)).join("\n"));
}

const disposition = (findingId, status, reason) => ({ findingId, status, reason, evidenceRefs: ["implementation.txt"] });
const withDisposition = (findingId, status, reason) => ({ ...REVIEW_PASS, priorDispositions: [disposition(findingId, status, reason)] });
const suiteCount = (root) => fs.readFileSync(path.join(root, "agents/suite-count.log"), "utf8");

async function until(condition, message) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) { if (condition()) return; await delay(25); }
  assert.fail(message);
}

test("two independently recorded reviews overlap on one full contract, evidence snapshot, suite and receipt", () => {
  const root = makeProject({ count: 30 });
  start(root);
  const evidence = registerEvidence(root);
  const env = { ...stub(root), SASU_JUDGE_STUB_DELAY_MS: JSON.stringify({ "implement:fidelity": 800, "implement:code": 800 }) };
  ok(run(root, ["implement", "verify"], { env }));
  const state = readState(root);
  assert.equal(state.schema, "sasu.implement.state.v10");
  assert.equal(state.verificationAttempts.length, 1);
  const attempt = state.verificationAttempts[0];
  assert.equal(attempt.review, undefined);
  assert.equal(attempt.prdSha256, state.prd.sha256);
  assert.deepEqual(attempt.reviewContext.requiredRequirementRefs, state.requirements.map((entry) => entry.id));
  assert.ok(attempt.reviewContext.actualEvidenceRefs.includes("implementation.txt"));
  assert.equal(attempt.risk, null);
  assert.deepEqual(Object.keys(attempt.reviews).sort(), ["code", "fidelity"]);
  const lanes = [attempt.reviews.fidelity, attempt.reviews.code];
  assert.equal(new Set(lanes.map((lane) => lane.invocationId)).size, 2);
  assert.deepEqual(lanes.map((lane) => lane.judge.purpose).sort(), ["implement:code", "implement:fidelity"]);
  for (const lane of lanes) {
    assert.equal(lane.verdict, "PASS");
    assert.deepEqual(lane.result, reviewWithAssessments(root, REVIEW_PASS, lane.judge.purpose === "implement:fidelity" ? "fidelity" : "code"));
    assert.equal(lane.judge.attempts, 1);
    assert.equal(lane.judge.outcome, "ok");
    assert.ok(lane.durationMs >= 0 && lane.judge.durationMs >= 0);
  }
  // Compare recorded execution intervals, not a wall-clock speed threshold.
  assert.ok(Math.max(...lanes.map((lane) => Date.parse(lane.startedAt))) < Math.min(...lanes.map((lane) => Date.parse(lane.finishedAt))), "neither reviewer must wait for the other to finish");
  assert.deepEqual(fs.readdirSync(env.SASU_JUDGE_STUB_CAPTURE_DIR).filter((name) => name.endsWith(".prompt.txt")).sort(), ["implement_code.prompt.txt", "implement_fidelity.prompt.txt"]);
  for (const prompt of assertSharedInputs(env)) {
    assert.ok(prompt.includes(fs.readFileSync(path.join(root, PRD_PATH), "utf8")));
    assert.ok(prompt.includes(evidence));
    assert.ok(prompt.includes(attempt.mechanical[0].logPath));
    for (let index = 1; index <= 30; index++) assert.ok(prompt.includes(`Requirement ${index}:`));
  }
  for (const role of ["fidelity", "code"]) {
    assert.ok(reviewFile(env, role, attempt.mechanical[0].logPath).includes("REAL-SUITE-OUTPUT"));
    assert.equal(reviewFile(env, role, evidence), fs.readFileSync(path.join(root, evidence), "utf8"));
  }
  assert.equal(attempt.mechanical.length, 1);
  assert.equal(suiteCount(root), "ran\n");
  ok(run(root, ["implement", "finalize"]));
  const closed = readState(root);
  const receipt = JSON.parse(fs.readFileSync(path.join(root, closed.completion.receiptPath), "utf8"));
  assert.equal(receipt.schema, "sasu.implement.receipt.v6");
  assert.equal(receipt.status, "complete");
  assert.equal(receipt.delivery.eligible, true);
  assert.equal(receipt.verificationAttemptId, attempt.id);
  assert.equal(receipt.inputFingerprint, attempt.inputFingerprint);
  assert.equal(receipt.prdSha256, attempt.prdSha256);
  assert.deepEqual(receipt.reviewContext, attempt.reviewContext);
  for (const role of ["fidelity", "code"]) assert.equal(receipt.reviews[role].invocationId, attempt.reviews[role].invocationId);
  assert.equal(suiteCount(root), "ran\n", "finalize must not repeat either reviewer or the suite");
});

test("missing Fidelity accounting is an error even when the Code reviewer passes and cannot earn a receipt", () => {
  const root = makeProject({ count: 3 });
  start(root);
  const fidelity = reviewWithAssessments(root);
  fidelity.assessments[0].requirementRefs = ["B1", "B3"];
  const env = roleOutputs(root, fidelity, REVIEW_PASS);
  assert.notEqual(run(root, ["implement", "verify"], { env }).status, 0);
  const state = readState(root);
  const attempt = state.verificationAttempts[0];
  assert.deepEqual(attempt.reviewContext.requiredRequirementRefs, ["B1", "B2", "B3"]);
  assert.equal(attempt.prdSha256, state.prd.sha256);
  assert.equal(attempt.verdict, "ERROR");
  assert.equal(attempt.reviews.fidelity.verdict, "ERROR");
  assert.equal(attempt.reviews.fidelity.result, null);
  assert.match(attempt.reviews.fidelity.error.message, /missing required references: B2/);
  assert.ok(attempt.reviews.fidelity.judge, "invalid output remains a recorded reviewer invocation");
  assert.equal(attempt.reviews.code.verdict, "PASS", "the valid peer retains its original result");
  assert.deepEqual(attempt.reviews.code.result, reviewWithAssessments(root, REVIEW_PASS, "code"));
  assert.equal(state.status, "active");
  assert.notEqual(run(root, ["implement", "finalize"]).status, 0);
  assert.equal(readState(root).completion, null);
  assert.equal(suiteCount(root), "ran\n");
});

test("a findings-only summary cannot substitute for either role's recorded grounds", () => {
  const root = makeProject();
  start(root);
  const env = stub(root);
  // Bypass the fixture's valid-result constructor deliberately: old responses
  // without assessments must reach and fail the production role validator.
  fs.writeFileSync(env.SASU_JUDGE_STUB_FILE, JSON.stringify({ byPurpose: { "implement:fidelity": REVIEW_PASS, "implement:code": REVIEW_PASS } }));
  assert.notEqual(run(root, ["implement", "verify"], { env }).status, 0);
  const attempt = readState(root).verificationAttempts[0];
  for (const role of ["fidelity", "code"]) {
    assert.equal(attempt.reviews[role].verdict, "ERROR");
    assert.equal(attempt.reviews[role].result, null);
    assert.match(attempt.reviews[role].error.message, /assessments must be a non-empty array/);
  }
  assert.notEqual(run(root, ["implement", "finalize"]).status, 0);
  assert.equal(readState(root).completion, null);
});

test("a settled role persists under the live lease, and its new defect survives a sibling error without closing prior findings", { timeout: 90_000 }, async (t) => {
  const root = makeProject();
  start(root);
  const original = defect();
  assert.notEqual(run(root, ["implement", "verify"], { env: stub(root, { ...REVIEW_PASS, findings: [original] }) }).status, 0);
  const prior = readState(root).findings[0];
  const newDefect = defect({ ref: "B2", problem: "The second public value is discarded by the implementation." });
  const fidelity = { ...withDisposition(prior.id, "resolved", "The first path appears repaired."), findings: [newDefect] };
  const env = { ...roleOutputs(root, fidelity, "malformed external reviewer response"), SASU_JUDGE_STUB_DELAY_MS: JSON.stringify({ "implement:code": 3_000 }) };
  const execution = runAsync(root, ["implement", "verify"], env);
  t.after(async () => { execution.child.kill("SIGTERM"); await execution.done; });
  // One snapshot per evaluation, not two. `at(-1)` is not monotonic here: the
  // prior attempt already carries a settled fidelity, so the first read could
  // answer that clause about attempt 1 while the second read answered the
  // length clause about attempt 2. Both true, neither about the same state -
  // and the next line then read attempt 2 with `reviews.fidelity` still null
  // and threw a TypeError (2026-09-11, load 9; passed on rerun). Load only
  // widened the window; the conjunction across snapshots was the defect.
  await until(() => {
    const state = readState(root);
    return state.verificationAttempts.length === 2 && state.verificationAttempts.at(-1)?.reviews.fidelity !== null;
  }, "the first role never persisted its settled result");
  const partial = readState(root);
  const pending = partial.verificationAttempts.at(-1);
  assert.deepEqual(pending.reviews.fidelity.result, reviewWithAssessments(root, fidelity, "fidelity"));
  assert.equal(pending.reviews.code, null);
  assert.equal(partial.activeVerification.attemptId, pending.id);
  assert.equal(partial.status, "active");
  assert.deepEqual(partial.findings.map((finding) => finding.id), [prior.id], "the shared ledger waits for both settlements");
  assert.equal(partial.findings[0].status, "open");
  const result = await execution.done;
  assert.notEqual(result.status, 0);
  const state = readState(root);
  const finished = state.verificationAttempts.at(-1);
  assert.equal(finished.reviews.fidelity.verdict, "FAIL");
  assert.equal(finished.reviews.code.verdict, "ERROR");
  assert.equal(finished.reviews.code.result, null);
  assert.ok(finished.reviews.code.error);
  assert.ok(finished.reviews.code.judge, "failed real backend attempts must remain recorded");
  assert.equal(finished.verdict, "ERROR");
  assert.equal(state.activeVerification, undefined);
  assert.equal(state.findings.find((finding) => finding.id === prior.id).status, "open");
  assert.ok(state.findings.some((finding) => finding.problem === newDefect.problem && finding.status === "open"));
  assert.equal(suiteCount(root), "ran\nran\n");
  assert.notEqual(run(root, ["implement", "finalize"]).status, 0);
  assert.equal(readState(root).completion, null);
});

test("identical findings share one stable identity, conflicting dispositions keep it open, and agreement after repair earns a receipt", () => {
  const root = makeProject();
  fs.writeFileSync(path.join(root, "agents/config.json"), JSON.stringify({ judge: { retryBudget: 3 } }));
  start(root);
  const issue = defect();
  assert.notEqual(run(root, ["implement", "verify"], { env: stub(root, { ...REVIEW_PASS, findings: [issue] }) }).status, 0);
  assert.equal(readState(root).findings.length, 1, "exact duplicates from the two roles should not become duplicate repair work");
  const id = readState(root).findings[0].id;
  const resolved = withDisposition(id, "resolved", "The first reviewer considers the existing path correct.");
  const open = withDisposition(id, "open", "The second reviewer still observes the missing public value.");
  let env = roleOutputs(root, resolved, open);
  assert.notEqual(run(root, ["implement", "verify"], { env }).status, 0);
  let state = readState(root);
  assert.equal(state.findings.length, 1);
  assert.equal(state.findings[0].id, id);
  assert.equal(state.findings[0].status, "open");
  const second = state.verificationAttempts[1];
  assert.deepEqual(second.reviews.fidelity.result.priorDispositions, resolved.priorDispositions);
  assert.deepEqual(second.reviews.code.result.priorDispositions, open.priorDispositions);
  assert.equal(second.verdict, "FAIL");
  for (const prompt of assertSharedInputs(env)) { assert.ok(prompt.includes(id)); assert.ok(prompt.includes(issue.problem)); }
  assert.notEqual(run(root, ["implement", "finalize"]).status, 0);
  fs.appendFileSync(path.join(root, "implementation.txt"), "The missing public value is now preserved.\n");
  const agreed = withDisposition(id, "resolved", "The changed public implementation now preserves the requested value.");
  env = roleOutputs(root, agreed, agreed);
  ok(run(root, ["implement", "verify"], { env }));
  state = readState(root);
  assert.equal(state.verificationAttempts.length, 3, "the reviews share one correction budget and attempt per round");
  assert.equal(state.findings[0].id, id);
  assert.equal(state.findings[0].status, "resolved");
  assert.notEqual(state.verificationAttempts[2].inputFingerprint, second.inputFingerprint);
  assert.equal(suiteCount(root), "ran\nran\nran\n");
  ok(run(root, ["implement", "finalize"]));
  const closed = readState(root);
  const receipt = JSON.parse(fs.readFileSync(path.join(root, closed.completion.receiptPath), "utf8"));
  assert.equal(receipt.status, "complete");
  assert.equal(receipt.verificationAttemptId, state.verificationAttempts[2].id);
  assert.equal(receipt.findings[0].status, "resolved");
  assert.equal(receipt.delivery.eligible, true);
  assert.equal(suiteCount(root), "ran\nran\nran\n");
});

test("different defects citing the same requirement remain separate repair obligations", () => {
  const root = makeProject();
  start(root);
  const first = defect({ problem: "The public value is dropped before dispatch." });
  const second = defect({ problem: "The public value is overwritten after dispatch." });
  const env = roleOutputs(root, { ...REVIEW_PASS, findings: [first] }, { ...REVIEW_PASS, findings: [second] });
  assert.notEqual(run(root, ["implement", "verify"], { env }).status, 0);
  const findings = readState(root).findings;
  assert.equal(new Set(findings.map((finding) => finding.id)).size, 2);
  assert.deepEqual(findings.map((finding) => finding.problem).sort(), [first.problem, second.problem].sort());
  assert.ok(findings.every((finding) => finding.status === "open" && finding.requirementRefs.includes("B1")));
  assert.notEqual(run(root, ["implement", "finalize"]).status, 0);
});

test("agreement between reviewers cannot close an explicit human prerequisite", () => {
  const quote = "The user must approve production access before completion.";
  const root = makeProject({ decisions: `| D-01 | Preserve every value in the approved request. | User requested all values. |\n| D-02 | ${quote} | Access remains the user's decision. |` });
  start(root);
  const finding = { kind: "human-confirmation", requirementRefs: ["D-02"], problem: "Production access awaits the user's decision.", evidenceRefs: ["D-02"], nextAction: "Obtain the user's production access decision.", human: { sourceRef: "D-02", quote, timing: "prerequisite" } };
  assert.notEqual(run(root, ["implement", "verify"], { env: stub(root, { ...REVIEW_PASS, findings: [finding] }) }).status, 0);
  const id = readState(root).findings[0].id;
  const resolved = withDisposition(id, "resolved", "Both reviewers claim the access requirement is satisfied.");
  assert.notEqual(run(root, ["implement", "verify"], { env: roleOutputs(root, resolved, resolved) }).status, 0);
  const state = readState(root);
  assert.equal(state.findings[0].id, id);
  assert.equal(state.findings[0].status, "open");
  assert.deepEqual(state.findings[0].responses, []);
  for (const role of ["fidelity", "code"]) assert.equal(state.verificationAttempts.at(-1).reviews[role].verdict, "ERROR");
  assert.notEqual(run(root, ["implement", "finalize"]).status, 0);
});

test("a Behavior explicitly reserved for later human judgment retains pending grounds through confirmation", () => {
  const quote = "The user confirms the finished visual result after implementation; this judgment may remain pending at delivery.";
  const root = makeProject({ count: 0, extraRows: ["| B1 | The finished visual result awaits the user's post-completion judgment. | D-02 |"], decisions: `| D-01 | Deliver the finished visual result. | The user requested the visual result. |\n| D-02 | ${quote} | The person owns the final visual judgment. |` });
  start(root);
  const finding = { kind: "human-confirmation", requirementRefs: ["B1"], problem: "The finished visual result awaits the user's judgment.", evidenceRefs: ["D-02"], nextAction: "Ask the user to confirm the delivered visual result.", human: { sourceRef: "D-02", quote, timing: "post-completion" } };
  ok(run(root, ["implement", "verify"], { env: stub(root, { ...REVIEW_PASS, findings: [finding] }) }));
  const attempt = readState(root).verificationAttempts[0];
  assert.equal(attempt.verdict, "PASS");
  for (const role of ["fidelity", "code"]) {
    assert.deepEqual(attempt.reviews[role].result.assessments.map((entry) => [entry.requirementRefs, entry.conclusion]), [[["B1"], "pending-human"]]);
  }
  const originalAttemptJson = JSON.stringify(attempt);
  ok(run(root, ["implement", "finalize"]));
  let state = readState(root);
  assert.equal(state.status, "complete-pending-human");
  const pendingReceipt = JSON.parse(fs.readFileSync(path.join(root, state.completion.receiptPath), "utf8"));
  assert.equal(pendingReceipt.status, "complete-pending-human");
  assert.equal(pendingReceipt.reviews.fidelity.result.assessments[0].conclusion, "pending-human");
  assert.equal(state.findings[0].status, "open");
  ok(run(root, ["implement", "confirm", "--issuer", "human", "--id", state.findings[0].id, "--evidence", "I approve the delivered visual result."]));
  state = readState(root);
  assert.equal(state.status, "complete");
  assert.equal(state.findings[0].status, "confirmed");
  assert.equal(JSON.stringify(state.verificationAttempts[0]), originalAttemptJson, "a later human response must not rewrite the original review grounds");
});
