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
const { writeImplementationReport } = requireModule(path.join(repoRoot, "cli", "lib", "render.js"));

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

test("verify-run dedupes identical verification_command deviations and reuses the recorded justification", () => {
  const projectRoot = initGitRepo();
  const prdPath = writeApprovedPrd(projectRoot, "deviation-dedupe");
  runJson(["init", "--prd", prdPath, "--review-profile", "trivial"], projectRoot);
  const statePath = path.join(projectRoot, "agents", "implement", "deviation-dedupe", "state.json");
  const readDeviations = () => JSON.parse(fs.readFileSync(statePath, "utf8"))
    .deviations.filter(item => item.type === "verification_command");
  const actual = ["node", "-e", "void 0; process.exit(0)"];

  // Same (target, expected, actual) triple twice: one entry, occurrences 2,
  // and the ORIGINAL summary survives even when a new reason is typed.
  runJson(["verify-run", "--id", "V1", "--deviation", "DATABASE_URL을 로컬로 대체한 동등 검증", "--", ...actual], projectRoot);
  runJson(["verify-run", "--id", "V1", "--deviation", "retyped different reason", "--", ...actual], projectRoot);
  let deviations = readDeviations();
  assert.equal(deviations.length, 1);
  assert.equal(deviations[0].id, "D1");
  assert.equal(deviations[0].summary, "DATABASE_URL을 로컬로 대체한 동등 검증");
  assert.equal(deviations[0].details.occurrences, 2);
  assert.ok(deviations[0].details.lastSeenAt, "deduped deviation must record lastSeenAt");

  // Missing --deviation with an identical recorded mismatch must not throw:
  // the intentional-equivalent justification is already on record.
  const rerun = runJson(["verify-run", "--id", "V1", "--", ...actual], projectRoot);
  assert.equal(rerun.ok, true);
  deviations = readDeviations();
  assert.equal(deviations.length, 1);
  assert.equal(deviations[0].details.occurrences, 3);

  // A different actual command is a genuinely new mismatch: --deviation is
  // still required, and providing it appends a second entry.
  const different = ["node", "-e", "void 0;; process.exit(0)"];
  const refused = run(process.execPath, [harness, "verify-run", "--id", "V1", "--", ...different], {
    cwd: projectRoot,
    allowFailure: true,
  });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /command differs from PRD contract/);
  runJson(["verify-run", "--id", "V1", "--deviation", "second distinct equivalent verifier", "--", ...different], projectRoot);
  deviations = readDeviations();
  assert.equal(deviations.length, 2);
  assert.equal(deviations[1].details.occurrences, 1);

  // The rendered deviation section shows the repeat count instead of rows.
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  writeImplementationReport(statePath, state);
  const report = fs.readFileSync(path.join(path.dirname(statePath), "implementation-result.md"), "utf8");
  assert.match(report, /D1: verification_command - DATABASE_URL을 로컬로 대체한 동등 검증 \(×3, last \d{4}-\d{2}-\d{2}T/);
  assert.doesNotMatch(report, /second distinct equivalent verifier \(×/);
});

function failingFidelityReviewBody(logPath) {
  return fidelityReviewBody(logPath)
    .replace("Status: PASS", "Status: FAIL")
    .replace("- none: no material findings", "- high: T1 is unfinished; the run is being handed off partial.")
    .replace("## Verdict\n\nPASS.", "## Verdict\n\nFAIL.");
}

function driveToPartialHandoff(projectRoot, slug, profile) {
  const prdPath = writeApprovedPrd(projectRoot, slug);
  runJson(["init", "--prd", prdPath, "--review-profile", profile, "--session-id", `${slug}-session`], projectRoot);
  runJson(["plan-execution"], projectRoot);
  // V1 passes (completed, evidenced) while T1 stays pending (incomplete): the
  // minimal legal shape for a partial handoff.
  runJson(["verify-run", "--id", "V1", "--", "bash", "-lc", "node -e 'process.exit(0)'"], projectRoot);
  const state = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", slug, "state.json"), "utf8"));
  const logPath = state.verification[0].artifacts[0].path;
  const reviewPath = path.join(projectRoot, "agents", "implement", slug, "review", "requirements-fidelity-review.md");
  write(reviewPath, failingFidelityReviewBody(logPath));
  runJson(["requirements-review-record", "--status", "fail", "--report", reviewPath, "--summary", "FAIL - handoff"], projectRoot);
}

test("high-risk partial finalize requires a recorded final adversarial review verdict", () => {
  const projectRoot = initGitRepo();
  const slug = "high-risk-partial";
  driveToPartialHandoff(projectRoot, slug, "high-risk");

  // No final review recorded: the high-risk handoff must be rejected.
  const rejected = runJson(["finalize", "--status", "partial", "--summary", "Partial handoff."], projectRoot, { allowFailure: true });
  assert.equal(rejected.ok, false);
  assert.ok(rejected.violations.some(item => /Final adversarial review must be recorded before blocked\/partial finalization/.test(item)),
    `expected a final-review handoff violation, got: ${JSON.stringify(rejected.violations)}`);
  assert.ok(rejected.violations.some(item => /review-prompt/.test(item) && /review-record/.test(item)),
    "the violation must tell the agent which commands to run");

  // A recorded FAIL final review is acceptable: the review happened and its
  // verdict lands in the receipt; the handoff does not demand a pass.
  const finalPath = path.join(projectRoot, "agents", "implement", slug, "review", "final-review.md");
  write(finalPath, `# Final Adversarial Review

Status: FAIL

## Fidelity Review Checked

- The failing fidelity review was checked; the partial handoff is honest.

## Findings

- high: T1 remains unfinished and must be completed by the next owner.

## Artifact Audit

- Harness-visible validity: the V1 command log was inspected.

## Deviation Audit

- Recorded deviations: none.

## Verdict

FAIL.
`);
  runJson(["review-record", "--status", "fail", "--report", finalPath, "--summary", "FAIL - unfinished work handed off"], projectRoot);
  const finalized = runJson(["finalize", "--status", "partial", "--summary", "Partial handoff with reviewed verdict."], projectRoot);
  assert.equal(finalized.ok, true);
  const receipt = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", slug, "receipt.json"), "utf8"));
  assert.equal(receipt.status, "partial");
  assert.equal(receipt.finalReview.status, "fail", "the partial receipt must carry the final review verdict");
});

test("non-high-risk partial finalize is unaffected by the final-review handoff gate", () => {
  const projectRoot = initGitRepo();
  const slug = "trivial-partial";
  driveToPartialHandoff(projectRoot, slug, "trivial");
  const finalized = runJson(["finalize", "--status", "partial", "--summary", "Trivial partial handoff."], projectRoot);
  assert.equal(finalized.ok, true);
  const receipt = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", slug, "receipt.json"), "utf8"));
  assert.equal(receipt.status, "partial");
  assert.equal(receipt.finalReview, null);
});

test("fidelity Coverage Judgment accepts plain label lines and demotes a missing label to a structure warning", () => {
  const projectRoot = initGitRepo();
  const { logPath, reviewPath } = driveToFidelity(projectRoot, "coverage-plain", "coverage-plain-session");

  // Plain `Label: judgment` lines (no bullet) carry the same claim and must pass.
  const plain = fidelityReviewBody(logPath)
    .replace("- Requirements: covered by V1.", "Requirements: R1 covered by V1.")
    .replace("- Acceptance Criteria: AC1 is met.", "Acceptance Criteria: AC1 is met.")
    .replace("- User-visible behavior: no user-visible behavior.", "User-visible behavior: none.")
    .replace("- Non-goals and rejected options: none reintroduced.", "Non-goals and rejected options: none reintroduced.")
    .replace("- Human verification: none required.", "Human verification: none required.");
  write(reviewPath, plain);
  const ok = runJson(["requirements-review-record", "--status", "pass", "--report", reviewPath, "--summary", "PASS"], projectRoot);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.structureWarnings, [], "a conforming report must record with zero structure warnings");

  // A genuinely missing label line is a structure defect, not substance:
  // recording succeeds and the expected shape rides in structureWarnings.
  write(reviewPath, fidelityReviewBody(logPath).replace("- Requirements: covered by V1.\n", ""));
  const warned = runJson(["requirements-review-record", "--status", "pass", "--report", reviewPath, "--summary", "PASS"], projectRoot);
  assert.equal(warned.ok, true);
  assert.ok(
    warned.structureWarnings.some(item => /Coverage Judgment should include a line 'Requirements: <judgment>' \(leading bullet '-' optional\)/.test(item)),
    `expected a Coverage Judgment structure warning, got: ${JSON.stringify(warned.structureWarnings)}`,
  );
});

test("review-record hard gate keeps verdict contradiction and FAIL-needs-a-finding as rejections", () => {
  const projectRoot = initGitRepo();
  const { logPath, reviewPath } = driveToFidelity(projectRoot, "hard-gate", "hard-gate-session");

  // (b) A stated verdict that contradicts --status still rejects: a PASS
  // report cannot be recorded as fail. This is the guard that survives the
  // de-duplication of the report's Status line against the --status flag -
  // the shape requirement went away, the contradiction check did not.
  write(reviewPath, fidelityReviewBody(logPath));
  const mismatch = run(process.execPath, [harness, "requirements-review-record", "--status", "fail", "--report", reviewPath, "--summary", "FAIL"], {
    cwd: projectRoot,
    allowFailure: true,
  });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /states 'Status: PASS' but --status fail was recorded/);
  assert.match(mismatch.stderr, /do not edit the report to match the flag/);

  // (b2) The contradiction is caught through markdown decoration too. The old
  // exact-shape regex saw none of these as a verdict at all and rejected them
  // for the wrong reason ("must include a standalone Status line"), which is
  // what pushed a real run to hand-patch its own report four times
  // (2026-08-11, modakbul/webhook-to-modakbul-server).
  for (const decorated of ["**Status:** PASS", "- Status: PASS ✅", "Status: PASS (one advisory note)"]) {
    write(reviewPath, fidelityReviewBody(logPath).replace("Status: PASS", decorated));
    const decoratedRun = run(process.execPath, [harness, "requirements-review-record", "--status", "fail", "--report", reviewPath, "--summary", "FAIL"], {
      cwd: projectRoot,
      allowFailure: true,
    });
    assert.notEqual(decoratedRun.status, 0, `a decorated PASS verdict must still contradict --status fail: ${decorated}`);
    assert.match(decoratedRun.stderr, /but --status fail was recorded/);
  }

  // (b3) The same decorated verdicts record cleanly against the matching
  // --status, with no structure warning: shape is no longer the gate.
  for (const decorated of ["**Status:** PASS", "- Status: PASS ✅", "Status: PASS (one advisory note)"]) {
    write(reviewPath, fidelityReviewBody(logPath).replace("Status: PASS", decorated));
    const recorded = runJson(["requirements-review-record", "--status", "pass", "--report", reviewPath, "--summary", "PASS"], projectRoot);
    assert.equal(recorded.ok, true, `a decorated matching verdict must record: ${decorated}`);
    assert.deepEqual(
      recorded.structureWarnings.filter(item => /verdict/i.test(item)),
      [],
      `a stated verdict must not warn: ${decorated}`,
    );
  }

  // (b4) A report that states no verdict at all is recorded under the flag
  // with an advisory warning instead of a rejection: the flag already carries
  // the fact, so demanding the report restate it in a fixed shape was pure
  // duplication and the source of the hand-patching pressure.
  write(reviewPath, fidelityReviewBody(logPath).replace("Status: PASS\n", ""));
  const silent = runJson(["requirements-review-record", "--status", "pass", "--report", reviewPath, "--summary", "PASS"], projectRoot);
  assert.equal(silent.ok, true);
  assert.ok(
    silent.structureWarnings.some(item => /states no verdict line/.test(item)),
    `expected an advisory no-verdict warning, got: ${JSON.stringify(silent.structureWarnings)}`,
  );

  // (b5) The unfilled skeleton line names both verdicts, so it states none:
  // it must never read as PASS.
  write(reviewPath, fidelityReviewBody(logPath).replace("Status: PASS", "Status: PASS | FAIL"));
  const skeleton = runJson(["requirements-review-record", "--status", "fail", "--report", reviewPath, "--summary", "FAIL"], projectRoot);
  assert.equal(skeleton.ok, true);
  assert.ok(
    skeleton.structureWarnings.some(item => /skeleton verdict line unfilled/.test(item)),
    `an unfilled skeleton line must not be read as a verdict: ${JSON.stringify(skeleton.structureWarnings)}`,
  );

  // (c) A FAIL report whose Findings carry no finding line still rejects.
  write(reviewPath, fidelityReviewBody(logPath)
    .replace("Status: PASS", "Status: FAIL")
    .replace("- none: no material findings", "No findings were recorded.")
    .replace("## Verdict\n\nPASS.", "## Verdict\n\nFAIL."));
  const noFinding = run(process.execPath, [harness, "requirements-review-record", "--status", "fail", "--report", reviewPath, "--summary", "FAIL"], {
    cwd: projectRoot,
    allowFailure: true,
  });
  assert.notEqual(noFinding.status, 0);
  assert.match(noFinding.stderr, /Failing requirements fidelity report must include at least one finding/);
});

