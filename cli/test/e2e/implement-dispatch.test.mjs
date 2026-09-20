// Real CLI boundary: the Observer starts a run and dispatches its implementor
// into a pane of its own, against a fake herdr that records every argv.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { CLI, git, isolatedEnv, makeProject, PRD_PATH, STATE_PATH } from "../helpers/implement-fixture.mjs";
import { installFakeHerdr } from "../helpers/fake-herdr.mjs";
import { attemptFixture } from "../helpers/implement-state.mjs";
import { reconcileCurrentDispatchPrerequisites, repairPendingDispatchPrerequisites, runImplementCommand } from "../../dist/implement/commands.js";
import { enrollRun, readIndex, unenrollRun, updateIndex } from "../../dist/supervisor/index.js";

const OBSERVER = "observer-session";
const IMPLEMENTOR = "implementor-session";
const PACKET = "ROLE: Implementor.\nPIPELINE: implement\nSOURCE: fixture\nRETURN CONTRACT: status";

function sasu(root, args, { env = {}, input } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args, "--json"], { cwd: root, encoding: "utf8", env: isolatedEnv(env), input, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  let json;
  try { json = JSON.parse(result.stdout); } catch { json = { stdout: result.stdout, stderr: result.stderr }; }
  return { ...result, json, text: result.stdout + result.stderr };
}

function sasuAsync(root, args, { env = {}, input } = {}) {
  const child = spawn(process.execPath, [CLI, ...args, "--json"], { cwd: root, env: isolatedEnv(env), stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(input);
  const completion = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("async sasu test timed out")); }, 30_000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (status, signal) => {
      clearTimeout(timeout);
      let json;
      try { json = JSON.parse(stdout); } catch { json = { stdout, stderr }; }
      resolve({ status, signal, stdout, stderr, json, text: stdout + stderr });
    });
  });
  return { child, completion };
}

async function waitForFile(file, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file) && Date.now() < deadline) await delay(10);
  if (!fs.existsSync(file)) throw new Error(`barrier was not reached: ${file}`);
}

const argvLog = (log) => fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const state = (root) => JSON.parse(fs.readFileSync(path.join(root, STATE_PATH), "utf8"));

const POINTER = path.join("agents", "runs", ".prd-implement-active.json");

function herdrEnv(root, extra = {}) {
  const fake = installFakeHerdr(root);
  // The supervisor index lives under HOME; every test gets its own.
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  return { env: { HERDR_ENV: "1", HERDR_PANE_ID: "w4G:p12", HERDR_WORKSPACE_ID: "w4G", CLAUDE_SESSION_ID: OBSERVER, HOME: home, ...fake.env, ...extra }, log: fake.log, fake, home };
}

const dispatch = (root, env, extra = []) => sasu(root, ["implement", "dispatch", "--name", "impl", "--prd", PRD_PATH, ...extra], { env, input: PACKET });

