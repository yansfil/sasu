// The supervisor at the real CLI boundary: a run started and dispatched by
// sasu, ticks run as launchd would run them, a fake herdr on PATH scripted
// between ticks, a fake launchctl, and an isolated HOME for the index. No
// live pane, no real launchd domain (B20).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

import { CLI, git, isolatedEnv, makeProject, PRD_PATH, STATE_PATH } from "../helpers/implement-fixture.mjs";
import { installFakeHerdr, installFakeLaunchctl } from "../helpers/fake-herdr.mjs";
import { readIndex, updateIndex } from "../../dist/supervisor/index.js";
import { launchdLogPath } from "../../dist/supervisor/paths.js";
import { LOG_CAP_BYTES } from "../../dist/supervisor/tick.js";

const OBSERVER = "0b5e7e1e-0000-4000-8000-00000000000a";
const OBSERVER_PANE = "w4G:p12";
const IMPL_PANE = "w4G:p13";
const PACKET = "ROLE: Implementor.\nPIPELINE: implement\nSOURCE: fixture\nRETURN CONTRACT: status";
const STOP_HOOK = path.resolve(import.meta.dirname, "../../../scripts/supervisor_stop.mjs");

function sasu(cwd, args, { env = {}, input } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args, "--json"], { cwd, encoding: "utf8", env: isolatedEnv(env), input, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  let json;
  try { json = JSON.parse(result.stdout); } catch { json = { stdout: result.stdout, stderr: result.stderr }; }
  return { ...result, json, text: result.stdout + result.stderr };
}

const state = (root) => JSON.parse(fs.readFileSync(path.join(root, STATE_PATH), "utf8"));
const activity = (secondsAgo) => String(Date.now() - secondsAgo * 1000);
const observerAgent = (fields = {}) => ({ agent: "claude", agent_status: "idle", pane_id: OBSERVER_PANE, terminal_id: "term_observer", agent_session: { value: OBSERVER }, tokens: { activity: activity(120) }, state_change_seq: 1, ...fields });
const implAgent = (fields = {}) => ({ name: "impl", agent: "claude", agent_status: "working", pane_id: IMPL_PANE, terminal_id: "term_impl", agent_session: { value: "impl-session" }, tokens: { activity: activity(120) }, state_change_seq: 5, ...fields });

/** A project, a started run, and a dispatched implementor, all through the CLI against the fake herdr. */
function dispatchedRun(extraDispatchArgs = []) {
  const root = fs.realpathSync(makeProject());
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({ worktree: { enabled: false } }));
  // Fakes and HOME live beside the project, never inside it: the digest
  // measures the project's git tree and must not see the fakes' logs.
  const outside = fs.mkdtempSync(`${root}-fakes-`);
  const herdr = installFakeHerdr(outside);
  const launchctl = installFakeLaunchctl(outside);
  const home = path.join(outside, "home");
  fs.mkdirSync(home, { recursive: true });
  const base = { HOME: home, ...herdr.env, PATH: herdr.env.PATH, LAUNCHCTL_FAKE_LOG: launchctl.env.LAUNCHCTL_FAKE_LOG, LAUNCHCTL_FAKE_STATE: launchctl.env.LAUNCHCTL_FAKE_STATE };
  const observerEnv = { ...base, HERDR_ENV: "1", HERDR_PANE_ID: OBSERVER_PANE, HERDR_WORKSPACE_ID: "w4G", HERDR_SOCKET_PATH: "/tmp/fake.sock", CLAUDE_SESSION_ID: OBSERVER };
  herdr.setAgents({ [OBSERVER_PANE]: observerAgent({ agent_status: "working" }) });
  const started = sasu(root, ["implement", "start", "--prd", PRD_PATH, "--dirty-attribution", "run-owned"], { env: observerEnv });
  assert.equal(started.status, 0, started.text);
  const dispatched = sasu(root, ["implement", "dispatch", "--name", "impl", "--prd", PRD_PATH, ...extraDispatchArgs], { env: observerEnv, input: PACKET });
  assert.equal(dispatched.status, 0, dispatched.text);
  const indexFile = path.join(home, ".sasu", "supervisor", "index.json");
  const tick = () => sasu(home, ["supervisor", "tick"], { env: base });
  /** Wakes only: the dispatch's own handoff prompt is not one. */
  const wakes = () => herdr.prompts().filter((prompt) => prompt.text.startsWith("SASU_WAKE"));
  return { root, home, herdr, launchctl, base, observerEnv, indexFile, tick, wakes, statePath: path.join(root, STATE_PATH), runInstanceId: dispatched.json.detail.runInstanceId, index: () => readIndex(indexFile) };
}

