import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { latestCommandLog, isFreshPass, declaredSideEffect } = require(
  path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "lib", "fresh_pass.js"),
);

const FP = { headSha: "abc", statusHash: "h1" };

test("latestCommandLog picks the last executable log and survives damaged shapes", () => {
  const log1 = { kind: "command-log", command: "npm test", exitCode: 1 };
  const log2 = { kind: "command-log", command: "npm test", exitCode: 0 };
  assert.equal(latestCommandLog({ artifacts: [log1, log2] }), log2);
  assert.equal(latestCommandLog({ artifacts: [log1, { kind: "screenshot" }] }), log1);
  // Shape tolerance: null elements, empty commands, non-array, missing item.
  assert.equal(latestCommandLog({ artifacts: [null, { kind: "command-log", command: "  " }] }), null);
  assert.equal(latestCommandLog({ artifacts: "not-an-array" }), null);
  assert.equal(latestCommandLog(null), null);
});

test("isFreshPass demands exit 0 and an exact fingerprint match", () => {
  const pass = { exitCode: 0, treeFingerprint: { ...FP } };
  assert.equal(isFreshPass(pass, FP), true);
  assert.equal(isFreshPass({ ...pass, exitCode: 1 }, FP), false);
  assert.equal(isFreshPass({ ...pass, treeFingerprint: { ...FP, statusHash: "h2" } }, FP), false);
  assert.equal(isFreshPass({ ...pass, treeFingerprint: { ...FP, headSha: "def" } }, FP), false);
  assert.equal(isFreshPass({ ...pass, treeFingerprint: null }, FP), false);
  assert.equal(isFreshPass(pass, null), false);
  assert.equal(isFreshPass(null, FP), false);
});

test("declaredSideEffect reads the matrix column with the shared none-values rule", () => {
  assert.equal(declaredSideEffect({ matrix: { sideEffect: "writes seed rows" } }), "writes seed rows");
  for (const none of ["none", "없음", "-", "n/a", "N/A", "", "  "]) {
    assert.equal(declaredSideEffect({ matrix: { sideEffect: none } }), "", `"${none}" must not count`);
  }
  assert.equal(declaredSideEffect({ matrix: {} }), "");
  assert.equal(declaredSideEffect({}), "");
  assert.equal(declaredSideEffect(null), "");
});
