import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AmendmentRejected,
  applyAmendment,
  criterionRowHash,
  planAmendment,
  tasksInProgress,
} from "../../dist/implement/amend.js";
import { parseImplementContract } from "../../dist/implement/contract.js";
import { assertCommandAuthority } from "../../dist/implement/verbs.js";
import { sha256 } from "../../dist/implement/store.js";

// Test-only approval strings. They are deliberately self-identifying rather
// than plausible user speech: a fixture must never be mistakable for a
// verbatim quote from a real person in an audit ledger.
const TEST_APPROVAL = "TEST-FIXTURE-APPROVAL: not a real human quote";
const TEST_REASON = "TEST-FIXTURE-REASON: the criterion named the wrong module";

function prd(rows, { tasks = ["T1. Do the thing. Covers R1, AC1, AC2, AC3."] } = {}) {
  return [
    "---",
    'topic: "fixture"',
    'status: "ready"',
    'human_approval: "approved"',
    "---",
    "",
    "# PRD: fixture",
    "",
    "## 6. Requirements",
    "",
    "- R1. The thing works.",
    "",
    "## 7. Acceptance Criteria",
    "",
    "| ID | Criterion | Judgment | Evidence Declaration |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    "## 8. PRD-Level Tasks",
    "",
    ...tasks.map((line) => `- ${line}`),
    "",
    "## 9. Verification Contract",
    "",
    "| ID | Mode | Covers | Pass Intent | Required For Done | Can Be Blocked |",
    "| --- | --- | --- | --- | --- | --- |",
    "| V1 | build/static | R1 | the build is green | yes | no |",
    "",
  ].join("\n");
}

const BASE_ROWS = [
  "| AC1 | The runner executes each command once. Covers R1. | machine | - |",
  "| AC2 | The receipt names every parked criterion. Covers R1. | machine | - |",
  "| AC3 | The operator can read the summary. Covers R1. | judged | Screen capture and the observer's note |",
];

function fixture(rows = BASE_ROWS, options) {
  const text = prd(rows, options);
  const contract = parseImplementContract(text);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-amend-"));
  const runDir = "agents/runs/fixture";
  fs.mkdirSync(path.join(root, runDir), { recursive: true });
  fs.writeFileSync(path.join(root, runDir, "prd.md"), text);
  const state = {
    runDir,
    prdPath: "agents/prd/fixture/prd.md",
    prd: { sha256: sha256(text), snapshotPath: `${runDir}/prd.md` },
    tasks: contract.tasks,
    requirements: contract.requirements,
    acceptanceCriteria: contract.acceptanceCriteria,
    verification: contract.verification,
    amendments: [],
  };
  return { root, state, text };
}

const amend = (root, state, text, extra = {}) => applyAmendment(
  root,
  state,
  { approval: TEST_APPROVAL, reason: TEST_REASON, text, ...extra },
  "2026-08-29T12:00:00.000Z",
);

const criterion = (state, id) => state.acceptanceCriteria.find((entry) => entry.id === id);

function makeGreen(state, id) {
  const entry = criterion(state, id);
  entry.check.status = "green";
  entry.check.bindings.push({ id: "B1", command: "node --test", argv: ["node", "--test"], cwd: "cli", classification: "asset", boundAt: "t", reason: null });
  entry.check.attempts.push({ id: "A1", at: "t", exitCode: 0 });
  return entry;
}

// --- AC14: row identity -----------------------------------------------------

test("AC14: identity is the three fields, normalized - format-only edits do not invalidate", () => {
  const same = criterionRowHash({ text: "The runner runs once.", judgment: "machine", evidenceDeclaration: null });
  assert.equal(
    criterionRowHash({ text: "  The   runner\truns once.  ", judgment: " machine ", evidenceDeclaration: "" }),
    same,
    "leading/trailing space and collapsed runs are formatting, not meaning",
  );
});

test("AC14: changing the judgment tag alone invalidates the row", () => {
  const machine = criterionRowHash({ text: "The runner runs once.", judgment: "machine", evidenceDeclaration: null });
  const judged = criterionRowHash({ text: "The runner runs once.", judgment: "judged", evidenceDeclaration: null });
  assert.notEqual(machine, judged, "who proves a criterion is part of the question it asks (D-40)");
});

test("AC14: changing the evidence declaration alone invalidates the row", () => {
  const before = criterionRowHash({ text: "T", judgment: "judged", evidenceDeclaration: "a capture" });
  const after = criterionRowHash({ text: "T", judgment: "judged", evidenceDeclaration: "a capture and a note" });
  assert.notEqual(before, after);
});

// The three fields must not be able to smear into one another: without a
// separator no field can contain, moving text across a field boundary would
// hash the same and a real change would pass as untouched.
test("AC14: field boundaries are not hashable across", () => {
  assert.notEqual(
    criterionRowHash({ text: "ab", judgment: "machine", evidenceDeclaration: null }),
    criterionRowHash({ text: "a", judgment: "bmachine", evidenceDeclaration: null }),
  );
});

