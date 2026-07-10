import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const harness = path.join(repoRoot, "skills", "fulfill", "scripts", "prd_state_harness.js");

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
  const file = path.join(projectRoot, "agents", "prd", slug, "prd.md");
  write(file, prd);
  return file;
}

test("an unbound pointer is claimed by the first hook session and isolated from others", () => {
  const root = initGitRepo();
  const prd = writeApprovedPrd(root, "bootstrap");
  // Init without any session id (env stripped) leaves the pointer unbound.
  const noSessionEnv = { ...process.env };
  delete noSessionEnv.CODEX_SESSION_ID;
  delete noSessionEnv.CODEX_THREAD_ID;
  delete noSessionEnv.CLAUDE_SESSION_ID;
  run(process.execPath, [harness, "init", "--prd", prd, "--review-profile", "trivial"], { cwd: root, env: noSessionEnv });
  const before = JSON.parse(fs.readFileSync(path.join(root, "agents", "implement", ".prd-implement-active.json"), "utf8"));
  assert.equal(before.activeSessionId, null);
  runJson(["plan-execution"], root);

  // First hook with a session id claims the unbound run and binds it.
  const claim = run(process.execPath, [harness, "hook", "stop"], {
    cwd: root,
    input: JSON.stringify({ hook_event_name: "Stop", cwd: root, session_id: "boot-s" }),
  });
  assert.match(JSON.parse(claim.stdout).reason, /prd-implement-continuation/);
  const bound = JSON.parse(fs.readFileSync(path.join(root, "agents", "implement", "bootstrap", "state.json"), "utf8"));
  assert.equal(bound.activeSessionId, "boot-s");

  // A different session must not pick up the now-bound run.
  const foreign = run(process.execPath, [harness, "hook", "stop"], {
    cwd: root,
    input: JSON.stringify({ hook_event_name: "Stop", cwd: root, session_id: "other-s" }),
  });
  assert.equal(foreign.stdout.trim(), "");
});

