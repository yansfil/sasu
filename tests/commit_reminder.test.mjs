import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { stateFixture, SHA } from "../cli/test/helpers/implement-state.mjs";
import { captureSourceSnapshot, writeActivePointer } from "../cli/dist/implement/store.js";
import { SESSION_ID_ENV_KEYS } from "../cli/dist/runs/session.js";

const HOOK = path.resolve(import.meta.dirname, "../scripts/commit_reminder.mjs");
const START = Date.now();
function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function commit(root) {
  git(root, ["add", "-A"]);
  git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "Fixture unit"]);
}
function fixture(t, { files = 10, initialLines = 1, isolated = false, unborn = false } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "commit-reminder-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const record = path.join(base, "record");
  fs.mkdirSync(record);
  fs.writeFileSync(path.join(record, ".gitignore"), "agents/\nignored/\n");
  for (let n = 0; n < files; n++) fs.writeFileSync(path.join(record, `file-${n}.txt`), "before\n".repeat(initialLines));
  git(record, ["init", "-q"]);
  if (!unborn) commit(record);
  const root = isolated ? path.join(base, "worktree") : record;
  if (isolated) git(record, ["worktree", "add", "-qb", "fixture", root]);
  const initialSource = captureSourceSnapshot(root);
  const state = stateFixture(record, {
    ownerSessionId: "implementor", initialSource,
    baselineAttribution: { disposition: "clean", paths: [], baselineDigest: initialSource.digest, head: initialSource.head },
    worktree: isolated ? { path: root, branch: "fixture" } : null,
  });
  const statePath = path.join(record, state.runDir, "state.json");
  const save = () => { fs.mkdirSync(path.dirname(statePath), { recursive: true }); fs.writeFileSync(statePath, JSON.stringify(state)); };
  save(); writeActivePointer(record, state, "implementor");
  return { root, record, state, statePath, save, cache: path.join(path.dirname(statePath), "commit-reminder.json") };
}
function put(f, name, text) {
  fs.mkdirSync(path.dirname(path.join(f.root, name)), { recursive: true });
  fs.writeFileSync(path.join(f.root, name), text);
}
function changed(f, count) { for (let n = 0; n < count; n++) put(f, `file-${n}.txt`, "after\n"); }
function invoke(f, { at = START, payload = {}, env = {}, raw } = {}) {
  const environment = { ...process.env };
  for (const key of [...SESSION_ID_ENV_KEYS, "SASU_HERDR_ROLE", "HERDR_ENV", "HERDR_PANE_ID"]) delete environment[key];
  Object.assign(environment, env);
  const stateBefore = fs.readFileSync(f.statePath);
  const index = git(f.root, ["rev-parse", "--git-path", "index"]);
  const indexPath = path.resolve(f.root, index);
  const indexBefore = fs.existsSync(indexPath) ? fs.readFileSync(indexPath) : null;
  const sourceBefore = captureSourceSnapshot(f.root);
  // Time is the only substituted boundary. The hook, Git, pointers, run state,
  // worktree and files are real, including stdout delivery through stdin JSON.
  const result = spawnSync(process.execPath, ["--import", `data:text/javascript,Date.now%20%3D%20()%20%3D%3E%20${at}`, HOOK], {
    cwd: f.root, env: environment, encoding: "utf8", timeout: 10_000,
    input: raw ?? JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Edit", cwd: f.root, session_id: "implementor", ...payload }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(fs.readFileSync(f.statePath), stateBefore, "hook never writes run state");
  assert.deepEqual(fs.existsSync(indexPath) ? fs.readFileSync(indexPath) : null, indexBefore, "hook never changes Git index");
  assert.deepEqual(captureSourceSnapshot(f.root), sourceBefore, "hook never changes HEAD or product files");
  if (!result.stdout) return null;
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.deepEqual(Object.keys(output), ["hookSpecificOutput"], "advice has no block or automatic action");
  return output.hookSpecificOutput.additionalContext;
}

test("9 owned files stay quiet; the 10th produces advisory context in a shared clean-start run", (t) => {
  const f = fixture(t); changed(f, 9);
  assert.equal(invoke(f), null);
  changed(f, 10);
  const message = invoke(f, { at: START + 30_000 });
  assert.match(message, /10 attributable uncommitted files and 20 added\/deleted lines/);
  assert.match(message, /If you are still integrating, continue/);
  assert.match(message, /do not commit automatically/);
});

test("499 net lines stay quiet; 500 triggers without double-counting staged and unstaged edits", (t) => {
  const f = fixture(t, { files: 1 });
  put(f, "file-0.txt", "before\n" + "added\n".repeat(300)); git(f.root, ["add", "file-0.txt"]);
  put(f, "file-0.txt", "before\n" + "added\n".repeat(499));
  assert.equal(invoke(f), null);
  put(f, "file-0.txt", "before\n" + "added\n".repeat(500));
  assert.match(invoke(f, { at: START + 30_000 }), /1 attributable uncommitted files and 500 added\/deleted lines/);
});

test("new regular files and deletions count, including binary file count but no binary lines", (t) => {
  const f = fixture(t, { files: 1 });
  fs.unlinkSync(path.join(f.root, "file-0.txt"));
  for (let n = 0; n < 8; n++) put(f, `new-${n}.txt`, "new");
  put(f, "binary.bin", Buffer.from([0, 10, 1]));
  assert.match(invoke(f), /10 attributable uncommitted files and 9 added\/deleted lines/);
});

test("a 500-line deletion meets the line boundary", (t) => {
  const f = fixture(t, { files: 1, initialLines: 500 });
  fs.unlinkSync(path.join(f.root, "file-0.txt"));
  assert.match(invoke(f), /1 attributable uncommitted files and 500 added\/deleted lines/);
});

test("an unborn run counts staged and untracked current files and resets after its first commit", (t) => {
  const f = fixture(t, { files: 8, unborn: true });
  git(f.root, ["add", "file-0.txt"]);
  put(f, "file-0.txt", "after staging\n");
  assert.equal(invoke(f), null, "eight product files plus gitignore are nine files");
  put(f, "file-8.txt", "new\n");
  assert.match(invoke(f, { at: START + 30_000 }), /10 attributable uncommitted files and 11 added\/deleted lines/);
  commit(f.root);
  put(f, "file-0.txt", "after staging\n" + "new\n".repeat(500));
  assert.match(invoke(f, { at: START + 60_000 }), /1 attributable uncommitted files and 500 added\/deleted lines/);
});

test("staged deletion followed by recreation counts the actual net bytes, including exact restoration", (t) => {
  const f = fixture(t, { files: 1, initialLines: 500 });
  git(f.root, ["rm", "file-0.txt"]);
  put(f, "file-0.txt", "before\n".repeat(500));
  assert.equal(invoke(f), null);
  put(f, "file-0.txt", "before\n".repeat(500) + "new\n".repeat(499));
  assert.equal(invoke(f, { at: START + 30_000 }), null);
  put(f, "file-0.txt", "before\n".repeat(500) + "new\n".repeat(500));
  assert.match(invoke(f, { at: START + 60_000 }), /1 attributable uncommitted files and 500 added\/deleted lines/);
});

test("pre-existing, ignored, bookkeeping, unchanged baseline and symlink files are excluded", (t) => {
  const f = fixture(t); changed(f, 9);
  put(f, "file-9.txt", "foreign\n".repeat(600));
  f.state.baselineAttribution = { ...f.state.baselineAttribution, disposition: "mixed", paths: [{ path: "file-9.txt", disposition: "pre-existing" }] };
  put(f, "agents/huge.txt", "x\n".repeat(600)); put(f, "ignored/huge.txt", "x\n".repeat(600));
  fs.symlinkSync("file-9.txt", path.join(f.root, "link"));
  f.save();
  assert.equal(invoke(f), null);
  f.state.baselineAttribution.paths = [{ path: "file-9.txt", disposition: "run-owned" }]; f.save();
  assert.match(invoke(f, { at: START + 30_000 }), /10 attributable uncommitted files/);
});

test("uncommitted reversions to initial bytes count against the latest HEAD", (t) => {
  const f = fixture(t); changed(f, 10);
  commit(f.root);
  for (let n = 0; n < 10; n++) put(f, `file-${n}.txt`, "before\n");
  assert.match(invoke(f), /10 attributable uncommitted files and 20 added\/deleted lines/);
});

test("unknown or conflicting baseline ownership stays quiet", (t) => {
  const f = fixture(t); changed(f, 10);
  for (const paths of [[{ path: "file-0.txt", disposition: "unknown" }], [{ path: "file-0.txt", disposition: "run-owned" }, { path: "file-0.txt", disposition: "pre-existing" }]]) {
    f.state.baselineAttribution.paths = paths; f.save();
    assert.equal(invoke(f, { at: START + 30_000 }), null);
  }
});

test("closed, unowned, foreign-session, observer, leased and unsupported runs stay quiet", (t) => {
  const f = fixture(t); changed(f, 10);
  const original = structuredClone(f.state);
  for (const override of [
    { status: "complete" }, { status: "complete-pending-human" }, { status: "retired" }, { status: "blocked" },
    { ownerSessionId: null }, { ownerSessionId: "someone-else" }, { schema: "sasu.implement.state.v9" },
    { activeVerification: { token: "held", attemptId: "V1", pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString(), inputFingerprint: SHA, prdSha256: SHA, executionPids: [], pendingSpawns: 0 } },
  ]) {
    Object.assign(f.state, original, override); f.save();
    assert.equal(invoke(f), null);
    for (const key of Object.keys(override)) if (!(key in original)) delete f.state[key];
  }
  Object.assign(f.state, original); f.save();
  assert.equal(invoke(f, { payload: { session_id: "observer" } }), null);
  assert.equal(invoke(f, { env: { CODEX_THREAD_ID: "observer" } }), null);
  assert.equal(invoke(f, { env: { HERDR_ENV: "1" } }), null);
  assert.match(invoke(f, { env: { HERDR_ENV: "1", SASU_HERDR_ROLE: "implementor" } }), /10 attributable/);
});

test("more than 100 closed or malformed historical records do not suppress a current-run reminder", (t) => {
  const f = fixture(t); changed(f, 10);
  for (let n = 0; n < 110; n++) {
    const oldPath = path.join(f.record, `agents/runs/closed-${n}/state.json`);
    fs.mkdirSync(path.dirname(oldPath), { recursive: true });
    fs.writeFileSync(oldPath, n % 2 ? "malformed legacy history" : JSON.stringify({ schema: "retired", status: "complete", history: "x".repeat(200_000) }));
  }
  assert.match(invoke(f), /10 attributable/);
});

test("isolated worktree redirects resolve its own state and exclude record-tree changes", (t) => {
  const f = fixture(t, { isolated: true }); changed(f, 10);
  assert.equal(invoke(f, { payload: { cwd: f.record } }), null);
  fs.mkdirSync(path.join(f.root, "nested"));
  assert.match(invoke(f, { payload: { cwd: path.join(f.root, "nested"), tool_name: "Bash" } }), /10 attributable/);
});

test("checks throttle for 30 seconds; changed reminders wait 10 minutes; each content state appears once", (t) => {
  const f = fixture(t); changed(f, 10);
  assert.ok(invoke(f));
  const cache = fs.readFileSync(f.cache);
  put(f, "file-0.txt", "next\n");
  assert.equal(invoke(f, { at: START + 29_999 }), null);
  assert.deepEqual(fs.readFileSync(f.cache), cache);
  assert.equal(invoke(f, { at: START + 30_000 }), null);
  assert.equal(invoke(f, { at: START + 599_999 }), null);
  assert.ok(invoke(f, { at: START + 630_000 }));
  assert.equal(invoke(f, { at: START + 1_260_000 }), null);
  put(f, "file-0.txt", "after\n");
  assert.equal(invoke(f, { at: START + 1_890_000 }), null);
});

test("a local commit resets notification spacing for new uncommitted work", (t) => {
  const f = fixture(t); changed(f, 10);
  assert.ok(invoke(f)); commit(f.root);
  for (let n = 0; n < 10; n++) put(f, `file-${n}.txt`, "next\n");
  assert.ok(invoke(f, { at: START + 30_000 }));
});

test("malformed, irrelevant and no-run payloads stay quiet and create no cache", (t) => {
  const f = fixture(t); changed(f, 10);
  for (const raw of ["", "not json", "null", "{}", "[]"]) assert.equal(invoke(f, { raw }), null);
  for (const payload of [{ hook_event_name: "PreToolUse" }, { tool_name: "Read" }, { session_id: "" }, { cwd: "/unavailable-root" }]) assert.equal(invoke(f, { payload }), null);
  fs.unlinkSync(path.join(f.root, "agents/runs/.active/implementor.json"));
  assert.equal(invoke(f), null);
  assert.equal(fs.existsSync(f.cache), false);
});

test("a crashed advisory lock expires without affecting run or Git state", (t) => {
  const f = fixture(t); changed(f, 10);
  fs.mkdirSync(`${f.cache}.lock`);
  assert.equal(invoke(f), null);
  fs.utimesSync(`${f.cache}.lock`, new Date(START - 60_000), new Date(START - 60_000));
  assert.ok(invoke(f));
});
