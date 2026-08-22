import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const helper = path.join(repoRoot, "skills", "implement", "scripts", "herdr_observer.js");
const HANDOFF = "ROLE: Implementor\nPIPELINE: please\nORIGINAL INVOCATION: $please test";

function fakeHerdrRoot(role) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-herdr-observer-"));
  const bin = path.join(root, "bin");
  const calls = path.join(root, "calls.jsonl");
  fs.mkdirSync(bin);
  const executable = path.join(bin, "herdr");
  fs.writeFileSync(executable, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_HERDR_CALLS, JSON.stringify(args) + "\\n");
const key = args.slice(0, 2).join(" ");
if (key === "pane current") {
  console.log(JSON.stringify({ result: { pane: { pane_id: "w1:p1", agent: "codex" } } }));
} else if (key === "pane split") {
  console.log(JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } }));
} else if (key === "agent start") {
  const busyStarts = Number(process.env.FAKE_HERDR_BUSY_STARTS || 0);
  const startAttempts = fs.readFileSync(process.env.FAKE_HERDR_CALLS, "utf8")
    .trim()
    .split("\\n")
    .map(line => JSON.parse(line))
    .filter(call => call[0] === "agent" && call[1] === "start")
    .length;
  if (startAttempts <= busyStarts) {
    console.error(JSON.stringify({ error: { code: "agent_pane_busy", message: "shell is still starting" } }));
    process.exit(1);
  }
  console.log(JSON.stringify({ result: { ok: true } }));
} else if (key === "agent list") {
  console.log(JSON.stringify({ result: { agents: [{
    name: "please-smoke",
    agent: "codex",
    agent_status: process.env.FAKE_HERDR_AGENT_STATUS || "done",
    pane_id: "w1:p2",
    cwd: process.cwd(),
    interactive_ready: true
  }] } }));
} else {
  console.log(JSON.stringify({ result: { ok: true } }));
}
`);
  fs.chmodSync(executable, 0o755);
  return { root, bin, calls, role };
}

function runHelper(fixture, args, extraEnv = {}, input = HANDOFF) {
  return spawnSync(process.execPath, [helper, ...args], {
    cwd: fixture.root,
    encoding: "utf8",
    input,
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH}`,
      HERDR_ENV: "1",
      SASU_HERDR_ROLE: fixture.role === "implementor" ? "implementor" : "",
      FAKE_HERDR_CALLS: fixture.calls,
      ...extraEnv,
    },
  });
}

function calls(fixture) {
  if (!fs.existsSync(fixture.calls)) return [];
  return fs.readFileSync(fixture.calls, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

test("dispatch creates one right-side marked Implementor with the Observer agent kind", () => {
  const fixture = fakeHerdrRoot("observer");
  const result = runHelper(fixture, ["dispatch", "--name", "please-smoke", "--cwd", fixture.root]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    mode: "observer",
    implementor: {
      name: "please-smoke",
      paneId: "w1:p2",
      agentKind: "codex",
      cwd: fixture.root,
      handoffSubmitted: true,
    },
  });
  const observedCalls = calls(fixture);
  assert.deepEqual(observedCalls.slice(0, 3), [
    ["pane", "current", "--current"],
    ["pane", "split", "--current", "--direction", "right", "--cwd", fixture.root, "--env", "SASU_HERDR_ROLE=implementor", "--no-focus"],
    ["agent", "start", "please-smoke", "--kind", "codex", "--pane", "w1:p2"],
  ]);
  assert.deepEqual(observedCalls[3].slice(0, 3), ["agent", "prompt", "please-smoke"]);
  assert.ok(observedCalls[3][3].startsWith(HANDOFF));
  assert.match(observedCalls[3][3], /Never invoke AskUserQuestion, request_user_input, or any interactive question UI/);
  assert.match(observedCalls[3][3], /output the structured OBSERVER_BLOCK packet.*end the turn/s);
});

test("dispatch refuses recursion from a marked Implementor pane", () => {
  const fixture = fakeHerdrRoot("implementor");
  const result = runHelper(fixture, ["dispatch", "--name", "nested"]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /recursive dispatch refused/);
  assert.deepEqual(calls(fixture), [["pane", "current", "--current"]]);
});

test("dispatch retries shell readiness in the same pane without splitting again", () => {
  const fixture = fakeHerdrRoot("observer");
  const result = runHelper(
    fixture,
    ["dispatch", "--name", "please-smoke", "--cwd", fixture.root],
    { FAKE_HERDR_BUSY_STARTS: "1" },
  );

  assert.equal(result.status, 0, result.stderr);
  const observed = calls(fixture);
  assert.equal(observed.filter(call => call[0] === "pane" && call[1] === "split").length, 1);
  assert.deepEqual(observed.filter(call => call[0] === "agent" && call[1] === "start"), [
    ["agent", "start", "please-smoke", "--kind", "codex", "--pane", "w1:p2"],
    ["agent", "start", "please-smoke", "--kind", "codex", "--pane", "w1:p2"],
  ]);
});

test("dispatch refuses an empty handoff before invoking Herdr", () => {
  const fixture = fakeHerdrRoot("observer");
  const result = runHelper(fixture, ["dispatch", "--name", "please-smoke"], {}, "\n");

  assert.equal(result.status, 2);
  assert.match(result.stderr, /requires the lossless Implementor handoff on stdin/);
  assert.deepEqual(calls(fixture), []);
});

test("role reports inline execution outside Herdr without invoking the CLI", () => {
  const fixture = fakeHerdrRoot("observer");
  const result = runHelper(fixture, ["role"], { HERDR_ENV: "" });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { mode: "inline", reason: "not-herdr" });
  assert.deepEqual(calls(fixture), []);
});

test("wait owns lifecycle parsing and settles on the named Implementor", () => {
  const fixture = fakeHerdrRoot("observer");
  const result = runHelper(fixture, ["wait", "--name", "please-smoke", "--cwd", fixture.root]);

  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.mode, "observer");
  assert.deepEqual(observed.implementor, {
    name: "please-smoke",
    status: "done",
    paneId: "w1:p2",
    agentKind: "codex",
    cwd: fs.realpathSync(fixture.root),
    interactiveReady: true,
  });
  assert.equal(typeof observed.elapsedMs, "number");
  assert.deepEqual(calls(fixture), [
    ["pane", "current", "--current"],
    ["agent", "list"],
  ]);
});
