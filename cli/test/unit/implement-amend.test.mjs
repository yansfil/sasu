import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AmendmentRejected, applyAmendment, planAmendment, sealRow } from "../../dist/implement/amend.js";
import { parseImplementContract } from "../../dist/implement/contract.js";
import { sha256 } from "../../dist/implement/store.js";

// Test-only approval strings. They are deliberately self-identifying rather
// than plausible user speech: a fixture must never be mistakable for a
// verbatim quote from a real person in an audit ledger.
const TEST_APPROVAL = "TEST-FIXTURE-APPROVAL: not a real human quote";
const TEST_REASON = "TEST-FIXTURE-REASON: the row named the wrong module";
const AT = "2026-08-29T12:00:00.000Z";

const B1 = "| B1 | The runner executes each command once. | check: `node --test test/runner.test.mjs` | D-01 |";
const B2 = "| B2 | The receipt names every parked row. | check: `node --test test/receipt.test.mjs` | D-01 |";
const B3 = "| B3 | The operator can read the summary. | judge: a capture of the summary output | D-01 |";
const BASE_ROWS = [B1, B2, B3];

function prd(rows = BASE_ROWS, { nonGoals = "Task parallelism.", decisions = ["| D-01 | one runner for every command | two executors disagreed |"] } = {}) {
  return [
    "---",
    'topic: "fixture"',
    'status: "ready"',
    'human_approval: "approved"',
    "---",
    "",
    "# PRD: fixture",
    "",
    "## Goal",
    "",
    "The thing works.",
    "",
    "## Non-goals",
    "",
    nonGoals,
    "",
    "## Decisions",
    "",
    "| D-n | 결정 | 근거 |",
    "| --- | --- | --- |",
    ...decisions,
    "",
    "## Behaviors",
    "",
    "| # | 사용자가 관찰하는 행동 | 검사 방법 | 결정 |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    "## Technical structure",
    "",
    "One runner.",
    "",
    "## Risks",
    "",
    "None.",
    "",
  ].join("\n");
}

function fixture(text = prd()) {
  const contract = parseImplementContract(text);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-amend-"));
  const runDir = "agents/runs/fixture";
  fs.mkdirSync(path.join(root, runDir), { recursive: true });
  fs.writeFileSync(path.join(root, runDir, "prd.md"), text);
  const state = {
    runDir,
    prdPath: "agents/prd/fixture/prd.md",
    prd: { sha256: sha256(text), snapshotPath: `${runDir}/prd.md`, reviewProfile: "standard" },
    rows: contract.rows.map(sealRow),
    amendments: [],
    suite: { sealedAt: AT, commands: [], exclusions: [], results: [] },
  };
  return { root, state, text };
}

const amend = (root, state, text, extra = {}) => applyAmendment(
  root,
  state,
  { issuer: "human", approval: TEST_APPROVAL, reason: TEST_REASON, text, ...extra },
  AT,
);

const row = (state, id) => state.rows.find((entry) => entry.id === id);

function makeGreen(state, id) {
  const entry = row(state, id);
  entry.status = "green";
  entry.attempts.push({ id: "A1", startedAt: AT, finishedAt: AT, exitCode: 0, outcome: "green" });
  return entry;
}

// --- identity is per cell ---------------------------------------------------

test("a table re-alignment amends nothing away", () => {
  const { root, state, text } = fixture();
  makeGreen(state, "B1");
  makeGreen(state, "B2");
  const realigned = text.replace(B1, "|  B1  |  The runner executes each command once.  |  check: `node --test test/runner.test.mjs`  |  D-01  |");
  assert.throws(() => amend(root, state, realigned), (error) => {
    assert.ok(error instanceof AmendmentRejected);
    assert.equal(error.check, "arguments");
    return /nothing to amend/.test(error.message);
  });
  assert.equal(row(state, "B1").status, "green", "a formatter run must not cost a green");
  assert.equal(state.amendments.length, 0);
});

test("a check-cell edit invalidates only that row; untouched evidence survives", () => {
  const { root, state, text } = fixture();
  makeGreen(state, "B1");
  makeGreen(state, "B2");
  const next = text.replace("node --test test/receipt.test.mjs", "node --test test/receipt-v2.test.mjs");
  const { plan, record } = amend(root, state, next, { issuer: "observer" });

  assert.equal(plan.scope, "check-cells");
  assert.deepEqual(plan.checkCellChanged, ["B2"]);
  assert.deepEqual(plan.invalidatedRows, ["B2"]);
  assert.deepEqual(plan.unchangedRows, ["B1", "B3"]);
  assert.equal(record.issuer, "observer");
  assert.equal(record.scope, "check-cells");
  assert.equal(row(state, "B1").status, "green", "B1's question did not change, so its proof stands");
  assert.equal(row(state, "B2").status, "pending");
  assert.equal(row(state, "B2").attempts.length, 1, "the attempt history stays readable; only the verdict is taken back");
  assert.deepEqual(row(state, "B2").check.argv, ["node", "--test", "test/receipt-v2.test.mjs"], "the new cell is what the next check runs");
});

