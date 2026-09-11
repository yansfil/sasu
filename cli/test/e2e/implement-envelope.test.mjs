import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { makeProject, readState, run, runAsync, start, stub, ok } from "../helpers/implement-fixture.mjs";

const heldSuite = `const fs = require('node:fs'); fs.mkdirSync('agents', { recursive: true }); fs.writeFileSync('agents/suite-ready', String(process.pid)); const timer = setInterval(() => { if (fs.existsSync('agents/suite-release')) { clearInterval(timer); console.log('suite released'); } }, 20);`;
// The concurrent full E2E suite took 33.5s across the sequential refusal
// subprocesses. Bound orchestration separately from each CLI's 30s timeout.
const LEASE_TEST_TIMEOUT = 90_000;
// The inner wait is derived from the test's own timeout rather than carried as
// a second number. At 30_000 it was the tighter of the two, so a slow but
// correct run failed here while the test still had 60s of its own budget
// unspent - these tests spawn the CLI twice and run a real held suite, which
// takes ~2.8s alone and more than 10x that when other suites run beside it
// (2026-09-11: reported as the lease-recovery flake, 45.3s total, which is
// this wait expiring plus its setup). The margin leaves room for the
// assertions that follow the wait.
const UNTIL_TIMEOUT = LEASE_TEST_TIMEOUT - 15_000;
async function until(condition, message, timeout = UNTIL_TIMEOUT) {
  const started = Date.now();
  const deadline = started + timeout;
  while (Date.now() < deadline) { if (condition()) return; await delay(25); }
  // The elapsed time and the budget are in the message because without them a
  // wait expiry and a failed assertion read the same in a log.
  assert.fail(`${message} (waited ${Date.now() - started}ms of ${timeout}ms)`);
}

test("the whole verify lease refuses every domain mutation and merges their refusal history before releasing", { timeout: LEASE_TEST_TIMEOUT }, async (t) => {
  const root = makeProject({ suiteSource: heldSuite });
  start(root);
  fs.writeFileSync(path.join(root, "agents/observation.log"), "observation\n");
  const env = { ...stub(root), SASU_JUDGE_STUB_DELAY_MS: JSON.stringify({ "implement:fidelity": 3_000 }) };
  const execution = runAsync(root, ["implement", "verify"], env);
  t.after(() => { fs.writeFileSync(path.join(root, "agents/suite-release"), "release\n"); execution.child.kill("SIGTERM"); });
  await until(() => fs.existsSync(path.join(root, "agents/suite-ready")) && readState(root).activeVerification?.executionPids.length > 0, "suite did not enter its recorded execution lease");
  const before = readState(root);
  const commands = [
    ["verify"], ["finalize"], ["retire"],
    ["amend", "--issuer", "human", "--approval", "I approve the amendment", "--reason", "fixture"],
    ["artifact", "--path", "agents/observation.log", "--kind", "log", "--description", "observation", "--source", "fixture", "--collected-at", "2026-09-08T00:00:00Z"],
    ["risk", "--accept", "--id", "RF1", "--evidence", "I accept the risk"],
    ["confirm", "--issuer", "human", "--id", "F1", "--evidence", "I approve"],
    ["escalate", "--issuer", "observer", "--reason", "stalled verification"],
  ];
  for (const command of commands) {
    const refused = run(root, ["implement", ...command]);
    assert.notEqual(refused.status, 0, command.join(" "));
    assert.match(refused.json.message, /verification still active|execution lease|verification.*in progress/, command.join(" "));
  }
  const takeover = run(root, ["implement", "retire", "--adopt", "I approve taking over the run"], { env: { CLAUDE_CODE_SESSION_ID: "foreign-fixture-session" } });
  assert.notEqual(takeover.status, 0);
  assert.equal(readState(root).ownerSessionId, before.ownerSessionId);
  assert.equal(readState(root).adoptions.length, before.adoptions.length);
  const refusedIds = readState(root).verbs.filter((entry) => entry.outcome === "rejected").map((entry) => entry.id);
  assert.ok(refusedIds.length >= commands.length);
  const observed = ok(run(root, ["implement", "status"]));
  assert.equal(observed.detail.status, "active");
  fs.writeFileSync(path.join(root, "agents/suite-release"), "release\n");
  await until(() => readState(root).verificationAttempts.at(-1)?.phase === "review", "review did not begin");
  assert.notEqual(run(root, ["implement", "retire"]).status, 0, "the lease must cover review, not merely suite execution");
  ok(await execution.done);
  const after = readState(root);
  assert.equal(after.activeVerification, undefined);
  assert.equal(after.verificationAttempts.length, 1);
  assert.equal(after.verificationAttempts[0].verdict, "PASS");
  for (const id of refusedIds) assert.ok(after.verbs.some((entry) => entry.id === id && entry.outcome === "rejected"), `refusal ${id} lost to a stale completion write`);
  ok(run(root, ["implement", "finalize"]));
});

