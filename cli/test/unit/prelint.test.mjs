// Deterministic pre-judge lint (PRD gate-prelint-json R2/R3, AC3): every rule
// must fire on its minimal defective fixture and ONLY that rule may fire -
// and the clean fixtures must produce zero findings. This matrix is the
// false-positive-zero guarantee: a drift here either lets broken documents
// reach the judge or blocks healthy ones.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { prelintQaLog, prelintPrd, prelintContract, runPrelint } from "../../dist/gates/prelint.js";

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
  ["prd-method-cell-mismatch.md", "prd-method-cell-mismatch"],
  ["prd-method-cell-unbalanced.md", "prd-method-cell-mismatch"],
  ["prd-table-span-collision.md", "prd-table-span-collision"],
  ["prd-task-scope-syntax.md", "prd-task-scope-syntax"],
  ["prd-ac-oracle-syntax.md", "prd-ac-oracle-syntax"],
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

// An AC whose bullet declares a machine oracle is its own verification: the
// coverage rule must not demand a V-row mapping on top of it (mirrors the lib
// planner's acceptance-uncovered exemption).
test("prd rule prd-uncovered-ac does not fire for an oracle-backed AC", () => {
  const result = prelintPrd(fixture("prd-oracle-covered-ac.md"));
  assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
});

// --- oracle advisories: non-blocking warnings, never counted toward ok ---

test("a Check command with shell operators draws the operators-not-interpreted warning without blocking", () => {
  const prd = fixture("prd-oracle-covered-ac.md").replace(
    "- AC3. the marker exists. Artifact: out/marker.txt",
    "- AC3. the marker greps. Check: `test -f README.md && grep -c Test README.md` -> 1",
  );
  const result = prelintPrd(prd);
  assert.equal(result.ok, true, "advisories must never block");
  assert.equal(result.findings.length, 0);
  assert.deepEqual(result.warnings.map((w) => w.rule), ["prd-ac-oracle-shell-operators"]);
  assert.match(result.warnings[0].missing, /not interpreted/);
  assert.match(result.warnings[0].recommendation, /bash -c/);
});

// Reproduced false positive #1 (2026-08-11): the rule's own recommendation is
// `bash -c "..."`, yet that exact shape still warned. A declared shell wrapper
// provides the shell semantics the warning exists to flag as absent.
test("the recommended bash -c wrapper shape is exempt from the shell-operators warning", () => {
  const prd = fixture("prd-oracle-covered-ac.md").replace(
    "- AC3. the marker exists. Artifact: out/marker.txt",
    '- AC3. the marker greps. Check: `bash -c "test -f README.md && grep -c Test README.md"` -> 1',
  );
  const result = prelintPrd(prd);
  assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
  assert.equal(result.findings.length, 0);
  assert.equal(result.warnings, undefined, JSON.stringify(result.warnings));
});

// Reproduced false positive #2 (2026-08-11): a metacharacter inside a quoted
// argument is a literal token to both executors (shellLikeTokens + shell:false),
// so nothing is silently reinterpreted and the warning was pure noise.
test("a quoted metacharacter argument is exempt from the shell-operators warning", () => {
  const prd = fixture("prd-oracle-covered-ac.md").replace(
    "- AC3. the marker exists. Artifact: out/marker.txt",
    '- AC3. the grep filter runs. Check: `npm test -- --grep "a|b"`',
  );
  const result = prelintPrd(prd);
  assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
  assert.equal(result.findings.length, 0);
  assert.equal(result.warnings, undefined, JSON.stringify(result.warnings));
});

test("a trivially-constant Check command draws the constant-true warning without blocking", () => {
  for (const command of ["true", ":", "exit 0", "echo done"]) {
    const prd = fixture("prd-oracle-covered-ac.md").replace(
      "- AC3. the marker exists. Artifact: out/marker.txt",
      `- AC3. the stub passes. Check: \`${command}\``,
    );
    const result = prelintPrd(prd);
    assert.equal(result.ok, true, `\`${command}\` must warn, not block`);
    assert.deepEqual(
      result.warnings.map((w) => w.rule),
      ["prd-ac-oracle-constant-true"],
      `\`${command}\`: ${JSON.stringify(result.warnings)}`,
    );
    assert.match(result.warnings[0].missing, /proves nothing/);
  }
});

// --- Method-cell round trip: pipes in code spans, mismatch guard, node --test advisory ---

// The exact live repro: the naive pipe split used to truncate this command at
// `||`, and the truncated form was still valid shell.
const LIVE_METHOD_COMMAND = 'bash -c "for f in $(git diff --name-only); do node --check \\"$f\\" || exit 1; done"';

function withMethod(method) {
  return fixture("prd-method-runner-unknown.md").replace("`checkshirt gate spec --slug fixture`", method);
}

test("a Method command with pipes inside its code span parses whole and passes clean", () => {
  const result = prelintPrd(withMethod(`\`${LIVE_METHOD_COMMAND}\``));
  assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
  assert.equal(result.findings.length, 0);
  assert.equal(result.warnings, undefined, JSON.stringify(result.warnings));
});

