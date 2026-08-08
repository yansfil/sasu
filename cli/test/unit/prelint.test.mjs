// Deterministic pre-judge lint (PRD gate-prelint-json R2/R3, AC3): every rule
// must fire on its minimal defective fixture and ONLY that rule may fire -
// and the clean fixtures must produce zero findings. This matrix is the
// false-positive-zero guarantee: a drift here either lets broken documents
// reach the judge or blocks healthy ones.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { prelintQaLog, prelintPrd, runPrelint } from "../../dist/gates/prelint.js";

const FIXTURES = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "fixtures", "prelint");

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

test("clean qa-log passes with zero findings (false-positive zero)", () => {
  const result = prelintQaLog(fixture("qa-clean.md"));
  assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
  assert.equal(result.findings.length, 0);
});

test("clean PRD passes with zero findings (false-positive zero)", () => {
  const result = prelintPrd(fixture("prd-clean.md"));
  assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
  assert.equal(result.findings.length, 0);
});

const QA_CASES = [
  ["qa-frontmatter-missing.md", "qa-frontmatter-missing"],
  ["qa-frontmatter-enum.md", "qa-frontmatter-enum"],
  ["qa-section-missing.md", "qa-section-missing"],
  ["qa-register-columns.md", "qa-register-columns"],
  ["qa-register-row.md", "qa-register-row"],
  ["qa-register-open.md", "qa-register-open"],
  ["qa-resolved-material-assumption.md", "qa-resolved-material-assumption"],
  ["qa-dangling-decision-id.md", "qa-dangling-decision-id"],
];

for (const [file, rule] of QA_CASES) {
  test(`qa rule ${rule} fires on its minimal defect and nothing else`, () => {
    const result = prelintQaLog(fixture(file));
    assert.equal(result.ok, false);
    assert.ok(result.findings.length >= 1);
    assert.ok(
      result.findings.every((f) => f.rule === rule),
      `expected only ${rule}, got: ${result.findings.map((f) => f.rule).join(", ")}`,
    );
  });
}

const PRD_CASES = [
  ["prd-frontmatter-missing.md", "prd-frontmatter-missing"],
  ["prd-frontmatter-enum.md", "prd-frontmatter-enum"],
  ["prd-section-missing.md", "prd-section-missing"],
  ["prd-dangling-ref.md", "prd-dangling-ref"],
  ["prd-uncovered-ac.md", "prd-uncovered-ac"],
  ["prd-mode-mismatch.md", "prd-mode-mismatch"],
  ["prd-method-runner-unknown.md", "prd-method-runner-unknown"],
  ["prd-method-parenthetical-scope.md", "prd-method-parenthetical-scope"],
];

for (const [file, rule] of PRD_CASES) {
  test(`prd rule ${rule} fires on its minimal defect and nothing else`, () => {
    const result = prelintPrd(fixture(file));
    assert.equal(result.ok, false);
    assert.ok(result.findings.length >= 1);
    assert.ok(
      result.findings.every((f) => f.rule === rule),
      `expected only ${rule}, got: ${result.findings.map((f) => f.rule).join(", ")}`,
    );
  });
}

test("row-level findings carry 1-indexed line numbers", () => {
  const open = prelintQaLog(fixture("qa-register-open.md"));
  assert.equal(typeof open.findings[0].line, "number");
  const dangling = prelintPrd(fixture("prd-dangling-ref.md"));
  assert.equal(typeof dangling.findings[0].line, "number");
});

test("covers ranges expand: R1-R3 with a deleted member is a dangling reference", () => {
  const prd = fixture("prd-clean.md").replace("Covers R1, AC1, AC2.", "Covers R1-R3, AC1, AC2.");
  const result = prelintPrd(prd);
  assert.equal(result.ok, false);
  const danglingIds = result.findings.filter((f) => f.rule === "prd-dangling-ref").map((f) => f.missing);
  assert.ok(danglingIds.some((m) => m.includes("R2")), "R2 from the range must be flagged");
  assert.ok(danglingIds.some((m) => m.includes("R3")), "R3 from the range must be flagged");
});

test("ID numbering gaps alone are NOT flagged (continuity is an explicit non-goal)", () => {
  const prd = fixture("prd-clean.md")
    .replace("- AC2. the widget persists its state", "- AC7. the widget persists its state")
    .replace("Covers R1, AC1, AC2.", "Covers R1, AC1, AC7.")
    .replace("| V1 | automated behavior | R1, AC1, AC2 |", "| V1 | automated behavior | R1, AC1, AC7 |");
  const result = prelintPrd(prd);
  assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
});

test("runPrelint fails closed on an internal crash instead of throwing (D-11)", () => {
  const result = runPrelint("qa-log", null);
  assert.equal(result.ok, false);
  assert.equal(result.findings[0].rule, "prelint-internal-error");
  assert.match(result.findings[0].missing, /prelint crashed/);
});
