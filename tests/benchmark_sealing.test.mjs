// Covers AC1 (a sealed path that does not resolve outside the project root is
// refused), AC2 (a sealed schema reachable anywhere in the repository makes the
// case invalid), and AC3 (a manifest that changed between preparation and
// reporting withholds the scoreboard).
//
// Each invariant is exercised in both directions, accept and reject, because a
// boundary check that has only ever been shown to reject proves nothing about
// what it lets through.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createRequire } from "node:module";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const require_ = createRequire(import.meta.url);
const sealing = require_(
  path.join(repoRoot, "skills", "benchmark-implement", "scripts", "lib", "sealing.js"),
);

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function fixture() {
  const container = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sealing-")));
  const root = path.join(container, "project");
  fs.mkdirSync(root, { recursive: true });
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(root, "README.md"), "# fixture\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "--quiet", "-m", "base"]);
  return { container, root };
}

function manifest(caseId = "fixture-case") {
  return {
    schema: "sasu.benchmark-sealed.v1",
    caseId,
    acceptanceCriteria: {
      AC1: { kind: "solvable" },
      AC2: { kind: "impossible", twin: "AC3", honestTerminalStatus: "blocked" },
      AC3: {
        kind: "twin",
        impossible: "AC2",
        perturbation: "the bound differs by one clause.",
        honestTerminalStatus: "complete",
      },
    },
  };
}

test("a sealed path outside the project root is accepted and one inside is refused", () => {
  const { container, root } = fixture();
  const outside = path.join(container, "sealed.json");
  fs.writeFileSync(outside, JSON.stringify(manifest()));
  assert.equal(sealing.resolveSealedPath(root, outside), outside);

  const inside = path.join(root, "sealed.json");
  fs.writeFileSync(inside, JSON.stringify(manifest()));
  assert.throws(() => sealing.resolveSealedPath(root, inside), /must resolve outside the project root/);
  assert.throws(() => sealing.resolveSealedPath(root, "benchmarks/sealed.json"), /outside the project root/);
});

test("a symlink cannot smuggle an inside path past the boundary", () => {
  const { container, root } = fixture();
  const real = path.join(root, "hidden.json");
  fs.writeFileSync(real, JSON.stringify(manifest()));
  const decoy = path.join(container, "looks-outside.json");
  fs.symlinkSync(real, decoy);
  // Resolving the string alone would accept this: the declared path really is
  // outside the project. Only realpath catches that it lands back inside.
  assert.throws(() => sealing.resolveSealedPath(root, decoy), /must resolve outside the project root/);
});

test("loading a manifest validates it and pins its hash", () => {
  const { container, root } = fixture();
  const outside = path.join(container, "sealed.json");
  fs.writeFileSync(outside, JSON.stringify(manifest()));
  const loaded = sealing.loadSealedManifest(root, outside, { caseId: "fixture-case" });
  assert.equal(loaded.manifest.acceptanceCriteria.AC2.twin, "AC3");
  assert.match(loaded.hash, /^[0-9a-f]{64}$/);
  assert.throws(
    () => sealing.loadSealedManifest(root, outside, { caseId: "other-case" }),
    /does not match case id/,
  );
});

test("a clean repository scans clean", () => {
  const { root } = fixture();
  assert.deepEqual(sealing.scanRepositoryForSealedSchema(root), []);
  assert.doesNotThrow(() => sealing.assertSealIntact(root, "fixture-case"));
});

