import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "dist", "cli.js");
const PRELINT_FIXTURES = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "fixtures", "prelint");
const QA_FIXTURE = fs.readFileSync(path.join(PRELINT_FIXTURES, "qa-clean.md"), "utf8");

function prd(profile = "standard", sourceIntake = "current conversation") {
  return `---
topic: "implement fixture"
status: "ready"
human_approval: "approved"
review_profile: "${profile}"
review_rationale: "CLI fixture"
source_intake: "${sourceIntake}"
---

# PRD: implement fixture

## 1. Summary

Prove the implement command flow.

## 2. Problem, Goal, And Users

The caller needs one closing flow.

## 3. Scope And Non-Goals

Only the CLI flow is included.

## 4. Pre-Work And Required Decisions

### 4.1 Pre-Work Before Implementation

None required.

### 4.2 Human Decisions Before PRD Approval

None required.

### 4.3 Decision Traceability For Fidelity Review

- D-01 (user, resolved): use one verify command with separate acceptance and fidelity judges.

## 5. Major Technical Structure Changes

The CLI owns state.

## 6. Requirements

- R1. The flow completes through one state. Covers AC1.

## 7. Acceptance Criteria

- AC1. A completed task can be verified and finalized from one state.

## 8. PRD-Level Tasks

- T1. Implement the flow. Covers R1.

## 9. Verification Contract

### 9.1 Test Mode Contract

| Mode | Required For Done | Covers | Human Decision |
| --- | --- | --- | --- |
| automated behavior | yes | state flow | none |
| live judge runtime | yes | judge lanes | none |

### 9.2 Required Agent Verification

| ID | Mode | Covers | Pass Intent | Required For Done | Can Be Blocked |
| --- | --- | --- | --- | --- | --- |
| V1 | automated behavior | R1, AC1 | public state flow passes its automated check | yes | no |
| V2 | automated behavior | R1, AC1 | the same public state flow remains idempotent | yes | no |
| V3 | live judge runtime | R1, AC1 | separate acceptance and fidelity judge verdicts are recorded | yes | no |

### 9.3 Human Verification

None required.

## 10. Risks And Open Decisions

None.

## 11. Implementation Guardrails

Do not add another state store.

## 12. Implementation Result Report Contract

Report the receipt.
`;
}

function makeProject({ profile = "standard", testExit = 0, sourceIntake = "current conversation" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-implement-"));
  fs.mkdirSync(path.join(root, "agents", "prd", "fixture"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", "prd", "fixture", "prd.md"), prd(profile, sourceIntake));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: `node -e "console.log('MECHANICAL-PROOF'); process.exit(${testExit})"` } }));
  for (const args of [["init", "-q"], ["add", "package.json"], ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "base"]]) {
    const run = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
  }
  return root;
}

function stub(root, profile = "standard") {
  const capture = path.join(root, "agents", "captures");
  const file = path.join(root, "agents", "judge.json");
  fs.writeFileSync(file, JSON.stringify({
    byPurpose: {
      "implement:acceptance:AC1": {
        verdict: "PASS",
        criteria: [{ id: "AC1", verdict: "PASS", reason: "one state completed", evidence: "public CLI transcript" }],
      },
      "implement:fidelity": {
        verdict: "PASS",
        checks: ["F1", "F2", "F3", "F4", "F5"].map((id) => ({ id, verdict: "PASS", reason: "preserved", evidence: "D-01" })),
      },
      // The design lane runs on every non-trivial profile. Silent by default:
      // a fixture that always leaves a comment would block every finalize
      // assertion in this file behind a disposition.
      "implement:design": { comments: [] },
      ...(profile === "high-risk" ? { "implement:risk": { verdict: "PASS", findings: [] } } : {}),
    },
  }));
  return { file, capture };
}

// Spawns must not inherit the developer's own session identity: ownership is
// derived from these env keys (cli/src/runs/session.ts), and an ambient id
// once let 33 tests pass by accident (tests/helpers/session_env.mjs).
const SESSION_ID_ENV_KEYS = ["CODEX_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID"];

function run(root, args, options = {}) {
  const env = { ...process.env, ...(options.env ?? {}) };
  for (const key of SESSION_ID_ENV_KEYS) if (!(key in (options.env ?? {}))) delete env[key];
  if (!("SASU_HERDR_ROLE" in (options.env ?? {}))) delete env.SASU_HERDR_ROLE;
  const executed = spawnSync(process.execPath, [CLI, ...args, "--json"], { cwd: root, encoding: "utf8", env });
  let json = null;
  try {
    json = JSON.parse(executed.stdout);
  } catch {
    json = { stdout: executed.stdout, stderr: executed.stderr };
  }
  return { ...executed, json };
}

// Command responses deliberately no longer echo the state (it grew to ~117k
// tokens per call on real runs); history assertions read the record itself.
function readState(root, slug = "fixture") {
  return JSON.parse(fs.readFileSync(path.join(root, "agents", "runs", slug, "state.json"), "utf8"));
}

function writeFixtureImplementation(root) {
  const state = readState(root);
  const workRoot = state.worktree?.path ?? root;
  fs.writeFileSync(path.join(workRoot, "fixture-implementation.txt"), "fixture implementation created after start\n");
}

function startAndClose(root, { sourceChange = true } = {}) {
  const started = run(root, ["implement", "start", "--prd", "agents/prd/fixture/prd.md", "--dirty-attribution", "run-owned"]);
  assert.equal(started.status, 0, started.stderr + started.stdout);
  // A completed task normally represents source work after the baseline was
  // captured. The 2026-08-25 empty-diff incident proved that fixtures which
  // close tasks without making that work accidentally exercise an invalid run.
  if (sourceChange) writeFixtureImplementation(root);
  const closed = run(root, ["implement", "task", "--id", "T1", "--evidence", "fixture implementation complete"]);
  assert.equal(closed.status, 0, closed.stderr + closed.stdout);
}

test("a qa-log-backed PRD cannot start before both PRD review gates pass", () => {
  const qaLog = "agents/interview/fixture/qa-log.md";
  const root = makeProject({ sourceIntake: qaLog });
  fs.mkdirSync(path.join(root, "agents", "interview", "fixture"), { recursive: true });
  fs.writeFileSync(path.join(root, qaLog), QA_FIXTURE);

  const refused = run(root, ["implement", "start", "--prd", "agents/prd/fixture/prd.md"]);
  assert.equal(refused.status, 2);
  assert.match(refused.json.message, /qa-log-backed PRD requires live PASS/);
  assert.match(refused.json.message, /gap-audit=NOT_RUN/);
  assert.match(refused.json.message, /spec=NOT_RUN/);
  assert.equal(fs.existsSync(path.join(root, "agents", "runs", "fixture", "state.json")), false);
});

test("a legacy agents/implement/<slug> run resolves by slug and by legacy active pointer", () => {
  const root = makeProject();
  startAndClose(root);
  // Simulate a run recorded before the unified layout: state under the legacy
  // namespace, pointer at the legacy location, nothing under agents/runs.
  fs.mkdirSync(path.join(root, "agents", "implement"), { recursive: true });
  fs.renameSync(path.join(root, "agents", "runs", "fixture"), path.join(root, "agents", "implement", "fixture"));
  fs.renameSync(
    path.join(root, "agents", "runs", ".prd-implement-active.json"),
    path.join(root, "agents", "implement", ".prd-implement-active.json"),
  );
  const pointerPath = path.join(root, "agents", "implement", ".prd-implement-active.json");
  const legacyStatePath = path.join(root, "agents", "implement", "fixture", "state.json");
  const legacyState = JSON.parse(fs.readFileSync(legacyStatePath, "utf8"));
  legacyState.runDir = "agents/implement/fixture";
  legacyState.prd.snapshotPath = "agents/implement/fixture/prd.md";
  fs.writeFileSync(legacyStatePath, JSON.stringify(legacyState));
  const pointer = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
  pointer.statePath = "agents/implement/fixture/state.json";
  fs.writeFileSync(pointerPath, JSON.stringify(pointer));

  const bySlug = run(root, ["implement", "status", "--slug", "fixture"]);
  assert.equal(bySlug.status, 0, bySlug.stderr + bySlug.stdout);
  const byPointer = run(root, ["implement", "status"]);
  assert.equal(byPointer.status, 0, byPointer.stderr + byPointer.stdout);
  // And the same slug cannot be restarted into a second, unified-layout run.
  const restart = run(root, ["implement", "start", "--prd", "agents/prd/fixture/prd.md"]);
  assert.equal(restart.status, 2);
  assert.match(restart.json.message, /implement state already exists/);
});

test("old implement state schemas fail closed with restart guidance", () => {
  const root = makeProject();
  const legacy = path.join(root, "agents", "implement", "legacy", "state.json");
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({ schema: "hoyeon.prd-implement.state.v2" }));
  const result = run(root, ["implement", "status", "--state", "agents/implement/legacy/state.json"]);
  assert.equal(result.status, 2);
  assert.match(result.json.message, /unsupported implement state schema/);
  assert.match(result.json.message, /sasu implement start/);
});

test("dirty attribution and retire cover refusal, recovery, cross-session evidence, and released occupancy", () => {
  const root = makeProject();
  fs.writeFileSync(path.join(root, "impl.txt"), "work that predates this run\n");
  const sessionA = { CLAUDE_CODE_SESSION_ID: "session-a" };
  const sessionB = { CLAUDE_CODE_SESSION_ID: "session-b" };

  const refused = run(root, ["implement", "start", "--prd", "agents/prd/fixture/prd.md"], { env: sessionA });
  assert.equal(refused.status, 2);
  assert.match(refused.json.message, /will not guess their ownership/);
  assert.match(refused.json.message, /- impl\.txt/);
  assert.match(refused.json.message, /--dirty-attribution pre-existing/);
  assert.match(refused.json.message, /--dirty-attribution run-owned/);
  assert.equal(fs.existsSync(path.join(root, "agents", "runs", "fixture", "state.json")), false);

  const started = run(root, [
    "implement", "start", "--prd", "agents/prd/fixture/prd.md", "--dirty-attribution", "pre-existing",
  ], { env: sessionA });
  assert.equal(started.status, 0, started.stderr + started.stdout);
  let state = readState(root);
  assert.equal(state.baselineAttribution.disposition, "pre-existing");
  assert.deepEqual(state.baselineAttribution.paths, [{ path: "impl.txt", disposition: "pre-existing" }]);
  assert.ok(state.initialSource.entries.some((entry) => entry.path === "impl.txt"));
  assert.equal(
    fs.readFileSync(path.join(root, state.prd.snapshotPath), "utf8"),
    fs.readFileSync(path.join(root, state.prdPath), "utf8"),
  );

  const foreign = run(root, ["implement", "retire", "--slug", "fixture"], { env: sessionB });
  assert.equal(foreign.status, 2);
  assert.match(foreign.json.message, /owned by another session/);
  assert.equal(readState(root).status, "active");

  const approval = "I approve retiring session-a's unfinished run";
  const retired = run(root, ["implement", "retire", "--slug", "fixture", "--adopt", approval], { env: sessionB });
  assert.equal(retired.status, 0, retired.stderr + retired.stdout);
  state = readState(root);
  assert.equal(state.status, "retired");
  assert.equal(state.retirement.adoptedFromSessionId, "session-a");
  assert.equal(state.retirement.adoptionEvidence, approval);
  assert.equal(state.adoptions.at(-1).evidence, approval);
  assert.equal(run(root, ["implement", "retire", "--slug", "fixture"], { env: { CLAUDE_CODE_SESSION_ID: "session-c" } }).status, 0);

  const secondPrd = path.join(root, "agents", "prd", "fixture-two", "prd.md");
  fs.mkdirSync(path.dirname(secondPrd), { recursive: true });
  fs.writeFileSync(secondPrd, prd());
  const restarted = run(root, [
    "implement", "start", "--prd", "agents/prd/fixture-two/prd.md", "--dirty-attribution", "pre-existing",
  ], { env: sessionB });
  assert.equal(restarted.status, 0, restarted.stderr + restarted.stdout);
  assert.equal(readState(root, "fixture-two").worktree, null, "a retired run no longer forces isolation");

  const runOwnedRoot = makeProject();
  fs.writeFileSync(path.join(runOwnedRoot, "impl.txt"), "this run owns these bytes\n");
  const runOwned = run(runOwnedRoot, [
    "implement", "start", "--prd", "agents/prd/fixture/prd.md", "--dirty-attribution", "run-owned",
  ]);
  assert.equal(runOwned.status, 0, runOwned.stderr + runOwned.stdout);
  const runOwnedState = readState(runOwnedRoot);
  assert.equal(runOwnedState.baselineAttribution.disposition, "run-owned");
  assert.deepEqual(runOwnedState.baselineAttribution.paths, [{ path: "impl.txt", disposition: "run-owned" }]);
  assert.equal(runOwnedState.initialSource.entries.some((entry) => entry.path === "impl.txt"), false);

  const mixedRoot = makeProject();
  fs.writeFileSync(path.join(mixedRoot, "other-session.txt"), "pre-existing bytes\n");
  fs.writeFileSync(path.join(mixedRoot, "this-run.txt"), "run-owned bytes\n");
  const mixed = run(mixedRoot, [
    "implement", "start", "--prd", "agents/prd/fixture/prd.md", "--dirty-attribution",
    JSON.stringify({ "other-session.txt": "pre-existing", "this-run.txt": "run-owned" }),
  ]);
  assert.equal(mixed.status, 0, mixed.stderr + mixed.stdout);
  const mixedState = readState(mixedRoot);
  assert.equal(mixedState.baselineAttribution.disposition, "mixed");
  assert.deepEqual(mixedState.baselineAttribution.paths, [
    { path: "other-session.txt", disposition: "pre-existing" },
    { path: "this-run.txt", disposition: "run-owned" },
  ]);
  assert.equal(mixedState.initialSource.entries.some((entry) => entry.path === "other-session.txt"), true);
  assert.equal(mixedState.initialSource.entries.some((entry) => entry.path === "this-run.txt"), false);
});

test("dirty intake presents one operator question and commit-first produces a committed baseline", () => {
  const root = makeProject();
  fs.writeFileSync(path.join(root, "impl.txt"), "work awaiting disposition\n");

  const intake = run(root, ["implement", "intake"]);
  assert.equal(intake.status, 0, intake.stderr + intake.stdout);
  assert.deepEqual(intake.json.detail.paths, ["impl.txt"]);
  assert.equal(intake.json.detail.required, true);
  assert.equal(intake.json.detail.question, "커밋되지 않은 판정 대상 파일이 있습니다. 이 작업을 어떻게 시작할까요?");
  assert.deepEqual(intake.json.detail.options.map((option) => [option.value, option.label]), [
    ["commit-first", "먼저 커밋하고 시작"],
    ["pre-existing", "기존 작업으로 이어서 시작"],
    ["run-owned", "이번 작업에 포함"],
  ]);

  assert.equal(spawnSync("git", ["add", "impl.txt"], { cwd: root }).status, 0);
  const committed = spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "save existing work"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(committed.status, 0, committed.stderr);
  const clean = run(root, ["implement", "intake"]);
  assert.equal(clean.status, 0, clean.stderr + clean.stdout);
  assert.deepEqual(clean.json.detail, { required: false, paths: [], question: null, options: [] });

  const started = run(root, ["implement", "start", "--prd", "agents/prd/fixture/prd.md"]);
  assert.equal(started.status, 0, started.stderr + started.stdout);
  const state = readState(root);
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  assert.equal(state.baselineAttribution.disposition, "clean");
  assert.equal(state.baselineAttribution.head, head);
  assert.ok(state.initialSource.entries.some((entry) => entry.path === "impl.txt"));
});

test("isolated starts carry source dirtiness and preserve its selected attribution", () => {
  const preExistingRoot = makeProject();
  fs.mkdirSync(path.join(preExistingRoot, "agents"), { recursive: true });
  fs.writeFileSync(path.join(preExistingRoot, "agents", "config.json"), JSON.stringify({ worktree: { enabled: true } }));
  fs.writeFileSync(path.join(preExistingRoot, "impl.txt"), "pre-existing bytes\n");

  const refused = run(preExistingRoot, ["implement", "start", "--prd", "agents/prd/fixture/prd.md"]);
  assert.equal(refused.status, 2);
  assert.match(refused.json.message, /sasu implement intake/);
  assert.match(refused.json.message, /- impl\.txt/);
  const recovered = run(preExistingRoot, [
    "implement", "start", "--prd", "agents/prd/fixture/prd.md", "--dirty-attribution", "pre-existing",
  ]);
  assert.equal(recovered.status, 0, recovered.stderr + recovered.stdout);
  const preExisting = readState(preExistingRoot);
  assert.ok(preExisting.worktree);
  assert.equal(fs.readFileSync(path.join(preExisting.worktree.path, "impl.txt"), "utf8"), "pre-existing bytes\n");
  assert.deepEqual(preExisting.baselineAttribution.paths, [{ path: "impl.txt", disposition: "pre-existing" }]);
  assert.ok(preExisting.initialSource.entries.some((entry) => entry.path === "impl.txt"));

  const runOwnedRoot = makeProject();
  fs.mkdirSync(path.join(runOwnedRoot, "agents"), { recursive: true });
  fs.writeFileSync(path.join(runOwnedRoot, "agents", "config.json"), JSON.stringify({ worktree: { enabled: true } }));
  fs.writeFileSync(path.join(runOwnedRoot, "impl.txt"), "run-owned bytes\n");
  const started = run(runOwnedRoot, [
    "implement", "start", "--prd", "agents/prd/fixture/prd.md", "--dirty-attribution", "run-owned",
  ]);
  assert.equal(started.status, 0, started.stderr + started.stdout);
  const runOwned = readState(runOwnedRoot);
  assert.equal(fs.readFileSync(path.join(runOwned.worktree.path, "impl.txt"), "utf8"), "run-owned bytes\n");
  assert.deepEqual(runOwned.baselineAttribution.paths, [{ path: "impl.txt", disposition: "run-owned" }]);
  assert.equal(runOwned.initialSource.entries.some((entry) => entry.path === "impl.txt"), false);
});

test("an unborn Git repository still requires attribution and keeps its files in the run-owned diff", () => {
  const root = makeProject();
  fs.rmSync(path.join(root, ".git"), { recursive: true, force: true });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: root }).status, 0);
  fs.writeFileSync(path.join(root, "impl.txt"), "work before the first commit\n");

  const refused = run(root, ["implement", "start", "--prd", "agents/prd/fixture/prd.md"]);
  assert.equal(refused.status, 2);
  assert.match(refused.json.message, /- impl\.txt/);
  assert.match(refused.json.message, /- package\.json/);

  const started = run(root, [
    "implement", "start", "--prd", "agents/prd/fixture/prd.md", "--dirty-attribution", "run-owned",
  ]);
  assert.equal(started.status, 0, started.stderr + started.stdout);
  const state = readState(root);
  assert.equal(state.initialSource.head, null);
  assert.deepEqual(state.baselineAttribution.paths, [
    { path: "impl.txt", disposition: "run-owned" },
    { path: "package.json", disposition: "run-owned" },
  ]);
  assert.equal(state.initialSource.entries.some((entry) => entry.path === "impl.txt"), false);
  assert.equal(state.initialSource.entries.some((entry) => entry.path === "package.json"), false);

  const { file, capture } = stub(root);
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  assert.equal(run(root, ["implement", "task", "--id", "T1", "--evidence", "done"]).status, 0);
  const verified = run(root, ["implement", "verify"], { env });
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);
  const prompt = fs.readFileSync(path.join(capture, "implement_acceptance_AC1.prompt.txt"), "utf8");
  assert.match(prompt, /- impl\.txt \[text,/);
  assert.match(prompt, /- package\.json \[text,/);
});

