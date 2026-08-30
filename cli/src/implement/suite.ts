import type { ImplementState, SuiteCommand, SuiteExclusion } from "./types";

/** Shape the suite axis needs from a batch result; keeps this module runner-agnostic. */
export interface SuiteAxisInput {
  suiteCommandIds: string[];
  criterionIds: string[];
  green: boolean;
  command: string;
}

export function activeSuiteCommands(state: ImplementState): SuiteCommand[] {
  const excluded = new Set(state.suite.exclusions.map((entry) => entry.commandId));
  return state.suite.commands.filter((command) => !excluded.has(command.id));
}

/**
 * Suite commands that no acceptance criterion bound.
 *
 * These are the whole reason the suite list survives alongside AC Check
 * bindings: they catch a regression no criterion is watching. Their failure
 * is therefore not an AC's failure and cannot be scored on the AC axis - it
 * blocks on its own (R2).
 */
export function orphanSuiteFailures(results: SuiteAxisInput[]): SuiteAxisInput[] {
  return results.filter((result) =>
    result.suiteCommandIds.length > 0
    && result.criterionIds.length === 0
    && !result.green);
}

/**
 * A suite command is not a criterion and cannot be parked.
 *
 * Park is the "prove this later, with a human's approval on record" escape for
 * an acceptance criterion. A suite command has no criterion to prove later; it
 * is a standing regression guard, and the only way to stop running one is to
 * remove it from the sealed list through an amendment (AC4, AC6).
 */
export function suiteCommandNamed(state: ImplementState, id: string): SuiteCommand | null {
  return state.suite.commands.find((command) => command.id === id.toUpperCase()) ?? null;
}

export interface ExclusionRequest {
  commandId: string;
  approval: string;
  reason: string;
}

/**
 * Drop a command from the sealed suite list.
 *
 * Refuses without a verbatim human approval and a reason. This is the only
 * door out of the sealed list, and it is deliberately narrow: the list is
 * sealed at start precisely so that nothing can quietly shrink what a run is
 * measured against (AC5, AC6). Every exclusion is appended, never replacing an
 * earlier record.
 */
export function excludeSuiteCommand(state: ImplementState, request: ExclusionRequest, at: string): SuiteExclusion {
  const commandId = request.commandId.toUpperCase();
  const command = suiteCommandNamed(state, commandId);
  if (command === null) {
    throw new Error(`unknown suite command: ${commandId}; sealed list holds ${state.suite.commands.map((entry) => entry.id).join(", ") || "no commands"}`);
  }
  const approval = request.approval.trim();
  const reason = request.reason.trim();
  if (approval === "") {
    throw new Error(`excluding ${commandId} (${command.command}) requires --approval "<verbatim human approval>"; the sealed suite list cannot shrink on an agent's judgment`);
  }
  if (reason === "") throw new Error(`excluding ${commandId} requires --reason "<why>"`);
  if (state.suite.exclusions.some((entry) => entry.commandId === commandId)) {
    throw new Error(`${commandId} is already excluded from the sealed suite list`);
  }
  const exclusion: SuiteExclusion = { at, commandId, approval, reason };
  state.suite.exclusions.push(exclusion);
  return exclusion;
}

export interface SuiteScore {
  green: number;
  total: number;
  red: Array<{ commandId: string; command: string }>;
}

/** The suite axis as it is reported: GREEN/RED over the active sealed list (R4). */
export function suiteScore(state: ImplementState): SuiteScore {
  const active = activeSuiteCommands(state);
  const red: Array<{ commandId: string; command: string }> = [];
  let green = 0;
  for (const command of active) {
    const result = state.suite.results.find((entry) => entry.commandId === command.id);
    if (result?.status === "GREEN") green += 1;
    else if (result?.status === "RED") red.push({ commandId: command.id, command: command.command });
  }
  return { green, total: active.length, red };
}
