import assert from "node:assert/strict";
import test from "node:test";

import {
  latestAttemptResult,
  validateRiskVerdict,
  validateVerdictDelta,
  verificationInputManifest,
  verificationRoundContext,
} from "../../dist/implement/convergence.js";

const snapshot = (entries) => ({ head: "head", entries, digest: JSON.stringify(entries) });

test("lane lineage skips newer partial errors and keeps the latest result for the same semantic unit", () => {
  const first = {
    id: "attempt-1",
    lanes: {
      acceptance: { result: { criteria: [{ id: "AC1", verdict: "FAIL" }] } },
      risk: { result: { verdict: "FAIL", findings: [{ id: "RF1", severity: "blocking", text: "unresolved" }] } },
    },
  };
  const partial = {
    id: "attempt-2",
    lanes: {
      acceptance: { result: { criteria: [{ id: "AC2", verdict: "PASS" }] } },
      risk: { result: null },
    },
  };
  const attempts = [first, partial];
  const acceptance = latestAttemptResult(attempts, (attempt) =>
    attempt.lanes.acceptance?.result?.criteria.find((entry) => entry.id === "AC1"));
  const risk = latestAttemptResult(attempts, (attempt) => attempt.lanes.risk?.result);

  assert.equal(acceptance.attempt.id, "attempt-1");
  assert.equal(acceptance.result.verdict, "FAIL");
  assert.equal(risk.attempt.id, "attempt-1");
  assert.equal(risk.result.findings[0].id, "RF1");
});

test("round context names exact changed paths and new evidence, and a new FAIL must point to one", () => {
  const initial = snapshot([]);
  const firstManifest = verificationInputManifest(initial, snapshot([
    { path: "src/a.ts", state: "present", sha256: "one" },
  ]), []);
  const prior = { id: "attempt-1", inputManifest: firstManifest };
  const current = verificationInputManifest(initial, snapshot([
    { path: "src/a.ts", state: "present", sha256: "two" },
  ]), [{ verificationId: "V1", path: "proof.log", sha256: "proof", command: undefined }]);
  const context = verificationRoundContext(current, prior);

  assert.deepEqual(context.changedPaths, ["src/a.ts"]);
  assert.deepEqual(context.newEvidence, [{ verificationId: "V1", path: "proof.log", sha256: "proof" }]);
  assert.deepEqual(validateVerdictDelta({
    origin: "new",
    deltaBasis: { kind: "changed-path", value: "src/a.ts" },
  }, "FAIL", "PASS", context, "AC1"), {
    origin: "new",
    deltaBasis: { kind: "changed-path", value: "src/a.ts" },
  });
  assert.match(validateVerdictDelta({ origin: "new" }, "FAIL", "PASS", context, "AC1"), /deltaBasis/);
  assert.match(validateVerdictDelta({
    origin: "new",
    deltaBasis: { kind: "changed-path", value: "invented.ts" },
  }, "FAIL", "PASS", context, "AC1"), /must name an exact changed-path/);
});

test("a prior FAIL must be dispositioned, while a real changed-path blocker remains allowed", () => {
  const context = { priorAttemptId: "attempt-1", changedPaths: ["src/fix.ts"], newEvidence: [] };
  assert.deepEqual(validateVerdictDelta({
    priorDisposition: { status: "resolved", reason: "the failing branch now has a guard" },
  }, "PASS", "FAIL", context, "F1"), {
    priorDisposition: { status: "resolved", reason: "the failing branch now has a guard" },
  });
  assert.match(validateVerdictDelta({}, "PASS", "FAIL", context, "F1"), /priorDisposition/);
  assert.deepEqual(validateVerdictDelta({
    priorDisposition: { status: "resolved", reason: "the old issue is fixed" },
    origin: "new",
    deltaBasis: { kind: "changed-path", value: "src/fix.ts" },
  }, "FAIL", "FAIL", context, "F1"), {
    priorDisposition: { status: "resolved", reason: "the old issue is fixed" },
    origin: "new",
    deltaBasis: { kind: "changed-path", value: "src/fix.ts" },
  });
});

test("risk findings get stable ids and every prior finding is dispositioned on round 2+", () => {
  const first = validateRiskVerdict({
    verdict: "PASS",
    findings: [{ severity: "advisory", text: "consider a narrower permission" }],
  }, null, { priorAttemptId: null, changedPaths: [], newEvidence: [] });
  assert.notEqual(typeof first, "string");
  assert.deepEqual(first.findings, [{ id: "RF1", severity: "advisory", text: "consider a narrower permission" }]);

  const context = { priorAttemptId: "attempt-1", changedPaths: ["src/auth.ts"], newEvidence: [] };
  assert.match(validateRiskVerdict({ verdict: "PASS", findings: [] }, first, context), /priorDispositions/);
  const second = validateRiskVerdict({
    verdict: "FAIL",
    priorDispositions: [{ id: "RF1", status: "resolved", reason: "permission is now scoped" }],
    findings: [{
      severity: "blocking",
      text: "the new token path logs credentials",
      origin: "new",
      deltaBasis: { kind: "changed-path", value: "src/auth.ts" },
    }],
  }, first, context);
  assert.notEqual(typeof second, "string");
  assert.equal(second.findings[0].id, "RF2");
  assert.deepEqual(second.findings[0].deltaBasis, { kind: "changed-path", value: "src/auth.ts" });
});

test("an unresolved blocker cannot be downgraded and resolving it requires an exact delta", () => {
  const prior = {
    verdict: "FAIL",
    findings: [{ id: "RF1", severity: "blocking", text: "unsafe write" }],
  };
  const unchanged = { priorAttemptId: "attempt-1", changedPaths: [], newEvidence: [] };
  assert.match(validateRiskVerdict({
    verdict: "PASS",
    priorDispositions: [{ id: "RF1", status: "resolved", reason: "claimed fixed" }],
    findings: [],
  }, prior, unchanged), /resolving prior blocking RF1 requires.*deltaBasis/);
  assert.match(validateRiskVerdict({
    verdict: "PASS",
    priorDispositions: [{ id: "RF1", status: "unresolved", reason: "still present" }],
    findings: [{ severity: "advisory", text: "same issue, lower label", origin: "prior-unresolved", priorFindingId: "RF1" }],
  }, prior, unchanged), /must remain blocking/);

  const changed = { priorAttemptId: "attempt-1", changedPaths: ["src/write.ts"], newEvidence: [] };
  const resolved = validateRiskVerdict({
    verdict: "PASS",
    priorDispositions: [{
      id: "RF1",
      status: "resolved",
      reason: "write is now guarded",
      deltaBasis: { kind: "changed-path", value: "src/write.ts" },
    }],
    findings: [],
  }, prior, changed);
  assert.notEqual(typeof resolved, "string");
  assert.deepEqual(resolved.priorDispositions[0].deltaBasis, { kind: "changed-path", value: "src/write.ts" });
});
