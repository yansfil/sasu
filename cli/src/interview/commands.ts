import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runPrelint, type PrelintFinding } from "../gates/prelint";
import { cadenceDrift, clearCadence, recordDecisionTurn } from "./cadence";
import {
  appendCheckpoint,
  appendQaEntry,
  appendTranscriptSource,
  markNormalized,
  parseTranscriptSources,
  qaSourceRefs,
  readQaLogState,
  refreshBookkeeping,
  renderInitialQaLog,
  setCursorValue,
  upsertRegisterRow,
  type QaEntryInput,
  type QaLogState,
  type RegisterRow,
} from "./qalog";
import {
  extractTranscriptTurns,
  latestHumanRef,
  locateTranscript,
  resolveCurrentTranscript,
  type TranscriptIdentity,
} from "./transcript";

/**
 * Intake commands: the CLI side of the interview-me latency contract.
 * The agent decides WHAT to ask and how to normalize it; these commands own
 * HOW the qa-log is mutated. Ordinary interview turns stay entirely in the
 * conversation, then `sync` imports their raw evidence in one batch.
 */

export interface InterviewCursorView {
  questionCount: number;
  questionLimit: number | null;
  questionBudgetReached: boolean;
  questionBudgetExceeded: boolean;
  outstandingNormalization: string[];
  nextDecisionId: string;
  nextCheckpointAt: string;
  checkpointDue: boolean;
}

export interface InterviewResult {
  ok: boolean;
  action: "init" | "sync" | "decision" | "checkpoint" | "status";
  slug: string;
  qaLog: string;
  cursor: InterviewCursorView;
  /**
   * Drift for the agent to fix now: structural defects from the gap-audit
   * prelint (closure-only rules excluded), plus the decision-write cadence
   * finding when D# upserts stop being batched at a checkpoint.
   */
  drift: PrelintFinding[];
  detail: Record<string, unknown>;
}

function assertSlug(slug: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error(`invalid topic slug: ${slug} (use kebab-case)`);
  }
}

/** Canonical qa-log path for a topic (the directory `interview init` writes to). */
export function qaLogPathFor(projectRoot: string, slug: string): string {
  return path.join(projectRoot, "agents", "interview", slug, "qa-log.md");
}

/** Legacy path from before the intake -> interview rename; read-only fallback. */
function legacyQaLogPathFor(projectRoot: string, slug: string): string {
  return path.join(projectRoot, "agents", "intake", slug, "qa-log.md");
}

/**
 * Resolve the qa-log to operate on: the canonical path, or the legacy
 * `agents/intake/` path when an interview started before the rename. Writes go
 * back to whichever file was resolved, so an in-flight legacy interview keeps
 * working in place without a migration step.
 */
export function resolveQaLogPath(projectRoot: string, slug: string): string {
  const current = qaLogPathFor(projectRoot, slug);
  if (fs.existsSync(current)) return current;
  const legacy = legacyQaLogPathFor(projectRoot, slug);
  if (fs.existsSync(legacy)) return legacy;
  return current;
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : null;
}

function temporarySibling(file: string): string {
  return path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
}