test("B1/B5/B8/B17: a dispatched run is indexed at once, a working implementor wakes nobody, a settled one wakes the Observer exactly once, and status shows it", () => {
  const run = dispatchedRun();
  assert.deepEqual(run.index().entries.map((entry) => [entry.statePath, entry.runInstanceId]), [[run.statePath, run.runInstanceId]]);

  run.herdr.setAgents({ [OBSERVER_PANE]: observerAgent(), [IMPL_PANE]: implAgent({ agent_status: "working" }) });
  const quiet = run.tick();
  assert.equal(quiet.status, 0, quiet.text);
  assert.deepEqual(quiet.json.detail.runs.map((entry) => entry.action), ["none"]);
  assert.equal(run.wakes().length, 0, "B5: working and nothing due means no Observer turn");

  run.herdr.setAgents({ [OBSERVER_PANE]: observerAgent(), [IMPL_PANE]: implAgent({ agent_status: "idle", tokens: { activity: activity(90) } }) });
  const woke = run.tick();
  assert.deepEqual(woke.json.detail.runs.map((entry) => [entry.action, entry.due]), [["sent", ["settled"]]]);
  const prompts = run.wakes();
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].target, OBSERVER_PANE);
  assert.equal(prompts[0].guard, null, "herdr 0.9.1 offers no input_guard, so the session-match path is used");
  assert.match(prompts[0].text, /^SASU_WAKE\n/);
  assert.match(prompts[0].text, new RegExp(`observer: ${OBSERVER}\nrun: fixture instance ${run.runInstanceId}\nreason: settled`));

  assert.equal(run.tick().json.detail.runs[0].action, "none");
  assert.equal(run.wakes().length, 1, "one wake per settled episode");

  const status = sasu(run.home, ["supervisor", "status"], { env: run.base });
  assert.equal(status.status, 1, "status exit reflects the missing scheduler even though detail remains readable");
  const shown = status.json.detail.runs[0];
  assert.deepEqual({ slug: shown.slug, instance: shown.runInstanceId, reasons: shown.lastWake.reasons, outcome: shown.lastWake.outcome, path: shown.wakePath, stale: shown.stale }, { slug: "fixture", instance: run.runInstanceId, reasons: ["settled"], outcome: "accepted", path: "session-match", stale: false });
  assert.equal(status.json.detail.guardedPrompt.supported, false, "the installed (fake 0.9.1) herdr offers no guard");
  assert.ok(typeof status.json.detail.lastTickAt === "string");
  assert.doesNotMatch(JSON.stringify(status.json), /SASU_WAKE|ROLE: Implementor/, "no prompt bodies or transcripts in status (D-14)");
  assert.match(status.json.summary.join("\n"), /LaunchAgent: NOT installed/);
});

test("P2 health and resource bounds: quiet ticks stay silent, rotate launchd output, and report current failures", () => {
  const run = dispatchedRun();
  run.herdr.setAgents({ [OBSERVER_PANE]: observerAgent(), [IMPL_PANE]: implAgent() });
  assert.equal(sasu(run.home, ["supervisor", "install"], { env: run.base }).status, 0);
  const log = launchdLogPath({ HOME: run.home });
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, Buffer.alloc(LOG_CAP_BYTES, 120));

  const quiet = spawnSync(process.execPath, [CLI, "supervisor", "tick", "--quiet"], { cwd: run.home, env: isolatedEnv(run.base), encoding: "utf8", timeout: 60_000 });
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(quiet.stdout, "");
  assert.equal(quiet.stderr, "");
  assert.equal(fs.statSync(`${log}.1`).size, LOG_CAP_BYTES, "the full launchd sink is rotated before the tick");
  assert.equal(sasu(run.home, ["supervisor", "status"], { env: run.base }).status, 0, "installed, recent and observable is healthy");

  const unavailable = spawnSync(process.execPath, [CLI, "supervisor", "tick", "--quiet"], { cwd: run.home, env: isolatedEnv({ ...run.base, HERDR_FAKE_DOWN: "1" }), encoding: "utf8", timeout: 60_000 });
  assert.equal(unavailable.status, 1);
  assert.equal(unavailable.stdout, "");
  assert.match(unavailable.stderr, /FAIL.*herdr unavailable/);
  const failedStatus = sasu(run.home, ["supervisor", "status"], { env: run.base });
  assert.equal(failedStatus.status, 1);
  assert.match(failedStatus.json.detail.healthProblems.join("\n"), /could not observe herdr|current failure/);

  assert.equal(run.tick().status, 0, "a healthy observation clears the current failure");
  assert.equal(sasu(run.home, ["supervisor", "status"], { env: run.base }).status, 0);
  updateIndex(run.indexFile, (index) => { index.lastTickAt = "2020-01-01T00:00:00.000Z"; });
  const stale = sasu(run.home, ["supervisor", "status"], { env: run.base });
  assert.equal(stale.status, 1);
  assert.match(stale.json.detail.healthProblems.join("\n"), /last tick is .* seconds old/);
});

