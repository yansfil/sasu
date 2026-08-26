import fs from "node:fs";
import path from "node:path";
import type { PrelintFinding } from "../gates/prelint";

/**
 * Interview cadence tracking: the decision-write side of the latency contract.
 *
 * The skill's rule is that ordinary answered questions require no tool call -
 * D# rows are batched at a checkpoint. A legitimate batch is many `interview
 * decision` calls made while the conversation still sits on ONE human turn
 * (the checkpoint the agent is writing right now); the drift it has to catch
 * is one decision write per user answer, which spreads those same calls across
 * many turns and makes the user wait between questions.
 *
 * Counting calls cannot separate the two - an eight-row checkpoint batch and
 * eight per-turn writes are both eight calls, and any threshold over raw call
 * count either fires on the legitimate batch or misses the drift. The human
 * turn boundary is the state actually being detected, so that is what gets
 * recorded: the distinct transcript turns that triggered a decision write
 * since the last checkpoint.
 *
 * State lives beside the qa-log as runtime bookkeeping and never inside it.
 * The gap-audit PASS is pinned to the qa-log's content hash, so a counter kept
 * in the document would break the seal on every decision write.
 */

/**
 * Distinct decision-triggering turns tolerated between checkpoints.
 *
 * The skill allows normalizing "after every 2 to 3 answers" for high-risk
 * work, so three turns is the widest sanctioned cadence; a fourth is past
 * every documented exception and is the per-turn write pattern.
 */
export const CADENCE_TURN_ALLOWANCE = 3;

const CADENCE_FILE = ".cadence.json";

interface CadenceState {
  turns: string[];
}

/** Runtime cadence state sits next to the qa-log it tracks. */
export function cadencePathFor(qaLogFile: string): string {
  return path.join(path.dirname(qaLogFile), CADENCE_FILE);
}

/**
 * Read the turns recorded since the last checkpoint. A missing file is the
 * normal empty state; a malformed one raises so the caller reports the
 * tracking failure rather than silently restarting the count.
 */
export function readCadenceTurns(qaLogFile: string): string[] {
  const file = cadencePathFor(qaLogFile);
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as CadenceState;
  if (!Array.isArray(parsed.turns) || parsed.turns.some((turn) => typeof turn !== "string")) {
    throw new Error(`malformed cadence state: ${file} (expected { turns: string[] })`);
  }
  return parsed.turns;
}

/**
 * Record that `turnRef` triggered a decision write and return every turn seen
 * since the last checkpoint. Repeating a turn is a no-op, so the batch of
 * upserts an agent makes at one checkpoint counts once however long it is.
 */
export function recordDecisionTurn(qaLogFile: string, turnRef: string): string[] {
  const turns = readCadenceTurns(qaLogFile);
  if (turns.includes(turnRef)) return turns;
  const updated = [...turns, turnRef];
  fs.writeFileSync(cadencePathFor(qaLogFile), `${JSON.stringify({ turns: updated }, null, 2)}\n`, "utf8");
  return updated;
}

/** Drop the count. Called by the commands that ARE the batch boundary. */
export function clearCadence(qaLogFile: string): void {
  const file = cadencePathFor(qaLogFile);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

/** The drift finding for a per-turn write pattern, or null while cadence is fine. */
export function cadenceDrift(turns: string[]): PrelintFinding | null {
  if (turns.length <= CADENCE_TURN_ALLOWANCE) return null;
  return {
    rule: "interview-decision-cadence",
    line: null,
    area: "interview-cadence",
    severity: "P1",
    missing:
      `${turns.length} separate conversation turns have each triggered an \`interview decision\` write since the last checkpoint` +
      ` (allowance ${CADENCE_TURN_ALLOWANCE})`,
    recommendation:
      "Ordinary answered questions require no tool call: keep the decision queue in the conversation, ask the next question immediately, and batch the D# upserts at the checkpoint after `interview sync`.",
    requiresHuman: false,
  };
}
