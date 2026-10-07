import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { INTAKE_PATH, PRD_PATH, STATE_PATH, makeProject, prd, readState, registerEvidence, run, start, ok } from "../helpers/implement-fixture.mjs";

function project(t) {
  const root = makeProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("start refuses invalid intake before sealing and accepts an internal file alias", (t) => {
  const root = project(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-intake-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "source.md"), "External unapproved source\n");
  fs.symlinkSync(path.join(outside, "source.md"), path.join(root, "agents/escape.md"));
  for (const sourceIntake of ["", "current conversation", "agents/missing.md", "agents/intake", "../source.md", "agents/escape.md"]) {
    fs.writeFileSync(path.join(root, PRD_PATH), prd({ sourceIntake }));
    const refused = run(root, ["implement", "start", "--prd", PRD_PATH]);
    assert.notEqual(refused.status, 0, sourceIntake);
    assert.match(refused.json.message, /canonical intent/);
    assert.equal(fs.existsSync(path.join(root, STATE_PATH)), false);
    assert.equal(fs.existsSync(path.join(root, "agents/runs/fixture/prd.md")), false);
  }
  fs.symlinkSync(path.join(root, INTAKE_PATH), path.join(root, "agents/alias.md"));
  fs.writeFileSync(path.join(root, PRD_PATH), prd({ sourceIntake: "agents/alias.md" }));
  ok(run(root, ["implement", "start", "--prd", PRD_PATH]));
  assert.equal(readState(root).prd.sourceIntake, "agents/alias.md");
});

test("amend refuses a missing intake without changing the sealed contract or suite", (t) => {
  const root = project(t);
  start(root);
  const before = readState(root);
  const snapshot = fs.readFileSync(path.join(root, before.prd.snapshotPath), "utf8");
  fs.writeFileSync(path.join(root, PRD_PATH), prd({ sourceIntake: "agents/missing.md", count: 3 }));
  const refused = run(root, ["implement", "amend", "--approval", "TEST: approved change", "--reason", "Change scope", "--exclude-suite", "S1"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.json.message, /canonical intent source is missing/);
  const after = readState(root);
  for (const key of ["prd", "suite", "amendments", "requirements", "verificationAttempts"]) assert.deepEqual(after[key], before[key]);
  assert.equal(fs.readFileSync(path.join(root, before.prd.snapshotPath), "utf8"), snapshot);
});

test("missing generated log recovery preserves failed history and requires fresh verification", (t) => {
  const root = project(t);
  start(root);
  ok(run(root, ["implement", "verify"]));
  const first = readState(root);
  const log = first.artifacts.find((entry) => entry.kind === "command-log");
  fs.unlinkSync(path.join(root, log.path));
  const failed = run(root, ["implement", "verify"]);
  assert.notEqual(failed.status, 0);
  assert.equal(readState(root).verificationAttempts.at(-1).verdict, "ERROR");
  const history = readState(root).verificationAttempts;
  const recovered = ok(run(root, ["implement", "artifact", "--recover", log.path, "--reason", "Generated log was accidentally removed"]));
  assert.equal(recovered.detail.reused, false);
  const repaired = readState(root);
  assert.deepEqual(repaired.verificationAttempts, history);
  assert.equal(repaired.verificationReport, null);
  assert.equal(repaired.artifacts.some((entry) => entry.path === log.path), false);
  assert.match(repaired.evidenceReplacements.at(-1).previous, new RegExp(log.sha256));
  assert.equal(fs.existsSync(path.join(root, log.path)), false, "recovery cannot fabricate execution output");
  const status = ok(run(root, ["implement", "status"]));
  assert.equal(status.detail.verification.verdict, "STALE");
  assert.equal(status.detail.delivery.eligible, false);
  const stateBytes = fs.readFileSync(path.join(root, STATE_PATH));
  assert.equal(ok(run(root, ["implement", "artifact", "--recover", log.path, "--reason", "Retry same recovery"])).detail.reused, true);
  assert.deepEqual(fs.readFileSync(path.join(root, STATE_PATH)), stateBytes);
  ok(run(root, ["implement", "verify"]));
  const fresh = readState(root);
  assert.deepEqual(fresh.verificationAttempts.slice(0, history.length), history);
  assert.equal(fresh.verificationAttempts.at(-1).verdict, "PASS");
  const replacement = fresh.artifacts.find((entry) => entry.kind === "command-log");
  assert.notEqual(replacement.path, log.path);
  assert.match(fs.readFileSync(path.join(root, replacement.path), "utf8"), /REAL-SUITE-OUTPUT/);
  assert.equal(ok(run(root, ["implement", "status"])).detail.delivery.eligible, true);
});

test("recovery refuses changed logs, unknown paths, missing observations and symlink escapes", (t) => {
  const root = project(t);
  start(root);
  const evidence = registerEvidence(root);
  ok(run(root, ["implement", "verify"]));
  const sealed = readState(root);
  const log = sealed.artifacts.find((entry) => entry.kind === "command-log");
  fs.appendFileSync(path.join(root, log.path), "tampered output\n");
  fs.unlinkSync(path.join(root, evidence));
  for (const relative of [log.path, "agents/missing.log", evidence]) {
    const refused = run(root, ["implement", "artifact", "--recover", relative, "--reason", "Attempted recovery"]);
    assert.notEqual(refused.status, 0, relative);
    assert.deepEqual(readState(root).artifacts, sealed.artifacts);
    assert.deepEqual(readState(root).evidenceReplacements, sealed.evidenceReplacements);
  }
  const logDir = path.dirname(path.join(root, log.path));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-log-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.renameSync(logDir, `${logDir}-saved`);
  fs.symlinkSync(outside, logDir);
  const escaped = run(root, ["implement", "artifact", "--recover", log.path, "--reason", "Attempted escape"]);
  assert.notEqual(escaped.status, 0);
  assert.match(escaped.json.message, /outside the project/);
  assert.deepEqual(readState(root).artifacts, sealed.artifacts);
});
