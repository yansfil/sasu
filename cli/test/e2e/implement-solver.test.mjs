import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { ESCALATE_LIMIT_PER_RUN } from "../../dist/implement/types.js";

const CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "dist", "cli.js");
const SESSION_KEYS = ["CODEX_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID"];

const DIAGNOSIS = {
  summary: "the implementor keeps rebinding the same failing command",
  likelyCause: "the check runs in the wrong cwd and never sees the built output",
  suggestedNextStep: "rebind with --cwd cli and run the check once",
};

function prd() {
  return `---
topic: "implement solver fixture"
status: "ready"
human_approval: "approved"
review_profile: "standard"
review_rationale: "solver protocol fixture"
source_intake: "current conversation"
---

# PRD: implement solver fixture

## 1. Summary

Exercise escalation, diagnosis, and the context reset.

## 2. Problem, Goal, And Users

A stuck implementor has to be recovered by an event, not by waiting.

## 3. Scope And Non-Goals

Only the escalate lifecycle is in scope.

## 4. Pre-Work And Required Decisions

None required.

## 5. Major Technical Structure Changes

No fixture structure change.

## 6. Requirements

- R1. The machine criterion works. Covers AC1.

## 7. Acceptance Criteria

| ID | Criterion | Judgment | Evidence Declaration |
| --- | --- | --- | --- |
| AC1 | The runner executes each command once. Covers R1. | machine | - |

## 8. PRD-Level Tasks

- T1. Implement AC1. Covers R1, AC1. Depends on: none.

## 9. Verification Contract

### 9.1 Test Mode Contract

| Mode | Required For Done | Covers | Human Decision |
| --- | --- | --- | --- |
| automated behavior | yes | fixture lifecycle | none |

### 9.2 Required Agent Verification

| ID | Mode | Covers | Pass Intent | Required For Done | Can Be Blocked |
| --- | --- | --- | --- | --- | --- |
| V1 | automated behavior | R1, AC1 | fixture lifecycle passes | yes | no |

## 10. Risks And Open Decisions

None.

## 11. Implementation Guardrails

Do not expand the fixture.

## 12. Implementation Result Report Contract

Report the escalation ledger.
`;
}

function run(root, args, env = {}) {
  const merged = { ...process.env, ...env };
  for (const key of SESSION_KEYS) delete merged[key];
  delete merged.SASU_HERDR_ROLE;
  // herdr must look absent unless a test says otherwise, so the fixture never
  // reaches for a real pane on the machine running the suite.
  delete merged.HERDR_ENV;
  const executed = spawnSync(process.execPath, [CLI, ...args, "--json"], { cwd: root, encoding: "utf8", env: merged });
  let json;
  try {
    json = JSON.parse(executed.stdout);
  } catch {
    json = { stdout: executed.stdout, stderr: executed.stderr };
  }
  return { ...executed, json };
}

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-implement-solver-e2e-"));
  fs.mkdirSync(path.join(root, "agents", "prd", "fixture"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", "prd", "fixture", "prd.md"), prd());
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e \"console.log('fixture suite green')\"" } }));
  for (const args of [
    ["init", "-q"],
    ["add", "package.json"],
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "base"],
  ]) {
    const executed = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(executed.status, 0, executed.stderr);
  }
  const started = run(root, ["implement", "start", "--prd", "agents/prd/fixture/prd.md"]);
  assert.equal(started.status, 0, started.stderr + started.stdout);
  fs.writeFileSync(path.join(root, "implementation.txt"), "run-owned fixture implementation\n");
  return root;
}

const STATE_REL = path.join("agents", "runs", "fixture", "state.json");
const state = (root) => JSON.parse(fs.readFileSync(path.join(root, STATE_REL), "utf8"));

function stubEnv(root, diagnosis = DIAGNOSIS) {
  const file = path.join(root, "agents", "judge.json");
  const capture = path.join(root, "agents", "captures");
  fs.writeFileSync(file, JSON.stringify({ byPurpose: { "implement:solver": diagnosis } }));
  return { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture, capture };
}

