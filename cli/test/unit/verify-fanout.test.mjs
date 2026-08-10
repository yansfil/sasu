// Verify-gate hardening (audited run, 2026-08): diff curation, the oversized-
// diff guard that must never charge a retry attempt, the zero-mechanical
// warning, and the criterion-scoped semantic fan-out. Exercised in-process
// against runVerifyGate with the stub judge backend so budget accounting is
// asserted on the real gate store.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isExcludedFromDiff, partitionVerifyCriteria, runVerifyGate } from "../../dist/gates/commands.js";
import { semanticVerifyPrompt, VERIFY_DIFF_MAX_CHARS } from "../../dist/gates/prompts.js";
import { loadConfig } from "../../dist/config.js";

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sasu-verify-unit-"));
}

function criteria(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `AC${i + 1}`, text: `criterion ${i + 1}` }));
}

// A prelint-clean quick contract: PASS verdicts pin their inputs, so tests
// that assert an effective PASS need a real AC-source document on disk.
function writeContract(dir, n) {
  fs.mkdirSync(path.join(dir, "agents", "quick", "t"), { recursive: true });
  const acs = criteria(n)
    .map((c) => `- ${c.id}. ${c.text}`)
    .join("\n");
  fs.writeFileSync(
    path.join(dir, "agents", "quick", "t", "contract.md"),
    `---\ntopic: t\nstatus: active\n---\n\n## Goal\n\nExercise the verify gate.\n\n## Acceptance Criteria\n\n${acs}\n`,
  );
  return "agents/quick/t/contract.md";
}

function withStub(dir, response, fn) {
  const stubFile = path.join(dir, "stub.json");
  fs.writeFileSync(stubFile, JSON.stringify(response));
  const saved = { backend: process.env.SASU_JUDGE_BACKEND, file: process.env.SASU_JUDGE_STUB_FILE };
  process.env.SASU_JUDGE_BACKEND = "stub";
  process.env.SASU_JUDGE_STUB_FILE = stubFile;
  const restore = () => {
    if (saved.backend === undefined) delete process.env.SASU_JUDGE_BACKEND;
    else process.env.SASU_JUDGE_BACKEND = saved.backend;
    if (saved.file === undefined) delete process.env.SASU_JUDGE_STUB_FILE;
    else process.env.SASU_JUDGE_STUB_FILE = saved.file;
  };
  return fn().finally(restore);
}

function gatesState(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "agents", "gates", "t", "gates.json"), "utf8"));
}

function readArtifacts(dir) {
  const artifactsDir = path.join(dir, "agents", "gates", "t", "artifacts");
  return fs.readdirSync(artifactsDir).map((f) => JSON.parse(fs.readFileSync(path.join(artifactsDir, f), "utf8")));
}

// --- diff curation predicate ---

test("isExcludedFromDiff: the whole agents/ namespace is out, not just gates/quick", () => {
  for (const file of ["agents/gates/t/gates.json", "agents/quick/demo/contract.md", "agents/prd/prd.md", "agents/interview/qa-log.md", "agents/config.json"]) {
    assert.equal(isExcludedFromDiff(file), true, `${file} must be excluded`);
  }
});

test("isExcludedFromDiff: lockfiles are excluded at any depth, code is not", () => {
  for (const file of ["pnpm-lock.yaml", "app/pnpm-lock.yaml", "package-lock.json", "a/b/yarn.lock", "bun.lockb", "Cargo.lock", "poetry.lock", "composer.lock", "vendor/Gemfile.lock"]) {
    assert.equal(isExcludedFromDiff(file), true, `${file} must be excluded`);
  }
  for (const file of ["app/src/index.ts", "src/lockfile-parser.ts", "agents.md", "yarn.lock.md"]) {
    assert.equal(isExcludedFromDiff(file), false, `${file} must stay in the diff`);
  }
});

// --- lane partition ---

test("partitionVerifyCriteria: balanced lanes under the cap, stable order, last lane may be smaller", () => {
  assert.deepEqual(partitionVerifyCriteria([]), []);
  assert.deepEqual(partitionVerifyCriteria(criteria(8)).map((l) => l.length), [8], "8 criteria stay a single lane");
  assert.deepEqual(partitionVerifyCriteria(criteria(9)).map((l) => l.length), [5, 4]);
  assert.deepEqual(partitionVerifyCriteria(criteria(27)).map((l) => l.length), [7, 7, 7, 6], "the audited 27-criterion run splits 7/7/7/6");
  const lanes = partitionVerifyCriteria(criteria(27));
  assert.deepEqual(lanes.flat().map((c) => c.id), criteria(27).map((c) => c.id), "partition preserves document order");
});

// --- truncation guard ---

