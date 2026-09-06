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

## Goal

A reader must learn what was proven and what was not without opening state.

## Non-goals

Only the score is in scope.

## Decisions

| D-n | 결정 | 근거 |
| --- | --- | --- |
| D-01 | the score explains the outcome and never decides it | a parked row must keep refusing a complete finalize |

## Behaviors

| # | 사용자가 관찰하는 행동 | 검사 방법 | 결정 |
| --- | --- | --- | --- |
| B1 | A durable test guards the flow. | check: \`node --test test/guard.test.mjs\` | D-01 |
| B2 | The suite proves the flow once. | check: \`npm test\` | D-01 |
| B3 | The operator can read the summary. | judge: A capture of the summary output. | D-01 |

## Technical structure

No fixture structure change.

## Risks

None.
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
      "implement:acceptance:B3": {
        verdict: "PASS",
        criteria: [{ id: "B3", verdict: "PASS", reason: "the capture shows the summary", evidence: "registered artifact" }],
      },
    },
  }));
  return { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture, capture };
}

const check = (root, row) => {
  const checked = run(root, ["implement", "check", "--row", row]);
  assert.equal(checked.status, 0, checked.stderr + checked.stdout);
};

function prove(root, rows = ["B1", "B2"]) {
  // The capture is written before any check runs: a check: row is green on
  // one product tree, and verify refuses a green earned on a tree that has
  // since moved - including by a capture file landing in the judged tree.
  fs.mkdirSync(path.join(root, "shots"), { recursive: true });
  fs.writeFileSync(path.join(root, "shots", "summary.txt"), "B3 summary capture\n");
  for (const row of rows) check(root, row);
  assert.equal(run(root, [
    "implement", "artifact", "--row", "B3", "--kind", "log", "--path", "shots/summary.txt", "--description", "summary capture",
  ]).status, 0);
}

test("an all-green receipt carries both axes", () => {
  const root = makeProject();
  const env = stubEnv(root);
  prove(root);
  assert.equal(run(root, ["implement", "verify"], env).status, 0);
  const finalized = run(root, ["implement", "finalize"]);
  assert.equal(finalized.status, 0, finalized.stderr + finalized.stdout);

  const receipt = finalized.json.detail.receipt;
  assert.equal(receipt.status, "complete");
  assert.equal(receipt.score.rows.passed, 3);
  assert.equal(receipt.score.rows.total, 3);
  assert.deepEqual(receipt.score.rows.parked, []);
  assert.deepEqual(receipt.score.rows.unproven, []);
  assert.deepEqual(receipt.score.rows.open, [], "no human: row, so no human clause");
  assert.equal(receipt.score.suite.green, receipt.score.suite.total);
  assert.equal(receipt.scoreLine, `기계·판사: 3/3 PASS | suite: ${receipt.score.suite.green}/${receipt.score.suite.total} GREEN`);

  // The same two axes reach the human report, with every row beside them.
  const report = fs.readFileSync(path.join(root, "agents", "runs", "fixture", "implementation-result.md"), "utf8");
  assert.match(report, /## Score/);
  assert.match(report, /기계·판사: 3\/3 PASS \| suite: \d+\/\d+ GREEN/);
  assert.match(report, /Unproven rows: none\./);
  assert.match(report, /\| B1 \| A durable test guards the flow\. \| check: node --test test\/guard\.test\.mjs \| green \| exit 0 at /);
  assert.match(report, /\| B3 \| The operator can read the summary\. \| judge: A capture of the summary output\. \| PASS \| the capture shows the summary \(registered artifact\) \|/);
});

test("a parked row is scored apart from a failure and still refuses a complete finalize", () => {
  const root = makeProject();
  // A blocked receipt is the only receipt a parked run can reach, and blocked
  // is only honest once verification has no move left - so the fix budget is
  // set to one and the judged row is made to fail.
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({ judge: { retryBudget: 1 } }));
  const env = stubEnv(root);
  const stubFile = JSON.parse(fs.readFileSync(env.SASU_JUDGE_STUB_FILE, "utf8"));
  stubFile.byPurpose["implement:acceptance:B3"] = {
    verdict: "FAIL",
    criteria: [{ id: "B3", verdict: "FAIL", reason: "the summary is unreadable", evidence: "the capture" }],
  };
  fs.writeFileSync(env.SASU_JUDGE_STUB_FILE, JSON.stringify(stubFile));
  prove(root, ["B1"]);

  // B2 is set aside with a recorded human approval instead of being proven.
  const parked = run(root, [
    "implement", "park", "--row", "B2", "--approval", TEST_APPROVAL, "--reason", "the upstream fixture is not built yet",
  ]);
  assert.equal(parked.status, 0, parked.stderr + parked.stdout);

  // The score explains; it does not decide. A parked row still blocks a
  // complete finalize exactly as it did before there was a score (D-01).
  assert.notEqual(run(root, ["implement", "verify"], env).status, 0);
  const refused = run(root, ["implement", "finalize"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.json.message, /B2 is parked/);

  let blocked = run(root, ["implement", "finalize", "--status", "blocked"]);
  while (blocked.status !== 0 && /verification can still run/.test(blocked.json.message ?? "")) {
    assert.notEqual(run(root, ["implement", "verify"], env).status, 0);
    blocked = run(root, ["implement", "finalize", "--status", "blocked"]);
  }
  assert.equal(blocked.status, 0, blocked.stderr + blocked.stdout);

  const score = blocked.json.detail.receipt.score;
  assert.equal(score.rows.total, 3);
  assert.equal(score.rows.passed, 1, "only B1 was proven");
  assert.deepEqual(score.rows.unproven, ["B3"], "tried and failed");
  assert.deepEqual(score.rows.parked, [
    { id: "B2", reason: "the upstream fixture is not built yet" },
  ], "set aside is a different fact, and the receipt keeps them apart");
  assert.match(blocked.json.detail.receipt.scoreLine, /기계·판사: 1\/3 PASS \(parked 1: B2 the upstream fixture is not built yet\)/);
  // The suite axis is reported whatever the row axis did.
  assert.equal(typeof score.suite.green, "number");
  assert.equal(typeof score.suite.total, "number");

  const report = fs.readFileSync(path.join(root, "agents", "runs", "fixture", "implementation-result.md"), "utf8");
  assert.match(report, /Unproven rows: B3\./);
  assert.match(report, /### Parked Rows\n\n- B2: the upstream fixture is not built yet/);
});
