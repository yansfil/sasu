import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { scratchDir } from "../scratch.mjs";
import { stateFixture, humanFinding, AT } from "../helpers/implement-state.mjs";
import { prd } from "../helpers/implement-fixture.mjs";
import { applyAmendment, planAmendment, sealRequirement } from "../../dist/implement/amend.js";
import { parseImplementContract } from "../../dist/implement/contract.js";
import { sha256, persistState, persistClose, loadState } from "../../dist/implement/store.js";

const APPROVAL = "TEST-FIXTURE-APPROVAL: approved contract change";
function fixture(t, text = prd()) {
  const root = scratchDir("sasu-amend-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = stateFixture(root);
  const pinned = path.join(root, state.prd.snapshotPath);
  fs.mkdirSync(path.dirname(pinned), { recursive: true }); fs.writeFileSync(pinned, text);
  state.requirements = parseImplementContract(text).rows.map(sealRequirement);
  state.prd.sha256 = sha256(text);
  const statePath = path.join(root, "agents/runs/fixture/state.json");
  persistState(statePath, state);
  return { root, state, statePath, text, pinned };
}
const input = (text, extra = {}) => ({ issuer: "human", approval: APPROVAL, reason: "TEST-FIXTURE: change the approved contract", text, ...extra });

test("every PRD amendment and suite exclusion is human-only", (t) => {
  const f = fixture(t);
  for (const issuer of ["implementor", "observer"]) assert.throws(() => applyAmendment(f.root, f.state, input(prd({ count: 3 }), { issuer }), AT), /human-only/);
  assert.throws(() => applyAmendment(f.root, f.state, input(prd({ count: 3 }), { approval: "" }), AT), /approval/);
  assert.equal(f.state.amendments.length, 0);
  assert.equal(fs.readFileSync(f.pinned, "utf8"), f.text);
});

test("amendment invalidates the whole contract and refreshes execution metadata together", (t) => {
  const f = fixture(t);
  const text = prd({ count: 3, profile: "high-risk", sourceIntake: "agents/interview/new/qa-log.md" });
  const outcome = applyAmendment(f.root, f.state, input(text), AT);
  assert.equal(f.state.prd.reviewProfile, "high-risk");
  assert.equal(f.state.prd.sourceIntake, "agents/interview/new/qa-log.md");
  assert.equal(f.state.prd.reviewRationale, "CLI regression fixture");
  assert.equal(f.state.prd.sha256, sha256(text));
  assert.deepEqual(outcome.record.addedRequirements, ["B3"]);
  assert.equal(fs.readFileSync(f.pinned, "utf8"), f.text, "snapshot cannot change before state CAS");
  persistClose(f.statePath, f.state, outcome.derived);
  const loaded = loadState(f.root, { slug: "fixture" }).state;
  assert.equal(loaded.requirements.length, 3);
  assert.equal(fs.readFileSync(path.join(f.root, outcome.record.previousSnapshotPath), "utf8"), f.text);
  assert.equal(fs.readFileSync(f.pinned, "utf8"), text);
});

test("removed human provenance is closed through explicit amendment history without erasing responses", (t) => {
  const quote = "The person confirms the visual result after implementation.";
  const f = fixture(t, prd({ risks: quote }));
  f.state.findings.push(humanFinding({ responses: [{ at: AT, response: "rejected", evidence: "TEST-FIXTURE: rejected visual result" }] }));
  const result = applyAmendment(f.root, f.state, input(prd({ risks: "No human review is deferred." })), AT);
  assert.deepEqual(result.record.closedHumanFindings, ["F1"]);
  assert.equal(f.state.findings[0].status, "amended");
  assert.equal(f.state.findings[0].history[0].amendmentId, result.record.id);
  assert.equal(f.state.findings[0].responses[0].response, "rejected");
});

test("suite exclusion keeps its observed failure and validates the complete exclusion request first", (t) => {
  const f = fixture(t);
  f.state.suite.commands = [{ id: "S1", command: "npm test", argv: ["npm", "test"], cwd: "." }];
  f.state.suite.results = [{ commandId: "S1", attemptId: "V1", status: "RED", exitCode: 1, mutatedTree: false, startedAt: AT, finishedAt: AT, durationMs: 1, logPath: "agents/fail.log" }];
  assert.throws(() => applyAmendment(f.root, f.state, input(f.text, { excludeSuite: ["S1", "S9"] }), AT), /unknown suite/);
  assert.equal(f.state.suite.exclusions.length, 0);
  const result = applyAmendment(f.root, f.state, input(f.text, { excludeSuite: ["S1"] }), AT);
  assert.equal(result.record.excludedSuiteCommands[0].priorResult, "RED");
  assert.equal(f.state.suite.results[0].status, "RED");
  assert.equal(f.state.suite.exclusions[0].approval, APPROVAL);
});

test("amendment planning is read-only and identifies actual static requirement changes", (t) => {
  const f = fixture(t);
  const before = JSON.stringify(f.state);
  const next = prd({ count: 1 }).replace("preserves value 1", "preserves a changed value");
  const plan = planAmendment(f.state, parseImplementContract(f.text), parseImplementContract(next));
  assert.deepEqual(plan.changedRequirements, ["B1"]);
  assert.deepEqual(plan.removedRequirements, ["B2"]);
  assert.equal(JSON.stringify(f.state), before);
});