function writeNewQaLog(file: string, content: string): void {
  const temporary = temporarySibling(file);
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
    try {
      fs.linkSync(temporary, file);
    } catch (error) {
      if (errorCode(error) === "EEXIST") throw new Error(`qa-log already exists: ${file}`);
      throw error;
    }
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function replaceQaLog(file: string, expected: string, content: string): void {
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

function readQaLog(projectRoot: string, slug: string): { file: string; content: string } {
  const file = resolveQaLogPath(projectRoot, slug);
  if (!fs.existsSync(file)) {
    throw new Error(`qa-log not found: ${path.relative(projectRoot, file)} (run interview init first)`);
  }
  return { file, content: fs.readFileSync(file, "utf8") };
}

/**
 * Mid-interview drift check. The `qa-register-open` rule is a closure gate
 * (open P0/P1 nodes are the normal state of an active interview), so it is
 * excluded here; everything else failing means the document structure broke.
 * The citation advisories (qa-dangling-q-reference, qa-unanchored-user-
 * decision) live in `warnings`, which drift never reads, so the
 * decision-before-log ordering inside a turn cannot produce drift noise.
 */
function driftFindings(content: string): PrelintFinding[] {
  return runPrelint("qa-log", content).findings.filter((finding) => finding.rule !== "qa-register-open");
}

function result(
  action: InterviewResult["action"],
  projectRoot: string,
  slug: string,
  content: string,
  detail: Record<string, unknown>,
  extraDrift: PrelintFinding[] = [],
): InterviewResult {
  const state: QaLogState = readQaLogState(content);
  const drift = [...driftFindings(content), ...extraDrift];
  return {
    ok: true,
    action,
    slug,
    qaLog: path.relative(projectRoot, resolveQaLogPath(projectRoot, slug)),
    cursor: {
      questionCount: state.questionCount,
      questionLimit: state.questionLimit,
      questionBudgetReached: state.questionBudgetReached,
      questionBudgetExceeded: state.questionBudgetExceeded,
      outstandingNormalization: state.outstanding,
      nextDecisionId: state.nextDecisionId,
      nextCheckpointAt: state.nextCheckpointAt,
      checkpointDue: state.checkpointDue,
    },
    drift,
    detail,
  };
}

export interface InterviewInitOptions {
  slug: string;
  topic: string;
  where: string;
  packs: string;
  understanding: string[];
  questionLimit?: number;
  transcriptPath?: string;
  /** Test/embedding seam for locating bound and automatically discovered transcripts. */
  homeDir?: string;
  /** Test/embedding seam for automatic discovery; null opts out of discovery. */
  sessionId?: string | null;
}

export async function runInterviewInit(projectRoot: string, options: InterviewInitOptions): Promise<InterviewResult> {
  assertSlug(options.slug);
  const file = qaLogPathFor(projectRoot, options.slug);
  const existing = resolveQaLogPath(projectRoot, options.slug);
  if (fs.existsSync(existing)) {
    throw new Error(`qa-log already exists: ${path.relative(projectRoot, existing)} (resume it instead of re-initializing)`);
  }
  const transcript = await resolveCurrentTranscript({
    transcriptPath: options.transcriptPath,
    homeDir: options.homeDir,
    sessionId: options.sessionId,
  });
  if (transcript === null) {
    throw new Error("current agent session is unavailable; pass --transcript <session.jsonl>");
  }
  const startRef = await latestHumanRef(transcript);
  const content = renderInitialQaLog({
    topic: options.topic,
    where: options.where,
    packs: options.packs,
    understanding: options.understanding,
    source: { runtime: transcript.runtime, sessionId: transcript.sessionId, startRef },
    questionLimit: options.questionLimit,
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const concurrentExisting = resolveQaLogPath(projectRoot, options.slug);
  if (fs.existsSync(concurrentExisting)) {
    throw new Error(`qa-log already exists: ${path.relative(projectRoot, concurrentExisting)} (resume it instead of re-initializing)`);
  }
  writeNewQaLog(file, content);
  clearCadence(file);
  return result("init", projectRoot, options.slug, content, {
    created: true,
    questionLimit: options.questionLimit ?? null,
    transcript: { runtime: transcript.runtime, sessionId: transcript.sessionId, startRef },
  });
}

export interface InterviewSyncOptions {
  slug: string;
  transcriptPath?: string;
  /** Test/embedding seam for locating bound and automatically discovered transcripts. */
  homeDir?: string;
  /** Test/embedding seam for automatic discovery; null opts out of discovery. */
  sessionId?: string | null;
}

function transcriptLabel(asked: string): string {
  const first = asked
    .split("\n")
    .map((line) => line.trim().replace(/^#+\s*/, ""))
    .find((line) => line !== "") ?? "Transcript turn";
  return Array.from(first).slice(0, 72).join("");
}

export async function runInterviewSync(projectRoot: string, options: InterviewSyncOptions): Promise<InterviewResult> {
  assertSlug(options.slug);
  const file = resolveQaLogPath(projectRoot, options.slug);
  if (!fs.existsSync(file)) {
    throw new Error(`qa-log not found: ${path.relative(projectRoot, file)} (run interview init first)`);
  }
  const original = fs.readFileSync(file, "utf8");
  const sealed = /^status:\s*"complete"\s*$/m.test(original);
  let content = original;
  const current = await resolveCurrentTranscript({
    transcriptPath: options.transcriptPath,
    homeDir: options.homeDir,
    sessionId: options.sessionId,
  });
  let sources = parseTranscriptSources(content);
  let bound: { runtime: string; sessionId: string; startRef: string } | null = null;

  if (current !== null && !sealed) {
    const existing = sources.find(
      (source) => source.runtime === current.runtime && source.sessionId === current.sessionId,
    );
    if (existing === undefined) {
      const startRef = await latestHumanRef(current);
      const appended = appendTranscriptSource(content, {
        runtime: current.runtime,
        sessionId: current.sessionId,
        startRef,
      });
      content = appended.content;
      bound = { runtime: current.runtime, sessionId: current.sessionId, startRef };
      sources = parseTranscriptSources(content);
    }
  }

  const identities = new Map<string, TranscriptIdentity>();
  if (current !== null) identities.set(`${current.runtime}:${current.sessionId}`, current);
  const extracted: Awaited<ReturnType<typeof extractTranscriptTurns>> = [];
  for (const source of sources) {
    const key = `${source.runtime}:${source.sessionId}`;
    const identity = identities.get(key) ?? await locateTranscript(source.runtime, source.sessionId, options.homeDir);
    identities.set(key, identity);
    extracted.push(...await extractTranscriptTurns(identity, source.startRef));
  }

  const seen = qaSourceRefs(content);
  const unseen: typeof extracted = [];
  for (const turn of extracted) {
    if (seen.has(turn.sourceRef)) continue;
    seen.add(turn.sourceRef);
    unseen.push(turn);
  }
  if (sealed && unseen.length > 0) {
    throw new Error(
      `qa-log is complete and sealed; ${unseen.length} later conversation turn(s) require an explicit reopen before sync`,
    );
  }

  const imported: string[] = [];
  for (const turn of unseen) {
    const entry: QaEntryInput = {
      label: transcriptLabel(turn.asked),
      route: "mixed",
      decisionIds: [],
      sourceRef: turn.sourceRef,
      asked: turn.asked,
      recommended: "",
      answer: turn.answer,
      notes: "Imported verbatim from the session transcript; semantic normalization is pending.",
    };
    const appended = appendQaEntry(content, entry);
    content = appended.content;
    imported.push(`Q${appended.qNumber}`);
  }

  if (content !== original) {
    content = refreshBookkeeping(content);
    replaceQaLog(file, original, content);
  }
  return result("sync", projectRoot, options.slug, content, {
    imported,
    alreadyImported: extracted.length - unseen.length,
    bound,
    sealed,
    sources: sources.map((source) => ({ runtime: source.runtime, sessionId: source.sessionId })),
  });
}

export interface InterviewDecisionOptions extends Partial<RegisterRow> {
  slug: string;
  id: string;
  transcriptPath?: string;
  /** Test/embedding seam for locating bound and automatically discovered transcripts. */
  homeDir?: string;
  /** Test/embedding seam for automatic discovery; null opts out of discovery. */
  sessionId?: string | null;
}

interface CadenceOutcome {
  cadence: Record<string, unknown>;
  drift: PrelintFinding[];
}

/**
 * Record this decision write against the conversation turn it happened on and
 * judge the cadence.
 *
 * Cadence is advisory bookkeeping about a qa-log write that has already
 * succeeded, so nothing in here may fail the command: an unresolvable
 * transcript or unreadable cadence state is reported as untracked in `detail`
 * (where the caller and --json both see it) rather than raised over a
 * completed mutation.
 */
async function trackDecisionCadence(
  qaLogFile: string,
  options: InterviewDecisionOptions,
): Promise<CadenceOutcome> {
  let turnRef: string;
  try {
    const transcript = await resolveCurrentTranscript({
      transcriptPath: options.transcriptPath,
      homeDir: options.homeDir,
      sessionId: options.sessionId,
    });
    if (transcript === null) {
      return { cadence: { tracked: false, reason: "current agent session is unavailable" }, drift: [] };
    }
    turnRef = await latestHumanRef(transcript);
  } catch (error) {
    return { cadence: { tracked: false, reason: messageOf(error) }, drift: [] };
  }
  try {
    const turns = recordDecisionTurn(qaLogFile, turnRef);
    const finding = cadenceDrift(turns);
    return {
      cadence: { tracked: true, turnsSinceCheckpoint: turns.length },
      drift: finding === null ? [] : [finding],
    };
  } catch (error) {
    return { cadence: { tracked: false, reason: messageOf(error) }, drift: [] };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runInterviewDecision(
  projectRoot: string,
  options: InterviewDecisionOptions,
): Promise<InterviewResult> {
  assertSlug(options.slug);
  const { file } = readQaLog(projectRoot, options.slug);
  const content = fs.readFileSync(file, "utf8");
  const { slug: _slug, transcriptPath: _transcriptPath, homeDir: _homeDir, sessionId: _sessionId, ...patch } = options;
  const upserted = upsertRegisterRow(content, patch);
  const updated = refreshBookkeeping(upserted.content);
  replaceQaLog(file, content, updated);
  const { cadence, drift } = await trackDecisionCadence(file, options);
  return result("decision", projectRoot, options.slug, updated, {
    id: upserted.row.id,
    created: upserted.created,
    row: upserted.row,
    cadence,
  }, drift);
}

export interface InterviewCheckpointOptions {
  slug: string;
  normalized: string[];
  registerChanges: string;
  reopened: string;
  gap: string;
}

export function runInterviewCheckpoint(projectRoot: string, options: InterviewCheckpointOptions): InterviewResult {
  assertSlug(options.slug);
  const { file } = readQaLog(projectRoot, options.slug);
  const content = fs.readFileSync(file, "utf8");
  if (options.normalized.includes("pending") && options.normalized.length !== 1) {
    throw new Error('--normalized pending cannot be combined with explicit Q numbers');
  }
  const outstanding = readQaLogState(content).outstanding;
  const normalized = options.normalized.length === 1 && options.normalized[0] === "pending"
    ? outstanding
    : options.normalized;
  const marked = markNormalized(content, normalized);
  if (marked.missing.length > 0) {
    throw new Error(
      `cannot mark normalized: ${marked.missing.join(", ")} (entry missing or already normalized)`,
    );
  }
  const state = readQaLogState(marked.content);
  const checkpointed = appendCheckpoint(marked.content, { ...options, normalized }, state.questionCount);
  let updated = setCursorValue(checkpointed.content, "last_materiality_sweep", `checkpoint ${checkpointed.number}`);
  updated = refreshBookkeeping(updated);
  replaceQaLog(file, content, updated);
  clearCadence(file);
  return result("checkpoint", projectRoot, options.slug, updated, {
    checkpoint: checkpointed.number,
    normalized,
  });
}

export function readInterviewStatus(projectRoot: string, slug: string): InterviewResult {
  assertSlug(slug);
  const { content } = readQaLog(projectRoot, slug);
  const state = readQaLogState(content);
  const openMaterial = state.registerRows.filter(
    (row) => (row.status === "open" || row.status === "blocking") && (row.priority === "P0" || row.priority === "P1"),
  );
  return result("status", projectRoot, slug, content, {
    registerCount: state.registerRows.length,
    openMaterial: openMaterial.map((row) => ({ id: row.id, area: row.area, priority: row.priority, status: row.status })),
  });
}