test("a real second unified round dispositions prior findings and admits only delta-grounded blockers", () => {
  const root = makeProject({ profile: "high-risk" });
  const { file, capture } = stub(root, "high-risk");
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  const configured = JSON.parse(fs.readFileSync(file, "utf8"));
  configured.byPurpose["implement:acceptance:AC1"] = {
    verdict: "FAIL",
    criteria: [{ id: "AC1", verdict: "FAIL", reason: "the first failure remains", evidence: "" }],
  };
  configured.byPurpose["implement:fidelity"] = {
    verdict: "FAIL",
    checks: ["F1", "F2", "F3", "F4", "F5"].map((id) => ({
      id,
      verdict: id === "F1" ? "FAIL" : "PASS",
      reason: id === "F1" ? "goal drift" : "preserved",
      evidence: "D-01",
    })),
  };
  configured.byPurpose["implement:risk"] = {
    verdict: "FAIL",
    findings: [{ severity: "blocking", text: "first blocking risk" }],
  };
  fs.writeFileSync(file, JSON.stringify(configured));
  startAndClose(root);
  const first = run(root, ["implement", "verify"], { env });
  assert.equal(first.status, 1, first.stderr + first.stdout);

  fs.writeFileSync(path.join(root, "impl.txt"), "round two changed this exact path\n");
  configured.byPurpose["implement:acceptance:AC1"] = {
    verdict: "FAIL",
    criteria: [{
      id: "AC1",
      verdict: "FAIL",
      reason: "a different changed-path defect exists",
      evidence: "impl.txt",
      priorDisposition: { status: "resolved", reason: "the first failure was fixed" },
      origin: "new",
      deltaBasis: { kind: "changed-path", value: "impl.txt" },
    }],
  };
  configured.byPurpose["implement:fidelity"] = {
    verdict: "PASS",
    checks: ["F1", "F2", "F3", "F4", "F5"].map((id) => ({
      id,
      verdict: "PASS",
      reason: "preserved",
      evidence: "D-01",
      ...(id === "F1" ? { priorDisposition: { status: "resolved", reason: "goal lineage restored" } } : {}),
    })),
  };
  configured.byPurpose["implement:risk"] = {
    verdict: "FAIL",
    priorDispositions: [{
      id: "RF1",
      status: "resolved",
      reason: "the first risk was removed",
      deltaBasis: { kind: "changed-path", value: "impl.txt" },
    }],
    findings: [{
      severity: "blocking",
      text: "a new risk in the changed path",
      origin: "new",
      deltaBasis: { kind: "changed-path", value: "impl.txt" },
    }],
  };
  fs.writeFileSync(file, JSON.stringify(configured));
  const second = run(root, ["implement", "verify"], { env });
  assert.equal(second.status, 1, second.stderr + second.stdout);
  assert.equal(second.json.detail.attempt.lanes.acceptance.verdict, "FAIL");
  assert.equal(second.json.detail.attempt.lanes.fidelity.verdict, "PASS");
  assert.equal(second.json.detail.attempt.lanes.risk.verdict, "FAIL");

  const latest = readState(root).verificationAttempts.at(-1);
  assert.deepEqual(latest.roundContexts.acceptance.AC1.changedPaths, ["impl.txt"]);
  assert.deepEqual(latest.roundContexts.fidelity.changedPaths, ["impl.txt"]);
  assert.deepEqual(latest.roundContexts.risk.changedPaths, ["impl.txt"]);
  assert.equal(latest.lanes.acceptance.result.criteria[0].priorDisposition.status, "resolved");
  assert.deepEqual(latest.lanes.acceptance.result.criteria[0].deltaBasis, { kind: "changed-path", value: "impl.txt" });
  assert.equal(latest.lanes.fidelity.result.checks[0].priorDisposition.status, "resolved");
  assert.deepEqual(latest.lanes.risk.result.priorDispositions, [{
    id: "RF1",
    status: "resolved",
    reason: "the first risk was removed",
    deltaBasis: { kind: "changed-path", value: "impl.txt" },
  }]);
  assert.equal(latest.lanes.risk.result.findings[0].id, "RF2");
  const ledger = readState(root).riskFindings;
  assert.equal(ledger[0].status, "fixed");
  assert.match(ledger[0].resolution.evidence, new RegExp(`attempt ${latest.id}`));
  assert.match(ledger[0].resolution.evidence, /deltaBasis changed-path=impl\.txt/);
  assert.equal(ledger[1].id, "RF2");
  assert.equal(ledger[1].status, "open");
  const prompt = fs.readFileSync(path.join(capture, "implement_risk.prompt.txt"), "utf8");
  assert.match(prompt, /PRIOR RISK RESULT/);
  assert.match(prompt, /CHANGED PATHS SINCE THE PRIOR ROUND:\n- impl\.txt/);
});

