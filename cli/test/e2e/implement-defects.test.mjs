import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { REVIEW_INPUT_PATHS } from "../../dist/implement/prompts.js";
import { PRD_PATH, REVIEW_PASS, makeProject, readState, run, start, stub, ok, registerEvidence, defect } from "../helpers/implement-fixture.mjs";

function reviewFile(env, role, relative) {
  const { cwd } = JSON.parse(fs.readFileSync(path.join(env.SASU_JUDGE_STUB_CAPTURE_DIR, `implement_${role}.options.json`), "utf8"));
  return fs.readFileSync(path.join(cwd, relative), "utf8");
}

// These assertions protect completion integrity; the external stub does not
// establish that a model can detect the planted defects in the live smoke.
for (const mutation of ["source", "prd", "artifact-changed", "artifact-missing"]) {
  test(`a current PASS becomes ineligible after ${mutation} changes, including a previously finalized run`, () => {
    const root = makeProject();
    start(root);
    const evidence = registerEvidence(root);
    const env = stub(root);
    ok(run(root, ["implement", "verify"], { env }));
    ok(run(root, ["implement", "finalize"]));
    if (mutation === "source") fs.appendFileSync(path.join(root, "implementation.txt"), "unreviewed source\n");
    if (mutation === "prd") fs.appendFileSync(path.join(root, PRD_PATH), "unapproved scope\n");
    if (mutation === "artifact-changed") fs.appendFileSync(path.join(root, evidence), "different observation\n");
    if (mutation === "artifact-missing") fs.unlinkSync(path.join(root, evidence));
    const refused = run(root, ["implement", "finalize"]);
    assert.notEqual(refused.status, 0, refused.stdout);
    const status = ok(run(root, ["implement", "status"]));
    assert.equal(status.detail.verification.verdict, "STALE");
    assert.equal(readState(root).verificationAttempts[0].verdict, "PASS", "the historical result remains honest");
  });
}

test("missing or altered registered evidence stops review, while a replacement preserves history", () => {
  const root = makeProject();
  start(root);
  const relative = registerEvidence(root);
  const env = stub(root);
  const initial = readState(root).artifacts.find((entry) => entry.path === relative);
  fs.appendFileSync(path.join(root, relative), "replacement capture\n");
  assert.notEqual(run(root, ["implement", "verify"], { env }).status, 0);
  assert.equal(readState(root).verificationAttempts.at(-1).reviews.fidelity, null);
  assert.equal(fs.existsSync(env.SASU_JUDGE_STUB_CAPTURE_DIR), false);
  registerEvidence(root, { relative, content: "replacement capture\n" });
  const state = readState(root);
  assert.ok(state.evidenceReplacements.some((entry) => JSON.stringify(entry).includes(initial.sha256)));
  ok(run(root, ["implement", "verify"], { env }));
  ok(run(root, ["implement", "finalize"]));
});

test("artifact registration rejects self-referential and escaping symlink evidence", () => {
  const root = makeProject();
  start(root);
  fs.symlinkSync(path.join(root, "agents/runs/fixture/state.json"), path.join(root, "state-alias.json"));
  fs.symlinkSync("/etc/hosts", path.join(root, "external-alias.txt"));
  for (const relative of ["agents/runs/fixture/state.json", "agents/runs/fixture/prd.md", "state-alias.json", "external-alias.txt"]) {
    const result = run(root, ["implement", "artifact", "--kind", "file", "--path", relative, "--description", "invalid evidence", "--source", "fixture", "--collected-at", "2026-09-08T00:00:00.000Z"]);
    assert.notEqual(result.status, 0, relative);
    assert.match(result.json.message, /harness-owned|outside|leaves|escape/);
  }
  assert.equal(readState(root).artifacts.length, 0);
});

