import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { reviewPrompt, riskPrompt, intentSource, renderDecisions, reviewInputDocuments, REVIEW_INPUT_PATHS, REVIEW_DIFF_DIR } from "../../dist/implement/prompts.js";
import { assertJudgeInputFits } from "../../dist/judge/backends.js";
import { parseImplementContract } from "../../dist/implement/contract.js";
import { prd } from "../helpers/implement-fixture.mjs";
import { validateReviewResult } from "../../dist/judge/types.js";

export function material(overrides = {}) {
  const prdText = prd({ count: 30 });
  const contract = parseImplementContract(prdText);
  const value = { prdText, approval: { source: "frontmatter", evidence: "human_approval: approved" }, contract, intentSource: { routing: "decisions", content: renderDecisions(contract), explanation: "approved decision record" }, changedPaths: ["implementation.txt"], workspacePaths: ["implementation.txt", "agents/review-input/changes/implementation.txt.diff"], changeSet: { changes: [{ path: "implementation.txt", chunkPath: "agents/review-input/changes/implementation.txt.diff", addedLines: 1, removedLines: 0 }], notes: [] }, checks: [], artifacts: [], priorFindings: [], roundContext: { priorAttemptId: null, changedPaths: [], newEvidence: [] }, ...overrides };
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

// One document reaches every backend, and each backend's read grammar is
// named in its own preamble, not here. A concrete command in the shared text
// is therefore an instruction some reviewer cannot follow: 28b9482 removed the
// tool names and b79afbc's batch example put one back. Pin the class, not the
// one word - any read command syntax landing in this document fails here.
test("the shared review prompt shows batching by naming chunk paths, never a backend's read command", () => {
  const chunks = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"].map((file) => ({
    path: file, chunkPath: `${REVIEW_DIFF_DIR}/${file}.diff`, addedLines: 3, removedLines: 1,
  }));
  const input = material({
    changedPaths: chunks.map((chunk) => chunk.path),
    workspacePaths: [...chunks.map((chunk) => chunk.path), ...chunks.map((chunk) => chunk.chunkPath)],
    changeSet: { changes: chunks, notes: [] },
  });
  for (const prompt of [reviewPrompt(input, "fidelity"), reviewPrompt(input, "code"), riskPrompt(input)]) {
    const line = prompt.split("\n").find((text) => text.trim().startsWith(`"${chunks[0].chunkPath}"`));
    assert.ok(line !== undefined, "the example must name this run's own chunk paths");
    assert.ok(line.includes(`"${chunks[1].chunkPath}"`), "several paths in one command is the whole point of the example");
    assert.doesNotMatch(prompt, /\bsed\b|\brg\b|\bcat\b|\bhead\b|\bgrep\b|\bGlob\b|\bGrep\b/i, "the shared document names no backend's read grammar");
  }
  // One chunk is nothing to batch, so the example is absent rather than
  // demonstrating a single read as if it were several.
  const single = material();
  assert.equal(single.changeSet.changes.length, 1);
  assert.doesNotMatch(reviewPrompt(single, "fidelity"), /these together in one command/);
});

