import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { REVIEW_PASS, makeProject, readState, run, start, stub, ok, defect } from "../helpers/implement-fixture.mjs";

function riskResult(priorId) {
  return { verdict: "FAIL", findings: [{ severity: "blocking", text: "B1: implementation.txt permits an unsafe destructive write without a guard.", ...(priorId ? { origin: "prior-unresolved", priorFindingId: priorId } : { deltaBasis: { kind: "contract-counterevidence", value: "B1 requires preserved values, implementation.txt allows destructive replacement.", requirementRefs: ["B1"], evidenceRefs: ["implementation.txt"] } }) }], ...(priorId ? { priorDispositions: [{ id: priorId, status: "unresolved", reason: "The destructive write remains unguarded." }] } : {}) };
}

test("routine success never resets the round budget while a distinct blocking risk stays open", () => {
  const root = makeProject({ profile: "high-risk" });
  fs.writeFileSync(path.join(root, "agents/config.json"), JSON.stringify({ judge: { retryBudget: 2 } }));
  start(root);
  let env = stub(root, REVIEW_PASS, riskResult());
  assert.notEqual(run(root, ["implement", "verify"], { env }).status, 0);
  let state = readState(root);
  assert.equal(state.verificationAttempts[0].reviews.fidelity.verdict, "PASS");
  const riskId = state.riskFindings[0].id;
  env = stub(root, REVIEW_PASS, riskResult(riskId));
  assert.notEqual(run(root, ["implement", "verify"], { env }).status, 0);
  const count = fs.readFileSync(path.join(root, "agents/suite-count.log"), "utf8");
  assert.notEqual(run(root, ["implement", "verify"], { env }).status, 0);
  state = readState(root);
  assert.equal(state.verificationAttempts.length, 2);
  assert.equal(fs.readFileSync(path.join(root, "agents/suite-count.log"), "utf8"), count, "budget refusal starts no new execution");
  assert.equal(state.riskFindings[0].status, "open");
  ok(run(root, ["implement", "finalize", "--status", "blocked"]));
  assert.equal(readState(root).status, "blocked");
  assert.notEqual(run(root, ["implement", "retire"]).status, 0);
  assert.notEqual(run(root, ["implement", "verify", "--grant-budget", "I approve further work."], { env }).status, 0, "a terminal blocked run cannot be reopened by a grant");
  assert.equal(readState(root).status, "blocked");
});

test("an explicit user grant preserves prior findings and extends the exhausted budget in the same run", () => {
  const root = makeProject();
  fs.writeFileSync(path.join(root, "agents/config.json"), JSON.stringify({ judge: { retryBudget: 1 } }));
  start(root);
  let env = stub(root, { ...REVIEW_PASS, findings: [defect()] });
  assert.notEqual(run(root, ["implement", "verify"], { env }).status, 0);
  const before = readState(root);
  const finding = before.findings[0];
  env = stub(root, { ...REVIEW_PASS, priorDispositions: [{ findingId: finding.id, status: "open", reason: "No correction yet.", evidenceRefs: ["implementation.txt"] }] });
  assert.notEqual(run(root, ["implement", "verify"], { env }).status, 0);
  assert.equal(readState(root).verificationAttempts.length, 1);
  const granted = run(root, ["implement", "verify", "--grant-budget", "I approve one additional review budget."], { env });
  assert.notEqual(granted.status, 0, "the unresolved defect stays incomplete after a grant");
  const state = readState(root);
  assert.equal(state.verificationAttempts.length, 2);
  assert.equal(state.budgetGrants.length, 1);
  assert.equal(state.budgetGrants[0].evidence, "I approve one additional review budget.");
  assert.equal(state.status, "active");
  assert.equal(state.findings[0].id, finding.id);
  assert.equal(state.findings[0].status, "open");
});

test("persistent backend errors terminate separately from implementation-fix rounds and permit a blocked receipt", () => {
  const root = makeProject();
  fs.writeFileSync(path.join(root, "agents/config.json"), JSON.stringify({ judge: { retryBudget: 15 } }));
  start(root);
  const env = stub(root, "malformed external judge response");
  for (let index = 0; index < 3; index++) assert.notEqual(run(root, ["implement", "verify"], { env }).status, 0);
  const before = readState(root);
  assert.equal(before.verificationAttempts.length, 3);
  assert.notEqual(run(root, ["implement", "verify"], { env }).status, 0);
  assert.equal(readState(root).verificationAttempts.length, 3);
  assert.ok(before.verificationAttempts.every((attempt) => attempt.reviews.fidelity?.result === null));
  ok(run(root, ["implement", "finalize", "--status", "blocked"]));
  const state = readState(root);
  const receipt = JSON.parse(fs.readFileSync(path.join(root, state.completion.receiptPath), "utf8"));
  assert.equal(receipt.status, "blocked");
});

