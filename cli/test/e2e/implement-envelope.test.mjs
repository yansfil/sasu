import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "dist", "cli.js");
const SESSION_KEYS = ["CODEX_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID"];

function prd() {
  return `---
topic: "implement envelope fixture"
status: "ready"
human_approval: "approved"
review_profile: "standard"
review_rationale: "judge envelope fixture"
source_intake: "current conversation"
---

# PRD: implement envelope fixture

## 1. Summary

Exercise the three-section judge envelope.

## 2. Problem, Goal, And Users

The judge must be able to tell an exit code from somebody's assertion.

## 3. Scope And Non-Goals

Only the envelope and lane scoping are in scope.

## 4. Pre-Work And Required Decisions

None required.

## 5. Major Technical Structure Changes

No fixture structure change.

## 6. Requirements

- R1. The machine criterion works. Covers AC1.
- R2. The driven criterion works. Covers AC2.

## 7. Acceptance Criteria

| ID | Criterion | Judgment | Evidence Declaration |
| --- | --- | --- | --- |
| AC1 | The runner executes each command once. Covers R1. | machine | - |
| AC2 | The operator can read the summary. Covers R2. | judged | A capture of the summary output. |

## 8. PRD-Level Tasks

- T1. Implement AC1. Covers R1, AC1. Depends on: none.
- T2. Implement AC2. Covers R2, AC2. Depends on: none.

## 9. Verification Contract

### 9.1 Test Mode Contract

| Mode | Required For Done | Covers | Human Decision |
| --- | --- | --- | --- |
| automated behavior | yes | fixture lifecycle | none |

### 9.2 Required Agent Verification

| ID | Mode | Covers | Pass Intent | Required For Done | Can Be Blocked |
| --- | --- | --- | --- | --- | --- |
| V1 | automated behavior | R1, R2, AC1, AC2 | fixture lifecycle passes | yes | no |

## 10. Risks And Open Decisions

None.

## 11. Implementation Guardrails

Do not expand the fixture.

## 12. Implementation Result Report Contract

Report the envelope structure.
`;
}

