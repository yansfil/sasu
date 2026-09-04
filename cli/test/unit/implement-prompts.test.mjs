import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acceptancePrompt, designPrompt, designReviewPaths, fidelityPrompt, fidelitySource, IMPLEMENT_REVIEW_DIFF_MAX_CHARS, reviewDiffMaterial, riskPrompt } from "../../dist/implement/prompts.js";
import { mechanicalBindings, parseImplementContract } from "../../dist/implement/contract.js";

function contract(sourceIntake) {
  return {
    frontmatter: { source_intake: sourceIntake },
    decisionTraceability: "D-01 preserve the user's chosen flow",
    scope: "Include one flow. Non-goal: task parallelism.",
    risks: "No open decisions.",
  };
}

const state = {
  tasks: [{ id: "T1", status: "complete" }],
  acceptanceCriteria: [{ id: "AC1", status: "complete" }],
  artifacts: [],
  deviations: [],
};

test("fidelity source routing uses decision trace for conversation and fresh spec, full qa-log otherwise", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-fidelity-source-"));
  fs.writeFileSync(path.join(root, "qa-log.md"), "FULL QA LOG");

  assert.equal(fidelitySource(root, contract("current conversation"), false).routing, "decision-traceability");
  assert.equal(fidelitySource(root, contract("qa-log.md"), true).routing, "decision-traceability");
  const stale = fidelitySource(root, contract("qa-log.md"), false);
  assert.equal(stale.routing, "full-qa-log");
  assert.equal(stale.content, "FULL QA LOG");
});

test("fidelity prompt keeps the fixed five-question rubric without rejudging code proof", () => {
  const source = { routing: "decision-traceability", content: "D-01", explanation: "fixture" };
  const prompt = fidelityPrompt("FULL PRD", contract("current conversation"), state, source, [{ path: "src/changed.ts", body: "changed file" }]);
  for (const id of ["F1", "F2", "F3", "F4", "F5"]) assert.match(prompt, new RegExp(`- ${id} `));
  assert.match(prompt, /Changed paths since implement start:\n- src\/changed\.ts\n\nFILE src\/changed\.ts\nchanged file/);
  assert.match(prompt, /Do not repeat code-correctness, per-verification artifact sufficiency/);
  assert.match(prompt, /Acceptance-criterion statuses are intentionally omitted/);
  assert.doesNotMatch(prompt, /AC1=complete/);
  assert.doesNotMatch(prompt, /Judge whether each verification ID has sufficient artifacts/);
  assert.match(prompt, /FULL APPROVED PRD:\nFULL PRD/);
  assert.match(prompt, /DECISION TRACEABILITY:\nD-01 preserve the user's chosen flow/);
});

test("full qa-log supplements rather than replaces PRD decision traceability", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-fidelity-qa-log-"));
  fs.writeFileSync(path.join(root, "qa-log.md"), "FULL QA LOG");
  const parsed = contract("qa-log.md");
  const source = fidelitySource(root, parsed, false);
  const prompt = fidelityPrompt("FULL PRD", parsed, state, source, []);
  assert.match(prompt, /No run-owned source changes were detected/);
  assert.match(prompt, /CANONICAL INTENT SOURCE:\nFULL QA LOG/);
  assert.match(prompt, /DECISION TRACEABILITY:\nD-01 preserve the user's chosen flow/);
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
      { verificationId: "V5", kind: "log", path: "proof/run.log", sha256: "a".repeat(64), description: "CLI run", bytes: 10, registeredAt },
      { verificationId: "V1", kind: "command-log", path: "proof/test.log", sha256: "b".repeat(64), description: "test run", bytes: 20, registeredAt: harnessRanAt, command: "npm test", cwd: ".", exitCode: 0 },
    ],
    { verdict: "PASS", findings: [{ id: "RF1", severity: "advisory", text: "old note" }] },
    { priorAttemptId: "attempt-1", changedPaths: ["src/run.ts"], newEvidence: [{ verificationId: "V5", path: "proof/run.log", sha256: "a".repeat(64) }] },
  );
  assert.match(prompt, /V5 log proof\/run\.log sha256=/);
  assert.ok(prompt.includes(`agent-registered at ${registeredAt}; treat as the implementer's claim, not a harness observation`));
  assert.ok(prompt.includes(`the harness ran \`npm test\` at ${harnessRanAt} from cwd=.`));
  assert.match(prompt, /not a vote in the unified acceptance\/fidelity verdict/);
  assert.match(prompt, /Resolving one requires a deltaBasis/);
  assert.match(prompt, /ROUND-2\+ DELTA CONTRACT/);
  assert.match(prompt, /Disposition every prior finding by its supplied id as resolved or unresolved/);
  assert.match(prompt, /deltaBasis.*one exact path.*CHANGED PATHS SINCE THE PRIOR ROUND/s);
  assert.match(prompt, /"origin": "prior-unresolved" \| "new"/);
  assert.doesNotMatch(prompt, /"new on round 2\+"/);
  assert.match(prompt, /V5:proof\/run\.log/);
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

test("explicit verify commands bind nested product checks instead of detected harness checks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-implement-bindings-"));
  fs.mkdirSync(path.join(root, "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "agents", "config.json"),
    JSON.stringify({ verify: { commands: { test: "node pokemon-rpg/test/rules.test.mjs", build: "node pokemon-rpg/test/static-check.mjs" } } }),
  );
  const bindings = mechanicalBindings(root, root, [
    { id: "V1", mode: "build/static", passIntent: "product static proof", covers: [], requiredForDone: true, canBeBlocked: false, text: "", title: "", status: "NOT_RUN", evidence: [] },
    { id: "V2", mode: "automated behavior", passIntent: "product rules proof", covers: [], requiredForDone: true, canBeBlocked: false, text: "", title: "", status: "NOT_RUN", evidence: [] },
  ]);
  assert.deepEqual(bindings, [
    { command: "node pokemon-rpg/test/static-check.mjs", cwd: ".", verificationIds: ["V1"] },
    { command: "node pokemon-rpg/test/rules.test.mjs", cwd: ".", verificationIds: ["V2"] },
  ]);
});

