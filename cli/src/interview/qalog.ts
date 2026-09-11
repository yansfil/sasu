/**
 * Deterministic qa-log.md bookkeeping for the interview-me capture loop.
 *
 * Ownership split (latency contract): the agent owns question judgment and
 * semantic prose (normalization, UX cards, evidence, sweeps); this module owns
 * every mechanical mutation - transcript source bindings, frontmatter
 * counters, the Intake Cursor, Raw Q&A appends, Decision Register upserts,
 * checkpoint records, and needs_normalization flips. All mutations are
 * line-based string edits so ordinary interview turns need no file write.
 *
 * Enum values mirror the gap-audit prelint rules in ../gates/prelint.ts; a
 * value accepted here must never be rejected there.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const QA_WHERE = ["greenfield", "brownfield", "docs-only", "unknown"] as const;
export const QA_KINDS = ["fact", "decision", "assumption"] as const;
export const QA_PRIORITIES = ["P0", "P1", "P2"] as const;
export const QA_STATUSES = ["open", "resolved", "deferred", "blocking", "rejected"] as const;
export const QA_ROUTES = ["fact", "user-decision", "mixed", "research"] as const;

export interface RegisterRow {
  id: string;
  kind: string;
  area: string;
  text: string;
  priority: string;
  source: string;
  status: string;
  mapping: string;
}

export interface QaEntryInput {
  label: string;
  route: string;
  decisionIds: string[];
  sourceRef: string;
  asked: string;
  recommended: string;
  answer: string;
  notes: string;
}

export interface TranscriptSourceRow {
  runtime: "claude" | "codex";
  sessionId: string;
  startRef: string;
}

export interface CheckpointInput {
  normalized: string[];
  registerChanges: string;
  reopened: string;
  gap: string;
}

export interface QaLogState {
  questionCount: number;
  questionLimit: number | null;
  questionBudgetReached: boolean;
  questionBudgetExceeded: boolean;
  outstanding: string[];
  registerRows: RegisterRow[];
  nextDecisionId: string;
  checkpointEvery: number;
  lastCheckpointAfter: number;
  checkpointDue: boolean;
  nextCheckpointAt: string;
}

const REGISTER_HEADING = "## Decision Register";
const RAW_QA_HEADING = "## Raw Q&A";
const CURSOR_HEADING = "## Intake Cursor";
const TRANSCRIPT_SOURCES_HEADING = "## Transcript Sources";
const CHECKPOINT_HEADING = "## Checkpoint And Sweep History";

function temporarySibling(file: string): string {
  return path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
}

/**
 * Atomic compare-and-replace of a qa-log: the write lands only if the file
 * still holds the content the mutation was computed from, so two writers
 * (an interview command and a gate recording its Audit entry) can never
 * silently drop each other's edit.
 */
