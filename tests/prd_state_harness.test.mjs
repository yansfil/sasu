import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const harness = path.join(repoRoot, "skills", "prd-implement", "scripts", "prd_state_harness.js");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    shell: false,
    encoding: "utf8",
    input: options.input,
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engineering-harness-"));
  run("git", ["init", "-b", "main"], { cwd: dir });
  run("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  run("git", ["config", "user.name", "Harness Test"], { cwd: dir });
  write(path.join(dir, "README.md"), "# Test Repo\n");
  run("git", ["add", "README.md"], { cwd: dir });
  run("git", ["commit", "-m", "Initial"], { cwd: dir });
  return dir;
}

function writeApprovedPrd(projectRoot, slug, extra = "") {
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
${extra}
`;
  const file = path.join(projectRoot, ".hoyeon", "prd", slug, "prd.md");
  write(file, prd);
  return file;
}

test("worktree init overwrites main active pointer and writes main session active file", () => {
  const projectRoot = initGitRepo();
  write(path.join(projectRoot, ".hoyeon", "config.json"), JSON.stringify({
    delivery: { mode: "pr", branchPrefix: "prd/" },
    worktree: { enabled: true, root: path.join(projectRoot, "..", `${path.basename(projectRoot)}.worktrees`) },
  }, null, 2));
  const prdPath = writeApprovedPrd(projectRoot, "pointer-test");
  const stale = {
    schema: "hoyeon.prd-implement.active.v1",
    statePath: ".hoyeon/implement/stale/state.json",
    activeSessionId: "codex:old",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
  write(path.join(projectRoot, ".hoyeon", "implement", ".prd-implement-active.json"), JSON.stringify(stale, null, 2));

  const result = runJson(["init", "--prd", prdPath, "--delivery", "pr", "--session-id", "new-session"], projectRoot);
  assert.equal(result.ok, true);
  assert.equal(result.mainRootPointerWritten, true);

  const active = JSON.parse(fs.readFileSync(path.join(projectRoot, ".hoyeon", "implement", ".prd-implement-active.json"), "utf8"));
  assert.match(active.statePath, /pointer-test\/state\.json$/);
  assert.match(active.statePath, /worktrees/);
  assert.equal(active.activeSessionId, "codex:new-session");

  const sessionFile = path.join(projectRoot, ".hoyeon", "implement", ".prd-implement-sessions", "codex%3Anew-session.json");
  assert.equal(fs.existsSync(sessionFile), true);
  const sessionActive = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
  assert.equal(sessionActive.statePath, active.statePath);

  const cleanup = runJson(["cleanup-active", "--state", active.statePath], projectRoot);
  assert.equal(cleanup.ok, true);
  assert.equal(fs.existsSync(path.join(projectRoot, ".hoyeon", "implement", ".prd-implement-active.json")), false);
  assert.equal(fs.existsSync(sessionFile), false);
});

test("init refuses an existing target worktree owned by another checkout", () => {
  const ownerRoot = initGitRepo();
  const targetParent = fs.mkdtempSync(path.join(os.tmpdir(), "foreign-worktree-target-"));
  const targetRoot = path.join(targetParent, "shared-pointer-test-worktree");
  run("git", ["worktree", "add", "-b", "prd/pointer-test", targetRoot, "HEAD"], { cwd: ownerRoot });

  const projectRoot = initGitRepo();
  write(path.join(projectRoot, ".hoyeon", "config.json"), JSON.stringify({
    delivery: { mode: "pr", branchPrefix: "prd/" },
    worktree: { enabled: true, path: targetRoot },
  }, null, 2));
  const prdPath = writeApprovedPrd(projectRoot, "pointer-test");
  const result = run(process.execPath, [harness, "init", "--prd", prdPath, "--delivery", "pr"], {
    cwd: projectRoot,
    allowFailure: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not registered under the current checkout/);
});

test("verify-run treats bash -lc wrapper as the planned command", () => {
  const projectRoot = initGitRepo();
  const prdPath = writeApprovedPrd(projectRoot, "command-normalization");
  runJson(["init", "--prd", prdPath, "--review-profile", "trivial"], projectRoot);
  const result = runJson(["verify-run", "--id", "V1", "--", "bash", "-lc", "node -e 'process.exit(0)'"], projectRoot);
  assert.equal(result.ok, true);
  const state = JSON.parse(fs.readFileSync(path.join(projectRoot, ".hoyeon", "implement", "command-normalization", "state.json"), "utf8"));
  assert.deepEqual(state.deviations.filter(item => item.type === "verification_command"), []);
});

test("verify-run treats planned bash -lc wrapper as equivalent to the inner command", () => {
  const projectRoot = initGitRepo();
  const prdPath = writeApprovedPrd(projectRoot, "planned-wrapper", `
## Extra

The intended verifier may be wrapped by a login shell.
`);
  let text = fs.readFileSync(prdPath, "utf8");
  text = text.replace("`node -e \"process.exit(0)\"`", "`bash -lc 'node -e \"process.exit(0)\"'`");
  fs.writeFileSync(prdPath, text);
  runJson(["init", "--prd", prdPath, "--review-profile", "trivial"], projectRoot);
  const result = runJson(["verify-run", "--id", "V1", "--", "node", "-e", "process.exit(0)"], projectRoot);
  assert.equal(result.ok, true);
  const state = JSON.parse(fs.readFileSync(path.join(projectRoot, ".hoyeon", "implement", "planned-wrapper", "state.json"), "utf8"));
  assert.deepEqual(state.deviations.filter(item => item.type === "verification_command"), []);
});

