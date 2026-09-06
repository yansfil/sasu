import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acceptancePrompt, designPrompt, designReviewPaths, fidelityPrompt, fidelitySource, IMPLEMENT_REVIEW_DIFF_MAX_CHARS, renderDecisions, reviewDiffMaterial, riskPrompt } from "../../dist/implement/prompts.js";
import { parseImplementContract } from "../../dist/implement/contract.js";

function contract(sourceIntake) {
  return {
    frontmatter: { source_intake: sourceIntake },
    goal: "One flow works end to end.",
    nonGoals: "Task parallelism.",
    decisions: [{ id: "D-01", decision: "preserve the user's chosen flow", rationale: "the user asked for it twice" }],
    risks: "No open decisions.",
  };
}

const row = (id, behavior, check, overrides = {}) => ({
  id, behavior, check, decisionIds: ["D-01"], status: "pending",
  attempts: [], consecutiveFailures: 0, parks: [], verdict: null, human: null, rejections: [],
  ...overrides,
});

const state = {
  status: "active",
  rows: [
    row("B1", "the runner runs once", { kind: "check", command: "npm test", argv: ["npm", "test"] }, { status: "green" }),
    row("B2", "the summary is readable", { kind: "judge", evidence: "a capture" }),
    row("B3", "the operator likes it", { kind: "human", confirmation: "the operator says so" }, { status: "OPEN" }),
  ],
  artifacts: [],
  deviations: [],
};

test("fidelity source routing uses the Decisions table for conversation and fresh spec, full qa-log otherwise", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-fidelity-source-"));
  fs.writeFileSync(path.join(root, "qa-log.md"), "FULL QA LOG");

  const conversation = fidelitySource(root, contract("current conversation"), false);
  assert.equal(conversation.routing, "decisions");
  assert.equal(conversation.content, renderDecisions(contract("current conversation")));
  assert.equal(fidelitySource(root, contract("qa-log.md"), true).routing, "decisions");
  const stale = fidelitySource(root, contract("qa-log.md"), false);
  assert.equal(stale.routing, "full-qa-log");
  assert.equal(stale.content, "FULL QA LOG");
});

