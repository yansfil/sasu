import assert from "node:assert/strict";
import test from "node:test";

import { acceptanceScore, assetLabor, runScore, scoreLine, suiteAxis } from "../../dist/implement/score.js";
import { classifyBinding } from "../../dist/implement/checks.js";

const binding = (command, cwd = ".", classification = "asset") => ({
  id: "B1", command, argv: command.split(/\s+/), cwd, classification, boundAt: "t", reason: null,
});

const criterion = (id, judgment, over = {}) => ({
  id, text: id, title: id, requirements: [], acceptanceCriteria: [], status: "pending", evidence: [],
  judgment, evidenceDeclaration: null,
  check: { status: "pending", bindings: [], attempts: [], consecutiveFailures: 0, decisionPoints: [], parks: [], ...over },
});

const green = (id) => {
  const entry = criterion(id, "machine");
  entry.check.status = "green";
  entry.check.bindings.push(binding("node --test test/unit/a.test.mjs", "cli"));
  entry.check.attempts.push({
    id: "A1", bindingId: "B1", outcome: "green", exitCode: 0,
    timedOut: false, signal: null, startedAt: "t", finishedAt: "t", durationMs: 1,
  });
  return entry;
};

const parkedCriterion = (id, reason, parkedBy = "human") => {
  const entry = criterion(id, "machine");
  entry.check.status = "parked";
  entry.check.parks.push({ parkedAt: "t", parkedBy, approval: "", reason, evidence: null, resumedAt: null });
  return entry;
};

const stateWith = (criteria, suite = {}) => ({
  acceptanceCriteria: criteria,
  suite: { sealedAt: "t", commands: [], exclusions: [], results: [], ...suite },
});

// --- AC11: address-based classification -------------------------------------

test("AC11: a check pointed into the bookkeeping namespace is labor", () => {
  assert.equal(classifyBinding("node --test agents/runs/x/probe.mjs", ["node", "--test", "agents/runs/x/probe.mjs"], "."), "labor");
  assert.equal(classifyBinding("node --test probe.mjs", ["node", "--test", "probe.mjs"], "agents/runs/x"), "labor");
  assert.equal(classifyBinding("node --test ./agents/runs/x/probe.mjs", ["node", "--test", "./agents/runs/x/probe.mjs"], "."), "labor");
});

test("AC11: a check pointed at the product tree is an asset", () => {
  assert.equal(classifyBinding("node --test test/unit/a.test.mjs", ["node", "--test", "test/unit/a.test.mjs"], "cli"), "asset");
  assert.equal(classifyBinding("pytest tests/test_a.py", ["pytest", "tests/test_a.py"], "."), "asset");
  assert.equal(classifyBinding("node --test=test/a.mjs", ["node", "--test=test/a.mjs"], "."), "asset", "a path behind --flag= is still a path");
});

// The assumption PRD 10장 records: a command with no path argument is scored
// as labor even when it does check product output. This test states the
// misfiling openly rather than hiding it, so the revisit trigger has evidence
// to point at when someone meets it.
test("AC11 (assumption): a path-less command is labor, including one that really checks the product", () => {
  assert.equal(classifyBinding("npm test", ["npm", "test"], "."), "labor");
  assert.equal(classifyBinding("make check", ["make", "check"], "."), "labor");
  assert.equal(classifyBinding("node --version", ["node", "--version"], "."), "labor");
});

test("AC11: the measurement counts the latest binding per criterion, so a rebind is not two assets", () => {
  const rebound = green("AC1");
  rebound.check.bindings.push({ ...binding("node --test test/unit/b.test.mjs", "cli"), id: "B2" });
  const state = stateWith([rebound, green("AC2")]);
  const measured = assetLabor(state);
  assert.equal(measured.asset, 2);
  assert.equal(measured.labor, 0);
  assert.equal(measured.bindings.length, 2);
  assert.equal(measured.bindings[0].command, "node --test test/unit/b.test.mjs", "the binding the run ended with");
});

test("AC11: an unbound criterion contributes no measurement row", () => {
  assert.deepEqual(assetLabor(stateWith([criterion("AC1", "judged")])).bindings, []);
});

// --- AC10: the two axes -----------------------------------------------------

test("AC10: the AC axis counts proof by the authority that owns each criterion", () => {
  const judged = criterion("AC3", "judged");
  judged.status = "complete";
  const failedJudged = criterion("AC4", "judged");
  failedJudged.status = "blocked";
  const score = acceptanceScore(stateWith([green("AC1"), criterion("AC2", "machine"), judged, failedJudged]));
  assert.equal(score.passed, 2, "the green machine one and the complete judged one");
  assert.equal(score.total, 4);
  assert.deepEqual(score.unproven, ["AC2", "AC4"]);
});

