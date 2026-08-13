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

function ignored(dir) {
  return spawnSync("git", ["check-ignore", "-q", "agents/runs/probe"], { cwd: dir, encoding: "utf8" }).status === 0;
}

test("ensure-setup: a git checkout without the rule gets it appended, once", () => {
  const dir = makeDir();
  gitInit(dir);
  const notices = ensureSetup(dir);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /agents\/runs\//);
  assert.ok(ignored(dir), "agents/runs/ must be ignored after provisioning");
  const provisioned = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
  assert.deepEqual(ensureSetup(dir), [], "second run must be a no-op");
  assert.equal(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), provisioned, "second run must not touch the file");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("ensure-setup: appends as its own line when .gitignore lacks a trailing newline", () => {
  const dir = makeDir();
  gitInit(dir);
  fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules");
  ensureSetup(dir);
  const content = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
  assert.ok(content.split("\n").includes("agents/runs/"), `rule must land on its own line, got: ${JSON.stringify(content)}`);
  assert.ok(content.split("\n").includes("node_modules"), "existing rule must survive intact");
  assert.ok(ignored(dir));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("ensure-setup: any already-matching ignore rule is left alone, glob forms included", () => {
  for (const rule of ["agents/runs/\n", "/agents/\n"]) {
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