test("a behavior-cell edit is a scope change: the observer is refused and the human is accepted", () => {
  const { root, state, text } = fixture();
  makeGreen(state, "B2");
  const next = text.replace("The receipt names every parked row.", "The receipt names every parked row and its reason.");
  assert.throws(() => amend(root, state, next, { issuer: "observer" }), (error) => {
    assert.ok(error instanceof AmendmentRejected);
    assert.equal(error.check, "authority");
    return /changes what the user observes \(B2 behavior cell\)/.test(error.message);
  });
  assert.equal(state.amendments.length, 0, "a refused amendment reaches no ledger");
  assert.equal(fs.readFileSync(path.join(root, state.runDir, "prd.md"), "utf8"), text, "and seals no snapshot");

  const { plan, record } = amend(root, state, next, { issuer: "human" });
  assert.equal(plan.scope, "behaviors");
  assert.deepEqual(plan.behaviorChanged, ["B2"]);
  assert.equal(record.issuer, "human");
  assert.equal(row(state, "B2").status, "pending");
  assert.match(row(state, "B2").behavior, /and its reason/);
});

test("moving Non-goals or a Decisions row is a scope change even when no Behaviors row moved", () => {
  const { root, state, text } = fixture();
  const nonGoals = text.replace("Task parallelism.", "Task parallelism and retries.");
  assert.throws(() => amend(root, state, nonGoals, { issuer: "observer" }), /\(Non-goals\)/);
  const decisions = text.replace("two executors disagreed", "two executors disagreed on cwd");
  assert.throws(() => amend(root, state, decisions, { issuer: "observer" }), /\(Decisions\)/);
  const { plan } = amend(root, state, decisions, { issuer: "human" });
  assert.equal(plan.scope, "behaviors");
  assert.deepEqual(plan.scopeSectionsChanged, ["Decisions"]);
  assert.deepEqual(plan.invalidatedRows, [], "a Decisions edit changes the reason, not the proof already filed against each row");
});

// --- who may issue ----------------------------------------------------------

test("the implementor may not amend the PRD it is being marked on", () => {
  const { root, state, text } = fixture();
  const next = text.replace("node --test test/receipt.test.mjs", "node --test test/other.test.mjs");
  assert.throws(() => amend(root, state, next, { issuer: "implementor" }), (error) => {
    assert.equal(error.check, "authority");
    return /implementor may not amend/.test(error.message);
  });
  assert.equal(state.amendments.length, 0);
});

test("an amendment without an approval quote or without a reason is refused", () => {
  const { root, state, text } = fixture();
  const next = text.replace("node --test test/receipt.test.mjs", "node --test test/other.test.mjs");
  assert.throws(() => amend(root, state, next, { approval: "  " }), (error) => {
    assert.ok(error instanceof AmendmentRejected);
    assert.equal(error.check, "arguments");
    return /requires --approval/.test(error.message);
  });
  assert.throws(() => amend(root, state, next, { reason: "" }), /requires --reason/);
  assert.equal(state.amendments.length, 0);
  assert.equal(fs.readFileSync(path.join(root, state.runDir, "prd.md"), "utf8"), text);
});

test("an observer waits while a check: row is mid-attempt; the human may still amend on the record", () => {
  const { root, state, text } = fixture();
  const failing = row(state, "B1");
  failing.status = "fail";
  failing.consecutiveFailures = 1;
  failing.attempts.push({ id: "A1", startedAt: AT, finishedAt: AT, exitCode: 1, outcome: "failed" });
  const next = text.replace("node --test test/receipt.test.mjs", "node --test test/other.test.mjs");
  assert.throws(() => amend(root, state, next, { issuer: "observer" }), (error) => {
    assert.equal(error.check, "transition");
    return /B1 is mid-attempt/.test(error.message);
  });
  assert.doesNotThrow(() => amend(root, state, next, { issuer: "human" }));
});

// --- sealing, history, added and removed rows, unparking --------------------

