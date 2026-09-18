// Real CLI boundary: the Observer starts a run and dispatches its implementor
// into a pane of its own, against a fake herdr that records every argv.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { CLI, isolatedEnv, makeProject, PRD_PATH, STATE_PATH } from "../helpers/implement-fixture.mjs";

const OBSERVER = "observer-session";
const IMPLEMENTOR = "implementor-session";
const PACKET = "ROLE: Implementor.\nPIPELINE: implement\nSOURCE: fixture\nRETURN CONTRACT: status";

/**
 * A herdr that answers the calls the dispatch makes with the shapes herdr
 * 0.9.0-preview answers them (measured 2026-09-18), and writes each argv to a
 * log so the test can assert what was asked. `HERDR_FAKE_AGENTS` names the
 * agents `agent list` reports beyond the dispatching pane.
 */
function installFakeHerdr(root) {
  const bin = path.join(root, "fake-bin");
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(root, "herdr-argv.log");
  fs.writeFileSync(path.join(bin, "herdr"), `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.HERDR_FAKE_LOG, JSON.stringify(argv) + "\\n");
const key = argv.slice(0, 2).join(" ");
const answer = (value) => { process.stdout.write(JSON.stringify(value)); process.exit(0); };
if (argv[0] === "--version") { process.stdout.write("herdr fake\\n"); process.exit(0); }
if (key === "agent list") {
  const extra = (process.env.HERDR_FAKE_AGENTS ?? "").split(",").filter(Boolean).map((name) => ({ name, agent: "claude", agent_status: "working", pane_id: "w7Z:p1" }));
  answer({ result: { type: "agent_list", agents: [{ agent: "claude", agent_status: "working", pane_id: "w4G:p12" }, ...extra] } });
}
if (key === "workspace create") answer({ result: { type: "workspace_created", workspace: { workspace_id: "w7Z" }, tab: { tab_id: "w7Z:t1" }, root_pane: { pane_id: "w7Z:p1" } } });
if (key === "tab create") answer({ result: { type: "tab_created", tab: { tab_id: "w4G:t9" }, root_pane: { pane_id: "w4G:p13" } } });
answer({ result: {} });
`, { mode: 0o755 });
  return { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, HERDR_FAKE_LOG: log, log };
}

function sasu(root, args, { env = {}, input } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args, "--json"], { cwd: root, encoding: "utf8", env: isolatedEnv(env), input, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  let json;
  try { json = JSON.parse(result.stdout); } catch { json = { stdout: result.stdout, stderr: result.stderr }; }
  return { ...result, json, text: result.stdout + result.stderr };
}

const argvLog = (log) => fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const state = (root) => JSON.parse(fs.readFileSync(path.join(root, STATE_PATH), "utf8"));

const POINTER = path.join("agents", "runs", ".prd-implement-active.json");

function herdrEnv(root, extra = {}) {
  const fake = installFakeHerdr(root);
  return { env: { HERDR_ENV: "1", HERDR_PANE_ID: "w4G:p12", HERDR_WORKSPACE_ID: "w4G", CLAUDE_SESSION_ID: OBSERVER, PATH: fake.PATH, HERDR_FAKE_LOG: fake.HERDR_FAKE_LOG, ...extra }, log: fake.log };
}

const dispatch = (root, env, extra = []) => sasu(root, ["implement", "dispatch", "--name", "impl", "--prd", PRD_PATH, ...extra], { env, input: PACKET });

// Hide lists a pane under the Herdr workspace that owns it, so an implementor
// split beside the Observer was listed under the root checkout however far
// away its worktree was, and sat in the operator's own layout (2026-09-18).
test("a worktree run's implementor is opened in a workspace on that worktree, never a split of the Observer's pane", (t) => {
  const root = fs.realpathSync(makeProject());
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({ worktree: { enabled: true } }));
  const { env, log } = herdrEnv(root);

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
  assert.deepEqual(created, ["workspace", "create", "--cwd", worktree, "--label", "fixture", "--env", "SASU_HERDR_ROLE=implementor", "--env", `PATH=${env.PATH}`, "--no-focus"]);
  assert.equal(asked.some((argv) => argv[0] === "pane" && argv[1] === "split"), false, "the Observer's pane is never split");
  assert.deepEqual(asked.find((argv) => argv[1] === "start").slice(0, 7), ["agent", "start", "impl", "--kind", "claude", "--pane", "w7Z:p1"]);
  assert.deepEqual(asked.find((argv) => argv[1] === "prompt"), ["agent", "prompt", "impl", PACKET]);
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
  const bookmark = JSON.parse(fs.readFileSync(path.join(worktree, POINTER), "utf8"));
  assert.equal(bookmark.projectRoot, root, "the bookmark names the record tree");

  // From the worktree, with no slug and a different session, the marked
  // implementor resolves the run and claims it on its first write.
  const implementorEnv = { CLAUDE_SESSION_ID: IMPLEMENTOR, SASU_HERDR_ROLE: "implementor", HERDR_ENV: "1", HERDR_PANE_ID: "w7Z:p1" };
  // Evidence is registered against the record tree, as every artifact is.
  fs.mkdirSync(path.join(root, "agents", "observations"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", "observations", "runtime.log"), "observed\n");
  const artifactArgs = ["implement", "artifact", "--kind", "log", "--path", "agents/observations/runtime.log", "--description", "observation", "--source", "fixture", "--collected-at", "2026-09-18T00:00:00.000Z"];

  const bystander = sasu(worktree, artifactArgs, { env: { CLAUDE_SESSION_ID: "someone-else" } });
  assert.notEqual(bystander.status, 0);
  assert.match(bystander.text, /was dispatched to implementor impl \(w7Z:p1\) and is its to claim/);
  assert.equal(state(root).ownerSessionId, null, "a bystander's refused write claims nothing");

  const claimed = sasu(worktree, artifactArgs, { env: implementorEnv });
  assert.equal(claimed.status, 0, claimed.text);
  assert.equal(state(root).ownerSessionId, IMPLEMENTOR);
  assert.equal(state(root).status, "active");

  // One implementor per run: a second dispatch is refused while the first is
  // listed, and allowed once herdr no longer lists it.
  const stillAlive = dispatch(root, { ...env, HERDR_FAKE_AGENTS: "impl" }, ["--adopt", "user said: take it back"]);
  assert.notEqual(stillAlive.status, 0);
  assert.match(stillAlive.text, /impl is still running in w7Z:p1/);
  assert.equal(argvLog(log).filter((argv) => argv[1] === "create").length, 1, "nothing was created for the refused dispatch");

  const replaced = sasu(root, ["implement", "dispatch", "--name", "impl-2", "--prd", PRD_PATH, "--adopt", "user said: take it back"], { env, input: PACKET });
  assert.equal(replaced.status, 0, replaced.text);
  assert.equal(state(root).dispatches.length, 2);
  assert.equal(state(root).dispatches.at(-1).agent, "impl-2");
  assert.equal(state(root).ownerSessionId, null);
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
