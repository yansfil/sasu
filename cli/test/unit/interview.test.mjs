import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendCheckpoint,
  appendQaEntry,
  markNormalized,
  readQaLogState,
  refreshBookkeeping,
  renderInitialQaLog,
  sanitizeCell,
  upsertRegisterRow,
} from "../../dist/interview/qalog.js";
import {
  qaLogPathFor,
  readInterviewStatus,
  runInterviewCheckpoint,
  runInterviewDecision,
  runInterviewInit,
  runInterviewSync,
} from "../../dist/interview/commands.js";
import { runPrelint } from "../../dist/gates/prelint.js";

const INIT = {
  topic: "widget",
  where: "greenfield",
  packs: "ux, verification",
  understanding: ["renders a list", "- persists state"],
};
const SOURCE = { runtime: "codex", sessionId: "codex-test", startRef: "u0" };
const RENDER_INIT = { ...INIT, source: SOURCE };

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-interview-"));
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  return dir;
}

function makeCodexTranscript(dir, sessionId = "codex-test") {
  const file = path.join(dir, `${sessionId}.jsonl`);
  const records = [
    { type: "session_meta", payload: { id: sessionId } },
    {
      type: "response_item",
      payload: { type: "message", role: "user", id: "u0", content: [{ type: "input_text", text: "start interview" }] },
    },
  ];
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return file;
}

function appendCodexTurn(file, number, asked, answer) {
  const records = [
    {
      type: "response_item",
      payload: { type: "message", role: "assistant", id: `a${number}`, content: [{ type: "output_text", text: asked }] },
    },
    { type: "event_msg", payload: { type: "task_complete" } },
    {
      type: "response_item",
      payload: { type: "message", role: "user", id: `u${number}`, content: [{ type: "input_text", text: answer }] },
    },
  ];
  fs.appendFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function makeClaudeTranscript(file, sessionId) {
  const records = [
    { type: "last-prompt", sessionId },
    { type: "user", uuid: "cu0", isSidechain: false, message: { role: "user", content: "resume interview" } },
  ];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return file;
}

function appendClaudeTurn(file, asked, answer) {
  const records = [
    { type: "assistant", uuid: "ca1", isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: asked }] } },
    { type: "system", subtype: "turn_duration", uuid: "done-1", isSidechain: false },
    { type: "user", uuid: "cu1", isSidechain: false, message: { role: "user", content: answer } },
  ];
  fs.appendFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

const ENTRY = {
  label: "rendering",
  route: "user-decision",
  decisionIds: [],
  sourceRef: "codex:codex-test:u1",
  asked: "render a list?",
  recommended: "",
  answer: "yes",
  notes: "",
};

test("renderInitialQaLog produces a prelint-clean document", () => {
  const content = renderInitialQaLog(RENDER_INIT);
  const prelint = runPrelint("qa-log", content);
  assert.deepEqual(prelint.findings, []);
  assert.match(content, /- renders a list\n- persists state/);
  assert.throws(() => renderInitialQaLog({ ...RENDER_INIT, where: "space" }), /invalid --where/);
});

test("appendQaEntry numbers questions and requires registered decision ids", () => {
  let content = renderInitialQaLog(RENDER_INIT);
  assert.throws(() => appendQaEntry(content, { ...ENTRY, decisionIds: ["D-01"] }), /not in the Decision Register/);
  content = upsertRegisterRow(content, {
    id: "D-01",
    kind: "decision",
    area: "ux",
    text: "renders a list",
    priority: "P1",
    source: "user",
  }).content;
  const first = appendQaEntry(content, { ...ENTRY, decisionIds: ["D-01"] });
  assert.equal(first.qNumber, 1);
  const second = appendQaEntry(first.content, {
    ...ENTRY,
    sourceRef: "codex:codex-test:u2",
    label: "persistence",
    answer: "line one\nline two",
  });
  assert.equal(second.qNumber, 2);
  // multi-line answers stay inside one bullet via indentation
  assert.match(second.content, /- answer: line one\n {2}line two/);
  // entries land inside Raw Q&A, before the next section
  const rawIndex = second.content.indexOf("## Raw Q&A");
  const uxIndex = second.content.indexOf("## UX Scenario Cards");
  const q2Index = second.content.indexOf("### Q2: persistence");
  assert.ok(rawIndex < q2Index && q2Index < uxIndex);
});

