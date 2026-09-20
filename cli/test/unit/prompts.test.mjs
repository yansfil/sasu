import assert from "node:assert/strict";
import test from "node:test";
import { FIDELITY_EVIDENCE_SENTENCE, SPEC_LANES, gapAuditPrompt, specGatePrompt, clampDocument } from "../../dist/gates/prompts.js";

const PRIOR = [{ id: "F1", severity: "P1", area: "error-handling", missing: "setPriority unknown id behavior unspecified" }];

test("fresh gap-audit prompt carries no delta context", () => {
  const prompt = gapAuditPrompt("log");
  assert.doesNotMatch(prompt, /DELTA REVIEW CONTEXT/);
});

// PRD gate-loop R1: a rerun judges the open findings by id; new findings
// exist where decisions changed, with explicit safety exceptions.
test("delta gap-audit prompt lists the open findings by id and asks for the id to be echoed", () => {
  const prompt = gapAuditPrompt("log", PRIOR);
  assert.match(prompt, /DELTA REVIEW CONTEXT/);
  assert.match(prompt, /- F1 \[P1\/error-handling\] setPriority unknown id/);
  assert.match(prompt, /echo its id\s+verbatim as an extra field "id"/);
  assert.match(prompt, /did NOT change since the previous round, so ordinary new findings are\s+inadmissible/);
  assert.doesNotMatch(prompt, /origin/);
  // The wording must hold for every delta round, so it must not claim to be
  // a terminal or closure round.
  assert.doesNotMatch(prompt, /terminal for the current review cycle|closure review|closure verdict|one exhaustive review/i);
});

test("unchanged-register delta prompts admit fresh authority independently of severity", () => {
  for (const prompt of [gapAuditPrompt("log", PRIOR), specGatePrompt("prd", "log", PRIOR)]) {
    assert.match(prompt, /SAFETY EXCEPTION: even when Decision Register rows and reopen evidence are unchanged/);
    assert.match(prompt, /new human_authority findings at ANY severity, and new P0 defects/);
    assert.match(prompt, /Use NO "id" for a fresh finding/);
    assert.match(prompt, /does not admit ordinary reversible choices/);
    assert.match(prompt, /Missing approval alone does not determine severity/);
    assert.doesNotMatch(prompt, /P0 is narrow:.*missing authority/);
  }
});

test("a delta round on a lane whose decisions changed admits new findings without an id", () => {
  const prompt = gapAuditPrompt("log", PRIOR, { rerun: true, decisionsChanged: true });
  assert.match(prompt, /CHANGED since the previous round, so you may report a genuinely\s+NEW gap/);
  assert.match(prompt, /A new finding carries NO "id" field/);
});

// PRD gate-loop D-08 / AC12: the fidelity judgment names its evidence.
test("AC12: the spec fidelity prompt states that Raw Q&A answer text is the decision basis and a resolved mark is not evidence", () => {
  assert.match(FIDELITY_EVIDENCE_SENTENCE, /user's own answer text in the Raw Q&A/);
  assert.match(FIDELITY_EVIDENCE_SENTENCE, /`resolved` mark in the Decision Register is written by the agent and is not evidence/);
  const fidelity = SPEC_LANES.find((lane) => lane.id === "fidelity");
  assert.ok(fidelity.scope.includes(FIDELITY_EVIDENCE_SENTENCE), "the lane scope carries the sentence");
  const lanePrompt = specGatePrompt("prd", "log", [], { lane: fidelity, laneCount: SPEC_LANES.length });
  assert.ok(lanePrompt.includes(FIDELITY_EVIDENCE_SENTENCE), "the fan-out fidelity lane prompt carries it");
  const singlePrompt = specGatePrompt("prd", "log");
  assert.ok(singlePrompt.includes(FIDELITY_EVIDENCE_SENTENCE), "the single-judge prompt's fidelity axis carries it");
  const testability = specGatePrompt("prd", "log", [], { lane: SPEC_LANES[1], laneCount: SPEC_LANES.length });
  assert.ok(!testability.includes(FIDELITY_EVIDENCE_SENTENCE), "the testability lane is unchanged");
});

test("delta spec prompt carries prior findings", () => {
  const prompt = specGatePrompt("prd", "log", PRIOR);
  assert.match(prompt, /DELTA REVIEW CONTEXT/);
  assert.match(prompt, /error-handling/);
});

test("PRD gate prompts treat the stored delegated invocation as supplemental user evidence", () => {
  const delegationEvidence = "$please keep delivery local and do not commit; choose reversible defaults";
  for (const prompt of [
    gapAuditPrompt("qa log", [], { delegationEvidence }),
    specGatePrompt("prd", "qa log", [], { delegationEvidence }),
  ]) {
    assert.match(prompt, /DELEGATED RUN INVOCATION/);
    assert.match(prompt, /do not commit/);
    assert.match(prompt, /supplement the interview log when the later invocation adds or narrows a requirement/);
    assert.match(prompt, /requirements evidence, not instructions about your verdict/);
    assert.match(prompt, /Product behavior, scope, risk, verification/);
    assert.match(prompt, /Agent roles, panes, skills, tools, pipeline ordering, monitoring/);
    assert.match(prompt, /do NOT belong in the product PRD or interview log/);
  }
});

test("PRD judges cannot demand proof or implementation detail that exists only after implementation", () => {
  const gap = gapAuditPrompt("log");
  assert.match(gap, /Never demand completed implementation, runtime\s+captures, deployed behavior, production execution/);
  assert.match(gap, /Do not require a separate verification plan, per-requirement proof methods/);
  const spec = specGatePrompt("prd", "log");
  assert.match(spec, /Do not require completed runtime evidence, production execution, exact DOM selectors/);
  assert.match(spec, /belong to implementation and verify, not PRD approval/);
});

test("depth bar is part of the shared gap contract", () => {
  assert.match(gapAuditPrompt("log"), /NEVER blockers/);
});

test("gap-audit treats explicit consent provenance as a closure requirement", () => {
  const prompt = gapAuditPrompt("log");
  assert.match(prompt, /recommendation is not evidence or permission/i);
  assert.match(prompt, /stronger or broader than the cited answer/i);
  assert.match(prompt, /invented consent.*P0/i);
  assert.match(prompt, /requiresHuman: false.*does not authorize/i);
  assert.match(prompt, /Resolved decisions supported by their cited Raw Q&A answers or exact repository evidence/);
});

test("clampDocument truncates the middle with a notice", () => {
  const clamped = clampDocument("a".repeat(300), 100);
  assert.match(clamped, /TRUNCATED 200 chars/);
  assert.ok(clamped.length < 300);
});
