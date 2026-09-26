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

// `hcoord daemon start` is macOS-only by design; elsewhere it refuses with unsupported_platform.
const MACOS_ONLY = { skip: process.platform !== "darwin" ? "hcoord daemon start is macOS-only" : false };

test("daemon start after a manual stop kickstarts the still-loaded label instead of failing its bootstrap", MACOS_ONLY, () => {
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

test("daemon start that reloads a changed plist waits for the bootout to settle before bootstrapping", MACOS_ONLY, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hcoord-launchd-"));
  const launchctl = installFakeLaunchctl(root);
  const home = path.join(root, "home");
  const plist = path.join(home, "Library", "LaunchAgents", "com.hcoord.daemon.plist");
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  // The live shape: the loaded label still runs another checkout's daemon.
  fs.writeFileSync(plist, "<plist><string>/elsewhere/cli/dist/hcoord/cli.js</string></plist>\n");
  fs.writeFileSync(launchctl.stateFile, JSON.stringify({ loaded: { "com.hcoord.daemon": plist } }));
  const env = { ...process.env, HOME: home, PATH: launchctl.env.PATH, LAUNCHCTL_FAKE_LOG: launchctl.log, LAUNCHCTL_FAKE_STATE: launchctl.stateFile, LAUNCHCTL_FAKE_BOOTOUT_SETTLE_PRINTS: "3" };
  delete env.HCOORD_HOME;
  const started = spawnSync(process.execPath, [HCOORD, "daemon", "start", "--json"], { env, encoding: "utf8" });
  assert.equal(started.status, 0, started.stdout + started.stderr);
  assert.equal(JSON.parse(started.stdout).ok, true);
  assert.deepEqual(launchctl.argv().map((args) => args[0]).filter((verb) => verb !== "print"), ["bootout", "bootstrap", "kickstart"]);
  assert.match(launchctl.state().loaded["com.hcoord.daemon"], /com\.hcoord\.daemon\.plist$/);
  assert.match(fs.readFileSync(plist, "utf8"), new RegExp(HCOORD.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the reloaded definition runs this build");
});

/**
 * A project with a started run, a fake herdr whose Observer pane is idle and
 * interactive-ready, and a daemon this test owns. `sasu enable` is on.
 */
async function hcoordProject(t, { observerName = "observer", observerReady, daemon = true, env: extraEnv = {} } = {}) {
  const root = fs.realpathSync(makeProject());
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({ worktree: { enabled: false } }));
  // Fakes and HOME live outside the project so the digest never sees their
  // logs, under a short name: beside a macOS temp project the daemon socket
  // path reached 114 bytes, past the 104-byte socket path limit, and every
  // coordinator call failed as a transport error.
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hc-")));
  const herdr = installFakeHerdr(outside);
  const launchctl = installFakeLaunchctl(outside);
  const home = path.join(outside, "home");
  fs.mkdirSync(home, { recursive: true });
  const base = { HOME: home, ...herdr.env, PATH: herdr.env.PATH, LAUNCHCTL_FAKE_LOG: launchctl.env.LAUNCHCTL_FAKE_LOG, LAUNCHCTL_FAKE_STATE: launchctl.env.LAUNCHCTL_FAKE_STATE, ...extraEnv };
  const observerEnv = { ...base, HERDR_ENV: "1", HERDR_PANE_ID: OBSERVER_PANE, HERDR_WORKSPACE_ID: "w4G", CLAUDE_SESSION_ID: OBSERVER };
  const implementorEnv = { ...base, HERDR_ENV: "1", HERDR_PANE_ID: IMPL_PANE, HERDR_WORKSPACE_ID: "w4G", CLAUDE_SESSION_ID: "impl-session", SASU_HERDR_ROLE: "implementor" };
  // The default Observer is hand-started, as in real use: Herdr 0.9.1 reports no interactive_ready for it (D-17).
  herdr.setAgents({ [OBSERVER_PANE]: { ...(observerName === null ? {} : { name: observerName }), ...(observerReady === undefined ? {} : { interactive_ready: observerReady }), agent: "claude", agent_status: "idle", pane_id: OBSERVER_PANE, terminal_id: "term_observer", agent_session: { value: OBSERVER }, tokens: { activity: String(Date.now()) }, state_change_seq: 1 } });
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
  fs.mkdirSync(path.join(home, ".sasu", "supervisor"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, ".sasu", "supervisor", "use-hcoord"), "test\n");
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

test("B3: dispatch refuses a stopped coordinator before any pane or agent exists", async (t) => {
  const stopped = await hcoordProject(t, { daemon: false });
  const refused = stopped.dispatch();
  assert.equal(refused.status, 1, refused.text);
  assert.match(refused.json.message, /daemon_down|not running/);
  assert.match(refused.json.message, /no legacy wake fallback/);
  assert.deepEqual(created(stopped.herdr), [], "nothing was created");
  assert.equal(stopped.state().pendingDispatch ?? null, null);
});

test("D-18: an unnamed Observer is registered under a name derived from its session, at dispatch and at handover, and its pane is never renamed", async (t) => {
  const run = await dispatchedRun(t, { observerName: null });
  assert.equal(run.hcoord("agent", "show", run.observerId).value.name, `observer-${OBSERVER.slice(0, 8)}`);
  const next = "7c1d2e3f-0000-4000-8000-00000000000b";
  run.herdr.patchAgent(OBSERVER_PANE, { agent_session: { value: next } });
  const handed = run.sasu(["supervisor", "handover", "--slug", "fixture", "--approval", "넘겨"], { env: { ...run.observerEnv, CLAUDE_SESSION_ID: next } });
  assert.equal(handed.status, 0, handed.text);
  assert.equal(run.hcoord("agent", "show", run.state().supervision.hcoord.observer).value.name, "observer-7c1d2e3f");
  assert.equal(run.herdr.argv().filter((args) => args[1] === "rename").length, 0, "the Observer's pane keeps no name");
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
  // D-19: hcoord holds only participants and relations; state.json names which ones make up the run.
  const shown = run.hcoord("agent", "show", record.hcoord.implementor).value;
  assert.equal(shown.parent, record.hcoord.observer);
  assert.equal(shown.watch.observer, record.hcoord.observer);
  assert.equal(shown.watch.intervalMs, 7 * 60_000);
  assert.equal(shown.watch.brief, "sasu implement status --slug fixture --digest (recovery owner task-factory)\n  -> verify PASS and PR merged: sasu implement retire --slug fixture\n  -> otherwise: close this cycle");
  assert.equal(run.hcoord("agent", "show", record.hcoord.observer).value.pane, OBSERVER_PANE);
  const status = run.sasu(["implement", "status"]);
  assert.ok(status.json.summary.some((line) => line.includes(`Supervision: hcoord run ${record.runInstanceId}; Observer ${record.hcoord.observer}, implementor ${record.hcoord.implementor}; watch every 7 min; recovery owner task-factory`)), status.text);
  const handoff = run.herdr.prompts().find((prompt) => prompt.target === IMPL_PANE);
  assert.match(handoff.text, /^ROLE: Implementor\./);
  assert.match(handoff.text, /HCOORD NOTICES: .*not an injection/);
  assert.match(handoff.text, /sasu implement block/);
  const index = readIndex(path.join(run.home, ".sasu", "supervisor", "index.json"));
  assert.equal(index.entries.length, 0, "never enrolled with the legacy supervisor");
  assert.deepEqual(index.coordinated.map((entry) => entry.runInstanceId), [record.runInstanceId], "listed as hcoord's");
});

test("B3: a coordinator refusal after the implementor started is completed by --resume-handoff", async (t) => {
  // Another session takes the Observer's pane at the exact moment the
  // implementor starts, so preflight passed and registration then refuses.
  const run = await hcoordProject(t, { env: { HERDR_FAKE_ON_START_PATCH: JSON.stringify({ [OBSERVER_PANE]: { agent_session: { value: "observer-elsewhere" } } }) } });
  const failed = run.dispatch();
  assert.equal(failed.status, 1, failed.text);
  assert.match(failed.json.message, /identity_conflict/);
  const pending = run.state().pendingDispatch;
  assert.equal(pending.phase, "started", "the implementor's exact identity was recorded before registration");
  assert.equal(pending.implementor.paneId, IMPL_PANE);
  assert.equal(run.herdr.prompts().filter((prompt) => prompt.target === IMPL_PANE).length, 0, "no handoff was sent unregistered");
  run.herdr.patchAgent(OBSERVER_PANE, { agent_session: { value: OBSERVER } });
  const resumed = run.sasu(["implement", "dispatch", "--resume-handoff"], { input: PACKET });
  assert.equal(resumed.status, 0, resumed.text);
  const record = run.state().supervision;
  assert.equal(run.state().pendingDispatch, null);
  assert.equal(run.hcoord("agent", "show", record.hcoord.implementor).value.watch.status, "active");
  const handoffs = run.herdr.prompts().filter((prompt) => prompt.target === IMPL_PANE);
  assert.equal(handoffs.length, 1);
  assert.match(handoffs[0].text, /HCOORD NOTICES/);
});

/** A dispatched hcoord run whose implementor pane is idle, so answers can reach it. */
async function dispatchedRun(t, options = {}) {
  const run = await hcoordProject(t, options);
  const dispatched = run.dispatch();
  assert.equal(dispatched.status, 0, dispatched.text);
  run.herdr.patchAgent(IMPL_PANE, { agent_status: "idle", interactive_ready: true });
  const record = run.state().supervision;
  run.implementorEnv.SASU_RUN_INSTANCE_ID = record.runInstanceId;
  const implementor = (args) => run.sasu(["implement", ...args], { env: run.implementorEnv });
  const field = (text, name) => (name === "request" ? /^HCOORD_\w+ (r_\S+)/ : /--delivery (d_\S+)/).exec(text)?.[1];
  return { ...run, record, implementor, field, observerId: record.hcoord.observer, implementorId: record.hcoord.implementor };
}

test("B7, B12: a registered plan reaches the Observer at once as a notice, and registering it again sends nothing twice", async (t) => {
  const run = await dispatchedRun(t);
  fs.mkdirSync(path.join(run.root, "agents", "runs", "fixture"), { recursive: true });
  fs.writeFileSync(path.join(run.root, "agents", "runs", "fixture", "plan.md"), "# plan\nstep 1\n");
  const first = run.implementor(["plan", "--path", "agents/runs/fixture/plan.md"]);
  assert.equal(first.status, 0, first.text);
  assert.match(first.json.message, /sent as hcoord request r_/);
  const notice = await run.until(() => run.noticesTo(OBSERVER_PANE).find((prompt) => prompt.text.includes("SASU_PLAN")), "the plan notice");
  assert.match(notice.text, /^HCOORD_NOTICE r_\S+ from \S+ \(a_\S+\)\nno reply needed\n/);
  assert.match(notice.text, new RegExp(`plan: ${path.join(run.root, "agents/runs/fixture/plan.md").replaceAll("/", "\\/")} \\(`));
  assert.doesNotMatch(notice.text, /request reply/, "a notice does not invite an answer");
  const again = run.implementor(["plan", "--path", "agents/runs/fixture/plan.md"]);
  assert.equal(again.status, 0, again.text);
  assert.equal(again.json.detail.hcoord.requestId, first.json.detail.hcoord.requestId, "the same plan is the same request");
  assert.equal(run.state().events.filter((event) => event.kind === "plan").length, 1, "and the same Sasu event");
  await wait(1500);
  assert.equal(run.noticesTo(OBSERVER_PANE).filter((prompt) => prompt.text.includes("SASU_PLAN")).length, 1);
});

test("B8, B9: a block asks the Observer, its answer reaches the implementor, and the acknowledgement is recorded", async (t) => {
  const run = await dispatchedRun(t);
  const blocked = run.implementor(["block", "--kind", "implementation", "--question", "Which retry bound?", "--recommendation", "3, matching the queue", "--reversible", "yes", "--scope-impact", "none"]);
  assert.equal(blocked.status, 0, blocked.text);
  assert.match(blocked.json.message, /end your turn now/);
  const asked = await run.until(() => run.noticesTo(OBSERVER_PANE).find((prompt) => prompt.text.includes("SASU_BLOCK")), "the block question");
  assert.match(asked.text, /^HCOORD_REQUEST r_\S+ from /);
  assert.match(asked.text, /question: Which retry bound\?\nrecommendation: 3, matching the queue\nreversible: yes\nscope_or_requirement_impact: none\nexternal_effect: none/);
  const requestId = run.field(asked.text, "request");
  assert.equal(run.hcoord("request", "reply", requestId, "--as", run.observerId, "--body", "3").ok, true);
  const answer = await run.until(() => run.noticesTo(IMPL_PANE).find((prompt) => prompt.text.startsWith("HCOORD_ANSWER")), "the answer at the implementor");
  assert.match(answer.text, /answer: 3/);
  assert.match(answer.text, new RegExp(`hcoord request ack ${requestId} --actor ${run.implementorId} --delivery d_`));
  assert.equal(run.hcoord("request", "ack", requestId, "--actor", run.implementorId, "--delivery", run.field(answer.text, "delivery")).ok, true);
  const shown = run.hcoord("request", "show", requestId).value;
  assert.equal(shown.respondent, run.observerId);
  assert.equal(shown.deliveries.find((delivery) => delivery.phase === "answer").status, "acknowledged");
  assert.equal(run.state().events.filter((event) => event.kind === "block").length, 1);
});

test("B10: a person's answer is recorded verbatim with the Observer as recorder, relayed, and acknowledged", async (t) => {
  const run = await dispatchedRun(t);
  const blocked = run.implementor(["block", "--kind", "product", "--question", "Drop the export button?", "--recommendation", "keep it", "--reversible", "no", "--scope-impact", "B4 changes"]);
  assert.equal(blocked.status, 0, blocked.text);
  const asked = await run.until(() => run.noticesTo(OBSERVER_PANE).find((prompt) => prompt.text.includes("SASU_BLOCK")), "the block question");
  const requestId = run.field(asked.text, "request");
  assert.equal(run.hcoord("request", "escalate", requestId, "--actor", run.observerId).ok, true);
  const words = "ㅇㅇ 유지해";
  assert.equal(run.hcoord("request", "reply", requestId, "--as", "human", "--recorded-by", run.observerId, "--body", words).ok, true);
  const toRelay = await run.until(() => run.noticesTo(OBSERVER_PANE).find((prompt) => prompt.text.startsWith("HCOORD_ANSWER")), "the recorded answer at the Observer");
  assert.match(toRelay.text, /hcoord request relay/);
  assert.equal(run.hcoord("request", "relay", requestId, "--actor", run.observerId, "--body", words).ok, true);
  const relayed = await run.until(() => run.noticesTo(IMPL_PANE).find((prompt) => prompt.text.startsWith("HCOORD_RELAY")), "the relay at the implementor");
  assert.match(relayed.text, new RegExp(words));
  assert.equal(run.hcoord("request", "ack", requestId, "--actor", run.implementorId, "--delivery", run.field(relayed.text, "delivery")).ok, true);
  const shown = run.hcoord("request", "show", requestId).value;
  assert.deepEqual({ respondent: shown.respondent, recordedBy: shown.recordedBy, answer: shown.answer, relay: shown.relayBody }, { respondent: "human", recordedBy: run.observerId, answer: words, relay: words });
  assert.equal(shown.deliveries.find((delivery) => delivery.phase === "relay").status, "acknowledged");
});

test("B11, B12: a report names the current verdict; a stopped daemon delivers it later; an ended run fails with the retry and keeps the Sasu record", async (t) => {
  const run = await dispatchedRun(t);
  const reported = run.implementor(["report"]);
  assert.equal(reported.status, 0, reported.text);
  const notice = await run.until(() => run.noticesTo(OBSERVER_PANE).find((prompt) => prompt.text.includes("SASU_REPORT")), "the report notice");
  assert.match(notice.text, /^HCOORD_NOTICE r_\S+ from \S+ \(a_\S+\)\nno reply needed\n/);
  assert.match(notice.text, /verification: NOT_RUN; no report generated/);
  assert.match(notice.text, /declares nothing/);

  await run.stopDaemon();
  const later = run.implementor(["report", "--summary", "all rows done"]);
  assert.equal(later.status, 0, later.text);
  assert.match(later.json.message, /waiting in the hcoord outbox/);
  assert.equal(run.noticesTo(OBSERVER_PANE).filter((prompt) => prompt.text.includes("all rows done")).length, 0);
  await run.startDaemon();
  await run.until(() => run.noticesTo(OBSERVER_PANE).find((prompt) => prompt.text.includes("summary: all rows done")), "the pending report after restart");

  // A refusal: the recorded Observer is not a participant hcoord knows.
  const saved = run.state();
  saved.supervision.hcoord.observer = "a_gone";
  fs.writeFileSync(path.join(run.root, STATE_PATH), `${JSON.stringify(saved, null, 2)}\n`);
  fs.mkdirSync(path.join(run.root, "agents", "runs", "fixture"), { recursive: true });
  fs.writeFileSync(path.join(run.root, "agents", "runs", "fixture", "plan.md"), "# plan\n");
  const refused = run.implementor(["plan", "--path", "agents/runs/fixture/plan.md"]);
  assert.equal(refused.status, 1, refused.text);
  assert.match(refused.json.message, /Observer was not notified: .*not_found/);
  assert.match(refused.json.message, /retry with `sasu implement plan --path agents\/runs\/fixture\/plan.md`/);
  assert.equal(run.state().events.filter((event) => event.kind === "plan").length, 1, "the Sasu record stays");
});

test("legacy runs keep OBSERVER_BLOCK: block and report refuse without an hcoord registration", async (t) => {
  const run = await hcoordProject(t);
  assert.equal(run.sasu(["supervisor", "use", "legacy"]).status, 0);
  const dispatched = run.dispatch();
  assert.equal(dispatched.status, 0, dispatched.text);
  assert.equal(run.state().supervision.coordinationOwner, "legacy");
  const blocked = run.sasu(["implement", "block", "--kind", "runtime", "--question", "q", "--recommendation", "r", "--reversible", "yes", "--scope-impact", "none"], { env: { ...run.implementorEnv, SASU_RUN_INSTANCE_ID: run.state().supervision.runInstanceId } });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.json.message, /emit the OBSERVER_BLOCK packet/);
  assert.doesNotMatch(run.herdr.prompts().find((prompt) => prompt.target === IMPL_PANE).text, /HCOORD NOTICES/, "a legacy handoff carries no hcoord forewarning");
});

test("B15: a new Observer session receives nothing until the handover, then gets the watch and the waiting question", async (t) => {
  const run = await dispatchedRun(t);
  // The Observer's session is replaced in the same pane under the same name.
  run.herdr.patchAgent(OBSERVER_PANE, { agent_session: { value: "observer-two" }, terminal_id: "term_observer_two" });
  const blocked = run.implementor(["block", "--kind", "runtime", "--question", "Is the daemon up?", "--recommendation", "check it", "--reversible", "yes", "--scope-impact", "none"]);
  assert.equal(blocked.status, 0, blocked.text);
  await wait(2500);
  assert.equal(run.noticesTo(OBSERVER_PANE).length, 0, "the old Observer's place receives nothing");
  const handed = run.sasu(["supervisor", "handover", "--slug", "fixture", "--approval", "넘겨"], { env: { ...run.observerEnv, CLAUDE_SESSION_ID: "observer-two" } });
  assert.equal(handed.status, 0, handed.text);
  const next = run.state().supervision.hcoord.observer;
  assert.notEqual(next, run.observerId);
  assert.equal(run.hcoord("agent", "show", run.implementorId).value.watch.observer, next, "watch assign moved the watch");
  assert.equal(run.state().supervision.observer.sessionId, "observer-two");
  const asked = await run.until(() => run.noticesTo(OBSERVER_PANE).find((prompt) => prompt.text.includes("SASU_BLOCK")), "the waiting question at the new Observer");
  assert.match(asked.text, new RegExp(`--as ${next}`));
  const again = run.sasu(["supervisor", "handover", "--slug", "fixture", "--approval", "넘겨"], { env: { ...run.observerEnv, CLAUDE_SESSION_ID: "observer-two" } });
  assert.equal(again.status, 0, again.text);
  assert.equal(run.hcoord("agent", "show", run.implementorId).value.watch.generation, 2, "a repeated handover finds the watch moved");
});

test("B14: a replacement dispatch registers the new implementor in the same run and stops watching the gone one", async (t) => {
  const run = await dispatchedRun(t);
  const first = run.record;
  const agents = JSON.parse(fs.readFileSync(run.herdr.agentsFile, "utf8"));
  delete agents[IMPL_PANE];
  run.herdr.setAgents(agents);
  const replaced = run.sasu(["implement", "dispatch", "--name", "impl2", "--prd", PRD_PATH, "--adopt", "implementor gone"], { env: { ...run.observerEnv, HERDR_FAKE_ON_START_PATCH: JSON.stringify({ [IMPL_PANE]: { agent_session: { value: "impl-two" }, terminal_id: "term_impl_two" } }) }, input: PACKET });
  assert.equal(replaced.status, 0, replaced.text);
  const second = run.state().supervision;
  assert.notEqual(second.runInstanceId, first.runInstanceId);
  assert.equal(run.hcoord("agent", "show", first.hcoord.implementor).value.watch.status, "stopped", "the gone implementor was ended");
  assert.notEqual(second.hcoord.implementor, first.hcoord.implementor);
  assert.equal(second.hcoord.observer, first.hcoord.observer, "the same Observer participant");
  const current = run.hcoord("agent", "show", second.hcoord.implementor).value;
  assert.equal(current.parent, first.hcoord.observer);
  assert.equal(current.watch.status, "active");
});

test("B17: retiring an hcoord run stops its watch and cancels what it left open", async (t) => {
  const run = await dispatchedRun(t);
  const blocked = run.implementor(["block", "--kind", "runtime", "--question", "q", "--recommendation", "r", "--reversible", "yes", "--scope-impact", "none"]);
  assert.equal(blocked.status, 0, blocked.text);
  const retired = run.sasu(["implement", "retire", "--adopt", "test cleanup"]);
  assert.equal(retired.status, 0, retired.text);
  assert.match(retired.json.message, /hcoord watch ended/);
  assert.equal(run.hcoord("agent", "show", run.implementorId).value.watch.status, "stopped");
  assert.equal(readIndex(path.join(run.home, ".sasu", "supervisor", "index.json")).coordinated.length, 0, "the retired run leaves the hcoord list");
  assert.equal(run.hcoord("request", "show", blocked.json.detail.hcoord.requestId).value.status, "canceled");
  assert.equal(run.hcoord("inbox").value.length, 0, "nothing of the retired run waits on anyone");
  const again = run.sasu(["implement", "retire"]);
  assert.equal(again.status, 0, again.text);
});

test("B4-B6, B18: a Sasu watch cycle names the digest, reminds once, reaches the inbox, and the digest and supervisor status show the coordinator's record", async (t) => {
  const run = await dispatchedRun(t);
  // A working implementor is patrolled every cycle; a resting one would get one check (D-20).
  run.herdr.patchAgent(IMPL_PANE, { agent_status: "working" });
  // A two-second cycle and short reminder bounds stand in for 15 and 30 minutes.
  assert.equal(run.hcoord("watch", "stop", run.implementorId, "--actor", "human").ok, true);
  assert.equal(run.hcoord("watch", "start", run.implementorId, "--observer", run.observerId, "--actor", "human", "--interval", "2s").ok, true);
  assert.equal(run.hcoord("config", "set", "--key", "remindMs", "--value", "3s").ok, true);
  assert.equal(run.hcoord("config", "set", "--key", "escalateMs", "--value", "6s").ok, true);
  const check = await run.until(() => run.noticesTo(OBSERVER_PANE).find((prompt) => prompt.text.startsWith("HCOORD_WATCH_CHECK")), "the first watch cycle");
  assert.match(check.text, /\nsasu implement status --slug fixture --digest \(recovery owner supervisor\)\n  -> verify PASS and PR merged: sasu implement retire --slug fixture\n/, "the brief rides on the check");
  const cycle = /cycle (c_\S+)/.exec(check.text)[1];
  await run.until(() => run.noticesTo(OBSERVER_PANE).filter((prompt) => prompt.text.includes(`cycle ${cycle}`)).length >= 2, "one reminder for the unchecked cycle");
  await run.until(() => run.hcoord("inbox").value.find((item) => item.kind === "question"), "the unchecked cycle in the human inbox", 20_000);
  const open = run.sasu(["implement", "status", "--digest"]);
  assert.equal(open.status, 0, open.text);
  assert.ok(open.json.summary.some((line) => line.startsWith(`Supervision: hcoord run ${run.record.runInstanceId}; Observer ${run.observerId}, implementor ${run.implementorId}; watch active every 0 min; open cycle ${cycle}; last closed cycle never`)), open.text);
  assert.equal(run.hcoord("watch", "check", run.implementorId, "--cycle", cycle, "--actor", run.observerId).ok, true);
  const closed = run.sasu(["implement", "status", "--digest"]);
  assert.ok(closed.json.summary.some((line) => /last closed cycle 0m ago/.test(line)), closed.text);
  const supervisor = run.sasu(["supervisor", "status"]);
  assert.ok(supervisor.json.summary.some((line) => line.startsWith(`  fixture ${run.record.runInstanceId}: hcoord owns this run; Observer ${run.observerId}; implementor impl (${run.implementorId})`)), supervisor.text);
});

test("B22: a hand-started Observer without a readiness flag is accepted, held while working or flagged false, and reached once idle", async (t) => {
  // Preflight and registration accept the idle, unflagged Observer.
  const run = await dispatchedRun(t);
  assert.equal(run.state().supervision.coordinationOwner, "hcoord");
  assert.equal("interactive_ready" in JSON.parse(fs.readFileSync(run.herdr.agentsFile, "utf8"))[OBSERVER_PANE], false, "the Observer carries no readiness flag");
  fs.mkdirSync(path.join(run.root, "agents", "runs", "fixture"), { recursive: true });
  const plan = (text) => { fs.writeFileSync(path.join(run.root, "agents", "runs", "fixture", "plan.md"), text); const sent = run.implementor(["plan", "--path", "agents/runs/fixture/plan.md"]); assert.equal(sent.status, 0, sent.text); return sent.json.detail.hcoord.requestId; };
  const delivered = (requestId) => run.hcoord("request", "show", requestId).value.deliveries.find((delivery) => delivery.recipient === run.observerId);

  run.herdr.patchAgent(OBSERVER_PANE, { agent_status: "working" });
  const whileWorking = plan("# plan one\n");
  await run.until(() => delivered(whileWorking)?.status === "deferred", "the notice held while the Observer works");
  run.herdr.patchAgent(OBSERVER_PANE, { agent_status: "idle" });
  await run.until(() => delivered(whileWorking)?.status === "accepted", "the notice delivered once the Observer is idle");

  run.herdr.patchAgent(OBSERVER_PANE, { interactive_ready: false });
  const flaggedFalse = plan("# plan two\n");
  await run.until(() => delivered(flaggedFalse)?.status === "deferred", "the notice held while Herdr reports not ready");
  assert.match(delivered(flaggedFalse).reason, /not interactive-ready/);
  run.herdr.patchAgent(OBSERVER_PANE, { agent_status: "done", interactive_ready: true });
  await run.until(() => delivered(flaggedFalse)?.status === "accepted", "the notice delivered once Herdr reports ready");
});

test("B23: a rotated terminal with a cleared name stays the same participant; another session, another pane, or a sessionless rotation holds", async (t) => {
  const run = await dispatchedRun(t);
  fs.mkdirSync(path.join(run.root, "agents", "runs", "fixture"), { recursive: true });
  const plan = (text) => { fs.writeFileSync(path.join(run.root, "agents", "runs", "fixture", "plan.md"), text); const sent = run.implementor(["plan", "--path", "agents/runs/fixture/plan.md"]); assert.equal(sent.status, 0, sent.text); return sent.json.detail.hcoord.requestId; };
  const delivered = (requestId) => run.hcoord("request", "show", requestId).value.deliveries.find((delivery) => delivery.recipient === run.observerId);
  const agents = () => JSON.parse(fs.readFileSync(run.herdr.agentsFile, "utf8"));
  const { name: _cleared, ...observer } = agents()[OBSERVER_PANE];

  // A Herdr restart: the same pane and session under a new terminal, with its name cleared.
  run.herdr.setAgents({ ...agents(), [OBSERVER_PANE]: { ...observer, terminal_id: "term_observer_rotated" } });
  const rotated = plan("# plan one\n");
  await run.until(() => delivered(rotated)?.status === "accepted", "the notice at the rotated, unnamed Observer");
  // Registering that execution again, under a name Herdr now reports, is the same participant.
  run.herdr.patchAgent(OBSERVER_PANE, { name: "observer-renamed" });
  const again = run.hcoord("agent", "register", "--machine", "local", "--session", OBSERVER, "--instance", "term_observer_rotated", "--pane", OBSERVER_PANE, "--name", "observer-renamed");
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.value.id, run.observerId);

  // Another session in the recorded pane holds.
  run.herdr.patchAgent(OBSERVER_PANE, { agent_session: { value: "someone-else" } });
  const otherSession = plan("# plan two\n");
  await run.until(() => delivered(otherSession)?.status === "deferred", "the notice held for another session in the pane");
  assert.match(delivered(otherSession).reason, /execution identity changed/);

  // The same session in another pane holds; the recorded pane is gone.
  const { [OBSERVER_PANE]: _moved, ...rest } = agents();
  run.herdr.setAgents({ ...rest, "w4G:p99": { ...observer, pane_id: "w4G:p99", terminal_id: "term_observer_rotated" } });
  const otherPane = plan("# plan three\n");
  await run.until(() => delivered(otherPane)?.status === "deferred", "the notice held for the session in another pane");

  // An execution Herdr reports without a session is matched by terminal: a rotated one holds.
  const { agent_session: _none, ...sessionless } = observer;
  run.herdr.setAgents({ ...rest, [OBSERVER_PANE]: { ...sessionless, terminal_id: "term_observer_third" } });
  const noSession = plan("# plan four\n");
  await run.until(() => delivered(noSession)?.status === "deferred", "the notice held for a sessionless rotated terminal");
  assert.match(delivered(noSession).reason, /execution identity changed/);
  // The terminal recorded by the latest registration identifies it, and the held notices go out.
  run.herdr.setAgents({ ...rest, [OBSERVER_PANE]: { ...sessionless, terminal_id: "term_observer_rotated" } });
  for (const held of [otherSession, otherPane, noSession]) await run.until(() => delivered(held)?.status === "accepted", "a held notice once the recorded terminal returns");
});

test("B27: migrate-hcoord records participant IDs found by pane and session, and reports a run it cannot match", async (t) => {
  const run = await dispatchedRun(t);
  const statePath = path.join(run.root, STATE_PATH);
  const rewrite = (change) => { const saved = run.state(); change(saved.supervision); fs.writeFileSync(statePath, `${JSON.stringify(saved, null, 2)}\n`); };
  // A run registered before state.json recorded its participants.
  rewrite((supervision) => { delete supervision.hcoord; });
  const migrated = run.sasu(["supervisor", "migrate-hcoord", "--state", statePath]);
  assert.equal(migrated.status, 0, migrated.text);
  assert.deepEqual([run.state().supervision.hcoord.observer, run.state().supervision.hcoord.implementor], [run.observerId, run.implementorId]);
  assert.equal(migrated.json.detail.runs[0].outcome, "recorded");
  const again = run.sasu(["supervisor", "migrate-hcoord", "--state", statePath]);
  assert.equal(again.json.detail.runs[0].outcome, "unchanged");
  rewrite((supervision) => { delete supervision.hcoord; supervision.implementor.paneId = "w4G:p77"; });
  const unmatched = run.sasu(["supervisor", "migrate-hcoord", "--state", statePath]);
  assert.equal(unmatched.status, 1, unmatched.text);
  assert.match(unmatched.json.detail.runs[0].reason, /implementor: no registered participant in pane w4G:p77/);
  assert.equal(run.state().supervision.hcoord, undefined, "an unmatched run is left as it was");
});

test("B27, D-18: migrate-hcoord records a run whose Observer has duplicate records, and names the handover when its watch moved to another Observer", async (t) => {
  const run = await dispatchedRun(t);
  const statePath = path.join(run.root, STATE_PATH);
  const saved = run.state(); delete saved.supervision.hcoord; fs.writeFileSync(statePath, `${JSON.stringify(saved, null, 2)}\n`);
  // The live shape: the recorded Observer's one execution has two records from
  // before D-18, and its watch was assigned to a new Observer outside Sasu.
  const next = "5e6f7a8b-0000-4000-8000-00000000000c", nextPane = "w4G:p20";
  run.herdr.patchAgent(nextPane, { agent: "claude", agent_status: "idle", pane_id: nextPane, terminal_id: "term_next", agent_session: { value: next }, tokens: { activity: String(Date.now()) }, state_change_seq: 1 });
  const newObserver = run.hcoord("agent", "register", "--machine", "local", "--session", next, "--instance", "term_next", "--pane", nextPane, "--name", "observer-next");
  assert.equal(newObserver.ok, true, JSON.stringify(newObserver));
  const watch = run.hcoord("agent", "show", run.implementorId).value.watch;
  assert.equal(run.hcoord("watch", "assign", run.implementorId, "--observer", newObserver.value.id, "--actor", "human", "--expected-generation", String(watch.generation)).ok, true);
  await run.stopDaemon();
  const ledgerPath = path.join(run.home, ".hcoord", "ledger.json");
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  ledger.participants.a_duplicate = { ...ledger.participants[run.observerId], id: "a_duplicate", instance: "term_before_restart", name: "observer-before-restart" };
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
  await run.startDaemon();

  const migrated = run.sasu(["supervisor", "migrate-hcoord", "--state", statePath]);
  assert.equal(migrated.status, 0, migrated.text);
  const outcome = migrated.json.detail.runs[0];
  assert.equal(outcome.outcome, "recorded");
  assert.ok([run.observerId, "a_duplicate"].includes(run.state().supervision.hcoord.observer), "one record of the recorded Observer's execution");
  assert.equal(run.state().supervision.hcoord.implementor, run.implementorId);
  assert.match(outcome.note, new RegExp(`watch is observed by .*${nextPane}.*sasu supervisor handover`));

  const handed = run.sasu(["supervisor", "handover", "--slug", "fixture", "--approval", "넘겨"], { env: { ...run.observerEnv, HERDR_PANE_ID: nextPane, CLAUDE_SESSION_ID: next } });
  assert.equal(handed.status, 0, handed.text);
  assert.equal(run.state().supervision.observer.paneId, nextPane);
  assert.equal(run.state().supervision.hcoord.observer, newObserver.value.id);
});
