import { activeSuiteCommands, suiteScore } from "./suite";
import type { ImplementState } from "./types";

/**
 * What the receipt says a run actually proved (R7).
 *
 * Three counts, deliberately not one number. Machine and judge rows are the
 * questions the harness can answer itself; human rows are the questions
 * only the person can, and are reported as OPEN until confirmed instead of
 * being folded into the same fraction. The suite axis is the standing
 * regression guard and is independent of both: every row can pass while a
 * command no row names goes red, and that run is not done.
 *
 * The score EXPLAINS the outcome and never decides it. A parked row still
 * refuses `finalize --status complete`; counting it does not soften it.
 */

export interface RowScore {
  /** check: and judge: rows proved (green or PASS). */
  passed: number;
  /** check: and judge: rows in total. */
  total: number;
  /** human: rows still OPEN, with the latest rejection when there is one. */
  open: Array<{ id: string; rejected: string | null }>;
  /** human: rows confirmed. */
  confirmed: number;
  /** Ids and reasons, so a reader learns what was set aside without opening state. */
  parked: Array<{ id: string; reason: string }>;
  /** check: and judge: rows that are neither proved nor parked. */
  unproven: string[];
}

export interface SuiteAxis {
  green: number;
  total: number;
  red: Array<{ commandId: string; command: string; exitCode: number }>;
  excluded: Array<{ commandId: string; reason: string }>;
}

export function rowScore(state: ImplementState): RowScore {
  const parked: RowScore["parked"] = [];
  const unproven: string[] = [];
  const open: RowScore["open"] = [];
  let passed = 0;
  let total = 0;
  let confirmed = 0;
  for (const row of state.rows) {
    if (row.check.kind === "human") {
      if (row.status === "PASS") confirmed += 1;
      else open.push({ id: row.id, rejected: row.rejections.at(-1)?.evidence ?? null });
      continue;
    }
    total += 1;
    if (row.status === "parked") {
      parked.push({ id: row.id, reason: row.parks.at(-1)?.reason ?? "parked without a recorded reason" });
    } else if (row.status === "green" || row.status === "PASS") {
      passed += 1;
    } else {
      unproven.push(row.id);
    }
  }
  return { passed, total, open, confirmed, parked, unproven };
}

export function suiteAxis(state: ImplementState): SuiteAxis {
  const score = suiteScore(state);
  const active = new Map(activeSuiteCommands(state).map((entry) => [entry.id, entry]));
  const red = state.suite.results
    .filter((entry) => entry.status === "RED" && active.has(entry.commandId))
    .map((entry) => ({ commandId: entry.commandId, command: active.get(entry.commandId)!.command, exitCode: entry.exitCode }));
  return {
    green: score.green,
    total: score.total,
    red,
    excluded: state.suite.exclusions.map((entry) => ({ commandId: entry.commandId, reason: entry.reason })),
  };
}

export interface RunScore {
  rows: RowScore;
  suite: SuiteAxis;
}

export function runScore(state: ImplementState): RunScore {
  return { rows: rowScore(state), suite: suiteAxis(state) };
}

/** The one line a person reads first: machine+judge N/M, human OPEN K, suite. */
export function scoreLine(score: RunScore): string {
  const { rows, suite } = score;
  const parked = rows.parked.length === 0
    ? ""
    : ` (parked ${rows.parked.length}: ${rows.parked.map((entry) => `${entry.id} ${entry.reason}`).join("; ")})`;
  const human = rows.open.length + rows.confirmed === 0 ? "" : ` | human: ${rows.open.length} OPEN, ${rows.confirmed} confirmed`;
  const red = suite.red.length === 0 ? "" : ` (RED: ${suite.red.map((entry) => entry.commandId).join(", ")})`;
  return `기계·판사: ${rows.passed}/${rows.total} PASS${parked}${human} | suite: ${suite.green}/${suite.total} GREEN${red}`;
}
