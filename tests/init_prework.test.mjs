// Tests for the init-time human-action checklist (preWorkChecklist).
//
// Rationale pinned here: an audited real run spent 62% of wall time waiting on
// the user because human-only prerequisites the PRD had declared in `## 4`
// (items literally marked "사람만 가능", an open §4.2 decision) were only
// discovered serially mid-implementation. These tests pin the surfacing
// contract: marked §4.1 bullets and open §4.2 bullets are extracted with
// resolved flags, unmarked §4.1 bullets are ignored, init carries the list in
// its output plus state.json, and unresolved items never fail init.

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

const MIXED_SECTION_4 = `
## 4. Pre-Work And Required Decisions

### 4.1 Pre-Work Before Implementation

- Vercel 환경변수 등록 - 사람만 가능(Vercel 프로젝트 소유자 권한)
- Create the seed data files for the local test database.
- [x] Issue the production API key - human-only (owner identity required)
- 결제 수단 등록 - 사람만 가능 - 완료됨

### 4.2 Human Decisions Before PRD Approval

- 확정 메일 문안 최종 승인
- Approve the delivery mode - resolved

### 4.3 Decision Traceability For Fidelity Review

- User approved the test scope: represented by R1, AC1, T1, V1.
`;

test("parsePreWorkChecklist extracts marked 4.1 bullets and open 4.2 bullets with resolved flags", () => {
  const items = parsePreWorkChecklist(MIXED_SECTION_4);
  assert.deepEqual(items, [
    {
      id: "PW1",
      section: "4.1",
      text: "Vercel 환경변수 등록 - 사람만 가능(Vercel 프로젝트 소유자 권한)",
      resolved: false,
    },
    {
      id: "PW2",
      section: "4.1",
      text: "Issue the production API key - human-only (owner identity required)",
      resolved: true,
    },
    {
      id: "PW3",
      section: "4.1",
      text: "결제 수단 등록 - 사람만 가능 - 완료됨",
      resolved: true,
    },
    {
      id: "HD1",
      section: "4.2",
      text: "확정 메일 문안 최종 승인",
      resolved: false,
    },
  ]);
  // Unmarked 4.1 bullets are not judged, only skipped; resolved unmarked 4.2
  // bullets are old news; 4.3 decision-trace bullets never leak in.
  assert.equal(items.some(item => /seed data/.test(item.text)), false);
  assert.equal(items.some(item => /delivery mode/.test(item.text)), false);
  assert.equal(items.some(item => /test scope/.test(item.text)), false);
});

test("parsePreWorkChecklist recognizes marker and resolved variants without judging content", () => {
  const items = parsePreWorkChecklist([
    "## 4. Pre-Work And Required Decisions",
    "",
    "### 4.1 Pre-Work Before Implementation",
    "",
    "- Grant repo admin access - 소유자 권한 필요",
    "- DB 백업 수행 - 사람만 가능 - 미완료",
    "- Provide the design assets - 사용자만 보유한 원본 파일 (done)",
    "- None required for tooling.",
    "",
    "### 4.2 Human Decisions Before PRD Approval",
    "",
    "- [ ] Approve the storage choice",
    "- [x] Approve scope and non-goals",
  ].join("\n"));
  assert.deepEqual(items.map(item => [item.id, item.resolved]), [
    ["PW1", false],
    ["PW2", false],
    ["PW3", true],
    ["HD1", false],
  ]);
  // "미완료" must not read as "완료", and a checked 4.2 box counts as resolved
  // (so it is not extracted when unmarked).
  assert.equal(items.some(item => /scope and non-goals/.test(item.text)), false);
});

