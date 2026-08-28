// The acceptance lane fans one judge subprocess out per criterion. The
// 2026-08-27 crawler-arena run launched 22 at once and sustained an effective
// 3.5-7.5x, so the fan-out is now bounded. These pin the two properties a
// caller migrating off Promise.all depends on: input order, and a real
// ceiling.
import assert from "node:assert/strict";
import test from "node:test";
import { judgeFanoutLimit, mapWithConcurrency } from "../../dist/judge/fanout.js";

test("mapWithConcurrency keeps input order regardless of completion order", async () => {
  const items = [40, 5, 30, 1, 20];
  const results = await mapWithConcurrency(items, 3, async (ms, index) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return `${index}:${ms}`;
  });
  assert.deepEqual(results, ["0:40", "1:5", "2:30", "3:1", "4:20"]);
});

test("mapWithConcurrency never exceeds the ceiling", async () => {
  let live = 0;
  let peak = 0;
  await mapWithConcurrency(Array.from({ length: 25 }, (_, i) => i), 4, async () => {
    live += 1;
    peak = Math.max(peak, live);
    await new Promise((resolve) => setTimeout(resolve, 5));
    live -= 1;
  });
  assert.equal(peak, 4, `peak concurrency was ${peak}`);
});

test("mapWithConcurrency runs every item even when the ceiling exceeds the input", async () => {
  const seen = [];
  await mapWithConcurrency([1, 2, 3], 99, async (n) => {
    seen.push(n);
  });
  assert.deepEqual(seen.sort(), [1, 2, 3]);
});

test("mapWithConcurrency rejects the whole call like Promise.all", async () => {
  await assert.rejects(
    () => mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("boom");
      return n;
    }),
    /boom/,
  );
});

test("judgeFanoutLimit stays a bounded derived value, never unbounded", () => {
  const limit = judgeFanoutLimit();
  assert.ok(Number.isInteger(limit), "limit must be an integer");
  assert.ok(limit >= 2, `limit must leave real parallelism, got ${limit}`);
  assert.ok(limit <= 8, `limit must stay under the measured effective ceiling, got ${limit}`);
});

test("mapWithConcurrency starts no new item after a rejection", async () => {
  // The old implementation kept its worker loops running after the caller had
  // already received the rejection, spawning every remaining item in the
  // background. Give the survivors time to misbehave before asserting.
  const started = [];
  await assert.rejects(
    () => mapWithConcurrency(Array.from({ length: 8 }, (_, i) => i), 2, async (n) => {
      started.push(n);
      if (n === 0) throw new Error("boom");
      await new Promise((resolve) => setTimeout(resolve, 20));
      return n;
    }),
    /boom/,
  );
  const seenAtRejection = started.length;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(started.length, seenAtRejection, `items kept starting after the rejection: ${started.join(",")}`);
  assert.ok(started.length <= 3, `at most the in-flight items may have started, got ${started.join(",")}`);
});