test("an absent prior disposition cannot silently resolve a defect, and a new unchanged-file omission is retained", () => {
  const root = makeProject({ count: 30 });
  start(root);
  let env = stub(root, { ...REVIEW_PASS, findings: [defect({ ref: "B17" })] });
  assert.notEqual(run(root, ["implement", "verify"], { env }).status, 0);
  const first = readState(root).findings[0];
  env = stub(root);
  assert.notEqual(run(root, ["implement", "verify"], { env }).status, 0);
  assert.equal(readState(root).findings[0].status, "open");
  env = stub(root, {
    summary: "A second missing approved value was found in the unchanged implementation.",
    findings: [defect({ ref: "B28", problem: "Value 28 is never reachable from the public command in implementation.txt." })],
    priorDispositions: [{ findingId: first.id, status: "open", reason: "Value 17 remains absent.", evidenceRefs: ["implementation.txt"] }],
  });
  assert.notEqual(run(root, ["implement", "verify"], { env }).status, 0);
  const after = readState(root);
  assert.equal(after.findings.filter((entry) => entry.status === "open").length, 2);
  assert.ok(after.findings.some((entry) => entry.requirementRefs.includes("B28")));
  assert.deepEqual(after.verificationAttempts.at(-1).roundContext.changedPaths, []);
  assert.equal(after.verificationAttempts.at(-1).reviews.fidelity.verdict, "FAIL", "a real contract omission is admitted without changed-path proof");
  fs.appendFileSync(path.join(root, "implementation.txt"), "values 17 and 28 are now reachable\n");
  env = stub(root, { ...REVIEW_PASS, priorDispositions: after.findings.map((entry) => ({ findingId: entry.id, status: "resolved", reason: "Both missing values are now connected in the implementation.", evidenceRefs: ["implementation.txt"] })) });
  ok(run(root, ["implement", "verify"], { env }));
  assert.equal(readState(root).findings.filter((entry) => entry.status === "open").length, 0);
  ok(run(root, ["implement", "finalize"]));
});

test("advice is recorded without an acceptance ceremony, while a top-level PASS cannot hide a defect", () => {
  const root = makeProject();
  start(root);
  let env = stub(root, { ...REVIEW_PASS, findings: [{ ...defect(), kind: "advisory", problem: "Optional wording polish beyond the approved contract." }] });
  ok(run(root, ["implement", "verify"], { env }));
  ok(run(root, ["implement", "finalize"]));
  assert.equal(readState(root).findings[0].kind, "advisory");
  const second = makeProject();
  start(second);
  env = stub(second, { ...REVIEW_PASS, verdict: "PASS", findings: [defect()] });
  assert.notEqual(run(second, ["implement", "verify"], { env }).status, 0);
  assert.notEqual(run(second, ["implement", "finalize"]).status, 0);
});

function humanFinding(timing = "post-completion") {
  return { kind: "human-confirmation", requirementRefs: ["D-02"], problem: "The user has reserved the final appearance judgment.", evidenceRefs: ["D-02"], nextAction: "Ask the user to assess the final appearance.", human: { sourceRef: "D-02", quote: "The user will judge the final appearance after completion.", timing } };
}
function humanProject() {
  return makeProject({ decisions: "| D-01 | Preserve every value in the approved request. | User requested all values. |\n| D-02 | The user will judge the final appearance after completion. | The user explicitly allows delivery before this judgment. |" });
}

