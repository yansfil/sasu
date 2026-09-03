import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { planRunUnits, runBatch } from "../../dist/implement/runner.js";

const criterion = (id, command, cwd, overrides = {}) => ({
  id,
  text: id,
  title: id,
  requirements: [],
  acceptanceCriteria: [],
  status: "pending",
  evidence: [],
  judgment: "machine",
  evidenceDeclaration: null,
  check: {
    status: "pending",
    bindings: command === null ? [] : [{
      id: "B1",
      command,
      argv: command.split(" "),
      cwd,
      classification: "asset",
      boundAt: "2026-08-29T00:00:00.000Z",
      reason: null,
    }],
    attempts: [],
    consecutiveFailures: 0,
    decisionPoints: [],
    parks: [],
    ...overrides,
  },
});

const suiteCommand = (id, command, cwd, verificationIds = []) => ({
  id,
  command,
  argv: command.split(" "),
  cwd,
  verificationIds,
});

const stateWith = (root, criteria, commands) => ({
  schema: "sasu.implement.state.v7",
  status: "active",
  topicSlug: "fixture",
  projectRoot: root,
  runDir: "agents/runs/fixture",
  acceptanceCriteria: criteria,
  suite: { sealedAt: "2026-08-29T00:00:00.000Z", commands, exclusions: [], results: [] },
  verificationAttempts: [],
});

test("AC1: a command named by both an AC binding and the suite is one unit scored for both", () => {
  const state = stateWith("/tmp/fixture", [criterion("AC1", "node --version", ".")], [suiteCommand("S1", "node --version", ".", ["V1"])]);
  const units = planRunUnits(state);
  assert.equal(units.length, 1, "the shared (cwd, command) must collapse to a single unit");
  assert.deepEqual(units[0].criterionIds, ["AC1"]);
  assert.deepEqual(units[0].suiteCommandIds, ["S1"]);
  assert.deepEqual(units[0].verificationIds, ["V1"]);
});

test("AC1: the same command under a different cwd is a different unit", () => {
  const state = stateWith("/tmp/fixture", [criterion("AC1", "node --version", ".")], [suiteCommand("S1", "node --version", "cli")]);
  assert.equal(planRunUnits(state).length, 2);
});

test("planning skips parked criteria and criteria with no binding, but keeps their suite twin", () => {
  const parked = criterion("AC2", "node --version", ".", { status: "parked" });
  const state = stateWith("/tmp/fixture", [parked, criterion("AC3", null, ".")], [suiteCommand("S1", "node --version", ".")]);
  const units = planRunUnits(state);
  assert.equal(units.length, 1);
  assert.deepEqual(units[0].criterionIds, [], "a parked criterion is not being proved right now");
  assert.deepEqual(units[0].suiteCommandIds, ["S1"], "the suite entry still stands on its own account");
});

// A gate:human criterion must spend a fresh verbatim approval on every
// execution. Verify has none to spend, so folding it into the batch would
// either run it ungated or invent an approval.
test("planning excludes machine+gate:human criteria from the verify batch", () => {
  const gated = criterion("AC4", "node --version", ".");
  gated.judgment = "machine+gate:human";
  const state = stateWith("/tmp/fixture", [gated], []);
  assert.deepEqual(planRunUnits(state), []);
});

test("an excluded suite command is not planned", () => {
  const state = stateWith("/tmp/fixture", [], [suiteCommand("S1", "node --version", ".")]);
  state.suite.exclusions = [{ at: "x", commandId: "S1", approval: "user said drop it", reason: "flaky" }];
  assert.deepEqual(planRunUnits(state), []);
});

const scratchState = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-runner-"));
  fs.mkdirSync(path.join(root, "agents", "runs", "fixture"), { recursive: true });
  return { root, state: stateWith(root, [], []) };
};

test("AC1: one unit runs exactly once even though two destinations claim it", () => {
  const { root, state } = scratchState();
  // Outside the judged tree on purpose: a counter written inside it would
  // trip the mutation guard and prove nothing about execution count.
  const counter = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sasu-runner-count-")), "runs.txt");
  const unit = {
    key: "./count",
    command: "count",
    argv: ["node", "-e", `require("fs").appendFileSync(${JSON.stringify(counter)}, "x")`],
    cwd: ".",
    criterionIds: ["AC1", "AC2"],
    suiteCommandIds: ["S1"],
    verificationIds: ["V1"],
  };
  const outcome = runBatch(state, root, [unit], 60_000);
  assert.equal(outcome.results.length, 1);
  assert.equal(outcome.results[0].outcome, "green");
  assert.equal(fs.readFileSync(counter, "utf8"), "x", "the command executed exactly once");
});