test("AC10: parked criteria are counted apart from failures, with id and reason", () => {
  const score = acceptanceScore(stateWith([
    green("AC1"),
    parkedCriterion("AC7", "the upstream fixture is not built yet"),
    parkedCriterion("AC19", "flagged stuck by the harness", "observer"),
  ]));
  assert.equal(score.passed, 1);
  assert.equal(score.total, 3);
  assert.deepEqual(score.unproven, [], "set aside is not the same fact as tried and failed");
  assert.deepEqual(score.parked, [
    { id: "AC7", reason: "the upstream fixture is not built yet", parkedBy: "human" },
    { id: "AC19", reason: "flagged stuck by the harness", parkedBy: "observer" },
  ]);
});

test("AC10: the suite axis is independent and names what is red", () => {
  const state = stateWith([green("AC1")], {
    commands: [
      { id: "S1", command: "npm test", argv: ["npm", "test"], cwd: ".", verificationIds: ["V1"] },
      { id: "S2", command: "npm run lint", argv: ["npm", "run", "lint"], cwd: ".", verificationIds: ["V2"] },
    ],
    results: [
      { commandId: "S1", attemptId: "a", startedAt: "t", finishedAt: "t", durationMs: 1, exitCode: 0, status: "GREEN", logPath: "l", attributedCriteria: ["AC1"] },
      { commandId: "S2", attemptId: "a", startedAt: "t", finishedAt: "t", durationMs: 1, exitCode: 1, status: "RED", logPath: "l", attributedCriteria: [] },
    ],
  });
  const axis = suiteAxis(state);
  assert.equal(axis.green, 1);
  assert.equal(axis.total, 2);
  assert.deepEqual(axis.red, [{ commandId: "S2", command: "npm run lint", exitCode: 1, boundCriteria: [] }]);
  // Every criterion passes and the run is still not green: the axes are
  // independent because their failures are (R2).
  assert.equal(acceptanceScore(state).passed, 1);
  assert.equal(acceptanceScore(state).unproven.length, 0);
});

test("AC10: an excluded suite command leaves the active total and keeps its reason on record", () => {
  const state = stateWith([], {
    commands: [
      { id: "S1", command: "npm test", argv: ["npm", "test"], cwd: ".", verificationIds: [] },
      { id: "S2", command: "npm run flaky", argv: ["npm", "run", "flaky"], cwd: ".", verificationIds: [] },
    ],
    exclusions: [{ at: "t", commandId: "S2", approval: "TEST-FIXTURE-APPROVAL", reason: "owned by another team and red on main" }],
    results: [
      { commandId: "S1", attemptId: "a", startedAt: "t", finishedAt: "t", durationMs: 1, exitCode: 0, status: "GREEN", logPath: "l", attributedCriteria: [] },
    ],
  });
  const axis = suiteAxis(state);
  assert.equal(axis.total, 1, "an excluded command is not measured against");
  assert.equal(axis.green, 1);
  assert.deepEqual(axis.excluded, [{ commandId: "S2", reason: "owned by another team and red on main" }]);
});

// --- the line a person reads ------------------------------------------------

test("AC10: the score line carries both axes and every parked reason", () => {
  const line = scoreLine(runScore(stateWith([
    green("AC1"),
    parkedCriterion("AC7", "the upstream fixture is not built yet"),
  ], {
    commands: [{ id: "S1", command: "npm test", argv: ["npm", "test"], cwd: ".", verificationIds: [] }],
    results: [{ commandId: "S1", attemptId: "a", startedAt: "t", finishedAt: "t", durationMs: 1, exitCode: 1, status: "RED", logPath: "l", attributedCriteria: [] }],
  })));
  assert.match(line, /AC: 1\/2 PASS/);
  assert.match(line, /parked 1: AC7 the upstream fixture is not built yet/);
  assert.match(line, /suite: 0\/1 GREEN \(RED: S1\)/);
});

test("a clean run's line says so without inventing parentheses", () => {
  const line = scoreLine(runScore(stateWith([green("AC1")], {
    commands: [{ id: "S1", command: "npm test", argv: ["npm", "test"], cwd: ".", verificationIds: [] }],
    results: [{ commandId: "S1", attemptId: "a", startedAt: "t", finishedAt: "t", durationMs: 1, exitCode: 0, status: "GREEN", logPath: "l", attributedCriteria: [] }],
  })));
  assert.equal(line, "AC: 1/1 PASS | suite: 1/1 GREEN");
});
