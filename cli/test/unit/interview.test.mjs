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
  runInterviewLog,
} from "../../dist/interview/commands.js";
import { runPrelint } from "../../dist/gates/prelint.js";

const INIT = {
  topic: "widget",
  where: "greenfield",
  packs: "ux, verification",
  understanding: ["renders a list", "- persists state"],
};

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-interview-"));
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  return dir;
}

const ENTRY = {
  label: "rendering",
  route: "user-decision",
  decisionIds: [],
  asked: "render a list?",
  recommended: "",
  answer: "yes",
  notes: "",
};

test("renderInitialQaLog produces a prelint-clean document", () => {
  const content = renderInitialQaLog(INIT);
  const prelint = runPrelint("qa-log", content);
  assert.deepEqual(prelint.findings, []);
  assert.match(content, /- renders a list\n- persists state/);
  assert.throws(() => renderInitialQaLog({ ...INIT, where: "space" }), /invalid --where/);
});

test("appendQaEntry numbers questions and requires registered decision ids", () => {
  let content = renderInitialQaLog(INIT);
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
  const second = appendQaEntry(first.content, { ...ENTRY, label: "persistence", answer: "line one\nline two" });
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
  let content = renderInitialQaLog(INIT);
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
  // Closure-clean only once the citing Q&A turn lands: a resolved user
  // decision with no Raw Q&A anchor is exactly what qa-unanchored-user-decision
  // exists to block at gap-audit time.
  assert.deepEqual(
    runPrelint("qa-log", patched.content).findings.map((f) => f.rule),
    ["qa-unanchored-user-decision"],
  );
  const closed = appendQaEntry(patched.content, { ...ENTRY, decisionIds: ["D-01"] }).content;
  assert.deepEqual(runPrelint("qa-log", closed).findings, []);
});

test("markNormalized flips only the addressed block", () => {
  let content = renderInitialQaLog(INIT);
  content = appendQaEntry(content, ENTRY).content;
  content = appendQaEntry(content, { ...ENTRY, label: "second" }).content;
  const marked = markNormalized(content, ["Q1"]);
  assert.deepEqual(marked.missing, []);
  const state = readQaLogState(marked.content);
  assert.deepEqual(state.outstanding, ["Q2"]);
  assert.deepEqual(markNormalized(marked.content, ["Q1"]).missing, ["Q1"]);
  assert.deepEqual(markNormalized(marked.content, ["Q9"]).missing, ["Q9"]);
});

test("readQaLogState tracks checkpoint cadence", () => {
  let content = renderInitialQaLog(INIT);
  for (let i = 0; i < 10; i += 1) content = appendQaEntry(content, { ...ENTRY, label: `q${i}` }).content;
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
  let content = renderInitialQaLog(INIT);
  content = appendQaEntry(content, ENTRY).content;
  const updated = refreshBookkeeping(content, { nextQuestion: "ask about persistence" });
  assert.match(updated, /^question_count: 1$/m);
  assert.match(updated, /- outstanding_raw_entries: Q1/);
  assert.match(updated, /- next_question: ask about persistence/);
});

test("sanitizeCell strips pipes and newlines", () => {
  assert.equal(sanitizeCell("a | b\nc"), "a / b c");
});

test("interview commands round-trip on disk and stay prelint-clean", () => {
  const dir = makeProject();
  const slug = "widget-feature";
  const init = runInterviewInit(dir, { slug, ...INIT });
  assert.equal(init.ok, true);
  assert.throws(() => runInterviewInit(dir, { slug, ...INIT }), /already exists/);
  assert.throws(() => runInterviewLog(dir, { slug: "missing-topic", ...ENTRY }), /run interview init first/);

  runInterviewDecision(dir, {
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
  const logged = runInterviewLog(dir, { slug, ...ENTRY, decisionIds: ["D-01"], nextQuestion: "persistence next" });
  assert.equal(logged.detail.logged, "Q1");
  assert.deepEqual(logged.cursor.outstandingNormalization, ["Q1"]);
  assert.equal(logged.cursor.nextDecisionId, "D-02");
  assert.deepEqual(logged.drift, []);

  const checkpoint = runInterviewCheckpoint(dir, {
    slug,
    normalized: ["Q1"],
    registerChanges: "D-01 resolved",
    reopened: "",
    gap: "",
  });
  assert.equal(checkpoint.detail.checkpoint, 1);
  assert.deepEqual(checkpoint.cursor.outstandingNormalization, []);

  const status = readInterviewStatus(dir, slug);
  assert.equal(status.cursor.questionCount, 1);
  assert.deepEqual(status.detail.openMaterial, []);
  assert.deepEqual(status.drift, []);

  const content = fs.readFileSync(qaLogPathFor(dir, slug), "utf8");
  assert.deepEqual(runPrelint("qa-log", content).findings, []);
});

test("status surfaces open material nodes but not closure-only prelint rules", () => {
  const dir = makeProject();
  const slug = "open-nodes";
  runInterviewInit(dir, { slug, ...INIT });
  runInterviewDecision(dir, {
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

test("interview commands surface a resolved material assumption as consent drift", () => {
  const dir = makeProject();
  const slug = "implicit-assumption";
  runInterviewInit(dir, { slug, ...INIT });
  const decision = runInterviewDecision(dir, {
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