export function replaceQaLog(file: string, expected: string, content: string): void {
  if (content === expected) return;
  const temporary = temporarySibling(file);
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
    const current = fs.readFileSync(file, "utf8");
    if (current !== expected) {
      throw new Error(`qa-log changed outside this command while it was running: ${file} (retry from fresh state)`);
    }
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function todayStamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Table cells must stay single-line and pipe-free for the prelint parser. */
export function sanitizeCell(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").replace(/\|/g, "/").trim();
}

/** Keep multi-line raw answers inside one bullet by indenting continuations. */
function bulletValue(text: string): string {
  return text
    .split("\n")
    .map((line, index) => (index === 0 ? line : `  ${line.trimEnd()}`))
    .join("\n")
    .trimEnd();
}

function sectionRange(lines: string[], heading: string): { start: number; end: number } {
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) throw new Error(`qa-log is missing the "${heading}" section`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/** Insert lines at the end of a section, trimming trailing blank lines first. */
function appendToSection(lines: string[], heading: string, block: string[]): string[] {
  const { start, end } = sectionRange(lines, heading);
  let insertAt = end;
  while (insertAt > start + 1 && lines[insertAt - 1]!.trim() === "") insertAt -= 1;
  return [...lines.slice(0, insertAt), "", ...block, "", ...lines.slice(end)];
}

const ADDENDUM_HEADING = "## Addendum";

/**
 * Post-seal decision ledger (2026-08-30, freshness contract v4): once
 * gap-audit seals the log, a new or changed decision lands here as a
 * self-contained entry instead of touching sealed sections. The freshness
 * hash excludes this section by structure, so recording a late decision
 * never stales the sealed PASS, and the entry carries every Register field
 * inline because the sealed Register cannot be edited to match. The entry is
 * its own anchor: it exists only because `sasu interview decision` wrote it,
 * with the cadence record naming the conversation turn.
 */
export function appendAddendumEntry(content: string, row: RegisterRow, supersedesSealedRow: boolean): string {
  const suffix = supersedesSealedRow ? " [supersedes the sealed Register row]" : "";
  const entry = [
    `- ${row.id} (${row.kind}, ${row.area}, ${row.priority}, ${row.status}, ${todayStamp()})${suffix}: ${sanitizeCell(row.text)}`,
    `  - source: ${sanitizeCell(row.source)}`,
    ...(row.mapping.trim() !== "" ? [`  - mapping: ${sanitizeCell(row.mapping)}`] : []),
  ];
  const lines = content.split("\n");
  if (!lines.some((line) => line.trim() === ADDENDUM_HEADING)) {
    const trimmed = content.replace(/\n+$/, "");
    return `${trimmed}\n\n${ADDENDUM_HEADING}\n\n${entry.join("\n")}\n`;
  }
  return appendToSection(lines, ADDENDUM_HEADING, entry).join("\n");
}

function frontmatterEnd(lines: string[]): number {
  if (lines[0]?.trim() !== "---") throw new Error("qa-log has no frontmatter block");
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]!.trim() === "---") return i;
  }
  throw new Error("qa-log frontmatter block is not closed");
}

export function setFrontmatterValue(content: string, key: string, value: string, quoted: boolean): string {
  const lines = content.split("\n");
  const end = frontmatterEnd(lines);
  const rendered = quoted ? `${key}: "${value}"` : `${key}: ${value}`;
  for (let i = 1; i < end; i += 1) {
    if (new RegExp(`^${key}:`).test(lines[i]!)) {
      lines[i] = rendered;
      return lines.join("\n");
    }
  }
  lines.splice(end, 0, rendered);
  return lines.join("\n");
}

export function setCursorValue(content: string, key: string, value: string): string {
  const lines = content.split("\n");
  const { start, end } = sectionRange(lines, CURSOR_HEADING);
  for (let i = start + 1; i < end; i += 1) {
    if (new RegExp(`^\\s*-\\s*${key}:`).test(lines[i]!)) {
      lines[i] = `- ${key}: ${sanitizeCell(value)}`;
      return lines.join("\n");
    }
  }
  lines.splice(end, 0, `- ${key}: ${sanitizeCell(value)}`);
  return lines.join("\n");
}

function parseFrontmatterNumber(content: string, key: string, fallback: number): number {
  const match = content.match(new RegExp(`^${key}:\\s*"?(\\d+)"?\\s*$`, "m"));
  return match ? Number(match[1]) : fallback;
}

const registerLib = require("../../lib/qa_register.js") as {
  parseRegisterRows: (content: string) => RegisterRow[] | null;
};

/**
 * Register rows via the shared plain-JS reader (cli/lib/qa_register.js), the
 * same parser the gate freshness pin and the rerun lane digests use, so one
 * document can never mean two different sets of decisions.
 */
export function parseRegisterRows(content: string): RegisterRow[] {
  const rows = registerLib.parseRegisterRows(content);
  if (rows === null) throw new Error(`qa-log is missing the "${REGISTER_HEADING}" section`);
  return rows;
}

function renderRegisterRow(row: RegisterRow): string {
  const cells = [row.id, row.kind, row.area, row.text, row.priority, row.source, row.status, row.mapping];
  return `| ${cells.map(sanitizeCell).join(" | ")} |`;
}

