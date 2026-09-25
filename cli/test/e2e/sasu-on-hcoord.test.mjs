// Sasu supervision on hcoord at the real CLI boundary: an isolated HOME, a
// fake herdr and a fake launchctl on PATH, and a test-owned hcoord daemon.
// No test reaches a live pane, the live daemon, or the real launchd domain.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

import { CLI, isolatedEnv, makeProject, PRD_PATH, STATE_PATH } from "../helpers/implement-fixture.mjs";
import { installFakeHerdr, installFakeLaunchctl } from "../helpers/fake-herdr.mjs";
import { readIndex } from "../../dist/supervisor/index.js";

const HCOORD = path.resolve(import.meta.dirname, "../../dist/hcoord/cli.js");
const OBSERVER = "0b5e7e1e-0000-4000-8000-00000000000a";
const OBSERVER_PANE = "w4G:p12";
const IMPL_PANE = "w4G:p13";
const PACKET = "ROLE: Implementor.\nPIPELINE: implement\nSOURCE: fixture\nRETURN CONTRACT: status";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("daemon start after a manual stop kickstarts the still-loaded label instead of failing its bootstrap", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hcoord-launchd-"));
  const launchctl = installFakeLaunchctl(root);
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, PATH: launchctl.env.PATH, LAUNCHCTL_FAKE_LOG: launchctl.log, LAUNCHCTL_FAKE_STATE: launchctl.stateFile };
  delete env.HCOORD_HOME;
  const start = () => spawnSync(process.execPath, [HCOORD, "daemon", "start", "--json"], { env, encoding: "utf8" });
  const first = start();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  // `hcoord daemon stop` leaves the label loaded (KeepAlive keeps a clean exit down) and writes the marker.
  fs.writeFileSync(path.join(home, ".hcoord", "manual-stop"), "stopped\n");
  const again = start();
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(JSON.parse(again.stdout).ok, true);
  const asked = launchctl.argv().map((args) => args[0]);
  assert.deepEqual(asked.filter((verb) => verb === "bootstrap").length, 1, "a loaded label is never bootstrapped a second time");
  assert.equal(launchctl.state().kicked, 2, "each start asks launchd to run the loaded label");
  assert.equal(fs.existsSync(path.join(home, ".hcoord", "manual-stop")), false, "start clears the manual stop");
});

/**
 * A project with a started run, a fake herdr whose Observer pane is idle and
 * interactive-ready, and a daemon this test owns. `sasu enable` is on.
 */