// Hide lists a pane under the Herdr workspace that owns it, so an implementor
// split beside the Observer was listed under the root checkout however far
// away its worktree was, and sat in the operator's own layout (2026-09-18).
test("a worktree run's implementor is opened in a workspace on that worktree, never a split of the Observer's pane", (t) => {
  const root = fs.realpathSync(makeProject());
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({ worktree: { enabled: true } }));
  const { env, log, fake, home } = herdrEnv(root);

  const started = sasu(root, ["implement", "start", "--prd", PRD_PATH, "--dirty-attribution", "run-owned"], { env });
  assert.equal(started.status, 0, started.text);
  const worktree = state(root).worktree.path;
  t.after(() => fs.rmSync(path.dirname(worktree), { recursive: true, force: true }));
  assert.match(started.json.summary.join("\n"), /sasu implement dispatch/, "start names dispatch as the Observer's next step");
  assert.match(started.json.summary.join("\n"), new RegExp(`a workspace on ${worktree}`));

  const dispatched = dispatch(root, env);
  assert.equal(dispatched.status, 0, dispatched.text);
  assert.equal(dispatched.json.ok, true);
  assert.deepEqual(
    { paneId: dispatched.json.detail.paneId, workspaceId: dispatched.json.detail.workspaceId, tabId: dispatched.json.detail.tabId, cwd: dispatched.json.detail.cwd, slug: dispatched.json.detail.slug },
    { paneId: "w7Z:p1", workspaceId: "w7Z", tabId: "w7Z:t1", cwd: worktree, slug: "fixture" },
  );

  const asked = argvLog(log);
  const created = asked.find((argv) => argv[0] === "workspace" && argv[1] === "create");
  const runInstanceId = dispatched.json.detail.runInstanceId;
  assert.match(runInstanceId, /^[0-9a-f-]{36}$/, "dispatch mints a random run instance id");
  assert.deepEqual(created, ["workspace", "create", "--cwd", worktree, "--label", "fixture", "--env", "SASU_HERDR_ROLE=implementor", "--env", `PATH=${env.PATH}`, "--env", `SASU_RUN_INSTANCE_ID=${runInstanceId}`, "--no-focus"], "the pane carries the marker and the run instance it was opened for");
  assert.equal(asked.some((argv) => argv[0] === "pane" && argv[1] === "split"), false, "the Observer's pane is never split");
  assert.deepEqual(asked.find((argv) => argv[1] === "start").slice(0, 7), ["agent", "start", "impl", "--kind", "claude", "--pane", "w7Z:p1"]);
  assert.deepEqual(asked.find((argv) => argv[1] === "prompt"), ["agent", "prompt", "w7Z:p1", PACKET]);
  assert.deepEqual(asked.find((argv) => argv[1] === "report-metadata"), ["pane", "report-metadata", "w7Z:p1", "--source", "sasu", "--token", "parent_pane=w4G:p12"], "the Observer's pane is declared as the parent, for hide's tree");
  assert.equal(dispatched.json.detail.parentLineage, "reported");

  // The run is recorded as handed over: the pane, the release of ownership,
  // and a bookmark in the worktree so the implementor's bare commands resolve.
  const recorded = state(root);
  assert.equal(recorded.dispatches.length, 1);
  assert.deepEqual(
    { agent: recorded.dispatches[0].agent, kind: recorded.dispatches[0].kind, paneId: recorded.dispatches[0].paneId, workspaceId: recorded.dispatches[0].workspaceId, cwd: recorded.dispatches[0].cwd, fromSessionId: recorded.dispatches[0].fromSessionId },
    { agent: "impl", kind: "claude", paneId: "w7Z:p1", workspaceId: "w7Z", cwd: worktree, fromSessionId: OBSERVER },
  );
  assert.equal(recorded.ownerSessionId, null, "released so the implementor's first write claims it");
  assert.equal(recorded.events.at(-1).kind, "dispatch");
  // B1: the Observer's identity, the run instance and the implementor pane
  // are in state.json, and the path is in the supervisor index before the
  // Observer's first Stop.
  assert.deepEqual(
    { runInstanceId: recorded.supervision.runInstanceId, observer: { sessionId: recorded.supervision.observer.sessionId, terminalId: recorded.supervision.observer.terminalId, paneId: recorded.supervision.observer.paneId, runtime: recorded.supervision.observer.runtime }, implementor: { ...recorded.supervision.implementor, recordedAt: "<timestamp>" }, patrolIntervalMs: recorded.supervision.patrolIntervalMs, recoveryOwner: recorded.supervision.recoveryOwner },
    { runInstanceId, observer: { sessionId: OBSERVER, terminalId: "term_observer", paneId: "w4G:p12", runtime: "claude" }, implementor: { paneId: "w7Z:p1", agent: "impl", sessionId: "impl-session", terminalId: "term_impl", hostScope: "default", recordedAt: "<timestamp>" }, patrolIntervalMs: 15 * 60 * 1000, recoveryOwner: "supervisor" },
  );
  assert.equal(recorded.supervision.dispatchHead, git(root, ["rev-parse", "HEAD"]), "the digest measures from the head at dispatch");
  const index = readIndex(path.join(home, ".sasu", "supervisor", "index.json"));
  assert.deepEqual(index.entries.map((entry) => [entry.statePath, entry.runInstanceId]), [[path.join(root, STATE_PATH), runInstanceId]]);
  const bookmark = JSON.parse(fs.readFileSync(path.join(worktree, POINTER), "utf8"));
  assert.equal(bookmark.projectRoot, root, "the bookmark names the record tree");

  // From the worktree, with no slug and a different session, the marked
  // implementor resolves the run and claims it on its first write.
  const implementorEnv = { CLAUDE_SESSION_ID: IMPLEMENTOR, SASU_HERDR_ROLE: "implementor", HERDR_ENV: "1", HERDR_PANE_ID: "w7Z:p1", SASU_RUN_INSTANCE_ID: runInstanceId, HOME: home };
  // Evidence is registered against the record tree, as every artifact is.
  fs.mkdirSync(path.join(root, "agents", "observations"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", "observations", "runtime.log"), "observed\n");
  const artifactArgs = ["implement", "artifact", "--kind", "log", "--path", "agents/observations/runtime.log", "--description", "observation", "--source", "fixture", "--collected-at", "2026-09-18T00:00:00.000Z"];

  const bystander = sasu(worktree, artifactArgs, { env: { CLAUDE_SESSION_ID: "someone-else" } });
  assert.notEqual(bystander.status, 0);
  assert.match(bystander.text, /was dispatched to implementor impl \(w7Z:p1\) and is its to claim/);
  assert.equal(state(root).ownerSessionId, null, "a bystander's refused write claims nothing");

  // D-04: a marked pane opened for another dispatch cannot claim this run.
  const wrongInstance = sasu(worktree, artifactArgs, { env: { ...implementorEnv, SASU_RUN_INSTANCE_ID: "00000000-0000-4000-8000-000000000000" } });
  assert.notEqual(wrongInstance.status, 0);
  assert.match(wrongInstance.text, /is not this pane's run/);
  assert.equal(state(root).ownerSessionId, null);

  const missingInstance = sasu(worktree, artifactArgs, { env: { ...implementorEnv, SASU_RUN_INSTANCE_ID: "" } });
  assert.notEqual(missingInstance.status, 0);
  assert.match(missingInstance.text, /carries no SASU_RUN_INSTANCE_ID/);
  assert.equal(state(root).ownerSessionId, null);

  const claimed = sasu(worktree, artifactArgs, { env: implementorEnv });
  assert.equal(claimed.status, 0, claimed.text);
  assert.equal(state(root).ownerSessionId, IMPLEMENTOR);
  assert.equal(state(root).status, "active");

  // One implementor per run: a second dispatch is refused while the first is
  // listed, and allowed once herdr no longer lists it.
  fake.setAgents({ "w7Z:p1": { name: "impl", agent: "claude", agent_status: "working", pane_id: "w7Z:p1", terminal_id: "term_impl", agent_session: { value: IMPLEMENTOR }, tokens: { activity: "1000" }, state_change_seq: 1 } });
  const stillAlive = dispatch(root, env, ["--adopt", "user said: take it back"]);
  assert.notEqual(stillAlive.status, 0);
  assert.match(stillAlive.text, /impl is still running in w7Z:p1/);
  assert.equal(argvLog(log).filter((argv) => argv[1] === "create").length, 1, "nothing was created for the refused dispatch");

  fake.setAgents({});
  const replaced = sasu(root, ["implement", "dispatch", "--name", "impl-2", "--prd", PRD_PATH, "--adopt", "user said: take it back"], { env, input: PACKET });
  assert.equal(replaced.status, 0, replaced.text);
  assert.equal(state(root).dispatches.length, 2);
  assert.equal(state(root).dispatches.at(-1).agent, "impl-2");
  assert.equal(state(root).ownerSessionId, null);
  const reindexed = readIndex(path.join(home, ".sasu", "supervisor", "index.json"));
  assert.equal(reindexed.entries.length, 1, "a re-dispatch replaces the entry rather than adding one");
  assert.equal(reindexed.entries[0].runInstanceId, state(root).supervision.runInstanceId);
  assert.notEqual(reindexed.entries[0].runInstanceId, runInstanceId, "the replacement is a new instance");
});

test("dispatch refuses when the Observer's identity cannot be read, before any pane exists (B2)", () => {
  const root = fs.realpathSync(makeProject());
  const { env, log, fake } = herdrEnv(root);
  const started = sasu(root, ["implement", "start", "--prd", PRD_PATH, "--dirty-attribution", "run-owned"], { env });
  assert.equal(started.status, 0, started.text);
  // The dispatching pane holds an agent herdr cannot name a session for.
  fake.setAgents({ "w4G:p12": { agent: "claude", agent_status: "working", pane_id: "w4G:p12", tokens: { activity: "1000" } } });
  const refused = dispatch(root, env);
  assert.notEqual(refused.status, 0);
  assert.match(refused.text, /the Observer cannot be recorded/);
  assert.match(refused.text, /no session UUID or terminal id/);
  assert.equal(argvLog(log).some((argv) => argv[1] === "create"), false, "no pane was created for an unrecordable Observer");
  assert.equal(state(root).supervision ?? null, null);

  const badPatrol = dispatch(root, env, ["--patrol", "0"]);
  assert.notEqual(badPatrol.status, 0);
  assert.match(badPatrol.text, /--patrol must be a whole number of minutes/);
  const badOwner = dispatch(root, env, ["--recovery-owner", "someone"]);
  assert.match(badOwner.text, /--recovery-owner must be supervisor or task-factory/);
  const smuggled = dispatch(root, env, ["--env", "SASU_RUN_INSTANCE_ID=x"]);
  assert.match(smuggled.text, /minted by the dispatch/);
});

test("D-04: an enrollment write that commits before cleanup failure restores the prior supervised run", async () => {
  const root = fs.realpathSync(makeProject());
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({ worktree: { enabled: false } }));
  const { env, fake, home } = herdrEnv(root);
  assert.equal(sasu(root, ["implement", "start", "--prd", PRD_PATH, "--dirty-attribution", "run-owned"], { env }).status, 0);
  const first = dispatch(root, env);
  assert.equal(first.status, 0, first.text);
  const priorRunInstanceId = state(root).supervision.runInstanceId;
  const index = path.join(home, ".sasu", "supervisor", "index.json");
  fake.setAgents({});

  // Hold four immutable revisions so the replacement enrollment commits its
  // new head and then reaches pruning. The round-two review reproduced an EIO
  // at that exact boundary: the external write existed even though its caller
  // received an exception.
  for (let revision = 0; revision < 5; revision += 1) {
    updateIndex(index, (current) => { current.lastHerdr = { available: true, detail: `seed-${revision}` }; });
  }

  const originalUnlink = fs.unlinkSync;
  const inherited = new Map();
  const cleared = ["CODEX_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID", "SASU_HERDR_ROLE", "HERDR_SOCKET_PATH"];
  for (const key of new Set([...Object.keys(env), ...cleared])) {
    inherited.set(key, process.env[key]);
    if (key in env) process.env[key] = env[key];
    else delete process.env[key];
  }
  let injected = false;
  fs.unlinkSync = (target) => {
    if (!injected && String(target).includes(".revision-")) {
      injected = true;
      const error = new Error("scripted revision pruning failure");
      error.code = "EIO";
      throw error;
    }
    return originalUnlink(target);
  };
  let refused;
  try {
    refused = await runImplementCommand(root, {
      positional: ["implement", "dispatch"],
      flags: new Map([["name", "impl-2"], ["prd", PRD_PATH], ["adopt", "user approved replacement"]]),
      values: new Map(),
    });
  } finally {
    fs.unlinkSync = originalUnlink;
    for (const [key, value] of inherited) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  assert.equal(injected, true, `the regression reaches cleanup after the replacement revision is committed: ${refused?.message ?? "no result"}`);
  assert.equal(refused.ok, false);
  assert.match(refused.message, /supervision enrollment failed before child start/);
  const after = state(root);
  assert.equal(after.pendingDispatch, null, "no child exists, so the failed replacement intent is cleared");
  assert.equal(after.supervision.runInstanceId, priorRunInstanceId, "state keeps the previously supervised run");
  assert.equal(readIndex(index).entries[0].runInstanceId, priorRunInstanceId, "the index is reconciled to the state authority before returning the failure");
});

test("D-04: identity and enrollment persist before handoff, and a failed handoff has an explicit recovery path", () => {
  const root = fs.realpathSync(makeProject());
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({ worktree: { enabled: false } }));
  const { env, fake, home } = herdrEnv(root);
  const initialEnv = { ...env, HERDR_SOCKET_PATH: "/tmp/fake.sock" };
  assert.equal(sasu(root, ["implement", "start", "--prd", PRD_PATH, "--dirty-attribution", "run-owned"], { env: initialEnv }).status, 0);
  const failed = dispatch(root, { ...initialEnv, HERDR_FAKE_PROMPT_FAIL: "1" });
  assert.equal(failed.status, 1, failed.text);
  assert.match(failed.text, /dispatch is incomplete/);
  const partial = state(root);
  assert.equal(partial.pendingDispatch.phase, "started");
  assert.equal(partial.pendingDispatch.implementor.sessionId, "impl-session");
  assert.equal(partial.supervision.implementor.terminalId, "term_impl");
  assert.equal(readIndex(path.join(home, ".sasu", "supervisor", "index.json")).entries[0].runInstanceId, partial.supervision.runInstanceId);
  assert.equal(fake.prompts().length, 0, "the failed wrapper did not submit the handoff");

  const resumed = sasu(root, ["implement", "dispatch", "--slug", "fixture", "--resume-handoff"], {
    env: { ...env, HERDR_SOCKET_PATH: "/tmp/other.sock", HERDR_FAKE_REQUIRED_SOCKET_PATH: "/tmp/fake.sock" },
    input: PACKET,
  });
  assert.equal(resumed.status, 0, resumed.text);
  assert.equal(state(root).pendingDispatch, null);
  assert.deepEqual(fake.prompts().map((entry) => [entry.target, entry.text]), [["w4G:p13", PACKET]]);
});

test("B2/B18: an approved Observer handover transfers partial-handoff recovery authority", () => {
  const root = fs.realpathSync(makeProject());
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({ worktree: { enabled: false } }));
  const { env, fake } = herdrEnv(root);
  assert.equal(sasu(root, ["implement", "start", "--prd", PRD_PATH, "--dirty-attribution", "run-owned"], { env }).status, 0);
  const failed = dispatch(root, { ...env, HERDR_FAKE_PROMPT_FAIL: "1" });
  assert.equal(failed.status, 1, failed.text);
  assert.equal(state(root).pendingDispatch.phase, "started");

  fake.patchAgent("w4G:p12", { name: "observer", agent: "claude", agent_status: "working", pane_id: "w4G:p12", terminal_id: "term_replacement", agent_session: { value: "replacement-session" }, tokens: { activity: "2000" }, state_change_seq: 2 });
  const replacementEnv = { ...env, CLAUDE_SESSION_ID: "replacement-session" };
  const handed = sasu(root, ["supervisor", "handover", "--slug", "fixture", "--approval", "user: replacement Observer takes over"], { env: replacementEnv });
  assert.equal(handed.status, 0, handed.text);
  assert.equal(state(root).pendingDispatch.observer.sessionId, "replacement-session");

  const resumed = sasu(root, ["implement", "dispatch", "--slug", "fixture", "--resume-handoff"], { env: replacementEnv, input: PACKET });
  assert.equal(resumed.status, 0, resumed.text);
  assert.equal(state(root).pendingDispatch, null);
  assert.deepEqual(fake.prompts().map((entry) => [entry.target, entry.text]), [["w4G:p13", PACKET]]);
});

