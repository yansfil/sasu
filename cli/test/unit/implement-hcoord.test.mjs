import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HCOORD_MISSING, HcoordCallFailed, runHcoord, sameExecution } from "../../dist/implement/hcoord.js";

test("a missing hcoord is a refusal that says what installs it, never a silent fallback", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "no-hcoord-"));
  try {
    assert.throws(() => runHcoord(["status", "--json"], { PATH: empty }), (error) => {
      assert.ok(error instanceof HcoordCallFailed);
      assert.equal(error.code, "not_installed");
      assert.equal(error.message, "hcoord is not on PATH; open the hide app, which installs it at ~/.local/bin/hcoord");
      return true;
    });
    assert.equal(HCOORD_MISSING, "hcoord is not on PATH; open the hide app, which installs it at ~/.local/bin/hcoord");
  } finally { fs.rmSync(empty, { recursive: true, force: true }); }
});

test("hcoord is found on PATH and its own exit and output are returned untouched", () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "fake-hcoord-"));
  try {
    fs.writeFileSync(path.join(bin, "hcoord"), "#!/bin/sh\nprintf '%s' \"$*\"\nexit 3\n", { mode: 0o755 });
    const answered = runHcoord(["agent", "list", "--json"], { PATH: bin });
    assert.deepEqual(answered, { stdout: "agent list --json", stderr: "", status: 3 });
  } finally { fs.rmSync(bin, { recursive: true, force: true }); }
});

// hcoord's identity rule: pane, then session, then the terminal only when no
// session is reported. Restarting Herdr rotates terminals and clears names
// without moving a participant.
test("sameExecution follows hcoord's rule: pane and session decide, a rotated terminal does not", () => {
  const recorded = { machine: "local", hostScope: "default", pane: "w1:p1", session: "s1", instance: "term_a" };
  assert.equal(sameExecution(recorded, { ...recorded, instance: "term_rotated" }), true);
  assert.equal(sameExecution(recorded, { ...recorded, session: "s2" }), false, "another session in the pane");
  assert.equal(sameExecution(recorded, { ...recorded, pane: "w1:p2" }), false, "the same session in another pane");
  assert.equal(sameExecution(recorded, { ...recorded, hostScope: "other" }), false);
  assert.equal(sameExecution(recorded, { ...recorded, machine: "mini" }), false);
  const sessionless = { ...recorded, session: null };
  assert.equal(sameExecution(sessionless, { ...sessionless, session: null }), true);
  assert.equal(sameExecution(sessionless, { ...sessionless, session: null, instance: "term_rotated" }), false, "without a session the terminal tells executions apart");
  assert.equal(sameExecution({ ...recorded, pane: null }, { ...recorded, pane: null }), false, "a participant without a pane matches nothing");
});
