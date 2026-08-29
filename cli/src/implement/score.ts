import { criterionCheckIsGreen } from "./checks";
import { activeSuiteCommands, suiteScore } from "./suite";
import type { ImplementState } from "./types";

/**
 * What the receipt says a run actually proved (R4, AC10, AC11).
 *
 * Two axes, deliberately not one number. The AC axis says how many questions
 * the PRD asked were answered; the suite axis says whether the standing
 * regression guards are green. They are independent because their failures
 * are independent: every criterion can pass while a command no criterion
 * binds goes red, and that run is not done (R2).
 *
 * The score EXPLAINS the outcome and never decides it. A parked criterion
 * still refuses `finalize --status complete`, exactly as before; counting it
 * does not soften it (D-23).
 */

export interface AcceptanceScore {
  passed: number;
  total: number;
  /** Ids and reasons, so a reader learns what was set aside without opening state. */
  parked: Array<{ id: string; reason: string; parkedBy: string }>;
  /** Criteria that are neither proven nor parked. */
  unproven: string[];
}

export interface SuiteAxis {
  green: number;
  total: number;
  red: Array<{ commandId: string; command: string; exitCode: number; boundCriteria: string[] }>;
  excluded: Array<{ commandId: string; reason: string }>;
}

export interface AssetLaborMeasurement {
  asset: number;
  labor: number;
  /** Every bound command with its classification, so the count is auditable. */
  bindings: Array<{ criterionId: string; command: string; cwd: string; classification: "asset" | "labor" }>;
}

/**
 * A criterion counts as passed when the authority that owns it says so: the
 * check ledger for a machine criterion, the recorded judged status for the
 * rest. Parked criteria are counted separately rather than as failures -
 * "set aside with a reason" and "tried and failed" are different facts and a
 * receipt that merged them would be lying by rounding.
 */
export function acceptanceScore(state: ImplementState): AcceptanceScore {
  const parked: AcceptanceScore["parked"] = [];
  const unproven: string[] = [];
  let passed = 0;
  for (const criterion of state.acceptanceCriteria) {
    if (criterion.check.status === "parked") {
      const park = criterion.check.parks.at(-1);
      parked.push({
        id: criterion.id,
        reason: park?.reason ?? "parked without a recorded reason",
        parkedBy: park?.parkedBy ?? "human",
      });
      continue;
    }
    const proven = criterion.judgment === "judged"
      ? criterion.status === "complete"
      : criterionCheckIsGreen(criterion);
    if (proven) passed += 1;
    else unproven.push(criterion.id);
  }
  return { passed, total: state.acceptanceCriteria.length, parked, unproven };
}

export function suiteAxis(state: ImplementState): SuiteAxis {
  const score = suiteScore(state);
  const active = new Map(activeSuiteCommands(state).map((entry) => [entry.id, entry]));
  const red = state.suite.results
    .filter((entry) => entry.status === "RED" && active.has(entry.commandId))
    .map((entry) => ({
      commandId: entry.commandId,
      command: active.get(entry.commandId)!.command,
      exitCode: entry.exitCode,
      boundCriteria: entry.attributedCriteria,
    }));
  return {
    green: score.green,
    total: score.total,
    red,
    excluded: state.suite.exclusions.map((entry) => ({ commandId: entry.commandId, reason: entry.reason })),
  };
}

export function assetLabor(state: ImplementState): AssetLaborMeasurement {
  // The LATEST binding per criterion is the one the run ends with. Counting
  // every superseded binding too would score a rebind as extra assets, which
  // is the opposite of what a rebind means.
  const bindings = state.acceptanceCriteria.flatMap((criterion) => {
    const binding = criterion.check.bindings.at(-1);
    return binding === undefined ? [] : [{
      criterionId: criterion.id,
      command: binding.command,
      cwd: binding.cwd,
      classification: binding.classification,
    }];
  });
  return {
    asset: bindings.filter((entry) => entry.classification === "asset").length,
    labor: bindings.filter((entry) => entry.classification === "labor").length,
    bindings,
  };
}

export interface RunScore {
  acceptance: AcceptanceScore;
  suite: SuiteAxis;
  assetLabor: AssetLaborMeasurement;
}

export function runScore(state: ImplementState): RunScore {
  return { acceptance: acceptanceScore(state), suite: suiteAxis(state), assetLabor: assetLabor(state) };
}

/** The one line a person reads first (D-23). */
export function scoreLine(score: RunScore): string {
  const { acceptance, suite } = score;
  const parked = acceptance.parked.length === 0
    ? ""
    : ` (parked ${acceptance.parked.length}: ${acceptance.parked.map((entry) => `${entry.id} ${entry.reason}`).join("; ")})`;
  return `AC: ${acceptance.passed}/${acceptance.total} PASS${parked} | suite: ${suite.green}/${suite.total} GREEN${suite.red.length === 0 ? "" : ` (RED: ${suite.red.map((entry) => entry.commandId).join(", ")})`}`;
}
