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
  isExcludedFromDiff,
  partitionVerifyCriteria,
  readGateStatus,
  runVerifyGate,
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

function withStub(dir, response, fn, extraEnv = {}) {
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
  const keys = ["SASU_JUDGE_BACKEND", "SASU_JUDGE_STUB_FILE", ...Object.keys(extraEnv)];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.SASU_JUDGE_BACKEND = "stub";
  process.env.SASU_JUDGE_STUB_FILE = stubFile;
  for (const [key, value] of Object.entries(extraEnv)) process.env[key] = value;
  const restore = () => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
  return fn().finally(restore);
}

function gatesState(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "agents", "runs", "t", "gates", "gates.json"), "utf8"));
}

function readArtifacts(dir) {
  const artifactsDir = path.join(dir, "agents", "runs", "t", "gates", "artifacts");
  return fs.readdirSync(artifactsDir).map((f) => JSON.parse(fs.readFileSync(path.join(artifactsDir, f), "utf8")));
}

// --- diff curation predicate ---

test("isExcludedFromDiff: the whole agents/ namespace is out, not just gates/quick", () => {
  for (const file of ["agents/runs/t/gates/gates.json", "agents/gates/t/gates.json", "agents/quick/demo/contract.md", "agents/prd/prd.md", "agents/interview/qa-log.md", "agents/config.json"]) {
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
  const stateDir = path.join(dir, "agents", "runs", "t", "gates");
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
      assert.match(error.message, /split the change/, "the recovery advice must preserve the full judged diff");
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
    // The simulated agentic judge attests one read round; an unbacked PASS
    // with a known-zero trace is rejected by the read-evidence guard.
    { SASU_JUDGE_STUB_TOOL_ROUNDS: "1" },
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
  // Profile stays routine; the budget is verify's own measured one, not the
  // profile's xhigh - verify is a closed diff-vs-criterion comparison where
  // extra reasoning budget bought nothing (2026-08-29 measurement).
  assert.ok(state.judgeCalls.every((c) => c.profile === "routine" && c.effort === "medium"), "lanes use the routine profile at verify's measured budget");

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

test("splitDiffByFile and diffStatFromText read one full-diff grammar", () => {
  const blocks = splitDiffByFile(TWO_FILE_DIFF);
  assert.deepEqual(blocks.map((b) => b.path), ["src/widget.ts", "docs/readme.md"]);
  const stat = diffStatFromText(TWO_FILE_DIFF);
  assert.match(stat, /src\/widget\.ts \| \+1 -0/);
  assert.match(stat, /docs\/readme\.md \| \+1 -1/);
  assert.match(stat, /2 file\(s\) changed/);
});

// A prelint-clean semantic PRD. Repository commands and file ownership are
// intentionally absent.
function writeSemanticPrd(dir) {
  const prd = `---
topic: "fixture"
status: "ready"
human_approval: "approved"
review_profile: "standard"
---

# PRD: fixture

## Goal

A widget that renders and persists.

## Non-goals

Nothing beyond the widget.

## Decisions

| D-n | 결정 | 근거 |
| --- | --- | --- |
| D-01 | 위젯 상태는 로컬에 저장한다 | 서버가 없다 |

## Behaviors

| # | 사용자가 관찰하는 행동 | 검사 방법 | 결정 |
| --- | --- | --- | --- |
| B1 | the widget renders | judge: the diff adds a render path | D-01 |
| B2 | the widget persists its state | judge: the diff writes state on change | D-01 |

## Technical structure

No major technical structure change expected.

## Risks

None.
`;
  fs.writeFileSync(path.join(dir, "prd.md"), prd);
  return "prd.md";
}

test("PRD path: every semantic lane receives the full curated diff", async () => {
  const dir = makeDir();
  fs.mkdirSync(path.join(dir, "out"), { recursive: true });
  fs.writeFileSync(path.join(dir, "out", "marker.txt"), "made it");
  const prdPath = writeSemanticPrd(dir);
  const result = await withStub(
    dir,
    { verdict: "PASS", criteria: [{ id: "B1", verdict: "PASS", reason: "ok", evidence: "src/widget.ts" }, { id: "B2", verdict: "PASS", reason: "ok", evidence: "src/widget.ts" }] },
    () => runVerifyGate(dir, loadConfig(dir), "t", { prdPath, diffText: TWO_FILE_DIFF, skipMechanical: true }),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.judgedCriteriaIds, ["B1", "B2"]);
  const artifact = readArtifacts(dir).find((a) => a.stage === "semantic");
  assert.equal(artifact.lanes[0].scope, undefined);
  assert.equal(artifact.lanes[0].diffChars, TWO_FILE_DIFF.length);
});



// --- PRD-path evidence injection (2nd wave, phase 1 track T) ---

function writeImplementState(dir, state) {
  const stateDir = path.join(dir, "agents", "runs", "t");
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

test("the config pin covers absence: a config CREATED after a PASS stales it too", async () => {
  const dir = makeGitDir();
  const contractPath = writeContract(dir, 1);
  // "No config" declares "run the detected defaults", so the absence is part
  // of what the verdict rests on. Pinning only the present case left the hole
  // this harness exists to close: a config written after the PASS was compared
  // against nothing, so a freshly declared verify.commands.test rode to
  // completion having never run once.
  assert.equal(fs.existsSync(path.join(dir, "agents", "config.json")), false, "the fixture starts with no config");
  const pass = await withStub(
    dir,
    { verdict: "PASS", criteria: [{ id: "AC1", verdict: "PASS", reason: "ok", evidence: "widget.js" }] },
    () => runVerifyGate(dir, loadConfig(dir), "t", { contractPath, skipMechanical: true }),
  );
  assert.equal(pass.ok, true, JSON.stringify(pass.status?.findings));
  const configRel = path.join("agents", "config.json");
  assert.ok(verifyGates(dir).inputs.some((i) => i.path === configRel && i.kind === "config"),
    "absence is pinned, not skipped");
  assert.equal(readGateStatus(dir, loadConfig(dir), "t").verify.effective, "PASS",
    "absent-then-still-absent must stay fresh, or every no-config project would read STALE");

  fs.writeFileSync(
    path.join(dir, configRel),
    JSON.stringify({ verify: { commands: { test: "node -e \"process.exit(1)\"" } } }),
  );
  const status = readGateStatus(dir, loadConfig(dir), "t").verify;
  assert.equal(status.effective, "STALE", "a check declared after the PASS must force re-verification");
  assert.deepEqual(status.staleInputs, [{ path: configRel, reason: "changed" }]);
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
  for (const args of [["init", "-q"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "base"]]) {
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
  for (const args of [["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message]]) {
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
  assert.match(afterFirst.judgedDiffSha256, /^[0-9a-f]{64}$/, "the FAIL must pin the diff it was earned on");
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
    assert.match(error.message, /diff sha256 [0-9a-f]{12}/, "the refusal names the pin it compared");
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
  const pinnedDiff = verifyGates(dir).judgedDiffSha256;

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
  // The worktree never moved - the stub response swap (FAIL -> PASS) writes
  // agents/stub.json, which the diff excludes - so the pin moved for exactly one
  // reason: a different base produces a different diff. That is the pin
  // subsuming the question diffSource used to answer alone.
  assert.notEqual(verifyGates(dir).judgedDiffSha256, pinnedDiff,
    "a corrected base is a different diff, and the pin says so on its own");
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
  git("-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "c0");
  const c0 = gitHead(dir);
  fs.writeFileSync(path.join(dir, "extra.js"), "// v1\n");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "c1");
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
  const pinnedDiff = verifyGates(dir).judgedDiffSha256;
  await assert.rejects(run(FAIL_TWO), /rerun short-circuit/, "an unmoved ref on an unchanged tree is the same question");

  // The trap: re-point `start` at C1 with the worktree untouched. `git diff
  // start` no longer contains the extra.js hunk, so it is a genuinely different
  // judged diff - and the commit-invariant TREE fingerprint could not see the
  // move at all, which is how a ref-string comparison refused this rerun
  // forever. A diff-body pin sees it directly.
  git("branch", "-f", "start", c1);
  const rerun = await run({
    verdict: "PASS",
    criteria: [{ id: "AC1", verdict: "PASS", reason: "ok", evidence: "widget.js" }, { id: "AC2", verdict: "PASS", reason: "ok", evidence: "widget.js" }],
  });
  assert.equal(rerun.ok, true, "a moved base is a different judged diff and must run");
  assert.equal(verifyGates(dir).diffSource, `git:${c1}`);
  assert.notEqual(verifyGates(dir).judgedDiffSha256, pinnedDiff,
    "the worktree never moved, yet the judged diff really is different - the pin catches the moved base itself");
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
  const pinnedDiff = record.judgedDiffSha256;

  // The out-of-tree fix: gitignored, so the judged diff cannot move.
  fs.writeFileSync(path.join(dir, "live-state.txt"), "OK\n");
  const rerun = await run({
    verdict: "PASS",
    criteria: [{ id: "AC1", verdict: "PASS", reason: "ok", evidence: "widget.js" }, { id: "AC2", verdict: "PASS", reason: "ok", evidence: "out/state.txt says OK" }],
  });
  assert.equal(rerun.ok, true, "the rerun must execute: the capture re-reads live state the diff is blind to");
  assert.equal(verifyGates(dir).judgedDiffSha256, pinnedDiff,
    "the judged diff really is identical - only usedLiveMaterial could have broken this refusal");
});

test("short-circuit: an agentic-lane semantic FAIL never refuses - the judge read live files", async () => {
  const dir = makeGitDir();
  const contractPath = writeContract(dir, 2);
  // An oversized lane diff drops to the read-only agentic judge, which Reads
  // whatever is on disk (gitignored files included) instead of judging the
  // fenced diff. That FAIL is not reproducible-by-construction either.
  fs.writeFileSync(path.join(dir, "big.ts"), `export const x = [\n${"  1,\n".repeat(Math.ceil(VERIFY_DIFF_MAX_CHARS / 5))}];\n`);
  const run = (response) =>
    withStub(dir, response, () => runVerifyGate(dir, loadConfig(dir), "t", { contractPath, skipMechanical: true }),
      // This test's premise is a judge that read live files; attest the read
      // so the read-evidence guard does not reject the unbacked AC1 PASS.
      { SASU_JUDGE_STUB_TOOL_ROUNDS: "1" });

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
  const pinnedDiff = record.judgedDiffSha256;

  fs.writeFileSync(path.join(dir, "live-state.txt"), "READY\n");
  const rerun = await run(FAIL_TWO);
  assert.equal(rerun.ok, false);
  assert.equal(verifyGates(dir).attempts, 2, "the rerun must execute: the check re-reads state the diff is blind to");
  assert.equal(verifyGates(dir).judgedDiffSha256, pinnedDiff,
    "the judged diff really is identical - only usedLiveMaterial could have broken this refusal");
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
  fs.mkdirSync(path.join(dir, "agents", "runs", "t"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "agents", "runs", "t", "state.json"),
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
  const gatesPath = path.join(dir, "agents", "runs", "t", "gates", "gates.json");
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
  const gatesPath = path.join(dir, "agents", "runs", "t", "gates", "gates.json");
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
  const gatesPath = path.join(dir, "agents", "runs", "t", "gates", "gates.json");
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
  const gatesPath = path.join(dir, "agents", "runs", "t", "gates", "gates.json");
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
  const gatesPath = path.join(dir, "agents", "runs", "t", "gates", "gates.json");
  const state = JSON.parse(fs.readFileSync(gatesPath, "utf8"));
  state.gates.verify.overridden = true;
  fs.writeFileSync(gatesPath, JSON.stringify(state, null, 2));
  const rerun = await run();
  assert.equal(rerun.ok, false, "an overridden record is a user decision; a re-run must execute");
  assert.equal(verifyGates(dir).attempts, 2);
});

test("short-circuit: a mechanical FAIL pins nothing and never refuses - it failed before a diff existed", async () => {
  const dir = makeGitDir();
  const contractPath = writeContract(dir, 2);
  // The reproduced 2026-08-11 case: the mechanical command reads a gitignored
  // marker no pin can see. Creating it is the legitimate fix, leaves the judged
  // diff byte-identical, and the old predicate then refused the rerun with a
  // false "can only reproduce that verdict".
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
  // This FAIL happened before the diff was produced, so there is nothing for a
  // pin to vouch for and the honest record says so (item 10) - the base is still
  // stamped, and the stage stamp is what keeps it from ever refusing a rerun.
  assert.equal(record.judgedDiffSha256, null, "nothing was judged, so nothing is pinned");

  // The out-of-tree fix: gitignored, so the judged diff is identical.
  fs.writeFileSync(path.join(dir, "marker.txt"), "present\n");
  const rerun = await withStub(
    dir,
    { verdict: "PASS", criteria: [{ id: "AC1", verdict: "PASS", reason: "ok", evidence: "widget.js" }, { id: "AC2", verdict: "PASS", reason: "ok", evidence: "widget.js" }] },
    () => runVerifyGate(dir, loadConfig(dir), "t", { contractPath }),
  );
  assert.equal(rerun.ok, true, "the identical-diff rerun after the out-of-tree fix must execute and may PASS");
  assert.equal(verifyGates(dir).verdict, "PASS");
  assert.equal(verifyGates(dir).history.length, 2, "the rerun is a real recorded run");
});