test("B2/B18: approved handover transfers a planned dispatch before supervision exists", () => {
  const root = fs.realpathSync(makeProject());
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({ worktree: { enabled: false } }));
  const { env, fake } = herdrEnv(root);
  assert.equal(sasu(root, ["implement", "start", "--prd", PRD_PATH, "--dirty-attribution", "run-owned"], { env }).status, 0);
  assert.equal(dispatch(root, { ...env, HERDR_FAKE_PROMPT_FAIL: "1" }).status, 1);
  const fixture = state(root);
  fixture.pendingDispatch.phase = "planned";
  fixture.pendingDispatch.prepared = null;
  fixture.pendingDispatch.implementor = null;
  fixture.pendingDispatch.handovers = [];
  fixture.supervision = null;
  fs.writeFileSync(path.join(root, STATE_PATH), `${JSON.stringify(fixture, null, 2)}\n`);

  fake.patchAgent("w4G:p12", { name: "observer", agent: "claude", agent_status: "working", pane_id: "w4G:p12", terminal_id: "term_replacement", agent_session: { value: "replacement-session" }, tokens: { activity: "2000" }, state_change_seq: 2 });
  const replacementEnv = { ...env, CLAUDE_SESSION_ID: "replacement-session" };
  const handed = sasu(root, ["supervisor", "handover", "--slug", "fixture", "--approval", "user: replacement Observer takes planned recovery"], { env: replacementEnv });
  assert.equal(handed.status, 0, handed.text);
  assert.equal(state(root).pendingDispatch.observer.sessionId, "replacement-session");
  assert.equal(state(root).pendingDispatch.handovers[0].approval, "user: replacement Observer takes planned recovery");

  const recovered = sasu(root, ["implement", "dispatch", "--slug", "fixture", "--resume-handoff"], { env: replacementEnv });
  assert.equal(recovered.status, 0, recovered.text);
  assert.equal(state(root).ownerSessionId, "replacement-session", "the transferred Observer can begin the next dispatch without a second adoption");
});

