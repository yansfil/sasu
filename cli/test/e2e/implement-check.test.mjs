import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "dist", "cli.js");
const SESSION_KEYS = ["CODEX_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID"];

function prd(criteria) {
  const ids = criteria.map((entry) => entry.id);
  const requirements = criteria.map((entry, index) => `- R${index + 1}. ${entry.id} behavior works. Covers ${entry.id}.`).join("\n");
  const rows = criteria.map((entry) => `| ${entry.id} | ${entry.text} | ${entry.judgment} | ${entry.evidence ?? "-"} |`).join("\n");
  const tasks = criteria.map((entry, index) => `- T${index + 1}. Implement ${entry.id}. Covers R${index + 1}. Depends on: none.`).join("\n");
  const covers = criteria.flatMap((entry, index) => [`R${index + 1}`, entry.id]).join(", ");
  return `---
topic: "implement check fixture"
status: "ready"
human_approval: "approved"
review_profile: "standard"
review_rationale: "completion authority fixture"
source_intake: "current conversation"
---

# PRD: implement check fixture

## 1. Summary

Exercise AC-owned completion checks.

## 2. Problem, Goal, And Users

The operator needs machine-owned completion evidence.

## 3. Scope And Non-Goals

Only the fixture CLI lifecycle is in scope.

## 4. Pre-Work And Required Decisions

None required.

## 5. Major Technical Structure Changes

No fixture structure change.

## 6. Requirements

${requirements}

## 7. Acceptance Criteria

| ID | Criterion | Judgment | Evidence Declaration |
| --- | --- | --- | --- |
${rows}

## 8. PRD-Level Tasks

${tasks}

## 9. Verification Contract

### 9.1 Test Mode Contract

| Mode | Required For Done | Covers | Human Decision |
| --- | --- | --- | --- |
| automated behavior | yes | fixture lifecycle | none |

### 9.2 Required Agent Verification

| ID | Mode | Covers | Pass Intent | Required For Done | Can Be Blocked |
| --- | --- | --- | --- | --- | --- |
| V1 | automated behavior | ${covers} | fixture lifecycle passes | yes | no |

## 10. Risks And Open Decisions

None.

## 11. Implementation Guardrails

Do not expand the fixture.

## 12. Implementation Result Report Contract

Report the receipt and check evidence for ${ids.join(", ")}.
`;
}

function run(root, args, options = {}) {
  const env = { ...process.env, ...(options.env ?? {}) };
  for (const key of SESSION_KEYS) delete env[key];
  delete env.SASU_HERDR_ROLE;
  const executed = spawnSync(process.execPath, [CLI, ...args, "--json"], { cwd: root, encoding: "utf8", env });
  let json;
  try {
    json = JSON.parse(executed.stdout);
  } catch {
    json = { stdout: executed.stdout, stderr: executed.stderr };
  }
  return { ...executed, json };
}

function makeProject(criteria) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-implement-check-e2e-"));
  fs.mkdirSync(path.join(root, "agents", "prd", "fixture"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", "prd", "fixture", "prd.md"), prd(criteria));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e \"console.log('fixture suite green')\"" } }));
  for (const args of [
    ["init", "-q"],
    ["add", "package.json"],
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "base"],
  ]) {
    const executed = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(executed.status, 0, executed.stderr);
  }
  return root;
}

function start(root) {
  const started = run(root, ["implement", "start", "--prd", "agents/prd/fixture/prd.md"]);
  assert.equal(started.status, 0, started.stderr + started.stdout);
  fs.writeFileSync(path.join(root, "implementation.txt"), "run-owned fixture implementation\n");
}

function state(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "agents", "runs", "fixture", "state.json"), "utf8"));
}

