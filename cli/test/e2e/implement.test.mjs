import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { PRD_PATH, STATE_PATH, REVIEW_PASS, makeProject, prd, readState, run, start, stub, ok, registerEvidence, defect, reviewWithAssessments } from "../helpers/implement-fixture.mjs";

const QA_FIXTURE = fs.readFileSync(path.resolve(import.meta.dirname, "../fixtures/prelint/qa-clean.md"), "utf8");

test("thirty requirements receive grouped evidence grounds in independent reviews and the receipt", () => {
  const root = makeProject({ count: 30 });
  start(root);
  const env = stub(root);
  const observation = registerEvidence(root);
  const verified = run(root, ["implement", "verify"], { env });
  ok(verified);
  const state = readState(root);
  assert.equal(state.schema, "sasu.implement.state.v10");
  assert.equal(state.requirements.length, 30);
  assert.equal(state.rows, undefined);
  for (const requirement of state.requirements) assert.deepEqual(Object.keys(requirement).sort(), ["behavior", "decisionIds", "id"]);
  for (const role of ["fidelity", "code"]) {
  const prompt = fs.readFileSync(path.join(env.SASU_JUDGE_STUB_CAPTURE_DIR, `implement_${role}.prompt.txt`), "utf8");
  for (let index = 1; index <= 30; index++) assert.ok(prompt.includes(`Requirement ${index}:`), `B${index} must not be omitted`);
  assert.ok(prompt.includes("Preserve every value in the approved request."));
  assert.ok(prompt.includes("The user requested all values."));
  assert.ok(prompt.includes(observation));
  }
  assert.deepEqual(fs.readdirSync(env.SASU_JUDGE_STUB_CAPTURE_DIR).filter((name) => name.endsWith(".prompt.txt")), ["implement_code.prompt.txt", "implement_fidelity.prompt.txt"]);
  assert.equal(fs.readFileSync(path.join(root, "agents/suite-count.log"), "utf8"), "ran\n");
  const attempt = state.verificationAttempts.at(-1);
  assert.equal(attempt.verdict, "PASS");
  assert.equal(attempt.prdSha256, state.prd.sha256);
  assert.deepEqual(attempt.reviewContext.requiredRequirementRefs, state.requirements.map((entry) => entry.id));
  assert.ok(attempt.reviewContext.actualEvidenceRefs.includes("implementation.txt"));
  assert.equal(attempt.reviews.fidelity.result.assessments.length, 1, "one shared source can ground the complete contract");
  assert.equal(attempt.reviews.fidelity.result.assessments[0].requirementRefs.length, 30);
  assert.deepEqual(attempt.reviews.code.result.assessments[0].requirementRefs, [], "code-wide grounds do not repeat Fidelity accounting");
  assert.equal(attempt.mechanical.length, 1);
  assert.equal(attempt.mechanical[0].exitCode, 0);
  assert.ok(fs.readFileSync(path.join(root, attempt.mechanical[0].logPath), "utf8").includes("REAL-SUITE-OUTPUT"));
  for (const role of ["fidelity", "code"]) assert.deepEqual(attempt.reviews[role].result, reviewWithAssessments(root, REVIEW_PASS, role));
  const finalized = ok(run(root, ["implement", "finalize"]));
  const receipt = JSON.parse(fs.readFileSync(path.join(root, finalized.detail.completion.receiptPath), "utf8"));
  assert.equal(receipt.schema, "sasu.implement.receipt.v6");
  assert.equal(readState(root).status, "complete");
  assert.equal(receipt.prdSha256, attempt.prdSha256);
  assert.deepEqual(receipt.reviewContext, attempt.reviewContext);
  for (const role of ["fidelity", "code"]) assert.deepEqual(receipt.reviews[role].result, attempt.reviews[role].result);
  assert.equal(receipt.rows, undefined);
  assert.equal(receipt.score, undefined);
  assert.equal(fs.readFileSync(path.join(root, "agents/suite-count.log"), "utf8"), "ran\n", "finalize runs neither tests nor review");
  ok(run(root, ["implement", "finalize"]));
  assert.equal(readState(root).verificationAttempts.length, 1);
});

