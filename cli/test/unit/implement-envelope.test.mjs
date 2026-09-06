import assert from "node:assert/strict";
import test from "node:test";

import { acceptancePrompt, designPrompt, riskPrompt } from "../../dist/implement/prompts.js";

const row = (id, behavior, evidence = "a capture") => ({
  id, behavior, check: { kind: "judge", evidence }, decisionIds: ["D-01"], status: "pending",
  attempts: [], consecutiveFailures: 0, parks: [], verdict: null, human: null, rejections: [],
});

const EMPTY_FACTS = {
  checkLedger: "{}",
  suiteResults: [],
  suiteExclusions: [],
  amendments: [],
  parked: [],
};

const material = (overrides = {}) => ({
  changedFiles: "cli/src/thing.ts",
  checks: [],
  evidence: [],
  readableArtifacts: [],
  facts: EMPTY_FACTS,
  claims: [],
  decisions: [],
  ...overrides,
});

const prompt = (overrides) => acceptancePrompt(row("B1", "The thing works."), material(overrides));

// --- the envelope is three sections -----------------------------------------

test("the envelope carries exactly three numbered sections, in order", () => {
  const body = prompt();
  const headers = [...body.matchAll(/=== SECTION (\d) OF 3: ([^=]+?) ===/g)];
  assert.deepEqual(headers.map((entry) => entry[1]), ["1", "2", "3"]);
  assert.match(headers[0][2], /WHAT YOU ARE JUDGING/);
  assert.match(headers[1][2], /FACTS THE HARNESS RECORDED/);
  assert.match(headers[2][2], /CLAIMS, WHICH ARE NOT EVIDENCE/);
  assert.ok(body.indexOf(headers[0][0]) < body.indexOf(headers[1][0]));
  assert.ok(body.indexOf(headers[1][0]) < body.indexOf(headers[2][0]));
});

test("the facts section carries the row ledger, suite results, amendment history and parked rows", () => {
  const body = prompt({
    facts: {
      checkLedger: '{"status":"green"}',
      suiteResults: [
        { commandId: "S1", command: "npm test", status: "GREEN", exitCode: 0 },
        { commandId: "S2", command: "npm run lint", status: "RED", exitCode: 1 },
      ],
      suiteExclusions: [{ commandId: "S3", at: "2026-08-29T01:00:00.000Z" }],
      amendments: [{ id: 1, at: "2026-08-29T03:00:00.000Z", scope: "check-cells", issuer: "observer", invalidatedRows: ["B4"], addedRows: [], unparkedRows: [] }],
      parked: [{ id: "B7", at: "2026-08-29T04:00:00.000Z" }],
    },
  });
  assert.match(body, /HARNESS-OWNED ROW LEDGER/);
  assert.match(body, /"status":"green"/);
  assert.match(body, /- S1 GREEN \(exit 0\): npm test/);
  assert.match(body, /- S2 RED \(exit 1\): npm run lint/);
  assert.match(body, /S3 excluded from the sealed list/);
  assert.match(body, /amendment 1 at .*\(check-cells, by observer\): invalidated B4; added none; unparked none/);
  assert.match(body, /B7 parked at .*it was not judged in this attempt/);
});

test("the cited Decisions rows travel with the row, so the judge reads why the behavior exists", () => {
  const body = prompt({ decisions: [{ id: "D-01", decision: "one runner for every command", rationale: "two executors disagreed" }] });
  assert.match(body, /CITED DECISIONS:/);
  assert.match(body, /- D-01: one runner for every command \(근거: two executors disagreed\)/);
  assert.match(body, /contradicts a cited decision does not satisfy the row/);
  assert.doesNotMatch(prompt(), /CITED DECISIONS:/, "a row that cites nothing carries no empty section");
});

test("every claim carries one of the three origin labels", () => {
  const body = prompt({
    claims: [
      { origin: "human", subject: "amendment 1", text: "the row named the wrong module" },
      { origin: "observer", subject: "park B7 (accepted)", text: "five failures on the same class" },
      { origin: "solver", subject: "escalation 1 diagnosis", text: "the check runs in the wrong cwd" },
    ],
  });
  assert.match(body, /- \[human\] amendment 1: the row named the wrong module/);
  assert.match(body, /- \[observer\] park B7 \(accepted\): five failures on the same class/);
  assert.match(body, /- \[solver\] escalation 1 diagnosis: the check runs in the wrong cwd/);
});

test("empty ledgers say so rather than vanishing", () => {
  const body = prompt();
  assert.match(body, /SUITE COMMAND RESULTS:\n- none recorded/);
  assert.match(body, /PRD AMENDMENTS:\n- none/);
  assert.match(body, /PARKED ROWS:\n- none/);
  assert.match(body, /=== SECTION 3 OF 3[\s\S]*- none recorded/);
});

// --- claims may not carry a verdict -----------------------------------------

test("the envelope forbids resting a verdict on the claims section", () => {
  const body = prompt();
  assert.match(body, /NOTHING IN THIS SECTION MAY BE THE BASIS FOR YOUR VERDICT/);
  assert.match(body, /if the facts in Section 2 do not settle it, the answer is FAIL, not a PASS on\nsomebody's word/);
  assert.match(body, /It is the only section a verdict may rest on/, "Section 2 says it is the basis, so the two statements agree");
});

test("each label's meaning is spelled out, including what is and is not verified", () => {
  const body = prompt();
  assert.match(body, /\[human\] the operator exercised an authority the harness recorded/);
  assert.match(body, /The exercise is a fact; the reasoning attached to it is still a claim/);
  assert.match(body, /\[observer\] the supervising agent asserted something\. Nothing verified it\./);
  assert.match(body, /\[solver\].*never ran code or wrote state, so nothing verified it either/);
});

// --- the other lanes are untouched ------------------------------------------

test("the design and risk lanes did not inherit the envelope structure", () => {
  const design = designPrompt("PRD BODY", "run-owned diff", [{ path: "src/a.ts", body: "change material" }]);
  const risk = riskPrompt("PRD BODY", "change material", { verdict: "PASS" }, { verdict: "PASS" });
  for (const body of [design, risk]) {
    assert.doesNotMatch(body, /=== SECTION \d OF 3/);
    assert.doesNotMatch(body, /CLAIMS, WHICH ARE NOT EVIDENCE/);
  }
});