function stub(root, criteria, overrides = {}) {
  const file = path.join(root, "agents", "judge.json");
  const capture = path.join(root, "agents", "captures");
  const byPurpose = {
    "implement:fidelity": {
      verdict: "PASS",
      checks: ["F1", "F2", "F3", "F4", "F5"].map((id) => ({ id, verdict: "PASS", reason: "preserved", evidence: "fixture PRD" })),
    },
    "implement:design": { comments: [] },
  };
  for (const entry of criteria) {
    byPurpose[`implement:acceptance:${entry.id}`] = {
      verdict: "PASS",
      criteria: [{ id: entry.id, verdict: "PASS", reason: "fixture proof passed", evidence: "harness check or AC artifact" }],
    };
  }
  Object.assign(byPurpose, overrides);
  fs.writeFileSync(file, JSON.stringify({ byPurpose }));
  return { file, capture, env: { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture } };
}

function bindAndRun(root, ac, command = "npm test", extra = []) {
  const bound = run(root, ["implement", "check", "--ac", ac, "--bind", command]);
  assert.equal(bound.status, 0, bound.stderr + bound.stdout);
  const checked = run(root, ["implement", "check", "--ac", ac, ...extra]);
  return { bound, checked };
}

test("readiness enforces the AC judgment table and reports tag counts", () => {
  const criteria = [
    { id: "AC1", text: "machine proof", judgment: "machine" },
    { id: "AC2", text: "judge proof", judgment: "judged", evidence: "scripted status transcript" },
    { id: "AC3", text: "human window proof", judgment: "machine+gate:human" },
  ];
  const root = makeProject(criteria);
  const ready = run(root, ["prd", "readiness", "--prd", "agents/prd/fixture/prd.md"]);
  assert.equal(ready.status, 0, ready.stderr + ready.stdout);
  assert.deepEqual(ready.json.detail.parsed.acceptanceJudgments, {
    machine: 1,
    judged: 1,
    "machine+gate:human": 1,
    missing: 0,
  });

  const prdPath = path.join(root, "agents", "prd", "fixture", "prd.md");
  const original = fs.readFileSync(prdPath, "utf8");
  fs.writeFileSync(prdPath, original.replace("| AC1 | machine proof | machine | - |", "| AC1 | machine proof |  | - |"));
  const untagged = run(root, ["prd", "readiness", "--prd", "agents/prd/fixture/prd.md"]);
  assert.equal(untagged.status, 1);
  assert.match(JSON.stringify(untagged.json), /AC1 has invalid or missing Judgment/);
  fs.writeFileSync(prdPath, original.replace("| AC2 | judge proof | judged | scripted status transcript |", "| AC2 | judge proof | judged | - |"));
  const noEvidence = run(root, ["prd", "readiness", "--prd", "agents/prd/fixture/prd.md"]);
  assert.equal(noEvidence.status, 1);
  assert.match(JSON.stringify(noEvidence.json), /AC2 is judged but has no Evidence Declaration/);
});