test("fidelity prompt keeps the fixed five-question rubric, compares the Decisions table, and omits judge: row statuses", () => {
  const parsed = contract("current conversation");
  const source = { routing: "decisions", content: renderDecisions(parsed), explanation: "fixture" };
  const prompt = fidelityPrompt("FULL PRD", parsed, state, source, [{ path: "src/changed.ts", body: "changed file" }]);
  for (const id of ["F1", "F2", "F3", "F4", "F5"]) assert.match(prompt, new RegExp(`- ${id} `));
  assert.match(prompt, /Changed paths since implement start:\n- src\/changed\.ts\n\nFILE src\/changed\.ts\nchanged file/);
  assert.match(prompt, /Do not repeat code-correctness, artifact sufficiency, or per-row acceptance testing/);
  assert.match(prompt, /PRD DECISIONS \(D-n \| 결정 \| 근거\):\n- D-01: preserve the user's chosen flow \(근거: the user asked for it twice\)/);
  assert.match(prompt, /PRD NON-GOALS:\nTask parallelism\./);
  assert.match(prompt, /IMPLEMENTATION CLAIMS:\nrun=active, B1=green, B3=OPEN/);
  assert.doesNotMatch(prompt, /B2=/, "the acceptance lane is judging judge: rows concurrently");
  assert.match(prompt, /judge: row statuses are intentionally omitted/);
  assert.match(prompt, /FULL APPROVED PRD:\nFULL PRD/);
});

test("full qa-log supplements rather than replaces the PRD Decisions table", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-fidelity-qa-log-"));
  fs.writeFileSync(path.join(root, "qa-log.md"), "FULL QA LOG");
  const parsed = contract("qa-log.md");
  const source = fidelitySource(root, parsed, false);
  const prompt = fidelityPrompt("FULL PRD", parsed, state, source, []);
  assert.match(prompt, /No run-owned source changes were detected/);
  assert.match(prompt, /CANONICAL INTENT SOURCE:\nFULL QA LOG/);
  assert.match(prompt, /PRD DECISIONS \(D-n \| 결정 \| 근거\):\n- D-01: preserve the user's chosen flow/);
  assert.match(prompt, /FULL APPROVED PRD:\nFULL PRD/);
});

test("risk prompt receives the complete artifact roster and the exact round-2 delta contract", () => {
  const registeredAt = "2026-08-25T06:14:00.000Z";
  const harnessRanAt = "2026-08-25T06:37:00.000Z";
  const prompt = riskPrompt(
    "FULL PRD",
    "changed source",
    { verdict: "PASS" },
    { verdict: "PASS" },
    [
      { rowId: "B2", kind: "log", path: "proof/run.log", sha256: "a".repeat(64), description: "CLI run", bytes: 10, registeredAt },
      { kind: "command-log", path: "proof/test.log", sha256: "b".repeat(64), description: "test run", bytes: 20, registeredAt: harnessRanAt, command: "npm test", cwd: ".", exitCode: 0 },
    ],
    { verdict: "PASS", findings: [{ id: "RF1", severity: "advisory", text: "old note" }] },
    { priorAttemptId: "attempt-1", changedPaths: ["src/run.ts"], newEvidence: [{ rowId: "B2", path: "proof/run.log", sha256: "a".repeat(64) }] },
  );
  assert.match(prompt, /B2 log proof\/run\.log sha256=/);
  assert.match(prompt, /unbound command-log proof\/test\.log sha256=/);
  assert.ok(prompt.includes(`agent-registered at ${registeredAt}; treat as the implementer's claim, not a harness observation`));
  assert.ok(prompt.includes(`the harness ran \`npm test\` at ${harnessRanAt} from cwd=.`));
  assert.match(prompt, /not a vote in the unified acceptance\/fidelity verdict/);
  assert.match(prompt, /Resolving one requires a deltaBasis/);
  assert.match(prompt, /ROUND-2\+ DELTA CONTRACT/);
  assert.match(prompt, /Disposition every prior finding by its supplied id as resolved or unresolved/);
  assert.match(prompt, /deltaBasis.*one exact path.*CHANGED PATHS SINCE THE PRIOR ROUND/s);
  assert.match(prompt, /"origin": "prior-unresolved" \| "new"/);
  assert.doesNotMatch(prompt, /"new on round 2\+"/);
  assert.match(prompt, /B2:proof\/run\.log/);
  assert.match(prompt, /Artifact bytes remain in the record tree and are not readable in this lane/);
});

/** A unified diff block for one file, the shape `git diff` and `git diff --no-index` both emit. */
function diffBlock(file, { added = [], removed = [], newFile = false } = {}) {
  const lines = [
    `diff --git a/${file} b/${file}`,
    ...(newFile ? ["new file mode 100644", `--- /dev/null`] : [`--- a/${file}`]),
    `+++ b/${file}`,
    `@@ -1,${removed.length} +1,${added.length} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ];
  return `${lines.join("\n")}\n`;
}

test("an oversized diff is chunked per file: whole blocks fill the budget, the rest are listed with counts", () => {
  const huge = diffBlock("src/huge.ts", { added: Array.from({ length: 1300 }, (_, i) => `HUGE_LINE_${i} ${"x".repeat(100)}`), removed: ["OLD_HUGE"] });
  const small = diffBlock("src/small.ts", { added: ["SMALL_ADDED_ONE", "SMALL_ADDED_TWO"], removed: ["SMALL_REMOVED"] });
  const fresh = diffBlock("docs/new.md", { added: ["FRESH_LINE"], newFile: true });
  const image = `diff --git a/img/logo.png b/img/logo.png\nBinary files a/img/logo.png and b/img/logo.png differ\n`;
  const completeDiff = `${huge}${small}${fresh}${image}`;
  assert.ok(completeDiff.length > IMPLEMENT_REVIEW_DIFF_MAX_CHARS, "fixture must exceed the budget");
  const readable = ["src/huge.ts", "src/small.ts", "docs/new.md"];

  const review = reviewDiffMaterial(completeDiff, readable);
  assert.deepEqual(review.inlinedPaths, ["src/small.ts", "docs/new.md", "img/logo.png"], "a block that does not fit must not starve the ones after it");
  assert.deepEqual(review.listedPaths, ["src/huge.ts"]);
  assert.ok(review.text.length <= IMPLEMENT_REVIEW_DIFF_MAX_CHARS, `chunked material must stay inside the budget, got ${review.text.length}`);
  assert.match(review.text, /1 file\(s\) listed by path only/);
  assert.match(review.text, /^- src\/huge\.ts \(\+1300\/-1\)$/m);
  assert.doesNotMatch(review.text, /\[not readable\]/, "every listed path here is readable text");
  assert.match(review.text, /SMALL_ADDED_ONE/);
  assert.match(review.text, /FRESH_LINE/);
  assert.doesNotMatch(review.text, /HUGE_LINE_/);

  const design = designPrompt("PRD", completeDiff, [
    { path: "src/huge.ts", body: "HUGE BODY" },
    { path: "src/small.ts", body: "SMALL BODY" },
    { path: "docs/new.md", body: "NEW BODY" },
  ], readable);
  const risk = riskPrompt("PRD", completeDiff, { verdict: "PASS" }, { verdict: "PASS" }, [], null, undefined, readable);
  for (const prompt of [design, risk]) {
    assert.match(prompt, /exceeds the 120000-character review input limit, so it is shown per file/);
    assert.match(prompt, /isolated read-only access/);
    assert.match(prompt, /SMALL_ADDED_ONE/);
    assert.doesNotMatch(prompt, /HUGE_LINE_/);
  }
  // The design lane spends the freed room on the files it could not show,
  // not on a second copy of the ones it did.
  assert.match(design, /FILE src\/huge\.ts\nHUGE BODY/);
  assert.doesNotMatch(design, /SMALL BODY|NEW BODY/);
  assert.match(design, /files whose diff is inline above are left out here/);
});

test("chunking marks listed paths the judge cannot read and inlines a later round's changed paths first", () => {
  const first = diffBlock("src/first.ts", { added: Array.from({ length: 700 }, (_, i) => `FIRST_${i} ${"a".repeat(100)}`) });
  const second = diffBlock("src/second.ts", { added: Array.from({ length: 700 }, (_, i) => `SECOND_${i} ${"b".repeat(100)}`) });
  const completeDiff = `${first}${second}`;
  assert.ok(first.length < IMPLEMENT_REVIEW_DIFF_MAX_CHARS && completeDiff.length > IMPLEMENT_REVIEW_DIFF_MAX_CHARS);

  const plain = reviewDiffMaterial(completeDiff, ["src/first.ts"]);
  assert.deepEqual(plain.inlinedPaths, ["src/first.ts"], "in order, the first block wins the budget");
  assert.match(plain.text, /^- src\/second\.ts \(\+700\/-0\) \[not readable\]$/m);

  const prioritized = reviewDiffMaterial(completeDiff, ["src/first.ts", "src/second.ts"], ["src/second.ts"]);
  assert.deepEqual(prioritized.inlinedPaths, ["src/second.ts"], "a path the judge is told to re-examine must be the one shown");
  assert.deepEqual(prioritized.listedPaths, ["src/first.ts"]);
});

test("a diff inside the budget is passed through whole with every path attributed", () => {
  const completeDiff = `${diffBlock("a.ts", { added: ["A"] })}${diffBlock("b.ts", { removed: ["B"] })}`;
  const review = reviewDiffMaterial(completeDiff, ["a.ts", "b.ts"]);
  assert.equal(review.text, completeDiff);
  assert.deepEqual(review.inlinedPaths, ["a.ts", "b.ts"]);
  assert.deepEqual(review.listedPaths, []);
});

test("acceptance prompt is scoped to one row, its judge: cell, and its mapped proof", () => {
  const registeredAt = "2026-08-25T06:14:00.000Z";
  const judged = row("B2", "second behavior", { kind: "judge", evidence: "a capture of the second screen" });
  const prompt = acceptancePrompt(judged, {
    changedFiles: "- src/second.ts [text, 80 bytes]",
    checks: [{ criterionId: "B2", command: "npm test", exitCode: 0, tail: "SECOND-MECHANICAL-PROOF" }],
    evidence: [{ criterionId: "B2", path: "second.log", sha256: "b".repeat(64), bytes: 21, text: "SECOND-ARTIFACT-BODY" }],
    readableArtifacts: [{ path: "second.png", kind: "screenshot", sha256: "c".repeat(64), bytes: 42, description: "second screen", registeredAt }],
    facts: { checkLedger: "{}", suiteResults: [], suiteExclusions: [], amendments: [], parked: [] },
    claims: [],
    decisions: [{ id: "D-01", decision: "preserve the user's chosen flow", rationale: "asked twice" }],
  });
  assert.match(prompt, /- B2: second behavior/);
  assert.match(prompt, /"id": "B2"/);
  assert.match(prompt, /EVIDENCE THE PRD DECLARED FOR THIS ROW \(judge: cell\):\n- a capture of the second screen/);
  assert.match(prompt, /- D-01: preserve the user's chosen flow \(근거: asked twice\)/);
  assert.match(prompt, /SECOND-MECHANICAL-PROOF/);
  assert.match(prompt, /SECOND-ARTIFACT-BODY/);
  assert.match(prompt, /second\.png/);
  assert.ok(prompt.includes(`agent-registered at ${registeredAt}; treat as the implementer's claim, not a harness observation`));
  assert.match(prompt, /a PASS relying on it must explain in reason why that evidence remains valid/);
  assert.match(prompt, /src\/second\.ts \[text, 80 bytes\]/);
  assert.doesNotMatch(prompt, /B1:|B3:|first\.log|MAPPED USER SCENARIOS/);
});

test("design prompt carries no verdict, anchors every comment to a path, and shows the diff with bounded file context", () => {
  const prompt = designPrompt("PRD BODY", "RUN OWNED DIFF", [{ path: "src/a.ts", body: "CURRENT FILE BODY" }]);
  assert.match(prompt, /design reviewer/);
  assert.match(prompt, /You have no verdict/);
  // The lane must not be able to emit a verdict at all: a verdict field in the
  // schema is what made the old lane a judge whose ruling was hardwired shut.
  assert.doesNotMatch(prompt, /"verdict"/);
  assert.match(prompt, /There is no verdict field\. Do not emit one\./);
  // Comments cost someone an answer, and the prompt must say so - looseness is
  // otherwise unpriced and the lane drifts into style commentary.
  assert.match(prompt, /must be answered before the run can be finalized/);
  assert.match(prompt, /"path": "project\/relative\/file"/);
  assert.match(prompt, /AT MOST ONE COMMENT PER FILE/);
  assert.match(prompt, /"area" is a label for the reader, not part of the identity/);
  assert.match(prompt, /One cause patched as N symptoms/);
  assert.match(prompt, /No style nitpicks/);
  // The complete diff is the material the accretion charter needs. Whole file
  // bodies previously duplicated it and made the prompt silently incomplete.
  assert.match(prompt, /RUN OWNED DIFF/);
  assert.match(prompt, /Judge what THIS RUN did/);
  assert.match(prompt, /BOUNDED CURRENT BODIES OF CHANGED FILES/);
  assert.match(prompt, /CURRENT FILE BODY/);
  assert.match(prompt, /PRD BODY/);
});

test("design prompt on round 2+ names the open comments and changed paths, and only those may be commented on", () => {
  const files = [{ path: "src/a.ts", body: "A BODY" }, { path: "src/b.ts", body: "B BODY" }];
  const open = [{ id: "D1", area: "dead-weight", path: "src/a.ts", text: "unused helper" }];
  const first = designPrompt("PRD", "RUN OWNED DIFF", files, [], open, { priorAttemptId: null, changedPaths: [], newEvidence: [] });
  assert.doesNotMatch(first, /ROUND-2\+ CONTRACT|OPEN COMMENTS FROM THE PRIOR ROUND/, "round 1 has nothing to carry forward");
  assert.equal(designReviewPaths({ priorAttemptId: null, changedPaths: [], newEvidence: [] }, open), null, "round 1 is unrestricted");

  const context = { priorAttemptId: "attempt-1", changedPaths: ["src/b.ts"], newEvidence: [] };
  const second = designPrompt("PRD", "RUN OWNED DIFF", files, [], open, context);
  assert.match(second, /ROUND-2\+ CONTRACT/);
  assert.match(second, /PRIOR ATTEMPT: attempt-1/);
  assert.match(second, /OPEN COMMENTS FROM THE PRIOR ROUND:\n- D1 \[dead-weight\] src\/a\.ts: unused helper/);
  assert.match(second, /CHANGED PATHS SINCE THE PRIOR ROUND:\n- src\/b\.ts/);
  assert.match(second, /Re-examine only the paths under CHANGED PATHS SINCE THE PRIOR ROUND and the paths of the OPEN COMMENTS/);
  assert.match(second, /Carry an open comment forward, at the same path/);
  assert.match(second, /A new comment belongs at a path in CHANGED PATHS SINCE THE PRIOR ROUND or at the path of an open comment/);
  // Still no verdict, still one comment per file: the round contract narrows
  // the lane's attention, not its output shape.
  assert.doesNotMatch(second, /"verdict"/);
  assert.deepEqual([...designReviewPaths(context, open)].sort(), ["src/a.ts", "src/b.ts"]);
});

test("on a later round the chunked diff inlines the paths the design lane is told to re-examine", () => {
  const first = diffBlock("src/first.ts", { added: Array.from({ length: 700 }, (_, i) => `FIRST_${i} ${"a".repeat(100)}`) });
  const flagged = diffBlock("src/flagged.ts", { added: Array.from({ length: 700 }, (_, i) => `FLAGGED_${i} ${"b".repeat(100)}`) });
  const readable = ["src/first.ts", "src/flagged.ts"];
  const open = [{ id: "D1", area: "accretion", path: "src/flagged.ts", text: "layered special cases" }];
  const context = { priorAttemptId: "attempt-1", changedPaths: [], newEvidence: [] };
  const prompt = designPrompt("PRD", `${first}${flagged}`, [], readable, open, context);
  assert.match(prompt, /FLAGGED_0 /, "the open comment's path is shown in full");
  assert.match(prompt, /^- src\/first\.ts \(\+700\/-0\)$/m, "the unflagged, unchanged file is the one listed");
});

test("the implement contract carries the Decisions table the fidelity lane compares against", () => {
  const parsed = parseImplementContract(`---
topic: "fixture"
status: "ready"
---

## Goal

One flow.

## Non-goals

None.

## Decisions

| D-n | 결정 | 근거 |
| --- | --- | --- |
| D-01 | keep the approved flow | the user chose it |

## Behaviors

| # | 사용자가 관찰하는 행동 | 검사 방법 | 결정 |
| --- | --- | --- | --- |
| B1 | the flow completes | judge: a capture | D-01 |

## Technical structure

None.

## Risks

None.
`);
  assert.deepEqual(parsed.decisions, [{ id: "D-01", decision: "keep the approved flow", rationale: "the user chose it" }]);
  assert.equal(renderDecisions(parsed), "- D-01: keep the approved flow (근거: the user chose it)");
});
