import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acceptancePrompt, designPrompt, fidelityPrompt, fidelitySource } from "../../dist/implement/prompts.js";
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

test("explicit verify commands bind nested product checks instead of detected harness checks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-implement-bindings-"));
  fs.mkdirSync(path.join(root, "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "agents", "config.json"),
    JSON.stringify({ verify: { commands: { test: "node pokemon-rpg/test/rules.test.mjs", build: "node pokemon-rpg/test/static-check.mjs" } } }),
  );
  const bindings = mechanicalBindings(root, [
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

test("design prompt is advisory-only and scoped to what other lanes do not read", () => {
  const prompt = designPrompt("PRD BODY", "CHANGE MATERIAL");
  assert.match(prompt, /advisory design reviewer/);
  assert.match(prompt, /never block the run/);
  assert.match(prompt, /"verdict": "PASS"/);
  assert.doesNotMatch(prompt, /"FAIL"/);
  assert.match(prompt, /One cause patched as N symptoms/);
  assert.match(prompt, /No style nitpicks/);
  assert.match(prompt, /CHANGE MATERIAL/);
  assert.match(prompt, /PRD BODY/);
});

test("implement contract extracts nested Decision Traceability content", () => {
  const parsed = parseImplementContract(`---\nstatus: ready\n---\n\n## 4. Pre-Work And Required Decisions\n\n### 4.3 Decision Traceability For Fidelity Review\n\n- D-01 keep the approved flow\n`);
  assert.match(parsed.decisionTraceability, /D-01 keep the approved flow/);
});