test("D-04/engineering 10: a positively absent started child has an idempotent recovery operation", () => {
  const root = fs.realpathSync(makeProject());
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({ worktree: { enabled: false } }));
  const { env, fake, home } = herdrEnv(root);
  assert.equal(sasu(root, ["implement", "start", "--prd", PRD_PATH, "--dirty-attribution", "run-owned"], { env }).status, 0);
  assert.equal(dispatch(root, { ...env, HERDR_FAKE_PROMPT_FAIL: "1" }).status, 1);
  assert.equal(state(root).pendingDispatch.phase, "started");
  fake.setAgents({});

  const recovered = sasu(root, ["implement", "dispatch", "--slug", "fixture", "--resume-handoff", "--recover-absent-child"], { env });
  assert.equal(recovered.status, 0, recovered.text);
  assert.equal(recovered.json.detail.recovered, "started-absent");
  assert.equal(state(root).pendingDispatch, null);
  assert.equal(state(root).ownerSessionId, OBSERVER);
  assert.equal(readIndex(path.join(home, ".sasu", "supervisor", "index.json")).entries.length, 0);
  assert.equal(fake.prompts().length, 0);

  const repeated = sasu(root, ["implement", "dispatch", "--slug", "fixture", "--resume-handoff", "--recover-absent-child"], { env });
  assert.equal(repeated.status, 0, repeated.text);
  assert.equal(repeated.json.detail.recovered, "already-clear");
});