test("review receives recorded conversational admission and exact human-source quotation boundaries", () => {
  const decision = "Preserve every value in the approved request.";
  const rationale = "Agent-owned fixture assumption; the user did not individually approve these product choices.";
  const root = makeProject({ decisions: `| D-01 | ${decision} | ${rationale} |` });
  const prdPath = path.join(root, PRD_PATH);
  fs.writeFileSync(prdPath, fs.readFileSync(prdPath, "utf8").replace('human_approval: "approved"', 'human_approval: "pending"'));
  const evidence = "Proceed with this test fixture using the recorded assumptions; no additional product approval is required.";
  ok(run(root, ["implement", "start", "--prd", PRD_PATH, "--dirty-attribution", "run-owned", "--allow-unapproved-prd", evidence]));
  fs.writeFileSync(path.join(readState(root).worktree?.path ?? root, "implementation.txt"), "run-owned implementation\n");
  const env = stub(root);
  ok(run(root, ["implement", "verify"], { env }));
  const prompt = fs.readFileSync(path.join(env.SASU_JUDGE_STUB_CAPTURE_DIR, "implement_fidelity.prompt.txt"), "utf8");
  // Canonical context now rides in the prompt inside its quoted boundary.
  const context = prompt;
  const admission = JSON.parse(context.split("RUN ADMISSION AUTHORITY (not product evidence):\n")[1]?.split("\n")[0] ?? "null");
  assert.deepEqual(admission, { source: "conversation", evidence });
  // Quotation authority is unchanged when duplicate canonical text is a pointer.
  // Assert every exact source and its target without assuming a JSON-object rendering.
  const sources = context.split("HUMAN SOURCE TEXT (sourceRef -> exact quoteable text):\n")[1]?.split("\n\nHARNESS BOOKKEEPING FACTS")[0];
  assert.ok(sources);
  for (const [ref, text] of Object.entries({ Decisions: `${decision}\n${rationale}`, Risks: "None.", "D-01": decision })) {
    assert.ok(sources.includes(`${JSON.stringify(ref)}: ${JSON.stringify(text)}`));
  }
  assert.ok(sources.includes('"instruction": the exact complete CANONICAL INTENT SOURCE text above'));
  assert.ok(context.split("RUN ADMISSION AUTHORITY")[0].includes(`- D-01: ${decision} (근거: ${rationale})`));
  assert.match(prompt, /Pending frontmatter or agent-owned assumptions alone do not create a human-confirmation finding/);
  ok(run(root, ["implement", "finalize"]));
  assert.equal(readState(root).status, "complete");
});

test("post-completion human input remains open, rejection blocks delivery, explicit withdrawal restores it with history", () => {
  const root = humanProject();
  start(root);
  const env = stub(root, { ...REVIEW_PASS, findings: [humanFinding()] });
  ok(run(root, ["implement", "verify"], { env }));
  ok(run(root, ["implement", "finalize"]));
  assert.equal(readState(root).status, "complete-pending-human");
  const item = readState(root).findings.find((entry) => entry.kind === "human-confirmation");
  const confirm = (issuer, flag, words) => run(root, ["implement", "confirm", "--issuer", issuer, "--id", item.id, ...(flag === "--reject" ? ["--reject"] : []), "--evidence", words]);
  assert.notEqual(confirm("observer", "--evidence", "I approve").status, 0);
  assert.notEqual(confirm("implementor", "--evidence", "I approve").status, 0);
  ok(confirm("human", "--reject", "The layout obscures the primary action."));
  let state = readState(root);
  assert.equal(state.findings.find((entry) => entry.id === item.id).status, "open");
  const status = ok(run(root, ["implement", "status"]));
  assert.equal(status.detail.delivery.eligible, false);
  const receipt = JSON.parse(fs.readFileSync(path.join(root, state.completion.receiptPath), "utf8"));
  assert.equal(receipt.delivery.eligible, false);
  ok(confirm("human", "--evidence", "I explicitly withdraw my previous rejection and approve this same result."));
  state = readState(root);
  assert.equal(state.status, "complete");
  assert.deepEqual(state.findings.find((entry) => entry.id === item.id).responses.map((entry) => entry.response), ["rejected", "confirmed"]);
  assert.equal(ok(run(root, ["implement", "status"])).detail.delivery.eligible, true);
});

test("a prerequisite human judgment cannot be downgraded into deliverable pending-human", () => {
  const root = humanProject();
  start(root);
  const invalid = humanFinding("prerequisite");
  invalid.human.quote = "The user explicitly allows delivery before this judgment.";
  assert.notEqual(run(root, ["implement", "verify"], { env: stub(root, { ...REVIEW_PASS, findings: [invalid] }) }).status, 0);
  assert.equal(readState(root).verificationAttempts[0].verdict, "ERROR", "a D-id cannot quote its rationale cell");
  assert.equal(readState(root).findings.length, 0);
  const env = stub(root, { ...REVIEW_PASS, findings: [humanFinding("prerequisite")] });
  const result = run(root, ["implement", "verify"], { env });
  assert.notEqual(result.status, 0);
  assert.notEqual(run(root, ["implement", "finalize"]).status, 0);
  assert.equal(readState(root).status, "active");
});

