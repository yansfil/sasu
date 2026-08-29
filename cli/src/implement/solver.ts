import type { EscalationRecord, ImplementState, SolverHandoff } from "./types";
import { ESCALATE_LIMIT_PER_RUN } from "./types";

/**
 * The solver: a clean context on a stronger model that looks at a stuck
 * implementor and says what it sees (R12).
 *
 * Two properties define it and both are structural rather than promised.
 *
 * It DIAGNOSES ONLY. It is summoned through the same read-only judge backend
 * every other lane uses - disposable workspace, no writes, no project
 * execution - and its return value is text. `escalate` writes state only
 * after that call has returned, so the solver's execution window contains
 * zero writes by construction, not by restraint (AC33).
 *
 * The replacement implementor is briefed from THREE PATHS and nothing else.
 * `buildHandoffBriefing` takes those three strings as its whole input, so
 * there is no parameter through which the previous implementor's
 * conversation could reach the replacement even by mistake (AC34, D-22).
 */

export class EscalateRejected extends Error {
  constructor(readonly check: "arguments" | "authority" | "transition", message: string) {
    super(message);
    this.name = "EscalateRejected";
  }
}

/** What a solver is allowed to return: text about the problem, nothing else. */
export interface SolverDiagnosis {
  summary: string;
  likelyCause: string;
  suggestedNextStep: string;
}

export function validateDiagnosis(value: unknown): SolverDiagnosis | string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "diagnosis must be an object";
  const record = value as Record<string, unknown>;
  const fields: Array<keyof SolverDiagnosis> = ["summary", "likelyCause", "suggestedNextStep"];
  for (const field of fields) {
    const held = record[field];
    if (typeof held !== "string" || held.trim() === "") return `diagnosis.${field} must be a non-empty string`;
  }
  // Anything beyond the three text fields would be the solver reaching for an
  // action, and the contract is that it does not act.
  const extra = Object.keys(record).filter((key) => !fields.includes(key as keyof SolverDiagnosis));
  if (extra.length > 0) return `diagnosis must carry only ${fields.join(", ")}; remove ${extra.join(", ")}`;
  return {
    summary: (record["summary"] as string).trim(),
    likelyCause: (record["likelyCause"] as string).trim(),
    suggestedNextStep: (record["suggestedNextStep"] as string).trim(),
  };
}

export interface SolverEnvelope {
  target: string | null;
  reason: string;
  /** The sealed question paper. */
  prd: string;
  /** The AC ledger as the replacement will read it. */
  checkLedger: string;
  /** Recent implementor output, when the environment can supply it. */
  paneExcerpt: string | null;
  paneProblem: string | null;
}

export function solverPrompt(envelope: SolverEnvelope): string {
  return [
    "You are the solver on a stuck implementation run.",
    "",
    "Your entire job is to diagnose. You do not write code, you do not change state, and you do not act.",
    "Return the three text fields and nothing else; any other key is rejected.",
    "",
    `## What the implementor is stuck on\n\n${envelope.target ?? "the run as a whole"}`,
    "",
    `## Why the supervisor escalated\n\n${envelope.reason}`,
    "",
    `## Sealed PRD\n\n${envelope.prd}`,
    "",
    `## Acceptance-criterion ledger\n\n${envelope.checkLedger}`,
    "",
    envelope.paneExcerpt === null
      ? `## Implementor output\n\nUnavailable: ${envelope.paneProblem ?? "no diagnosis channel in this environment"}. Diagnose from the ledger and the PRD alone, and say so if that is not enough.`
      : `## Implementor output (recent)\n\n${envelope.paneExcerpt}`,
    "",
    "## Return",
    "",
    "```json",
    '{"summary": "<what is actually happening>", "likelyCause": "<the one cause, not the symptoms>", "suggestedNextStep": "<the single next move for a replacement implementor>"}',
    "```",
  ].join("\n");
}

export function renderDiagnosis(record: { id: number; at: string; target: string | null; reason: string }, diagnosis: SolverDiagnosis): string {
  return [
    `# Solver diagnosis ${record.id}`,
    "",
    `- escalated at: ${record.at}`,
    `- target: ${record.target ?? "the run as a whole"}`,
    `- supervisor's reason: ${record.reason}`,
    "",
    "## Summary",
    "",
    diagnosis.summary,
    "",
    "## Likely cause",
    "",
    diagnosis.likelyCause,
    "",
    "## Suggested next step",
    "",
    diagnosis.suggestedNextStep,
    "",
  ].join("\n");
}

/**
 * The whole briefing a replacement implementor receives.
 *
 * Three paths in, one string out. The absence of any other parameter is the
 * mechanism: a caller cannot pass a transcript here, so a replacement cannot
 * inherit one (AC34). The prior implementor's conversation is deliberately
 * lost - carrying it over would carry the stuck reasoning with it, which is
 * the thing the reset exists to discard (D-22).
 */
export function buildHandoffBriefing(handoff: SolverHandoff): string {
  return [
    "You are the replacement implementor on this run. You are starting with a clean context.",
    "The previous implementor's conversation is not available to you, and that is deliberate: it is the reasoning that got stuck.",
    "",
    "Read these three, in this order, and nothing else is handed to you:",
    "",
    `1. The sealed PRD - the question paper this run is measured against: ${handoff.prdSnapshotPath}`,
    `2. The solver's diagnosis - what the previous implementor was stuck on: ${handoff.diagnosisPath}`,
    `3. The acceptance-criterion ledger - what is already proven and what is not: ${handoff.checkLedgerPath}`,
    "",
    "Then report what you understand and what you intend to do next, and wait for the supervisor before writing code.",
  ].join("\n");
}

/**
 * Refuse a fourth escalation.
 *
 * The bound exists because escalation is generative: a fresh solver on the
 * same stuck run does not converge on its own, so something outside it has to
 * stop the loop (PRINCIPLES 13). Three is an unmeasured initial default
 * (D-46) and lives here as a code constant rather than a config knob, so
 * tuning it is a code change with a reason attached.
 */
export function assertEscalateBudget(state: ImplementState): void {
  const spent = state.escalations.length;
  if (spent < ESCALATE_LIMIT_PER_RUN) return;
  throw new EscalateRejected(
    "transition",
    `escalate refused: this run has used all ${ESCALATE_LIMIT_PER_RUN} escalations (${state.escalations.map((entry) => `#${entry.id} ${entry.outcome}`).join(", ")}). A fourth solver on the same problem is not a plan. Take it to the operator: park the criterion, amend the PRD, or finalize blocked.`,
  );
}

export function recordEscalation(
  state: ImplementState,
  entry: Omit<EscalationRecord, "id">,
): EscalationRecord {
  const record: EscalationRecord = { id: Math.max(0, ...state.escalations.map((existing) => existing.id)) + 1, ...entry };
  state.escalations.push(record);
  return record;
}