test("D-04: absent-child recovery revalidates handover before changing enrollment", async () => {
  const root = fs.realpathSync(makeProject());
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({ worktree: { enabled: false } }));
  const { env, fake, home } = herdrEnv(root);
  assert.equal(sasu(root, ["implement", "start", "--prd", PRD_PATH, "--dirty-attribution", "run-owned"], { env }).status, 0);
  assert.equal(dispatch(root, { ...env, HERDR_FAKE_PROMPT_FAIL: "1" }).status, 1);
  fake.setAgents({});
  const ready = path.join(root, "absent-recovery.ready");
  const release = path.join(root, "absent-recovery.release");
  const running = sasuAsync(root, ["implement", "dispatch", "--slug", "fixture", "--resume-handoff", "--recover-absent-child"], {
    env: { ...env, HERDR_FAKE_GET_BARRIER_TARGET: "w4G:p13", HERDR_FAKE_GET_BARRIER_READY: ready, HERDR_FAKE_GET_BARRIER_RELEASE: release },
  });
  try {
    await waitForFile(ready);
    fake.patchAgent("w4G:p12", { name: "observer", agent: "claude", agent_status: "working", pane_id: "w4G:p12", terminal_id: "term_replacement", agent_session: { value: "replacement-session" }, tokens: { activity: "2000" }, state_change_seq: 2 });
    const handed = sasu(root, ["supervisor", "handover", "--slug", "fixture", "--approval", "user: replacement Observer takes absent recovery"], { env: { ...env, CLAUDE_SESSION_ID: "replacement-session" } });
    assert.equal(handed.status, 0, handed.text);
  } finally {
    fs.writeFileSync(release, "release\n");
  }
  const recovered = await running.completion;
  assert.notEqual(recovered.status, 0, recovered.text);
  assert.match(recovered.text, /partial dispatch changed|authority/i);
  assert.equal(state(root).pendingDispatch.observer.sessionId, "replacement-session");
  const entries = readIndex(path.join(home, ".sasu", "supervisor", "index.json")).entries;
  assert.equal(entries.length, 1, "stale recovery cannot remove the replacement Observer's enrollment");
  assert.equal(entries[0].runInstanceId, state(root).pendingDispatch.runInstanceId);
});

test("D-04/engineering 11: prerequisite repair binds enrollment generation to freshly validated dispatch authority", () => {
  const root = fs.realpathSync(makeProject());
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({ worktree: { enabled: false } }));
  const { env, home } = herdrEnv(root);
  assert.equal(sasu(root, ["implement", "start", "--prd", PRD_PATH, "--dirty-attribution", "run-owned"], { env }).status, 0);
  assert.equal(dispatch(root, { ...env, HERDR_FAKE_PROMPT_FAIL: "1" }).status, 1);
  const staleState = state(root);
  const stalePending = structuredClone(staleState.pendingDispatch);
  const index = path.join(home, ".sasu", "supervisor", "index.json");
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.throws(() => repairPendingDispatchPrerequisites(root, path.join(root, STATE_PATH), staleState, stalePending, () => {
      const replacement = state(root);
      replacement.pendingDispatch.runInstanceId = "replacement-instance";
      replacement.pendingDispatch.observer.sessionId = "replacement-observer";
      fs.writeFileSync(path.join(root, STATE_PATH), `${JSON.stringify(replacement, null, 2)}\n`);
      enrollRun(index, {
        statePath: path.join(root, STATE_PATH),
        runInstanceId: replacement.pendingDispatch.runInstanceId,
        recoveryOwner: replacement.pendingDispatch.recoveryOwner,
        at: new Date().toISOString(),
      });
    }), /dispatch authority changed/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
  assert.equal(state(root).pendingDispatch.runInstanceId, "replacement-instance");
  assert.deepEqual(readIndex(index).entries.map((entry) => entry.runInstanceId), ["replacement-instance"], "stale recovery cannot claim a generation created for newer authority");
});

test("D-04/engineering 11: current prerequisite reconciliation binds generation before a later refusal", () => {
  const root = fs.realpathSync(makeProject());
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({ worktree: { enabled: false } }));
  const { env, home } = herdrEnv(root);
  assert.equal(sasu(root, ["implement", "start", "--prd", PRD_PATH, "--dirty-attribution", "run-owned"], { env }).status, 0);
  assert.equal(dispatch(root, { ...env, HERDR_FAKE_PROMPT_FAIL: "1" }).status, 1);
  const index = path.join(home, ".sasu", "supervisor", "index.json");
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.throws(() => reconcileCurrentDispatchPrerequisites(root, path.join(root, STATE_PATH), "test reconciliation", () => {
      const replacement = state(root);
      replacement.pendingDispatch.runInstanceId = "replacement-current-instance";
      const attempt = attemptFixture({ id: "replacement-verification" });
      replacement.verificationAttempts.push(attempt);
      replacement.activeVerification = {
        token: "replacement-verification-token",
        attemptId: attempt.id,
        pid: process.pid,
        hostname: "test-host",
        startedAt: attempt.startedAt,
        inputFingerprint: attempt.inputFingerprint,
        prdSha256: attempt.prdSha256,
        executionPids: [],
        pendingSpawns: 0,
      };
      fs.writeFileSync(path.join(root, STATE_PATH), `${JSON.stringify(replacement, null, 2)}\n`);
      enrollRun(index, {
        statePath: path.join(root, STATE_PATH),
        runInstanceId: replacement.pendingDispatch.runInstanceId,
        recoveryOwner: replacement.pendingDispatch.recoveryOwner,
        at: new Date().toISOString(),
      });
    }), /verification still active/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
  assert.equal(state(root).pendingDispatch.runInstanceId, "replacement-current-instance");
  assert.deepEqual(readIndex(index).entries.map((entry) => entry.runInstanceId), ["replacement-current-instance"], "a later actionable refusal cannot leave the replacement enrollment overwritten");
});

