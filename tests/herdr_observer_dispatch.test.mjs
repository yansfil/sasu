import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const helper = path.join(repoRoot, "skills", "implement", "scripts", "herdr_observer.js");
const PRD_PATH = "agents/prd/test/prd.md";
const HANDOFF = `ROLE: Implementor
PIPELINE: implement via ~/.codex/skills/implement/SKILL.md
ORIGINAL INVOCATION: $please test
SOURCE: ${PRD_PATH}`;

function fakeHerdrRoot(role) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-herdr-observer-"));
  const bin = path.join(root, "bin");
  const calls = path.join(root, "calls.jsonl");
  fs.mkdirSync(bin);
  const executable = path.join(bin, "herdr");
  const prd = path.join(root, PRD_PATH);
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
} else if (key === "agent prompt" && process.env.FAKE_HERDR_PROMPT_FAIL === "1") {
  console.error("failed argv: " + args.join(" "));
  process.exit(1);
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
  fs.mkdirSync(path.dirname(prd), { recursive: true });
  fs.writeFileSync(prd, "---\nstatus: ready\nhuman_approval: pending\n---\n\n# Test PRD\n");
  return { root, bin, calls, prd: PRD_PATH, role };
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
  const result = runHelper(fixture, ["dispatch", "--name", "please-smoke", "--cwd", fixture.root, "--prd", fixture.prd]);

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
  assert.match(observedCalls[3][3], /sole specification source is the ready PRD/);
  assert.match(observedCalls[3][3], /never author or edit the qa-log or PRD/);
  assert.match(observedCalls[3][3], /output the structured OBSERVER_BLOCK packet.*end the turn/s);
});

test("dispatch forwards the selected Codex model and reasoning effort as native agent arguments", () => {
  const fixture = fakeHerdrRoot("observer");
  const result = runHelper(fixture, [
    "dispatch",
    "--name", "please-smoke",
    "--cwd", fixture.root,
    "--prd", fixture.prd,
    "--model", "gpt-5.6-sol",
    "--effort", "xhigh",
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).implementor, {
    name: "please-smoke",
    paneId: "w1:p2",
    agentKind: "codex",
    cwd: fixture.root,
    handoffSubmitted: true,
    model: "gpt-5.6-sol",
    effort: "xhigh",
  });
  assert.deepEqual(calls(fixture)[2], [
    "agent", "start", "please-smoke", "--kind", "codex", "--pane", "w1:p2",
    "--", "--model", "gpt-5.6-sol", "--config", 'model_reasoning_effort="xhigh"',
  ]);
});

test("dispatch carries the Spec Owner's dirty disposition into the Implementor start contract", () => {
  const fixture = fakeHerdrRoot("observer");
  const result = runHelper(fixture, [
    "dispatch",
    "--name", "please-smoke",
    "--cwd", fixture.root,
    "--prd", fixture.prd,
    "--dirty-attribution", "pre-existing",
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).implementor.dirtyAttribution, "pre-existing");
  const submitted = calls(fixture).find(call => call[0] === "agent" && call[1] === "prompt")[3];
  assert.match(submitted, /DIRTY ATTRIBUTION: pre-existing/);
  assert.match(submitted, /Pass --dirty-attribution pre-existing to sasu implement start exactly once/);
  assert.match(submitted, /never ask the question again/);
});

