import assert from "node:assert/strict";
import test from "node:test";
import { latestAttemptResult, reconcileRiskFindings, validateRiskVerdict, reconcileReviewFindings, reconcileParallelReviewFindings, verificationInputManifest, verificationRoundContext } from "../../dist/implement/convergence.js";
import { REVIEW_PASS, defect } from "../helpers/implement-fixture.mjs";

test("parallel reconciliation retains different defects sharing a requirement and only deduplicates identical content", () => {
  const first = defect();
  const second = defect({ problem: "The error path silently discards the approved value." });
  const next = reconcileParallelReviewFindings([], {
    fidelity: { ...REVIEW_PASS, findings: [first] },
    code: { ...REVIEW_PASS, findings: [structuredClone(first), second] },
  }, "V1", "2026-09-08T00:00:00.000Z");
  assert.deepEqual(next.map((entry) => [entry.id, entry.problem]), [["F1", first.problem], ["F2", second.problem]]);
});

test("both roles must explicitly resolve a prior defect; missing or disputed disposition stays open", () => {
  const initial = reconcileReviewFindings([], { ...REVIEW_PASS, findings: [defect()] }, "V1", "2026-09-08T00:00:00.000Z");
  const response = (status) => ({ ...REVIEW_PASS, priorDispositions: [{ findingId: "F1", status, reason: status === "open" ? "The failing input still loses its value." : "The public path preserves the input now.", evidenceRefs: ["implementation.txt"] }] });
  for (const code of [null, response("open")]) {
    const next = reconcileParallelReviewFindings(initial, { fidelity: response("resolved"), code }, "V2", "2026-09-08T01:00:00.000Z");
    assert.equal(next.length, 1);
    assert.equal(next[0].id, "F1");
    assert.equal(next[0].status, "open");
    assert.match(next[0].history.at(-1).reason, /fidelity: resolved/);
    assert.match(next[0].history.at(-1).reason, /code: (open|no completed disposition)/);
  }
  const closed = reconcileParallelReviewFindings(initial, { fidelity: response("resolved"), code: response("resolved") }, "V2", "2026-09-08T01:00:00.000Z");
  assert.equal(closed[0].status, "resolved");
  assert.equal(initial[0].status, "open", "reconciliation must not change the pinned prior ledger");
});

test("parallel continued findings preserve stable authority and both explanations without double-closing", () => {
  const human = { kind: "human-confirmation", requirementRefs: ["B1"], problem: "The user must authorize destructive reset.", evidenceRefs: ["Risks"], nextAction: "Obtain the reserved approval.", human: { sourceRef: "Risks", quote: "The user must authorize reset before execution.", timing: "prerequisite" } };
  const initial = reconcileReviewFindings([], { ...REVIEW_PASS, findings: [human] }, "V1", "2026-09-08T00:00:00.000Z");
  const result = { ...REVIEW_PASS, findings: [{ ...human, priorFindingId: "F1" }], priorDispositions: [{ findingId: "F1", status: "open", reason: "Approval is still absent.", evidenceRefs: ["Risks"] }] };
  const next = reconcileParallelReviewFindings(initial, { fidelity: result, code: result }, "V2", "2026-09-08T01:00:00.000Z");
  assert.equal(next.length, 1);
  assert.deepEqual(next[0].human, human.human);
  assert.equal(next[0].status, "open");
  assert.match(next[0].history.at(-1).reason, /fidelity: open/);
  assert.match(next[0].history.at(-1).reason, /code: open/);
  const weakened = { ...result, findings: [{ ...result.findings[0], human: { ...human.human, timing: "post-completion" } }] };
  assert.throws(() => reconcileParallelReviewFindings(initial, { fidelity: result, code: weakened }, "V2", "2026-09-08T01:00:00.000Z"), /cannot change its authority source or timing/);
});

