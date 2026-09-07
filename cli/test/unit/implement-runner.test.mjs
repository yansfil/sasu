import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { scratchDir } from "../scratch.mjs";

import { planRunUnits, runBatch } from "../../dist/implement/runner.js";
import { executeMechanicalArgv } from "../../dist/mechanical.js";

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
  const root = scratchDir("sasu-runner-");
  fs.mkdirSync(path.join(root, "agents", "runs", "fixture"), { recursive: true });
  return { root, state: stateWith(root, []) };
};

test("one unit runs exactly once", async () => {
  const { root, state } = scratchState();
  // Outside the judged tree on purpose: a counter written inside it would
  // trip the mutation guard and prove nothing about execution count.
  const counter = path.join(scratchDir("sasu-runner-count-"), "runs.txt");
  const outcome = await runBatch(state, root, [unit("S1", ["node", "-e", `require("fs").appendFileSync(${JSON.stringify(counter)}, "x")`])], 60_000);
  assert.equal(outcome.results.length, 1);
  assert.equal(outcome.results[0].outcome, "green");
  assert.equal(fs.readFileSync(counter, "utf8"), "x", "the command executed exactly once");
});

test("every result names the tree it was earned on, and a batch whose tree moved is reported", async () => {
  const { root, state } = scratchState();
  fs.writeFileSync(path.join(root, "source.txt"), "before\n");
  const clean = await runBatch(state, root, [unit("S1", ["node", "--version"])], 60_000);
  assert.equal(clean.treeMoved, null);
  assert.ok(clean.results[0].tree.product, "a pass must name its tree");

  const mutator = unit("S2", ["node", "-e", `require("fs").writeFileSync(${JSON.stringify(path.join(root, "source.txt"))}, "after\\n")`]);
  const moved = await runBatch(state, root, [mutator], 60_000);
  assert.equal(moved.results[0].mutatedTree, true, "a command that rewrites judged source is rejected");
  assert.equal(moved.results[0].outcome, "tree-moved", "exit 0 does not save a command that moved the goalposts");
  assert.equal(moved.results[0].exitCode, 0, "the real exit code survives beside the verdict");
  assert.notEqual(moved.treeMoved, null, "the batch reports that it was not earned on one frozen tree");
});

// Judged source is what git lists. A build that writes into a gitignored
// directory has not moved the tree anyone judges; before this rule the
// readdir walk hashed a Rust target/ as source and every cargo build in a
// verify batch was scored as a moved tree (2026-09-02 herdr-ide).
test("a build writing into a gitignored directory is not a moved tree, an untracked file is", async () => {
  const { root, state } = scratchState();
  fs.writeFileSync(path.join(root, ".gitignore"), "target/\n");
  fs.writeFileSync(path.join(root, "source.txt"), "source\n");
  for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "base"]]) {
    assert.equal(spawnSync("git", args, { cwd: root, encoding: "utf8" }).status, 0);
  }
  const write = (relative) => `require("fs").mkdirSync(require("path").dirname(${JSON.stringify(path.join(root, relative))}), {recursive:true}); require("fs").writeFileSync(${JSON.stringify(path.join(root, relative))}, "built\\n")`;
  const built = await runBatch(state, root, [unit("S1", ["node", "-e", write("target/release/lib.a")])], 60_000);
  assert.equal(built.results[0].outcome, "green");
  assert.equal(built.results[0].mutatedTree, false);
  assert.equal(built.treeMoved, null);

  const leaked = await runBatch(state, root, [unit("S2", ["node", "-e", write("generated.txt")])], 60_000);
  assert.equal(leaked.results[0].outcome, "tree-moved");
  assert.equal(leaked.results[0].mutatedTree, true);
});

// The old suite loop stopped at the first failure, which is why a run could
// never honestly say "suites 3/3": it had not executed all three.
test("a failing unit does not stop the batch", async () => {
  const { root, state } = scratchState();
  const outcome = await runBatch(state, root, [
    unit("S1", ["node", "-e", "process.exit(3)"]),
    unit("S2", ["node", "--version"]),
  ], 60_000);
  assert.equal(outcome.results.length, 2);
  assert.equal(outcome.results[0].outcome, "failed");
  assert.equal(outcome.results[0].exitCode, 3);
  assert.equal(outcome.results[1].outcome, "green");
});

test("the registered command identity names the executing process and is gone before completion returns", async () => {
  const { root } = scratchState();
  let registeredPid;
  const result = await executeMechanicalArgv(root, [process.execPath, "-e", "console.log(process.pid)"], ".", 5000, {}, (pid) => {
    registeredPid = pid;
    process.kill(pid, 0);
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(Number(result.stdout.trim()), registeredPid);
  assert.throws(() => process.kill(registeredPid, 0), { code: "ESRCH" });
});

test("failed process registration rejects only after terminating the unregistered command", async () => {
  const { root } = scratchState();
  let registeredPid;
  const rejected = new Error("the active process record could not be persisted");
  await assert.rejects(() => executeMechanicalArgv(root, [process.execPath, "-e", "setInterval(() => {}, 1000)"], ".", 5000, {}, (pid) => {
    registeredPid = pid;
    throw rejected;
  }), rejected);
  assert.ok(Number.isInteger(registeredPid));
  assert.throws(() => process.kill(registeredPid, 0), { code: "ESRCH" });
});

test("a timed-out command that ignores SIGTERM is killed and reported as timeout 124", {
  skip: process.platform === "win32" ? "POSIX signal handling" : false,
  timeout: 10000,
}, async () => {
  const { root } = scratchState();
  let registeredPid;
  const source = "process.on('SIGTERM', () => console.log('term-ignored')); setInterval(() => {}, 1000); console.log('ready');";
  const result = await executeMechanicalArgv(root, [process.execPath, "-e", source], ".", 2000, {}, (pid) => { registeredPid = pid; });
  assert.match(result.stdout, /ready/);
  assert.match(result.stdout, /term-ignored/, "the child handled SIGTERM before escalation");
  assert.equal(result.exitCode, 124);
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, "SIGKILL");
  assert.throws(() => process.kill(registeredPid, 0), { code: "ESRCH" });
});

test("a completed leader terminates its pipe-inheriting helper without waiting for the command timeout", {
  skip: process.platform === "win32" ? "POSIX process groups" : false,
  timeout: 10000,
}, async (t) => {
  const { root } = scratchState();
  let groupPid;
  t.after(() => {
    if (groupPid === undefined) return;
    try { process.kill(-groupPid, "SIGKILL"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  });
  // IPC is the readiness handshake: the leader exits only after its helper
  // is alive and holding inherited pipes, without assuming a startup delay.
  const helper = "process.send(process.pid); setInterval(() => {}, 1000);";
  const leader = `
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', ${JSON.stringify(helper)}], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
child.once('message', (pid) => { console.log('helper:' + pid); process.exit(0); });
`;
  const result = await executeMechanicalArgv(root, [process.execPath, "-e", leader], ".", 5000, {}, (pid) => { groupPid = pid; });
  const helperPid = Number(result.stdout.match(/helper:(\d+)/)?.[1]);
  assert.ok(Number.isInteger(helperPid), result.stdout);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.timedOut, false, "the leader's exit, not the command timeout, triggers helper cleanup");
  assert.throws(() => process.kill(helperPid, 0), { code: "ESRCH" });
  assert.throws(() => process.kill(-groupPid, 0), { code: "ESRCH" });
});
