// The six-section contract (prd-template R1, R2): what `implement start`
// reads and what it refuses. Every refusal here is the same line prelint
// would flag, because both read the one grammar in cli/lib/prd_parser.js.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { LEGACY_PRD_LAST_COMMIT, parseImplementContract } from "../../dist/implement/contract.js";

const FIXTURES = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "fixtures", "prelint");
const clean = () => fs.readFileSync(path.join(FIXTURES, "prd-clean.md"), "utf8");
const B1 = "| B1 | the widget renders | check: `node --test test/widget.test.mjs` | - |";

test("a clean six-section PRD parses into rows with their kind, payload and cited decisions", () => {
  const contract = parseImplementContract(clean());
  assert.deepEqual(contract.rows.map((row) => [row.id, row.check.kind]), [["B1", "check"], ["B2", "judge"], ["B3", "human"]]);
  assert.deepEqual(contract.rows[0].check, { kind: "check", command: "node --test test/widget.test.mjs", argv: ["node", "--test", "test/widget.test.mjs"] });
  assert.equal(contract.rows[1].check.evidence, "a before/after screenshot pair registered for B2");
  assert.equal(contract.rows[2].check.confirmation, "the user reloads and says the widget kept their state");
  assert.deepEqual(contract.rows[1].decisionIds, ["D-01"]);
  assert.deepEqual(contract.decisions, [{ id: "D-01", decision: "the widget persists to local storage", rationale: "Q2: the user wants state to survive reload" }]);
  assert.match(contract.goal, /renders and persists/);
  assert.match(contract.nonGoals, /No theming/);
  assert.match(contract.technicalStructure, /storage adapter/);
});

// AC2: the refusal names the format and the last commit that reads it, so
// the holder of an old PRD knows which checkout still runs it.
test("a five-axis PRD is refused as the old format, naming the last commit that read it", () => {
  const legacy = clean().replace("## Behaviors", "## 7. Acceptance Criteria");
  assert.throws(() => parseImplementContract(legacy), (error) => {
    assert.match(error.message, /구 형식/);
    assert.match(error.message, new RegExp(`이 형식을 읽는 마지막 커밋은 \\x60${LEGACY_PRD_LAST_COMMIT}\\x60`));
    return true;
  });
  assert.match(LEGACY_PRD_LAST_COMMIT, /^[0-9a-f]{40}$/);
});

test("a missing section is refused by title", () => {
  assert.throws(() => parseImplementContract(clean().replace("## Risks\n\nNone.\n", "")), /missing section\(s\): ## Risks/);
});

test("row defects are refused with the row's line, the same defects prelint reports", () => {
  const cases = [
    ["| B1 | check: `x` the widget renders | judge: the diff | - |", /line 28 \(B1\): behavior cell carries a check:/],
    ["| B1 | the widget renders | verify by hand | - |", /line 28 \(B1\): check cell must start with one of check:, judge:, human:/],
    ["| B1 | the widget renders | check: `a && b` | - |", /line 28 \(B1\): check: command must be one command/],
    ["| B1 | the widget renders | check: `npm test` | D-09 |", /line 28 \(B1\): cites D-09, which is not in the Decisions table/],
  ];
  for (const [row, pattern] of cases) assert.throws(() => parseImplementContract(clean().replace(B1, row)), pattern);
  assert.throws(() => parseImplementContract(clean().replace(/\| B[123] \|.*\n/g, "")), /has no table rows/);
});

test("a check: command tokenizes the way the runner executes it, quotes included", () => {
  const contract = parseImplementContract(clean().replace(B1, "| B1 | the widget renders | check: `node --test --test-name-pattern \"a && b\" test/widget.test.mjs` | - |"));
  assert.deepEqual(contract.rows[0].check.argv, ["node", "--test", "--test-name-pattern", "a && b", "test/widget.test.mjs"]);
});
