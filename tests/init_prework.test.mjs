// Tests for the §4 pre-work checklist: structural extraction, agent-owned
// disposition, and the Stop-hook forcing function.
//
// Rationale pinned here: an audited real run spent 62% of wall time waiting on
// the user because human-only prerequisites the PRD had declared in `## 4`
// were only discovered serially mid-implementation. The first fix extracted
// only bullets matching a human-only keyword regex, and on 2026-08-11 that
// regex missed ALL THREE human-only items of a real PRD (modakbul
// webhook-to-modakbul-server) whose §4.1 preamble stated the property for
// every bullet at once - the empty checklist read as an all-clear and the user
// found the missing Slack channel and Vercel env vars ~4 hours later.
//
// So these tests pin the replacement contract: every bullet is extracted with
// no semantic filtering, every item starts `pending`, only the agent disposes
// of one (`mark --kind prework`), and a `pending` item blocks the run.

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
const { parsePreWorkChecklist } = requireModule(path.join(repoRoot, "cli", "lib", "prd_parser.js"));

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "init-prework-"));
  run("git", ["init", "-b", "main"], { cwd: dir });
  run("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  run("git", ["config", "user.name", "Prework Test"], { cwd: dir });
  run("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  write(path.join(dir, "README.md"), "# Test Repo\n");
  run("git", ["add", "README.md"], { cwd: dir });
  run("git", ["commit", "-m", "Initial"], { cwd: dir });
  return dir;
}

// Same shape as the harness-test fixture PRD, but with a caller-supplied
// `## 4` section so each test can pin a different checklist scenario.
function writeApprovedPrd(projectRoot, slug, section4) {
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

Test the checklist surfacing.

## 3. Scope And Non-Goals

In scope: one local verification.

${section4.trim()}

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

// Verbatim §4.1 from agents/prd/webhook-to-modakbul-server/prd.md in
// /Users/grab/projects/modakbul (2026-08-11). Every bullet here is human-only
// and the deleted keyword regex (사람만 가능|human-only|사용자만|소유자 권한|
// owner-only) matched NONE of them: "관리 권한" is not "소유자 권한",
// "소유자만 가능" falls in the gap between two alternatives, and "사람이" is not
// "사람만". The property was stated once, in the preamble, for all three.
const MODAKBUL_SECTION_4 = `
## 4. Pre-Work And Required Decisions

### 4.1 Pre-Work Before Implementation

각 항목은 계정 소유자 신원이 필요해 에이전트가 대신할 수 없다.

- **P1. Slack Incoming Webhook 생성과 전용 채널 개설.** Slack 워크스페이스 관리 권한이 필요하다. 산출물은 채널명과 webhook URL.
- **P2. Vercel 환경변수 등록.** \`SLACK_ALERT_WEBHOOK_URL\` 값을 Production과 Preview 양쪽에 넣는다. Vercel 프로젝트 소유자만 가능하다.
- **P3. Meta 콘솔 콜백 URL 전환.** 컷오버 시점에 사람이 Meta 개발자 콘솔에서 바꾼다.

### 4.2 Human Decisions Before PRD Approval

- 알림 문안 최종 승인

### 4.3 Decision Traceability For Fidelity Review

- User approved the test scope: represented by R1, AC1, T1, V1.
`;

test("the three real modakbul human-only bullets are extracted and start pending", () => {
  const items = parsePreWorkChecklist(MODAKBUL_SECTION_4);
  assert.deepEqual(items.map(item => [item.id, item.section, item.status]), [
    ["PW1", "4.1", "pending"],
    ["PW2", "4.1", "pending"],
    ["PW3", "4.1", "pending"],
    ["HD1", "4.2", "pending"],
  ]);
  assert.match(items[0].text, /Slack 워크스페이스 관리 권한이 필요하다/);
  assert.match(items[1].text, /Vercel 프로젝트 소유자만 가능하다/);
  assert.match(items[2].text, /사람이 Meta 개발자 콘솔에서 바꾼다/);
  // The preamble that carried the property for all three is prose, not a
  // bullet, and never becomes an item.
  assert.equal(items.some(item => /각 항목은/.test(item.text)), false);
  // §4.3 decision-trace bullets stay out.
  assert.equal(items.some(item => /test scope/.test(item.text)), false);
  // These bullets bold a lead-in rather than the whole line, so an ends-only
  // strip leaves the closing marker inside the text - and this text is quoted
  // verbatim into the batched question the user reads ("Slack 채널 개설.**
  // Slack 워크스페이스 ..."). No emphasis marker may survive extraction.
  for (const item of items) assert.ok(!item.text.includes("**"), `bold marker survived: ${item.text}`);
  assert.match(items[0].text, /^P1\. Slack Incoming Webhook 생성과 전용 채널 개설\. Slack/);
  // A code span is not emphasis: its content is passed through untouched.
  assert.match(items[1].text, /`SLACK_ALERT_WEBHOOK_URL`/);
});

// The one place `**` is content rather than emphasis: a recursive glob inside a
// code span. §8's `Scope:` tail parses from the pre-strip raw text, but the
// display text must not mangle it either.
test("bold stripping leaves code spans alone, including recursive globs", () => {
  const items = parsePreWorkChecklist([
    "## 4. Pre-Work And Required Decisions",
    "### 4.1 Pre-Work Before Implementation",
    "- **Confirm the deploy target.** Paths under `app/src/**/*.ts` are in scope.",
  ].join("\n"));
  assert.equal(items.length, 1);
  assert.equal(items[0].text, "Confirm the deploy target. Paths under `app/src/**/*.ts` are in scope.");
});

test("extraction is structural only: no bullet is filtered or judged by its prose", () => {
  const items = parsePreWorkChecklist([
    "## 4. Pre-Work And Required Decisions",
    "",
    "### 4.1 Pre-Work Before Implementation",
    "",
    // Agent-doable prep: the old parser dropped this for lacking a human-only
    // marker. It is a real item and the agent disposes of it as `agent`.
    "- Create the seed data files for the local test database.",
    // Prose that reads "done": the harness must not act on it. Only the agent
    // or an author's checkbox can dispose of an item.
    "- 결제 수단 등록 - 완료됨",
    "- DB 백업 수행 - 미완료",
    "- [x] Issue the production API key",
    "",
    "### 4.2 Human Decisions Before PRD Approval",
    "",
    "- [ ] Approve the storage choice",
    "- [x] Approve scope and non-goals",
  ].join("\n"));
  assert.deepEqual(items.map(item => [item.id, item.status]), [
    ["PW1", "pending"],
    ["PW2", "pending"],
    ["PW3", "pending"],
    ["PW4", "resolved"],
    ["HD1", "pending"],
    ["HD2", "resolved"],
  ]);
  // No item carries the deleted `resolved` boolean any more.
  assert.equal(items.some(item => "resolved" in item), false);
  assert.ok(items.every(item => Array.isArray(item.evidence)));
});

test("only a whole-line none idiom is skipped, never a bullet that merely starts with one", () => {
  const items = parsePreWorkChecklist([
    "## 4. Pre-Work And Required Decisions",
    "",
    "### 4.1 Pre-Work Before Implementation",
    "",
    "- None.",
    "- N/A",
    "- 없음",
    "- 해당 없음",
    // Substring matching is how the old marker/resolved regexes failed; an
    // item whose text merely opens with "없음" is a real item.
    "- 없음을 확인한 뒤 API 키를 발급한다.",
  ].join("\n"));
  assert.deepEqual(items.map(item => [item.id, item.text]), [
    ["PW1", "없음을 확인한 뒤 API 키를 발급한다."],
  ]);
});

test("bullets inside code fences in section 4 never enter the checklist", () => {
  const items = parsePreWorkChecklist(`
## 4. Pre-Work And Required Decisions

### 4.1 Pre-Work Before Implementation

- 실제 항목

\`\`\`markdown
- 예시 항목 (fenced example only)
\`\`\`

- 두 번째 실제 항목
`);
  assert.deepEqual(items.map(item => item.id), ["PW1", "PW2"]);
  assert.ok(items.every(item => !item.text.includes("예시")));
});

test("parsePreWorkChecklist returns an empty list without a section 4", () => {
  assert.deepEqual(parsePreWorkChecklist("## 6. Requirements\n\n- R1. Something.\n"), []);
  assert.deepEqual(parsePreWorkChecklist([
    "## 4. Pre-Work And Required Decisions",
    "",
    "### 4.1 Pre-Work Before Implementation",
    "",
    "None required.",
    "",
    "### 4.2 Human Decisions Before PRD Approval",
    "",
    "- 없음",
  ].join("\n")), []);
});

test("init lists every item loudly with the exact mark command", () => {
  const projectRoot = initGitRepo();
  const prdPath = writeApprovedPrd(projectRoot, "prework-modakbul", MODAKBUL_SECTION_4);
  const result = runJson(["init", "--prd", prdPath, "--review-profile", "trivial"], projectRoot);

  // Pending items must not fail init: the Stop hook is the forcing function,
  // init is the loud surface.
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.preWorkChecklist.items.map(item => [item.id, item.section, item.status]),
    [["PW1", "4.1", "pending"], ["PW2", "4.1", "pending"], ["PW3", "4.1", "pending"], ["HD1", "4.2", "pending"]],
  );
  assert.match(result.preWorkAction, /PW1, PW2, PW3, HD1/);
  assert.match(result.preWorkAction, /mark --kind prework/);
  assert.match(result.preWorkAction, /human\|agent\|resolved/);

  const state = JSON.parse(fs.readFileSync(
    path.join(projectRoot, "agents", "implement", "prework-modakbul", "state.json"),
    "utf8",
  ));
  assert.deepEqual(state.preWorkChecklist, result.preWorkChecklist);
});

test("init reports an empty checklist and no action for a PRD with no section 4 bullets", () => {
  const projectRoot = initGitRepo();
  const prdPath = writeApprovedPrd(projectRoot, "prework-clean", `
## 4. Pre-Work And Required Decisions

### 4.1 Pre-Work Before Implementation

None required.

### 4.2 Human Decisions Before PRD Approval

Approved test scope.
`);
  const result = runJson(["init", "--prd", prdPath, "--review-profile", "trivial"], projectRoot);
  assert.equal(result.ok, true);
  assert.deepEqual(result.preWorkChecklist, { items: [] });
  assert.equal(result.preWorkAction, undefined);
});

test("a pending item blocks the Stop hook, and disposing every item releases it", () => {
  const projectRoot = initGitRepo();
  const prdPath = writeApprovedPrd(projectRoot, "prework-gate", MODAKBUL_SECTION_4);
  runJson(["init", "--prd", prdPath, "--review-profile", "trivial", "--session-id", "pw-session"], projectRoot);
  const stopInput = JSON.stringify({ hook_event_name: "Stop", cwd: projectRoot, session_id: "pw-session" });

  const blocked = JSON.parse(run(process.execPath, [harness, "hook", "stop"], { cwd: projectRoot, input: stopInput }).stdout);
  assert.equal(blocked.decision, "block");
  assert.match(blocked.reason, /# Undisposed pre-work \(PRD §4\)/);
  assert.match(blocked.reason, /Next required item: PRE-WORK: 4 PRD §4 item\(s\) are undisposed/);
  assert.match(blocked.reason, /Vercel 프로젝트 소유자만 가능하다/);
  assert.match(blocked.reason, /mark --kind prework/);
  // The task must not be offered as the next item while pre-work is pending.
  assert.doesNotMatch(blocked.reason, /Next required item: TASK T1/);

  // Marking the first task does not buy the run past the gate.
  runJson(["mark", "--kind", "task", "--id", "T1", "--status", "complete", "--evidence", "did it"], projectRoot);
  const stillBlocked = JSON.parse(run(process.execPath, [harness, "hook", "stop"], { cwd: projectRoot, input: stopInput }).stdout);
  assert.match(stillBlocked.reason, /# Undisposed pre-work \(PRD §4\)/);

  const partial = runJson([
    "mark", "--kind", "prework", "--id", "PW1,PW2", "--status", "human",
    "--evidence", "Asked the user in one batched message; awaiting the webhook URL.",
  ], projectRoot);
  assert.equal(partial.ok, true);
  assert.deepEqual(partial.marked.map(entry => [entry.id, entry.status]), [["PW1", "human"], ["PW2", "human"]]);
  assert.equal(partial.preWorkPending.length, 2);
  assert.match(partial.preWorkPending[0], /^PW3 \(4\.1\)/);

  runJson(["mark", "--kind", "prework", "--id", "PW3", "--status", "agent", "--evidence", "Cutover switch happens in this run."], projectRoot);
  const last = runJson(["mark", "--kind", "prework", "--id", "HD1", "--status", "resolved", "--evidence", "User approved the copy in conversation."], projectRoot);
  assert.equal(last.preWorkPending, undefined);

  const released = JSON.parse(run(process.execPath, [harness, "hook", "stop"], { cwd: projectRoot, input: stopInput }).stdout);
  assert.doesNotMatch(released.reason, /Undisposed pre-work/);

  const state = JSON.parse(fs.readFileSync(path.join(projectRoot, "agents", "implement", "prework-gate", "state.json"), "utf8"));
  assert.deepEqual(state.preWorkChecklist.items.map(item => item.status), ["human", "human", "agent", "resolved"]);
  // No stored pending count anywhere: it is derived from item status, so it
  // cannot drift from the record (PRINCIPLES.md item 10).
  assert.deepEqual(Object.keys(state.preWorkChecklist), ["items"]);
  assert.equal(state.preWorkChecklist.items[0].evidence.length, 1);
});

// The Stop hook guards turns that end; the receipt is what claims the run is
// done. An undisposed §4 item is an unasked question about setup that may not
// exist, so completion has to refuse it in `completionViolations` as well -
// otherwise a finalize reached on any path the hook did not intercept stamps
// "done" over it (2026-08-11, modakbul: three human-only items went undisposed
// and the missing Slack channel and Vercel variable surfaced four hours later).
test("undisposed pre-work blocks completion, and every disposition clears it", () => {
  const projectRoot = initGitRepo();
  const prdPath = writeApprovedPrd(projectRoot, "prework-finalize", MODAKBUL_SECTION_4);
  runJson(["init", "--prd", prdPath, "--review-profile", "trivial"], projectRoot);

  const blocked = runJson(["finalize", "--status", "complete", "--summary", "Claiming done."], projectRoot, { allowFailure: true });
  assert.equal(blocked.ok, false);
  const preWorkViolation = blocked.violations.find(item => /PRD §4 pre-work item/.test(item));
  assert.ok(preWorkViolation, `expected a pre-work completion blocker, got: ${JSON.stringify(blocked.violations)}`);
  assert.match(preWorkViolation, /4 PRD §4 pre-work item\(s\) are still undisposed \(PW1, PW2, PW3, HD1\)/);
  assert.match(preWorkViolation, /mark --kind prework/, "the blocker names the command that clears it");

  // `human` and `agent` are dispositions, not completions: an item the agent
  // owns is an answered question, so the blocker must clear on any of the three.
  runJson(["mark", "--kind", "prework", "--id", "PW1,PW2", "--status", "human", "--evidence", "Asked in one batched message."], projectRoot);
  runJson(["mark", "--kind", "prework", "--id", "PW3", "--status", "agent", "--evidence", "This run performs the cutover."], projectRoot);
  const partial = runJson(["finalize", "--status", "complete", "--summary", "Claiming done."], projectRoot, { allowFailure: true });
  assert.ok(partial.violations.some(item => /1 PRD §4 pre-work item\(s\) are still undisposed \(HD1\)/.test(item)),
    `expected the count to fall to the undisposed remainder, got: ${JSON.stringify(partial.violations)}`);

  runJson(["mark", "--kind", "prework", "--id", "HD1", "--status", "resolved", "--evidence", "User approved the copy."], projectRoot);
  const cleared = runJson(["finalize", "--status", "complete", "--summary", "Claiming done."], projectRoot, { allowFailure: true });
  assert.equal(cleared.violations.some(item => /PRD §4 pre-work item/.test(item)), false,
    `every item disposed must clear the blocker, got: ${JSON.stringify(cleared.violations)}`);
});

test("mark --kind prework rejects an unknown status and an unknown id", () => {
  const projectRoot = initGitRepo();
  const prdPath = writeApprovedPrd(projectRoot, "prework-invalid", MODAKBUL_SECTION_4);
  runJson(["init", "--prd", prdPath, "--review-profile", "trivial"], projectRoot);

  const badStatus = run(process.execPath, [
    harness, "mark", "--kind", "prework", "--id", "PW1", "--status", "done", "--evidence", "x",
  ], { cwd: projectRoot, allowFailure: true });
  assert.notEqual(badStatus.status, 0);
  assert.match(badStatus.stderr, /Invalid prework status 'done'/);
  assert.match(badStatus.stderr, /pending, human, agent, resolved/);

  const badId = run(process.execPath, [
    harness, "mark", "--kind", "prework", "--id", "PW9", "--status", "human", "--evidence", "x",
  ], { cwd: projectRoot, allowFailure: true });
  assert.notEqual(badId.status, 0);
  assert.match(badId.stderr, /prework PW9 not found/);
});

test("a pre-2026-08-11 state.json migrates to dispositions instead of crashing", () => {
  const projectRoot = initGitRepo();
  const prdPath = writeApprovedPrd(projectRoot, "prework-legacy", MODAKBUL_SECTION_4);
  runJson(["init", "--prd", prdPath, "--review-profile", "trivial", "--session-id", "legacy-session"], projectRoot);
  const statePath = path.join(projectRoot, "agents", "implement", "prework-legacy", "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  // The old on-disk shape: `{id, section, text, resolved}`, no status, no
  // evidence array, plus the old count key.
  state.preWorkChecklist = {
    items: [
      { id: "PW1", section: "4.1", text: "Vercel 환경변수 등록", resolved: false },
      { id: "PW2", section: "4.1", text: "결제 수단 등록", resolved: true },
    ],
    unresolvedCount: 1,
  };
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

  // `resolved: true` is the only positive signal, so it maps to `resolved`;
  // everything else falls to `pending`, the fail-safe direction.
  const stopInput = JSON.stringify({ hook_event_name: "Stop", cwd: projectRoot, session_id: "legacy-session" });
  const blocked = JSON.parse(run(process.execPath, [harness, "hook", "stop"], { cwd: projectRoot, input: stopInput }).stdout);
  assert.match(blocked.reason, /- PW1 \(4\.1\): Vercel 환경변수 등록/);
  assert.doesNotMatch(blocked.reason, /PW2/);

  const marked = runJson(["mark", "--kind", "prework", "--id", "PW1", "--status", "human", "--evidence", "asked"], projectRoot);
  assert.equal(marked.ok, true);
  assert.equal(marked.preWorkPending, undefined);
  const migrated = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.deepEqual(migrated.preWorkChecklist.items.map(item => [item.id, item.status]), [["PW1", "human"], ["PW2", "resolved"]]);
  assert.equal(migrated.preWorkChecklist.items.some(item => "resolved" in item), false);
});

test("reconcile re-parses the checklist and re-opens it after a PRD edit", () => {
  const projectRoot = initGitRepo();
  const prdPath = writeApprovedPrd(projectRoot, "prework-reconcile", `
## 4. Pre-Work And Required Decisions

### 4.1 Pre-Work Before Implementation

- API 키 발급
`);
  const init = runJson(["init", "--prd", prdPath, "--review-profile", "trivial"], projectRoot);
  assert.equal(init.preWorkChecklist.items.length, 1);
  runJson(["mark", "--kind", "prework", "--id", "PW1", "--status", "human", "--evidence", "asked"], projectRoot);

  const prdAbs = path.isAbsolute(prdPath) ? prdPath : path.join(projectRoot, prdPath);
  fs.writeFileSync(prdAbs, fs.readFileSync(prdAbs, "utf8").replace(
    "- API 키 발급",
    "- API 키 발급\n- Vercel 도메인 연결",
  ));
  const reconciled = runJson(["reconcile", "--reason", "pre-work updated"], projectRoot);
  assert.equal(reconciled.ok, true);

  // §4 ids are positional, so a PRD edit can slide a disposition onto a
  // different bullet. Re-parsing back to `pending` is the fail-safe answer:
  // re-disposing costs one batched mark, a silently inherited disposition
  // costs the stall this checklist exists to prevent.
  const state = JSON.parse(fs.readFileSync(
    path.join(projectRoot, "agents", "implement", "prework-reconcile", "state.json"),
    "utf8",
  ));
  assert.deepEqual(
    state.preWorkChecklist.items.map(item => [item.text, item.status]),
    [["API 키 발급", "pending"], ["Vercel 도메인 연결", "pending"]],
  );
});
