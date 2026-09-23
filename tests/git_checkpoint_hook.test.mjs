import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const HOOK = path.resolve(import.meta.dirname, "../scripts/hooks/git-checkpoint.mjs");
const INSTALLER = path.resolve(import.meta.dirname, "../scripts/hooks/install.mjs");

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

function git(root, args, { allowFailure = false, encoding = "utf8" } = {}) {
  const result = spawnSync("git", args, { cwd: root, encoding });
  if (!allowFailure) assert.equal(result.status, 0, result.stderr?.toString());
  return result;
}

function commit(root, message = "Fixture") {
  git(root, ["add", "-A"]);
  git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", message]);
}

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "git-checkpoint-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "repo");
  fs.mkdirSync(root);
  git(root, ["init", "-q"]);
  for (const [name, value] of [["tracked.txt", "before\n"], ["deleted.txt", "delete me\n"], ["staged.txt", "before stage\n"]]) {
    fs.writeFileSync(path.join(root, name), value);
  }
  commit(root);
  return { base, root, log: path.join(base, "hook.jsonl") };
}

function indexBytes(root) {
  const index = git(root, ["rev-parse", "--git-path", "index"]).stdout.trim();
  const file = path.isAbsolute(index) ? index : path.resolve(root, index);
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

function observedState(root) {
  return {
    head: git(root, ["rev-parse", "HEAD"]).stdout.trim(),
    branch: git(root, ["branch", "--show-current"]).stdout.trim(),
    branches: git(root, ["for-each-ref", "--format=%(refname)", "refs/heads"]).stdout,
    index: indexBytes(root),
    status: git(root, ["status", "--porcelain=v1", "-z"], { encoding: null }).stdout,
  };
}

function invoke(f, { cwd = f.root, env = {}, input } = {}) {
  return run(process.execPath, [HOOK], {
    cwd,
    env: { ...process.env, HOME: f.base, SASU_HOOK_LOG: f.log, ...env },
    input: input ?? JSON.stringify({ hook_event_name: "Stop", cwd }),
  });
}

function checkpointRefs(root) {
  return git(root, ["for-each-ref", "--format=%(refname)", "refs/sasu/checkpoints"]).stdout.trim().split("\n").filter(Boolean);
}

test("dirty tracked, staged, untracked and deleted files are captured without changing Git state", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, "tracked.txt"), "after\n");
  fs.unlinkSync(path.join(f.root, "deleted.txt"));
  fs.writeFileSync(path.join(f.root, "staged.txt"), "staged after\n");
  git(f.root, ["add", "staged.txt"]);
  fs.writeFileSync(path.join(f.root, "untracked.txt"), "new\n");
  const before = observedState(f.root);

  const result = invoke(f);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.deepEqual(observedState(f.root), before);
  const [ref] = checkpointRefs(f.root);
  assert.ok(ref);
  assert.equal(git(f.root, ["show", `${ref}:tracked.txt`]).stdout, "after\n");
  assert.equal(git(f.root, ["show", `${ref}:staged.txt`]).stdout, "staged after\n");
  assert.equal(git(f.root, ["show", `${ref}:untracked.txt`]).stdout, "new\n");
  assert.notEqual(git(f.root, ["cat-file", "-e", `${ref}:deleted.txt`], { allowFailure: true }).status, 0);
  assert.doesNotMatch(git(f.root, ["log", "--format=%s", "--all"]).stdout, /^checkpoint:/m);
});

test("the latest tree converges to one ref per worktree and a clean tree clears its ref", (t) => {
  const f = fixture(t);
  const linked = path.join(f.base, "linked");
  git(f.root, ["worktree", "add", "--detach", "-q", linked, "HEAD"]);
  fs.writeFileSync(path.join(f.root, "tracked.txt"), "main dirty\n");
  fs.writeFileSync(path.join(linked, "tracked.txt"), "linked dirty\n");

  assert.equal(invoke(f).status, 0);
  const mainRef = checkpointRefs(f.root)[0];
  const firstCommit = git(f.root, ["rev-parse", mainRef]).stdout.trim();
  assert.equal(invoke(f).status, 0);
  assert.equal(git(f.root, ["rev-parse", mainRef]).stdout.trim(), firstCommit, "same snapshot is idempotent");

  fs.writeFileSync(path.join(f.root, "transient.txt"), "committed then deleted\n");
  git(f.root, ["add", "transient.txt"]);
  git(f.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "Advance HEAD"]);
  fs.unlinkSync(path.join(f.root, "transient.txt"));
  assert.equal(invoke(f).status, 0);
  const rebasedCheckpoint = git(f.root, ["rev-parse", mainRef]).stdout.trim();
  assert.notEqual(rebasedCheckpoint, firstCommit, "the same recovery tree is refreshed after HEAD moves");
  assert.equal(git(f.root, ["rev-parse", `${rebasedCheckpoint}^`]).stdout.trim(), git(f.root, ["rev-parse", "HEAD"]).stdout.trim());

  assert.equal(invoke(f, { cwd: linked }).status, 0);
  assert.equal(checkpointRefs(f.root).length, 2, "linked worktree owns a different recovery ref");

  fs.writeFileSync(path.join(f.root, "tracked.txt"), "before\n");
  fs.writeFileSync(path.join(f.root, "transient.txt"), "committed then deleted\n");
  assert.equal(invoke(f).status, 0);
  assert.equal(checkpointRefs(f.root).length, 1, "cleaning one worktree clears only its stale ref");
});

