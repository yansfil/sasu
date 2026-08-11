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
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  diffStatFromText,
  filterDiffByGlobs,
  isExcludedFromDiff,
  matchesScopeGlob,
  partitionVerifyCriteria,
  readGateStatus,
  runAcOracles,
  runVerifyGate,
  scopeForLane,
  splitDiffByFile,
  verifyRerunWouldBeRefused,
} from "../../dist/gates/commands.js";
import { semanticVerifyPrompt, VERIFY_DIFF_MAX_CHARS } from "../../dist/gates/prompts.js";
import { loadConfig } from "../../dist/config.js";

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sasu-verify-unit-"));
}

function criteria(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `AC${i + 1}`, text: `criterion ${i + 1}` }));
}

// Diff injection rides the diffText test seam (the --diff-file CLI flag was
// removed: an agent-curated diff is a pointer-hijack surface), so fixtures
// are plain strings rather than files on disk.
const SMALL_DIFF = "diff --git a/x b/x\n+render()\n";

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
  // Under agents/ so the stub plumbing rides neither the judged git diff
  // (isExcludedFromDiff excludes the whole namespace) nor the vouched tree
  // fingerprint. Only the first half was true when this comment was written:
  // loose `agents/*` files rode the fallback vouched set until the exclusion
  // went namespace-wide, so a short-circuit test that swapped the stub RESPONSE
  // between two runs (FAIL then PASS) moved the fingerprint, and any rerun it
  // observed could have been explained by tree drift rather than by the
  // condition under test. Re-verified 2026-08-11: the corrected-base test below
  // now asserts the fingerprint is byte-identical across the swap, so the
  // disarm it proves rests on diffSource alone.
  const stubFile = path.join(dir, "agents", "stub.json");
  fs.mkdirSync(path.dirname(stubFile), { recursive: true });
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

test("an oversized diff on a non-agentic backend fails the command without charging an attempt or recording an outcome", async () => {
  const dir = makeDir();
  // The stub backend rehearses the codex case: no read tools, so no fallback.
  process.env.SASU_JUDGE_BACKEND = "stub";
  process.env.SASU_JUDGE_STUB_FILE = path.join(dir, "unused-stub.json");
  fs.writeFileSync(process.env.SASU_JUDGE_STUB_FILE, "{}");
  process.env.SASU_JUDGE_STUB_NO_AGENTIC = "1";
  const bigDiff = "+x".repeat(Math.ceil((VERIFY_DIFF_MAX_CHARS + 1) / 2));
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
    runVerifyGate(dir, loadConfig(dir), "t", { criteria: criteria(2), diffText: bigDiff, skipMechanical: true }),
    (error) => {
      assert.match(error.message, new RegExp(`over the ${VERIFY_DIFF_MAX_CHARS}-char judge input budget`));
      assert.match(error.message, /No judgment ran and no retry attempt was spent/);
      assert.match(error.message, /declare task Scope globs/, "the recovery advice must point at PRD Scope globs, not a curated diff");
      return true;
    },
  );
  const record = gatesState(dir).gates.verify;
  assert.equal(record.attempts, 2, "the guard must not charge a retry attempt");
  assert.equal(record.verdict, "FAIL", "the guard must not record a new outcome");
  assert.equal(gatesState(dir).judgeCalls.length, 0, "no judge call may be spent");
  delete process.env.SASU_JUDGE_STUB_NO_AGENTIC;
  delete process.env.SASU_JUDGE_BACKEND;
  delete process.env.SASU_JUDGE_STUB_FILE;
});

test("an oversized diff on an agentic backend falls back to the read-only judge instead of erroring", async () => {
  const dir = makeDir();
  const bigDiff = `diff --git a/big.ts b/big.ts\n${"+x\n".repeat(Math.ceil(VERIFY_DIFF_MAX_CHARS / 3) + 100)}`;
  const contractPath = writeContract(dir, 2);
  const result = await withStub(
    dir,
    { verdict: "PASS", criteria: [{ id: "AC1", verdict: "PASS", reason: "ok", evidence: "read big.ts" }, { id: "AC2", verdict: "PASS", reason: "ok", evidence: "read big.ts" }] },
    () => runVerifyGate(dir, loadConfig(dir), "t", { contractPath, diffText: bigDiff, skipMechanical: true }),
  );
  assert.equal(result.ok, true, "the fallback must judge, not throw");
  const artifact = readArtifacts(dir).find((a) => a.stage === "semantic");
  assert.equal(artifact.lanes[0].agenticFallback, true, "the artifact must record that the lane went agentic");
  assert.ok(artifact.lanes[0].diffChars > VERIFY_DIFF_MAX_CHARS, "the artifact records the oversized lane diff size");
  assert.ok(!("agentCuratedDiff" in artifact), "the agent-curated stamp left with the --diff-file flag");
  assert.equal(artifact.criteria[0].evidence, "read big.ts", "the judge's read trail rides in the verdict evidence");
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
  const contractPath = writeContract(dir, 2);
  const result = await withStub(
    dir,
    { verdict: "PASS", criteria: [{ id: "AC1", verdict: "PASS", reason: "ok", evidence: "x hunk" }, { id: "AC2", verdict: "PASS", reason: "ok", evidence: "x hunk" }] },
    () => runVerifyGate(dir, loadConfig(dir), "t", { contractPath, diffText: SMALL_DIFF }),
  );
  assert.equal(result.ok, true, "the warning must not block the gate");
  assert.match(result.mechanicalWarning, /ZERO mechanical commands/);
  assert.match(result.mechanicalWarning, /agents\/config\.json/, "the warning must say how to fix it");
  const artifact = readArtifacts(dir).find((a) => a.stage === "semantic");
  assert.equal(artifact.mechanical, "none-detected", "an empty runs list must not read as a passing stage");
});

test("--skip-mechanical is a deliberate choice and gets no zero-detection warning", async () => {
  const dir = makeDir();
  const contractPath = writeContract(dir, 2);
  const result = await withStub(
    dir,
    { verdict: "PASS", criteria: [{ id: "AC1", verdict: "PASS", reason: "ok", evidence: "x hunk" }, { id: "AC2", verdict: "PASS", reason: "ok", evidence: "x hunk" }] },
    () => runVerifyGate(dir, loadConfig(dir), "t", { contractPath, diffText: SMALL_DIFF, skipMechanical: true }),
  );
  assert.equal(result.mechanicalWarning, undefined);
  assert.equal(readArtifacts(dir).find((a) => a.stage === "semantic").mechanical, "skipped");
});

// --- semantic fan-out ---

const laneVerdicts = (ids, failId) => ({
  verdict: ids.includes(failId) ? "FAIL" : "PASS",
  criteria: ids.map((id) => ({
    id,
    verdict: id === failId ? "FAIL" : "PASS",
    reason: id === failId ? "not in the diff" : "ok",
    ...(id === failId ? {} : { evidence: "x hunk" }),
  })),
});

test("fan-out: criteria split into lanes, lanes merge in document order, one round is one attempt", async () => {
  const dir = makeDir();
  const nine = criteria(9);
  const result = await withStub(
    dir,
    {
      byPurpose: {
        "lane:1": laneVerdicts(nine.slice(0, 5).map((c) => c.id), null),
        "lane:2": laneVerdicts(nine.slice(5).map((c) => c.id), "AC6"),
      },
    },
    () => runVerifyGate(dir, loadConfig(dir), "t", { criteria: nine, diffText: SMALL_DIFF, skipMechanical: true }),
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
  const contractPath = writeContract(dir, 2);
  const result = await withStub(
    dir,
    { verdict: "PASS", criteria: [{ id: "AC1", verdict: "PASS", reason: "ok", evidence: "x hunk" }, { id: "AC2", verdict: "PASS", reason: "ok", evidence: "x hunk" }] },
    () => runVerifyGate(dir, loadConfig(dir), "t", { contractPath, diffText: SMALL_DIFF, skipMechanical: true }),
  );
  assert.equal(result.ok, true);
  const state = gatesState(dir);
  assert.equal(state.judgeCalls.length, 1);
  assert.equal(state.judgeCalls[0].purpose, "gate:verify-semantic");
});

test("fan-out: one erroring lane fails the whole round closed and names the lane", async () => {
  const dir = makeDir();
  const nine = criteria(9);
  const result = await withStub(
    dir,
    {
      byPurpose: {
        "lane:1": laneVerdicts(nine.slice(0, 5).map((c) => c.id), null),
        "lane:2": "garbage that is not a verdict",
      },
    },
    () => runVerifyGate(dir, loadConfig(dir), "t", { criteria: nine, diffText: SMALL_DIFF, skipMechanical: true }),
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
            ...nine.slice(0, 5).map((c) => ({ id: c.id, verdict: "PASS", reason: "ok", evidence: "x hunk" })),
            { id: "AC6", verdict: "FAIL", reason: "not my lane" },
          ],
        },
        "lane:2": laneVerdicts(lane2Ids, null),
      },
    },
    () => runVerifyGate(dir, loadConfig(dir), "t", { contractPath, diffText: SMALL_DIFF, skipMechanical: true }),
  );
  assert.equal(result.ok, true, "the owning lane's PASS must be authoritative for AC6");
  assert.equal(result.criteria.find((c) => c.id === "AC6").verdict, "PASS");
});

test("fan-out: judge.fanout=false restores the exhaustive single call for any criteria count", async () => {
  const dir = makeDir();
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agents", "config.json"), JSON.stringify({ judge: { fanout: false } }));
  const contractPath = writeContract(dir, 9);
  const nine = criteria(9);
  const result = await withStub(
    dir,
    laneVerdicts(nine.map((c) => c.id), null),
    () => runVerifyGate(dir, loadConfig(dir), "t", { contractPath, diffText: SMALL_DIFF, skipMechanical: true }),
  );
  assert.equal(result.ok, true);
  const state = gatesState(dir);
  assert.equal(state.judgeCalls.length, 1, "the escape hatch makes exactly one judge call");
  assert.equal(state.judgeCalls[0].purpose, "gate:verify-semantic");
});

// --- PRD-declared lane scoping (4a) and AC oracles (5c) ---