test("SC1 and SC3: machine close needs a harness green and rebind history remains append-only", () => {
  const criteria = [
    { id: "AC1", text: "machine flow closes", judgment: "machine" },
    { id: "AC2", text: "the close reads honestly", judgment: "judged", evidence: "scripted status transcript" },
  ];
  const root = makeProject(criteria);
  start(root);

  const proseOnly = run(root, ["implement", "task", "--id", "T1", "--evidence", "trust me, it passed"]);
  assert.equal(proseOnly.status, 2);
  assert.match(proseOnly.json.message, /AC1: no Check binding/);
  assert.match(proseOnly.json.message, /or park with verbatim human approval/);
  const refused = run(root, ["implement", "check", "--ac", "AC1", "--bind", "curl https://example.com"]);
  assert.equal(refused.status, 2);
  assert.match(refused.json.message, /outside the allowed runner forms/);

  const { bound, checked } = bindAndRun(root, "AC1");
  assert.equal(bound.json.detail.binding.classification, "asset");
  assert.equal(checked.status, 0, checked.stderr + checked.stdout);
  assert.equal(checked.json.detail.attempt.outcome, "green");
  assert.equal(typeof checked.json.detail.attempt.outputFingerprint, "string");
  assert.equal(typeof checked.json.detail.attempt.tree.product, "string");

  const noReason = run(root, ["implement", "check", "--ac", "AC1", "--bind", "node --version"]);
  assert.equal(noReason.status, 2);
  assert.match(noReason.json.message, /requires --reason/);
  const rebound = run(root, ["implement", "check", "--ac", "AC1", "--bind", "node --version", "--reason", "replace the flaky checker"]);
  assert.equal(rebound.status, 0);
  let ledger = state(root).acceptanceCriteria[0].check;
  assert.equal(ledger.bindings.length, 2);
  assert.equal(ledger.status, "pending");
  assert.equal(ledger.consecutiveFailures, 0);
  assert.equal(run(root, ["implement", "check", "--ac", "AC1"]).status, 0);
  assert.equal(run(root, ["implement", "task", "--id", "T1"]).status, 0, "free-text evidence is optional after harness proof");

  fs.writeFileSync(path.join(root, "runtime.log"), "AC and V runtime evidence\n");
  const artifact = run(root, [
    "implement", "artifact", "--id", "V1", "--ac", "AC1", "--kind", "log",
    "--path", "runtime.log", "--description", "dual-bound runtime proof",
  ]);
  assert.equal(artifact.status, 0, artifact.stderr + artifact.stdout);
  assert.equal(artifact.json.detail.artifact.verificationId, "V1");
  assert.equal(artifact.json.detail.artifact.acceptanceCriterionId, "AC1");
  ledger = state(root).acceptanceCriteria[0].check;
  assert.equal(ledger.attempts.length, 2);
  assert.equal(ledger.bindings[0].reason, null);
  assert.equal(ledger.bindings[1].reason, "replace the flaky checker");

  fs.writeFileSync(path.join(root, "transcript.log"), "AC2 status transcript\n");
  assert.equal(run(root, [
    "implement", "artifact", "--ac", "AC2", "--kind", "log", "--path", "transcript.log", "--description", "status transcript",
  ]).status, 0);
  assert.equal(run(root, ["implement", "task", "--id", "T2"]).status, 0);

  const judge = stub(root, criteria);
  const verified = run(root, ["implement", "verify"], { env: judge.env });
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);
  const manifest = state(root).verificationAttempts.at(-1).inputManifest.checkLedger;
  assert.equal(typeof manifest.sha256, "string");
  assert.deepEqual(manifest.bindings.map(({ criterionId, bindingId, classification }) => ({ criterionId, bindingId, classification })), [
    { criterionId: "AC1", bindingId: "B1", classification: "asset" },
    { criterionId: "AC1", bindingId: "B2", classification: "asset" },
  ]);
  // The machine criterion summons no judge (AC7), so the rebind reaches the
  // judge as a FACT in the envelope of the criterion that does (AC8). Without
  // that entry a judge could not tell a criterion that passed from one whose
  // oracle was swapped until it passed.
  assert.equal(fs.existsSync(path.join(judge.capture, "implement_acceptance_AC1.prompt.txt")), false);
  const prompt = fs.readFileSync(path.join(judge.capture, "implement_acceptance_AC2.prompt.txt"), "utf8");
  assert.match(prompt, /HARNESS-OWNED ACCEPTANCE CHECK LEDGER/);
  assert.match(prompt, /CHECK REBINDS:\n- AC1 at .*: npm test -> node --version/);
  const finalized = run(root, ["implement", "finalize"]);
  assert.equal(finalized.status, 0, finalized.stderr + finalized.stdout);
  assert.deepEqual(finalized.json.detail.receipt.skippedAcceptanceCriteria, []);
  const report = fs.readFileSync(path.join(root, "agents", "runs", "fixture", "implementation-result.md"), "utf8");
  assert.match(report, /### Skipped Acceptance Criteria\n\nNone\./);
});