test("acceptance prompt is scoped to one criterion and its mapped proof", () => {
  const registeredAt = "2026-08-25T06:14:00.000Z";
  const scopedState = {
    requirements: [
      { id: "R1", text: "first requirement" },
      { id: "R2", text: "second requirement" },
    ],
    verification: [
      { id: "V1", covers: ["AC1"], passIntent: "prove first" },
      { id: "V2", covers: ["AC2"], passIntent: "prove second" },
    ],
  };
  const criterion = { id: "AC2", text: "second criterion", requirements: ["R2"] };
  const prompt = acceptancePrompt(scopedState, criterion, {
    changedFiles: "- src/second.ts [text, 80 bytes]",
    checks: [{ criterionId: "AC2", command: "npm test", exitCode: 0, tail: "SECOND-MECHANICAL-PROOF" }],
    evidence: [{ criterionId: "AC2", path: "second.log", sha256: "b".repeat(64), bytes: 21, text: "SECOND-ARTIFACT-BODY" }],
    readableArtifacts: [{ path: "second.png", kind: "screenshot", sha256: "c".repeat(64), bytes: 42, description: "second screen", registeredAt }],
    scenarios: [],
    // Section 2/3 of the envelope. Empty ledgers here: these two cases are
    // about criterion scoping and scenario cards, not about the facts split.
    facts: { checkLedger: "{}", suiteResults: [], suiteExclusions: [], rebinds: [], amendments: [], parked: [] },
    claims: [],
  });
  assert.match(prompt, /AC2: second criterion/);
  assert.match(prompt, /"id": "AC2"/);
  assert.match(prompt, /R2: second requirement/);
  assert.match(prompt, /V2: prove second/);
  assert.match(prompt, /SECOND-MECHANICAL-PROOF/);
  assert.match(prompt, /SECOND-ARTIFACT-BODY/);
  assert.match(prompt, /second\.png/);
  assert.ok(prompt.includes(`agent-registered at ${registeredAt}; treat as the implementer's claim, not a harness observation`));
  assert.match(prompt, /a PASS relying on it must explain in reason why that evidence remains valid/);
  assert.match(prompt, /src\/second\.ts \[text, 80 bytes\]/);
  assert.doesNotMatch(prompt, /AC1:|R1:|V1:|first\.log|RUN-OWNED CHANGE MATERIAL|MAPPED USER SCENARIOS/);
});

test("mapped scenario cards travel to the acceptance judge with their full body", () => {
  const scopedState = {
    requirements: [],
    verification: [{ id: "V1", covers: ["AC1", "SC1"], passIntent: "main flow works" }],
  };
  const criterion = { id: "AC1", text: "the flow completes", requirements: [] };
  const prompt = acceptancePrompt(scopedState, criterion, {
    changedFiles: "- none",
    checks: [],
    evidence: [],
    readableArtifacts: [],
    scenarios: [{ id: "SC1", text: "Invite: Primary path: B joins. Failure state: expired link notice. Recovery: reissue works." }],
    // Section 2/3 of the envelope. Empty ledgers here: these two cases are
    // about criterion scoping and scenario cards, not about the facts split.
    facts: { checkLedger: "{}", suiteResults: [], suiteExclusions: [], rebinds: [], amendments: [], parked: [] },
    claims: [],
  });
  assert.match(prompt, /MAPPED USER SCENARIOS/);
  assert.match(prompt, /SC1: Invite: Primary path: B joins\. Failure state: expired link notice\. Recovery: reissue works\./);
  assert.match(prompt, /happy-path-only proof does not satisfy/);
});

test("implement contract parses 2.1 scenario cards and carries SC ids into V covers", () => {
  const parsed = parseImplementContract(`---\nstatus: ready\n---\n\n## 2. Problem, Goal, And Users\n\n### 2.1 User Scenarios\n\n- SC1. Invite flow: A invites, B joins.\n  Failure state: expired link shows a notice.\n\n## 6. Requirements\n\n- R1. inviting works. Covers AC1.\n\n## 7. Acceptance Criteria\n\n- AC1. B can join through a link.\n\n## 8. PRD-Level Tasks\n\n- T1. build it. Covers R1.\n\n## 9. Verification Contract\n\n| ID | Mode | Covers | Pass Intent | Required For Done | Can Be Blocked |\n| --- | --- | --- | --- | --- | --- |\n| V1 | automated behavior | R1, AC1, SC1 | flow proven | yes | no |\n`);
  assert.equal(parsed.scenarios.length, 1);
  assert.equal(parsed.scenarios[0].id, "SC1");
  assert.match(parsed.scenarios[0].text, /expired link shows a notice/);
  assert.ok(parsed.verification[0].covers.includes("SC1"), JSON.stringify(parsed.verification[0].covers));
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

test("implement contract extracts nested Decision Traceability content", () => {
  const parsed = parseImplementContract(`---\nstatus: ready\n---\n\n## 4. Pre-Work And Required Decisions\n\n### 4.3 Decision Traceability For Fidelity Review\n\n- D-01 keep the approved flow\n`);
  assert.match(parsed.decisionTraceability, /D-01 keep the approved flow/);
});
