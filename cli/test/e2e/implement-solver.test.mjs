import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { ESCALATE_LIMIT_PER_RUN } from "../../dist/implement/types.js";
import { readIndex } from "../../dist/supervisor/index.js";
import { makeProject as createProject, start, run as runCli, registerEvidence, CLI, isolatedEnv, PRD_PATH } from "../helpers/implement-fixture.mjs";
import { installFakeHerdr } from "../helpers/fake-herdr.mjs";
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

test("D-04: escalation persists replacement identity and enrollment before submitting the handoff", async () => {
  const root = fs.realpathSync(createProject({ count: 1 }));
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({ worktree: { enabled: false } }));
  const outside = fs.mkdtempSync(`${root}-herdr-`);
  const fake = installFakeHerdr(outside);
  const home = path.join(outside, "home");
  fs.mkdirSync(home, { recursive: true });
  const observerEnv = { ...fake.env, HOME: home, HERDR_ENV: "1", HERDR_PANE_ID: "w4G:p12", HERDR_WORKSPACE_ID: "w4G", CLAUDE_SESSION_ID: "observer-session" };
  assert.equal(runCli(root, ["implement", "start", "--prd", PRD_PATH, "--dirty-attribution", "run-owned"], { env: observerEnv }).status, 0);
  const dispatched = spawnSync(process.execPath, [CLI, "implement", "dispatch", "--name", "impl", "--prd", PRD_PATH, "--json"], {
    cwd: root, encoding: "utf8", env: isolatedEnv(observerEnv), input: "ROLE: Implementor\nSOURCE: fixture\nRETURN CONTRACT: status", timeout: 30_000,
  });
  assert.equal(dispatched.status, 0, dispatched.stderr + dispatched.stdout);

  const judge = stubEnv(root);
  const ready = path.join(outside, "prompt-ready");
  const release = path.join(outside, "prompt-release");
  const env = isolatedEnv({ ...observerEnv, ...judge, HERDR_FAKE_PROMPT_BARRIER_READY: ready, HERDR_FAKE_PROMPT_BARRIER_RELEASE: release });
  const child = spawn(process.execPath, [CLI, "implement", "escalate", "--issuer", "observer", "--reason", "stuck", "--agent", "impl", "--adopt", "user requested replacement", "--json"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const deadline = Date.now() + 15_000;
  while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fs.existsSync(ready), true, stderr || stdout);
  const during = state(root);
  assert.equal(during.pendingDispatch.phase, "started");
  assert.equal(during.pendingDispatch.implementor.sessionId, "impl-session");
  assert.equal(during.supervision.runInstanceId, during.pendingDispatch.runInstanceId);
  const indexed = readIndex(path.join(home, ".sasu", "supervisor", "index.json"));
  assert.equal(indexed.entries[0].runInstanceId, during.pendingDispatch.runInstanceId);
  fs.writeFileSync(release, "release\n");
  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(exitCode, 0, stderr + stdout);
  assert.equal(state(root).pendingDispatch, null);
});

