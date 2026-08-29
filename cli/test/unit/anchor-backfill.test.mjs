import assert from "node:assert/strict";
import test from "node:test";
import { parseRegisterRows, questionBlockRange } from "../../dist/interview/qalog.js";
import { runPrelint } from "../../dist/gates/prelint.js";

// This file used to read `agents/interview/implement-bc/qa-log.md` from the
// live repository and shell out to `gate status --slug implement-bc`, which
// made a permanent suite member depend on one sealed run's bookkeeping. That
// is R16 ① seen from the other side: `agents/**` is gitignored and excluded
// from every judged diff, so a test that reads it passes or fails on which
// checkout it runs in and proves nothing a reviewer can see.
//
// What was a one-time historical fact now lives where one-time facts belong -
// the run's own evidence ledger, registered under implement-bc AC44
// (`agents/runs/implement-bc/artifacts/ac44-anchor-backfill-final-run.txt`;
// both original assertions PASS, 2026-08-29). What survives here is the part
// that IS a regression guard: the derivation RULE, exercised against a
// fixture, so it holds for any qa-log rather than for the one document that
// happened to motivate it (PRINCIPLES 11).

const QA_LOG = `---
topic: "fixture"
status: "complete"
where: "brownfield"
created_at: "2026-08-29"
updated_at: "2026-08-29"
question_count: 2
---

## Current Understanding

A fixture interview with two questions and three decisions.

## Decision Register

| ID | Kind | Area | Decision / fact | Priority | Source / owner | Status | PRD mapping / revisit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| D-01 | decision | scope | first decision | P1 | user Q20 verbatim: "그러자" | resolved | R1 |
| D-02 | decision | scope | second decision | P1 | user Q21 verbatim: "다 고고" | resolved | R2 |
| D-03 | decision | scope | third decision | P1 | user Q21 verbatim: "다 고고" | resolved | R3 |

## Raw Q&A

### Q20: an earlier question

- decision_ids: D-01
- route: mixed
- asked: an earlier question
- answered: 그러자

### Q21: the question under test

- decision_ids: D-02, D-03
- route: mixed
- asked: the question under test
- answered: 으 너가 제안한 방향으로 우선 다 고고

## Audit History

None.
`;

/** The rule: a question's decision_ids are exactly the rows whose Source cites it. */
function decisionIdsFor(content, question) {
  const lines = content.split("\n");
  const range = questionBlockRange(lines, question);
  assert.ok(range, `Q${question} entry not found in Raw Q&A`);
  for (let i = range.start + 1; i < range.end; i += 1) {
    const match = lines[i].match(/^-\s*decision_ids:\s*(.*)$/);
    if (match) return match[1].split(",").map((token) => token.trim()).filter(Boolean).sort();
  }
  return null;
}

test("a question's decision_ids are derived from each row's own Source, in both directions", () => {
  const rows = parseRegisterRows(QA_LOG);
  const expected = rows.filter((row) => /\bQ21\b/.test(row.source)).map((row) => row.id).sort();
  assert.deepEqual(expected, ["D-02", "D-03"], "fixture drifted: no rows cite Q21");
  assert.deepEqual(decisionIdsFor(QA_LOG, "21"), expected);

  // The other direction: nothing cited by Q21 may be missing from the block,
  // and nothing in the block may be uncited. A hand-written mapping table
  // passes the first direction and fails this one (interview-anchor D-16).
  for (const id of expected) {
    assert.match(rows.find((row) => row.id === id).source, /\bQ21\b/);
  }
  assert.deepEqual(decisionIdsFor(QA_LOG, "20"), ["D-01"], "a neighbouring question keeps its own rows");
});

const unanchored = (content) => {
  const result = runPrelint("qa-log", content);
  assert.deepEqual(result.findings ?? [], [], "the fixture must clear structural prelint, or the warning pass never runs");
  return (result.warnings ?? [])
    .filter((entry) => entry.rule === "qa-unanchored-user-decision")
    .map((entry) => entry.missing);
};

test("a resolved user decision no Q&A turn cites is warned about, and an anchored one is not", () => {
  assert.deepEqual(unanchored(QA_LOG), [], "every decision here is cited by a decision_ids line");

  // ...and the guard is not vacuous: a row no turn cites must raise it, or
  // the assertion above would pass for a document with no decisions at all.
  const orphaned = QA_LOG.replace(
    "\n## Raw Q&A",
    '| D-04 | decision | scope | a decision nobody asked about | P1 | user verbatim: "ㅇㅇ" | resolved | R4 |\n\n## Raw Q&A',
  );
  assert.deepEqual(
    unanchored(orphaned),
    ["D-04 is a resolved user-sourced decision, but no Raw Q&A turn's decision_ids cites it"],
  );
});
