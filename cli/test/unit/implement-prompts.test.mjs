import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acceptancePrompt, designPrompt, fidelityPrompt, fidelitySource, riskPrompt } from "../../dist/implement/prompts.js";
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
  const prompt = fidelityPrompt("FULL PRD", contract("current conversation"), state, source, "changed file");
  for (const id of ["F1", "F2", "F3", "F4", "F5"]) assert.match(prompt, new RegExp(`- ${id} `));
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
  const prompt = fidelityPrompt("FULL PRD", parsed, state, source, "changed file");
  assert.match(prompt, /CANONICAL INTENT SOURCE:\nFULL QA LOG/);
  assert.match(prompt, /DECISION TRACEABILITY:\nD-01 preserve the user's chosen flow/);
  assert.match(prompt, /FULL APPROVED PRD:\nFULL PRD/);
});

test("risk prompt receives the complete artifact roster and the exact round-2 delta contract", () => {
  const prompt = riskPrompt(
    "FULL PRD",
    "changed source",
    { verdict: "PASS" },
    { verdict: "PASS" },
    [{ verificationId: "V5", kind: "log", path: "proof/run.log", sha256: "a".repeat(64), description: "CLI run", bytes: 10, sourceFingerprint: "source", registeredAt: "now" }],
    { verdict: "PASS", findings: [{ id: "RF1", severity: "advisory", text: "old note" }] },
    { priorAttemptId: "attempt-1", changedPaths: ["src/run.ts"], newEvidence: [{ verificationId: "V5", path: "proof/run.log", sha256: "a".repeat(64) }] },
  );
  assert.match(prompt, /V5 log proof\/run\.log sha256=/);
  assert.match(prompt, /ROUND-2\+ DELTA CONTRACT/);
  assert.match(prompt, /Disposition every prior finding by its supplied id as resolved or unresolved/);
  assert.match(prompt, /deltaBasis.*one exact path.*CHANGED PATHS SINCE THE PRIOR ROUND/s);
  assert.match(prompt, /"origin": "prior-unresolved" \| "new"/);
  assert.doesNotMatch(prompt, /"new on round 2\+"/);
  assert.match(prompt, /V5:proof\/run\.log/);
  assert.match(prompt, /Artifact bytes remain in the record tree and are not readable in this lane/);
});

test("design and risk prompts bound oversized diffs and name the isolated read surface", () => {
  const completeDiff = `FIRST_CHANGED_LINE\n${"x".repeat(130_000)}\nLAST_CHANGED_LINE`;
  const readable = ["src/large.ts"];
  const design = designPrompt("PRD", completeDiff, "BOUNDED FILE BODY", readable);
  const risk = riskPrompt("PRD", completeDiff, { verdict: "PASS" }, { verdict: "PASS" }, [], null, undefined, readable);
  for (const prompt of [design, risk]) {
    assert.match(prompt, /1300\d+-character diff omitted/);
    assert.match(prompt, /isolated read-only access/);
    assert.match(prompt, /- src\/large\.ts/);
    assert.doesNotMatch(prompt, /FIRST_CHANGED_LINE|LAST_CHANGED_LINE/);
    assert.ok(prompt.length < 125_000);
  }
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
    readableArtifacts: [{ path: "second.png", kind: "screenshot", sha256: "c".repeat(64), bytes: 42, description: "second screen" }],
    scenarios: [],
  });
  assert.match(prompt, /AC2: second criterion/);
  assert.match(prompt, /"id": "AC2"/);
  assert.match(prompt, /R2: second requirement/);
  assert.match(prompt, /V2: prove second/);
  assert.match(prompt, /SECOND-MECHANICAL-PROOF/);
  assert.match(prompt, /SECOND-ARTIFACT-BODY/);
  assert.match(prompt, /second\.png/);
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
  const prompt = designPrompt("PRD BODY", "RUN OWNED DIFF", "CURRENT FILE BODY");
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

test("implement contract extracts nested Decision Traceability content", () => {
  const parsed = parseImplementContract(`---\nstatus: ready\n---\n\n## 4. Pre-Work And Required Decisions\n\n### 4.3 Decision Traceability For Fidelity Review\n\n- D-01 keep the approved flow\n`);
  assert.match(parsed.decisionTraceability, /D-01 keep the approved flow/);
});