test("the new snapshot is sealed and the one it replaced is archived distinguishably", () => {
  const { root, state, text } = fixture();
  const next = text.replace("node --test test/runner.test.mjs", "node --test test/runner-v2.test.mjs");
  const { record } = amend(root, state, next);

  const pinned = fs.readFileSync(path.join(root, record.snapshotPath), "utf8");
  const superseded = fs.readFileSync(path.join(root, record.previousSnapshotPath), "utf8");
  assert.equal(pinned, next, "the pinned snapshot is now the amended text");
  assert.equal(superseded, text, "and the text it replaced is recoverable");
  assert.equal(record.snapshotPath, `${state.runDir}/prd.md`, "the pinned path is stable so every reader keeps resolving it");
  assert.equal(state.prd.sha256, sha256(next));
  assert.equal(record.prdSha256, sha256(next));
  assert.equal(record.approval, TEST_APPROVAL);
  assert.equal(record.suiteSnapshotUpdated, false);
});

test("the history is append-only with monotonic ids and never rewritten", () => {
  const { root, state, text } = fixture();
  const first = text.replace("node --test test/runner.test.mjs", "node --test test/runner-v2.test.mjs");
  amend(root, state, first);
  const frozen = JSON.parse(JSON.stringify(state.amendments[0]));
  const second = first.replace("node --test test/receipt.test.mjs", "node --test test/receipt-v2.test.mjs");
  amend(root, state, second);

  assert.deepEqual(state.amendments.map((entry) => entry.id), [1, 2]);
  assert.deepEqual(state.amendments[0], frozen, "an earlier amendment is not touched by a later one");
  assert.notEqual(state.amendments[0].previousSnapshotPath, state.amendments[1].previousSnapshotPath);
  assert.equal(fs.readFileSync(path.join(root, state.amendments[0].previousSnapshotPath), "utf8"), text);
});

test("an added row joins unproven, a removed row leaves the ledger, and both are human-only", () => {
  const { root, state, text } = fixture();
  makeGreen(state, "B1");
  const added = text.replace(B3, `${B3}\n| B4 | The waiter reports its exit reason. | human: the operator says the reason reads well | D-01 |`);
  assert.throws(() => amend(root, state, added, { issuer: "observer" }), /\(\+B4\)/);
  const { plan } = amend(root, state, added);
  assert.deepEqual(plan.addedRows, ["B4"]);
  assert.deepEqual(plan.invalidatedRows, []);
  assert.equal(row(state, "B4").status, "OPEN", "a human: row starts OPEN");
  assert.equal(row(state, "B1").status, "green", "adding a question does not un-answer the others");

  const removed = added.replace(`${B2}\n`, "");
  assert.throws(() => amend(root, state, removed, { issuer: "observer" }), /\(-B2\)/);
  const outcome = amend(root, state, removed);
  assert.deepEqual(outcome.plan.removedRows, ["B2"]);
  assert.deepEqual(state.rows.map((entry) => entry.id), ["B1", "B3", "B4"]);
});

test("a parked row whose cell changed is unparked; one left alone stays parked", () => {
  const { root, state, text } = fixture();
  for (const id of ["B1", "B2"]) {
    const entry = row(state, id);
    entry.status = "parked";
    entry.parks.push({ parkedAt: AT, approval: TEST_APPROVAL, reason: TEST_REASON, evidence: null, resumedAt: null });
  }
  const next = text.replace("node --test test/receipt.test.mjs", "node --test test/receipt-v2.test.mjs");
  const { plan } = amend(root, state, next, { issuer: "observer" });

  assert.deepEqual(plan.unparkedRows, ["B2"]);
  assert.equal(row(state, "B2").status, "pending");
  assert.equal(row(state, "B2").parks.at(-1).resumedAt, AT);
  assert.equal(row(state, "B1").status, "parked", "a park survives an amendment that did not touch its row");
  assert.equal(row(state, "B1").parks.at(-1).resumedAt, null);
});

test("a row that changes kind starts its ledger over", () => {
  const { root, state, text } = fixture();
  makeGreen(state, "B2");
  const next = text.replace("check: `node --test test/receipt.test.mjs`", "judge: the receipt is read by the judge");
  const { plan } = amend(root, state, next);
  assert.deepEqual(plan.invalidatedRows, ["B2"]);
  assert.equal(row(state, "B2").check.kind, "judge");
  assert.deepEqual(row(state, "B2").attempts, [], "an exit code proves nothing about a judge: question");
  assert.equal(row(state, "B2").status, "pending");
});

test("planAmendment reports without writing anything", () => {
  const { state, text } = fixture();
  makeGreen(state, "B1");
  const current = parseImplementContract(text);
  const next = parseImplementContract(text.replace("node --test test/receipt.test.mjs", "node --test test/receipt-v2.test.mjs"));
  const plan = planAmendment(state, current, next);
  assert.deepEqual(plan.invalidatedRows, ["B2"]);
  assert.equal(row(state, "B1").status, "green");
  assert.equal(state.amendments.length, 0);
});
