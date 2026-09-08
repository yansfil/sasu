import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

export const CLI = path.resolve(import.meta.dirname, "../../dist/cli.js");
export const PRD_PATH = "agents/prd/fixture/prd.md";
export const STATE_PATH = "agents/runs/fixture/state.json";
export const REVIEW_PASS = { summary: "The full approved contract is satisfied by the supplied implementation and evidence.", findings: [], priorDispositions: [] };

export function prd({ profile = "standard", sourceIntake = "current conversation", count = 2, extraRows = [], risks = "None.", decisions } = {}) {
  const rows = Array.from({ length: count }, (_, index) => `| B${index + 1} | Requirement ${index + 1}: the public command preserves value ${index + 1}. | D-01 |`);
  return `---
topic: "implement fixture"
status: "ready"
human_approval: "approved"
review_profile: "${profile}"
review_rationale: "CLI regression fixture"
source_intake: "${sourceIntake}"
---

# PRD: implement fixture

## Goal
The public command preserves every requested value.

## Non-goals
No network service or second state store.

## Decisions
| D-n | 결정 | 근거 |
| --- | --- | --- |
${decisions ?? "| D-01 | Preserve every value in the approved request. | The user requested all values. |"}

## Behaviors
| # | 사용자가 관찰하는 행동 | 결정 |
| --- | --- | --- |
${[...rows, ...extraRows].join("\n")}

## Technical structure
The public command is implemented in implementation.txt.

## Risks
${risks}
`;
}

export function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

