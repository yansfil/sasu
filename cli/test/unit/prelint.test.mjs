// Deterministic pre-judge lint (PRD gate-prelint-json R2/R3, AC3): every rule
// must fire on its minimal defective fixture and ONLY that rule may fire -
// and the clean fixtures must produce zero findings. This matrix is the
// false-positive-zero guarantee: a drift here either lets broken documents
// reach the judge or blocks healthy ones.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { prelintQaLog, prelintPrd, prelintPrdDecisionIds, prelintContract, runPrelint } from "../../dist/gates/prelint.js";

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
  ["prd-uncovered-scenario.md", "prd-uncovered-scenario"],
  ["prd-mode-mismatch.md", "prd-mode-mismatch"],
  ["prd-method-runner-unknown.md", "prd-implementation-binding"],
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

test("a PRD with a covered SC scenario card passes with zero findings", () => {
  const result = prelintPrd(fixture("prd-scenario-clean.md"));
  assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
  assert.equal(result.findings.length, 0);
});

test("a Covers reference to an undefined SC card is a dangling reference", () => {
  const prd = fixture("prd-scenario-clean.md").replace("R1, AC1, AC2, SC1", "R1, AC1, AC2, SC1, SC9");
  const result = prelintPrd(prd);
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((f) => f.rule === "prd-dangling-ref" && f.missing.includes("SC9")));
});

test("ID numbering gaps alone are NOT flagged (continuity is an explicit non-goal)", () => {
  const prd = fixture("prd-clean.md")
    .replace("- AC2. the widget persists its state", "- AC7. the widget persists its state")
    .replace("Covers R1, AC1, AC2.", "Covers R1, AC1, AC7.")
    .replace("| V1 | automated behavior | R1, AC1, AC2 |", "| V1 | automated behavior | R1, AC1, AC7 |");
  const result = prelintPrd(prd);
  assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
});

// --- quick-contract matrix: same single-rule guarantee as the PRD cases ---

const CLEAN_CONTRACT = `---
topic: fix-widget
status: active
---

## Goal

Fix the widget.

## Acceptance Criteria

- AC1. the widget renders
- AC2. the widget persists its state
`;

test("clean contract passes with zero findings (false-positive zero)", () => {
  const result = prelintContract(CLEAN_CONTRACT);
  assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
  assert.equal(result.findings.length, 0);
  assert.equal(result.doc, "contract");
});

const CONTRACT_CASES = [
  ["missing frontmatter", CLEAN_CONTRACT.replace(/^---\n[\s\S]*?\n---\n/, ""), "contract-frontmatter-missing"],
  ["missing topic", CLEAN_CONTRACT.replace("topic: fix-widget\n", ""), "contract-frontmatter-topic"],
  ["invalid status", CLEAN_CONTRACT.replace("status: active", "status: wip"), "contract-frontmatter-enum"],
  ["missing status", CLEAN_CONTRACT.replace("status: active\n", ""), "contract-frontmatter-enum"],
  ["missing AC section", CLEAN_CONTRACT.replace("## Acceptance Criteria", "## Criteria"), "contract-ac-section-missing"],
  ["no AC items", CLEAN_CONTRACT.replace(/- AC\d\..*\n/g, ""), "contract-ac-empty"],
  ["duplicate AC id", CLEAN_CONTRACT.replace("- AC2.", "- AC1."), "contract-ac-duplicate"],
];

for (const [label, content, rule] of CONTRACT_CASES) {
  test(`contract prelint flags ${label} with only ${rule}`, () => {
    const result = prelintContract(content);
    assert.equal(result.ok, false);
    assert.deepEqual([...new Set(result.findings.map((f) => f.rule))], [rule], JSON.stringify(result.findings, null, 2));
  });
}

test("runPrelint routes the contract doc kind", () => {
  assert.equal(runPrelint("contract", CLEAN_CONTRACT).ok, true);
  assert.equal(runPrelint("contract", "no structure at all").ok, false);
});

test("runPrelint fails closed on an internal crash instead of throwing (D-11)", () => {
  const result = runPrelint("qa-log", null);
  assert.equal(result.ok, false);
  assert.equal(result.findings[0].rule, "prelint-internal-error");
  assert.match(result.findings[0].missing, /prelint crashed/);
});

test("PRD implementation bindings are rejected at every semantic surface", () => {
  const cleanPrd = fixture("prd-clean.md");
  const taskScope = prelintPrd(cleanPrd.replace("- T1.", "- T1. Scope: src/**."));
  assert.equal(taskScope.ok, false);
  assert.ok(taskScope.findings.some((entry) => entry.rule === "prd-implementation-binding" && /file Scope/.test(entry.missing)));

  const acCheck = prelintPrd(cleanPrd.replace("- AC1.", "- AC1. Check: `npm test`."));
  assert.equal(acCheck.ok, false);
  assert.ok(acCheck.findings.some((entry) => entry.rule === "prd-implementation-binding" && /executable Check/.test(entry.missing)));

  const methodMatrix = prelintPrd(fixture("prd-method-runner-unknown.md"));
  assert.equal(methodMatrix.ok, false);
  assert.ok(methodMatrix.findings.some((entry) => entry.rule === "prd-implementation-binding" && /column "Method"/.test(entry.missing)));
});

test("an AC with a Check tail still requires V coverage", () => {
  const result = prelintPrd(fixture("prd-oracle-covered-ac.md"));
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((entry) => entry.rule === "prd-uncovered-ac"));
  assert.ok(result.findings.some((entry) => entry.rule === "prd-implementation-binding"));
});

// Citation ADVISORIES (red-team 2026-08-20): the blocking versions
// false-positived on 8 real judge-passed documents (answer-count vs
// heading-count numbering divergence; pre-interview consent), so these warn
// without blocking - ok stays true, the rule lands in warnings only.
test("qa-dangling-q-reference warns without blocking", () => {
  const result = prelintQaLog(fixture("qa-dangling-q-reference.md"));
  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.warnings.map((w) => w.rule), ["qa-dangling-q-reference"]);
});

test("qa-unanchored-user-decision warns without blocking", () => {
  const result = prelintQaLog(fixture("qa-unanchored-user-decision.md"));
  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.warnings.map((w) => w.rule), ["qa-unanchored-user-decision"]);
});

test("clean qa-log carries zero citation warnings", () => {
  const result = prelintQaLog(fixture("qa-clean.md"));
  assert.deepEqual(result.warnings, []);
});

// Cross-document spec-gate rule: a PRD citing a D-id absent from the
// interview register is the judge's dominant P0 class ("invented D-40") and
// blocks at $0. Calibrated 2026-08-20: zero missing D-ids across all 30 real
// PRD+qa-log pairs on this machine.
test("prd-dangling-decision-id blocks a PRD citing an unregistered decision", () => {
  const qaLog = fixture("qa-clean.md"); // register holds D-01, D-02
  const result = prelintPrdDecisionIds("The user approved PR delivery (D-40) and D-01 covers the rest.", qaLog);
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings.map((f) => f.rule), ["prd-dangling-decision-id"]);
  assert.match(result.findings[0].missing, /D-40/);
});

test("prd-dangling-decision-id passes when every cited D-id is registered", () => {
  const qaLog = fixture("qa-clean.md");
  const result = prelintPrdDecisionIds("Decisions D-01 and D-02 trace to the interview.", qaLog);
  assert.equal(result.ok, true);
});