test("both routine roles and the distinct risk reviewer receive all thirty requirements, full decisions, and fixed actual inputs", () => {
  const input = material();
  assert.match(reviewPrompt(input, "fidelity"), /REQUIRED FIDELITY REFERENCES/);
  assert.doesNotMatch(reviewPrompt(input, "code"), /REQUIRED FIDELITY REFERENCES/);
  assert.doesNotMatch(riskPrompt(input), /REQUIRED FIDELITY REFERENCES/);
  for (const prompt of [reviewPrompt(input, "fidelity"), reviewPrompt(input, "code"), riskPrompt(input)]) {
    const documents = reviewInputDocuments(input);
    // The harness's own documents ride in the prompt; only the path index and
    // the change chunks are still files, because only those are read selectively.
    assert.ok(prompt.includes(input.prdText), "the complete approved contract is quoted, not fetched");
    assert.ok(prompt.includes(input.intentSource.content));
    for (let n = 1; n <= 30; n++) assert.ok(prompt.includes(`Requirement ${n}:`));
    assert.ok(prompt.includes(input.changeSet.changes[0].chunkPath), "each change chunk is named for selective reading");
    assert.deepEqual(Object.keys(documents), [REVIEW_INPUT_PATHS.sourceIndex]);
    assert.ok(prompt.includes(REVIEW_INPUT_PATHS.sourceIndex));
    for (const retired of ["agents/review-input/contract.md", "agents/review-input/context.md", "agents/review-input/evidence.md", "agents/review-input/changes.diff"]) {
      assert.ok(!prompt.includes(retired), `${retired} must not be advertised as a file to read`);
    }
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

// The 2026-09-09 rule kept complete bytes out of argv; 2026-09-10 measurement
// reversed it for the harness's own documents, which the reviewer was buying
// back through the tool boundary. Deletion hunks and canonical intent must
// still arrive complete, and the transport budget is counted in UTF-8 bytes -
// Korean text is three bytes per character, so a character count would report
// a comfortable margin while the real limit is already gone.
test("a large Korean contract stays complete, is measured in bytes, and oversized input is refused rather than clipped", () => {
  const prdText = material().prdText + "\n" + "한글 요구사항 원문\n".repeat(400);
  const intent = "원래 사용자 결정\n".repeat(400);
  const input = material({ prdText, intentSource: { routing: "full-qa-log", content: intent, explanation: "complete recorded intent" },
    changeSet: { changes: [{ path: "deleted.ts", chunkPath: `${REVIEW_DIFF_DIR}/deleted.ts.diff`, addedLines: 0, removedLines: 4_000 }], notes: [] } });
  for (const role of ["fidelity", "code"]) {
    const prompt = reviewPrompt(input, role);
    assert.ok(prompt.includes(prdText), "a large contract is quoted complete, never clipped");
    assert.ok(prompt.includes(intent), "canonical intent arrives complete");
    assert.ok(prompt.includes(`${REVIEW_DIFF_DIR}/deleted.ts.diff`), "the deletion's chunk stays citable and readable");
    const bytes = Buffer.byteLength(prompt, "utf8");
    assert.ok(bytes > prompt.length, "Korean contracts must be measured as UTF-8 bytes, not characters");
    assert.doesNotThrow(() => assertJudgeInputFits("codex", prompt, { agentic: true, explore: true }), `${role} prompt of ${bytes} bytes must fit the transport budget`);
  }
  // A contract too large for the transport is an explicit refusal, never a
  // silent truncation: the reviewer must not judge a contract it was not sent.
  const oversized = material({ prdText: "한".repeat(200_000) });
  assert.throws(() => assertJudgeInputFits("codex", reviewPrompt(oversized, "fidelity"), { agentic: true, explore: true }), (error) => {
    assert.equal(error.code, "judge-context-overflow");
    assert.equal(error.reason, "input-too-large");
    assert.match(error.detail, /UTF-8 bytes/);
    return true;
  });
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
  // The execution facts and evidence roster are small and always needed, so
  // they are quoted; the unrelated path inventory is large and selectively
  // needed, so it stays in the workspace index the reviewer greps.
  for (const prompt of [reviewPrompt(expanded, "fidelity"), reviewPrompt(expanded, "code"), riskPrompt(expanded)]) {
    for (const value of ["agents/suite.log", "npm test", "agents/qa.log", "operator", "observed flow"]) assert.ok(prompt.includes(value), value);
    assert.ok(!prompt.includes(sourcePaths[0]), "an unrelated 2,000-path inventory must never enter the prompt");
    assert.match(prompt, /snapshot|frozen/);
    assert.match(prompt, /entrypoint|caller/);
    // Targeted search stays instructed; the backend policy names the tool.
    assert.match(prompt, /search them with a pattern/);
  }
  for (const entry of [sourcePaths[0], sourcePaths.at(-1)]) assert.ok(documents[REVIEW_INPUT_PATHS.sourceIndex].includes(entry.slice(entry.lastIndexOf("/") + 1)));
  assert.equal(reviewPrompt(input, "fidelity"), reviewPrompt(expanded, "fidelity"));
});

// Both roles previously opened by inventorying the frozen tree with
// rg --files. The tree is fixed for the whole call, so that listing is
// derivable once by the harness; discovery of unchanged callers must survive.
test("the frozen workspace index names every readable path once, off the initial prompt", () => {
  const input = material({ workspacePaths: ["src/api/save.ts", "src/api/load.ts", "src/view.tsx", "README.md", "agents/qa.log", ...Object.values(REVIEW_INPUT_PATHS)] });
  const index = reviewInputDocuments(input)[REVIEW_INPUT_PATHS.sourceIndex];
  assert.match(index, /^src\/api\/ \(2\): load\.ts, save\.ts$/m, "one line per directory keeps the complete set compact");
  assert.match(index, /^src\/ \(1\): view\.tsx$/m);
  assert.match(index, /^\(workspace root\) \(1\): README\.md$/m);
  // The review documents are readable files of the same workspace, and they
  // reach the index the way every other path does - from the caller. The
  // index adding them itself is what let the readable set outgrow the citable
  // one: a review that cited the index the harness told it to read was
  // rejected for an unknown reference (2026-09-10, one measured rejection).
  for (const document of Object.values(REVIEW_INPUT_PATHS)) assert.ok(index.includes(document.slice(document.lastIndexOf("/") + 1)), document);
  const withoutDocuments = reviewInputDocuments(material({ workspacePaths: ["src/view.tsx"] }))[REVIEW_INPUT_PATHS.sourceIndex];
  for (const document of Object.values(REVIEW_INPUT_PATHS)) assert.ok(!withoutDocuments.includes(document.slice(document.lastIndexOf("/") + 1)), document);
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
  for (const prompt of [fidelity, code]) {
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