export function makeProject(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-whole-review-"));
  fs.mkdirSync(path.dirname(path.join(root, PRD_PATH)), { recursive: true });
  fs.writeFileSync(path.join(root, PRD_PATH), prd(options));
  fs.writeFileSync(path.join(root, ".gitignore"), "agents/\n");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node suite.cjs" } }));
  fs.writeFileSync(path.join(root, "suite.cjs"), options.suiteSource ?? `const fs = require('node:fs'); fs.mkdirSync('agents', { recursive: true }); fs.appendFileSync('agents/suite-count.log', 'ran\\n'); console.log('REAL-SUITE-OUTPUT'); process.exit(${options.testExit ?? 0});\n`);
  for (const args of [["init", "-q"], ["add", ".gitignore", "package.json", "suite.cjs"], ["-c", "user.name=test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "baseline"]]) git(root, args);
  return root;
}

// A child must never claim the developer's session or reach a live Herdr pane.
export function isolatedEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  for (const key of ["CODEX_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "SASU_HERDR_ROLE", "HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "SASU_JUDGE_BACKEND", "SASU_JUDGE_STUB_FILE", "SASU_JUDGE_STUB_CAPTURE_DIR", "SASU_JUDGE_STUB_DELAY_MS", "SASU_JUDGE_STUB_NO_AGENTIC", "SASU_JUDGE_STUB_NO_ATTACHMENTS", "SASU_JUDGE_STUB_TOOL_ROUNDS"])
    if (!(key in overrides)) delete env[key];
  return env;
}

export function run(root, args, { env = {} } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args, "--json"], { cwd: root, encoding: "utf8", env: isolatedEnv(env), timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  let json;
  try { json = JSON.parse(result.stdout); } catch { json = { stdout: result.stdout, stderr: result.stderr }; }
  return { ...result, json };
}

export function runAsync(root, args, env = {}) {
  const child = spawn(process.execPath, [CLI, ...args, "--json"], { cwd: root, env: isolatedEnv(env), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => {
      let json;
      try { json = JSON.parse(stdout); } catch { json = { stdout, stderr }; }
      resolve({ status, json, stdout, stderr });
    });
  });
  return { child, done };
}

export const readState = (root, slug = "fixture") => JSON.parse(fs.readFileSync(path.join(root, `agents/runs/${slug}/state.json`), "utf8"));
export function ok(result) { assert.equal(result.status, 0, result.stderr + result.stdout); return result.json; }
export function start(root, options = {}) {
  ok(run(root, ["implement", "start", "--prd", PRD_PATH, "--dirty-attribution", "run-owned"], options));
  const workRoot = readState(root).worktree?.path ?? root;
  fs.writeFileSync(path.join(workRoot, "implementation.txt"), "run-owned implementation\n");
  return workRoot;
}

// Findings-focused test inputs share this envelope, while each CLI role gets
// explicit grounds against its actual fixture contract. An explicit assessments
// field is never filled or repaired, so malformed-result tests reach validation.
export function reviewWithAssessments(root, review = REVIEW_PASS, role = "fidelity") {
  if (typeof review !== "object" || review === null || "assessments" in review) return review;
  const state = readState(root);
  const workRoot = state.worktree?.path ?? root;
  const evidenceRef = ["implementation.txt", "impl.txt"].find((relative) => fs.existsSync(path.join(workRoot, relative)))
    ?? state.artifacts[0]?.path ?? "implementation.txt";
  const blockers = Array.isArray(review.findings) ? review.findings.filter((finding) => finding.kind === "defect" || finding.kind === "human-confirmation" && finding.human?.timing === "prerequisite") : [];
  const unresolvedRefs = [...new Set(blockers.flatMap((finding) => finding.requirementRefs ?? []))];
  const pendingHuman = Array.isArray(review.findings) ? review.findings.filter((finding) => finding.kind === "human-confirmation" && finding.human?.timing === "post-completion") : [];
  const pendingRefs = [...new Set(pendingHuman.flatMap((finding) => finding.requirementRefs ?? []))].filter((ref) => !unresolvedRefs.includes(ref));
  const satisfiedRefs = state.requirements.map((entry) => entry.id).filter((ref) => !unresolvedRefs.includes(ref) && !pendingRefs.includes(ref));
  const assessments = [];
  if (blockers.length > 0) assessments.push({
    requirementRefs: unresolvedRefs, conclusion: "unresolved",
    rationale: "The fixture's blocking findings identify the concrete missing behavior or prerequisite.",
    evidenceRefs: [...new Set(blockers.flatMap((finding) => finding.evidenceRefs ?? [evidenceRef]))],
  });
  if (pendingHuman.length > 0) assessments.push({
    requirementRefs: pendingRefs, conclusion: "pending-human",
    rationale: "The approved authority explicitly reserves this judgment for human input after completion.",
    evidenceRefs: [...new Set(pendingHuman.flatMap((finding) => finding.evidenceRefs ?? []))],
  });
  if ((role === "fidelity" && satisfiedRefs.length > 0) || (role === "code" && blockers.length === 0 && pendingHuman.length === 0)) assessments.push({
    requirementRefs: role === "fidelity" ? satisfiedRefs : [], conclusion: "satisfied",
    rationale: role === "fidelity"
      ? "The shared fixture source preserves the requested values for these behaviors."
      : "The fixture's public implementation preserves its input without introducing another storage or dispatch path.",
    evidenceRefs: [evidenceRef],
  });
  return { ...review, assessments };
}

export function stub(root, review = REVIEW_PASS, risk) {
  const file = path.join(root, "agents/judge.json");
  const capture = path.join(root, "agents/captures");
  fs.writeFileSync(file, JSON.stringify({ byPurpose: { "implement:fidelity": reviewWithAssessments(root, review, "fidelity"), "implement:code": reviewWithAssessments(root, review, "code"), ...(risk ? { "implement:risk": risk } : {}) } }));
  return { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
}

export function registerEvidence(root, { relative = "agents/observations/runtime.log", content = "Actual fixture observation\n", env = {} } = {}) {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), content);
  ok(run(root, ["implement", "artifact", "--kind", "log", "--path", relative, "--description", "Fixture runtime observation", "--source", "fixture operator", "--collected-at", "2026-09-08T00:00:00.000Z", "--target", "fixture public command", "--environment", "disposable project"], { env }));
  return relative;
}

export function defect({ ref = "B1", problem = "The approved value is absent from the public implementation.", priorFindingId } = {}) {
  return { kind: "defect", requirementRefs: [ref], problem, evidenceRefs: ["implementation.txt"], nextAction: "Implement the missing approved value.", ...(priorFindingId ? { priorFindingId } : {}) };
}
