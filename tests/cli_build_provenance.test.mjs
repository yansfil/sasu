import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { scratchDir } from "../cli/test/scratch.mjs";

const repo = path.resolve(import.meta.dirname, "..");

test("version reports frozen build commit and dirty state from any later checkout", (t) => {
  // Build in a disposable Git repository, then advance both runtime/source
  // HEADs without rebuilding. A runtime rev-parse would report the wrong head.
  const root = scratchDir("sasu-provenance-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cli = path.join(root, "cli");
  fs.mkdirSync(cli);
  for (const entry of ["src", "lib", "scripts", "tsconfig.json", "package.json"]) fs.cpSync(path.join(repo, "cli", entry), path.join(cli, entry), { recursive: true });
  fs.symlinkSync(path.join(repo, "cli/node_modules"), path.join(cli, "node_modules"));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(GIT_|HIDE_|HERDR_)/.test(key)) delete env[key];
  const git = (cwd, ...args) => {
    const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const build = (extraEnv = {}) => {
    const result = spawnSync(process.execPath, [path.join(cli, "scripts/build.mjs")], { cwd: root, env: { ...env, ...extraEnv }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  const version = (cwd = root, args = ["version", "--json"]) => spawnSync(process.execPath, [path.join(cli, "dist/cli.js"), ...args], { cwd, env, encoding: "utf8" });
  build();
  const archive = version();
  assert.equal(archive.status, 1);
  assert.deepEqual(JSON.parse(archive.stdout).build, { status: "unavailable", reason: "git-unavailable" });

  fs.writeFileSync(path.join(root, ".gitignore"), "cli/dist*/\ncli/node_modules/\n");
  git(root, "init", "-q");
  const commit = (cwd, message) => {
    git(cwd, "add", "-A");
    git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", message);
    return git(cwd, "rev-parse", "HEAD");
  };
  const builtCommit = commit(root, "Source at build time");
  build({ GIT_DIR: path.join(root, "foreign-git-dir"), GIT_WORK_TREE: path.join(root, "foreign-worktree") });
  assert.deepEqual(JSON.parse(version().stdout).build, { status: "available", commit: builtCommit, dirty: false });

  fs.appendFileSync(path.join(cli, "src/version.ts"), "\n// Local source edit before this build.\n");
  build();
  const frozen = { status: "available", commit: builtCommit, dirty: true };
  assert.deepEqual(JSON.parse(version().stdout).build, frozen);
  assert.notEqual(commit(root, "Source advanced after build"), builtCommit);
  const runtime = path.join(root, "other-project");
  fs.mkdirSync(runtime);
  git(runtime, "init", "-q");
  fs.writeFileSync(path.join(runtime, "product.txt"), "Another product\n");
  assert.notEqual(commit(runtime, "Unrelated runtime checkout"), builtCommit);
  const observed = version(runtime);
  assert.equal(observed.status, 0, observed.stderr);
  assert.deepEqual(JSON.parse(observed.stdout).build, frozen);
  assert.equal(JSON.parse(observed.stdout).hide.required.format, 1);
  assert.match(version(runtime, ["--version"]).stdout, new RegExp(builtCommit));
  const metadata = path.join(cli, "dist/build-info.json");
  fs.writeFileSync(metadata, '{"status":"available","commit":"invalid","dirty":false}');
  assert.deepEqual(JSON.parse(version(runtime).stdout).build, { status: "unavailable", reason: "metadata-invalid" });
  fs.rmSync(metadata);
  assert.deepEqual(JSON.parse(version(runtime).stdout).build, { status: "unavailable", reason: "metadata-missing" });
});
