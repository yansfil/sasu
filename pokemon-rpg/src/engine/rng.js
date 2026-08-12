// Deterministic seeded PRNG (R22). Every probability in the engine flows
// through an instance created here; nothing in src/engine calls the global
// random function that JavaScript exposes on the Math object (AC11 checks
// for a real call site of it).
// mulberry32: small, fast, good-enough distribution for gameplay RNG, pure
// integer/bitwise arithmetic only - no platform-provided randomness.
export function createRng(seed) {
  let state = seed >>> 0;

  function nextFloat() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  return {
    /** @returns {number} float in [0, 1) */
    next: nextFloat,
    /** @param {number} p probability in [0,1] @returns {boolean} */
    chance(p) {
      return nextFloat() < p;
    },
    /** @returns {number} integer in [min, max] inclusive */
    int(min, max) {
      return min + Math.floor(nextFloat() * (max - min + 1));
    },
    /** @returns {number} float in [min, max) */
    range(min, max) {
      return min + nextFloat() * (max - min);
    },
    /** @template T @param {T[]} items @returns {T} */
    pick(items) {
      return items[Math.floor(nextFloat() * items.length)];
    },
    /** @template T @param {{item: T, weight: number}[]} entries @returns {T} */
    weightedPick(entries) {
      const total = entries.reduce((sum, e) => sum + e.weight, 0);
      let roll = nextFloat() * total;
      for (const entry of entries) {
        roll -= entry.weight;
        if (roll <= 0) return entry.item;
      }
      return entries[entries.length - 1].item;
    },
  };
}