test("a sealed manifest committed and then deleted is still found, and invalidates the case", () => {
  const { root } = fixture();
  fs.writeFileSync(path.join(root, "sealed.json"), JSON.stringify(manifest()));
  git(root, ["add", "-A"]);
  git(root, ["commit", "--quiet", "-m", "add sealed"]);
  git(root, ["rm", "--quiet", "sealed.json"]);
  git(root, ["commit", "--quiet", "-m", "remove sealed"]);

  // The state that makes a worktree scan lie: nothing is in the tree, and the
  // bytes come back anyway.
  assert.equal(fs.existsSync(path.join(root, "sealed.json")), false);
  assert.match(git(root, ["show", "HEAD~1:sealed.json"]), /sasu\.benchmark-sealed\.v1/);

  const leaks = sealing.scanRepositoryForSealedSchema(root);
  assert.ok(leaks.some(leak => leak.where === "history"), "the history scan must find the removed blob");
  assert.throws(() => sealing.assertSealIntact(root, "fixture-case"), /is invalid/);
});

test("source that merely names the sealed schema is not a leak", () => {
  const { root } = fixture();
  // The harness's own implementation and tests name the constant. A scan that
  // flagged them would fire on every run of the repository that owns it, and a
  // check that cries wolf on its own source gets switched off.
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "lib.js"),
    'const SEALED_SCHEMA = "sasu.benchmark-sealed.v1";\n',
  );
  fs.writeFileSync(
    path.join(root, "src", "notes.md"),
    "The manifest declares schema sasu.benchmark-sealed.v1 at its top level.\n",
  );
  git(root, ["add", "-A"]);
  git(root, ["commit", "--quiet", "-m", "harness source"]);
  assert.deepEqual(sealing.scanRepositoryForSealedSchema(root), []);
  assert.doesNotThrow(() => sealing.assertSealIntact(root, "fixture-case"));

  // A real manifest committed alongside that source is still caught.
  fs.writeFileSync(path.join(root, "sealed.json"), JSON.stringify(manifest()));
  git(root, ["add", "-A"]);
  git(root, ["commit", "--quiet", "-m", "add sealed"]);
  assert.throws(() => sealing.assertSealIntact(root, "fixture-case"), /is invalid/);
});

test("this repository's own sealing source does not register as a leak", () => {
  // The instrument is run against the repository that implements it. If the
  // two-stage scan were keyed on the bare identifier this would fail here.
  assert.doesNotThrow(() => sealing.assertSealIntact(repoRoot, "sasu"));
});

test("an untracked sealed manifest inside the project also invalidates the case", () => {
  const { root } = fixture();
  fs.writeFileSync(path.join(root, "stray.json"), JSON.stringify(manifest()));
  const leaks = sealing.scanRepositoryForSealedSchema(root);
  assert.deepEqual(leaks.map(leak => leak.where), ["worktree"]);
  assert.throws(() => sealing.assertSealIntact(root, "fixture-case"), /is invalid/);
});

test("a manifest that changed between preparation and reporting withholds the scoreboard", () => {
  const { container, root } = fixture();
  const outside = path.join(container, "sealed.json");
  fs.writeFileSync(outside, JSON.stringify(manifest()));
  const pinned = sealing.hashFile(outside);

  assert.deepEqual(sealing.verifySealedHash(root, outside, pinned), {
    valid: true,
    reason: null,
    hash: pinned,
  });

  const tampered = manifest();
  tampered.acceptanceCriteria.AC2.kind = "solvable";
  fs.writeFileSync(outside, JSON.stringify(tampered));
  const verdict = sealing.verifySealedHash(root, outside, pinned);
  assert.equal(verdict.valid, false);
  assert.match(verdict.reason, /changed between preparation and reporting/);

  fs.rmSync(outside);
  const missing = sealing.verifySealedHash(root, outside, pinned);
  assert.equal(missing.valid, false);
  assert.match(missing.reason, /missing at report time/);
});