test("a partial judge error cannot erase older unresolved acceptance or risk findings", () => {
  const root = makeProject({ profile: "high-risk" });
  const { file, capture } = stub(root, "high-risk");
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  const configured = JSON.parse(fs.readFileSync(file, "utf8"));
  configured.byPurpose["implement:acceptance:AC1"] = {
    verdict: "FAIL",
    criteria: [{ id: "AC1", verdict: "FAIL", reason: "older unresolved acceptance", evidence: "" }],
  };
  configured.byPurpose["implement:risk"] = {
    verdict: "FAIL",
    findings: [{ severity: "blocking", text: "older unresolved risk" }],
  };
  fs.writeFileSync(file, JSON.stringify(configured));
  startAndClose(root);

  const first = run(root, ["implement", "verify"], { env });
  assert.equal(first.status, 1, first.stderr + first.stdout);
  const firstAttempt = readState(root).verificationAttempts.at(-1);

  // Both outputs are invalid only for their own lane. Fidelity still settles,
  // leaving a mixed partial attempt that must not become the lineage source
  // for acceptance AC1 or risk.
  configured.byPurpose["implement:acceptance:AC1"] = { verdict: "PASS", criteria: [] };
  configured.byPurpose["implement:risk"] = { verdict: "PASS", findings: [] };
  fs.writeFileSync(file, JSON.stringify(configured));
  const partial = run(root, ["implement", "verify"], { env });
  assert.equal(partial.status, 1, partial.stderr + partial.stdout);
  assert.equal(partial.json.detail.attempt.lanes.acceptance.verdict, "ERROR");
  assert.equal(partial.json.detail.attempt.lanes.risk.verdict, "ERROR");

  fs.writeFileSync(path.join(root, "impl.txt"), "the recovery changed this path\n");
  configured.byPurpose["implement:acceptance:AC1"] = {
    verdict: "PASS",
    criteria: [{
      id: "AC1",
      verdict: "PASS",
      reason: "older acceptance is fixed",
      evidence: "impl.txt",
      priorDisposition: { status: "resolved", reason: "the changed path fixes it" },
    }],
  };
  configured.byPurpose["implement:risk"] = {
    verdict: "PASS",
    priorDispositions: [{
      id: "RF1",
      status: "resolved",
      reason: "the changed path removes it",
      deltaBasis: { kind: "changed-path", value: "impl.txt" },
    }],
    findings: [],
  };
  fs.writeFileSync(file, JSON.stringify(configured));
  const recovered = run(root, ["implement", "verify"], { env });
  assert.equal(recovered.status, 0, recovered.stderr + recovered.stdout);

  const latest = readState(root).verificationAttempts.at(-1);
  assert.equal(latest.lanes.acceptance.result.criteria[0].priorDisposition.status, "resolved");
  assert.deepEqual(latest.lanes.risk.result.priorDispositions, [
    {
      id: "RF1",
      status: "resolved",
      reason: "the changed path removes it",
      deltaBasis: { kind: "changed-path", value: "impl.txt" },
    },
  ]);
  for (const name of ["implement_acceptance_AC1.prompt.txt", "implement_risk.prompt.txt"]) {
    const prompt = fs.readFileSync(path.join(capture, name), "utf8");
    assert.match(prompt, new RegExp(`PRIOR ATTEMPT: ${firstAttempt.id}`));
    assert.match(prompt, /older unresolved/);
  }
});

test("verify refuses a completed run whose run-owned change set is empty", () => {
  const root = makeProject();
  const { file, capture } = stub(root);
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  startAndClose(root, { sourceChange: false });

  const refused = run(root, ["implement", "verify"], { env });
  assert.equal(refused.status, 1, refused.stderr + refused.stdout);
  assert.equal(refused.json.detail.reason, "empty-run-owned-change-set");
  assert.match(refused.json.message, /run-owned change set is empty after 1 complete task/);
  assert.match(refused.json.message, /`sasu implement start` ran after the implementation was committed/);
  assert.match(refused.json.message, /dispositioned pre-existing at start/);
  assert.match(refused.json.message, /`sasu implement retire`/);
  assert.match(refused.json.message, /restart with `sasu implement start` before implementation begins/);
  assert.equal(readState(root).verificationAttempts.length, 0, "a refusal before any judge must not spend an attempt");
  assert.equal(run(root, ["implement", "status"]).json.detail.verification.budget.fixAttempts, 0);
  assert.equal(fs.existsSync(capture), false, "no judge may run for an empty change set");
});

test("open tasks and mechanical failures stop before either judge", () => {
  const root = makeProject({ testExit: 3 });
  const { file, capture } = stub(root);
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  assert.equal(run(root, ["implement", "start", "--prd", "agents/prd/fixture/prd.md"]).status, 0);
  const open = run(root, ["implement", "verify"], { env });
  assert.equal(open.status, 2);
  assert.match(open.json.message, /open: T1/);
  assert.equal(fs.existsSync(capture), false);

  writeFixtureImplementation(root);
  assert.equal(run(root, ["implement", "task", "--id", "T1", "--evidence", "done"]).status, 0);
  const failed = run(root, ["implement", "verify"], { env });
  assert.equal(failed.status, 1);
  assert.equal(failed.json.detail.judgeCalls, 0);
  assert.equal(fs.existsSync(capture), false);
  assert.equal(failed.json.detail.attempt.mechanical.length, 1, "V1 and V2 share one (cwd, command) execution");
  assert.deepEqual(failed.json.detail.attempt.mechanical[0].verificationIds, ["V1", "V2"]);
});

test("acceptance and fidelity run separately in parallel, then finalize converges", () => {
  const root = makeProject();
  const { file, capture } = stub(root);
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  startAndClose(root);
  fs.writeFileSync(path.join(root, "source.txt"), "SOURCE-BODY-MUST-NOT-BE-INLINED\n");
  fs.writeFileSync(path.join(root, "runtime.log"), "REGISTERED-RUNTIME-EVIDENCE\n");
  const registered = run(root, [
    "implement", "artifact", "--id", "V1", "--kind", "log", "--path", "runtime.log", "--description", "runtime proof body",
  ]);
  assert.equal(registered.status, 0, registered.stderr + registered.stdout);
  const verified = run(root, ["implement", "verify"], { env });
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);
  // Lane progress is observable from outside the process while stdout stays
  // pure JSON: an opaque verify forces callers into ps-polling loops.
  assert.match(verified.stderr, /\[implement:verify\] mechanical PASS in [\d.]+s: npm test/);
  assert.match(verified.stderr, /\[implement:verify\] acceptance AC1: PASS \(\d+s\)/);
  assert.match(verified.stderr, /\[implement:verify\] fidelity: PASS \(\d+s\)/);
  assert.match(verified.stderr, /\[implement:verify\] unified verification PASS in \d+s/);
  assert.doesNotMatch(verified.stdout, /\[implement:verify\]/, "progress must not corrupt the JSON stdout");
  const attempt = verified.json.detail.attempt;
  assert.equal(attempt.verdict, "PASS");
  assert.notEqual(attempt.lanes.acceptance.invocationId, attempt.lanes.fidelity.invocationId);
  const acceptanceInvocations = readState(root).verificationAttempts.at(-1).lanes.acceptance.result.invocations;
  assert.equal(acceptanceInvocations.length, 1);
  assert.equal(acceptanceInvocations[0].criterionId, "AC1");
  assert.ok(attempt.lanes.acceptance.startedAt <= attempt.lanes.fidelity.finishedAt);
  assert.ok(attempt.lanes.fidelity.startedAt <= attempt.lanes.acceptance.finishedAt);
  assert.equal(attempt.lanes.risk, null);
  assert.equal(attempt.mechanical.length, 1);

  const fidelityPrompt = fs.readFileSync(path.join(capture, "implement_fidelity.prompt.txt"), "utf8");
  assert.match(fidelityPrompt, /F1 Original goal preserved/);
  assert.match(fidelityPrompt, /SOURCE ROUTING: decision-traceability/);
  assert.match(fidelityPrompt, /Do not repeat code-correctness/);

  const acceptancePrompt = fs.readFileSync(path.join(capture, "implement_acceptance_AC1.prompt.txt"), "utf8");
  const acceptanceOptions = JSON.parse(fs.readFileSync(path.join(capture, "implement_acceptance_AC1.options.json"), "utf8"));
  assert.match(acceptancePrompt, /"id": "AC1"/);
  assert.match(acceptancePrompt, /MECHANICAL-PROOF/);
  assert.match(acceptancePrompt, /REGISTERED-RUNTIME-EVIDENCE/);
  assert.match(acceptancePrompt, /source\.txt \[text, \d+ bytes\]/);
  assert.doesNotMatch(acceptancePrompt, /SOURCE-BODY-MUST-NOT-BE-INLINED/);
  assert.deepEqual(acceptanceOptions, { agentic: true, cwd: fs.realpathSync(root), effort: "xhigh" });

  const failBin = path.join(root, "agents", "fail-on-call-bin");
  const sentinel = path.join(root, "agents", "unexpected-finalize-execution");
  fs.mkdirSync(failBin, { recursive: true });
  for (const name of ["npm", "claude", "codex", "chromux"]) {
    const executable = path.join(failBin, name);
    fs.writeFileSync(executable, `#!/bin/sh\ntouch ${JSON.stringify(sentinel)}\nexit 90\n`);
    fs.chmodSync(executable, 0o755);
  }
  const finalizeEnv = { ...env, PATH: `${failBin}:${process.env.PATH}` };
  const first = run(root, ["implement", "finalize"], { env: finalizeEnv });
  assert.equal(first.status, 0, first.stderr + first.stdout);
  assert.equal(first.json.detail.executionCalls, 0);
  assert.equal(fs.existsSync(sentinel), false, "finalize must not call a test, judge, browser, or capture executable");
  const receiptPath = path.join(root, first.json.detail.completion.receiptPath);
  const firstReceipt = fs.readFileSync(receiptPath, "utf8");
  const second = run(root, ["implement", "finalize"], { env: finalizeEnv });
  assert.equal(second.status, 0, second.stderr + second.stdout);
  assert.equal(second.json.detail.executionCalls, 0);
  assert.equal(fs.readFileSync(receiptPath, "utf8"), firstReceipt);
});

test("work done before implement start is still judged as run-owned", () => {
  // 2026-08-13 creator-assist: runs restarted after the implementation was
  // written judged an empty diff, and every first verify round failed on
  // "No run-owned source changes were detected."
  const root = makeProject();
  fs.writeFileSync(path.join(root, "impl.txt"), "implementation written before start\n");
  const { file, capture } = stub(root);
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  startAndClose(root);
  const verified = run(root, ["implement", "verify"], { env });
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);
  const acceptancePrompt = fs.readFileSync(path.join(capture, "implement_acceptance_AC1.prompt.txt"), "utf8");
  assert.match(acceptancePrompt, /impl\.txt \[text, \d+ bytes\]/);
  const fidelityPrompt = fs.readFileSync(path.join(capture, "implement_fidelity.prompt.txt"), "utf8");
  assert.match(fidelityPrompt, /implementation written before start/);
});

test("a backend without read-only file access fails acceptance observably instead of judging from missing code", () => {
  const root = makeProject();
  const { file, capture } = stub(root);
  const env = {
    SASU_JUDGE_BACKEND: "stub",
    SASU_JUDGE_STUB_FILE: file,
    SASU_JUDGE_STUB_CAPTURE_DIR: capture,
    SASU_JUDGE_STUB_NO_AGENTIC: "1",
  };
  startAndClose(root);
  const verified = run(root, ["implement", "verify"], { env });
  assert.equal(verified.status, 1);
  const attempt = verified.json.detail.attempt;
  assert.equal(attempt.verdict, "ERROR");
  assert.equal(attempt.lanes.acceptance.verdict, "ERROR");
  assert.match(attempt.lanes.acceptance.error.message, /requires isolated read-only evidence access/);
  assert.equal(fs.existsSync(path.join(capture, "implement_acceptance_AC1.prompt.txt")), false);
  assert.equal(fs.existsSync(path.join(capture, "implement_fidelity.prompt.txt")), true);
});

test("high-risk runs the risk judge only after both base lanes complete", () => {
  const root = makeProject({ profile: "high-risk" });
  const { file, capture } = stub(root, "high-risk");
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  startAndClose(root);
  const verified = run(root, ["implement", "verify"], { env });
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);
  const lanes = verified.json.detail.attempt.lanes;
  assert.equal(lanes.risk.verdict, "PASS");
  assert.match(verified.stderr, /\[implement:verify\] risk: PASS \(0 blocking, 0 advisory, \d+s\)/);
  assert.ok(lanes.risk.startedAt >= lanes.acceptance.finishedAt);
  assert.ok(lanes.risk.startedAt >= lanes.fidelity.finishedAt);

  const trivialRoot = makeProject({ profile: "trivial" });
  const trivialStub = stub(trivialRoot, "trivial");
  const trivialEnv = {
    SASU_JUDGE_BACKEND: "stub",
    SASU_JUDGE_STUB_FILE: trivialStub.file,
    SASU_JUDGE_STUB_CAPTURE_DIR: trivialStub.capture,
  };
  startAndClose(trivialRoot);
  const trivial = run(trivialRoot, ["implement", "verify"], { env: trivialEnv });
  assert.equal(trivial.status, 0, trivial.stderr + trivial.stdout);
  assert.equal(trivial.json.detail.attempt.lanes.risk, null);
  assert.equal(fs.existsSync(path.join(trivialStub.capture, "implement_risk.prompt.txt")), false);
});

