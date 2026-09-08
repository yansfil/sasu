import assert from "node:assert/strict";
import test from "node:test";

import {
  assertEscalateBudget,
  buildHandoffBriefing,
  recordEscalation,
  renderDiagnosis,
  solverPrompt,
  validateDiagnosis,
} from "../../dist/implement/solver.js";
import { ESCALATE_LIMIT_PER_RUN } from "../../dist/implement/types.js";
import { assertCommandAuthority } from "../../dist/implement/verbs.js";

const AT = "2026-08-29T12:00:00.000Z";
const DIAGNOSIS = {
  summary: "the implementor is rebinding the same failing command",
  likelyCause: "the check runs in the wrong cwd, so it never sees the built output",
  suggestedNextStep: "rebind the check with --cwd cli and run it once",
};

const stateWith = (escalations = []) => ({ escalations });

const escalation = (outcome = "diagnosed") => ({
  at: AT, target: "T5", reason: "stuck", profile: "high-risk", model: "m",
  outcome,
  diagnosis: outcome === "diagnosed" ? "d" : null,
  error: outcome === "diagnosed" ? null : "no backend",
  judge: null,
  durationMs: 0,
  handoff: null,
});

// --- AC33: the solver returns text and nothing else -------------------------

test("AC33: a diagnosis is exactly three text fields", () => {
  assert.deepEqual(validateDiagnosis(DIAGNOSIS), DIAGNOSIS);
  assert.match(validateDiagnosis({ ...DIAGNOSIS, summary: "" }), /summary must be a non-empty string/);
  assert.match(validateDiagnosis({ summary: "s", likelyCause: "c" }), /suggestedNextStep must be a non-empty string/);
  assert.match(validateDiagnosis(null), /must be an object/);
  assert.match(validateDiagnosis([DIAGNOSIS]), /must be an object/);
});

// A solver that returns a patch, a command, or a state change is reaching for
// an action. The contract is that it does not act, so the shape refuses to
// carry one rather than trusting the prompt to have discouraged it.
test("AC33: any field beyond the three is refused, so the solver cannot smuggle an action", () => {
  assert.match(validateDiagnosis({ ...DIAGNOSIS, patch: "diff --git ..." }), /remove patch/);
  assert.match(validateDiagnosis({ ...DIAGNOSIS, stateChange: { close: "T5" } }), /remove stateChange/);
});

test("AC33: the prompt tells the solver it does not write, and asks only for the three fields", () => {
  const prompt = solverPrompt({
    target: "T5", reason: "eight rounds on one binding",
    prd: "PRD BODY", findings: "{}", paneExcerpt: "recent output", paneProblem: null,
  });
  assert.match(prompt, /You do not write code, you do not change state, and you do not act/);
  assert.match(prompt, /PRD BODY/);
  assert.match(prompt, /eight rounds on one binding/);
  assert.match(prompt, /recent output/);
});

test("AC33: a missing diagnosis channel degrades the envelope instead of hiding the gap", () => {
  const prompt = solverPrompt({
    target: null, reason: "r", prd: "P", findings: "{}",
    paneExcerpt: null, paneProblem: "read unavailable: not running under herdr",
  });
  assert.match(prompt, /Unavailable: read unavailable: not running under herdr/);
  assert.match(prompt, /say so if that is not enough/);
  assert.match(prompt, /the run as a whole/);
});

// --- AC34: the handoff carries three artifacts and no conversation ----------

const HANDOFF = {
  prdSnapshotPath: "agents/runs/fixture/prd.md",
  diagnosisPath: "agents/runs/fixture/artifacts/solver/diagnosis-1.md",
  findingsPath: "agents/runs/fixture/artifacts/solver/findings-1.json",
};

test("AC34: the briefing names exactly the three artifacts", () => {
  const briefing = buildHandoffBriefing(HANDOFF);
  for (const value of Object.values(HANDOFF)) assert.match(briefing, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(briefing, /clean context/);
  assert.match(briefing, /previous implementor's conversation is not available/);
});

// The guarantee is structural: buildHandoffBriefing's whole input is the
// three paths, so no caller can pass a transcript through it even by
// accident. This test states that as a property rather than trusting prose.
test("AC34: no transcript can reach the briefing, because there is no parameter for one", () => {
  assert.equal(buildHandoffBriefing.length, 1, "one argument, and it is the handoff");
  const briefing = buildHandoffBriefing(HANDOFF);
  const transcript = "PRIOR-CONVERSATION-MARKER: I tried binding it eight times and it kept failing";
  assert.doesNotMatch(briefing, /PRIOR-CONVERSATION-MARKER/);
  assert.equal(buildHandoffBriefing({ ...HANDOFF, transcript }), briefing, "an extra key changes nothing; it is not read");
});

test("AC34: the diagnosis document records what was escalated and why", () => {
  const rendered = renderDiagnosis({ id: 2, at: AT, target: "AC7", reason: "no progress for 40 minutes" }, DIAGNOSIS);
  assert.match(rendered, /# Solver diagnosis 2/);
  assert.match(rendered, /target: AC7/);
  assert.match(rendered, /no progress for 40 minutes/);
  assert.match(rendered, /rebinding the same failing command/);
  assert.match(rendered, /rebind the check with --cwd cli/);
});

// --- AC35: the budget and the failed summon ---------------------------------

test("AC35: escalations are accepted below the constant bound and refused at it", () => {
  const state = stateWith([]);
  for (let spent = 0; spent < ESCALATE_LIMIT_PER_RUN; spent += 1) {
    assert.doesNotThrow(() => assertEscalateBudget(state));
    recordEscalation(state, escalation());
  }
  assert.throws(() => assertEscalateBudget(state), (error) => {
    assert.equal(error.check, "transition");
    assert.match(error.message, new RegExp(`used all ${ESCALATE_LIMIT_PER_RUN} escalations`));
    // A refusal that does not say what to do instead leaves the supervisor
    // with nowhere to go, which is how a run gets abandoned instead of closed.
    assert.match(error.message, /amend the PRD or finalize blocked/);
    return true;
  });
});

test("AC35: the refusal lists what the spent escalations actually did", () => {
  const state = stateWith([]);
  recordEscalation(state, escalation("diagnosed"));
  recordEscalation(state, escalation("summon-failed"));
  recordEscalation(state, escalation("diagnosed"));
  assert.throws(() => assertEscalateBudget(state), /#1 diagnosed, #2 summon-failed, #3 diagnosed/);
});

test("AC35: a failed summon still consumes a record, with the failure in it", () => {
  const state = stateWith([]);
  const record = recordEscalation(state, escalation("summon-failed"));
  assert.equal(record.id, 1);
  assert.equal(record.outcome, "summon-failed");
  assert.equal(record.error, "no backend");
  assert.equal(record.handoff, null, "nothing was handed off, because nobody came");
});

test("escalation ids are monotonic and derived from the ledger", () => {
  const state = stateWith([]);
  for (let index = 0; index < 3; index += 1) recordEscalation(state, escalation());
  assert.deepEqual(state.escalations.map((entry) => entry.id), [1, 2, 3]);
});

test("escalate stays an observer verb; the implementor cannot summon its own replacement", () => {
  assert.throws(() => assertCommandAuthority("escalate", "implementor"), /limited to observer, human/);
  for (const issuer of ["observer", "human"]) {
    assert.doesNotThrow(() => assertCommandAuthority("escalate", issuer));
  }
});
