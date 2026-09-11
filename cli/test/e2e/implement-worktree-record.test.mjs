// Real CLI boundary: a run isolated into a worktree, queried from other trees.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { makeProject, run, PRD_PATH, STATE_PATH } from "../helpers/implement-fixture.mjs";

// 2026-09-10: `implement start` isolated the run into a worktree and kept the
// record in the tree that started it; the Observer's `status --slug` and
// `await --slug` from another worktree of the same repository answered
// "state not found", and it waited on a record that was never going to appear
// there. A slug names a run, not a tree.
test("a --slug run record is found from any worktree of the same repository", (t) => {
  const root = makeProject();
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({ worktree: { enabled: true } }));
  const started = run(root, ["implement", "start", "--prd", PRD_PATH, "--dirty-attribution", "run-owned"]);
  assert.equal(started.status, 0, started.stdout + started.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(root, STATE_PATH), "utf8"));
  const worktree = state.worktree?.path;
  assert.ok(worktree && fs.existsSync(worktree), "the run was isolated into a worktree");
  t.after(() => fs.rmSync(path.dirname(worktree), { recursive: true, force: true }));
  assert.equal(fs.existsSync(path.join(worktree, STATE_PATH)), false, "the record lives in the tree that started the run");

  const fromWorktree = run(worktree, ["implement", "status", "--slug", "fixture"], { env: { CLAUDE_SESSION_ID: "another-session" } });
  assert.equal(fromWorktree.status, 0, fromWorktree.stdout + fromWorktree.stderr);
  assert.equal(fromWorktree.json.ok, true);
  assert.equal(fromWorktree.json.action, "status");

  // A record present in two trees is not resolved by luck.
  const twin = path.join(path.dirname(worktree), "twin");
  const added = spawnSync("git", ["worktree", "add", "-q", "-b", "twin", twin], { cwd: root, encoding: "utf8" });
  assert.equal(added.status, 0, added.stderr);
  fs.mkdirSync(path.join(twin, path.dirname(STATE_PATH)), { recursive: true });
  fs.copyFileSync(path.join(root, STATE_PATH), path.join(twin, STATE_PATH));
  const ambiguous = run(worktree, ["implement", "status", "--slug", "fixture"], { env: { CLAUDE_SESSION_ID: "another-session" } });
  assert.notEqual(ambiguous.status, 0);
  assert.match(ambiguous.stdout + ambiguous.stderr, /more than one worktree/);
});