test("matchesScopeGlob: git-pathspec-like dialect", () => {
  assert.equal(matchesScopeGlob("cli/src/gates/commands.ts", "cli/src/**"), true);
  assert.equal(matchesScopeGlob("cli/src/config.ts", "cli/src/*.ts"), true);
  assert.equal(matchesScopeGlob("cli/src/gates/commands.ts", "cli/src/*.ts"), false, "* must not cross a slash");
  assert.equal(matchesScopeGlob("cli/lib/git.js", "cli/lib"), true, "a bare path matches like a pathspec prefix");
  assert.equal(matchesScopeGlob("cli/library/git.js", "cli/lib"), false, "prefix match is segment-aware");
  assert.equal(matchesScopeGlob("a/b/c.ts", "**/c.ts"), true);
  assert.equal(matchesScopeGlob("c.ts", "**/c.ts"), true, "**/ may match zero directories");
});

const TWO_FILE_DIFF = [
  "diff --git a/src/widget.ts b/src/widget.ts",
  "--- a/src/widget.ts",
  "+++ b/src/widget.ts",
  "@@ -1 +1,2 @@",
  "+render()",
  "diff --git a/docs/readme.md b/docs/readme.md",
  "--- a/docs/readme.md",
  "+++ b/docs/readme.md",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

test("splitDiffByFile / filterDiffByGlobs / diffStatFromText read one diff grammar", () => {
  const blocks = splitDiffByFile(TWO_FILE_DIFF);
  assert.deepEqual(blocks.map((b) => b.path), ["src/widget.ts", "docs/readme.md"]);
  const filtered = filterDiffByGlobs(TWO_FILE_DIFF, ["src/**"]);
  assert.deepEqual(filtered.files, ["src/widget.ts"]);
  assert.ok(filtered.text.includes("render()") && !filtered.text.includes("readme"));
  const stat = diffStatFromText(TWO_FILE_DIFF);
  assert.match(stat, /src\/widget\.ts \| \+1 -0/);
  assert.match(stat, /docs\/readme\.md \| \+1 -1/);
  assert.match(stat, /2 file\(s\) changed/);
});

test("scopeForLane: union of covering tasks' globs, only when every covering task declared one", () => {
  const tasks = [
    { id: "T1", scopeGlobs: ["src/**"], acceptanceCriteria: ["AC1"], requirements: ["R1"] },
    { id: "T2", scopeGlobs: ["lib/**"], acceptanceCriteria: ["AC2"], requirements: [] },
    { id: "T3", scopeGlobs: [], acceptanceCriteria: ["AC3"], requirements: [] },
  ];
  assert.deepEqual(scopeForLane([{ id: "AC1", text: "x" }], tasks), ["src/**"]);
  assert.deepEqual(scopeForLane([{ id: "AC1", text: "x" }, { id: "AC2", text: "y" }], tasks), ["src/**", "lib/**"]);
  assert.equal(scopeForLane([{ id: "AC3", text: "z" }], tasks), null, "an undeclared covering task disables scoping");
  assert.equal(scopeForLane([{ id: "AC9", text: "global invariant" }], tasks), null, "an uncovered AC keeps the full diff");
  assert.deepEqual(scopeForLane([{ id: "AC9", text: "references R1" }], tasks), ["src/**"], "coverage may ride the shared R# chain");
  // The lib parser uppercases R refs, so a lowercase bullet ref must ride the
  // same chain (the case-sensitive match silently dropped the coverage).
  assert.deepEqual(scopeForLane([{ id: "AC9", text: "references r1" }], tasks), ["src/**"], "R-refs are case-insensitive like the lib parser");
});

// A prelint-clean PRD with an oracle-backed AC3 and a Scope-declaring task.
function writeScopedPrd(dir) {
  const prd = `---
topic: "fixture"
status: "ready"
human_approval: "approved"
review_profile: "standard"
---

# PRD: fixture

## 1. Summary

A widget that renders and persists.

## 2. Problem, Goal, And Users

Users need a widget.

## 3. Scope And Non-Goals

In scope: the widget.

## 4. Pre-Work And Required Decisions

None required.

## 5. Major Technical Structure Changes

No major technical structure change expected.

## 6. Requirements

- R1. the widget renders and persists its state

## 7. Acceptance Criteria

- AC1. the widget renders
- AC2. the widget persists its state
- AC3. the marker artifact exists. Artifact: out/marker.txt

## 8. PRD-Level Tasks

- T1. build the widget. Covers R1, AC1, AC2. Scope: src/**

## 9. Verification Contract

### 9.1 Test Mode Contract

| Mode | Required For Done | Covers | Human Decision |
| --- | --- | --- | --- |
| automated behavior | yes | core behavior | none |

### 9.2 Required Agent Verification

| ID | Mode | Covers | Pass Intent | Required For Done | Can Be Blocked |
| --- | --- | --- | --- | --- | --- |
| V1 | automated behavior | R1, AC1, AC2 | behavior covered by automated test | yes | no |

## 10. Risks And Open Decisions

None.

## 11. Implementation Guardrails

Do not expand scope.

## 12. Implementation Result Report Contract

Report status and evidence.
`;
  fs.writeFileSync(path.join(dir, "prd.md"), prd);
  return "prd.md";
}

test("PRD path: oracle-backed ACs settle mechanically, lanes get the Scope-filtered diff, and unscoped files warn", async () => {
  const dir = makeDir();
  fs.mkdirSync(path.join(dir, "out"), { recursive: true });
  fs.writeFileSync(path.join(dir, "out", "marker.txt"), "made it");
  const prdPath = writeScopedPrd(dir);
  const result = await withStub(
    dir,
    { verdict: "PASS", criteria: [{ id: "AC1", verdict: "PASS", reason: "ok", evidence: "src/widget.ts" }, { id: "AC2", verdict: "PASS", reason: "ok", evidence: "src/widget.ts" }] },
    () => runVerifyGate(dir, loadConfig(dir), "t", { prdPath, diffText: TWO_FILE_DIFF, skipMechanical: true }),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.judgedCriteriaIds, ["AC1", "AC2"], "the oracle-backed AC3 never reaches the judge");
  const ac3 = result.criteria.find((c) => c.id === "AC3");
  assert.equal(ac3.verdict, "PASS");
  assert.match(ac3.evidence, /out\/marker\.txt/);
  assert.deepEqual(result.unscopedFiles, ["docs/readme.md"], "changed files outside every task Scope surface as a warning");
  const artifact = readArtifacts(dir).find((a) => a.stage === "semantic");
  assert.deepEqual(artifact.lanes[0].scope, ["src/**"], "the artifact records which paths the lane received");
  assert.equal(artifact.oracle[0].met, true);
  assert.deepEqual(artifact.unscopedFiles, ["docs/readme.md"]);
});

test("PRD path: partial Scope declaration suppresses the unscoped-files warning (ownership ambiguous)", async () => {
  const dir = makeDir();
  fs.mkdirSync(path.join(dir, "out"), { recursive: true });
  fs.writeFileSync(path.join(dir, "out", "marker.txt"), "made it");
  // T2 owns the docs work but declares no Scope: docs/readme.md may be its
  // file, so warning on it would be noise, not a finding.
  const prdPath = writeScopedPrd(dir);
  fs.writeFileSync(
    path.join(dir, prdPath),
    fs
      .readFileSync(path.join(dir, prdPath), "utf8")
      .replace(
        "- T1. build the widget. Covers R1, AC1, AC2. Scope: src/**",
        "- T1. build the widget. Covers R1, AC1, AC2. Scope: src/**\n- T2. document the widget. Covers R1.",
      ),
  );
  const result = await withStub(
    dir,
    { verdict: "PASS", criteria: [{ id: "AC1", verdict: "PASS", reason: "ok", evidence: "src/widget.ts" }, { id: "AC2", verdict: "PASS", reason: "ok", evidence: "src/widget.ts" }] },
    () => runVerifyGate(dir, loadConfig(dir), "t", { prdPath, diffText: TWO_FILE_DIFF, skipMechanical: true }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.unscopedFiles, undefined, "a Scope-less task makes file ownership ambiguous; no warning");
  const artifact = readArtifacts(dir).find((a) => a.stage === "semantic");
  assert.equal(artifact.unscopedFiles, undefined);
  assert.deepEqual(artifact.lanes[0].scope, ["src/**"], "lane scoping still applies where every covering task declared");
});

test("PRD path: an all-oracle PASS is stamped zeroJudgeCalls and spends no judge call", async () => {
  const dir = makeDir();
  fs.mkdirSync(path.join(dir, "out"), { recursive: true });
  fs.writeFileSync(path.join(dir, "out", "marker.txt"), "made it");
  const prdPath = writeScopedPrd(dir);
  fs.writeFileSync(
    path.join(dir, prdPath),
    fs
      .readFileSync(path.join(dir, prdPath), "utf8")
      .replace("- AC1. the widget renders", '- AC1. the widget renders. Check: `node -e "process.exit(0)"`')
      .replace("- AC2. the widget persists its state", '- AC2. the widget persists its state. Check: `node -e "process.exit(0)"`'),
  );
  // No judge backend configured at all: a truly zero-LLM path must not need one.
  const saved = process.env.SASU_JUDGE_BACKEND;
  delete process.env.SASU_JUDGE_BACKEND;
  try {
    const result = await runVerifyGate(dir, loadConfig(dir), "t", { prdPath, diffText: TWO_FILE_DIFF, skipMechanical: true });
    assert.equal(result.ok, true);
    assert.equal(result.zeroJudgeCalls, true, "the receipt must be able to say no model saw this diff");
    assert.equal(gatesState(dir).judgeCalls.length, 0);
    const artifact = readArtifacts(dir).find((a) => a.stage === "oracle");
    assert.equal(artifact.zeroJudgeCalls, true);
    assert.equal(artifact.verdict, "PASS");
  } finally {
    if (saved !== undefined) process.env.SASU_JUDGE_BACKEND = saved;
  }
});

test("PRD path: the oversized-diff hard error spends no oracle side effects", async () => {
  const dir = makeDir();
  const bigDiff = `diff --git a/src/widget.ts b/src/widget.ts\n${"+x\n".repeat(Math.ceil(VERIFY_DIFF_MAX_CHARS / 3) + 100)}`;
  const prdPath = writeScopedPrd(dir);
  // The oracle command leaves a marker: on the no-judgment error path it must
  // never run (it used to execute before the size check threw, side effects
  // spent with nothing recorded).
  fs.writeFileSync(
    path.join(dir, prdPath),
    fs
      .readFileSync(path.join(dir, prdPath), "utf8")
      .replace(
        "- AC3. the marker artifact exists. Artifact: out/marker.txt",
        "- AC3. the oracle ran. Check: `node -e \"require('fs').writeFileSync('oracle-ran.txt','x')\"`",
      ),
  );
  process.env.SASU_JUDGE_BACKEND = "stub";
  process.env.SASU_JUDGE_STUB_FILE = path.join(dir, "unused-stub.json");
  fs.writeFileSync(process.env.SASU_JUDGE_STUB_FILE, "{}");
  process.env.SASU_JUDGE_STUB_NO_AGENTIC = "1";
  try {
    await assert.rejects(
      runVerifyGate(dir, loadConfig(dir), "t", { prdPath, diffText: bigDiff, skipMechanical: true }),
      /over the \d+-char judge input budget/,
    );
    assert.equal(fs.existsSync(path.join(dir, "oracle-ran.txt")), false, "no judgment ran, so no oracle may have run either");
  } finally {
    delete process.env.SASU_JUDGE_STUB_NO_AGENTIC;
    delete process.env.SASU_JUDGE_BACKEND;
    delete process.env.SASU_JUDGE_STUB_FILE;
  }
});

test("PRD path: a failed oracle closes the gate even when the judge passes every lane", async () => {
  const dir = makeDir();
  const prdPath = writeScopedPrd(dir); // out/marker.txt deliberately absent
  const result = await withStub(
    dir,
    { verdict: "PASS", criteria: [{ id: "AC1", verdict: "PASS", reason: "ok", evidence: "src/widget.ts" }, { id: "AC2", verdict: "PASS", reason: "ok", evidence: "src/widget.ts" }] },
    () => runVerifyGate(dir, loadConfig(dir), "t", { prdPath, diffText: TWO_FILE_DIFF, skipMechanical: true }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.status.findings.some((f) => f.area === "oracle" && f.missing.startsWith("AC3:")));
});

// --- PRD-path evidence injection (2nd wave, phase 1 track T) ---

function writeImplementState(dir, state) {
  const stateDir = path.join(dir, "agents", "implement", "t");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(state, null, 2));
}

function writeRunArtifact(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return rel;
}

function sha256OfFile(dir, rel) {
  return crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, rel))).digest("hex");
}

