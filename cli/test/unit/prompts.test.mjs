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
  assert.match(prompt, /human-required findings remain blocking/i);
  assert.match(prompt, /other new findings below P0 cannot block/i);
});

test("post-PASS re-run prompt permits findings that require explicit human agreement", () => {
  const prompt = gapAuditPrompt("log", [], { rerun: true });
  assert.match(prompt, /closing\s+it requires explicit human agreement/i);
  assert.match(prompt, /keeps human-required findings blocking/i);
});

test("re-run spec prompt carries prior findings", () => {
  const prompt = specGatePrompt("prd", "log", PRIOR);
  assert.match(prompt, /RE-RUN CONTEXT/);
  assert.match(prompt, /error-handling/);
});

test("depth bar is part of the shared gap contract", () => {
  assert.match(gapAuditPrompt("log"), /NEVER blockers/);
});

test("gap-audit treats explicit consent provenance as a closure requirement", () => {
  const prompt = gapAuditPrompt("log");
  assert.match(prompt, /recommendation is not evidence or permission/i);
  assert.match(prompt, /stronger or broader than the cited answer/i);
  assert.match(prompt, /invented consent.*P0/i);
  assert.match(prompt, /requiresHuman: false.*does not authorize/i);
  assert.match(prompt, /Resolved decisions supported by their cited Raw Q&A answers or exact repository evidence/);
});

test("clampDocument truncates the middle with a notice", () => {
  const clamped = clampDocument("a".repeat(300), 100);
  assert.match(clamped, /TRUNCATED 200 chars/);
  assert.ok(clamped.length < 300);
});

// --- semantic verify prompt: injected evidence, recorded checks, settled oracles ---

test("both verify prompt builders render settled oracles, check provenance, evidence provenance, and the omitted notice identically", async () => {
  const { semanticVerifyPrompt, agenticSemanticVerifyPrompt } = await import("../../dist/gates/prompts.js");
  const criteria = [{ id: "AC1", text: "renders" }];
  const evidence = [
    {
      criterionId: "AC1",
      path: "agents/implement/t/artifacts/logs/run.log",
      sha256: "ab".repeat(32),
      bytes: 999,
      text: "captured body",
      provenance: "registered as log evidence by the implement run (owner AC1)",
      truncated: true,
    },
  ];
  const checks = [
    {
      criterionId: "AC1",
      command: "node check.js",
      exitCode: 0,
      tail: "recorded tail",
      provenance: "the implement harness ran `node check.js` earlier in the run (verify-run recorded on V1; the tree may have changed since)",
    },
  ];
  const options = {
    settled: [{ criterionId: "AC9", note: "harness ran `x`: exit 0", tail: "oracle tail" }],
    omittedEvidenceCount: 2,
  };
  for (const prompt of [
    semanticVerifyPrompt("diff", criteria, evidence, checks, options),
    agenticSemanticVerifyPrompt("stat", criteria, evidence, checks, options),
  ]) {
    assert.match(prompt, /\[AC9 - settled by harness oracle\] harness ran `x`: exit 0/);
    assert.match(prompt, /NOT yours to judge/);
    assert.match(prompt, /oracle tail/);
    assert.match(prompt, /verify-run recorded on V1; the tree may have changed since\); it exited 0\./, "provenance replaces the 'just now' wording");
    assert.doesNotMatch(prompt, /`node check\.js` just now/);
    assert.match(prompt, /registered as log evidence by the implement run/);
    assert.match(prompt, /bounded excerpt of a larger file/);
    assert.match(prompt, /2 more artifact\(s\) omitted for the judge input budget/);
    assert.match(prompt, /Do not treat their absence here as absence of evidence/);
  }
});

test("quick-path prompt wording is unchanged when nothing is injected", async () => {
  const { semanticVerifyPrompt } = await import("../../dist/gates/prompts.js");
  const prompt = semanticVerifyPrompt(
    "diff",
    [{ id: "AC1", text: "renders" }],
    [{ criterionId: "AC1", path: "out.log", sha256: "cd".repeat(32), bytes: 10, text: "body", producedBy: "node cap.js" }],
    [{ criterionId: "AC1", command: "node t.js", exitCode: 0, tail: "ok" }],
  );
  assert.match(prompt, /produced by the harness running `node cap\.js` just now/);
  assert.match(prompt, /the harness ran `node t\.js` just now and it exited 0/);
  assert.doesNotMatch(prompt, /ALREADY SETTLED/);
  assert.doesNotMatch(prompt, /artifact\(s\) omitted/);
});
