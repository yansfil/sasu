// Refactor safety net for prd_state_harness.js.
//
// Drives the policy v2 standard review profile through the full happy path
// (init -> plan -> mark -> verify-run -> independent combined fidelity review
// -> finalize) and pins the rendered markdown artifacts against normalized
// golden files so module extraction cannot silently change CLI output.
//
// Regenerate goldens after an intentional rendering change:
//   UPDATE_GOLDEN=1 node --test tests/prd_state_regression.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const harness = path.join(repoRoot, "skills", "implement", "scripts", "prd_state_harness.js");
const goldenDir = path.join(repoRoot, "tests", "golden", "prd-state-standard-flow");
const updateGolden = process.env.UPDATE_GOLDEN === "1";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    shell: false,
    encoding: "utf8",
    input: options.input,
    env: options.env,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error([
      `Command failed: ${[command, ...args].join(" ")}`,
      `cwd: ${options.cwd}`,
      `exitCode: ${result.status}`,
      result.stdout ? `stdout:\n${result.stdout}` : "",
      result.stderr ? `stderr:\n${result.stderr}` : "",
    ].filter(Boolean).join("\n"));
  }
  return result;
}

function runJson(args, cwd, options = {}) {
  const result = run(process.execPath, [harness, ...args], { cwd, allowFailure: options.allowFailure });
  const text = result.stdout.trim();
  return text ? JSON.parse(text) : null;
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`);
}

function initGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engineering-harness-regression-"));
  run("git", ["init", "-b", "main"], { cwd: dir });
  run("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  run("git", ["config", "user.name", "Harness Test"], { cwd: dir });
  run("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  write(path.join(dir, "README.md"), "# Test Repo\n");
  run("git", ["add", "README.md"], { cwd: dir });
  run("git", ["commit", "-m", "Initial"], { cwd: dir });
  return dir;
}

function writeApprovedPrd(projectRoot, slug) {
  const prd = `---
topic: "${slug}"
status: "ready"
human_approval: "approved"
source_intake: "current conversation"
source_clarity: "none"
created_at: "2026-07-06"
updated_at: "2026-07-06"
---

# PRD: ${slug}

## 1. Summary

Implement a small test behavior.

Approval checklist:
- Scope: R1, AC1.

## 2. Problem, Goal, And Users

Test the harness.

## 3. Scope And Non-Goals

In scope: one local verification.

## 4. Pre-Work And Required Decisions

### 4.1 Pre-Work Before Implementation

None required.

### 4.2 Human Decisions Before PRD Approval

Approved test scope.

### 4.3 Decision Traceability For Fidelity Review

- User approved the test scope: represented by R1, AC1, T1, V1.

## 5. Major Technical Structure Changes

No major technical structure change expected.

## 6. Requirements

- R1. The harness records a local command verification.

## 7. Acceptance Criteria

- AC1. V1 passes with a command-log artifact.

## 8. PRD-Level Tasks

- T1. Run the local command verification. Covers R1, AC1.

## 9. Verification Contract

### 9.1 Test Mode Contract

| Mode | Required For Done | Covers | Human Decision |
| --- | --- | --- | --- |
| build/static | yes | local command proof | none |

### 9.2 Required Agent Verification

| ID | Mode | Covers | Method | Artifact | Pass Intent | Required For Done | Can Be Blocked |
| --- | --- | --- | --- | --- | --- | --- | --- |
| V1 | build/static | R1, AC1, T1 | \`node -e "process.exit(0)"\` | command-log | command exits zero | yes | no |

### 9.3 Human Verification

None required.

## 10. Risks And Open Decisions

None.

## 11. Implementation Guardrails

Do not add scope.

## 12. Implementation Result Report Contract

Report status and verification evidence.
`;
  const file = path.join(projectRoot, "agents", "prd", slug, "prd.md");
  write(file, prd);
  return file;
}

