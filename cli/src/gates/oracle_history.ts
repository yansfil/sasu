import fs from "node:fs";
import path from "node:path";

import type { GateRecord } from "./store.js";

/**
 * Per-criterion oracle outcome history, read back out of the gate's own
 * recorded artifacts.
 *
 * The failure this exists to make visible: an AC oracle that does not answer
 * the same way twice. In an audited tetris run the verify gate ran 16 rounds
 * and AC1's oracle went
 *
 *   PASS FAIL PASS PASS PASS PASS PASS FAIL PASS PASS PASS FAIL PASS PASS PASS
 *
 * (five other criteria did the same on a smaller scale). Nothing told the agent
 * that AC1 had already failed and recovered twice, so each new FAIL read as a
 * fresh regression it had just caused, and it spent about four hours chasing
 * one (2026-08-11).
 *
 * The harness already watches the mirror image of this question - rehearsals
 * .jsonl exists because "a check that never failed anywhere is indistinguishable
 * from a check that guards nothing" - and had no reading at all for a check that
 * answers both ways. Same data, same cost: every round already writes its full
 * `oracle[]` array to `agents/gates/<slug>/artifacts/verify-*.json`, and the
 * history rows already point at those files, so this reads what is on disk and
 * collects nothing new.
 *
 * Item 4 account. Nothing leaves with this, which is a debt, not a free pass -
 * so the surface is one line on a finding the agent is already being shown, and
 * these are the two things deliberately NOT built: no second surface for a PASS
 * earned by a flip-flopping oracle (real, but it costs a new artifact key and an
 * extra print for an honesty gain, while the FAIL path is where the four hours
 * went), and no "flaky" verdict anywhere in the output. Whether a red-then-green
 * run is a genuine regression the agent fixed or a check that cannot decide is
 * exactly the judgment the harness must not make from a sequence of booleans
 * (items 7 and 10): state the observation, hand over the material, let the
 * reader decide.
 *
 * Observer only. Reads fail open - a missing, unreadable, or truncated artifact
 * drops that round from the sequence rather than failing the gate, because an
 * advisory note must never be able to break a verification.
 */
export interface OracleHistoryEntry {
  id: string;
  /** Oldest-first, one character per recorded round: `P` met, `F` not met. */
  sequence: string;
  /** Rounds whose artifact recorded a result for this criterion. */
  runs: number;
  failures: number;
  /** `F` -> `P` transitions: how many times this criterion came back green. */
  returnedToPass: number;
}

interface RecordedOracleOutcome {
  id?: unknown;
  met?: unknown;
}

/**
 * Read every recorded round's oracle results, oldest first.
 *
 * `history` is capped at 20 rows by recordGateResult, so the lookback is
 * bounded by construction and needs no window of its own. Measured on the
 * tetris run (16 rounds, ~25KB per artifact): ~400KB of reads, well under the
 * cost of a single oracle command.
 */
export function oracleHistory(projectRoot: string, record: GateRecord | undefined): Map<string, OracleHistoryEntry> {
  const sequences = new Map<string, string>();
  for (const row of record?.history ?? []) {
    if (typeof row.artifact !== "string" || row.artifact === "") continue;
    let outcomes: RecordedOracleOutcome[];
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(projectRoot, row.artifact), "utf8")) as { oracle?: unknown };
      if (!Array.isArray(parsed.oracle)) continue;
      outcomes = parsed.oracle as RecordedOracleOutcome[];
    } catch {
      continue;
    }
    for (const outcome of outcomes) {
      if (typeof outcome?.id !== "string" || outcome.id === "") continue;
      sequences.set(outcome.id, `${sequences.get(outcome.id) ?? ""}${outcome.met === true ? "P" : "F"}`);
    }
  }
  const entries = new Map<string, OracleHistoryEntry>();
  for (const [id, sequence] of sequences) {
    let returnedToPass = 0;
    for (let i = 1; i < sequence.length; i += 1) {
      if (sequence[i] === "P" && sequence[i - 1] === "F") returnedToPass += 1;
    }
    entries.set(id, {
      id,
      sequence,
      runs: sequence.length,
      failures: sequence.split("").filter((char) => char === "F").length,
      returnedToPass,
    });
  }
  return entries;
}

/**
 * The observation to hand an agent staring at a fresh oracle FAIL, or null when
 * the recorded history says nothing worth saying.
 *
 * The bar is `returnedToPass >= 1`: this criterion has already failed and gone
 * back to green at least once, so the failure in front of the agent is provably
 * not the first of its kind. A criterion that has only ever failed since it
 * started failing gets no note - that is an ordinary open failure, and saying
 * anything about it would be noise.
 *
 * Deliberately states no conclusion. "Look at both runs' evidence" is the whole
 * ask; "this check is flaky" is a judgment the sequence cannot support.
 */
export function oracleRepeatFailureNote(entry: OracleHistoryEntry | undefined): string | null {
  if (!entry || entry.returnedToPass < 1) return null;
  return (
    `Recorded history for ${entry.id}: it failed in ${entry.failures} of the last ${entry.runs} gate rounds and returned to passing `
    + `${entry.returnedToPass} time(s) (oldest first: ${entry.sequence}). This failure is not the first, so before treating it as a `
    + `regression you just introduced, compare the evidence from this round against the last round where it passed - the two readings `
    + `may come from a real change, or from a check that does not answer the same way twice.`
  );
}
