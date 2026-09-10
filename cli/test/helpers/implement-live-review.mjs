import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { reviewPrompt, renderDecisions, reviewInputDocuments, diffChunkPath, REVIEW_INPUT_PATHS } from "../../dist/implement/prompts.js";
import { parseImplementContract } from "../../dist/implement/contract.js";
import { validateImplementationReviewResult } from "../../dist/implement/review-contract.js";
import { runJudge, judgeCallRecordFrom } from "../../dist/judge/runner.js";
import { loadConfig } from "../../dist/config.js";
import { prd } from "./implement-fixture.mjs";

function writeReviewDocuments(root, material, chunks = {}) {
  // Production hands the generated documents to the index and to the citable
  // reference list from one place; the fixture mirrors that rather than
  // letting the index manufacture paths nothing else knows about.
  material.workspacePaths = [...new Set([...material.workspacePaths ?? [], ...Object.values(REVIEW_INPUT_PATHS)])];
  const documents = { ...chunks, ...reviewInputDocuments(material) };
  for (const [relative, text] of Object.entries(documents)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  material.referenceContext.evidenceRefs.push(...Object.keys(documents));
  material.referenceContext.actualEvidenceRefs.push(...Object.keys(chunks));
  return Object.keys(documents);
}

// The fixture oracle runs after the production validator, never as retry
// feedback: the backend must not be told which omission was planted.
export function assertReviewBlockingRefs(review, expectedRequirementRefs, decisionRefs = []) {
  const expected = new Set(expectedRequirementRefs);
  const decisions = new Set(decisionRefs);
  const found = new Set();
  for (const finding of review.findings) {
    if (finding.kind === "advisory") continue;
    assert.equal(finding.kind, "defect", "these fixed fixtures contain no human-only judgment");
    assert.ok(finding.requirementRefs.some((ref) => expected.has(ref)), `unrelated or unreferenced blocker: ${JSON.stringify(finding.requirementRefs)}`);
    for (const ref of finding.requirementRefs) {
      assert.ok(expected.has(ref) || decisions.has(ref), `unrelated blocking reference: ${ref}`);
      if (expected.has(ref)) found.add(ref);
    }
  }
  assert.deepEqual([...found].sort(), [...expected].sort(), "the review must identify exactly the fixed fixture's affected requirements");
}

function fixtureHumanSources(contract, intentContent) {
  return {
    Decisions: contract.decisions.flatMap((entry) => [entry.decision, entry.rationale]).join("\n"),
    Risks: contract.risks,
    instruction: intentContent,
    ...Object.fromEntries(contract.decisions.map((entry) => [entry.id, entry.decision])),
  };
}

function diagnosticValidator(t, variant, role, referenceContext) {
  let attempt = 0;
  const refs = (value) => Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : null;
  return (value) => {
    const validated = validateImplementationReviewResult(value, referenceContext, role);
    // Keep schema failures visible even when the runner retries successfully.
    // Record bounded references only, never the provider envelope or narrative.
    const references = JSON.stringify({
      assessments: Array.isArray(value?.assessments) ? value.assessments.map((entry) => ({ conclusion: typeof entry?.conclusion === "string" ? entry.conclusion : null, requirementRefs: refs(entry?.requirementRefs), evidenceRefs: refs(entry?.evidenceRefs) })) : null,
      findings: Array.isArray(value?.findings) ? value.findings.map((finding) => ({ kind: typeof finding?.kind === "string" ? finding.kind : null, requirementRefs: refs(finding?.requirementRefs), evidenceRefs: refs(finding?.evidenceRefs) })) : null,
      priorDispositions: Array.isArray(value?.priorDispositions) ? value.priorDispositions.map((entry) => ({ findingId: typeof entry?.findingId === "string" ? entry.findingId : null, status: typeof entry?.status === "string" ? entry.status : null, evidenceRefs: refs(entry?.evidenceRefs) })) : null,
    });
    t.diagnostic(JSON.stringify({ variant, role, validatorAttempt: ++attempt,
      validationError: typeof validated === "string" ? validated.slice(0, 2_000) : null,
      resultReferences: references.slice(0, 12_000), referencesTruncated: references.length > 12_000,
    }));
    return validated;
  };
}

async function evaluateRoles(config, variant, t, material, options) {
  const roles = ["fidelity", "code"];
  const startedAt = new Map();
  const finishedAt = new Map();
  const settled = await Promise.allSettled(roles.map(async (role) => {
    startedAt.set(role, new Date().toISOString());
    try {
      const outcome = await runJudge(config, `smoke:implement:review:${role}:${variant}`, "routine", reviewPrompt(material, role),
        diagnosticValidator(t, variant, role, material.referenceContext), options);
      return { review: outcome.value, call: outcome.record };
    } finally {
      finishedAt.set(role, new Date().toISOString());
    }
  }));
  // Preserve each actual execution before raising a partial failure or testing
  // the fixture oracle. The successful peer must remain visible after an error.
  const reviews = Object.fromEntries(settled.map((entry, index) => {
    const role = roles[index];
    const timing = { startedAt: startedAt.get(role), finishedAt: finishedAt.get(role) };
    const result = entry.status === "fulfilled"
      ? { status: "complete", ...timing, ...entry.value }
      : { status: "error", ...timing, review: null, call: judgeCallRecordFrom(entry.reason), error: String(entry.reason) };
    return [role, result];
  }));
  t.diagnostic(JSON.stringify({ variant, reviews }));
  for (const role of roles) assert.equal(reviews[role].status, "complete", `${role} review failed: ${reviews[role].error ?? "no result"}`);
  return reviews;
}

// This deliberately stays outside default suites. Unlike the fixture judge,
// the real reviewer must identify independently fixed omissions in a contract
// whose middle and final requirements are equally important.
export async function evaluateLiveReview(backend, t, variants = ["complete", "middle-omission", "final-omission", "unwired", "storage-failure", "authorized-assumptions"]) {
  const outcomes = [];
  for (const variant of variants) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `sasu-live-review-${variant}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, "src"));
    fs.mkdirSync(path.join(root, "private"));
    fs.writeFileSync(path.join(root, "private/decoy.txt"), "PRIVATE_DECOY_MUST_NOT_BE_READ\n");
    const definitions = Array.from({ length: 30 }, (_, index) => `export function value${index + 1}() { return ${variant === "middle-omission" && index === 16 || variant === "final-omission" && index === 29 ? "undefined" : index + 1}; }`).join("\n");
    const bindings = Array.from({ length: 30 }, (_, index) => variant === "unwired" && index === 27 ? "undefined" : `value${index + 1}`).join(", ");
    // B31 does not restrict thrown values to Error. A real review exposed the
    // former baseline losing string errors and crashing on null, beyond the planted defect.
    const source = `import { ${Array.from({ length: 30 }, (_, index) => `value${index + 1}`).join(", ")} } from './values.mjs';\nconst actions = [${bindings}];\nexport function command(n) { return actions[n - 1]?.(); }\nexport function save(store, value) { ${variant === "storage-failure" ? "try { store.write(value); } catch {} return { ok: true };" : "try { store.write(value); return { ok: true }; } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error), value }; }"} }\n`;
    fs.writeFileSync(path.join(root, "src/public.mjs"), source);
    fs.writeFileSync(path.join(root, "src/values.mjs"), definitions + "\n");
    let original = prd({ count: 30, extraRows: ["| B31 | If the injected store throws while saving, save returns ok false with the error message and preserves the input value. | D-01 |"] });
    const authorizedAssumptions = variant === "authorized-assumptions";
    if (authorizedAssumptions) original = original.replace('human_approval: "approved"', 'human_approval: "pending"').replace("The user requested all values.", "Agent-owned product assumptions: these product items have not been individually approved by the user.");
    const contractText = original.replace(/Requirement (\d+): the public command preserves value \d+\./g, "The exported command($1) function returns the number $1.").replace("The public command is implemented in implementation.txt.", "The public API is command and save exported from src/public.mjs; internal helper presence alone does not satisfy command behavior.");
    const contract = parseImplementContract(contractText);
    const approval = authorizedAssumptions
      ? { source: "conversation", evidence: "I approve this fixture and authorize implementation using the listed agent-owned product assumptions." }
      : { source: "frontmatter", evidence: "human_approval: approved" };
    const intentContent = renderDecisions(contract);
    const observed = spawnSync(process.execPath, ["--input-type=module", "-e", "import { command } from './src/public.mjs'; if (command(1) !== 1) process.exit(1); console.log('command(1)=1; only the first requirement was executed');"], { cwd: root, encoding: "utf8" });
    assert.equal(observed.status, 0, observed.stderr);
    fs.writeFileSync(path.join(root, "smoke.log"), observed.stdout);
    const requirementRefs = [...contract.rows.map((row) => row.id), ...contract.decisions.map((decision) => decision.id)];
    const referenceContext = { requiredRequirementRefs: contract.rows.map((row) => row.id), actualEvidenceRefs: ["src/public.mjs", "src/values.mjs", "smoke.log"], requirementRefs, evidenceRefs: ["PRD", "Decisions", "Risks", "instruction", ...requirementRefs, "src/public.mjs", "src/values.mjs", "smoke.log"], priorFindingIds: [], humanSources: fixtureHumanSources(contract, intentContent) };
    const material = {
      prdText: contractText, contract, approval, intentSource: { routing: "decisions", content: intentContent, explanation: "fixed approved evaluation contract" },
      // The changed helper alone cannot prove the public API is wired. The
      // reviewer must discover the unchanged caller in the fixed snapshot.
      changedPaths: ["src/values.mjs"], workspacePaths: ["src/public.mjs", "src/values.mjs", "smoke.log", diffChunkPath("src/values.mjs")],
      changeSet: { changes: [{ path: "src/values.mjs", chunkPath: diffChunkPath("src/values.mjs"), addedLines: 30, removedLines: 0 }], notes: [] }, checks: [{ command: "node first-requirement-smoke", exitCode: observed.status, logPath: "smoke.log", provenance: "fixed fixture command(1) execution only" }], artifacts: [],
      referenceContext, priorFindings: [], roundContext: { priorAttemptId: null, changedPaths: [], newEvidence: [] },
    };
    const config = loadConfig(root);
    config.judge.profiles.routine = { primary: { backend, model: backend === "codex" ? "gpt-5.6-luna" : "claude-sonnet-5", effort: "xhigh" }, fallback: null };
    const chunk = "diff --git a/src/values.mjs b/src/values.mjs\n--- a/src/values.mjs\n+++ b/src/values.mjs\n@@ -0,0 +1,30 @@\n" + definitions.split("\n").map((line) => "+" + line).join("\n") + "\n";
    const documents = writeReviewDocuments(root, material, { [diffChunkPath("src/values.mjs")]: chunk });
    const reviews = await evaluateRoles(config, variant, t, material,
      { agentic: true, explore: true, cwd: root, evidencePaths: ["src/public.mjs", "src/values.mjs", "smoke.log", ...documents] });
    const expected = { "middle-omission": "B17", "final-omission": "B30", unwired: "B28", "storage-failure": "B31" }[variant];
    for (const outcome of Object.values(reviews)) {
      assert.equal(outcome.call.backend, backend, "a fallback must not masquerade as the evaluated backend");
      const trace = outcome.call.activity?.commands ?? [];
      if (backend === "codex") {
        assert.ok(trace.length > 0, "each role must read the omitted inline source through production isolation");
        assert.doesNotMatch(trace.join("\n"), /private\/decoy|\bgit\s|\bcurl\s|\bwget\s|\bnode\s/);
      }
    }
    outcomes.push({ variant, expectedDefect: expected ?? null, reviews });
    t.diagnostic(JSON.stringify({ variant, expectedDefect: expected ?? null }));
    // Union only for the fixed oracle. Keep all original findings above so
    // duplicate findings are measurable and either role's extra blocker fails.
    assertReviewBlockingRefs({ findings: Object.values(reviews).flatMap((entry) => entry.review.findings) }, expected ? [expected] : [], contract.decisions.map((decision) => decision.id));
  }
  return outcomes;
}

export async function evaluateLiveVisual(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-live-review-image-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const imagePath = path.join(root, "visual.png");
  fs.copyFileSync(path.resolve(import.meta.dirname, "../../../assets/mascot.png"), imagePath);
  const { createHash } = await import("node:crypto");
  const bytes = fs.readFileSync(imagePath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const prdText = prd({ count: 0, extraRows: ["| B1 | The image depicts an illustrated person wearing rectangular glasses. | D-01 |", "| B2 | The person wears a red plaid shirt and a red marker is visible. | D-01 |"], decisions: "| D-01 | Provide the specified character illustration. | The requested visual details are the complete contract. |" }).replace("The public command preserves every requested value.", "Provide the requested character illustration.").replace("The public command is implemented in implementation.txt.", "The delivered image is visual.png.");
  const contract = parseImplementContract(prdText);
  const approval = { source: "frontmatter", evidence: "human_approval: approved" };
  const intentContent = renderDecisions(contract);
  const artifact = { path: "visual.png", kind: "image", description: "Delivered character illustration", sha256, bytes: bytes.length, registeredAt: new Date().toISOString(), observedAt: new Date().toISOString(), provenance: "fixed visual fixture", target: "visual.png" };
  const referenceContext = { requiredRequirementRefs: ["B1", "B2"], actualEvidenceRefs: ["visual.png"], requirementRefs: ["B1", "B2", "D-01"], evidenceRefs: ["PRD", "Decisions", "Risks", "instruction", "B1", "B2", "D-01", "visual.png"], priorFindingIds: [], humanSources: fixtureHumanSources(contract, intentContent) };
  const material = { prdText, contract, approval, intentSource: { routing: "decisions", content: intentContent, explanation: "fixed visual contract" }, changedPaths: ["visual.png"], workspacePaths: ["visual.png"], changeSet: { changes: [], notes: ["No product source changed."] }, checks: [], artifacts: [artifact], referenceContext, priorFindings: [], roundContext: { priorAttemptId: null, changedPaths: [], newEvidence: [] } };
  const config = loadConfig(root);
  config.judge.profiles.routine = { primary: { backend: "codex", model: "gpt-5.6-luna", effort: "xhigh" }, fallback: null };
  const documents = writeReviewDocuments(root, material);
  const reviews = await evaluateRoles(config, "visual", t, material, { agentic: true, explore: true, cwd: root, evidencePaths: ["visual.png", ...documents], images: [imagePath] });
  for (const outcome of Object.values(reviews)) assert.equal(outcome.call.backend, "codex");
  t.diagnostic(JSON.stringify({ case: "actual-image-attachment", variant: "visual" }));
  assertReviewBlockingRefs({ findings: Object.values(reviews).flatMap((entry) => entry.review.findings) }, [], contract.decisions.map((decision) => decision.id));
}
