import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

// Pins the lib/TS gate-arithmetic twins together with fixtures instead of a
// comment: verifyGateFallbackStatus (cli/lib/reviews.js, the no-dist branch
// of verifyGateStatus) must derive the same effective/budgetExhausted reading
// as the compiled gateStatus (cli/src/gates/store.ts), because that predicate
// now gates the blocked-receipt exit. The fallback is exported as a pure
// function precisely so this test can drive it deterministically without
// hiding the dist build from the module loader.
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const requireModule = createRequire(import.meta.url);
const { verifyGateFallbackStatus } = requireModule(path.join(repoRoot, "cli", "lib", "reviews.js"));
const { judgeRetryBudget } = requireModule(path.join(repoRoot, "cli", "lib", "config.js"));
const store = requireModule(path.join(repoRoot, "cli", "dist", "gates", "store.js"));
const { loadConfig } = requireModule(path.join(repoRoot, "cli", "dist", "config.js"));

const emptyGate = { verdict: null, attempts: 0, overridden: false, findings: [], lastRunAt: null, history: [] };

test("lib fallback gate arithmetic matches dist gateStatus on identical fixtures", () => {
  const budget = 2;
  const fixtures = [
    { name: "BLOCKED with budget exhausted", record: { ...emptyGate, verdict: "FAIL", attempts: 2 } },
    { name: "BLOCKED with budget left", record: { ...emptyGate, verdict: "FAIL", attempts: 1 } },
    { name: "never judged despite attempts >= budget", record: { ...emptyGate, verdict: null, attempts: 3 } },
    { name: "PASS", record: { ...emptyGate, verdict: "PASS", attempts: 1 } },
    { name: "overridden FAIL reads as PASS", record: { ...emptyGate, verdict: "FAIL", attempts: 2, overridden: true } },
  ];
  for (const { name, record } of fixtures) {
    const lib = verifyGateFallbackStatus(record, budget);
    // No projectRoot on the dist call: freshness is exactly what the no-dist
    // fallback cannot check, so parity is scoped to the shared arithmetic.
    const dist = store.gateStatus({ gates: { verify: record } }, "verify", budget);
    assert.equal(lib.effective, dist.effective, `${name}: effective`);
    assert.equal(lib.budgetExhausted, dist.budgetExhausted, `${name}: budgetExhausted`);
    assert.equal(lib.attempts, dist.attempts, `${name}: attempts`);
    assert.equal(lib.budget, dist.budget, `${name}: budget`);
    assert.equal(lib.overridden, dist.overridden, `${name}: overridden`);
    // Deliberate asymmetry, pinned so it stays deliberate: the second terminal
    // cause ("an identical rerun would be refused") needs the tree fingerprint
    // and the input pins, i.e. exactly the dist code this fallback exists
    // because it could not load. Without dist only budgetExhausted ends the fix
    // loop - the conservative reading, since a wrongly-closed exit costs a user
    // override while a wrongly-opened one lets a run give up early.
    assert.equal(lib.rerunRefused, false, `${name}: the no-dist fallback never claims a refusal it cannot evaluate`);
    assert.equal("rerunRefused" in dist, false, `${name}: gateStatus stays pure arithmetic; the refusal lives in the gate commands layer`);
  }
});

test("lib judgeRetryBudget default equals the dist config default retryBudget", () => {
  // An empty project has no agents/config.json, so both sides answer from
  // their hardcoded default; drift here would let the Stop-hook guard and
  // `sasu verify` disagree on when a budget is exhausted.
  const emptyProject = fs.mkdtempSync(path.join(os.tmpdir(), "gate-parity-"));
  assert.equal(judgeRetryBudget(emptyProject), loadConfig(emptyProject).judge.retryBudget);
});
