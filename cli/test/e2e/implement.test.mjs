import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "dist", "cli.js");

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
  for (const args of [["init", "-q"], ["add", "package.json"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base"]]) {
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
      ...(profile === "high-risk" ? { "implement:risk": { verdict: "PASS", findings: [] } } : {}),
    },
  }));
  return { file, capture };
}

function run(root, args, options = {}) {
  const env = { ...process.env, ...(options.env ?? {}) };
  const executed = spawnSync(process.execPath, [CLI, ...args, "--json"], { cwd: root, encoding: "utf8", env });
  let json = null;
  try {
    json = JSON.parse(executed.stdout);
  } catch {
    json = { stdout: executed.stdout, stderr: executed.stderr };
  }
  return { ...executed, json };
}

function startAndClose(root) {
  const started = run(root, ["implement", "start", "--prd", "agents/prd/fixture/prd.md"]);
  assert.equal(started.status, 0, started.stderr + started.stdout);
  const closed = run(root, ["implement", "task", "--id", "T1", "--evidence", "fixture implementation complete"]);
  assert.equal(closed.status, 0, closed.stderr + closed.stdout);
}

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

test("open tasks and mechanical failures stop before either judge", () => {
  const root = makeProject({ testExit: 3 });
  const { file, capture } = stub(root);
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  assert.equal(run(root, ["implement", "start", "--prd", "agents/prd/fixture/prd.md"]).status, 0);
  const open = run(root, ["implement", "verify"], { env });
  assert.equal(open.status, 2);
  assert.match(open.json.message, /open: T1/);
  assert.equal(fs.existsSync(capture), false);

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
  const attempt = verified.json.detail.attempt;
  assert.equal(attempt.verdict, "PASS");
  assert.notEqual(attempt.lanes.acceptance.invocationId, attempt.lanes.fidelity.invocationId);
  assert.equal(attempt.lanes.acceptance.result.invocations.length, 1);
  assert.equal(attempt.lanes.acceptance.result.invocations[0].criterionId, "AC1");
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

test("registered runtime evidence becomes stale when either file or judged source changes", () => {
  const root = makeProject();
  fs.writeFileSync(path.join(root, "runtime.log"), "runtime proof\n");
  startAndClose(root);
  const registered = run(root, [
    "implement", "artifact", "--id", "V1", "--kind", "log", "--path", "runtime.log", "--description", "runtime proof",
  ]);
  assert.equal(registered.status, 0, registered.stderr + registered.stdout);
  fs.writeFileSync(path.join(root, "runtime.log"), "changed proof\n");
  const current = run(root, ["implement", "status"]);
  assert.match(current.json.detail.artifactProblems.join("\n"), /artifact hash changed/);
  assert.match(current.json.detail.artifactProblems.join("\n"), /artifact is stale/);
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
  fs.writeFileSync(path.join(root, qaLog), "original user decisions\n");
  const { file, capture } = stub(root);
  const env = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
  startAndClose(root);
  const verified = run(root, ["implement", "verify"], { env });
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);
  assert.equal(verified.json.detail.attempt.fidelityInput.routing, "full-qa-log");

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
  assert.match(missingPrd.json.message, /PRD missing/);

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
  assert.equal(verifiedTwice.json.state.verificationAttempts.length, 2);
  assert.equal(verifiedTwice.json.state.verificationAttempts.every((attempt) => attempt.verdict === "PASS"), true);
});

test("closing a task reports the remaining open tasks in the response", () => {
  const root = makeProject();
  const started = run(root, ["implement", "start", "--prd", "agents/prd/fixture/prd.md"]);
  assert.equal(started.status, 0, started.stderr + started.stdout);

  const closed = run(root, ["implement", "task", "--id", "T1", "--evidence", "fixture implementation complete"]);
  assert.equal(closed.status, 0, closed.stderr + closed.stdout);
  assert.match(closed.json.message, /remaining: none — all tasks closed/);
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
  assert.match(last.json.message, /remaining: none — all tasks closed/);
});