test("an oversized diff fails the command without charging an attempt or recording an outcome", async () => {
  const dir = makeDir();
  fs.writeFileSync(path.join(dir, "big.diff"), "+x".repeat(Math.ceil((VERIFY_DIFF_MAX_CHARS + 1) / 2)));
  // Pre-seed a gate state mid fix-loop: the guard must leave it untouched.
  const stateDir = path.join(dir, "agents", "gates", "t");
  fs.mkdirSync(stateDir, { recursive: true });
  const empty = { verdict: null, attempts: 0, overridden: false, findings: [], lastRunAt: null, history: [] };
  fs.writeFileSync(
    path.join(stateDir, "gates.json"),
    JSON.stringify({
      schema: 1,
      topic: "t",
      gates: { "gap-audit": empty, spec: empty, verify: { ...empty, verdict: "FAIL", attempts: 2 } },
      deviations: [],
      judgeCalls: [],
    }),
  );
  await assert.rejects(
    runVerifyGate(dir, loadConfig(dir), "t", { criteria: criteria(2), diffFile: "big.diff", skipMechanical: true }),
    (error) => {
      assert.match(error.message, new RegExp(`over the ${VERIFY_DIFF_MAX_CHARS}-char judge input budget`));
      assert.match(error.message, /No judgment ran and no retry attempt was spent/);
      assert.match(error.message, /--diff-file/);
      return true;
    },
  );
  const record = gatesState(dir).gates.verify;
  assert.equal(record.attempts, 2, "the guard must not charge a retry attempt");
  assert.equal(record.verdict, "FAIL", "the guard must not record a new outcome");
  assert.equal(gatesState(dir).judgeCalls.length, 0, "no judge call may be spent");
});

test("the semantic prompt never clamps the diff it is given", () => {
  const diff = "+line\n".repeat(10_000);
  const prompt = semanticVerifyPrompt(diff, criteria(1));
  assert.ok(prompt.includes(diff), "the full diff must ride in the prompt");
  assert.doesNotMatch(prompt, /TRUNCATED \d+ chars/);
});

// --- mechanical zero-detection warning ---

test("zero resolved mechanical commands surface a loud warning and a none-detected artifact stage", async () => {
  const dir = makeDir();
  fs.writeFileSync(path.join(dir, "small.diff"), "diff --git a/x b/x\n+render()\n");
  const contractPath = writeContract(dir, 2);
  const result = await withStub(
    dir,
    { verdict: "PASS", criteria: [{ id: "AC1", verdict: "PASS", reason: "ok" }, { id: "AC2", verdict: "PASS", reason: "ok" }] },
    () => runVerifyGate(dir, loadConfig(dir), "t", { contractPath, diffFile: "small.diff" }),
  );
  assert.equal(result.ok, true, "the warning must not block the gate");
  assert.match(result.mechanicalWarning, /ZERO mechanical commands/);
  assert.match(result.mechanicalWarning, /agents\/config\.json/, "the warning must say how to fix it");
  const artifact = readArtifacts(dir).find((a) => a.stage === "semantic");
  assert.equal(artifact.mechanical, "none-detected", "an empty runs list must not read as a passing stage");
});

test("--skip-mechanical is a deliberate choice and gets no zero-detection warning", async () => {
  const dir = makeDir();
  fs.writeFileSync(path.join(dir, "small.diff"), "diff --git a/x b/x\n+render()\n");
  const contractPath = writeContract(dir, 2);
  const result = await withStub(
    dir,
    { verdict: "PASS", criteria: [{ id: "AC1", verdict: "PASS", reason: "ok" }, { id: "AC2", verdict: "PASS", reason: "ok" }] },
    () => runVerifyGate(dir, loadConfig(dir), "t", { contractPath, diffFile: "small.diff", skipMechanical: true }),
  );
  assert.equal(result.mechanicalWarning, undefined);
  assert.equal(readArtifacts(dir).find((a) => a.stage === "semantic").mechanical, "skipped");
});

// --- semantic fan-out ---

const laneVerdicts = (ids, failId) => ({
  verdict: ids.includes(failId) ? "FAIL" : "PASS",
  criteria: ids.map((id) => ({ id, verdict: id === failId ? "FAIL" : "PASS", reason: id === failId ? "not in the diff" : "ok" })),
});

