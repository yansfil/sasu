import assert from "node:assert/strict";
import test from "node:test";
import { extractAcceptanceCriteria } from "../../dist/gates/commands.js";

const PRD = `# PRD: x

## 6. Requirements

- R1. something

## 7. Acceptance Criteria

- AC1. builds cleanly
- AC2. judge retries once
  and then errors with a typed code
- AC10. doctor prints three sections

## 8. PRD-Level Tasks

- T1. scaffold
`;

test("extractAcceptanceCriteria reads AC ids and joins continuation lines", () => {
  const criteria = extractAcceptanceCriteria(PRD);
  assert.deepEqual(criteria.map((c) => c.id), ["AC1", "AC2", "AC10"]);
  assert.match(criteria[1].text, /typed code/);
});

test("extractAcceptanceCriteria returns empty for a PRD without the section", () => {
  assert.deepEqual(extractAcceptanceCriteria("# nothing here"), []);
});