test("task close rejects a forged green status without a harness attempt", () => {
  const criteria = [{ id: "AC1", text: "forged prose cannot close", judgment: "machine" }];
  const root = makeProject(criteria);
  start(root);
  assert.equal(run(root, ["implement", "check", "--ac", "AC1", "--bind", "npm test"]).status, 0);
  const statePath = path.join(root, "agents", "runs", "fixture", "state.json");
  const forged = JSON.parse(fs.readFileSync(statePath, "utf8"));
  forged.acceptanceCriteria[0].check.status = "green";
  fs.writeFileSync(statePath, JSON.stringify(forged));
  const refused = run(root, ["implement", "task", "--id", "T1"]);
  assert.equal(refused.status, 2);
  assert.match(refused.json.message, /check\.status green contradicts the harness-owned attempt ledger/);
});

test("SC2: repeated failures surface one decision, park unlocks close, and resume blocks finalize until re-proof", () => {
  const criteria = [{ id: "AC1", text: "repeat failure flow", judgment: "machine" }];
  const root = makeProject(criteria);
  start(root);
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "scripts", "fail.cjs"), "console.error('Error: fixture still failing'); process.exit(1);\n");
  assert.equal(run(root, ["implement", "check", "--ac", "AC1", "--bind", "node scripts/fail.cjs"]).status, 0);
  const selfReported = run(root, ["implement", "check", "--ac", "AC1", "--outcome", "green"]);
  assert.equal(selfReported.status, 2);
  assert.match(selfReported.json.message, /--outcome is harness-owned/);
  for (let index = 0; index < 4; index += 1) {
    const failed = run(root, ["implement", "check", "--ac", "AC1"]);
    assert.equal(failed.status, 1);
  }
  const status = run(root, ["implement", "status"]);
  assert.equal(status.status, 0);
  assert.equal(status.json.detail.decisionPoints.filter((point) => point.kind === "same-class").length, 1);
  assert.equal(status.json.detail.acceptanceChecks[0].consecutiveFailures, 4);
  assert.equal(run(root, ["implement", "park", "--ac", "AC1", "--reason", "wait for operator"]).status, 2);
  const parked = run(root, [
    "implement", "park", "--ac", "AC1", "--approval", "operator approved overnight park",
    "--reason", "wait for the morning fixture", "--evidence", "fixture-ticket",
  ]);
  assert.equal(parked.status, 0, parked.stderr + parked.stdout);
  assert.equal(parked.json.detail.park.parkedBy, "human");
  assert.equal(parked.json.detail.park.approval, "operator approved overnight park");
  assert.equal(parked.json.detail.park.reason, "wait for the morning fixture");
  assert.equal(typeof parked.json.detail.park.parkedAt, "string");
  assert.equal(run(root, ["implement", "park", "--ac", "AC1", "--approval", "again", "--reason", "again"]).status, 2);
  assert.equal(run(root, ["implement", "task", "--id", "T1"]).status, 0);

  const judge = stub(root, criteria);
  const verified = run(root, ["implement", "verify"], { env: judge.env });
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);
  assert.deepEqual(verified.json.detail.attempt.skippedAcceptanceCriteria, [{ id: "AC1", reason: "wait for the morning fixture" }]);
  assert.equal(state(root).tasks[0].status, "complete");
  const blocked = run(root, ["implement", "finalize"]);
  assert.equal(blocked.status, 2);
  assert.match(blocked.json.message, /AC1 is parked and was skipped by verification/);

  const resumed = run(root, ["implement", "resume", "--ac", "AC1"]);
  assert.equal(resumed.status, 0);
  assert.equal(resumed.json.detail.consecutiveFailures, 0);
  assert.equal(state(root).tasks[0].status, "complete", "resume never reopens an already closed task");
  assert.equal(run(root, ["implement", "resume", "--ac", "AC1"]).status, 2);
  assert.equal(run(root, [
    "implement", "check", "--ac", "AC1", "--bind", "npm test", "--reason", "replace the failed fixture checker",
  ]).status, 0);
  assert.equal(run(root, ["implement", "check", "--ac", "AC1"]).status, 0);
  assert.equal(run(root, ["implement", "verify"], { env: judge.env }).status, 0);
  assert.equal(run(root, ["implement", "finalize"]).status, 0);
});

