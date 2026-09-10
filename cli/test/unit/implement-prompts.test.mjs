import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { reviewPrompt, riskPrompt, intentSource, renderDecisions, reviewInputDocuments, REVIEW_INPUT_PATHS } from "../../dist/implement/prompts.js";
import { parseImplementContract } from "../../dist/implement/contract.js";
import { prd } from "../helpers/implement-fixture.mjs";
import { validateReviewResult } from "../../dist/judge/types.js";

export function material(overrides = {}) {
  const prdText = prd({ count: 30 });
  const contract = parseImplementContract(prdText);
  const value = { prdText, approval: { source: "frontmatter", evidence: "human_approval: approved" }, contract, intentSource: { routing: "decisions", content: renderDecisions(contract), explanation: "approved decision record" }, changedPaths: ["implementation.txt"], workspacePaths: ["implementation.txt"], runOwnedDiff: "diff --git a/implementation.txt b/implementation.txt\n--- /dev/null\n+++ b/implementation.txt\n+complete source\n", checks: [], artifacts: [], priorFindings: [], roundContext: { priorAttemptId: null, changedPaths: [], newEvidence: [] }, ...overrides };
  return { ...value, referenceContext: overrides.referenceContext ?? { requiredRequirementRefs: value.contract.rows.map((entry) => entry.id), actualEvidenceRefs: ["implementation.txt"], requirementRefs: [...value.contract.rows.map((entry) => entry.id), ...value.contract.decisions.map((entry) => entry.id)], evidenceRefs: ["PRD", "implementation.txt"], priorFindingIds: value.priorFindings.filter((entry) => entry.status === "open").map((entry) => entry.id), humanSources: {} } };
}

test("review prompts advertise the exact validator vocabulary, including whole-contract findings without invented requirement IDs", () => {
  const referenceContext = { requiredRequirementRefs: ["B1"], actualEvidenceRefs: ["src/public.mjs"], requirementRefs: ["B1", "D-01"], evidenceRefs: ["PRD", "src/public.mjs"], priorFindingIds: [], humanSources: {} };
  for (const prompt of [reviewPrompt(material({ referenceContext }), "fidelity"), reviewPrompt(material({ referenceContext }), "code"), riskPrompt(material({ referenceContext }))]) {
    const advertised = prompt.split("\nVALID CONTRACT REFERENCES")[1].split("\nREQUIRED FIDELITY REFERENCES")[0]
      .split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2));
    assert.deepEqual(advertised, referenceContext.requirementRefs);
    for (const ref of advertised) assert.equal(typeof validateReviewResult({ summary: "known gap", findings: [{ kind: "defect", requirementRefs: [ref], problem: "entrypoint is absent", evidenceRefs: ["PRD"], nextAction: "implement it" }], priorDispositions: [] }, referenceContext), "object");
  }
  const wholeContract = { summary: "contract-level gap", findings: [{ kind: "defect", requirementRefs: [], problem: "the approved public entrypoint is absent", evidenceRefs: ["PRD"], nextAction: "provide the entrypoint" }], priorDispositions: [] };
  assert.equal(typeof validateReviewResult(wholeContract, referenceContext), "object");
  assert.equal(typeof validateReviewResult({ ...wholeContract, findings: [{ ...wholeContract.findings[0], requirementRefs: ["Goal"] }] }, referenceContext), "string");
});

test("both routine roles and the distinct risk reviewer receive all thirty requirements, full decisions, and fixed actual inputs", () => {
  const input = material();
  assert.match(reviewPrompt(input, "fidelity"), /REQUIRED FIDELITY REFERENCES/);
  assert.doesNotMatch(reviewPrompt(input, "code"), /REQUIRED FIDELITY REFERENCES/);
  assert.doesNotMatch(riskPrompt(input), /REQUIRED FIDELITY REFERENCES/);
  for (const prompt of [reviewPrompt(input, "fidelity"), reviewPrompt(input, "code"), riskPrompt(input)]) {
    const documents = reviewInputDocuments(input);
    assert.equal(documents[REVIEW_INPUT_PATHS.contract], input.prdText);
    assert.ok(documents[REVIEW_INPUT_PATHS.context].includes(input.intentSource.content));
    for (let n = 1; n <= 30; n++) assert.ok(documents[REVIEW_INPUT_PATHS.contract].includes(`Requirement ${n}:`));
    assert.equal(documents[REVIEW_INPUT_PATHS.diff], input.runOwnedDiff);
    for (const entrypoint of Object.values(REVIEW_INPUT_PATHS)) assert.ok(prompt.includes(entrypoint));
    assert.ok(!prompt.includes(input.prdText));
    assert.ok(!prompt.includes(input.runOwnedDiff));
    assert.match(prompt, /Never execute project code/);
    assert.match(prompt, /state.json.*not product proof/);
  }
  assert.match(reviewPrompt(input, "fidelity"), /never produce a per-requirement PASS array/);
  assert.match(reviewPrompt(input, "fidelity"), /trace a concrete input from its public caller through dispatch to the failing expression/);
  assert.match(reviewPrompt(input, "fidelity"), /Complete readable source can establish deterministic behavior/);
  assert.match(reviewPrompt(input, "fidelity"), /execution count or absent per-requirement test is not itself a defect/);
  assert.match(reviewPrompt(input, "fidelity"), /specific boundary.*rendered UI.*external service.*real persistence/);
  assert.match(reviewPrompt(input, "fidelity"), /source reasoning never substitutes for a configured suite execution/);
  assert.match(riskPrompt(input), /data-loss, authorization/);
  assert.match(riskPrompt(input), /may run concurrently/);
});

