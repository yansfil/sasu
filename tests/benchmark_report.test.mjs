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
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function benchmarkPrd({ approval = "approved", includeSections = true } = {}) {
  const approved = cleanPrd.replace('human_approval: "approved"', `human_approval: "${approval}"`);
  return includeSections ? approved : approved.replace(/## 12\. Implementation Result Report Contract[\s\S]*$/, "");
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
    schema: "sasu.benchmark-case.v2",
    id: "demo",
    prd: "prd.md",
    environment: { mode: "fresh-worktree", baseRef: "HEAD", mustBeAbsent: ["demo-app"] },
    expected: {
      terminalStatuses: ["complete"],
      requiredStages: ["init", "implementation", "verification", "verify-gate", "requirements-fidelity", "finalize"],
      forbiddenStages: ["final-adversarial-review"],
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
  write(path.join(runDir, "state.json"), {
    createdAt: "2026-08-12T00:00:00.000Z",
    activeSessionId: "session-1",
    projectRoot: prepared.worktree,
    tasks: [{ id: "T1", status: "complete", evidence: [{ ts: "2026-08-12T00:05:00.000Z" }] }],
    verification: [{ id: "V1", status: "pass" }],
  });
  write(path.join(runDir, "receipt.json"), {
    status: "partial",
    counts: { totalOpen: 1, requiredVerificationNotPassed: 1 },
    initialWorktreeSnapshot: preparedRecord.initialWorktreeSnapshot,
    phaseTimings: {
      wallClockSeconds: 1000,
      taskEvidenceBoundary: { afterSeconds: 300 },
      measured: {
        verificationCommandSeconds: 20,
        verificationCommandRuns: 1,
        judgeSeconds: 40,
        judgeCalls: 2,
        verifyGateAttempts: 2,
      },
      unattributedSeconds: 940,
      milestones: { initAt: "2026-08-12T00:00:00.000Z", finalizedAt: "2026-08-12T00:16:40.000Z" },
    },
    reviewRounds: { fidelity: { rounds: 1 }, final: { rounds: 0 } },
    requirementsFidelityReview: { status: "pass" },
    finalReview: null,
    verifyGate: { effective: "BLOCKED", staleInputs: [], overridden: false },
  });
  write(path.join(gatesDir, "gates.json"), {
    gates: {
      verify: {
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
    },
    dimensions: {
      flowAdherence: { score: 4, reason: "Expected order.", evidence: ["session:event-1"] },
      recoveryDiscipline: { score: 3, reason: "Scoped recovery.", evidence: ["gates:/gates/verify/history/0"] },
      reviewEfficiency: { score: 4, reason: "One required review.", evidence: ["receipt:/reviewRounds"] },
      evidenceHonesty: { score: 4, reason: "Partial stayed partial.", evidence: ["receipt:/status"] },
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
  assert.equal(reportResult.validRun, false, "partial must not satisfy a complete-only case");

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
  assert.equal(report.efficiency.repeatedIdenticalDiffJudgments, 1);
  assert.equal(report.honesty.falseComplete, false, "an honest partial result is not a false complete");
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

  const candidatePath = path.join(root, "candidate.json");
  write(candidatePath, {
    ...report,
    run: { ...report.run, id: "run-2" },
    outcome: { ...report.outcome, validRun: true },
    timing: { ...report.timing, wallClockSeconds: 800, judgeCalls: 1 },
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
    schema: "sasu.benchmark-case.v2",
    id,
    prd: "prd.md",
    environment: { mode: "fresh-worktree", baseRef: "HEAD", mustBeAbsent: ["demo-app"] },
    expected: {
      terminalStatuses: ["complete"],
      requiredStages: ["init", "implementation", "verification", "verify-gate", "requirements-fidelity", "finalize"],
      forbiddenStages: ["final-adversarial-review"],
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
