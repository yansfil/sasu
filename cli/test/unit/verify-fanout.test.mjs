// Whole-contract verification replaces criterion fan-out. These tests keep
// its diff curation, input-size and fresh-input boundaries.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { diffStatFromText, splitDiffByFile, isExcludedFromDiff, runVerifyGate } from "../../dist/gates/commands.js";
import { VERIFY_DIFF_MAX_CHARS } from "../../dist/gates/prompts.js";
import { loadConfig } from "../../dist/config.js";

const DIFF = "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/docs/guide.md b/docs/guide.md\n--- a/docs/guide.md\n+++ b/docs/guide.md\n@@ -1 +1 @@\n+guide\n";
const PASS = { summary: "Contract assessed", findings: [], priorDispositions: [] };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-contract-review-"));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  fs.mkdirSync(path.join(dir, "agents"));
  fs.writeFileSync(path.join(dir, "agents/contract.md"), "---\ntopic: t\nstatus: active\n---\n## Goal\nShow requested behavior\n## Acceptance Criteria\n- AC1. user sees behavior\n");
  fs.writeFileSync(path.join(dir, "agents/stub.json"), JSON.stringify(PASS));
  return dir;
}
async function withStub(dir, env, task) {
  const changes = {SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: path.join(dir, "agents/stub.json"), ...env};
  const saved = Object.fromEntries(Object.keys(changes).map(key => [key, process.env[key]]));
  Object.assign(process.env, changes);
  try { return await task(); } finally { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}

test("diff curation excludes bookkeeping and locks while preserving actual source", () => {
  for (const file of ["agents/quick/t/contract.md", "agents/runs/t/state.json", "agents/config.json", "app/package-lock.json"]) assert.equal(isExcludedFromDiff(file), true, file);
  for (const file of ["src/app.ts", "docs/guide.md", "agents.md"]) assert.equal(isExcludedFromDiff(file), false, file);
  assert.deepEqual(splitDiffByFile(DIFF).map(block => block.path), ["src/app.ts", "docs/guide.md"]);
  assert.match(diffStatFromText(DIFF), /2 file\(s\) changed/);
});

test("oversized input is explicit when no independent read-capable backend exists", async t => {
  const dir = fixture(t);
  await withStub(dir, {SASU_JUDGE_STUB_NO_AGENTIC: "1"}, async () => {
    await assert.rejects(runVerifyGate(dir, loadConfig(dir), "t", {contractPath: "agents/contract.md", diffText: DIFF + "x".repeat(VERIFY_DIFF_MAX_CHARS)}), /too large.*not truncated/);
    assert.equal(fs.existsSync(path.join(dir, "agents/runs/t/gates/gates.json")), false);
  });
});

test("read-capable backend must actually read source before accepting oversized input", async t => {
  const dir = fixture(t);
  await withStub(dir, {}, async () => {
    const result = await runVerifyGate(dir, loadConfig(dir), "t", {contractPath: "agents/contract.md", diffText: DIFF + "x".repeat(VERIFY_DIFF_MAX_CHARS)});
    assert.equal(result.ok, false);
    assert.match(result.error.message, /recorded reads/);
  });
});

test("a contract mutation during actual mechanical execution cannot earn a current review", async t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, "agents/config.json"), JSON.stringify({verify: {commands: {test: 'node -e "require(\'fs\').appendFileSync(\'agents/contract.md\',\'changed\')"'}}}));
  await withStub(dir, {}, async () => {
    const result = await runVerifyGate(dir, loadConfig(dir), "t", {contractPath: "agents/contract.md", diffText: DIFF});
    assert.equal(result.ok, false);
    assert.match(result.error.message, /inputs changed during execution/);
  });
});