// The user-approved exploration change moves complete bytes to files; it does
// not permit clipping large contracts, deletion hunks, or canonical intent.
test("large Korean contracts, deleted hunks and canonical intent remain complete without expanding the initial prompt", () => {
  const original = material();
  const prdText = original.prdText + "\n" + "한글 요구사항 원문\n".repeat(40_000);
  const deleted = "diff --git a/deleted.ts b/deleted.ts\n--- a/deleted.ts\n+++ /dev/null\n" + "-deleted behavior\n".repeat(40_000);
  const intent = "원래 사용자 결정\n".repeat(40_000);
  const input = material({ prdText, runOwnedDiff: deleted, intentSource: { routing: "full-qa-log", content: intent, explanation: "complete recorded intent" } });
  const documents = reviewInputDocuments(input);
  assert.equal(documents[REVIEW_INPUT_PATHS.contract], prdText);
  assert.equal(documents[REVIEW_INPUT_PATHS.diff], deleted);
  assert.ok(documents[REVIEW_INPUT_PATHS.context].includes(intent));
  for (const role of ["fidelity", "code"]) {
    const prompt = reviewPrompt(input, role);
    assert.equal(prompt, reviewPrompt(original, role), "content size must not change the entrypoint instructions");
    assert.ok(prompt.length < 25_000, "a large contract must be admitted without an oversized inline envelope");
  }
});

