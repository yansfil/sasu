import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { scratchDir } from "../scratch.mjs";
import { stateFixture, attemptFixture, AT } from "../helpers/implement-state.mjs";
import { assertNoActiveVerification, beginVerification, finishVerification, completeVerificationExecution, prepareVerificationExecution, recordVerificationExecution, recoverVerification, progressVerification } from "../../dist/implement/verification-activity.js";
import { loadState, persistState } from "../../dist/implement/store.js";
import { reconcileReviewFindings } from "../../dist/implement/convergence.js";
import { REVIEW_PASS, defect } from "../helpers/implement-fixture.mjs";

function fixture(t) {
  const root = scratchDir("sasu-verification-activity-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const statePath = path.join(root, "agents/runs/fixture/state.json");
  const state = stateFixture(root);
  persistState(statePath, state);
  return { root, statePath, state, reload: () => loadState(root, { slug: "fixture" }).state };
}
const refusal = (id = 1) => ({ id, at: AT, verb: "retire", issuer: "human", target: null, reason: "fixture", outcome: "rejected", rejection: { check: "transition", message: "verification still active" } });

test("a live verify lease blocks every domain mutation while preserving refusal-only writes", (t) => {
  const f = fixture(t);
  beginVerification(f.statePath, f.state, attemptFixture());
  assert.throws(() => beginVerification(f.statePath, f.reload(), attemptFixture({ id: "V2" })), /verification still active/);
  for (const mutate of [s => s.status = "retired", s => s.ownerSessionId = "another", s => s.findings.push({}), s => s.riskFindings.push({}), s => s.escalations.push({})]) {
    const state = f.reload(); mutate(state);
    assert.throws(() => persistState(f.statePath, state), /other domain mutations/);
  }
  const refused = f.reload(); refused.verbs.push(refusal());
  persistState(f.statePath, refused, { refusalOnly: true });
  finishVerification(f.statePath, f.state, fresh => { fresh.verificationAttempts[0].verdict = "ERROR"; });
  assert.equal(f.reload().verbs.length, 1);
  assert.equal(f.reload().activeVerification, undefined);
});

test("a dead owner is recovered only after every registered process group exits", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  beginVerification(f.statePath, f.state, attemptFixture());
  const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { detached: true, stdio: ["pipe", "ignore", "ignore"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  await once(child, "spawn");
  prepareVerificationExecution(f.statePath, f.state);
  recordVerificationExecution(f.statePath, f.state, child.pid);
  const dead = spawnSync(process.execPath, ["-e", ""], { detached: true });
  progressVerification(f.statePath, f.state, fresh => { fresh.activeVerification.pid = dead.pid; });
  const exited = once(child, "exit");
  await recoverVerification(f.statePath, f.reload());
  await exited;
  assert.throws(() => process.kill(-child.pid, 0), (error) => error.code === "ESRCH");
  assert.equal(f.reload().verificationAttempts[0].error.code, "verification-interrupted");
  assert.equal(f.reload().activeVerification, undefined);
});

test("a crash inside process registration leaves an explicit uncertainty instead of stealing the lease", async (t) => {
  const f = fixture(t);
  beginVerification(f.statePath, f.state, attemptFixture());
  prepareVerificationExecution(f.statePath, f.state);
  const dead = spawnSync(process.execPath, ["-e", ""]);
  progressVerification(f.statePath, f.state, fresh => { fresh.activeVerification.pid = dead.pid; });
  await assert.rejects(() => recoverVerification(f.statePath, f.reload()), /uninspectable/);
  const remote = f.reload(); remote.activeVerification.hostname = `${os.hostname()}-remote`;
  assert.throws(() => assertNoActiveVerification(remote), /uninspectable/);
});

test("verification progress merges concurrent refusal history and rejects a stolen token", (t) => {
  const f = fixture(t);
  beginVerification(f.statePath, f.state, attemptFixture());
  const refused = f.reload(); refused.verbs.push(refusal());
  persistState(f.statePath, refused, { refusalOnly: true });
  const progressed = progressVerification(f.statePath, f.state, fresh => { fresh.verificationAttempts[0].phase = "review"; });
  assert.equal(progressed.verbs.length, 1);
  const stale = structuredClone(f.state); stale.activeVerification.token = "stolen";
  assert.throws(() => finishVerification(f.statePath, stale), /replaced or cleared/);
  finishVerification(f.statePath, f.state);
});

test("settled groups leave the live lease only after process absence is proved", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  beginVerification(f.statePath, f.state, attemptFixture());
  const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { detached: true, stdio: ["pipe", "ignore", "ignore"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  await once(child, "spawn");
  prepareVerificationExecution(f.statePath, f.state);
  recordVerificationExecution(f.statePath, f.state, child.pid);
  assert.throws(() => completeVerificationExecution(f.statePath, f.state, child.pid), /still active/);
  const exited = once(child, "exit"); child.stdin.end(); await exited;
  completeVerificationExecution(f.statePath, f.state, child.pid);
  assert.deepEqual(f.reload().activeVerification.executionPids, []);
  finishVerification(f.statePath, f.state);
});

test("interrupted review preserves settled findings for repair without applying a recorded round twice", async (t) => {
  for (const alreadyRecorded of [false, true]) {
    const f = fixture(t);
    const review = { invocationId: "J1", startedAt: AT, finishedAt: AT, durationMs: 0,
      verdict: "FAIL", result: { ...REVIEW_PASS, findings: [defect()] }, judge: null, error: null };
    const attempt = attemptFixture({ phase: "review", reviews: { fidelity: review, code: null }, verdict: alreadyRecorded ? "ERROR" : "NOT_RUN" });
    if (alreadyRecorded) f.state.findings = reconcileReviewFindings([], review.result, attempt.id, AT);
    beginVerification(f.statePath, f.state, attempt);
    const dead = spawnSync(process.execPath, ["-e", ""]);
    progressVerification(f.statePath, f.state, fresh => { fresh.activeVerification.pid = dead.pid; });
    const recovered = await recoverVerification(f.statePath, f.reload());
    assert.equal(recovered.verificationAttempts[0].error.code, "verification-interrupted");
    assert.equal(recovered.verificationAttempts[0].reviews.code, null);
    assert.equal(recovered.findings.length, 1);
    assert.equal(recovered.findings[0].id, "F1");
    assert.equal(recovered.findings[0].status, "open");
    assert.equal(recovered.findings[0].history.length, 1, "recovery cannot duplicate settled finding history");
    assert.deepEqual(recovered.verificationAttempts[0].reviews.fidelity, review);
  }
});
