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
async function hcoordProject(t, { observerName = "observer", observerReady, daemon = true, env: extraEnv = {} } = {}) {
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

/** A dispatched hcoord run whose implementor pane is idle, so answers can reach it. */
async function dispatchedRun(t, options = {}) {
  const run = await hcoordProject(t, options);
  const dispatched = run.dispatch();
  assert.equal(dispatched.status, 0, dispatched.text);
  run.herdr.patchAgent(IMPL_PANE, { agent_status: "idle", interactive_ready: true });
  const record = run.state().supervision;
  run.implementorEnv.SASU_RUN_INSTANCE_ID = record.runInstanceId;
  const implementor = (args) => run.sasu(["implement", ...args], { env: run.implementorEnv });
  const field = (text, name) => new RegExp(`^${name}: (\\S+)$`, "m").exec(text)?.[1];
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
  assert.match(notice.text, /^HCOORD_NOTICE\n/);
  assert.match(notice.text, new RegExp(`plan: ${path.join(run.root, "agents/runs/fixture/plan.md").replaceAll("/", "\\/")} \\(`));
  assert.match(notice.text, /No reply is needed/);
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
  assert.match(asked.text, /^HCOORD_REQUEST\n/);
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
  assert.match(notice.text, /^HCOORD_NOTICE\n/);
  assert.match(notice.text, /verification: NOT_RUN; no report generated/);
  assert.match(notice.text, /declares nothing/);

  await run.stopDaemon();
  const later = run.implementor(["report", "--summary", "all rows done"]);
  assert.equal(later.status, 0, later.text);
  assert.match(later.json.message, /waiting in the hcoord outbox/);
  assert.equal(run.noticesTo(OBSERVER_PANE).filter((prompt) => prompt.text.includes("all rows done")).length, 0);
  await run.startDaemon();
  await run.until(() => run.noticesTo(OBSERVER_PANE).find((prompt) => prompt.text.includes("summary: all rows done")), "the pending report after restart");

  assert.equal(run.hcoord("sasu", "end", "--run", run.record.runInstanceId, "--reason", "test").ok, true);
  fs.mkdirSync(path.join(run.root, "agents", "runs", "fixture"), { recursive: true });
  fs.writeFileSync(path.join(run.root, "agents", "runs", "fixture", "plan.md"), "# plan\n");
  const refused = run.implementor(["plan", "--path", "agents/runs/fixture/plan.md"]);
  assert.equal(refused.status, 1, refused.text);
  assert.match(refused.json.message, /Observer was not notified: .*ended/);
  assert.match(refused.json.message, /retry with `sasu implement plan --path agents\/runs\/fixture\/plan.md`/);
  assert.equal(run.state().events.filter((event) => event.kind === "plan").length, 1, "the Sasu record stays");
});

test("legacy runs keep OBSERVER_BLOCK: block and report refuse without an hcoord registration", async (t) => {
  const run = await hcoordProject(t);
  fs.rmSync(path.join(run.home, ".hcoord", "sasu-enabled"));
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
  const shown = run.hcoord("sasu", "show", "--run", run.record.runInstanceId).value;
  assert.notEqual(shown.observer.id, run.observerId);
  assert.equal(shown.watch.observer, shown.observer.id);
  assert.equal(run.state().supervision.hcoord.observer, shown.observer.id);
  assert.equal(run.state().supervision.observer.sessionId, "observer-two");
  const asked = await run.until(() => run.noticesTo(OBSERVER_PANE).find((prompt) => prompt.text.includes("SASU_BLOCK")), "the waiting question at the new Observer");
  assert.match(asked.text, new RegExp(`--as ${shown.observer.id}`));
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
  const old = run.hcoord("sasu", "show", "--run", first.runInstanceId).value;
  assert.match(old.endReason, new RegExp(`replaced by ${second.runInstanceId}`));
  assert.equal(old.watch.status, "stopped");
  const current = run.hcoord("sasu", "show", "--run", second.runInstanceId).value;
  assert.equal(current.replaces, first.runInstanceId);
  assert.equal(current.slug, "fixture");
  assert.equal(current.observer.id, first.hcoord.observer, "the same Observer participant");
  assert.equal(current.watch.status, "active");
});

