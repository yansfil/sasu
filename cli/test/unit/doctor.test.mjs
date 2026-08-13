import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runDoctor } from "../../dist/doctor.js";

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sasu-doctor-"));
}

function gitInit(dir) {
  const result = spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function namespaceSection(dir) {
  const section = runDoctor(dir).sections.find((s) => s.section === "namespace");
  assert.ok(section, "doctor must report a namespace section");
  return section;
}

test("doctor namespace: a git checkout without the ignore rule fails with the one-line fix", () => {
  const dir = makeDir();
  gitInit(dir);
  const section = namespaceSection(dir);
  assert.equal(section.ok, false);
  assert.match(section.lines[0], /NOT gitignored/);
  assert.match(section.lines[0], /agents\/runs\//);
  assert.equal(runDoctor(dir).ok, false, "an unignored runs namespace must fail doctor overall");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("doctor namespace: an ignored runs namespace passes, whole-namespace rules included", () => {
  for (const rule of ["agents/runs/\n", "/agents/\n"]) {
    const dir = makeDir();
    gitInit(dir);
    fs.writeFileSync(path.join(dir, ".gitignore"), rule);
    const section = namespaceSection(dir);
    assert.equal(section.ok, true, `rule ${JSON.stringify(rule)} must satisfy the check`);
    assert.match(section.lines[0], /is gitignored/);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor namespace: outside a git checkout the check reports not-checkable and does not fail", () => {
  const dir = makeDir();
  const section = namespaceSection(dir);
  assert.equal(section.ok, true);
  assert.match(section.lines[0], /not checkable/);
  fs.rmSync(dir, { recursive: true, force: true });
});