test("D-04/engineering 10: navigation failure leaves absent recovery retryable", () => {
  const root = fs.realpathSync(makeProject());
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({ worktree: { enabled: false } }));
  const { env, fake } = herdrEnv(root);
  assert.equal(sasu(root, ["implement", "start", "--prd", PRD_PATH, "--dirty-attribution", "run-owned"], { env }).status, 0);
  assert.equal(dispatch(root, { ...env, HERDR_FAKE_PROMPT_FAIL: "1" }).status, 1);
  fake.setAgents({});
  const pointer = path.join(root, POINTER);
  fs.rmSync(pointer, { force: true });
  fs.mkdirSync(pointer);
  fs.writeFileSync(path.join(pointer, "block-replacement"), "occupied\n");

  const interrupted = sasu(root, ["implement", "dispatch", "--slug", "fixture", "--resume-handoff", "--recover-absent-child"], { env });
  assert.notEqual(interrupted.status, 0, interrupted.text);
  assert.equal(state(root).pendingDispatch.phase, "started", "navigation must succeed before the durable recovery record is cleared");

  fs.rmSync(pointer, { recursive: true });
  const retried = sasu(root, ["implement", "dispatch", "--slug", "fixture", "--resume-handoff", "--recover-absent-child"], { env });
  assert.equal(retried.status, 0, retried.text);
  assert.ok(fs.existsSync(pointer), "the retry repairs navigation instead of trusting a stale converged result");
});

test("D-04: resumed handoff restores navigation and enrollment before executable input", async () => {
  const root = fs.realpathSync(makeProject());
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({ worktree: { enabled: false } }));
  const { env, fake, home } = herdrEnv(root);
  assert.equal(sasu(root, ["implement", "start", "--prd", PRD_PATH, "--dirty-attribution", "run-owned"], { env }).status, 0);
  assert.equal(dispatch(root, { ...env, HERDR_FAKE_PROMPT_FAIL: "1" }).status, 1);
  const partial = state(root).pendingDispatch;
  const pointer = path.join(root, POINTER);
  fs.rmSync(pointer, { force: true });
  unenrollRun(path.join(home, ".sasu", "supervisor", "index.json"), { statePath: path.join(root, STATE_PATH), runInstanceId: partial.runInstanceId, at: new Date().toISOString(), cause: "test removes prerequisites" });
  const ready = path.join(root, "resume-prerequisites.ready");
  const release = path.join(root, "resume-prerequisites.release");
  const running = sasuAsync(root, ["implement", "dispatch", "--slug", "fixture", "--resume-handoff"], {
    env: { ...env, HERDR_FAKE_PROMPT_BARRIER_READY: ready, HERDR_FAKE_PROMPT_BARRIER_RELEASE: release },
    input: PACKET,
  });
  try {
    await waitForFile(ready);
    assert.ok(fs.existsSync(pointer), "navigation exists before the prompt process starts");
    const entries = readIndex(path.join(home, ".sasu", "supervisor", "index.json")).entries;
    assert.deepEqual(entries.map((entry) => entry.runInstanceId), [partial.runInstanceId], "enrollment exists before the prompt process starts");
  } finally {
    fs.writeFileSync(release, "release\n");
  }
  const resumed = await running.completion;
  assert.equal(resumed.status, 0, resumed.text);
  assert.equal(fake.prompts().length, 1);
});

async function initialDispatchAtFinalLookup(root, env, stem) {
  const ready = path.join(root, `${stem}.ready`);
  const release = path.join(root, `${stem}.release`);
  const count = path.join(root, `${stem}.count`);
  const running = sasuAsync(root, ["implement", "dispatch", "--name", "impl", "--prd", PRD_PATH], {
    env: {
      ...env,
      HERDR_FAKE_GET_BARRIER_TARGET: "w4G:p13",
      HERDR_FAKE_GET_BARRIER_OCCURRENCE: "2",
      HERDR_FAKE_GET_BARRIER_COUNT: count,
      HERDR_FAKE_GET_BARRIER_READY: ready,
      HERDR_FAKE_GET_BARRIER_RELEASE: release,
    },
    input: PACKET,
  });
  await waitForFile(ready);
  return { running, release };
}

test("D-04: initial handoff rechecks lifecycle after its final target lookup", async () => {
  const root = fs.realpathSync(makeProject());
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({ worktree: { enabled: false } }));
  const { env, fake } = herdrEnv(root);
  assert.equal(sasu(root, ["implement", "start", "--prd", PRD_PATH, "--dirty-attribution", "run-owned"], { env }).status, 0);
  const { running, release } = await initialDispatchAtFinalLookup(root, env, "initial-retire-get");
  try {
    const retired = sasu(root, ["implement", "retire", "--slug", "fixture", "--issuer", "human", "--adopt", "user: retire during dispatch"], { env });
    assert.equal(retired.status, 0, retired.text);
  } finally {
    fs.writeFileSync(release, "release\n");
  }
  const dispatched = await running.completion;
  assert.notEqual(dispatched.status, 0, dispatched.text);
  assert.equal(fake.prompts().length, 0, "retirement at the final lookup barrier prevents executable handoff input");
  assert.equal(state(root).pendingDispatch.phase, "started");
});

test("D-04: initial handoff rechecks Observer authority after its final target lookup", async () => {
  const root = fs.realpathSync(makeProject());
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({ worktree: { enabled: false } }));
  const { env, fake } = herdrEnv(root);
  assert.equal(sasu(root, ["implement", "start", "--prd", PRD_PATH, "--dirty-attribution", "run-owned"], { env }).status, 0);
  const { running, release } = await initialDispatchAtFinalLookup(root, env, "initial-handover-get");
  try {
    fake.patchAgent("w9:p1", { name: "observer-replacement", agent: "claude", agent_status: "working", pane_id: "w9:p1", terminal_id: "term_replacement", agent_session: { value: OBSERVER }, tokens: { activity: "2000" }, state_change_seq: 2 });
    const handed = sasu(root, ["supervisor", "handover", "--slug", "fixture", "--approval", "user: move Observer authority during dispatch"], {
      env: { ...env, HERDR_PANE_ID: "w9:p1" },
    });
    assert.equal(handed.status, 0, handed.text);
  } finally {
    fs.writeFileSync(release, "release\n");
  }
  const dispatched = await running.completion;
  assert.notEqual(dispatched.status, 0, dispatched.text);
  assert.equal(fake.prompts().length, 0, "approved same-session handover at the final lookup barrier prevents old authority from sending");
  assert.equal(state(root).pendingDispatch.observer.paneId, "w9:p1");
});

