import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { scratchDir } from "../scratch.mjs";
import { stateFixture, attemptFixture, AT } from "../helpers/implement-state.mjs";
import { assertNoActiveVerification, beginVerification, finishVerification, completeVerificationExecution, prepareVerificationExecution, recordVerificationExecution, recoverVerification, progressVerification } from "../../dist/implement/verification-activity.js";
import { loadState, persistState } from "../../dist/implement/store.js";
import { reconcileReviewFindings } from "../../dist/implement/convergence.js";
import { defect } from "../helpers/implement-fixture.mjs";

// A pid above the platform's allocatable range: `kill(pid, 0)` answers ESRCH,
// which is what `processPresent` reads as "demonstrably dead". The earlier
// shape spawned a node process and reused its pid once it exited, and that is
// a pid the OS is free to hand to the next process - under the suite's own
// process churn it did, and the owner then read as alive (2026-09-11 flake,
// three sites, one concept). Same constant and same reason as
// gate-concurrency.test.mjs's dead-owner lock.
const UNALLOCATABLE_PID = 99_999_999;

const REVIEW_CONTEXT = {
  requirementRefs: ["B1"], requiredRequirementRefs: ["B1"],
  evidenceRefs: ["B1", "implementation.txt"], actualEvidenceRefs: ["implementation.txt"], priorFindingIds: [], humanSources: {},
};
const REVIEW_FAIL = { summary: "The implementation omits the approved value.", findings: [defect()], priorDispositions: [],
  assessments: [{ requirementRefs: ["B1"], conclusion: "unresolved", rationale: "The implementation contains no return of the approved value.", evidenceRefs: ["implementation.txt"] }] };

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
  progressVerification(f.statePath, f.state, fresh => { fresh.activeVerification.pid = UNALLOCATABLE_PID; });
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
  progressVerification(f.statePath, f.state, fresh => { fresh.activeVerification.pid = UNALLOCATABLE_PID; });
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

test("partial review results and pinned inputs survive progress, refusal merging and correction", (t) => {
  const f = fixture(t);
  assert.throws(() => beginVerification(f.statePath, f.state, attemptFixture({ prdSha256: "b".repeat(64) })), /PRD identity/);
  beginVerification(f.statePath, f.state, attemptFixture());
  progressVerification(f.statePath, f.state, fresh => {
    fresh.verificationAttempts[0].reviewContext = structuredClone(REVIEW_CONTEXT);
    fresh.verificationAttempts[0].phase = "review";
  });
  const lane = { invocationId: "J1", startedAt: AT, finishedAt: AT, durationMs: 0, verdict: "FAIL", result: REVIEW_FAIL, judge: null, error: null };
  progressVerification(f.statePath, f.state, fresh => { fresh.verificationAttempts[0].reviews.fidelity = structuredClone(lane); });
  const before = fs.readFileSync(f.statePath, "utf8");
  for (const mutate of [
    s => s.verificationAttempts[0].reviews.fidelity = null,
    s => s.verificationAttempts[0].reviews.fidelity.result = null,
    s => s.verificationAttempts[0].reviews.fidelity.verdict = "PASS",
    s => s.verificationAttempts[0].reviews.fidelity.error = { code: "replacement", message: "rewritten" },
    s => s.verificationAttempts[0].reviews.fidelity.judge = { backend: "rewritten" },
    s => s.verificationAttempts[0].reviewContext = null,
    s => s.verificationAttempts[0].inputFingerprint = "b".repeat(64),
    s => s.verificationAttempts.push(attemptFixture({ id: "V2" })),
  ]) {
    assert.throws(() => progressVerification(f.statePath, f.state, mutate), /immutable|cannot append/);
    assert.equal(fs.readFileSync(f.statePath, "utf8"), before);
  }
  const refused = f.reload(); refused.verbs.push(refusal());
  persistState(f.statePath, refused, { refusalOnly: true });
  const finished = finishVerification(f.statePath, f.state, fresh => {
    const attempt = fresh.verificationAttempts[0];
    attempt.phase = "complete"; attempt.verdict = "ERROR";
    attempt.error = { stage: "review", code: "interrupted", message: "The sibling review did not settle." };
  });
  const historical = structuredClone(finished.verificationAttempts[0]);
  assert.deepEqual(historical.reviews.fidelity, lane);
  assert.equal(finished.verbs.length, 1);
  beginVerification(f.statePath, finished, attemptFixture({ id: "V2" }));
  finishVerification(f.statePath, finished, fresh => { fresh.verificationAttempts[1].verdict = "ERROR"; });
  assert.deepEqual(f.reload().verificationAttempts[0], historical);
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
      verdict: "FAIL", result: structuredClone(REVIEW_FAIL), judge: null, error: null };
    const attempt = attemptFixture({ phase: "review", reviewContext: REVIEW_CONTEXT, reviews: { fidelity: review, code: null }, verdict: alreadyRecorded ? "ERROR" : "NOT_RUN" });
    if (alreadyRecorded) f.state.findings = reconcileReviewFindings([], review.result, attempt.id, AT);
    beginVerification(f.statePath, f.state, attempt);
    progressVerification(f.statePath, f.state, fresh => { fresh.activeVerification.pid = UNALLOCATABLE_PID; });
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
