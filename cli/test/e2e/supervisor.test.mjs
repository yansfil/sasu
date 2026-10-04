// Real Sasu CLI, strict native/delivery doubles and a private machine registry.
// Pinned native Hide acceptance is a separate end-to-end suite.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { CLI, isolatedEnv, makeProject, PRD_PATH, STATE_PATH } from "../helpers/implement-fixture.mjs";
import { installFakeHerdr } from "../helpers/fake-herdr.mjs";
import { readIndex } from "../../dist/supervisor/index.js";

const OBSERVER = "observer-session", OLD = "w4G:p12", NEW = "w4G:p14";
const PACKET = "ROLE: Implementor.\nPIPELINE: implement\nSOURCE: fixture\nRETURN CONTRACT: status";
function sasu(cwd, args, { env = {}, input } = {}) {
  const run = spawnSync(process.execPath, [CLI, ...args, "--json"], { cwd, encoding: "utf8", env: isolatedEnv(env), input, timeout: 30_000 });
  let json; try { json = JSON.parse(run.stdout); } catch { json = {}; }
  return { ...run, json, text: run.stdout + run.stderr };
}
function fixture(t) {
  const root = fs.realpathSync(makeProject());
  fs.writeFileSync(path.join(root, "agents/config.json"), JSON.stringify({ worktree: { enabled: false } }));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sasu-hide-contract-")));
  const fake = installFakeHerdr(outside), home = path.join(outside, "home"); fs.mkdirSync(home);
  const env = { HOME: home, ...fake.env, HERDR_ENV: "1", HERDR_PANE_ID: OLD, HERDR_WORKSPACE_ID: "w4G", HERDR_SOCKET_PATH: "/tmp/fake.sock", CLAUDE_SESSION_ID: OBSERVER };
  const statePath = path.join(root, STATE_PATH), hidePath = env.HIDE_FAKE_STATE, indexPath = path.join(home, ".sasu/supervisor/index.json");
  t.after(() => { fs.rmSync(outside, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal(sasu(root, ["implement", "start", "--prd", PRD_PATH, "--dirty-attribution", "run-owned"], { env }).status, 0);
  const dispatched = sasu(root, ["implement", "dispatch", "--name", "impl", "--prd", PRD_PATH], { env, input: PACKET });
  assert.equal(dispatched.status, 0, dispatched.text);
  return { root, home, fake, env, statePath, hidePath, indexPath,
    state: () => JSON.parse(fs.readFileSync(statePath, "utf8")), hide: () => JSON.parse(fs.readFileSync(hidePath, "utf8")),
    argv: () => fs.readFileSync(env.HIDE_FAKE_LOG, "utf8").trim().split("\n").map(JSON.parse),
    newObserver() {
      fake.patchAgent(NEW, { name: "new-observer", agent: "claude", agent_status: "working", pane_id: NEW, terminal_id: "term_new", agent_session: { value: "new-session" }, tokens: { activity: String(Date.now()) }, state_change_seq: 2 });
      return { ...env, HERDR_PANE_ID: NEW, CLAUDE_SESSION_ID: "new-session" };
    },
  };
}
const registryBytes = (file) => fs.readdirSync(path.dirname(file)).filter((name) => name === path.basename(file) || name.startsWith(path.basename(file) + ".revision-")).sort().map((name) => [name, fs.readFileSync(path.join(path.dirname(file), name), "utf8")]);
const handoverArgs = ["supervisor", "handover", "--slug", "fixture", "--approval", "The new Observer takes this run"];

test("Hide dispatch records registry occupancy and status reads the current watch without a second scheduler", (t) => {
  const run = fixture(t), state = run.state();
  assert.equal(state.schema, "sasu.implement.state.v12.hide");
  assert.equal("coordinationOwner" in state.supervision, false);
  assert.deepEqual(readIndex(run.indexPath).entries.map(({ statePath, runInstanceId }) => [statePath, runInstanceId]), [[run.statePath, state.supervision.runInstanceId]]);
  const shown = sasu(run.home, ["supervisor", "status"], { env: run.env });
  assert.equal(shown.status, 0, shown.text);
  assert.equal(shown.json.detail.runs[0].watch.id, state.supervision.hide.watchId);
  assert.match(shown.json.summary.join("\n"), /Hide delivery and inactivity watches/);
  assert.doesNotMatch(JSON.stringify(shown.json), /ROLE: Implementor|launchd|lastTick|cycle/);
  const digest = sasu(run.root, ["implement", "status", "--slug", "fixture", "--digest"], { env: run.env });
  assert.equal(digest.status, 0, digest.text);
  assert.match(digest.json.summary.join("\n"), /Supervision: Hide run.*watch/);
});

test("D33: the attested new Observer assigns the exact watch generation before Sasu records the recipient", (t) => {
  const run = fixture(t), old = run.state(), before = readIndex(run.indexPath).entries[0];
  const env = run.newObserver();
  const changed = sasu(run.root, handoverArgs, { env });
  assert.equal(changed.status, 0, changed.text);
  const current = run.state(), watched = run.hide().participants[current.supervision.hide.implementor].watch;
  assert.equal(current.supervision.observer.paneId, NEW);
  assert.equal(watched.parent.pane_id, NEW);
  assert.equal(watched.generation, 1);
  assert.equal(watched.id, old.supervision.hide.watchId);
  assert.notEqual(readIndex(run.indexPath).entries[0].registrationId, before.registrationId);
  const assign = run.argv().find((argv) => argv[0] === "watch" && argv[1] === "assign");
  assert.deepEqual(assign, ["watch", "assign", watched.id, "--observer", current.supervision.hide.observer, "--actor", current.supervision.hide.observer, "--expected-generation", "0", "--approval", handoverArgs.at(-1)]);
  const repeat = sasu(run.root, handoverArgs, { env });
  assert.equal(repeat.status, 0, repeat.text);
  assert.equal(run.argv().filter((argv) => argv[0] === "watch" && argv[1] === "assign").length, 1, "same Observer retry keeps the watch generation");
});

test("D33: a generation refusal leaves both Sasu state and registry byte-identical", (t) => {
  const run = fixture(t), stateBytes = fs.readFileSync(run.statePath), indexBytes = registryBytes(run.indexPath);
  const refused = sasu(run.root, handoverArgs, { env: { ...run.newObserver(), HIDE_FAKE_REFUSE_ASSIGN: "1" } });
  assert.notEqual(refused.status, 0);
  assert.match(refused.text, /watch_generation_conflict.*handover was not recorded/);
  assert.deepEqual(fs.readFileSync(run.statePath), stateBytes);
  assert.deepEqual(registryBytes(run.indexPath), indexBytes);
});

test("watch handover does not let the new Observer retire another parent's child", (t) => {
  const run = fixture(t), dispatched = run.state(), env = run.newObserver();
  const planPath = path.join(run.root, "agents/runs/fixture/plan.md");
  fs.writeFileSync(planPath, "Exercise the caller contract before claiming completion.\n");
  const claimed = sasu(run.root, ["implement", "plan", "--path", "agents/runs/fixture/plan.md"], { env: { ...run.env, HERDR_PANE_ID: dispatched.supervision.implementor.paneId, CLAUDE_SESSION_ID: dispatched.supervision.implementor.sessionId, SASU_HERDR_ROLE: "implementor", SASU_RUN_INSTANCE_ID: dispatched.supervision.runInstanceId } });
  assert.equal(claimed.status, 0, claimed.text);
  assert.equal(run.state().ownerSessionId, dispatched.supervision.implementor.sessionId);
  const changed = sasu(run.root, handoverArgs, { env });
  assert.equal(changed.status, 0, changed.text);
  const stateBytes = fs.readFileSync(run.statePath), indexBytes = registryBytes(run.indexPath);
  const refused = sasu(run.root, ["implement", "retire", "--slug", "fixture", "--adopt", "Retire this fixture"], { env });
  assert.notEqual(refused.status, 0);
  assert.match(refused.text, /agent_authority_required.*target or original registered parent/);
  assert.equal(refused.json.detail.occupancyReleased, false);
  assert.deepEqual(fs.readFileSync(run.statePath), stateBytes);
  assert.deepEqual(registryBytes(run.indexPath), indexBytes);
  const ended = sasu(run.root, ["implement", "retire", "--slug", "fixture", "--adopt", "Retire this fixture"], { env: run.env });
  assert.equal(ended.status, 0, ended.text);
  assert.equal(run.state().status, "retired");
  assert.equal(readIndex(run.indexPath).entries.length, 0);
});

test("handover requires bounded approval and positive native identity before any Hide mutation", (t) => {
  const run = fixture(t), original = fs.readFileSync(run.statePath), calls = run.argv().length;
  for (const approval of ["", "x".repeat(257), "line\nbreak"]) {
    const result = sasu(run.root, [...handoverArgs.slice(0, -1), approval], { env: run.env });
    assert.notEqual(result.status, 0); assert.match(result.text, /nonempty --approval/);
  }
  const unknown = sasu(run.root, handoverArgs, { env: { ...run.env, HERDR_PANE_ID: NEW } });
  assert.notEqual(unknown.status, 0); assert.match(unknown.text, /cannot identify/);
  assert.equal(run.argv().length, calls);
  assert.deepEqual(fs.readFileSync(run.statePath), original);
});

test("a positively observed ended watch transfers the recipient without rearming it", (t) => {
  const run = fixture(t), ledger = run.hide(), state = run.state();
  ledger.participants[state.supervision.hide.implementor].watch = null;
  fs.writeFileSync(run.hidePath, JSON.stringify(ledger));
  const starts = run.argv().filter((argv) => argv[0] === "watch" && argv[1] === "start").length;
  const handed = sasu(run.root, handoverArgs, { env: run.newObserver() });
  assert.equal(handed.status, 0, handed.text);
  assert.match(handed.text, /no active Hide watch.*not restarted/);
  assert.equal(run.state().supervision.observer.paneId, NEW);
  assert.equal(run.hide().participants[state.supervision.hide.implementor].watch, null);
  assert.equal(run.argv().filter((argv) => argv[0] === "watch" && argv[1] === "start").length, starts);
});

test("transport failure is attention, never evidence of an ended watch or permission to transfer", (t) => {
  const run = fixture(t), original = fs.readFileSync(run.statePath);
  const downEnv = { ...run.newObserver(), HIDE_FAKE_DOWN: "1" };
  const shown = sasu(run.home, ["supervisor", "status"], { env: downEnv });
  assert.notEqual(shown.status, 0);
  assert.match(shown.json.detail.healthProblems.join("\n"), /delivery_unavailable/);
  const refused = sasu(run.root, handoverArgs, { env: downEnv });
  assert.notEqual(refused.status, 0);
  assert.deepEqual(fs.readFileSync(run.statePath), original);
});

test("retired scheduler and backend commands are rejected without installing files", (t) => {
  const run = fixture(t);
  for (const args of [["install"], ["uninstall"], ["tick"], ["use", "legacy"], ["migrate-hcoord"], ["retire-legacy"]]) {
    const refused = sasu(run.home, ["supervisor", ...args], { env: run.env });
    assert.notEqual(refused.status, 0);
    assert.match(refused.text, /unknown supervisor subcommand/);
  }
  assert.equal(fs.existsSync(path.join(run.home, "Library/LaunchAgents")), false);
});
