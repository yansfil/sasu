import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ESCALATE_LIMIT_PER_RUN } from "../../dist/implement/types.js";
import { makeProject as createProject, start, run as runCli, registerEvidence, CLI, isolatedEnv } from "../helpers/implement-fixture.mjs";
function makeProject() { const root = createProject({ count: 1 }); start(root); return root; }
const run = (root, args, env = {}) => runCli(root, args, { env });
const DIAGNOSIS = {
  summary: "the implementor keeps re-running the same failing command",
  likelyCause: "the check reads a fixture the run never wrote, so it never sees the built output",
  suggestedNextStep: "write the fixture, then run the check once from the repository root",
};

const STATE_REL = path.join("agents", "runs", "fixture", "state.json");
const state = (root) => JSON.parse(fs.readFileSync(path.join(root, STATE_REL), "utf8"));

function stubEnv(root, diagnosis = DIAGNOSIS) {
  const file = path.join(root, "agents", "judge.json");
  const capture = path.join(root, "agents", "captures");
  fs.writeFileSync(file, JSON.stringify({ byPurpose: { "implement:solver": diagnosis } }));
  return { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture, capture };
}

const escalate = (root, env, extra = []) => run(root, [
  "implement", "escalate", "--issuer", "observer", "--reason", "repeated incomplete verification", ...extra,
], env);

// --- AC33: no state write during the solver's execution ---------------------

test("AC33: the solver runs read-only and the run's only write happens after it returns", () => {
  const root = makeProject();
  const env = stubEnv(root);
  const before = state(root);

  const escalated = escalate(root, env);
  assert.equal(escalated.status, 0, escalated.stderr + escalated.stdout);

  // The stub writes its capture at the moment the solver is called. The state
  // file is younger than that capture, so nothing wrote state while the solver
  // was running.
  const capturedAt = fs.statSync(path.join(env.capture, "implement_solver.prompt.txt")).mtimeMs;
  assert.ok(fs.statSync(path.join(root, STATE_REL)).mtimeMs >= capturedAt);

  // And the write that did happen changed only the escalation ledger and the
  // event log - no row or verification moved under the solver.
  const after = state(root);
  for (const key of ["requirements", "suite", "artifacts", "verificationAttempts", "findings"]) assert.deepEqual(after[key], before[key], `${key} must remain unchanged by diagnosis`);
  assert.equal(after.escalations.length, before.escalations.length + 1);
});

test("AC33: what comes back is a diagnosis, and it is recorded as text", () => {
  const root = makeProject();
  const env = stubEnv(root);
  const escalated = escalate(root, env);
  assert.equal(escalated.status, 0, escalated.stderr + escalated.stdout);

  const record = escalated.json.detail.escalation;
  assert.equal(record.outcome, "diagnosed");
  assert.equal(record.profile, "high-risk", "the solver reuses the high-risk judge routing rather than a knob of its own");
  assert.equal(record.diagnosis, DIAGNOSIS.summary);
  assert.equal(record.error, null);

  const written = fs.readFileSync(path.join(root, record.handoff.diagnosisPath), "utf8");
  assert.match(written, /re-running the same failing command/);
  assert.match(written, /never wrote/);
  assert.match(written, /run the check once from the repository root/);
});

test("AC33: a solver that returns anything but the three fields is not accepted", () => {
  const root = makeProject();
  const env = stubEnv(root, { ...DIAGNOSIS, patch: "diff --git a b" });
  const escalated = escalate(root, env);
  assert.notEqual(escalated.status, 0);
  assert.equal(escalated.json.detail.escalation.outcome, "summon-failed");
  assert.match(escalated.json.message, /remove patch/);
});

// --- AC34: the handoff ------------------------------------------------------

