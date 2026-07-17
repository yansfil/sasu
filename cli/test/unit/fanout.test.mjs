// Mechanical fan-out merge and prior-finding routing (PRD judge-fanout R3/R4,
// D-08/D-09): union, dedupe, findings-derived verdict, and area-hint routing
// are pure functions - any drift here silently changes gate verdicts.
import assert from "node:assert/strict";
import test from "node:test";
import { mergeLaneFindings, routePriorFindings } from "../../dist/gates/commands.js";
import { GAP_AUDIT_LANES, SPEC_LANES, gapAuditPrompt, specGatePrompt } from "../../dist/gates/prompts.js";

function finding(overrides = {}) {
  return {
    area: "data",
    severity: "P1",
    missing: "retention period undecided",
    recommendation: "decide retention",
    requiresHuman: false,
    ...overrides,
  };
}

test("merge: all lanes empty is a PASS with zero findings", () => {
  const merged = mergeLaneFindings([
    { laneId: "a", findings: [] },
    { laneId: "b", findings: [] },
  ]);
  assert.equal(merged.verdict, "PASS");
  assert.equal(merged.findings.length, 0);
});

test("merge: one blocking-grade finding in any lane makes the merged verdict BLOCK", () => {
  const merged = mergeLaneFindings([
    { laneId: "a", findings: [] },
    { laneId: "b", findings: [finding()] },
    { laneId: "c", findings: [] },
  ]);
  assert.equal(merged.verdict, "BLOCK");
  assert.equal(merged.findings.length, 1);
  assert.deepEqual(merged.laneFindingCounts, { a: 0, b: 1, c: 0 });
});

test("merge: P2-only findings across lanes stay a PASS with advisories", () => {
  const merged = mergeLaneFindings([
    { laneId: "a", findings: [finding({ severity: "P2", missing: "note one" })] },
    { laneId: "b", findings: [finding({ severity: "P2", missing: "note two" })] },
  ]);
  assert.equal(merged.verdict, "PASS");
  assert.equal(merged.findings.length, 2);
});

test("merge: normalized-equal findings dedupe keeping the higher severity", () => {
  const merged = mergeLaneFindings([
    { laneId: "a", findings: [finding({ severity: "P2", missing: "Retention period... UNDECIDED!" })] },
    { laneId: "b", findings: [finding({ severity: "P0", missing: "retention period undecided" })] },
  ]);
  assert.equal(merged.findings.length, 1);
  assert.equal(merged.findings[0].severity, "P0");
  assert.equal(merged.dedupedCount, 1);
  assert.equal(merged.verdict, "BLOCK");
});

test("routing: prior findings go to area-matching lanes only", () => {
  const routed = routePriorFindings(
    [{ severity: "P1", area: "ux", missing: "error state undecided" }],
    GAP_AUDIT_LANES,
  );
  assert.equal(routed.get("ux-behavior").length, 1);
  assert.equal(routed.get("data-tech").length, 0);
  assert.equal(routed.get("goal-scope").length, 0);
});

test("routing: an unmatched area is broadcast to every lane so it cannot drop", () => {
  const routed = routePriorFindings(
    [{ severity: "P0", area: "mystery", missing: "unclassifiable gap" }],
    GAP_AUDIT_LANES,
  );
  for (const lane of GAP_AUDIT_LANES) {
    assert.equal(routed.get(lane.id).length, 1, `lane ${lane.id} must receive the unmatched finding`);
  }
});

test("lane prompts: gap-audit lane prompt scopes the judge and keeps the JSON contract", () => {
  const lane = GAP_AUDIT_LANES[1];
  const prompt = gapAuditPrompt("qa log body", [], { lane, laneCount: 4 });
  assert.match(prompt, /one of 4 parallel judges/);
  assert.match(prompt, /UX, behavior, states, and recovery/);
  assert.match(prompt, /Never output a numeric score/);
});

test("lane prompts: spec lane prompt narrows to a single axis", () => {
  const prompt = specGatePrompt("prd body", "qa body", [], { lane: SPEC_LANES[1], laneCount: 3 });
  assert.match(prompt, /exactly ONE axis - TESTABILITY OF ACCEPTANCE CRITERIA/);
  assert.doesNotMatch(prompt, /\(a\) FIDELITY/);
});

test("lane prompts: fan-out rerun with no routed priors still demands origin labels", () => {
  const prompt = gapAuditPrompt("qa log body", [], { lane: GAP_AUDIT_LANES[0], laneCount: 4, rerun: true });
  assert.match(prompt, /No prior finding was\nassigned to your lane/);
  assert.match(prompt, /"origin": "new"/);
});