test("dispatch rejects unresolved commit-first before invoking Herdr", () => {
  const fixture = fakeHerdrRoot("observer");
  const result = runHelper(fixture, [
    "dispatch",
    "--name", "please-smoke",
    "--cwd", fixture.root,
    "--prd", fixture.prd,
    "--dirty-attribution", "commit-first",
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /commit-first is resolved before dispatch/);
  assert.deepEqual(calls(fixture), []);
});

test("a failed handoff submission never echoes the handoff into diagnostics", () => {
  const fixture = fakeHerdrRoot("observer");
  const secret = "PRIVATE_OPERATIONAL_CONTEXT_8241";
  const result = runHelper(
    fixture,
    ["dispatch", "--name", "please-smoke", "--cwd", fixture.root, "--prd", fixture.prd],
    { FAKE_HERDR_PROMPT_FAIL: "1" },
    `${HANDOFF}\nCONTEXT: ${secret}`,
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /agent prompt please-smoke <redacted handoff> failed/);
  assert.match(result.stderr, /handoff diagnostic redacted/);
  assert.doesNotMatch(result.stderr, new RegExp(secret));
  assert.doesNotMatch(result.stderr, /ORIGINAL INVOCATION/);
});

test("dispatch refuses recursion from a marked Implementor pane", () => {
  const fixture = fakeHerdrRoot("implementor");
  const result = runHelper(fixture, ["dispatch", "--name", "nested", "--prd", fixture.prd]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /recursive dispatch refused/);
  assert.deepEqual(calls(fixture), [["pane", "current", "--current"]]);
});

test("dispatch retries shell readiness in the same pane without splitting again", () => {
  const fixture = fakeHerdrRoot("observer");
  const result = runHelper(
    fixture,
    ["dispatch", "--name", "please-smoke", "--cwd", fixture.root, "--prd", fixture.prd],
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

test("dispatch refuses specification work before invoking Herdr", () => {
  const fixture = fakeHerdrRoot("observer");
  const result = runHelper(
    fixture,
    ["dispatch", "--name", "please-smoke", "--cwd", fixture.root, "--prd", fixture.prd],
    {},
    HANDOFF.replace("PIPELINE: implement", "PIPELINE: please"),
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /requires exactly one 'PIPELINE: implement'/);
  assert.deepEqual(calls(fixture), []);
});

test("dispatch refuses a PRD that is not ready before invoking Herdr", () => {
  const fixture = fakeHerdrRoot("observer");
  fs.writeFileSync(path.join(fixture.root, fixture.prd), "---\nstatus: draft\n---\n\n# Draft\n");
  const result = runHelper(
    fixture,
    ["dispatch", "--name", "please-smoke", "--cwd", fixture.root, "--prd", fixture.prd],
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /PRD status must be ready before dispatch, got draft/);
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

// Pre-dispatch gate check. 2026-08-27 modakbul: the Observer dispatched while
// gap-audit sat BLOCKED on a judge-auth ERROR; the Implementor booted, ran
// `sasu implement start`, was refused, and bounced. The dispatcher now reads
// `sasu gate status` first for qa-log-backed PRDs; authority stays with
// implement start, so an unavailable or unparseable `sasu` never blocks here.
function writeQaLogBackedPrd(fixture) {
  fs.writeFileSync(
    path.join(fixture.root, PRD_PATH),
    "---\nstatus: ready\nhuman_approval: pending\nsource_intake: agents/interview/test/qa-log.md\n---\n\n# Test PRD\n",
  );
}

function fakeSasu(fixture, body) {
  const executable = path.join(fixture.bin, "sasu");
  fs.writeFileSync(executable, `#!/usr/bin/env node\n${body}\n`);
  fs.chmodSync(executable, 0o755);
}

function gateStatusJson(gapEffective, specEffective) {
  return JSON.stringify({
    contractVersion: "test",
    "gap-audit": { gate: "gap-audit", effective: gapEffective },
    spec: { gate: "spec", effective: specEffective },
    verify: { gate: "verify", effective: "NOT_RUN" },
  });
}

test("dispatch refuses a qa-log-backed PRD while a PRD gate is not at live PASS", () => {
  const fixture = fakeHerdrRoot("observer");
  writeQaLogBackedPrd(fixture);
  fakeSasu(fixture, `console.log(${JSON.stringify(gateStatusJson("BLOCKED", "PASS"))});`);
  const result = runHelper(fixture, ["dispatch", "--name", "please-smoke", "--cwd", fixture.root, "--prd", fixture.prd]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /dispatch refused: qa-log-backed PRD requires live PASS for gap-audit and spec, got gap-audit=BLOCKED/);
  assert.deepEqual(calls(fixture).filter((call) => call[0] === "pane" && call[1] === "split"), [], "no Implementor pane may be provisioned");
});

test("dispatch proceeds for a qa-log-backed PRD once both PRD gates report PASS", () => {
  const fixture = fakeHerdrRoot("observer");
  writeQaLogBackedPrd(fixture);
  fakeSasu(fixture, `console.log(${JSON.stringify(gateStatusJson("PASS", "PASS"))});`);
  const result = runHelper(fixture, ["dispatch", "--name", "please-smoke", "--cwd", fixture.root, "--prd", fixture.prd]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).implementor.handoffSubmitted, true);
});

test("dispatch stays fail-open when sasu is broken; implement start remains the authority", () => {
  const fixture = fakeHerdrRoot("observer");
  writeQaLogBackedPrd(fixture);
  fakeSasu(fixture, "console.log('not json'); process.exit(1);");
  const result = runHelper(fixture, ["dispatch", "--name", "please-smoke", "--cwd", fixture.root, "--prd", fixture.prd]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).implementor.handoffSubmitted, true);
});