test("D-04: escalation rechecks run authority after its final target lookup", async () => {
  const root = fs.realpathSync(createProject({ count: 1 }));
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({ worktree: { enabled: false } }));
  const outside = fs.mkdtempSync(`${root}-herdr-`);
  const fake = installFakeHerdr(outside);
  const home = path.join(outside, "home");
  fs.mkdirSync(home, { recursive: true });
  const observerEnv = { ...fake.env, HOME: home, HERDR_ENV: "1", HERDR_PANE_ID: "w4G:p12", HERDR_WORKSPACE_ID: "w4G", CLAUDE_SESSION_ID: "observer-session" };
  assert.equal(runCli(root, ["implement", "start", "--prd", PRD_PATH, "--dirty-attribution", "run-owned"], { env: observerEnv }).status, 0);
  const dispatched = spawnSync(process.execPath, [CLI, "implement", "dispatch", "--name", "impl", "--prd", PRD_PATH, "--json"], {
    cwd: root, encoding: "utf8", env: isolatedEnv(observerEnv), input: "ROLE: Implementor\nSOURCE: fixture\nRETURN CONTRACT: status", timeout: 30_000,
  });
  assert.equal(dispatched.status, 0, dispatched.stderr + dispatched.stdout);
  const promptsBefore = fake.prompts().length;

  const judge = stubEnv(root);
  const ready = path.join(outside, "replacement-get.ready");
  const release = path.join(outside, "replacement-get.release");
  const count = path.join(outside, "replacement-get.count");
  const env = isolatedEnv({
    ...observerEnv,
    ...judge,
    HERDR_FAKE_GET_BARRIER_TARGET: "w4G:p13",
    HERDR_FAKE_GET_BARRIER_OCCURRENCE: "2",
    HERDR_FAKE_GET_BARRIER_COUNT: count,
    HERDR_FAKE_GET_BARRIER_READY: ready,
    HERDR_FAKE_GET_BARRIER_RELEASE: release,
  });
  const child = spawn(process.execPath, [CLI, "implement", "escalate", "--issuer", "observer", "--reason", "stuck", "--agent", "impl", "--adopt", "user requested replacement", "--json"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const deadline = Date.now() + 15_000;
  while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fs.existsSync(ready), true, stderr || stdout);
  try {
    const retired = runCli(root, ["implement", "retire", "--issuer", "human", "--adopt", "user: retire during replacement"], { env: observerEnv });
    assert.equal(retired.status, 0, retired.stderr + retired.stdout);
  } finally {
    fs.writeFileSync(release, "release\n");
  }
  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(exitCode, 0, stderr + stdout);
  const outcome = JSON.parse(stdout);
  assert.equal(outcome.detail.contextReset, false);
  assert.match(outcome.detail.contextResetProblem, /final handoff authority validation failed.*retired/);
  assert.equal(fake.prompts().length, promptsBefore, "retirement at the replacement's final lookup prevents new handoff input");
  assert.equal(state(root).pendingDispatch.phase, "started");
});

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
  for (const key of ["requirements", "suite", "artifacts", "verificationAttempts", "verificationReport"]) assert.deepEqual(after[key], before[key], `${key} must remain unchanged by diagnosis`);
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

  // The ledger handed over is current deterministic verification, not a transcript.
  const ledger = JSON.parse(fs.readFileSync(path.join(root, handoff.verificationPath), "utf8"));
  assert.ok(Array.isArray(ledger.attempts));
  assert.ok(Object.hasOwn(ledger, "currentReport"));
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
  assert.match(refused.json.message, /amend the PRD or record the unresolved limitation/);
  assert.equal(state(root).escalations.length, ESCALATE_LIMIT_PER_RUN, "a refused escalation is not charged");
});

test("AC35: escalate needs a reason and accepts a freeform diagnostic target", () => {
  const root = makeProject();
  const env = stubEnv(root);
  const noReason = run(root, ["implement", "escalate", "--issuer", "observer"], env);
  assert.notEqual(noReason.status, 0);
  assert.match(noReason.json.message, /requires --reason/);

  const labeled = escalate(root, env, ["--target", "B9"]);
  assert.equal(labeled.status, 0, labeled.stderr + labeled.stdout);
  assert.equal(state(root).escalations.at(-1).target, "B9");
  assert.equal(state(root).escalations.length, 1, "only the actual diagnosis spends an escalation");
});

test("AC35: the implementor may not summon its own replacement", () => {
  const root = makeProject();
  const env = stubEnv(root);
  const refused = run(root, ["implement", "escalate", "--reason", "stuck"], env);
  assert.notEqual(refused.status, 0);
  assert.match(refused.json.message, /implementor may not issue .*escalate/);
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
  assert.match(summary, /Next: commit coherent work and request native review on the committed head with this verdict disclosed; run the full verify on the final committed candidate; delivery needs a current PASS/);
  assert.doesNotMatch(summary, /continue to ship/);
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
  assert.match(prompt, /## Deterministic verification history/);

  // The output shape, recorded on success.
  const record = state(root).escalations.at(-1);
  assert.equal(record.outcome, "diagnosed");
  assert.equal(record.profile, "high-risk", "the solver reuses the routing table; it has no knob of its own");
  assert.equal(record.error, null);
  // The ledger row carries the headline; the three fields live in full in the
  // diagnosis the replacement is handed.
  assert.equal(record.diagnosis, DIAGNOSIS.summary);

  // The three handoff artifacts, in the shape a replacement is briefed with.
  assert.deepEqual(Object.keys(record.handoff).sort(), ["diagnosisPath", "prdSnapshotPath", "verificationPath"]);
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
  assert.match(briefing, /3\. The deterministic verification history/);

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