// The verdict scan is scoped by structure, not by phrasing: the final-review
// skeleton asks for `- Status: <recorded status>` under `Fidelity Review
// Checked`, so a whole-file scan would read a FAILing final review's citation
// of the PASSing fidelity review as a self-contradiction.
test("a FAILing final review citing a PASSing fidelity review is not a self-contradiction", () => {
  const projectRoot = initGitRepo();
  const slug = "final-verdict-scope";
  const { logPath, reviewPath } = driveToFidelity(projectRoot, slug, "final-verdict-session");
  write(reviewPath, fidelityReviewBody(logPath));
  runJson(["requirements-review-record", "--status", "pass", "--report", reviewPath, "--summary", "PASS"], projectRoot);

  const finalPath = path.join(projectRoot, "agents", "implement", slug, "review", "final-review.md");
  const finalBody = (ownVerdict, verdictSection) => `# Final Adversarial Review

Status: ${ownVerdict}

## Fidelity Review Checked

- Report: agents/implement/${slug}/review/requirements-fidelity-review.md
- Status: PASS
- Recorded at: now

## Findings

- high: the diff still misses one guard.

## Artifact Audit

- Harness-visible validity: the command log was inspected.

## Deviation Audit

- Recorded deviations: none.

## Verdict

${verdictSection}
`;

  write(finalPath, finalBody("FAIL", "FAIL."));
  const recorded = runJson(["review-record", "--status", "fail", "--report", finalPath, "--summary", "FAIL - one guard missing"], projectRoot);
  assert.equal(recorded.ok, true, `the cited fidelity status must not read as this report's verdict: ${JSON.stringify(recorded)}`);
  assert.deepEqual(recorded.structureWarnings.filter(item => /verdict/i.test(item)), []);

  // The Verdict section IS in scope: a verdict there that contradicts the
  // recorded status still rejects.
  write(finalPath, finalBody("FAIL", "Verdict: PASS"));
  const contradiction = run(process.execPath, [harness, "review-record", "--status", "fail", "--report", finalPath, "--summary", "FAIL"], {
    cwd: projectRoot,
    allowFailure: true,
  });
  assert.notEqual(contradiction.status, 0);
  assert.match(contradiction.stderr, /states 'Verdict: PASS' but --status fail was recorded/);
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

## Deviation Audit

- none recorded

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
  for (const legacyView of ["checklist.md", "verification.md", "verification-plan.json", "verification-plan.md", "execution-plan.json", "execution-plan.md", "ledger.jsonl"]) {
    assert.equal(fs.existsSync(path.join(projectRoot, "agents", "implement", "trivial-finalize", legacyView)), false, `derived view ${legacyView} must no longer be written`);
  }
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

## Deviation Audit

- none recorded

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

test("fidelity review accepts code-span generics/tags and demotes leftover template placeholders to warnings", () => {
  const projectRoot = initGitRepo();
  const { logPath, reviewPath } = driveToFidelity(projectRoot, "fidelity-placeholder", "fp-session");

  // Legitimate generics and JSX tags inside code spans must not read as placeholders.
  write(reviewPath, fidelityReviewBody(logPath, "\n- The handler returns `Array<string>` and renders a `<button>` element as intended."));
  const ok = runJson(["requirements-review-record", "--status", "pass", "--report", reviewPath, "--summary", "PASS"], projectRoot);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.structureWarnings, []);

  // A leftover <topic-slug>-style placeholder in prose is a structure defect:
  // recording succeeds, the warning is surfaced instead of a rejection.
  write(reviewPath, fidelityReviewBody(logPath, "\n- Implemented the <topic-slug> flow end to end."));
  const warned = runJson(["requirements-review-record", "--status", "pass", "--report", reviewPath, "--summary", "PASS"], projectRoot);
  assert.equal(warned.ok, true);
  assert.ok(
    warned.structureWarnings.some(item => /leftover <template> placeholders/.test(item)),
    `expected a placeholder structure warning, got: ${JSON.stringify(warned.structureWarnings)}`,
  );
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
  const readyA = runJson(["status"], rootA);
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
  const readyB = runJson(["status"], rootB);
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
  assert.equal(fs.existsSync(path.join(root, "agents", "implement", "high-risk-graph", "checklist.md")), false);
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

test("fidelity prompt narrows the qa-log mandate only behind a fresh spec-gate PASS", () => {
  const root = initGitRepo();
  const slug = "spec-settled";
  const prdAbs = writeApprovedPrd(root, slug);
  runJson(["init", "--prd", prdAbs, "--review-profile", "standard", "--session-id", "settled-session"], root);
  const renderPrompt = () => run(process.execPath, [harness, "requirements-review-prompt"], { cwd: root }).stdout;

  // No spec gate record: the full-read mandate stands.
  let prompt = renderPrompt();
  assert.match(prompt, /read the complete file, including Current Understanding/);
  assert.doesNotMatch(prompt, /qa-log→PRD leg is settled/);

  // A fresh, non-overridden spec PASS hash-pinned to the on-disk documents
  // (hashes computed with the canonical hashGateInput, as the gate records them).
  const { hashGateInput } = requireModule(path.join(repoRoot, "cli", "lib", "gate_freshness.js"));
  const qaLogRel = path.join("agents", "interview", slug, "qa-log.md");
  const qaLogAbs = path.join(root, qaLogRel);
  write(qaLogAbs, "---\ntopic: \"spec-settled\"\nstatus: \"complete\"\n---\n\n## Decision Register\n\n- D-01 resolved.\n");
  const prdRel = path.relative(root, prdAbs);
  const gatesJson = {
    schema: 1,
    topic: slug,
    gates: {
      spec: {
        verdict: "PASS",
        attempts: 0,
        overridden: false,
        findings: [],
        lastRunAt: "2026-08-10T00:00:00.000Z",
        history: [],
        inputs: [
          { path: prdRel, sha256: hashGateInput(prdAbs, undefined) },
          { path: qaLogRel, sha256: hashGateInput(qaLogAbs, undefined) },
        ],
      },
    },
    deviations: [],
    judgeCalls: [],
  };
  const gatesPath = path.join(root, "agents", "gates", slug, "gates.json");
  write(gatesPath, JSON.stringify(gatesJson, null, 2));
  prompt = renderPrompt();
  assert.match(prompt, /qa-log→PRD leg is settled/);
  assert.match(prompt, /last run 2026-08-10T00:00:00\.000Z/);
  assert.match(prompt, new RegExp(qaLogRel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "settled text must cite the pinned inputs");
  assert.match(prompt, /Decision Traceability/);
  assert.match(prompt, /fall back to reading the canonical qa-log in full/);
  assert.doesNotMatch(prompt, /read the complete file, including Current Understanding/);

  // Body drift in a pinned input revives the full-read mandate.
  fs.appendFileSync(qaLogAbs, "\n- D-02 added after the gate ran.\n");
  prompt = renderPrompt();
  assert.match(prompt, /read the complete file, including Current Understanding/);
  assert.doesNotMatch(prompt, /qa-log→PRD leg is settled/);

  // Restore freshness, then a user override (not a judged PASS) must not narrow.
  fs.writeFileSync(qaLogAbs, "---\ntopic: \"spec-settled\"\nstatus: \"complete\"\n---\n\n## Decision Register\n\n- D-01 resolved.\n");
  gatesJson.gates.spec.overridden = true;
  write(gatesPath, JSON.stringify(gatesJson, null, 2));
  prompt = renderPrompt();
  assert.match(prompt, /read the complete file, including Current Understanding/);
  assert.doesNotMatch(prompt, /qa-log→PRD leg is settled/);
});

// The axis division, which the freshness rules used to ignore. The verify gate
// owns the code (it pins the exact diff it judged); the requirements fidelity
// review owns intent lineage, decisions, deviations, and registered evidence, so
// it is pinned to what it actually reads. Pinning it to the source tree made
// every bug fix invalidate a review whose subject had not moved - measured
// 2026-08-11 on project modakbul, ten fidelity recordings where one survived.
test("a source change does not stale the fidelity review; a change to what it read does", () => {
  const root = initGitRepo();
  const { logPath, reviewPath } = driveToFidelity(root, "fidelity-axis", "fa-session");
  write(reviewPath, fidelityReviewBody(logPath));
  runJson(["requirements-review-record", "--status", "pass", "--report", reviewPath, "--summary", "PASS"], root);

  const statePath = path.join(root, "agents", "implement", "fidelity-axis", "state.json");
  const inputs = JSON.parse(fs.readFileSync(statePath, "utf8")).requirementsFidelityReview.inputs;
  assert.ok(inputs.length >= 2, `the review must pin what it read: ${JSON.stringify(inputs)}`);
  assert.ok(inputs.some(input => input.path === "agents/prd/fidelity-axis/prd.md" && /^[0-9a-f]{64}$/.test(input.sha256)),
    `the PRD is pinned: ${JSON.stringify(inputs)}`);
  assert.ok(inputs.every(input => !/^src\//.test(input.path)), `no source file is pinned: ${JSON.stringify(inputs)}`);

  // A source change - committed, so the worktree is clean - no longer touches
  // this review. The code under judgment is the verify gate's subject, and that
  // gate pins the diff it judged; this fixture deliberately has no gate run, so
  // nothing else objects either. That narrowing is the point and the cost: a run
  // that never verified has no code judgment at all, which its receipt says with
  // "Verify gate: NOT_RUN" rather than by borrowing this review's pin.
  write(path.join(root, "README.md"), "# Changed after review\n");
  run("git", ["add", "README.md"], { cwd: root });
  run("git", ["commit", "-m", "commit-only source change"], { cwd: root });
  const afterSourceChange = runJson(["finalize", "--status", "complete", "--summary", "done"], root);
  assert.equal(afterSourceChange.ok, true, JSON.stringify(afterSourceChange.violations || []));

  // Changing what the review DID read stales it. The registered evidence
  // artifact is the cleanest case: it is a fidelity input and nothing else.
  const logAbs = path.join(root, logPath);
  const reviewedLog = fs.readFileSync(logAbs, "utf8");
  write(logAbs, "$ npm test\nrewritten after the review\n");
  const afterEvidenceChange = runJson(["finalize", "--status", "complete", "--summary", "done"], root, { allowFailure: true });
  assert.equal(afterEvidenceChange.ok, false);
  assert.ok(
    afterEvidenceChange.violations.some(item => /Requirements fidelity review is stale: .*changed after the review/.test(item)),
    JSON.stringify(afterEvidenceChange.violations),
  );

  // Restoring the reviewed content revives it: the pin is content-based, so a
  // benign round trip costs no re-review cycle.
  write(logAbs, reviewedLog);
  const revived = runJson(["finalize", "--status", "complete", "--summary", "done"], root);
  assert.equal(revived.ok, true, JSON.stringify(revived.violations || []));
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

## Deviation Audit

- none recorded

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

## Deviation Audit

- none recorded

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

## Deviation Audit

- none recorded

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

test("re-recording the same artifact path supersedes the entry and clears the hash-changed violation", () => {
  const root = initGitRepo();
  const prd = writeApprovedPrd(root, "recapture");
  runJson(["init", "--prd", prd, "--review-profile", "trivial"], root);
  runJson(["plan-execution"], root);
  runJson(["mark", "--kind", "task", "--id", "T1", "--status", "complete", "--ac", "AC1", "--evidence", "implementation done"], root);

  const capture = path.join(root, "agents", "implement", "recapture", "artifacts", "capture.log");
  write(capture, "first capture");
  runJson(["record-artifact", "--id", "V1", "--kind", "log", "--path", capture, "--description", "runtime capture"], root);
  const statePath = path.join(root, "agents", "implement", "recapture", "state.json");
  const first = JSON.parse(fs.readFileSync(statePath, "utf8")).verification
    .find(item => item.id === "V1").artifacts.at(-1);

  // Overwriting the registered file in place raises the hash-changed violation.
  write(capture, "second capture with new bytes");
  const stale = runJson(["status"], root);
  assert.ok(
    stale.completion.violations.some(item => /artifact .+ hash changed/.test(item)),
    `expected hash-changed violation, got: ${JSON.stringify(stale.completion.violations)}`,
  );

  // Re-registering the same owner+path replaces the entry instead of appending
  // a duplicate whose stale hash could never be cleared (refresh-artifacts,
  // the old manual re-blessing command, no longer exists).
  runJson(["record-artifact", "--id", "V1", "--kind", "log", "--path", capture, "--description", "re-captured in place"], root);
  const v1 = JSON.parse(fs.readFileSync(statePath, "utf8")).verification.find(item => item.id === "V1");
  const entries = v1.artifacts.filter(entry => entry.path === first.path);
  assert.equal(entries.length, 1, "same owner+path re-registration must supersede, not append");
  assert.equal(entries[0].artifactId, first.artifactId, "the superseding entry keeps the original identity");
  assert.equal(entries[0].createdAt, first.createdAt, "the superseding entry keeps the original registration time");
  assert.notEqual(entries[0].sha256, first.sha256, "the superseding entry carries the fresh hash");
  assert.ok(entries[0].refreshedAt, "the superseding entry records when the bytes were re-inspected");

  const fresh = runJson(["status"], root);
  assert.ok(
    !fresh.completion.violations.some(item => /artifact .+ hash changed/.test(item)),
    `hash-changed violation should clear after re-registration, got: ${JSON.stringify(fresh.completion.violations)}`,
  );
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

test("a budget-exhausted BLOCKED verify gate is itself the blocker: finalize --status blocked exits the deadlock honestly", () => {
  const projectRoot = initGitRepo();
  const slug = "gate-deadlock";
  // A non-default budget proves the snapshot reads the configured
  // judge.retryBudget instead of a hardcoded value (or the old 0).
  write(path.join(projectRoot, "agents", "config.json"), JSON.stringify({ judge: { retryBudget: 2 } }));
  const { logPath, reviewPath } = driveToFidelity(projectRoot, slug, "gate-deadlock-session");
  write(reviewPath, fidelityReviewBody(logPath));
  runJson(["requirements-review-record", "--status", "pass", "--report", reviewPath, "--summary", "PASS"], projectRoot);

  const emptyGate = { verdict: null, attempts: 0, overridden: false, findings: [], lastRunAt: null, history: [] };
  const finding = { area: "semantic", severity: "P0", missing: "AC1: judge keeps rejecting the diff", recommendation: "fix it", requiresHuman: false };
  const writeGates = verify => write(path.join(projectRoot, "agents", "gates", slug, "gates.json"), JSON.stringify({
    schema: 1,
    topic: slug,
    gates: { "gap-audit": { ...emptyGate }, spec: { ...emptyGate }, verify },
    deviations: [],
    judgeCalls: [],
  }, null, 2));

  // Budget remaining: the cheap escapes stay shut - attempts are left to
  // spend, so an empty blocker list still refuses the blocked handoff and
  // the gate still vetoes a passing review record (fix and re-verify first).
  writeGates({ ...emptyGate, verdict: "FAIL", attempts: 1, findings: [finding] });
  const early = runJson(["finalize", "--status", "blocked", "--summary", "Giving up early."], projectRoot, { allowFailure: true });
  assert.equal(early.ok, false);
  assert.ok(
    early.violations.some(item => /retry budget is not exhausted \(attempts 1\/2\)/.test(item)),
    `expected a budget-remaining refusal, got: ${JSON.stringify(early.violations)}`,
  );
  const earlyRecord = runJson(["requirements-review-record", "--status", "pass", "--report", reviewPath, "--summary", "PASS again"], projectRoot, { allowFailure: true });
  assert.equal(earlyRecord.ok, false);
  assert.ok(earlyRecord.violations.some(item => /Verify gate is BLOCKED/.test(item)), JSON.stringify(earlyRecord.violations));

  // Budget exhausted: complete keeps rejecting, but the honest review record
  // opens together with the blocked handoff - the gate is terminal, so it no
  // longer vetoes the review the blocked receipt requires.
  writeGates({ ...emptyGate, verdict: "FAIL", attempts: 2, findings: [finding] });
  const complete = runJson(["finalize", "--status", "complete", "--summary", "Not actually complete."], projectRoot, { allowFailure: true });
  assert.equal(complete.ok, false);
  assert.ok(complete.violations.some(item => /Verify gate is BLOCKED/.test(item)), JSON.stringify(complete.violations));
  assert.ok(complete.violations.some(item => /--status blocked/.test(item)), "the rejection must name the honest exit");
  const rerecord = runJson(["requirements-review-record", "--status", "pass", "--report", reviewPath, "--summary", "PASS again"], projectRoot);
  assert.equal(rerecord.ok, true, "a terminally blocked gate must not veto an honest review record");

  // During the deadlock the goal guard still refuses update_goal complete.
  const preTool = run(process.execPath, [harness, "hook", "pretool-use"], {
    cwd: projectRoot,
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      cwd: projectRoot,
      session_id: "gate-deadlock-session",
      tool_name: "update_goal",
      tool_input: { status: "complete" },
    }),
  });
  assert.equal(JSON.parse(preTool.stdout).decision, "block");

  // The honest exit: zero blocked tracked items, the terminal gate qualifies.
  const finalized = runJson(["finalize", "--status", "blocked", "--summary", "Verify gate exhausted its retry budget."], projectRoot);
  assert.equal(finalized.ok, true);
  const receipt = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", slug, "receipt.json"), "utf8"));
  assert.equal(receipt.status, "blocked");
  assert.equal(receipt.verifyGate.effective, "BLOCKED");
  assert.equal(receipt.verifyGate.attempts, 2);
  assert.equal(receipt.verifyGate.budget, 2);
  assert.equal(receipt.verifyGate.budgetExhausted, true);
  assert.equal(receipt.verifyGate.findings.length, 1);
  assert.match(receipt.verifyGate.findings[0].missing, /judge keeps rejecting the diff/);

  const report = fs.readFileSync(path.join(projectRoot, "agents", "implement", slug, "implementation-result.md"), "utf8");
  assert.match(report, /Status: Blocked/);
  assert.match(report, /Verify gate: BLOCKED/);
  assert.match(report, /Attempts: 2\/2 \(retry budget exhausted\)/);
  assert.match(report, /judge keeps rejecting the diff/);

  // The blocked receipt releases the Stop hook: the deadlock has an exit.
  const stop = run(process.execPath, [harness, "hook", "stop"], {
    cwd: projectRoot,
    input: JSON.stringify({ hook_event_name: "Stop", cwd: projectRoot, session_id: "gate-deadlock-session" }),
  });
  assert.equal(stop.stdout.trim(), "");
});

// Legibility regression for the probing incident (2026-08-11, modakbul run
// webhook-to-modakbul-server): the agent called finalize three times inside
// two minutes - partial, complete with the dummy summary "테스트", blocked -
// because each rejection reported only the status it was asked about. One
// rejection must now carry every blocker of every exit, each with the command
// that clears it.
test("a rejected finalize reports every blocker at once, each with the command that clears it", () => {
  const projectRoot = initGitRepo();
  const prdPath = writeApprovedPrd(projectRoot, "finalize-legibility");
  runJson(["init", "--prd", prdPath, "--review-profile", "trivial", "--session-id", "legibility-session"], projectRoot);
  runJson(["plan-execution"], projectRoot);

  const rejected = runJson(["finalize", "--status", "complete", "--summary", "Not actually done."], projectRoot, { allowFailure: true });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.requested, "complete");

  // Every open item is reported in the SAME rejection - not one per round trip.
  for (const expected of [
    /Task T1 is pending; .*`.*mark --kind task --id T1 --status complete --evidence/,
    /Task T1 has no evidence; .*`.*mark --kind task --id T1/,
    /Acceptance AC1 is pending; .*`.*mark --kind ac --id AC1 --status met --evidence/,
    /Required verification V1 is pending; .*`.*verify-run --id V1 -- <command>`/,
    /Verification V1 has no evidence; .*`.*verify-run --id V1/,
    /Requirements fidelity review has not passed \(currently not recorded\); .*requirements-review-record/,
  ]) {
    assert.ok(
      rejected.violations.some(item => expected.test(item)),
      `expected a blocker matching ${expected}, got: ${JSON.stringify(rejected.violations, null, 2)}`,
    );
  }
  // Every blocker names an action, never just a diagnosis.
  for (const violation of rejected.violations) {
    assert.match(violation, /`[^`]+`/, `blocker carries no concrete command or action: ${violation}`);
  }

  // All three exits are priced from the same state read, so no other status
  // has to be tried to learn what it would say.
  assert.deepEqual(rejected.exits.map(exit => exit.status), ["complete", "partial", "blocked"]);
  assert.deepEqual(rejected.exits.map(exit => exit.eligible), [false, false, false]);
  assert.deepEqual(rejected.exits[0].blockers, rejected.violations, "the requested exit reports exactly the violations");
  assert.equal(rejected.exits[0].blockerCount, rejected.violations.length);
  assert.ok(
    rejected.exits[1].blockers.some(item => /Partial finalization requires at least one completed, evidenced/.test(item)),
    `expected the partial exit to price itself, got: ${JSON.stringify(rejected.exits[1].blockers, null, 2)}`,
  );
  assert.ok(
    rejected.exits[2].blockers.some(item => /Blocked finalization requires at least one task, acceptance, or verification item marked blocked/.test(item)),
    `expected the blocked exit to price itself, got: ${JSON.stringify(rejected.exits[2].blockers, null, 2)}`,
  );
  for (const exit of rejected.exits) {
    assert.match(exit.command, new RegExp(`finalize --status ${exit.status} `));
  }

  // With nothing open, the guidance states the mutual exclusivity instead of
  // leaving the agent to infer it from three separate refusals.
  assert.match(rejected.guidance, /cannot be `complete` while/);
  assert.match(rejected.guidance, /No finalize status succeeds right now/);
  assert.match(rejected.guidance, /mutually exclusive/);

  // An exit the agent did not ask about is previewed, not dumped: the count
  // stays exact while the list stays readable.
  const asBlocked = runJson(["finalize", "--status", "blocked", "--summary", "Not actually blocked."], projectRoot, { allowFailure: true });
  const completePreview = asBlocked.exits.find(exit => exit.status === "complete");
  assert.equal(completePreview.blockerCount, rejected.violations.length);
  assert.ok(completePreview.blockerCount > completePreview.blockers.length, "an unrequested exit's long blocker list must be previewed");
  assert.match(completePreview.blockers[completePreview.blockers.length - 1], /^\+\d+ more; `finalize --status complete` lists all \d+$/);
});

test("a rejected complete names the exit that succeeds right now instead of leaving it to be probed", () => {
  const projectRoot = initGitRepo();
  const slug = "finalize-exit-naming";
  write(path.join(projectRoot, "agents", "config.json"), JSON.stringify({ judge: { retryBudget: 2 } }));
  const { logPath, reviewPath } = driveToFidelity(projectRoot, slug, "exit-naming-session");
  write(reviewPath, fidelityReviewBody(logPath));
  runJson(["requirements-review-record", "--status", "pass", "--report", reviewPath, "--summary", "PASS"], projectRoot);

  // The incident's exact shape: every tracked item closed, the verify gate
  // terminally BLOCKED. `complete` is impossible, `partial` is impossible
  // (nothing is open), `blocked` is the honest exit - and the rejection says
  // so rather than making the agent discover it by trying all three.
  const emptyGate = { verdict: null, attempts: 0, overridden: false, findings: [], lastRunAt: null, history: [] };
  write(path.join(projectRoot, "agents", "gates", slug, "gates.json"), JSON.stringify({
    schema: 1,
    topic: slug,
    gates: {
      "gap-audit": { ...emptyGate },
      spec: { ...emptyGate },
      verify: {
        ...emptyGate,
        verdict: "FAIL",
        attempts: 2,
        findings: [{ area: "semantic", severity: "P0", missing: "AC1: judge keeps rejecting the diff", recommendation: "fix it", requiresHuman: false }],
      },
    },
    deviations: [],
    judgeCalls: [],
  }, null, 2));

  const rejected = runJson(["finalize", "--status", "complete", "--summary", "Not actually complete."], projectRoot, { allowFailure: true });
  assert.equal(rejected.ok, false);
  const byStatus = Object.fromEntries(rejected.exits.map(exit => [exit.status, exit]));
  assert.equal(byStatus.complete.eligible, false);
  assert.equal(byStatus.partial.eligible, false);
  assert.equal(byStatus.blocked.eligible, true, `blocked must be open here, got: ${JSON.stringify(rejected.exits, null, 2)}`);
  assert.deepEqual(byStatus.blocked.blockers, []);
  assert.match(rejected.guidance, /cannot be `complete` while: Verify gate is BLOCKED/);
  assert.match(rejected.guidance, /`--status blocked` succeeds right now/);
  assert.match(rejected.guidance, /finalize --status blocked/);
  assert.match(rejected.guidance, /honestly describes this run/);

  // The named exit is the one that actually works: no probing round trip.
  const finalized = runJson(["finalize", "--status", "blocked", "--summary", "Verify gate exhausted its retry budget."], projectRoot);
  assert.equal(finalized.ok, true);
});

// A `complete` exit priced without running it must not claim the harness-timed
// reverification's result (PRINCIPLES item 10: records stay honest).
test("a priced-but-unrun complete exit is marked pending final reverification", () => {
  const projectRoot = initGitRepo();
  const slug = "finalize-exit-honesty";
  const { logPath, reviewPath } = driveToFidelity(projectRoot, slug, "exit-honesty-session");
  write(reviewPath, fidelityReviewBody(logPath));
  runJson(["requirements-review-record", "--status", "pass", "--report", reviewPath, "--summary", "PASS"], projectRoot);

  // `partial` is refused (nothing is open), which prices `complete` without
  // running it: its cheap checks clear, but the re-run has not happened.
  const rejected = runJson(["finalize", "--status", "partial", "--summary", "Half done."], projectRoot, { allowFailure: true });
  assert.equal(rejected.ok, false);
  const completeExit = rejected.exits.find(exit => exit.status === "complete");
  assert.equal(completeExit.eligible, true);
  assert.equal(completeExit.pendingFinalReverification, true);
  assert.match(rejected.guidance, /`--status complete` succeeds right now/);

  // The requested exit ran for real, so it never carries the caveat.
  const completed = runJson(["finalize", "--status", "complete", "--summary", "Done."], projectRoot);
  assert.equal(completed.ok, true);
});

// The second terminal cause, on the implement path. A semantic FAIL whose
// identical rerun the gate refuses at $0 freezes `attempts` below the budget
// forever, so a budget-only terminal predicate is unreachable and the blocked
// exit never opens (reproduced 2026-08-11 on the quick path at attempts 1/3).
// The receipt must stay honest about which cause it was: 1/3, not a faked 3/3.
test("a refused rerun is itself terminal: finalize --status blocked opens at attempts 1/N without faking exhaustion", () => {
  const projectRoot = initGitRepo();
  const slug = "gate-rerun-refused";
  write(path.join(projectRoot, "agents", "config.json"), JSON.stringify({ judge: { retryBudget: 3 } }));
  const { logPath, reviewPath } = driveToFidelity(projectRoot, slug, "gate-rerun-refused-session");
  write(reviewPath, fidelityReviewBody(logPath));
  runJson(["requirements-review-record", "--status", "pass", "--report", reviewPath, "--summary", "PASS"], projectRoot);

  const store = requireModule(path.join(repoRoot, "cli", "dist", "gates", "store.js"));
  const { judgedDiffSha256 } = requireModule(path.join(repoRoot, "cli", "lib", "git.js"));
  const prdRel = path.join("agents", "prd", slug, "prd.md");
  const emptyGate = { verdict: null, attempts: 0, overridden: false, findings: [], lastRunAt: null, history: [] };
  const finding = { area: "semantic", severity: "P0", missing: "AC1: the diff still has no persistence", recommendation: "add it", requiresHuman: false };
  const headSha = run("git", ["rev-parse", "HEAD"], { cwd: projectRoot }).stdout.trim();

  // A record shaped exactly as runVerifyGate writes an armed semantic FAIL:
  // stage stamp, live-material stamp false, base pinned to a resolved SHA, the
  // PRD pinned by content hash, the judged diff pinned, and a history row that
  // agrees with all of it. Written LAST, so state.json's updatedAt (bumped by
  // every mark and by the review record) is older than lastRunAt - a newer
  // updatedAt means new evidence and would legitimately break the refusal.
  const writeGates = (overrides = {}) => {
    const lastRunAt = new Date(Date.now() + 1000).toISOString();
    const verify = {
      ...emptyGate,
      verdict: "FAIL",
      attempts: 1,
      totalAttempts: 1,
      findings: [finding],
      lastRunAt,
      failedStage: "semantic",
      diffSource: `git:${headSha}`,
      usedLiveMaterial: false,
      docKind: "prd",
      inputs: [{ path: prdRel, sha256: store.freshnessHash(fs.readFileSync(path.join(projectRoot, prdRel), "utf8")), kind: "prd" }],
      judgedDiffSha256: judgedDiffSha256(projectRoot, headSha),
      ...overrides,
    };
    verify.history = [{
      at: verify.lastRunAt,
      verdict: verify.verdict,
      findingCount: verify.findings.length,
      requiresHuman: false,
      judgedDiffSha256: verify.judgedDiffSha256,
      failedStage: verify.failedStage,
      diffSource: verify.diffSource,
      usedLiveMaterial: verify.usedLiveMaterial,
      docKind: verify.docKind,
      ...(overrides.history ? overrides.history[0] : {}),
    }];
    write(path.join(projectRoot, "agents", "gates", slug, "gates.json"), JSON.stringify({
      schema: 1,
      topic: slug,
      gates: { "gap-audit": { ...emptyGate }, spec: { ...emptyGate }, verify },
      deviations: [],
      judgeCalls: [],
    }, null, 2));
  };

  // Control: the SAME record with an unmatchable base is a gate whose rerun
  // would really run, so the cheap early "blocked" stays shut. Without this the
  // test could not tell "the refusal opened the exit" from "the exit was open".
  writeGates({ diffSource: "git:HEAD" });
  const wouldRun = runJson(["finalize", "--status", "blocked", "--summary", "Giving up early."], projectRoot, { allowFailure: true });
  assert.equal(wouldRun.ok, false);
  assert.ok(
    wouldRun.violations.some(item => /an identical re-run would still run/.test(item)),
    `expected a rerun-would-run refusal, got: ${JSON.stringify(wouldRun.violations)}`,
  );

  // Armed: complete is still impossible, and the rejection must name the code
  // change as the live option rather than a re-run that would only be refused.
  writeGates();
  const complete = runJson(["finalize", "--status", "complete", "--summary", "Not actually complete."], projectRoot, { allowFailure: true });
  assert.equal(complete.ok, false);
  const gateViolation = complete.violations.find(item => /Verify gate is BLOCKED/.test(item));
  assert.ok(gateViolation, JSON.stringify(complete.violations));
  assert.match(gateViolation, /identical re-run is refused on this unchanged tree \(attempts 1\/3/);
  assert.match(gateViolation, /change the code under judgment/);
  assert.match(gateViolation, /--status blocked/, "the rejection must name the honest exit");
  assert.doesNotMatch(gateViolation, /retry budget is exhausted/, "the budget was not spent; the receipt may not claim it was");

  // The Stop hook carries the same directive verbatim, so the continuation loop
  // cannot keep demanding a re-run the gate will refuse.
  const stuck = run(process.execPath, [harness, "hook", "stop"], {
    cwd: projectRoot,
    input: JSON.stringify({ hook_event_name: "Stop", cwd: projectRoot, session_id: "gate-rerun-refused-session" }),
  });
  const stuckReason = JSON.parse(stuck.stdout).reason;
  assert.match(stuckReason, /identical re-run is refused on this unchanged tree/);
  assert.ok(!/fix the cited findings and re-run/.test(stuckReason),
    "a Stop hook must never point at a command that will exit with the refusal");

  // The honest exit opens with zero blocked tracked items and budget remaining.
  const finalized = runJson(["finalize", "--status", "blocked", "--summary", "Verify gate FAIL; an identical re-run is refused on the unchanged tree."], projectRoot);
  assert.equal(finalized.ok, true);
  const receipt = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", slug, "receipt.json"), "utf8"));
  assert.equal(receipt.status, "blocked");
  assert.equal(receipt.verifyGate.effective, "BLOCKED");
  assert.equal(receipt.verifyGate.attempts, 1, "the receipt reports the attempts actually spent");
  assert.equal(receipt.verifyGate.budget, 3);
  assert.equal(receipt.verifyGate.budgetExhausted, false, "a receipt must never claim a budget it did not spend");
  assert.equal(receipt.verifyGate.rerunRefused, true, "the terminal cause is recorded distinctly");

  const report = fs.readFileSync(path.join(projectRoot, "agents", "implement", slug, "implementation-result.md"), "utf8");
  assert.match(report, /Status: Blocked/);
  assert.match(report, /Attempts: 1\/3 \(rerun refused on an unchanged tree, judged against base [0-9a-f]{12}; the remaining attempts are unspendable\)/,
    "a human reads the honest cause - and the base it was judged against - straight off the record");
  assert.doesNotMatch(report, /retry budget exhausted/);

  // The blocked receipt releases the Stop hook: the livelock has an exit.
  const stop = run(process.execPath, [harness, "hook", "stop"], {
    cwd: projectRoot,
    input: JSON.stringify({ hook_event_name: "Stop", cwd: projectRoot, session_id: "gate-rerun-refused-session" }),
  });
  assert.equal(stop.stdout.trim(), "");
});

// Regression for the circular deadlock: the gate FAIL landed before the
// concurrent fidelity review was recorded, so finalize --status blocked
// demanded the review while review-record pass was vetoed by the BLOCKED
// gate - each error pointed at the other and the only observed escape was
// recording a truthful-PASS review as --status fail (reproduced 2026-08-11).
// A terminally blocked gate must let the honest review land so the blocked
// receipt can be earned without lying.
test("terminally blocked gate with no recorded review: record the honest pass, then finalize blocked", () => {
  const projectRoot = initGitRepo();
  const slug = "gate-circle";
  write(path.join(projectRoot, "agents", "config.json"), JSON.stringify({ judge: { retryBudget: 2 } }));
  const { logPath, reviewPath } = driveToFidelity(projectRoot, slug, "gate-circle-session");

  // The gate exhausts its budget BEFORE any fidelity review is recorded -
  // the concurrent-lane ordering that produced the circle.
  const emptyGate = { verdict: null, attempts: 0, overridden: false, findings: [], lastRunAt: null, history: [] };
  const finding = { area: "semantic", severity: "P0", missing: "AC1: judge keeps rejecting the diff", recommendation: "fix it", requiresHuman: false };
  write(path.join(projectRoot, "agents", "gates", slug, "gates.json"), JSON.stringify({
    schema: 1,
    topic: slug,
    gates: { "gap-audit": { ...emptyGate }, spec: { ...emptyGate }, verify: { ...emptyGate, verdict: "FAIL", attempts: 2, findings: [finding] } },
    deviations: [],
    judgeCalls: [],
  }, null, 2));

  // One side of the old circle: the blocked handoff still demands the review.
  const withoutReview = runJson(["finalize", "--status", "blocked", "--summary", "Verify gate exhausted its retry budget."], projectRoot, { allowFailure: true });
  assert.equal(withoutReview.ok, false);
  assert.ok(
    withoutReview.violations.some(item => /Requirements fidelity review must be recorded/.test(item)),
    `expected the missing-review refusal, got: ${JSON.stringify(withoutReview.violations)}`,
  );

  // The other side no longer rejects: the honest PASS review records cleanly.
  write(reviewPath, fidelityReviewBody(logPath));
  const recorded = runJson(["requirements-review-record", "--status", "pass", "--report", reviewPath, "--summary", "Intent preserved; blocked only by the verify gate."], projectRoot);
  assert.equal(recorded.ok, true, "the terminal gate must not veto the honest review record");

  // The circle is broken: the blocked receipt lands and stays honest.
  const finalized = runJson(["finalize", "--status", "blocked", "--summary", "Verify gate exhausted its retry budget."], projectRoot);
  assert.equal(finalized.ok, true);
  const receipt = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", slug, "receipt.json"), "utf8"));
  assert.equal(receipt.status, "blocked");
  assert.equal(receipt.verifyGate.effective, "BLOCKED");
  assert.equal(receipt.verifyGate.budgetExhausted, true);
  assert.equal(receipt.requirementsFidelityReview.status, "pass");
});

// The judge-error loop is the third terminal cause, and the only one where the
// gate never answered the question. Charging judge ERRORs to the fix budget
// produced false BLOCKEDs; not charging them left the run with no exit at all
// unless this predicate opens one (measured 2026-08-11, modakbul).
// Every recording overwrote one field, so a run that reviewed ten times and a
// run that reviewed once left identical state and identical receipts. Measured
// 2026-08-11: an audited run recorded ten reviews across five adversarial rounds
// and neither state.json nor the receipt held any trace - reconstructing it took
// session-transcript archaeology. PRINCIPLES item 13 wants a harness-owned bound
// on a stage that cannot converge, and a loop the harness cannot count is a loop
// it cannot bound.
test("every accepted review recording is counted as a round; a rejected one is not", () => {
  const projectRoot = initGitRepo();
  const slug = "review-rounds";
  const { logPath, reviewPath } = driveToFidelity(projectRoot, slug, "review-rounds-session");
  const statePath = path.join(projectRoot, "agents", "implement", slug, "state.json");
  const readState = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
  const record = () => runJson(["requirements-review-record", "--status", "pass", "--report", reviewPath, "--summary", "Intent preserved."], projectRoot);

  write(reviewPath, fidelityReviewBody(logPath));
  const first = record();
  assert.deepEqual(first.reviewRounds.fidelity, { rounds: 1, distinctReports: 1 });
  assert.equal(readState().supersededReviews.length, 0, "the live round is not duplicated into the log");
  assert.equal(first.reviewRoundCapNotice, undefined, "inside the bound the harness says nothing");

  // Re-recording the SAME document is still a round the run spent - the harness
  // counts what it observed and does not decide whether it was worth it.
  const second = record();
  assert.deepEqual(second.reviewRounds.fidelity, { rounds: 2, distinctReports: 1 },
    "two rounds, one document: the distinct-report count is what separates them");

  // A different report is a second distinct document.
  write(reviewPath, fidelityReviewBody(logPath, " (revised after the reviewer's note)"));
  const third = record();
  assert.deepEqual(third.reviewRounds.fidelity, { rounds: 3, distinctReports: 2 });
  assert.equal(third.reviewRounds.total, 3);

  // The superseded rounds are recorded once each, in order, with what they were.
  const superseded = readState().supersededReviews;
  assert.equal(superseded.length, 2);
  assert.deepEqual(superseded.map(entry => [entry.kind, entry.status]), [["fidelity", "pass"], ["fidelity", "pass"]]);
  assert.ok(superseded.every(entry => /^[0-9a-f]{64}$/.test(entry.reportSha256) && entry.recordedAt && entry.supersededAt));

  // A REJECTED recording is not a round: it never touches state. Here the report
  // states a verdict contradicting --status, which the harness refuses outright.
  write(reviewPath, fidelityReviewBody(logPath).replace("Status: PASS", "Status: FAIL"));
  const rejected = run(process.execPath, [harness, "requirements-review-record", "--status", "pass", "--report", reviewPath, "--summary", "Claiming a pass."], {
    cwd: projectRoot,
    allowFailure: true,
  });
  assert.notEqual(rejected.status, 0);
  assert.equal(readState().supersededReviews.length, 2, "a refused recording must not be counted as a round");

  // The bound: a fresh adversarial reviewer produces findings on any codebase, so
  // the loop has no fixed point of its own (PRINCIPLES item 13). At the cap the
  // harness redirects - record what is left as follow-ups - and it does so at the
  // moment the agent has just finished a round and is choosing what to do next.
  write(reviewPath, fidelityReviewBody(logPath, " (revised after the reviewer's note)"));
  const fourth = record();
  assert.equal(fourth.reviewRounds.total, 4);
  assert.equal(fourth.reviewRounds.cap, 4);
  assert.equal(fourth.reviewRounds.capReached, true);
  assert.match(fourth.reviewRoundCapNotice, /Review round cap reached: 4 of 4 recorded rounds/);
  assert.match(fourth.reviewRoundCapNotice, /Do not summon another adversarial review round on your own/);
  assert.match(fourth.reviewRoundCapNotice, /record every remaining advisory finding as a follow-up item in the receipt/);
  assert.match(fourth.reviewRoundCapNotice, /If the USER asks for another review round, run it/,
    "the bound stops the autonomous loop, never the human");

  // It redirects and never blocks: a run at the cap must still be able to finish,
  // because a bound that can strand a run is worse than the loop it bounds.
  const finalized = runJson(["finalize", "--status", "complete", "--summary", "Done."], projectRoot);
  assert.equal(finalized.ok, true, JSON.stringify(finalized.violations || []));
  const receipt = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", slug, "receipt.json"), "utf8"));
  assert.equal(receipt.reviewRounds.fidelity.rounds, 4);
  assert.equal(receipt.reviewRounds.capReached, true, "the receipt records that the loop hit its bound");
  const report = fs.readFileSync(path.join(projectRoot, "agents", "implement", slug, "implementation-result.md"), "utf8");
  assert.match(report, /Review rounds recorded: 4\/4 \(cap reached: further rounds were not autonomous\) \(requirements fidelity 4, 2 distinct report\(s\); final 0, 0 distinct report\(s\)\)/);

  // And a fifth round is still recordable - the cap is not a refusal.
  const fifth = record();
  assert.equal(fifth.ok, true, "the cap must never reject a recording");
  assert.equal(fifth.reviewRounds.total, 5);
});

test("judge-error loop reaches a blocked receipt without ever claiming a spent fix budget", () => {
  const projectRoot = initGitRepo();
  const slug = "judge-error-loop";
  write(path.join(projectRoot, "agents", "config.json"), JSON.stringify({ judge: { retryBudget: 2 } }));
  const { logPath, reviewPath } = driveToFidelity(projectRoot, slug, "judge-error-session");

  const emptyGate = { verdict: null, attempts: 0, overridden: false, findings: [], lastRunAt: null, history: [] };
  const errorRecord = {
    ...emptyGate,
    verdict: "ERROR",
    attempts: 0,
    consecutiveErrors: 2,
    lastRunAt: "2026-08-11T09:00:00Z",
    history: [{ at: "2026-08-11T09:00:00Z", verdict: "ERROR", findingCount: 0, requiresHuman: false, error: "judge-invalid-output (backend: claude): criteria missing verdicts for AC1" }],
  };
  write(path.join(projectRoot, "agents", "gates", slug, "gates.json"), JSON.stringify({
    schema: 1,
    topic: slug,
    gates: { "gap-audit": { ...emptyGate }, spec: { ...emptyGate }, verify: errorRecord },
    deviations: [],
    judgeCalls: [],
  }, null, 2));

  // Completion stays impossible, and the refusal must not read as a spent
  // budget: nothing was judged, so nothing about the code has been disproved.
  const complete = runJson(["finalize", "--status", "complete", "--summary", "Not actually complete."], projectRoot, { allowFailure: true });
  assert.equal(complete.ok, false);
  const gateViolation = complete.violations.find(item => /Verify gate is BLOCKED/.test(item));
  assert.ok(gateViolation, JSON.stringify(complete.violations));
  assert.match(gateViolation, /judge backend failed 2 times in a row without returning a verdict/);
  assert.match(gateViolation, /fix budget is untouched at attempts 0\/2/);
  assert.match(gateViolation, /repair the judge/, "the one move that could still reach a real verdict comes first");
  assert.doesNotMatch(gateViolation, /retry budget is exhausted/);

  // The honest review lands (the terminal gate must not veto it) and the
  // blocked receipt is earned - the exit the state change alone did not open.
  write(reviewPath, fidelityReviewBody(logPath));
  const recorded = runJson(["requirements-review-record", "--status", "pass", "--report", reviewPath, "--summary", "Intent preserved; the judge backend never returned a verdict."], projectRoot);
  assert.equal(recorded.ok, true);

  const finalized = runJson(["finalize", "--status", "blocked", "--summary", "Verify gate ERROR: the judge backend failed twice running without a verdict."], projectRoot);
  assert.equal(finalized.ok, true);
  const receipt = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", slug, "receipt.json"), "utf8"));
  assert.equal(receipt.status, "blocked");
  assert.equal(receipt.verifyGate.effective, "BLOCKED");
  assert.equal(receipt.verifyGate.judgeErrorLoop, true, "the terminal cause is recorded distinctly");
  assert.equal(receipt.verifyGate.consecutiveErrors, 2);
  assert.equal(receipt.verifyGate.attempts, 0, "a judge that never answered spent no fix attempts");
  assert.equal(receipt.verifyGate.budgetExhausted, false, "a receipt must never claim a budget it did not spend");

  const report = fs.readFileSync(path.join(projectRoot, "agents", "implement", slug, "implementation-result.md"), "utf8");
  assert.match(report, /Status: Blocked/);
  assert.match(report, /Attempts: 0\/2 \(judge-error loop: 2 consecutive judge failures with no verdict returned, so no criterion was judged and the fix budget is unspent\)/,
    "a human reads the honest cause straight off the record");
  assert.doesNotMatch(report, /retry budget exhausted/);
});

test("readiness precheck blocks a PRD whose Tasks section failed to parse", () => {
  const root = initGitRepo();
  const prdPath = writeApprovedPrd(root, "no-tasks");
  const broken = fs.readFileSync(prdPath, "utf8").replace("## 8. PRD-Level Tasks", "## 8. Tasks");
  fs.writeFileSync(prdPath, broken);
  const result = run(process.execPath, [harness, "plan-verification", "--prd", prdPath], {
    cwd: root,
    allowFailure: true,
  });
  assert.equal(result.status, 2);
  const report = JSON.parse(result.stdout.trim());
  assert.ok(report.blockingGaps.some(gap => gap.code === "no_prd_tasks"),
    `expected no_prd_tasks gap, got: ${JSON.stringify(report.blockingGaps)}`);
});

test("posttool-use hook records side-door rehearsals of contract commands", () => {
  const root = initGitRepo();
  const prd = writeApprovedPrd(root, "rehearsal");
  run(process.execPath, [harness, "init", "--prd", prd, "--review-profile", "trivial"], { cwd: root });
  runJson(["plan-verification"], root);
  const rehearsalsPath = path.join(root, "agents", "implement", "rehearsal", "rehearsals.jsonl");

  const postTool = (command, exitCode) => run(process.execPath, [harness, "hook", "posttool-use"], {
    cwd: root,
    input: JSON.stringify({
      hook_event_name: "PostToolUse",
      cwd: root,
      session_id: "reh-s",
      tool_name: "Bash",
      tool_input: { command },
      tool_response: { exit_code: exitCode },
    }),
  });

  // A failing side-door run of the V1 contract command lands in the ledger.
  postTool('node -e "process.exit(0)"', 1);
  assert.ok(fs.existsSync(rehearsalsPath), "rehearsals.jsonl must be created");
  let entries = fs.readFileSync(rehearsalsPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].verificationId, "V1");
  assert.equal(entries[0].exitCode, 1);

  // A leading `cd <dir> &&` is the dominant rehearsal shape; still V1.
  postTool('cd cli && node -e "process.exit(0)"', 0);
  entries = fs.readFileSync(rehearsalsPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(entries.length, 2);
  assert.equal(entries[1].verificationId, "V1");
  assert.equal(entries[1].exitCode, 0);

  // Unrelated commands and the official verify-run channel stay off the ledger.
  postTool("npm run lint", 1);
  postTool(`node ${harness} verify-run --id V1 -- node -e "process.exit(0)"`, 0);
  entries = fs.readFileSync(rehearsalsPath, "utf8").trim().split("\n");
  assert.equal(entries.length, 2, "non-contract and harness commands must not be recorded");

  // The observer never blocks: stdout stays empty.
  const observed = postTool('node -e "process.exit(0)"', 1);
  assert.equal(observed.stdout.trim(), "");

  // status surfaces the honest history per verification id.
  const status = runJson(["status"], root);
  assert.equal(status.rehearsals.recorded, true);
  assert.deepEqual(status.rehearsals.byVerification.V1, { runs: 3, failures: 2, unknown: 0, lastExitCode: 1 });
});

test("finalize reverifies required command verifications on the final tree", () => {
  const projectRoot = initGitRepo();
  // The sentinel is gitignored: its disappearance is invisible to the review
  // freshness snapshot (like build-output drift), so the receipt-time re-run
  // is the only gate that can catch the regression.
  write(path.join(projectRoot, ".gitignore"), "ok.txt\n");
  run("git", ["add", ".gitignore"], { cwd: projectRoot });
  run("git", ["commit", "-m", "Ignore sentinel"], { cwd: projectRoot });
  const prdPath = writeApprovedPrd(projectRoot, "reverify");
  runJson(["init", "--prd", prdPath, "--review-profile", "trivial", "--session-id", "rev-s"], projectRoot);
  let state = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", "reverify", "state.json"), "utf8"));
  const taskIds = state.tasks.map(task => task.id).join(",");
  runJson(["mark", "--kind", "task", "--id", taskIds, "--status", "complete", "--evidence", "Test nodes completed."], projectRoot);
  runJson(["mark", "--kind", "ac", "--id", "AC1", "--status", "met", "--evidence", "V1 proves AC1."], projectRoot);

  // The official pass depends on a file that exists NOW - a state-dependent check.
  const sentinel = path.join(projectRoot, "ok.txt");
  write(sentinel, "present");
  runJson(["verify-run", "--id", "V1", "--deviation", "equivalent command preserves coverage", "--",
    "node", "-e", "process.exit(require('fs').existsSync('ok.txt') ? 0 : 1)"], projectRoot);

  // Later "task work" changes the visible tree after the recorded pass, so
  // the pass fingerprint goes stale and finalize must actually re-run V1.
  write(path.join(projectRoot, "src", "extra.js"), "// later task work\n");

  state = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", "reverify", "state.json"), "utf8"));
  const logPath = state.verification[0].artifacts[0].path;
  const reviewPath = path.join(projectRoot, "agents", "implement", "reverify", "review", "requirements-fidelity-review.md");
  write(reviewPath, `# Requirements Fidelity Review

Status: PASS

## Intent Sources Read

- agents/prd/reverify/prd.md

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

## Deviation Audit

- none recorded

## Verdict

PASS.
`);
  runJson(["requirements-review-record", "--status", "pass", "--report", reviewPath, "--summary", "PASS"], projectRoot);

  // Code "regresses" after the recorded pass: the sentinel disappears.
  fs.rmSync(sentinel);
  const rejected = runJson(["finalize", "--status", "complete", "--summary", "Should be rejected."], projectRoot, { allowFailure: true });
  assert.equal(rejected.ok, false);
  assert.ok(rejected.violations.some(item => /Final reverification failed: V1/.test(item)),
    `expected reverification violation, got: ${JSON.stringify(rejected.violations)}`);
  assert.equal(rejected.finalReverification.failures.length, 1);
  const reverifyLog = rejected.finalReverification.failures[0].logPath;
  assert.ok(fs.existsSync(path.join(projectRoot, reverifyLog)), "reverify log must be written");

  // Fix the tree; the same finalize now passes and the receipt records the re-run.
  write(sentinel, "restored");
  const finalized = runJson(["finalize", "--status", "complete", "--summary", "Reverified clean."], projectRoot);
  assert.equal(finalized.ok, true);
  const receipt = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", "reverify", "receipt.json"), "utf8"));
  assert.equal(receipt.finalReverification.failures.length, 0);
  assert.equal(receipt.finalReverification.results.length, 1);
  assert.equal(receipt.finalReverification.results[0].id, "V1");
  assert.equal(receipt.finalReverification.results[0].exitCode, 0);
});

test("finalize skips reverification for a pass earned on the unchanged tree", () => {
  const projectRoot = initGitRepo();
  const prdPath = writeApprovedPrd(projectRoot, "reverify-skip");
  runJson(["init", "--prd", prdPath, "--review-profile", "trivial", "--session-id", "skip-s"], projectRoot);
  let state = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", "reverify-skip", "state.json"), "utf8"));
  const taskIds = state.tasks.map(task => task.id).join(",");
  runJson(["mark", "--kind", "task", "--id", taskIds, "--status", "complete", "--evidence", "Test nodes completed."], projectRoot);
  runJson(["mark", "--kind", "ac", "--id", "AC1", "--status", "met", "--evidence", "V1 proves AC1."], projectRoot);
  runJson(["verify-run", "--id", "V1", "--deviation", "equivalent command preserves coverage", "--",
    "node", "-e", "void 0; process.exit(0)"], projectRoot);

  state = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", "reverify-skip", "state.json"), "utf8"));
  const logPath = state.verification[0].artifacts[0].path;
  assert.ok(state.verification[0].artifacts[0].treeFingerprint, "verify-run must stamp a tree fingerprint on the pass");
  const reviewPath = path.join(projectRoot, "agents", "implement", "reverify-skip", "review", "requirements-fidelity-review.md");
  write(reviewPath, `# Requirements Fidelity Review

Status: PASS

## Intent Sources Read

- agents/prd/reverify-skip/prd.md

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

## Deviation Audit

- none recorded

## Verdict

PASS.
`);
  runJson(["requirements-review-record", "--status", "pass", "--report", reviewPath, "--summary", "PASS"], projectRoot);

  // Nothing visible changed since the pass: the honest final-suite-then-finalize
  // flow must cost zero re-runs.
  const finalized = runJson(["finalize", "--status", "complete", "--summary", "Fresh pass, no re-run."], projectRoot);
  assert.equal(finalized.ok, true);
  const receipt = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", "reverify-skip", "receipt.json"), "utf8"));
  assert.equal(receipt.finalReverification.failures.length, 0);
  assert.equal(receipt.finalReverification.results.length, 1);
  assert.match(receipt.finalReverification.results[0].skipped, /fresh pass: worktree unchanged/);
  assert.equal(fs.existsSync(path.join(projectRoot, "agents", "implement", "reverify-skip", "reverify")), false,
    "no reverify log directory when everything was skipped fresh");
});

test("verification pass auto-mets covered acceptance criteria; manual judgments survive", () => {
  const projectRoot = initGitRepo();
  const prdPath = writeApprovedPrd(projectRoot, "auto-ac");
  runJson(["init", "--prd", prdPath, "--review-profile", "trivial", "--session-id", "auto-s"], projectRoot);
  let state = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", "auto-ac", "state.json"), "utf8"));
  const taskIds = state.tasks.map(task => task.id).join(",");
  runJson(["mark", "--kind", "task", "--id", taskIds, "--status", "complete", "--evidence", "Test nodes completed."], projectRoot);

  // No manual ac mark: the covering verification pass must close AC1 itself.
  const verified = runJson(["verify-run", "--id", "V1", "--deviation", "equivalent command preserves coverage", "--",
    "node", "-e", "void 0; process.exit(0)"], projectRoot);
  assert.deepEqual(verified.autoMetAcceptanceCriteria, ["AC1"]);
  state = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", "auto-ac", "state.json"), "utf8"));
  assert.equal(state.acceptanceCriteria[0].status, "met");
  assert.ok(state.acceptanceCriteria[0].evidence.some(entry => /Auto-met: covering verification V1 passed/.test(entry.text)),
    "derived evidence must name the covering pass");
  const status = runJson(["status"], projectRoot);
  assert.equal(status.counts.acOpen, 0);

  // A manual judgment is never overridden: flip to not_met, re-run the pass.
  runJson(["mark", "--kind", "ac", "--id", "AC1", "--status", "not_met", "--evidence", "Human judged the outcome insufficient."], projectRoot);
  const rerun = runJson(["verify-run", "--id", "V1", "--deviation", "equivalent command preserves coverage", "--",
    "node", "-e", "void 0; process.exit(0)"], projectRoot);
  assert.deepEqual(rerun.autoMetAcceptanceCriteria, []);
  state = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", "auto-ac", "state.json"), "utf8"));
  assert.equal(state.acceptanceCriteria[0].status, "not_met");
});

// --- quick-path Stop guard ---

const { freshnessHash } = requireModule(path.join(repoRoot, "cli", "lib", "gate_freshness.js"));
const { judgedDiffSha256 } = requireModule(path.join(repoRoot, "cli", "lib", "git.js"));

const QUICK_CONTRACT = `---
topic: demo
status: active
---

## Goal

Render the widget.

## Acceptance Criteria

- AC1. the widget renders
`;

function makeQuickProject() {
  const root = initGitRepo();
  write(path.join(root, "agents", "quick", "demo", "contract.md"), QUICK_CONTRACT);
  write(
    path.join(root, "agents", "quick", ".quick-active.json"),
    JSON.stringify({ slug: "demo", contractPath: "agents/quick/demo/contract.md", startedAt: "2026-08-08T00:00:00Z" }),
  );
  return root;
}

function quickStop(root, sessionId = "quick-s") {
  const result = run(process.execPath, [harness, "hook", "stop"], {
    cwd: root,
    input: JSON.stringify({ hook_event_name: "Stop", cwd: root, session_id: sessionId }),
  });
  return result.stdout.trim();
}

function writeQuickGates(root, verifyRecord) {
  write(
    path.join(root, "agents", "gates", "demo", "gates.json"),
    JSON.stringify({
      schema: 1,
      topic: "demo",
      gates: {
        "gap-audit": { verdict: null, attempts: 0, overridden: false, findings: [], lastRunAt: null, history: [] },
        spec: { verdict: null, attempts: 0, overridden: false, findings: [], lastRunAt: null, history: [] },
        verify: { attempts: 0, overridden: false, findings: [], lastRunAt: null, history: [], ...verifyRecord },
      },
      deviations: [],
      judgeCalls: [],
    }),
  );
}

function passRecord(root) {
  const contract = fs.readFileSync(path.join(root, "agents", "quick", "demo", "contract.md"), "utf8");
  const base = run("git", ["rev-parse", "HEAD"], { cwd: root }).stdout.trim();
  return {
    verdict: "PASS",
    inputs: [{ path: "agents/quick/demo/contract.md", sha256: freshnessHash(contract) }],
    diffSource: `git:${base}`,
    judgedDiffSha256: judgedDiffSha256(root, base),
  };
}

test("quick guard blocks a stop before verify has run, and claims the session", () => {
  const root = makeQuickProject();
  const directive = JSON.parse(quickStop(root));
  assert.equal(directive.decision, "block");
  assert.match(directive.reason, /verify gate has not run/);
  assert.match(directive.reason, /sasu verify --slug demo --contract agents\/quick\/demo\/contract\.md --json/);
  const marker = JSON.parse(fs.readFileSync(path.join(root, "agents", "quick", ".quick-active.json"), "utf8"));
  assert.equal(marker.activeSessionId, "quick-s");
  // A foreign session must be told, not silently released: a stray hook
  // firing in this directory would otherwise disarm the guard for the owner.
  const foreign = JSON.parse(quickStop(root, "other-session"));
  assert.equal(foreign.decision, "block");
  assert.match(foreign.reason, /owned by another session/);
  assert.match(foreign.reason, /quick-s/);
});

test("quick guard demands finalization on a live PASS, and silence once the marker is gone", () => {
  const root = makeQuickProject();
  writeQuickGates(root, passRecord(root));
  const directive = JSON.parse(quickStop(root));
  assert.equal(directive.decision, "block");
  assert.match(directive.reason, /receipt\.md/);
  assert.match(directive.reason, /status: complete/);
  fs.rmSync(path.join(root, "agents", "quick", ".quick-active.json"));
  assert.equal(quickStop(root), "", "no marker means no quick guard");
});

test("quick guard re-opens a PASS when the code changed after it", () => {
  const root = makeQuickProject();
  writeQuickGates(root, passRecord(root));
  write(path.join(root, "src.txt"), "edited after the pass");
  const directive = JSON.parse(quickStop(root));
  assert.equal(directive.decision, "block");
  assert.match(directive.reason, /change under judgment is no longer the one that passed/);
  assert.match(directive.reason, /Re-run verification/);
});

test("quick guard demands a re-run when the recorded pin cannot be compared, and never crashes", () => {
  const root = makeQuickProject();
  // A pin that does not match what the tree produces now - the shape a
  // pre-field gates.json has, where the retired tree fingerprint object sits
  // where a sha256 belongs. The guard must demand one honest re-run rather than
  // accept the pass or throw.
  for (const unusable of ["deadbeef".repeat(8), { headSha: "abc123", statusHash: "deadbeef" }]) {
    writeQuickGates(root, { ...passRecord(root), judgedDiffSha256: unusable });
    const directive = JSON.parse(quickStop(root));
    assert.equal(directive.decision, "block", JSON.stringify(unusable));
    assert.match(directive.reason, /Re-run verification/, JSON.stringify(unusable));
  }

  // And with no pin at all the guard makes no claim either way: it cannot
  // compare, so it must not invent drift.
  const noPin = passRecord(root);
  delete noPin.judgedDiffSha256;
  writeQuickGates(root, noPin);
  assert.doesNotMatch(JSON.parse(quickStop(root)).reason, /no longer the one that passed/);
});

test("quick guard re-opens a PASS when the contract changed after it", () => {
  const root = makeQuickProject();
  writeQuickGates(root, passRecord(root));
  const contractPath = path.join(root, "agents", "quick", "demo", "contract.md");
  write(contractPath, fs.readFileSync(contractPath, "utf8").replace("- AC1. the widget renders", "- AC1. the widget renders twice"));
  const directive = JSON.parse(quickStop(root));
  assert.equal(directive.decision, "block");
  assert.match(directive.reason, /changed after the pass/);
});

test("quick guard drives the fix loop inside the budget, then switches to handoff instead of another verify", () => {
  const root = makeQuickProject();
  const finding = { area: "semantic", severity: "P0", missing: "AC1: no render in diff", recommendation: "add it", requiresHuman: false };
  writeQuickGates(root, { verdict: "FAIL", attempts: 1, findings: [finding] });
  const directive = JSON.parse(quickStop(root));
  assert.equal(directive.decision, "block");
  assert.match(directive.reason, /attempt 1\/3/);
  assert.match(directive.reason, /AC1: no render in diff/);
  assert.match(directive.reason, /sasu verify/, "inside the budget the guard asks for another verify");

  // Ending the loop is not ending the run: both exits still owe the receipt.
  writeQuickGates(root, { verdict: "FAIL", attempts: 3, findings: [finding] });
  const exhausted = JSON.parse(quickStop(root));
  assert.match(exhausted.reason, /exhausted its 3-attempt verify budget/);
  assert.ok(!/Fix the findings and re-run/.test(exhausted.reason), "an exhausted budget must stop driving the fix loop");

  writeQuickGates(root, { verdict: "BLOCK", attempts: 1, findings: [{ ...finding, requiresHuman: true }] });
  assert.match(JSON.parse(quickStop(root)).reason, /needs human verification/);
});

// A judge that never returns a verdict is the one failure the fix loop cannot
// fix, and it is also the one that cannot end the loop by spending the budget -
// judge ERRORs deliberately leave `attempts` alone. Without the third exit the
// guard demands `sasu verify` forever (measured 2026-08-11, modakbul: 4 of 10
// verify attempts lost to judge-invalid-output, 0 criterion FAILs).
test("quick guard ends the loop on a judge-error streak, without claiming a spent budget", () => {
  const root = makeQuickProject();
  // One error is not a loop: the guard still asks for the re-run that may work.
  writeQuickGates(root, { verdict: "ERROR", attempts: 0, consecutiveErrors: 1, findings: [] });
  const retrying = JSON.parse(quickStop(root));
  assert.equal(retrying.decision, "block");
  assert.match(retrying.reason, /sasu verify/, "below the bound the guard still drives a re-run");

  // At the bound it stops driving and names the honest cause.
  writeQuickGates(root, { verdict: "ERROR", attempts: 0, consecutiveErrors: 3, findings: [] });
  const terminal = JSON.parse(quickStop(root));
  assert.match(terminal.reason, /3 consecutive judge failures/);
  assert.match(terminal.reason, /fix budget is untouched at 0\/3/, "a directive must never claim a budget it did not spend");
  assert.match(terminal.reason, /backend failure, not a verification failure/);
  assert.match(terminal.reason, /status: blocked/, "the run closes out as blocked, not as complete-with-open-items");
  assert.ok(!/Fix the findings and re-run/.test(terminal.reason), "there are no findings to fix");
  assert.ok(!/exhausted its 3-attempt verify budget/.test(terminal.reason));
});

test("quick guard treats a user override as passable and demands finalization", () => {
  const root = makeQuickProject();
  writeQuickGates(root, { verdict: "FAIL", attempts: 2, overridden: true, findings: [] });
  const directive = JSON.parse(quickStop(root));
  assert.equal(directive.decision, "block");
  assert.match(directive.reason, /receipt\.md/);
});

test("quick guard closes out a human-verification run instead of letting it vanish", () => {
  const root = makeQuickProject();
  const pass = passRecord(root);
  writeQuickGates(root, {
    verdict: "FAIL",
    attempts: 1,
    findings: [{
      area: "human-verification",
      severity: "P0",
      missing: "AC2: declared human-verified - compare against the printed mock",
      recommendation: "Confirm AC2 yourself and report the result; no judge can settle it.",
      requiresHuman: true,
    }],
    inputs: pass.inputs,
  });
  const directive = JSON.parse(quickStop(root));
  assert.equal(directive.decision, "block", "a human handoff still owes the user a receipt and a clean marker");
  assert.match(directive.reason, /needs human verification/);
  assert.match(directive.reason, /compare against the printed mock/);
  assert.match(directive.reason, /receipt\.md/);
  assert.match(directive.reason, /Do not call the run Done/);

  // Doing the finalize work - not deleting the marker - is what ends the run.
  write(path.join(root, "agents", "quick", "demo", "receipt.md"), "# receipt\n");
  const stillOpen = JSON.parse(quickStop(root));
  assert.match(stillOpen.reason, /status: complete/, "the receipt alone must not close the run");
  assert.ok(!/receipt\.md/.test(stillOpen.reason), "a step already done must drop off the list");

  const contractPath = path.join(root, "agents", "quick", "demo", "contract.md");
  write(contractPath, fs.readFileSync(contractPath, "utf8").replace("status: active", "status: complete"));
  assert.equal(quickStop(root), "", "once the run is closed out the guard is silent");
  assert.equal(
    fs.existsSync(path.join(root, "agents", "quick", ".quick-active.json")),
    false,
    "the guard retires the marker itself, so deleting it can never be the shortcut",
  );
});

test("quick guard closes out an exhausted budget as an honest blocked run", () => {
  const root = makeQuickProject();
  writeQuickGates(root, {
    verdict: "FAIL",
    attempts: 3,
    findings: [{ area: "semantic", severity: "P0", missing: "AC1: still not implemented", recommendation: "fix", requiresHuman: false }],
    inputs: passRecord(root).inputs,
  });
  const directive = JSON.parse(quickStop(root));
  assert.equal(directive.decision, "block");
  assert.match(directive.reason, /exhausted its 3-attempt verify budget/);
  assert.match(directive.reason, /receipt\.md/);
  // A run that failed verification must not be told to record itself
  // complete; only the exhausted budget (never budget remaining, which stays
  // in the fix loop above) unlocks the blocked contract status.
  assert.match(directive.reason, /status: blocked/);
  assert.ok(!/status: complete/.test(directive.reason), "an exhausted budget must not demand a lying `complete`");

  // Doing the honest close-out - receipt plus a `blocked` contract - is what
  // ends the run; frontmatter is outside the freshness hash, so the flip
  // cannot stale the recorded verdict's evidence pins.
  write(path.join(root, "agents", "quick", "demo", "receipt.md"), "# receipt\n");
  const contractPath = path.join(root, "agents", "quick", "demo", "contract.md");
  write(contractPath, fs.readFileSync(contractPath, "utf8").replace("status: active", "status: blocked"));
  assert.equal(quickStop(root), "", "an honest blocked close-out releases the guard");
  assert.equal(
    fs.existsSync(path.join(root, "agents", "quick", ".quick-active.json")),
    false,
    "the guard retires the marker on the blocked close-out too",
  );
});

test("quick guard refuses to close out a handoff whose evidence drifted", () => {
  const root = makeQuickProject();
  write(path.join(root, "agents", "quick", "demo", "evidence", "api.json"), '{"status":200}');
  const evidencePath = "agents/quick/demo/evidence/api.json";
  const { sha256Of } = requireModule(path.join(repoRoot, "cli", "lib", "gate_freshness.js"));
  writeQuickGates(root, {
    verdict: "FAIL",
    attempts: 1,
    findings: [{ area: "human-verification", severity: "P0", missing: "AC2: human", recommendation: "check it", requiresHuman: true }],
    inputs: [{ path: evidencePath, sha256: sha256Of(fs.readFileSync(path.join(root, evidencePath))), kind: "evidence" }],
  });
  assert.match(JSON.parse(quickStop(root)).reason, /needs human verification/, "a matching artifact closes out normally");

  write(path.join(root, evidencePath), '{"status":500}');
  const directive = JSON.parse(quickStop(root));
  assert.match(directive.reason, /evidence no longer matches/);
  assert.match(directive.reason, /api\.json changed after the verdict/);
});

test("hooks stay silent inside a judge subprocess so the judge is never derailed", () => {
  const root = makeQuickProject();
  // Sanity: this state does block a normal session.
  assert.equal(JSON.parse(quickStop(root)).decision, "block");
  fs.rmSync(path.join(root, "agents", "quick", ".quick-active.json"));
  write(
    path.join(root, "agents", "quick", ".quick-active.json"),
    JSON.stringify({ slug: "demo", contractPath: "agents/quick/demo/contract.md" }),
  );

  // A judge call is a full CLI session in this project, so the user's hooks
  // fire inside it. Answering there both corrupts the judge's reply and lets
  // its session id claim the marker, locking out the agent that asked.
  const judged = run(process.execPath, [harness, "hook", "stop"], {
    cwd: root,
    input: JSON.stringify({ hook_event_name: "Stop", cwd: root, session_id: "judge-session" }),
    env: { ...process.env, SASU_JUDGE_SUBPROCESS: "1" },
  });
  assert.equal(judged.stdout.trim(), "", "a judge subprocess must get no directive");
  const marker = JSON.parse(fs.readFileSync(path.join(root, "agents", "quick", ".quick-active.json"), "utf8"));
  assert.equal(marker.activeSessionId, undefined, "the judge must not claim the run marker");

  // The owning session still gets its directive afterwards.
  assert.equal(JSON.parse(quickStop(root)).decision, "block");
});

// --- workspace digest guard (5a) and AC oracles (5c) ---

test("verify-run digest guard demotes an exit-0 pass whose command mutated the workspace", () => {
  const projectRoot = initGitRepo();
  const prdPath = writeApprovedPrd(projectRoot, "digest-guard");
  runJson(["init", "--prd", prdPath, "--review-profile", "trivial"], projectRoot);
  // Exit 0, but the command edits a tracked file: the classic reward-hacking
  // shape (verifier fixes the code it judges).
  const mutating = ["bash", "-c", "echo dirty >> README.md"];
  const result = run(process.execPath, [harness, "verify-run", "--id", "V1", "--deviation", "guard test", "--", ...mutating], {
    cwd: projectRoot,
    allowFailure: true,
  });
  assert.equal(result.status, 2, result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.status, "fail");
  assert.equal(parsed.exitCode, 0, "the command itself succeeded; the guard is what failed it");
  assert.equal(parsed.digestGuard.violated, true);
  assert.deepEqual(parsed.digestGuard.changedPaths, ["~README.md"], "the guard names the moved paths, not just a boolean");
  assert.ok(!("entries" in (parsed.digestGuard.before || {})), "per-path entries must never be persisted");
  const state = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", "digest-guard", "state.json"), "utf8"));
  const v1 = state.verification.find(item => item.id === "V1");
  assert.equal(v1.status, "fail");
  assert.match(v1.evidence.at(-1).text, /MUTATED the workspace/);
  assert.match(v1.evidence.at(-1).text, /~README\.md/, "the evidence line names the violating path");
  const artifact = v1.artifacts.at(-1);
  assert.equal(artifact.treeFingerprint, null, "a demoted pass must not pin a fresh fingerprint");
});

test("verify-run digest guard is skipped for a contract-declared side effect, on the record", () => {
  const projectRoot = initGitRepo();
  const prdPath = writeApprovedPrd(projectRoot, "digest-side-effect");
  // Declare the side effect in the 9.2 matrix so the guard opt-out is the
  // PRD's decision, not the runner's.
  const prdText = fs.readFileSync(prdPath, "utf8")
    .replace(
      "| ID | Mode | Covers | Method | Artifact | Pass Intent | Required For Done | Can Be Blocked |",
      "| ID | Mode | Covers | Method | Artifact | Pass Intent | Required For Done | Can Be Blocked | Side Effect |",
    )
    .replace(
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    )
    .replace(
      '| V1 | build/static | R1, AC1, T1 | \`node -e "process.exit(0)"\` | command-log | command exits zero | yes | no |',
      '| V1 | build/static | R1, AC1, T1 | \`node -e "process.exit(0)"\` | command-log | command exits zero | yes | no | writes fixture data |',
    );
  fs.writeFileSync(prdPath, prdText);
  runJson(["init", "--prd", prdPath, "--review-profile", "trivial"], projectRoot);
  const mutating = ["bash", "-c", "echo dirty >> README.md"];
  const result = runJson(["verify-run", "--id", "V1", "--deviation", "side effect test", "--", ...mutating], projectRoot);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.digestGuard.skipped, /writes fixture data/);
});

test("finalize reverification digest guard fails a re-run whose command mutates the tree", () => {
  const projectRoot = initGitRepo();
  const prdPath = writeApprovedPrd(projectRoot, "reverify-guard");
  runJson(["init", "--prd", prdPath, "--review-profile", "trivial"], projectRoot);
  // A command that mutates only on the SECOND run (finalize's re-run), so the
  // recorded pass is honest and the reverification is the mutating one. The
  // flag lives outside the project so arming it does not trip the guard on
  // the first run.
  const flagPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "reverify-flag-")), "mutated.flag");
  const flaky = ["bash", "-c", `if [ -f ${flagPath} ]; then echo dirty >> README.md; else touch ${flagPath}; fi`];
  const first = runJson(["verify-run", "--id", "V1", "--deviation", "reverify guard test", "--", ...flaky], projectRoot);
  assert.equal(first.ok, true, JSON.stringify(first.digestGuard));
  run("git", ["add", "-A"], { cwd: projectRoot });
  run("git", ["commit", "-m", "work"], { cwd: projectRoot });
  // Real source drift after the recorded pass: the fingerprint is
  // content-based, so the commit alone would read as fresh and skip the
  // re-run - and the digest guard only fires on a re-run that happens.
  fs.appendFileSync(path.join(projectRoot, "README.md"), "\ndrift after the pass\n");
  runJson(["mark", "--kind", "task", "--id", "T1", "--status", "complete", "--ac", "AC1", "--evidence", "done"], projectRoot);
  const reviewDir = path.join(projectRoot, "agents", "implement", "reverify-guard", "review");
  write(path.join(reviewDir, "requirements-fidelity-review.md"), [
    "# Requirements Fidelity Review", "", "Status: PASS", "", "## Fidelity", "", "- ok", "",
  ].join("\n"));
  runJson(["requirements-review-record", "--status", "pass", "--report", path.join(reviewDir, "requirements-fidelity-review.md"), "--summary", "ok"], projectRoot);
  const result = run(process.execPath, [harness, "finalize", "--status", "complete", "--summary", "done"], {
    cwd: projectRoot,
    allowFailure: true,
  });
  assert.equal(result.status, 2, result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.ok(
    parsed.violations.some(v => /digest guard/.test(v) && /mutated the workspace/.test(v)),
    JSON.stringify(parsed.violations, null, 2),
  );
  assert.ok(
    parsed.violations.some(v => /changed: ~README\.md/.test(v)),
    `the finalize violation must name the moved paths: ${JSON.stringify(parsed.violations, null, 2)}`,
  );
});

test("oracle-run settles Check and Artifact oracles mechanically and records evidence", () => {
  const projectRoot = initGitRepo();
  const prdPath = writeApprovedPrd(projectRoot, "oracle-run");
  const prdText = fs.readFileSync(prdPath, "utf8").replace(
    "- AC1. V1 passes with a command-log artifact.",
    [
      "- AC1. V1 passes with a command-log artifact.",
      '- AC2. The oracle marker prints. Check: \`node -e "console.log(\'MARKER OK\')"\` -> MARKER OK',
      "- AC3. The report artifact exists. Artifact: out/report.txt",
    ].join("\n"),
  );
  fs.writeFileSync(prdPath, prdText);
  runJson(["init", "--prd", prdPath, "--review-profile", "trivial"], projectRoot);
  const state = () => JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", "oracle-run", "state.json"), "utf8"));
  assert.equal(state().acceptanceCriteria.find(ac => ac.id === "AC2").oracle.kind, "check");

  // First sweep: the check passes, the artifact is missing.
  const first = run(process.execPath, [harness, "oracle-run"], { cwd: projectRoot, allowFailure: true });
  assert.equal(first.status, 2);
  const firstParsed = JSON.parse(first.stdout);
  assert.equal(firstParsed.ran, 2);
  const ac2 = state().acceptanceCriteria.find(ac => ac.id === "AC2");
  assert.equal(ac2.status, "met");
  assert.match(ac2.evidence.at(-1).text, /harness ran/);
  assert.ok(ac2.artifacts.length >= 1, "the check oracle records a command-log artifact");
  assert.equal(state().acceptanceCriteria.find(ac => ac.id === "AC3").status, "not_met");

  // Produce the artifact and narrow the sweep to AC3: it flips to met.
  write(path.join(projectRoot, "out", "report.txt"), "report");
  const second = runJson(["oracle-run", "--id", "AC3"], projectRoot);
  assert.equal(second.ok, true);
  assert.equal(state().acceptanceCriteria.find(ac => ac.id === "AC3").status, "met");
});

test("oracle-run digest guard records not_met when the oracle command mutates the tree", () => {
  const projectRoot = initGitRepo();
  const prdPath = writeApprovedPrd(projectRoot, "oracle-guard");
  const prdText = fs.readFileSync(prdPath, "utf8").replace(
    "- AC1. V1 passes with a command-log artifact.",
    [
      "- AC1. V1 passes with a command-log artifact.",
      '- AC2. The self-fixing check passes. Check: \`bash -c "echo dirty >> README.md"\`',
    ].join("\n"),
  );
  fs.writeFileSync(prdPath, prdText);
  runJson(["init", "--prd", prdPath, "--review-profile", "trivial"], projectRoot);
  const result = run(process.execPath, [harness, "oracle-run"], { cwd: projectRoot, allowFailure: true });
  assert.equal(result.status, 2);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.results[0].digestViolation, true);
  assert.deepEqual(parsed.results[0].changedPaths, ["~README.md"], "the oracle guard names the moved paths");
  const state = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", "oracle-guard", "state.json"), "utf8"));
  const ac2 = state.acceptanceCriteria.find(ac => ac.id === "AC2");
  assert.equal(ac2.status, "not_met");
  assert.match(ac2.evidence.at(-1).text, /MUTATED the workspace/);
  assert.match(ac2.evidence.at(-1).text, /~README\.md/, "the evidence line names the violating path");
});

// --- oracle enforcement (verifier-confirmed defects, 2026-08 adversarial audit) ---

function writeOraclePrd(projectRoot, slug, acLine) {
  const prdPath = writeApprovedPrd(projectRoot, slug);
  const prdText = fs.readFileSync(prdPath, "utf8").replace(
    "- AC1. V1 passes with a command-log artifact.",
    ["- AC1. V1 passes with a command-log artifact.", acLine].join("\n"),
  );
  fs.writeFileSync(prdPath, prdText);
  return prdPath;
}

test("oracle-run default sweep re-observes a not_met oracle once the world is fixed (F3)", () => {
  const projectRoot = initGitRepo();
  const prdPath = writeOraclePrd(projectRoot, "oracle-resweep", "- AC2. The report exists. Artifact: out/report.txt");
  runJson(["init", "--prd", prdPath, "--review-profile", "trivial"], projectRoot);
  const first = run(process.execPath, [harness, "oracle-run"], { cwd: projectRoot, allowFailure: true });
  assert.equal(first.status, 2);
  // Fix the world; the documented bare sweep (no --id) must re-observe the
  // failed oracle instead of returning {ok:true, ran:0} forever.
  write(path.join(projectRoot, "out", "report.txt"), "report");
  const second = runJson(["oracle-run"], projectRoot);
  assert.equal(second.ran, 1, "the not_met oracle must be back in the default sweep");
  assert.equal(second.ok, true);
  const ac2 = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", "oracle-resweep", "state.json"), "utf8"))
    .acceptanceCriteria.find(ac => ac.id === "AC2");
  assert.equal(ac2.status, "met");
  assert.equal(ac2.oracleObservation.met, true, "the flip carries a fresh harness-recorded observation");
});

test("mark cannot met an oracle-backed AC, directly or via task co-mark (F4a)", () => {
  const projectRoot = initGitRepo();
  const prdPath = writeOraclePrd(projectRoot, "oracle-exclusive", '- AC2. The failing check passes. Check: `node -e "process.exit(1)"`');
  runJson(["init", "--prd", prdPath, "--review-profile", "trivial"], projectRoot);
  run(process.execPath, [harness, "oracle-run"], { cwd: projectRoot, allowFailure: true });

  const direct = run(process.execPath, [harness, "mark", "--kind", "ac", "--id", "AC2", "--status", "met", "--evidence", "trust me"], {
    cwd: projectRoot,
    allowFailure: true,
  });
  assert.equal(direct.status, 1, "a manual met must not override the oracle's not_met");
  assert.match(direct.stderr, /oracle-run --id AC2/);

  const coMark = run(process.execPath, [harness, "mark", "--kind", "task", "--id", "T1", "--status", "complete", "--ac", "AC2", "--evidence", "done"], {
    cwd: projectRoot,
    allowFailure: true,
  });
  assert.equal(coMark.status, 1, "the task co-mark must not be a side door to a manual met");
  assert.match(coMark.stderr, /oracle-run --id AC2/);

  const state = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", "oracle-exclusive", "state.json"), "utf8"));
  assert.equal(state.acceptanceCriteria.find(ac => ac.id === "AC2").status, "not_met");

  // Pessimistic manual judgments stay allowed - closing down is never a bypass.
  const blocked = runJson(["mark", "--kind", "ac", "--id", "AC2", "--status", "blocked", "--evidence", "blocked on infra"], projectRoot);
  assert.equal(blocked.ok, true);
});

test("incidental V coverage does not auto-met an oracle-backed AC (F4b)", () => {
  const projectRoot = initGitRepo();
  const prdPath = writeOraclePrd(projectRoot, "oracle-autoclose", "- AC2. The report exists. Artifact: out/report.txt");
  // Make V1 cover the oracle AC too: the covering pass must still not close it.
  const prdText = fs.readFileSync(prdPath, "utf8").replace("| V1 | build/static | R1, AC1, T1 |", "| V1 | build/static | R1, AC1, AC2, T1 |");
  fs.writeFileSync(prdPath, prdText);
  runJson(["init", "--prd", prdPath, "--review-profile", "trivial"], projectRoot);
  const result = runJson(["verify-run", "--id", "V1", "--deviation", "autoclose test", "--", "node", "-e", "process.exit(0)"], projectRoot);
  assert.equal(result.ok, true);
  assert.ok(result.autoMetAcceptanceCriteria.includes("AC1"), "the plain AC still auto-closes on coverage");
  assert.ok(!result.autoMetAcceptanceCriteria.includes("AC2"), "the oracle AC must wait for oracle-run");
  const state = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", "oracle-autoclose", "state.json"), "utf8"));
  assert.equal(state.acceptanceCriteria.find(ac => ac.id === "AC2").status, "pending");
});

test("finalize accepts a met oracle AC through its recorded observation and needs no V-row coverage (F1)", () => {
  const projectRoot = initGitRepo();
  const prdPath = writeOraclePrd(projectRoot, "oracle-finalize", '- AC2. The marker prints. Check: `node -e "console.log(\'MARKER OK\')"` -> MARKER OK');
  runJson(["init", "--prd", prdPath, "--review-profile", "trivial"], projectRoot);
  runJson(["verify-run", "--id", "V1", "--deviation", "finalize test", "--", "node", "-e", "process.exit(0)"], projectRoot);
  runJson(["oracle-run"], projectRoot);
  runJson(["mark", "--kind", "task", "--id", "T1", "--status", "complete", "--ac", "AC1", "--evidence", "done"], projectRoot);
  const reviewDir = path.join(projectRoot, "agents", "implement", "oracle-finalize", "review");
  write(path.join(reviewDir, "requirements-fidelity-review.md"), [
    "# Requirements Fidelity Review", "", "Status: PASS", "", "## Fidelity", "", "- ok", "",
  ].join("\n"));
  runJson(["requirements-review-record", "--status", "pass", "--report", path.join(reviewDir, "requirements-fidelity-review.md"), "--summary", "ok"], projectRoot);
  const finalize = runJson(["finalize", "--status", "complete", "--summary", "done"], projectRoot);
  assert.equal(finalize.ok, true, `oracle-backed AC must not deadlock finalize: ${JSON.stringify(finalize)}`);
});

test("finalize rejects a met oracle AC whose observation trail is missing (F1 evidence)", () => {
  const projectRoot = initGitRepo();
  const prdPath = writeOraclePrd(projectRoot, "oracle-tamper", '- AC2. The marker prints. Check: `node -e "console.log(\'MARKER OK\')"` -> MARKER OK');
  runJson(["init", "--prd", prdPath, "--review-profile", "trivial"], projectRoot);
  runJson(["verify-run", "--id", "V1", "--deviation", "tamper test", "--", "node", "-e", "process.exit(0)"], projectRoot);
  runJson(["mark", "--kind", "task", "--id", "T1", "--status", "complete", "--ac", "AC1", "--evidence", "done"], projectRoot);
  // Simulate the bypass the guard exists for: met status written into state
  // without the oracle ever running (mark rejects this path, so edit directly).
  const statePath = path.join(projectRoot, "agents", "implement", "oracle-tamper", "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const ac2 = state.acceptanceCriteria.find(ac => ac.id === "AC2");
  ac2.status = "met";
  ac2.evidence.push({ ts: new Date().toISOString(), text: "hand-written pass" });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  // The guard fires everywhere completionViolations runs: the fidelity review
  // record already rejects on the evidence-free met, and finalize stays shut.
  const reviewDir = path.join(projectRoot, "agents", "implement", "oracle-tamper", "review");
  write(path.join(reviewDir, "requirements-fidelity-review.md"), [
    "# Requirements Fidelity Review", "", "Status: PASS", "", "## Fidelity", "", "- ok", "",
  ].join("\n"));
  const record = run(process.execPath, [harness, "requirements-review-record", "--status", "pass", "--report", path.join(reviewDir, "requirements-fidelity-review.md"), "--summary", "ok"], {
    cwd: projectRoot,
    allowFailure: true,
  });
  assert.equal(record.status, 2, "the review record must already reject the evidence-free met");
  const finalize = run(process.execPath, [harness, "finalize", "--status", "complete", "--summary", "done"], {
    cwd: projectRoot,
    allowFailure: true,
  });
  assert.equal(finalize.status, 2);
  const parsed = JSON.parse(finalize.stdout);
  assert.ok(
    parsed.violations.some(v => /AC2.*no recorded passing observation.*oracle-run --id AC2/.test(v)),
    JSON.stringify(parsed.violations, null, 2),
  );
});

test("gate and harness oracle executors agree on an operator-bearing Check command (F2)", { skip: !fs.existsSync(path.join(repoRoot, "cli", "dist", "gates", "commands.js")) && "cli/dist not built" }, () => {
  const projectRoot = initGitRepo();
  // Under a real shell this prints 1 and passes (README.md contains "Test");
  // without a shell `test` receives "&&" as a literal argument and fails.
  // Both executors must fail it the same way - the gate used to run a shell
  // and PASS while the harness recorded not_met for the same declared oracle.
  const command = "test -f README.md && grep -c Test README.md";
  const prdPath = writeOraclePrd(projectRoot, "oracle-parity", `- AC2. Marker greps. Check: \`${command}\` -> 1`);
  runJson(["init", "--prd", prdPath, "--review-profile", "trivial"], projectRoot);
  const harnessRun = run(process.execPath, [harness, "oracle-run"], { cwd: projectRoot, allowFailure: true });
  assert.equal(harnessRun.status, 2);
  const harnessResult = JSON.parse(harnessRun.stdout).results[0];
  assert.equal(harnessResult.met, false);
  assert.notEqual(harnessResult.exitCode, 0);

  const { runAcOracles } = requireModule(path.join(repoRoot, "cli", "dist", "gates", "commands.js"));
  const { loadConfig } = requireModule(path.join(repoRoot, "cli", "dist", "config.js"));
  const gateStage = runAcOracles(projectRoot, loadConfig(projectRoot), [
    { id: "AC2", text: "Marker greps.", oracle: { kind: "check", command, expect: "1" } },
  ]);
  assert.equal(gateStage.outcomes[0].met, false, "gate must agree with the harness: operators are not interpreted");
  assert.notEqual(gateStage.outcomes[0].exitCode, 0);

  // Positive parity: a plain tokenizable command passes at the gate exactly
  // like the harness ("oracle-run settles Check and Artifact oracles" above
  // pins the harness side of this same command).
  const plain = { id: "AC2", text: "Marker prints.", oracle: { kind: "check", command: `node -e "console.log('MARKER OK')"`, expect: "MARKER OK" } };
  const gatePlain = runAcOracles(projectRoot, loadConfig(projectRoot), [plain]);
  assert.equal(gatePlain.outcomes[0].met, true);
});
