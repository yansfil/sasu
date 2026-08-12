// Turn-based battle core (R7). Pure engine module: no DOM, no globalThis
// Math.random - every probability takes an injected `rng` (src/engine/rng.js).
// Mode policy (wild vs trainer: flee/capture legality, multi-mon queues) is
// layered on top in src/engine/capture.js (T4); this file only knows how to
// resolve one move and order two speeds.
import { TYPE_CHART } from "../data/types.js";

export const CRIT_CHANCE = 1 / 16;
export const CRIT_MULTIPLIER = 1.5;
export const STAB_MULTIPLIER = 1.5;
export const RANDOM_FACTOR_MIN = 0.85;
export const RANDOM_FACTOR_MAX = 1.0;

// Fallback action when every known move is out of PP (R7: "모든 기술의 PP가
// 0이면 대체 행동으로 넘어간다"). Infinite PP so it can never itself run dry.
export const STRUGGLE_MOVE = { id: "struggle", name: "발버둥", type: "normal", power: 40, accuracy: 100, pp: Infinity };

/** @returns {number} multiplier for an attack of `attackType` into `defendType`; 1.0 for any combo table D leaves unlisted. */
export function getTypeEffectiveness(attackType, defendType) {
  const row = TYPE_CHART[attackType];
  if (!row) return 1.0;
  return row[defendType] ?? 1.0;
}

/**
 * R7 damage formula: ((2*Lv/5+2)*Power*Atk/Def)/50+2, times STAB, type
 * effectiveness, crit, a 0.85-1.00 random factor, and (only for the
 * player's side) the active character's damage trait multiplier.
 */
export function calcDamage({ attackerLevel, attackerAtk, defenderDef, move, attackerType, defenderType, rng, characterDamageMultiplier = 1 }) {
  const base = ((2 * attackerLevel) / 5 + 2) * move.power * (attackerAtk / defenderDef) / 50 + 2;
  const stab = move.type === attackerType ? STAB_MULTIPLIER : 1;
  const effectiveness = getTypeEffectiveness(move.type, defenderType);
  const crit = rng.chance(CRIT_CHANCE);
  const critMultiplier = crit ? CRIT_MULTIPLIER : 1;
  const randomFactor = rng.range(RANDOM_FACTOR_MIN, RANDOM_FACTOR_MAX);
  const total = base * stab * effectiveness * critMultiplier * randomFactor * characterDamageMultiplier;
  return { damage: Math.max(1, Math.floor(total)), crit, effectiveness, stab: stab > 1 };
}

export function rollAccuracy(move, rng) {
  return rng.chance(move.accuracy / 100);
}

/**
 * Resolves one move use end to end: accuracy roll, then damage on hit.
 * A miss still reports damage 0 (PP consumption is the caller's job, since
 * it must happen on both hit and miss per R7 - see consumePp below).
 */
export function executeMove({ attacker, defender, move, rng, characterDamageMultiplier = 1 }) {
  const hit = rollAccuracy(move, rng);
  if (!hit) return { hit: false, damage: 0, crit: false, effectiveness: 1, stab: false };
  return {
    hit: true,
    ...calcDamage({
      attackerLevel: attacker.level,
      attackerAtk: attacker.stats.atk,
      defenderDef: defender.stats.def,
      move,
      attackerType: attacker.species.type,
      defenderType: defender.species.type,
      rng,
      characterDamageMultiplier,
    }),
  };
}

/** @returns {"a"|"b"} which battler acts first; ties broken by rng (R7 스피드 기반 선공). */
export function resolveTurnOrder(battlerA, battlerB, rng) {
  if (battlerA.stats.spd > battlerB.stats.spd) return "a";
  if (battlerB.stats.spd > battlerA.stats.spd) return "b";
  return rng.chance(0.5) ? "a" : "b";
}

/** @returns {number|null} index of the move slot to use, or null when every slot is out of PP (struggle). */
export function pickAiMove(moveSlots, rng) {
  const usable = moveSlots
    .map((slot, index) => ({ slot, index }))
    .filter(({ slot }) => slot.pp > 0);
  if (usable.length === 0) return null;
  return rng.pick(usable).index;
}

/** Decrements PP for the used slot; a struggle (moveIndex null) never touches PP. */
export function consumePp(moveSlots, moveIndex) {
  if (moveIndex === null) return moveSlots;
  return moveSlots.map((slot, i) => (i === moveIndex ? { ...slot, pp: Math.max(0, slot.pp - 1) } : slot));
}

/** @returns {boolean} true once no move slot has PP left (R7 대체 행동 조건). */
export function allMovesExhausted(moveSlots) {
  return moveSlots.every(slot => slot.pp <= 0);
}