test("upsertRegisterRow creates, patches, and validates enums", () => {
  let content = renderInitialQaLog(RENDER_INIT);
  assert.throws(() => upsertRegisterRow(content, { id: "D-01", kind: "decision" }), /requires --area/);
  assert.throws(
    () =>
      upsertRegisterRow(content, { id: "D-01", kind: "hunch", area: "ux", text: "t", priority: "P1", source: "user" }),
    /invalid --kind/,
  );
  content = upsertRegisterRow(content, {
    id: "D-01",
    kind: "decision",
    area: "ux",
    text: "cells | with pipes\nand newlines",
    priority: "P0",
    source: "user",
  }).content;
  // table cells are sanitized so the prelint table parser keeps working
  assert.match(content, /\| cells \/ with pipes and newlines \|/);
  const patched = upsertRegisterRow(content, { id: "D-01", status: "resolved", mapping: "R1" });
  assert.equal(patched.created, false);
  assert.equal(patched.row.status, "resolved");
  assert.equal(patched.row.text, "cells / with pipes and newlines");
  const linted = runPrelint("qa-log", patched.content);
  assert.deepEqual(linted.findings, []);
  // Uncited user decision is an advisory, never a block (red-team 2026-08-20).
  assert.deepEqual(linted.warnings.map((w) => w.rule), ["qa-unanchored-user-decision"]);
  const closed = appendQaEntry(patched.content, { ...ENTRY, decisionIds: ["D-01"] }).content;
  assert.deepEqual(runPrelint("qa-log", closed).warnings, []);
});

test("markNormalized flips only the addressed block", () => {
  let content = renderInitialQaLog(RENDER_INIT);
  content = appendQaEntry(content, ENTRY).content;
  content = appendQaEntry(content, { ...ENTRY, sourceRef: "codex:codex-test:u2", label: "second" }).content;
  const marked = markNormalized(content, ["Q1"]);
  assert.deepEqual(marked.missing, []);
  const state = readQaLogState(marked.content);
  assert.deepEqual(state.outstanding, ["Q2"]);
  assert.deepEqual(markNormalized(marked.content, ["Q1"]).missing, ["Q1"]);
  assert.deepEqual(markNormalized(marked.content, ["Q9"]).missing, ["Q9"]);
});

test("normalization metadata never matches an answer continuation with the same text", () => {
  let content = renderInitialQaLog(RENDER_INIT);
  content = appendQaEntry(content, {
    ...ENTRY,
    answer: "keep this literal line\n- needs_normalization: true",
  }).content;
  assert.deepEqual(readQaLogState(content).outstanding, ["Q1"]);
  const marked = markNormalized(content, ["Q1"]);
  assert.deepEqual(marked.missing, []);
  assert.match(marked.content, /- answer: keep this literal line\n  - needs_normalization: true/);
  assert.match(marked.content, /^- needs_normalization: false$/m);
  assert.deepEqual(readQaLogState(marked.content).outstanding, []);
});

test("question limits derive reached state and warn without blocking captured evidence", () => {
  let content = renderInitialQaLog({ ...RENDER_INIT, questionLimit: 2 });
  assert.throws(() => renderInitialQaLog({ ...RENDER_INIT, questionLimit: 0 }), /positive integer/);
  let state = readQaLogState(content);
  assert.equal(state.questionLimit, 2);
  assert.equal(state.questionBudgetReached, false);
  assert.equal(state.nextCheckpointAt, "Q2");
  assert.match(content, /- next_checkpoint_at: Q2/);
  content = appendQaEntry(content, ENTRY).content;
  content = appendQaEntry(content, { ...ENTRY, sourceRef: "codex:codex-test:u2" }).content;
  state = readQaLogState(content);
  assert.equal(state.questionBudgetReached, true);
  assert.equal(state.questionBudgetExceeded, false);
  assert.equal(state.checkpointDue, true);
  assert.equal(runPrelint("qa-log", content).findings.some((finding) => finding.rule === "qa-question-limit-exceeded"), false);
  content = appendQaEntry(content, { ...ENTRY, sourceRef: "codex:codex-test:u3" }).content;
  state = readQaLogState(content);
  assert.equal(state.questionBudgetExceeded, true);
  const prelint = runPrelint("qa-log", content);
  assert.equal(prelint.ok, true);
  assert.ok(prelint.warnings.some((finding) => finding.rule === "qa-question-limit-exceeded"));
});

