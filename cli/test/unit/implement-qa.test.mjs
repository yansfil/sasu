import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveBriefSteps,
  issueQaBrief,
  latestBriefFor,
  registerTrail,
  resolveDriverRole,
  TrailRejected,
} from "../../dist/implement/qa.js";
import { assertCommandAuthority } from "../../dist/implement/verbs.js";

const row = (id, behavior, check = { kind: "judge", evidence: "" }) => ({
  id, behavior, check, decisionIds: [], status: check.kind === "human" ? "OPEN" : "pending",
  attempts: [], consecutiveFailures: 0, parks: [], verdict: null, human: null, rejections: [],
});
const judge = (id, behavior, evidence = "") => row(id, behavior, { kind: "judge", evidence });

const stateWith = (rows, artifacts = []) => ({
  prd: { sha256: "a".repeat(64) },
  rows,
  artifacts,
  qaBriefs: [],
  trails: [],
  evidenceReplacements: [],
});

const AT = "2026-08-29T12:00:00.000Z";

// --- script derivation and brief identity -----------------------------------

test("the script is derived from the whole sealed row, behavior then evidence", () => {
  const steps = deriveBriefSteps(judge(
    "B1",
    "The status output names the parked row. The reason is visible without scrolling.",
    "A capture of the summary output.",
  ));
  assert.deepEqual(steps.map((step) => step.id), ["S1", "S2", "S3"]);
  assert.match(steps[0].text, /names the parked row/);
  assert.match(steps[1].text, /without scrolling/);
  assert.match(steps[2].text, /capture of the summary/, "what must be captured is a step too; a drive without it is unfinished");
});

test("the author's own enumerators become separate steps", () => {
  const steps = deriveBriefSteps(judge(
    "B2",
    "The observer can name three things: ①the stalled row and why ②the verbs available now ③the recommended next move.",
  ));
  assert.equal(steps.length, 4, "the lead-in plus one step per enumerated item");
  assert.match(steps[1].text, /stalled row/);
  assert.match(steps[2].text, /verbs available/);
  assert.match(steps[3].text, /recommended next move/);
});

// A single marker is a reference, not a list. Splitting on it would shred a
// sentence that merely cites an item, which is the overfit this guards.
test("a lone enumerator does not split a sentence", () => {
  const steps = deriveBriefSteps(judge("B1", "Confirm the behaviour described in ① above."));
  assert.equal(steps.length, 1);
});

test("reissuing for the same row mints a distinct briefId", () => {
  const state = stateWith([judge("B1", "The summary is readable.")]);
  const first = issueQaBrief(state, state.rows[0], AT);
  const second = issueQaBrief(state, state.rows[0], AT);
  assert.notEqual(first.briefId, second.briefId, "an identical script at the same instant must still be a new brief");
  assert.match(first.briefId, /^B1-Q1-[0-9a-f]{12}$/);
  assert.match(second.briefId, /^B1-Q2-[0-9a-f]{12}$/);
  assert.equal(latestBriefFor(state, "B1").briefId, second.briefId);
  assert.equal(state.qaBriefs.length, 2, "the superseded brief stays readable");
  assert.equal(first.prdSha256, state.prd.sha256);
});

test("only judge: rows get a brief", () => {
  const state = stateWith([
    row("B1", "The runner runs once.", { kind: "check", command: "npm test", argv: ["npm", "test"] }),
    row("B2", "The operator likes it.", { kind: "human", confirmation: "the operator says so" }),
  ]);
  for (const entry of state.rows) {
    assert.throws(() => issueQaBrief(state, entry, AT), (error) => {
      assert.ok(error instanceof TrailRejected);
      return /qa-brief issues scripts for judge: rows only/.test(error.message);
    });
  }
});

// --- the three exit checks --------------------------------------------------

function readyState() {
  const state = stateWith([judge("B1", "Step one happens. Step two happens.", "A capture.")]);
  const brief = issueQaBrief(state, state.rows[0], AT);
  return { state, brief };
}

const register = (state, brief, overrides = {}) => registerTrail(state, {
  rowId: "B1",
  briefId: brief.briefId,
  driverRole: "human",
  coveredStepIds: brief.steps.map((step) => step.id),
  artifactPaths: [],
  ...overrides,
}, AT);

test("a briefId that was never issued is refused and points at the real one", () => {
  const { state, brief } = readyState();
  assert.throws(() => register(state, brief, { briefId: "B1-Q9-deadbeef" }), (error) => {
    assert.equal(error.check, "arguments");
    assert.match(error.message, new RegExp(brief.briefId));
    return /only briefing channel/.test(error.message);
  });
  assert.equal(state.trails.length, 0);
});

