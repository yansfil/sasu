// #21 replaces hidden diagnosis subprocesses with three visible advisor intents.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { runtimeFixture } from "../helpers/implement-hide-fixture.mjs";
import { STATE_PATH, git } from "../helpers/implement-fixture.mjs";
import { attemptFixture } from "../helpers/implement-state.mjs";

const ok = (result) => { assert.equal(result.status, 0, result.text); return result.json.detail; };
const refuses = (result, pattern) => { assert.notEqual(result.status, 0, result.text); assert.match(result.json.message, pattern); };
const escalate = (f, intent, flags = [], options = {}) => f.cli(["implement", "escalate", "--intent", intent, ...flags], options);

test("advisor reservation prints a native spawn and letter reply instructions without running diagnosis", (t) => {
  const f = runtimeFixture(t);
  const before = f.state();
  const detail = ok(escalate(f, "failed-suite", ["--reason", "the required command keeps failing", "--target", "B1"], {
    env: { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: path.join(f.outside, "does-not-exist.json") },
  }));
  assert.equal(detail.escalationsRemaining, 2);
  assert.equal(detail.escalation.id, 1);
  assert.equal(detail.escalation.reason, "the required command keeps failing");
  assert.equal(detail.escalation.target, "B1");
  assert.equal(detail.effort, "high");
  assert.deepEqual(detail.argv.slice(0, 4), ["agent", "spawn", "--parent", "here"]);
  const prompt = fs.readFileSync(detail.promptPath, "utf8");
  assert.match(prompt, /Read-only advisor/);
  assert.match(prompt, /Sealed PRD:/);
  assert.match(prompt, /Blockage: the required command keeps failing/);
  assert.match(prompt, /hide request send <parent-id> .* --kind report/);
  assert.ok(f.hide.argv().every((argv) => ["agent list", "agent show here"].includes(argv.join(" "))));
  assert.deepEqual(Object.keys(f.runtime().participants), ["observer"]);
  const after = f.state();
  for (const key of ["requirements", "suite", "artifacts", "verificationAttempts", "verificationReport", "dispatchIntent"]) assert.deepEqual(after[key], before[key], key);
  for (const key of ["diagnosis", "judge", "handoff", "sessionId", "terminalId"]) assert.equal(key in detail.escalation, false, key);
});

test("three distinct advisor intents are allowed; retries at the cap spend no additional slot", (t) => {
  const f = runtimeFixture(t);
  const first = ok(escalate(f, "one", ["--reason", "first blockage"]));
  ok(escalate(f, "two", ["--reason", "second blockage"]));
  const third = ok(escalate(f, "three", ["--reason", "third blockage"]));
  assert.equal(third.escalationsRemaining, 0);
  const before = f.state();
  const retry = ok(escalate(f, "one"));
  assert.equal(retry.command, first.command);
  assert.equal(retry.reused, true);
  assert.deepEqual(f.state().escalations, before.escalations);
  assert.equal(f.state().events.filter((event) => event.kind === "escalate").length, 3);
  refuses(escalate(f, "four", ["--reason", "new blockage"]), /limit reached.*ask a human/);
  assert.equal(f.state().escalations.length, 3);
  assert.equal(Object.keys(f.runtime().spawns).length, 0);
});

test("same advisor intent refuses conflicting inputs instead of spending or changing its slot", (t) => {
  const f = runtimeFixture(t);
  const first = ok(escalate(f, "advice", ["--reason", "blocked", "--target", "B1", "--kind", "codex", "--model", "first-model"]));
  const original = f.state().escalations;
  for (const flags of [["--reason", "different"], ["--target", "B2"], ["--name", "other-advisor"], ["--kind", "claude"], ["--model", "other-model"], ["--effort", "xhigh"]]) {
    refuses(escalate(f, "advice", flags), /conflicts with reserved/);
  }
  assert.deepEqual(f.state().escalations, original);
  assert.equal(ok(escalate(f, "advice")).command, first.command);
});

test("advisor replay retains its original launch tuple after a branch rename", (t) => {
  const f = runtimeFixture(t);
  const first = ok(escalate(f, "advice", ["--reason", "blocked"]));
  const child = f.execute(first);
  assert.equal(child.status, 0, child.stderr);
  git(f.root, ["branch", "-m", "work/renamed"]);
  const retry = ok(escalate(f, "advice"));
  assert.deepEqual(retry.argv, first.argv);
  assert.equal(f.execute(retry).json.value.id, child.json.value.id);
  assert.equal(f.state().escalations.length, 1);
});

test("missing intent or reason and unavailable Hide consume no advisor slot", (t) => {
  const f = runtimeFixture(t);
  refuses(f.cli(["implement", "escalate", "--reason", "blocked"]), /missing required --intent/);
  refuses(escalate(f, "advice"), /missing required --reason/);
  refuses(escalate(f, "advice", ["--reason", "blocked"], { env: { HIDE_FAKE_DOWN: "1" } }), /delivery_unavailable/);
  assert.deepEqual(f.state().escalations, []);
  assert.equal(ok(escalate(f, "advice", ["--reason", "blocked"])).escalationsRemaining, 2);
});

test("Implementor and advisor panes cannot escalate regardless of issuer or old role marker", (t) => {
  const f = runtimeFixture(t);
  const dispatch = ok(f.dispatch());
  const implementor = f.execute(dispatch).json.value;
  const advisor = ok(escalate(f, "advice", ["--reason", "blocked"]));
  const advisorChild = f.execute(advisor).json.value;
  for (const pane of [implementor.pane, advisorChild.pane]) {
    refuses(escalate(f, "recursive", ["--reason", "blocked", "--issuer", "observer"], { env: { HERDR_PANE_ID: pane, SASU_HERDR_ROLE: "observer" } }), /run child in Hide/);
  }
  assert.equal(f.state().escalations.length, 1);
  assert.equal(Object.keys(f.runtime().spawns).length, 2);
});

test("a live verification lease refuses advisor reservation and keeps the lease intact", (t) => {
  const f = runtimeFixture(t);
  const state = f.state(), attempt = attemptFixture({ prdSha256: state.prd.sha256 });
  state.verificationAttempts.push(attempt);
  state.activeVerification = { token: "lease", attemptId: attempt.id, pid: process.pid, hostname: os.hostname(), startedAt: attempt.startedAt, inputFingerprint: attempt.inputFingerprint, prdSha256: attempt.prdSha256, executionPids: [], pendingSpawns: 0 };
  fs.writeFileSync(path.join(f.root, STATE_PATH), JSON.stringify(state));
  refuses(escalate(f, "advice", ["--reason", "blocked"]), /verification still active/);
  assert.deepEqual(f.state().escalations, []);
  assert.deepEqual(f.state().activeVerification, state.activeVerification);
  assert.deepEqual(f.hide.argv(), []);
});