test("a human confirmation cannot refresh a completed result after source has changed", () => {
  const root = humanProject();
  start(root);
  const env = stub(root, { ...REVIEW_PASS, findings: [humanFinding()] });
  ok(run(root, ["implement", "verify"], { env }));
  ok(run(root, ["implement", "finalize"]));
  const id = readState(root).findings[0].id;
  fs.appendFileSync(path.join(root, "implementation.txt"), "unreviewed changes\n");
  const result = run(root, ["implement", "confirm", "--issuer", "human", "--id", id, "--evidence", "I approve"]);
  assert.notEqual(result.status, 0);
  assert.equal(ok(run(root, ["implement", "status"])).detail.verification.verdict, "STALE");
});

test("a change to the canonical interview invalidates review even when a prior spec gate selected decisions", () => {
  const qaLog = "agents/interview/fixture/qa-log.md";
  const root = makeProject({ sourceIntake: qaLog });
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "../fixtures/prelint/qa-clean.md"), "utf8");
  fs.mkdirSync(path.dirname(path.join(root, qaLog)), { recursive: true });
  fs.writeFileSync(path.join(root, qaLog), source);
  const file = path.join(root, "agents/gate-judge.json");
  fs.writeFileSync(file, JSON.stringify({ verdict: "PASS", findings: [] }));
  const gates = { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file };
  ok(run(root, ["gate", "gap-audit", "--slug", "fixture", "--qa-log", qaLog], { env: gates }));
  ok(run(root, ["gate", "spec", "--slug", "fixture", "--prd", PRD_PATH, "--qa-log", qaLog], { env: gates }));
  start(root);
  ok(run(root, ["implement", "verify"], { env: stub(root) }));
  fs.appendFileSync(path.join(root, qaLog), "\nUser clarification changes the allowed storage behavior.\n");
  assert.notEqual(run(root, ["implement", "finalize"]).status, 0);
  assert.equal(ok(run(root, ["implement", "status"])).detail.verification.verdict, "STALE");
});

test("a foreign session mutation needs recorded adoption before ownership changes", () => {
  const root = makeProject();
  const first = { CLAUDE_CODE_SESSION_ID: "fixture-owner" };
  const second = { CLAUDE_CODE_SESSION_ID: "fixture-other" };
  start(root, { env: first });
  const foreign = run(root, ["implement", "retire", "--slug", "fixture"], { env: second });
  assert.notEqual(foreign.status, 0);
  assert.match(foreign.json.message, /owned by another session/);
  assert.equal(readState(root).ownerSessionId, "fixture-owner");
  ok(run(root, ["implement", "retire", "--slug", "fixture", "--adopt", "I approve taking over this unfinished run."], { env: second }));
  assert.equal(readState(root).adoptions.at(-1).fromSessionId, "fixture-owner");
  assert.equal(readState(root).adoptions.at(-1).evidence, "I approve taking over this unfinished run.");
});

test("a confirmed human authority remains visible to the next full review and is not reopened by omission", () => {
  const root = humanProject();
  start(root);
  const env = stub(root, { ...REVIEW_PASS, findings: [humanFinding()] });
  ok(run(root, ["implement", "verify"], { env }));
  const id = readState(root).findings[0].id;
  const evidence = "I confirm the final appearance of this exact result.";
  ok(run(root, ["implement", "confirm", "--issuer", "human", "--id", id, "--evidence", evidence]));
  const rereview = stub(root);
  ok(run(root, ["implement", "verify"], { env: rereview }));
  const prompt = fs.readFileSync(path.join(rereview.SASU_JUDGE_STUB_CAPTURE_DIR, "implement_fidelity.prompt.txt"), "utf8");
  assert.ok(prompt.includes(evidence), "the recorded human authority is quoted for the next review");
  assert.equal(readState(root).findings.find((entry) => entry.id === id).status, "confirmed");
  ok(run(root, ["implement", "finalize"]));
  assert.equal(readState(root).status, "complete");
});