test("verify-run preserves quoted argument whitespace when comparing commands", () => {
  const projectRoot = initGitRepo();
  const prdPath = writeApprovedPrd(projectRoot, "quoted-whitespace");
  let text = fs.readFileSync(prdPath, "utf8");
  text = text.replace("`node -e \"process.exit(0)\"`", "`node -e \"process.stdout.write('a b')\"`");
  fs.writeFileSync(prdPath, text);
  runJson(["init", "--prd", prdPath, "--review-profile", "trivial"], projectRoot);
  const result = run(process.execPath, [harness, "verify-run", "--id", "V1", "--", "node", "-e", "process.stdout.write('a    b')"], {
    cwd: projectRoot,
    allowFailure: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /command differs from PRD contract/);
});

test("batch mark-node with a bad id does not persist partial mutation", () => {
  const projectRoot = initGitRepo();
  const prdPath = writeApprovedPrd(projectRoot, "batch-bad-id");
  runJson(["init", "--prd", prdPath, "--review-profile", "trivial"], projectRoot);
  runJson(["plan-execution"], projectRoot);
  const statePath = path.join(projectRoot, ".hoyeon", "implement", "batch-bad-id", "state.json");
  const before = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(before.executionPlan.nodes[0].status, "pending");
  const result = run(process.execPath, [harness, "mark-node", "--id", `${before.executionPlan.nodes[0].id},N999`, "--status", "complete", "--evidence", "should not persist"], {
    cwd: projectRoot,
    allowFailure: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Execution node N999 not found/);
  const after = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(after.executionPlan.nodes[0].status, "pending");
  assert.deepEqual(after.executionPlan.nodes[0].evidence, []);
});

test("trivial review profile can finalize with requirements fidelity review only", () => {
  const projectRoot = initGitRepo();
  const prdPath = writeApprovedPrd(projectRoot, "trivial-finalize");
  runJson(["init", "--prd", prdPath, "--review-profile", "trivial", "--session-id", "trivial-session"], projectRoot);
  runJson(["plan-execution"], projectRoot);
  let state = JSON.parse(fs.readFileSync(path.join(projectRoot, ".hoyeon", "implement", "trivial-finalize", "state.json"), "utf8"));
  const nodeIds = state.executionPlan.nodes.map(node => node.id).join(",");
  runJson(["mark-node", "--id", nodeIds, "--status", "complete", "--evidence", "Test nodes completed."], projectRoot);
  runJson(["mark", "--kind", "ac", "--id", "AC1", "--status", "met", "--evidence", "V1 proves AC1."], projectRoot);
  runJson(["verify-run", "--id", "V1", "--", "bash", "-lc", "node -e 'process.exit(0)'"], projectRoot);

  state = JSON.parse(fs.readFileSync(path.join(projectRoot, ".hoyeon", "implement", "trivial-finalize", "state.json"), "utf8"));
  const logPath = state.verification[0].artifacts[0].path;
  const reviewPath = path.join(projectRoot, ".hoyeon", "implement", "trivial-finalize", "review", "requirements-fidelity-review.md");
  write(reviewPath, `# Requirements Fidelity Review

Status: PASS

## Intent Sources Read

- .hoyeon/prd/trivial-finalize/prd.md

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
`);
  runJson(["requirements-review-record", "--status", "pass", "--report", reviewPath, "--summary", "PASS"], projectRoot);
  const status = runJson(["status"], projectRoot);
  assert.equal(status.reviewProfile.profile, "trivial");
  assert.equal(status.next, null);
  const stopHook = run(process.execPath, [harness, "hook", "stop"], {
    cwd: projectRoot,
    input: JSON.stringify({ hook_event_name: "Stop", cwd: projectRoot, session_id: "trivial-session" }),
  });
  const stopDirective = JSON.parse(stopHook.stdout);
  assert.match(stopDirective.reason, /trivial profile gates passed; write receipt/);
  assert.doesNotMatch(stopDirective.reason, /prd_state_harness\.js review-record/);
  const preToolHook = run(process.execPath, [harness, "hook", "pretool-use"], {
    cwd: projectRoot,
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      cwd: projectRoot,
      session_id: "trivial-session",
      tool_name: "update_goal",
      tool_input: { status: "complete" },
    }),
  });
  const preToolDirective = JSON.parse(preToolHook.stdout);
  assert.doesNotMatch(preToolDirective.reason, /record a passing final review/);
  assert.match(preToolDirective.reason, /trivial review profile/);
  const finalized = runJson(["finalize", "--status", "complete", "--summary", "Trivial run completed."], projectRoot);
  assert.equal(finalized.ok, true);
  const receipt = JSON.parse(fs.readFileSync(path.join(projectRoot, ".hoyeon", "implement", "trivial-finalize", "receipt.json"), "utf8"));
  assert.equal(receipt.status, "complete");
  assert.equal(receipt.finalReview, null);
  assert.equal(receipt.reviewProfile.profile, "trivial");
});

