import { test } from "node:test";
import assert from "node:assert/strict";
import { createRng } from "../src/engine/rng.js";
import {
  getTypeEffectiveness,
  calcDamage,
  executeMove,
  resolveTurnOrder,
  pickAiMove,
  consumePp,
  allMovesExhausted,
  STRUGGLE_MOVE,
} from "../src/engine/battle.js";
import { TYPES, TYPE_CHART } from "../src/data/types.js";

test("[AC10] every one of the 49 type combinations matches table D, no x0", () => {
  let checked = 0;
  for (const atk of TYPES) {
    for (const def of TYPES) {
      checked++;
      const expected = TYPE_CHART[atk]?.[def] ?? 1.0;
      assert.equal(getTypeEffectiveness(atk, def), expected);
      assert.notEqual(getTypeEffectiveness(atk, def), 0);
    }
  }
  assert.equal(checked, 49);
});

test("[AC11] same seed reproduces identical damage, crit, and effectiveness", () => {
  const scenario = {
    attackerLevel: 15, attackerAtk: 50, defenderDef: 45,
    move: { type: "electric", power: 65, accuracy: 100, pp: 20 },
    attackerType: "electric", defenderType: "water",
  };
  const runOnce = () => calcDamage({ ...scenario, rng: createRng(2024) });
  const a = runOnce();
  const b = runOnce();
  assert.deepEqual(a, b);
});

test("[AC11] STAB applies only when move type matches attacker type", () => {
  const rng = createRng(1);
  const withStab = calcDamage({
    attackerLevel: 10, attackerAtk: 40, defenderDef: 40,
    move: { type: "fire", power: 50, accuracy: 100, pp: 10 },
    attackerType: "fire", defenderType: "normal", rng: createRng(1),
  });
  const withoutStab = calcDamage({
    attackerLevel: 10, attackerAtk: 40, defenderDef: 40,
    move: { type: "fire", power: 50, accuracy: 100, pp: 10 },
    attackerType: "water", defenderType: "normal", rng: createRng(1),
  });
  assert.equal(withStab.stab, true);
  assert.equal(withoutStab.stab, false);
});

test("[R7] character damage multiplier scales the final damage", () => {
  const scenario = {
    attackerLevel: 12, attackerAtk: 45, defenderDef: 40,
    move: { type: "normal", power: 40, accuracy: 100, pp: 10 },
    attackerType: "normal", defenderType: "normal",
  };
  const base = calcDamage({ ...scenario, rng: createRng(5), characterDamageMultiplier: 1 });
  const boosted = calcDamage({ ...scenario, rng: createRng(5), characterDamageMultiplier: 1.1 });
  assert.ok(boosted.damage >= base.damage);
});

test("[R7] a missed move deals 0 damage but is still reported as a miss", () => {
  const alwaysMiss = { chance: () => false, range: a => a, pick: arr => arr[0] };
  const result = executeMove({
    attacker: { level: 10, stats: { atk: 40 }, species: { type: "normal" } },
    defender: { level: 10, stats: { def: 40 }, species: { type: "normal" } },
    move: { type: "normal", power: 40, accuracy: 50, pp: 10 },
    rng: alwaysMiss,
  });
  assert.equal(result.hit, false);
  assert.equal(result.damage, 0);
});

test("[R7] speed-based turn order picks the faster battler", () => {
  const rng = createRng(1);
  assert.equal(resolveTurnOrder({ stats: { spd: 90 } }, { stats: { spd: 30 } }, rng), "a");
  assert.equal(resolveTurnOrder({ stats: { spd: 10 } }, { stats: { spd: 30 } }, rng), "b");
});

test("[R7] tied speed still resolves deterministically for a fixed seed", () => {
  const order1 = resolveTurnOrder({ stats: { spd: 50 } }, { stats: { spd: 50 } }, createRng(9));
  const order2 = resolveTurnOrder({ stats: { spd: 50 } }, { stats: { spd: 50 } }, createRng(9));
  assert.equal(order1, order2);
});

test("[AC12] a move slot at 0 PP cannot be selected", () => {
  const slots = [{ pp: 0 }, { pp: 5 }, { pp: 0 }, { pp: 0 }];
  const rng = createRng(1);
  for (let i = 0; i < 30; i++) {
    assert.equal(pickAiMove(slots, rng), 1);
  }
});

test("[AC12] all-zero PP falls back to struggle (null index)", () => {
  const slots = [{ pp: 0 }, { pp: 0 }, { pp: 0 }, { pp: 0 }];
  assert.equal(allMovesExhausted(slots), true);
  assert.equal(pickAiMove(slots, createRng(1)), null);
  assert.ok(STRUGGLE_MOVE.pp === Infinity);
});

test("[AC12] consumePp decrements only the used slot; struggle leaves PP untouched", () => {
  const slots = [{ pp: 3 }, { pp: 3 }];
  const after = consumePp(slots, 0);
  assert.equal(after[0].pp, 2);
  assert.equal(after[1].pp, 3);
  const struggleAfter = consumePp(slots, null);
  assert.deepEqual(struggleAfter, slots);
});
