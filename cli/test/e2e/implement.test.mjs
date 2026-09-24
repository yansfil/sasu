import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { STATE_PATH, makeProject, readState, run, runText, start, ok } from "../helpers/implement-fixture.mjs";

function readReport(root) {
  const state = readState(root);
  return JSON.parse(fs.readFileSync(path.join(root, state.verificationReport.jsonPath), "utf8"));
}

test("verify runs the sealed suite, writes a current report, and starts no reviewer process", () => {
  const root = makeProject({ count: 30 });
  start(root);
  const evidencePath = path.join(root, "agents", "observations", "runtime.log");
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, "observed fixture behavior\n");
  ok(run(root, [
    "implement", "artifact",
    "--kind", "log",
    "--path", "agents/observations/runtime.log",
    "--description", "Fixture runtime observation",
    "--source", "fixture operator",
    "--collected-at", "2026-09-15T00:00:00.000Z",
    "--target", "fixture public command",
    "--environment", "disposable project",
  ]));
  const capture = path.join(root, "agents", "captures");
  const verified = runText(root, ["implement", "verify"], {
    env: { SASU_JUDGE_BACKEND: "missing-backend", SASU_JUDGE_STUB_CAPTURE_DIR: capture },
  });
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);

  const state = readState(root);
  const report = readReport(root);
  assert.equal(state.schema, "sasu.implement.state.v11.stateless-verification");
  assert.equal(state.requirements.length, 30);
  assert.equal(state.verificationAttempts.length, 1);
  assert.equal(state.verificationAttempts[0].verdict, "PASS");
  assert.equal(report.schema, "sasu.verification-report.v1");
  assert.equal(report.status, "PASS");
  assert.equal(report.requiredCommands.length, 1);
  assert.equal(report.requiredCommands[0].result.status, "GREEN");
  assert.deepEqual(report.evidence.map(({ description, sourceFingerprint, environment }) => ({ description, sourceFingerprint, environment })), [{
    description: "Fixture runtime observation",
    sourceFingerprint: state.verificationAttempts[0].sourceFingerprint,
    environment: "disposable project",
  }]);
  assert.equal(report.agentReview.status, "NOT_RUN");
  assert.match(verified.stdout, /Subagent tool: Claude Code uses the Agent tool; Codex uses spawn_agent\. Do not split a Herdr pane/);
  assert.match(verified.stdout, /Fix now, Follow-up improvements, and What was checked/);
  assert.match(verified.stdout, /Sasu sets no reviewer turn limit/);
  assert.match(verified.stdout, /REVIEW_UNAVAILABLE/);
  assert.doesNotMatch(verified.stdout, /rerun verify and review/);
  for (const instruction of [
    /Next action: if the last native review covered exactly this verified head and the registered evidence is unchanged since that review, continue to ship\./,
    /Otherwise spawn one set of native Fidelity and Code review subagents in parallel from this runtime for this exact verified head/,
    /a follow-up review with the prior review context on the diff, or the full-scope review when no prior review exists/,
    /commit the fix, run its focused checks, request the follow-up review on that commit, and run the full verify again on the final committed candidate/,
    /If a previous review exists.*actual reviewed HEAD \(not merely a verified HEAD\)/,
    /findings, coverage, dispositions, the diff to this HEAD/,
    /approved contract or material evidence changes/,
    /fix closure, and affected flows first while retaining complete reviewer scope/,
    /Without applicable prior review context, perform the full-scope review/,
    /concrete failure evidence or a traceable failure path/,
    /observable closure condition/,
    /nonessential expansion belongs in Follow-up improvements/,
  ]) {
    assert.match(verified.stdout, instruction);
    assert.match(report.agentReview.instruction, instruction);
  }
  assert.equal(fs.existsSync(capture), false, "deterministic verify must not invoke a model backend");
  assert.equal(fs.readFileSync(path.join(root, "agents/suite-count.log"), "utf8"), "ran\n");

  const status = ok(run(root, ["implement", "status"]));
  assert.equal(status.detail.delivery.eligible, true);
  assert.equal(status.detail.verification.verdict, "PASS");
  const summary = runText(root, ["implement", "status"]).stdout;
  assert.match(summary, /Next: ship if the last native review covered this exact head with unchanged evidence; otherwise run one native review set on this head \(a follow-up with the prior review context, or the full scope when none exists\)/);
});

test("source drift makes the report stale until deterministic verify is rerun", () => {
  const root = makeProject({ profile: "high-risk" });
  start(root);
  const verified = runText(root, ["implement", "verify"]);
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);
  assert.match(verified.stdout, /Fidelity, Code, and Security/);
  const first = readState(root).verificationReport;

  fs.appendFileSync(path.join(root, "implementation.txt"), "related bug fix\n");
  const stale = ok(run(root, ["implement", "status"]));
  assert.equal(stale.detail.verification.verdict, "STALE");
  assert.equal(stale.detail.delivery.eligible, false);

  ok(run(root, ["implement", "verify"]));
  const current = readState(root);
  assert.equal(current.verificationReport.status, "PASS");
  assert.notEqual(current.verificationReport.sourceFingerprint, first.sourceFingerprint);
  assert.equal(current.verificationAttempts.length, 2);
});