test("parsePreWorkChecklist returns an empty list without a section 4 and skips none-style bullets", () => {
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

test("init surfaces the checklist with an unresolved count and round-trips it through state.json", () => {
  const projectRoot = initGitRepo();
  const prdPath = writeApprovedPrd(projectRoot, "prework-mixed", MIXED_SECTION_4);
  const result = runJson(["init", "--prd", prdPath, "--review-profile", "trivial"], projectRoot);

  // Unresolved human-only items must not fail init: the contract is
  // "surface loudly", not "block".
  assert.equal(result.ok, true);
  assert.equal(result.preWorkChecklist.unresolvedCount, 2);
  assert.deepEqual(
    result.preWorkChecklist.items.map(item => [item.id, item.section, item.resolved]),
    [["PW1", "4.1", false], ["PW2", "4.1", true], ["PW3", "4.1", true], ["HD1", "4.2", false]],
  );
  assert.match(result.preWorkChecklist.items[0].text, /사람만 가능/);

  const state = JSON.parse(fs.readFileSync(
    path.join(projectRoot, "agents", "implement", "prework-mixed", "state.json"),
    "utf8",
  ));
  assert.deepEqual(state.preWorkChecklist, result.preWorkChecklist);
});

test("init reports an empty checklist for a PRD whose pre-work is all resolved or absent", () => {
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
  assert.deepEqual(result.preWorkChecklist, { items: [], unresolvedCount: 0 });

  const state = JSON.parse(fs.readFileSync(
    path.join(projectRoot, "agents", "implement", "prework-clean", "state.json"),
    "utf8",
  ));
  assert.deepEqual(state.preWorkChecklist, { items: [], unresolvedCount: 0 });
});

test("negated and future Korean resolution phrasings stay unresolved", () => {
  // "완료되지 않음"/"완료 안 됨"/"완료 예정" contain the positive "완료" as a
  // substring; misreading them as resolved silently drops open human
  // decisions from the checklist (adversarial-review finding, 2026-08-10).
  const items = parsePreWorkChecklist(`
## 4. Pre-Work And Required Decisions

### 4.2 Human Decisions Before PRD Approval

- 배포 방식 승인 - 완료되지 않음
- 요금제 선택 - 아직 완료 안 됨
- API 키 발급 - 완료 예정
- 문안 확정 - 진행 중
`);
  assert.deepEqual(items.map(item => [item.id, item.resolved]), [
    ["HD1", false], ["HD2", false], ["HD3", false], ["HD4", false],
  ]);
});

test("bullets inside code fences in section 4 never enter the checklist", () => {
  const items = parsePreWorkChecklist(`
## 4. Pre-Work And Required Decisions

### 4.1 Pre-Work Before Implementation

- 실제 항목 - 사람만 가능

\`\`\`markdown
- 예시 항목 - 사람만 가능 (fenced example only)
\`\`\`

- 두 번째 실제 항목 - 사람만 가능
`);
  assert.deepEqual(items.map(item => item.id), ["PW1", "PW2"]);
  assert.ok(items.every(item => !item.text.includes("예시")));
});

test("reconcile refreshes the checklist after a PRD edit", () => {
  const projectRoot = initGitRepo();
  const prdPath = writeApprovedPrd(projectRoot, "prework-reconcile", `
## 4. Pre-Work And Required Decisions

### 4.1 Pre-Work Before Implementation

- API 키 발급 - 사람만 가능
`);
  const init = runJson(["init", "--prd", prdPath, "--review-profile", "trivial"], projectRoot);
  assert.equal(init.preWorkChecklist.unresolvedCount, 1);

  const prdAbs = path.isAbsolute(prdPath) ? prdPath : path.join(projectRoot, prdPath);
  fs.writeFileSync(prdAbs, fs.readFileSync(prdAbs, "utf8").replace(
    "- API 키 발급 - 사람만 가능",
    "- API 키 발급 - 사람만 가능 - 완료됨\n- Vercel 도메인 연결 - 사람만 가능",
  ));
  const reconciled = runJson(["reconcile", "--reason", "pre-work updated"], projectRoot);
  assert.equal(reconciled.ok, true);

  const state = JSON.parse(fs.readFileSync(
    path.join(projectRoot, "agents", "implement", "prework-reconcile", "state.json"),
    "utf8",
  ));
  assert.equal(state.preWorkChecklist.unresolvedCount, 1);
  assert.deepEqual(
    state.preWorkChecklist.items.map(item => [item.text.includes("Vercel"), item.resolved]),
    [[false, true], [true, false]],
  );
});
