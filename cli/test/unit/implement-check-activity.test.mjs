import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { scratchDir } from "../scratch.mjs";
import { assertNoActiveCheck, beginCheck, finishCheck, recordCheckExecution } from "../../dist/implement/check-activity.js";
import { loadState, persistState } from "../../dist/implement/store.js";

function fixture(t) {
  const root = scratchDir("sasu-check-activity-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const statePath = path.join(root, "agents/runs/fixture/state.json");
  const state = {
    schema: "sasu.implement.state.v8", status: "active", topicSlug: "fixture",
    projectRoot: root, worktree: null, runDir: "agents/runs/fixture",
    prdPath: "agents/prd/fixture/prd.md",
    prd: { sha256: "pinned-prd", snapshotPath: "agents/runs/fixture/prd.md", reviewProfile: "standard" },
    initialSource: { head: null, digest: "source", entries: [] },
    baselineAttribution: { disposition: "clean", paths: [], baselineDigest: "source", head: null },
    rows: [{
      id: "B1", behavior: "the runner runs once",
      check: { kind: "check", command: "npm test", argv: ["npm", "test"] },
      decisionIds: [], status: "pending", attempts: [], consecutiveFailures: 0,
      parks: [], verdict: null, human: null, rejections: [],
    }],
    deviations: [], artifacts: [], verificationAttempts: [], riskFindings: [],
    events: [], verbs: [], amendments: [], evidenceReplacements: [],
    suite: { sealedAt: "2026-09-07T00:00:00.000Z", commands: [], exclusions: [], results: [] },
    qaBriefs: [], trails: [], escalations: [], retirement: null, completion: null,
  };
  persistState(statePath, state);
  return { root, statePath, state, reload: () => loadState(root, { slug: "fixture" }).state };
}

test("historical failures do not block correction; a real executing process does", (t) => {
  assert.doesNotThrow(() => assertNoActiveCheck({ rows: [{ status: "fail" }], deviations: [] }));
  const f = fixture(t);
  beginCheck(f.statePath, f.state, "B1");
  assert.throws(() => assertNoActiveCheck(f.reload()), /check still active: B1/);
  assert.throws(() => beginCheck(f.statePath, f.reload(), "B1"), /check still active/);
  finishCheck(f.statePath, f.state);
  assert.doesNotThrow(() => assertNoActiveCheck(f.reload()));
});

test("only a demonstrably dead local command group is recovered and its interruption is recorded", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t);
  beginCheck(f.statePath, f.state, "B1");
  const finished = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8", detached: true });
  assert.equal(finished.status, 0);
  f.state.activeCheck.pid = finished.pid;
  f.state.activeCheck.executionPid = finished.pid;
  assertNoActiveCheck(f.state);
  persistState(f.statePath, f.state);
  assert.equal(f.reload().activeCheck, undefined);
  assert.equal(f.reload().deviations.at(-1).type, "interrupted-check");

  beginCheck(f.statePath, f.state, "B1");
  f.state.activeCheck.hostname = `${os.hostname()}-another-host`;
  assert.throws(() => assertNoActiveCheck(f.state), /active or uninspectable/);
  assert.ok(f.state.activeCheck, "unknown remote activity is retained");
});

test("a dead owner with no recorded command group cannot be assumed safe", (t) => {
  const f = fixture(t);
  beginCheck(f.statePath, f.state, "B1");
  const finished = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  assert.equal(finished.status, 0);
  f.state.activeCheck.pid = finished.pid;
  assert.throws(() => assertNoActiveCheck(f.state), /active or uninspectable/);
  assert.ok(f.state.activeCheck);
  assert.deepEqual(f.state.deviations, []);
});

test("a command group surviving its owner prevents amendment until it exits", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  beginCheck(f.statePath, f.state, "B1");
  const command = spawn(process.execPath, ["-e", "process.stdin.resume()"], { detached: true, stdio: ["pipe", "ignore", "ignore"] });
  t.after(() => { if (command.exitCode === null) command.kill(); });
  await once(command, "spawn");
  const exited = once(command, "exit");
  const owner = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  assert.equal(owner.status, 0);
  recordCheckExecution(f.statePath, f.state, command.pid);
  f.state.activeCheck.pid = owner.pid;
  assert.throws(() => assertNoActiveCheck(f.state), /command process group .* survives its owner/);
  command.stdin.end();
  await exited;
  assertNoActiveCheck(f.state);
  assert.equal(f.state.activeCheck, undefined);
  assert.equal(f.state.deviations.at(-1).type, "interrupted-check");
});

test("finishing preserves concurrent ledger writes and clears only its own activity", (t) => {
  const f = fixture(t);
  beginCheck(f.statePath, f.state, "B1");
  const concurrent = f.reload();
  concurrent.deviations.push({ at: new Date().toISOString(), type: "fixture", summary: "concurrent note" });
  persistState(f.statePath, concurrent);
  const finished = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8", detached: true });
  assert.equal(finished.status, 0);
  recordCheckExecution(f.statePath, f.state, finished.pid);
  assert.equal(f.reload().activeCheck.executionPid, finished.pid);
  assert.equal(f.state.activeCheck.executionPid, finished.pid);
  finishCheck(f.statePath, f.state, (fresh) => {
    fresh.deviations.push({ at: new Date().toISOString(), type: "result", summary: "result accepted" });
  });
  assert.deepEqual(f.reload().deviations.map((item) => item.type), ["fixture", "result"]);
  assert.equal(f.reload().activeCheck, undefined);
});

test("finishing refuses both cleanup and results while the command group remains alive", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  beginCheck(f.statePath, f.state, "B1");
  const command = spawn(process.execPath, ["-e", "process.stdin.resume()"], { detached: true, stdio: ["pipe", "ignore", "ignore"] });
  t.after(() => { if (command.exitCode === null) command.kill(); });
  await once(command, "spawn");
  const exited = once(command, "exit");
  recordCheckExecution(f.statePath, f.state, command.pid);
  const before = fs.readFileSync(f.statePath, "utf8");
  assert.throws(() => finishCheck(f.statePath, f.state), /process group .* is still active/);
  assert.throws(() => finishCheck(f.statePath, f.state, () => assert.fail("live result accepted")), /process group .* is still active/);
  assert.equal(fs.readFileSync(f.statePath, "utf8"), before);
  command.stdin.end();
  await exited;
  finishCheck(f.statePath, f.state);
  assert.equal(f.reload().activeCheck, undefined);
});

test("a result cannot replace a changed row or a changed PRD", (t) => {
  for (const change of [
    (state) => { state.prd.sha256 = "amended-prd"; },
    (state) => { state.rows[0].behavior = "changed behavior"; },
  ]) {
    const f = fixture(t);
    beginCheck(f.statePath, f.state, "B1");
    const concurrent = f.reload();
    change(concurrent);
    persistState(f.statePath, concurrent);
    assert.throws(() => finishCheck(f.statePath, f.state, () => assert.fail("obsolete result accepted")), /changed during execution/);
    assert.equal(f.reload().activeCheck, undefined);
  }
});

test("a result callback failure clears activity without persisting a partial result", (t) => {
  const f = fixture(t);
  beginCheck(f.statePath, f.state, "B1");
  assert.throws(() => finishCheck(f.statePath, f.state, (fresh) => {
    fresh.rows[0].behavior = "partial mutation";
    throw new Error("fixture failure");
  }), /fixture failure/);
  assert.equal(f.reload().rows[0].behavior, "the runner runs once");
  assert.equal(f.reload().activeCheck, undefined);
});