test("D-15/B18: status and the digest name the loop that owns Observer recovery, and the tick still wakes only the recorded Observer for a factory run", () => {
  const run = dispatchedRun(["--recovery-owner", "task-factory"]);
  assert.equal(state(run.root).supervision.recoveryOwner, "task-factory");
  const status = sasu(run.home, ["supervisor", "status"], { env: run.base });
  assert.equal(status.status, 1, "an enrolled run with no scheduler and no tick is unhealthy");
  assert.equal(status.json.detail.runs[0].recoveryOwner, "task-factory");
  assert.match(status.json.summary.join("\n"), /fixture .*: recovery owner task-factory;/);
  run.herdr.setAgents({ [OBSERVER_PANE]: observerAgent(), [IMPL_PANE]: implAgent() });
  const digest = sasu(run.root, ["implement", "status", "--slug", "fixture", "--digest"], { env: run.observerEnv });
  assert.equal(digest.status, 0, digest.text);
  assert.equal(digest.json.detail.digest.recoveryOwner, "task-factory");
  assert.match(digest.json.summary.join("\n"), /; recovery owner task-factory$/m);
  // The owner changes who replaces a vanished Observer, never who is woken.
  run.herdr.setAgents({ [OBSERVER_PANE]: observerAgent({ agent_session: { value: "replacement-session" } }), [IMPL_PANE]: implAgent({ agent_status: "blocked" }) });
  const tick = run.tick();
  assert.equal(tick.json.detail.runs[0].action, "deferred");
  assert.equal(run.wakes().length, 0, "a factory-owned run still sends nothing to a replacement session");
});

test("B9/B18: after the Observer's session is replaced no input reaches the pane, status says observer-gone, and an explicit handover resumes wakes to the new session", () => {
  const run = dispatchedRun();
  run.herdr.setAgents({ [OBSERVER_PANE]: observerAgent({ agent_session: { value: "replacement-session" } }), [IMPL_PANE]: implAgent({ agent_status: "blocked" }) });
  const deferred = run.tick();
  assert.deepEqual(deferred.json.detail.runs.map((entry) => [entry.action, entry.due]), [["deferred", ["blocked"]]]);
  assert.equal(run.wakes().length, 0);
  const status = sasu(run.home, ["supervisor", "status"], { env: run.base });
  assert.match(status.json.detail.runs[0].lastObservation.observer, /^observer-gone/);
  assert.equal(status.json.detail.runs[0].stale, true);

  // Same pane, same name, same cwd: still a stranger until a person says otherwise.
  assert.equal(run.tick().json.detail.runs[0].action, "deferred");

  const fromImplementor = sasu(run.root, ["supervisor", "handover", "--slug", "fixture", "--approval", "user: take over"], { env: { ...run.observerEnv, SASU_HERDR_ROLE: "implementor", CLAUDE_SESSION_ID: "replacement-session" } });
  assert.notEqual(fromImplementor.status, 0);
  assert.match(fromImplementor.text, /marked implementor pane cannot become the Observer/);
  const noApproval = sasu(run.root, ["supervisor", "handover", "--slug", "fixture"], { env: { ...run.observerEnv, CLAUDE_SESSION_ID: "replacement-session" } });
  assert.match(noApproval.text, /requires --approval/);

  const handed = sasu(run.root, ["supervisor", "handover", "--slug", "fixture", "--approval", "user: 새 세션이 이어받아"], { env: { ...run.observerEnv, CLAUDE_SESSION_ID: "replacement-session" } });
  assert.equal(handed.status, 0, handed.text);
  const recorded = state(run.root).supervision;
  assert.equal(recorded.observer.sessionId, "replacement-session");
  assert.equal(recorded.handovers.length, 1);
  assert.equal(recorded.handovers[0].from.sessionId, OBSERVER);
  assert.equal(recorded.handovers[0].approval, "user: 새 세션이 이어받아");
  assert.equal(state(run.root).events.at(-1).kind, "handover");

  const delivered = run.tick();
  assert.equal(delivered.json.detail.runs[0].action, "sent");
  assert.equal(run.wakes().length, 1);
  assert.match(run.wakes()[0].text, /observer: replacement-session/);
});