function run(root, args, env = {}) {
  const merged = { ...process.env, ...env };
  for (const key of SESSION_KEYS) delete merged[key];
  delete merged.SASU_HERDR_ROLE;
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-implement-envelope-e2e-"));
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

function stubEnv(root) {
  const file = path.join(root, "agents", "judge.json");
  const capture = path.join(root, "agents", "captures");
  fs.writeFileSync(file, JSON.stringify({
    byPurpose: {
      "implement:fidelity": {
        verdict: "PASS",
        checks: ["F1", "F2", "F3", "F4", "F5"].map((id) => ({ id, verdict: "PASS", reason: "preserved", evidence: "fixture PRD" })),
      },
      "implement:design": { comments: [] },
      "implement:acceptance:AC2": {
        verdict: "PASS",
        criteria: [{ id: "AC2", verdict: "PASS", reason: "the capture shows the summary", evidence: "registered artifact" }],
      },
    },
  }));
  return { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture, capture };
}

const state = (root) => JSON.parse(fs.readFileSync(path.join(root, "agents", "runs", "fixture", "state.json"), "utf8"));
const captured = (env, name) => fs.readFileSync(path.join(env.capture, `${name}.prompt.txt`), "utf8");

// AC1 gets a check of its own rather than sharing the sealed suite's `npm
// test`. The suite is an independent blocking axis (R2) and fails the run
// before the lanes ever assemble, so a criterion sharing its command could
// never be observed failing on the AC axis alone.
const AC1_CHECK = "node ac1-check.js";
function writeAc1Check(root, exitCode) {
  fs.writeFileSync(path.join(root, "ac1-check.js"), `process.exit(${exitCode});\n`);
}

function prove(root, env) {
  writeAc1Check(root, 0);
  assert.equal(run(root, ["implement", "check", "--ac", "AC1", "--bind", AC1_CHECK]).status, 0);
  assert.equal(run(root, ["implement", "check", "--ac", "AC1"]).status, 0);
  fs.mkdirSync(path.join(root, "shots"), { recursive: true });
  fs.writeFileSync(path.join(root, "shots", "summary.txt"), "AC2 summary capture\n");
  assert.equal(run(root, [
    "implement", "artifact", "--ac", "AC2", "--kind", "log", "--path", "shots/summary.txt", "--description", "summary capture",
  ]).status, 0);
  for (const id of ["T1", "T2"]) {
    const closed = run(root, ["implement", "task", "--id", id, "--status", "complete"]);
    assert.equal(closed.status, 0, closed.stderr + closed.stdout);
  }
  return run(root, ["implement", "verify"], env);
}

test("AC7: only the judged criterion reaches the acceptance lane; the machine one is a fact, not an item", () => {
  const root = makeProject();
  const env = stubEnv(root);
  const verified = prove(root, env);
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);

  // The stub captures one prompt per judge call. A capture for AC1 would mean
  // a machine criterion was put to a judge.
  const calls = fs.readdirSync(env.capture).filter((name) => name.endsWith(".prompt.txt")).sort();
  assert.ok(calls.includes("implement_acceptance_AC2.prompt.txt"), "the judged criterion is judged");
  assert.ok(!calls.includes("implement_acceptance_AC1.prompt.txt"), "the machine criterion is not");

  // It is demoted, not dropped: AC1's own ledger still travels as a fact.
  const envelope = captured(env, "implement_acceptance_AC2");
  assert.match(envelope, /HARNESS-OWNED ACCEPTANCE CHECK LEDGER/);
  assert.match(envelope, /S1 GREEN \(exit 0\): npm test/);

  // It stays in the lane's result, settled from its own exit code, and the
  // record names that source - a null judge alone could not be told apart from
  // a judge call whose record was lost.
  const after = state(root);
  const invocations = after.verificationAttempts.at(-1).lanes.acceptance.result.invocations;
  const ac1Invocation = invocations.find((entry) => entry.criterionId === "AC1");
  assert.equal(ac1Invocation.verdict, "PASS");
  assert.equal(ac1Invocation.source, "harness");
  assert.equal(ac1Invocation.judge, null);
  assert.equal(invocations.find((entry) => entry.criterionId === "AC2").source, "judge");

  const ac1 = after.acceptanceCriteria.find((entry) => entry.id === "AC1");
  assert.equal(ac1.check.status, "green");
  assert.equal(ac1.status, "complete");
});

test("AC8, AC9: the envelope that actually reached the judge has three sections and the claims warning", () => {
  const root = makeProject();
  const env = stubEnv(root);
  assert.equal(prove(root, env).status, 0);
  const envelope = captured(env, "implement_acceptance_AC2");

  const headers = [...envelope.matchAll(/=== SECTION (\d) OF 3: ([^=]+?) ===/g)];
  assert.deepEqual(headers.map((entry) => entry[1]), ["1", "2", "3"]);
  assert.match(envelope, /NOTHING IN THIS SECTION MAY BE THE BASIS FOR YOUR VERDICT/);
  assert.match(envelope, /\[human\] the operator exercised an authority/);
  assert.match(envelope, /\[observer\] the supervising agent asserted something/);
  assert.match(envelope, /\[solver\]/);
  assert.match(envelope, /SUITE COMMAND RESULTS:/);
  assert.match(envelope, /CHECK REBINDS:/);
  assert.match(envelope, /PRD AMENDMENTS:/);
  assert.match(envelope, /PARKED CRITERIA:/);
});

