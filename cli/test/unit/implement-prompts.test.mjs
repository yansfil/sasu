import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acceptancePrompt, fidelityPrompt, fidelitySource } from "../../dist/implement/prompts.js";
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
    artifacts: [
      { verificationId: "V1", kind: "log", path: "first.log", sha256: "a", description: "first" },
      { verificationId: "V2", kind: "log", path: "second.log", sha256: "b", description: "second" },
    ],
  };
  const criterion = { id: "AC1", text: "first criterion", requirements: ["R1"] };
  const prompt = acceptancePrompt(scopedState, criterion, "changed file", [
    { status: "PASS", cwd: ".", command: "first", verificationIds: ["V1"], logPath: "first-command.log" },
    { status: "PASS", cwd: ".", command: "second", verificationIds: ["V2"], logPath: "second-command.log" },
  ]);
  assert.match(prompt, /AC1: first criterion/);
  assert.match(prompt, /R1: first requirement/);
  assert.match(prompt, /V1: prove first/);
  assert.match(prompt, /first\.log/);
  assert.doesNotMatch(prompt, /AC2|R2:|V2:|second\.log|command=second/);
});

test("implement contract extracts nested Decision Traceability content", () => {
  const parsed = parseImplementContract(`---\nstatus: ready\n---\n\n## 4. Pre-Work And Required Decisions\n\n### 4.3 Decision Traceability For Fidelity Review\n\n- D-01 keep the approved flow\n`);
  assert.match(parsed.decisionTraceability, /D-01 keep the approved flow/);
});