test("B15: retiring the run wakes the Observer once with reason terminal and removes it from the index; a later tick sees nothing", () => {
  const run = dispatchedRun();
  run.herdr.setAgents({ [OBSERVER_PANE]: observerAgent(), [IMPL_PANE]: implAgent() });
  const retired = sasu(run.root, ["implement", "retire", "--slug", "fixture", "--issuer", "human"], { env: { ...run.observerEnv, CLAUDE_SESSION_ID: "someone", SASU_HERDR_ROLE: "implementor", SASU_RUN_INSTANCE_ID: run.runInstanceId } });
  assert.equal(retired.status, 0, retired.text);
  const woke = run.tick();
  assert.deepEqual(woke.json.detail.runs.map((entry) => [entry.action, entry.due]), [["sent", ["terminal"]]]);
  assert.match(run.wakes()[0].text, /reason: terminal/);
  assert.equal(run.index().entries.length, 0);
  assert.match(run.index().removed[0].cause, /run retired; terminal wake accepted/);
  assert.equal(run.tick().json.detail.runs.length, 0);
  assert.equal(run.wakes().length, 1);
});

test("B3/D-09: a tick killed after the prompt effect but before persistence duplicates at most once and then converges", async () => {
  const run = dispatchedRun();
  run.herdr.setAgents({ [OBSERVER_PANE]: observerAgent(), [IMPL_PANE]: implAgent({ agent_status: "blocked" }) });
  const ready = path.join(path.dirname(run.indexFile), "prompt-effect.ready");
  const release = path.join(path.dirname(run.indexFile), "prompt-effect.release");
  const env = isolatedEnv({ ...run.base, HERDR_FAKE_PROMPT_BARRIER_READY: ready, HERDR_FAKE_PROMPT_BARRIER_RELEASE: release });
  const child = spawn(process.execPath, [CLI, "supervisor", "tick", "--json"], { cwd: run.home, env, stdio: "ignore", detached: true });
  const closed = new Promise((resolve) => child.once("close", resolve));
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fs.existsSync(ready), true, "the fake herdr reached the exact post-effect barrier");
  process.kill(-child.pid, "SIGKILL");
  await closed;

  // The prompt effect happened, while the immutable index stayed parseable
  // at its prior revision and contains no acknowledgment for the episode.
  assert.equal(run.wakes().length, 1);
  assert.doesNotThrow(() => run.index());
  assert.equal(fs.readdirSync(path.dirname(run.indexFile)).filter((name) => name.endsWith(".tmp")).length, 0, "the interrupted tick leaves no half-written index");
  const settled = run.tick();
  assert.equal(settled.status, 0, settled.text);
  const prompts = run.wakes();
  assert.equal(prompts.length, 2, "the uncertain prompt is retried exactly once");
  const converged = run.tick();
  assert.equal(converged.json.detail.runs[0].action, "none");
  assert.equal(run.wakes().length, 2, "once recorded, the episode is never resent");
  const entry = run.index().entries[0];
  assert.deepEqual({ reasons: entry.lastWake.reasons, outcome: entry.lastWake.outcome }, { reasons: ["blocked"], outcome: "accepted" });
  assert.equal(prompts.every((prompt) => prompt.target === OBSERVER_PANE), true, "every duplicate went to the same verified Observer");
});

