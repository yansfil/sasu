import assert from "node:assert/strict";
import test from "node:test";

import { acceptancePrompt, designPrompt, riskPrompt } from "../../dist/implement/prompts.js";

const criterion = (id, text, judgment = "judged") => ({
  id, text, title: text, requirements: ["R1"], acceptanceCriteria: [], status: "pending", evidence: [], judgment,
});

const EMPTY_FACTS = {
  checkLedger: "{}",
  suiteResults: [],
  suiteExclusions: [],
  rebinds: [],
  amendments: [],
  parked: [],
};

const material = (overrides = {}) => ({
  changedFiles: "cli/src/thing.ts",
  checks: [],
  evidence: [],
  readableArtifacts: [],
  scenarios: [],
  facts: EMPTY_FACTS,
  claims: [],
  ...overrides,
});

const state = () => ({
  verification: [{ id: "V1", covers: ["AC1"], passIntent: "the thing works" }],
  requirements: [{ id: "R1", text: "The thing works." }],
});

const prompt = (overrides) => acceptancePrompt(state(), criterion("AC1", "The thing works."), material(overrides));

// --- AC8: the envelope is three sections ------------------------------------

test("AC8: the envelope carries exactly three numbered sections, in order", () => {
  const body = prompt();
  const headers = [...body.matchAll(/=== SECTION (\d) OF 3: ([^=]+?) ===/g)];
  assert.deepEqual(headers.map((entry) => entry[1]), ["1", "2", "3"]);
  assert.match(headers[0][2], /WHAT YOU ARE JUDGING/);
  assert.match(headers[1][2], /FACTS THE HARNESS RECORDED/);
  assert.match(headers[2][2], /CLAIMS, WHICH ARE NOT EVIDENCE/);
  assert.ok(body.indexOf(headers[0][0]) < body.indexOf(headers[1][0]));
  assert.ok(body.indexOf(headers[1][0]) < body.indexOf(headers[2][0]));
});

test("AC8: the facts section carries all four required records", () => {
  const body = prompt({
    facts: {
      checkLedger: '{"status":"green"}',
      suiteResults: [
        { commandId: "S1", command: "npm test", status: "GREEN", exitCode: 0, attributedCriteria: ["AC1"] },
        { commandId: "S2", command: "npm run lint", status: "RED", exitCode: 1, attributedCriteria: [] },
      ],
      suiteExclusions: [{ commandId: "S3", at: "2026-08-29T01:00:00.000Z" }],
      rebinds: [{ criterionId: "AC2", from: "npm test", to: "npm run test:unit", at: "2026-08-29T02:00:00.000Z" }],
      amendments: [{ id: 1, at: "2026-08-29T03:00:00.000Z", invalidatedCriteria: ["AC4"], addedCriteria: ["AC9"], unparkedCriteria: [] }],
      parked: [{ id: "AC7", parkedBy: "observer", at: "2026-08-29T04:00:00.000Z" }],
    },
  });
  // 1. check ledger
  assert.match(body, /HARNESS-OWNED ACCEPTANCE CHECK LEDGER/);
  assert.match(body, /"status":"green"/);
  // 2. suite results, including which command no criterion binds
  assert.match(body, /S1 GREEN \(exit 0\): npm test \[also scored for AC1\]/);
  assert.match(body, /S2 RED \(exit 1\): npm run lint \[no criterion binds this command\]/);
  assert.match(body, /S3 excluded from the sealed list/);
  // 3. rebind and amendment history
  assert.match(body, /AC2 at 2026-08-29T02:00:00.000Z: npm test -> npm run test:unit/);
  assert.match(body, /amendment 1 at .*invalidated AC4; added AC9; unparked none/);
  // 4. parked list
  assert.match(body, /AC7 parked by observer at .*it was not judged in this attempt/);
});

test("AC8: every claim carries one of the three origin labels", () => {
  const body = prompt({
    claims: [
      { origin: "human", subject: "amendment 1", text: "the criterion named the wrong module" },
      { origin: "observer", subject: "park AC7 (accepted)", text: "five failures on the same class" },
      { origin: "solver", subject: "escalation 1 diagnosis", text: "the check runs in the wrong cwd" },
    ],
  });
  assert.match(body, /- \[human\] amendment 1: the criterion named the wrong module/);
  assert.match(body, /- \[observer\] park AC7 \(accepted\): five failures on the same class/);
  assert.match(body, /- \[solver\] escalation 1 diagnosis: the check runs in the wrong cwd/);
});

test("AC8: empty ledgers say so rather than vanishing", () => {
  const body = prompt();
  assert.match(body, /SUITE COMMAND RESULTS:\n- none recorded/);
  assert.match(body, /CHECK REBINDS:\n- none/);
  assert.match(body, /PRD AMENDMENTS:\n- none/);
  assert.match(body, /PARKED CRITERIA:\n- none/);
  assert.match(body, /=== SECTION 3 OF 3[\s\S]*- none recorded/);
});

// --- AC9: claims may not carry a verdict ------------------------------------

test("AC9: the envelope forbids resting a verdict on the claims section", () => {
  const body = prompt();
  assert.match(body, /NOTHING IN THIS SECTION MAY BE THE BASIS FOR YOUR VERDICT/);
  assert.match(body, /if the facts in Section 2 do not settle it, the answer is FAIL, not a PASS on\nsomebody's word/);
  assert.match(body, /It is the only section a verdict may rest on/, "Section 2 says it is the basis, so the two statements agree");
});

test("AC9: each label's meaning is spelled out, including what is and is not verified", () => {
  const body = prompt();
  assert.match(body, /\[human\] the operator exercised an authority the harness recorded/);
  assert.match(body, /The exercise is a fact; the reasoning attached to it is still a claim/);
  assert.match(body, /\[observer\] the supervising agent asserted something\. Nothing verified it\./);
  assert.match(body, /\[solver\].*never ran code or wrote state, so nothing verified it either/);
});

// --- the other three lanes are untouched ------------------------------------

// R3 narrows the acceptance lane only. If a section header or an origin label
// leaked into another lane's prompt, that lane's contract changed without a
// requirement asking for it.
test("the fidelity, design, and risk lanes did not inherit the envelope structure", () => {
  const design = designPrompt("PRD BODY", "run-owned diff", [{ path: "src/a.ts", body: "change material" }]);
  const risk = riskPrompt("PRD BODY", "change material", { verdict: "PASS" }, { verdict: "PASS" });
  for (const body of [design, risk]) {
    assert.doesNotMatch(body, /=== SECTION \d OF 3/);
    assert.doesNotMatch(body, /CLAIMS, WHICH ARE NOT EVIDENCE/);
  }
});