test("oversized design and risk diffs switch to isolated changed-file access", () => {
  const root = makeProject({ profile: "high-risk" });
  const { file, capture } = stub(root, "high-risk");
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  startAndClose(root);
  fs.writeFileSync(path.join(root, "large.ts"), `export const large = "${"x".repeat(130_000)}";\n`);

  const verified = run(root, ["implement", "verify"], { env });
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);
  for (const purpose of ["implement_design", "implement_risk"]) {
    const prompt = fs.readFileSync(path.join(capture, `${purpose}.prompt.txt`), "utf8");
    const options = JSON.parse(fs.readFileSync(path.join(capture, `${purpose}.options.json`), "utf8"));
    assert.match(prompt, /diff omitted because it exceeds the 120000-character review input limit/);
    assert.match(prompt, /- large\.ts/);
    assert.deepEqual(options, { agentic: true, cwd: fs.realpathSync(root), effort: "xhigh" });
  }
});

test("an open blocking risk is ledgered outside the unified verdict, blocks finalize, and user acceptance releases it", () => {
  const root = makeProject({ profile: "high-risk" });
  const { file, capture } = stub(root, "high-risk");
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  const configured = JSON.parse(fs.readFileSync(file, "utf8"));
  configured.byPurpose["implement:risk"] = {
    verdict: "PASS",
    findings: [{ severity: "advisory", text: "consider rate limiting the retry path" }],
  };
  fs.writeFileSync(file, JSON.stringify(configured));
  startAndClose(root);

  const advisory = run(root, ["implement", "verify"], { env });
  assert.equal(advisory.status, 0, advisory.stderr + advisory.stdout);
  assert.equal(advisory.json.detail.attempt.lanes.risk.verdict, "PASS");
  // The response summarizes: no blocking findings inline, advisory as a count;
  // the full findings stay in state.json.
  assert.deepEqual(advisory.json.detail.attempt.lanes.risk.blocking, []);
  assert.equal(advisory.json.detail.attempt.lanes.risk.advisoryCount, 1);
  assert.deepEqual(readState(root).verificationAttempts.at(-1).lanes.risk.result.findings, [
    { id: "RF1", severity: "advisory", text: "consider rate limiting the retry path" },
  ]);
  assert.deepEqual(readState(root).riskFindings, [{
    id: "RF1",
    severity: "advisory",
    text: "consider rate limiting the retry path",
    originAttemptId: readState(root).verificationAttempts.at(-1).id,
    status: "open",
  }]);
  const riskPrompt = fs.readFileSync(path.join(capture, "implement_risk.prompt.txt"), "utf8");
  assert.match(riskPrompt, /Delivery evidence is out of scope/);
  assert.match(riskPrompt, /Their absence is never a finding here/);

  // A later blocking finding fails only the lane. The unified acceptance and
  // fidelity verdict stays PASS, while the ledger becomes finalize authority.
  fs.writeFileSync(path.join(root, "impl.txt"), "a changed risk-bearing path\n");
  const blockingText = "credentials are written to a world-readable log and remain visible to every local account on the host";
  configured.byPurpose["implement:risk"] = {
    verdict: "FAIL",
    priorDispositions: [{
      id: "RF1",
      status: "resolved",
      reason: "the retry path is now rate limited",
      deltaBasis: { kind: "changed-path", value: "impl.txt" },
    }],
    findings: [{
      severity: "blocking",
      text: blockingText,
      origin: "new",
      deltaBasis: { kind: "changed-path", value: "impl.txt" },
    }],
  };
  fs.writeFileSync(file, JSON.stringify(configured));
  const blocking = run(root, ["implement", "verify"], { env });
  assert.equal(blocking.status, 0, blocking.stderr + blocking.stdout);
  assert.equal(blocking.json.detail.attempt.lanes.risk.verdict, "FAIL");
  assert.equal(blocking.json.detail.attempt.verdict, "PASS");
  assert.match(blocking.json.message, /1 blocking risk finding\(s\) await resolution/);

  const state = readState(root);
  assert.equal(state.riskFindings[0].status, "fixed");
  assert.match(state.riskFindings[0].resolution.evidence, new RegExp(`attempt ${state.verificationAttempts.at(-1).id}`));
  assert.match(state.riskFindings[0].resolution.evidence, /deltaBasis changed-path=impl\.txt/);
  assert.deepEqual(state.riskFindings[1], {
    id: "RF2",
    severity: "blocking",
    text: blockingText,
    originAttemptId: state.verificationAttempts.at(-1).id,
    status: "open",
  });

  const status = run(root, ["implement", "status"]);
  assert.equal(status.status, 0, status.stderr + status.stdout);
  assert.equal(status.json.detail.counts.riskFindingsOpen, 1);
  assert.deepEqual(status.json.detail.riskFindings.open, [{
    id: "RF2",
    severity: "blocking",
    text: blockingText.slice(0, 80),
  }]);

  const refused = run(root, ["implement", "finalize"]);
  assert.equal(refused.status, 2);
  assert.match(refused.json.message, /risk finding RF2 \(blocking\) is open/);
  assert.match(refused.json.message, /fix it and re-run `sasu implement verify`/);
  assert.match(refused.json.message, /sasu implement risk --accept --id RF2 --evidence/);

  const approval = "I approve accepting RF2 for this release";
  const accepted = run(root, ["implement", "risk", "--accept", "--id", "RF2", "--evidence", approval]);
  assert.equal(accepted.status, 0, accepted.stderr + accepted.stdout);
  assert.equal(accepted.json.detail.finding.status, "accepted");
  assert.equal(accepted.json.detail.finding.resolution.evidence, approval);
  assert.deepEqual(accepted.json.detail.open, []);

  // The same operation converges without replacing the original evidence.
  const repeated = run(root, ["implement", "risk", "--accept", "--id", "RF2", "--evidence", approval]);
  assert.equal(repeated.status, 0, repeated.stderr + repeated.stdout);
  assert.match(repeated.json.message, /already accepted with the same evidence/);

  const finalized = run(root, ["implement", "finalize"]);
  assert.equal(finalized.status, 0, finalized.stderr + finalized.stdout);
  const report = fs.readFileSync(path.join(root, finalized.json.detail.completion.implementationResultPath), "utf8");
  assert.match(report, /## Risk Findings/);
  assert.match(report, /RF1 \[advisory\].*Status: fixed/s);
  assert.match(report, /deltaBasis changed-path=impl\.txt/);
  assert.match(report, /RF2 \[blocking\].*Status: accepted/s);
  assert.match(report, new RegExp(approval));
});

test("a risk ERROR stays in the attempt record without changing the unified verdict or ledger", () => {
  const root = makeProject({ profile: "high-risk" });
  const { file, capture } = stub(root, "high-risk");
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  const configured = JSON.parse(fs.readFileSync(file, "utf8"));
  configured.byPurpose["implement:risk"] = {
    verdict: "FAIL",
    findings: [{ severity: "blocking", text: "unsafe destructive write" }],
  };
  fs.writeFileSync(file, JSON.stringify(configured));
  startAndClose(root);
  const first = run(root, ["implement", "verify"], { env });
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const before = readState(root).riskFindings;
  assert.equal(before.length, 1);

  // Missing priorDispositions is invalid on round 2+, so the risk lane records
  // ERROR after its normal repair/fallback ladder. It is not a voter.
  configured.byPurpose["implement:risk"] = { verdict: "PASS", findings: [] };
  fs.writeFileSync(file, JSON.stringify(configured));
  const errored = run(root, ["implement", "verify"], { env });
  assert.equal(errored.status, 0, errored.stderr + errored.stdout);
  assert.equal(errored.json.detail.attempt.verdict, "PASS");
  assert.equal(errored.json.detail.attempt.error, null);
  assert.equal(errored.json.detail.attempt.lanes.risk.verdict, "ERROR");
  assert.equal(errored.json.detail.attempt.lanes.risk.error.code, "judge-invalid-output");
  assert.deepEqual(readState(root).riskFindings, before, "an errored review must not resolve or append ledger entries");
});

test("lane failure and malformed judge output remain independent and block finalize", () => {
  const root = makeProject();
  const { file, capture } = stub(root);
  const configured = JSON.parse(fs.readFileSync(file, "utf8"));
  configured.byPurpose["implement:fidelity"].verdict = "FAIL";
  configured.byPurpose["implement:fidelity"].checks[2].verdict = "FAIL";
  fs.writeFileSync(file, JSON.stringify(configured));
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  startAndClose(root);

  const failed = run(root, ["implement", "verify"], { env });
  assert.equal(failed.status, 1);
  assert.equal(failed.json.detail.attempt.lanes.acceptance.verdict, "PASS");
  assert.equal(failed.json.detail.attempt.lanes.fidelity.verdict, "FAIL");
  assert.equal(failed.json.detail.attempt.verdict, "FAIL");
  const refused = run(root, ["implement", "finalize"]);
  assert.equal(refused.status, 2);
  assert.match(refused.json.message, /unified verify is FAIL/);

  configured.byPurpose["implement:fidelity"] = { verdict: "PASS", checks: [] };
  fs.writeFileSync(file, JSON.stringify(configured));
  const malformed = run(root, ["implement", "verify"], { env });
  assert.equal(malformed.status, 1);
  assert.equal(malformed.json.detail.attempt.lanes.acceptance.verdict, "PASS");
  assert.equal(malformed.json.detail.attempt.lanes.fidelity.verdict, "ERROR");
  assert.equal(malformed.json.detail.attempt.lanes.fidelity.error.code, "judge-invalid-output");
  assert.equal(malformed.json.detail.attempt.verdict, "ERROR");
});

test("registered runtime evidence becomes stale when the file or the rest of the judged source changes", () => {
  const root = makeProject();
  fs.writeFileSync(path.join(root, "runtime.log"), "runtime proof\n");
  startAndClose(root);
  const register = () => run(root, [
    "implement", "artifact", "--id", "V1", "--kind", "log", "--path", "runtime.log", "--description", "runtime proof",
  ]);
  assert.equal(register().status, 0);

  // The artifact's own bytes moving is one fact, reported once, by its hash
  // pin. It is not additionally "stale": an artifact that invalidates itself
  // makes extending evidence cost a verification round for nothing.
  fs.writeFileSync(path.join(root, "runtime.log"), "changed proof\n");
  const ownChange = run(root, ["implement", "status"]).json.detail.artifactProblems.join("\n");
  assert.match(ownChange, /artifact hash changed/);
  assert.doesNotMatch(ownChange, /artifact is stale/);

  // The rest of the judged tree moving still stales it: the artifact is proof
  // about that tree.
  assert.equal(register().status, 0);
  fs.writeFileSync(path.join(root, "source.txt"), "judged source moved\n");
  const sourceChange = run(root, ["implement", "status"]).json.detail.artifactProblems.join("\n");
  assert.match(sourceChange, /artifact is stale/);
});

test("a source change after unified PASS makes finalize refuse the stale attempt", () => {
  const root = makeProject();
  const { file, capture } = stub(root);
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  fs.writeFileSync(path.join(root, "source.txt"), "judged source\n");
  startAndClose(root);
  assert.equal(run(root, ["implement", "verify"], { env }).status, 0);
  fs.writeFileSync(path.join(root, "source.txt"), "changed after pass\n");

  const stale = run(root, ["implement", "status"]);
  assert.equal(stale.json.detail.verification.verdict, "STALE");
  const finalized = run(root, ["implement", "finalize"]);
  assert.equal(finalized.status, 2);
  assert.match(finalized.json.message, /STALE because judged source changed/);
});

test("a routed qa-log change after PASS stales status and blocks finalize", () => {
  const qaLog = "agents/interview/fixture/qa-log.md";
  const root = makeProject({ sourceIntake: qaLog });
  fs.mkdirSync(path.join(root, "agents", "interview", "fixture"), { recursive: true });
  fs.writeFileSync(path.join(root, qaLog), QA_FIXTURE);
  const gateFile = path.join(root, "agents", "gate-judge.json");
  fs.writeFileSync(gateFile, JSON.stringify({ verdict: "PASS", findings: [] }));
  const gateEnv = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: gateFile };
  const gap = run(root, ["gate", "gap-audit", "--slug", "fixture", "--qa-log", qaLog], { env: gateEnv });
  assert.equal(gap.status, 0, gap.stderr + gap.stdout);
  const spec = run(root, ["gate", "spec", "--slug", "fixture", "--prd", "agents/prd/fixture/prd.md", "--qa-log", qaLog], { env: gateEnv });
  assert.equal(spec.status, 0, spec.stderr + spec.stdout);
  const { file, capture } = stub(root);
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  startAndClose(root);
  const verified = run(root, ["implement", "verify"], { env });
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);
  assert.equal(verified.json.detail.attempt.fidelityInput.routing, "decision-traceability");

  fs.writeFileSync(path.join(root, qaLog), "changed user decisions\n");
  const stale = run(root, ["implement", "status"]);
  assert.equal(stale.json.detail.verification.verdict, "STALE");
  const finalized = run(root, ["implement", "finalize"]);
  assert.equal(finalized.status, 2);
  assert.match(finalized.json.message, /fidelity source/);
});