/** Run the gate with the stub judge AND the prompt-capture seam active. */
function withCapture(dir, response, fn) {
  const captureDir = path.join(dir, "capture");
  process.env.SASU_JUDGE_STUB_CAPTURE_DIR = captureDir;
  return withStub(dir, response, fn).finally(() => {
    delete process.env.SASU_JUDGE_STUB_CAPTURE_DIR;
  });
}

function capturedPrompt(dir, name) {
  return fs.readFileSync(path.join(dir, "capture", `${name}.prompt.txt`), "utf8");
}

test("oracle outcomes ride into the lane prompt as settled context, with tail and provenance", async () => {
  const dir = makeDir();
  const prdPath = writeScopedPrd(dir);
  fs.writeFileSync(
    path.join(dir, prdPath),
    fs
      .readFileSync(path.join(dir, prdPath), "utf8")
      .replace(
        "- AC3. the marker artifact exists. Artifact: out/marker.txt",
        "- AC3. the oracle passes. Check: `node -e \"console.log('oracle says 42')\"`",
      ),
  );
  const result = await withCapture(
    dir,
    { verdict: "PASS", criteria: [{ id: "AC1", verdict: "PASS", reason: "ok", evidence: "src/widget.ts" }, { id: "AC2", verdict: "PASS", reason: "ok", evidence: "src/widget.ts" }] },
    () => runVerifyGate(dir, loadConfig(dir), "t", { prdPath, diffText: TWO_FILE_DIFF, skipMechanical: true }),
  );
  assert.equal(result.ok, true);
  const prompt = capturedPrompt(dir, "gate_verify-semantic");
  assert.match(prompt, /CRITERIA ALREADY SETTLED BY THE HARNESS/, "the settled section must exist");
  assert.match(prompt, /\[AC3 - settled by harness oracle\]/, "provenance names the oracle, so the judge does not re-prove it");
  assert.match(prompt, /oracle says 42/, "the retained stdout tail is shown, not discarded after the substring test");
  assert.doesNotMatch(prompt, /- AC3:/, "the settled criterion never appears in the judged criteria list");
  const artifact = readArtifacts(dir).find((a) => a.stage === "semantic");
  assert.match(artifact.oracle[0].tail, /oracle says 42/, "the oracle outcome records its bounded tail");
});

test("registered per-AC evidence reaches only the owning lane; ambiguous V-row evidence goes lane-wide", async () => {
  const dir = makeDir();
  const nine = criteria(9); // two lanes: AC1-AC5 / AC6-AC9
  const ac2Log = writeRunArtifact(dir, "agents/implement/t/artifacts/logs/ac2.log", "runtime proof for AC2 only\n");
  const v1Log = writeRunArtifact(dir, "agents/implement/t/artifacts/logs/v1.log", "v1 command log tail line\n");
  const v2Log = writeRunArtifact(dir, "agents/implement/t/artifacts/logs/v2.log", "ambiguous evidence body\n");
  writeImplementState(dir, {
    tasks: [{ id: "T1", status: "complete" }],
    acceptanceCriteria: [{ id: "AC2", requirements: [], artifacts: [{ kind: "log", path: ac2Log, description: "runtime capture" }] }],
    verification: [
      // Covers names AC7 -> routed to lane 2 as a recorded verify-run check.
      { id: "V1", matrix: { covers: "AC7" }, artifacts: [{ kind: "command-log", path: v1Log, command: "node run-check.js", exitCode: 0 }] },
      // Covers names nothing -> ambiguous mapping must inject lane-wide, not drop.
      { id: "V2", matrix: { covers: "" }, artifacts: [{ kind: "log", path: v2Log, description: "who owns this" }] },
    ],
  });
  const result = await withCapture(
    dir,
    {
      byPurpose: {
        "lane:1": laneVerdicts(nine.slice(0, 5).map((c) => c.id), null),
        "lane:2": laneVerdicts(nine.slice(5).map((c) => c.id), null),
      },
    },
    () => runVerifyGate(dir, loadConfig(dir), "t", { criteria: nine, diffText: SMALL_DIFF, skipMechanical: true }),
  );
  assert.equal(result.ok, true);
  const lane1 = capturedPrompt(dir, "gate_verify-semantic_lane_1");
  const lane2 = capturedPrompt(dir, "gate_verify-semantic_lane_2");
  assert.match(lane1, /runtime proof for AC2 only/, "the owning lane sees the artifact content");
  assert.doesNotMatch(lane2, /runtime proof for AC2 only/, "a foreign lane never sees another criterion's artifact");
  assert.match(lane2, /v1 command log tail line/, "the V-row command log reaches the lane owning its covered AC");
  assert.doesNotMatch(lane1, /v1 command log tail line/);
  assert.match(lane2, /verify-run recorded on V1/, "the recorded check states its provenance, not 'just now'");
  assert.match(lane2, /the tree may have changed since/, "a non-fresh recorded pass says so honestly");
  assert.match(lane1, /ambiguous evidence body/, "unmappable V-row evidence goes to every lane");
  assert.match(lane2, /ambiguous evidence body/);
  assert.match(lane1, /\[V2\]/, "lane-wide material is labeled by its owner id");

  // Freshness honesty: every injected file is hash-pinned into the inputs.
  const artifact = readArtifacts(dir).find((a) => a.stage === "semantic");
  for (const rel of [ac2Log, v1Log, v2Log]) {
    const pin = artifact.inputs.find((i) => i.path === rel);
    assert.ok(pin, `${rel} must be pinned in the artifact inputs`);
    assert.equal(pin.sha256, sha256OfFile(dir, rel), `${rel} pin must hash the raw bytes`);
    assert.equal(pin.kind, "evidence");
  }
  // The manifest records what each lane saw: paths + hashes + owner, no content.
  assert.deepEqual(artifact.lanes[0].injected.evidence.map((e) => [e.criterionId, e.path]).sort(), [["AC2", ac2Log], ["V2", v2Log]].sort());
  assert.deepEqual(artifact.lanes[1].injected.checks, [{ criterionId: "AC7", command: "node run-check.js", exitCode: 0, path: v1Log }]);

  // Changing an injected evidence file after the PASS makes it stale.
  assert.equal(readGateStatus(dir, loadConfig(dir), "t").verify.effective, "PASS");
  fs.appendFileSync(path.join(dir, ac2Log), "tampered\n");
  const status = readGateStatus(dir, loadConfig(dir), "t").verify;
  assert.equal(status.effective, "STALE", "a changed evidence file must stale the PASS");
  assert.deepEqual(status.staleInputs, [{ path: ac2Log, reason: "changed" }]);
});

