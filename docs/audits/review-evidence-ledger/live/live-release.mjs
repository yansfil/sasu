import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const [candidate, backend, outputRoot] = process.argv.slice(2);
assert.ok(candidate && ["codex", "claude"].includes(backend) && outputRoot);
const { prd, git, isolatedEnv } = await import(pathToFileURL(path.join(candidate, "cli/test/helpers/implement-fixture.mjs")));
const cli = path.join(candidate, "cli/dist/cli.js");
const root = path.join(outputRoot, backend);
fs.mkdirSync(root, { recursive: true });
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = { backend, candidate, root, startedAt: new Date().toISOString(), outcome: "running", commands: [], attempts: [] };
const save = () => fs.writeFileSync(path.join(root, "release-summary.json"), JSON.stringify(report, null, 2) + "\n");
const env = isolatedEnv();
async function invoke(label, args) {
  const startedAt = new Date().toISOString();
  const child = spawn(process.execPath, [cli, ...args, "--json"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (part) => { stdout += part; });
  child.stderr.on("data", (part) => { stderr += part; });
  const status = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  fs.writeFileSync(path.join(root, label + ".stdout.json"), stdout);
  fs.writeFileSync(path.join(root, label + ".stderr.log"), stderr);
  const json = JSON.parse(stdout);
  report.commands.push({ label, args, startedAt, finishedAt: new Date().toISOString(), status });
  save();
  return { status, json };
}
const readState = () => JSON.parse(fs.readFileSync(path.join(root, "agents/runs/fixture/state.json"), "utf8"));
const blockers = (state) => state.findings.filter((finding) => finding.status === "open" && finding.kind !== "advisory");
function recordAttempt(state, label) {
  assert.equal(state.schema, "sasu.implement.state.v10");
  const attempt = state.verificationAttempts.at(-1);
  assert.equal(attempt.prdSha256, report.prdSha256);
  assert.ok(attempt.reviewContext, "the actual review context was not pinned");
  assert.deepEqual([...attempt.reviewContext.requiredRequirementRefs].sort(), Array.from({ length: 30 }, (_, index) => "B" + (index + 1)).sort());
  assert.ok(attempt.reviewContext.actualEvidenceRefs.includes("src/public.mjs"));
  fs.writeFileSync(path.join(root, label + ".attempt.json"), JSON.stringify(attempt, null, 2) + "\n");
  report.attempts.push({ label, id: attempt.id, verdict: attempt.verdict, inputFingerprint: attempt.inputFingerprint, sourceFingerprint: attempt.sourceFingerprint,
    durationMs: attempt.durationMs, mechanical: attempt.mechanical.map(({ command, status, durationMs }) => ({ command, status, durationMs })),
    reviews: attempt.reviews, blockers: blockers(state) });
  save();
  return attempt;
}
function assertActualReviews(attempt) {
  assert.equal(attempt.mechanical.length, 1);
  assert.ok(attempt.mechanical.every((entry) => entry.status === "PASS"));
  for (const role of ["fidelity", "code"]) {
    const lane = attempt.reviews[role];
    assert.ok(lane?.result, role + " has no completed result");
    assert.equal(lane.error, null);
    assert.equal(lane.judge.backend, backend);
    assert.equal(lane.judge.outcome, "ok");
    assert.equal(lane.judge.purpose, "implement:" + role);
  }
  const assessments = attempt.reviews.fidelity.result.assessments;
  assert.ok(Array.isArray(assessments) && assessments.length > 0, "Fidelity has no requirement/evidence record");
  const allRefs = assessments.flatMap((entry) => entry.requirementRefs);
  assert.equal(new Set(allRefs).size, allRefs.length, "assessment references must not be duplicated");
  const required = new Set(attempt.reviewContext.requiredRequirementRefs);
  const covered = allRefs.filter((ref) => required.has(ref));
  assert.equal(covered.length, 30, "coverage must account for 30 requirements exactly once");
  assert.deepEqual([...covered].sort(), Array.from({ length: 30 }, (_, index) => "B" + (index + 1)).sort());
  for (const entry of assessments) {
    assert.ok(entry.rationale.trim().length > 0);
    assert.ok(entry.evidenceRefs.length > 0);
    if (entry.conclusion === "satisfied") {
      const needsSource = entry.requirementRefs.some((ref) => required.has(ref) && ref !== "B1");
      assert.ok(needsSource ? entry.evidenceRefs.includes("src/public.mjs") : entry.evidenceRefs.some((ref) => ref === "src/public.mjs" || ref === "suite.mjs" || attempt.mechanical.some((run) => run.logPath === ref)), "the single executed requirement cannot be runtime evidence for the remaining 29");
    }
  }
  const lanes = Object.values(attempt.reviews);
  assert.ok(Math.max(...lanes.map((lane) => Date.parse(lane.startedAt))) < Math.min(...lanes.map((lane) => Date.parse(lane.finishedAt))), "review execution intervals did not overlap");
}
try {
  const version = spawnSync(process.execPath, [cli, "--contract-version"], { encoding: "utf8", env });
  assert.equal(version.status, 0);
  report.contractVersion = version.stdout.trim();
  assert.equal(report.contractVersion, "0.10.0");
  report.candidateCommit = git(candidate, ["rev-parse", "HEAD"]);
  report.cliEntrySha256 = sha(fs.readFileSync(cli));
  fs.mkdirSync(path.join(root, "agents/prd/fixture"), { recursive: true });
  const text = prd({ count: 30 })
    .replace(/Requirement (\d+): the public command preserves value \d+\./g, "The exported command($1) returns the number $1.")
    .replace("The public command is implemented in implementation.txt.", "The public API is command exported from src/public.mjs. The complete source can establish deterministic integer behavior.");
  fs.writeFileSync(path.join(root, "agents/prd/fixture/prd.md"), text);
  fs.writeFileSync(path.join(root, ".gitignore"), "agents/\n*.stdout.json\n*.stderr.log\n*.attempt.json\nrelease-summary.json\n");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node suite.mjs" } }, null, 2) + "\n");
  fs.writeFileSync(path.join(root, "suite.mjs"), 'import assert from "node:assert/strict";\nimport { command } from "./src/public.mjs";\nassert.equal(command(1), 1);\nconsole.log("Actual required suite: command(1) returned 1. This suite did not execute the other requirements.");\n');
  fs.writeFileSync(path.join(root, "agents/config.json"), JSON.stringify({ judge: { retryBudget: 2, profiles: { routine: { primary: { backend, model: backend === "codex" ? "gpt-5.6-luna" : "claude-sonnet-5", effort: "xhigh" }, fallback: null } } } }, null, 2));
  for (const args of [["init", "-q"], ["add", ".gitignore", "package.json", "suite.mjs"], ["-c", "user.name=test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "Prepare review evidence fixture"]]) git(root, args);
  report.prdSha256 = sha(text);
  assert.equal((await invoke("start", ["implement", "start", "--prd", "agents/prd/fixture/prd.md", "--dirty-attribution", "run-owned"])).status, 0);
  const workRoot = readState().worktree?.path ?? root;
  report.workRoot = workRoot;
  fs.mkdirSync(path.join(workRoot, "src"), { recursive: true });
  const sourcePath = path.join(workRoot, "src/public.mjs");
  const complete = "export function command(n) { if (Number.isInteger(n) && n >= 1 && n <= 30) return n; }\n";
  const broken = "export function command(n) { if (Number.isInteger(n) && n >= 1 && n < 30) return n; }\n";
  let firstBytes, initialFindingIds;
  if (backend === "codex") {
    fs.writeFileSync(sourcePath, broken);
    const failed = await invoke("verify-missing-final", ["implement", "verify"]);
    assert.notEqual(failed.status, 0);
    const state = readState();
    const attempt = recordAttempt(state, "missing-final");
    assert.equal(attempt.verdict, "FAIL");
    assertActualReviews(attempt);
    const open = blockers(state);
    assert.ok(open.length > 0);
    assert.ok(open.every((finding) => finding.kind === "defect" && finding.requirementRefs.includes("B30") && finding.requirementRefs.every((ref) => ref === "B30" || ref === "D-01")), "unexpected blocker outside the planted B30 omission");
    const finalAssessment = attempt.reviews.fidelity.result.assessments.find((entry) => entry.requirementRefs.includes("B30"));
    assert.equal(finalAssessment.conclusion, "unresolved");
    assert.ok(finalAssessment.evidenceRefs.includes("src/public.mjs"));
    initialFindingIds = open.map((entry) => entry.id);
    firstBytes = JSON.stringify(attempt);
    assert.notEqual((await invoke("finalize-refused", ["implement", "finalize"])).status, 0);
    assert.equal(readState().completion, null);
  }
  fs.writeFileSync(sourcePath, complete);
  report.finalSourceSha256 = sha(complete);
  const passed = await invoke("verify-complete", ["implement", "verify"]);
  const state = readState();
  const attempt = recordAttempt(state, "complete");
  assert.equal(passed.status, 0);
  assert.equal(attempt.verdict, "PASS");
  assertActualReviews(attempt);
  assert.ok(attempt.reviews.fidelity.result.assessments.every((entry) => entry.conclusion === "satisfied"));
  assert.deepEqual(blockers(state), []);
  if (firstBytes) assert.equal(JSON.stringify(state.verificationAttempts[0]), firstBytes, "the prior settled judgment was rewritten");
  const count = state.verificationAttempts.length;
  const passBytes = JSON.stringify(attempt);
  assert.equal((await invoke("finalize", ["implement", "finalize"])).status, 0);
  const closed = readState();
  assert.equal(closed.status, "complete");
  assert.equal(closed.verificationAttempts.length, count);
  assert.equal(JSON.stringify(closed.verificationAttempts.at(-1)), passBytes, "finalize rewrote the selected PASS judgment");
  if (firstBytes) {
    assert.equal(JSON.stringify(closed.verificationAttempts[0]), firstBytes, "finalize rewrote the original FAIL judgment");
    for (const id of initialFindingIds) assert.equal(closed.findings.find((entry) => entry.id === id)?.status, "resolved", "the original finding disappeared instead of being resolved");
  }
  const receipt = JSON.parse(fs.readFileSync(path.join(root, closed.completion.receiptPath), "utf8"));
  assert.equal(receipt.status, "complete");
  assert.equal(receipt.schema, "sasu.implement.receipt.v6");
  assert.equal(receipt.verificationAttemptId, attempt.id);
  report.receipt = { schema: receipt.schema, status: receipt.status, path: closed.completion.receiptPath };
  assert.equal(sha(fs.readFileSync(cli)), report.cliEntrySha256, "the invoked CLI changed during the live check");
  report.outcome = "PASS";
} catch (error) {
  report.outcome = "FAIL";
  report.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify({ backend, outcome: report.outcome, root, error: report.error ?? null }));
}
