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
 * Who may issue what.
 *
 * The label is a DECLARATION, not an authentication. The CLI cannot tell a
 * supervisor typing `--issuer human` from the human (PRD 10장, D-39): this
 * table encodes intent and produces an audit record, and the mitigation for a
 * false declaration is the transcript, not this code. Treating it as a
 * security boundary would be a mistake.
 *
 * What it does buy is the thing R16 ② asked for: the supervisor is meant to
 * be read-only over implementation, and until now nothing but self-restraint
 * stopped it from closing a task or registering an artifact. Now the code
 * says so.
 */
export const COMMAND_AUTHORITY: Record<IssuedCommand, IssuerLabel[]> = {
  artifact: ["implementor", "human"],
  verify: ["implementor", "human"],
  finalize: ["implementor", "human"],
  risk: ["implementor", "human"],
  retire: ["implementor", "human"],
  confirm: ["human"],
  escalate: ["observer", "human"],
  "risk-non-convergent": ["human"],
  amend: ["human"],
};

/**
 * The runtime spelling of the vocabulary, derived from the authority table
 * rather than typed out beside it. The store validates against this, so a
 * command the gate accepts can never be a verb the next read refuses - which
 * is exactly what happened when the two lists were written separately.
 */
export const ISSUED_COMMANDS = Object.keys(COMMAND_AUTHORITY) as IssuedCommand[];

/**
 * Subcommands that are deliberately ungated, and why.
 *
 * The gate is fail-open on a command it does not know, which is right for
 * these - anyone may look at a run, and `start`/`await` are not
 * state changes an issuer label means anything about. It is wrong for a
 * command someone forgets to add to the table, so the two lists are compared
 * against the dispatcher by test (implement-authority) rather than trusted to
 * stay in step. Fail-closed instead would mean listing every read-only
 * surface in an authority table, which is the same list one indirection away.
 */
// `dispatch` belongs here for the same reason as `start`: it runs before a
// run exists, so there is no verb history to attribute an issuer label to.
// Its guard is not a declaration anyway - dispatchImplementor refuses a pane
// already marked SASU_HERDR_ROLE=implementor, which is structural and cannot
// be typed around the way `--issuer` can.
export const UNGATED_COMMANDS = ["intake", "start", "status", "await", "dispatch"] as const;

export function isIssuedCommand(value: string): value is IssuedCommand {
  return (ISSUED_COMMANDS as string[]).includes(value);
}

export function assertCommandAuthority(command: string, issuer: IssuerLabel): void {
  if (!isIssuedCommand(command)) return;
  const allowed = COMMAND_AUTHORITY[command];
  if (allowed.includes(issuer)) return;
  throw new VerbRejected(
    "authority",
    `${issuer} may not issue \`sasu implement ${command}\`; this command is limited to ${allowed.join(", ")}. Issuer labels are self-declared and recorded for audit, not authenticated.`,
  );
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
