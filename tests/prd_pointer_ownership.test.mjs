// Active-pointer ownership: cross-session state hijack must be a hard error.
//
// Live-session evidence: two concurrent sessions in one checkout. Session P
// ran `init` (pointer -> pokemon); session T's later activity re-pointed
// `agents/implement/.prd-implement-active.json` back to tetris; P's subsequent
// UN-pinned `reconcile`/`status` silently operated on TETRIS state and only
// no-op'd by luck. The agent survived by pinning --state on every call -
// discipline where code should refuse. These tests pin the refusal contract:
// same-session unpinned access stays frictionless, foreign-owned pointers
// refuse mutations, read-only status warns, and the no-identity fallback
// refuses only when more than one run exists.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const harness = path.join(repoRoot, "skills", "implement", "scripts", "prd_state_harness.js");

const SESSION_ENV_KEYS = ["CODEX_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID"];

// Session identity is env-derived, so every spawn controls it explicitly:
// null strips all identity, a string impersonates that session.
function sessionEnv(sessionId) {
  const env = { ...process.env };
  for (const key of SESSION_ENV_KEYS) delete env[key];
  if (sessionId) env.CLAUDE_CODE_SESSION_ID = sessionId;
  return env;
}

function run(args, cwd, { sessionId = null, allowFailure = false } = {}) {
  const result = spawnSync(process.execPath, [harness, ...args], {
    cwd,
    shell: false,
    encoding: "utf8",
    env: sessionEnv(sessionId),
    maxBuffer: 20 * 1024 * 1024,
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error([
      `Command failed: ${args.join(" ")}`,
      `cwd: ${cwd}`,
      `exitCode: ${result.status}`,
      result.stdout ? `stdout:\n${result.stdout}` : "",
      result.stderr ? `stderr:\n${result.stderr}` : "",
    ].filter(Boolean).join("\n"));
  }
  return result;
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`);
}

function initGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pointer-ownership-"));
  const git = args => spawnSync("git", args, { cwd: dir, shell: false, encoding: "utf8" });
  git(["init", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Ownership Test"]);
  git(["config", "commit.gpgsign", "false"]);
  write(path.join(dir, "README.md"), "# Test Repo\n");
  git(["add", "README.md"]);
  git(["commit", "-m", "Initial"]);
  return dir;
}

function writeApprovedPrd(projectRoot, slug) {
  const prd = `---
topic: "${slug}"
status: "ready"
human_approval: "approved"
source_intake: "current conversation"
source_clarity: "none"
created_at: "2026-08-10"
updated_at: "2026-08-10"
---

# PRD: ${slug}

## 1. Summary

Implement a small test behavior.

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

function readPointer(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "agents", "implement", ".prd-implement-active.json"), "utf8"));
}

test("foreign-owned pointer: unpinned mutation refuses, --state works, ownership follows the last writer", () => {
  const root = initGitRepo();
  const prdA = writeApprovedPrd(root, "run-a");
  const prdB = writeApprovedPrd(root, "run-b");
  run(["init", "--prd", prdA, "--review-profile", "trivial"], root, { sessionId: "session-a" });
  run(["init", "--prd", prdB, "--review-profile", "trivial"], root, { sessionId: "session-b" });

  // The pointer carries the last writer's identity stamp.
  const pointer = readPointer(root);
  assert.match(pointer.statePath, /run-b\/state\.json$/);
  assert.equal(pointer.owner.sessionId, "session-b");
  assert.equal(typeof pointer.owner.pid, "number");
  assert.equal(typeof pointer.owner.startedAt, "string");

  // Owning session: unpinned mutation stays frictionless even with two runs.
  run(["plan-execution"], root, { sessionId: "session-b" });
  const refreshed = readPointer(root);
  assert.equal(refreshed.owner.sessionId, "session-b");
  assert.equal(refreshed.owner.startedAt, pointer.owner.startedAt, "same owner keeps its first claim time");

  // Foreign session: unpinned mutation is a hard error naming both runs.
  const refused = run(["plan-execution"], root, { sessionId: "session-a", allowFailure: true });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /belongs to another session/);
  assert.match(refused.stderr, /session-b/);
  assert.match(refused.stderr, /run-b\/state\.json/);
  assert.match(refused.stderr, /--state/);
  assert.match(refused.stderr, /run-a\/state\.json/, "candidates must name the caller's own run");

  // Read-only status warns on stderr but still reports.
  const status = run(["status"], root, { sessionId: "session-a" });
  assert.match(status.stderr, /Warning: Active pointer .* belongs to another session/);
  assert.match(JSON.parse(status.stdout).statePath, /run-b\/state\.json$/);

  // An explicit --state pin is always honored...
  run(["plan-execution", "--state", "agents/implement/run-a/state.json"], root, { sessionId: "session-a" });
  // ...and re-points the pointer: ownership follows the last legitimate writer.
  const repointed = readPointer(root);
  assert.match(repointed.statePath, /run-a\/state\.json$/);
  assert.equal(repointed.owner.sessionId, "session-a");
  const nowForeign = run(["plan-execution"], root, { sessionId: "session-b", allowFailure: true });
  assert.notEqual(nowForeign.status, 0);
  assert.match(nowForeign.stderr, /belongs to another session/);
});

