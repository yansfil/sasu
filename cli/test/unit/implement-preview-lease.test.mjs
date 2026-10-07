import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { scratchDir } from "../scratch.mjs";
import { stateFixture, attemptFixture, SHA } from "../helpers/implement-state.mjs";
import { loadState, parseImplementState, persistState } from "../../dist/implement/store.js";
import { beginPreview, beginVerification, finishPreview, finishVerification, progressVerification, recoverVerification } from "../../dist/implement/verification-activity.js";
import { recordVerb } from "../../dist/implement/verbs.js";

function fixture(t) {
  const root = scratchDir("sasu-preview-lease-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "agents/runs/fixture/state.json");
  persistState(file, stateFixture(root, { verificationAttempts: [attemptFixture()] }));
  const reload = () => loadState(root, { state: file }).state;
  return { root, file, reload, state: reload(), text: () => fs.readFileSync(file, "utf8") };
}

test("preview lease has no attempt identity and restores original serialization", (t) => {
  const f = fixture(t);
  const original = JSON.stringify(f.state).replaceAll(",", ", ") + "\r\n";
  fs.writeFileSync(f.file, original);
  const state = f.reload();
  beginPreview(f.file, state, SHA);
  assert.equal(f.reload().activeVerification.mode, "preview");
  assert.equal(f.reload().activeVerification.attemptId, undefined);
  assert.equal(f.reload().updatedAt, state.updatedAt);
  assert.deepEqual(f.reload().verificationAttempts, [attemptFixture()]);
  finishPreview(f.file, state, original);
  assert.equal(f.text(), original);
});

test("preview cannot mutate domain fields, publish records, or start real verification", (t) => {
  const f = fixture(t);
  const original = f.text();
  beginPreview(f.file, f.state, SHA);
  const held = f.text();
  assert.throws(() => beginVerification(f.file, f.reload(), attemptFixture({ id: "V2" })), /verification still active/);
  assert.throws(() => finishVerification(f.file, f.state), /preview cannot complete/);
  assert.throws(() => progressVerification(f.file, f.state, (state) => { state.deviations.push({ at: state.updatedAt, type: "unexpected", summary: "must refuse" }); }), /preview may only change/);
  assert.throws(() => progressVerification(f.file, f.state, () => {}, () => [{ file: path.join(f.root, "report.md"), text: "forbidden" }]), /preview cannot publish/);
  assert.throws(() => progressVerification(f.file, f.state, (state) => { state.activeVerification.mode = "verify"; state.activeVerification.attemptId = "V1"; }), /preview may only change/);
  assert.equal(f.text(), held);
  assert.equal(fs.existsSync(path.join(f.root, "report.md")), false);
  finishPreview(f.file, f.state, original);
});

test("dead preview recovery terminates its group and releases only after absence is inspectable", { timeout: 5000 }, async (t) => {
  const f = fixture(t);
  beginPreview(f.file, f.state, SHA);
  const exited = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  assert.equal(exited.status, 0);
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); process.send('ready');"], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const done = new Promise((resolve) => child.on("close", resolve));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await done; });
  await new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); });
  const active = f.reload();
  active.activeVerification.pid = exited.pid;
  active.activeVerification.executionPids = [child.pid];
  fs.writeFileSync(f.file, JSON.stringify(active));
  const held = f.text();
  let uninspectable = false;
  try { await recoverVerification(f.file, f.reload()); }
  catch (error) {
    assert.equal(error.code, "EPERM");
    assert.equal(f.text(), held, "an uninspectable group must retain the complete lease and record");
    uninspectable = true;
  }
  // macOS kill(-pgid, 0) can return EPERM for our own zombie before libuv
  // reaps it (measured 2026-10-07). That is an unavailable observation, not
  // absence. A fresh recovery is allowed once the owned close event and an
  // actual ESRCH prove the lifecycle transition, never after a timed retry.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("registered child survived recovery")), 3000);
    done.then(() => { clearTimeout(timer); resolve(); }, reject);
  });
  assert.equal(child.signalCode, "SIGKILL", "the ready child ignores TERM, so recovery must escalate");
  assert.throws(() => process.kill(-child.pid, 0), { code: "ESRCH" });
  if (uninspectable) await recoverVerification(f.file, f.reload());
  assert.equal(f.reload().activeVerification, undefined);
  assert.deepEqual(f.reload().verificationAttempts, [attemptFixture()]);
  assert.deepEqual(f.reload().deviations, []);
});