test("AC14: a table re-alignment amends nothing away", () => {
  const { root, state, text } = fixture();
  makeGreen(state, "AC1");
  makeGreen(state, "AC2");
  // Amendment requires an idle run (AC15), so the holding task is closed
  // first; this test is about identity, not about the idle guard.
  state.tasks[0].status = "complete";
  const realigned = text
    .replace("| AC1 | The runner executes each command once. Covers R1. | machine | - |",
      "|  AC1  |  The runner executes each command once.  Covers R1.  |  machine  |  -  |");
  const { plan } = amend(root, state, realigned);
  assert.deepEqual(plan.invalidatedCriteria, [], "a formatter run must not cost a green");
  assert.equal(criterion(state, "AC1").check.status, "green");
});

// --- AC13: selective invalidation -------------------------------------------

test("AC13: only the changed row loses green; untouched evidence survives", () => {
  const { root, state, text } = fixture();
  makeGreen(state, "AC1");
  makeGreen(state, "AC2");
  state.tasks[0].status = "complete";
  const next = text.replace("The receipt names every parked criterion.", "The receipt names every parked criterion and its reason.");
  const { plan } = amend(root, state, next);

  assert.deepEqual(plan.invalidatedCriteria, ["AC2"]);
  assert.deepEqual(plan.unchangedCriteria, ["AC1", "AC3"]);
  assert.equal(criterion(state, "AC1").check.status, "green", "AC1's question did not change, so its proof stands");
  assert.equal(criterion(state, "AC1").check.attempts.length, 1);
  assert.equal(criterion(state, "AC2").check.status, "pending");
  assert.equal(criterion(state, "AC2").check.attempts.length, 1, "the attempt history stays readable; only the verdict is taken back");
  assert.equal(criterion(state, "AC2").text.includes("and its reason"), true);
});

// --- AC12: human-only issuance ----------------------------------------------

test("AC12: an observer-issued amendment is refused on authority", () => {
  assert.throws(() => assertCommandAuthority("amend", "observer"), /observer may not issue .*amend.*limited to human/s);
  assert.doesNotThrow(() => assertCommandAuthority("amend", "human"));
  assert.throws(() => assertCommandAuthority("amend", "implementor"), /limited to human/);
});

test("AC12: an amendment without an approval quote or without a reason is refused", () => {
  const { root, state, text } = fixture();
  const next = text.replace("The runner executes each command once.", "The runner executes each command exactly once.");
  assert.throws(() => amend(root, state, next, { approval: "  " }), (error) => {
    assert.ok(error instanceof AmendmentRejected);
    assert.equal(error.check, "arguments");
    return /requires --approval/.test(error.message);
  });
  assert.throws(() => amend(root, state, next, { reason: "" }), /requires --reason/);
  assert.equal(state.amendments.length, 0, "a refused amendment reaches no ledger");
  assert.equal(fs.readFileSync(path.join(root, state.runDir, "prd.md"), "utf8"), text, "and seals no snapshot");
});

// --- AC15: idle-only ---------------------------------------------------------

test("AC15: a bound or attempted criterion makes its task in progress, and amendment is refused", () => {
  const { root, state, text } = fixture();
  assert.deepEqual(tasksInProgress(state), [], "a pending task nobody has touched is next, not in progress");
  makeGreen(state, "AC1");
  assert.deepEqual(tasksInProgress(state), ["T1"]);
  const next = text.replace("The receipt names every parked criterion.", "The receipt names each parked criterion.");
  assert.throws(() => amend(root, state, next), (error) => {
    assert.equal(error.check, "transition");
    return /T1 is in progress/.test(error.message);
  });
});

test("AC15: a completed task is not in progress, and a park does not make one", () => {
  const { root, state, text } = fixture();
  makeGreen(state, "AC1");
  state.tasks[0].status = "complete";
  assert.deepEqual(tasksInProgress(state), []);
  const next = text.replace("The receipt names every parked criterion.", "The receipt names each parked criterion.");
  assert.doesNotThrow(() => amend(root, state, next));
});

// --- AC16: sealing, history, added criteria, unparking -----------------------

test("AC16: the new snapshot is sealed and the one it replaced is archived distinguishably", () => {
  const { root, state, text } = fixture();
  const next = text.replace("The runner executes each command once.", "The runner executes each bound command once.");
  const { record } = amend(root, state, next);

  const pinned = fs.readFileSync(path.join(root, record.snapshotPath), "utf8");
  const superseded = fs.readFileSync(path.join(root, record.previousSnapshotPath), "utf8");
  assert.equal(pinned, next, "the pinned snapshot is now the amended text");
  assert.equal(superseded, text, "and the text it replaced is recoverable");
  assert.notEqual(pinned, superseded);
  assert.equal(record.snapshotPath, `${state.runDir}/prd.md`, "the pinned path is stable so every reader keeps resolving it");
  assert.equal(state.prd.sha256, sha256(next));
  assert.equal(record.prdSha256, sha256(next));
  assert.equal(record.issuer, "human");
  assert.equal(record.approval, TEST_APPROVAL);
  assert.equal(record.suiteSnapshotUpdated, false);
});