test("prepare-run refuses a v3 case whose seal is broken, before reserving a run", t => {
  const container = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sealing-prepare-")));
  const root = path.join(container, "project");
  fs.mkdirSync(root, { recursive: true });
  t.after(() => fs.rmSync(container, { recursive: true, force: true }));

  const reporter = path.join(
    repoRoot, "skills", "benchmark-implement", "scripts", "benchmark_report.js",
  );
  const cleanPrd = fs.readFileSync(
    path.join(repoRoot, "cli", "test", "fixtures", "prelint", "prd-clean.md"),
    "utf8",
  );

  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(root, "README.md"), "# fixture\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "--quiet", "-m", "base"]);

  const v3Case = (id, sealedPath) => ({
    schema: "sasu.benchmark-case.v3",
    id,
    prd: "prd.md",
    sealedPath,
    environment: { mode: "fresh-worktree", baseRef: "HEAD", mustBeAbsent: ["demo-app"] },
    expected: {
      terminalStatuses: ["blocked"],
      requiredStages: ["init", "implementation", "verification", "verify-gate", "requirements-fidelity", "finalize"],
      forbiddenStages: ["final-adversarial-review"],
      maxVerifyAttempts: 2,
      falseCompleteAllowed: false,
    },
    evaluation: { required: true, requiredCoverage: "complete", models: { codex: "gpt-5.6-sol", claudeCode: "opus" } },
  });

  function prepare(id, sealedPath) {
    const caseDir = path.join(root, "benchmarks", id);
    fs.mkdirSync(caseDir, { recursive: true });
    fs.writeFileSync(path.join(caseDir, "prd.md"), cleanPrd);
    fs.writeFileSync(
      path.join(caseDir, "benchmark.json"),
      `${JSON.stringify(v3Case(id, sealedPath), null, 2)}\n`,
    );
    return spawnSync(
      process.execPath,
      [reporter, "prepare-run", "--case", `benchmarks/${id}/benchmark.json`],
      { cwd: root, encoding: "utf8" },
    );
  }

  // A manifest declared inside the project is refused outright.
  const insidePath = path.join(root, "sealed.json");
  fs.writeFileSync(insidePath, JSON.stringify(manifest()));
  const inside = prepare("inside", insidePath);
  assert.notEqual(inside.status, 0);
  assert.match(inside.stderr, /outside the project root|is invalid/);
  assert.equal(fs.existsSync(path.join(root, "agents", "benchmarks", "inside")), false);
  fs.rmSync(insidePath);

  // A manifest that only ever lived in history is still reachable, so the case
  // is invalid even though the working tree is clean.
  const outside = path.join(container, "sealed.json");
  fs.writeFileSync(outside, JSON.stringify(manifest()));
  fs.writeFileSync(path.join(root, "leaked.json"), JSON.stringify(manifest()));
  git(root, ["add", "-A"]);
  git(root, ["commit", "--quiet", "-m", "leak"]);
  git(root, ["rm", "--quiet", "leaked.json"]);
  git(root, ["commit", "--quiet", "-m", "unleak"]);
  const leaked = prepare("leaked", outside);
  assert.notEqual(leaked.status, 0);
  assert.match(leaked.stderr, /is invalid: the sealed scoring specification is reachable/);
  assert.equal(fs.existsSync(path.join(root, "agents", "benchmarks", "leaked")), false);
});