test("recovery terminates a dead owner's command group before a new verification can run", { skip: process.platform === "win32", timeout: LEASE_TEST_TIMEOUT }, async (t) => {
  const root = makeProject({ suiteSource: heldSuite });
  start(root);
  const env = stub(root);
  const execution = runAsync(root, ["implement", "verify"], env);
  let retry;
  let groups = [];
  t.after(() => {
    execution.child.kill("SIGKILL");
    retry?.child.kill("SIGKILL");
    fs.writeFileSync(path.join(root, "agents/suite-release"), "release\n");
    for (const group of groups) { try { process.kill(-group, "SIGKILL"); } catch {} }
  });
  await until(() => fs.existsSync(path.join(root, "agents/suite-ready")) && readState(root).activeVerification?.executionPids.length > 0, "suite never registered");
  groups = readState(root).activeVerification.executionPids;
  const original = readState(root).activeVerification.attemptId;
  const originalSuitePid = fs.readFileSync(path.join(root, "agents/suite-ready"), "utf8");
  execution.child.kill("SIGKILL");
  await execution.done;
  assert.equal(groups.some((pid) => { try { process.kill(-pid, 0); return true; } catch { return false; } }), true, "the killed owner left a real running command group");
  retry = runAsync(root, ["implement", "verify"], env);
  // A refused retry will never satisfy the wait below, so watching only the
  // state turns an immediate, explained refusal into a silent wait expiry.
  // Measured 2026-09-11 under three concurrent runs of this file: 4 of 15 runs
  // exited 2 with "liveness probe of process group N failed with EPERM", and
  // by the time the test looked, that same group answered ESRCH. The group is
  // reaped, its id is briefly taken by a process that is not ours, and the
  // probe refuses rather than read an unreadable signal as absence. Surfacing
  // the exit is the test's job; whether that refusal is the right product
  // behaviour is a separate question recorded in the investigation notes.
  let refused;
  retry.done.then((result) => { if (result.status !== 0) refused = result; }, () => {});
  await until(
    () => refused !== undefined
      || (fs.readFileSync(path.join(root, "agents/suite-ready"), "utf8") !== originalSuitePid && readState(root).activeVerification?.attemptId !== original),
    "recovery never reached the next real suite execution",
  );
  assert.equal(refused, undefined, `the recovering run refused instead of starting the next execution: ${JSON.stringify(refused?.stdout ?? "")}`);
  for (const pid of groups) assert.throws(() => process.kill(-pid, 0), { code: "ESRCH" }, "the old group must be gone before the next execution starts");
  fs.writeFileSync(path.join(root, "agents/suite-release"), "release\n");
  ok(await retry.done);
  const state = readState(root);
  assert.equal(state.verificationAttempts[0].error.code, "verification-interrupted");
  assert.equal(state.verificationAttempts[0].reviews.fidelity, null);
  assert.equal(state.verificationAttempts.at(-1).verdict, "PASS");
  assert.equal(state.activeVerification, undefined);
});