test("only the newest run of a command is injected; older runs are skipped without being read", async () => {
  const dir = makeDir();
  // mark.js verify-run writes one TIMESTAMPED log path per execution, so
  // same-path supersede never collapses them: a V row accumulated every
  // historical run and the exit-1 rows rode into the judge beside the current
  // exit-0 row, unordered, each fully read first.
  const oldLog = writeRunArtifact(dir, "agents/implement/t/artifacts/logs/v1-2020.log", "FIRST RUN OUTPUT: 3 failures\n");
  const newLog = writeRunArtifact(dir, "agents/implement/t/artifacts/logs/v1-2026.log", "LATEST RUN OUTPUT: all green\n");
  const otherLog = writeRunArtifact(dir, "agents/implement/t/artifacts/logs/v1-lint.log", "LINT OUTPUT: clean\n");
  writeImplementState(dir, {
    tasks: [{ id: "T1", status: "complete" }],
    verification: [
      {
        id: "V1",
        matrix: { covers: "AC1" },
        artifacts: [
          // Deliberately out of order in state, so recency has to come from
          // createdAt rather than from array position.
          { kind: "command-log", path: newLog, command: "node test.js", exitCode: 0, createdAt: "2026-08-11T00:00:00.000Z" },
          { kind: "command-log", path: oldLog, command: "node test.js", exitCode: 1, createdAt: "2020-01-01T00:00:00.000Z" },
          // A DIFFERENT command is not history: it keeps its own newest row.
          { kind: "command-log", path: otherLog, command: "node lint.js", exitCode: 0, createdAt: "2020-01-01T00:00:00.000Z" },
        ],
      },
    ],
  });
  const result = await withCapture(
    dir,
    { verdict: "PASS", criteria: [{ id: "AC1", verdict: "PASS", reason: "ok", evidence: "the latest run is green" }] },
    () => runVerifyGate(dir, loadConfig(dir), "t", { criteria: criteria(1), diffText: SMALL_DIFF, skipMechanical: true }),
  );
  assert.equal(result.ok, true, JSON.stringify(result.status?.findings));
  const prompt = capturedPrompt(dir, "gate_verify-semantic");
  assert.match(prompt, /LATEST RUN OUTPUT: all green/, "the newest run of the command is the row's current result");
  assert.doesNotMatch(prompt, /FIRST RUN OUTPUT/, "an older run of the same command is history, not evidence");
  assert.match(prompt, /LINT OUTPUT: clean/, "a different command keeps its own newest run");
  assert.match(prompt, /at 2026-08-11T00:00:00\.000Z/, "the provenance stamps WHEN the check ran, so an old pass cannot read as current");

  const artifact = readArtifacts(dir).find((a) => a.stage === "semantic");
  assert.deepEqual(
    artifact.injectionOmitted.filter((o) => o.path === oldLog),
    [{ ownerId: "V1", path: oldLog, reason: "superseded by a newer run of the same command" }],
    "the selection is auditable: the skipped run is named with its reason",
  );
  // Skipped without being read means skipped without being pinned - the judge
  // never saw those bytes, so a later edit must not stale this PASS.
  assert.equal(artifact.inputs.some((i) => i.path === oldLog), false, "a never-read artifact is never pinned");
  assert.ok(artifact.inputs.some((i) => i.path === newLog));
  assert.equal(readGateStatus(dir, loadConfig(dir), "t").verify.effective, "PASS");
  fs.appendFileSync(path.join(dir, oldLog), "edited long after the fact\n");
  assert.equal(readGateStatus(dir, loadConfig(dir), "t").verify.effective, "PASS",
    "editing a superseded log the judge never read must not stale the PASS");
});

test("a missing newest log falls back to the newest surviving run, not to nothing", async () => {
  const dir = makeDir();
  // Ranking a log that is gone from disk used to drop BOTH rows: the older one
  // as "superseded", the newer as "file not found", so the judge silently lost
  // a check it had seen before. Recency must be decided among the logs that
  // still exist.
  const oldLog = writeRunArtifact(dir, "agents/implement/t/artifacts/logs/v1-2020.log", "SURVIVING RUN OUTPUT: all green\n");
  const goneLog = "agents/implement/t/artifacts/logs/v1-2026.log";
  writeImplementState(dir, {
    tasks: [{ id: "T1", status: "complete" }],
    verification: [
      {
        id: "V1",
        matrix: { covers: "AC1" },
        artifacts: [
          { kind: "command-log", path: goneLog, command: "node test.js", exitCode: 0, createdAt: "2026-08-11T00:00:00.000Z" },
          { kind: "command-log", path: oldLog, command: "node test.js", exitCode: 0, createdAt: "2020-01-01T00:00:00.000Z" },
        ],
      },
    ],
  });
  const result = await withCapture(
    dir,
    { verdict: "PASS", criteria: [{ id: "AC1", verdict: "PASS", reason: "ok", evidence: "the surviving run is green" }] },
    () => runVerifyGate(dir, loadConfig(dir), "t", { criteria: criteria(1), diffText: SMALL_DIFF, skipMechanical: true }),
  );
  assert.equal(result.ok, true, JSON.stringify(result.status?.findings));
  assert.match(capturedPrompt(dir, "gate_verify-semantic"), /SURVIVING RUN OUTPUT: all green/,
    "the surviving log still reaches the judge");
  const artifact = readArtifacts(dir).find((a) => a.stage === "semantic");
  assert.deepEqual(
    artifact.injectionOmitted.filter((o) => o.path === goneLog),
    [{ ownerId: "V1", path: goneLog, reason: "file not found" }],
    "the vanished log is reported as missing, never as superseded by itself",
  );
  assert.ok(artifact.inputs.some((i) => i.path === oldLog), "the log the judge read is pinned");
});

test("the project config is a judged input: declaring a new mechanical check stales a PASS", async () => {
  const dir = makeGitDir();
  const contractPath = writeContract(dir, 1);
  // agents/config.json DECLARES the mechanical commands this gate runs, so it
  // cannot be bookkeeping. After agents/** left the vouched fingerprint,
  // nothing else pinned it: adding a failing test command left the PASS intact
  // and the newly declared check never ran before completion.
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agents", "config.json"), JSON.stringify({ verify: { commands: {} } }));
  const pass = await withStub(
    dir,
    { verdict: "PASS", criteria: [{ id: "AC1", verdict: "PASS", reason: "ok", evidence: "widget.js" }] },
    () => runVerifyGate(dir, loadConfig(dir), "t", { contractPath, skipMechanical: true }),
  );
  assert.equal(pass.ok, true, JSON.stringify(pass.status?.findings));
  assert.ok(verifyGates(dir).inputs.some((i) => i.path === path.join("agents", "config.json")),
    "the config is pinned alongside the judged document");
  assert.equal(readGateStatus(dir, loadConfig(dir), "t").verify.effective, "PASS");

  fs.writeFileSync(
    path.join(dir, "agents", "config.json"),
    JSON.stringify({ verify: { commands: { test: "node -e \"process.exit(1)\"" } } }),
  );
  const status = readGateStatus(dir, loadConfig(dir), "t").verify;
  assert.equal(status.effective, "STALE", "a newly declared check must force re-verification");
  assert.deepEqual(status.staleInputs, [{ path: path.join("agents", "config.json"), reason: "changed" }]);
});

test("image evidence: attachability and the byte budget are decided from the stat, once, before any read", async () => {
  const dir = makeDir();
  // 5MB+ of PNG-named bytes. Reading it just to drop it was pure waste (V rows
  // accumulate large artifacts), so the decision moved ahead of the read - and
  // an artifact skipped without being read must not be pinned either, because
  // the judge was never told it exists.
  const bigShot = writeRunArtifact(dir, "agents/implement/t/artifacts/shots/big.png", "P".repeat(5 * 1024 * 1024 + 1));
  const smallShot = writeRunArtifact(dir, "agents/implement/t/artifacts/shots/small.png", "PNGBYTES");
  writeImplementState(dir, {
    acceptanceCriteria: [
      { id: "AC1", artifacts: [{ kind: "screenshot", path: bigShot, description: "way over budget" }] },
      { id: "AC2", artifacts: [{ kind: "screenshot", path: smallShot, description: "fine" }] },
    ],
  });
  const response = { verdict: "PASS", criteria: [{ id: "AC1", verdict: "PASS", reason: "ok", evidence: "x" }, { id: "AC2", verdict: "PASS", reason: "ok", evidence: "x" }] };
  // Evidence injection is the PRD path, and the PRD is also the pinned input
  // the PASS needs: a record with an empty input list reads as unverifiable
  // (STALE), which would mask what this test is about. AC3 is oracle-backed.
  fs.mkdirSync(path.join(dir, "out"), { recursive: true });
  fs.writeFileSync(path.join(dir, "out", "marker.txt"), "made it");
  const options = { prdPath: writeScopedPrd(dir), diffText: SMALL_DIFF, skipMechanical: true };

  const overBudget = await withStub(dir, response, () => runVerifyGate(dir, loadConfig(dir), "t", options));
  assert.equal(overBudget.ok, true);
  let artifact = readArtifacts(dir).find((a) => a.stage === "semantic");
  assert.deepEqual(
    artifact.injectionOmitted,
    [{ ownerId: "AC1", path: bigShot, reason: `image is ${5 * 1024 * 1024 + 1} bytes, over the ${5 * 1024 * 1024}-byte attachment budget` }],
    "the oversized image is omitted with its measured size",
  );
  assert.equal(artifact.inputs.some((i) => i.path === bigShot), false, "an image dropped before the read is never pinned");
  assert.ok(artifact.inputs.some((i) => i.path === smallShot), "the attachable image is pinned");
  assert.ok(artifact.lanes[0].injected.evidence.some((e) => e.path === smallShot));

  // Same stat-driven decision, other reason: a backend with no attachment
  // support cannot receive any image, whatever its size.
  process.env.SASU_JUDGE_STUB_NO_ATTACHMENTS = "1";
  try {
    const noAttach = await withStub(dir, response, () => runVerifyGate(dir, loadConfig(dir), "t", options));
    assert.equal(noAttach.ok, true);
    // Read the SECOND round's artifact through the history row that names it,
    // never by directory order.
    const history = verifyGates(dir).history;
    assert.equal(history.length, 2);
    artifact = JSON.parse(fs.readFileSync(path.join(dir, history[1].artifact), "utf8"));
    assert.deepEqual(
      artifact.injectionOmitted.map((o) => [o.path, o.reason]).sort(),
      [[bigShot, "judge backend has no image attachment support"], [smallShot, "judge backend has no image attachment support"]].sort(),
    );
    assert.deepEqual(artifact.inputs.filter((i) => i.kind === "evidence"), [], "no image is pinned when none can be attached");
  } finally {
    delete process.env.SASU_JUDGE_STUB_NO_ATTACHMENTS;
  }
});