test("a valid failed review stays active and repair appends a passing attempt without rewriting history", () => {
  const root = makeProject();
  start(root);
  const env = stub(root, { ...REVIEW_PASS, findings: [defect()] });
  const failed = run(root, ["implement", "verify"], { env });
  assert.notEqual(failed.status, 0);
  assert.equal(readState(root).status, "active");
  assert.equal(readState(root).findings[0].status, "open");
  assert.notEqual(run(root, ["implement", "finalize"]).status, 0);
  assert.notEqual(run(root, ["implement", "finalize", "--status", "blocked"]).status, 0);
  assert.equal(readState(root).status, "active");
  assert.equal(readState(root).findings[0].status, "open");
  assert.equal(readState(root).completion, null);
  const failedState = readState(root);
  const first = failedState.verificationAttempts[0];
  assert.equal(first.verdict, "FAIL", "this is a validated defect, not malformed reviewer output");
  for (const role of ["fidelity", "code"]) {
    assert.equal(first.reviews[role].verdict, "FAIL");
    assert.ok(first.reviews[role].result.assessments.some((entry) => entry.conclusion === "unresolved" && entry.requirementRefs.includes("B1")));
  }
  const originalAttemptJson = JSON.stringify(first);
  fs.appendFileSync(path.join(root, "implementation.txt"), "The missing public value is now preserved.\n");
  const repaired = { ...REVIEW_PASS, priorDispositions: [{ findingId: failedState.findings[0].id, status: "resolved", reason: "The public implementation now preserves the missing value.", evidenceRefs: ["implementation.txt"] }] };
  ok(run(root, ["implement", "verify"], { env: stub(root, repaired) }));
  const corrected = readState(root);
  assert.equal(corrected.verificationAttempts.length, 2);
  assert.equal(JSON.stringify(corrected.verificationAttempts[0]), originalAttemptJson, "settled results and their pinned inputs remain byte-identical");
  const latest = corrected.verificationAttempts[1];
  assert.equal(latest.verdict, "PASS");
  assert.equal(latest.prdSha256, first.prdSha256);
  assert.notEqual(latest.inputFingerprint, first.inputFingerprint);
  assert.notEqual(latest.sourceFingerprint, first.sourceFingerprint);
  assert.equal(corrected.findings[0].status, "resolved");
  const closed = ok(run(root, ["implement", "finalize"]));
  const receipt = JSON.parse(fs.readFileSync(path.join(root, closed.detail.completion.receiptPath), "utf8"));
  assert.equal(receipt.verificationAttemptId, latest.id);
  assert.equal(receipt.delivery.eligible, true);
  for (const role of ["fidelity", "code"]) assert.deepEqual(receipt.reviews[role].result, latest.reviews[role].result);
  assert.equal(JSON.stringify(readState(root).verificationAttempts[0]), originalAttemptJson, "finalize must preserve failed-attempt evidence too");
});

test("a failed mandatory suite is an actual failed attempt and leaves the correction path active", () => {
  const root = makeProject({ testExit: 7 });
  start(root);
  const env = stub(root);
  assert.notEqual(run(root, ["implement", "verify"], { env }).status, 0);
  const attempt = readState(root).verificationAttempts.at(-1);
  assert.equal(attempt.error.stage, "mechanical");
  assert.equal(attempt.mechanical[0].exitCode, 7);
  assert.equal(attempt.reviews.fidelity, null);
  assert.equal(fs.existsSync(env.SASU_JUDGE_STUB_CAPTURE_DIR), false);
  assert.equal(readState(root).status, "active");
  assert.notEqual(run(root, ["implement", "finalize", "--status", "blocked"]).status, 0);
  assert.equal(readState(root).status, "active");
  assert.notEqual(run(root, ["implement", "finalize", "--status", "complete"]).status, 0);
});