export function upsertRegisterRow(
  content: string,
  patch: Partial<RegisterRow> & { id: string },
): { content: string; created: boolean; row: RegisterRow } {
  if (!/^D-\d+$/.test(patch.id)) throw new Error(`invalid decision id: ${patch.id} (use D-<number>)`);
  const existing = parseRegisterRows(content).find((row) => row.id === patch.id);
  if (existing) {
    const row: RegisterRow = { ...existing, ...stripUndefined(patch) };
    validateRegisterRow(row);
    const lines = content.split("\n");
    const { start, end } = sectionRange(lines, REGISTER_HEADING);
    for (let i = start + 1; i < end; i += 1) {
      const cells = lines[i]!.trim().replace(/^\|/, "").split("|").map((c) => c.trim());
      if (cells[0] === patch.id) {
        lines[i] = renderRegisterRow(row);
        return { content: lines.join("\n"), created: false, row };
      }
    }
    throw new Error(`register row ${patch.id} parsed but not found for rewrite`);
  }
  const required: (keyof RegisterRow)[] = ["kind", "area", "text", "priority", "source"];
  for (const field of required) {
    if (patch[field] === undefined || String(patch[field]).trim() === "") {
      throw new Error(`new register row ${patch.id} requires --${field === "text" ? "text" : field}`);
    }
  }
  const row: RegisterRow = {
    id: patch.id,
    kind: patch.kind!,
    area: patch.area!,
    text: patch.text!,
    priority: patch.priority!,
    source: patch.source!,
    status: patch.status ?? "open",
    mapping: patch.mapping ?? "",
  };
  validateRegisterRow(row);
  const lines = content.split("\n");
  const { start, end } = sectionRange(lines, REGISTER_HEADING);
  let insertAt = -1;
  for (let i = start + 1; i < end; i += 1) {
    if (lines[i]!.trim().startsWith("|")) insertAt = i + 1;
  }
  if (insertAt === -1) throw new Error("Decision Register has no table to append to");
  lines.splice(insertAt, 0, renderRegisterRow(row));
  return { content: lines.join("\n"), created: true, row };
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

function validateRegisterRow(row: RegisterRow): void {
  if (!(QA_KINDS as readonly string[]).includes(row.kind)) {
    throw new Error(`invalid --kind "${row.kind}" (allowed: ${QA_KINDS.join(" | ")})`);
  }
  if (!(QA_PRIORITIES as readonly string[]).includes(row.priority)) {
    throw new Error(`invalid --priority "${row.priority}" (allowed: ${QA_PRIORITIES.join(" | ")})`);
  }
  if (!(QA_STATUSES as readonly string[]).includes(row.status)) {
    throw new Error(`invalid --status "${row.status}" (allowed: ${QA_STATUSES.join(" | ")})`);
  }
}

export function questionNumbers(content: string): number[] {
  const numbers: number[] = [];
  for (const match of content.matchAll(/^###\s+Q(\d+):/gm)) {
    numbers.push(Number(match[1]));
  }
  return numbers;
}

export function appendQaEntry(content: string, entry: QaEntryInput): { content: string; qNumber: number } {
  if (!(QA_ROUTES as readonly string[]).includes(entry.route)) {
    throw new Error(`invalid --route "${entry.route}" (allowed: ${QA_ROUTES.join(" | ")})`);
  }
  for (const id of entry.decisionIds) {
    if (!/^D-\d+$/.test(id)) throw new Error(`invalid decision id in --decision-ids: ${id}`);
  }
  const registerIds = new Set(parseRegisterRows(content).map((row) => row.id));
  for (const id of entry.decisionIds) {
    if (!registerIds.has(id)) {
      throw new Error(`--decision-ids references ${id} which is not in the Decision Register (run interview decision first)`);
    }
  }
  if (entry.sourceRef.trim() === "" || /[\r\n]/.test(entry.sourceRef)) {
    throw new Error("sourceRef must be one non-empty line");
  }
  if (qaSourceRefs(content).has(entry.sourceRef)) {
    throw new Error(`sourceRef is already present in Raw Q&A: ${entry.sourceRef}`);
  }
  const qNumber = Math.max(0, ...questionNumbers(content)) + 1;
  const block = [
    `### Q${qNumber}: ${sanitizeCell(entry.label)}`,
    `- decision_ids: ${entry.decisionIds.length > 0 ? entry.decisionIds.join(", ") : "none"}`,
    `- route: ${entry.route}`,
    `- source_ref: ${sanitizeCell(entry.sourceRef)}`,
    `- asked: ${bulletValue(entry.asked)}`,
    `- recommended: ${bulletValue(entry.recommended || "none")}`,
    `- answer: ${bulletValue(entry.answer)}`,
    `- immediate_notes: ${bulletValue(entry.notes)}`,
    "- needs_normalization: true",
  ];
  const lines = appendToSection(content.split("\n"), RAW_QA_HEADING, block);
  return { content: lines.join("\n"), qNumber };
}

export function parseTranscriptSources(content: string): TranscriptSourceRow[] {
  const lines = content.split("\n");
  const { start, end } = sectionRange(lines, TRANSCRIPT_SOURCES_HEADING);
  const rows: TranscriptSourceRow[] = [];
  for (let i = start + 1; i < end; i += 1) {
    const line = lines[i]!;
    if (!line.trim().startsWith("|")) continue;
    const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-+:?$/.test(cell) || cell === "")) continue;
    if (cells[0] === "Runtime") continue;
    if (cells.length < 3) continue;
    const runtime = cells[0];
    if (runtime !== "claude" && runtime !== "codex") {
      throw new Error(`invalid transcript runtime in qa-log: ${runtime}`);
    }
    const sessionId = cells[1] ?? "";
    const startRef = cells[2] ?? "";
    if (sessionId === "" || startRef === "") throw new Error("transcript source row is incomplete");
    rows.push({ runtime, sessionId, startRef });
  }
  return rows;
}

