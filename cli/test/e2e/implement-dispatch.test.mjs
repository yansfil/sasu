// #21 changes the public contract: Sasu prints launch instructions, Hide executes them.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { HANDOFF, runtimeFixture } from "../helpers/implement-hide-fixture.mjs";
import { PRD_PATH, STATE_PATH, git } from "../helpers/implement-fixture.mjs";
import { attemptFixture } from "../helpers/implement-state.mjs";

const ok = (result) => { assert.equal(result.status, 0, result.text); return result.json.detail; };
const refuses = (result, pattern) => { assert.notEqual(result.status, 0, result.text); assert.match(result.json.message, pattern); };
const assertNoRuntimeCopies = (state) => {
  for (const field of ["ownerSessionId", "adoptions", "dispatches", "supervision", "pendingDispatch"]) assert.equal(field in state, false, field);
  assert.doesNotMatch(JSON.stringify(state.dispatchIntent), /session|terminal|paneId|watchId|registration/);
};

test("dispatch prints a complete native command without starting or registering a child", (t) => {
  const f = runtimeFixture(t);
  const handoff = `${HANDOFF}\n${"full approved context\n".repeat(1000)}`;
  const detail = ok(f.dispatch(["--kind", "codex", "--model", "chosen-model"], { input: handoff }));
  assert.deepEqual(detail.argv.slice(0, 4), ["agent", "spawn", "--parent", "here"]);
  assert.deepEqual(detail.argv.slice(-6), ["--model", "chosen-model", "--config", 'model_reasoning_effort="high"', "--", detail.prompt]);
  for (const flag of ["--repo", "--path"]) assert.equal(detail.argv[detail.argv.indexOf(flag) + 1], f.root);
  assert.equal(detail.dispatch.effort, "high");
  assert.equal(detail.prompt, `Read ${JSON.stringify(detail.promptPath)} and carry out the assigned work.`);
  const prompt = fs.readFileSync(detail.promptPath, "utf8");
  assert.ok(prompt.includes(handoff.trim()));
  assert.match(prompt, /sasu implement verify on the final committed head/);
  assert.match(prompt, /hide request send --kind block/);
  assert.match(prompt, /hide request send --kind report/);
  assert.doesNotMatch(prompt, /sasu implement (plan|block|report)/);
  assert.deepEqual(Object.keys(f.runtime().participants), ["observer"]);
  assert.ok(f.hide.argv().every((argv) => ["agent list", "workspace info"].includes(argv.join(" "))));
  assertNoRuntimeCopies(f.state());
});

test("linked checkout instructions use the main repository and the actual run branch/path", (t) => {
  const f = runtimeFixture(t, { linked: true });
  const detail = ok(f.dispatch());
  assert.equal(detail.argv[detail.argv.indexOf("--repo") + 1], f.mainRoot);
  assert.equal(detail.argv[detail.argv.indexOf("--path") + 1], f.root);
  assert.equal(detail.argv[detail.argv.indexOf("--branch") + 1], "work/linked");
  assert.equal(f.state().projectRoot, f.root);
  assert.ok(f.state().suite.commands.every((command) => path.resolve(f.root, command.cwd) === f.root));
  assert.equal(ok(f.dispatch([], { input: "" })).command, detail.command);
});

test("retry reuses the immutable prompt and one intent; direct Hide retries converge", (t) => {
  const f = runtimeFixture(t);
  const first = ok(f.dispatch());
  const before = f.state();
  const retry = ok(f.dispatch([], { input: "" }));
  assert.equal(retry.command, first.command);
  assert.equal(retry.promptPath, first.promptPath);
  assert.deepEqual(f.state().dispatchIntent, before.dispatchIntent);
  assert.equal(f.state().events.filter((event) => event.kind === "dispatch").length, 1);
  assert.equal(f.hide.argv().some((argv) => argv[1] === "spawn"), false);
  const launched = f.execute(first), resumed = f.execute(retry);
  assert.equal(launched.status, 0, launched.stderr);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(launched.json.value.id, resumed.json.value.id);
  assert.equal(Object.keys(f.runtime().spawns).length, 1);
  assert.equal(ok(f.cli(["implement", "status"])).dispatch.intent, first.dispatch.intent);
});

test("conflicting launch flags and handoff cannot rewrite a reserved dispatch", (t) => {
  const f = runtimeFixture(t);
  const detail = ok(f.dispatch(["--kind", "codex", "--model", "first-model"]));
  const reserved = f.state().dispatchIntent;
  const bytes = fs.readFileSync(detail.promptPath, "utf8");
  for (const flags of [["--name", "another"], ["--kind", "claude"], ["--model", "other-model"], ["--effort", "xhigh"]]) {
    refuses(f.cli(["implement", "dispatch", ...flags]), /conflicts with reserved intent/);
  }
  refuses(f.dispatch([], { input: "different goal" }), /handoff conflicts/);
  assert.deepEqual(f.state().dispatchIntent, reserved);
  assert.equal(fs.readFileSync(detail.promptPath, "utf8"), bytes);
  assert.equal(Object.keys(f.runtime().spawns).length, 0);
});

test("dispatch replay retains its original launch tuple after a branch rename", (t) => {
  const f = runtimeFixture(t);
  const first = ok(f.dispatch());
  const child = f.execute(first);
  assert.equal(child.status, 0, child.stderr);
  git(f.root, ["branch", "-m", "work/renamed"]);
  const retry = ok(f.dispatch([], { input: "" }));
  assert.deepEqual(retry.argv, first.argv);
  assert.equal(f.execute(retry).json.value.id, child.json.value.id);
  assert.equal(Object.keys(f.runtime().spawns).length, 1);
});