test("risk findings get stable ids and every prior finding is dispositioned on round 2+", () => {
  const first = validateRiskVerdict({
    verdict: "PASS",
    findings: [{ severity: "advisory", text: "consider a narrower permission" }],
  }, null, { priorAttemptId: null, changedPaths: [], newEvidence: [] });
  assert.notEqual(typeof first, "string");
  assert.deepEqual(first.findings, [{ id: "RF1", severity: "advisory", text: "consider a narrower permission" }]);

  const context = { priorAttemptId: "attempt-1", changedPaths: ["src/auth.ts"], newEvidence: [] };
  assert.match(validateRiskVerdict({ verdict: "PASS", findings: [] }, first, context), /priorDispositions/);
  const second = validateRiskVerdict({
    verdict: "FAIL",
    priorDispositions: [{
      id: "RF1",
      status: "resolved",
      reason: "permission is now scoped",
      deltaBasis: { kind: "changed-path", value: "src/auth.ts" },
    }],
    findings: [{
      severity: "blocking",
      text: "the new token path logs credentials",
      origin: "new",
      deltaBasis: { kind: "changed-path", value: "src/auth.ts" },
    }],
  }, first, context);
  assert.notEqual(typeof second, "string");
  assert.equal(second.findings[0].id, "RF2");
  assert.deepEqual(second.findings[0].deltaBasis, { kind: "changed-path", value: "src/auth.ts" });
});

test("an unresolved blocker cannot be downgraded and resolving it requires an exact delta", () => {
  const prior = {
    verdict: "FAIL",
    findings: [{ id: "RF1", severity: "blocking", text: "unsafe write" }],
  };
  const unchanged = { priorAttemptId: "attempt-1", changedPaths: [], newEvidence: [] };
  assert.match(validateRiskVerdict({
    verdict: "PASS",
    priorDispositions: [{ id: "RF1", status: "resolved", reason: "claimed fixed" }],
    findings: [],
  }, prior, unchanged), /resolving prior blocking RF1 requires.*deltaBasis/);
  assert.match(validateRiskVerdict({
    verdict: "PASS",
    priorDispositions: [{ id: "RF1", status: "unresolved", reason: "still present" }],
    findings: [{ severity: "advisory", text: "same issue, lower label", origin: "prior-unresolved", priorFindingId: "RF1" }],
  }, prior, unchanged), /must remain blocking/);

  const changed = { priorAttemptId: "attempt-1", changedPaths: ["src/write.ts"], newEvidence: [] };
  const resolved = validateRiskVerdict({
    verdict: "PASS",
    priorDispositions: [{
      id: "RF1",
      status: "resolved",
      reason: "write is now guarded",
      deltaBasis: { kind: "changed-path", value: "src/write.ts" },
    }],
    findings: [],
  }, prior, changed);
  assert.notEqual(typeof resolved, "string");
  assert.deepEqual(resolved.priorDispositions[0].deltaBasis, { kind: "changed-path", value: "src/write.ts" });
});

test("a successful risk result moves the ledger through open, fixed, and newly appended entries", () => {
  const firstResult = {
    verdict: "FAIL",
    findings: [
      { id: "RF1", severity: "blocking", text: "unsafe write" },
      { id: "RF2", severity: "advisory", text: "consider a smaller permission" },
    ],
  };
  const first = reconcileRiskFindings([], firstResult, "attempt-1", "2026-08-25T01:00:00.000Z");
  assert.deepEqual(first, [
    { id: "RF1", severity: "blocking", text: "unsafe write", originAttemptId: "attempt-1", status: "open" },
    { id: "RF2", severity: "advisory", text: "consider a smaller permission", originAttemptId: "attempt-1", status: "open" },
  ]);

  const secondResult = {
    verdict: "FAIL",
    priorDispositions: [
      {
        id: "RF1",
        status: "resolved",
        reason: "the write is now guarded",
        deltaBasis: { kind: "changed-path", value: "src/write.ts" },
      },
      { id: "RF2", status: "unresolved", reason: "permission is unchanged" },
    ],
    findings: [
      { id: "RF2", severity: "advisory", text: "permission remains broad", origin: "prior-unresolved", priorFindingId: "RF2" },
      { id: "RF3", severity: "blocking", text: "new credential log", origin: "new", deltaBasis: { kind: "changed-path", value: "src/write.ts" } },
    ],
  };
  const second = reconcileRiskFindings(first, secondResult, "attempt-2", "2026-08-25T02:00:00.000Z");
  assert.equal(second[0].status, "fixed");
  assert.match(second[0].resolution.evidence, /attempt attempt-2/);
  assert.ok(second[0].resolution.evidence.includes("changed-path"));
  assert.ok(second[0].resolution.evidence.includes("src/write.ts"));
  assert.deepEqual(second[1], {
    id: "RF2",
    severity: "advisory",
    text: "permission remains broad",
    originAttemptId: "attempt-1",
    status: "open",
  });
  assert.deepEqual(second[2], {
    id: "RF3",
    severity: "blocking",
    text: "new credential log",
    originAttemptId: "attempt-2",
    status: "open",
  });
});

