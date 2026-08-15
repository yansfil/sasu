import assert from "node:assert/strict";
import test from "node:test";
import { assumeHumanFindings, enforceHumanBlocking } from "../../dist/gates/commands.js";

const f = (over) => ({ area: "x", severity: "P1", missing: "m", recommendation: "r", requiresHuman: false, ...over });

test("delegated run: a non-P0 human finding becomes a recorded P2 assumption and stops blocking", () => {
  const out = assumeHumanFindings({
    verdict: "BLOCK",
    findings: [f({ requiresHuman: true, severity: "P1", missing: "delivery scope unconfirmed" })],
  });
  assert.equal(out.verdict, "PASS");
  assert.equal(out.assumed.length, 1);
  assert.equal(out.assumed[0].missing, "delivery scope unconfirmed", "the ledger keeps the original finding verbatim");
  assert.equal(out.assumed[0].severity, "P1", "the ledger keeps the judged severity, not the demoted one");
  assert.equal(out.findings[0].severity, "P2");
  assert.equal(out.findings[0].requiresHuman, false);
  assert.match(out.findings[0].recommendation, /assumed under the recorded delegated invocation/);
});

test("delegated run: a P0 human finding still blocks - delegation never covers invented consent", () => {
  const out = assumeHumanFindings({
    verdict: "BLOCK",
    findings: [f({ requiresHuman: true, severity: "P0" })],
  });
  assert.equal(out.verdict, "BLOCK");
  assert.equal(out.assumed.length, 0);
});

test("delegated run: non-human blockers are untouched - the flag is not a general softener", () => {
  const out = assumeHumanFindings({
    verdict: "BLOCK",
    findings: [f({ severity: "P1" }), f({ requiresHuman: true, severity: "P1" })],
  });
  assert.equal(out.verdict, "BLOCK", "the plain P1 quality finding still blocks");
  assert.equal(out.assumed.length, 1, "only the human finding was assumed");
});

test("delegated run composes with enforceHumanBlocking: a promoted P2 human finding is assumed, not blocked", () => {
  const promoted = enforceHumanBlocking({
    verdict: "PASS",
    findings: [f({ requiresHuman: true, severity: "P2" })],
  });
  assert.equal(promoted.verdict, "BLOCK", "promotion still happens first");
  const out = assumeHumanFindings(promoted);
  assert.equal(out.verdict, "PASS");
  assert.equal(out.assumed.length, 1);
});
