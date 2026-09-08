import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const reporter = path.join(repoRoot, "skills", "benchmark-implement", "scripts", "benchmark_report.js");
const cleanPrd = fs.readFileSync(path.join(repoRoot, "cli", "test", "fixtures", "prelint", "prd-clean.md"), "utf8");

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function run(root, args) {
  const result = spawnSync(process.execPath, [reporter, ...args], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

function git(root, args) {
  const result = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function benchmarkPrd({ approval = "approved", includeSections = true } = {}) {
  const approved = cleanPrd.replace('human_approval: "approved"', `human_approval: "${approval}"`);
  return includeSections ? approved : approved.replace(/## Risks[\s\S]*$/, "");
}

test("report and comparison preserve hard outcomes while scoring only evidenced process behavior", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-report-"));
  const caseDir = path.join(root, "benchmarks", "demo");
  const sessionPath = path.join(root, "session.jsonl");

  git(root, ["init", "--quiet"]);
  write(path.join(root, "README.md"), "# Benchmark fixture\n");
  git(root, ["add", "README.md"]);
  git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "fixture"]);

  write(path.join(caseDir, "prd.md"), benchmarkPrd());
  write(path.join(caseDir, "benchmark.json"), {
    schema: "sasu.benchmark-case.v4",
    id: "demo",
    prd: "prd.md",
    environment: { mode: "fresh-worktree", baseRef: "HEAD", mustBeAbsent: ["demo-app"] },
    expected: {
      terminalStatuses: ["complete"],
      requiredStages: ["start", "verification", "mechanical", "review", "finalize"],
      forbiddenStages: [],
      maxVerifyAttempts: 2,
      falseCompleteAllowed: false,
    },
    evaluation: { required: true, requiredCoverage: "complete", models: { codex: "gpt-5.6-sol", claudeCode: "opus" } },
  });
  const prepared = run(root, ["prepare-run", "--case", "benchmarks/demo/benchmark.json"]);
  const secondPrepared = run(root, ["prepare-run", "--case", "benchmarks/demo/benchmark.json"]);
  assert.equal(prepared.runId, "demo-run-1");
  assert.equal(secondPrepared.runId, "demo-run-2");
  assert.equal(prepared.prdReadiness.status, "ready");
  assert.equal(prepared.prdReadiness.blockingGaps.length, 0);
  assert.notEqual(prepared.worktree, secondPrepared.worktree);
  assert.equal(fs.existsSync(path.join(prepared.worktree, "demo-app")), false);
  t.after(() => {
    for (const worktree of [prepared.worktree, secondPrepared.worktree]) {
      spawnSync("git", ["worktree", "remove", "--force", worktree], { cwd: root, encoding: "utf8" });
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const runDir = prepared.runDir;
  const gatesDir = path.dirname(prepared.gates);
  const evaluationPath = path.join(root, prepared.resultDir, "qualitative.json");
  const preparedRecord = JSON.parse(fs.readFileSync(path.join(root, prepared.resultDir, "run.json"), "utf8"));
  const at = seconds => new Date(Date.parse("2026-08-12T00:00:00Z") + seconds * 1000).toISOString();
  const review = (seconds, duration, attempts = 1) => ({
    invocationId: `review-${seconds}`, startedAt: at(seconds), finishedAt: at(seconds + duration), durationMs: duration * 1000,
    verdict: "FAIL", result: { summary: "A required flow is not connected.", findings: [] },
    judge: { at: at(seconds), durationMs: duration * 1000, attempts, outcome: "ok" },
  });
  const attempt = (id, seconds) => ({
    id, phase: "complete", inputFingerprint: "same", verdict: "FAIL", startedAt: at(seconds), finishedAt: at(seconds + 30), durationMs: 30000,
    mechanical: [{ command: "node --test", cwd: prepared.worktree, startedAt: at(seconds), finishedAt: at(seconds + 10), durationMs: 10000, exitCode: 0, status: "PASS" }],
    review: review(seconds + 10, 20), risk: review(seconds + 10, 20),
  });
  const firstAttempt = attempt("verify-1", 300);
  const secondAttempt = attempt("verify-2", 600);
  // The answering backend reset its counters after a failed primary. Count
  // each actual backend call once, without recounting rejected retry entries.
  secondAttempt.review.judge = {
    at: at(620), durationMs: 10000, attempts: 1, outcome: "ok",
    fallback: { at: at(610), durationMs: 10000, attempts: 2, outcome: "judge-invalid-output" },
    retries: [{ at: at(610), durationMs: 5000 }, { at: at(615), durationMs: 5000 }],
    usage: { inputTokens: 10, outputTokens: 3 },
  };
  write(path.join(runDir, "state.json"), {
    schema: "sasu.implement.state.v9", status: "blocked", createdAt: at(0),
    ownerSessionId: "session-1", projectRoot: prepared.worktree,
    initialSource: preparedRecord.initialSource,
    requirements: Array.from({ length: 30 }, (_, index) => ({ id: `B${index + 1}`, behavior: `Requirement ${index + 1}`, decisionIds: [] })),
    findings: [{ id: "F1", kind: "defect", status: "open", problem: "A required flow is not connected." }],
    verificationAttempts: [firstAttempt, secondAttempt],
    riskFindings: [], artifacts: [],
    escalations: [
      { id: 1, at: at(415), durationMs: 15000, outcome: "diagnosed", judge: { at: at(400), durationMs: 15000, attempts: 2, outcome: "ok" } },
      { id: 2, at: at(421), durationMs: 1000, outcome: "summon-failed", judge: { at: at(420), durationMs: 1000, attempts: 0, outcome: "judge-auth" } },
    ],
  });
  write(path.join(runDir, "receipt.json"), {
    schema: "sasu.implement.receipt.v5", status: "blocked", completedAt: at(1000),
    delivery: { eligible: false, reasons: ["F1 remains open"] }, review: secondAttempt.review,
  });
  write(path.join(gatesDir, "gates.json"), {
    gates: {
      spec: {
        lastRunAt: "2026-08-12T00:15:00.000Z",
        totalAttempts: 2,
        history: [
          { judgedDiffSha256: "same" },
          { judgedDiffSha256: "same" },
        ],
      },
    },
  });
  write(sessionPath, [
    { type: "user", uuid: "event-1", sessionId: "session-1", timestamp: "2026-08-12T00:00:00.000Z" },
    { type: "system", uuid: "event-2", sessionId: "session-1", timestamp: "2026-08-12T00:16:40.000Z" },
  ].map(event => JSON.stringify(event)).join("\n") + "\n");
  write(evaluationPath, {
    schema: "sasu.benchmark-qualitative.v1",
    evaluator: { runtime: "codex", model: "gpt-5.6-sol" },
    evaluationTiming: { durationSeconds: 12.5, basis: "Measured evaluator wall clock." },
    sessionAnalysis: {
      coverage: "complete",
      reason: "All sources were readable.",
      avoidableReviewCalls: 0,
      unchangedCommandReruns: 1,
      unexpectedUserStops: 0,
      redundantStatusPolls: 0,
    },
    dimensions: {
      flowAdherence: { score: 4, reason: "Expected order.", evidence: ["session:event-1"] },
      recoveryDiscipline: { score: 3, reason: "Scoped recovery.", evidence: ["gates:/gates/spec/history/0"] },
      reviewEfficiency: { score: 4, reason: "One required review.", evidence: ["receipt:/review"] },
      evidenceHonesty: { score: 4, reason: "Blocked stayed blocked.", evidence: ["receipt:/status"] },
      sessionEfficiency: { score: 2, reason: "One unchanged rerun.", evidence: ["session:event-1"] },
    },
    findings: [{ severity: "P2", message: "One unchanged rerun.", evidence: ["session:event-1"] }],
  });

  const reportArgs = [
    "report",
    "--case", "benchmarks/demo/benchmark.json",
    "--run-id", prepared.runId,
    "--run-dir", runDir,
    "--runtime", "codex",
    "--model", "gpt-5.6-sol",
    "--session-id", "session-1",
    "--session", sessionPath,
    "--qualitative", path.relative(root, evaluationPath),
  ];
  const unprepared = spawnSync(process.execPath, [
    reporter,
    ...reportArgs.map(value => value === prepared.runId ? "demo-run-999" : value),
  ], { cwd: root, encoding: "utf8" });
  assert.notEqual(unprepared.status, 0);
  assert.match(unprepared.stderr, /prepared benchmark run not found/);

  const reportResult = run(root, reportArgs);
  assert.equal(reportResult.validRun, false, "blocked must not satisfy a complete-only case");

  const reportPath = path.join(root, reportResult.output);
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(report.outcome.expectedStatusMatched, false);
  assert.equal(report.outcome.validRun, false);
  assert.equal(report.outcome.expectationChecks.evaluationAvailable, true);
  assert.equal(report.outcome.expectationChecks.evaluationCoverageMatched, true);
  assert.deepEqual(report.flow.requiredStagesMissing, []);
  assert.deepEqual(report.flow.forbiddenStagesRun, []);
  assert.equal(report.timing.wallClockSeconds, 1000);
  assert.equal(report.timing.evaluationSeconds, 12.5);
  assert.equal(report.timing.judgeCalls, 8, "actual backend attempts include fallback and solver calls, excluding synthetic results and zero-call refusals");
  assert.equal(report.timing.judgeInvocations, 5);
  assert.equal(report.timing.judgeSeconds, 95);
  assert.equal(report.timing.judgeUnionSeconds, 55, "parallel review and risk durations overlap");
  assert.equal(report.timing.solverInvocationSeconds, 16);
  assert.equal(report.timing.verificationUnionSeconds, 60);
  assert.equal(report.timing.verificationSumSeconds, 60);
  assert.equal(report.timing.verificationCommandRuns, 2);
  assert.equal(report.timing.verificationCommandSeconds, 20);
  assert.equal(report.timing.answeringUsage.reportedInvocations, 1);
  assert.equal(report.efficiency.repeatedIdenticalInputReviews, 1);
  assert.equal(report.efficiency.redundantStatusPolls, 0);
  assert.equal(report.efficiency.solverInvocations, 1);
  assert.equal(report.efficiency.escalationAttempts, 2);
  assert.equal(report.efficiency.diagnosedRecoveries, 1);
  assert.equal(report.honesty.falseComplete, false, "an honest blocked result is not a false complete");
  assert.equal(report.qualitative.processScore.score, 85);
  assert.equal(report.qualitative.evaluatorRuntimeMatched, true);
  assert.equal(Object.prototype.hasOwnProperty.call(report.qualitative, "productQuality"), false);

  fs.appendFileSync(sessionPath, `${JSON.stringify({
    type: "system",
    uuid: "post-receipt-event",
    sessionId: "session-1",
    timestamp: "2026-08-12T00:20:00.000Z",
  })}\n`);
  const rerunResult = run(root, reportArgs);
  const rerunReport = JSON.parse(fs.readFileSync(path.join(root, rerunResult.output), "utf8"));
  assert.deepEqual(rerunReport, report, "post-receipt session activity must not change the report");

  const mismatchedSession = spawnSync(process.execPath, [
    reporter,
    "report",
    "--case", "benchmarks/demo/benchmark.json",
    "--run-id", prepared.runId,
    "--run-dir", runDir,
    "--runtime", "codex",
    "--session-id", "wrong-session",
    "--session", sessionPath,
    "--qualitative", path.relative(root, evaluationPath),
  ], { cwd: root, encoding: "utf8" });
  assert.notEqual(mismatchedSession.status, 0);
  assert.match(mismatchedSession.stderr, /session id does not match implementation state/);

  const statePath = path.join(runDir, "state.json");
  const originalState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  write(statePath, {
    ...originalState,
    initialSource: { ...originalState.initialSource, digest: "changed-helper-before-start" },
  });
  const changedStartingSource = spawnSync(process.execPath, [reporter, ...reportArgs], { cwd: root, encoding: "utf8" });
  assert.notEqual(changedStartingSource.status, 0);
  assert.match(changedStartingSource.stderr, /implementation source snapshot changed before start/);
  write(statePath, originalState);

  const candidatePath = path.join(root, "candidate.json");
  write(candidatePath, {
    ...report,
    run: { ...report.run, id: "run-2" },
    outcome: { ...report.outcome, validRun: true },
    timing: { ...report.timing, wallClockSeconds: 800, judgeCalls: 7 },
  });
  const comparisonResult = run(root, [
    "compare",
    "--baseline", path.relative(root, reportPath),
    "--candidate", path.relative(root, candidatePath),
  ]);
  const comparison = JSON.parse(fs.readFileSync(path.join(root, comparisonResult.output), "utf8"));
  assert.equal(comparison.strictlyComparable, true);
  assert.equal(comparison.harness.changed, false);
  assert.equal(comparison.outcome.changed, true);
  assert.equal(comparison.deltas.wallClockSeconds, -200);
  assert.equal(comparison.deltas.judgeCalls, -1);

  const legacyPath = path.join(root, "legacy-report.json");
  write(legacyPath, { schema: "sasu.benchmark-report.v1" });
  const legacy = spawnSync(process.execPath, [reporter, "compare", "--baseline", legacyPath, "--candidate", candidatePath], { cwd: root, encoding: "utf8" });
  assert.notEqual(legacy.status, 0);
  assert.match(legacy.stderr, /received schema sasu.benchmark-report.v1; expected sasu.benchmark-report.v2; last supported commit 488d3cc/);

  const receiptPath = path.join(runDir, "receipt.json");
  const originalReceipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  const settledState = {
    ...originalState,
    status: "complete",
    findings: [],
    riskFindings: [{ id: "RF1", severity: "blocking", status: "accepted", text: "Declared risk accepted after review." }],
    completion: { fingerprint: "settled-completion" },
  };
  write(statePath, settledState);
  const settledReceipt = {
    ...originalReceipt, status: "complete", completionFingerprint: "settled-completion",
    delivery: { eligible: true, reasons: [] },
  };
  write(receiptPath, settledReceipt);
  const settledOutput = run(root, reportArgs);
  const settledReport = JSON.parse(fs.readFileSync(path.join(root, settledOutput.output), "utf8"));
  assert.equal(settledReport.outcome.validRun, true, "CLI completion eligibility can settle a recorded risk FAIL");
  assert.equal(settledReport.honesty.falseComplete, false);
  assert.equal(settledReport.honesty.verificationStatus, "FAIL", "the original actual verdict remains a historical observation");
  write(receiptPath, { ...settledReceipt, delivery: { eligible: false, reasons: ["F2: human rejected"] } });
  const rejectedOutput = run(root, reportArgs);
  const rejectedReport = JSON.parse(fs.readFileSync(path.join(root, rejectedOutput.output), "utf8"));
  assert.equal(rejectedReport.outcome.validRun, false, "human rejection does not satisfy a completed benchmark");
  assert.equal(rejectedReport.honesty.deliveryEligible, false);
  write(statePath, originalState);
  write(receiptPath, originalReceipt);

  const executionState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  executionState.verificationAttempts.push({
    id: "verify-3", phase: "preflight", inputFingerprint: "same", verdict: "ERROR",
    startedAt: at(700), finishedAt: at(701), durationMs: 1000, mechanical: [], review: null, risk: null,
    error: { stage: "preflight", code: "input-invalid", message: "Required input unavailable." },
  });
  write(statePath, executionState);
  const preflightOutput = run(root, reportArgs);
  const preflightReport = JSON.parse(fs.readFileSync(path.join(root, preflightOutput.output), "utf8"));
  assert.equal(preflightReport.timing.judgeCalls, 8, "a preflight failure did not execute a judge");
  assert.equal(preflightReport.timing.verificationCommandRuns, 2);
  assert.equal(preflightReport.efficiency.verifyAttempts, 3);
  assert.deepEqual(preflightReport.efficiency.executionErrorsByStage, { preflight: 1 });
  assert.equal(preflightReport.honesty.falseComplete, false);

  const badEvaluationPath = path.join(root, "bad-qualitative.json");
  const badEvaluation = JSON.parse(fs.readFileSync(evaluationPath, "utf8"));
  badEvaluation.dimensions.flowAdherence.evidence = ["session:missing-event"];
  write(badEvaluationPath, badEvaluation);
  const badEvidenceArgs = [...reportArgs];
  badEvidenceArgs[badEvidenceArgs.indexOf("--qualitative") + 1] = path.relative(root, badEvaluationPath);
  const badEvidence = spawnSync(process.execPath, [reporter, ...badEvidenceArgs], { cwd: root, encoding: "utf8" });
  assert.notEqual(badEvidence.status, 0);
  assert.match(badEvidence.stderr, /qualitative evidence reference does not exist: session:missing-event/);
});

test("prepare-run rejects unapproved and unreadable PRDs before reserving a run", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-prd-preflight-"));
  git(root, ["init", "--quiet"]);
  write(path.join(root, "README.md"), "# Benchmark fixture\n");
  git(root, ["add", "README.md"]);
  git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "fixture"]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const contract = id => ({
    schema: "sasu.benchmark-case.v4",
    id,
    prd: "prd.md",
    environment: { mode: "fresh-worktree", baseRef: "HEAD", mustBeAbsent: ["demo-app"] },
    expected: {
      terminalStatuses: ["complete"],
      requiredStages: ["start", "verification", "mechanical", "review", "finalize"],
      forbiddenStages: [],
      maxVerifyAttempts: 2,
      falseCompleteAllowed: false,
    },
    evaluation: { required: true, requiredCoverage: "complete", models: { codex: "gpt-5.6-sol", claudeCode: "opus" } },
  });

  for (const fixture of [
    { id: "pending", prd: benchmarkPrd({ approval: "pending" }), error: /human_approval must be approved/ },
    { id: "unreadable", prd: benchmarkPrd({ includeSections: false }), error: /benchmark PRD readiness failed/ },
  ]) {
    const caseDir = path.join(root, "benchmarks", fixture.id);
    write(path.join(caseDir, "prd.md"), fixture.prd);
    write(path.join(caseDir, "benchmark.json"), contract(fixture.id));
    const result = spawnSync(process.execPath, [reporter, "prepare-run", "--case", `benchmarks/${fixture.id}/benchmark.json`], {
      cwd: root,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, fixture.error);
    assert.equal(fs.existsSync(path.join(root, "agents", "benchmarks", fixture.id)), false);
  }
});
