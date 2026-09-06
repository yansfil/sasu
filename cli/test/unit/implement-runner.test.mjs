import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { planRunUnits, runBatch } from "../../dist/implement/runner.js";

const suiteCommand = (id, command, cwd) => ({ id, command, argv: command.split(" "), cwd });

const stateWith = (root, commands) => ({
  schema: "sasu.implement.state.v8",
  status: "active",
  topicSlug: "fixture",
  projectRoot: root,
  runDir: "agents/runs/fixture",
  rows: [],
  suite: { sealedAt: "2026-08-29T00:00:00.000Z", commands, exclusions: [], results: [] },
  verificationAttempts: [],
});

const unit = (key, argv, suiteCommandId = key) => ({ command: key, argv, cwd: ".", suiteCommandId });

test("the verify batch is the sealed suite in sealed order, one unit per command", () => {
  const state = stateWith("/tmp/fixture", [
    suiteCommand("S1", "node --version", "."),
    suiteCommand("S2", "node --version", "cli"),
  ]);
  const units = planRunUnits(state);
  assert.deepEqual(units.map((entry) => [entry.suiteCommandId, entry.cwd]), [["S1", "."], ["S2", "cli"]]);
});

test("an excluded suite command is not planned", () => {
  const state = stateWith("/tmp/fixture", [suiteCommand("S1", "node --version", ".")]);
  state.suite.exclusions = [{ at: "x", commandId: "S1", approval: "user said drop it", reason: "flaky" }];
  assert.deepEqual(planRunUnits(state), []);
});

const scratchState = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-runner-"));
  fs.mkdirSync(path.join(root, "agents", "runs", "fixture"), { recursive: true });
  return { root, state: stateWith(root, []) };
};

test("one unit runs exactly once", () => {
  const { root, state } = scratchState();
  // Outside the judged tree on purpose: a counter written inside it would
  // trip the mutation guard and prove nothing about execution count.
  const counter = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sasu-runner-count-")), "runs.txt");
  const outcome = runBatch(state, root, [unit("S1", ["node", "-e", `require("fs").appendFileSync(${JSON.stringify(counter)}, "x")`])], 60_000);
  assert.equal(outcome.results.length, 1);
  assert.equal(outcome.results[0].outcome, "green");
  assert.equal(fs.readFileSync(counter, "utf8"), "x", "the command executed exactly once");
});

test("every result names the tree it was earned on, and a batch whose tree moved is reported", () => {
  const { root, state } = scratchState();
  fs.writeFileSync(path.join(root, "source.txt"), "before\n");
  const clean = runBatch(state, root, [unit("S1", ["node", "--version"])], 60_000);
  assert.equal(clean.treeMoved, null);
  assert.ok(clean.results[0].tree.product, "a pass must name its tree");

  const mutator = unit("S2", ["node", "-e", `require("fs").writeFileSync(${JSON.stringify(path.join(root, "source.txt"))}, "after\\n")`]);
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
  const built = runBatch(state, root, [unit("S1", ["node", "-e", write("target/release/lib.a")])], 60_000);
  assert.equal(built.results[0].outcome, "green");
  assert.equal(built.results[0].mutatedTree, false);
  assert.equal(built.treeMoved, null);

  const leaked = runBatch(state, root, [unit("S2", ["node", "-e", write("generated.txt")])], 60_000);
  assert.equal(leaked.results[0].outcome, "tree-moved");
  assert.equal(leaked.results[0].mutatedTree, true);
});

// The old suite loop stopped at the first failure, which is why a run could
// never honestly say "suites 3/3": it had not executed all three.
test("a failing unit does not stop the batch", () => {
  const { root, state } = scratchState();
  const outcome = runBatch(state, root, [
    unit("S1", ["node", "-e", "process.exit(3)"]),
    unit("S2", ["node", "--version"]),
  ], 60_000);
  assert.equal(outcome.results.length, 2);
  assert.equal(outcome.results[0].outcome, "failed");
  assert.equal(outcome.results[0].exitCode, 3);
  assert.equal(outcome.results[1].outcome, "green");
});