test("intent routing checks the source even after spec PASS and never substitutes a missing or escaped document", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-review-intent-"));
  const contract = parseImplementContract(prd());
  assert.equal(intentSource(root, contract, false).routing, "decisions");
  const intake = { ...contract, frontmatter: { ...contract.frontmatter, source_intake: "qa-log.md" } };
  assert.throws(() => intentSource(root, intake, true), /missing/);
  fs.writeFileSync(path.join(root, "qa-log.md"), "ORIGINAL FULL USER INTENT\n");
  assert.equal(intentSource(root, intake, false).content, "ORIGINAL FULL USER INTENT\n");
  assert.equal(intentSource(root, intake, true).routing, "decisions");
  const escaped = { ...contract, frontmatter: { source_intake: "../outside.md" } };
  assert.throws(() => intentSource(root, escaped, false), /escapes/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("evidence uses exact log locations and provenance while unrelated source inventories stay out of the prompt", () => {
  const input = material({
    checks: [{ command: "npm test", exitCode: 0, logPath: "agents/suite.log", provenance: "CLI execution at fixed time" }],
    artifacts: [{ path: "agents/qa.log", kind: "log", bytes: 500_000, sha256: "a".repeat(64), description: "observed flow", registeredAt: "2026-09-09T00:00:00Z", observedAt: "2026-09-09T00:00:00Z", provenance: "operator" }],
  });
  const sourcePaths = Array.from({ length: 2_000 }, (_, index) => `강의/관련없는-파일-${index}.md`);
  const expanded = { ...input, referenceContext: { ...input.referenceContext, evidenceRefs: [...input.referenceContext.evidenceRefs, ...sourcePaths], actualEvidenceRefs: [...input.referenceContext.actualEvidenceRefs, ...sourcePaths] } };
  const documents = reviewInputDocuments({ ...expanded, workspacePaths: [...expanded.workspacePaths, ...sourcePaths] });
  for (const value of ["agents/suite.log", "npm test", "agents/qa.log", "operator"]) assert.ok(documents[REVIEW_INPUT_PATHS.evidence].includes(value));
  // The same inventory the reviewer would otherwise re-list belongs in the
  // workspace index document, never in the initial prompt.
  for (const entry of [sourcePaths[0], sourcePaths.at(-1)]) assert.ok(documents[REVIEW_INPUT_PATHS.sourceIndex].includes(entry.slice(entry.lastIndexOf("/") + 1)));
  for (const prompt of [reviewPrompt(expanded, "fidelity"), reviewPrompt(expanded, "code"), riskPrompt(expanded)]) {
    assert.ok(!prompt.includes(sourcePaths[0]));
    assert.ok(!prompt.includes("observed flow"));
    assert.match(prompt, /snapshot|frozen/);
    assert.match(prompt, /entrypoint|caller/);
    // Targeted search stays instructed; the backend policy names the tool.
    assert.match(prompt, /search them with a pattern/);
  }
  assert.equal(reviewPrompt(input, "fidelity"), reviewPrompt(expanded, "fidelity"));
});

// Both roles previously opened by inventorying the frozen tree with
// rg --files. The tree is fixed for the whole call, so that listing is
// derivable once by the harness; discovery of unchanged callers must survive.
test("the frozen workspace index names every readable path once, off the initial prompt", () => {
  const input = material({ workspacePaths: ["src/api/save.ts", "src/api/load.ts", "src/view.tsx", "README.md", "agents/qa.log"] });
  const index = reviewInputDocuments(input)[REVIEW_INPUT_PATHS.sourceIndex];
  assert.match(index, /^src\/api\/ \(2\): load\.ts, save\.ts$/m, "one line per directory keeps the complete set compact");
  assert.match(index, /^src\/ \(1\): view\.tsx$/m);
  assert.match(index, /^\(workspace root\) \(1\): README\.md$/m);
  // The review documents are readable files of the same workspace.
  for (const document of Object.values(REVIEW_INPUT_PATHS)) assert.ok(index.includes(document.slice(document.lastIndexOf("/") + 1)), document);
  assert.ok(index.includes("qa.log"));
  for (const prompt of [reviewPrompt(input, "fidelity"), reviewPrompt(input, "code"), riskPrompt(input)]) {
    assert.ok(prompt.includes(REVIEW_INPUT_PATHS.sourceIndex), "every role is pointed at the index");
    assert.doesNotMatch(prompt, /rg --files/, "no role is told to rebuild the tree listing");
    assert.match(prompt, /listing the tree again adds nothing/);
    // Discovery itself is preserved: the reviewer still chooses and reads the
    // unchanged callers behind a changed file.
    assert.match(prompt, /Follow public callers, imports, integration boundaries and error paths/);
    assert.ok(!prompt.includes("src/api/save.ts"), "the index lives in the workspace, not in argv");
  }
});

test("Fidelity and Code differ in responsibility while retaining identical complete inputs and strict authority", () => {
  const input = material({ approval: { source: "conversation", evidence: "Implement the approved assumptions." } });
  const fidelity = reviewPrompt(input, "fidelity");
  const code = reviewPrompt(input, "code");
  assert.match(fidelity, /independent Fidelity reviewer/);
  assert.match(fidelity, /Own complete intent and observable behavior fulfillment/);
  assert.match(code, /independent Code reviewer/);
  assert.match(code, /consequential design or maintainability problems with an identified failure or material impact/);
  assert.match(code, /Cosmetic preferences.*advisory, not blocking defects/);
  assert.equal(fidelity.slice(fidelity.indexOf("FIXED REVIEW WORKSPACE:")), code.slice(code.indexOf("FIXED REVIEW WORKSPACE:")));
  for (const prompt of [fidelity, code].map((text) => text + "\n" + reviewInputDocuments(input)[REVIEW_INPUT_PATHS.context])) {
    assert.match(prompt, /never produce a per-requirement PASS array/);
    assert.match(prompt, /Complete readable source can establish deterministic behavior/);
    assert.match(prompt, /an execution count or absent per-requirement test is not itself a defect/);
    assert.match(prompt, /source reasoning never substitutes for a configured suite execution/);
    assert.match(prompt, /contiguous verbatim substring/);
    assert.match(prompt, /Pending frontmatter or agent-owned assumptions alone do not create a human-confirmation finding/);
    assert.match(prompt, /Disappearance does not resolve it/);
    assert.match(prompt, /Preserve human confirmation\/rejection history and original timing; never.*waive prerequisites/);
  }
  assert.throws(() => reviewPrompt(input), /explicit fidelity or code role/);
  assert.throws(() => reviewPrompt(input, "comprehensive"), /explicit fidelity or code role/);
});
