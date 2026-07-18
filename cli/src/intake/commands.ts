import fs from "node:fs";
import path from "node:path";
import { runPrelint, type PrelintFinding } from "../gates/prelint";
import {
  appendCheckpoint,
  appendQaEntry,
  markNormalized,
  readQaLogState,
  refreshBookkeeping,
  renderInitialQaLog,
  setCursorValue,
  upsertRegisterRow,
  type QaEntryInput,
  type QaLogState,
  type RegisterRow,
} from "./qalog";

/**
 * Intake commands: the CLI side of the interview-me latency contract.
 * The agent decides WHAT to ask and record; these commands own HOW the
 * qa-log is mutated, so a full interview turn costs one short command
 * instead of a hand-written multi-hunk markdown edit.
 */

export interface IntakeCursorView {
  questionCount: number;
  outstandingNormalization: string[];
  nextDecisionId: string;
  nextCheckpointAt: string;
  checkpointDue: boolean;
}

export interface IntakeResult {
  ok: boolean;
  action: "init" | "log" | "decision" | "checkpoint" | "status";
  slug: string;
  qaLog: string;
  cursor: IntakeCursorView;
  /** Structural drift found by the gap-audit prelint (closure-only rules excluded). */
  drift: PrelintFinding[];
  detail: Record<string, unknown>;
}

function assertSlug(slug: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error(`invalid topic slug: ${slug} (use kebab-case)`);
  }
}

export function qaLogPathFor(projectRoot: string, slug: string): string {
  return path.join(projectRoot, "agents", "intake", slug, "qa-log.md");
}

function readQaLog(projectRoot: string, slug: string): { file: string; content: string } {
  const file = qaLogPathFor(projectRoot, slug);
  if (!fs.existsSync(file)) {
    throw new Error(`qa-log not found: ${path.relative(projectRoot, file)} (run intake init first)`);
  }
  return { file, content: fs.readFileSync(file, "utf8") };
}

/**
 * Mid-interview drift check. The `qa-register-open` rule is a closure gate
 * (open P0/P1 nodes are the normal state of an active interview), so it is
 * excluded here; everything else failing means the document structure broke.
 */
function driftFindings(content: string): PrelintFinding[] {
  return runPrelint("qa-log", content).findings.filter((finding) => finding.rule !== "qa-register-open");
}

function result(
  action: IntakeResult["action"],
  projectRoot: string,
  slug: string,
  content: string,
  detail: Record<string, unknown>,
): IntakeResult {
  const state: QaLogState = readQaLogState(content);
  return {
    ok: true,
    action,
    slug,
    qaLog: path.relative(projectRoot, qaLogPathFor(projectRoot, slug)),
    cursor: {
      questionCount: state.questionCount,
      outstandingNormalization: state.outstanding,
      nextDecisionId: state.nextDecisionId,
      nextCheckpointAt: state.nextCheckpointAt,
      checkpointDue: state.checkpointDue,
    },
    drift: driftFindings(content),
    detail,
  };
}

export interface IntakeInitOptions {
  slug: string;
  topic: string;
  where: string;
  packs: string;
  understanding: string[];
}

export function runIntakeInit(projectRoot: string, options: IntakeInitOptions): IntakeResult {
  assertSlug(options.slug);
  const file = qaLogPathFor(projectRoot, options.slug);
  if (fs.existsSync(file)) {
    throw new Error(`qa-log already exists: ${path.relative(projectRoot, file)} (resume it instead of re-initializing)`);
  }
  const content = renderInitialQaLog({
    topic: options.topic,
    where: options.where,
    packs: options.packs,
    understanding: options.understanding,
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return result("init", projectRoot, options.slug, content, { created: true });
}

export interface IntakeLogOptions extends QaEntryInput {
  slug: string;
  nextQuestion?: string;
}

export function runIntakeLog(projectRoot: string, options: IntakeLogOptions): IntakeResult {
  assertSlug(options.slug);
  const { file, content } = readQaLog(projectRoot, options.slug);
  const appended = appendQaEntry(content, options);
  const updated = refreshBookkeeping(appended.content, { nextQuestion: options.nextQuestion });
  fs.writeFileSync(file, updated);
  return result("log", projectRoot, options.slug, updated, {
    logged: `Q${appended.qNumber}`,
    decisionIds: options.decisionIds,
  });
}

export interface IntakeDecisionOptions extends Partial<RegisterRow> {
  slug: string;
  id: string;
}

export function runIntakeDecision(projectRoot: string, options: IntakeDecisionOptions): IntakeResult {
  assertSlug(options.slug);
  const { file, content } = readQaLog(projectRoot, options.slug);
  const { slug: _slug, ...patch } = options;
  const upserted = upsertRegisterRow(content, patch);
  const updated = refreshBookkeeping(upserted.content);
  fs.writeFileSync(file, updated);
  return result("decision", projectRoot, options.slug, updated, {
    id: upserted.row.id,
    created: upserted.created,
    row: upserted.row,
  });
}

export interface IntakeCheckpointOptions {
  slug: string;
  normalized: string[];
  registerChanges: string;
  reopened: string;
  gap: string;
}

export function runIntakeCheckpoint(projectRoot: string, options: IntakeCheckpointOptions): IntakeResult {
  assertSlug(options.slug);
  const { file, content } = readQaLog(projectRoot, options.slug);
  const marked = markNormalized(content, options.normalized);
  if (marked.missing.length > 0) {
    throw new Error(
      `cannot mark normalized: ${marked.missing.join(", ")} (entry missing or already normalized)`,
    );
  }
  const state = readQaLogState(marked.content);
  const checkpointed = appendCheckpoint(marked.content, options, state.questionCount);
  let updated = setCursorValue(checkpointed.content, "last_materiality_sweep", `checkpoint ${checkpointed.number}`);
  updated = refreshBookkeeping(updated);
  fs.writeFileSync(file, updated);
  return result("checkpoint", projectRoot, options.slug, updated, {
    checkpoint: checkpointed.number,
    normalized: options.normalized,
  });
}

export function readIntakeStatus(projectRoot: string, slug: string): IntakeResult {
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
