import fs from "node:fs";
import path from "node:path";
import { parseImplementContract, type BehaviorRowContract, type ImplementContract } from "./contract";
import { rowCheckPayload } from "./checks";
import { normalizeProjectPath, sha256, writeTextAtomic } from "./store";
import { excludeSuiteCommand, suiteCommandNamed } from "./suite";
import type { AmendmentRecord, BehaviorRow, ImplementState, IssuerLabel } from "./types";

/**
 * Amendment: correcting the question paper mid-run (R6).
 *
 * The rule that shapes this module is that a correction must cost only what
 * it actually invalidates: identity is decided per row and per cell, and
 * everything whose cells survive keeps its evidence. The second rule is the
 * authority split. A diff that touches only 검사 방법 cells changes HOW rows
 * are proved and the observer may issue it; a diff that touches a behavior
 * cell, adds or removes a row, or moves Non-goals or the Decisions table
 * changes WHAT the user observes, and only the human may issue it. The
 * implementor is refused either way: it does not get to rewrite the question
 * it is being marked on.
 */

/** Normalize away formatting, keep meaning: a table re-alignment is a non-event. */
function normalizeField(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function behaviorHash(row: { behavior: string; decisionIds: string[] }): string {
  return sha256([normalizeField(row.behavior), row.decisionIds.join(",")].join(" "));
}

function checkHash(row: { check: BehaviorRow["check"] }): string {
  return sha256([row.check.kind, normalizeField(rowCheckPayload(row as BehaviorRow))].join(" "));
}

export class AmendmentRejected extends Error {
  constructor(readonly check: "arguments" | "authority" | "transition", message: string) {
    super(message);
    this.name = "AmendmentRejected";
  }
}

export interface AmendmentPlan {
  scope: "check-cells" | "behaviors";
  /** Rows whose check cell changed and nothing else. */
  checkCellChanged: string[];
  /** Rows whose behavior cell (or cited decisions) changed. */
  behaviorChanged: string[];
  addedRows: string[];
  removedRows: string[];
  /** Whether Non-goals or the Decisions table moved (a scope change). */
  scopeSectionsChanged: string[];
  invalidatedRows: string[];
  unparkedRows: string[];
  unchangedRows: string[];
}

function decisionsDigest(contract: { decisions: ImplementContract["decisions"] }): string {
  return sha256(JSON.stringify(contract.decisions.map((entry) => [entry.id, normalizeField(entry.decision), normalizeField(entry.rationale)])));
}

/**
 * Decide what an amended PRD costs and who may issue it, without applying.
 * Split from the application so the refusal path and the receipt can both
 * ask "what would this do?" without a write happening as a side effect.
 */
export function planAmendment(
  state: ImplementState,
  current: ImplementContract,
  next: ImplementContract,
): AmendmentPlan {
  const held = new Map(state.rows.map((row) => [row.id, row]));
  const plan: AmendmentPlan = {
    scope: "check-cells",
    checkCellChanged: [],
    behaviorChanged: [],
    addedRows: [],
    removedRows: [],
    scopeSectionsChanged: [],
    invalidatedRows: [],
    unparkedRows: [],
    unchangedRows: [],
  };
  const nextIds = new Set(next.rows.map((row) => row.id));
  plan.removedRows = state.rows.filter((row) => !nextIds.has(row.id)).map((row) => row.id);
  for (const row of next.rows) {
    const existing = held.get(row.id);
    if (existing === undefined) {
      plan.addedRows.push(row.id);
      continue;
    }
    const behaviorMoved = behaviorHash(existing) !== behaviorHash(row);
    const checkMoved = checkHash(existing) !== checkHash(row);
    if (behaviorMoved) plan.behaviorChanged.push(row.id);
    else if (checkMoved) plan.checkCellChanged.push(row.id);
    else {
      plan.unchangedRows.push(row.id);
      continue;
    }
    plan.invalidatedRows.push(row.id);
    if (existing.status === "parked") plan.unparkedRows.push(row.id);
  }
  if (normalizeField(current.nonGoals) !== normalizeField(next.nonGoals)) plan.scopeSectionsChanged.push("Non-goals");
  if (decisionsDigest(current) !== decisionsDigest(next)) plan.scopeSectionsChanged.push("Decisions");
  if (plan.behaviorChanged.length > 0 || plan.addedRows.length > 0 || plan.removedRows.length > 0 || plan.scopeSectionsChanged.length > 0) {
    plan.scope = "behaviors";
  }
  return plan;
}

/** A fresh, unproven row as `start` would seal it. */
export function sealRow(row: BehaviorRowContract): BehaviorRow {
  return {
    id: row.id,
    behavior: row.behavior,
    check: row.check,
    decisionIds: [...row.decisionIds],
    status: row.check.kind === "human" ? "OPEN" : "pending",
    attempts: [],
    consecutiveFailures: 0,
    parks: [],
    verdict: null,
    human: null,
    rejections: [],
  };
}

/**
 * Merge the amended rows into the ledger.
 *
 * An unchanged row keeps its object whole. A changed row keeps its history
 * and loses its verdict: attempts stay readable so the next attempt is not
 * blind, the status returns to unproven because it was earned against a
 * question that no longer exists, and an active park is lifted for the same
 * reason. Row order follows the amended PRD.
 */
function mergeRows(state: ImplementState, next: ImplementContract, plan: AmendmentPlan, at: string): void {
  const held = new Map(state.rows.map((row) => [row.id, row]));
  const invalidated = new Set(plan.invalidatedRows);
  state.rows = next.rows.map((row) => {
    const existing = held.get(row.id);
    if (existing === undefined) return sealRow(row);
    if (!invalidated.has(row.id)) return existing;
    const park = existing.parks.at(-1);
    if (existing.status === "parked" && park !== undefined && park.resumedAt === null) park.resumedAt = at;
    const kindChanged = existing.check.kind !== row.check.kind;
    return {
      ...existing,
      behavior: row.behavior,
      check: row.check,
      decisionIds: [...row.decisionIds],
      status: row.check.kind === "human" ? "OPEN" : "pending",
      // Attempts and parks belong to a check: row; a row that changed kind
      // starts its ledger over, because an exit code proves nothing about a
      // judge: question.
      attempts: kindChanged ? [] : existing.attempts,
      parks: kindChanged ? [] : existing.parks,
      consecutiveFailures: 0,
      verdict: null,
      human: null,
      rejections: kindChanged ? [] : existing.rejections,
    };
  });
}

export interface AmendmentInput {
  issuer: IssuerLabel;
  approval: string;
  reason: string;
  /** The amended PRD text, already read from the source path. */
  text: string;
  /**
   * Sealed suite command ids to drop from the scored list.
   *
   * Exclusion rides the amendment because it is the same act: correcting
   * what this run is measured against. One door out of the sealed list, one
   * place the approval is recorded. Human-only, like a behaviors amendment.
   */
  excludeSuite?: string[];
}

export interface AmendmentOutcome {
  record: AmendmentRecord;
  plan: AmendmentPlan;
}

/**
 * Where a superseded snapshot goes. The pinned snapshot keeps its path
 * (`<runDir>/prd.md`) across amendments so every reader keeps resolving the
 * live question paper the same way; the version it replaced is archived
 * under its amendment id.
 */
export function amendmentArchivePath(runDir: string, id: number): string {
  return `${runDir}/amendments/prd-${id}-superseded.md`;
}

export function applyAmendment(
  recordRoot: string,
  state: ImplementState,
  input: AmendmentInput,
  at: string,
): AmendmentOutcome {
  if (input.issuer === "implementor") {
    throw new AmendmentRejected("authority", "amend refused: the implementor may not amend the PRD it is being marked on. An observer may correct a 검사 방법 cell with --issuer observer; anything that changes what the user observes needs --issuer human.");
  }
  if (input.approval.trim() === "") {
    throw new AmendmentRejected("arguments", "amend requires --approval <verbatim approval>; correcting the question paper is recorded with the words that authorised it");
  }
  if (input.reason.trim() === "") {
    throw new AmendmentRejected("arguments", "amend requires --reason <why the row was wrong>");
  }
  const running = state.rows.filter((row) => row.check.kind === "check" && row.status === "fail").map((row) => row.id);
  if (running.length > 0 && input.issuer !== "human") {
    // A failing check: row is one somebody is holding. Rewriting its cell
    // under a live attempt would move the goalposts mid-measurement; the
    // human may still do it, on the record, and the observer waits.
    throw new AmendmentRejected("transition", `amend refused: ${running.join(", ")} ${running.length === 1 ? "is" : "are"} mid-attempt (latest check failed and no green since). Let the implementor land a green or park the row, or amend as the human.`);
  }

  const current = parseImplementContract(fs.readFileSync(normalizeProjectPath(recordRoot, state.prd.snapshotPath).absolute, "utf8"));
  const next = parseImplementContract(input.text);
  const plan = planAmendment(state, current, next);
  const excludeSuite = (input.excludeSuite ?? []).map((entry) => entry.trim().toUpperCase()).filter((entry) => entry !== "");
  if (input.issuer === "observer" && (plan.scope === "behaviors" || excludeSuite.length > 0)) {
    const what = [
      ...plan.behaviorChanged.map((id) => `${id} behavior cell`),
      ...plan.addedRows.map((id) => `+${id}`),
      ...plan.removedRows.map((id) => `-${id}`),
      ...plan.scopeSectionsChanged,
      ...(excludeSuite.length > 0 ? [`suite exclusion ${excludeSuite.join(", ")}`] : []),
    ];
    throw new AmendmentRejected("authority", `amend refused for observer: this diff changes what the user observes (${what.join("; ")}). The observer may change 검사 방법 cells only; take this to the human (--issuer human with the user's verbatim approval).`);
  }
  if (plan.scope === "check-cells" && plan.checkCellChanged.length === 0 && excludeSuite.length === 0) {
    throw new AmendmentRejected("arguments", "amended PRD changes no Behaviors row, Non-goals, or Decisions row; nothing to amend");
  }
  const id = Math.max(0, ...state.amendments.map((entry) => entry.id)) + 1;

  // Excluded first, so a refused exclusion leaves the snapshot untouched: an
  // amendment that half-applied would be worse than one that did not run.
  const excluded: NonNullable<AmendmentRecord["excludedSuiteCommands"]> = [];
  for (const commandId of excludeSuite) {
    const command = suiteCommandNamed(state, commandId);
    if (command === null) {
      throw new AmendmentRejected("arguments", `unknown suite command: ${commandId}; the sealed list holds ${state.suite.commands.map((entry) => entry.id).join(", ") || "no commands"}`);
    }
    // The last result STAYS in the ledger: it stops being counted because
    // the command left the scored list, but deleting it would erase a red
    // this run really saw.
    const priorResult = state.suite.results.find((entry) => entry.commandId === commandId)?.status ?? "none";
    excludeSuiteCommand(state, { commandId, approval: input.approval.trim(), reason: input.reason.trim() }, at);
    excluded.push({ commandId, command: command.command, priorResult });
  }

  // Archive first, then overwrite: if the archive write fails, the pinned
  // snapshot is still the one state.prd.sha256 names and the run is intact.
  const snapshotPath = state.prd.snapshotPath;
  const previousSnapshotPath = amendmentArchivePath(state.runDir, id);
  const pinned = normalizeProjectPath(recordRoot, snapshotPath);
  const archive = normalizeProjectPath(recordRoot, previousSnapshotPath);
  fs.mkdirSync(path.dirname(archive.absolute), { recursive: true });
  writeTextAtomic(archive.absolute, fs.readFileSync(pinned.absolute, "utf8"));
  writeTextAtomic(pinned.absolute, input.text);

  mergeRows(state, next, plan, at);
  state.prd = { ...state.prd, sha256: sha256(input.text) };

  const record: AmendmentRecord = {
    id,
    at,
    issuer: input.issuer,
    scope: plan.scope,
    approval: input.approval.trim(),
    reason: input.reason.trim(),
    prdSha256: state.prd.sha256,
    snapshotPath,
    previousSnapshotPath,
    invalidatedRows: plan.invalidatedRows,
    addedRows: plan.addedRows,
    unparkedRows: plan.unparkedRows,
    suiteSnapshotUpdated: excluded.length > 0,
    ...(excluded.length > 0 ? { excludedSuiteCommands: excluded } : {}),
  };
  state.amendments.push(record);
  return { record, plan };
}
