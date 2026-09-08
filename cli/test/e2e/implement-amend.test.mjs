import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { PRD_PATH, REVIEW_PASS, makeProject, readState, run, start, stub, ok } from "../helpers/implement-fixture.mjs";

function amend(root, issuer = "human", extra = []) {
  return run(root, ["implement", "amend", "--issuer", issuer, "--approval", "I approve this changed requirement and review profile.", "--reason", "Approved contract correction", ...extra]);
}

test("only a human amendment reseals the full PRD and refreshes mirrored execution metadata", () => {
  const root = makeProject();
  start(root);
  const env = stub(root);
  ok(run(root, ["implement", "verify"], { env }));
  const before = readState(root);
  const oldText = fs.readFileSync(path.join(root, PRD_PATH), "utf8");
  const newText = oldText.replace('review_profile: "standard"', 'review_profile: "high-risk"').replace('review_rationale: "CLI regression fixture"', 'review_rationale: "Newly approved data risk"').replace("Requirement 1: the public command preserves value 1.", "The corrected public command preserves value 1 and its label.");
  fs.writeFileSync(path.join(root, PRD_PATH), newText);
  assert.notEqual(amend(root, "implementor").status, 0);
  assert.notEqual(amend(root, "observer").status, 0);
  assert.equal(readState(root).prd.sha256, before.prd.sha256);
  ok(amend(root));
  const after = readState(root);
  assert.equal(after.prd.reviewProfile, "high-risk");
  assert.equal(after.prd.reviewRationale, "Newly approved data risk");
  assert.notEqual(after.prd.sha256, before.prd.sha256);
  assert.match(after.requirements[0].behavior, /corrected public command/);
  assert.equal(fs.readFileSync(path.join(root, after.prd.snapshotPath), "utf8"), newText);
  assert.equal(fs.readFileSync(path.join(root, after.amendments[0].previousSnapshotPath), "utf8"), oldText);
  assert.notEqual(run(root, ["implement", "finalize"]).status, 0, "a previous whole review cannot be reused on an amended contract");
  const risk = { verdict: "PASS", findings: [], priorDispositions: [] };
  ok(run(root, ["implement", "verify"], { env: stub(root, REVIEW_PASS, risk) }));
  ok(run(root, ["implement", "finalize"]));
});

test("the sealed suite survives config weakening and exclusion requires approval while retaining its failed result", () => {
  const root = makeProject({ testExit: 9 });
  fs.writeFileSync(path.join(root, "agents/config.json"), JSON.stringify({ verify: { commands: { test: "npm test" } } }));
  start(root);
  const original = readState(root).suite.commands;
  fs.writeFileSync(path.join(root, "agents/config.json"), JSON.stringify({ verify: { commands: { test: "node --version" } } }));
  assert.notEqual(run(root, ["implement", "verify"], { env: stub(root) }).status, 0);
  const before = readState(root);
  assert.deepEqual(before.suite.commands, original);
  assert.equal(before.suite.results[0].status, "RED");
  assert.notEqual(run(root, ["implement", "amend", "--issuer", "human", "--exclude-suite", "S1", "--reason", "Invalid command"]).status, 0);
  assert.notEqual(amend(root, "observer", ["--exclude-suite", "S1"]).status, 0);
  ok(amend(root, "human", ["--exclude-suite", "S1"]));
  const after = readState(root);
  assert.equal(after.suite.exclusions.length, 1);
  assert.equal(after.suite.exclusions[0].approval, "I approve this changed requirement and review profile.");
  assert.deepEqual(after.suite.results, before.suite.results, "excluding never deletes actual execution history");
  ok(run(root, ["implement", "verify"], { env: stub(root) }));
  assert.equal(readState(root).verificationAttempts.at(-1).mechanical.length, 0);
  ok(run(root, ["implement", "finalize"]));
});