test("an escaped \\| inside a Method code span round-trips to a literal pipe", () => {
  const result = prelintPrd(withMethod('`bash -c "grep -c \\"a\\|b\\" README.md"`'));
  assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
});

test("prd-method-cell-mismatch quotes both the declared and the parsed form", () => {
  const result = prelintPrd(fixture("prd-method-cell-mismatch.md"));
  assert.equal(result.ok, false);
  assert.equal(result.findings[0].rule, "prd-method-cell-mismatch");
  assert.match(result.findings[0].missing, /declares `npm test` \+ `x`/);
  assert.match(result.findings[0].missing, /would read `npm test``x`/);
});

test("an unbalanced backtick in a Method cell blocks with the same rule family", () => {
  const result = prelintPrd(fixture("prd-method-cell-unbalanced.md"));
  assert.equal(result.ok, false);
  assert.equal(result.findings[0].rule, "prd-method-cell-mismatch");
  assert.match(result.findings[0].missing, /unbalanced backtick/);
});

test("node --test on a directory-shaped path draws the glob-form warning without blocking", () => {
  const result = prelintPrd(withMethod("`node --test cli/test/unit`"));
  assert.equal(result.ok, true, "advisories must never block");
  assert.equal(result.findings.length, 0);
  assert.deepEqual(result.warnings.map((w) => w.rule), ["prd-node-test-directory"]);
  assert.match(result.warnings[0].missing, /directory-shaped/);
  assert.match(result.warnings[0].recommendation, /cli\/test\/unit\/\*\.test\.mjs/);
});

test("node --test with a glob or an explicit file draws no warning", () => {
  for (const method of [
    '`node --test "cli/test/unit/*.test.mjs"`',
    "`node --test cli/test/unit/quick.test.mjs`",
    "`node --test-reporter=spec --test cli/test/unit/quick.test.mjs`",
  ]) {
    const result = prelintPrd(withMethod(method));
    assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
    assert.equal(result.warnings, undefined, `${method}: ${JSON.stringify(result.warnings)}`);
  }
});

test("space-separated flag values are not mistaken for directory targets", () => {
  for (const method of [
    '`node --test --test-reporter spec "cli/test/unit/*.test.mjs"`',
    '`node --test --test-concurrency 4 "cli/test/unit/*.test.mjs"`',
  ]) {
    const result = prelintPrd(withMethod(method));
    assert.equal(result.warnings, undefined, `${method}: ${JSON.stringify(result.warnings)}`);
  }
  // The real target after a skipped flag value, and after `--`, still warns.
  for (const method of [
    "`node --test --test-reporter spec cli/test/unit`",
    "`node --test -- cli/test/unit`",
  ]) {
    const result = prelintPrd(withMethod(method));
    assert.deepEqual(result.warnings?.map((w) => w.rule), ["prd-node-test-directory"], method);
  }
});

test("cross-cell backtick pairing blocks; an extra unescaped pipe only advises", () => {
  // Blocking direction is the fixture matrix row (prd-table-span-collision.md);
  // here: the advisory direction and the message content.
  const collision = prelintPrd(fixture("prd-table-span-collision.md"));
  assert.equal(collision.ok, false);
  assert.match(collision.findings[0].missing, /parses to 6 cell\(s\) but its rendered form shows 7/);
  const extraPipe = prelintPrd(
    fixture("prd-method-cell-mismatch.md").replace(
      "| V1 | automated behavior | R1, AC1, AC2 | `npm test`**`x` | command-log | yes | no |",
      "| V1 | automated behavior | R1, AC1, AC2 | `npm test` | command-log | yes a|b | no |",
    ),
  );
  assert.equal(extraPipe.ok, true, "extra-cell direction must not block");
  assert.deepEqual(extraPipe.warnings?.map((w) => w.rule), ["prd-table-row-shape"]);
});

test("a Check oracle pointing node --test at a directory draws the same warning", () => {
  const prd = fixture("prd-oracle-covered-ac.md").replace(
    "- AC3. the marker exists. Artifact: out/marker.txt",
    "- AC3. the tests pass. Check: `node --test cli/test/unit`",
  );
  const result = prelintPrd(prd);
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings.map((w) => w.rule), ["prd-node-test-directory"]);
});

test("a substantive Check command and an Artifact oracle draw no advisory", () => {
  const artifactOnly = prelintPrd(fixture("prd-oracle-covered-ac.md"));
  assert.equal(artifactOnly.warnings, undefined);
  const check = fixture("prd-oracle-covered-ac.md").replace(
    "- AC3. the marker exists. Artifact: out/marker.txt",
    '- AC3. the marker prints. Check: `node -e "console.log(1)"` -> 1',
  );
  const result = prelintPrd(check);
  assert.equal(result.ok, true);
  assert.equal(result.warnings, undefined, JSON.stringify(result.warnings));
});