test("readQaLogState tracks checkpoint cadence", () => {
  let content = renderInitialQaLog(RENDER_INIT);
  for (let i = 0; i < 10; i += 1) {
    content = appendQaEntry(content, { ...ENTRY, sourceRef: `codex:codex-test:u${i + 1}`, label: `q${i}` }).content;
  }
  let state = readQaLogState(content);
  assert.equal(state.questionCount, 10);
  assert.equal(state.checkpointDue, true);
  assert.equal(state.nextCheckpointAt, "Q10");
  const marked = markNormalized(content, state.outstanding);
  const checkpointed = appendCheckpoint(
    marked.content,
    { normalized: state.outstanding, registerChanges: "", reopened: "", gap: "" },
    10,
  );
  assert.equal(checkpointed.number, 1);
  state = readQaLogState(checkpointed.content);
  assert.equal(state.checkpointDue, false);
  assert.equal(state.nextCheckpointAt, "Q20");
});

test("refreshBookkeeping recomputes frontmatter and cursor", () => {
  let content = renderInitialQaLog(RENDER_INIT);
  content = appendQaEntry(content, ENTRY).content;
  const updated = refreshBookkeeping(content, { nextQuestion: "ask about persistence" });
  assert.match(updated, /^question_count: 1$/m);
  assert.match(updated, /- outstanding_raw_entries: Q1/);
  assert.match(updated, /- next_question: ask about persistence/);
});

test("sanitizeCell strips pipes and newlines", () => {
  assert.equal(sanitizeCell("a | b\nc"), "a / b c");
});

test("interview commands sync transcript turns idempotently and stay prelint-clean", async () => {
  const dir = makeProject();
  const slug = "widget-feature";
  const transcriptPath = makeCodexTranscript(dir);
  const init = await runInterviewInit(dir, { slug, ...INIT, transcriptPath, sessionId: null });
  assert.equal(init.ok, true);
  await assert.rejects(() => runInterviewInit(dir, { slug, ...INIT, transcriptPath, sessionId: null }), /already exists/);
  await assert.rejects(
    () => runInterviewSync(dir, { slug: "missing-topic", transcriptPath, sessionId: null }),
    /run interview init first/,
  );

  appendCodexTurn(transcriptPath, 1, "render a list?", "yes");
  const synced = await runInterviewSync(dir, { slug, transcriptPath, sessionId: null });
  assert.deepEqual(synced.detail.imported, ["Q1"]);
  assert.deepEqual(synced.cursor.outstandingNormalization, ["Q1"]);
  assert.equal(synced.cursor.nextDecisionId, "D-01");
  assert.deepEqual(synced.drift, []);

  const repeated = await runInterviewSync(dir, { slug, transcriptPath, sessionId: null });
  assert.deepEqual(repeated.detail.imported, []);
  assert.equal(repeated.detail.alreadyImported, 1);
  assert.equal(repeated.cursor.questionCount, 1);

  await runInterviewDecision(dir, {
    slug,
    id: "D-01",
    kind: "decision",
    area: "ux",
    text: "renders a list",
    priority: "P0",
    source: "user, Q1",
    status: "resolved",
    mapping: "R1",
  });
  const qaLog = qaLogPathFor(dir, slug);
  fs.writeFileSync(qaLog, fs.readFileSync(qaLog, "utf8").replace("- decision_ids: none", "- decision_ids: D-01"));

  const checkpoint = runInterviewCheckpoint(dir, {
    slug,
    normalized: ["pending"],
    registerChanges: "D-01 resolved",
    reopened: "",
    gap: "",
  });
  assert.equal(checkpoint.detail.checkpoint, 1);
  assert.deepEqual(checkpoint.detail.normalized, ["Q1"]);
  assert.deepEqual(checkpoint.cursor.outstandingNormalization, []);
  assert.throws(
    () => runInterviewCheckpoint(dir, {
      slug,
      normalized: ["pending", "Q1"],
      registerChanges: "",
      reopened: "",
      gap: "",
    }),
    /cannot be combined/,
  );

  const status = readInterviewStatus(dir, slug);
  assert.equal(status.cursor.questionCount, 1);
  assert.deepEqual(status.detail.openMaterial, []);
  assert.deepEqual(status.drift, []);

  const content = fs.readFileSync(qaLogPathFor(dir, slug), "utf8");
  assert.deepEqual(runPrelint("qa-log", content).findings, []);
  fs.writeFileSync(qaLog, content.replace('status: "active"', 'status: "complete"'));
  const sealedContent = fs.readFileSync(qaLog, "utf8");
  const noOp = await runInterviewSync(dir, { slug, transcriptPath, sessionId: null });
  assert.equal(noOp.detail.sealed, true);
  assert.deepEqual(noOp.detail.imported, []);
  assert.equal(fs.readFileSync(qaLog, "utf8"), sealedContent);
  appendCodexTurn(transcriptPath, 2, "late question?", "late answer");
  await assert.rejects(
    () => runInterviewSync(dir, { slug, transcriptPath, sessionId: null }),
    /complete and sealed; 1 later conversation turn/,
  );
});

