import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { scratchDir } from "../scratch.mjs";
import { ClaudeBackend } from "../../dist/judge/backends.js";

function binaryFixture(t, program) {
  const root = scratchDir("sasu-judge-execution-");
  const previous = process.env.PATH;
  fs.writeFileSync(path.join(root, "claude"), `#!${process.execPath}\n${program}\n`, { mode: 0o755 });
  process.env.PATH = `${root}${path.delimiter}${previous}`;
  t.after(() => { process.env.PATH = previous; fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}
const absent = (pid) => assert.throws(() => process.kill(-pid, 0), (error) => error.code === "ESRCH");

test("a judge's returned result has no surviving owned process group", { skip: process.platform === "win32" }, async (t) => {
  binaryFixture(t, `process.stdin.resume(); process.stdin.on('end', () => { require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'}).unref(); console.log(JSON.stringify({result:'accepted', num_turns:1})); });`);
  let group;
  const result = await new ClaudeBackend().run("fixture prompt", { model: null, timeoutMs: 5000, execution: { prepare() {}, spawned(pid) { group = pid; process.kill(-pid, 0); }, settled() {} } });
  assert.equal(result.text, "accepted");
  assert.ok(group > 0);
  absent(group);
});

test("failed judge process registration rejects after its child group is killed", { skip: process.platform === "win32" }, async (t) => {
  binaryFixture(t, "setInterval(()=>{}, 1000);");
  let group;
  await assert.rejects(() => new ClaudeBackend().run("fixture prompt", { model: null, timeoutMs: 5000, execution: { prepare() {}, spawned(pid) { group = pid; throw new Error('registration failed'); }, settled() {} } }), /registration failed/);
  absent(group);
});

test("a timed-out judge that ignores SIGTERM is bounded and leaves no process group", { skip: process.platform === "win32" }, async (t) => {
  binaryFixture(t, "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);");
  let group;
  const started = Date.now();
  await assert.rejects(() => new ClaudeBackend().run("fixture prompt", { model: null, timeoutMs: 500, execution: { prepare() {}, spawned(pid) { group = pid; }, settled() {} } }), /timeout|timed out/);
  absent(group);
  assert.ok(Date.now() - started < 3000);
});

test("a signal permission race clears only after the judge group is confirmed absent", { skip: process.platform === "win32" }, async (t) => {
  binaryFixture(t, "process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({result:'accepted',num_turns:1}))); ");
  const kill = process.kill.bind(process);
  let group;
  let injected = false;
  let closed = false;
  t.mock.method(process, "kill", (pid, signal) => {
    if (pid === -group && signal === "SIGKILL") {
      injected = true;
      throw Object.assign(new Error("signal permission race"), { code: "EPERM" });
    }
    return kill(pid, signal);
  });
  const result = await new ClaudeBackend().run("fixture prompt", { model: null, timeoutMs: 5000, execution: {
    prepare() {}, spawned(pid) { group = pid; }, settled() { absent(group); closed = true; },
  } });
  assert.equal(result.text, "accepted");
  assert.equal(injected, true);
  assert.equal(closed, true);
});

test("an uninspectable judge group rejects cleanup and keeps its execution lease", { skip: process.platform === "win32" }, async (t) => {
  binaryFixture(t, "process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({result:'accepted',num_turns:1}))); ");
  const kill = process.kill.bind(process);
  let group;
  let closed = false;
  t.mock.method(process, "kill", (pid, signal) => {
    if (pid === -group) throw Object.assign(new Error("group permission denied"), { code: "EPERM" });
    return kill(pid, signal);
  });
  await assert.rejects(() => new ClaudeBackend().run("fixture prompt", { model: null, timeoutMs: 5000, execution: {
    prepare() {}, spawned(pid) { group = pid; }, settled() { closed = true; },
  } }), (error) => error.code === "EPERM");
  assert.equal(closed, false);
  assert.throws(() => kill(-group, 0), (error) => error.code === "ESRCH");
});