test("worktree init overwrites the main active pointer bound to the session", () => {
  const projectRoot = initGitRepo();
  write(path.join(projectRoot, "agents", "config.json"), JSON.stringify({
    delivery: { mode: "pr", branchPrefix: "prd/" },
    worktree: { enabled: true, root: path.join(projectRoot, "..", `${path.basename(projectRoot)}.worktrees`) },
  }, null, 2));
  const prdPath = writeApprovedPrd(projectRoot, "pointer-test");
  const stale = {
    schema: "hoyeon.prd-implement.active.v1",
    statePath: "agents/implement/stale/state.json",
    activeSessionId: "codex:old",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
  write(path.join(projectRoot, "agents", "implement", ".prd-implement-active.json"), JSON.stringify(stale, null, 2));

  const result = runJson(["init", "--prd", prdPath, "--delivery", "pr", "--session-id", "new-session"], projectRoot);
  assert.equal(result.ok, true);
  assert.equal(result.mainRootPointerWritten, true);

  const active = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", ".prd-implement-active.json"), "utf8"));
  assert.match(active.statePath, /pointer-test\/state\.json$/);
  assert.match(active.statePath, /worktrees/);
  assert.equal(active.activeSessionId, "new-session");

  const cleanup = runJson(["cleanup-active", "--state", active.statePath], projectRoot);
  assert.equal(cleanup.ok, true);
  assert.equal(fs.existsSync(path.join(projectRoot, "agents", "implement", ".prd-implement-active.json")), false);
});

test("doctor recognizes PRD-trackable and implement-ignored gitignore policy", () => {
  const projectRoot = initGitRepo();
  write(path.join(projectRoot, ".gitignore"), [
    "# PRD pipeline runtime state",
    "agents/implement/",
    "",
  ].join("\n"));
  const doctor = runJson(["doctor"], projectRoot);
  const gitignoreChecks = doctor.checks.filter(item => item.id === "gitignore");
  assert(gitignoreChecks.some(item => item.level === "ok" && item.message === "agents/prd/** is trackable"));
  assert(gitignoreChecks.some(item => item.level === "ok" && item.message === "agents/config.json is trackable"));
  assert(gitignoreChecks.some(item => item.level === "ok" && item.message === "agents/implement/** is ignored"));
});

test("init refuses an existing target worktree owned by another checkout", () => {
  const ownerRoot = initGitRepo();
  const targetParent = fs.mkdtempSync(path.join(os.tmpdir(), "foreign-worktree-target-"));
  const targetRoot = path.join(targetParent, "shared-pointer-test-worktree");
  run("git", ["worktree", "add", "-b", "prd/pointer-test", targetRoot, "HEAD"], { cwd: ownerRoot });

  const projectRoot = initGitRepo();
  write(path.join(projectRoot, "agents", "config.json"), JSON.stringify({
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
  const state = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", "command-normalization", "state.json"), "utf8"));
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
  const state = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", "planned-wrapper", "state.json"), "utf8"));
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
  const statePath = path.join(projectRoot, "agents", "implement", "batch-bad-id", "state.json");
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
  let state = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", "trivial-finalize", "state.json"), "utf8"));
  const nodeIds = state.executionPlan.nodes.map(node => node.id).join(",");
  runJson(["mark-node", "--id", nodeIds, "--status", "complete", "--evidence", "Test nodes completed."], projectRoot);
  runJson(["mark", "--kind", "ac", "--id", "AC1", "--status", "met", "--evidence", "V1 proves AC1."], projectRoot);
  runJson(["verify-run", "--id", "V1", "--", "bash", "-lc", "node -e 'process.exit(0)'"], projectRoot);

  state = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", "trivial-finalize", "state.json"), "utf8"));
  const logPath = state.verification[0].artifacts[0].path;
  const reviewPath = path.join(projectRoot, "agents", "implement", "trivial-finalize", "review", "requirements-fidelity-review.md");
  write(reviewPath, `# Requirements Fidelity Review

Status: PASS

## Intent Sources Read

- agents/prd/trivial-finalize/prd.md

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
  const receipt = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", "trivial-finalize", "receipt.json"), "utf8"));
  assert.equal(receipt.status, "complete");
  assert.equal(receipt.finalReview, null);
  assert.equal(receipt.reviewProfile.profile, "trivial");
});

function fidelityReviewBody(logPath, extraProse = "") {
  return `# Requirements Fidelity Review

Status: PASS

## Intent Sources Read

- agents/prd/x/prd.md

## Decision Trace

- User approved the test scope: represented by R1, AC1, T1, V1 | gap: none

## Findings

- none: no material findings${extraProse}

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

function driveToFidelity(projectRoot, slug, sessionId) {
  const prdPath = writeApprovedPrd(projectRoot, slug);
  runJson(["init", "--prd", prdPath, "--review-profile", "trivial", "--session-id", sessionId], projectRoot);
  runJson(["plan-execution"], projectRoot);
  const state = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", slug, "state.json"), "utf8"));
  const nodeIds = state.executionPlan.nodes.map(node => node.id).join(",");
  runJson(["mark-node", "--id", nodeIds, "--status", "complete", "--evidence", "done"], projectRoot);
  runJson(["mark", "--kind", "ac", "--id", "AC1", "--status", "met", "--evidence", "V1 proves AC1."], projectRoot);
  runJson(["verify-run", "--id", "V1", "--", "bash", "-lc", "node -e 'process.exit(0)'"], projectRoot);
  const after = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", slug, "state.json"), "utf8"));
  return { logPath: after.verification[0].artifacts[0].path, reviewPath: path.join(projectRoot, "agents", "implement", slug, "review", "requirements-fidelity-review.md") };
}

test("fidelity review accepts code-span generics/tags but rejects leftover template placeholders", () => {
  const projectRoot = initGitRepo();
  const { logPath, reviewPath } = driveToFidelity(projectRoot, "fidelity-placeholder", "fp-session");

  // Legitimate generics and JSX tags inside code spans must not read as placeholders.
  write(reviewPath, fidelityReviewBody(logPath, "\n- The handler returns `Array<string>` and renders a `<button>` element as intended."));
  const ok = runJson(["requirements-review-record", "--status", "pass", "--report", reviewPath, "--summary", "PASS"], projectRoot);
  assert.equal(ok.ok, true);

  // A leftover <topic-slug>-style placeholder in prose must still fail.
  write(reviewPath, fidelityReviewBody(logPath, "\n- Implemented the <topic-slug> flow end to end."));
  const bad = run(process.execPath, [harness, "requirements-review-record", "--status", "pass", "--report", reviewPath, "--summary", "PASS"], {
    cwd: projectRoot,
    allowFailure: true,
  });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /leftover <template> placeholders/);
});

test("browser verification without a dev script is a warning, not a blocking gap", () => {
  const projectRoot = initGitRepo();
  const slug = "browser-warn";
  const prd = `---
topic: "${slug}"
status: "ready"
human_approval: "approved"
source_intake: "current conversation"
created_at: "2026-07-06"
updated_at: "2026-07-06"
---

# PRD: ${slug}

## 1. Summary

Browser flow. Approval checklist:
- Scope: R1, AC1.

## 4. Pre-Work And Required Decisions

### 4.3 Decision Traceability For Fidelity Review

- User approved scope: represented by R1, AC1, T1, V1.

## 5. Major Technical Structure Changes

No major technical structure change expected.

## 6. Requirements

- R1. Main flow works in the browser.

## 7. Acceptance Criteria

- AC1. V1 proves the browser flow.

## 8. PRD-Level Tasks

- T1. Build the browser flow. Covers R1, AC1.

## 9. Verification Contract

### 9.1 Test Mode Contract

| Mode | Required For Done | Covers | Human Decision |
| --- | --- | --- | --- |
| browser/runtime | yes | main flow | final UX judgment |

### 9.2 Required Agent Verification

| ID | Mode | Covers | Pass Intent | Required For Done | Can Be Blocked |
| --- | --- | --- | --- | --- | --- |
| V1 | browser/runtime | R1, AC1, T1 | main flow works in browser runtime | yes | no |

## 11. Implementation Guardrails

Do not add scope.

## 12. Implementation Result Report Contract

Report status.
`;
  const prdPath = path.join(projectRoot, "agents", "prd", slug, "prd.md");
  write(prdPath, prd);
  const result = runJson(["init", "--prd", prdPath, "--review-profile", "trivial"], projectRoot);
  assert.equal(result.ok, true);
  const state = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", slug, "state.json"), "utf8"));
  const browserGaps = state.verificationPlan.gaps.filter(gap => gap.code === "browser-server-missing");
  assert.equal(browserGaps.length, 1);
  assert.equal(browserGaps[0].severity, "warning");
  assert.equal(state.verificationPlan.gaps.some(gap => gap.severity === "blocking"), false);
});

test("mutation command output is compact and stop directive gates verbose procedure by phase", () => {
  const projectRoot = initGitRepo();
  const slug = "compact-output";
  const prdPath = writeApprovedPrd(projectRoot, slug);
  runJson(["init", "--prd", prdPath, "--review-profile", "trivial", "--session-id", "co-session"], projectRoot);
  runJson(["plan-execution"], projectRoot);
  const state = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", slug, "state.json"), "utf8"));
  const firstNode = state.executionPlan.nodes[0].id;

  const markOut = runJson(["mark-node", "--id", firstNode, "--status", "complete", "--evidence", "done"], projectRoot);
  assert.equal(markOut.ok, true);
  assert.equal(markOut.taskGraph, undefined);
  assert.equal(markOut.executionPlan, undefined);
  assert.equal(markOut.ready, undefined);
  assert.equal(markOut.next.writeScope, undefined);

  const stopInput = JSON.stringify({ hook_event_name: "Stop", cwd: projectRoot, session_id: "co-session" });
  const first = run(process.execPath, [harness, "hook", "stop"], { cwd: projectRoot, input: stopInput });
  const firstReason = JSON.parse(first.stdout).reason;
  assert.match(firstReason, /Required procedure this turn/);
  assert.match(firstReason, /Recent activity:/);

  const second = run(process.execPath, [harness, "hook", "stop"], { cwd: projectRoot, input: stopInput });
  const secondReason = JSON.parse(second.stdout).reason;
  assert.doesNotMatch(secondReason, /Required procedure this turn/);
  assert.match(secondReason, /phase has not changed/);
  assert.match(secondReason, /# Completion rule/);
});

test("structural parse gaps block the readiness gate on empty AC, orphan R#, and dangling AC refs", () => {
  const projectRoot = initGitRepo();

  // Case A: the Acceptance Criteria heading drifted, so it parses empty while tasks parse.
  const prdA = writeApprovedPrd(projectRoot, "drift-ac");
  write(prdA, fs.readFileSync(prdA, "utf8").replace("## 7. Acceptance Criteria", "## 7. Acceptance Criteria (User-Facing)"));
  const a = runJson(["plan-verification", "--prd", prdA], projectRoot, { allowFailure: true });
  assert.equal(a.ok, false);
  assert(a.blockingGaps.some(gap => gap.code === "acceptance-section-empty"), JSON.stringify(a.blockingGaps));

  // Case B: a requirement is defined but never referenced by any task/AC/verification.
  const prdB = writeApprovedPrd(projectRoot, "orphan-req");
  write(prdB, fs.readFileSync(prdB, "utf8").replace(
    "- R1. The harness records a local command verification.",
    "- R1. The harness records a local command verification.\n- R2. An orphan requirement referenced by nothing.",
  ));
  const b = runJson(["plan-verification", "--prd", prdB], projectRoot, { allowFailure: true });
  assert.equal(b.ok, false);
  assert(b.blockingGaps.some(gap => gap.code === "requirement-uncovered" && gap.item === "R2"), JSON.stringify(b.blockingGaps));

  // Case C: a task cites an AC id that is not defined in Acceptance Criteria.
  const prdC = writeApprovedPrd(projectRoot, "dangling-ac");
  write(prdC, fs.readFileSync(prdC, "utf8").replace("Covers R1, AC1.", "Covers R1, AC9."));
  const c = runJson(["plan-verification", "--prd", prdC], projectRoot, { allowFailure: true });
  assert.equal(c.ok, false);
  assert(c.blockingGaps.some(gap => gap.code === "dangling-ac-reference" && gap.item === "AC9"), JSON.stringify(c.blockingGaps));

  // Control: the unmodified PRD has none of these structural gaps.
  const prdOk = writeApprovedPrd(projectRoot, "structural-ok");
  const ok = runJson(["plan-verification", "--prd", prdOk], projectRoot, { allowFailure: true });
  const structuralCodes = new Set(["acceptance-section-empty", "verification-section-empty", "dangling-ac-reference", "requirement-uncovered"]);
  assert.equal((ok.blockingGaps || []).some(gap => structuralCodes.has(gap.code)), false, JSON.stringify(ok.blockingGaps));
});

test("parallel ready groups are config-gated and off by default", () => {
  // Default: no config -> sequential; ready emits no parallel groups and the
  // Stop directive omits the parallel line.
  const rootA = initGitRepo();
  const prdA = writeApprovedPrd(rootA, "seq-default");
  runJson(["init", "--prd", prdA, "--review-profile", "trivial", "--session-id", "seq-s"], rootA);
  runJson(["plan-execution"], rootA);
  const readyA = runJson(["ready"], rootA);
  assert.equal(readyA.ready.parallelEnabled, false);
  assert.deepEqual(readyA.ready.readyParallelGroups, []);
  const stopA = run(process.execPath, [harness, "hook", "stop"], {
    cwd: rootA,
    input: JSON.stringify({ hook_event_name: "Stop", cwd: rootA, session_id: "seq-s" }),
  });
  assert.doesNotMatch(JSON.parse(stopA.stdout).reason, /- Ready parallel groups:/);

  // Opt-in: execution.parallel true -> ready reports enabled and the directive
  // surfaces the parallel line.
  const rootB = initGitRepo();
  write(path.join(rootB, "agents", "config.json"), JSON.stringify({ execution: { parallel: true } }, null, 2));
  const prdB = writeApprovedPrd(rootB, "par-on");
  runJson(["init", "--prd", prdB, "--review-profile", "trivial", "--session-id", "par-s"], rootB);
  runJson(["plan-execution"], rootB);
  const readyB = runJson(["ready"], rootB);
  assert.equal(readyB.ready.parallelEnabled, true);
  const stopB = run(process.execPath, [harness, "hook", "stop"], {
    cwd: rootB,
    input: JSON.stringify({ hook_event_name: "Stop", cwd: rootB, session_id: "par-s" }),
  });
  assert.match(JSON.parse(stopB.stdout).reason, /- Ready parallel groups:/);
});

test("review profile is config-driven with CLI override precedence", () => {
  // config review.profile forces the profile the PRD would not auto-classify to.
  const root = initGitRepo();
  write(path.join(root, "agents", "config.json"), JSON.stringify({ review: { profile: "high-risk" } }, null, 2));
  const prd = writeApprovedPrd(root, "review-config");
  runJson(["init", "--prd", prd, "--session-id", "rc"], root);
  const status = runJson(["status"], root);
  assert.equal(status.reviewProfile.profile, "high-risk");
  assert.equal(status.reviewProfile.source, "config");

  // A per-run --review-profile still overrides config.
  const root2 = initGitRepo();
  write(path.join(root2, "agents", "config.json"), JSON.stringify({ review: { profile: "high-risk" } }, null, 2));
  const prd2 = writeApprovedPrd(root2, "review-cli");
  runJson(["init", "--prd", prd2, "--review-profile", "trivial", "--session-id", "rc2"], root2);
  const status2 = runJson(["status"], root2);
  assert.equal(status2.reviewProfile.profile, "trivial");
  assert.equal(status2.reviewProfile.source, "explicit");
});

test("commit-only source change makes a recorded review stale", () => {
  const root = initGitRepo();
  const { logPath, reviewPath } = driveToFidelity(root, "commit-stale", "cs-session");
  write(reviewPath, fidelityReviewBody(logPath));
  runJson(["requirements-review-record", "--status", "pass", "--report", reviewPath, "--summary", "PASS"], root);
  // Move HEAD with an empty commit; the working tree stays clean of source changes,
  // so only the HEAD sha differs. Pre-fix this went undetected.
  run("git", ["commit", "--allow-empty", "-m", "move head"], { cwd: root });
  const fin = runJson(["finalize", "--status", "complete", "--summary", "done"], root, { allowFailure: true });
  assert.equal(fin.ok, false);
  assert(fin.violations.some(v => /stale/i.test(v)), JSON.stringify(fin.violations));
});

test("fidelity Decision Trace accepts a table trace instead of bullets", () => {
  const root = initGitRepo();
  const { logPath, reviewPath } = driveToFidelity(root, "table-trace", "tt-session");
  // Decision Trace expressed as a markdown table (no bullets). Previously the
  // bullet-only count would reject this.
  write(reviewPath, `# Requirements Fidelity Review

Status: PASS

## Intent Sources Read

- agents/prd/table-trace/prd.md

## Decision Trace

| Decision | Represented by | Gap |
| --- | --- | --- |
| User approved the test scope | R1, AC1, T1, V1 | none |

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
  const rec = runJson(["requirements-review-record", "--status", "pass", "--report", reviewPath, "--summary", "PASS"], root);
  assert.equal(rec.ok, true);
});

test("session ids match across runtime prefixes and legacy stored values", () => {
  const root = initGitRepo();
  const prd = writeApprovedPrd(root, "session-neutral");
  // A prefixed --session-id is stored bare.
  runJson(["init", "--prd", prd, "--review-profile", "trivial", "--session-id", "claude:sess-1"], root);
  const statePath = path.join(root, "agents", "implement", "session-neutral", "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(state.activeSessionId, "sess-1");
  runJson(["plan-execution"], root);

  // A bare hook payload id (Claude Code) matches the stored session.
  const bare = run(process.execPath, [harness, "hook", "stop"], {
    cwd: root,
    input: JSON.stringify({ hook_event_name: "Stop", cwd: root, session_id: "sess-1" }),
  });
  assert.match(JSON.parse(bare.stdout).reason, /prd-implement-continuation/);

  // A legacy codex-prefixed payload id for the same session also matches.
  const prefixed = run(process.execPath, [harness, "hook", "stop"], {
    cwd: root,
    input: JSON.stringify({ hook_event_name: "Stop", cwd: root, session_id: "codex:sess-1" }),
  });
  assert.match(JSON.parse(prefixed.stdout).reason, /prd-implement-continuation/);

  // Legacy state files that stored a prefixed id keep matching bare payloads.
  const legacy = JSON.parse(fs.readFileSync(statePath, "utf8"));
  legacy.activeSessionId = "codex:sess-1";
  fs.writeFileSync(statePath, JSON.stringify(legacy, null, 2));
  const legacyMatch = run(process.execPath, [harness, "hook", "stop"], {
    cwd: root,
    input: JSON.stringify({ hook_event_name: "Stop", cwd: root, session_id: "sess-1" }),
  });
  assert.match(JSON.parse(legacyMatch.stdout).reason, /prd-implement-continuation/);

  // A different session still gets nothing.
  const foreign = run(process.execPath, [harness, "hook", "stop"], {
    cwd: root,
    input: JSON.stringify({ hook_event_name: "Stop", cwd: root, session_id: "sess-2" }),
  });
  assert.equal(foreign.stdout.trim(), "");
});

test("CLAUDE_SESSION_ID env binds the session at init", () => {
  const root = initGitRepo();
  const prd = writeApprovedPrd(root, "claude-env");
  const env = { ...process.env };
  delete env.CODEX_SESSION_ID;
  delete env.CODEX_THREAD_ID;
  env.CLAUDE_SESSION_ID = "claude-env-session";
  run(process.execPath, [harness, "init", "--prd", prd, "--review-profile", "trivial"], { cwd: root, env });
  const state = JSON.parse(fs.readFileSync(path.join(root, "agents", "implement", "claude-env", "state.json"), "utf8"));
  assert.equal(state.activeSessionId, "claude-env-session");
});

test("hook directives emit the invoked harness path, not a hardcoded install root", () => {
  const root = initGitRepo();
  const prd = writeApprovedPrd(root, "self-path");
  runJson(["init", "--prd", prd, "--review-profile", "trivial", "--session-id", "sp-session"], root);
  const stop = run(process.execPath, [harness, "hook", "stop"], {
    cwd: root,
    input: JSON.stringify({ hook_event_name: "Stop", cwd: root, session_id: "sp-session" }),
  });
  const reason = JSON.parse(stop.stdout).reason;
  const home = os.homedir();
  const expected = harness.startsWith(home + path.sep) ? `~${harness.slice(home.length)}` : harness;
  assert.ok(reason.includes(`node ${expected} plan-execution`), reason);
  assert.doesNotMatch(reason, /~\/\.codex\/skills\/prd-implement/);
});

test("doctor reports hook registration per runtime from HOME", () => {
  const root = initGitRepo();
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "harness-home-"));
  write(path.join(fakeHome, ".claude", "settings.json"), JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: "command", command: `"node" "${harness}" hook stop`, timeout: 10 }] }] },
  }, null, 2));
  const result = run(process.execPath, [harness, "doctor"], {
    cwd: root,
    env: { ...process.env, HOME: fakeHome },
    allowFailure: true,
  });
  const doctor = JSON.parse(result.stdout);
  const hookChecks = doctor.checks.filter(item => item.id === "hooks");
  assert.equal(hookChecks.length, 2);
  assert(hookChecks.some(item => item.level === "ok" && item.message.includes("for claude")), JSON.stringify(hookChecks));
  assert(hookChecks.some(item => item.level === "warn" && item.message.includes("for codex")), JSON.stringify(hookChecks));
});

test("not-watched PR delivery ship log keeps hook delivery guard active", () => {
  const projectRoot = initGitRepo();
  const prdPath = writeApprovedPrd(projectRoot, "pr-not-watched");
  runJson(["init", "--prd", prdPath, "--review-profile", "trivial", "--delivery", "pr", "--skip-worktree", "--session-id", "ship-session"], projectRoot);
  runJson(["plan-execution"], projectRoot);
  let state = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", "pr-not-watched", "state.json"), "utf8"));
  const nodeIds = state.executionPlan.nodes.map(node => node.id).join(",");
  runJson(["mark-node", "--id", nodeIds, "--status", "complete", "--evidence", "Test nodes completed."], projectRoot);
  runJson(["mark", "--kind", "ac", "--id", "AC1", "--status", "met", "--evidence", "V1 proves AC1."], projectRoot);
  runJson(["verify-run", "--id", "V1", "--", "bash", "-lc", "node -e 'process.exit(0)'"], projectRoot);

  state = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", "pr-not-watched", "state.json"), "utf8"));
  const logPath = state.verification[0].artifacts[0].path;
  const reviewPath = path.join(projectRoot, "agents", "implement", "pr-not-watched", "review", "requirements-fidelity-review.md");
  write(reviewPath, `# Requirements Fidelity Review

Status: PASS

## Intent Sources Read

- agents/prd/pr-not-watched/prd.md

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
  write(path.join(projectRoot, "agents", "implement", "pr-not-watched", "delivery", "ship-log.jsonl"), JSON.stringify({
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

test("legacy .hoyeon run keeps working through status, verify-run, and pointer updates", () => {
  const root = initGitRepo();
  writeApprovedPrd(root, "legacy-run");
  runJson(["init", "--prd", "agents/prd/legacy-run/prd.md", "--session-id", "legacy-session"], root);

  // Simulate a run that started before the agents/ namespace migration: the
  // whole tree, including the active pointer, lives under .hoyeon and every
  // recorded relative path uses the legacy prefix.
  fs.renameSync(path.join(root, "agents"), path.join(root, ".hoyeon"));
  const legacyStatePath = path.join(root, ".hoyeon", "implement", "legacy-run", "state.json");
  const legacyPointerPath = path.join(root, ".hoyeon", "implement", ".prd-implement-active.json");
  for (const file of [legacyStatePath, legacyPointerPath]) {
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").split("agents/").join(".hoyeon/"));
  }

  const status = runJson(["status"], root);
  assert.equal(status.ok, true);
  assert.equal(status.runDir, ".hoyeon/implement/legacy-run");

  const verify = runJson(["verify-run", "--id", "V1", "--", "node", "-e", "process.exit(0)"], root);
  assert.equal(verify.ok, true);

  const state = JSON.parse(fs.readFileSync(legacyStatePath, "utf8"));
  assert.equal(state.verification[0].status, "pass");
  assert.equal(fs.existsSync(path.join(root, "agents")), false,
    "legacy run updates must not spill into the new namespace");
  const pointer = JSON.parse(fs.readFileSync(legacyPointerPath, "utf8"));
  assert.equal(pointer.statePath, ".hoyeon/implement/legacy-run/state.json");

  const reinit = run(process.execPath, [harness, "init", "--prd", ".hoyeon/prd/legacy-run/prd.md", "--session-id", "other-session"], {
    cwd: root,
    allowFailure: true,
  });
  assert.notEqual(reinit.status, 0);
  assert.match(String(reinit.stderr || reinit.stdout), /legacy-namespace run for this PRD already exists/);
});

test("legacy .hoyeon config.json is honored when no agents/config.json exists", () => {
  const root = initGitRepo();
  write(path.join(root, ".hoyeon", "config.json"), JSON.stringify({
    review: { profile: "trivial" },
  }, null, 2));
  writeApprovedPrd(root, "legacy-config");
  runJson(["init", "--prd", "agents/prd/legacy-config/prd.md", "--session-id", "legacy-config-session"], root);
  const state = JSON.parse(fs.readFileSync(path.join(root, "agents", "implement", "legacy-config", "state.json"), "utf8"));
  assert.equal(state.reviewProfile.profile, "trivial");
  assert.equal(state.reviewProfile.source, "config");
});