test("oversized injected artifacts are excerpted with an explicit marker; past the lane budget they are omitted with a count", async () => {
  const dir = makeDir();
  const big = `HEAD-MARKER\n${"x".repeat(70_000)}\nTAIL-MARKER\n`;
  const bigLog = writeRunArtifact(dir, "agents/implement/t/artifacts/logs/big.log", big);
  // ~30KB: the ~40k-char excerpt of big.log plus this file exceeds the 64KB
  // per-lane injected-evidence budget, so this one must be omitted (loudly).
  const secondLog = writeRunArtifact(dir, "agents/implement/t/artifacts/logs/second.log", `second artifact body\n${"s".repeat(30_000)}\n`);
  writeImplementState(dir, {
    acceptanceCriteria: [
      { id: "AC1", artifacts: [{ kind: "log", path: bigLog, description: "big" }] },
      { id: "AC2", artifacts: [{ kind: "log", path: secondLog, description: "small but over budget" }] },
    ],
  });
  const result = await withCapture(
    dir,
    { verdict: "PASS", criteria: [{ id: "AC1", verdict: "PASS", reason: "ok", evidence: "x" }, { id: "AC2", verdict: "PASS", reason: "ok", evidence: "x" }] },
    () => runVerifyGate(dir, loadConfig(dir), "t", { criteria: criteria(2), diffText: SMALL_DIFF, skipMechanical: true }),
  );
  assert.equal(result.ok, true);
  const prompt = capturedPrompt(dir, "gate_verify-semantic");
  assert.match(prompt, /HEAD-MARKER/, "the excerpt keeps the head");
  assert.match(prompt, /TAIL-MARKER/, "the excerpt keeps the tail");
  assert.match(prompt, /TRUNCATED \d+ bytes for judge input budget/, "truncation is explicit inside the excerpt");
  assert.match(prompt, /bounded excerpt of a larger file/, "the head line names the excerpt as bounded");
  // The full-cap excerpt consumes the lane budget, so the second artifact is
  // omitted - loudly, in the prompt and in the manifest.
  assert.doesNotMatch(prompt, /second artifact body/);
  assert.match(prompt, /1 more artifact\(s\) omitted for the judge input budget/);
  const artifact = readArtifacts(dir).find((a) => a.stage === "semantic");
  assert.equal(artifact.lanes[0].injected.omittedCount, 1);
  const bigEntry = artifact.lanes[0].injected.evidence.find((e) => e.path === bigLog);
  assert.equal(bigEntry.truncated, true);
  assert.equal(bigEntry.bytes, Buffer.byteLength(big), "the manifest records the FULL file size");
  const pin = artifact.inputs.find((i) => i.path === bigLog);
  assert.equal(pin.sha256, sha256OfFile(dir, bigLog), "the pin hashes the full file, not the excerpt");
  // The omitted artifact is still pinned: the judge was told it exists, and a
  // later change to it must stale the record like any other injected input.
  assert.ok(artifact.inputs.some((i) => i.path === secondLog));
});

test("evidence owned by settled or unknown criteria is skipped; unreadable artifacts land in injectionOmitted", async () => {
  const dir = makeDir();
  fs.mkdirSync(path.join(dir, "out"), { recursive: true });
  fs.writeFileSync(path.join(dir, "out", "marker.txt"), "made it");
  const prdPath = writeScopedPrd(dir); // AC3 is oracle-backed -> never judged
  const ac3Log = writeRunArtifact(dir, "agents/implement/t/artifacts/logs/ac3.log", "oracle-owned artifact body\n");
  writeImplementState(dir, {
    acceptanceCriteria: [
      { id: "AC3", artifacts: [{ kind: "log", path: ac3Log, description: "oracle AC evidence" }] },
      { id: "AC1", artifacts: [{ kind: "log", path: "agents/implement/t/artifacts/logs/gone.log", description: "missing file" }] },
    ],
  });
  const result = await withCapture(
    dir,
    { verdict: "PASS", criteria: [{ id: "AC1", verdict: "PASS", reason: "ok", evidence: "src/widget.ts" }, { id: "AC2", verdict: "PASS", reason: "ok", evidence: "src/widget.ts" }] },
    () => runVerifyGate(dir, loadConfig(dir), "t", { prdPath, diffText: TWO_FILE_DIFF, skipMechanical: true }),
  );
  assert.equal(result.ok, true);
  const prompt = capturedPrompt(dir, "gate_verify-semantic");
  assert.doesNotMatch(prompt, /oracle-owned artifact body/, "an oracle-settled criterion's artifact would only duplicate a decided verdict");
  const artifact = readArtifacts(dir).find((a) => a.stage === "semantic");
  assert.deepEqual(artifact.injectionOmitted, [{ ownerId: "AC1", path: "agents/implement/t/artifacts/logs/gone.log", reason: "file not found" }]);
  assert.ok(!artifact.inputs.some((i) => i.path === ac3Log), "a skipped artifact is not pinned - the judge never saw it");
});