test("repeated identical pre-judge errors reach the harness bound and produce an honest blocked receipt", () => {
  const root = makeProject();
  ok(run(root, ["implement", "start", "--prd", "agents/prd/fixture/prd.md"]));
  const env = stub(root);
  for (let index = 0; index < 3; index++) {
    assert.notEqual(run(root, ["implement", "verify"], { env }).status, 0);
    assert.equal(readState(root).status, "active");
    if (index < 2) assert.notEqual(run(root, ["implement", "finalize", "--status", "blocked"]).status, 0);
  }
  const before = readState(root);
  assert.equal(before.verificationAttempts.length, 3);
  assert.ok(before.verificationAttempts.every((attempt) => attempt.error.stage === "preflight" && attempt.reviews.fidelity === null));
  assert.notEqual(run(root, ["implement", "verify"], { env }).status, 0);
  assert.equal(readState(root).verificationAttempts.length, 3, "the bound refuses a fourth execution");
  assert.equal(fs.existsSync(env.SASU_JUDGE_STUB_CAPTURE_DIR), false);
  ok(run(root, ["implement", "finalize", "--status", "blocked"]));
  const state = readState(root);
  const receipt = JSON.parse(fs.readFileSync(path.join(root, state.completion.receiptPath), "utf8"));
  assert.equal(receipt.status, "blocked");
  assert.equal(receipt.delivery.eligible, false);
  assert.equal(state.verificationAttempts.at(-1).reviews.fidelity, null);
});

test("high-risk and routine review execute concurrently on the same input with no duplicate suite", () => {
  const root = makeProject({ profile: "high-risk" });
  start(root);
  const env = { ...stub(root, REVIEW_PASS, { verdict: "PASS", findings: [] }), SASU_JUDGE_STUB_DELAY_MS: JSON.stringify({ "implement:fidelity": 800 }) };
  ok(run(root, ["implement", "verify"], { env }));
  const attempt = readState(root).verificationAttempts[0];
  assert.equal(attempt.reviews.fidelity.verdict, "PASS");
  assert.equal(attempt.risk.verdict, "PASS");
  assert.ok(Date.parse(attempt.risk.startedAt) < Date.parse(attempt.reviews.fidelity.finishedAt), "risk need not wait for routine review output");
  assert.equal(attempt.mechanical.length, 1);
  assert.equal(fs.readFileSync(path.join(root, "agents/suite-count.log"), "utf8"), "ran\n");
});

test("accepted risk can release delivery while historical review failure remains honest and product defects remain blocking", () => {
  for (const missingRequirement of [false, true]) {
    const root = makeProject({ profile: "high-risk" });
    start(root);
    const env = stub(root, missingRequirement ? { ...REVIEW_PASS, findings: [defect()] } : REVIEW_PASS, riskResult());
    assert.notEqual(run(root, ["implement", "verify"], { env }).status, 0);
    const id = readState(root).riskFindings[0].id;
    ok(run(root, ["implement", "risk", "--issuer", "human", "--accept", "--id", id, "--evidence", "I explicitly accept the remaining risk for this delivery."]));
    assert.equal(readState(root).verificationAttempts.at(-1).verdict, "FAIL", "acceptance does not rewrite the actual historical result");
    const finalized = run(root, ["implement", "finalize"]);
    if (missingRequirement) {
      assert.notEqual(finalized.status, 0);
      assert.equal(readState(root).findings[0].status, "open");
    } else {
      ok(finalized);
      assert.equal(ok(run(root, ["implement", "status"])).detail.delivery.eligible, true);
    }
  }
});

test("only a human non-convergence declaration permits early blocked closure and never accepts the risk", () => {
  const root = makeProject({ profile: "high-risk" });
  start(root);
  const env = stub(root, REVIEW_PASS, riskResult());
  assert.notEqual(run(root, ["implement", "verify"], { env }).status, 0);
  const id = readState(root).riskFindings[0].id;
  const declaration = ["implement", "risk", "--non-convergent", "--id", id, "--approval", "I approve stopping this unresolved run.", "--reason", "The prerequisite cannot be supplied in this environment."];
  assert.notEqual(run(root, [...declaration, "--issuer", "implementor"]).status, 0);
  assert.notEqual(run(root, [...declaration, "--issuer", "observer"]).status, 0);
  assert.notEqual(run(root, ["implement", "finalize", "--status", "blocked"]).status, 0);
  ok(run(root, [...declaration, "--issuer", "human"]));
  assert.notEqual(run(root, ["implement", "finalize"]).status, 0);
  ok(run(root, ["implement", "finalize", "--status", "blocked"]));
  const state = readState(root);
  assert.equal(state.riskFindings[0].status, "open");
  assert.equal(state.riskFindings[0].nonConvergence.approval, "I approve stopping this unresolved run.");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, state.completion.receiptPath), "utf8")).delivery.eligible, false);
});