test("retired commands and old state schemas fail explicitly instead of replaying legacy proof", () => {
  const root = makeProject();
  start(root);
  for (const command of ["check", "park", "resume", "qa-brief", "trail", "design"]) {
    const result = run(root, ["implement", command, "--row", "B1"]);
    assert.notEqual(result.status, 0, command);
    assert.match(result.json.message ?? result.stderr, /retired|removed|unknown|no longer|지원하지/);
  }
  const state = readState(root);
  state.schema = "sasu.implement.state.v8";
  fs.writeFileSync(path.join(root, STATE_PATH), JSON.stringify(state));
  const refused = run(root, ["implement", "status"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.json.message, /v8/);
  assert.match(refused.json.message, /v10/);
  assert.match(refused.json.message, /3f549dc/);
});

test("an empty source change is recorded as preflight failure rather than a successful review", () => {
  const root = makeProject();
  ok(run(root, ["implement", "start", "--prd", PRD_PATH]));
  const env = stub(root);
  assert.notEqual(run(root, ["implement", "verify"], { env }).status, 0);
  const attempt = readState(root).verificationAttempts.at(-1);
  assert.equal(attempt.error.stage, "preflight");
  assert.equal(attempt.reviews.fidelity, null);
  assert.equal(fs.existsSync(env.SASU_JUDGE_STUB_CAPTURE_DIR), false);
  assert.notEqual(run(root, ["implement", "finalize", "--status", "blocked"]).status, 0);
  assert.equal(readState(root).status, "active");
});
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
  assert.deepEqual(state.baselineAttribution.paths, [".gitignore", "impl.txt", "package.json", "suite.cjs"].map((path) => ({ path, disposition: "run-owned" })));
  assert.equal(state.initialSource.entries.some((entry) => entry.path === "impl.txt"), false);
  assert.equal(state.initialSource.entries.some((entry) => entry.path === "package.json"), false);

  const env = stub(root);
  registerEvidence(root);
  ok(run(root, ["implement", "verify"], { env }));
  const prompt = fs.readFileSync(path.join(env.SASU_JUDGE_STUB_CAPTURE_DIR, "implement_fidelity.prompt.txt"), "utf8");
  assert.ok(prompt.includes("impl.txt"));
  assert.ok(prompt.includes("package.json"));
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


test("a successful command that changes product source cannot earn a current review or receipt", () => {
  const root = makeProject({ suiteSource: "const fs=require('node:fs'); fs.appendFileSync('implementation.txt','mutated by suite\\n'); console.log('exit zero with changed source');" });
  start(root);
  const env = stub(root);
  assert.notEqual(run(root, ["implement", "verify"], { env }).status, 0);
  const attempt = readState(root).verificationAttempts.at(-1);
  assert.equal(attempt.mechanical[0].exitCode, 0);
  assert.equal(attempt.mechanical[0].mutatedTree, true);
  assert.equal(attempt.mechanical[0].status, "FAIL");
  assert.equal(attempt.reviews.fidelity, null);
  assert.equal(fs.existsSync(env.SASU_JUDGE_STUB_CAPTURE_DIR), false);
  assert.notEqual(run(root, ["implement", "finalize"]).status, 0);
  assert.notEqual(run(root, ["implement", "finalize", "--status", "blocked"]).status, 0);
  assert.equal(readState(root).status, "active");
});

test("a backend without bounded evidence access fails visibly instead of reviewing from unavailable source", () => {
  const root = makeProject();
  start(root);
  const env = { ...stub(root), SASU_JUDGE_STUB_NO_AGENTIC: "1" };
  assert.notEqual(run(root, ["implement", "verify"], { env }).status, 0);
  const attempt = readState(root).verificationAttempts.at(-1);
  assert.equal(attempt.reviews.fidelity.result, null);
  assert.match(attempt.reviews.fidelity.error.message, /requires isolated read-only evidence access/);
  assert.equal(fs.existsSync(env.SASU_JUDGE_STUB_CAPTURE_DIR), false);
  assert.notEqual(run(root, ["implement", "finalize"]).status, 0);
});