test("a failed required suite writes an honest failed report and remains caller-visible", () => {
  const root = makeProject({ testExit: 7 });
  start(root);
  const failed = runText(root, ["implement", "verify"]);
  assert.notEqual(failed.status, 0);

  const state = readState(root);
  const report = readReport(root);
  assert.equal(state.status, "active");
  assert.equal(state.verificationAttempts.at(-1).verdict, "FAIL");
  assert.equal(state.verificationAttempts.at(-1).mechanical[0].exitCode, 7);
  assert.equal(report.status, "FAIL");
  assert.equal(report.requiredCommands[0].result.status, "RED");
  for (const text of [failed.stdout, report.agentReview.instruction]) {
    assert.match(text, /Next action: ship is blocked; verification FAIL\. Failed required commands: S1 `[^`]+` \(exit 7\)\./);
    assert.match(text, /Reproduce each failed command in isolation, fix the cause, commit, then rerun the full sasu implement verify\./);
    assert.doesNotMatch(text, /spawn native/);
    assert.doesNotMatch(text, /Do not review/);
    assert.doesNotMatch(text, /consecutive FAIL/);
  }
  assert.equal(ok(run(root, ["implement", "status"])).detail.delivery.eligible, false);

  // Review is no longer gated on PASS; delivery still is.
  const summary = runText(root, ["implement", "status"]);
  assert.equal(summary.status, 0, summary.stderr);
  assert.match(summary.stdout, /Agent Review: native Fidelity and Code subagents .* may review a committed head with the current verification verdict \(FAIL\) disclosed; delivery still needs a current deterministic PASS/);
  assert.doesNotMatch(summary.stdout, /wait for a current deterministic PASS/);
  assert.match(summary.stdout, /Next: reproduce the failed required command\(s\) in isolation, fix, commit, then rerun the full verify/);
});

test("a repeated FAIL on identical input is named as diagnostic, and changed input resets the count", () => {
  const root = makeProject({ testExit: 7 });
  start(root);
  const first = runText(root, ["implement", "verify"]);
  assert.notEqual(first.status, 0);
  assert.doesNotMatch(first.stdout, /consecutive FAIL/);

  const repeated = runText(root, ["implement", "verify"]);
  assert.notEqual(repeated.status, 0);
  const state = readState(root);
  assert.equal(state.verificationAttempts[0].inputFingerprint, state.verificationAttempts[1].inputFingerprint);
  for (const text of [repeated.stdout, readReport(root).agentReview.instruction]) {
    assert.match(text, /Failed required commands: S1 /);
    assert.match(text, /Repeated input: 2 consecutive FAIL attempts ran on identical verification input; a rerun without a change is a diagnostic reproduction, not a fix\./);
  }

  fs.appendFileSync(path.join(root, "implementation.txt"), "attempted fix\n");
  const changed = runText(root, ["implement", "verify"]);
  assert.notEqual(changed.status, 0);
  assert.notEqual(readState(root).verificationAttempts[2].inputFingerprint, state.verificationAttempts[1].inputFingerprint);
  assert.doesNotMatch(changed.stdout, /consecutive FAIL/);
  assert.equal(fs.readFileSync(path.join(root, "agents/suite-count.log"), "utf8"), "ran\nran\nran\n", "a repeated input is never refused");
});

test("a suite that mutates source publishes a source-moved failure and releases its lease", () => {
  const root = makeProject({
    suiteSource: "const fs = require('node:fs'); fs.appendFileSync('implementation.txt', 'suite mutation\\n');\n",
  });
  start(root);
  const failed = run(root, ["implement", "verify"]);
  assert.notEqual(failed.status, 0);

  const state = readState(root);
  const report = readReport(root);
  assert.equal(state.activeVerification, undefined);
  assert.equal(state.verificationAttempts.at(-1).verdict, "FAIL");
  assert.equal(state.verificationAttempts.at(-1).error.code, "source-moved");
  assert.equal(report.status, "FAIL");
  assert.equal(report.sourceChangedAfterVerification, true);
  assert.notEqual(report.observedSourceFingerprint, report.sourceFingerprint);
});

test("retired lifecycle commands and old state schemas fail explicitly", () => {
  const root = makeProject();
  start(root);
  for (const command of ["finalize", "confirm", "risk", "check", "park", "resume", "qa-brief", "trail", "design"]) {
    const result = run(root, ["implement", command]);
    assert.notEqual(result.status, 0, command);
    assert.match(result.json.message ?? result.stderr, /retired|removed|unknown|no longer|지원하지/);
  }

  const state = readState(root);
  state.schema = "sasu.implement.state.v10";
  fs.writeFileSync(path.join(root, STATE_PATH), JSON.stringify(state));
  const refused = run(root, ["implement", "status"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.json.message, /v10/);
  assert.match(refused.json.message, /v11/);
});
