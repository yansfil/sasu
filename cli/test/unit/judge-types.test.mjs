import assert from "node:assert/strict";
import test from "node:test";
import { extractJsonObject, validateGapVerdict, validateReviewResult } from "../../dist/judge/types.js";

test("extractJsonObject parses direct JSON", () => {
  assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
});

test("extractJsonObject parses fenced JSON (haiku fence habit)", () => {
  assert.deepEqual(extractJsonObject('```json\n{"verdict":"PASS","findings":[]}\n```'), {
    verdict: "PASS",
    findings: [],
  });
});

test("extractJsonObject parses JSON embedded in prose", () => {
  assert.deepEqual(extractJsonObject('Here is my verdict:\n{"a":{"b":2}}\nThanks!'), { a: { b: 2 } });
});

test("extractJsonObject returns null when no JSON exists", () => {
  assert.equal(extractJsonObject("no json here"), null);
});

test("validateGapVerdict accepts a PASS with empty findings", () => {
  assert.deepEqual(validateGapVerdict({ verdict: "PASS", findings: [] }), { verdict: "PASS", findings: [] });
});

test("validateGapVerdict rejects BLOCK without findings", () => {
  assert.equal(typeof validateGapVerdict({ verdict: "BLOCK", findings: [] }), "string");
});

test("validateGapVerdict rejects PASS carrying P0 findings", () => {
  const result = validateGapVerdict({
    verdict: "PASS",
    findings: [{ area: "data", severity: "P0", missing: "x", recommendation: "", requiresHuman: false }],
  });
  assert.equal(typeof result, "string");
});

test("validateGapVerdict rejects a missing or non-boolean requiresHuman field", () => {
  for (const requiresHuman of [undefined, "false", 0]) {
    const finding = { area: "data", severity: "P1", missing: "retention undecided", recommendation: "ask" };
    if (requiresHuman !== undefined) finding.requiresHuman = requiresHuman;
    const result = validateGapVerdict({ verdict: "BLOCK", findings: [finding] });
    assert.match(String(result), /requiresHuman must be a boolean/);
  }
});

test("validateGapVerdict rejects numeric-score-shaped output", () => {
  assert.equal(typeof validateGapVerdict({ verdict: 0.19, findings: [] }), "string");
});

const context = { requirementRefs: ["B1", "D-01"], evidenceRefs: ["B1", "src/app.ts"], priorFindingIds: [] };
const result = (findings = [], priorDispositions = []) => ({ summary: "Assessed full contract", findings, priorDispositions });
const defect = { kind: "defect", requirementRefs: ["B1"], problem: "Save button has no event handler", evidenceRefs: ["src/app.ts"], nextAction: "Connect save button" };

test("full-contract review uses exception findings without per-requirement PASS records", () => {
  assert.deepEqual(validateReviewResult(result(), context), result());
  assert.deepEqual(validateReviewResult(result([defect]), context), result([defect]));
  assert.equal(typeof validateReviewResult({ verdict: "PASS", criteria: [] }, context), "string");
});

test("unknown references and evidence-free defects fail closed", () => {
  for (const bad of [{ ...defect, requirementRefs: ["B2"] }, { ...defect, evidenceRefs: ["secret"] }, { ...defect, evidenceRefs: [] }]) assert.equal(typeof validateReviewResult(result([bad]), context), "string");
  assert.equal(typeof validateReviewResult(result([{ ...defect, evidenceRefs: ["B1"] }]), context), "object", "absent evidence can cite the contract");
});

test("prior open issues require explicit non-contradictory dispositions", () => {
  const previous = { ...context, priorFindingIds: ["F1"] };
  assert.match(validateReviewResult(result(), previous), /missing.*F1/);
  const resolved = { findingId: "F1", status: "resolved", reason: "Button now invokes save", evidenceRefs: ["src/app.ts"] };
  assert.equal(typeof validateReviewResult(result([], [resolved]), previous), "object");
  assert.match(validateReviewResult(result([{ ...defect, priorFindingId: "F1" }], [resolved]), previous), /still returned as open/);
});

test("human confirmation needs source authority and exact quotation", () => {
  const human = { ...defect, kind: "human-confirmation", human: { sourceRef: "Risks", quote: "Owner checks visual fit later", timing: "post-completion" } };
  const inputs = { ...context, humanSources: { Risks: "Owner checks visual fit later." } };
  assert.equal(typeof validateReviewResult(result([human]), inputs), "object");
  assert.equal(typeof validateReviewResult(result([{ ...human, human: { ...human.human, quote: "approved" } }]), inputs), "string");
  assert.equal(typeof validateReviewResult(result([{ ...human, human: { ...human.human, sourceRef: "toString" } }]), inputs), "string");
  assert.equal(typeof validateReviewResult(result([{ ...defect, human: human.human }]), inputs), "string");
});
