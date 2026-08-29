import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "dist", "cli.js");
const SESSION_KEYS = ["CODEX_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID"];

// Test-only approval text, deliberately self-identifying: an approval quote
// lands verbatim in an audit ledger, and a fixture must never be mistakable
// for something a real person said.
const TEST_APPROVAL = "TEST-FIXTURE-APPROVAL: not a real human quote";
const TEST_REASON = "TEST-FIXTURE-REASON: AC2 named the wrong artifact";

const AC2_ORIGINAL = "the receipt names every parked criterion";
const AC2_AMENDED = "the receipt names every parked criterion and its reason";

function prd({ ac2 = AC2_ORIGINAL, extraRows = [] } = {}) {
  return `---
topic: "implement amend fixture"
status: "ready"
human_approval: "approved"
review_profile: "standard"
review_rationale: "amendment fixture"
source_intake: "current conversation"
---

# PRD: implement amend fixture

## 1. Summary

Exercise mid-run PRD amendment.

## 2. Problem, Goal, And Users

The operator needs to correct a wrong criterion without discarding the run.

## 3. Scope And Non-Goals

Only the amendment lifecycle is in scope.

## 4. Pre-Work And Required Decisions

None required.

## 5. Major Technical Structure Changes

No fixture structure change.

## 6. Requirements

- R1. AC1 behavior works. Covers AC1.
- R2. AC2 behavior works. Covers AC2.

## 7. Acceptance Criteria

| ID | Criterion | Judgment | Evidence Declaration |
| --- | --- | --- | --- |
| AC1 | The runner executes each command once. Covers R1. | machine | - |
| AC2 | ${ac2}. Covers R2. | machine | - |
${extraRows.join("\n")}

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

Report the receipt and amendment ledger.
`;
}