export function appendTranscriptSource(
  content: string,
  source: TranscriptSourceRow,
): { content: string; created: boolean } {
  if (source.runtime !== "claude" && source.runtime !== "codex") {
    throw new Error(`invalid transcript runtime: ${source.runtime}`);
  }
  for (const value of [source.sessionId, source.startRef]) {
    if (value.trim() === "" || /[|\r\n]/.test(value)) throw new Error("transcript source fields must be one non-empty pipe-free line");
  }
  const existing = parseTranscriptSources(content).find(
    (row) => row.runtime === source.runtime && row.sessionId === source.sessionId,
  );
  if (existing !== undefined) {
    if (existing.startRef !== source.startRef) {
      throw new Error(`session ${source.sessionId} already has a different transcript start boundary`);
    }
    return { content, created: false };
  }
  const lines = content.split("\n");
  const { start, end } = sectionRange(lines, TRANSCRIPT_SOURCES_HEADING);
  let insertAt = -1;
  for (let i = start + 1; i < end; i += 1) {
    if (lines[i]!.trim().startsWith("|")) insertAt = i + 1;
  }
  if (insertAt === -1) throw new Error("Transcript Sources has no table to append to");
  lines.splice(insertAt, 0, `| ${source.runtime} | ${source.sessionId} | ${source.startRef} |`);
  return { content: lines.join("\n"), created: true };
}

export function qaSourceRefs(content: string): Set<string> {
  const refs = new Set<string>();
  for (const match of content.matchAll(/^- source_ref:\s*(.+?)\s*$/gm)) refs.add(match[1]!);
  return refs;
}