async function hcoordProject(t, { observerName = "observer", daemon = true, env: extraEnv = {} } = {}) {
  const root = fs.realpathSync(makeProject());
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({ worktree: { enabled: false } }));
  // Fakes and HOME live beside the project so the digest never sees their logs.
  const outside = fs.mkdtempSync(`${root}-hc-`);
  const herdr = installFakeHerdr(outside);
  const launchctl = installFakeLaunchctl(outside);
  const home = path.join(outside, "home");
  fs.mkdirSync(home, { recursive: true });
  const base = { HOME: home, ...herdr.env, PATH: herdr.env.PATH, LAUNCHCTL_FAKE_LOG: launchctl.env.LAUNCHCTL_FAKE_LOG, LAUNCHCTL_FAKE_STATE: launchctl.env.LAUNCHCTL_FAKE_STATE, ...extraEnv };
  const observerEnv = { ...base, HERDR_ENV: "1", HERDR_PANE_ID: OBSERVER_PANE, HERDR_WORKSPACE_ID: "w4G", CLAUDE_SESSION_ID: OBSERVER };
  const implementorEnv = { ...base, HERDR_ENV: "1", HERDR_PANE_ID: IMPL_PANE, HERDR_WORKSPACE_ID: "w4G", CLAUDE_SESSION_ID: "impl-session", SASU_HERDR_ROLE: "implementor" };
  herdr.setAgents({ [OBSERVER_PANE]: { ...(observerName === null ? {} : { name: observerName }), agent: "claude", agent_status: "idle", interactive_ready: true, pane_id: OBSERVER_PANE, terminal_id: "term_observer", agent_session: { value: OBSERVER }, tokens: { activity: String(Date.now()) }, state_change_seq: 1 } });
  let child = null, daemonError = "";
  const startDaemon = async () => {
    child = spawn(process.execPath, [HCOORD, "daemon", "run"], { cwd: home, env: isolatedEnv(base), stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.on("data", (chunk) => { daemonError += chunk; });
    const socket = path.join(home, ".hcoord", "api.sock");
    for (let attempt = 0; attempt < 200 && !fs.existsSync(socket); attempt += 1) await wait(20);
    assert.equal(fs.existsSync(socket), true, daemonError);
  };
  const stopDaemon = async () => {
    if (child !== null && child.exitCode === null) { child.kill("SIGTERM"); await new Promise((resolve) => child.once("exit", resolve)); }
    child = null;
  };
  t.after(async () => { await stopDaemon(); fs.rmSync(outside, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); });
  const hcoord = (...args) => {
    const result = spawnSync(process.execPath, [HCOORD, ...args, "--json"], { cwd: home, env: isolatedEnv(observerEnv), encoding: "utf8" });
    return JSON.parse(result.stdout);
  };
  const sasu = (args, { env = observerEnv, input } = {}) => {
    const result = spawnSync(process.execPath, [CLI, ...args, "--json"], { cwd: root, encoding: "utf8", env: isolatedEnv(env), input, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    let json;
    try { json = JSON.parse(result.stdout); } catch { json = { stdout: result.stdout, stderr: result.stderr }; }
    return { ...result, json, text: result.stdout + result.stderr };
  };
  if (daemon) await startDaemon();
  fs.mkdirSync(path.join(home, ".hcoord"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, ".hcoord", "sasu-enabled"), "test\n");
  const started = sasu(["implement", "start", "--prd", PRD_PATH, "--dirty-attribution", "run-owned"]);
  assert.equal(started.status, 0, started.text);
  const state = () => JSON.parse(fs.readFileSync(path.join(root, STATE_PATH), "utf8"));
  /** Notices typed into a pane by the daemon, in order. */
  const noticesTo = (pane) => herdr.prompts().filter((prompt) => prompt.target === pane && prompt.text.startsWith("HCOORD_"));
  const until = async (predicate, what, ms = 15_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { const value = predicate(); if (value) return value; await wait(100); }
    assert.fail(`timed out waiting for ${what}; daemon stderr: ${daemonError}`);
  };
  const dispatch = (extra = [], env = observerEnv) => sasu(["implement", "dispatch", "--name", "impl", "--prd", PRD_PATH, ...extra], { env, input: PACKET });
  return { root, home, herdr, base, observerEnv, implementorEnv, hcoord, sasu, state, dispatch, noticesTo, until, startDaemon, stopDaemon };
}

const created = (herdr) => herdr.argv().filter((args) => ["tab create", "workspace create", "agent start"].includes(args.slice(0, 2).join(" ")));

test("B3: dispatch refuses a stopped coordinator and an unnamed Observer before any pane or agent exists", async (t) => {
  const stopped = await hcoordProject(t, { daemon: false });
  const refused = stopped.dispatch();
  assert.equal(refused.status, 1, refused.text);
  assert.match(refused.json.message, /daemon_down|not running/);
  assert.match(refused.json.message, /no legacy wake fallback/);
  assert.deepEqual(created(stopped.herdr), [], "nothing was created");
  assert.equal(stopped.state().pendingDispatch ?? null, null);

  const unnamed = await hcoordProject(t, { observerName: null });
  const named = unnamed.dispatch();
  assert.equal(named.status, 1, named.text);
  assert.match(named.json.message, /herdr agent rename w4G:p12 <name>/);
  assert.deepEqual(created(unnamed.herdr), [], "the name check precedes any pane");
});

test("B1, B4, B13, B16: dispatch registers both participants with the patrol interval and forewarns the implementor", async (t) => {
  const run = await hcoordProject(t);
  const dispatched = run.dispatch(["--patrol", "7", "--recovery-owner", "task-factory"]);
  assert.equal(dispatched.status, 0, dispatched.text);
  const record = run.state().supervision;
  assert.equal(record.coordinationOwner, "hcoord");
  assert.equal(record.hcoord.intervalMs, 7 * 60_000);
  assert.equal(record.hcoord.recoveryOwner, "task-factory");
  assert.match(dispatched.json.message, /coordinated by hcoord .*watch every 7 min, recovery owner task-factory/);
  const shown = run.hcoord("sasu", "show", "--run", record.runInstanceId).value;
  assert.equal(shown.watch.intervalMs, 7 * 60_000);
  assert.equal(shown.slug, "fixture");
  assert.equal(shown.recoveryOwner, "task-factory");
  assert.equal(shown.observer.id, record.hcoord.observer);
  assert.equal(shown.implementor.id, record.hcoord.implementor);
  const listed = run.hcoord("watch", "list").value;
  assert.equal(listed.find((watch) => watch.target === record.hcoord.implementor).sasuRun.slug, "fixture", "watch list names the run");
  const status = run.sasu(["implement", "status"]);
  assert.ok(status.json.summary.some((line) => line.includes(`Supervision: hcoord run ${record.runInstanceId}; Observer ${record.hcoord.observer}, implementor ${record.hcoord.implementor}; watch every 7 min; recovery owner task-factory`)), status.text);
  const handoff = run.herdr.prompts().find((prompt) => prompt.target === IMPL_PANE);
  assert.match(handoff.text, /^ROLE: Implementor\./);
  assert.match(handoff.text, /HCOORD NOTICES: .*not an injection/);
  assert.match(handoff.text, /sasu implement block/);
  assert.equal(readIndex(path.join(run.home, ".sasu", "supervisor", "index.json")).entries.length, 0, "never enrolled with the legacy supervisor");
});

test("B3: a coordinator refusal after the implementor started is completed by --resume-handoff", async (t) => {
  // The Observer's terminal changes at the exact moment the implementor
  // starts, so preflight passed and registration then refuses.
  const run = await hcoordProject(t, { env: { HERDR_FAKE_ON_START_PATCH: JSON.stringify({ [OBSERVER_PANE]: { terminal_id: "term_elsewhere" } }) } });
  const failed = run.dispatch();
  assert.equal(failed.status, 1, failed.text);
  assert.match(failed.json.message, /identity_conflict/);
  const pending = run.state().pendingDispatch;
  assert.equal(pending.phase, "started", "the implementor's exact identity was recorded before registration");
  assert.equal(pending.implementor.paneId, IMPL_PANE);
  assert.equal(run.herdr.prompts().filter((prompt) => prompt.target === IMPL_PANE).length, 0, "no handoff was sent unregistered");
  run.herdr.patchAgent(OBSERVER_PANE, { terminal_id: "term_observer" });
  const resumed = run.sasu(["implement", "dispatch", "--resume-handoff"], { input: PACKET });
  assert.equal(resumed.status, 0, resumed.text);
  const record = run.state().supervision;
  assert.equal(run.state().pendingDispatch, null);
  assert.equal(run.hcoord("sasu", "show", "--run", record.runInstanceId).value.implementor.id, record.hcoord.implementor);
  const handoffs = run.herdr.prompts().filter((prompt) => prompt.target === IMPL_PANE);
  assert.equal(handoffs.length, 1);
  assert.match(handoffs[0].text, /HCOORD NOTICES/);
});
