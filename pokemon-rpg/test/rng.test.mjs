import { test } from "node:test";
import assert from "node:assert/strict";
import { createRng } from "../src/engine/rng.js";

test("[R22] same seed produces the same sequence", () => {
  const a = createRng(123);
  const b = createRng(123);
  const seqA = Array.from({ length: 20 }, () => a.next());
  const seqB = Array.from({ length: 20 }, () => b.next());
  assert.deepEqual(seqA, seqB);
});

test("[R22] different seeds diverge", () => {
  const a = createRng(1);
  const b = createRng(2);
  const seqA = Array.from({ length: 10 }, () => a.next());
  const seqB = Array.from({ length: 10 }, () => b.next());
  assert.notDeepEqual(seqA, seqB);
});

test("[R22] next() stays within [0, 1)", () => {
  const rng = createRng(999);
  for (let i = 0; i < 500; i++) {
    const v = rng.next();
    assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
  }
});

test("[R22] chance(1) is always true and chance(0) is always false", () => {
  const rng = createRng(7);
  for (let i = 0; i < 20; i++) {
    assert.equal(rng.chance(1), true);
    assert.equal(rng.chance(0), false);
  }
});

test("[R22] int(min,max) stays within inclusive bounds", () => {
  const rng = createRng(55);
  for (let i = 0; i < 200; i++) {
    const v = rng.int(3, 7);
    assert.ok(v >= 3 && v <= 7, `out of range: ${v}`);
  }
});

test("[R22] weightedPick respects zero-weight exclusion", () => {
  const rng = createRng(3);
  for (let i = 0; i < 50; i++) {
    const picked = rng.weightedPick([{ item: "a", weight: 1 }, { item: "b", weight: 0 }]);
    assert.equal(picked, "a");
  }
});
