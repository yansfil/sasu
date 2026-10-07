// An Observer a lead spawned already has a live Hide registration under that
// lead. Dispatch and handover adopt it; a directly opened Observer registers
// itself as before (sasu#19, 2026-10-07).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { CLI, isolatedEnv, makeProject, PRD_PATH, STATE_PATH } from "../helpers/implement-fixture.mjs";
import { installFakeHerdr } from "../helpers/fake-herdr.mjs";

const OBSERVER = "w4G:p12", NEXT = "w4G:p14", LEAD = "w9J:p5F", SCOPE = "/tmp/fake.sock";
const PACKET = "ROLE: Implementor.\nPIPELINE: implement\nSOURCE: fixture\nRETURN CONTRACT: status";
function sasu(cwd, args, { env, input } = {}) {
  const run = spawnSync(process.execPath, [CLI, ...args, "--json"], { cwd, encoding: "utf8", env: isolatedEnv(env), input, timeout: 30_000 });
  return { ...run, text: run.stdout + run.stderr };
}
function fixture(t) {
  const root = fs.realpathSync(makeProject());
  fs.writeFileSync(path.join(root, "agents/config.json"), JSON.stringify({ worktree: { enabled: false } }));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sasu-observer-registration-")));
  const fake = installFakeHerdr(outside), home = path.join(outside, "home"); fs.mkdirSync(home);
  const env = { HOME: home, ...fake.env, HERDR_ENV: "1", HERDR_PANE_ID: OBSERVER, HERDR_WORKSPACE_ID: "w4G", HERDR_SOCKET_PATH: SCOPE, CLAUDE_SESSION_ID: "observer-session" };
  t.after(() => { fs.rmSync(outside, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal(sasu(root, ["implement", "start", "--prd", PRD_PATH, "--dirty-attribution", "run-owned"], { env }).status, 0);
  const ledger = () => fs.existsSync(env.HIDE_FAKE_STATE) ? JSON.parse(fs.readFileSync(env.HIDE_FAKE_STATE, "utf8")) : { seq: 0, participants: {}, requests: {} };
  return { root, fake, env, ledger,
    state: () => JSON.parse(fs.readFileSync(path.join(root, STATE_PATH), "utf8")),
    participants: () => ledger().participants,
    registrations: (pane) => fs.readFileSync(env.HIDE_FAKE_LOG, "utf8").trim().split("\n").map(JSON.parse).filter((argv) => argv[0] === "agent" && argv[1] === "register" && argv[argv.indexOf("--pane") + 1] === pane),
    dispatch: () => sasu(root, ["implement", "dispatch", "--name", "impl", "--prd", PRD_PATH], { env, input: PACKET }),
    /** What `hide agent spawn --parent` leaves behind: the child registered under the lead with the lead's name for it, and the lead's watch on it. */
    spawnedByLead(pane, session, name) {
      const current = ledger(), actor = (p) => ({ pane_id: p.pane, name: p.name, kind: "claude", device_id: "local", session: p.session });
      const lead = Object.values(current.participants).find((p) => p.pane === LEAD) ?? { id: `a_${++current.seq}`, name: "lead", machine: "local", hostScope: SCOPE, pane: LEAD, session: "lead-session", instance: LEAD, parent: null, project: root, runtime: "running", connection: "connected", registered: true, watch: null };
      const child = { id: `a_${++current.seq}`, name, machine: "local", hostScope: SCOPE, pane, session, instance: pane, parent: lead.id, project: root, runtime: "running", connection: "connected", registered: true, watch: null };
      child.watch = { id: `watch_${++current.seq}`, parent: actor(lead), target: actor(child), generation: 0, last_activity_at_unix_ms: 1, first_warning_at_unix_ms: null, warning_count: 0, activity_failures: 0, last_status: "working", last_state_change_seq: 1, status_changed_at_unix_ms: 1 };
      current.participants[lead.id] = lead; current.participants[child.id] = child;
      fs.writeFileSync(env.HIDE_FAKE_STATE, JSON.stringify(current, null, 2));
      return structuredClone(child);
    },
  };
}

test("dispatch from an Observer a lead spawned keeps its registration, parent and the lead's watch", (t) => {
  const run = fixture(t), spawned = run.spawnedByLead(OBSERVER, "observer-session", "observer-spawned-by-lead");
  const dispatched = run.dispatch();
  assert.equal(dispatched.status, 0, dispatched.text);
  const ids = run.state().supervision.hide, participants = run.participants();
  assert.equal(ids.observer, spawned.id);
  assert.deepEqual(participants[spawned.id], spawned, "registration id, name, parent and the lead's watch are unchanged");
  assert.equal(participants[ids.implementor].parent, spawned.id);
  assert.equal(participants[ids.implementor].watch.id, ids.watchId);
  assert.deepEqual(run.registrations(OBSERVER), [], "the lead-owned registration is never re-registered");
});

test("dispatch from an Observer opened directly registers it without a parent", (t) => {
  const run = fixture(t);
  const dispatched = run.dispatch();
  assert.equal(dispatched.status, 0, dispatched.text);
  const ids = run.state().supervision.hide, participants = run.participants();
  assert.equal(participants[ids.observer].pane, OBSERVER);
  assert.equal(participants[ids.observer].parent, null);
  assert.equal(participants[ids.implementor].parent, ids.observer);
  assert.deepEqual(run.registrations(OBSERVER).map((argv) => argv.includes("--check")), [true, false]);
});

test("handover to an Observer a lead spawned adopts its registration and moves the run's watch to it", (t) => {
  const run = fixture(t);
  assert.equal(run.dispatch().status, 0);
  run.fake.patchAgent(NEXT, { name: "next-observer", agent: "claude", agent_status: "working", pane_id: NEXT, terminal_id: "term_next", agent_session: { value: "next-session" }, tokens: { activity: String(Date.now()) }, state_change_seq: 2 });
  const spawned = run.spawnedByLead(NEXT, "next-session", "next-spawned-by-lead");
  const env = { ...run.env, HERDR_PANE_ID: NEXT, CLAUDE_SESSION_ID: "next-session" };
  const handed = sasu(run.root, ["supervisor", "handover", "--slug", "fixture", "--approval", "The spawned Observer takes this run"], { env });
  assert.equal(handed.status, 0, handed.text);
  const ids = run.state().supervision.hide, participants = run.participants();
  assert.equal(ids.observer, spawned.id);
  assert.deepEqual(participants[spawned.id], spawned);
  assert.equal(participants[ids.implementor].watch.parent.pane_id, NEXT);
  assert.deepEqual(run.registrations(NEXT), []);
});