test("secret-like and oversized files are excluded and the structured log rotates below its cap", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, "tracked.key"), "old key\n");
  commit(f.root, "Add tracked secret fixture");
  fs.writeFileSync(path.join(f.root, "tracked.key"), "new key\n");
  fs.writeFileSync(path.join(f.root, ".env"), "TOKEN=not-for-git\n");
  fs.writeFileSync(path.join(f.root, "private.pem"), "not-for-git\n");
  fs.writeFileSync(path.join(f.root, "normal.txt"), "captured\n");
  const descriptor = fs.openSync(path.join(f.root, "large.bin"), "w");
  fs.ftruncateSync(descriptor, 10 * 1024 * 1024 + 1);
  fs.closeSync(descriptor);
  fs.writeFileSync(f.log, "x".repeat(1024 * 1024 - 1));

  assert.equal(invoke(f).status, 0);

  const [ref] = checkpointRefs(f.root);
  assert.equal(git(f.root, ["show", `${ref}:normal.txt`]).stdout, "captured\n");
  assert.equal(git(f.root, ["show", `${ref}:tracked.key`]).stdout, "old key\n");
  for (const name of [".env", "private.pem", "large.bin"]) {
    assert.notEqual(git(f.root, ["cat-file", "-e", `${ref}:${name}`], { allowFailure: true }).status, 0);
  }
  const event = JSON.parse(fs.readFileSync(f.log, "utf8"));
  assert.equal(event.event, "recovery-checkpoint.saved");
  assert.equal(event.excludedSecrets, 3);
  assert.equal(event.excludedLargeFiles, 1);
  assert.ok(fs.statSync(f.log).size < 1024 * 1024);
  assert.ok(fs.statSync(`${f.log}.1`).size <= 1024 * 1024);
  assert.doesNotMatch(fs.readFileSync(f.log, "utf8"), /TOKEN|private\.pem|\.env/);
});

test("a checkpoint failure is visible but remains non-blocking", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, "tracked.txt"), "dirty\n");

  const result = invoke(f, { env: { PATH: "" } });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(JSON.parse(result.stdout).systemMessage, /recovery snapshot failed/i);
  assert.equal(checkpointRefs(f.root).length, 0);
});

test("installer replaces legacy checkpoint hooks, retires WorktreeCreate and preserves foreign hooks", (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "git-checkpoint-install-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const foreign = { type: "command", command: "echo foreign" };
  const legacyCheckpoint = { type: "command", command: "/old/scripts/hooks/git-checkpoint.sh" };
  const legacyWorktree = { hooks: [{ type: "command", command: "/old/scripts/hooks/worktree-create.sh" }] };
  const files = [path.join(home, ".claude", "settings.json"), path.join(home, ".codex", "hooks.json")];
  for (const file of files) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ keep: true, hooks: {
      Stop: [{ hooks: [foreign, legacyCheckpoint] }],
      WorktreeCreate: [legacyWorktree, { hooks: [foreign] }],
    } }, null, 2)}\n`);
  }
  const environment = { ...process.env, HOME: home };

  const installed = run(process.execPath, [INSTALLER], { env: environment });
  assert.equal(installed.status, 0, installed.stderr);
  for (const file of files) {
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(config.keep, true);
    assert.deepEqual(config.hooks.WorktreeCreate, [{ hooks: [foreign] }]);
    assert.deepEqual(config.hooks.Stop[0], { hooks: [foreign] });
    assert.match(config.hooks.Stop[1].hooks[0].command, /^node .*git-checkpoint\.mjs$/);
  }

  const repeated = JSON.parse(run(process.execPath, [INSTALLER], { env: environment }).stdout);
  assert.ok(repeated.results.every(result => result.changed === false));
  const removed = run(process.execPath, [INSTALLER, "--uninstall"], { env: environment });
  assert.equal(removed.status, 0, removed.stderr);
  for (const file of files) {
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(config.hooks.Stop, [{ hooks: [foreign] }]);
    assert.deepEqual(config.hooks.WorktreeCreate, [{ hooks: [foreign] }]);
  }
});
