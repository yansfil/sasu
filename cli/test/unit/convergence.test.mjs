import assert from "node:assert/strict";
import test from "node:test";
import { applyRerunConvergence } from "../../dist/gates/commands.js";

const f = (over) => ({ area: "x", severity: "P1", missing: "m", recommendation: "r", requiresHuman: false, ...over });

test("re-run convergence: unresolved prior findings keep blocking", () => {
  const out = applyRerunConvergence({ verdict: "BLOCK", findings: [f({ origin: "prior-unresolved" })] });
  assert.equal(out.verdict, "BLOCK");
  assert.equal(out.demotedCount, 0);
});

test("re-run convergence: a new P0 still blocks (catastrophic-miss escape hatch)", () => {
  const out = applyRerunConvergence({ verdict: "BLOCK", findings: [f({ origin: "new", severity: "P0" })] });
  assert.equal(out.verdict, "BLOCK");
});

test("re-run convergence: a new P1 requiring human agreement remains blocking", () => {
  const out = applyRerunConvergence({
    verdict: "BLOCK",
    findings: [f({ origin: "new", severity: "P1", requiresHuman: true })],
  });
  assert.equal(out.verdict, "BLOCK");
  assert.equal(out.demotedCount, 0);
  assert.equal(out.findings[0].severity, "P1");
  assert.equal(out.findings[0].requiresHuman, true);
});

test("re-run convergence: a new non-human P1 is demoted to a non-blocking P2 advisory", () => {
  const out = applyRerunConvergence({
    verdict: "BLOCK",
    findings: [f({ origin: "new", severity: "P1", requiresHuman: false })],
  });
  assert.equal(out.verdict, "PASS");
  assert.equal(out.demotedCount, 1);
  assert.equal(out.findings[0].severity, "P2");
  assert.equal(out.findings[0].requiresHuman, false, "demoted advisories must not trigger human stops");
  assert.match(out.findings[0].recommendation, /auto-demoted/);
});

test("re-run convergence: a human-required P2 is promoted and blocks", () => {
  const out = applyRerunConvergence({
    verdict: "PASS",
    findings: [f({ origin: "new", severity: "P2", requiresHuman: true })],
  });
  assert.equal(out.verdict, "BLOCK");
  assert.equal(out.findings[0].severity, "P1");
  assert.equal(out.findings[0].requiresHuman, true);
});

test("re-run convergence: mixed findings block only on the prior-unresolved one", () => {
  const out = applyRerunConvergence({
    verdict: "BLOCK",
    findings: [f({ origin: "prior-unresolved" }), f({ origin: "new" }), f({ origin: "new", severity: "P2" })],
  });
  assert.equal(out.verdict, "BLOCK");
  assert.equal(out.demotedCount, 1);
  assert.equal(out.findings.filter((x) => x.severity === "P2").length, 2);
});
