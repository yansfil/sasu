import assert from "node:assert/strict";
import test from "node:test";

import { activeSuiteCommands, excludeSuiteCommand, suiteCommandNamed, suiteScore } from "../../dist/implement/suite.js";

const stateWith = (commands, results = [], exclusions = []) => ({
  suite: { sealedAt: "2026-08-29T00:00:00.000Z", commands, exclusions, results },
});

const cmd = (id, command) => ({ id, command, argv: command.split(" "), cwd: ".",  });

test("AC6: excluding a sealed command without a verbatim human approval is refused", () => {
  const state = stateWith([cmd("S1", "npm test")]);
  assert.throws(
    () => excludeSuiteCommand(state, { commandId: "S1", approval: "  ", reason: "flaky" }, "2026-08-29T01:00:00.000Z"),
    /requires --approval/,
  );
  assert.throws(
    () => excludeSuiteCommand(state, { commandId: "S1", approval: "user: drop it", reason: "" }, "2026-08-29T01:00:00.000Z"),
    /requires --reason/,
  );
  assert.deepEqual(state.suite.exclusions, [], "a refused exclusion leaves no trace in the ledger");
});

test("AC6: an approved exclusion is appended to the history and takes the command out of the active list", () => {
  const state = stateWith([cmd("S1", "npm test"), cmd("S2", "npm run build")]);
  const exclusion = excludeSuiteCommand(state, { commandId: "S1", approval: "user 2026-08-29: drop the flaky one", reason: "flaky on CI" }, "2026-08-29T01:00:00.000Z");
  assert.equal(exclusion.approval, "user 2026-08-29: drop the flaky one");
  assert.equal(state.suite.exclusions.length, 1);
  assert.deepEqual(activeSuiteCommands(state).map((entry) => entry.id), ["S2"]);
  // Sealed commands are never deleted: the record must still show what the
  // run was originally sealed against.
  assert.equal(state.suite.commands.length, 2, "exclusion hides a command, it does not erase it");
});

test("AC6: excluding an unknown or already-excluded command is refused", () => {
  const state = stateWith([cmd("S1", "npm test")]);
  assert.throws(() => excludeSuiteCommand(state, { commandId: "S9", approval: "a", reason: "b" }, "t"), /unknown suite command: S9/);
  excludeSuiteCommand(state, { commandId: "S1", approval: "a", reason: "b" }, "t");
  assert.throws(() => excludeSuiteCommand(state, { commandId: "S1", approval: "a", reason: "b" }, "t"), /already excluded/);
  assert.equal(state.suite.exclusions.length, 1, "a refused repeat does not double the history");
});

test("the suite score counts the active list and names what is red", () => {
  const state = stateWith(
    [cmd("S1", "npm test"), cmd("S2", "npm run build"), cmd("S3", "npm run lint")],
    [
      { commandId: "S1", attemptId: "a", startedAt: "t", finishedAt: "t", durationMs: 1, exitCode: 0, status: "GREEN", logPath: "l" },
      { commandId: "S2", attemptId: "a", startedAt: "t", finishedAt: "t", durationMs: 1, exitCode: 1, status: "RED", logPath: "l" },
    ],
  );
  const score = suiteScore(state);
  assert.equal(score.total, 3);
  assert.equal(score.green, 1);
  assert.deepEqual(score.red, [{ commandId: "S2", command: "npm run build" }]);

  excludeSuiteCommand(state, { commandId: "S2", approval: "a", reason: "b" }, "t");
  const after = suiteScore(state);
  assert.equal(after.total, 2, "an excluded command leaves the denominator");
  assert.deepEqual(after.red, [], "and stops being counted red");
});