test("AC16: the history is append-only with monotonic ids and never rewritten", () => {
  const { root, state, text } = fixture();
  const first = text.replace("The runner executes each command once.", "The runner executes each bound command once.");
  amend(root, state, first);
  const frozen = JSON.parse(JSON.stringify(state.amendments[0]));
  const second = first.replace("The receipt names every parked criterion.", "The receipt names each parked criterion.");
  amend(root, state, second);

  assert.deepEqual(state.amendments.map((entry) => entry.id), [1, 2]);
  assert.deepEqual(state.amendments[0], frozen, "an earlier amendment is not touched by a later one");
  assert.notEqual(state.amendments[0].previousSnapshotPath, state.amendments[1].previousSnapshotPath);
  assert.equal(
    fs.readFileSync(path.join(root, state.amendments[0].previousSnapshotPath), "utf8"),
    text,
    "every superseded version stays readable, not just the last",
  );
});

test("AC16: an added criterion joins unproven", () => {
  const { root, state, text } = fixture();
  makeGreen(state, "AC1");
  state.tasks[0].status = "complete";
  const next = text.replace(
    "| AC3 | The operator can read the summary. Covers R1. | judged | Screen capture and the observer's note |",
    "| AC3 | The operator can read the summary. Covers R1. | judged | Screen capture and the observer's note |\n| AC4 | The waiter reports its exit reason. Covers R1. | machine | - |",
  );
  const { plan } = amend(root, state, next);
  assert.deepEqual(plan.addedCriteria, ["AC4"]);
  assert.deepEqual(plan.invalidatedCriteria, []);
  const added = criterion(state, "AC4");
  assert.equal(added.check.status, "pending");
  assert.deepEqual(added.check.bindings, []);
  assert.deepEqual(added.check.attempts, []);
  assert.equal(criterion(state, "AC1").check.status, "green", "adding a question does not un-answer the others");
});

test("AC16: a parked criterion whose row changed is unparked; one left alone stays parked", () => {
  const { root, state, text } = fixture();
  for (const id of ["AC2", "AC3"]) {
    const entry = criterion(state, id);
    entry.check.status = "parked";
    entry.check.parks.push({ parkedAt: "t", parkedBy: "human", approval: TEST_APPROVAL, reason: TEST_REASON, evidence: null, resumedAt: null });
  }
  const next = text.replace("The receipt names every parked criterion.", "The receipt names each parked criterion.");
  const { plan } = amend(root, state, next);

  assert.deepEqual(plan.unparkedCriteria, ["AC2"]);
  assert.equal(criterion(state, "AC2").check.status, "pending");
  assert.equal(criterion(state, "AC2").check.parks.at(-1).resumedAt, "2026-08-29T12:00:00.000Z");
  assert.equal(criterion(state, "AC3").check.status, "parked", "a park survives an amendment that did not touch its row");
  assert.equal(criterion(state, "AC3").check.parks.at(-1).resumedAt, null);
});

test("an open decision point on an invalidated criterion is closed as amended", () => {
  const { root, state, text } = fixture();
  criterion(state, "AC2").check.decisionPoints.push({
    id: "D1", kind: "same-class", openedAt: "t", attemptId: "A1", message: "stuck", resolvedAt: null, resolution: null,
  });
  const next = text.replace("The receipt names every parked criterion.", "The receipt names each parked criterion.");
  amend(root, state, next);
  const point = criterion(state, "AC2").check.decisionPoints[0];
  assert.equal(point.resolution, "amended");
  assert.equal(point.resolvedAt, "2026-08-29T12:00:00.000Z");
});

// --- refusals with no defined disposition -----------------------------------

test("dropping a criterion is refused, because filed evidence has no defined disposition", () => {
  const { root, state, text } = fixture();
  const next = text.replace("| AC2 | The receipt names every parked criterion. Covers R1. | machine | - |\n", "");
  assert.throws(() => amend(root, state, next), (error) => {
    assert.equal(error.check, "arguments");
    // A refusal that does not say what to do instead is a wall, not a guard.
    assert.match(error.message, /rewrite the criterion so the row changes/);
    assert.match(error.message, /park it with verbatim human approval/);
    return /drops AC2.*not remove them/s.test(error.message);
  });
  assert.equal(state.amendments.length, 0);
});

test("changing the task set is refused and points at resequence", () => {
  const { root, state, text } = fixture();
  const next = prd(BASE_ROWS.map((row) => row.replace("executes each command once", "executes each bound command once")), {
    tasks: ["T1. Do the thing. Covers R1, AC1, AC2, AC3.", "T2. Do another thing. Covers R1."],
  });
  assert.notEqual(next, text);
  assert.throws(() => amend(root, state, next), /changes the task set \(\+T2\).*resequence/s);
});

test("planAmendment reports without writing anything", () => {
  const { state, text } = fixture();
  makeGreen(state, "AC1");
  const contract = parseImplementContract(text.replace("The receipt names every parked criterion.", "The receipt names each parked criterion."));
  const plan = planAmendment(state, contract.acceptanceCriteria);
  assert.deepEqual(plan.invalidatedCriteria, ["AC2"]);
  assert.equal(criterion(state, "AC1").check.status, "green");
  assert.equal(state.amendments.length, 0);
});