function run(root, args) {
  const env = { ...process.env };
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

const PRD_REL = path.join("agents", "prd", "fixture", "prd.md");

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-implement-amend-e2e-"));
  fs.mkdirSync(path.join(root, "agents", "prd", "fixture"), { recursive: true });
  fs.writeFileSync(path.join(root, PRD_REL), prd());
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

const state = (root) => JSON.parse(fs.readFileSync(path.join(root, "agents", "runs", "fixture", "state.json"), "utf8"));
const criterion = (root, id) => state(root).acceptanceCriteria.find((entry) => entry.id === id);

function proveAc1(root) {
  assert.equal(run(root, ["implement", "check", "--ac", "AC1", "--bind", "npm test"]).status, 0);
  const checked = run(root, ["implement", "check", "--ac", "AC1"]);
  assert.equal(checked.status, 0, checked.stderr + checked.stdout);
  assert.equal(criterion(root, "AC1").check.status, "green");
  // Amendment requires an idle run (AC15): close the task that held AC1.
  assert.equal(run(root, ["implement", "task", "--id", "T1", "--status", "complete"]).status, 0);
}

const editPrd = (root, options) => fs.writeFileSync(path.join(root, PRD_REL), prd(options));

const amend = (root, extra = []) => run(root, [
  "implement", "amend", "--issuer", "human", "--approval", TEST_APPROVAL, "--reason", TEST_REASON, ...extra,
]);

test("AC12: the supervisor cannot correct the question paper", () => {
  const root = makeProject();
  editPrd(root, { ac2: AC2_AMENDED });
  const refused = run(root, [
    "implement", "amend", "--issuer", "observer", "--approval", TEST_APPROVAL, "--reason", TEST_REASON,
  ]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.json.message, /observer may not issue .*amend/);
  assert.match(refused.json.message, /limited to human/);
  assert.equal(state(root).amendments.length, 0);
});

test("AC12: amendment without an approval quote is refused and seals nothing", () => {
  const root = makeProject();
  const pinned = path.join(root, "agents", "runs", "fixture", "prd.md");
  const before = fs.readFileSync(pinned, "utf8");
  editPrd(root, { ac2: AC2_AMENDED });
  const refused = run(root, ["implement", "amend", "--issuer", "human", "--reason", TEST_REASON]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.json.message, /requires --approval/);
  assert.equal(refused.json.detail.rejectedCheck, "arguments");
  assert.equal(fs.readFileSync(pinned, "utf8"), before, "a refused amendment re-seals nothing");
  assert.equal(state(root).amendments.length, 0);
});

test("AC15: amendment is refused while a task is in progress", () => {
  const root = makeProject();
  assert.equal(run(root, ["implement", "check", "--ac", "AC2", "--bind", "npm test"]).status, 0);
  editPrd(root, { ac2: AC2_AMENDED });
  const refused = amend(root);
  assert.notEqual(refused.status, 0);
  assert.match(refused.json.message, /T2 is in progress/);
  assert.equal(refused.json.detail.rejectedCheck, "transition");
});

test("AC13, AC16: an accepted amendment re-seals the PRD and costs only the row it changed", () => {
  const root = makeProject();
  proveAc1(root);
  const pinned = path.join(root, "agents", "runs", "fixture", "prd.md");
  const superseded = fs.readFileSync(pinned, "utf8");

  editPrd(root, { ac2: AC2_AMENDED });
  const accepted = amend(root);
  assert.equal(accepted.status, 0, accepted.stderr + accepted.stdout);

  const record = accepted.json.detail.amendment;
  assert.equal(record.id, 1);
  assert.equal(record.issuer, "human");
  assert.equal(record.approval, TEST_APPROVAL);
  assert.deepEqual(record.invalidatedCriteria, ["AC2"]);
  assert.deepEqual(record.addedCriteria, []);

  // The pinned snapshot now IS the amended text, and the text it replaced is
  // still readable at a path the record names (AC16).
  assert.equal(fs.readFileSync(pinned, "utf8"), fs.readFileSync(path.join(root, PRD_REL), "utf8"));
  assert.match(fs.readFileSync(pinned, "utf8"), new RegExp(AC2_AMENDED));
  assert.equal(fs.readFileSync(path.join(root, record.previousSnapshotPath), "utf8"), superseded);

  assert.equal(criterion(root, "AC1").check.status, "green", "AC1's question did not change, so its proof stands");
  assert.equal(criterion(root, "AC2").check.status, "pending");
  assert.equal(state(root).events.at(-1).kind, "amendment");
  assert.equal(state(root).events.at(-1).actor, "human");
});

test("amend is the only sanctioned way past the PRD drift guard", () => {
  const root = makeProject();
  proveAc1(root);
  editPrd(root, { ac2: AC2_AMENDED });

  // Before amending, the edited source PRD is drift: the run reports that the
  // question paper it is measured against no longer matches the file.
  const drifted = run(root, ["implement", "status"]);
  assert.equal(drifted.status, 0);
  assert.equal(drifted.json.detail.prdDrift.code, "prd-drift");

  assert.equal(amend(root).status, 0);

  // After amending, the drift is gone - not waived, re-sealed. The run is now
  // measured against the corrected paper.
  const resealed = run(root, ["implement", "status"]);
  assert.equal(resealed.status, 0, resealed.stderr + resealed.stdout);
  assert.equal(resealed.json.detail.prdDrift, null);
});

test("AC16: an added criterion joins unproven and the history stays append-only", () => {
  const root = makeProject();
  proveAc1(root);
  editPrd(root, { extraRows: ["| AC3 | The waiter reports its exit reason. Covers R2. | machine | - |"] });
  const first = amend(root);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  assert.deepEqual(first.json.detail.addedCriteria, ["AC3"]);
  assert.deepEqual(first.json.detail.invalidatedCriteria, []);
  assert.equal(criterion(root, "AC3").check.status, "pending");
  assert.deepEqual(criterion(root, "AC3").check.bindings, []);
  assert.equal(criterion(root, "AC1").check.status, "green");

  editPrd(root, { ac2: AC2_AMENDED, extraRows: ["| AC3 | The waiter reports its exit reason. Covers R2. | machine | - |"] });
  const second = amend(root);
  assert.equal(second.status, 0, second.stderr + second.stdout);

  const ledger = state(root).amendments;
  assert.deepEqual(ledger.map((entry) => entry.id), [1, 2]);
  assert.deepEqual(ledger[0].addedCriteria, ["AC3"], "the first record is not rewritten by the second");
  assert.notEqual(ledger[0].previousSnapshotPath, ledger[1].previousSnapshotPath);
  for (const entry of ledger) {
    assert.ok(fs.existsSync(path.join(root, entry.previousSnapshotPath)), `${entry.previousSnapshotPath} stays readable`);
  }
});

test("AC16: a parked criterion whose row changed is unparked", () => {
  const root = makeProject();
  proveAc1(root);
  const parked = run(root, [
    "implement", "park", "--ac", "AC2", "--approval", TEST_APPROVAL, "--reason", TEST_REASON,
  ]);
  assert.equal(parked.status, 0, parked.stderr + parked.stdout);
  assert.equal(criterion(root, "AC2").check.status, "parked");

  editPrd(root, { ac2: AC2_AMENDED });
  const accepted = amend(root);
  assert.equal(accepted.status, 0, accepted.stderr + accepted.stdout);
  assert.deepEqual(accepted.json.detail.unparkedCriteria, ["AC2"]);
  assert.equal(criterion(root, "AC2").check.status, "pending");
  assert.equal(criterion(root, "AC2").check.parks.at(-1).resumedAt !== null, true);
});

test("an unedited PRD has nothing to amend and says so", () => {
  const root = makeProject();
  proveAc1(root);
  const refused = amend(root);
  assert.notEqual(refused.status, 0);
  assert.match(refused.json.message, /byte-identical to the pinned snapshot/);
});
