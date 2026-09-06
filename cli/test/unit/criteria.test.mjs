import assert from "node:assert/strict";
import test from "node:test";
import { extractAcceptanceCriteria } from "../../dist/gates/commands.js";

const PRD = `# PRD: x

## Goal

g

## Behaviors

| # | 사용자가 관찰하는 행동 | 검사 방법 | 결정 |
| --- | --- | --- | --- |
| B1 | builds cleanly | check: \`npm run build\` | - |
| B2 | judge retries once and then errors with a typed code | judge: the retry log | - |
| B10 | doctor prints three sections | human: the user sees three sections | - |

## Risks

none
`;

test("extractAcceptanceCriteria reads every Behaviors row as a criterion", () => {
  const criteria = extractAcceptanceCriteria(PRD);
  assert.deepEqual(criteria.map((c) => c.id), ["B1", "B2", "B10"]);
  assert.match(criteria[1].text, /typed code/);
});

test("extractAcceptanceCriteria returns empty for a PRD without the section", () => {
  assert.deepEqual(extractAcceptanceCriteria("# nothing here"), []);
});
