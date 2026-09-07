import type { ImplementEvent, ImplementState } from "./types";
import { eventsSince } from "./events";
import { waitForAgent, type AgentWaitObservation } from "./herdr";
import { setTimeout as delay } from "node:timers/promises";

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
  /** Automatically carried by the CLI, never written to the run record. */
  notifyAfter?: number;
  observationProblem?: string;
}

export interface WaitOptions {
  /** Re-read from disk on every poll; the writer is another process. */
  loadState: () => ImplementState;
  since: number | null;
  stallMs: number;
  notifyAfter?: number;
  observationProblem?: string;
  /** Named targets use one bounded child instead of alive polling. */
  agent?: string;
  /**
   * The bounded observation itself, injectable for the same reason the herdr
   * adapter injects `run`: the race between an event and a child exit has no
   * other seam, and a test that has to spawn herdr to reach it would not be
   * written (engineering practice: price a test before writing it).
   */
  observe?: typeof waitForAgent;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Liveness probe for the implementor, or null when the environment cannot
   * answer. Null degrades honestly: the outcome says the probe was
   * unavailable instead of pretending the implementor is alive (R9).
   */
  isAlive?: (() => boolean | null) | null;
}

const newestId = (state: ImplementState): number => state.events.at(-1)?.id ?? 0;

/**
 * Event evidence owns progress. Terminal observations only bring inspection
 * forward once per silence interval; the CLI carries that consumption in
 * notifyAfter, leaving the run record read-only.
 */
export async function waitForEvent(options: WaitOptions): Promise<WaitOutcome> {
  const now = options.now ?? (() => Date.now());
  const polling = new AbortController();
  const sleep = options.sleep ?? ((ms: number) => delay(ms, undefined, { signal: polling.signal }).catch((error) => {
    if (!polling.signal.aborted) throw error;
  }));
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
  const silentSince = Date.parse(first.events.at(-1)?.at ?? first.createdAt);
  if (!Number.isFinite(silentSince)) throw new Error("cannot measure silence: invalid event or run creation timestamp");
  const longDeadline = silentSince + options.stallMs;
  const deadline = Math.max(longDeadline, options.notifyAfter ?? 0);
  const cursor = options.since ?? newestId(first);
  const target = new AbortController();
  const consumed = options.agent !== undefined && options.notifyAfter !== undefined;
  const tradeoff = "early inspection is consumed for this silence interval; no per-second target-loss detection remains until a new event; inspect again at the long notification deadline";
  let observationProblem = options.observationProblem ?? (options.agent === undefined && isAlive === null
    ? "liveness could not be probed in this environment" : "");
  const schedulingDetail = consumed ? tradeoff : "";
  let observed: AgentWaitObservation | undefined;
  // A re-arm carries a notification time only after a wake. Starting another
  // short wait here would either spin on settled or create a blind window.
  const child = options.agent !== undefined && !consumed && now() < deadline
    ? (options.observe ?? waitForAgent)({ name: options.agent, timeoutMs: deadline - now(), signal: target.signal }).then((value) => { observed = value; })
    : null;
  let childPending = child;
  const detail = (message: string): string => [message, observationProblem, schedulingDetail].filter(Boolean).join("; ");
  const result = (reason: WaitReason, message: string, notifyAfter?: number): WaitOutcome => ({
    reason, events: [], cursor, waitedMs: now() - startedAt, detail: detail(message),
    ...(observationProblem === "" ? {} : { observationProblem }),
    ...(notifyAfter === undefined ? {} : { notifyAfter }),
  });
  try {
    while (true) {
      // Read before interpreting the child, including when both became ready.
      const fresh = eventsSince(options.loadState(), cursor);
      if (fresh.length > 0) {
        const degradation = observed?.kind === "unavailable" ? `; ${observed.detail}` : "";
        return { reason: "event", events: fresh, cursor: fresh.at(-1)!.id, waitedMs: now() - startedAt,
          detail: detail(`${fresh.length} new event(s)${degradation}`),
          ...(observationProblem === "" && degradation === "" ? {} : { observationProblem: observationProblem || observed?.detail }) };
      }
      if (observed !== undefined) {
        const observation = observed;
        observed = undefined;
        childPending = null;
        if (observation.kind === "gone") return result("implementor-gone", observation.detail);
        if (observation.kind === "settled" && now() < deadline) {
          return result("stall", `early inspection candidate: ${observation.detail}; ${tradeoff}`, longDeadline);
        }
        observationProblem = observation.detail;
      }
      if (options.agent === undefined && isAlive !== null) {
        try {
          const alive = isAlive();
          if (alive === false) return result("implementor-gone", "the watched target can no longer be followed; inspect before deciding on recovery");
          if (alive === null) observationProblem = "liveness observation unavailable; event and time monitoring continued";
        } catch (error) {
          observationProblem = `liveness observation failed: ${String(error)}; event and time monitoring continued`;
        }
      }
      if (now() >= deadline) {
        if (childPending !== null) observationProblem = "settled was not confirmed before the parent deadline; event and time monitoring continued";
        return result("stall", `no event for ${Math.round((now() - silentSince) / 1000)}s, past the ${Math.round(options.stallMs / 1000)}s no-progress bound`, now() + options.stallMs);
      }
      const tick = sleep(Math.min(pollMs, Math.max(0, deadline - now())));
      await (childPending === null ? tick : Promise.race([tick, childPending]));
    }
  } finally {
    // Every exit, event race, and read exception owns the same cancellation.
    // Awaiting disposal prevents a one-shot returning with a live wait child.
    polling.abort();
    target.abort();
    await child;
  }
}