test("no session identity: mutation via the pointer refuses only when several runs exist", () => {
  const root = initGitRepo();
  const prdA = writeApprovedPrd(root, "run-a");
  const prdB = writeApprovedPrd(root, "run-b");
  run(["init", "--prd", prdA, "--review-profile", "trivial"], root);
  run(["init", "--prd", prdB, "--review-profile", "trivial"], root);
  assert.equal(readPointer(root).owner.sessionId, null, "no identity anywhere leaves the stamp empty");

  const refused = run(["plan-execution"], root, { allowFailure: true });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /ownership cannot be verified/);
  assert.match(refused.stderr, /2 implementation states/);
  assert.match(refused.stderr, /run-a\/state\.json/);
  assert.match(refused.stderr, /run-b\/state\.json/);

  // Pinning works; read-only status stays quiet and exits zero.
  run(["plan-execution", "--state", "agents/implement/run-b/state.json"], root);
  const status = run(["status"], root);
  assert.doesNotMatch(status.stderr, /Warning/);

  // A caller with identity facing an unowned pointer is just as unverifiable
  // in a multi-run checkout: refuse rather than guess whose run it names.
  const halfKnown = run(["plan-execution"], root, { sessionId: "session-x", allowFailure: true });
  assert.notEqual(halfKnown.status, 0);
  assert.match(halfKnown.stderr, /ownership cannot be verified/);

  // Once a pinned mutation stamps ownership, the stripped-identity caller is
  // the unverifiable side; multi-run still refuses.
  run(["plan-execution", "--state", "agents/implement/run-b/state.json"], root, { sessionId: "session-x" });
  assert.equal(readPointer(root).owner.sessionId, "session-x");
  const unverifiable = run(["plan-execution"], root, { allowFailure: true });
  assert.notEqual(unverifiable.status, 0);
  assert.match(unverifiable.stderr, /ownership cannot be verified/);
});

test("single run keeps the historical behavior in every identity situation", () => {
  const root = initGitRepo();
  const prd = writeApprovedPrd(root, "solo");
  run(["init", "--prd", prd, "--review-profile", "trivial"], root);

  // No identity on either side.
  run(["plan-execution"], root);
  // Caller identity present, pointer stamp empty (legacy/bootstrap shape).
  run(["plan-execution"], root, { sessionId: "session-a" });
  // Same session again after it stamped the pointer.
  assert.equal(readPointer(root).owner.sessionId, "session-a");
  run(["plan-execution"], root, { sessionId: "session-a" });
  // Pointer owned, caller identity stripped: one run, still allowed.
  run(["plan-execution"], root);

  // A legacy pointer without the owner field never breaks single-run flows.
  const pointerPath = path.join(root, "agents", "implement", ".prd-implement-active.json");
  const legacy = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
  delete legacy.owner;
  legacy.activeSessionId = null;
  fs.writeFileSync(pointerPath, JSON.stringify(legacy, null, 2));
  run(["plan-execution"], root, { sessionId: "session-b" });
});

test("a foreign session id in a legacy pointer's activeSessionId still refuses", () => {
  const root = initGitRepo();
  const prd = writeApprovedPrd(root, "legacy");
  run(["init", "--prd", prd, "--review-profile", "trivial", "--session-id", "owner-legacy"], root);

  // Simulate a pre-owner-stamp pointer: only activeSessionId identifies it.
  const pointerPath = path.join(root, "agents", "implement", ".prd-implement-active.json");
  const legacy = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
  delete legacy.owner;
  fs.writeFileSync(pointerPath, JSON.stringify(legacy, null, 2));
  assert.equal(JSON.parse(fs.readFileSync(pointerPath, "utf8")).activeSessionId, "owner-legacy");

  const refused = run(["plan-execution"], root, { sessionId: "someone-else", allowFailure: true });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /belongs to another session/);
  assert.match(refused.stderr, /owner-legacy/);

  // The bound session itself passes the legacy comparison.
  run(["plan-execution"], root, { sessionId: "owner-legacy" });
});