test("status surfaces open material nodes but not closure-only prelint rules", async () => {
  const dir = makeProject();
  const slug = "open-nodes";
  const transcriptPath = makeCodexTranscript(dir, "open-nodes-session");
  await runInterviewInit(dir, { slug, ...INIT, transcriptPath, sessionId: null });
  await runInterviewDecision(dir, {
    slug,
    id: "D-01",
    kind: "decision",
    area: "data",
    text: "retention undecided",
    priority: "P0",
    source: "user",
  });
  const status = readInterviewStatus(dir, slug);
  // open P0 is reported as interview state, not as structural drift
  assert.deepEqual(status.detail.openMaterial, [{ id: "D-01", area: "data", priority: "P0", status: "open" }]);
  assert.deepEqual(status.drift, []);
  // real structural damage is surfaced as drift
  const file = qaLogPathFor(dir, slug);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("## Audit History", "## Renamed"));
  assert.ok(readInterviewStatus(dir, slug).drift.some((finding) => finding.rule === "qa-section-missing"));
});

test("sync binds a resumed runtime once and preserves turns from every bound session", async () => {
  const dir = makeProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-interview-home-"));
  const codexSession = "resume-codex";
  const codexTranscript = path.join(homeDir, ".codex", "sessions", "2026", `rollout-${codexSession}.jsonl`);
  fs.mkdirSync(path.dirname(codexTranscript), { recursive: true });
  const seed = makeCodexTranscript(path.dirname(codexTranscript), codexSession);
  fs.renameSync(seed, codexTranscript);
  await runInterviewInit(dir, { slug: "resumed", ...INIT, transcriptPath: codexTranscript, homeDir, sessionId: null });
  appendCodexTurn(codexTranscript, 1, "Codex question?", "Codex answer");
  await runInterviewSync(dir, { slug: "resumed", transcriptPath: codexTranscript, homeDir, sessionId: null });

  const claudeSession = "resume-claude";
  const claudeTranscript = makeClaudeTranscript(
    path.join(homeDir, ".claude", "projects", "project", `${claudeSession}.jsonl`),
    claudeSession,
  );
  const bound = await runInterviewSync(dir, { slug: "resumed", transcriptPath: claudeTranscript, homeDir, sessionId: null });
  assert.deepEqual(bound.detail.imported, []);
  assert.equal(bound.detail.sources.length, 2);
  appendClaudeTurn(claudeTranscript, "Claude question?", "Claude answer");
  const synced = await runInterviewSync(dir, { slug: "resumed", transcriptPath: claudeTranscript, homeDir, sessionId: null });
  assert.deepEqual(synced.detail.imported, ["Q2"]);
  const content = fs.readFileSync(qaLogPathFor(dir, "resumed"), "utf8");
  assert.match(content, /source_ref: codex:resume-codex:u1/);
  assert.match(content, /source_ref: claude:resume-claude:cu1/);
});

test("interview commands surface a resolved material assumption as consent drift", async () => {
  const dir = makeProject();
  const slug = "implicit-assumption";
  const transcriptPath = makeCodexTranscript(dir, "assumption-session");
  await runInterviewInit(dir, { slug, ...INIT, transcriptPath, sessionId: null });
  const decision = await runInterviewDecision(dir, {
    slug,
    id: "D-01",
    kind: "assumption",
    area: "data",
    text: "events are retained for the account lifetime",
    priority: "P1",
    source: "agent default",
    status: "resolved",
    mapping: "R1; revisit if retention changes",
  });
  assert.ok(decision.drift.some((finding) => finding.rule === "qa-resolved-material-assumption"));
});

const CADENCE_RULE = "interview-decision-cadence";

function cadenceDriftOf(result) {
  return result.drift.filter((finding) => finding.rule === CADENCE_RULE);
}

function decisionInput(slug, n, transcriptPath) {
  return {
    slug,
    transcriptPath,
    id: `D-${String(n).padStart(2, "0")}`,
    kind: "decision",
    area: "ux",
    text: `decision ${n}`,
    priority: "P1",
    source: "user",
    status: "resolved",
    mapping: "R1",
  };
}

