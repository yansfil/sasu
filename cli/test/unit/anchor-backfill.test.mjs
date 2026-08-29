import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseRegisterRows, questionBlockRange } from "../../dist/interview/qalog.js";
import { runPrelint } from "../../dist/gates/prelint.js";

// PRD interview-anchor R5/AC9: the implement-bc backfill is derived only from
// each register row's own Source field ("user Q21 verbatim: ..."), never from
// a hand-written mapping table (D-16). This test re-derives the expected
// twelve-row set from Source at run time and checks it against what actually
// landed in Q21's decision_ids, so a future edit to either side cannot drift
// silently.
const QA_LOG = path.join(import.meta.dirname, "..", "..", "..", "agents", "interview", "implement-bc", "qa-log.md");

test("AC9: implement-bc Q21 decision_ids contains exactly the D#s whose Source cites Q21, both directions", () => {
  const content = fs.readFileSync(QA_LOG, "utf8");
  const rows = parseRegisterRows(content);
  const expected = rows
    .filter((row) => /\bQ21\b/.test(row.source))
    .map((row) => row.id)
    .sort();
  assert.ok(expected.length > 0, "no register row cites Q21 in Source - fixture drifted");

  const lines = content.split("\n");
  const range = questionBlockRange(lines, "21");
  assert.ok(range, "Q21 entry not found in Raw Q&A");
  let decisionIds = null;
  for (let i = range.start + 1; i < range.end; i += 1) {
    const match = lines[i].match(/^-\s*decision_ids:\s*(.*)$/);
    if (match) { decisionIds = match[1].trim(); break; }
  }
  assert.ok(decisionIds, "Q21 entry has no decision_ids line");
  const actual = decisionIds.split(",").map((token) => token.trim()).filter(Boolean).sort();

  assert.deepEqual(actual, expected);
  for (const id of expected) {
    const row = rows.find((candidate) => candidate.id === id);
    assert.match(row.source, /\bQ21\b/, `${id} Source must cite Q21 (derivation direction)`);
  }
});

// PRD interview-anchor R5/AC10. Read-only: this shells out to `gate status`,
// never `gate gap-audit`/`gate spec` - implement-bc's review cycle is
// exhausted and its PASS was restored by a user override, so re-running
// either gate would invalidate that recovery. "PASS" here is deliberately
// read as the gate's `effective` verdict, which is PASS on an overridden gate
// too - a wider reading than the PRD's literal "게이트가 PASS" text, accepted
// by the user for exactly this case (recorded as a deviation in the
// implementation report, not decided here).
test("AC10: implement-bc qa-log has zero unanchored-user-decision warnings and both gates read effective PASS, not stale", () => {
  const content = fs.readFileSync(QA_LOG, "utf8");
  const result = runPrelint("qa-log", content);
  const unanchored = (result.warnings ?? []).filter((warning) => warning.rule === "qa-unanchored-user-decision");
  assert.deepEqual(unanchored, []);

  const projectRoot = path.join(import.meta.dirname, "..", "..", "..");
  const cliEntry = path.join(projectRoot, "cli", "dist", "cli.js");
  const raw = execFileSync(process.execPath, [cliEntry, "gate", "status", "--slug", "implement-bc", "--json"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  const status = JSON.parse(raw);
  for (const gate of ["gap-audit", "spec"]) {
    assert.equal(status[gate].effective, "PASS", `${gate} must read effective PASS`);
    assert.equal(status[gate].stale, false, `${gate} must not be stale`);
  }
});
