import assert from "node:assert/strict";
import test from "node:test";
import { reviewPrompt, reviewInputDocuments } from "../../dist/implement/prompts.js";
import { parseImplementContract } from "../../dist/implement/contract.js";
import { prd } from "../helpers/implement-fixture.mjs";

function material(overrides = {}) {
  const prdText = prd();
  const contract = parseImplementContract(prdText);
  return { prdText, approval: { source: "frontmatter", evidence: "human_approval: approved" }, contract, referenceContext: { requiredRequirementRefs: contract.rows.map((entry) => entry.id), actualEvidenceRefs: [], requirementRefs: [...contract.rows.map((entry) => entry.id), ...contract.decisions.map((entry) => entry.id)], evidenceRefs: ["PRD"], priorFindingIds: [], humanSources: {} }, intentSource: { routing: "decisions", content: "User decisions", explanation: "approved" }, changedPaths: [], workspacePaths: [], changeSet: { changes: [], notes: ["No product source changed."] }, checks: [], artifacts: [], priorFindings: [], roundContext: { priorAttemptId: null, changedPaths: [], newEvidence: [] }, ...overrides };
}

test("the whole-review input distinguishes real execution from collection metadata and attributed claims", () => {
  const observation = { kind: "log", path: "agents/observed.log", sha256: "a".repeat(64), bytes: 12, description: "flow worked", registeredAt: "2026-09-08T01:00:00Z", provenance: "operator browser drive", observedAt: "2026-09-08T00:00:00Z", target: "dev browser", environment: "local fixture" };
  const command = { ...observation, path: "agents/suite.log", command: "npm test", cwd: ".", exitCode: 0 };
  const input = material({ artifacts: [observation, command], claims: [{ origin: "human", subject: "amendment", text: "approved request" }, { origin: "observer", subject: "diagnosis", text: "likely complete" }, { origin: "solver", subject: "diagnosis", text: "possible missing fixture" }] });
  for (const prompt of [reviewPrompt(input, "fidelity"), reviewPrompt(input, "code")].map((text) => text + "\n" + Object.values(reviewInputDocuments(input)).join("\n"))) {
    assert.match(prompt, /agent-registered at 2026-09-08T01:00:00Z/);
    assert.match(prompt, /description as the implementer's claim, not a harness observation/);
    assert.match(prompt, /declared collection source=operator browser drive; observedAt=2026-09-08T00:00:00Z/);
    assert.match(prompt, /the harness ran `npm test`.*exit=0/);
    assert.match(prompt, /target=dev browser; environment=local fixture/);
    for (const text of ["approved request", "likely complete", "possible missing fixture"]) assert.ok(prompt.includes(text));
    assert.match(prompt, /ATTRIBUTED CLAIMS \(not observations\)/);
    assert.match(prompt, /A build cannot establish rendered UI/);
  }
});

test("an empty evidence or suite list reports no observation and prior findings cannot disappear through omission", () => {
  for (const role of ["fidelity", "code"]) {
    const input = material();
    const prompt = reviewPrompt(input, role) + "\n" + Object.values(reviewInputDocuments(input)).join("\n");
    assert.match(prompt, /No required suite command was recorded/);
    assert.match(prompt, /An empty execution list is not "tests all passed"/);
    assert.match(prompt, /none registered; do not claim runtime QA occurred/);
    assert.match(prompt, /Disappearance does not resolve it/);
    assert.match(prompt, /concrete omission in unchanged code still counts/);
    assert.match(prompt, /Older observations keep their original date and target/);
  }
});


test("a long canonical human source remains complete once without changing quote authority", () => {
  const input = material();
  const original = "사용자가 승인한 정확한 원문입니다. ".repeat(5000);
  input.intentSource.content = original;
  input.referenceContext.humanSources = { instruction: original, "D-01": "A separately reserved human judgment." };
  const before = structuredClone(input.referenceContext);
  // The canonical intake now rides in the prompt itself; it must still appear
  // exactly once, because a duplicated 52,731-byte intake is what the single
  // copy was introduced to stop.
  const context = reviewPrompt(input, "fidelity");
  assert.ok(context.includes(original), "the complete quote source must remain readable");
  assert.equal(context.indexOf(original), context.lastIndexOf(original), "quoting the context must not repeat the full intake");
  assert.ok(context.includes('"instruction"'));
  assert.ok(context.includes("A separately reserved human judgment."));
  assert.deepEqual(input.referenceContext, before, "deduplicating presentation must not change authoritative quote values");
});