test("not-watched PR delivery ship log keeps hook delivery guard active", () => {
  const projectRoot = initGitRepo();
  const prdPath = writeApprovedPrd(projectRoot, "pr-not-watched");
  runJson(["init", "--prd", prdPath, "--review-profile", "trivial", "--delivery", "pr", "--skip-worktree", "--session-id", "ship-session"], projectRoot);
  runJson(["plan-execution"], projectRoot);
  let state = JSON.parse(fs.readFileSync(path.join(projectRoot, ".hoyeon", "implement", "pr-not-watched", "state.json"), "utf8"));
  const nodeIds = state.executionPlan.nodes.map(node => node.id).join(",");
  runJson(["mark-node", "--id", nodeIds, "--status", "complete", "--evidence", "Test nodes completed."], projectRoot);
  runJson(["mark", "--kind", "ac", "--id", "AC1", "--status", "met", "--evidence", "V1 proves AC1."], projectRoot);
  runJson(["verify-run", "--id", "V1", "--", "bash", "-lc", "node -e 'process.exit(0)'"], projectRoot);

  state = JSON.parse(fs.readFileSync(path.join(projectRoot, ".hoyeon", "implement", "pr-not-watched", "state.json"), "utf8"));
  const logPath = state.verification[0].artifacts[0].path;
  const reviewPath = path.join(projectRoot, ".hoyeon", "implement", "pr-not-watched", "review", "requirements-fidelity-review.md");
  write(reviewPath, `# Requirements Fidelity Review

Status: PASS

## Intent Sources Read

- .hoyeon/prd/pr-not-watched/prd.md

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
`);
  runJson(["requirements-review-record", "--status", "pass", "--report", reviewPath, "--summary", "PASS"], projectRoot);
  runJson(["finalize", "--status", "complete", "--summary", "PR-mode trivial run completed."], projectRoot);
  write(path.join(projectRoot, ".hoyeon", "implement", "pr-not-watched", "delivery", "ship-log.jsonl"), JSON.stringify({
    ts: new Date().toISOString(),
    event: "ship",
    pr: "https://example.com/pr/1",
    ciVerdict: "not-watched",
  }));
  const stopHook = run(process.execPath, [harness, "hook", "stop"], {
    cwd: projectRoot,
    input: JSON.stringify({ hook_event_name: "Stop", cwd: projectRoot, session_id: "ship-session" }),
  });
  const stopDirective = JSON.parse(stopHook.stdout);
  assert.match(stopDirective.reason, /prd-ship-handoff-guard/);
  assert.match(stopDirective.reason, /required CI passes/);
});