// User-approved policy: the reviewer discovers unchanged callers in the
// frozen product source instead of asking the implementor to register each one.
test("the frozen source includes unchanged callers without exposing bookkeeping or ignored files", () => {
  const root = makeProject();
  start(root);
  fs.appendFileSync(path.join(root, ".gitignore"), "private/\n");
  fs.mkdirSync(path.join(root, "private"));
  fs.writeFileSync(path.join(root, "private/secret.txt"), "private decoy\n");
  const env = stub(root);
  ok(run(root, ["implement", "verify"], { env }));
  const attempt = readState(root).verificationAttempts.at(-1);
  const { cwd } = JSON.parse(fs.readFileSync(path.join(env.SASU_JUDGE_STUB_CAPTURE_DIR, "implement_fidelity.options.json"), "utf8"));
  assert.equal(reviewFile(env, "fidelity", "suite.cjs"), fs.readFileSync(path.join(root, "suite.cjs"), "utf8"));
  assert.ok(attempt.reviewContext.actualEvidenceRefs.includes("suite.cjs"));
  assert.equal(fs.existsSync(path.join(cwd, "agents/runs/fixture/state.json")), false);
  assert.equal(fs.existsSync(path.join(cwd, "private/secret.txt")), false);
  assert.equal(fs.existsSync(path.join(cwd, ".git")), false);
  const fixedCaller = reviewFile(env, "fidelity", "suite.cjs");
  fs.appendFileSync(path.join(root, "suite.cjs"), "// subsequent source mutation\n");
  assert.equal(reviewFile(env, "fidelity", "suite.cjs"), fixedCaller, "review input remains pinned after the working source changes");
  assert.notEqual(run(root, ["implement", "finalize"]).status, 0, "the later source mutation must invalidate completion");
});

// 2026-09-10, one measured production rejection: a review that cited this
// document was thrown out for an unknown reference. The harness writes it,
// lists it in its own path index, and names it in the prompt, so the readable
// set and the citable set have to be built from one place.
test("every document the harness writes into the review workspace is citable", () => {
  const root = makeProject();
  start(root);
  const env = stub(root);
  ok(run(root, ["implement", "verify"], { env }));
  const attempt = readState(root).verificationAttempts.at(-1);
  const { cwd } = JSON.parse(fs.readFileSync(path.join(env.SASU_JUDGE_STUB_CAPTURE_DIR, "implement_fidelity.options.json"), "utf8"));
  for (const document of Object.values(REVIEW_INPUT_PATHS)) {
    assert.ok(fs.existsSync(path.join(cwd, document)), `${document} is readable`);
    assert.ok(attempt.reviewContext.evidenceRefs.includes(document), `${document} is citable`);
    // Citable, but never the actual evidence a satisfied assessment rests on:
    // the contract already says catalog-only paths establish no implementation.
    assert.equal(attempt.reviewContext.actualEvidenceRefs.includes(document), false, document);
  }
  assert.ok(reviewFile(env, "fidelity", REVIEW_INPUT_PATHS.sourceIndex).includes("suite.cjs"), "the index names the frozen product source");
});

test("registered record-tree source cannot replace different current source in an isolated worktree", (t) => {
  const root = makeProject();
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-source-context-"));
  fs.writeFileSync(path.join(root, "agents/config.json"), JSON.stringify({ worktree: { enabled: true, root: worktreeRoot } }));
  const workRoot = start(root);
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(worktreeRoot, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(workRoot, "suite.cjs"), "console.log('CURRENT WORKTREE SOURCE');\n");
  ok(run(root, ["implement", "artifact", "--kind", "file", "--path", "suite.cjs", "--description", "Record-tree source", "--source", "record checkout"]));
  const env = stub(root);
  assert.notEqual(run(root, ["implement", "verify"], { env }).status, 0);
  const attempt = readState(root).verificationAttempts.at(-1);
  assert.equal(attempt.reviews.fidelity, null);
  assert.match(attempt.error.message, /registered source context.*differs from current product source/);
  assert.equal(fs.existsSync(env.SASU_JUDGE_STUB_CAPTURE_DIR), false);
  assert.notEqual(run(root, ["implement", "finalize"]).status, 0);
});