function fidelityReviewBody(prdRelPath, logPath) {
  return `# Requirements Fidelity Review

Status: PASS

## Intent Sources Read

- ${prdRelPath}

## Decision Trace

- User approved the test scope: represented by R1, AC1, T1, V1 | gap: none

## Findings

- none: no material findings

## Verification Intent Checklist

- V1: Pass Intent: command exits zero; Covers: R1, AC1; Artifacts checked: ${logPath}; Judgment: PASS; Gap: none

## Coverage Judgment

- Requirements: covered by V1.
- Acceptance Criteria: AC1 is met.
- User-visible behavior: no user-visible behavior.
- Non-goals and rejected options: none reintroduced.
- Human verification: none required.

## Verdict

PASS.
`;
}

// Normalize machine- and run-specific content so goldens stay stable across
// tmpdirs, machines, and wall clocks.
function normalizeArtifact(text, projectRoot) {
  const roots = new Set([projectRoot]);
  try {
    roots.add(fs.realpathSync(projectRoot));
  } catch {
    // keep the raw root only
  }
  let out = text;
  for (const root of roots) {
    out = out.split(root).join("<ROOT>");
  }
  const home = os.homedir();
  out = out
    .split(harness).join("<HARNESS>")
    .split(`~${harness.startsWith(home) ? harness.slice(home.length) : harness}`).join("<HARNESS>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<TS>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z/g, "<TS>")
    .replace(/\b\d{8}T\d{6,}Z?\b/g, "<TS>")
    .replace(/\b[0-9a-f]{12,64}\b/g, "<SHA>")
    .replace(/"evidenceHash": "[0-9a-f]+"/g, '"evidenceHash": "<SHA>"')
    .replace(/\b\d+ms\b/g, "<MS>");
  return out;
}

function assertGolden(name, actual) {
  const goldenPath = path.join(goldenDir, name);
  if (updateGolden) {
    write(goldenPath, actual);
    return;
  }
  assert.ok(fs.existsSync(goldenPath), `Missing golden file ${goldenPath}; regenerate with UPDATE_GOLDEN=1`);
  const expected = fs.readFileSync(goldenPath, "utf8");
  assert.equal(actual, expected, `Rendered artifact ${name} drifted from golden; if intentional, regenerate with UPDATE_GOLDEN=1`);
}

test("policy v2 standard profile finalizes after one combined fidelity review and matches goldens", () => {
  const projectRoot = initGitRepo();
  const slug = "standard-regression";
  const prdPath = writeApprovedPrd(projectRoot, slug);
  const runDir = path.join(projectRoot, "agents", "implement", slug);
  const statePathAbs = path.join(runDir, "state.json");
  const readState = () => JSON.parse(fs.readFileSync(statePathAbs, "utf8"));
  const removedBaselinePath = path.join(projectRoot, "baseline-only.txt");
  write(removedBaselinePath, "Present only in the initial dirty snapshot.");

  const initResult = runJson(
    ["init", "--prd", prdPath, "--review-profile", "standard", "--session-id", "regression-session"],
    projectRoot,
  );
  assert.equal(initResult.ok, true);
  let state = readState();
  assert(state.initialWorktreeSnapshot);
  assert.equal(typeof state.initialWorktreeSnapshot.statusHash, "string");
  assert(Array.isArray(state.initialWorktreeSnapshot.entries));

  runJson(["plan-execution"], projectRoot);
  const ready = runJson(["ready"], projectRoot);
  assert.ok(Array.isArray(ready.ready.readySequential) && ready.ready.readySequential.length >= 1);

  const nodeIds = readState().executionPlan.nodes.map(node => node.id).join(",");
  runJson(["mark-node", "--id", nodeIds, "--status", "complete", "--evidence", "Test nodes completed."], projectRoot);
  runJson(["mark", "--kind", "ac", "--id", "AC1", "--status", "met", "--evidence", "V1 proves AC1."], projectRoot);
  runJson(["verify-run", "--id", "V1", "--", "bash", "-lc", "node -e 'process.exit(0)'"], projectRoot);

  state = readState();
  assert.equal(state.verification[0].status, "pass");
  const logPath = state.verification[0].artifacts[0].path;
  fs.rmSync(removedBaselinePath);

  // The prompts are agent-facing contracts; pin their key anchors before the
  // renderers move to their own module.
  const fidelityPrompt = run(process.execPath, [harness, "requirements-review-prompt"], { cwd: projectRoot }).stdout;
  for (const anchor of ["Decision Trace", "Verification Intent Checklist", "Coverage Judgment", "fresh independent read-only semantic reviewer", "Do not rerun the complete test suite", "read the complete file", "not semantic coverage proof", "invented consent"]) {
    assert.ok(fidelityPrompt.includes(anchor), `requirements-review-prompt lost anchor: ${anchor}`);
  }

  const prdRelPath = path.join("agents", "prd", slug, "prd.md");
  const fidelityReportPath = path.join(runDir, "review", "requirements-fidelity-review.md");
  write(fidelityReportPath, fidelityReviewBody(prdRelPath, logPath));
  const fidelityRecord = runJson(
    ["requirements-review-record", "--status", "pass", "--report", fidelityReportPath, "--summary", "PASS"],
    projectRoot,
  );
  assert.equal(fidelityRecord.ok, true);

  state = readState();
  assert.equal(state.reviewProfile.policyVersion, 2);
  assert.equal(state.finalReview, null);
  assert.equal(state.taskGraph.nodes.some(node => node.id === "REVIEW"), false);
  assert(state.taskGraph.edges.some(edge => edge.from === "REQ_FIDELITY_REVIEW" && edge.to === "FINALIZE"));

  const status = runJson(["status"], projectRoot);
  assert.equal(status.reviewProfile.profile, "standard");
  assert.equal(status.reviewPolicy.fidelityOwner, "independent");
  assert.equal(status.reviewPolicy.finalReviewRequired, false);
  assert.equal(status.next, null);
  assert.equal(status.counts.verificationOpen, 0);
  assert.equal(status.counts.requiredVerificationNotPassed, 0);

  const finalized = runJson(["finalize", "--status", "complete", "--summary", "Standard run completed."], projectRoot);
  assert.equal(finalized.ok, true);

  const receipt = JSON.parse(fs.readFileSync(path.join(runDir, "receipt.json"), "utf8"));
  assert.equal(receipt.status, "complete");
  assert.equal(receipt.reviewProfile.profile, "standard");
  assert.equal(receipt.reviewProfile.policyVersion, 2);
  assert.equal(receipt.reviewPolicy.fidelityOwner, "independent");
  assert.equal(receipt.reviewPolicy.finalReviewRequired, false);
  assert(receipt.initialWorktreeSnapshot);
  assert.equal(receipt.initialWorktreeSnapshot.statusHash, state.initialWorktreeSnapshot.statusHash);
  assert.equal(receipt.finalReview, null);
  assert.equal(receipt.requirementsFidelityReview.status, "pass");

  const implementationResult = fs.readFileSync(path.join(runDir, "implementation-result.md"), "utf8");
  for (const anchor of [
    "Status: Done",
    "## Approval And Deviations",
    "## Review Policy",
    "## Worktree Scope And Delivery",
    "Initial worktree snapshot:",
    "Added, changed, or removed after initialization:",
    "## Coordinator Context Notes",
  ]) {
    assert(implementationResult.includes(anchor), `implementation-result lost contract anchor: ${anchor}`);
  }
  assert.match(implementationResult, /Added, changed, or removed after initialization: baseline-only\.txt\./);

  for (const name of [
    "checklist.md",
    "execution-plan.md",
    "verification-plan.md",
    "taskgraph.md",
    "verification.md",
    "implementation-result.md",
  ]) {
    const rendered = fs.readFileSync(path.join(runDir, name), "utf8");
    assertGolden(name, normalizeArtifact(rendered, projectRoot));
  }
});
