import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const harness = path.join(repoRoot, "skills", "implement", "scripts", "prd_state_harness.js");
const requireModule = createRequire(import.meta.url);
const { classifyReviewProfile } = requireModule(path.join(repoRoot, "cli", "lib", "config.js"));
const { parseGitStatusZ } = requireModule(path.join(repoRoot, "cli", "lib", "git.js"));
const { normalizeWriteScopes, findDependencyCycle, writeScopesOverlap } = requireModule(path.join(repoRoot, "cli", "lib", "planning.js"));

test("parseGitStatusZ preserves rename source records", () => {
  assert.deepEqual(
    parseGitStatusZ("R  new-name.txt\0old-name.txt\0 M normal.txt\0"),
    [
      { status: "R ", path: "new-name.txt", originalPath: "old-name.txt" },
      { status: " M", path: "normal.txt", originalPath: null },
    ],
  );
});

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
  run("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
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

test("review profile uses agent-declared semantics with a standard fallback", () => {
  const declared = classifyReviewProfile({
    reviewProfile: "high-risk",
    reviewRationale: "This change migrates production data and needs the stronger review path.",
  });
  assert.equal(declared.profile, "high-risk");
  assert.equal(declared.source, "prd");
  assert.deepEqual(declared.signals, [
    "PRD semantic assessment: This change migrates production data and needs the stronger review path.",
  ]);

  const fallback = classifyReviewProfile({
    tasks: [{ id: "T1", text: "Delete production records and rotate credentials." }],
  });
  assert.equal(fallback.profile, "standard");
  assert.equal(fallback.source, "default");
  assert.deepEqual(fallback.signals, []);
  assert.match(fallback.reason, /no semantic review profile was declared/);

  const configured = classifyReviewProfile(
    {
      reviewProfile: "trivial",
      reviewRationale: "Documentation-only change with no behavior impact.",
    },
    null,
    "high-risk",
  );
  assert.equal(configured.profile, "high-risk");
  assert.equal(configured.source, "config");

  const cannotLowerConfig = classifyReviewProfile({}, "trivial", "high-risk");
  assert.equal(cannotLowerConfig.profile, "high-risk");
  assert.equal(cannotLowerConfig.source, "config");

  const cannotLowerPrd = classifyReviewProfile({
    reviewProfile: "high-risk",
    reviewRationale: "The approved work changes a production authorization boundary.",
  }, "trivial", "standard");
  assert.equal(cannotLowerPrd.profile, "high-risk");
  assert.equal(cannotLowerPrd.source, "prd");

  const explicitRaise = classifyReviewProfile({}, "high-risk", "trivial");
  assert.equal(explicitRaise.profile, "high-risk");
  assert.equal(explicitRaise.source, "explicit");

  assert.throws(
    () => classifyReviewProfile({ reviewProfile: "high-risk" }),
    /review_rationale/,
  );
  assert.throws(
    () => classifyReviewProfile({
      reviewProfile: "urgent",
      reviewRationale: "The author requested an unsupported profile.",
    }),
    /review_profile must be trivial, standard, or high-risk/,
  );
});

test("PR delivery init rejects receipt gates that require PR, CI, or merge outcomes", () => {
  const root = initGitRepo();
  const prdPath = writeApprovedPrd(root, "circular-delivery");
  const circular = fs.readFileSync(prdPath, "utf8")
    .replace("- AC1. V1 passes with a command-log artifact.", "- AC1. V1 passes and the CI checks pass.");
  fs.writeFileSync(prdPath, circular);

  const result = run(process.execPath, [harness, "init", "--prd", prdPath, "--delivery", "pr"], {
    cwd: root,
    allowFailure: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /circular PR-delivery completion contract/);
  assert.match(result.stderr, /AC1 .*CI or required-check verdict/);
  assert.equal(fs.existsSync(path.join(root, "agents", "implement", "circular-delivery", "state.json")), false);
});

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

test("worktree init uses the configured base branch and warns about dirty source changes", () => {
  const projectRoot = initGitRepo();
  const mainSha = run("git", ["rev-parse", "main"], { cwd: projectRoot }).stdout.trim();
  run("git", ["switch", "-c", "source-feature"], { cwd: projectRoot });
  write(path.join(projectRoot, "feature-only.txt"), "feature branch content\n");
  run("git", ["add", "feature-only.txt"], { cwd: projectRoot });
  run("git", ["commit", "-m", "Feature-only commit"], { cwd: projectRoot });

  const worktreeRoot = path.join(projectRoot, "..", `${path.basename(projectRoot)}.base-worktrees`);
  write(path.join(projectRoot, "agents", "config.json"), JSON.stringify({
    delivery: { mode: "pr", branchPrefix: "prd/", baseBranch: "main" },
    worktree: { enabled: true, root: worktreeRoot },
  }, null, 2));
  const prdPath = writeApprovedPrd(projectRoot, "base-branch-test");
  write(path.join(projectRoot, "README.md"), "# Dirty source checkout\n");

  const result = runJson([
    "init",
    "--prd",
    prdPath,
    "--delivery",
    "pr",
    "--review-profile",
    "standard",
  ], projectRoot);
  const targetRoot = result.worktreePrepared.path;
  assert.equal(result.worktreePrepared.baseRef, "main");
  assert.equal(result.worktreePrepared.baseSha, mainSha);
  assert(result.warnings.some(message => /uncommitted changes/.test(message)));
  assert.equal(run("git", ["rev-parse", "HEAD"], { cwd: targetRoot }).stdout.trim(), mainSha);
  assert.equal(fs.existsSync(path.join(targetRoot, "feature-only.txt")), false);
  assert.equal(fs.readFileSync(path.join(targetRoot, "README.md"), "utf8"), "# Test Repo\n");

  run("git", ["worktree", "remove", "--force", targetRoot], { cwd: projectRoot });
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

test("batch task mark with a bad id does not persist partial mutation", () => {
  const projectRoot = initGitRepo();
  const prdPath = writeApprovedPrd(projectRoot, "batch-bad-id");
  runJson(["init", "--prd", prdPath, "--review-profile", "trivial"], projectRoot);
  runJson(["plan-execution"], projectRoot);
  const statePath = path.join(projectRoot, "agents", "implement", "batch-bad-id", "state.json");
  const before = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(before.tasks[0].status, "pending");
  const result = run(process.execPath, [harness, "mark", "--kind", "task", "--id", `${before.tasks[0].id},T999`, "--status", "complete", "--evidence", "should not persist"], {
    cwd: projectRoot,
    allowFailure: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /task T999 not found/);
  const after = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(after.tasks[0].status, "pending");
  assert.deepEqual(after.tasks[0].evidence, []);
});

test("trivial review profile can finalize with requirements fidelity review only", () => {
  const projectRoot = initGitRepo();
  const prdPath = writeApprovedPrd(projectRoot, "trivial-finalize");
  runJson(["init", "--prd", prdPath, "--review-profile", "trivial", "--session-id", "trivial-session"], projectRoot);
  runJson(["plan-execution"], projectRoot);
  let state = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", "trivial-finalize", "state.json"), "utf8"));
  const taskIds = state.tasks.map(task => task.id).join(",");
  runJson(["mark", "--kind", "task", "--id", taskIds, "--status", "complete", "--evidence", "Test nodes completed."], projectRoot);
  runJson(["mark", "--kind", "ac", "--id", "AC1", "--status", "met", "--evidence", "V1 proves AC1."], projectRoot);
  runJson(["verify-run", "--id", "V1", "--deviation", "equivalent command preserves coverage", "--", "node", "-e", "void 0; process.exit(0)"], projectRoot);

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
  assert.equal(status.reviewPolicy.finalReviewRequired, false);
  assert.equal(status.next, null);
  const reviewedState = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", "trivial-finalize", "state.json"), "utf8"));
  assert.equal(reviewedState.finalReview, null);
  assert.equal(reviewedState.taskGraph, undefined);
  const reviewedChecklist = fs.readFileSync(path.join(projectRoot, "agents", "implement", "trivial-finalize", "checklist.md"), "utf8");
  assert.doesNotMatch(reviewedChecklist, /## Final Adversarial Review/);
  const stopHook = run(process.execPath, [harness, "hook", "stop"], {
    cwd: projectRoot,
    input: JSON.stringify({ hook_event_name: "Stop", cwd: projectRoot, session_id: "trivial-session" }),
  });
  const stopDirective = JSON.parse(stopHook.stdout);
  assert.match(stopDirective.reason, /effective review-policy gates passed; write receipt/);
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
  assert.match(preToolDirective.reason, /effective review policy/);
  const finalized = runJson(["finalize", "--status", "complete", "--summary", "Trivial run completed."], projectRoot);
  assert.equal(finalized.ok, true);
  // The receipt nudges remember with the run's recorded deviations.
  assert.ok(Array.isArray(finalized.rememberSuggestions));
  assert.ok(finalized.rememberSuggestions.some(item => /deviation/.test(item)),
    `expected a deviation-based remember suggestion, got: ${JSON.stringify(finalized.rememberSuggestions)}`);
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
  const taskIds = state.tasks.map(task => task.id).join(",");
  runJson(["mark", "--kind", "task", "--id", taskIds, "--status", "complete", "--evidence", "done"], projectRoot);
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

test("a fresh fidelity review can replace stale fidelity and final reviews after remediation", () => {
  const projectRoot = initGitRepo();
  const slug = "fidelity-remediation";
  const { logPath, reviewPath } = driveToFidelity(projectRoot, slug, "fidelity-remediation-session");
  write(reviewPath, fidelityReviewBody(logPath));
  runJson(["requirements-review-record", "--status", "pass", "--report", reviewPath, "--summary", "Initial PASS"], projectRoot);

  const finalPath = path.join(projectRoot, "agents", "implement", slug, "review", "final-review.md");
  write(finalPath, `# Final Adversarial Review

Status: FAIL

## Fidelity Review Checked

- The initial fidelity review was checked and remediation is required.

## Findings

- high: a tracked source file must be remediated.

## Checklist Coverage

- Tasks: the recorded task coverage was inspected.

## Artifact Audit

- Harness-visible validity: the command log was inspected.

## Deviation Audit

- Recorded deviations: none.

## Verdict

FAIL.
`);
  runJson(["review-record", "--status", "fail", "--report", finalPath, "--summary", "FAIL - remediation required"], projectRoot);

  write(path.join(projectRoot, "README.md"), "# Remediated source\n");
  write(reviewPath, fidelityReviewBody(logPath, "\n- The tracked source remediation now matches the approved intent."));
  const recorded = runJson(["requirements-review-record", "--status", "pass", "--report", reviewPath, "--summary", "Remediated PASS"], projectRoot);

  assert.equal(recorded.ok, true);
  assert.equal(recorded.finalReview, null);
  assert.equal(recorded.requirementsFidelityReview.status, "pass");
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
  const firstTask = state.tasks[0].id;

  const markOut = runJson(["mark", "--kind", "task", "--id", firstTask, "--status", "complete", "--evidence", "done"], projectRoot);
  assert.equal(markOut.ok, true);
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
  write(prdB, fs.readFileSync(prdB, "utf8").replace(
    "- T1. Run the local command verification. Covers R1, AC1.",
    "- T1. Implement the first independent slice. Covers R1, AC1.\n- T2. Implement the second independent slice. Covers R1, AC1.",
  ));
  const taskPlanPath = path.join(rootB, "task-plan.json");
  write(taskPlanPath, JSON.stringify({ tasks: {
    T1: { writeScope: ["src/first"], risk: "low", dependsOn: [], parallelSafe: true },
    T2: { writeScope: ["src/second"], risk: "medium", dependsOn: [], parallelSafe: true },
  } }, null, 2));
  runJson(["init", "--prd", prdB, "--review-profile", "trivial", "--session-id", "par-s"], rootB);
  runJson(["plan-execution", "--task-plan", taskPlanPath], rootB);
  const readyB = runJson(["ready"], rootB);
  assert.equal(readyB.ready.parallelEnabled, true);
  assert.deepEqual(readyB.ready.readyParallelGroups, [["T1", "T2"]]);
  const stopB = run(process.execPath, [harness, "hook", "stop"], {
    cwd: rootB,
    input: JSON.stringify({ hook_event_name: "Stop", cwd: rootB, session_id: "par-s" }),
  });
  assert.match(JSON.parse(stopB.stdout).reason, /- Ready parallel groups:/);

  write(taskPlanPath, JSON.stringify({ tasks: {
    T1: { writeScope: ["src/first"], risk: "low", dependsOn: [], parallelSafe: true },
  } }, null, 2));
  runJson(["plan-execution", "--task-plan", taskPlanPath], rootB);
  const partialState = JSON.parse(fs.readFileSync(path.join(rootB, "agents", "implement", "par-on", "state.json"), "utf8"));
  const omitted = partialState.tasks.find(task => task.id === "T2");
  assert.deepEqual(omitted.writeScope, []);
  assert.equal(omitted.risk, "medium");
  assert.equal(omitted.parallelSafe, false);

  write(taskPlanPath, JSON.stringify({ tasks: {
    T1: { writeScope: ["src/first"], risk: "low", dependsOn: "T2", parallelSafe: true },
    T2: { writeScope: ["src/second"], risk: "low", dependsOn: [], parallelSafe: true },
  } }, null, 2));
  const malformed = run(process.execPath, [harness, "plan-execution", "--task-plan", taskPlanPath], {
    cwd: rootB,
    allowFailure: true,
  });
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /T1\.dependsOn must be an array/);
});

test("task-plan paths are canonicalized before parallel overlap checks", () => {
  const root = initGitRepo();
  assert.deepEqual(normalizeWriteScopes(["./src/a", "src/../src/a"], root), ["src/a"]);
  assert.equal(writeScopesOverlap(["./src/a"], ["src/a/file.js"]), true);
  assert.equal(writeScopesOverlap(["src/a"], ["src/b"]), false);
  assert.throws(() => normalizeWriteScopes(["../outside"], root), /escapes the project root/);
  assert.throws(() => normalizeWriteScopes([path.join(root, "src/a")], root), /must be repository-relative/);
  assert.throws(() => normalizeWriteScopes(["src/**"], root), /not a glob/);
  assert.deepEqual(findDependencyCycle([
    { id: "T1", dependsOn: ["T2"] },
    { id: "T2", dependsOn: ["T1"] },
  ]), ["T1", "T2", "T1"]);
});

test("review profile sources act as safety floors and cannot lower stronger risk", () => {
  // A fixed config profile raises the semantic profile declared by the PRD.
  const root = initGitRepo();
  write(path.join(root, "agents", "config.json"), JSON.stringify({ review: { profile: "high-risk" } }, null, 2));
  const prd = writeApprovedPrd(root, "review-config");
  runJson(["init", "--prd", prd, "--session-id", "rc"], root);
  const status = runJson(["status"], root);
  assert.equal(status.reviewProfile.profile, "high-risk");
  assert.equal(status.reviewProfile.source, "config");

  // A per-run profile cannot lower the configured safety floor.
  const root2 = initGitRepo();
  write(path.join(root2, "agents", "config.json"), JSON.stringify({ review: { profile: "high-risk" } }, null, 2));
  const prd2 = writeApprovedPrd(root2, "review-cli");
  runJson(["init", "--prd", prd2, "--review-profile", "trivial", "--session-id", "rc2"], root2);
  const status2 = runJson(["status"], root2);
  assert.equal(status2.reviewProfile.profile, "high-risk");
  assert.equal(status2.reviewProfile.source, "config");
});

test("policy v2 high-risk graph retains the independent final review gate", () => {
  const root = initGitRepo();
  const prd = writeApprovedPrd(root, "high-risk-graph");
  write(prd, fs.readFileSync(prd, "utf8").replace(
    'updated_at: "2026-07-06"',
    'updated_at: "2026-07-06"\nreview_profile: "high-risk"\nreview_rationale: "The approved change includes a production data migration."',
  ));
  runJson(["init", "--prd", prd, "--session-id", "high-risk-session"], root);
  runJson(["plan-execution"], root);
  const status = runJson(["status"], root);
  assert.equal(status.reviewProfile.profile, "high-risk");
  assert.equal(status.reviewProfile.source, "prd");
  assert(status.reviewProfile.signals.some(signal => /production data migration/.test(signal)));
  assert.equal(status.reviewPolicy.finalReviewRequired, true);
  const state = JSON.parse(fs.readFileSync(path.join(root, "agents", "implement", "high-risk-graph", "state.json"), "utf8"));
  assert.equal(state.taskGraph, undefined);
  const highRiskChecklist = fs.readFileSync(path.join(root, "agents", "implement", "high-risk-graph", "checklist.md"), "utf8");
  assert.match(highRiskChecklist, /## Final Adversarial Review/);
});

test("policy v2 standard fidelity prompt owns conditional UI and UX judgment", () => {
  const root = initGitRepo();
  const prd = writeApprovedPrd(root, "standard-ux-prompt");
  let text = fs.readFileSync(prd, "utf8");
  text = text.replace("| build/static | yes | local command proof | none |", "| browser | yes | primary UI and UX flow, loading and error states | none |");
  text = text.replace("| V1 | build/static |", "| V1 | browser |");
  write(prd, text);
  runJson(["init", "--prd", prd, "--review-profile", "standard", "--session-id", "ux-session"], root);
  const prompt = run(process.execPath, [harness, "requirements-review-prompt"], { cwd: root }).stdout;
  for (const anchor of [
    "single fresh independent read-only semantic reviewer",
    "UI and UX evidence is applicable",
    "loading, empty, and error states",
    "responsive behavior and accessibility",
    "copy and visual hierarchy",
    "remaining human taste judgment",
  ]) {
    assert.match(prompt, new RegExp(anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
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

test("delivery freshness accepts the exact reviewed worktree materialized as a commit", () => {
  const root = initGitRepo();
  const slug = "reviewed-commit";
  const { logPath, reviewPath } = driveToFidelity(root, slug, "reviewed-commit-session");
  write(reviewPath, fidelityReviewBody(logPath));
  runJson(["requirements-review-record", "--status", "pass", "--report", reviewPath, "--summary", "PASS"], root);
  runJson(["finalize", "--status", "complete", "--summary", "done"], root);
  run("git", ["add", "-A"], { cwd: root });
  run("git", ["commit", "-m", "Materialize reviewed result"], { cwd: root });

  const statePath = path.join(root, "agents", "implement", slug, "state.json");
  const fresh = runJson(["verify-delivery", "--state", statePath], root);
  assert.equal(fresh.ok, true, JSON.stringify(fresh.violations));

  write(path.join(root, "README.md"), "# Changed after review\n");
  run("git", ["add", "README.md"], { cwd: root });
  run("git", ["commit", "-m", "Unreviewed source change"], { cwd: root });
  const stale = runJson(["verify-delivery", "--state", statePath], root, { allowFailure: true });
  assert.equal(stale.ok, false);
  assert(stale.violations.some(item => /stale/i.test(item)), JSON.stringify(stale.violations));
});

test("delivery freshness permits only unchanged initial dirty entries after reviewed work is committed", () => {
  const root = initGitRepo();
  write(path.join(root, "notes.txt"), "baseline\n");
  run("git", ["add", "notes.txt"], { cwd: root });
  run("git", ["commit", "-m", "Add notes"], { cwd: root });
  write(path.join(root, "notes.txt"), "pre-existing user edit\n");

  const slug = "reviewed-commit-dirty-baseline";
  const { logPath, reviewPath } = driveToFidelity(root, slug, "reviewed-commit-dirty-session");
  write(path.join(root, "src", "app.js"), "export const ready = true;\n");
  write(reviewPath, fidelityReviewBody(logPath));
  runJson(["requirements-review-record", "--status", "pass", "--report", reviewPath, "--summary", "PASS"], root);
  runJson(["finalize", "--status", "complete", "--summary", "done"], root);
  run("git", ["add", "src/app.js"], { cwd: root });
  run("git", ["commit", "-m", "Materialize reviewed source only"], { cwd: root });

  const statePath = path.join(root, "agents", "implement", slug, "state.json");
  const fresh = runJson(["verify-delivery", "--state", statePath], root);
  assert.equal(fresh.ok, true, JSON.stringify(fresh.violations));

  if (process.platform !== "win32") {
    fs.chmodSync(path.join(root, "notes.txt"), 0o755);
    const staleMode = runJson(["verify-delivery", "--state", statePath], root, { allowFailure: true });
    assert.equal(staleMode.ok, false);
    assert(staleMode.violations.some(item => /stale/i.test(item)), JSON.stringify(staleMode.violations));
    fs.chmodSync(path.join(root, "notes.txt"), 0o644);
    const freshAgain = runJson(["verify-delivery", "--state", statePath], root);
    assert.equal(freshAgain.ok, true, JSON.stringify(freshAgain.violations));
  }

  write(path.join(root, "notes.txt"), "changed again after review\n");
  const stale = runJson(["verify-delivery", "--state", statePath], root, { allowFailure: true });
  assert.equal(stale.ok, false);
  assert(stale.violations.some(item => /stale/i.test(item)), JSON.stringify(stale.violations));
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
  const taskIds = state.tasks.map(task => task.id).join(",");
  runJson(["mark", "--kind", "task", "--id", taskIds, "--status", "complete", "--evidence", "Test nodes completed."], projectRoot);
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

function writeInvariantDraft(projectRoot, { id, trigger, checkRun }) {
  const draft = path.join(projectRoot, `${id}-draft.md`);
  write(draft, [
    "---",
    `id: ${id}`,
    "kind: invariant",
    "status: active",
    "evidence:",
    "  - agents/implement/previous-run/state.json#D1",
    "trigger:",
    "  paths:",
    `    - "${trigger}"`,
    "check:",
    "  type: command",
    `  run: ${checkRun}`,
    "---",
    "",
    `Changes under ${trigger} must satisfy ${id}.`,
  ].join("\n"));
  runJson(["rules", "add", "--file", path.basename(draft)], projectRoot);
}

function writeGrepInvariantDraft(projectRoot, { id, trigger, pattern, files, expect = "present" }) {
  const draft = path.join(projectRoot, `${id}-draft.md`);
  write(draft, [
    "---",
    `id: ${id}`,
    "kind: invariant",
    "status: active",
    "evidence:",
    "  - agents/implement/previous-run/state.json#D1",
    "trigger:",
    "  paths:",
    `    - "${trigger}"`,
    "check:",
    "  type: grep",
    `  pattern: ${pattern}`,
    `  files: ${files}`,
    `  expect: ${expect}`,
    "---",
    "",
    `Files under ${trigger} must satisfy the ${id} grep rule.`,
  ].join("\n"));
  runJson(["rules", "add", "--file", path.basename(draft)], projectRoot);
}

test("plan-execution injects matching learned invariants as verification items", () => {
  const projectRoot = initGitRepo();
  writeInvariantDraft(projectRoot, {
    id: "INV-src-guard",
    trigger: "src/**",
    checkRun: "node -e 'process.exit(0)'",
  });
  const prdPath = writeApprovedPrd(projectRoot, "rules-injection");
  const taskPlanPath = path.join(projectRoot, "task-plan.json");
  write(taskPlanPath, JSON.stringify({ tasks: {
    T1: { writeScope: ["src"], risk: "low", dependsOn: [], parallelSafe: false },
  } }, null, 2));
  runJson(["init", "--prd", prdPath, "--review-profile", "trivial", "--session-id", "injection-session"], projectRoot);
  const planned = runJson(["plan-execution", "--task-plan", taskPlanPath], projectRoot);
  assert.equal(planned.injectedRules.length, 1);
  assert.equal(planned.injectedRules[0].rule, "INV-src-guard");

  const state = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", "rules-injection", "state.json"), "utf8"));
  const injected = state.verification.find(item => item.sourceRuleId === "INV-src-guard");
  assert.ok(injected, "injected verification item exists");
  assert.equal(injected.source, "rules_injection");
  assert.match(injected.text, /full targeted check required, changed files rechecked at deliver/);
  assert.equal(injected.matrix.requiredForDone, true);
  const injectedCheck = state.verificationPlan.checks.find(item => item.verificationId === injected.id);
  assert.equal(injectedCheck.command, "node -e 'process.exit(0)'");
  assert.deepEqual(injectedCheck.covers.tasks, ["T1"]);
  assert.equal(injectedCheck.status, "planned");
  assert.equal(state.verificationPlan.status, "ready");
  assert(state.verification.some(item => item.id === injected.id && item.matrix.covers.includes("T1")));

  // Re-planning must not duplicate the injected item.
  runJson(["plan-execution"], projectRoot);
  let replanned = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", "rules-injection", "state.json"), "utf8"));
  assert.equal(replanned.verification.filter(item => item.sourceRuleId === "INV-src-guard").length, 1);

  const taskIds = replanned.tasks.map(task => task.id).join(",");
  runJson(["mark", "--kind", "task", "--id", taskIds, "--status", "complete", "--evidence", "Implementation node completed."], projectRoot);
  runJson(["mark", "--kind", "ac", "--id", "AC1", "--status", "met", "--evidence", "V1 proves AC1."], projectRoot);
  runJson(["verify-run", "--id", "V1", "--", "node", "-e", "process.exit(0)"], projectRoot);
  runJson(["verify-run", "--id", injected.id, "--", "node", "-e", "process.exit(0)"], projectRoot);
  replanned = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", "rules-injection", "state.json"), "utf8"));
  const v1Log = replanned.verification.find(item => item.id === "V1").artifacts[0].path;
  const ruleLog = replanned.verification.find(item => item.id === injected.id).artifacts[0].path;
  const reviewPath = path.join(projectRoot, "agents", "implement", "rules-injection", "review", "requirements-fidelity-review.md");
  const reviewBody = fidelityReviewBody(v1Log).replace(
    "- V1: Pass Intent: command exits zero; Covers: R1, AC1; Artifacts checked: " + v1Log + "; Judgment: PASS; Gap: none",
    "- V1: Pass Intent: command exits zero; Covers: R1, AC1; Artifacts checked: " + v1Log + "; Judgment: PASS; Gap: none\n" +
      "- " + injected.id + ": Pass Intent: learned invariant exits zero; Covers: T1; Artifacts checked: " + ruleLog + "; Judgment: PASS; Gap: none",
  );
  write(reviewPath, reviewBody);
  runJson(["requirements-review-record", "--status", "pass", "--report", reviewPath, "--summary", "PASS"], projectRoot);
  const finalized = runJson(["finalize", "--status", "complete", "--summary", "Injected invariant run completed."], projectRoot);
  assert.equal(finalized.ok, true);
});

test("plan-execution gives grep invariants an executable targeted verification command", () => {
  const projectRoot = initGitRepo();
  write(path.join(projectRoot, "src", "app.js"), "export const allowed = true;\n");
  writeGrepInvariantDraft(projectRoot, {
    id: "INV-grep-guard",
    trigger: "src/**",
    pattern: "FORBIDDEN",
    files: "src/**",
    expect: "absent",
  });
  const prdPath = writeApprovedPrd(projectRoot, "grep-rules-injection");
  const taskPlanPath = path.join(projectRoot, "task-plan.json");
  write(taskPlanPath, JSON.stringify({ tasks: {
    T1: { writeScope: ["src"], risk: "low", dependsOn: [], parallelSafe: false },
  } }, null, 2));
  runJson(["init", "--prd", prdPath, "--review-profile", "trivial", "--session-id", "grep-injection-session"], projectRoot);
  runJson(["plan-execution", "--task-plan", taskPlanPath], projectRoot);

  let state = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", "grep-rules-injection", "state.json"), "utf8"));
  const injected = state.verification.find(item => item.sourceRuleId === "INV-grep-guard");
  const check = state.verificationPlan.checks.find(item => item.verificationId === injected.id);
  assert.equal(check.status, "planned");
  assert.doesNotMatch(check.command, /<changed files>/);
  assert.match(check.command, /rules check --id INV-grep-guard --all/);

  const taskIds = state.tasks.map(task => task.id).join(",");
  runJson(["mark", "--kind", "task", "--id", taskIds, "--status", "complete", "--evidence", "Implementation node completed."], projectRoot);
  runJson(["mark", "--kind", "ac", "--id", "AC1", "--status", "met", "--evidence", "V1 proves AC1."], projectRoot);
  runJson(["verify-run", "--id", "V1", "--", "node", "-e", "process.exit(0)"], projectRoot);
  runJson([
    "verify-run", "--id", injected.id, "--",
    process.execPath, harness, "rules", "check", "--id", "INV-grep-guard", "--all",
  ], projectRoot);
  state = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", "grep-rules-injection", "state.json"), "utf8"));
  const v1Log = state.verification.find(item => item.id === "V1").artifacts[0].path;
  const ruleLog = state.verification.find(item => item.id === injected.id).artifacts[0].path;
  const reviewPath = path.join(projectRoot, "agents", "implement", "grep-rules-injection", "review", "requirements-fidelity-review.md");
  write(reviewPath, fidelityReviewBody(v1Log).replace(
    "- V1: Pass Intent: command exits zero; Covers: R1, AC1; Artifacts checked: " + v1Log + "; Judgment: PASS; Gap: none",
    "- V1: Pass Intent: command exits zero; Covers: R1, AC1; Artifacts checked: " + v1Log + "; Judgment: PASS; Gap: none\n" +
      "- " + injected.id + ": Pass Intent: targeted grep invariant passes; Covers: T1; Artifacts checked: " + ruleLog + "; Judgment: PASS; Gap: none",
  ));
  runJson(["requirements-review-record", "--status", "pass", "--report", reviewPath, "--summary", "PASS"], projectRoot);
  const finalized = runJson(["finalize", "--status", "complete", "--summary", "Injected grep invariant run completed."], projectRoot);
  assert.equal(finalized.ok, true);
});

test("targeted grep invariant fails closed when a parent write scope arms it", () => {
  const projectRoot = initGitRepo();
  write(path.join(projectRoot, "src", "protected", "app.js"), "export const marker = 'FORBIDDEN';\n");
  writeGrepInvariantDraft(projectRoot, {
    id: "INV-parent-scope-guard",
    trigger: "src/protected/**",
    pattern: "FORBIDDEN",
    files: "src/protected/**",
    expect: "absent",
  });
  const prdPath = writeApprovedPrd(projectRoot, "parent-scope-grep-injection");
  const taskPlanPath = path.join(projectRoot, "task-plan.json");
  write(taskPlanPath, JSON.stringify({ tasks: {
    T1: { writeScope: ["src"], risk: "low", dependsOn: [], parallelSafe: false },
  } }, null, 2));
  runJson(["init", "--prd", prdPath, "--review-profile", "trivial", "--session-id", "parent-scope-session"], projectRoot);
  runJson(["plan-execution", "--task-plan", taskPlanPath], projectRoot);

  const state = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", "parent-scope-grep-injection", "state.json"), "utf8"));
  const injected = state.verification.find(item => item.sourceRuleId === "INV-parent-scope-guard");
  const check = state.verificationPlan.checks.find(item => item.verificationId === injected.id);
  assert.match(check.command, /rules check --id INV-parent-scope-guard --all/);

  const result = run(process.execPath, [
    harness, "rules", "check", "--id", "INV-parent-scope-guard", "--all",
  ], { cwd: projectRoot, allowFailure: true });
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].status, "fail");
  assert.deepEqual(report.results[0].matchedFiles, ["(all)"]);
});

test("deliver ship fails closed on a failing learned invariant and honors --skip-rules --reason", () => {
  const projectRoot = initGitRepo();
  const shipScript = path.join(repoRoot, "skills", "ship", "scripts", "prd_ship.js");
  const prdPath = writeApprovedPrd(projectRoot, "rules-gate");
  runJson(["init", "--prd", prdPath, "--review-profile", "trivial", "--delivery", "pr", "--session-id", "gate-session"], projectRoot);
  runJson(["plan-execution"], projectRoot);
  let state = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", "rules-gate", "state.json"), "utf8"));
  const taskIds = state.tasks.map(task => task.id).join(",");
  runJson(["mark", "--kind", "task", "--id", taskIds, "--status", "complete", "--evidence", "Test nodes completed."], projectRoot);
  runJson(["mark", "--kind", "ac", "--id", "AC1", "--status", "met", "--evidence", "V1 proves AC1."], projectRoot);
  runJson(["verify-run", "--id", "V1", "--", "bash", "-lc", "node -e 'process.exit(0)'"], projectRoot);
  state = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", "rules-gate", "state.json"), "utf8"));
  const logPath = state.verification[0].artifacts[0].path;
  const reviewPath = path.join(projectRoot, "agents", "implement", "rules-gate", "review", "requirements-fidelity-review.md");
  write(reviewPath, `# Requirements Fidelity Review

Status: PASS

## Intent Sources Read

- agents/prd/rules-gate/prd.md

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
  runJson(["finalize", "--status", "complete", "--summary", "Gate test run completed."], projectRoot);

  // Arm a failing invariant after the receipt: the guarded file is missing.
  writeInvariantDraft(projectRoot, {
    id: "INV-gate-guard",
    trigger: "src/**",
    checkRun: "test -f src/must-exist.txt",
  });
  write(path.join(projectRoot, "src", "app.js"), "// armed change");

  const blocked = run(process.execPath, [shipScript, "ship", "--no-watch", "--allow-stale", "--reason", "test: freshness is not under test here"], {
    cwd: projectRoot,
    allowFailure: true,
  });
  assert.notEqual(blocked.status, 0);
  assert.match(String(blocked.stderr), /Learned invariant checks failed/);
  assert.match(String(blocked.stderr), /INV-gate-guard/);

  // With the override the gate records instead of blocking; the next failure
  // (if any) must come from delivery mechanics, not the rules gate.
  const overridden = run(process.execPath, [shipScript, "ship", "--no-watch", "--allow-stale", "--reason", "test: freshness is not under test here", "--skip-rules", "--reason", "test: user-approved override"], {
    cwd: projectRoot,
    allowFailure: true,
  });
  assert.doesNotMatch(String(overridden.stderr), /Learned invariant checks failed/);
});

test("reconcile preserves marks across a PRD edit and resets only changed items", () => {
  const root = initGitRepo();
  const prdPath = writeApprovedPrd(root, "reconcile-flow");
  runJson(["init", "--prd", prdPath, "--review-profile", "trivial"], root);
  runJson(["plan-execution"], root);
  // Batch mark: close the task and its AC in one call.
  const marked = runJson(["mark", "--kind", "task", "--id", "T1", "--status", "complete", "--ac", "AC1", "--evidence", "test evidence for T1 and AC1"], root);
  assert.deepEqual(marked.marked.map(entry => `${entry.kind}:${entry.id}`), ["task:T1", "ac:AC1"]);

  const statePath = path.join(root, "agents", "implement", "reconcile-flow", "state.json");

  // Edit the PRD without touching contract items: reconcile keeps everything.
  fs.appendFileSync(prdPath, "\nAdditional non-contract prose added mid-run.\n");
  const beforeStatus = runJson(["status"], root);
  assert.ok(beforeStatus.completion.violations.some(item => /PRD file changed after implementation state was initialized/.test(item)));
  const first = runJson(["reconcile", "--reason", "prose-only edit"], root);
  assert.equal(first.changed, true);
  assert.deepEqual(first.changedItems, []);
  assert.equal(first.reviewsMarkedStale, false);
  let state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(state.acceptanceCriteria.find(item => item.id === "AC1").status, "met");
  assert.equal(state.tasks.find(task => task.id === "T1").status, "complete");
  const afterStatus = runJson(["status"], root);
  assert.ok(!afterStatus.completion.violations.some(item => /PRD file changed after implementation state was initialized/.test(item)));

  // Now change AC1's definition: only AC1 resets; the task survives.
  const edited = fs.readFileSync(prdPath, "utf8")
    .replace("- AC1. V1 passes with a command-log artifact.", "- AC1. V1 passes with a command-log artifact and prints a summary.");
  fs.writeFileSync(prdPath, edited);
  const second = runJson(["reconcile"], root);
  assert.deepEqual(second.changedItems, ["ac:AC1"]);
  assert.equal(second.reviewsMarkedStale, true);
  state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const ac1 = state.acceptanceCriteria.find(item => item.id === "AC1");
  assert.equal(ac1.status, "pending");
  assert.ok(ac1.evidence.some(entry => /PRD reconcile: definition changed/.test(entry.text)));
  assert.equal(state.tasks.find(task => task.id === "T1").status, "complete");
  assert.ok(state.deviations.some(entry => entry.type === "prd_reconciled"));

  // Reconcile with a matching snapshot is a no-op.
  const third = runJson(["reconcile"], root);
  assert.equal(third.changed, false);
});

test("pause mutes the stop hook until the next harness mutation resumes it", () => {
  const root = initGitRepo();
  const prd = writeApprovedPrd(root, "pause-flow");
  runJson(["init", "--prd", prd, "--review-profile", "trivial", "--session-id", "pause-s"], root);
  runJson(["plan-execution"], root);
  const stopInput = JSON.stringify({ hook_event_name: "Stop", cwd: root, session_id: "pause-s" });

  const active = run(process.execPath, [harness, "hook", "stop"], { cwd: root, input: stopInput });
  assert.match(JSON.parse(active.stdout).reason, /prd-implement-continuation/);
  assert.match(JSON.parse(active.stdout).reason, /pause --reason/);

  runJson(["pause", "--reason", "user asked an unrelated question"], root);
  const muted = run(process.execPath, [harness, "hook", "stop"], { cwd: root, input: stopInput });
  assert.equal(muted.stdout.trim(), "");

  // Any real mutation clears the pause.
  runJson(["mark", "--kind", "task", "--id", "T1", "--status", "in_progress", "--evidence", "resumed work"], root);
  const resumed = run(process.execPath, [harness, "hook", "stop"], { cwd: root, input: stopInput });
  assert.match(JSON.parse(resumed.stdout).reason, /prd-implement-continuation/);

  // Explicit clear also works.
  runJson(["pause", "--reason", "second redirect"], root);
  runJson(["pause", "--clear"], root);
  const cleared = run(process.execPath, [harness, "hook", "stop"], { cwd: root, input: stopInput });
  assert.match(JSON.parse(cleared.stdout).reason, /prd-implement-continuation/);
});

test("review-policy records a user-directed profile override as a deviation", () => {
  const root = initGitRepo();
  const prd = writeApprovedPrd(root, "review-override");
  runJson(["init", "--prd", prd, "--review-profile", "high-risk"], root);
  const result = runJson(["review-policy", "--profile", "standard", "--reason", "리뷰 한번만 돌리고 마무리해"], root);
  assert.equal(result.ok, true);
  assert.equal(result.effectivePolicy.profile, "standard");
  assert.equal(result.effectivePolicy.finalReviewRequired, false);
  assert.equal(result.reviewProfile.source, "user-override");
  assert.equal(result.reviewProfile.previous.profile, "high-risk");
  const state = JSON.parse(fs.readFileSync(path.join(root, "agents", "implement", "review-override", "state.json"), "utf8"));
  assert.ok(state.deviations.some(entry => entry.type === "review_profile_override" && /리뷰 한번만/.test(entry.summary)));

  const missingReason = run(process.execPath, [harness, "review-policy", "--profile", "trivial"], { cwd: root, allowFailure: true });
  assert.notEqual(missingReason.status, 0);
  assert.match(missingReason.stderr, /--reason is required/);
});

test("plan-verification warns when a check appears to touch a database", () => {
  const root = initGitRepo();
  const prdPath = writeApprovedPrd(root, "db-safety");
  const edited = fs.readFileSync(prdPath, "utf8")
    .replace('`node -e "process.exit(0)"`', '`psql "$DATABASE_URL" -c "select count(*) from applications"`');
  fs.writeFileSync(prdPath, edited);
  runJson(["init", "--prd", prdPath, "--review-profile", "trivial"], root);
  const state = JSON.parse(fs.readFileSync(path.join(root, "agents", "implement", "db-safety", "state.json"), "utf8"));
  const dbGaps = state.verificationPlan.gaps.filter(gap => gap.code === "db-safety");
  assert.equal(dbGaps.length, 1);
  assert.equal(dbGaps[0].severity, "warning");
  assert.match(dbGaps[0].message, /disposable local or branch database/);
  // The warning must not block implementation.
  assert.equal(state.verificationPlan.status, "ready");

  // A non-DB command produces no db-safety warning.
  const cleanRoot = initGitRepo();
  const cleanPrd = writeApprovedPrd(cleanRoot, "db-safety-clean");
  runJson(["init", "--prd", cleanPrd, "--review-profile", "trivial"], cleanRoot);
  const cleanState = JSON.parse(fs.readFileSync(path.join(cleanRoot, "agents", "implement", "db-safety-clean", "state.json"), "utf8"));
  assert.equal(cleanState.verificationPlan.gaps.filter(gap => gap.code === "db-safety").length, 0);
});

test("required command verification only closes through verify-run execution metadata", () => {
  const root = initGitRepo();
  const prd = writeApprovedPrd(root, "provenance");
  runJson(["init", "--prd", prd, "--review-profile", "trivial"], root);
  runJson(["plan-execution"], root);
  runJson(["mark", "--kind", "task", "--id", "T1", "--status", "complete", "--ac", "AC1", "--evidence", "implementation done"], root);

  // Hand-author a plausible log and register it without running anything.
  const fakeLog = path.join(root, "agents", "implement", "provenance", "artifacts", "logs", "fake.log");
  write(fakeLog, "command: node -e \"process.exit(0)\"\nexitCode: 0\n--- stdout ---\n");
  runJson(["record-artifact", "--id", "V1", "--kind", "command-log", "--path", fakeLog, "--description", "hand-authored log"], root);
  runJson(["mark", "--kind", "verification", "--id", "V1", "--status", "pass", "--evidence", "manually marked"], root);
  const before = runJson(["status"], root);
  assert.ok(
    before.completion.violations.some(item => /run it through verify-run so the command log carries execution metadata/.test(item)),
    `expected provenance violation, got: ${JSON.stringify(before.completion.violations)}`,
  );

  // The genuine run satisfies the same check.
  runJson(["verify-run", "--id", "V1", "--", "node", "-e", "process.exit(0)"], root);
  const after = runJson(["status"], root);
  assert.ok(!after.completion.violations.some(item => /verify-run so the command log carries execution metadata/.test(item)));
});

test("a BLOCKED or stale verify gate blocks completion; PASS and NOT_RUN do not", () => {
  const root = initGitRepo();
  const prd = writeApprovedPrd(root, "gate-wire");
  runJson(["init", "--prd", prd, "--review-profile", "trivial"], root);
  runJson(["plan-execution"], root);

  const gatesDir = path.join(root, "agents", "gates", "gate-wire");
  const gatesPath = path.join(gatesDir, "gates.json");
  const emptyGate = { verdict: null, attempts: 0, overridden: false, findings: [], lastRunAt: null, history: [] };
  const writeGates = verify => write(gatesPath, JSON.stringify({
    gates: { "gap-audit": { ...emptyGate }, spec: { ...emptyGate }, verify },
    deviations: [],
    judgeCalls: [],
  }, null, 2));

  // NOT_RUN (no gates file): no gate violation.
  const notRun = runJson(["status"], root);
  assert.ok(!notRun.completion.violations.some(item => /Verify gate/.test(item)));

  // Gate ran and failed: completion blocked.
  writeGates({ ...emptyGate, verdict: "FAIL", attempts: 1 });
  const blocked = runJson(["status"], root);
  assert.ok(blocked.completion.violations.some(item => /Verify gate is BLOCKED/.test(item)));

  // Fresh PASS pinned to the current PRD content: no gate violation.
  const store = requireModule(path.join(repoRoot, "cli", "dist", "gates", "store.js"));
  const inputs = [{ path: path.relative(root, prd), sha256: store.freshnessHash(fs.readFileSync(prd, "utf8")) }];
  writeGates({ ...emptyGate, verdict: "PASS", attempts: 1, inputs });
  const passed = runJson(["status"], root);
  assert.ok(!passed.completion.violations.some(item => /Verify gate/.test(item)));

  // PASS whose pinned input hash no longer matches: stale, blocked again.
  writeGates({ ...emptyGate, verdict: "PASS", attempts: 1, inputs: [{ path: path.relative(root, prd), sha256: "0".repeat(64) }] });
  const stale = runJson(["status"], root);
  assert.ok(stale.completion.violations.some(item => /Verify gate PASS is stale/.test(item)));
});