test("fan-out: criteria split into lanes, lanes merge in document order, one round is one attempt", async () => {
  const dir = makeDir();
  fs.writeFileSync(path.join(dir, "small.diff"), "diff --git a/x b/x\n+render()\n");
  const nine = criteria(9);
  const result = await withStub(
    dir,
    {
      byPurpose: {
        "lane:1": laneVerdicts(nine.slice(0, 5).map((c) => c.id), null),
        "lane:2": laneVerdicts(nine.slice(5).map((c) => c.id), "AC6"),
      },
    },
    () => runVerifyGate(dir, loadConfig(dir), "t", { criteria: nine, diffFile: "small.diff", skipMechanical: true }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.judgedVerdict, "FAIL", "one failing lane fails the merged verdict");
  assert.deepEqual(result.criteria.map((c) => c.id), nine.map((c) => c.id), "merged criteria keep document order");
  assert.ok(result.status.findings.some((f) => f.missing.startsWith("AC6:")));

  const state = gatesState(dir);
  assert.equal(state.gates.verify.attempts, 1, "one fan-out round is ONE gate attempt");
  assert.equal(state.judgeCalls.length, 2, "one judge call per lane");
  assert.deepEqual(state.judgeCalls.map((c) => c.purpose).sort(), ["gate:verify-semantic:lane:1", "gate:verify-semantic:lane:2"]);
  assert.ok(state.judgeCalls.every((c) => c.tier === "standard"), "lanes must not be cheapened below the standard tier");

  const artifact = readArtifacts(dir).find((a) => a.stage === "semantic");
  assert.equal(artifact.lanes.length, 2);
  assert.deepEqual(artifact.lanes[0].criteriaIds, ["AC1", "AC2", "AC3", "AC4", "AC5"]);
  assert.deepEqual(artifact.lanes.map((l) => l.verdict), ["PASS", "FAIL"]);
  assert.ok(artifact.lanes.every((l) => l.promptSha256 && l.judge.backend === "stub"), "each lane records its prompt hash and judge call");
  assert.ok(artifact.promptSha256, "the round keeps a single auditable prompt hash");
});

test("fan-out: a single lane keeps the historical gate:verify-semantic purpose", async () => {
  const dir = makeDir();
  fs.writeFileSync(path.join(dir, "small.diff"), "diff --git a/x b/x\n+render()\n");
  const contractPath = writeContract(dir, 2);
  const result = await withStub(
    dir,
    { verdict: "PASS", criteria: [{ id: "AC1", verdict: "PASS", reason: "ok" }, { id: "AC2", verdict: "PASS", reason: "ok" }] },
    () => runVerifyGate(dir, loadConfig(dir), "t", { contractPath, diffFile: "small.diff", skipMechanical: true }),
  );
  assert.equal(result.ok, true);
  const state = gatesState(dir);
  assert.equal(state.judgeCalls.length, 1);
  assert.equal(state.judgeCalls[0].purpose, "gate:verify-semantic");
});

test("fan-out: one erroring lane fails the whole round closed and names the lane", async () => {
  const dir = makeDir();
  fs.writeFileSync(path.join(dir, "small.diff"), "diff --git a/x b/x\n+render()\n");
  const nine = criteria(9);
  const result = await withStub(
    dir,
    {
      byPurpose: {
        "lane:1": laneVerdicts(nine.slice(0, 5).map((c) => c.id), null),
        "lane:2": "garbage that is not a verdict",
      },
    },
    () => runVerifyGate(dir, loadConfig(dir), "t", { criteria: nine, diffFile: "small.diff", skipMechanical: true }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "judge-invalid-output");
  assert.match(result.error.message, /lane failed \[2\]/);
  const state = gatesState(dir);
  assert.equal(state.gates.verify.verdict, "ERROR", "a partial set of lane verdicts is not a verdict");
  assert.equal(state.judgeCalls.length, 2, "the passing lane's record survives beside the failure record");
});

test("fan-out: a foreign criterion id is dropped from the lane instead of failing it", async () => {
  const dir = makeDir();
  fs.writeFileSync(path.join(dir, "small.diff"), "diff --git a/x b/x\n+render()\n");
  const contractPath = writeContract(dir, 9);
  const nine = criteria(9);
  const lane2Ids = nine.slice(5).map((c) => c.id);
  const result = await withStub(
    dir,
    {
      byPurpose: {
        // Lane 1 over-answers with a FAIL for AC6, which lane 2 owns and passes.
        "lane:1": {
          verdict: "FAIL",
          criteria: [
            ...nine.slice(0, 5).map((c) => ({ id: c.id, verdict: "PASS", reason: "ok" })),
            { id: "AC6", verdict: "FAIL", reason: "not my lane" },
          ],
        },
        "lane:2": laneVerdicts(lane2Ids, null),
      },
    },
    () => runVerifyGate(dir, loadConfig(dir), "t", { contractPath, diffFile: "small.diff", skipMechanical: true }),
  );
  assert.equal(result.ok, true, "the owning lane's PASS must be authoritative for AC6");
  assert.equal(result.criteria.find((c) => c.id === "AC6").verdict, "PASS");
});

test("fan-out: judge.fanout=false restores the exhaustive single call for any criteria count", async () => {
  const dir = makeDir();
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agents", "config.json"), JSON.stringify({ judge: { fanout: false } }));
  fs.writeFileSync(path.join(dir, "small.diff"), "diff --git a/x b/x\n+render()\n");
  const contractPath = writeContract(dir, 9);
  const nine = criteria(9);
  const result = await withStub(
    dir,
    laneVerdicts(nine.map((c) => c.id), null),
    () => runVerifyGate(dir, loadConfig(dir), "t", { contractPath, diffFile: "small.diff", skipMechanical: true }),
  );
  assert.equal(result.ok, true);
  const state = gatesState(dir);
  assert.equal(state.judgeCalls.length, 1, "the escape hatch makes exactly one judge call");
  assert.equal(state.judgeCalls[0].purpose, "gate:verify-semantic");
});