test("D-04: initial handoff sends nothing when verification acquires the run during final lookup", async () => {
  const root = fs.realpathSync(makeProject());
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({ worktree: { enabled: false } }));
  const { env, fake } = herdrEnv(root);
  assert.equal(sasu(root, ["implement", "start", "--prd", PRD_PATH, "--dirty-attribution", "run-owned"], { env }).status, 0);
  const { running, release } = await initialDispatchAtFinalLookup(root, env, "initial-verification-get");
  try {
    const leased = state(root);
    const attempt = attemptFixture({ id: "dispatch-verification" });
    leased.verificationAttempts.push(attempt);
    leased.activeVerification = {
      token: "verification-token", attemptId: "dispatch-verification", pid: process.pid, hostname: "test-host",
      startedAt: attempt.startedAt, inputFingerprint: attempt.inputFingerprint, prdSha256: attempt.prdSha256,
      executionPids: [], pendingSpawns: 0,
    };
    fs.writeFileSync(path.join(root, STATE_PATH), `${JSON.stringify(leased, null, 2)}\n`);
  } finally {
    fs.writeFileSync(release, "release\n");
  }
  const dispatched = await running.completion;
  assert.notEqual(dispatched.status, 0, dispatched.text);
  assert.equal(fake.prompts().length, 0, "a verification lease at the final lookup barrier prevents executable handoff input");
  assert.equal(state(root).pendingDispatch.phase, "started");
});

test("B2: resumed handoff rechecks lifecycle after the final target lookup", async () => {
  const root = fs.realpathSync(makeProject());
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({ worktree: { enabled: false } }));
  const { env, fake } = herdrEnv(root);
  assert.equal(sasu(root, ["implement", "start", "--prd", PRD_PATH, "--dirty-attribution", "run-owned"], { env }).status, 0);
  assert.equal(dispatch(root, { ...env, HERDR_FAKE_PROMPT_FAIL: "1" }).status, 1);
  const ready = path.join(root, "resume-get.ready");
  const release = path.join(root, "resume-get.release");
  const running = sasuAsync(root, ["implement", "dispatch", "--slug", "fixture", "--resume-handoff"], {
    env: { ...env, HERDR_FAKE_GET_BARRIER_TARGET: "w4G:p13", HERDR_FAKE_GET_BARRIER_READY: ready, HERDR_FAKE_GET_BARRIER_RELEASE: release },
    input: PACKET,
  });
  try {
    await waitForFile(ready);
    const retired = sasu(root, ["implement", "retire", "--slug", "fixture", "--issuer", "human", "--adopt", "user: retire this interrupted run"], { env });
    assert.equal(retired.status, 0, retired.text);
  } finally {
    fs.writeFileSync(release, "release\n");
  }
  const resumed = await running.completion;
  assert.notEqual(resumed.status, 0, resumed.text);
  assert.match(resumed.text, /implement run is retired/);
  assert.equal(fake.prompts().length, 0, "retirement at the deterministic lookup barrier prevents external input");
  assert.equal(state(root).pendingDispatch.phase, "started", "failed recovery retains its exact pending record");
});

test("B2/B18: resumed handoff rechecks recovery authority after the final target lookup", async () => {
  const root = fs.realpathSync(makeProject());
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({ worktree: { enabled: false } }));
  const { env, fake } = herdrEnv(root);
  assert.equal(sasu(root, ["implement", "start", "--prd", PRD_PATH, "--dirty-attribution", "run-owned"], { env }).status, 0);
  assert.equal(dispatch(root, { ...env, HERDR_FAKE_PROMPT_FAIL: "1" }).status, 1);
  const ready = path.join(root, "resume-handover-get.ready");
  const release = path.join(root, "resume-handover-get.release");
  const running = sasuAsync(root, ["implement", "dispatch", "--slug", "fixture", "--resume-handoff"], {
    env: { ...env, HERDR_FAKE_GET_BARRIER_TARGET: "w4G:p13", HERDR_FAKE_GET_BARRIER_READY: ready, HERDR_FAKE_GET_BARRIER_RELEASE: release },
    input: PACKET,
  });
  try {
    await waitForFile(ready);
    fake.patchAgent("w4G:p12", { name: "observer", agent: "claude", agent_status: "working", pane_id: "w4G:p12", terminal_id: "term_replacement", agent_session: { value: "replacement-session" }, tokens: { activity: "2000" }, state_change_seq: 2 });
    const handed = sasu(root, ["supervisor", "handover", "--slug", "fixture", "--approval", "user: replacement Observer takes over"], { env: { ...env, CLAUDE_SESSION_ID: "replacement-session" } });
    assert.equal(handed.status, 0, handed.text);
  } finally {
    fs.writeFileSync(release, "release\n");
  }
  const resumed = await running.completion;
  assert.notEqual(resumed.status, 0, resumed.text);
  assert.match(resumed.text, /recovery authority or implementor identity changed/);
  assert.equal(fake.prompts().length, 0, "the former Observer cannot submit input after approved handover");
  assert.equal(state(root).pendingDispatch.observer.sessionId, "replacement-session");
});