test("an approved PRD change after PASS stales status and blocks finalize", () => {
  const root = makeProject();
  const { file, capture } = stub(root);
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  startAndClose(root);
  assert.equal(run(root, ["implement", "verify"], { env }).status, 0);
  const prdPath = path.join(root, "agents", "prd", "fixture", "prd.md");
  fs.appendFileSync(prdPath, "\nPost-approval mutation.\n");

  const stale = run(root, ["implement", "status"]);
  assert.equal(stale.json.detail.verification.verdict, "STALE");
  assert.match(stale.json.detail.prdProblem, /PRD changed/);
  const finalized = run(root, ["implement", "finalize"]);
  assert.equal(finalized.status, 2);
  assert.match(finalized.json.message, /PRD changed after implement start/);
});

test("an approved PRD change after completion blocks repeated finalize", () => {
  const root = makeProject();
  const { file, capture } = stub(root);
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  startAndClose(root);
  assert.equal(run(root, ["implement", "verify"], { env }).status, 0);
  assert.equal(run(root, ["implement", "finalize"]).status, 0);
  fs.appendFileSync(path.join(root, "agents", "prd", "fixture", "prd.md"), "\nChanged after completion.\n");

  const repeated = run(root, ["implement", "finalize"]);
  assert.equal(repeated.status, 2);
  assert.match(repeated.json.message, /PRD changed after implement start/);
});

test("missing or malformed PRD, state, artifact, and judge input fail closed with an observable cause", () => {
  const missingPrdRoot = makeProject();
  startAndClose(missingPrdRoot);
  fs.rmSync(path.join(missingPrdRoot, "agents", "prd", "fixture", "prd.md"));
  const missingPrd = run(missingPrdRoot, ["implement", "verify"]);
  assert.equal(missingPrd.status, 2);
  assert.match(missingPrd.json.message, /PRD changed after implement start/);
  assert.match(missingPrd.json.message, /current sha256: missing/);
  assert.equal(missingPrd.json.detail.prdDrift.code, "prd-drift");

  const malformedStateRoot = makeProject();
  startAndClose(malformedStateRoot);
  fs.writeFileSync(path.join(malformedStateRoot, "agents", "runs", "fixture", "state.json"), "{bad json");
  const malformedState = run(malformedStateRoot, ["implement", "status"]);
  assert.notEqual(malformedState.status, 0);
  assert.match(malformedState.json.message, /malformed implement state JSON/);

  const missingArtifactRoot = makeProject();
  const artifactStub = stub(missingArtifactRoot);
  const artifactEnv = {
    SASU_JUDGE_BACKEND: "stub",
    SASU_JUDGE_STUB_FILE: artifactStub.file,
    SASU_JUDGE_STUB_CAPTURE_DIR: artifactStub.capture,
  };
  fs.writeFileSync(path.join(missingArtifactRoot, "runtime.log"), "proof\n");
  startAndClose(missingArtifactRoot);
  assert.equal(run(missingArtifactRoot, [
    "implement", "artifact", "--id", "V1", "--kind", "log", "--path", "runtime.log", "--description", "proof",
  ]).status, 0);
  fs.rmSync(path.join(missingArtifactRoot, "runtime.log"));
  const missingArtifact = run(missingArtifactRoot, ["implement", "verify"], { env: artifactEnv });
  assert.equal(missingArtifact.status, 1);
  assert.equal(missingArtifact.json.detail.attempt.error.stage, "artifact");
  assert.match(missingArtifact.json.detail.attempt.error.message, /artifact missing/);
  assert.equal(fs.existsSync(artifactStub.capture), false);

  const malformedJudgeRoot = makeProject();
  const judgeStub = stub(malformedJudgeRoot);
  fs.writeFileSync(judgeStub.file, "{bad json");
  const judgeEnv = {
    SASU_JUDGE_BACKEND: "stub",
    SASU_JUDGE_STUB_FILE: judgeStub.file,
    SASU_JUDGE_STUB_CAPTURE_DIR: judgeStub.capture,
  };
  startAndClose(malformedJudgeRoot);
  const malformedJudge = run(malformedJudgeRoot, ["implement", "verify"], { env: judgeEnv });
  assert.equal(malformedJudge.status, 1);
  assert.equal(malformedJudge.json.detail.attempt.verdict, "ERROR");
  assert.match(malformedJudge.json.detail.attempt.error.message, /stub file|JSON/i);
});

test("artifact registration and verify converge safely when each operation runs twice", () => {
  const root = makeProject();
  const { file, capture } = stub(root);
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  fs.writeFileSync(path.join(root, "runtime.log"), "runtime proof\n");
  startAndClose(root);
  const command = [
    "implement", "artifact", "--id", "V1", "--kind", "log", "--path", "runtime.log", "--description", "runtime proof",
  ];
  const first = run(root, command);
  const second = run(root, command);
  assert.equal(first.status, 0);
  assert.equal(second.status, 0);
  assert.equal(first.json.detail.artifact.registeredAt, second.json.detail.artifact.registeredAt);

  const verifiedOnce = run(root, ["implement", "verify"], { env });
  const verifiedTwice = run(root, ["implement", "verify"], { env });
  assert.equal(verifiedOnce.status, 0);
  assert.equal(verifiedTwice.status, 0);
  assert.equal(readState(root).verificationAttempts.length, 2);
  assert.equal(readState(root).verificationAttempts.every((attempt) => attempt.verdict === "PASS"), true);
  assert.equal(verifiedTwice.json.detail.verificationBudget.fixAttempts, 0);
  assert.equal(verifiedTwice.json.detail.verificationBudget.consecutiveErrors, 0);
});

test("closing a task reports the remaining open tasks in the response", () => {
  const root = makeProject();
  const started = run(root, ["implement", "start", "--prd", "agents/prd/fixture/prd.md"]);
  assert.equal(started.status, 0, started.stderr + started.stdout);

  const closed = run(root, ["implement", "task", "--id", "T1", "--evidence", "fixture implementation complete"]);
  assert.equal(closed.status, 0, closed.stderr + closed.stdout);
  assert.match(closed.json.message, /remaining: none - all tasks closed/);
  assert.deepEqual(closed.json.detail.remainingTasks, []);

  const reopened = run(root, ["implement", "task", "--id", "T1", "--status", "pending"]);
  assert.equal(reopened.status, 0, reopened.stderr + reopened.stdout);
  assert.match(reopened.json.message, /remaining: T1 \(/);
  assert.equal(reopened.json.detail.remainingTasks.length, 1);
  assert.equal(reopened.json.detail.remainingTasks[0].id, "T1");
  assert.equal(reopened.json.detail.remainingTasks[0].status, "pending");
});

test("task dependencies gate closing order and the response marks ready tasks", () => {
  const root = makeProject();
  const parallelPrd = prd().replace(
    "- T1. Implement the flow. Covers R1.",
    [
      "- T1. Base interface. Covers R1.",
      "- T2. Adapter A. Covers R1. Depends on: T1.",
      "- T3. Adapter B. Covers R1. Depends on: T1.",
      "- T4. Integration. Covers R1. Depends on: T2, T3.",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(root, "agents", "prd", "fixture", "prd.md"), parallelPrd);
  const started = run(root, ["implement", "start", "--prd", "agents/prd/fixture/prd.md"]);
  assert.equal(started.status, 0, started.stderr + started.stdout);

  const early = run(root, ["implement", "task", "--id", "T4", "--evidence", "premature"]);
  assert.notEqual(early.status, 0);
  assert.match(early.json.message, /cannot close T4: depends on T2, T3 \(not complete\)/);

  const base = run(root, ["implement", "task", "--id", "T1", "--evidence", "base done"]);
  assert.equal(base.status, 0, base.stderr + base.stdout);
  assert.match(base.json.message, /T2 \(Adapter A, ready\)/);
  assert.match(base.json.message, /T3 \(Adapter B, ready\)/);
  assert.match(base.json.message, /T4 \(Integration, waiting on T2, T3\)/);
  const byId = Object.fromEntries(base.json.detail.remainingTasks.map((entry) => [entry.id, entry]));
  assert.equal(byId.T2.ready, true);
  assert.equal(byId.T4.ready, false);
  assert.deepEqual(byId.T4.dependsOn, ["T2", "T3"]);

  assert.equal(run(root, ["implement", "task", "--id", "T2", "--evidence", "adapter a done"]).status, 0);
  assert.equal(run(root, ["implement", "task", "--id", "T3", "--evidence", "adapter b done"]).status, 0);
  const last = run(root, ["implement", "task", "--id", "T4", "--evidence", "integration done"]);
  assert.equal(last.status, 0, last.stderr + last.stdout);
  assert.match(last.json.message, /remaining: none - all tasks closed/);
});

test("the conversation-approved please chain reaches a finalized receipt", () => {
  const root = makeProject();
  const prdPath = path.join(root, "agents", "prd", "fixture", "prd.md");
  fs.writeFileSync(prdPath, fs.readFileSync(prdPath, "utf8").replace('human_approval: "approved"', 'human_approval: "pending"'));
  const { file, capture } = stub(root);
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };

  const readiness = run(root, ["prd", "readiness", "--prd", "agents/prd/fixture/prd.md"]);
  assert.equal(readiness.status, 0, readiness.stderr + readiness.stdout);
  const invocation = "$please implement the current conversation";
  const started = run(root, [
    "implement", "start", "--prd", "agents/prd/fixture/prd.md", "--allow-unapproved-prd", invocation,
  ]);
  assert.equal(started.status, 0, started.stderr + started.stdout);
  assert.equal(readState(root).prd.approval.source, "conversation");
  assert.equal(readState(root).prd.approval.evidence, invocation);
  writeFixtureImplementation(root);
  assert.equal(run(root, ["implement", "task", "--id", "T1", "--evidence", "implemented from the approved conversation"]).status, 0);
  assert.equal(run(root, ["implement", "verify"], { env }).status, 0);
  const finalized = run(root, ["implement", "finalize"]);
  assert.equal(finalized.status, 0, finalized.stderr + finalized.stdout);
  assert.equal(finalized.json.detail.receipt.status, "complete");
});

test("implement verify stops at the configured fix budget before running more work", () => {
  const root = makeProject();
  fs.mkdirSync(path.join(root, "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({ judge: { retryBudget: 2 } }));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    scripts: {
      test: "node -e \"const fs=require('fs');const p='agents/verify-count';const n=fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0;fs.writeFileSync(p,String(n+1));process.exit(1)\"",
    },
  }));
  startAndClose(root);

  assert.equal(run(root, ["implement", "verify"]).status, 1);
  const second = run(root, ["implement", "verify"]);
  assert.equal(second.status, 1);
  assert.equal(second.json.detail.verificationBudget.fixAttempts, 1);
  const third = run(root, ["implement", "verify"]);
  assert.equal(third.status, 1);
  assert.equal(third.json.detail.verificationBudget.budgetExhausted, true);
  const refused = run(root, ["implement", "verify"]);
  assert.equal(refused.status, 1);
  assert.equal(refused.json.detail.terminalReason, "budget-exhausted");
  assert.equal(refused.json.detail.judgeCalls, 0);
  assert.equal(readState(root).verificationAttempts.length, 3);
  assert.equal(fs.readFileSync(path.join(root, "agents", "verify-count"), "utf8"), "3");
  assert.match(refused.json.message, /--grant-budget/);
});

test("an explicit user grant opens one fresh fix budget inside the same state record", () => {
  // 2026-08-13 creator-assist: with no grant path, "새 검증 런을 허용한다"
  // was honored by archiving state.json and starting a fresh run three
  // times, scattering the record and re-judging everything from zero.
  const root = makeProject();
  fs.mkdirSync(path.join(root, "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({ judge: { retryBudget: 2 } }));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(1)\"" } }));
  startAndClose(root);

  // A grant before exhaustion is refused: it would widen the configured budget.
  const early = run(root, ["implement", "verify", "--grant-budget", "go ahead"]);
  assert.equal(early.status, 2);
  assert.match(early.json.message, /budget is not exhausted/);

  assert.equal(run(root, ["implement", "verify"]).status, 1);
  assert.equal(run(root, ["implement", "verify"]).status, 1);
  assert.equal(run(root, ["implement", "verify"]).status, 1);
  const refused = run(root, ["implement", "verify"]);
  assert.equal(refused.json.detail.terminalReason, "budget-exhausted");

  // Empty evidence is refused; the grant must carry the user's words.
  const unevidenced = run(root, ["implement", "verify", "--grant-budget", "  "]);
  assert.equal(unevidenced.status, 2);
  assert.match(unevidenced.json.message, /verbatim approval/);

  // The grant runs verification again and is recorded in the one state file.
  const granted = run(root, ["implement", "verify", "--grant-budget", "새 검증 런을 허용한다"]);
  assert.equal(granted.status, 1, granted.stderr + granted.stdout);
  assert.notEqual(granted.json.detail.terminalReason, "budget-exhausted");
  const grantedState = readState(root);
  assert.equal(grantedState.verificationAttempts.length, 4);
  assert.equal(grantedState.budgetGrants.length, 1);
  assert.equal(grantedState.budgetGrants[0].evidence, "새 검증 런을 허용한다");
  assert.equal(grantedState.budgetGrants[0].attemptCountBefore, 3);
  assert.equal(granted.json.detail.verificationBudget.fixAttempts, 0);
  assert.equal(granted.json.detail.verificationBudget.grants, 1);

  // The granted budget exhausts again by the same rule, and the blocked
  // close then works with the grant on the receipt's gauge.
  assert.equal(run(root, ["implement", "verify"]).status, 1);
  assert.equal(run(root, ["implement", "verify"]).status, 1);
  const reExhausted = run(root, ["implement", "verify"]);
  assert.equal(reExhausted.json.detail.terminalReason, "budget-exhausted");
  const closed = run(root, ["implement", "finalize", "--status", "blocked"]);
  assert.equal(closed.status, 0, closed.stderr + closed.stdout);
  assert.equal(closed.json.detail.receipt.verificationBudget.grants, 1);
});

