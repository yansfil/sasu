import assert from "node:assert/strict";
import test from "node:test";
import { reviewPrompt } from "../../dist/implement/prompts.js";
import { parseImplementContract } from "../../dist/implement/contract.js";
import { prd } from "../helpers/implement-fixture.mjs";

function material(overrides = {}) {
  const prdText = prd();
  const contract = parseImplementContract(prdText);
  return { prdText, approval: { source: "frontmatter", evidence: "human_approval: approved" }, contract, referenceContext: { requirementRefs: [...contract.rows.map((entry) => entry.id), ...contract.decisions.map((entry) => entry.id)], evidenceRefs: ["PRD"], priorFindingIds: [], humanSources: {} }, intentSource: { routing: "decisions", content: "User decisions", explanation: "approved" }, changeMaterial: [], runOwnedDiff: "", checks: [], evidence: [], artifacts: [], readablePaths: [], priorFindings: [], roundContext: { priorAttemptId: null, changedPaths: [], newEvidence: [] }, ...overrides };
}

test("the whole-review input distinguishes real execution from collection metadata and attributed claims", () => {
  const observation = { kind: "log", path: "agents/observed.log", sha256: "a".repeat(64), bytes: 12, description: "flow worked", registeredAt: "2026-09-08T01:00:00Z", provenance: "operator browser drive", observedAt: "2026-09-08T00:00:00Z", target: "dev browser", environment: "local fixture" };
  const command = { ...observation, path: "agents/suite.log", command: "npm test", cwd: ".", exitCode: 0 };
  const prompt = reviewPrompt(material({ artifacts: [observation, command], claims: [{ origin: "human", subject: "amendment", text: "approved request" }, { origin: "observer", subject: "diagnosis", text: "likely complete" }, { origin: "solver", subject: "diagnosis", text: "possible missing fixture" }] }));
  assert.match(prompt, /agent-registered at 2026-09-08T01:00:00Z/);
  assert.match(prompt, /description as the implementer's claim, not a harness observation/);
  assert.match(prompt, /declared collection source=operator browser drive; observedAt=2026-09-08T00:00:00Z/);
  assert.match(prompt, /the harness ran `npm test`.*exit=0/);
  assert.match(prompt, /target=dev browser; environment=local fixture/);
  for (const text of ["approved request", "likely complete", "possible missing fixture"]) assert.ok(prompt.includes(text));
  assert.match(prompt, /ATTRIBUTED CLAIMS \(not observations\)/);
  assert.match(prompt, /A build cannot establish rendered UI/);
});

test("an empty evidence or suite list reports no observation and prior findings cannot disappear through omission", () => {
  const prompt = reviewPrompt(material());
  assert.match(prompt, /No required suite commands were recorded/);
  assert.match(prompt, /none registered; do not claim runtime QA occurred/);
  assert.match(prompt, /Disappearance does not resolve it/);
  assert.match(prompt, /unchanged file is a defect/);
  assert.match(prompt, /Older observations retain their original date and target/);
});