test("B10/B16: status --digest is deterministic on a fixture history, reads only for the recorded Observer, and carries no judgment", () => {
  const run = dispatchedRun();
  run.herdr.setAgents({ [OBSERVER_PANE]: observerAgent(), [IMPL_PANE]: implAgent() });
  fs.writeFileSync(path.join(run.root, "feature.txt"), "one\ntwo\nthree\n");
  fs.writeFileSync(path.join(run.root, "suite.cjs"), "process.exit(0);\n");
  git(run.root, ["add", "feature.txt", "suite.cjs"]);
  git(run.root, ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "Add feature"]);
  fs.writeFileSync(path.join(run.root, "feature.txt"), "one\ntwo\nthree\nfour\n");
  fs.mkdirSync(path.join(run.root, "agents", "scratch"), { recursive: true });
  fs.writeFileSync(path.join(run.root, "agents", "scratch", "note.txt"), "x\n");

  const first = sasu(run.root, ["implement", "status", "--slug", "fixture", "--digest"], { env: run.observerEnv });
  assert.equal(first.status, 0, first.text);
  const second = sasu(run.root, ["implement", "status", "--slug", "fixture", "--digest"], { env: run.observerEnv });
  const strip = ({ generatedAt, ...rest }) => rest;
  assert.deepEqual(strip(first.json.detail.digest), strip(second.json.detail.digest), "same input, same output");

  const digest = first.json.detail.digest;
  assert.equal(digest.dispatchHead, state(run.root).supervision.dispatchHead);
  assert.equal(digest.git.commitsSinceDispatch, 1);
  assert.equal(digest.git.recentCommits[0].subject, "Add feature");
  assert.deepEqual(digest.git.churn.map((entry) => entry.path), ["feature.txt", "suite.cjs"], "highest churn first");
  assert.deepEqual(digest.git.churn[0], { path: "feature.txt", added: 4, deleted: 0 }, "committed plus uncommitted lines since the dispatch head");
  assert.equal(digest.git.uncommitted.files, 1);
  assert.deepEqual(digest.git.outsideBoundary, [], "agents/ is ignored by git and never enters the diff");
  assert.equal(digest.implementor.status, "working");
  assert.equal(digest.verify.attempts, 0);
  assert.equal(digest.events.sinceDispatch, 1, "the dispatch event itself");
  const text = first.json.summary.join("\n");
  assert.match(text, /Commits since dispatch: 1; recent: [0-9a-f]{7} Add feature/);
  assert.match(text, /Changed since dispatch: 2 file\(s\), \+5 -1; outside delivery boundary: 0/);
  assert.match(text, /Uncommitted: 1 path\(s\)/);
  assert.doesNotMatch(text, /stuck|wandering|fine|should|looks/i, "facts only, no judgment words (D-11)");

  const stranger = sasu(run.root, ["implement", "status", "--slug", "fixture", "--digest"], { env: { ...run.observerEnv, CLAUDE_SESSION_ID: "someone-else" } });
  assert.notEqual(stranger.status, 0);
  assert.match(stranger.text, /digest refused: run 'fixture' is observed by session/);
  assert.match(stranger.text, /nothing was changed/);
  const wrongInstance = sasu(run.root, ["implement", "status", "--state", run.statePath, "--instance", "different-instance", "--observer", OBSERVER, "--digest"], { env: run.observerEnv });
  assert.notEqual(wrongInstance.status, 0);
  assert.match(wrongInstance.text, /digest refused: expected run instance different-instance/);
  const wrongObserver = sasu(run.root, ["implement", "status", "--state", run.statePath, "--instance", run.runInstanceId, "--observer", "different-observer", "--digest"], { env: run.observerEnv });
  assert.notEqual(wrongObserver.status, 0);
  assert.match(wrongObserver.text, /digest refused: expected Observer different-observer/);
  const sameSlugRoot = fs.realpathSync(makeProject());
  const sameSlugOwner = "same-slug-owner";
  assert.equal(sasu(sameSlugRoot, ["implement", "start", "--prd", PRD_PATH, "--dirty-attribution", "run-owned"], { env: { CLAUDE_SESSION_ID: sameSlugOwner } }).status, 0);
  const exactFromOtherRepository = sasu(sameSlugRoot, ["implement", "status", "--state", run.statePath, "--instance", run.runInstanceId, "--observer", OBSERVER, "--digest"], { env: { CLAUDE_SESSION_ID: OBSERVER } });
  assert.equal(exactFromOtherRepository.status, 0, exactFromOtherRepository.text);
  const wrongSameSlugOwner = sasu(sameSlugRoot, ["implement", "status", "--state", run.statePath, "--instance", run.runInstanceId, "--observer", OBSERVER, "--digest"], { env: { CLAUDE_SESSION_ID: sameSlugOwner } });
  assert.notEqual(wrongSameSlugOwner.status, 0);
  assert.match(wrongSameSlugOwner.text, /is observed by session/);
  const plain = sasu(run.root, ["implement", "status", "--slug", "fixture"], { env: { ...run.observerEnv, CLAUDE_SESSION_ID: "someone-else" } });
  assert.equal(plain.status, 0, "the ordinary status stays open");
  assert.equal(plain.json.detail.supervision.runInstanceId, run.runInstanceId);
});

