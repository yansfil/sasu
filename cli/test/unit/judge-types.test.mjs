import assert from "node:assert/strict";
import test from "node:test";
import { extractJsonObject, validateGapVerdict, validateSemanticVerdict } from "../../dist/judge/types.js";

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

test("validateGapVerdict rejects numeric-score-shaped output", () => {
  assert.equal(typeof validateGapVerdict({ verdict: 0.19, findings: [] }), "string");
});

test("validateSemanticVerdict requires every expected criterion id", () => {
  const result = validateSemanticVerdict(
    { verdict: "PASS", criteria: [{ id: "AC1", verdict: "PASS", reason: "ok" }] },
    ["AC1", "AC2"],
  );
  assert.match(String(result), /AC2/);
});

test("validateSemanticVerdict rejects PASS verdict with FAIL criteria", () => {
  const result = validateSemanticVerdict(
    {
      verdict: "PASS",
      criteria: [
        { id: "AC1", verdict: "PASS", reason: "ok" },
        { id: "AC2", verdict: "FAIL", reason: "missing" },
      ],
    },
    ["AC1", "AC2"],
  );
  assert.equal(typeof result, "string");
});

test("validateSemanticVerdict accepts a consistent FAIL", () => {
  const result = validateSemanticVerdict(
    {
      verdict: "FAIL",
      criteria: [
        { id: "AC1", verdict: "PASS", reason: "ok" },
        { id: "AC2", verdict: "FAIL", reason: "not in diff" },
      ],
    },
    ["AC1", "AC2"],
  );
  assert.equal(typeof result, "object");
  assert.equal(result.verdict, "FAIL");
});