test("implement verify bounds consecutive judge errors without spending the fix budget", () => {
  const root = makeProject();
  fs.mkdirSync(path.join(root, "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({ judge: { retryBudget: 2 } }));
  const { file, capture } = stub(root);
  fs.writeFileSync(file, "{bad json");
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  startAndClose(root);

  assert.equal(run(root, ["implement", "verify"], { env }).status, 1);
  const second = run(root, ["implement", "verify"], { env });
  assert.equal(second.status, 1);
  assert.equal(second.json.detail.verificationBudget.fixAttempts, 0);
  assert.equal(second.json.detail.verificationBudget.judgeErrorLoop, true);
  const refused = run(root, ["implement", "verify"], { env });
  assert.equal(refused.status, 1);
  assert.equal(refused.json.detail.terminalReason, "judge-error-loop");
  assert.equal(readState(root).verificationAttempts.length, 2);
});

test("settled verdicts from an ERROR'd attempt are reused on the unchanged tree only", () => {
  const root = makeProject();
  const prdPath = path.join(root, "agents", "prd", "fixture", "prd.md");
  let text = fs.readFileSync(prdPath, "utf8");
  text = text.replace(
    "- AC1. A completed task can be verified and finalized from one state.",
    "- AC1. A completed task can be verified and finalized from one state.\n- AC2. The same flow reports its status honestly.",
  );
  text = text.replaceAll("R1, AC1", "R1, AC1, AC2");
  text = text.replace("Covers AC1.", "Covers AC1, AC2.");
  fs.writeFileSync(prdPath, text);
  const { file, capture } = stub(root);
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  startAndClose(root);

  // AC2 has no stub entry, so its judge call errors while AC1 and fidelity settle.
  const errored = run(root, ["implement", "verify"], { env });
  assert.equal(errored.status, 1);
  const first = errored.json.detail.attempt;
  assert.equal(first.verdict, "ERROR");
  assert.equal(first.lanes.acceptance.verdict, "ERROR");
  assert.equal(first.lanes.fidelity.verdict, "PASS");
  // Per-invocation detail lives only in state.json; the response carries a summary.
  const settledAc1 = readState(root).verificationAttempts.at(-1).lanes.acceptance.result.invocations.find((entry) => entry.criterionId === "AC1");
  assert.equal(settledAc1.verdict, "PASS");
  assert.equal(errored.json.detail.verificationBudget.fixAttempts, 0, "an infrastructure ERROR spends no fix budget");

  const stubJson = JSON.parse(fs.readFileSync(file, "utf8"));
  stubJson.byPurpose["implement:acceptance:AC2"] = {
    verdict: "PASS",
    criteria: [{ id: "AC2", verdict: "PASS", reason: "status honest", evidence: "transcript" }],
  };
  fs.writeFileSync(file, JSON.stringify(stubJson));
  fs.rmSync(capture, { recursive: true, force: true });

  const reused = run(root, ["implement", "verify"], { env });
  assert.equal(reused.status, 0, reused.stderr + reused.stdout);
  const second = reused.json.detail.attempt;
  assert.equal(second.verdict, "PASS");
  const secondState = readState(root).verificationAttempts.at(-1);
  const ac1 = secondState.lanes.acceptance.result.invocations.find((entry) => entry.criterionId === "AC1");
  const ac2 = secondState.lanes.acceptance.result.invocations.find((entry) => entry.criterionId === "AC2");
  assert.equal(ac1.reusedFrom, first.id);
  assert.equal(ac1.invocationId, settledAc1.invocationId);
  assert.equal(ac2.reusedFrom, undefined);
  assert.equal(second.lanes.fidelity.reusedFrom, first.id);
  assert.deepEqual(secondState.lanes.acceptance.result.criteria.map((entry) => entry.id).sort(), ["AC1", "AC2"]);
  assert.equal(fs.existsSync(path.join(capture, "implement_acceptance_AC1.prompt.txt")), false, "a reused criterion must not re-call its judge");
  assert.equal(fs.existsSync(path.join(capture, "implement_fidelity.prompt.txt")), false, "a reused fidelity lane must not re-call its judge");
  assert.equal(fs.existsSync(path.join(capture, "implement_acceptance_AC2.prompt.txt")), true);

  // ERROR again, then move the tree: nothing may be reused across a source change.
  delete stubJson.byPurpose["implement:acceptance:AC2"];
  fs.writeFileSync(file, JSON.stringify(stubJson));
  assert.equal(run(root, ["implement", "verify"], { env }).json.detail.attempt.verdict, "ERROR");

  stubJson.byPurpose["implement:acceptance:AC2"] = {
    verdict: "PASS",
    criteria: [{ id: "AC2", verdict: "PASS", reason: "status honest", evidence: "transcript" }],
  };
  fs.writeFileSync(file, JSON.stringify(stubJson));
  fs.writeFileSync(path.join(root, "changed.txt"), "the judged tree moved\n");
  fs.rmSync(capture, { recursive: true, force: true });
  const fresh = run(root, ["implement", "verify"], { env });
  assert.equal(fresh.status, 0, fresh.stderr + fresh.stdout);
  const third = fresh.json.detail.attempt;
  assert.equal(third.verdict, "PASS");
  assert.ok(readState(root).verificationAttempts.at(-1).lanes.acceptance.result.invocations.every((entry) => entry.reusedFrom === undefined));
  assert.equal(third.lanes.fidelity.reusedFrom, undefined);
  assert.equal(fs.existsSync(path.join(capture, "implement_acceptance_AC1.prompt.txt")), true, "a changed tree re-judges every criterion");
});

test("a terminally stuck run closes through an explicit blocked finalize and can recover", () => {
  const root = makeProject();
  fs.mkdirSync(path.join(root, "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({ judge: { retryBudget: 2 } }));
  const failingTest = JSON.stringify({ scripts: { test: "node -e \"process.exit(1)\"" } });
  fs.writeFileSync(path.join(root, "package.json"), failingTest);
  const { file, capture } = stub(root);
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  startAndClose(root);

  // A blocked close is refused while the budget still allows a fix loop.
  assert.equal(run(root, ["implement", "verify"], { env }).status, 1);
  const early = run(root, ["implement", "finalize", "--status", "blocked"]);
  assert.equal(early.status, 2);
  assert.match(early.json.message, /verification can still run/);

  // Exhaust the budget; the refusal must name the honest exit.
  assert.equal(run(root, ["implement", "verify"], { env }).status, 1);
  assert.equal(run(root, ["implement", "verify"], { env }).status, 1);
  const refused = run(root, ["implement", "verify"], { env });
  assert.equal(refused.json.detail.terminalReason, "budget-exhausted");
  assert.match(refused.json.message, /finalize --status blocked/);

  // A plain finalize still refuses; only the explicit blocked close works.
  assert.equal(run(root, ["implement", "finalize"]).status, 2);
  const closed = run(root, ["implement", "finalize", "--status", "blocked"]);
  assert.equal(closed.status, 0, closed.stderr + closed.stdout);
  assert.equal(closed.json.detail.receipt.status, "blocked");
  assert.equal(closed.json.detail.receipt.terminalReason, "budget-exhausted");
  assert.ok(closed.json.detail.receipt.openItems.length > 0);
  assert.equal(readState(root).status, "blocked");
  const receiptOnDisk = JSON.parse(fs.readFileSync(path.join(root, closed.json.detail.completion.receiptPath), "utf8"));
  assert.equal(receiptOnDisk.status, "blocked");
  const report = fs.readFileSync(path.join(root, closed.json.detail.completion.implementationResultPath), "utf8");
  assert.match(report, /Status: Blocked \(budget-exhausted\)/);
  assert.match(report, /## Open Items/);

  // Idempotent re-close.
  const again = run(root, ["implement", "finalize", "--status", "blocked"]);
  assert.equal(again.status, 0);
  assert.match(again.json.message, /already closed blocked/);

  // Recovery: the user raises the budget and fixes the failure; verify
  // reactivates the run and a fresh PASS overwrites the blocked receipt.
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({ judge: { retryBudget: 5 } }));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e \"console.log('MECHANICAL-PROOF')\"" } }));
  const recovered = run(root, ["implement", "verify"], { env });
  assert.equal(recovered.status, 0, recovered.stderr + recovered.stdout);
  assert.equal(readState(root).status, "active");
  const finalized = run(root, ["implement", "finalize"]);
  assert.equal(finalized.status, 0, finalized.stderr + finalized.stdout);
  assert.equal(finalized.json.detail.receipt.status, "complete");
  assert.equal(readState(root).status, "complete");
});

test("an unbacked acceptance PASS with a known-zero read trace is invalidated", () => {
  const root = makeProject();
  const prdPath = path.join(root, "agents", "prd", "fixture", "prd.md");
  let text = fs.readFileSync(prdPath, "utf8");
  text = text.replace(
    "- AC1. A completed task can be verified and finalized from one state.",
    "- AC1. A completed task can be verified and finalized from one state.\n- AC2. The same flow reports its status honestly.",
  );
  // AC2 hangs off its own requirement covered ONLY by a live-judge
  // verification: coverage expands through requirements, so R1's mechanical
  // rows must not reach AC2 or its checks would count as inlined proof.
  text = text.replace(
    "- R1. The flow completes through one state. Covers AC1.",
    "- R1. The flow completes through one state. Covers AC1.\n- R2. The flow reports honestly. Covers AC2.",
  );
  text = text.replace("- T1. Implement the flow. Covers R1.", "- T1. Implement the flow. Covers R1, R2.");
  text = text.replace(
    "| V3 | live judge runtime | R1, AC1 | separate acceptance and fidelity judge verdicts are recorded | yes | no |",
    "| V3 | live judge runtime | R1, AC1 | separate acceptance and fidelity judge verdicts are recorded | yes | no |\n| V4 | live judge runtime | R2, AC2 | the status report criterion is judged from the implementation | yes | no |",
  );
  fs.writeFileSync(prdPath, text);
  const { file, capture } = stub(root);
  const stubJson = JSON.parse(fs.readFileSync(file, "utf8"));
  stubJson.byPurpose["implement:acceptance:AC2"] = {
    verdict: "PASS",
    criteria: [{ id: "AC2", verdict: "PASS", reason: "status honest", evidence: "src/status.ts" }],
  };
  fs.writeFileSync(file, JSON.stringify(stubJson));
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  startAndClose(root);

  // The stub attests zero tool rounds, so AC2's unbacked PASS is rejected
  // through the invalid-output ladder while check-backed AC1 still settles.
  const verified = run(root, ["implement", "verify"], { env });
  assert.equal(verified.status, 1);
  const attempt = verified.json.detail.attempt;
  assert.equal(attempt.lanes.acceptance.verdict, "ERROR");
  const invocations = readState(root).verificationAttempts.at(-1).lanes.acceptance.result.invocations;
  const ac1 = invocations.find((entry) => entry.criterionId === "AC1");
  const ac2 = invocations.find((entry) => entry.criterionId === "AC2");
  assert.equal(ac1.verdict, "PASS");
  assert.equal(ac2.verdict, "ERROR");
  assert.match(ac2.error.message, /no file read was recorded/);

  // A judge that attests a read is accepted on the same contract.
  const attested = run(root, ["implement", "verify"], { env: { ...env, SASU_JUDGE_STUB_TOOL_ROUNDS: "1" } });
  assert.equal(attested.status, 0, attested.stderr + attested.stdout);
  assert.equal(attested.json.detail.attempt.verdict, "PASS");
});