test("B2: resumed handoff sends nothing when verification acquires the run during target lookup", async () => {
  const root = fs.realpathSync(makeProject());
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({ worktree: { enabled: false } }));
  const { env, fake } = herdrEnv(root);
  assert.equal(sasu(root, ["implement", "start", "--prd", PRD_PATH, "--dirty-attribution", "run-owned"], { env }).status, 0);
  assert.equal(dispatch(root, { ...env, HERDR_FAKE_PROMPT_FAIL: "1" }).status, 1);
  const ready = path.join(root, "resume-verification-get.ready");
  const release = path.join(root, "resume-verification-get.release");
  const running = sasuAsync(root, ["implement", "dispatch", "--slug", "fixture", "--resume-handoff"], {
    env: { ...env, HERDR_FAKE_GET_BARRIER_TARGET: "w4G:p13", HERDR_FAKE_GET_BARRIER_READY: ready, HERDR_FAKE_GET_BARRIER_RELEASE: release },
    input: PACKET,
  });
  try {
    await waitForFile(ready);
    const leased = state(root);
    const attempt = attemptFixture({ id: "concurrent-verification" });
    leased.verificationAttempts.push(attempt);
    leased.activeVerification = {
      token: "verification-token", attemptId: "concurrent-verification", pid: process.pid, hostname: "test-host",
      startedAt: attempt.startedAt, inputFingerprint: attempt.inputFingerprint, prdSha256: attempt.prdSha256,
      executionPids: [], pendingSpawns: 0,
    };
    fs.writeFileSync(path.join(root, STATE_PATH), `${JSON.stringify(leased, null, 2)}\n`);
  } finally {
    fs.writeFileSync(release, "release\n");
  }
  const resumed = await running.completion;
  assert.notEqual(resumed.status, 0, resumed.text);
  assert.match(resumed.text, /verification still active: concurrent-verification/);
  assert.equal(fake.prompts().length, 0, "a verification lease acquired at the barrier prevents external input");
  assert.equal(state(root).pendingDispatch.phase, "started");
});

test("D-04: a prepared live agent without a durably captured UUID is refused rather than adopted", () => {
  const root = fs.realpathSync(makeProject());
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({ worktree: { enabled: false } }));
  const { env, fake } = herdrEnv(root);
  assert.equal(sasu(root, ["implement", "start", "--prd", PRD_PATH, "--dirty-attribution", "run-owned"], { env }).status, 0);
  const failed = dispatch(root, { ...env, HERDR_FAKE_FAIL_GET_TARGET: "w4G:p13" });
  assert.equal(failed.status, 1, failed.text);
  const partial = state(root).pendingDispatch;
  assert.equal(partial.phase, "prepared");
  assert.equal(partial.prepared.paneId, "w4G:p13");
  assert.equal(partial.implementor, null);
  assert.equal(fake.prompts().length, 0);

  const resumed = sasu(root, ["implement", "dispatch", "--slug", "fixture", "--resume-handoff"], { env, input: PACKET });
  assert.notEqual(resumed.status, 0, resumed.text);
  assert.match(resumed.text, /identity was not durably recorded before it started/);
  assert.equal(state(root).pendingDispatch.phase, "prepared");
  assert.equal(fake.prompts().length, 0);
  assert.equal(argvLog(fake.log).filter((argv) => argv[0] === "tab" && argv[1] === "create").length, 1, "recovery creates no second pane");
});

test("an in-place run's implementor is opened as a tab in the Observer's workspace", () => {
  const root = fs.realpathSync(makeProject());
  const { env, log } = herdrEnv(root);
  const started = sasu(root, ["implement", "start", "--prd", PRD_PATH, "--dirty-attribution", "run-owned"], { env });
  assert.equal(started.status, 0, started.text);
  assert.match(started.json.summary.join("\n"), /a new tab in this workspace/);

  const dispatched = dispatch(root, env);
  assert.equal(dispatched.status, 0, dispatched.text);
  const created = argvLog(log).find((argv) => argv[1] === "create");
  assert.deepEqual(created.slice(0, 8), ["tab", "create", "--workspace", "w4G", "--cwd", root, "--label", "fixture"]);
  assert.deepEqual(state(root).dispatches[0].paneId, "w4G:p13");
  assert.equal(state(root).dispatches[0].workspaceId, "w4G");
  const bookmark = JSON.parse(fs.readFileSync(path.join(root, POINTER), "utf8"));
  assert.equal(bookmark.topicSlug, "fixture", "the session-less bookmark lets the implementor's bare commands resolve");
});

test("dispatch refuses before it creates anything: no run, a foreign PRD, no workspace for an in-place run, a marked pane", () => {
  const root = makeProject();
  const { env, log } = herdrEnv(root);

  const early = dispatch(root, env);
  assert.notEqual(early.status, 0);
  assert.match(early.text, /no active implement run for this session/);

  const started = sasu(root, ["implement", "start", "--prd", PRD_PATH, "--dirty-attribution", "run-owned"], { env });
  assert.equal(started.status, 0, started.text);

  fs.mkdirSync(path.join(root, "agents", "prd", "other"), { recursive: true });
  fs.copyFileSync(path.join(root, PRD_PATH), path.join(root, "agents", "prd", "other", "prd.md"));
  const foreign = sasu(root, ["implement", "dispatch", "--name", "impl", "--prd", "agents/prd/other/prd.md"], { env, input: PACKET });
  assert.notEqual(foreign.status, 0);
  assert.match(foreign.text, /is not the PRD run 'fixture' started from/);

  const noWorkspace = dispatch(root, { ...env, HERDR_WORKSPACE_ID: "" });
  assert.notEqual(noWorkspace.status, 0);
  assert.match(noWorkspace.text, /HERDR_WORKSPACE_ID is unset/);

  const marked = dispatch(root, { ...env, SASU_HERDR_ROLE: "implementor" });
  assert.notEqual(marked.status, 0);
  assert.match(marked.text, /never dispatches another implementor/);

  assert.equal(fs.existsSync(log) && argvLog(log).some((argv) => argv[1] === "create"), false, "every refusal happened before herdr was asked to create anything");
  assert.equal(state(root).dispatches ?? null, null);
});
