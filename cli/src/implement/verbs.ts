import type { ImplementState, IssuedCommand, IssuerLabel, VerbRecord, VerbRejectionCheck } from "./types";

/**
 * Append one verb to the run's history.
 *
 * Refusals are recorded too, and they name WHICH of the three checks refused
 * (arguments, authority, transition). A history that only remembers what
 * succeeded cannot answer "why did nothing happen when I asked?", which is
 * the question a supervisor actually has.
 */
export function recordVerb(
  state: ImplementState,
  entry: Omit<VerbRecord, "id" | "rejection"> & { rejection?: { check: VerbRejectionCheck; message: string } },
): VerbRecord {
  const record: VerbRecord = {
    id: Math.max(0, ...state.verbs.map((existing) => existing.id)) + 1,
    at: entry.at,
    verb: entry.verb,
    issuer: entry.issuer,
    target: entry.target,
    reason: entry.reason,
    outcome: entry.outcome,
    rejection: entry.rejection ?? null,
  };
  state.verbs.push(record);
  return record;
}

export class VerbRejected extends Error {
  constructor(readonly check: VerbRejectionCheck, message: string) {
    super(message);
    this.name = "VerbRejected";
  }
}

/**
 * Record a refusal, flush it, and throw.
 *
 * `persist` is a required argument rather than the caller's responsibility
 * after the fact: a refusal recorded in memory and then thrown past the write
 * is a refusal the history never learns about. That is exactly what happened
 * the first time this was written, and a comment asking callers to remember
 * is a request for discipline, not a guard (AGENTS.md Review Guide 7).
 */
/**
 * The recorded verb vocabulary: the mutating subcommands whose every attempt,
 * accepted or refused, lands in `state.verbs` with its declared issuer. The
 * store validates against this list, so a command the dispatcher accepts can
 * never be a verb the next read refuses.
 *
 * The issuer label is a DECLARATION for the audit trail, not an authority
 * gate. An earlier table refused commands by label; the label was typed by
 * the same process it claimed to restrict, so the gate stopped nothing a
 * transcript would not already show and blocked legitimate cleanup (an
 * Observer retiring its own scratch run, 2026-09-24). Structural facts guard
 * what needs guarding: session ownership, the pane marker, the verify lease.
 */
export const ISSUED_COMMANDS: IssuedCommand[] = ["artifact", "plan", "block", "report", "verify", "retire", "escalate", "amend"];

/**
 * Subcommands with no verb record: reads, and the two that run before a run
 * record exists to write into. Compared against the dispatcher by test so a
 * new subcommand is placed deliberately in one list or the other.
 */
export const UNRECORDED_COMMANDS = ["intake", "start", "status", "dispatch"] as const;

export function isIssuedCommand(value: string): value is IssuedCommand {
  return (ISSUED_COMMANDS as string[]).includes(value);
}

const ISSUERS: IssuerLabel[] = ["implementor", "observer", "human"];

/**
 * Resolve the declared issuer, defaulting to the commonest caller.
 *
 * Defaulting to `implementor` keeps every existing invocation meaning what it
 * always meant, and makes the restricted paths the ones that must say so.
 */
export function resolveIssuer(declared: string | undefined): IssuerLabel {
  const value = (declared ?? "").trim().toLowerCase();
  if (value === "") return "implementor";
  const match = ISSUERS.find((entry) => entry === value);
  if (match === undefined) {
    throw new VerbRejected("arguments", `unknown --issuer ${value}; use one of ${ISSUERS.join(", ")}`);
  }
  return match;
}

export function rejectVerb(
  state: ImplementState,
  entry: { verb: IssuedCommand; issuer: IssuerLabel; target: string | null; reason: string; at: string },
  check: VerbRejectionCheck,
  message: string,
  persist: () => void,
): never {
  recordVerb(state, { ...entry, outcome: "rejected", rejection: { check, message } });
  persist();
  throw new VerbRejected(check, message);
}
