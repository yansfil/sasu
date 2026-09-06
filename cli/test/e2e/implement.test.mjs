import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "dist", "cli.js");
const PRELINT_FIXTURES = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "fixtures", "prelint");
const QA_FIXTURE = fs.readFileSync(path.join(PRELINT_FIXTURES, "qa-clean.md"), "utf8");

/** One more judge: row for fixtures that need a second judged question. */
const judgeRow = (id, behavior) => `| ${id} | ${behavior} | judge: the log at agents/runs/fixture/artifacts/${id.toLowerCase()}.log | D-01 |`;

function prd({ profile = "standard", sourceIntake = "current conversation", checkCommand = "npm test", extraRows = [] } = {}) {
  return `---
topic: "implement fixture"
status: "ready"
human_approval: "approved"
review_profile: "${profile}"
review_rationale: "CLI fixture"
source_intake: "${sourceIntake}"
---

# PRD: implement fixture

## Goal

Prove the implement command flow through one state.

## Non-goals

A second state store.

## Decisions

| D-n | 결정 | 근거 |
| --- | --- | --- |
| D-01 | one verify command with separate acceptance and fidelity judges | the two questions have different owners |

## Behaviors

| # | 사용자가 관찰하는 행동 | 검사 방법 | 결정 |
| --- | --- | --- | --- |
| B1 | A proved row can be verified and finalized from one state. | check: \`${checkCommand}\` | D-01 |
| B2 | The finalized state reads honestly to its operator. | judge: the log at agents/runs/fixture/artifacts/b2.log | D-01 |
${extraRows.map((row) => `${row}\n`).join("")}
## Technical structure

The CLI owns state.

## Risks

None.
`;
}