/** Bounds of the `### Q<n>:` block: from its heading to the next heading. */
export function questionBlockRange(lines: string[], qNumber: string): { start: number; end: number } | null {
  const startRe = new RegExp(`^###\\s+Q${qNumber}:`);
  const start = lines.findIndex((line) => startRe.test(line));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##+\s/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/**
 * Flip `needs_normalization` for the named turns. A turn that does not exist
 * is `missing`; a turn already marked is `alreadyNormalized`, and its state is
 * exactly what was asked for, so it is reported rather than refused - a
 * checkpoint repeated with an overlapping list converges instead of aborting
 * the whole call over the one entry that was already done (2026-09-10).
 */
export function markNormalized(content: string, qIds: string[]): { content: string; missing: string[]; alreadyNormalized: string[] } {
  const lines = content.split("\n");
  const missing: string[] = [];
  const alreadyNormalized: string[] = [];
  for (const qId of qIds) {
    const match = qId.match(/^Q(\d+)$/);
    if (!match) throw new Error(`invalid question id: ${qId} (use Q<number>)`);
    const range = questionBlockRange(lines, match[1]!);
    if (!range) {
      missing.push(qId);
      continue;
    }
    let flipped = false;
    for (let i = range.start + 1; i < range.end; i += 1) {
      if (lines[i] === "- needs_normalization: true") {
        lines[i] = "- needs_normalization: false";
        flipped = true;
        break;
      }
    }
    if (!flipped) alreadyNormalized.push(qId);
  }
  return { content: lines.join("\n"), missing, alreadyNormalized };
}

/**
 * Add a Decision Register ID to a Raw Q&A turn's `decision_ids` line - the
 * write half of the anchor (`sasu interview decision` owns this; see
 * cli/src/interview/commands.ts runInterviewDecision). Idempotent: re-adding
 * an already-cited D# is a no-op.
 */
/**
 * The other half of moving an anchor: drop a Decision Register ID from every
 * Raw Q&A turn that cites it, restoring `none` where it was the only one.
 * `sasu interview decision --anchor` used to add only, so a decision anchored
 * to the wrong turn kept both citations and the operator hand-edited
 * `decision_ids` to fix it, which the interview skill forbids (2026-09-10).
 * Returns the turns the ID was removed from, so the caller can say where the
 * anchor moved from.
 */
export function unanchorDecision(content: string, decisionId: string): { content: string; from: number[] } {
  const lines = content.split("\n");
  const from: number[] = [];
  for (const qNumber of questionNumbers(content)) {
    const range = questionBlockRange(lines, String(qNumber));
    if (!range) continue;
    for (let i = range.start + 1; i < range.end; i += 1) {
      const match = lines[i]!.match(/^-\s*decision_ids:\s*(.*)$/);
      if (!match) continue;
      const existing = match[1]!.split(",").map((token) => token.trim()).filter((token) => token !== "" && token !== "none");
      if (!existing.includes(decisionId)) break;
      const remaining = existing.filter((token) => token !== decisionId);
      lines[i] = `- decision_ids: ${remaining.length === 0 ? "none" : remaining.join(", ")}`;
      from.push(qNumber);
      break;
    }
  }
  return { content: lines.join("\n"), from };
}

export function anchorDecisionToQuestion(content: string, qNumber: number, decisionId: string): string {
  const lines = content.split("\n");
  const range = questionBlockRange(lines, String(qNumber));
  if (!range) throw new Error(`Raw Q&A has no Q${qNumber} entry to anchor`);
  for (let i = range.start + 1; i < range.end; i += 1) {
    const match = lines[i]!.match(/^-\s*decision_ids:\s*(.*)$/);
    if (match) {
      const existing = match[1]!.split(",").map((token) => token.trim()).filter((token) => token !== "" && token !== "none");
      if (!existing.includes(decisionId)) existing.push(decisionId);
      lines[i] = `- decision_ids: ${existing.join(", ")}`;
      return lines.join("\n");
    }
  }
  throw new Error(`Q${qNumber} entry has no decision_ids line`);
}

const AUDIT_HEADING = "## Audit History";

export interface AuditEntryInput {
  type: "gap-audit-gate" | "spec-gate";
  result: "pass" | "block" | "needs-human" | "error" | "answered" | "reopened";
  at: string;
  cycle: number;
  /** Open findings after the round, rendered one per line. */
  open: { id?: string; severity: string; area: string; missing: string }[];
  warnings: { id?: string; severity: string; area: string; missing: string }[];
  artifact: string | null;
  note?: string;
}

function renderFindingLines(findings: AuditEntryInput["open"]): string[] {
  if (findings.length === 0) return ["none"];
  return findings.map((f) => `${f.id !== undefined ? `${f.id} ` : ""}[${f.severity}/${f.area}] ${sanitizeCell(f.missing)}`);
}

/**
 * The gate's own record of a round in the log it judged (PRD gate-loop
 * D-06/R5): written by the harness at every judged, errored, answered, or
 * reopened round, never by the agent (hide-rebrand 2026-08-29: the agent
 * hand-wrote the block three times with python and left "placeholder
 * written - will update result after gate run"). The section is outside the
 * freshness pin, so recording never stales the seal. A log without the
 * section gets one appended at the end; the gap-audit prelint requires it,
 * so this only happens on a log the gate never saw.
 */
export function appendAuditEntry(content: string, entry: AuditEntryInput): { content: string; number: number } {
  const numbers = [0];
  for (const match of content.matchAll(/^###\s+Audit\s+(\d+)$/gm)) numbers.push(Number(match[1]));
  const number = Math.max(...numbers) + 1;
  const block = [
    `### Audit ${number}`,
    `- type: ${entry.type}`,
    `- at: ${entry.at}`,
    `- cycle: ${entry.cycle}`,
    `- result: ${entry.result}`,
    `- open findings: ${renderFindingLines(entry.open).join("\n  ")}`,
    `- warnings: ${renderFindingLines(entry.warnings).join("\n  ")}`,
    `- artifact: ${entry.artifact ?? "none"}`,
    ...(entry.note !== undefined && entry.note.trim() !== "" ? [`- note: ${bulletValue(entry.note)}`] : []),
  ];
  const lines = content.split("\n");
  if (!lines.some((line) => line.trim() === AUDIT_HEADING)) {
    const trimmed = content.replace(/\n+$/, "");
    return { content: `${trimmed}\n\n${AUDIT_HEADING}\n\n${block.join("\n")}\n`, number };
  }
  return { content: appendToSection(lines, AUDIT_HEADING, block).join("\n"), number };
}

/** Lifecycle status is harness-owned (PRD gate-loop D-06): gap-audit PASS completes a log, reopen reactivates it. */
export function setQaLogStatus(content: string, status: "active" | "paused" | "complete"): string {
  return setFrontmatterValue(content, "status", status, true);
}

export function appendCheckpoint(content: string, input: CheckpointInput, afterQuestion: number): { content: string; number: number } {
  const numbers = [0];
  for (const match of content.matchAll(/^###\s+Checkpoint\s+(\d+)$/gm)) numbers.push(Number(match[1]));
  const number = Math.max(...numbers) + 1;
  const block = [
    `### Checkpoint ${number}`,
    `- after_question: Q${afterQuestion}`,
    `- normalized_entries: ${input.normalized.length > 0 ? input.normalized.join(", ") : "none"}`,
    `- register_changes: ${sanitizeCell(input.registerChanges) || "none"}`,
    `- reopened_decisions: ${sanitizeCell(input.reopened) || "none"}`,
    `- highest_remaining_gap: ${sanitizeCell(input.gap) || "none"}`,
  ];
  const lines = appendToSection(content.split("\n"), CHECKPOINT_HEADING, block);
  return { content: lines.join("\n"), number };
}

export function readQaLogState(content: string): QaLogState {
  const questionCount = Math.max(0, ...questionNumbers(content));
  const parsedQuestionLimit = parseFrontmatterNumber(content, "question_limit", 0);
  const questionLimit = parsedQuestionLimit > 0 ? parsedQuestionLimit : null;
  const outstanding: string[] = [];
  const lines = content.split("\n");
  let currentQ: string | null = null;
  for (const line of lines) {
    const heading = line.match(/^###\s+Q(\d+):/);
    if (heading) {
      currentQ = `Q${heading[1]}`;
      continue;
    }
    if (/^##+\s/.test(line)) currentQ = null;
    if (currentQ !== null && line === "- needs_normalization: true") {
      outstanding.push(currentQ);
      currentQ = null;
    }
  }
  const registerRows = parseRegisterRows(content);
  const maxId = Math.max(0, ...registerRows.map((row) => Number(row.id.slice(2))));
  const checkpointEvery = parseFrontmatterNumber(content, "normalization_checkpoint_every", 10);
  const afters = [0];
  for (const match of content.matchAll(/^- after_question: Q(\d+)$/gm)) afters.push(Number(match[1]));
  const lastCheckpointAfter = Math.max(...afters);
  const cadenceCheckpointAt = lastCheckpointAfter + checkpointEvery;
  const budgetCheckpointAt = questionLimit !== null && questionLimit > lastCheckpointAfter
    ? questionLimit
    : cadenceCheckpointAt;
  const nextCheckpointQuestion = Math.min(cadenceCheckpointAt, budgetCheckpointAt);
  const questionBudgetReached = questionLimit !== null && questionCount >= questionLimit;
  const questionBudgetExceeded = questionLimit !== null && questionCount > questionLimit;
  return {
    questionCount,
    questionLimit,
    questionBudgetReached,
    questionBudgetExceeded,
    outstanding,
    registerRows,
    nextDecisionId: `D-${String(maxId + 1).padStart(2, "0")}`,
    checkpointEvery,
    lastCheckpointAfter,
    checkpointDue:
      questionCount - lastCheckpointAfter >= checkpointEvery
      || (questionLimit !== null && questionCount >= questionLimit && lastCheckpointAfter < questionLimit),
    nextCheckpointAt: `Q${nextCheckpointQuestion}`,
  };
}

/**
 * Recompute every derived bookkeeping field after a mutation so command
 * implementations never hand-maintain counters.
 */
export function refreshBookkeeping(content: string, options: { nextQuestion?: string } = {}): string {
  const state = readQaLogState(content);
  let updated = content;
  updated = setFrontmatterValue(updated, "question_count", String(state.questionCount), false);
  updated = setFrontmatterValue(updated, "updated_at", todayStamp(), true);
  // The Intake Cursor is the live interview's convenience block, not a gate
  // requirement (the gap-audit prelint lists the required sections and it is
  // not one). A gate command that appends a turn to a log written without it
  // - the older template, a hand-assembled fixture - keeps the frontmatter
  // counts honest and leaves the absent cursor absent.
  if (!content.split("\n").some((line) => line.trim() === CURSOR_HEADING)) return updated;
  updated = setCursorValue(updated, "next_decision_id", state.nextDecisionId);
  updated = setCursorValue(updated, "outstanding_raw_entries", state.outstanding.length > 0 ? state.outstanding.join(", ") : "none");
  updated = setCursorValue(updated, "next_checkpoint_at", state.nextCheckpointAt);
  if (options.nextQuestion !== undefined) {
    updated = setCursorValue(updated, "next_question", options.nextQuestion);
  }
  return updated;
}

export interface InitOptions {
  topic: string;
  where: string;
  packs: string;
  understanding: string[];
  source: TranscriptSourceRow;
  questionLimit?: number;
}

export function renderInitialQaLog(options: InitOptions): string {
  if (!(QA_WHERE as readonly string[]).includes(options.where)) {
    throw new Error(`invalid --where "${options.where}" (allowed: ${QA_WHERE.join(" | ")})`);
  }
  if (options.questionLimit !== undefined && (!Number.isInteger(options.questionLimit) || options.questionLimit < 1)) {
    throw new Error("--question-limit must be a positive integer");
  }
  const stamp = todayStamp();
  const understanding =
    options.understanding.length > 0
      ? options.understanding.map((line) => (line.trim().startsWith("-") ? line.trim() : `- ${line.trim()}`))
      : ["- (pending first mirror)"];
  return [
    "---",
    `topic: "${options.topic.replace(/"/g, "'")}"`,
    'status: "active"',
    `where: "${options.where}"`,
    `selected_packs: "${options.packs}"`,
    `created_at: "${stamp}"`,
    `updated_at: "${stamp}"`,
    "question_count: 0",
    ...(options.questionLimit === undefined ? [] : [`question_limit: ${options.questionLimit}`]),
    'normalization_policy: "transcript-sync-with-checkpoint-backfill"',
    "normalization_checkpoint_every: 10",
    "---",
    "",
    `# Interview Log: ${options.topic}`,
    "",
    "## Current Understanding",
    "",
    ...understanding,
    "",
    CURSOR_HEADING,
    "",
    "- next_decision_id: D-01",
    "- next_question: (owned by the live conversation until checkpoint)",
    "- last_materiality_sweep: preflight",
    "- outstanding_raw_entries: none",
    `- next_checkpoint_at: Q${Math.min(10, options.questionLimit ?? 10)}`,
    "",
    TRANSCRIPT_SOURCES_HEADING,
    "",
    "| Runtime | Session ID | Start ref |",
    "| --- | --- | --- |",
    `| ${options.source.runtime} | ${options.source.sessionId} | ${options.source.startRef} |`,
    "",
    REGISTER_HEADING,
    "",
    "| ID | Kind | Area | Decision / fact | Priority | Source / owner | Status | PRD mapping / revisit |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    "",
    RAW_QA_HEADING,
    "",
    "## UX Scenario Cards",
    "",
    "## Evidence From Code, Docs, Or Research",
    "",
    "## Documented Domain Checks",
    "",
    "- docs inspected:",
    "- canonical terms:",
    "- glossary or code conflicts:",
    "- concrete scenarios tested:",
    "- docs mutation:",
    "- ADR candidate:",
    "",
    CHECKPOINT_HEADING,
    "",
    "## Audit History",
    "",
  ].join("\n");
}
