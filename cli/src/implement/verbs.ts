import type { ImplementState, IssuerLabel, ObserverVerb, VerbRecord, VerbRejectionCheck } from "./types";

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
export function rejectVerb(
  state: ImplementState,
  entry: { verb: ObserverVerb; issuer: IssuerLabel; target: string | null; reason: string; at: string },
  check: VerbRejectionCheck,
  message: string,
  persist: () => void,
): never {
  recordVerb(state, { ...entry, outcome: "rejected", rejection: { check, message } });
  persist();
  throw new VerbRejected(check, message);
}

/**
 * Reorder the pending tasks.
 *
 * Deliberately the smallest thing that could work: one validation (is this a
 * permutation of exactly the pending set?) and one write (fill the pending
 * slots in the given order). No dependency inference, no relative-position
 * syntax, no priority field.
 *
 * It invalidates nothing. `dependsOn` is materialized when the PRD is parsed
 * and stored per task, so array order carries no dependency meaning and
 * moving a task cannot change what gates it (R6, AC18). Reordering a COMPLETE
 * task is not resequencing but undoing, and belongs to park or amendment - so
 * completed and blocked tasks keep their slots and may not be named.
 */
export function resequencePendingTasks(state: ImplementState, order: string[]): string[] {
  const pending = state.tasks.filter((task) => task.status === "pending").map((task) => task.id);
  const requested = order.map((id) => id.trim().toUpperCase()).filter((id) => id !== "");

  const seen = new Set<string>();
  for (const id of requested) {
    if (seen.has(id)) throw new Error(`resequence lists ${id} more than once; give each pending task exactly once`);
    seen.add(id);
  }
  const pendingSet = new Set(pending);
  const notPending = requested.filter((id) => !pendingSet.has(id));
  if (notPending.length > 0) {
    const known = new Set(state.tasks.map((task) => task.id));
    throw new Error(notPending.every((id) => known.has(id))
      ? `resequence may only reorder pending tasks; ${notPending.join(", ")} is not pending. Moving a finished task is undoing it, which is park or amendment, not resequence.`
      : `unknown task(s) in resequence: ${notPending.filter((id) => !known.has(id)).join(", ")}`);
  }
  const missing = pending.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    throw new Error(`resequence must name every pending task exactly once; missing ${missing.join(", ")}. A partial order would leave the rest in an order nobody chose.`);
  }

  // Fill the pending slots in the requested order, leaving every non-pending
  // task exactly where it was.
  const queue = requested.map((id) => state.tasks.find((task) => task.id === id)!);
  let next = 0;
  state.tasks = state.tasks.map((task) => (task.status === "pending" ? queue[next++]! : task));
  return requested;
}