test("a whole checkpoint batch of decision writes on one turn is never cadence drift", async () => {
  const dir = makeProject();
  const slug = "batched-cadence";
  const transcriptPath = makeCodexTranscript(dir, "batched-session");
  await runInterviewInit(dir, { slug, ...INIT, transcriptPath, sessionId: null });

  // The agent answers ten questions in the conversation, syncs once, then
  // upserts every imported row - all of it sitting on the same human turn.
  for (let i = 1; i <= 10; i += 1) appendCodexTurn(transcriptPath, i, `Q${i}?`, `answer ${i}`);
  await runInterviewSync(dir, { slug, transcriptPath, sessionId: null });

  let last;
  for (let i = 1; i <= 10; i += 1) {
    last = await runInterviewDecision(dir, decisionInput(slug, i, transcriptPath));
  }
  assert.deepEqual(cadenceDriftOf(last), []);
  assert.equal(last.detail.cadence.turnsSinceCheckpoint, 1);
});

test("a decision write on every answered turn becomes cadence drift, and a checkpoint clears it", async () => {
  const dir = makeProject();
  const slug = "per-turn-cadence";
  const transcriptPath = makeCodexTranscript(dir, "per-turn-session");
  await runInterviewInit(dir, { slug, ...INIT, transcriptPath, sessionId: null });

  const drifted = [];
  for (let i = 1; i <= 4; i += 1) {
    appendCodexTurn(transcriptPath, i, `Q${i}?`, `answer ${i}`);
    const decision = await runInterviewDecision(dir, decisionInput(slug, i, transcriptPath));
    drifted.push(cadenceDriftOf(decision).length > 0);
  }
  // Three turns is the widest cadence the skill sanctions; the fourth is drift.
  assert.deepEqual(drifted, [false, false, false, true]);

  await runInterviewSync(dir, { slug, transcriptPath, sessionId: null });
  await runInterviewCheckpoint(dir, {
    slug,
    normalized: ["pending"],
    registerChanges: "batched",
    reopened: "none",
    gap: "none",
  });

  appendCodexTurn(transcriptPath, 5, "Q5?", "answer 5");
  const afterCheckpoint = await runInterviewDecision(dir, decisionInput(slug, 5, transcriptPath));
  assert.deepEqual(cadenceDriftOf(afterCheckpoint), []);
  assert.equal(afterCheckpoint.detail.cadence.turnsSinceCheckpoint, 1);
});

test("cadence tracking never fails a decision write when the transcript is unavailable", async () => {
  const dir = makeProject();
  const slug = "untracked-cadence";
  const transcriptPath = makeCodexTranscript(dir, "untracked-session");
  await runInterviewInit(dir, { slug, ...INIT, transcriptPath, sessionId: null });

  const decision = await runInterviewDecision(dir, { ...decisionInput(slug, 1, undefined), sessionId: null });
  assert.equal(decision.ok, true);
  assert.equal(decision.detail.cadence.tracked, false);
  assert.deepEqual(cadenceDriftOf(decision), []);
});

test("corrupt cadence state is reported, never raised over a completed decision write", async () => {
  const dir = makeProject();
  const slug = "corrupt-cadence";
  const transcriptPath = makeCodexTranscript(dir, "corrupt-session");
  await runInterviewInit(dir, { slug, ...INIT, transcriptPath, sessionId: null });
  fs.writeFileSync(path.join(path.dirname(qaLogPathFor(dir, slug)), ".cadence.json"), "{ not json");

  const decision = await runInterviewDecision(dir, decisionInput(slug, 1, transcriptPath));
  assert.equal(decision.ok, true);
  assert.equal(decision.detail.cadence.tracked, false);
  assert.match(readQaLogState(fs.readFileSync(qaLogPathFor(dir, slug), "utf8")).registerRows[0].text, /decision 1/);
});

/** decision_ids line for one Q turn, read straight off disk. */
function decisionIdsOf(content, qNumber) {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^###\\s+Q${qNumber}:`).test(line));
  assert.notEqual(start, -1, `Q${qNumber} not found`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##+\s/.test(lines[i])) { end = i; break; }
  }
  for (let i = start + 1; i < end; i += 1) {
    const match = lines[i].match(/^-\s*decision_ids:\s*(.*)$/);
    if (match) return match[1].trim();
  }
  assert.fail(`Q${qNumber} has no decision_ids line`);
}