test("a row with no brief yet is told how to get one", () => {
  const state = stateWith([judge("B1", "Something happens.")]);
  assert.throws(() => registerTrail(state, { rowId: "B1", briefId: "B1-Q1-x", driverRole: "human", coveredStepIds: [], artifactPaths: [] }, AT), /sasu implement qa-brief --row B1/);
});

test("a stale briefId is refused after a reissue", () => {
  const { state, brief } = readyState();
  const reissued = issueQaBrief(state, state.rows[0], AT);
  assert.throws(() => register(state, brief), (error) => {
    assert.equal(error.check, "transition");
    return new RegExp(`${brief.briefId} is superseded`).test(error.message);
  });
  assert.doesNotThrow(() => register(state, reissued));
});

test("an uncovered step is refused and the refusal names it with its text", () => {
  const { state, brief } = readyState();
  assert.throws(() => register(state, brief, { coveredStepIds: ["S1"] }), (error) => {
    assert.equal(error.check, "arguments");
    assert.match(error.message, /uncovered steps: S2/);
    assert.match(error.message, /Step two happens/, "the driver has to know which step to go back and do");
    return true;
  });
  assert.equal(state.trails.length, 0);
});

test("a step that is not in the brief is refused", () => {
  const { state, brief } = readyState();
  assert.throws(
    () => register(state, brief, { coveredStepIds: [...brief.steps.map((step) => step.id), "S9"] }),
    /S9 is not in brief/,
  );
});

test("coverage is a set comparison, so order and case do not matter", () => {
  const { state, brief } = readyState();
  const record = register(state, brief, { coveredStepIds: ["s3", "s1", "s2"] });
  assert.equal(record.status, "accepted");
  assert.deepEqual(record.coveredStepIds, ["S1", "S2", "S3"], "the record stores the script's own ids, not the driver's spelling");
});

// --- driver eligibility -----------------------------------------------------

test("the implementor and the solver are refused by name, with the reason", () => {
  assert.throws(() => resolveDriverRole("implementor"), (error) => {
    assert.equal(error.check, "authority");
    return /may not drive the criterion it built/.test(error.message);
  });
  assert.throws(() => resolveDriverRole("solver"), /diagnoses and never drives/);
  assert.throws(() => resolveDriverRole("qa_agent"), /unknown --driver qa_agent/);
  assert.throws(() => resolveDriverRole(undefined), /trail requires --driver/);
});

test("the three eligible roles are accepted and recorded as declared", () => {
  for (const role of ["human", "observer", "qa-agent"]) {
    assert.equal(resolveDriverRole(role.toUpperCase()), role);
    const { state, brief } = readyState();
    assert.equal(register(state, brief, { driverRole: role }).driverRole, role);
  }
});

test("the refusal says the role is declared, not authenticated", () => {
  assert.throws(() => resolveDriverRole("implementor"), /self-declaration recorded for audit, not an authenticated identity/);
});

test("qa-brief and trail are open to every issuer; the driver role is the gate", () => {
  for (const issuer of ["implementor", "observer", "human"]) {
    assert.doesNotThrow(() => assertCommandAuthority("qa-brief", issuer));
    assert.doesNotThrow(() => assertCommandAuthority("trail", issuer));
  }
});

// --- record keeping ----------------------------------------------------------

test("a later accepted trail supersedes the earlier one rather than deleting it", () => {
  const { state, brief } = readyState();
  const first = register(state, brief);
  const second = register(state, brief);
  assert.deepEqual(state.trails.map((entry) => entry.id), [1, 2]);
  assert.equal(state.trails[0].status, "superseded");
  assert.equal(state.trails[1].status, "accepted");
  assert.equal(first.briefId, second.briefId);
  assert.equal(state.evidenceReplacements.length, 1);
  assert.equal(state.evidenceReplacements[0].rowId, "B1");
  assert.equal(state.evidenceReplacements[0].priorDisposition, "preserved");
});

test("a trail may only name artifacts the run has registered", () => {
  const { state, brief } = readyState();
  assert.throws(() => register(state, brief, { artifactPaths: ["shots/missing.png"] }), /unregistered artifact\(s\): shots\/missing.png/);
  state.artifacts.push({ kind: "screenshot", path: "shots/real.png", description: "d", sha256: "x", bytes: 1, registeredAt: AT });
  assert.deepEqual(register(state, brief, { artifactPaths: ["shots/real.png"] }).artifactPaths, ["shots/real.png"]);
});
