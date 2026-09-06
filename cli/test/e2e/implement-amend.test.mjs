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
const TEST_REASON = "TEST-FIXTURE-REASON: B2 named the wrong artifact";

const B2_BEHAVIOR = "The receipt names every parked row.";
const B2_BEHAVIOR_AMENDED = "The receipt names every parked row and its reason.";
const B2_CHECK = "node scripts/b2.mjs";
const B2_CHECK_AMENDED = "node scripts/b2-v2.mjs";

function prd({ b2Behavior = B2_BEHAVIOR, b2Check = B2_CHECK, extraRows = [] } = {}) {
  return `---
topic: "implement amend fixture"
status: "ready"
human_approval: "approved"
review_profile: "standard"
review_rationale: "amendment fixture"
source_intake: "current conversation"
---

# PRD: implement amend fixture

## Goal

The operator needs to correct a wrong row without discarding the run.

## Non-goals

Only the amendment lifecycle is in scope.

## Decisions

| D-n | 결정 | 근거 |
| --- | --- | --- |
| D-01 | a correction costs only what it invalidates | evidence filed against an unchanged row still stands |

## Behaviors

| # | 사용자가 관찰하는 행동 | 검사 방법 | 결정 |
| --- | --- | --- | --- |
| B1 | The runner executes each command once. | check: \`npm test\` | D-01 |
| B2 | ${b2Behavior} | check: \`${b2Check}\` | D-01 |
${extraRows.join("\n")}

## Technical structure

No fixture structure change.

## Risks

None.
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

function makeProject({ b2Exit = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-implement-amend-e2e-"));
  fs.mkdirSync(path.join(root, "agents", "prd", "fixture"), { recursive: true });
  fs.writeFileSync(path.join(root, PRD_REL), prd());
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e \"console.log('fixture suite green')\"" } }));
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "scripts", "b2.mjs"), `process.exit(${b2Exit});\n`);
  for (const args of [
    ["init", "-q"],
    ["add", "package.json", "scripts"],
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
const row = (root, id) => state(root).rows.find((entry) => entry.id === id);

function proveB1(root) {
  const checked = run(root, ["implement", "check", "--row", "B1"]);
  assert.equal(checked.status, 0, checked.stderr + checked.stdout);
  assert.equal(row(root, "B1").status, "green");
}

const editPrd = (root, options) => fs.writeFileSync(path.join(root, PRD_REL), prd(options));

const amend = (root, issuer = "human", extra = []) => run(root, [
  "implement", "amend", "--issuer", issuer, "--approval", TEST_APPROVAL, "--reason", TEST_REASON, ...extra,
]);

test("the implementor cannot correct the question paper it is marked on", () => {
  const root = makeProject();
  editPrd(root, { b2Check: B2_CHECK_AMENDED });
  const refused = amend(root, "implementor");
  assert.notEqual(refused.status, 0);
  assert.match(refused.json.message, /implementor may not issue .*amend/);
  assert.match(refused.json.message, /limited to observer, human/);
  assert.equal(state(root).amendments.length, 0);
});

test("the observer may repair a check cell but not what the user observes", () => {
  const root = makeProject();
  proveB1(root);
  editPrd(root, { b2Behavior: B2_BEHAVIOR_AMENDED });
  const refused = amend(root, "observer");
  assert.notEqual(refused.status, 0);
  assert.match(refused.json.message, /changes what the user observes \(B2 behavior cell\)/);
  assert.equal(refused.json.detail.rejectedCheck, "authority");
  assert.equal(state(root).amendments.length, 0);
  // The refusal is on the record, so the observer's attempt is auditable.
  assert.equal(state(root).verbs.at(-1).verb, "amend");
  assert.equal(state(root).verbs.at(-1).outcome, "rejected");

  editPrd(root, { b2Check: B2_CHECK_AMENDED });
  const accepted = amend(root, "observer");
  assert.equal(accepted.status, 0, accepted.stderr + accepted.stdout);
  assert.equal(accepted.json.detail.scope, "check-cells");
  assert.equal(accepted.json.detail.amendment.issuer, "observer");
  assert.deepEqual(accepted.json.detail.invalidatedRows, ["B2"]);
  assert.deepEqual(row(root, "B2").check.argv, ["node", "scripts/b2-v2.mjs"], "the next check runs the repaired cell");
  assert.equal(row(root, "B1").status, "green");
});

test("amendment without an approval quote is refused and seals nothing", () => {
  const root = makeProject();
  const pinned = path.join(root, "agents", "runs", "fixture", "prd.md");
  const before = fs.readFileSync(pinned, "utf8");
  editPrd(root, { b2Behavior: B2_BEHAVIOR_AMENDED });
  const refused = run(root, ["implement", "amend", "--issuer", "human", "--reason", TEST_REASON]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.json.message, /requires --approval/);
  assert.equal(refused.json.detail.rejectedCheck, "arguments");
  assert.equal(fs.readFileSync(pinned, "utf8"), before, "a refused amendment re-seals nothing");
  assert.equal(state(root).amendments.length, 0);
});

test("the observer waits while a check: row is mid-attempt; the human may still amend on the record", () => {
  const root = makeProject({ b2Exit: 1 });
  const failed = run(root, ["implement", "check", "--row", "B2"]);
  assert.equal(failed.status, 1, "a failed check exits non-zero and records the attempt");
  assert.equal(row(root, "B2").status, "fail");
  editPrd(root, { b2Check: B2_CHECK_AMENDED });
  const refused = amend(root, "observer");
  assert.notEqual(refused.status, 0);
  assert.match(refused.json.message, /B2 is mid-attempt/);
  assert.equal(refused.json.detail.rejectedCheck, "transition");

  const accepted = amend(root, "human");
  assert.equal(accepted.status, 0, accepted.stderr + accepted.stdout);
  assert.equal(row(root, "B2").status, "pending");
  assert.equal(row(root, "B2").attempts.length, 1, "the failed attempt stays readable");
});

test("an accepted amendment re-seals the PRD and costs only the row it changed", () => {
  const root = makeProject();
  proveB1(root);
  const pinned = path.join(root, "agents", "runs", "fixture", "prd.md");
  const superseded = fs.readFileSync(pinned, "utf8");

  editPrd(root, { b2Behavior: B2_BEHAVIOR_AMENDED });
  const accepted = amend(root);
  assert.equal(accepted.status, 0, accepted.stderr + accepted.stdout);

  const record = accepted.json.detail.amendment;
  assert.equal(record.id, 1);
  assert.equal(record.issuer, "human");
  assert.equal(record.scope, "behaviors");
  assert.equal(record.approval, TEST_APPROVAL);
  assert.deepEqual(record.invalidatedRows, ["B2"]);
  assert.deepEqual(record.addedRows, []);

  // The pinned snapshot now IS the amended text, and the text it replaced is
  // still readable at a path the record names.
  assert.equal(fs.readFileSync(pinned, "utf8"), fs.readFileSync(path.join(root, PRD_REL), "utf8"));
  assert.match(fs.readFileSync(pinned, "utf8"), new RegExp(B2_BEHAVIOR_AMENDED.replace(".", "\\.")));
  assert.equal(fs.readFileSync(path.join(root, record.previousSnapshotPath), "utf8"), superseded);

  assert.equal(row(root, "B1").status, "green", "B1's question did not change, so its proof stands");
  assert.equal(row(root, "B2").status, "pending");
  assert.equal(row(root, "B2").behavior, B2_BEHAVIOR_AMENDED);
  const events = state(root).events;
  assert.equal(events.at(-1).kind, "row-status");
  assert.equal(events.at(-2).kind, "amendment");
  assert.equal(events.at(-2).actor, "human");
});

test("amend is the only sanctioned way past the PRD drift guard", () => {
  const root = makeProject();
  proveB1(root);
  editPrd(root, { b2Behavior: B2_BEHAVIOR_AMENDED });

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

test("an added row joins unproven and the history stays append-only", () => {
  const root = makeProject();
  proveB1(root);
  const extraRows = ["| B3 | The waiter reports its exit reason. | human: the operator says the reason reads well | D-01 |"];
  editPrd(root, { extraRows });
  assert.notEqual(amend(root, "observer").status, 0, "adding a row changes what the user observes");
  const first = amend(root);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  assert.deepEqual(first.json.detail.addedRows, ["B3"]);
  assert.deepEqual(first.json.detail.invalidatedRows, []);
  assert.equal(row(root, "B3").status, "OPEN", "a human: row starts OPEN");
  assert.equal(row(root, "B1").status, "green");

  editPrd(root, { b2Behavior: B2_BEHAVIOR_AMENDED, extraRows });
  const second = amend(root);
  assert.equal(second.status, 0, second.stderr + second.stdout);

  const ledger = state(root).amendments;
  assert.deepEqual(ledger.map((entry) => entry.id), [1, 2]);
  assert.deepEqual(ledger[0].addedRows, ["B3"], "the first record is not rewritten by the second");
  assert.notEqual(ledger[0].previousSnapshotPath, ledger[1].previousSnapshotPath);
  for (const entry of ledger) {
    assert.ok(fs.existsSync(path.join(root, entry.previousSnapshotPath)), `${entry.previousSnapshotPath} stays readable`);
  }
});

test("a parked row whose cell changed is unparked", () => {
  const root = makeProject();
  proveB1(root);
  const parked = run(root, [
    "implement", "park", "--row", "B2", "--approval", TEST_APPROVAL, "--reason", TEST_REASON,
  ]);
  assert.equal(parked.status, 0, parked.stderr + parked.stdout);
  assert.equal(row(root, "B2").status, "parked");

  editPrd(root, { b2Check: B2_CHECK_AMENDED });
  const accepted = amend(root, "observer");
  assert.equal(accepted.status, 0, accepted.stderr + accepted.stdout);
  assert.deepEqual(accepted.json.detail.unparkedRows, ["B2"]);
  assert.equal(row(root, "B2").status, "pending");
  assert.notEqual(row(root, "B2").parks.at(-1).resumedAt, null);
});

test("an unedited PRD has nothing to amend and says so", () => {
  const root = makeProject();
  proveB1(root);
  const refused = amend(root);
  assert.notEqual(refused.status, 0);
  assert.match(refused.json.message, /byte-identical to the pinned snapshot/);
});