test("one artifact covering several of a lane's criteria rides once with every criterion label merged", async () => {
  const dir = makeDir();
  const shared = writeRunArtifact(dir, "agents/implement/t/artifacts/logs/shared.log", "shared proof body\n");
  // The same file registered under AC1 and AC2: the per-lane path dedupe used
  // to keep only the first entry's label, so the judge read AC2's proof as
  // absent (reproduced: an artifact covering AC2+AC4 rendered as [AC2] only).
  writeImplementState(dir, {
    acceptanceCriteria: [
      { id: "AC1", artifacts: [{ kind: "log", path: shared }] },
      { id: "AC2", artifacts: [{ kind: "log", path: shared }] },
    ],
  });
  const result = await withCapture(
    dir,
    { verdict: "PASS", criteria: [{ id: "AC1", verdict: "PASS", reason: "ok", evidence: "x" }, { id: "AC2", verdict: "PASS", reason: "ok", evidence: "x" }] },
    () => runVerifyGate(dir, loadConfig(dir), "t", { criteria: criteria(2), diffText: SMALL_DIFF, skipMechanical: true }),
  );
  assert.equal(result.ok, true);
  const prompt = capturedPrompt(dir, "gate_verify-semantic");
  assert.match(prompt, /\[AC1, AC2\] agents\/implement\/t\/artifacts\/logs\/shared\.log/, "the retained entry carries BOTH criterion labels");
  assert.equal(prompt.split("shared proof body").length - 1, 1, "the artifact body rides exactly once");
  // Registered (not harness-collected) framing covers it (F1/R1 split).
  assert.match(prompt, /REGISTERED EVIDENCE \(registered by the implementing session; origin NOT verified by the harness/);
  const artifact = readArtifacts(dir).find((a) => a.stage === "semantic");
  assert.deepEqual(artifact.lanes[0].injected.evidence.map((e) => e.criterionId), ["AC1, AC2"]);
});

test("injected check tails are charged against the per-lane evidence budget and drop whole past it", async () => {
  const dir = makeDir();
  // Nine ~8.5KB verify-run log tails at an 8KB rendered cost each: the first
  // eight fill the 64KB lane budget (8 x 8000 = 64000 <= 65536), the ninth
  // must drop its TAIL only - the command/exit-code row always rides.
  const verification = [];
  for (let i = 1; i <= 9; i += 1) {
    const rel = writeRunArtifact(dir, `agents/implement/t/artifacts/logs/v${i}.log`, `TAIL-V${i} ${"x".repeat(8_500)}\n`);
    verification.push({
      id: `V${i}`,
      matrix: { covers: "AC1" },
      artifacts: [{ kind: "command-log", path: rel, command: `node check-${i}.js`, exitCode: 0 }],
    });
  }
  writeImplementState(dir, { verification });
  const result = await withCapture(
    dir,
    { verdict: "PASS", criteria: [{ id: "AC1", verdict: "PASS", reason: "ok", evidence: "x" }, { id: "AC2", verdict: "PASS", reason: "ok", evidence: "x" }] },
    () => runVerifyGate(dir, loadConfig(dir), "t", { criteria: criteria(2), diffText: SMALL_DIFF, skipMechanical: true }),
  );
  assert.equal(result.ok, true);
  const prompt = capturedPrompt(dir, "gate_verify-semantic");
  assert.match(prompt, /TAIL-V1 /, "tails inside the budget ride");
  assert.match(prompt, /TAIL-V8 /);
  assert.doesNotMatch(prompt, /TAIL-V9 /, "the over-budget tail is dropped whole");
  assert.match(prompt, /the implement harness ran `node check-9\.js`/, "the dropped tail's check row still rides");
  assert.match(prompt, /\[output tail omitted for the judge input budget/, "the drop is explicit, never silent");
  const artifact = readArtifacts(dir).find((a) => a.stage === "semantic");
  assert.equal(artifact.lanes[0].injected.omittedTailCount, 1);
  const dropped = artifact.lanes[0].injected.checks.filter((c) => c.tailOmitted === true);
  assert.deepEqual(dropped.map((c) => c.command), ["node check-9.js"]);
});

test("settled oracle tails share the per-lane budget; the settled note always rides", async () => {
  const dir = makeDir();
  const prdPath = writeScopedPrd(dir);
  // Four ~9KB oracle outputs after a 60KB registered artifact (40KB excerpt
  // cost): AC3-AC5 tails fit (40000 + 3 x 8000 = 64000), AC6's must drop -
  // but its settled NOTE still rides, because the judge must know the
  // criterion is decided.
  fs.writeFileSync(
    path.join(dir, prdPath),
    fs
      .readFileSync(path.join(dir, prdPath), "utf8")
      .replace(
        "- AC3. the marker artifact exists. Artifact: out/marker.txt",
        [
          '- AC3. oracle A. Check: `node -e "console.log(\'A\'.repeat(9000))"`',
          '- AC4. oracle B. Check: `node -e "console.log(\'B\'.repeat(9000))"`',
          '- AC5. oracle C. Check: `node -e "console.log(\'C\'.repeat(9000))"`',
          '- AC6. oracle D. Check: `node -e "console.log(\'D\'.repeat(9000))"`',
        ].join("\n"),
      ),
  );
  const bigLog = writeRunArtifact(dir, "agents/implement/t/artifacts/logs/big.log", "x".repeat(60_000));
  writeImplementState(dir, { acceptanceCriteria: [{ id: "AC1", artifacts: [{ kind: "log", path: bigLog }] }] });
  const result = await withCapture(
    dir,
    { verdict: "PASS", criteria: [{ id: "AC1", verdict: "PASS", reason: "ok", evidence: "x" }, { id: "AC2", verdict: "PASS", reason: "ok", evidence: "x" }] },
    () => runVerifyGate(dir, loadConfig(dir), "t", { prdPath, diffText: TWO_FILE_DIFF, skipMechanical: true }),
  );
  assert.equal(result.ok, true);
  const prompt = capturedPrompt(dir, "gate_verify-semantic");
  assert.match(prompt, /A{100}/, "in-budget settled tails ride");
  assert.match(prompt, /C{100}/);
  assert.doesNotMatch(prompt, /D{100}/, "the over-budget settled tail is dropped whole");
  assert.match(prompt, /\[AC6 - settled by harness oracle\]/, "the settled note always rides");
  assert.match(prompt, /\[output tail omitted for the judge input budget; the settled verdict above stands\]/);
  const artifact = readArtifacts(dir).find((a) => a.stage === "semantic");
  assert.equal(artifact.lanes[0].injected.omittedTailCount, 1);
});

// --- FAIL-side rerun short-circuit (2nd wave, phase 2) ----------------------
// A SEMANTIC-judge FAIL re-run on the identical judged diff (same base),
// identical vouched tree, identical pinned inputs, and unchanged implement
// evidence can only reproduce itself; the gate refuses at $0 (no attempt, no
// judge call, no history row). Everything that CAN legitimately change the
// verdict - tree drift, a different --base, a contract edit outside the
// vouched tree, new implement evidence, a user override - must break the
// refusal, and mechanical/oracle FAILs (whose causes live outside the
// fingerprint) never refuse at all. These tests judge REAL git diffs: the
// diffText seam records diffSource "injected" and never arms the refusal.

/** A temp project that is a real git checkout with a base commit, so tree fingerprints and `git diff HEAD` exist. */
function makeGitDir() {
  const dir = makeDir();
  fs.writeFileSync(path.join(dir, "widget.js"), "module.exports = () => null;\n");
  for (const args of [["init", "-q"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base"]]) {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  }
  // The change under judgment: a tracked modification, so the git-derived
  // diff at the default base (HEAD) is non-empty.
  fs.appendFileSync(path.join(dir, "widget.js"), "render();\n");
  return dir;
}

function gitHead(dir) {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function gitCommitAll(dir, message) {
  for (const args of [["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message]]) {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  }
}

const FAIL_TWO = {
  verdict: "FAIL",
  criteria: [
    { id: "AC1", verdict: "PASS", reason: "ok", evidence: "x hunk" },
    { id: "AC2", verdict: "FAIL", reason: "no persistence in the diff" },
  ],
};

function verifyGates(dir) {
  return gatesState(dir).gates.verify;
}

test("short-circuit: an identical tree after a semantic FAIL refuses at zero cost; drift re-runs", async () => {
  const dir = makeGitDir();
  const contractPath = writeContract(dir, 2);
  const run = () =>
    withStub(dir, FAIL_TWO, () => runVerifyGate(dir, loadConfig(dir), "t", { contractPath, skipMechanical: true }));

  const first = await run();
  assert.equal(first.ok, false);
  const afterFirst = verifyGates(dir);
  assert.equal(afterFirst.attempts, 1);
  assert.ok(afterFirst.treeFingerprint, "the FAIL must pin the tree it was earned on");
  assert.equal(afterFirst.failedStage, "semantic", "a judge FAIL records its stage");
  assert.equal(afterFirst.diffSource, `git:${gitHead(dir)}`,
    "the record pins the base RESOLVED to a commit SHA, never the ref string");
  assert.equal(afterFirst.usedLiveMaterial, false,
    "a diff-only round records that its material was reproducible; only that may arm the refusal");

  await assert.rejects(run(), (error) => {
    assert.match(error.message, /rerun short-circuit/);
    assert.match(error.message, /semantic-judge FAIL/, "the refusal claims inevitability only for the semantic case");
    assert.match(error.message, new RegExp(`git:${gitHead(dir)}`), "the refusal names the judged-diff identity");
    assert.match(error.message, /close the run out honestly as blocked/,
      "the component that refuses names the terminal exit it creates, not just the re-run advice");
    assert.match(error.message, /fallback-mode vouched fingerprint/, "the refusal names the fingerprint mode");
    assert.match(error.message, /no persistence in the diff/, "the recorded findings are replayed");
    assert.match(error.message, /--base/, "the refusal points at the corrected-base escape");
    assert.match(error.message, /gate override/, "the user escape hatch is named");
    assert.match(error.message, /No gate attempt was recorded and no judge call was made/);
    return true;
  });
  const afterRefusal = verifyGates(dir);
  assert.equal(afterRefusal.attempts, 1, "a refusal must not charge an attempt");
  assert.equal(afterRefusal.totalAttempts, 1, "a refusal is not a run");
  assert.equal(afterRefusal.history.length, 1, "a refusal must not append a history row");
  assert.equal(gatesState(dir).judgeCalls.length, 1, "a refusal must not spend a judge call");

  // Tree drift is the honest fix-loop shape: the rerun is a real attempt again.
  fs.appendFileSync(path.join(dir, "widget.js"), "persistHarder();\n");
  const rerun = await run();
  assert.equal(rerun.ok, false);
  assert.equal(verifyGates(dir).attempts, 2);
  assert.equal(gatesState(dir).judgeCalls.length, 2);
});

test("short-circuit: a corrected --base rerun judges a different diff and must run", async () => {
  const dir = makeGitDir();
  const contractPath = writeContract(dir, 2);
  const baseSha = gitHead(dir);
  // Commit the implementation, then leave only unrelated noise in the working
  // tree: the default base (HEAD) judges a diff MISSING the implementation -
  // the exact reproduced trap, where the harness's own empty-diff/oversized
  // recovery advice says "point --base at the commit you started from" and the
  // old refusal predicate then swallowed that corrected rerun.
  gitCommitAll(dir, "implementation");
  fs.writeFileSync(path.join(dir, "notes.js"), "// unrelated noise\n");

  const first = await withStub(dir, FAIL_TWO, () =>
    runVerifyGate(dir, loadConfig(dir), "t", { contractPath, skipMechanical: true }));
  assert.equal(first.ok, false);
  assert.equal(verifyGates(dir).failedStage, "semantic");
  const headSha = gitHead(dir);
  assert.equal(verifyGates(dir).diffSource, `git:${headSha}`);
  const artifact = readArtifacts(dir).find((a) => a.stage === "semantic");
  assert.equal(artifact.diffSource, `git:${headSha}`, "the gate artifact stamps the git provenance of the judged diff");
  const pinnedFingerprint = verifyGates(dir).treeFingerprint.vouched;

  // Same base, same tree: still refused.
  await assert.rejects(
    withStub(dir, FAIL_TWO, () => runVerifyGate(dir, loadConfig(dir), "t", { contractPath, skipMechanical: true })),
    /rerun short-circuit/,
  );

  // Corrected base: a DIFFERENT judged diff (now containing the
  // implementation) - a different question, so the gate must run it.
  const rerun = await withStub(
    dir,
    { verdict: "PASS", criteria: [{ id: "AC1", verdict: "PASS", reason: "ok", evidence: "widget.js" }, { id: "AC2", verdict: "PASS", reason: "ok", evidence: "widget.js" }] },
    () => runVerifyGate(dir, loadConfig(dir), "t", { contractPath, baseRef: baseSha, skipMechanical: true }),
  );
  assert.equal(rerun.ok, true, "the corrected-base rerun executes and may PASS");
  assert.equal(verifyGates(dir).verdict, "PASS");
  assert.equal(verifyGates(dir).diffSource, `git:${baseSha}`, "the new record names the base it judged");
  // The disarm must rest on diffSource ALONE. Only the base moved: the stub
  // response swap (FAIL -> PASS) writes agents/stub.json, which the vouched set
  // excluded only after the namespace-wide exclusion landed - before that this
  // assertion failed and the "corrected base re-runs" claim was confounded by
  // tree drift.
  assert.equal(verifyGates(dir).treeFingerprint.vouched, pinnedFingerprint,
    "nothing but the base changed: the vouched fingerprint must be byte-identical across the swap");
});

test("short-circuit: a moved base ref re-runs even though the worktree never moved", async () => {
  // Two commits, so `start` has somewhere to move to WITHOUT touching a single
  // byte of the worktree - the whole point of the case. C0 is where the work
  // began; C1 lands an unrelated file the base can absorb.
  const dir = makeDir();
  const git = (...args) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  fs.writeFileSync(path.join(dir, "widget.js"), "module.exports = () => null;\n");
  fs.writeFileSync(path.join(dir, "extra.js"), "// v0\n");
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "c0");
  const c0 = gitHead(dir);
  fs.writeFileSync(path.join(dir, "extra.js"), "// v1\n");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "c1");
  const c1 = gitHead(dir);
  // The work under judgment stays dirty in the worktree from here on.
  fs.appendFileSync(path.join(dir, "widget.js"), "render();\n");
  const contractPath = writeContract(dir, 2);
  git("branch", "-f", "start", c0);

  const run = (response) =>
    withStub(dir, response, () =>
      runVerifyGate(dir, loadConfig(dir), "t", { contractPath, baseRef: "start", skipMechanical: true }));

  const first = await run(FAIL_TWO);
  assert.equal(first.ok, false);
  assert.equal(verifyGates(dir).diffSource, `git:${c0}`, "the ref is resolved at record time, never stored as 'git:start'");
  const pinnedFingerprint = verifyGates(dir).treeFingerprint.vouched;
  await assert.rejects(run(FAIL_TWO), /rerun short-circuit/, "an unmoved ref on an unchanged tree is the same question");

  // The trap: re-point `start` at C1 with the worktree untouched. `git diff
  // start` no longer contains the extra.js hunk, so it is a genuinely different
  // judged diff - and the commit-invariant fingerprint cannot see the move at
  // all, so a ref-string comparison refused this rerun forever.
  git("branch", "-f", "start", c1);
  const rerun = await run({
    verdict: "PASS",
    criteria: [{ id: "AC1", verdict: "PASS", reason: "ok", evidence: "widget.js" }, { id: "AC2", verdict: "PASS", reason: "ok", evidence: "widget.js" }],
  });
  assert.equal(rerun.ok, true, "a moved base is a different judged diff and must run");
  assert.equal(verifyGates(dir).diffSource, `git:${c1}`);
  assert.equal(verifyGates(dir).treeFingerprint.vouched, pinnedFingerprint,
    "the worktree never moved: only diffSource could have broken this refusal");
});

test("short-circuit: an unresolvable base fails on the diff, never on a refusal", async () => {
  const dir = makeGitDir();
  const contractPath = writeContract(dir, 2);
  const run = (baseRef) =>
    withStub(dir, FAIL_TWO, () => runVerifyGate(dir, loadConfig(dir), "t", { contractPath, baseRef, skipMechanical: true }));
  const first = await run(undefined);
  assert.equal(first.ok, false);
  await assert.rejects(run(undefined), /rerun short-circuit/, "the honest rerun is armed");

  // A base that cannot be pinned to a SHA degrades to a non-armable identity
  // rather than guessing, so the refusal cannot swallow the run; the diff itself
  // is what fails loudly on a bogus base.
  await assert.rejects(run("no-such-ref"), (error) => {
    assert.doesNotMatch(error.message, /rerun short-circuit/);
    assert.match(error.message, /no-such-ref/);
    return true;
  });
  assert.equal(verifyGates(dir).attempts, 1, "the failed resolution spends nothing either way");
});

test("short-circuit: a capture-fed semantic FAIL never refuses - its material is not in the tree", async () => {
  const dir = makeGitDir();
  // The reproduced 2026-08-11 shape, one layer up from the mechanical case: a
  // `capture:` command re-runs only when the gate runs, and it read gitignored
  // service state. The FAIL was earned on bytes the vouched fingerprint cannot
  // see, so fixing that state out of tree leaves the fingerprint identical -
  // and a diff-only refusal would have been permanent.
  fs.writeFileSync(path.join(dir, ".gitignore"), "out/\nlive-state.txt\n");
  fs.writeFileSync(path.join(dir, "live-state.txt"), "BROKEN\n");
  fs.mkdirSync(path.join(dir, "agents", "quick", "t"), { recursive: true });
  const contractPath = "agents/quick/t/contract.md";
  const capture = "node -e \"const f=require('fs');f.mkdirSync('out',{recursive:true});f.writeFileSync('out/state.txt',f.readFileSync('live-state.txt','utf8'))\"";
  fs.writeFileSync(
    path.join(dir, contractPath),
    `---\ntopic: t\nstatus: active\n---\n\n## Goal\n\nExercise the verify gate.\n\n## Acceptance Criteria\n\n- AC1. renders\n- AC2. persists\n  - capture: \`${capture}\` -> out/state.txt\n`,
  );
  const run = (response) =>
    withStub(dir, response, () => runVerifyGate(dir, loadConfig(dir), "t", { contractPath, skipMechanical: true }));

  const first = await run(FAIL_TWO);
  assert.equal(first.ok, false);
  const record = verifyGates(dir);
  assert.equal(record.failedStage, "semantic");
  assert.equal(record.usedLiveMaterial, true, "a round fed by a capture is stamped as non-reproducible");
  assert.equal(record.history[record.history.length - 1].usedLiveMaterial, true,
    "the history row mirrors the stamp so the arming-time consistency check can compare them");
  const pinnedFingerprint = record.treeFingerprint.vouched;

  // The out-of-tree fix: gitignored, so the vouched fingerprint cannot move.
  fs.writeFileSync(path.join(dir, "live-state.txt"), "OK\n");
  const rerun = await run({
    verdict: "PASS",
    criteria: [{ id: "AC1", verdict: "PASS", reason: "ok", evidence: "widget.js" }, { id: "AC2", verdict: "PASS", reason: "ok", evidence: "out/state.txt says OK" }],
  });
  assert.equal(rerun.ok, true, "the rerun must execute: the capture re-reads live state the fingerprint is blind to");
  assert.equal(verifyGates(dir).treeFingerprint.vouched, pinnedFingerprint,
    "the fingerprint really is identical - only usedLiveMaterial could have broken this refusal");
});

test("short-circuit: an agentic-lane semantic FAIL never refuses - the judge read live files", async () => {
  const dir = makeGitDir();
  const contractPath = writeContract(dir, 2);
  // An oversized lane diff drops to the read-only agentic judge, which Reads
  // whatever is on disk (gitignored files included) instead of judging the
  // fenced diff. That FAIL is not reproducible-by-construction either.
  fs.writeFileSync(path.join(dir, "big.ts"), `export const x = [\n${"  1,\n".repeat(Math.ceil(VERIFY_DIFF_MAX_CHARS / 5))}];\n`);
  const run = (response) =>
    withStub(dir, response, () => runVerifyGate(dir, loadConfig(dir), "t", { contractPath, skipMechanical: true }));

  const first = await run(FAIL_TWO);
  assert.equal(first.ok, false);
  const artifact = readArtifacts(dir).find((a) => a.stage === "semantic");
  assert.equal(artifact.lanes[0].agenticFallback, true, "the lane really went agentic");
  assert.equal(verifyGates(dir).usedLiveMaterial, true, "an agentic lane is stamped as non-reproducible");

  const rerun = await run(FAIL_TWO);
  assert.equal(rerun.ok, false);
  assert.equal(verifyGates(dir).attempts, 2, "an agentic-lane FAIL must re-run, not refuse");
});

test("short-circuit: a check-fed semantic FAIL never refuses - the harness ran it against live state", async () => {
  const dir = makeGitDir();
  // The producer the first live-material stamp missed: a criterion `check:`
  // runs every round and its output tail rides into the judging lane under
  // prompt text saying the harness observed the running system. The `curl`
  // shape - a probe that exits 0 while REPORTING failure - is what makes this
  // a semantic FAIL rather than an oracle/mechanical one, so failedStage is
  // "semantic" and only usedLiveMaterial can break the refusal.
  fs.writeFileSync(path.join(dir, ".gitignore"), "live-state.txt\n");
  fs.writeFileSync(path.join(dir, "live-state.txt"), "BROKEN\n");
  fs.mkdirSync(path.join(dir, "agents", "quick", "t"), { recursive: true });
  const contractPath = "agents/quick/t/contract.md";
  const check = "node -e \"process.stdout.write('service state: '+require('fs').readFileSync('live-state.txt','utf8'))\"";
  fs.writeFileSync(
    path.join(dir, contractPath),
    `---\ntopic: t\nstatus: active\n---\n\n## Goal\n\nExercise the verify gate.\n\n## Acceptance Criteria\n\n- AC1. renders\n- AC2. persists\n  - check: \`${check}\`\n`,
  );
  const run = (response) => withStub(dir, response, () => runVerifyGate(dir, loadConfig(dir), "t", { contractPath }));

  const first = await run(FAIL_TWO);
  assert.equal(first.ok, false);
  const record = verifyGates(dir);
  assert.equal(record.failedStage, "semantic", "the check exited 0, so no oracle/mechanical stage closed the gate");
  assert.equal(record.usedLiveMaterial, true, "a round whose lane carries a live check tail is not reproducible-by-construction");
  const pinnedFingerprint = record.treeFingerprint.vouched;

  fs.writeFileSync(path.join(dir, "live-state.txt"), "READY\n");
  const rerun = await run(FAIL_TWO);
  assert.equal(rerun.ok, false);
  assert.equal(verifyGates(dir).attempts, 2, "the rerun must execute: the check re-reads state the fingerprint is blind to");
  assert.equal(verifyGates(dir).treeFingerprint.vouched, pinnedFingerprint,
    "the fingerprint really is identical - only usedLiveMaterial could have broken this refusal");
});

test("short-circuit: a contract FAIL and the terminal predicate agree when implement state moves", async () => {
  const dir = makeGitDir();
  const contractPath = writeContract(dir, 2);
  const run = () => withStub(dir, FAIL_TWO, () => runVerifyGate(dir, loadConfig(dir), "t", { contractPath, skipMechanical: true }));

  assert.equal((await run()).ok, false);
  assert.equal(verifyGates(dir).docKind, "contract", "the round stamps which document it judged");

  // A same-slug implement state, touched after the FAIL. It is not part of a
  // contract round's judged material (only the PRD path injects it), so the
  // gate refuses the rerun - and the terminal predicate must say the same, or
  // the Stop hook demands a re-run the gate refuses: the original livelock.
  fs.mkdirSync(path.join(dir, "agents", "implement", "t"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "agents", "implement", "t", "state.json"),
    JSON.stringify({ updatedAt: new Date(Date.now() + 60_000).toISOString(), tasks: [] }),
  );
  await assert.rejects(run(), /rerun short-circuit/, "the gate ignores implement state on a contract round");
  assert.equal(verifyRerunWouldBeRefused(dir, "t"), true, "the terminal predicate must read the same evidence the gate did");
  assert.equal(verifyGates(dir).attempts, 1, "the refusal spent nothing");
});

test("short-circuit: a pre-field record (no live-material stamp) never refuses", async () => {
  const dir = makeGitDir();
  const contractPath = writeContract(dir, 2);
  const run = () =>
    withStub(dir, FAIL_TWO, () => runVerifyGate(dir, loadConfig(dir), "t", { contractPath, skipMechanical: true }));
  await run();
  // A file written before the stamp existed cannot prove its material was
  // diff-only, so the safe default is not arming.
  const gatesPath = path.join(dir, "agents", "gates", "t", "gates.json");
  const state = JSON.parse(fs.readFileSync(gatesPath, "utf8"));
  delete state.gates.verify.usedLiveMaterial;
  delete state.gates.verify.history[state.gates.verify.history.length - 1].usedLiveMaterial;
  fs.writeFileSync(gatesPath, JSON.stringify(state, null, 2));
  const rerun = await run();
  assert.equal(rerun.ok, false);
  assert.equal(verifyGates(dir).attempts, 2, "an unstamped record must re-run, not refuse");
});

test("short-circuit: a record with no doc-kind stamp never refuses", async () => {
  const dir = makeGitDir();
  const contractPath = writeContract(dir, 2);
  const run = () =>
    withStub(dir, FAIL_TWO, () => runVerifyGate(dir, loadConfig(dir), "t", { contractPath, skipMechanical: true }));
  await run();
  // Without the stamp the gate and the terminal predicate cannot agree on
  // whether the implement run's evidence counts as judged material, and a
  // predicate that disagrees with the gate IS the livelock. So an unstamped
  // record must re-run rather than refuse - and the terminal predicate must
  // not call the run over either.
  const gatesPath = path.join(dir, "agents", "gates", "t", "gates.json");
  const state = JSON.parse(fs.readFileSync(gatesPath, "utf8"));
  delete state.gates.verify.docKind;
  delete state.gates.verify.history[state.gates.verify.history.length - 1].docKind;
  fs.writeFileSync(gatesPath, JSON.stringify(state, null, 2));
  assert.equal(verifyRerunWouldBeRefused(dir, "t"), false, "an unstamped record is not terminal");
  const rerun = await run();
  assert.equal(rerun.ok, false);
  assert.equal(verifyGates(dir).attempts, 2, "an unstamped record must re-run, not refuse");
});

test("short-circuit: a record whose stamps disagree with its latest history row never arms", async () => {
  const dir = makeGitDir();
  const contractPath = writeContract(dir, 2);
  const run = () =>
    withStub(dir, FAIL_TWO, () => runVerifyGate(dir, loadConfig(dir), "t", { contractPath, skipMechanical: true }));
  await run();
  await assert.rejects(run(), /rerun short-circuit/, "the honest write arms it");

  // Mixed-dist writes: an older dist's recordGateResult rewrites
  // verdict/findings/lastRunAt without knowing the stage/diff/live stamps,
  // stranding stale stamps under a verdict they never described. Every field the
  // record and its latest row share must agree, or the reader must not trust
  // either of them.
  const gatesPath = path.join(dir, "agents", "gates", "t", "gates.json");
  const pristine = fs.readFileSync(gatesPath, "utf8");
  const mutations = {
    "a rewritten lastRunAt": (record) => { record.lastRunAt = "2999-01-01T00:00:00.000Z"; },
    "a row-only verdict": (record) => { record.history[record.history.length - 1].verdict = "BLOCK"; },
    "a dropped row diffSource": (record) => { delete record.history[record.history.length - 1].diffSource; },
    "a dropped row failedStage": (record) => { delete record.history[record.history.length - 1].failedStage; },
    "a row-only live-material stamp": (record) => { record.history[record.history.length - 1].usedLiveMaterial = true; },
    "a dropped row docKind": (record) => { delete record.history[record.history.length - 1].docKind; },
    "a row docKind the record contradicts": (record) => { record.history[record.history.length - 1].docKind = "prd"; },
    "an emptied history": (record) => { record.history = []; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const state = JSON.parse(pristine);
    mutate(state.gates.verify);
    const attemptsBefore = state.gates.verify.attempts;
    fs.writeFileSync(gatesPath, JSON.stringify(state, null, 2));
    const rerun = await run();
    assert.equal(rerun.ok, false, name);
    assert.equal(verifyGates(dir).attempts, attemptsBefore + 1, `${name}: must re-run rather than trust mixed-dist stamps`);
  }
});

test("short-circuit: a legacy ref-string diffSource can never refuse anything", async () => {
  const dir = makeGitDir();
  const contractPath = writeContract(dir, 2);
  const run = () =>
    withStub(dir, FAIL_TWO, () => runVerifyGate(dir, loadConfig(dir), "t", { contractPath, skipMechanical: true }));
  await run();
  // Pre-SHA-pinning files carry "git:HEAD" / "git:start": a pointer name, which
  // cannot prove the judged diff is still the same one. Unmatched, never armed.
  const gatesPath = path.join(dir, "agents", "gates", "t", "gates.json");
  const state = JSON.parse(fs.readFileSync(gatesPath, "utf8"));
  state.gates.verify.diffSource = "git:HEAD";
  state.gates.verify.history[state.gates.verify.history.length - 1].diffSource = "git:HEAD";
  fs.writeFileSync(gatesPath, JSON.stringify(state, null, 2));
  const rerun = await run();
  assert.equal(rerun.ok, false);
  assert.equal(verifyGates(dir).attempts, 2, "a legacy ref-string record must re-run, not refuse");
});

test("short-circuit: an injected diff (test seam) records diffSource=injected and never arms the refusal", async () => {
  const dir = makeGitDir();
  const contractPath = writeContract(dir, 2);
  const run = () =>
    withStub(dir, FAIL_TWO, () => runVerifyGate(dir, loadConfig(dir), "t", { contractPath, diffText: SMALL_DIFF, skipMechanical: true }));
  const first = await run();
  assert.equal(first.ok, false);
  const record = verifyGates(dir);
  assert.equal(record.failedStage, "semantic");
  assert.equal(record.diffSource, "injected", "a diffText round is stamped as injected, indistinguishable no more");
  assert.equal(readArtifacts(dir).find((a) => a.stage === "semantic").diffSource, "injected");
  // Identical tree, identical injected bytes: still a real run - an injected
  // diff has no git provenance, so the refusal may never rest on it.
  const second = await run();
  assert.equal(second.ok, false);
  assert.equal(verifyGates(dir).attempts, 2, "an injected-diff FAIL must not refuse the rerun");
});

test("short-circuit: a contract edit outside the vouched tree breaks the refusal via the input pins", async () => {
  const dir = makeGitDir();
  const contractPath = writeContract(dir, 2);
  const run = () =>
    withStub(dir, FAIL_TWO, () => runVerifyGate(dir, loadConfig(dir), "t", { contractPath, skipMechanical: true }));
  await run();
  await assert.rejects(run(), /rerun short-circuit/);
  // agents/quick/** is harness bookkeeping the fingerprint is blind to, so
  // only the recorded input hash can notice this edit.
  fs.appendFileSync(path.join(dir, contractPath), "\nThe goal grew a clarification.\n");
  const rerun = await run();
  assert.equal(rerun.ok, false, "an edited contract is a changed judgment input and must re-run");
  assert.equal(verifyGates(dir).attempts, 2);
});

test("short-circuit: gate override and a user-driven rerun are never swallowed", async () => {
  const dir = makeGitDir();
  const contractPath = writeContract(dir, 2);
  const run = () =>
    withStub(dir, FAIL_TWO, () => runVerifyGate(dir, loadConfig(dir), "t", { contractPath, skipMechanical: true }));
  await run();
  await assert.rejects(run(), /rerun short-circuit/);
  const gatesPath = path.join(dir, "agents", "gates", "t", "gates.json");
  const state = JSON.parse(fs.readFileSync(gatesPath, "utf8"));
  state.gates.verify.overridden = true;
  fs.writeFileSync(gatesPath, JSON.stringify(state, null, 2));
  const rerun = await run();
  assert.equal(rerun.ok, false, "an overridden record is a user decision; a re-run must execute");
  assert.equal(verifyGates(dir).attempts, 2);
});

test("short-circuit: a mechanical FAIL pins its tree but never refuses - its fix may live outside the fingerprint", async () => {
  const dir = makeGitDir();
  const contractPath = writeContract(dir, 2);
  // The reproduced 2026-08-11 case: the mechanical command reads a gitignored
  // marker the vouched fingerprint cannot see. Creating it is the legitimate
  // fix, leaves the fingerprint byte-identical, and the old predicate then
  // refused the rerun with a false "can only reproduce that verdict".
  fs.writeFileSync(path.join(dir, ".gitignore"), "marker.txt\n");
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "agents", "config.json"),
    JSON.stringify({ verify: { commands: { test: `node -e "process.exit(require('fs').existsSync('marker.txt')?0:2)"` } } }),
  );

  const first = await withStub(dir, "poison - the judge must never be consulted", () =>
    runVerifyGate(dir, loadConfig(dir), "t", { contractPath }));
  assert.equal(first.ok, false);
  const record = verifyGates(dir);
  assert.equal(record.verdict, "FAIL");
  assert.equal(record.failedStage, "mechanical", "the record names the stage that failed");
  assert.ok(record.treeFingerprint, "a mechanical FAIL still pins the tree it was earned on (item 10)");

  // The out-of-tree fix: gitignored, so the vouched fingerprint is identical.
  fs.writeFileSync(path.join(dir, "marker.txt"), "present\n");
  const rerun = await withStub(
    dir,
    { verdict: "PASS", criteria: [{ id: "AC1", verdict: "PASS", reason: "ok", evidence: "widget.js" }, { id: "AC2", verdict: "PASS", reason: "ok", evidence: "widget.js" }] },
    () => runVerifyGate(dir, loadConfig(dir), "t", { contractPath }),
  );
  assert.equal(rerun.ok, true, "the identical-fingerprint rerun after the out-of-tree fix must execute and may PASS");
  assert.equal(verifyGates(dir).verdict, "PASS");
  assert.equal(verifyGates(dir).history.length, 2, "the rerun is a real recorded run");
});

test("short-circuit: new implement evidence (state.json updatedAt) breaks the refusal on the PRD path", async () => {
  const dir = makeGitDir();
  fs.mkdirSync(path.join(dir, "out"), { recursive: true });
  fs.writeFileSync(path.join(dir, "out", "marker.txt"), "made it");
  const prdPath = writeScopedPrd(dir);
  const seedImplement = (updatedAt) =>
    writeImplementState(dir, { tasks: [{ id: "T1", status: "complete" }], updatedAt });
  seedImplement("2020-01-01T00:00:00.000Z");
  const run = () =>
    withStub(dir, FAIL_TWO, () => runVerifyGate(dir, loadConfig(dir), "t", { prdPath, skipMechanical: true }));

  const first = await run();
  assert.equal(first.ok, false);
  await assert.rejects(run(), /rerun short-circuit/, "stale evidence and an identical tree can only reproduce the FAIL");

  // Registered evidence moved after the attempt: the rerun may now see more
  // than the recorded round did, so it must execute.
  seedImplement(new Date(Date.now() + 60_000).toISOString());
  const rerun = await run();
  assert.equal(rerun.ok, false);
  assert.equal(verifyGates(dir).attempts, 2);
});

// --- digest-guard path naming (gate-side oracle executor) -------------------

test("oracle digest guard names the paths the command moved, not just a boolean", () => {
  const dir = makeGitDir();
  const { outcomes } = runAcOracles(dir, loadConfig(dir), [
    {
      id: "AC1",
      text: "mutates",
      oracle: { kind: "check", command: `node -e "require('fs').writeFileSync('dirty.txt','x')"` },
    },
  ]);
  assert.equal(outcomes[0].digestViolation, true);
  assert.equal(outcomes[0].met, false);
  assert.deepEqual(outcomes[0].changedPaths, ["+dirty.txt"], "the outcome records the moved paths");
  assert.match(outcomes[0].reason, /digest guard: \+dirty\.txt/, "the finding text names the path");
});