test("AC2: every result names the tree it was earned on, and a batch whose tree moved is reported", () => {
  const { root, state } = scratchState();
  fs.writeFileSync(path.join(root, "source.txt"), "before\n");
  const quiet = { key: "a", command: "a", argv: ["node", "--version"], cwd: ".", criterionIds: [], suiteCommandIds: ["S1"], verificationIds: [] };
  const clean = runBatch(state, root, [quiet], 60_000);
  assert.equal(clean.treeMoved, null);
  assert.ok(clean.results[0].tree.product, "a pass must name its tree");

  const mutator = {
    key: "b",
    command: "b",
    argv: ["node", "-e", `require("fs").writeFileSync(${JSON.stringify(path.join(root, "source.txt"))}, "after\\n")`],
    cwd: ".",
    criterionIds: [],
    suiteCommandIds: ["S2"],
    verificationIds: [],
  };
  const moved = runBatch(state, root, [mutator], 60_000);
  assert.equal(moved.results[0].mutatedTree, true, "a command that rewrites judged source is rejected");
  assert.equal(moved.results[0].outcome, "tree-moved", "exit 0 does not save a command that moved the goalposts");
  assert.equal(moved.results[0].exitCode, 0, "the real exit code survives beside the verdict");
  assert.notEqual(moved.treeMoved, null, "the batch reports that it was not earned on one frozen tree");
});

// Judged source is what git lists. A build that writes into a gitignored
// directory has not moved the tree anyone judges; before this rule the
// readdir walk hashed a Rust target/ as source and every cargo build in a
// verify batch was scored as a moved tree (2026-09-02 herdr-ide).
test("a build writing into a gitignored directory is not a moved tree, an untracked file is", () => {
  const { root, state } = scratchState();
  fs.writeFileSync(path.join(root, ".gitignore"), "target/\n");
  fs.writeFileSync(path.join(root, "source.txt"), "source\n");
  for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "base"]]) {
    assert.equal(spawnSync("git", args, { cwd: root, encoding: "utf8" }).status, 0);
  }
  const write = (relative) => `require("fs").mkdirSync(require("path").dirname(${JSON.stringify(path.join(root, relative))}), {recursive:true}); require("fs").writeFileSync(${JSON.stringify(path.join(root, relative))}, "built\\n")`;
  const build = { key: "b", command: "b", argv: ["node", "-e", write("target/release/lib.a")], cwd: ".", criterionIds: ["AC1"], suiteCommandIds: [], verificationIds: [] };
  const built = runBatch(state, root, [build], 60_000);
  assert.equal(built.results[0].outcome, "green");
  assert.equal(built.results[0].mutatedTree, false);
  assert.equal(built.treeMoved, null);

  const leak = { key: "l", command: "l", argv: ["node", "-e", write("generated.txt")], cwd: ".", criterionIds: ["AC1"], suiteCommandIds: [], verificationIds: [] };
  const leaked = runBatch(state, root, [leak], 60_000);
  assert.equal(leaked.results[0].outcome, "tree-moved");
  assert.equal(leaked.results[0].mutatedTree, true);
});

// The old suite loop stopped at the first failure, which is why a run could
// never honestly say "suites 3/3": it had not executed all three.
test("a failing unit does not stop the batch", () => {
  const { root, state } = scratchState();
  const fail = { key: "f", command: "f", argv: ["node", "-e", "process.exit(3)"], cwd: ".", criterionIds: [], suiteCommandIds: ["S1"], verificationIds: [] };
  const pass = { key: "p", command: "p", argv: ["node", "--version"], cwd: ".", criterionIds: [], suiteCommandIds: ["S2"], verificationIds: [] };
  const outcome = runBatch(state, root, [fail, pass], 60_000);
  assert.equal(outcome.results.length, 2);
  assert.equal(outcome.results[0].outcome, "failed");
  assert.equal(outcome.results[0].exitCode, 3);
  assert.equal(outcome.results[1].outcome, "green");
});
