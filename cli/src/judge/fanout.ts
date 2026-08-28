import os from "node:os";

/**
 * Ceiling on judge subprocesses one lane may hold in flight.
 *
 * Measured on the 2026-08-27 crawler-arena run: the acceptance lane launched
 * all 22 criteria inside the same second, but sum-of-per-criterion-judge-
 * seconds divided by the lane's wall clock came out at 3.5x (attempt 4),
 * 5.5x (attempt 2) and 7.5x (attempt 3). The machine never sustained 22
 * concurrent codex/claude processes - it oversubscribed and the lane still
 * cost its slowest criterion. Bounding at the effective ceiling therefore
 * gives up no observed throughput, and stops a lane from competing with the
 * project's own build, dev server and browsers on the same box.
 *
 * Derived, never configured: a knob here would be a contract the human has to
 * reason about for no decision they can actually make better (PRINCIPLES 7).
 */
export function judgeFanoutLimit(): number {
  return Math.max(2, Math.min(8, os.cpus().length - 2));
}

/**
 * `Promise.all(items.map(fn))` with a concurrency ceiling. Results keep input
 * order and one rejection rejects the whole call. Stricter than Promise.all
 * on one point: after a rejection no NEW item is started (in-flight items
 * finish; promises cannot be cancelled). Without that stop, a caller that has
 * already received the rejection would keep spawning judge subprocesses in
 * the background - latent today only because judgeLane never rejects.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index]!, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}
