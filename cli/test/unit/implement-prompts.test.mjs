import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { reviewPrompt, riskPrompt, intentSource, renderDecisions, reviewDiffMaterial, IMPLEMENT_REVIEW_DIFF_MAX_CHARS } from "../../dist/implement/prompts.js";
import { parseImplementContract } from "../../dist/implement/contract.js";
import { prd } from "../helpers/implement-fixture.mjs";
import { validateReviewResult } from "../../dist/judge/types.js";

export function material(overrides = {}) {
  const prdText = prd({ count: 30 });
  const contract = parseImplementContract(prdText);
  const value = { prdText, approval: { source: "frontmatter", evidence: "human_approval: approved" }, contract, intentSource: { routing: "decisions", content: renderDecisions(contract), explanation: "approved decision record" }, changeMaterial: [{ path: "implementation.txt", body: "complete source" }], runOwnedDiff: "diff --git a/implementation.txt b/implementation.txt\n--- /dev/null\n+++ b/implementation.txt\n+complete source\n", checks: [], evidence: [], artifacts: [], readablePaths: ["implementation.txt"], priorFindings: [], roundContext: { priorAttemptId: null, changedPaths: [], newEvidence: [] }, ...overrides };
  return { ...value, referenceContext: overrides.referenceContext ?? { requirementRefs: [...value.contract.rows.map((entry) => entry.id), ...value.contract.decisions.map((entry) => entry.id)], evidenceRefs: ["PRD", ...value.readablePaths], priorFindingIds: value.priorFindings.filter((entry) => entry.status === "open").map((entry) => entry.id), humanSources: {} } };
}

test("review prompts advertise the exact validator vocabulary, including whole-contract findings without invented requirement IDs", () => {
  const referenceContext = { requirementRefs: ["B1", "D-01"], evidenceRefs: ["PRD", "src/public.mjs"], priorFindingIds: [], humanSources: {} };
  for (const prompt of [reviewPrompt(material({ referenceContext }), "fidelity"), reviewPrompt(material({ referenceContext }), "code"), riskPrompt(material({ referenceContext }))]) {
    const advertised = prompt.split("\nVALID CONTRACT REFERENCES")[1].split("\nVALID EVIDENCE REFERENCES")[0]
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
  for (const prompt of [reviewPrompt(input, "fidelity"), reviewPrompt(input, "code"), riskPrompt(input)]) {
    assert.ok(prompt.includes(input.prdText));
    assert.ok(prompt.includes(input.intentSource.content));
    for (let n = 1; n <= 30; n++) assert.ok(prompt.includes(`Requirement ${n}:`));
    assert.ok(prompt.includes(input.runOwnedDiff));
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

test("a complete diff is retained at the boundary and excess is explicitly rejected without clipping", () => {
  const exact = "d".repeat(IMPLEMENT_REVIEW_DIFF_MAX_CHARS);
  assert.equal(reviewDiffMaterial(exact).text, exact);
  assert.throws(() => reviewDiffMaterial(exact + "d"), /input-too-large.*No content was truncated/);
  assert.throws(() => reviewPrompt(material({ prdText: exact + "d" }), "fidelity"), /approved PRD.*No content was truncated/);
  assert.throws(() => reviewPrompt(material({ intentSource: { routing: "full-qa-log", content: exact + "d", explanation: "full intent" } }), "code"), /canonical intent.*No content was truncated/);
});

test("large source bodies require an exact readable file instead of disappearing from review", () => {
  const body = "s".repeat(IMPLEMENT_REVIEW_DIFF_MAX_CHARS + 1);
  const input = material({ changeMaterial: [{ path: "large.txt", body }], readablePaths: ["large.txt"] });
  const prompt = reviewPrompt(input, "fidelity");
  assert.match(prompt, /COMPLETE BODIES AVAILABLE BY ALLOWLISTED READ/);
  assert.ok(prompt.includes("large.txt"));
  assert.throws(() => reviewPrompt({ ...input, readablePaths: [] }, "code"), /large.txt.*not readable/);
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

test("large execution and QA excerpts retain exact full-file access and cannot silently clip unavailable evidence", () => {
  const tail = "LOG-START\n" + "l".repeat(9_000) + "\nLOG-END";
  const text = "QA-START\n" + "e".repeat(45_000) + "\nQA-END";
  const input = material({ checks: [{ command: "npm test", exitCode: 0, tail, logPath: "agents/suite.log" }], evidence: [{ path: "agents/qa.log", kind: "log", text, bytes: text.length, sha256: "a".repeat(64) }], readablePaths: ["implementation.txt", "agents/suite.log", "agents/qa.log"] });
  const prompt = reviewPrompt(input, "fidelity");
  for (const marker of ["LOG-START", "LOG-END", "QA-START", "QA-END", "LABELED INLINE EXCERPT ONLY", "agents/suite.log", "agents/qa.log"]) assert.ok(prompt.includes(marker));
  assert.throws(() => reviewPrompt({ ...input, readablePaths: ["implementation.txt"] }, "code"), /exact full allowlisted logPath|complete allowlisted file/);
  const noLogPath = { ...input, checks: [{ command: "npm test", exitCode: 0, tail }] };
  assert.throws(() => reviewPrompt(noLogPath, "fidelity"), /exact full allowlisted logPath/);
});


test("the source catalog identifies unavailable context without granting file access or fabricating inspected content", () => {
  const catalog = ["implementation.txt", "src/router.ts", "src/storage.ts"];
  const input = material({ sourceCatalog: catalog });
  for (const prompt of [reviewPrompt(input, "fidelity"), reviewPrompt(input, "code"), riskPrompt(input)]) {
    const catalogSection = prompt.split("SOURCE CATALOG (current path metadata only;")[1].split("ALLOWLISTED PATHS")[0];
    const readableSection = prompt.split("ALLOWLISTED PATHS (only these exact files are readable):")[1].split("VALID CONTRACT REFERENCES")[0];
    for (const file of catalog) assert.ok(catalogSection.includes(`- ${file}`));
    assert.ok(readableSection.includes("- implementation.txt"));
    assert.ok(!readableSection.includes("src/router.ts"));
    assert.ok(!readableSection.includes("src/storage.ts"));
    assert.ok(!prompt.includes("FILE src/router.ts"));
    assert.match(prompt, /catalog-only paths may identify an access gap, never unseen content/);
    assert.match(prompt, /insufficient-evidence defect naming the relevant contract, the inaccessible path/);
    assert.match(prompt, /One shared run artifact or bounded source context may support many requirements/);
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
  assert.equal(fidelity.slice(fidelity.indexOf("INPUT SAFETY AND EXPLORATION:")), code.slice(code.indexOf("INPUT SAFETY AND EXPLORATION:")));
  for (const prompt of [fidelity, code]) {
    assert.match(prompt, /never produce a per-requirement PASS array/);
    assert.match(prompt, /Complete readable source can establish deterministic behavior/);
    assert.match(prompt, /an execution count or absent per-requirement test is not itself a defect/);
    assert.match(prompt, /source reasoning never substitutes for a configured suite execution/);
    assert.match(prompt, /contiguous verbatim substring of that key's value/);
    assert.match(prompt, /Pending frontmatter or agent-owned assumptions alone do not create a human-confirmation finding/);
    assert.match(prompt, /Disappearance does not resolve it/);
    assert.match(prompt, /Never resolve one through review, change its authority source, or downgrade prerequisite timing/);
  }
  assert.throws(() => reviewPrompt(input), /explicit fidelity or code role/);
  assert.throws(() => reviewPrompt(input, "comprehensive"), /explicit fidelity or code role/);
});