test("an OS permission failure cannot clear a preview execution lease", async (t) => {
  const f = fixture(t);
  beginPreview(f.file, f.state, SHA);
  const exited = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  assert.equal(exited.status, 0);
  const active = f.reload();
  active.activeVerification.pid = exited.pid;
  // The negative PID names a group probe only. No signal reaches this PID.
  active.activeVerification.executionPids = [exited.pid];
  fs.writeFileSync(f.file, JSON.stringify(active));
  const held = f.text();
  const kill = process.kill;
  // Sanctioned OS boundary fault, with every other syscall delegated intact.
  process.kill = function (pid, signal) {
    if (pid === -exited.pid && signal === 0) throw Object.assign(new Error("permission denied"), { code: "EPERM" });
    return kill.call(process, pid, signal);
  };
  try {
    await assert.rejects(recoverVerification(f.file, f.reload()), { code: "EPERM" });
    assert.equal(f.text(), held);
  } finally { process.kill = kill; }
});

test("preview close preserves another command's recorded refusal", (t) => {
  const f = fixture(t);
  const original = f.text();
  beginPreview(f.file, f.state, SHA);
  const other = f.reload();
  recordVerb(other, { at: other.updatedAt, verb: "retire", issuer: "human", target: null, reason: "busy", outcome: "rejected", rejection: { check: "transition", message: "preview owns execution" } });
  persistState(f.file, other, { refusalOnly: true });
  const expected = f.reload();
  delete expected.activeVerification;
  finishPreview(f.file, f.state, original);
  assert.deepEqual(f.reload(), expected);
});

test("preview parser rejects an attempt identity and unknown execution modes", (t) => {
  const f = fixture(t);
  beginPreview(f.file, f.state, SHA);
  const held = f.reload();
  assert.throws(() => parseImplementState(JSON.stringify({ ...held, activeVerification: { ...held.activeVerification, attemptId: "V1" } })), /preview cannot name/);
  assert.throws(() => parseImplementState(JSON.stringify({ ...held, activeVerification: { ...held.activeVerification, mode: "diagnostic" } })), /activeVerification.mode/);
  assert.throws(() => parseImplementState(JSON.stringify({ ...held, activeVerification: { ...held.activeVerification, mode: "verify" } })), /attemptId/);
});

test("dead preview cleanup records no attempt or deviation and retains uncertain leases", async (t) => {
  const f = fixture(t);
  const expected = f.reload();
  const original = JSON.stringify(expected, null, 1).replaceAll("\n", "\r\n") + "\r\n";
  fs.writeFileSync(f.file, original);
  beginPreview(f.file, f.reload(), SHA);
  const exited = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  assert.equal(exited.status, 0);
  const active = f.reload();
  active.activeVerification.pid = exited.pid;
  // Emulate an abrupt owner exit on disk, never a live operator process.
  fs.writeFileSync(f.file, JSON.stringify(active, null, 1).replaceAll("\n", "\r\n") + "\r\n");
  const recovered = await recoverVerification(f.file, f.reload());
  assert.equal(recovered.activeVerification, undefined);
  assert.deepEqual(f.reload(), expected, "abrupt recovery preserves every domain field, timestamp and history entry");
  // Formatting may normalize after a crash; only domain identity is promised.
  beginPreview(f.file, f.reload(), SHA);
  const uncertain = f.reload();
  uncertain.activeVerification.pid = exited.pid;
  uncertain.activeVerification.pendingSpawns = 1;
  fs.writeFileSync(f.file, JSON.stringify(uncertain));
  const held = f.text();
  await assert.rejects(recoverVerification(f.file, f.reload()), /registration is uncertain/);
  assert.equal(f.text(), held);
  uncertain.activeVerification.pendingSpawns = 0;
  uncertain.activeVerification.hostname = os.hostname() + "-foreign";
  fs.writeFileSync(f.file, JSON.stringify(uncertain));
  const foreign = f.text();
  await assert.rejects(recoverVerification(f.file, f.reload()), /uninspectable on/);
  assert.equal(f.text(), foreign);
});