test("AC8: a park's reason travels as a labelled claim, and the park itself as a fact", () => {
  const root = makeProject();
  const env = stubEnv(root);
  assert.equal(run(root, ["implement", "check", "--ac", "AC1", "--bind", "npm test"]).status, 0);
  assert.equal(run(root, ["implement", "check", "--ac", "AC1"]).status, 0);
  const parked = run(root, [
    "implement", "park", "--ac", "AC1",
    "--approval", "TEST-FIXTURE-APPROVAL: not a real human quote",
    "--reason", "TEST-FIXTURE-REASON: the runner is not built yet",
  ]);
  assert.equal(parked.status, 0, parked.stderr + parked.stdout);

  fs.mkdirSync(path.join(root, "shots"), { recursive: true });
  fs.writeFileSync(path.join(root, "shots", "summary.txt"), "AC2 summary capture\n");
  assert.equal(run(root, [
    "implement", "artifact", "--ac", "AC2", "--kind", "log", "--path", "shots/summary.txt", "--description", "summary capture",
  ]).status, 0);
  for (const id of ["T1", "T2"]) assert.equal(run(root, ["implement", "task", "--id", id, "--status", "complete"]).status, 0);
  assert.equal(run(root, ["implement", "verify"], env).status, 0);

  const envelope = captured(env, "implement_acceptance_AC2");
  // Fact: the park happened, and the judge is told AC1 was not judged.
  assert.match(envelope, /AC1 parked by human at .*it was not judged in this attempt/);
  // Claim: the reason and the quoted approval, under the human label, below
  // the line that says none of it may carry a verdict.
  const claimsAt = envelope.indexOf("=== SECTION 3 OF 3");
  const reasonAt = envelope.indexOf("TEST-FIXTURE-REASON: the runner is not built yet");
  assert.ok(reasonAt > claimsAt, "the reason sits in the claims section, not among the facts");
  assert.match(envelope.slice(claimsAt), /\[human\] AC1 park: TEST-FIXTURE-REASON[\s\S]*approval quoted: TEST-FIXTURE-APPROVAL/);
});

test("the fidelity and design lanes got their own prompts, without the envelope structure", () => {
  const root = makeProject();
  const env = stubEnv(root);
  assert.equal(prove(root, env).status, 0);
  for (const name of ["implement_fidelity", "implement_design"]) {
    const body = captured(env, name);
    assert.doesNotMatch(body, /=== SECTION \d OF 3/, `${name} did not inherit the acceptance envelope`);
    assert.doesNotMatch(body, /CLAIMS, WHICH ARE NOT EVIDENCE/);
  }
});

// The first attempt at AC7 dropped machine criteria from the lane entirely,
// and `every(PASS)` over the resulting empty list printed a green acceptance
// lane on a run with a red criterion. This is that regression's test.
//
// The scenario has to be a criterion that goes red BETWEEN its check and
// verify: an never-proven one cannot reach verify at all, because closing its
// task is refused first. That makes this the sharper case anyway - the lane
// verdict must follow what the frozen tree says now, not the green that was
// recorded earlier.
test("AC7: a machine criterion that turns red fails the acceptance lane rather than vanishing from it", () => {
  const root = makeProject();
  const env = stubEnv(root);
  const verified = prove(root, env);
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);
  assert.equal(state(root).acceptanceCriteria.find((entry) => entry.id === "AC1").check.status, "green");

  // The bound command now fails. Nothing about the ledger's recorded green
  // changes; what changes is what the command does when verify runs it.
  writeAc1Check(root, 1);
  const reverified = run(root, ["implement", "verify"], env);
  assert.notEqual(reverified.status, 0, "a red machine criterion must not verify green");

  const lane = reverified.json.detail.attempt.lanes.acceptance;
  assert.equal(lane.verdict, "FAIL");
  assert.deepEqual(lane.failing.map((entry) => entry.id), ["AC1"]);
  assert.match(lane.failing[0].reason, /the bound Check is not green/);

  // Still no envelope was built for it: AC7 forbids the judge item, not the
  // bookkeeping that keeps the lane honest.
  assert.equal(fs.existsSync(path.join(env.capture, "implement_acceptance_AC1.prompt.txt")), false);
});