function makeProject({ profile = "standard", testExit = 0, sourceIntake = "current conversation", checkCommand = "npm test", extraRows = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-implement-"));
  fs.mkdirSync(path.join(root, "agents", "prd", "fixture"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", "prd", "fixture", "prd.md"), prd({ profile, sourceIntake, checkCommand, extraRows }));
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
      "implement:acceptance:B2": {
        verdict: "PASS",
        criteria: [{ id: "B2", verdict: "PASS", reason: "the finalized state reads honestly", evidence: "public CLI transcript" }],
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

function greenRow(root, row = "B1", { env } = {}) {
  const checked = run(root, ["implement", "check", "--row", row], env === undefined ? {} : { env });
  assert.equal(checked.status, 0, checked.stderr + checked.stdout);
}

// A check: row's green names the tree it was earned on, and verify refuses a
// green earned on an older tree. Every fixture that edits judged source after
// proving its rows re-proves them here before it verifies.
function greenChecks(root, { env } = {}) {
  for (const row of readState(root).rows) {
    if (row.check.kind === "check" && row.status !== "parked") greenRow(root, row.id, { env });
  }
}

function registerDeclaredEvidence(root, row = "B2", { env } = {}) {
  const rel = path.posix.join("agents", "runs", "fixture", "artifacts", `${row.toLowerCase()}.log`);
  fs.mkdirSync(path.join(root, "agents", "runs", "fixture", "artifacts"), { recursive: true });
  fs.writeFileSync(path.join(root, rel), `${row} declared evidence\n`);
  const registered = run(root, [
    "implement", "artifact", "--row", row, "--kind", "log", "--path", rel, "--description", `${row} declared evidence`,
  ], env === undefined ? {} : { env });
  assert.equal(registered.status, 0, registered.stderr + registered.stdout);
}

function startAndProve(root, { sourceChange = true, leaveUnregistered = [] } = {}) {
  const started = run(root, ["implement", "start", "--prd", "agents/prd/fixture/prd.md", "--dirty-attribution", "run-owned"]);
  assert.equal(started.status, 0, started.stderr + started.stdout);
  // A proved run normally represents source work after the baseline was
  // captured. The 2026-08-25 empty-diff incident proved that fixtures which
  // prove rows without making that work accidentally exercise an invalid run.
  if (sourceChange) writeFixtureImplementation(root);
  for (const row of readState(root).rows) {
    // A judge: row is refused before its judge is summoned unless the
    // evidence its cell declares is registered, so the fixture registers it.
    if (row.check.kind === "judge" && !leaveUnregistered.includes(row.id)) registerDeclaredEvidence(root, row.id);
  }
  greenChecks(root);
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
  startAndProve(root);
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
  registerDeclaredEvidence(root);
  greenChecks(root);
  const verified = run(root, ["implement", "verify"], { env });
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);
  const prompt = fs.readFileSync(path.join(capture, "implement_acceptance_B2.prompt.txt"), "utf8");
  assert.match(prompt, /- impl\.txt \[text,/);
  assert.match(prompt, /- package\.json \[text,/);
});

test("a real second unified round dispositions prior findings and admits only delta-grounded blockers", () => {
  const root = makeProject({ profile: "high-risk" });
  const { file, capture } = stub(root, "high-risk");
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  const configured = JSON.parse(fs.readFileSync(file, "utf8"));
  configured.byPurpose["implement:acceptance:B2"] = {
    verdict: "FAIL",
    criteria: [{ id: "B2", verdict: "FAIL", reason: "the first failure remains", evidence: "" }],
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
  startAndProve(root);
  const first = run(root, ["implement", "verify"], { env });
  assert.equal(first.status, 1, first.stderr + first.stdout);
  assert.equal(readState(root).rows.find((row) => row.id === "B2").status, "FAIL", "a judge: row takes the lane's verdict as its status");

  fs.writeFileSync(path.join(root, "impl.txt"), "round two changed this exact path\n");
  greenChecks(root);
  configured.byPurpose["implement:acceptance:B2"] = {
    verdict: "FAIL",
    criteria: [{
      id: "B2",
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
  assert.deepEqual(latest.roundContexts.acceptance.B2.changedPaths, ["impl.txt"]);
  assert.deepEqual(latest.roundContexts.fidelity.changedPaths, ["impl.txt"]);
  assert.deepEqual(latest.roundContexts.risk.changedPaths, ["impl.txt"]);
  // The design lane shares the same round shape: one prior attempt, the same
  // changed-path delta, recorded on the attempt like every other lane's.
  assert.deepEqual(latest.roundContexts.design.changedPaths, ["impl.txt"]);
  assert.equal(latest.roundContexts.design.priorAttemptId, latest.roundContexts.risk.priorAttemptId);
  const judged = latest.lanes.acceptance.result.criteria.find((entry) => entry.id === "B2");
  assert.equal(judged.priorDisposition.status, "resolved");
  assert.deepEqual(judged.deltaBasis, { kind: "changed-path", value: "impl.txt" });
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
  configured.byPurpose["implement:acceptance:B2"] = {
    verdict: "FAIL",
    criteria: [{ id: "B2", verdict: "FAIL", reason: "older unresolved acceptance", evidence: "" }],
  };
  configured.byPurpose["implement:risk"] = {
    verdict: "FAIL",
    findings: [{ severity: "blocking", text: "older unresolved risk" }],
  };
  fs.writeFileSync(file, JSON.stringify(configured));
  startAndProve(root);

  const first = run(root, ["implement", "verify"], { env });
  assert.equal(first.status, 1, first.stderr + first.stdout);
  const firstAttempt = readState(root).verificationAttempts.at(-1);

  // Both outputs are invalid only for their own lane. Fidelity still settles,
  // leaving a mixed partial attempt that must not become the lineage source
  // for acceptance B2 or risk.
  configured.byPurpose["implement:acceptance:B2"] = { verdict: "PASS", criteria: [] };
  configured.byPurpose["implement:risk"] = { verdict: "PASS", findings: [] };
  fs.writeFileSync(file, JSON.stringify(configured));
  const partial = run(root, ["implement", "verify"], { env });
  assert.equal(partial.status, 1, partial.stderr + partial.stdout);
  assert.equal(partial.json.detail.attempt.lanes.acceptance.verdict, "ERROR");
  assert.equal(partial.json.detail.attempt.lanes.risk.verdict, "ERROR");

  fs.writeFileSync(path.join(root, "impl.txt"), "the recovery changed this path\n");
  greenChecks(root);
  configured.byPurpose["implement:acceptance:B2"] = {
    verdict: "PASS",
    criteria: [{
      id: "B2",
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
  assert.equal(latest.lanes.acceptance.result.criteria.find((entry) => entry.id === "B2").priorDisposition.status, "resolved");
  assert.deepEqual(latest.lanes.risk.result.priorDispositions, [
    {
      id: "RF1",
      status: "resolved",
      reason: "the changed path removes it",
      deltaBasis: { kind: "changed-path", value: "impl.txt" },
    },
  ]);
  for (const name of ["implement_acceptance_B2.prompt.txt", "implement_risk.prompt.txt"]) {
    const prompt = fs.readFileSync(path.join(capture, name), "utf8");
    assert.match(prompt, new RegExp(`PRIOR ATTEMPT: ${firstAttempt.id}`));
    assert.match(prompt, /older unresolved/);
  }
});

test("verify refuses a proved run whose run-owned change set is empty", () => {
  const root = makeProject();
  const { file, capture } = stub(root);
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  startAndProve(root, { sourceChange: false });

  const refused = run(root, ["implement", "verify"], { env });
  assert.equal(refused.status, 1, refused.stderr + refused.stdout);
  assert.equal(refused.json.detail.reason, "empty-run-owned-change-set");
  assert.match(refused.json.message, /run-owned change set is empty/);
  assert.match(refused.json.message, /`sasu implement start` ran after the implementation was committed/);
  assert.match(refused.json.message, /dispositioned pre-existing at start/);
  assert.match(refused.json.message, /`sasu implement retire`/);
  assert.match(refused.json.message, /restart with `sasu implement start` before implementation begins/);
  assert.equal(readState(root).verificationAttempts.length, 0, "a refusal before any judge must not spend an attempt");
  assert.equal(run(root, ["implement", "status"]).json.detail.verification.budget.fixAttempts, 0);
  assert.equal(fs.existsSync(capture), false, "no judge may run for an empty change set");
});

// R3/R4: an unproved check: row stops verify before anything runs, and the
// suite axis blocks on its own. A command no row names is watching a
// regression nobody else is, so a fully green row score cannot clear it.
test("an unproved check: row and a red suite command each stop before either judge", () => {
  const root = makeProject({ testExit: 3, checkCommand: "node --version" });
  const { file, capture } = stub(root);
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  assert.equal(run(root, ["implement", "start", "--prd", "agents/prd/fixture/prd.md"]).status, 0);
  const unproved = run(root, ["implement", "verify"], { env });
  assert.equal(unproved.status, 2);
  assert.match(unproved.json.message, /verify requires every check: row green on the current tree; B1 is pending/);
  assert.match(unproved.json.message, /sasu implement check --row B<n>/);
  assert.equal(fs.existsSync(capture), false);
  assert.equal(readState(root).verificationAttempts.length, 0, "a refusal before any command must not spend an attempt");

  writeFixtureImplementation(root);
  registerDeclaredEvidence(root);
  greenChecks(root);
  assert.equal(readState(root).rows.find((row) => row.id === "B1").status, "green", "B1 must be green for this fixture to prove anything");
  const blocked = run(root, ["implement", "verify"], { env });
  assert.equal(blocked.status, 1);
  assert.equal(blocked.json.detail.judgeCalls, 0, "a red suite command stops before any judge");
  assert.match(blocked.json.message, /suite 0\/1 GREEN; npm test failed with exit 3/);
  assert.match(blocked.json.message, /amendment carrying verbatim human approval/);
  assert.equal(fs.existsSync(capture), false);
  assert.equal(blocked.json.detail.attempt.mechanical.length, 1);
  assert.equal(blocked.json.detail.attempt.mechanical[0].command, "npm test");

  const state = readState(root);
  const suiteResult = state.suite.results.find((entry) => entry.commandId === "S1");
  assert.equal(suiteResult.status, "RED", "the suite axis records its own verdict");
  assert.equal(state.rows.find((row) => row.id === "B1").status, "green", "the row axis is untouched by the suite's red");
});

// A suite command is not a row. The refusal must say why, not just
// "unknown row S1".
test("a sealed suite command cannot be parked", () => {
  const root = makeProject();
  assert.equal(run(root, ["implement", "start", "--prd", "agents/prd/fixture/prd.md", "--dirty-attribution", "run-owned"]).status, 0);
  assert.equal(readState(root).suite.commands[0].id, "S1");

  const refused = run(root, ["implement", "park", "--row", "S1", "--approval", "user: park it", "--reason", "flaky"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.json.message, /sealed suite command, not a Behaviors row/);
  assert.match(refused.json.message, /cannot be parked/);
  assert.match(refused.json.message, /amendment carrying verbatim human approval/);
  assert.deepEqual(readState(root).suite.exclusions, [], "a refused park must not become an exclusion");
});

// The list is sealed at start. What the run is measured against must not
// change because someone edited config mid-run.
test("the sealed suite list ignores a mid-run edit of agents/config.json", () => {
  const root = makeProject();
  assert.equal(run(root, ["implement", "start", "--prd", "agents/prd/fixture/prd.md", "--dirty-attribution", "run-owned"]).status, 0);
  const sealed = readState(root).suite.commands.map((entry) => entry.command);
  assert.deepEqual(sealed, ["npm test"]);

  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({
    verify: { commands: { test: "node -e \"process.exit(0)\"", build: "node -e \"process.exit(0)\"" } },
  }));
  writeFixtureImplementation(root);
  registerDeclaredEvidence(root);
  greenChecks(root);
  run(root, ["implement", "verify"]);

  const after = readState(root);
  assert.deepEqual(after.suite.commands.map((entry) => entry.command), sealed, "the sealed list is the authority, not the config file");
  assert.deepEqual(after.suite.results.map((entry) => entry.commandId), ["S1"]);
  assert.equal(after.suite.sealedAt, readState(root).suite.sealedAt);
});

// The supervisor plans and judges; it does not build, and until now nothing
// but self-restraint stopped it from saying the building is done.
test("the supervisor is refused implementation commands and accepted on its own verbs", () => {
  const root = makeProject();
  assert.equal(run(root, ["implement", "start", "--prd", "agents/prd/fixture/prd.md", "--dirty-attribution", "run-owned"]).status, 0);
  writeFixtureImplementation(root);

  for (const argv of [
    ["implement", "check", "--row", "B1"],
    ["implement", "artifact", "--row", "B2", "--kind", "log", "--path", "package.json", "--description", "not evidence"],
    ["implement", "verify"],
    ["implement", "finalize", "--status", "complete"],
  ]) {
    const refused = run(root, [...argv, "--issuer", "observer"]);
    assert.notEqual(refused.status, 0, `${argv[1]} must refuse an observer`);
    assert.match(refused.json.message, /observer may not issue/);
    assert.equal(refused.json.detail.rejectedCheck, "authority");
  }
  assert.equal(readState(root).rows.find((row) => row.id === "B1").attempts.length, 0, "a refused check must not run the command");

  // A park is the supervisor's own channel, and still needs the human's words.
  const unquoted = run(root, ["implement", "park", "--row", "B1", "--issuer", "observer", "--reason", "I would rather not"]);
  assert.notEqual(unquoted.status, 0);
  assert.match(unquoted.json.message, /requires --approval/);
  assert.equal(unquoted.json.detail.rejectedCheck, "transition");
  assert.equal(readState(root).verbs.at(-1).rejection.check, "transition", "the refused verb is in the history with the check that refused it");
  const ok = run(root, ["implement", "park", "--row", "B1", "--issuer", "observer", "--approval", "user: park B1 for now", "--reason", "blocked on a missing fixture"]);
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  assert.equal(readState(root).verbs.at(-1).issuer, "observer");
  assert.equal(readState(root).rows.find((row) => row.id === "B1").parks.at(-1).approval, "user: park B1 for now");

  // An unknown label is an argument problem, not an authority one.
  const bad = run(root, ["implement", "resume", "--row", "B1", "--issuer", "root"]);
  assert.notEqual(bad.status, 0);
  assert.equal(bad.json.detail.rejectedCheck, "arguments");
});

// One check on a parked row used to leave status "pending" against an active
// park record, which parseImplementState refuses - bricking every later
// command with no recovery path.
test("a check on a parked row is refused instead of bricking the run", () => {
  const root = makeProject();
  assert.equal(run(root, ["implement", "start", "--prd", "agents/prd/fixture/prd.md", "--dirty-attribution", "run-owned"]).status, 0);
  writeFixtureImplementation(root);
  greenRow(root);
  assert.equal(run(root, ["implement", "park", "--row", "B1", "--approval", "user: park it", "--reason", "later"]).status, 0);

  const refused = run(root, ["implement", "check", "--row", "B1"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.json.message, /is parked; run `sasu implement resume/);

  // The run is still readable and still recoverable, which is the point.
  assert.equal(run(root, ["implement", "status"]).status, 0);
  assert.equal(run(root, ["implement", "resume", "--row", "B1"]).status, 0);
  greenRow(root);
  assert.equal(readState(root).rows.find((row) => row.id === "B1").attempts.length, 2, "a park never deletes prior attempts");
});

// The log is the supervisor's memory of the run. Once written, an entry is
// never edited or removed for the life of the run.
test("the event log grows append-only across real mutations and never replays past a cursor", () => {
  const root = makeProject();
  assert.equal(run(root, ["implement", "start", "--prd", "agents/prd/fixture/prd.md", "--dirty-attribution", "run-owned"]).status, 0);
  writeFixtureImplementation(root);

  const snapshots = [];
  const record = () => { snapshots.push(readState(root).events.map((entry) => JSON.stringify(entry))); };
  record();
  greenRow(root);
  record();
  assert.equal(run(root, ["implement", "park", "--row", "B1", "--approval", "user: park it", "--reason", "later"]).status, 0);
  record();
  assert.equal(run(root, ["implement", "resume", "--row", "B1"]).status, 0);
  record();

  // Every snapshot is a prefix of the next: entries only ever get added.
  for (let index = 1; index < snapshots.length; index += 1) {
    const previous = snapshots[index - 1];
    const current = snapshots[index];
    assert.ok(current.length > previous.length, `mutation ${index} must record an event`);
    assert.deepEqual(current.slice(0, previous.length), previous, `mutation ${index} rewrote history`);
  }

  const events = readState(root).events;
  assert.deepEqual(events.map((entry) => entry.id), events.map((_, index) => index + 1), "ids are monotonic from 1");
  assert.deepEqual(
    events.map((entry) => entry.kind),
    ["check-attempt", "row-status", "park", "row-status", "resume", "row-status"],
  );
  for (const entry of events) assert.ok(["implementor", "observer", "human"].includes(entry.actor));

  // A backlog past the cursor returns immediately - no waiting, no replay.
  const woke = run(root, ["implement", "await", "--since", "1"]);
  assert.equal(woke.status, 0, woke.stderr + woke.stdout);
  assert.equal(woke.json.detail.reason, "event");
  assert.equal(woke.json.detail.waitedMs, 0);
  assert.deepEqual(woke.json.detail.events.map((entry) => entry.id), [2, 3, 4, 5, 6]);
  assert.equal(woke.json.detail.cursor, 6);
  assert.equal(woke.json.detail.livenessProbe, "unavailable");

  const caughtUp = run(root, ["implement", "await", "--since", "6", "--pid", "999999999"]);
  assert.equal(caughtUp.status, 0);
  assert.equal(caughtUp.json.detail.reason, "implementor-gone", "a dead pid ends the wait without burning the stall bound");
  assert.deepEqual(caughtUp.json.detail.events, []);

  assert.notEqual(run(root, ["implement", "await", "--since", "-1"]).status, 0);
});

test("acceptance and fidelity run separately in parallel, then finalize converges", () => {
  const root = makeProject();
  const { file, capture } = stub(root);
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  startAndProve(root);
  fs.writeFileSync(path.join(root, "source.txt"), "SOURCE-BODY-MUST-NOT-BE-INLINED\n");
  fs.writeFileSync(path.join(root, "runtime.log"), "REGISTERED-RUNTIME-EVIDENCE\n");
  const registered = run(root, [
    "implement", "artifact", "--row", "B2", "--kind", "log", "--path", "runtime.log", "--description", "runtime proof body",
  ]);
  assert.equal(registered.status, 0, registered.stderr + registered.stdout);
  greenChecks(root);
  const verified = run(root, ["implement", "verify"], { env });
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);
  // Lane progress is observable from outside the process while stdout stays
  // pure JSON: an opaque verify forces callers into ps-polling loops.
  assert.match(verified.stderr, /\[implement:verify\] mechanical PASS in [\d.]+s: npm test/);
  // The judge: row is timed because a judge ran; the check: row reports
  // that nobody was called (R4).
  assert.match(verified.stderr, /\[implement:verify\] acceptance B2: PASS \(\d+s\)/);
  assert.match(verified.stderr, /\[implement:verify\] acceptance B1: PASS \(from the check ledger, no judge call\)/);
  assert.match(verified.stderr, /\[implement:verify\] fidelity: PASS \(\d+s\)/);
  assert.match(verified.stderr, /\[implement:verify\] unified verification PASS in \d+s/);
  assert.doesNotMatch(verified.stdout, /\[implement:verify\]/, "progress must not corrupt the JSON stdout");
  const attempt = verified.json.detail.attempt;
  assert.equal(attempt.verdict, "PASS");
  assert.notEqual(attempt.lanes.acceptance.invocationId, attempt.lanes.fidelity.invocationId);
  const acceptanceInvocations = readState(root).verificationAttempts.at(-1).lanes.acceptance.result.invocations;
  // Both rows are in the lane's result; only the judge: row summoned a
  // judge, and each invocation says which happened (R4).
  assert.deepEqual(
    acceptanceInvocations.map((entry) => [entry.rowId, entry.source]).sort(),
    [["B1", "harness"], ["B2", "judge"]],
  );
  assert.equal(readState(root).rows.find((row) => row.id === "B2").status, "PASS");
  assert.ok(attempt.lanes.acceptance.startedAt <= attempt.lanes.fidelity.finishedAt);
  assert.ok(attempt.lanes.fidelity.startedAt <= attempt.lanes.acceptance.finishedAt);
  assert.equal(attempt.lanes.risk, null);
  assert.equal(attempt.mechanical.length, 1);

  const fidelityPrompt = fs.readFileSync(path.join(capture, "implement_fidelity.prompt.txt"), "utf8");
  assert.match(fidelityPrompt, /F1 Original goal preserved/);
  assert.match(fidelityPrompt, /SOURCE ROUTING: decisions/);
  assert.match(fidelityPrompt, /Do not repeat code-correctness/);
  const registeredProvenance = `agent-registered at ${registered.json.detail.artifact.registeredAt}; treat as the implementer's claim, not a harness observation`;
  assert.ok(fidelityPrompt.includes(registeredProvenance));

  const acceptancePrompt = fs.readFileSync(path.join(capture, "implement_acceptance_B2.prompt.txt"), "utf8");
  const acceptanceOptions = JSON.parse(fs.readFileSync(path.join(capture, "implement_acceptance_B2.options.json"), "utf8"));
  assert.match(acceptancePrompt, /"id": "B2"/);
  assert.match(acceptancePrompt, /- S1 GREEN \(exit 0\): npm test/, "the suite result reaches the judge as a fact");
  assert.match(acceptancePrompt, /REGISTERED-RUNTIME-EVIDENCE/);
  assert.ok(acceptancePrompt.includes(registeredProvenance));
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
  assert.equal(first.json.detail.receipt.schema, "sasu.implement.receipt.v4");
  assert.equal(first.json.detail.receipt.status, "complete");
  assert.deepEqual(first.json.detail.receipt.behaviors.map((entry) => [entry.id, entry.result.status]), [["B1", "green"], ["B2", "PASS"]]);
  assert.equal(first.json.detail.receipt.scoreLine, "기계·판사: 2/2 PASS | suite: 1/1 GREEN");
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
  startAndProve(root);
  const verified = run(root, ["implement", "verify"], { env });
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);
  const acceptancePrompt = fs.readFileSync(path.join(capture, "implement_acceptance_B2.prompt.txt"), "utf8");
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
  startAndProve(root);
  const verified = run(root, ["implement", "verify"], { env });
  assert.equal(verified.status, 1);
  const attempt = verified.json.detail.attempt;
  assert.equal(attempt.verdict, "ERROR");
  assert.equal(attempt.lanes.acceptance.verdict, "ERROR");
  assert.match(attempt.lanes.acceptance.error.message, /requires isolated read-only evidence access/);
  assert.equal(fs.existsSync(path.join(capture, "implement_acceptance_B2.prompt.txt")), false);
  assert.equal(fs.existsSync(path.join(capture, "implement_fidelity.prompt.txt")), true);
});

test("high-risk runs the risk judge only after both base lanes complete", () => {
  const root = makeProject({ profile: "high-risk" });
  const { file, capture } = stub(root, "high-risk");
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  startAndProve(root);
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
  startAndProve(trivialRoot);
  const trivial = run(trivialRoot, ["implement", "verify"], { env: trivialEnv });
  assert.equal(trivial.status, 0, trivial.stderr + trivial.stdout);
  assert.equal(trivial.json.detail.attempt.lanes.risk, null);
  assert.equal(fs.existsSync(path.join(trivialStub.capture, "implement_risk.prompt.txt")), false);
});

test("oversized design and risk diffs switch to isolated changed-file access", () => {
  const root = makeProject({ profile: "high-risk" });
  const { file, capture } = stub(root, "high-risk");
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  startAndProve(root);
  fs.writeFileSync(path.join(root, "large.ts"), `export const large = "${"x".repeat(130_000)}";\n`);
  greenChecks(root);

  const verified = run(root, ["implement", "verify"], { env });
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);
  // Design runs at its own measured budget; risk carries a verdict and keeps
  // the high-risk profile's.
  for (const [purpose, effort] of [["implement_design", "high"], ["implement_risk", "xhigh"]]) {
    const prompt = fs.readFileSync(path.join(capture, `${purpose}.prompt.txt`), "utf8");
    const options = JSON.parse(fs.readFileSync(path.join(capture, `${purpose}.options.json`), "utf8"));
    assert.match(prompt, /exceeds the 120000-character review input limit, so it is shown per file/);
    assert.match(prompt, /^- large\.ts \(\+1\/-0\)$/m, "the oversized file is listed with its counts, not shown");
    assert.deepEqual(options, { agentic: true, cwd: fs.realpathSync(root), effort });
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
  startAndProve(root);

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
  greenChecks(root);
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
  startAndProve(root);
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
  startAndProve(root);

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

test("registered runtime evidence stays source-independent while file identity failures remain observable", () => {
  const root = makeProject();
  fs.writeFileSync(path.join(root, "runtime.log"), "runtime proof\n");
  startAndProve(root);
  const register = () => run(root, [
    "implement", "artifact", "--row", "B2", "--kind", "log", "--path", "runtime.log", "--description", "runtime proof",
  ]);
  const registered = register();
  assert.equal(registered.status, 0);
  assert.equal(Object.hasOwn(registered.json.detail.artifact, "sourceFingerprint"), false);

  fs.writeFileSync(path.join(root, "source.txt"), "judged source moved\n");
  const sourceChange = run(root, ["implement", "status"]).json.detail.artifactProblems;
  assert.deepEqual(sourceChange, [], "an unrelated source edit must not stale every registered artifact");

  fs.writeFileSync(path.join(root, "runtime.log"), "changed proof\n");
  const ownChange = run(root, ["implement", "status"]).json.detail.artifactProblems.join("\n");
  assert.match(ownChange, /artifact hash changed/);

  fs.rmSync(path.join(root, "runtime.log"));
  const deleted = run(root, ["implement", "status"]).json.detail.artifactProblems.join("\n");
  assert.match(deleted, /artifact missing/);
});

test("a source change after unified PASS makes finalize refuse the stale attempt", () => {
  const root = makeProject();
  const { file, capture } = stub(root);
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  fs.writeFileSync(path.join(root, "source.txt"), "judged source\n");
  startAndProve(root);
  assert.equal(run(root, ["implement", "verify"], { env }).status, 0);
  fs.writeFileSync(path.join(root, "source.txt"), "changed after pass\n");
  for (let index = 0; index < 21; index += 1) {
    fs.writeFileSync(path.join(root, `z-post-pass-${String(index).padStart(2, "0")}.txt`), "changed after pass\n");
  }

  const stale = run(root, ["implement", "status"]);
  assert.equal(stale.json.detail.verification.verdict, "STALE");
  const finalized = run(root, ["implement", "finalize", "--status", "complete"]);
  assert.equal(finalized.status, 2);
  // The row's own green names the tree it was earned on, so it is stale too.
  assert.match(finalized.json.message, /B1 is green on tree [0-9a-f]{12}, but the judged tree is now/);
  assert.match(finalized.json.message, /STALE because judged source changed/);
  assert.match(finalized.json.message, /changed paths since judged attempt .+ \(first 20 of 22\): source\.txt/);
  assert.match(finalized.json.message, /z-post-pass-18\.txt/);
  assert.doesNotMatch(finalized.json.message, /z-post-pass-19\.txt|z-post-pass-20\.txt/);
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
  startAndProve(root);
  const verified = run(root, ["implement", "verify"], { env });
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);
  assert.equal(verified.json.detail.attempt.fidelityInput.routing, "decisions");

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
  startAndProve(root);
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
  startAndProve(root);
  assert.equal(run(root, ["implement", "verify"], { env }).status, 0);
  assert.equal(run(root, ["implement", "finalize"]).status, 0);
  fs.appendFileSync(path.join(root, "agents", "prd", "fixture", "prd.md"), "\nChanged after completion.\n");

  const repeated = run(root, ["implement", "finalize"]);
  assert.equal(repeated.status, 2);
  assert.match(repeated.json.message, /PRD changed after implement start/);
});

test("missing or malformed PRD, state, artifact, and judge input fail closed with an observable cause", () => {
  const missingPrdRoot = makeProject();
  startAndProve(missingPrdRoot);
  fs.rmSync(path.join(missingPrdRoot, "agents", "prd", "fixture", "prd.md"));
  const missingPrd = run(missingPrdRoot, ["implement", "verify"]);
  assert.equal(missingPrd.status, 2);
  assert.match(missingPrd.json.message, /PRD changed after implement start/);
  assert.match(missingPrd.json.message, /current sha256: missing/);
  assert.equal(missingPrd.json.detail.prdDrift.code, "prd-drift");

  const malformedStateRoot = makeProject();
  startAndProve(malformedStateRoot);
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
  startAndProve(missingArtifactRoot);
  assert.equal(run(missingArtifactRoot, [
    "implement", "artifact", "--row", "B2", "--kind", "log", "--path", "runtime.log", "--description", "proof",
  ]).status, 0);
  fs.rmSync(path.join(missingArtifactRoot, "runtime.log"));
  greenChecks(missingArtifactRoot);
  const missingArtifact = run(missingArtifactRoot, ["implement", "verify"], { env: artifactEnv });
  assert.equal(missingArtifact.status, 1);
  assert.match(missingArtifact.json.message, /artifact integrity preflight failed/);
  assert.match(missingArtifact.json.detail.problems.join("\n"), /artifact missing/);
  assert.equal(missingArtifact.json.detail.judgeCalls, 0);
  assert.equal(readState(missingArtifactRoot).verificationAttempts.length, 0);
  assert.equal(fs.existsSync(artifactStub.capture), false);

  const malformedJudgeRoot = makeProject();
  const judgeStub = stub(malformedJudgeRoot);
  fs.writeFileSync(judgeStub.file, "{bad json");
  const judgeEnv = {
    SASU_JUDGE_BACKEND: "stub",
    SASU_JUDGE_STUB_FILE: judgeStub.file,
    SASU_JUDGE_STUB_CAPTURE_DIR: judgeStub.capture,
  };
  startAndProve(malformedJudgeRoot);
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
  startAndProve(root);
  const command = [
    "implement", "artifact", "--row", "B2", "--kind", "log", "--path", "runtime.log", "--description", "runtime proof",
  ];
  const first = run(root, command);
  const second = run(root, [...command.slice(0, -1), "attempted metadata-only relabel"]);
  assert.equal(first.status, 0);
  assert.equal(second.status, 0);
  assert.equal(first.json.detail.artifact.registeredAt, second.json.detail.artifact.registeredAt);
  assert.equal(second.json.detail.unchanged, true);
  assert.equal(
    second.json.message,
    `artifact unchanged since ${first.json.detail.artifact.registeredAt}; registration timestamp preserved for B2: runtime.log`,
  );
  assert.deepEqual(
    readState(root).artifacts.filter((entry) => entry.rowId === "B2" && entry.path === "runtime.log"),
    [first.json.detail.artifact],
    "same bytes must preserve the entire prior artifact record",
  );
  assert.equal(Object.hasOwn(first.json.detail.artifact, "sourceFingerprint"), false);

  fs.writeFileSync(path.join(root, "runtime.log"), "runtime proof with changed bytes\n");
  const changed = run(root, command);
  assert.equal(changed.status, 0);
  assert.notEqual(changed.json.detail.artifact.sha256, first.json.detail.artifact.sha256);
  assert.notEqual(changed.json.detail.artifact.registeredAt, first.json.detail.artifact.registeredAt);
  assert.equal(Object.hasOwn(changed.json.detail.artifact, "sourceFingerprint"), false);

  greenChecks(root);
  const verifiedOnce = run(root, ["implement", "verify"], { env });
  const verifiedTwice = run(root, ["implement", "verify"], { env });
  assert.equal(verifiedOnce.status, 0, verifiedOnce.stderr + verifiedOnce.stdout);
  assert.equal(verifiedTwice.status, 0, verifiedTwice.stderr + verifiedTwice.stdout);
  assert.equal(readState(root).verificationAttempts.length, 2);
  assert.equal(readState(root).verificationAttempts.every((attempt) => attempt.verdict === "PASS"), true);
  assert.equal(verifiedTwice.json.detail.verificationBudget.fixAttempts, 0);
  assert.equal(verifiedTwice.json.detail.verificationBudget.consecutiveErrors, 0);
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
  registerDeclaredEvidence(root);
  greenChecks(root);
  assert.equal(run(root, ["implement", "verify"], { env }).status, 0);
  const finalized = run(root, ["implement", "finalize"]);
  assert.equal(finalized.status, 0, finalized.stderr + finalized.stdout);
  assert.equal(finalized.json.detail.receipt.status, "complete");
});

test("implement verify stops at the configured fix budget before running more work", () => {
  const root = makeProject({ checkCommand: "node --version" });
  fs.mkdirSync(path.join(root, "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({ judge: { retryBudget: 2 } }));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    scripts: {
      test: "node -e \"const fs=require('fs');const p='agents/verify-count';const n=fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0;fs.writeFileSync(p,String(n+1));process.exit(1)\"",
    },
  }));
  startAndProve(root);

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
  const root = makeProject({ checkCommand: "node --version" });
  fs.mkdirSync(path.join(root, "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({ judge: { retryBudget: 2 } }));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(1)\"" } }));
  startAndProve(root);

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
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({ judge: { retryBudget: 15 } }));
  const { file, capture } = stub(root);
  fs.writeFileSync(file, "{bad json");
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  startAndProve(root);

  assert.equal(run(root, ["implement", "verify"], { env }).status, 1);
  const second = run(root, ["implement", "verify"], { env });
  assert.equal(second.status, 1);
  assert.equal(second.json.detail.verificationBudget.fixAttempts, 0);
  assert.equal(second.json.detail.verificationBudget.judgeErrorLoop, false);
  const third = run(root, ["implement", "verify"], { env });
  assert.equal(third.status, 1);
  assert.equal(third.json.detail.verificationBudget.fixAttempts, 0);
  assert.equal(third.json.detail.verificationBudget.judgeErrorThreshold, 3);
  assert.equal(third.json.detail.verificationBudget.judgeErrorCause, "unknown/judge-runtime");
  assert.equal(third.json.detail.verificationBudget.judgeErrorLoop, true, "backend survival stops independently of the 15-round fix budget");
  const refused = run(root, ["implement", "verify"], { env });
  assert.equal(refused.status, 1);
  assert.equal(refused.json.detail.terminalReason, "judge-error-loop");
  assert.equal(readState(root).verificationAttempts.length, 3);
  const closed = run(root, ["implement", "finalize", "--status", "blocked"]);
  assert.equal(closed.status, 0, closed.stderr + closed.stdout);
  assert.equal(closed.json.detail.receipt.verificationBudget.judgeErrorThreshold, 3);
  assert.equal(closed.json.detail.receipt.verificationBudget.judgeErrorCause, "unknown/judge-runtime");
  assert.equal(closed.json.detail.receipt.verificationBudget.judgeErrorLoop, true);
});

test("settled verdicts from an ERROR'd attempt are reused on the unchanged tree only", () => {
  // Two judge: rows: the acceptance judge is only summoned for judge: rows
  // (R4), so reuse across an ERROR'd attempt - the behaviour this test
  // protects - can only be exercised through rows that reach one.
  const root = makeProject({ extraRows: [judgeRow("B3", "The same flow reports its status honestly.")] });
  const { file, capture } = stub(root);
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  startAndProve(root);

  // B3 has no stub entry, so its judge call errors while B2 and fidelity settle.
  const errored = run(root, ["implement", "verify"], { env });
  assert.equal(errored.status, 1);
  const first = errored.json.detail.attempt;
  assert.equal(first.verdict, "ERROR");
  assert.equal(first.lanes.acceptance.verdict, "ERROR");
  assert.equal(first.lanes.fidelity.verdict, "PASS");
  // Per-invocation detail lives only in state.json; the response carries a summary.
  const settledB2 = readState(root).verificationAttempts.at(-1).lanes.acceptance.result.invocations.find((entry) => entry.rowId === "B2");
  assert.equal(settledB2.verdict, "PASS");
  assert.equal(settledB2.source, "judge");
  assert.equal(errored.json.detail.verificationBudget.fixAttempts, 0, "an infrastructure ERROR spends no fix budget");

  const stubJson = JSON.parse(fs.readFileSync(file, "utf8"));
  stubJson.byPurpose["implement:acceptance:B3"] = {
    verdict: "PASS",
    criteria: [{ id: "B3", verdict: "PASS", reason: "status honest", evidence: "transcript" }],
  };
  fs.writeFileSync(file, JSON.stringify(stubJson));
  fs.rmSync(capture, { recursive: true, force: true });

  const reused = run(root, ["implement", "verify"], { env });
  assert.equal(reused.status, 0, reused.stderr + reused.stdout);
  const second = reused.json.detail.attempt;
  assert.equal(second.verdict, "PASS");
  const secondState = readState(root).verificationAttempts.at(-1);
  const byId = Object.fromEntries(secondState.lanes.acceptance.result.invocations.map((entry) => [entry.rowId, entry]));
  assert.equal(byId.B2.reusedFrom, first.id);
  assert.equal(byId.B2.invocationId, settledB2.invocationId);
  assert.equal(byId.B3.reusedFrom, undefined);
  // The check: row is recomputed every attempt, never carried over: there is
  // no expensive judgment to preserve, and a carry-over would be a second
  // record of what state.json already holds.
  assert.equal(byId.B1.reusedFrom, undefined);
  assert.equal(byId.B1.source, "harness");
  assert.equal(second.lanes.fidelity.reusedFrom, first.id);
  assert.deepEqual(secondState.lanes.acceptance.result.criteria.map((entry) => entry.id).sort(), ["B1", "B2", "B3"]);
  assert.equal(fs.existsSync(path.join(capture, "implement_acceptance_B2.prompt.txt")), false, "a reused row must not re-call its judge");
  assert.equal(fs.existsSync(path.join(capture, "implement_fidelity.prompt.txt")), false, "a reused fidelity lane must not re-call its judge");
  assert.equal(fs.existsSync(path.join(capture, "implement_acceptance_B3.prompt.txt")), true);

  // ERROR again, then move the tree: nothing may be reused across a source change.
  delete stubJson.byPurpose["implement:acceptance:B3"];
  fs.writeFileSync(file, JSON.stringify(stubJson));
  assert.equal(run(root, ["implement", "verify"], { env }).json.detail.attempt.verdict, "ERROR");

  stubJson.byPurpose["implement:acceptance:B3"] = {
    verdict: "PASS",
    criteria: [{ id: "B3", verdict: "PASS", reason: "status honest", evidence: "transcript" }],
  };
  fs.writeFileSync(file, JSON.stringify(stubJson));
  fs.writeFileSync(path.join(root, "changed.txt"), "the judged tree moved\n");
  greenChecks(root);
  fs.rmSync(capture, { recursive: true, force: true });
  const fresh = run(root, ["implement", "verify"], { env });
  assert.equal(fresh.status, 0, fresh.stderr + fresh.stdout);
  const third = fresh.json.detail.attempt;
  assert.equal(third.verdict, "PASS");
  assert.ok(readState(root).verificationAttempts.at(-1).lanes.acceptance.result.invocations.every((entry) => entry.reusedFrom === undefined));
  assert.equal(third.lanes.fidelity.reusedFrom, undefined);
  assert.equal(fs.existsSync(path.join(capture, "implement_acceptance_B2.prompt.txt")), true, "a changed tree re-judges every row");
});

test("a terminally stuck run closes through an explicit blocked finalize and can recover", () => {
  const root = makeProject({ checkCommand: "node --version" });
  fs.mkdirSync(path.join(root, "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({ judge: { retryBudget: 2 } }));
  const failingTest = JSON.stringify({ scripts: { test: "node -e \"process.exit(1)\"" } });
  fs.writeFileSync(path.join(root, "package.json"), failingTest);
  const { file, capture } = stub(root);
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  startAndProve(root);

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
  assert.equal(recovered.status, 2, "a blocked run still refuses a stale check: row before it reactivates");
  assert.match(recovered.json.message, /B1 is green on tree/);
  greenChecks(root);
  const reactivated = run(root, ["implement", "verify"], { env });
  assert.equal(reactivated.status, 0, reactivated.stderr + reactivated.stdout);
  assert.equal(readState(root).status, "active");
  const finalized = run(root, ["implement", "finalize"]);
  assert.equal(finalized.status, 0, finalized.stderr + finalized.stdout);
  assert.equal(finalized.json.detail.receipt.status, "complete");
  assert.equal(readState(root).status, "complete");
});

test("a judge: row without its declared evidence fails before a judge call", () => {
  const root = makeProject({ extraRows: [judgeRow("B3", "The same flow reports its status honestly.")] });
  const { file, capture } = stub(root);
  const stubJson = JSON.parse(fs.readFileSync(file, "utf8"));
  stubJson.byPurpose["implement:acceptance:B3"] = {
    verdict: "PASS",
    criteria: [{ id: "B3", verdict: "PASS", reason: "status honest", evidence: "src/status.ts" }],
  };
  fs.writeFileSync(file, JSON.stringify(stubJson));
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  startAndProve(root, { leaveUnregistered: ["B3"] });

  // A declaration is not evidence. The harness fails B3 before provider
  // routing and still lets the other two settle normally.
  const verified = run(root, ["implement", "verify"], { env });
  assert.equal(verified.status, 1);
  const attempt = verified.json.detail.attempt;
  assert.equal(attempt.lanes.acceptance.verdict, "FAIL");
  const invocations = readState(root).verificationAttempts.at(-1).lanes.acceptance.result.invocations;
  const byId = Object.fromEntries(invocations.map((entry) => [entry.rowId, entry]));
  // B1 is a check: row: it stays in the lane's result but is settled from
  // its own exit code, and the record says so rather than leaving a null
  // judge to be read as a lost record (R4).
  assert.equal(byId.B1.verdict, "PASS");
  assert.equal(byId.B1.source, "harness", "settled from its own exit code");
  assert.equal(byId.B1.judge, null);
  // B2's evidence is registered, so its judge was summoned and ruled.
  assert.equal(byId.B2.verdict, "PASS");
  assert.equal(byId.B2.source, "judge");
  // B3 declared evidence nobody registered, so nobody was summoned for it.
  assert.equal(byId.B3.verdict, "FAIL");
  assert.equal(byId.B3.source, "harness", "refused before the judge was summoned, for want of the declared evidence");
  assert.equal(byId.B3.judge, null);
  assert.equal(byId.B3.error, null);
  assert.equal(readState(root).rows.find((row) => row.id === "B3").status, "FAIL");
  assert.match(attempt.lanes.acceptance.failing[0].evidence, /sasu implement artifact --row B3/);
  assert.equal(fs.existsSync(path.join(capture, "implement_acceptance_B3.prompt.txt")), false);

  // Registering the declared evidence against B3 admits its judge.
  fs.mkdirSync(path.join(root, "agents", "runs", "fixture", "artifacts"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", "runs", "fixture", "artifacts", "b3.log"), "status lifecycle proof\n");
  const registered = run(root, [
    "implement", "artifact", "--row", "B3", "--kind", "log",
    "--path", "agents/runs/fixture/artifacts/b3.log", "--description", "status lifecycle proof",
  ]);
  assert.equal(registered.status, 0, registered.stderr + registered.stdout);
  stubJson.byPurpose["implement:acceptance:B3"].criteria[0].priorDisposition = {
    status: "resolved",
    reason: "the declared status evidence is now registered against B3",
  };
  fs.writeFileSync(file, JSON.stringify(stubJson));
  const attested = run(root, ["implement", "verify"], { env });
  assert.equal(attested.status, 0, attested.stderr + attested.stdout);
  assert.equal(attested.json.detail.attempt.verdict, "PASS");
  assert.equal(readState(root).rows.find((row) => row.id === "B3").status, "PASS");
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
  registerDeclaredEvidence(root, "B2", { env: sessionA });
  const refused = run(root, ["implement", "check", "--row", "B1", "--slug", "fixture"], { env: sessionB });
  assert.equal(refused.status, 2);
  assert.match(refused.json.message, /owned by another session \(session-a\)/);
  assert.equal(readState(root).ownerSessionId, "session-a");
  const adopted = run(
    root,
    ["implement", "check", "--row", "B1", "--slug", "fixture", "--adopt", "user said take it over"],
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
  const sessionC = { CLAUDE_CODE_SESSION_ID: "session-c" };
  greenRow(root, "B1", { env: sessionC });
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
  fs.mkdirSync(path.join(root, "agents", "runs", "fixture-b", "artifacts"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", "runs", "fixture-b", "artifacts", "b2.log"), "B2 declared evidence\n");
  const registered = run(root, [
    "implement", "artifact", "--row", "B2", "--kind", "log", "--path", "agents/runs/fixture-b/artifacts/b2.log", "--description", "B2 declared evidence",
  ], { env: b });
  assert.equal(registered.status, 0, registered.stderr + registered.stdout);
  greenRow(root, "B1", { env: b });
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
  // budget never reached a lane (a mis-declared binding and an own test
  // failure). Only 2 real judged rounds were spendable and an otherwise
  // finished run closed as blocked. A failing test suite converges; the
  // budget exists for the stage that does not (PRINCIPLES 13).
  const root = makeProject({ testExit: 1, checkCommand: "node --version" });
  fs.mkdirSync(path.join(root, "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({ judge: { retryBudget: 2 } }));
  startAndProve(root);

  // The first deterministic failure did not invoke a generative stage, so it
  // cannot spend the budget that exists to bound that stage.
  assert.equal(run(root, ["implement", "verify"]).status, 1);
  assert.equal(run(root, ["implement", "status"]).json.detail.verification.budget.fixAttempts, 0);

  // A real fix lands in the judged tree; the next mechanical failure is free.
  fs.writeFileSync(path.join(root, "fix-one.txt"), "a real change between rounds\n");
  greenChecks(root);
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
  startAndProve(root);

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
  startAndProve(root);
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
  startAndProve(root);
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
  startAndProve(root);
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
  startAndProve(root);
  const verified = run(root, ["implement", "verify"], { env });
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);
  assert.equal(verified.json.detail.design.ran, false);
  assert.equal(fs.existsSync(path.join(capture, "implement_design.prompt.txt")), false);
  assert.equal(readState(root).designComments, undefined);
  assert.equal(run(root, ["implement", "finalize"]).status, 0);
});

// Lane-ordering contract. The design lane produces comments, not a verdict:
// riskPrompt never receives its result and the unified verdict never reads
// it. Holding risk behind it inside one Promise.all cost 23.1 minutes of pure
// wait across the 8 verify attempts of the 2026-08-27 crawler-arena run - 41%
// of that run's total verify wall clock, against a design lane measured at
// 264-655s. A slow design lane must not delay risk by a single second.
test("a slow design lane does not delay the risk lane", () => {
  const root = makeProject({ profile: "high-risk" });
  const { file } = stub(root, "high-risk");
  const env = {
    SASU_JUDGE_BACKEND: "stub",
    SASU_JUDGE_STUB_FILE: file,
    // 3000ms, not a tighter figure: the assertion compares lane wall-clock
    // ordering, and a loaded CI box can stretch the stub lanes' bookkeeping
    // enough to false-fail a small delay.
    SASU_JUDGE_STUB_DELAY_MS: JSON.stringify({ "implement:design": 3000 }),
  };
  startAndProve(root);
  const verified = run(root, ["implement", "verify"], { env });
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);

  const state = readState(root);
  const attempt = state.verificationAttempts.at(-1);
  const { design, risk, acceptance } = attempt.lanes;
  assert.ok(design, "the design lane must still run on a high-risk profile");
  assert.ok(risk, "the risk lane must still run on a high-risk profile");
  assert.ok(design.durationMs >= 1500, `the design lane must actually be the slow one, was ${design.durationMs}ms`);
  assert.ok(
    Date.parse(risk.startedAt) < Date.parse(design.finishedAt),
    `risk must start before design finishes (risk ${risk.startedAt}, design finished ${design.finishedAt})`,
  );
  // Risk still waits for what it genuinely consumes.
  assert.ok(
    Date.parse(risk.startedAt) >= Date.parse(acceptance.finishedAt),
    "risk must still start after the acceptance result it is prompted with",
  );
});

test("a design lane outside the risk barrier still records its comments on the attempt", () => {
  const root = makeProject({ profile: "high-risk" });
  const { file } = stub(root, "high-risk");
  const configured = JSON.parse(fs.readFileSync(file, "utf8"));
  configured.byPurpose["implement:design"] = {
    comments: [{ area: "dead-weight", path: "package.json", text: "unused script", suggestion: "remove it" }],
  };
  fs.writeFileSync(file, JSON.stringify(configured));
  const env = {
    SASU_JUDGE_BACKEND: "stub",
    SASU_JUDGE_STUB_FILE: file,
    SASU_JUDGE_STUB_DELAY_MS: JSON.stringify({ "implement:design": 300 }),
  };
  startAndProve(root);
  const verified = run(root, ["implement", "verify"], { env });
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);

  const state = readState(root);
  const attempt = state.verificationAttempts.at(-1);
  assert.equal(attempt.lanes.design.result.comments.length, 1);
  assert.equal(state.designComments.length, 1);
  assert.equal(verified.json.detail.design.open.length, 1, "the caller must still be handed the comment it owes an answer for");
});

test("a harness-owned mechanical log cannot be registered as runtime evidence", () => {
  const root = makeProject();
  const { file, capture } = stub(root);
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  startAndProve(root);
  assert.equal(run(root, ["implement", "verify"], { env }).status, 0);
  const logPath = readState(root).artifacts.find((entry) => entry.command !== undefined).path;
  // 2026-08-27 crawler-arena: this exact registration deadlocked the run -
  // the harness rewrites its log every verify, so the frozen sha could never
  // match again and the integrity preflight failed forever.
  const refused = run(root, ["implement", "artifact", "--row", "B2", "--kind", "log", "--path", logPath, "--description", "harness log as claim"]);
  assert.equal(refused.status, 2, refused.stderr + refused.stdout);
  assert.match(refused.json.message ?? refused.stderr, /harness-owned and rewritten by the harness/);
});

test("harness-owned files and their symlink aliases cannot be registered as evidence", () => {
  const root = makeProject();
  startAndProve(root);
  // state.json is self-invalidating evidence: registering it freezes a sha
  // that the registration's own persistState immediately rewrites, after
  // which every verify fails the integrity preflight forever.
  const stateRefused = run(root, ["implement", "artifact", "--row", "B2", "--kind", "file", "--path", "agents/runs/fixture/state.json", "--description", "self-referential claim"]);
  assert.equal(stateRefused.status, 2, stateRefused.stderr + stateRefused.stdout);
  assert.match(stateRefused.json.message ?? stateRefused.stderr, /harness-owned and rewritten by the harness/);
  const prdRefused = run(root, ["implement", "artifact", "--row", "B2", "--kind", "file", "--path", "agents/runs/fixture/prd.md", "--description", "pinned prd as claim"]);
  assert.equal(prdRefused.status, 2);
  // A project-internal symlink alias points at the same harness-owned file;
  // the refusal resolves realpath, so the alias is judged by its target.
  fs.symlinkSync(path.join(root, "agents", "runs", "fixture", "state.json"), path.join(root, "alias-state.json"));
  const aliasRefused = run(root, ["implement", "artifact", "--row", "B2", "--kind", "file", "--path", "alias-state.json", "--description", "alias claim"]);
  assert.equal(aliasRefused.status, 2, aliasRefused.stderr + aliasRefused.stdout);
  assert.match(aliasRefused.json.message ?? aliasRefused.stderr, /harness-owned/);
});

test("a legacy agent-registered harness log is purged so the run can verify again", () => {
  const root = makeProject();
  const { file, capture } = stub(root);
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  startAndProve(root);
  assert.equal(run(root, ["implement", "verify"], { env }).status, 0);
  // Reproduce the poisoned shape directly: an agent-registered copy of the
  // harness's own mechanical log, sha frozen at a value the next mechanical
  // run is guaranteed to invalidate.
  const statePath = path.join(root, "agents", "runs", "fixture", "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const commandLog = state.artifacts.find((entry) => entry.command !== undefined);
  state.artifacts.push({
    rowId: "B2",
    kind: "log",
    path: commandLog.path,
    description: "poisoned legacy registration",
    sha256: "0".repeat(64),
    bytes: 1,
    registeredAt: new Date().toISOString(),
  });
  // The same species one directory up: state.json itself, which every
  // persistState rewrites. The purge must cover the harness-owned class,
  // not one log directory.
  state.artifacts.push({
    rowId: "B2",
    kind: "file",
    path: "agents/runs/fixture/state.json",
    description: "poisoned self-referential registration",
    sha256: "0".repeat(64),
    bytes: 1,
    registeredAt: new Date().toISOString(),
  });
  // And the alias face of the same poison: a legacy symlink registration
  // whose stored string names the alias, not the harness-owned target.
  fs.symlinkSync(path.join(root, "agents", "runs", "fixture", "state.json"), path.join(root, "legacy-alias.json"));
  state.artifacts.push({
    rowId: "B2",
    kind: "file",
    path: "legacy-alias.json",
    description: "poisoned legacy alias registration",
    sha256: "0".repeat(64),
    bytes: 1,
    registeredAt: new Date().toISOString(),
  });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  // The alias symlink is judged source, so the row is re-proved on it first.
  greenChecks(root);
  const repaired = run(root, ["implement", "verify"], { env });
  assert.equal(repaired.status, 0, repaired.stderr + repaired.stdout);
  assert.match(repaired.stderr, /dropped 3 agent-registered artifact\(s\) on harness-owned path\(s\)/);
  assert.equal(
    readState(root).artifacts.filter((entry) => entry.command === undefined && entry.path === commandLog.path).length,
    0,
    "the poisoned entry must be gone from the record",
  );
});

// PRD gate-loop R9/AC15: a PRD with no interview qa-log has no user
// utterances for the specification judges to compare against, so start does
// not require gap-audit/spec and the receipt says the judge did not run
// instead of implying a judgment that never happened.
test("AC15: a conversation-only PRD starts without judge PASS and its receipt records why the judge did not run", () => {
  const root = makeProject();
  const { file, capture } = stub(root);
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  assert.equal(fs.existsSync(path.join(root, "agents", "runs", "fixture", "gates")), false, "no gate ever ran");
  startAndProve(root);
  const judge = readState(root).prd.judge;
  assert.equal(judge.required, false);
  assert.match(judge.skippedReason, /^judge not run: no user utterances to judge against \(source_intake is "current conversation", not an interview qa-log\)$/);
  assert.equal(judge.gapAudit, null);
  assert.equal(judge.spec, null);

  const verified = run(root, ["implement", "verify"], { env });
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);
  const finalized = run(root, ["implement", "finalize"], { env });
  assert.equal(finalized.status, 0, finalized.stderr + finalized.stdout);
  const receipt = JSON.parse(fs.readFileSync(path.join(root, finalized.json.detail.completion.receiptPath), "utf8"));
  assert.deepEqual(receipt.prdJudge, judge, "the receipt carries the reason verbatim from start");
  assert.equal(fs.existsSync(path.join(root, "agents", "runs", "fixture", "gates")), false, "still no gate ran");
});