test("per-session pointers keep two sessions' bare commands on their own runs", () => {
  const root = makeProject();
  fs.mkdirSync(path.join(root, "agents", "prd", "fixture-b"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", "prd", "fixture-b", "prd.md"), prd());
  const sessionA = { CLAUDE_CODE_SESSION_ID: "session-a" };
  const sessionB = { CLAUDE_CODE_SESSION_ID: "session-b" };
  assert.equal(run(root, ["implement", "start", "--prd", "agents/prd/fixture/prd.md"], { env: sessionA }).status, 0);
  assert.equal(run(root, ["implement", "start", "--prd", "agents/prd/fixture-b/prd.md"], { env: sessionB }).status, 0);
  // Each session's bare status resolves its own run, not the last one started.
  const statusA = run(root, ["implement", "status"], { env: sessionA });
  assert.equal(statusA.status, 0, statusA.stderr + statusA.stdout);
  assert.match(statusA.json.message, /^fixture:/);
  const statusB = run(root, ["implement", "status"], { env: sessionB });
  assert.match(statusB.json.message, /^fixture-b:/);
  assert.ok(fs.existsSync(path.join(root, "agents", "runs", ".active", "session-a.json")));
  // No shared singleton is written by session-scoped starts, so there is
  // nothing for a later session to steal.
  assert.equal(fs.existsSync(path.join(root, "agents", "runs", ".prd-implement-active.json")), false);
  // A session with no run of its own gets an explicit menu, never a guess.
  const statusC = run(root, ["implement", "status"], { env: { CLAUDE_CODE_SESSION_ID: "session-c" } });
  assert.equal(statusC.status, 2);
  assert.match(statusC.json.message, /existing runs: fixture, fixture-b/);
});

test("a run owned by another session refuses mutation without --adopt and records the takeover with it", () => {
  const root = makeProject();
  const sessionA = { CLAUDE_CODE_SESSION_ID: "session-a" };
  const sessionB = { CLAUDE_CODE_SESSION_ID: "session-b" };
  assert.equal(run(root, ["implement", "start", "--prd", "agents/prd/fixture/prd.md"], { env: sessionA }).status, 0);
  writeFixtureImplementation(root);
  const refused = run(root, ["implement", "task", "--id", "T1", "--evidence", "done", "--slug", "fixture"], { env: sessionB });
  assert.equal(refused.status, 2);
  assert.match(refused.json.message, /owned by another session \(session-a\)/);
  assert.equal(readState(root).ownerSessionId, "session-a");
  const adopted = run(
    root,
    ["implement", "task", "--id", "T1", "--evidence", "done", "--slug", "fixture", "--adopt", "user said take it over"],
    { env: sessionB },
  );
  assert.equal(adopted.status, 0, adopted.stderr + adopted.stdout);
  const state = readState(root);
  assert.equal(state.ownerSessionId, "session-b");
  assert.deepEqual(
    state.adoptions.map((entry) => [entry.fromSessionId, entry.evidence]),
    [["session-a", "user said take it over"]],
  );
  // Reads stay open to every session: ownership guards mutation only.
  assert.equal(run(root, ["implement", "status", "--slug", "fixture"], { env: sessionA }).status, 0);
  // The adoption reaches both human surfaces of the close: fingerprints
  // deliberately ignore ownership, so receipt + report are where it shows.
  const { file, capture } = stub(root);
  const judgeEnv = { ...sessionB, SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  const verified = run(root, ["implement", "verify"], { env: judgeEnv });
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);
  const finalized = run(root, ["implement", "finalize"], { env: sessionB });
  assert.equal(finalized.status, 0, finalized.stderr + finalized.stdout);
  const receipt = JSON.parse(fs.readFileSync(path.join(root, "agents", "runs", "fixture", "receipt.json"), "utf8"));
  assert.equal(receipt.adoptions.length, 1);
  assert.equal(receipt.adoptions[0].fromSessionId, "session-a");
  const report = fs.readFileSync(path.join(root, "agents", "runs", "fixture", "implementation-result.md"), "utf8");
  assert.match(report, /ownership-adopted: taken over from session session-a/);
});

test("a sessionless run stays on the shared pointer and is claimed by its first mutating session", () => {
  const root = makeProject();
  assert.equal(run(root, ["implement", "start", "--prd", "agents/prd/fixture/prd.md"]).status, 0);
  assert.ok(fs.existsSync(path.join(root, "agents", "runs", ".prd-implement-active.json")));
  assert.equal(readState(root).ownerSessionId, null);
  // A session with no pointer of its own falls back to the sessionless run,
  // and its first mutation claims ownership, closing the unowned window that
  // let a bystander session become a run's owner (pokemon-rpg-run-1).
  const claimed = run(root, ["implement", "task", "--id", "T1", "--evidence", "done"], { env: { CLAUDE_CODE_SESSION_ID: "session-c" } });
  assert.equal(claimed.status, 0, claimed.stderr + claimed.stdout);
  assert.equal(readState(root).ownerSessionId, "session-c");
});

test("a second start in an occupied tree diverts to an isolated worktree and completes there", () => {
  const root = makeProject();
  fs.mkdirSync(path.join(root, "agents", "prd", "fixture-b"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", "prd", "fixture-b", "prd.md"), prd());
  const a = { CLAUDE_CODE_SESSION_ID: "session-a" };
  const b = { CLAUDE_CODE_SESSION_ID: "session-b" };
  assert.equal(run(root, ["implement", "start", "--prd", "agents/prd/fixture/prd.md"], { env: a }).status, 0);
  const started = run(root, ["implement", "start", "--prd", "agents/prd/fixture-b/prd.md"], { env: b });
  assert.equal(started.status, 0, started.stderr + started.stdout);
  assert.match(started.json.message, /isolated worktree/);
  const stateB = readState(root, "fixture-b");
  assert.ok(stateB.worktree, "second run must be isolated");
  const wt = stateB.worktree.path;
  assert.equal(stateB.worktree.branch, "prd/fixture-b");
  assert.ok(fs.existsSync(path.join(wt, "package.json")), "worktree carries committed sources");
  // Records live in the record tree, never in the worktree.
  assert.ok(fs.existsSync(path.join(root, "agents", "runs", "fixture-b", "state.json")));
  assert.equal(fs.existsSync(path.join(wt, "agents", "runs", "fixture-b")), false);
  // Bare commands typed from inside the worktree resolve the record tree.
  const inside = run(wt, ["implement", "status"], { env: b });
  assert.equal(inside.status, 0, inside.stderr + inside.stdout);
  assert.match(inside.json.message, /^fixture-b:/);
  // Session B implements in the worktree while the record tree keeps churning.
  fs.writeFileSync(path.join(wt, "beta.txt"), "beta implementation\n");
  fs.writeFileSync(path.join(root, "alpha.txt"), "concurrent unrelated edit in the record tree\n");
  assert.equal(run(root, ["implement", "task", "--id", "T1", "--evidence", "implemented in worktree"], { env: b }).status, 0);
  const { file, capture } = stub(root);
  const env = { ...b, SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  const verified = run(root, ["implement", "verify"], { env });
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);
  assert.equal(verified.json.detail.attempt.verdict, "PASS", "record-tree churn must not stale the isolated run");
  const finalized = run(root, ["implement", "finalize"], { env: b });
  assert.equal(finalized.status, 0, finalized.stderr + finalized.stdout);
  assert.match(finalized.json.message, /branch prd\/fixture-b/);
  const receipt = JSON.parse(fs.readFileSync(path.join(root, "agents", "runs", "fixture-b", "receipt.json"), "utf8"));
  assert.equal(receipt.worktree.branch, "prd/fixture-b");
  // A removed worktree fails loudly instead of silently judging the record tree.
  fs.rmSync(wt, { recursive: true, force: true });
  const missing = run(root, ["implement", "status"], { env: b });
  assert.equal(missing.status, 2);
  assert.match(missing.json.message, /worktree missing/);
});

test("worktree.enabled isolates the first run too", () => {
  const root = makeProject();
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({ worktree: { enabled: true } }));
  const started = run(root, ["implement", "start", "--prd", "agents/prd/fixture/prd.md"]);
  assert.equal(started.status, 0, started.stderr + started.stdout);
  assert.ok(readState(root).worktree, "enabled=true must isolate without an occupant");
});

test("dirty worktree setup output is attributed before state and a refused provision is rolled back", () => {
  const root = makeProject();
  const worktreeRoot = path.join(os.tmpdir(), `${path.basename(root)}-prepared-worktrees`);
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({
    worktree: {
      enabled: true,
      root: worktreeRoot,
      setup: ["node -e \"require('fs').writeFileSync('setup.txt','prepared')\""],
    },
  }));
  const refused = run(root, ["implement", "start", "--prd", "agents/prd/fixture/prd.md"]);
  assert.equal(refused.status, 2);
  assert.match(refused.json.message, /- setup\.txt/);
  assert.equal(fs.existsSync(path.join(worktreeRoot, "fixture")), false);
  const branch = spawnSync("git", ["branch", "--list", "prd/fixture"], { cwd: root, encoding: "utf8" });
  assert.equal(branch.stdout.trim(), "");
  assert.equal(fs.existsSync(path.join(root, "agents", "runs", "fixture", "state.json")), false);

  const recovered = run(root, [
    "implement", "start", "--prd", "agents/prd/fixture/prd.md", "--dirty-attribution", "pre-existing",
  ]);
  assert.equal(recovered.status, 0, recovered.stderr + recovered.stdout);
  assert.deepEqual(readState(root).baselineAttribution.paths, [{ path: "setup.txt", disposition: "pre-existing" }]);
});

test("a failure after worktree setup removes the unrecorded worktree and branch", () => {
  const root = makeProject();
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-init-failure-worktrees-"));
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({
    worktree: { enabled: true, root: worktreeRoot },
  }));
  // A directory at the snapshot path makes the atomic file rename fail after
  // the worktree exists, but before state.json becomes the run commit point.
  fs.mkdirSync(path.join(root, "agents", "runs", "fixture", "prd.md"), { recursive: true });

  const failed = run(root, ["implement", "start", "--prd", "agents/prd/fixture/prd.md"]);
  assert.equal(failed.status, 2);
  assert.equal(fs.existsSync(path.join(worktreeRoot, "fixture")), false);
  const branch = spawnSync("git", ["branch", "--list", "prd/fixture"], { cwd: root, encoding: "utf8" });
  assert.equal(branch.stdout.trim(), "");
  assert.equal(fs.existsSync(path.join(root, "agents", "runs", "fixture", "state.json")), false);
});

test("a failed worktree rollback reports its cleanup failures", () => {
  const root = makeProject();
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-cleanup-failure-worktrees-"));
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-cleanup-failure-bin-"));
  const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
  const gitWrapper = path.join(fakeBin, "git");
  fs.writeFileSync(gitWrapper, `#!/bin/sh
if [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then
  echo "forced cleanup failure" >&2
  exit 77
fi
exec ${JSON.stringify(realGit)} "$@"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({
    worktree: { enabled: true, root: worktreeRoot },
  }));
  fs.mkdirSync(path.join(root, "agents", "runs", "fixture", "prd.md"), { recursive: true });

  const failed = run(root, ["implement", "start", "--prd", "agents/prd/fixture/prd.md"], {
    env: { PATH: `${fakeBin}:${process.env.PATH}` },
  });
  assert.equal(failed.status, 2);
  assert.match(failed.json.message, /cleanup was incomplete/);
  assert.match(failed.json.message, /worktree remove failed: forced cleanup failure/);
  assert.match(failed.json.message, /branch delete failed/);

  const worktreePath = path.join(worktreeRoot, "fixture");
  assert.equal(fs.existsSync(worktreePath), true, "the reported debris remains observable for recovery");
  assert.equal(spawnSync(realGit, ["worktree", "remove", "--force", worktreePath], { cwd: root }).status, 0);
  assert.equal(spawnSync(realGit, ["branch", "-D", "prd/fixture"], { cwd: root }).status, 0);
});

test("a first round that called no judge is free, while unchanged repeats remain bounded", () => {
  // 2026-08-17 herdr-remote-handoff: 3 of the 5 rounds that exhausted the
  // budget never reached a lane (mis-declared binding, stale artifact, own
  // test failure). Only 2 real judged rounds were spendable and an otherwise
  // finished run closed as blocked. A failing test suite converges; the
  // budget exists for the stage that does not (PRINCIPLES 13).
  const root = makeProject({ testExit: 1 });
  fs.mkdirSync(path.join(root, "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({ judge: { retryBudget: 2 } }));
  startAndClose(root);

  // The first deterministic failure did not invoke a generative stage, so it
  // cannot spend the budget that exists to bound that stage.
  assert.equal(run(root, ["implement", "verify"]).status, 1);
  assert.equal(run(root, ["implement", "status"]).json.detail.verification.budget.fixAttempts, 0);

  // A real fix lands in the judged tree; the next mechanical failure is free.
  fs.writeFileSync(path.join(root, "fix-one.txt"), "a real change between rounds\n");
  assert.equal(run(root, ["implement", "verify"]).status, 1);
  const afterFix = run(root, ["implement", "status"]).json.detail.verification.budget;
  assert.equal(afterFix.fixAttempts, 0, "a no-judge round that followed real work spends nothing");
  assert.equal(afterFix.budgetExhausted, false);

  // Re-running the identical tree proves no new work, so it is charged and
  // the loop still terminates.
  assert.equal(run(root, ["implement", "verify"]).status, 1);
  const repeated = run(root, ["implement", "status"]).json.detail.verification.budget;
  assert.equal(repeated.fixAttempts, 1, "an unchanged re-run is charged exactly like a judged round");
  assert.equal(repeated.budgetExhausted, false);
  assert.equal(run(root, ["implement", "verify"]).status, 1);
  const exhausted = run(root, ["implement", "status"]).json.detail.verification.budget;
  assert.equal(exhausted.fixAttempts, 2);
  assert.equal(exhausted.budgetExhausted, true);
  assert.equal(run(root, ["implement", "verify"]).json.detail.terminalReason, "budget-exhausted");
  assert.equal(readState(root).verificationAttempts.length, 4);
});

test("registering evidence does not stale the artifacts registered from the same file", () => {
  // 2026-08-17 herdr-remote-handoff: V6-V12 all cited docs/evidence/e2e-run.md,
  // so appending to that document invalidated every artifact drawn from it and
  // burned two verification rounds on bookkeeping alone.
  const root = makeProject();
  const evidence = path.join(root, "docs", "evidence");
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(evidence, "run.md"), "first observation\n");
  startAndClose(root);

  const register = (id) => run(root, [
    "implement", "artifact", "--id", id, "--kind", "log",
    "--path", "docs/evidence/run.md", "--description", `runtime evidence for ${id}`,
  ]);
  assert.equal(register("V1").status, 0);

  // The document grows, exactly as an implementation session extends its
  // evidence, and both artifacts are re-registered from the new content.
  fs.appendFileSync(path.join(evidence, "run.md"), "second observation\n");
  assert.equal(register("V1").status, 0);
  assert.equal(register("V2").status, 0);

  const status = run(root, ["implement", "status"]);
  assert.equal(status.status, 0, status.stderr + status.stdout);
  const stale = (status.json.detail.artifactProblems ?? []).filter((problem) => problem.includes("stale"));
  assert.deepEqual(stale, [], "an artifact must not invalidate itself");
});

// --- design comments: the lane's only consequence is disposition -----------
//
// 2026-08-20, herdr-remote-handoff: the design lane ran 12 times in one run and
// reported the same duplicated remote-boundary check every time, in two
// languages and four phrasings. Nothing required an answer, so none of the 12
// was ever answered. These tests pin the two properties that fix that: a
// re-worded repeat is the SAME comment, and an unanswered comment stops
// finalize.

function designStub(root, comments) {
  const file = path.join(root, "agents", "judge.json");
  const configured = JSON.parse(fs.readFileSync(file, "utf8"));
  configured.byPurpose["implement:design"] = { comments };
  fs.writeFileSync(file, JSON.stringify(configured));
}

const DUPLICATE_COMMENT = {
  area: "one-cause-n-symptoms",
  path: "lib/remote.sh",
  text: "the remote-boundary check is copied into three commands",
  suggestion: "extract one helper and call it from each",
};

test("an unanswered design comment blocks finalize, and accepting it with a reason releases the run", () => {
  const root = makeProject();
  const { file, capture } = stub(root);
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  designStub(root, [DUPLICATE_COMMENT]);
  startAndClose(root);

  const verified = run(root, ["implement", "verify"], { env });
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);
  // The lane has no verdict of its own and never touches the unified one.
  assert.equal(verified.json.detail.attempt.verdict, "PASS");
  assert.equal(verified.json.detail.attempt.lanes.design, undefined);

  // The agent sees the debt without reading any file: in the response body...
  const design = verified.json.detail.design;
  assert.equal(design.ran, true);
  assert.equal(design.open.length, 1);
  assert.equal(design.open[0].id, "D1");
  assert.equal(design.open[0].path, "lib/remote.sh");
  assert.match(design.howToAnswer, /sasu implement design --id/);
  // ...and in the one line a caller reading only `message` cannot skip.
  assert.match(verified.json.message, /1 design comment\(s\) await a disposition/);
  assert.match(verified.stderr, /design: 1 comment\(s\) await a disposition before finalize/);

  const refused = run(root, ["implement", "finalize"]);
  assert.equal(refused.status, 2);
  assert.match(refused.json.message, /design comment D1 \(one-cause-n-symptoms @ lib\/remote\.sh\) has no disposition/);

  // Accepting demands a reason, and the reason lands in the record.
  const bare = run(root, ["implement", "design", "--id", "D1"]);
  assert.equal(bare.status, 2);
  assert.match(bare.json.message, /missing required --accept/);
  const unknown = run(root, ["implement", "design", "--id", "D9", "--accept", "x"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.json.message, /unknown design comment: D9 \(open: D1\)/);

  const accepted = run(root, ["implement", "design", "--id", "D1", "--accept", "the third caller ships next week and takes the helper with it"]);
  assert.equal(accepted.status, 0, accepted.stderr + accepted.stdout);
  assert.equal(accepted.json.detail.open.length, 0);
  const tracked = readState(root).designComments;
  assert.equal(tracked.length, 1);
  assert.equal(tracked[0].accepted.note, "the third caller ships next week and takes the helper with it");
  assert.equal(tracked[0].status, "open");

  const finalized = run(root, ["implement", "finalize"]);
  assert.equal(finalized.status, 0, finalized.stderr + finalized.stdout);
  // The acceptance survives into the human-readable record, next to the comment.
  const report = fs.readFileSync(path.join(root, finalized.json.detail.completion.implementationResultPath), "utf8");
  assert.match(report, /## Design Comments/);
  assert.match(report, /D1 \[one-cause-n-symptoms\] lib\/remote\.sh/);
  assert.match(report, /Disposition: accepted .*the third caller ships next week/);
});

test("a re-worded repeat is the same comment; a fixed one resolves itself without anyone claiming a fix", () => {
  const root = makeProject();
  const { file, capture } = stub(root);
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  designStub(root, [DUPLICATE_COMMENT]);
  startAndClose(root);
  assert.equal(run(root, ["implement", "verify"], { env }).status, 0);

  // Same defect, different words, different language, and a different area
  // label - all three drift in practice. Measured on gpt-5.6-luna, `area`
  // split 5/5 across 10 calls on one fixed diff, so only `path` is identity.
  designStub(root, [{
    ...DUPLICATE_COMMENT,
    area: "structure-drift",
    text: "원격 경계 검사가 세 개 명령에 각각 중복되어 있습니다",
    suggestion: "공통 헬퍼로 추출하세요",
  }]);
  const second = run(root, ["implement", "verify"], { env });
  assert.equal(second.status, 0, second.stderr + second.stdout);
  const afterRepeat = readState(root).designComments;
  assert.equal(afterRepeat.length, 1, "a re-wording must not mint a second comment");
  assert.equal(afterRepeat[0].id, "D1");
  assert.match(afterRepeat[0].text, /원격 경계 검사/, "the tracked text follows the latest wording");
  assert.equal(afterRepeat[0].area, "structure-drift", "a re-labelled area updates the comment, never forks it");
  assert.notEqual(afterRepeat[0].firstSeenAt, undefined);

  // A genuinely new defect in a different file does get its own id.
  designStub(root, [DUPLICATE_COMMENT, { ...DUPLICATE_COMMENT, area: "dead-weight", path: "lib/common.sh" }]);
  assert.equal(run(root, ["implement", "verify"], { env }).status, 0);
  assert.deepEqual(readState(root).designComments.map((entry) => entry.id), ["D1", "D2"]);

  // Fixing is proved by the lane going quiet, never by a hand-typed claim:
  // D1 resolves on its own and stops blocking, and there is no --fixed flag.
  designStub(root, [{ ...DUPLICATE_COMMENT, area: "dead-weight", path: "lib/common.sh" }]);
  const third = run(root, ["implement", "verify"], { env });
  assert.equal(third.status, 0, third.stderr + third.stdout);
  const afterFix = readState(root).designComments;
  assert.equal(afterFix.find((entry) => entry.id === "D1").status, "resolved");
  assert.deepEqual(third.json.detail.design.open.map((entry) => entry.id), ["D2"]);
  assert.equal(third.json.detail.design.resolvedCount, 1);
  const resolvedAccept = run(root, ["implement", "design", "--id", "D1", "--accept", "moot"]);
  assert.equal(resolvedAccept.status, 2);
  assert.match(resolvedAccept.json.message, /already resolved/);

  // A resolved comment that comes back keeps its original id, so a defect
  // cannot launder itself into a fresh unanswered slot - or out of an old
  // acceptance.
  designStub(root, [DUPLICATE_COMMENT]);
  assert.equal(run(root, ["implement", "verify"], { env }).status, 0);
  const reopened = readState(root).designComments.find((entry) => entry.key === "lib/remote.sh");
  assert.equal(reopened.id, "D1");
  assert.equal(reopened.status, "open");
});

test("the design lane is shown the run's own diff and cannot answer with a verdict", () => {
  const root = makeProject();
  fs.writeFileSync(path.join(root, "impl.txt"), "DIFF-ONLY-LINE\n");
  const { file, capture } = stub(root);
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  startAndClose(root);
  assert.equal(run(root, ["implement", "verify"], { env }).status, 0);
  const prompt = fs.readFileSync(path.join(capture, "implement_design.prompt.txt"), "utf8");
  assert.match(prompt, /RUN-OWNED DIFF/);
  // A real unified diff of the run's work, not just the file body: without the
  // +/- the lane cannot tell this run's accretion from pre-existing shape.
  assert.match(prompt, /\+DIFF-ONLY-LINE/);
  assert.match(prompt, /^--- \/dev\/null$/m);

  // Verdict-shaped output is rejected rather than quietly reinterpreted: the
  // lane that could emit a verdict is the lane that had to be hardwired PASS.
  const configured = JSON.parse(fs.readFileSync(file, "utf8"));
  configured.byPurpose["implement:design"] = { verdict: "FAIL", findings: [] };
  fs.writeFileSync(file, JSON.stringify(configured));
  const malformed = run(root, ["implement", "verify"], { env });
  assert.equal(malformed.status, 0, "a broken design lane must not fail the run");
  assert.equal(malformed.json.detail.attempt.verdict, "PASS");
  // A broken lane is observable, not silent: it errored, so it reported nothing.
  assert.match(malformed.json.detail.design.error, /comments must be an array/);
  assert.deepEqual(malformed.json.detail.design.open, []);
  assert.match(malformed.stderr, /design: ERROR/);
  assert.equal(readState(root).verificationAttempts.at(-1).lanes.design.error.code, "judge-invalid-output");

  // Two comments on one file would collide into a single tracked entry,
  // silently discarding one before anyone could answer it. Note the differing
  // area: identity is the path, so a second area does not buy a second slot.
  configured.byPurpose["implement:design"] = { comments: [DUPLICATE_COMMENT, { ...DUPLICATE_COMMENT, area: "dead-weight", text: "different words" }] };
  fs.writeFileSync(file, JSON.stringify(configured));
  run(root, ["implement", "verify"], { env });
  assert.match(
    readState(root).verificationAttempts.at(-1).lanes.design.error.message,
    /two comments target the same file \(lib\/remote\.sh\)/,
  );
});

test("an ERROR'd design lane never resolves the comments it failed to look at", () => {
  const root = makeProject();
  const { file, capture } = stub(root);
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  designStub(root, [DUPLICATE_COMMENT]);
  startAndClose(root);
  assert.equal(run(root, ["implement", "verify"], { env }).status, 0);

  const configured = JSON.parse(fs.readFileSync(file, "utf8"));
  configured.byPurpose["implement:design"] = "not json at all";
  fs.writeFileSync(file, JSON.stringify(configured));
  const errored = run(root, ["implement", "verify"], { env });
  assert.equal(errored.status, 0, errored.stderr + errored.stdout);
  // "saw nothing" is not "reported nothing": D1 stays open and finalize stays shut.
  assert.equal(readState(root).designComments[0].status, "open");
  const refused = run(root, ["implement", "finalize"]);
  assert.equal(refused.status, 2);
  assert.match(refused.json.message, /design comment D1/);
});

test("a trivial-profile run skips the design lane entirely and finalizes with no comments to answer", () => {
  const root = makeProject({ profile: "trivial" });
  const { file, capture } = stub(root, "trivial");
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  designStub(root, [DUPLICATE_COMMENT]);
  startAndClose(root);
  const verified = run(root, ["implement", "verify"], { env });
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);
  assert.equal(verified.json.detail.design.ran, false);
  assert.equal(fs.existsSync(path.join(capture, "implement_design.prompt.txt")), false);
  assert.equal(readState(root).designComments, undefined);
  assert.equal(run(root, ["implement", "finalize"]).status, 0);
});