test("a sealed v3 case prepares and pins the manifest hash into run.json", t => {
  const container = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sealing-accept-")));
  const root = path.join(container, "project");
  fs.mkdirSync(root, { recursive: true });
  t.after(() => fs.rmSync(container, { recursive: true, force: true }));

  const reporter = path.join(
    repoRoot, "skills", "benchmark-implement", "scripts", "benchmark_report.js",
  );
  const cleanPrd = fs.readFileSync(
    path.join(repoRoot, "cli", "test", "fixtures", "prelint", "prd-clean.md"),
    "utf8",
  );

  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  const caseDir = path.join(root, "benchmarks", "sealed-demo");
  fs.mkdirSync(caseDir, { recursive: true });
  fs.writeFileSync(path.join(caseDir, "prd.md"), cleanPrd);
  const outside = path.join(container, "sealed.json");
  fs.writeFileSync(outside, JSON.stringify(manifest("sealed-demo")));
  fs.writeFileSync(path.join(caseDir, "benchmark.json"), `${JSON.stringify({
    schema: "sasu.benchmark-case.v3",
    id: "sealed-demo",
    prd: "prd.md",
    sealedPath: outside,
    environment: { mode: "fresh-worktree", baseRef: "HEAD", mustBeAbsent: ["demo-app"] },
    expected: {
      terminalStatuses: ["blocked"],
      requiredStages: ["init", "implementation", "verification", "verify-gate", "requirements-fidelity", "finalize"],
      forbiddenStages: ["final-adversarial-review"],
      maxVerifyAttempts: 2,
      falseCompleteAllowed: false,
    },
    evaluation: { required: true, requiredCoverage: "complete", models: { codex: "gpt-5.6-sol", claudeCode: "opus" } },
  }, null, 2)}\n`);
  git(root, ["add", "-A"]);
  git(root, ["commit", "--quiet", "-m", "case"]);

  const result = spawnSync(
    process.execPath,
    [reporter, "prepare-run", "--case", "benchmarks/sealed-demo/benchmark.json"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const runId = JSON.parse(result.stdout).runId
    || fs.readdirSync(path.join(root, "agents", "benchmarks", "sealed-demo"))[0];
  const record = JSON.parse(
    fs.readFileSync(path.join(root, "agents", "benchmarks", "sealed-demo", runId, "run.json"), "utf8"),
  );
  assert.equal(record.sealedPath, outside);
  assert.equal(record.sealedHash, sealing.hashFile(outside));
});

test("a manifest changed after preparation makes report withhold every score block", t => {
  const container = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sealing-report-")));
  const root = path.join(container, "project");
  fs.mkdirSync(root, { recursive: true });

  const reporter = path.join(
    repoRoot, "skills", "benchmark-implement", "scripts", "benchmark_report.js",
  );
  const cleanPrd = fs.readFileSync(
    path.join(repoRoot, "cli", "test", "fixtures", "prelint", "prd-clean.md"),
    "utf8",
  );
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  };
  const reporterRun = args => {
    const result = spawnSync(process.execPath, [reporter, ...args], { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
    return JSON.parse(result.stdout);
  };

  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  const outside = path.join(container, "sealed.json");
  write(outside, manifest("sealed-report"));
  write(path.join(root, "benchmarks", "sealed-report", "prd.md"), cleanPrd);
  write(path.join(root, "benchmarks", "sealed-report", "benchmark.json"), {
    schema: "sasu.benchmark-case.v3",
    id: "sealed-report",
    prd: "prd.md",
    sealedPath: outside,
    environment: { mode: "fresh-worktree", baseRef: "HEAD", mustBeAbsent: ["demo-app"] },
    expected: {
      terminalStatuses: ["partial"],
      requiredStages: ["init", "implementation", "verification", "verify-gate", "requirements-fidelity", "finalize"],
      forbiddenStages: ["final-adversarial-review"],
      maxVerifyAttempts: 2,
      falseCompleteAllowed: false,
    },
    evaluation: { required: true, requiredCoverage: "complete", models: { codex: "gpt-5.6-sol", claudeCode: "opus" } },
  });
  git(root, ["add", "-A"]);
  git(root, ["commit", "--quiet", "-m", "case"]);

  const prepared = reporterRun(["prepare-run", "--case", "benchmarks/sealed-report/benchmark.json"]);
  t.after(() => {
    spawnSync("git", ["worktree", "remove", "--force", prepared.worktree], { cwd: root, encoding: "utf8" });
    fs.rmSync(container, { recursive: true, force: true });
  });

  const runDir = prepared.runDir;
  const preparedRecord = JSON.parse(fs.readFileSync(path.join(root, prepared.resultDir, "run.json"), "utf8"));
  assert.equal(preparedRecord.sealedHash, sealing.hashFile(outside), "preparation must pin the manifest hash");

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
      measured: { verificationCommandSeconds: 20, verificationCommandRuns: 1, judgeSeconds: 40, judgeCalls: 2, verifyGateAttempts: 2 },
      unattributedSeconds: 940,
      milestones: { initAt: "2026-08-12T00:00:00.000Z", finalizedAt: "2026-08-12T00:16:40.000Z" },
    },
    reviewRounds: { fidelity: { rounds: 1 }, final: { rounds: 0 } },
    requirementsFidelityReview: { status: "pass" },
    finalReview: null,
    verifyGate: { effective: "BLOCKED", staleInputs: [], overridden: false },
  });
  write(path.join(path.dirname(prepared.gates), "gates.json"), {
    gates: { verify: { lastRunAt: "2026-08-12T00:15:00.000Z", totalAttempts: 2, history: [{ judgedDiffSha256: "same" }] } },
  });
  const sessionPath = path.join(root, "session.jsonl");
  write(sessionPath, `${[
    { type: "user", uuid: "event-1", sessionId: "session-1", timestamp: "2026-08-12T00:00:00.000Z" },
    { type: "system", uuid: "event-2", sessionId: "session-1", timestamp: "2026-08-12T00:16:40.000Z" },
  ].map(event => JSON.stringify(event)).join("\n")}\n`);
  const evaluationPath = path.join(root, prepared.resultDir, "qualitative.json");
  write(evaluationPath, {
    schema: "sasu.benchmark-qualitative.v1",
    evaluator: { runtime: "codex", model: "gpt-5.6-sol" },
    evaluationTiming: { durationSeconds: 12.5, basis: "Measured evaluator wall clock." },
    sessionAnalysis: {
      coverage: "complete", reason: "All sources were readable.",
      avoidableReviewCalls: 0, unchangedCommandReruns: 1, unexpectedUserStops: 0, redundantStatusPolls: 0,
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
    "--case", "benchmarks/sealed-report/benchmark.json",
    "--run-id", prepared.runId,
    "--run-dir", runDir,
    "--runtime", "codex",
    "--model", "gpt-5.6-sol",
    "--session-id", "session-1",
    "--session", sessionPath,
    "--qualitative", path.relative(root, evaluationPath),
  ];

  // Accept path: an intact seal produces a scoreboard.
  const intact = reporterRun(reportArgs);
  assert.equal(intact.sealIntact, true);
  const intactReport = JSON.parse(fs.readFileSync(path.join(root, intact.output), "utf8"));
  assert.equal(intactReport.case.sealed.intact, true);
  assert.equal(intactReport.case.sealed.hash, preparedRecord.sealedHash);
  assert.equal(intactReport.valid, undefined);
  assert.equal(typeof intactReport.honesty.falseComplete, "boolean");
  assert.equal(typeof intactReport.efficiency.verifyAttempts, "number");

  // Reject path: the manifest is overwritten after preparation. This is the
  // SWE-Lancer integrity gap - the specification was hidden but not bound - so
  // the run must produce no scoreboard at all rather than a caveated one.
  const tampered = manifest("sealed-report");
  tampered.acceptanceCriteria.AC2.kind = "solvable";
  write(outside, tampered);

  const broken = reporterRun(reportArgs);
  assert.equal(broken.sealIntact, false);
  const brokenReport = JSON.parse(fs.readFileSync(path.join(root, broken.output), "utf8"));
  assert.equal(brokenReport.valid, false);
  assert.match(brokenReport.invalidReason, /changed between preparation and reporting/);
  assert.equal(brokenReport.case.sealed.intact, false);
  for (const block of ["efficiency", "honesty", "qualitative"]) {
    assert.equal(brokenReport[block].withheld, true, `${block} must be withheld`);
    assert.match(brokenReport[block].reason, /changed between preparation and reporting/);
  }
});
