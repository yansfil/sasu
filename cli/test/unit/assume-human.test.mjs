import assert from "node:assert/strict";
import test from "node:test";
import { assumeHumanFindings, enforceHumanBlocking } from "../../dist/gates/commands.js";

const f = (over) => ({ area: "x", severity: "P1", missing: "m", recommendation: "r", requiresHuman: false, ...over });

test("delegated run: a reversible choice becomes an assumption without changing severity", () => {
  const out = assumeHumanFindings({
    verdict: "BLOCK",
    findings: [f({ requiresHuman: true, disposition: "delegated_assumption", severity: "P1", missing: "delivery scope unconfirmed" })],
  });
  assert.equal(out.verdict, "PASS");
  assert.equal(out.assumed.length, 1);
  assert.equal(out.assumed[0].missing, "delivery scope unconfirmed", "the ledger keeps the original finding verbatim");
  assert.equal(out.assumed[0].severity, "P1", "the ledger keeps the judged severity, not the demoted one");
  assert.deepEqual(out.findings, []);
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
    findings: [f({ severity: "P1" }), f({ requiresHuman: true, disposition: "delegated_assumption", severity: "P1" })],
  });
  assert.equal(out.verdict, "BLOCK", "the plain P1 quality finding still blocks");
  assert.equal(out.assumed.length, 1, "only the human finding was assumed");
});

test("delegated run composes with authority normalization without severity promotion", () => {
  const promoted = enforceHumanBlocking({
    verdict: "PASS",
    findings: [f({ requiresHuman: true, disposition: "delegated_assumption", severity: "P2" })],
  });
  assert.equal(promoted.verdict, "BLOCK", "requiresHuman blocks independently of P2");
  const out = assumeHumanFindings(promoted);
  assert.equal(out.verdict, "PASS");
  assert.equal(out.assumed.length, 1);
});

for (const severity of ["P0", "P1", "P2"]) test(`authority is independent of ${severity} impact`, () => {
  const reversible = f({ severity, requiresHuman: true, disposition: "delegated_assumption" });
  const assumed = assumeHumanFindings(enforceHumanBlocking({ verdict: "BLOCK", findings: [reversible] }));
  assert.equal(assumed.verdict, "PASS");
  assert.deepEqual(assumed.assumed, [reversible]);
  const hard = assumeHumanFindings(enforceHumanBlocking({ verdict: "BLOCK", findings: [f({ severity, disposition: "human_authority" })] }));
  assert.equal(hard.verdict, "BLOCK");
  assert.equal(hard.assumed.length, 0);
  assert.equal(hard.findings[0].severity, severity);
});
