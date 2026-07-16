import assert from "node:assert/strict";
import test from "node:test";
import { gapAuditPrompt, specGatePrompt, clampDocument } from "../../dist/gates/prompts.js";

const PRIOR = [{ severity: "P1", area: "error-handling", missing: "setPriority unknown id behavior unspecified" }];

test("fresh gap-audit prompt carries no re-run context", () => {
  const prompt = gapAuditPrompt("log");
  assert.doesNotMatch(prompt, /RE-RUN CONTEXT/);
});

test("re-run gap-audit prompt carries prior findings and the convergence contract", () => {
  const prompt = gapAuditPrompt("log", PRIOR);
  assert.match(prompt, /RE-RUN CONTEXT/);
  assert.match(prompt, /setPriority unknown id/);
  assert.match(prompt, /Do NOT open new, deeper lines of questioning/);
});

test("re-run spec prompt carries prior findings", () => {
  const prompt = specGatePrompt("prd", "log", PRIOR);
  assert.match(prompt, /RE-RUN CONTEXT/);
  assert.match(prompt, /error-handling/);
});

test("depth bar is part of the shared gap contract", () => {
  assert.match(gapAuditPrompt("log"), /NEVER blockers/);
});

test("clampDocument truncates the middle with a notice", () => {
  const clamped = clampDocument("a".repeat(300), 100);
  assert.match(clamped, /TRUNCATED 200 chars/);
  assert.ok(clamped.length < 300);
});
