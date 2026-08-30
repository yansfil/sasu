import type { ImplementEvent, ImplementEventKind, ImplementState, IssuerLabel } from "./types";

/**
 * Append one event to the run's log.
 *
 * The id is derived from the log itself (max + 1) rather than from a stored
 * counter, so the record cannot drift from its own ledger. Events are never
 * edited or removed for the life of the run (AC24); this is the only function
 * that writes to the array.
 */
export function recordEvent(
  state: ImplementState,
  entry: { kind: ImplementEventKind; actor: IssuerLabel; subject: string | null; summary: string; at: string },
): ImplementEvent {
  const event: ImplementEvent = {
    id: Math.max(0, ...state.events.map((existing) => existing.id)) + 1,
    at: entry.at,
    kind: entry.kind,
    actor: entry.actor,
    subject: entry.subject,
    summary: entry.summary,
  };
  state.events.push(event);
  return event;
}

/** Events strictly after `since`, in order. `null` means from the beginning. */
export function eventsSince(state: ImplementState, since: number | null): ImplementEvent[] {
  if (since === null) return [...state.events];
  return state.events.filter((event) => event.id > since);
}
