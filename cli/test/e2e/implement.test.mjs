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

// Command responses deliberately no longer echo the state (it grew to ~117k
// tokens per call on real runs); history assertions read the record itself.
function readState(root, slug = "fixture") {
  return JSON.parse(fs.readFileSync(path.join(root, "agents", "runs", slug, "state.json"), "utf8"));
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

test("risk findings fail the run only at the blocking severity floor", () => {
  // Advisory findings ride along on PASS: without the floor, a fresh
  // adversarial judge always finds something new and the lane cannot
  // converge (2026-08-13 creator-assist: 17 rounds, 89 findings, 0 repeats).
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
    { severity: "advisory", text: "consider rate limiting the retry path" },
  ]);
  const riskPrompt = fs.readFileSync(path.join(capture, "implement_risk.prompt.txt"), "utf8");
  assert.match(riskPrompt, /Delivery evidence is out of scope/);
  assert.match(riskPrompt, /Their absence is never a finding here/);

  // A blocking finding fails the lane and the run.
  configured.byPurpose["implement:risk"] = {
    verdict: "FAIL",
    findings: [{ severity: "blocking", text: "credentials are written to a world-readable log" }],
  };
  fs.writeFileSync(file, JSON.stringify(configured));
  const blocking = run(root, ["implement", "verify"], { env });
  assert.equal(blocking.status, 1);
  assert.equal(blocking.json.detail.attempt.lanes.risk.verdict, "FAIL");
  assert.equal(blocking.json.detail.attempt.verdict, "FAIL");

  // Free-prose string findings and severity-inconsistent verdicts are
  // rejected as invalid output instead of silently accepted.
  configured.byPurpose["implement:risk"] = { verdict: "FAIL", findings: ["prose finding without severity"] };
  fs.writeFileSync(file, JSON.stringify(configured));
  const malformed = run(root, ["implement", "verify"], { env });
  assert.equal(malformed.status, 1);
  assert.equal(malformed.json.detail.attempt.lanes.risk.verdict, "ERROR");
  assert.equal(malformed.json.detail.attempt.lanes.risk.error.code, "judge-invalid-output");

  configured.byPurpose["implement:risk"] = {
    verdict: "FAIL",
    findings: [{ severity: "advisory", text: "only advisory yet FAIL" }],
  };
  fs.writeFileSync(file, JSON.stringify(configured));
  const inconsistent = run(root, ["implement", "verify"], { env });
  assert.equal(inconsistent.status, 1);
  assert.equal(inconsistent.json.detail.attempt.lanes.risk.verdict, "ERROR");
  assert.equal(inconsistent.json.detail.attempt.lanes.risk.error.code, "judge-invalid-output");
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
  assert.equal(second.json.detail.verificationBudget.budgetExhausted, true);
  const refused = run(root, ["implement", "verify"]);
  assert.equal(refused.status, 1);
  assert.equal(refused.json.detail.terminalReason, "budget-exhausted");
  assert.equal(refused.json.detail.judgeCalls, 0);
  assert.equal(readState(root).verificationAttempts.length, 2);
  assert.equal(fs.readFileSync(path.join(root, "agents", "verify-count"), "utf8"), "2");
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
  assert.equal(grantedState.verificationAttempts.length, 3);
  assert.equal(grantedState.budgetGrants.length, 1);
  assert.equal(grantedState.budgetGrants[0].evidence, "새 검증 런을 허용한다");
  assert.equal(grantedState.budgetGrants[0].attemptCountBefore, 2);
  assert.equal(granted.json.detail.verificationBudget.fixAttempts, 1);
  assert.equal(granted.json.detail.verificationBudget.grants, 1);

  // The granted budget exhausts again by the same rule, and the blocked
  // close then works with the grant on the receipt's gauge.
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