async function twoSyncedQuestions(dir, slug) {
  const transcriptPath = makeCodexTranscript(dir, `${slug}-session`);
  await runInterviewInit(dir, { slug, ...INIT, transcriptPath, sessionId: null });
  appendCodexTurn(transcriptPath, 1, "first question?", "first answer");
  appendCodexTurn(transcriptPath, 2, "second question?", "second answer");
  await runInterviewSync(dir, { slug, transcriptPath, sessionId: null });
  return transcriptPath;
}

test("AC1: a user-sourced resolved decision auto-anchors to the most recently synced Q", async () => {
  const dir = makeProject();
  const slug = "anchor-auto";
  await twoSyncedQuestions(dir, slug);
  await runInterviewDecision(dir, decisionInput(slug, 1, undefined));
  const content = fs.readFileSync(qaLogPathFor(dir, slug), "utf8");
  assert.equal(decisionIdsOf(content, 2), "D-01");
  assert.equal(decisionIdsOf(content, 1), "none");
  assert.deepEqual(runPrelint("qa-log", content).warnings ?? [], []);
});

test("AC2: --anchor Q<n> targets that turn instead of the latest, and leaves the other turn untouched", async () => {
  const dir = makeProject();
  const slug = "anchor-explicit";
  await twoSyncedQuestions(dir, slug);
  await runInterviewDecision(dir, { ...decisionInput(slug, 1, undefined), anchor: "Q1" });
  const content = fs.readFileSync(qaLogPathFor(dir, slug), "utf8");
  assert.equal(decisionIdsOf(content, 1), "D-01");
  assert.equal(decisionIdsOf(content, 2), "none");
});

test("AC3: --anchor none records the register row and anchors no Q turn", async () => {
  const dir = makeProject();
  const slug = "anchor-none";
  await twoSyncedQuestions(dir, slug);
  const decision = await runInterviewDecision(dir, { ...decisionInput(slug, 1, undefined), anchor: "none" });
  assert.equal(decision.detail.anchor.anchored, false);
  const content = fs.readFileSync(qaLogPathFor(dir, slug), "utf8");
  assert.equal(decisionIdsOf(content, 1), "none");
  assert.equal(decisionIdsOf(content, 2), "none");
  assert.match(readQaLogState(content).registerRows[0].id, /D-01/);
});

test("AC4: a decision that is not user-sourced (kind/status/source) never gets an anchor", async () => {
  const dir = makeProject();
  const slug = "anchor-not-user-sourced";
  await twoSyncedQuestions(dir, slug);
  await runInterviewDecision(dir, { ...decisionInput(slug, 1, undefined), kind: "fact", source: "user" });
  await runInterviewDecision(dir, { ...decisionInput(slug, 2, undefined), status: "deferred", source: "user" });
  await runInterviewDecision(dir, { ...decisionInput(slug, 3, undefined), source: "agent default" });
  const content = fs.readFileSync(qaLogPathFor(dir, slug), "utf8");
  assert.equal(decisionIdsOf(content, 1), "none");
  assert.equal(decisionIdsOf(content, 2), "none");
});

test("AC5: no synced Q turn yet writes the register row, warns, and still succeeds", async () => {
  const dir = makeProject();
  const slug = "anchor-no-synced-q";
  const transcriptPath = makeCodexTranscript(dir, "no-synced-q-session");
  await runInterviewInit(dir, { slug, ...INIT, transcriptPath, sessionId: null });
  const decision = await runInterviewDecision(dir, decisionInput(slug, 1, transcriptPath));
  assert.equal(decision.ok, true);
  assert.equal(decision.detail.anchor.anchored, false);
  assert.ok(decision.drift.some((finding) => finding.rule === "qa-unanchored-user-decision"));
  const content = fs.readFileSync(qaLogPathFor(dir, slug), "utf8");
  assert.match(readQaLogState(content).registerRows[0].text, /decision 1/);
});

test("AC6: --anchor Q<n> for a nonexistent turn rejects atomically and offers recovery paths", async () => {
  const dir = makeProject();
  const slug = "anchor-missing-target";
  await twoSyncedQuestions(dir, slug);
  const before = fs.readFileSync(qaLogPathFor(dir, slug), "utf8");
  await assert.rejects(
    () => runInterviewDecision(dir, { ...decisionInput(slug, 1, undefined), anchor: "Q9" }),
    /sync.*retry.*--anchor none/s,
  );
  const after = fs.readFileSync(qaLogPathFor(dir, slug), "utf8");
  assert.equal(after, before);
  assert.deepEqual(readQaLogState(after).registerRows, []);
});
