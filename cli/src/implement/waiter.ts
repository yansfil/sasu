import type { ImplementEvent, ImplementState } from "./types";
import { eventsSince } from "./events";

/**
 * How often the waiter re-reads the record.
 *
 * Stat polling rather than fs.watch, because state.json is replaced by atomic
 * rename: a watch bound to the old inode stops firing after the first write,
 * which is the one case the waiter exists for. One second is far below any
 * human-relevant latency and costs a stat per second.
 *
 * This is NOT the 250ms pane poll that herdr_observer.js used and this PRD
 * removes. That one sampled terminal text, which is not a semantic unit and
 * cannot say what happened; this one waits on the harness's own event log
 * (D-16, D-19).
 */
export const WAITER_POLL_MS = 1_000;

export type WaitReason = "event" | "stall" | "implementor-gone";

export interface WaitOutcome {
  reason: WaitReason;
  /** Events strictly after the cursor. Empty for stall and implementor-gone. */
  events: ImplementEvent[];
  /** Cursor to pass to the next `--since`; the newest id the caller has seen. */
  cursor: number;
  waitedMs: number;
  detail: string;
}

export interface WaitOptions {
  /** Re-read from disk on every poll; the writer is another process. */
  loadState: () => ImplementState;
  since: number | null;
  stallMs: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Liveness probe for the implementor, or null when the environment cannot
   * answer. Null degrades honestly: the outcome says the probe was
   * unavailable instead of pretending the implementor is alive (R9).
   */
  isAlive?: (() => boolean) | null;
}

const newestId = (state: ImplementState): number => state.events.at(-1)?.id ?? 0;

/**
 * Wait once, and return for exactly one reason (AC22).
 *
 * The three reasons are the three ways a supervisor's wait can end: something
 * happened, nothing happened for too long, or the thing it was waiting on
 * stopped existing. There is deliberately no timeout as a fourth reason - the
 * stall bound IS the timeout, so this always returns within `stallMs`.
 */
export async function waitForEvent(options: WaitOptions): Promise<WaitOutcome> {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const pollMs = options.pollMs ?? WAITER_POLL_MS;
  const isAlive = options.isAlive ?? null;
  const startedAt = now();

  // AC23: anything already past the cursor is returned without waiting. A
  // waiter that slept first would lose every event produced between the
  // supervisor reading its last batch and re-arming - the exact window in
  // which the implementor is most likely to be working.
  const first = options.loadState();
  const pending = eventsSince(first, options.since);
  if (pending.length > 0) {
    return {
      reason: "event",
      events: pending,
      cursor: pending.at(-1)!.id,
      waitedMs: 0,
      detail: `${pending.length} event(s) were already past cursor ${options.since ?? 0}; returned without waiting`,
    };
  }

  // AC25: measured from the last recorded event, not from when this waiter
  // started. The question is how long the RUN has been silent, and re-arming
  // the waiter must not reset that clock - otherwise a supervisor that keeps
  // re-arming could never observe a stall.
  const lastEventAt = first.events.at(-1)?.at;
  const silentSince = lastEventAt === undefined ? startedAt : Date.parse(lastEventAt);
  const deadline = (Number.isNaN(silentSince) ? startedAt : silentSince) + options.stallMs;

  let cursor = options.since ?? newestId(first);
  while (true) {
    if (isAlive !== null && !isAlive()) {
      return {
        reason: "implementor-gone",
        events: [],
        cursor,
        waitedMs: now() - startedAt,
        detail: "the implementor process is no longer alive; nothing further will be recorded by it",
      };
    }
    if (now() >= deadline) {
      const silence = Math.round((now() - (Number.isNaN(silentSince) ? startedAt : silentSince)) / 1000);
      return {
        reason: "stall",
        events: [],
        cursor,
        waitedMs: now() - startedAt,
        detail: `no event for ${silence}s, past the ${Math.round(options.stallMs / 1000)}s no-progress bound${isAlive === null ? "; liveness could not be probed in this environment" : ""}`,
      };
    }
    await sleep(pollMs);
    const state = options.loadState();
    const fresh = eventsSince(state, cursor);
    if (fresh.length > 0) {
      return {
        reason: "event",
        events: fresh,
        cursor: fresh.at(-1)!.id,
        waitedMs: now() - startedAt,
        detail: `${fresh.length} new event(s)`,
      };
    }
  }
}
