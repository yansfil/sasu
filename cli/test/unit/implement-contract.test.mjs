// Task dependency grammar: `Depends on:` is an executable declaration — the
// close guard in `sasu implement task` enforces exactly what parses here, so
// every default, override, and rejection is pinned.
import assert from "node:assert/strict";
import test from "node:test";
import { parseImplementContract } from "../../dist/implement/contract.js";

function prd(taskLines) {
  return `---
topic: "contract fixture"
status: "ready"
---

# PRD: contract fixture

## 6. Requirements

- R1. The flow completes. Covers AC1.

## 7. Acceptance Criteria

- AC1. The flow is verifiable.

## 8. PRD-Level Tasks

${taskLines.join("\n")}

## 9. Verification Contract

| ID | Mode | Covers | Pass Intent | Required For Done | Can Be Blocked |
| --- | --- | --- | --- | --- | --- |
| V1 | automated behavior | R1, AC1 | flow passes | yes | no |
`;
}

test("tasks without a Depends on clause chain to the previous task", () => {
  const contract = parseImplementContract(prd([
    "- T1. First. Covers R1.",
    "- T2. Second. Covers R1.",
    "- T3. Third. Covers R1.",
  ]));
  assert.deepEqual(contract.tasks.map((task) => task.dependsOn), [[], ["T1"], ["T2"]]);
});

test("an explicit Depends on list overrides the chain and none clears it", () => {
  const contract = parseImplementContract(prd([
    "- T1. Base. Covers R1.",
    "- T2. Adapter A. Covers R1. Depends on: T1.",
    "- T3. Adapter B. Covers R1. Depends on: T1.",
    "- T4. Standalone doc. Covers R1. Depends on: none.",
    "- T5. Integration. Covers R1. Depends on: T2, T3.",
  ]));
  assert.deepEqual(contract.tasks.map((task) => task.dependsOn), [[], ["T1"], ["T1"], [], ["T2", "T3"]]);
});

test("a dependency on an unknown task is rejected at parse time", () => {
  assert.throws(
    () => parseImplementContract(prd(["- T1. Only. Covers R1. Depends on: T9."])),
    /T1 depends on unknown task T9/,
  );
});

test("a self-dependency is rejected at parse time", () => {
  assert.throws(
    () => parseImplementContract(prd(["- T1. Only. Covers R1. Depends on: T1."])),
    /T1 cannot depend on itself/,
  );
});

test("a dependency cycle is rejected at parse time", () => {
  assert.throws(
    () => parseImplementContract(prd([
      "- T1. A. Covers R1. Depends on: T2.",
      "- T2. B. Covers R1. Depends on: T1.",
    ])),
    /task dependency cycle: T1 -> T2 -> T1/,
  );
});

test("duplicate task ids are rejected at parse time", () => {
  assert.throws(
    () => parseImplementContract(prd([
      "- T1. A. Covers R1.",
      "- T1. A again. Covers R1.",
    ])),
    /duplicate task id: T1/,
  );
});

// A duplicate AC id that got past parsing let `implement start` persist a
// state every later load rejected - a bricked run with no CLI recovery
// (2026-08-30 code review). The parse-time refusal covers start and amend
// alike, mirroring the task-id guard above.
test("duplicate acceptance criterion ids are rejected at parse time", () => {
  const doc = prd(["- T1. A. Covers R1."]).replace(
    "- AC1. The flow is verifiable.",
    "- AC1. The flow is verifiable.\n- AC1. The flow is verifiable twice.",
  );
  assert.throws(() => parseImplementContract(doc), /duplicate acceptance criterion id: AC1/);
});
