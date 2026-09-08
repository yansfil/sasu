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

test("qa question limits reject invalid values and warn on the first over-budget heading", () => {
  const clean = fixture("qa-clean.md");
  const invalid = prelintQaLog(clean.replace('where: "greenfield"', 'where: "greenfield"\nquestion_limit: 0'));
  assert.deepEqual(invalid.findings.map((finding) => finding.rule), ["qa-question-limit-invalid"]);
  const exceeded = prelintQaLog(clean.replace('where: "greenfield"', 'where: "greenfield"\nquestion_limit: 1'));
  assert.equal(exceeded.ok, true);
  assert.deepEqual(exceeded.findings, []);
  assert.deepEqual(exceeded.warnings.map((finding) => finding.rule), ["qa-question-limit-exceeded"]);
  assert.match(exceeded.warnings[0].missing, /Q2/);
});

test("clean PRD passes with zero findings (false-positive zero)", () => {
  const result = prelintPrd(fixture("prd-clean.md"));
  assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
  assert.equal(result.findings.length, 0);
});

test("quoted frontmatter values keep working when followed by an inline YAML comment", () => {
  const commented = fixture("prd-clean.md").replace('human_approval: "approved"', 'human_approval: "approved" # verbatim approval recorded elsewhere');
  const result = prelintPrd(commented);
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
  ["prd-behavior-row.md", "prd-behavior-row"],
];

// The eight rules the six-section template retired (prd-template R11, AC13).
// A rule id that comes back here is a five-axis concept leaking in.
const RETIRED_PRD_RULES = [
  "prd-dangling-ref",
  "prd-uncovered-ac",
  "prd-uncovered-scenario",
  "prd-mode-mismatch",
  "prd-ac-table-required",
  "prd-ac-judgment-missing",
  "prd-ac-evidence-missing",
  "prd-implementation-binding",
];

test("the retired five-axis rules are gone from prelint", () => {
  const source = fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "src", "gates", "prelint.ts"), "utf8");
  for (const rule of RETIRED_PRD_RULES) assert.ok(!source.includes(`"${rule}"`), `${rule} is still spelled in prelint.ts`);
  const legacy = prelintPrd(fixture("prd-clean.md").replace("## Behaviors", "## 7. Acceptance Criteria"));
  assert.ok(legacy.findings.every((finding) => !RETIRED_PRD_RULES.includes(finding.rule)));
});

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
  const row = prelintPrd(fixture("prd-behavior-row.md"));
  assert.equal(row.findings[0].line, 28);
});

// prd-section-missing keys on the six template titles and nothing else
// (R11): one absent section names exactly that title; the retired numbered
// headings are not what it looks for.
test("prd-section-missing names the one absent six-section title", () => {
  const result = prelintPrd(fixture("prd-section-missing.md"));
  assert.deepEqual(result.findings.map((f) => f.rule), ["prd-section-missing"]);
  assert.match(result.findings[0].missing, /^missing section\(s\): ## Non-goals$/);
  const renamed = prelintPrd(fixture("prd-clean.md").replace("## Technical structure", "## 5. Technical structure"));
  assert.match(renamed.findings.find((f) => f.rule === "prd-section-missing").missing, /## Technical structure$/);
});

// The shared reader owns cell grammar; prelint leaves behavior meaning to review.
test("prd-behavior-row reports structural defects without judging proof methods", () => {
  const clean = fixture("prd-clean.md");
  const b1 = "| B1 | the widget renders | - |";
  for (const [row, pattern] of [
    ["| B1 | the widget renders | check: run | - |", /retired four-column/],
    ["| AC1 | the widget renders | - |", /row id must be B<n>/],
    ["| B1 | | - |", /behavior cell is empty/],
    ["| B1 | the widget renders |", /3 columns/],
    ["| B2 | the widget renders | - |", /duplicate row id B2/],
  ]) {
    const result = prelintPrd(clean.replace(b1, row));
    assert.equal(result.ok, false);
    assert.ok(result.findings.some(f => pattern.test(f.missing)), JSON.stringify(result.findings));
  }
  const prose = prelintPrd(clean.replace("the widget renders", "the literal check: prefix is rendered"));
  assert.equal(prose.ok, true, "behavior prose is not interpreted as a proof method");
});

test("behavior decision references must resolve in the PRD Decisions table", () => {
  const prd = fixture("prd-clean.md").replace("| B1 | the widget renders | - |", "| B1 | the widget renders | D-99 |");
  const result = prelintPrd(prd);
  assert.equal(result.ok, false);
  assert.ok(result.findings.some(f => f.rule === "prd-decision-reference" && /B1: cites D-99/.test(f.missing)));
});

test("ID numbering gaps alone are NOT flagged (continuity is an explicit non-goal)", () => {
  const prd = fixture("prd-clean.md").replace("| B3 |", "| B7 |");
  const result = prelintPrd(prd);
  assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
});

test("a backtick crossing a cell boundary is a span collision", () => {
  const result = prelintPrd(fixture("prd-table-span-collision.md"));
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((f) => f.rule === "prd-table-span-collision" && f.line === 28));
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

test("a user invocation decision is anchored by a transcript start boundary", () => {
  const content = fixture("qa-unanchored-user-decision.md")
    .replace("| D-01 | decision | ux | widget renders a list | P1 | user | resolved | R1 |", "| D-01 | decision | ux | widget renders a list | P1 | user invocation: codex:session-1:msg-start | resolved | R1 |")
    .replace(
      "## Decision Register",
      "## Transcript Sources\n\n| Runtime | Session ID | Start ref |\n| --- | --- | --- |\n| codex | session-1 | msg-start |\n\n## Decision Register",
    );
  const result = prelintQaLog(content);
  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.warnings, []);

  const mismatched = prelintQaLog(content.replace("msg-start | resolved", "msg-other | resolved"));
  assert.deepEqual(mismatched.warnings.map((w) => w.rule), ["qa-unanchored-user-decision"]);
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

// Freshness contract v4: a post-seal decision lives as an Addendum bullet,
// not a Register row. A PRD citing it cites a real decision; a D-id merely
// mentioned in prose outside the Addendum still dangles.
test("prd-dangling-decision-id accepts a decision defined in the qa-log Addendum", () => {
  const qaLog = `${fixture("qa-clean.md")}\n## Addendum\n\n- D-51 (decision, scope, P1, resolved, 2026-08-30): late scope decision\n  - source: user\n`;
  assert.equal(prelintPrdDecisionIds("D-51 sets the late scope.", qaLog).ok, true);
  const prose = `${fixture("qa-clean.md")}\nWe once discussed D-51 in passing.\n`;
  assert.equal(prelintPrdDecisionIds("D-51 sets the late scope.", prose).ok, false);
});