const escalate = (root, env, extra = []) => run(root, [
  "implement", "escalate", "--issuer", "observer", "--reason", "eight rounds on one binding", ...extra,
], env);

// --- AC33: no state write during the solver's execution ---------------------

test("AC33: the solver runs read-only and the run's only write happens after it returns", () => {
  const root = makeProject();
  const env = stubEnv(root);
  const before = state(root);

  const escalated = escalate(root, env, ["--target", "T1"]);
  assert.equal(escalated.status, 0, escalated.stderr + escalated.stdout);

  // The stub writes its capture at the moment the solver is called. The state
  // file is younger than that capture, so nothing wrote state while the solver
  // was running.
  const capturedAt = fs.statSync(path.join(env.capture, "implement_solver.prompt.txt")).mtimeMs;
  assert.ok(fs.statSync(path.join(root, STATE_REL)).mtimeMs >= capturedAt);

  // And the write that did happen changed only the escalation ledger and the
  // event log - no task, criterion, or verification moved under the solver.
  const after = state(root);
  const changed = Object.keys(after).filter((key) => JSON.stringify(after[key]) !== JSON.stringify(before[key]));
  assert.deepEqual(changed.sort(), ["escalations", "events", "updatedAt"]);
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
  assert.match(written, /rebinding the same failing command|rebinding the same failing/);
  assert.match(written, /wrong cwd/);
  assert.match(written, /rebind with --cwd cli/);
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
  const escalated = escalate(root, env, ["--target", "AC1"]);
  assert.equal(escalated.status, 0, escalated.stderr + escalated.stdout);

  const { handoff, briefing } = escalated.json.detail;
  assert.equal(handoff.prdSnapshotPath, "agents/runs/fixture/prd.md");
  for (const rel of Object.values(handoff)) {
    assert.ok(fs.existsSync(path.join(root, rel)), `${rel} exists for the replacement to read`);
    assert.ok(briefing.includes(rel), `${rel} is named in the briefing`);
  }
  assert.match(briefing, /clean context/);
  assert.match(briefing, /previous implementor's conversation is not available/);

  // The ledger handed over is the criterion ledger, not a transcript.
  const ledger = JSON.parse(fs.readFileSync(path.join(root, handoff.checkLedgerPath), "utf8"));
  assert.ok(Array.isArray(ledger.bindings));
  assert.equal(typeof ledger.sha256, "string");
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
  fs.writeFileSync(file, JSON.stringify({ byPurpose: { "implement:acceptance": { verdict: "PASS" } } }));
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
  assert.match(refused.json.message, /park the criterion, amend the PRD, or finalize blocked/);
  assert.equal(state(root).escalations.length, ESCALATE_LIMIT_PER_RUN, "a refused escalation is not charged");
});

test("AC35: escalate needs a reason and a target that exists", () => {
  const root = makeProject();
  const env = stubEnv(root);
  const noReason = run(root, ["implement", "escalate", "--issuer", "observer"], env);
  assert.notEqual(noReason.status, 0);
  assert.match(noReason.json.message, /requires --reason/);

  const badTarget = escalate(root, env, ["--target", "T9"]);
  assert.notEqual(badTarget.status, 0);
  assert.match(badTarget.json.message, /unknown --target T9/);
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
  assert.equal(run(root, ["implement", "task", "--id", "T1", "--status", "blocked"]).status, 0);

  // Without herdr the adapter's alive hole is shut, so the waiter says the
  // probe was unavailable rather than assuming a live implementor.
  const woke = run(root, ["implement", "await", "--agent", "impl-1", "--since", "0"]);
  assert.equal(woke.status, 0, woke.stderr + woke.stdout);
  assert.match(woke.json.detail.livenessProbe, /^unavailable: /);
  assert.match(woke.json.detail.livenessProbe, /not running under herdr/);
});
