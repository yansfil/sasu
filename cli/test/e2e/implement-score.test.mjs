import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "dist", "cli.js");
const SESSION_KEYS = ["CODEX_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID"];

const TEST_APPROVAL = "TEST-FIXTURE-APPROVAL: not a real human quote";

function prd() {
  return `---
topic: "implement score fixture"
status: "ready"
human_approval: "approved"
review_profile: "standard"
review_rationale: "receipt score fixture"
source_intake: "current conversation"
---

# PRD: implement score fixture

## 1. Summary

Exercise the receipt's two axes and the asset/labor measurement.

## 2. Problem, Goal, And Users

A reader must learn what was proven and what was not without opening state.

## 3. Scope And Non-Goals

Only the score is in scope.

## 4. Pre-Work And Required Decisions

None required.

## 5. Major Technical Structure Changes

No fixture structure change.

## 6. Requirements

- R1. The asset-backed criterion works. Covers AC1.
- R2. The labor-backed criterion works. Covers AC2.
- R3. The driven criterion works. Covers AC3.

## 7. Acceptance Criteria

| ID | Criterion | Judgment | Evidence Declaration |
| --- | --- | --- | --- |
| AC1 | A durable test guards the flow. Covers R1. | machine | - |
| AC2 | A one-off command proved the flow once. Covers R2. | machine | - |
| AC3 | The operator can read the summary. Covers R3. | judged | A capture of the summary output. |

## 8. PRD-Level Tasks

- T1. Implement AC1. Covers R1, AC1. Depends on: none.
- T2. Implement AC2. Covers R2, AC2. Depends on: none.
- T3. Implement AC3. Covers R3, AC3. Depends on: none.

## 9. Verification Contract

### 9.1 Test Mode Contract

| Mode | Required For Done | Covers | Human Decision |
| --- | --- | --- | --- |
| automated behavior | yes | fixture lifecycle | none |

### 9.2 Required Agent Verification

| ID | Mode | Covers | Pass Intent | Required For Done | Can Be Blocked |
| --- | --- | --- | --- | --- | --- |
| V1 | automated behavior | R1, R2, R3, AC1, AC2, AC3 | fixture lifecycle passes | yes | no |

## 10. Risks And Open Decisions

None.

## 11. Implementation Guardrails

Do not expand the fixture.

## 12. Implementation Result Report Contract

Report the score.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-implement-score-e2e-"));
  fs.mkdirSync(path.join(root, "agents", "prd", "fixture"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", "prd", "fixture", "prd.md"), prd());
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e \"console.log('fixture suite green')\"" } }));
  fs.mkdirSync(path.join(root, "test"), { recursive: true });
  fs.writeFileSync(path.join(root, "test", "guard.test.mjs"), "import test from 'node:test';\ntest('guard', () => {});\n");
  for (const args of [
    ["init", "-q"],
    ["add", "-A"],
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
      "implement:acceptance:AC3": {
        verdict: "PASS",
        criteria: [{ id: "AC3", verdict: "PASS", reason: "the capture shows the summary", evidence: "registered artifact" }],
      },
    },
  }));
  return { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture, capture };
}

const bind = (root, ac, command) => {
  const bound = run(root, ["implement", "check", "--ac", ac, "--bind", command]);
  assert.equal(bound.status, 0, bound.stderr + bound.stdout);
  assert.equal(run(root, ["implement", "check", "--ac", ac]).status, 0);
  return bound.json.detail.binding;
};

function prove(root) {
  // AC1's check names a committed test file; AC2's names no path at all.
  const asset = bind(root, "AC1", "node --test test/guard.test.mjs");
  const labor = bind(root, "AC2", "npm test");
  fs.mkdirSync(path.join(root, "shots"), { recursive: true });
  fs.writeFileSync(path.join(root, "shots", "summary.txt"), "AC3 summary capture\n");
  assert.equal(run(root, [
    "implement", "artifact", "--ac", "AC3", "--kind", "log", "--path", "shots/summary.txt", "--description", "summary capture",
  ]).status, 0);
  return { asset, labor };
}

const closeAll = (root, ids = ["T1", "T2", "T3"]) => {
  for (const id of ids) {
    const closed = run(root, ["implement", "task", "--id", id, "--status", "complete"]);
    assert.equal(closed.status, 0, closed.stderr + closed.stdout);
  }
};

test("AC11: the classification a bind reports is the address rule, and it reaches the receipt", () => {
  const root = makeProject();
  const env = stubEnv(root);
  const { asset, labor } = prove(root);
  assert.equal(asset.classification, "asset", "a check naming a committed test file is a durable guard");
  assert.equal(labor.classification, "labor", "a path-less command leaves nothing behind (recorded assumption)");
  closeAll(root);
  assert.equal(run(root, ["implement", "verify"], env).status, 0);

  const finalized = run(root, ["implement", "finalize"]);
  assert.equal(finalized.status, 0, finalized.stderr + finalized.stdout);
  const measured = finalized.json.detail.receipt.score.assetLabor;
  assert.equal(measured.asset, 1);
  assert.equal(measured.labor, 1);
  assert.deepEqual(
    measured.bindings.map((entry) => [entry.criterionId, entry.classification]),
    [["AC1", "asset"], ["AC2", "labor"]],
    "the roster is auditable, not just the counts",
  );
});

test("AC10: an all-green receipt carries both axes", () => {
  const root = makeProject();
  const env = stubEnv(root);
  prove(root);
  closeAll(root);
  assert.equal(run(root, ["implement", "verify"], env).status, 0);
  const finalized = run(root, ["implement", "finalize"]);
  assert.equal(finalized.status, 0, finalized.stderr + finalized.stdout);

  const receipt = finalized.json.detail.receipt;
  assert.equal(receipt.status, "complete");
  assert.equal(receipt.score.acceptance.passed, 3);
  assert.equal(receipt.score.acceptance.total, 3);
  assert.deepEqual(receipt.score.acceptance.parked, []);
  assert.deepEqual(receipt.score.acceptance.unproven, []);
  assert.equal(receipt.score.suite.green, receipt.score.suite.total);
  assert.equal(receipt.scoreLine, `AC: 3/3 PASS | suite: ${receipt.score.suite.green}/${receipt.score.suite.total} GREEN`);

  // The same two axes reach the human report, with the measurement beside them.
  const report = fs.readFileSync(path.join(root, "agents", "runs", "fixture", "implementation-result.md"), "utf8");
  assert.match(report, /## Score/);
  assert.match(report, /AC: 3\/3 PASS \| suite: \d+\/\d+ GREEN/);
  assert.match(report, /1 asset, 1 labor/);
  assert.match(report, /never a gate - no run is refused for its ratio/);
  assert.match(report, /- AC1 \(asset\): `node --test test\/guard.test.mjs` in \./);
  assert.match(report, /- AC2 \(labor\): `npm test` in \./);
});

test("AC10: a parked criterion is scored apart from a failure and still refuses a complete finalize", () => {
  const root = makeProject();
  // A blocked receipt is the only receipt a parked run can reach, and blocked
  // is only honest once verification has no move left - so the fix budget is
  // set to one and the judged criterion is made to fail.
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({ judge: { retryBudget: 1 } }));
  const env = stubEnv(root);
  const stubFile = JSON.parse(fs.readFileSync(env.SASU_JUDGE_STUB_FILE, "utf8"));
  stubFile.byPurpose["implement:acceptance:AC3"] = {
    verdict: "FAIL",
    criteria: [{ id: "AC3", verdict: "FAIL", reason: "the summary is unreadable", evidence: "the capture" }],
  };
  fs.writeFileSync(env.SASU_JUDGE_STUB_FILE, JSON.stringify(stubFile));
  prove(root);

  // AC2 is set aside with a recorded human approval instead of being proven.
  const parked = run(root, [
    "implement", "park", "--ac", "AC2", "--approval", TEST_APPROVAL, "--reason", "the upstream fixture is not built yet",
  ]);
  assert.equal(parked.status, 0, parked.stderr + parked.stdout);
  closeAll(root);

  // The score explains; it does not decide. A parked criterion still blocks a
  // complete finalize exactly as it did before there was a score (D-23).
  assert.notEqual(run(root, ["implement", "verify"], env).status, 0);
  const refused = run(root, ["implement", "finalize"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.json.message, /AC2 is parked/);

  let blocked = run(root, ["implement", "finalize", "--status", "blocked"]);
  while (blocked.status !== 0 && /verification can still run/.test(blocked.json.message ?? "")) {
    assert.notEqual(run(root, ["implement", "verify"], env).status, 0);
    blocked = run(root, ["implement", "finalize", "--status", "blocked"]);
  }
  assert.equal(blocked.status, 0, blocked.stderr + blocked.stdout);

  const score = blocked.json.detail.receipt.score;
  assert.equal(score.acceptance.total, 3);
  assert.equal(score.acceptance.passed, 1, "only AC1 was proven");
  assert.deepEqual(score.acceptance.unproven, ["AC3"], "tried and failed");
  assert.deepEqual(score.acceptance.parked, [
    { id: "AC2", reason: "the upstream fixture is not built yet", parkedBy: "human" },
  ], "set aside is a different fact, and the receipt keeps them apart");
  assert.match(blocked.json.detail.receipt.scoreLine, /AC: 1\/3 PASS \(parked 1: AC2 the upstream fixture is not built yet\)/);
  // The suite axis is reported whatever the AC axis did.
  assert.equal(typeof score.suite.green, "number");
  assert.equal(typeof score.suite.total, "number");

  const report = fs.readFileSync(path.join(root, "agents", "runs", "fixture", "implementation-result.md"), "utf8");
  assert.match(report, /Unproven criteria: AC3\./);
});
