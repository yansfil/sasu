import assert from "node:assert/strict";
import test from "node:test";

import { rowScore, runScore, scoreLine, suiteAxis } from "../../dist/implement/score.js";

const row = (id, check, overrides = {}) => ({
  id, behavior: id, check, decisionIds: [],
  status: check.kind === "human" ? "OPEN" : "pending",
  attempts: [], consecutiveFailures: 0, parks: [], verdict: null, human: null, rejections: [],
  ...overrides,
});
const check = (id, status = "pending") => row(id, { kind: "check", command: "npm test", argv: ["npm", "test"] }, { status });
const judge = (id, status = "pending") => row(id, { kind: "judge", evidence: "a capture" }, { status });
const human = (id, overrides = {}) => row(id, { kind: "human", confirmation: "the operator says so" }, overrides);
const parked = (id, reason) => row(id, { kind: "check", command: "npm test", argv: ["npm", "test"] }, {
  status: "parked",
  parks: [{ parkedAt: "t", approval: "TEST-FIXTURE-APPROVAL", reason, evidence: null, resumedAt: null }],
});

const result = (commandId, exitCode) => ({
  commandId, attemptId: "a", startedAt: "t", finishedAt: "t", durationMs: 1, exitCode, mutatedTree: false,
  status: exitCode === 0 ? "GREEN" : "RED", logPath: "l",
});
const command = (id, text) => ({ id, command: text, argv: text.split(" "), cwd: "." });

const stateWith = (rows, suite = {}) => ({
  rows,
  suite: { sealedAt: "t", commands: [], exclusions: [], results: [], ...suite },
});

// --- R7: three counts, not one number ---------------------------------------

test("machine and judge rows share one fraction; human rows are counted apart as OPEN or confirmed", () => {
  const score = rowScore(stateWith([
    check("B1", "green"),
    check("B2", "fail"),
    judge("B3", "PASS"),
    judge("B4", "FAIL"),
    human("B5"),
    human("B6", { status: "PASS", human: { confirmedAt: "t", evidence: "looks right" } }),
    human("B7", { rejections: [{ at: "t", evidence: "wrong colour" }] }),
  ]));
  assert.equal(score.passed, 2, "the green check row and the PASS judge row");
  assert.equal(score.total, 4, "human rows are not in the machine+judge denominator");
  assert.deepEqual(score.unproven, ["B2", "B4"]);
  assert.deepEqual(score.open, [{ id: "B5", rejected: null }, { id: "B7", rejected: "wrong colour" }]);
  assert.equal(score.confirmed, 1);
});

test("parked rows are counted apart from failures, with id and reason", () => {
  const score = rowScore(stateWith([
    check("B1", "green"),
    parked("B2", "the upstream fixture is not built yet"),
  ]));
  assert.equal(score.passed, 1);
  assert.equal(score.total, 2);
  assert.deepEqual(score.unproven, [], "set aside is not the same fact as tried and failed");
  assert.deepEqual(score.parked, [{ id: "B2", reason: "the upstream fixture is not built yet" }]);
});

test("the suite axis is independent and names what is red", () => {
  const state = stateWith([check("B1", "green")], {
    commands: [command("S1", "npm test"), command("S2", "npm run lint")],
    results: [result("S1", 0), result("S2", 1)],
  });
  const axis = suiteAxis(state);
  assert.equal(axis.green, 1);
  assert.equal(axis.total, 2);
  assert.deepEqual(axis.red, [{ commandId: "S2", command: "npm run lint", exitCode: 1 }]);
  // Every row passes and the run is still not green: the axes are
  // independent because their failures are.
  assert.equal(rowScore(state).unproven.length, 0);
});

test("an excluded suite command leaves the active total and keeps its reason on record", () => {
  const state = stateWith([], {
    commands: [command("S1", "npm test"), command("S2", "npm run flaky")],
    exclusions: [{ at: "t", commandId: "S2", approval: "TEST-FIXTURE-APPROVAL", reason: "owned by another team and red on main" }],
    results: [result("S1", 0)],
  });
  const axis = suiteAxis(state);
  assert.equal(axis.total, 1, "an excluded command is not measured against");
  assert.equal(axis.green, 1);
  assert.deepEqual(axis.excluded, [{ commandId: "S2", reason: "owned by another team and red on main" }]);
});

// --- the line a person reads ------------------------------------------------

test("the score line carries every axis, every parked reason, and the human count", () => {
  const line = scoreLine(runScore(stateWith([
    check("B1", "green"),
    parked("B2", "the upstream fixture is not built yet"),
    human("B3"),
  ], {
    commands: [command("S1", "npm test")],
    results: [result("S1", 1)],
  })));
  assert.match(line, /기계·판사: 1\/2 PASS/);
  assert.match(line, /parked 1: B2 the upstream fixture is not built yet/);
  assert.match(line, /human: 1 OPEN, 0 confirmed/);
  assert.match(line, /suite: 0\/1 GREEN \(RED: S1\)/);
});

test("a clean run's line says so without inventing parentheses or a human clause", () => {
  const line = scoreLine(runScore(stateWith([check("B1", "green")], {
    commands: [command("S1", "npm test")],
    results: [result("S1", 0)],
  })));
  assert.equal(line, "기계·판사: 1/1 PASS | suite: 1/1 GREEN");
});