test("AC34: the replacement briefing carries the three artifacts and no conversation", () => {
  const root = makeProject();
  const env = stubEnv(root);
  const escalated = escalate(root, env);
  assert.equal(escalated.status, 0, escalated.stderr + escalated.stdout);

  const { handoff, briefing } = escalated.json.detail;
  assert.equal(handoff.prdSnapshotPath, "agents/runs/fixture/prd.md");
  for (const rel of Object.values(handoff)) {
    assert.ok(fs.existsSync(path.join(root, rel)), `${rel} exists for the replacement to read`);
    assert.ok(briefing.includes(rel), `${rel} is named in the briefing`);
  }
  assert.match(briefing, /clean context/);
  assert.match(briefing, /previous implementor's conversation is not available/);

  // The ledger handed over is the row ledger, not a transcript.
  const ledger = JSON.parse(fs.readFileSync(path.join(root, handoff.findingsPath), "utf8"));
  assert.ok(Array.isArray(ledger.findings));
  assert.ok(Array.isArray(ledger.attempts));
});

test("AC34: with no herdr the reset is reported as the supervisor's to perform, not silently skipped", () => {
  const root = makeProject();
  const env = stubEnv(root);
  const escalated = escalate(root, env);
  assert.equal(escalated.status, 0);
  assert.equal(escalated.json.detail.contextReset, false);
  assert.match(escalated.json.detail.contextResetProblem, /reset the implementor's context yourself/);
  assert.match(escalated.json.message, /Context reset not performed automatically/);
  assert.match(state(root).events.at(-1).summary, /the context reset is the supervisor's to perform/);
});

// --- AC35: the bound and the failed summon ----------------------------------

test("AC35: a summon failure is recorded as a failed escalation and the implementor is not reset", () => {
  const root = makeProject();
  const file = path.join(root, "agents", "judge.json");
  fs.writeFileSync(file, JSON.stringify({ byPurpose: { "not-the-solver": { verdict: "PASS" } } }));
  const escalated = escalate(root, { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file });

  assert.notEqual(escalated.status, 0);
  const record = escalated.json.detail.escalation;
  assert.equal(record.outcome, "summon-failed");
  assert.equal(record.handoff, null);
  assert.ok(record.error !== null && record.error !== "");
  assert.match(escalated.json.message, /The implementor was NOT reset/);
  assert.equal(state(root).escalations.length, 1, "a failed summon is still a spent escalation and is on the record");
  assert.equal(state(root).events.at(-1).kind, "escalate");
});

test("AC35: the run-wide bound refuses the escalation past the constant", () => {
  const root = makeProject();
  const env = stubEnv(root);
  for (let spent = 0; spent < ESCALATE_LIMIT_PER_RUN; spent += 1) {
    const accepted = escalate(root, env);
    assert.equal(accepted.status, 0, accepted.stderr + accepted.stdout);
    assert.equal(accepted.json.detail.escalationsRemaining, ESCALATE_LIMIT_PER_RUN - spent - 1);
  }
  const refused = escalate(root, env);
  assert.notEqual(refused.status, 0);
  assert.equal(refused.json.detail.rejectedCheck, "transition");
  assert.match(refused.json.message, new RegExp(`used all ${ESCALATE_LIMIT_PER_RUN} escalations`));
  assert.match(refused.json.message, /amend the PRD or finalize blocked/);
  assert.equal(state(root).escalations.length, ESCALATE_LIMIT_PER_RUN, "a refused escalation is not charged");
});

test("AC35: escalate needs a reason and a target that exists", () => {
  const root = makeProject();
  const env = stubEnv(root);
  const noReason = run(root, ["implement", "escalate", "--issuer", "observer"], env);
  assert.notEqual(noReason.status, 0);
  assert.match(noReason.json.message, /requires --reason/);

  const badTarget = escalate(root, env, ["--target", "B9"]);
  assert.notEqual(badTarget.status, 0);
  assert.match(badTarget.json.message, /unknown --target B9; name an open finding/);
  assert.equal(state(root).escalations.length, 0, "neither refusal spent an escalation");
});

test("AC35: the implementor may not summon its own replacement", () => {
  const root = makeProject();
  const env = stubEnv(root);
  const refused = run(root, ["implement", "escalate", "--reason", "stuck"], env);
  assert.notEqual(refused.status, 0);
  assert.match(refused.json.message, /implementor may not issue .*escalate/);
});

// --- the liveness probe reaches the adapter ---------------------------------

test("await names which liveness probe it used, and refuses two answers to one question", () => {
  const root = makeProject();
  const both = run(root, ["implement", "await", "--pid", String(process.pid), "--agent", "impl-1"]);
  assert.notEqual(both.status, 0);
  assert.match(both.json.message, /two answers to the same question/);

  // Give the waiter an event to return on, or it would sit until the stall
  // bound - correct behaviour, but not what this test is about.
  registerEvidence(root);

  // Without herdr the adapter's alive hole is shut, so the waiter says the
  // probe was unavailable rather than assuming a live implementor.
  const woke = run(root, ["implement", "await", "--agent", "impl-1", "--since", "0"]);
  assert.equal(woke.status, 0, woke.stderr + woke.stdout);
  assert.match(woke.json.detail.livenessProbe, /^unavailable: /);
  assert.match(woke.json.detail.livenessProbe, /not running under herdr/);
});

// --- AC41/AC43: what the record says after the solver path is spent ---------

test("AC41: once the bound is spent, status names the run's state and the move that is left", () => {
  const root = makeProject();
  const env = stubEnv(root);
  for (let i = 0; i < ESCALATE_LIMIT_PER_RUN; i += 1) {
    const each = escalate(root, env);
    assert.equal(each.status, 0, each.stderr + each.stdout);
  }
  const refused = escalate(root, env);
  assert.notEqual(refused.status, 0, refused.stdout);
  assert.match(refused.json.message, /used all 3 escalations/);
  // The refusal is history too, and the roster survives it.
  assert.equal(state(root).escalations.length, ESCALATE_LIMIT_PER_RUN, "a refused escalation summons nobody");

  // AC41: the supervisor deciding what to do next reads status, not the
  // message of a command it has not run yet.
  const merged = isolatedEnv();
  const summary = spawnSync(process.execPath, [CLI, "implement", "status"], { cwd: root, encoding: "utf8", env: merged }).stdout;
  assert.match(summary, /escalations: 3 of 3 used/);
  assert.match(summary, /bound (?:is )?spent/);
  assert.match(summary, /amend.*human approval/);
  assert.match(summary, /finalize.*blocked/);
  // ...and the verb it can no longer issue is not offered.
  assert.doesNotMatch(summary, /escalate \(\d+ of 3 left\)/);
});

test("AC43: the solver's input envelope and its output both hold their declared shape", () => {
  const root = makeProject();
  const env = stubEnv(root);
  const summoned = escalate(root, env);
  assert.equal(summoned.status, 0, summoned.stderr + summoned.stdout);

  // The envelope that actually reached the solver: diagnosis-only framing,
  // plus the three things it is allowed to read.
  const prompt = fs.readFileSync(path.join(env.capture, "implement_solver.prompt.txt"), "utf8");
  assert.match(prompt, /Your entire job is to diagnose/);
  assert.match(prompt, /you do not change state/);
  assert.match(prompt, /## What the implementor is stuck on/);
  assert.match(prompt, /## Why the supervisor escalated/);
  assert.match(prompt, /## Sealed PRD/);
  assert.match(prompt, /## Run findings and actual attempts/);

  // The output shape, recorded on success.
  const record = state(root).escalations.at(-1);
  assert.equal(record.outcome, "diagnosed");
  assert.equal(record.profile, "high-risk", "the solver reuses the routing table; it has no knob of its own");
  assert.equal(record.error, null);
  // The ledger row carries the headline; the three fields live in full in the
  // diagnosis the replacement is handed.
  assert.equal(record.diagnosis, DIAGNOSIS.summary);

  // The three handoff artifacts, in the shape a replacement is briefed with.
  assert.deepEqual(Object.keys(record.handoff).sort(), ["diagnosisPath", "findingsPath", "prdSnapshotPath"]);
  for (const rel of Object.values(record.handoff)) {
    assert.ok(fs.existsSync(path.join(root, rel)), `${rel} must exist for the replacement to read`);
  }
  const written = fs.readFileSync(path.join(root, record.handoff.diagnosisPath), "utf8");
  for (const field of Object.values(DIAGNOSIS)) {
    assert.ok(written.includes(field), `the diagnosis file must carry "${field}"`);
  }
  const briefing = summoned.json.detail.briefing;
  assert.match(briefing, /1\. The sealed PRD/);
  assert.match(briefing, /2\. The solver's diagnosis/);
  assert.match(briefing, /3\. The findings and actual attempts/);

  // ...and a failed summon records the other half of the shape.
  const failing = makeProject();
  const failEnv = stubEnv(failing, { summary: "", likelyCause: "x", suggestedNextStep: "y" });
  const failed = escalate(failing, failEnv);
  assert.notEqual(failed.status, 0, failed.stdout);
  const failure = state(failing).escalations.at(-1);
  assert.equal(failure.outcome, "summon-failed");
  assert.equal(failure.diagnosis, null);
  assert.equal(failure.handoff, null);
  assert.ok(failure.error.length > 0, "a failed summon says why");
});
