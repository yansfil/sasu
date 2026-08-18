import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureSetup } from "../../dist/support/ensure-setup.js";

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sasu-ensure-setup-"));
}

function gitInit(dir) {
  const result = spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function ignored(dir, root = "agents/runs/") {
  return spawnSync("git", ["check-ignore", "-q", `${root}probe`], { cwd: dir, encoding: "utf8" }).status === 0;
}

test("ensure-setup: a git checkout without the rule gets info/exclude provisioned, once", () => {
  const dir = makeDir();
  gitInit(dir);
  const notices = ensureSetup(dir);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /agents\/runs\//);
  assert.match(notices[0], /agents\/quick\//);
  assert.ok(ignored(dir), "agents/runs/ must be ignored after provisioning");
  assert.ok(ignored(dir, "agents/quick/"), "agents/quick/ must be ignored after provisioning");
  // The judged working tree stays untouched: the old .gitignore append put a
  // harness-owned diff into every run until a human committed it.
  assert.equal(fs.existsSync(path.join(dir, ".gitignore")), false, "provisioning must not touch the working tree");
  const excludePath = path.join(dir, ".git", "info", "exclude");
  const provisioned = fs.readFileSync(excludePath, "utf8");
  assert.ok(provisioned.split("\n").includes("agents/runs/"));
  assert.ok(provisioned.split("\n").includes("agents/quick/"));
  assert.deepEqual(ensureSetup(dir), [], "second run must be a no-op");
  assert.equal(fs.readFileSync(excludePath, "utf8"), provisioned, "second run must not touch the file");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("ensure-setup: appends as its own line when info/exclude lacks a trailing newline", () => {
  const dir = makeDir();
  gitInit(dir);
  const excludePath = path.join(dir, ".git", "info", "exclude");
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  fs.writeFileSync(excludePath, "node_modules");
  ensureSetup(dir);
  const content = fs.readFileSync(excludePath, "utf8");
  assert.ok(content.split("\n").includes("agents/runs/"), `rule must land on its own line, got: ${JSON.stringify(content)}`);
  assert.ok(content.split("\n").includes("agents/quick/"), `every runtime root must land on its own line, got: ${JSON.stringify(content)}`);
  assert.ok(content.split("\n").includes("node_modules"), "existing rule must survive intact");
  assert.ok(ignored(dir));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("ensure-setup: any already-matching ignore rule is left alone, glob forms and .gitignore included", () => {
  for (const rule of ["agents/runs/\nagents/quick/\n", "/agents/\n"]) {
    const dir = makeDir();
    gitInit(dir);
    fs.writeFileSync(path.join(dir, ".gitignore"), rule);
    assert.deepEqual(ensureSetup(dir), []);
    assert.equal(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), rule);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensure-setup: outside a git checkout nothing is enforced or written", () => {
  const dir = makeDir();
  assert.deepEqual(ensureSetup(dir), []);
  assert.equal(fs.existsSync(path.join(dir, ".gitignore")), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Regression: agents/quick/ was never in the provisioned set, so a project that
// already ignored agents/runs/ silently committed quick contracts, receipts and
// evidence blobs (creator-assist, 2026-08-18: 710KB of screenshots landed in a
// commit). A partially provisioned checkout must gain only the missing root.
test("ensure-setup: a checkout that ignores only agents/runs/ gains agents/quick/", () => {
  const dir = makeDir();
  gitInit(dir);
  fs.writeFileSync(path.join(dir, ".gitignore"), "agents/runs/\n");
  const notices = ensureSetup(dir);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /agents\/quick\//);
  assert.doesNotMatch(notices[0], /agents\/runs\//, "an already-ignored root must not be re-provisioned");
  const provisioned = fs.readFileSync(path.join(dir, ".git", "info", "exclude"), "utf8").split("\n");
  assert.ok(provisioned.includes("agents/quick/"));
  assert.equal(provisioned.includes("agents/runs/"), false);
  assert.deepEqual(ensureSetup(dir), [], "second run must be a no-op");
  fs.rmSync(dir, { recursive: true, force: true });
});
