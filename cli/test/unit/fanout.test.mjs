// Mechanical fan-out merge and prior-finding routing (PRD judge-fanout R3/R4,
// D-08/D-09): union, dedupe, findings-derived verdict, and area-hint routing
// are pure functions - any drift here silently changes gate verdicts.
import assert from "node:assert/strict";
import test from "node:test";
import { applyOpenSetContract, mergeLaneFindings, routePriorFindings } from "../../dist/gates/commands.js";
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

test("merge: a human-required P2 is promoted to P1 and blocks", () => {
  const merged = mergeLaneFindings([
    { laneId: "a", findings: [finding({ severity: "P2", requiresHuman: true })] },
  ]);
  assert.equal(merged.verdict, "BLOCK");
  assert.equal(merged.findings[0].severity, "P1");
  assert.equal(merged.findings[0].requiresHuman, true);
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

test("merge: equal-severity duplicates preserve the human-required finding", () => {
  const merged = mergeLaneFindings([
    { laneId: "a", findings: [finding({ requiresHuman: false })] },
    { laneId: "b", findings: [finding({ requiresHuman: true })] },
  ]);
  assert.equal(merged.findings.length, 1);
  assert.equal(merged.findings[0].requiresHuman, true);
  assert.equal(merged.verdict, "BLOCK");
});

test("merge: mixed-severity duplicates preserve requiresHuman in either order", () => {
  for (const findings of [
    [finding({ severity: "P0", requiresHuman: false }), finding({ severity: "P1", requiresHuman: true })],
    [finding({ severity: "P1", requiresHuman: true }), finding({ severity: "P0", requiresHuman: false })],
  ]) {
    const merged = mergeLaneFindings([
      { laneId: "a", findings: [findings[0]] },
      { laneId: "b", findings: [findings[1]] },
    ]);
    assert.equal(merged.findings.length, 1);
    assert.equal(merged.findings[0].severity, "P0");
    assert.equal(merged.findings[0].requiresHuman, true);
    assert.equal(merged.verdict, "BLOCK");
  }
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
  const prompt = specGatePrompt("prd body", "qa body", [], { lane: SPEC_LANES[1], laneCount: SPEC_LANES.length });
  assert.match(prompt, /exactly ONE axis - REQUIREMENT CLARITY AND OBSERVABILITY/);
  assert.doesNotMatch(prompt, /\(a\) FIDELITY/);
});

// The verification-completeness lane is gone (its R#/AC# walk was
// deterministic work the prelint does at $0), so the two survivors must keep
// its semantic residue and absorb its re-run finding routing.
test("spec lanes: two lanes remain and old verification/coverage findings route to testability", () => {
  assert.deepEqual(SPEC_LANES.map((lane) => lane.id), ["fidelity", "testability"]);
  assert.match(SPEC_LANES[1].scope, /observable user outcome/i);
  assert.match(SPEC_LANES[1].scope, /Do not prescribe a proof method per requirement/i);
  const routed = routePriorFindings(
    [
      { severity: "P1", area: "verification", missing: "V2 pass intent unobservable" },
      { severity: "P1", area: "coverage", missing: "R3 has no disposition" },
    ],
    SPEC_LANES,
  );
  assert.equal(routed.get("testability").length, 2, "old lane areas must land in the surviving lane, not broadcast");
  assert.equal(routed.get("fidelity").length, 0);
});

test("lane prompts: a rerun lane with no routed open finding is told so, and told whether new findings are admissible", () => {
  const unchanged = gapAuditPrompt("qa log body", [], { lane: GAP_AUDIT_LANES[0], laneCount: 4, rerun: true, decisionsChanged: false });
  assert.match(unchanged, /No open finding is assigned to your lane/);
  assert.match(unchanged, /did NOT change since the previous round, so no new finding is\s+admissible/);
  assert.doesNotMatch(unchanged, /origin/);
  const changed = gapAuditPrompt("qa log body", [], { lane: GAP_AUDIT_LANES[0], laneCount: 4, rerun: true, decisionsChanged: true });
  assert.match(changed, /CHANGED since the previous round, so you may report a genuinely\s+NEW gap/);
});

// PRD gate-loop R3: goal-scope and data-tech findings are recorded but do not
// block; a requiresHuman finding blocks whichever lane reported it.
test("merge: a non-blocking lane's finding is an advisory unless it needs a human decision", () => {
  const scope = { area: "scope", severity: "P1", missing: "non-goal missing", recommendation: "r", requiresHuman: false };
  const human = { area: "data", severity: "P1", missing: "retention", recommendation: "r", requiresHuman: true };
  const merged = mergeLaneFindings([
    { laneId: "goal-scope", blocking: false, findings: [scope] },
    { laneId: "data-tech", blocking: false, findings: [human] },
    { laneId: "ux-behavior", blocking: true, findings: [] },
  ]);
  assert.deepEqual(merged.advisories.map((f) => f.missing), ["non-goal missing"]);
  assert.deepEqual(merged.findings.map((f) => f.missing), ["retention"]);
  assert.equal(merged.verdict, "BLOCK");
  const blockingTwin = mergeLaneFindings([
    { laneId: "goal-scope", blocking: false, findings: [scope] },
    { laneId: "ux-behavior", blocking: true, findings: [{ ...scope, area: "ux" }] },
  ]);
  assert.equal(blockingTwin.advisories.length, 0, "the same gap reported by a blocking lane blocks");
  assert.equal(blockingTwin.dedupedCount, 1);
  // Severity floor: a warning lane demotes its P1 noise, never a P0 (RF3).
  const p0 = mergeLaneFindings([
    { laneId: "data-tech", blocking: false, findings: [{ ...scope, area: "data", severity: "P0", missing: "credentials logged in plain text" }] },
  ]);
  assert.deepEqual(p0.findings.map((f) => f.missing), ["credentials logged in plain text"]);
  assert.equal(p0.advisories.length, 0);
  assert.equal(p0.verdict, "BLOCK");
});

test("open set: on a rerun only echoed ids survive, and new findings need a changed lane", () => {
  const prior = [{ id: "F1", severity: "P1", area: "ux", missing: "a" }, { id: "F2", severity: "P1", area: "ux", missing: "b" }];
  const base = { area: "ux", severity: "P1", recommendation: "r", requiresHuman: false };
  const out = applyOpenSetContract({
    prior,
    rerun: true,
    lanes: [
      { laneId: "ux-behavior", blocking: true, decisionsChanged: false, findings: [{ ...base, id: "F1", missing: "a still" }, { ...base, missing: "new c" }] },
      { laneId: "risk-ops-verification", blocking: true, decisionsChanged: true, findings: [{ ...base, area: "risk", missing: "new d" }, { ...base, id: "F9", missing: "unknown id" }] },
    ],
  });
  assert.deepEqual(out.findings.map((f) => f.id ?? f.missing), ["F1", "new d", "unknown id"], "an unknown id is a new finding, admitted only because its lane changed");
  assert.deepEqual(out.resolved.map((f) => f.id), ["F2"]);
  assert.deepEqual(out.dropped.map((f) => f.missing), ["new c"]);
  assert.equal(out.verdict, "BLOCK");
  // Severity floor: an unchanged lane still cannot drop a new P0 (RF4).
  const floor = applyOpenSetContract({
    prior,
    rerun: true,
    lanes: [{ laneId: "ux-behavior", blocking: true, decisionsChanged: false, findings: [{ ...base, id: "F1", missing: "a still" }, { ...base, severity: "P0", missing: "new destructive default" }] }],
  });
  assert.deepEqual(floor.findings.map((f) => f.id ?? f.missing), ["F1", "new destructive default"]);
  assert.deepEqual(floor.dropped, []);
  const allHuman = applyOpenSetContract({
    prior: [],
    rerun: false,
    lanes: [{ laneId: "ux-behavior", blocking: true, decisionsChanged: false, findings: [{ ...base, missing: "needs a person", requiresHuman: true, id: "F7" }] }],
  });
  assert.equal(allHuman.verdict, "NEEDS_HUMAN");
  assert.equal(allHuman.findings[0].id, undefined, "a first round strips any id the judge invented");
  const empty = applyOpenSetContract({ prior: [], rerun: false, lanes: [] });
  assert.equal(empty.verdict, "PASS");
});