test("a partial backend error preserves the last actual whole-review result", () => {
  const attempts = [{ id: "a1", review: { result: { ...REVIEW_PASS, findings: [defect()] } } }, { id: "a2", review: { result: null, verdict: "ERROR" } }];
  assert.equal(latestAttemptResult(attempts, (entry) => entry.review?.result).attempt.id, "a1");
});

test("omitted problems stay open and a concrete newly discovered omission in unchanged source is accepted", () => {
  const first = reconcileReviewFindings([], { ...REVIEW_PASS, findings: [defect({ ref: "B17" })] }, "a1", "t1");
  const second = reconcileReviewFindings(first, { ...REVIEW_PASS, findings: [defect({ ref: "B28" })] }, "a2", "t2");
  assert.deepEqual(second.map((item) => [item.id, item.status, item.requirementRefs[0]]), [["F1", "open", "B17"], ["F2", "open", "B28"]]);
  const third = reconcileReviewFindings(second, { ...REVIEW_PASS, priorDispositions: [{ findingId: "F1", status: "resolved", reason: "Value is now connected.", evidenceRefs: ["implementation.txt"] }] }, "a3", "t3");
  assert.deepEqual(third.map((item) => item.status), ["resolved", "open"]);
  assert.equal(first[0].status, "open", "reconciliation never mutates historical input");
  assert.equal(third[0].history.at(-1).reason, "Value is now connected.");
});

test("a reviewer cannot downgrade an open defect or close or rewrite a human authority item", () => {
  const first = reconcileReviewFindings([], { ...REVIEW_PASS, findings: [defect()] }, "a1", "t1");
  assert.throws(() => reconcileReviewFindings(first, { ...REVIEW_PASS, findings: [{ ...defect({ priorFindingId: "F1" }), kind: "advisory" }] }, "a2", "t2"), /cannot change kind/);
  const human = { kind: "human-confirmation", requirementRefs: ["D-01"], problem: "Approval is reserved.", evidenceRefs: ["D-01"], nextAction: "Obtain approval.", human: { sourceRef: "D-01", quote: "Owner approves before delivery.", timing: "prerequisite" } };
  const ledger = reconcileReviewFindings([], { ...REVIEW_PASS, findings: [human] }, "a1", "t1");
  assert.throws(() => reconcileReviewFindings(ledger, { ...REVIEW_PASS, priorDispositions: [{ findingId: "F1", status: "resolved", reason: "Reviewer approves.", evidenceRefs: ["D-01"] }] }, "a2", "t2"), /only be closed by a human/);
  assert.throws(() => reconcileReviewFindings(ledger, { ...REVIEW_PASS, findings: [{ ...human, priorFindingId: "F1", human: { ...human.human, timing: "post-completion" } }] }, "a2", "t2"), /cannot change its authority source or timing/);
});

test("round context keeps source delta distinct from replacement evidence", () => {
  const prior = { id: "a1", inputManifest: { source: [{ path: "a.txt", state: "file", sha256: "before" }], evidence: [{ path: "agents/capture.png", sha256: "old" }] } };
  const current = { source: [{ path: "a.txt", state: "file", sha256: "before" }], evidence: [{ path: "agents/capture.png", sha256: "new" }] };
  assert.deepEqual(verificationRoundContext(current, prior), { priorAttemptId: "a1", changedPaths: [], newEvidence: [{ path: "agents/capture.png", sha256: "new" }] });
});

test("new risks in unchanged source require concrete valid contract and counterevidence references", () => {
  const context = { priorAttemptId: "a1", changedPaths: [], newEvidence: [], requirementRefs: ["B1", "D-01"], evidenceRefs: ["src/write.ts"] };
  const finding = { severity: "blocking", text: "B1 preservation fails when src/write.ts overwrites the existing record.", origin: "new", deltaBasis: { kind: "contract-counterevidence", value: "B1 requires preservation, src/write.ts overwrites without recovery.", requirementRefs: ["B1"], evidenceRefs: ["src/write.ts"] } };
  const result = { verdict: "FAIL", priorDispositions: [], findings: [finding] };
  const parsed = validateRiskVerdict(result, { verdict: "PASS", findings: [] }, context);
  assert.notEqual(typeof parsed, "string", String(parsed));
  const invalid = { ...result, findings: [{ ...finding, deltaBasis: { ...finding.deltaBasis, requirementRefs: ["B99"] } }] };
  assert.equal(typeof validateRiskVerdict(invalid, { verdict: "PASS", findings: [] }, context), "string");
});
