import assert from "node:assert/strict";
import test from "node:test";
import { parseContract } from "../../dist/gates/contract.js";

test("compact contract keeps all requirements and run-wide optional inputs", () => {
  const contract = parseContract(`## Acceptance Criteria\n- AC1. save\n- AC2. reload\n## Checks\n- \`node test.mjs\`\n## Evidence\n- logs/run.txt\n- capture: \`node shot.mjs\` -> out/shot.png\n## Human Review\n- Owner will compare the approved design later.\n`);
  assert.deepEqual(contract.defects, []);
  assert.deepEqual(contract.criteria.map(c => Object.keys(c).sort()), [["id", "line", "text"], ["id", "line", "text"]]);
  assert.deepEqual(contract.checks.map(c => c.command), ["node test.mjs"]);
  assert.deepEqual(contract.evidence.map(c => c.path), ["logs/run.txt"]);
  assert.deepEqual(contract.captures.map(c => [c.command, c.path]), [["node shot.mjs", "out/shot.png"]]);
  assert.equal(contract.humanReview[0].text, "Owner will compare the approved design later.");
});

test("a document-only contract needs no evidence table or per-requirement outcomes", () => {
  const parsed = parseContract("## Acceptance Criteria\n- AC1. explain setup\n");
  assert.deepEqual(parsed.defects, []);
  assert.deepEqual(parsed.evidence, []);
  assert.deepEqual(parsed.humanReview, []);
});

test("retired per-AC method fields fail explicitly with last supported commit", () => {
  for (const field of ["check: `true`", "evidence: file.txt", "capture: `shot` -> shot.png", "human: owner decides", "proof: x"]) {
    const result = parseContract(`## Acceptance Criteria\n- AC1. behavior\n  - ${field}\n`);
    assert.equal(result.defects[0].rule, "contract-retired-method");
    assert.match(result.defects[0].missing, /488d3cc7d6e99742e7f68a1680fcb101710c8e20/);
  }
});

test("invalid evidence paths and capture syntax never become usable inputs", () => {
  for (const path of ["/etc/passwd", "../outside", "a/../../outside", "C:\\secret"]) {
    const parsed = parseContract(`## Evidence\n- ${path}\n`);
    assert.equal(parsed.defects.length, 1);
    assert.deepEqual(parsed.evidence, []);
  }
  assert.equal(parseContract("## Evidence\n- capture: `shot`\n").defects[0].rule, "contract-capture-format");
  assert.equal(parseContract("## Checks\n- node test.mjs\n").defects[0].rule, "contract-check-format");
});