test("SC4: gate-human checks require a fresh one-use approval for each execution", () => {
  const criteria = [{ id: "AC1", text: "operator window runs", judgment: "machine+gate:human" }];
  const root = makeProject(criteria);
  start(root);
  assert.equal(run(root, ["implement", "check", "--ac", "AC1", "--bind", "npm test"]).status, 0);
  const noWindow = run(root, ["implement", "check", "--ac", "AC1"]);
  assert.equal(noWindow.status, 2);
  assert.match(noWindow.json.message, /requires --human-window/);
  const approved = run(root, ["implement", "check", "--ac", "AC1", "--human-window", "operator approved this one run"]);
  assert.equal(approved.status, 0, approved.stderr + approved.stdout);
  assert.equal(approved.json.detail.attempt.humanWindow.evidence, "operator approved this one run");
  assert.equal(approved.json.detail.attempt.humanWindow.criterionId, "AC1");
  const reused = run(root, ["implement", "check", "--ac", "AC1", "--human-window", "operator approved this one run"]);
  assert.equal(reused.status, 2);
  assert.match(reused.json.message, /already consumed/);
  assert.equal(run(root, ["implement", "task", "--id", "T1"]).status, 0);
});

test("judged-only close succeeds, missing evidence fails without a judge, and AC evidence recovers", () => {
  const criteria = [{ id: "AC1", text: "status transcript is convincing", judgment: "judged", evidence: "scripted status transcript" }];
  const root = makeProject(criteria);
  start(root);
  assert.equal(run(root, ["implement", "task", "--id", "T1"]).status, 0, "judged-only task has no machine close predicate");
  const judge = stub(root, criteria);
  const missing = run(root, ["implement", "verify"], { env: judge.env });
  assert.equal(missing.status, 1);
  assert.equal(missing.json.detail.attempt.lanes.acceptance.verdict, "FAIL");
  const invocation = state(root).verificationAttempts.at(-1).lanes.acceptance.result.invocations[0];
  assert.equal(invocation.verdict, "FAIL");
  assert.equal(invocation.judge, null);
  assert.equal(fs.existsSync(path.join(judge.capture, "implement_acceptance_AC1.prompt.txt")), false);
  assert.equal(state(root).tasks[0].status, "complete");

  fs.writeFileSync(path.join(root, "status.log"), "scripted status transcript\n");
  assert.equal(run(root, [
    "implement", "artifact", "--ac", "AC1", "--kind", "log", "--path", "status.log", "--description", "status transcript",
  ]).status, 0);
  const configured = JSON.parse(fs.readFileSync(judge.file, "utf8"));
  configured.byPurpose["implement:acceptance:AC1"].criteria[0].priorDisposition = {
    status: "resolved",
    reason: "the declared transcript is now registered",
  };
  fs.writeFileSync(judge.file, JSON.stringify(configured));
  assert.equal(run(root, ["implement", "verify"], { env: judge.env }).status, 0);
  assert.equal(run(root, ["implement", "finalize"]).status, 0);
});

test("v5 state refuses check, park, and resume with new-run guidance", () => {
  const root = makeProject([{ id: "AC1", text: "legacy state", judgment: "machine" }]);
  const legacy = path.join(root, "agents", "runs", "legacy", "state.json");
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({ schema: "sasu.implement.state.v5" }));
  for (const command of ["check", "park", "resume"]) {
    const refused = run(root, ["implement", command, "--state", "agents/runs/legacy/state.json", "--ac", "AC1"]);
    assert.equal(refused.status, 2);
    assert.match(refused.json.message, /unsupported implement state schema sasu\.implement\.state\.v5/);
    assert.match(refused.json.message, /Start a new run with `sasu implement start/);
  }
});
