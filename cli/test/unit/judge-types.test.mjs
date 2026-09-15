import assert from "node:assert/strict";
import test from "node:test";
import { extractJsonObject, validateGapVerdict } from "../../dist/judge/types.js";

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