test("B13: the Stop hook exits 0 and creates nothing for a marked session, a session outside Herdr, an unknown session, and only kicks the tick for the recorded Observer", () => {
  const run = dispatchedRun();
  const hook = (payload, env) => spawnSync(process.execPath, [STOP_HOOK], { encoding: "utf8", input: JSON.stringify(payload), env: isolatedEnv({ ...run.base, ...env }), timeout: 30_000 });
  const log = () => { const file = path.join(run.home, ".sasu", "supervisor", "stop-hook.log"); return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []; };
  const launchctlCalls = () => run.launchctl.argv().length;

  const marked = hook({ session_id: OBSERVER, hook_event_name: "Stop" }, { HERDR_ENV: "1", SASU_HERDR_ROLE: "implementor" });
  assert.equal(marked.status, 0);
  assert.equal(marked.stdout, "", "never a decision on stdout");
  assert.equal(log().at(-1).reason.includes("implementor marker"), true);

  const outside = hook({ session_id: OBSERVER }, {});
  assert.equal(outside.status, 0);
  assert.match(log().at(-1).reason, /not a Herdr session/);

  const unknown = hook({ session_id: "not-an-observer" }, { HERDR_ENV: "1" });
  assert.equal(unknown.status, 0);
  assert.match(log().at(-1).reason, /not the recorded Observer/);
  assert.equal(launchctlCalls(), 0, "no process creation on the no-op paths");
  assert.equal(run.wakes().length, 0);

  const garbage = spawnSync(process.execPath, [STOP_HOOK], { encoding: "utf8", input: "not json", env: isolatedEnv({ ...run.base, HERDR_ENV: "1" }), timeout: 30_000 });
  assert.equal(garbage.status, 0, "malformed stdin never fails the stop");

  // The recorded Observer: launchd is not loaded and no plist is installed, so the hook can only say so.
  const missing = hook({ session_id: OBSERVER }, { HERDR_ENV: "1" });
  assert.equal(missing.status, 0);
  assert.deepEqual({ action: log().at(-1).action, runs: log().at(-1).runs, launchAgent: log().at(-1).launchAgent }, { action: "confirmed", runs: ["fixture"], launchAgent: "missing" });

  // With the agent installed and loaded, the hook asks for an immediate tick.
  const installed = sasu(run.home, ["supervisor", "install"], { env: run.base });
  assert.equal(installed.status, 0, installed.text);
  const kicked = hook({ session_id: OBSERVER }, { HERDR_ENV: "1" });
  assert.equal(kicked.status, 0);
  assert.deepEqual({ launchAgent: log().at(-1).launchAgent, kicked: log().at(-1).kicked }, { launchAgent: "loaded", kicked: true });
  assert.equal(run.launchctl.state().kicked, 1);
  assert.equal(run.wakes().length, 0, "the hook itself prompts nobody");
});

test("B14: install, update and uninstall of the LaunchAgent converge under an isolated HOME and never touch the domain twice for an unchanged definition", () => {
  const run = dispatchedRun();
  const first = sasu(run.home, ["supervisor", "install"], { env: run.base });
  assert.equal(first.status, 0, first.text);
  assert.equal(first.json.detail.plist, "written");
  const plist = path.join(run.home, "Library", "LaunchAgents", "com.sasu.supervisor.plist");
  assert.equal(fs.existsSync(plist), true);
  assert.match(fs.readFileSync(plist, "utf8"), new RegExp(`<string>${CLI.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</string>`));
  assert.deepEqual(run.launchctl.argv().map((argv) => argv[0]), ["print", "bootstrap"]);

  const second = sasu(run.home, ["supervisor", "install"], { env: run.base });
  assert.equal(second.json.detail.plist, "unchanged");
  assert.deepEqual(second.json.detail.launchctl, []);

  const shown = sasu(run.home, ["supervisor", "status"], { env: run.base });
  assert.deepEqual({ installed: shown.json.detail.launchAgent.installed, loaded: shown.json.detail.launchAgent.loaded }, { installed: true, loaded: true });

  const removed = sasu(run.home, ["supervisor", "uninstall"], { env: run.base });
  assert.equal(removed.status, 0, removed.text);
  assert.equal(fs.existsSync(plist), false);
  assert.deepEqual(run.launchctl.state().loaded, {});
  assert.equal(sasu(run.home, ["supervisor", "uninstall"], { env: run.base }).json.detail.launchAgent.plist, "absent");
});