test("B17: retiring an hcoord run stops its watch and cancels what it left open", async (t) => {
  const run = await dispatchedRun(t);
  const blocked = run.implementor(["block", "--kind", "runtime", "--question", "q", "--recommendation", "r", "--reversible", "yes", "--scope-impact", "none"]);
  assert.equal(blocked.status, 0, blocked.text);
  const retired = run.sasu(["implement", "retire", "--adopt", "test cleanup"]);
  assert.equal(retired.status, 0, retired.text);
  assert.match(retired.json.message, /hcoord watch ended/);
  const shown = run.hcoord("sasu", "show", "--run", run.record.runInstanceId).value;
  assert.equal(shown.endReason, "retired");
  assert.equal(shown.watch.status, "stopped");
  assert.equal(run.hcoord("request", "show", blocked.json.detail.hcoord.requestId).value.status, "canceled");
  assert.equal(run.hcoord("inbox").value.length, 0, "nothing of the retired run waits on anyone");
  const again = run.sasu(["implement", "retire"]);
  assert.equal(again.status, 0, again.text);
});

test("B4-B6, B18: a Sasu watch cycle names the digest, reminds once, reaches the inbox, and the digest and supervisor status show the coordinator's record", async (t) => {
  const run = await dispatchedRun(t);
  // A two-second cycle and short reminder bounds stand in for 15 and 30 minutes.
  assert.equal(run.hcoord("watch", "stop", run.implementorId, "--actor", "human").ok, true);
  assert.equal(run.hcoord("watch", "start", run.implementorId, "--observer", run.observerId, "--actor", "human", "--interval", "2s").ok, true);
  assert.equal(run.hcoord("config", "set", "--key", "remindMs", "--value", "3s").ok, true);
  assert.equal(run.hcoord("config", "set", "--key", "escalateMs", "--value", "6s").ok, true);
  const check = await run.until(() => run.noticesTo(OBSERVER_PANE).find((prompt) => prompt.text.startsWith("HCOORD_WATCH_CHECK")), "the first watch cycle");
  assert.match(check.text, /Sasu run: fixture; read sasu implement status --slug fixture --digest before the pane\./);
  const cycle = run.field(check.text, "cycle");
  await run.until(() => run.noticesTo(OBSERVER_PANE).filter((prompt) => prompt.text.includes(`cycle: ${cycle}`)).length >= 2, "one reminder for the unchecked cycle");
  await run.until(() => run.hcoord("inbox").value.find((item) => item.kind === "question"), "the unchecked cycle in the human inbox", 20_000);
  const open = run.sasu(["implement", "status", "--digest"]);
  assert.equal(open.status, 0, open.text);
  assert.ok(open.json.summary.some((line) => line.startsWith(`Supervision: hcoord run ${run.record.runInstanceId}; Observer ${run.observerId}, implementor ${run.implementorId}; watch active every 0 min; open cycle ${cycle}; last closed cycle never`)), open.text);
  assert.equal(run.hcoord("watch", "check", run.implementorId, "--cycle", cycle, "--actor", run.observerId).ok, true);
  const closed = run.sasu(["implement", "status", "--digest"]);
  assert.ok(closed.json.summary.some((line) => /last closed cycle 0m ago/.test(line)), closed.text);
  const supervisor = run.sasu(["supervisor", "status"]);
  assert.ok(supervisor.json.summary.some((line) => line.startsWith(`  fixture ${run.record.runInstanceId}: hcoord owns this run; Observer observer (${run.observerId}); implementor impl (${run.implementorId})`)), supervisor.text);
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