test("changed or missing prompt bytes refuse a retry until the original bytes return", (t) => {
  const f = runtimeFixture(t);
  const detail = ok(f.dispatch());
  const bytes = fs.readFileSync(detail.promptPath);
  fs.writeFileSync(detail.promptPath, "changed instructions");
  refuses(f.dispatch([], { input: "" }), /prompt is missing or changed/);
  fs.rmSync(detail.promptPath);
  refuses(f.dispatch([], { input: "" }), /prompt is missing or changed/);
  fs.writeFileSync(detail.promptPath, bytes);
  assert.equal(ok(f.dispatch([], { input: "" })).command, detail.command);
  assert.equal(Object.keys(f.runtime().spawns).length, 0);
});

test("native session and terminal changes preserve run navigation and mutations", (t) => {
  const f = runtimeFixture(t);
  const first = ok(f.dispatch());
  const live = f.runtime();
  Object.assign(live.participants.observer, { session: "rotated-session", instance: "rotated-terminal" });
  f.writeRuntime(live);
  const env = { CODEX_SESSION_ID: "rotated-session", SASU_HERDR_ROLE: "implementor" };
  const evidence = "agents/observations/session-change.log";
  fs.mkdirSync(path.dirname(path.join(f.root, evidence)), { recursive: true });
  fs.writeFileSync(path.join(f.root, evidence), "Observed the current public flow\n");
  ok(f.cli(["implement", "artifact", "--kind", "log", "--path", evidence, "--description", "current runtime observation"], { env }));
  assert.equal(ok(f.cli(["implement", "dispatch"], { env })).command, first.command);
  assertNoRuntimeCopies(f.state());
  assert.equal(fs.existsSync(path.join(f.root, "agents/runs/.active")), false);
  assert.equal(fs.existsSync(path.join(f.root, "agents/runs/.prd-implement-active.json")), false);
});

test("a child cannot recursively dispatch and another parent cannot reuse its intent", (t) => {
  const f = runtimeFixture(t);
  const detail = ok(f.dispatch());
  const child = f.execute(detail).json.value;
  refuses(f.cli(["implement", "dispatch"], { env: { HERDR_PANE_ID: child.pane, SASU_HERDR_ROLE: "observer" } }), /run child in Hide/);
  const runtime = f.runtime();
  runtime.participants[child.id].parent = "another-observer";
  f.writeRuntime(runtime);
  refuses(f.dispatch([], { input: "" }), /another parent/);
  assert.equal(f.state().dispatchIntent.intent, detail.dispatch.intent);
  assert.equal(Object.keys(f.runtime().spawns).length, 1);
});

test("dispatch refuses before reserving a prompt during a live verification lease", (t) => {
  const f = runtimeFixture(t);
  const state = f.state(), attempt = attemptFixture({ prdSha256: state.prd.sha256 });
  state.verificationAttempts.push(attempt);
  state.activeVerification = { token: "lease", attemptId: attempt.id, pid: process.pid, hostname: os.hostname(), startedAt: attempt.startedAt, inputFingerprint: attempt.inputFingerprint, prdSha256: attempt.prdSha256, executionPids: [], pendingSpawns: 0 };
  fs.writeFileSync(path.join(f.root, STATE_PATH), JSON.stringify(state));
  refuses(f.dispatch(), /verification still active/);
  assert.equal(f.state().dispatchIntent, null);
  assert.equal(fs.existsSync(path.join(f.root, "agents/runs/fixture/dispatch")), false);
  assert.deepEqual(f.hide.argv(), []);
});

test("bare navigation requires one active run instead of a session bookmark", (t) => {
  const f = runtimeFixture(t);
  const secondPrd = PRD_PATH.replace("fixture/", "second/");
  fs.mkdirSync(path.dirname(path.join(f.root, secondPrd)), { recursive: true });
  fs.copyFileSync(path.join(f.root, PRD_PATH), path.join(f.root, secondPrd));
  ok(f.cli(["implement", "start", "--prd", secondPrd, "--dirty-attribution", "run-owned"]));
  refuses(f.cli(["implement", "status"]), /multiple active implement runs/);
  assert.equal(ok(f.cli(["implement", "status", "--slug", "fixture"], { env: { CODEX_SESSION_ID: "another-session" } })).topicSlug, "fixture");
  assert.equal(fs.existsSync(path.join(f.root, "agents/runs/.active")), false);
});

test("closed legacy history is ignored but active legacy and malformed current records fail explicitly", (t) => {
  const f = runtimeFixture(t);
  const history = path.join(f.root, "agents/runs/history/state.json");
  fs.mkdirSync(path.dirname(history), { recursive: true });
  const archived = { ...f.state(), schema: "sasu.implement.state.v12.hide", topicSlug: "history", status: "closed" };
  fs.writeFileSync(history, JSON.stringify(archived));
  assert.equal(ok(f.cli(["implement", "status"])).topicSlug, "fixture");
  ok(f.dispatch());
  fs.writeFileSync(history, JSON.stringify({ ...archived, status: "active" }));
  refuses(f.cli(["implement", "status"]), /unsupported implement state schema/);
  refuses(f.cli(["implement", "dispatch", "--slug", "fixture"]), /unsupported implement state schema/);
  fs.writeFileSync(history, JSON.stringify({ ...f.state(), status: "retired", createdAt: "invalid" }));
  refuses(f.cli(["implement", "status"]), /malformed implement state.*createdAt/);
  fs.writeFileSync(history, "{broken JSON");
  refuses(f.cli(["implement", "status"]), /cannot inspect implement run/);
});
