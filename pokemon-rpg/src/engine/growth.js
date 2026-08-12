// Experience, leveling, stat recalculation, evolution, and move learning
// (R12). Pure engine module; SPECIES/MOVES are imported the same way
// engine/battle.js imports the type chart - data flows one direction only
// (data -> engine), never the reverse.
import { SPECIES } from "../data/species.js";
import { MOVES } from "../data/moves.js";

export const MAX_MOVE_SLOTS = 4;
const HP_GROWTH_RATE = 0.08;
const STAT_GROWTH_RATE = 0.06;

// Tuned so a same-tier trainer fight (TRAINER_XP_PER_LEVEL below) meaningfully
// levels up a solo starter early on - measured empirically via e2e/game.spec.js's
// forest_guardian fight, which previously left a level-5 starter still at
// level 5 (needing 494 xp against a ~126 xp reward) and unable to survive
// the next area's trainer at its declared level floor.
export function xpToNextLevel(level) {
  return Math.floor(8 * Math.pow(level, 1.5));
}

/**
 * Creates a fresh battler-shaped party/wild/trainer member at `level`: the
 * most recent up to 4 learnset moves it would know by that level (the usual
 * roster-generation convention), each at full PP.
 */
export function createMonster(speciesId, level) {
  const species = SPECIES[speciesId];
  const learnableByLevel = species.learnset
    .filter(entry => entry.level <= level)
    .sort((a, b) => a.level - b.level)
    .slice(-MAX_MOVE_SLOTS);
  let moveSlots = [];
  for (const entry of learnableByLevel) {
    moveSlots = learnMove(moveSlots, entry.move).moveSlots;
  }
  const stats = computeStatsAtLevel(species.baseStats, level);
  return { speciesId, level, xp: 0, stats, currentHp: stats.hp, moveSlots };
}

/** @returns {{hp:number, atk:number, def:number, spd:number}} stats at `level`; exactly baseStats at level 1. */
export function computeStatsAtLevel(baseStats, level) {
  return {
    hp: Math.floor(baseStats.hp * (1 + HP_GROWTH_RATE * (level - 1))) + level,
    atk: Math.floor(baseStats.atk * (1 + STAT_GROWTH_RATE * (level - 1))),
    def: Math.floor(baseStats.def * (1 + STAT_GROWTH_RATE * (level - 1))),
    spd: Math.floor(baseStats.spd * (1 + STAT_GROWTH_RATE * (level - 1))),
  };
}

export function shouldEvolve(speciesId, level) {
  const species = SPECIES[speciesId];
  return Boolean(species.evolvesAt != null && species.evolvesInto && level >= species.evolvesAt);
}

/**
 * Attempts to add `moveId` to a 4-slot moveset (R7/R12: 4 slots, skip and
 * log when full). A move already known is a no-op, not a skip.
 */
export function learnMove(moveSlots, moveId) {
  if (moveSlots.some(slot => slot.moveId === moveId)) {
    return { moveSlots, event: { type: "already_known", moveId } };
  }
  if (moveSlots.length >= MAX_MOVE_SLOTS) {
    return { moveSlots, event: { type: "move_skipped", moveId } };
  }
  const data = MOVES[moveId];
  return { moveSlots: [...moveSlots, { moveId, pp: data.pp, maxPp: data.pp }], event: { type: "move_learned", moveId } };
}

/**
 * Applies one battle's worth of experience: level-ups (each rolling any
 * learnset entries at that level through learnMove), then an evolution
 * check, then a stat recalculation that grows maxHp/currentHp together so a
 * level-up or evolution never drops a living monster to 0 HP.
 * @returns {{level:number, xp:number, speciesId:string, stats:object, currentHp:number, moveSlots:object[], events:object[]}}
 */
export function gainExperience(member, xpGained) {
  let { level, xp, speciesId, currentHp, moveSlots } = member;
  xp += xpGained;
  /** @type {object[]} */
  const events = [{ type: "xp_gained", amount: xpGained }];

  while (xp >= xpToNextLevel(level)) {
    xp -= xpToNextLevel(level);
    level += 1;
    events.push({ type: "level_up", level });
    for (const entry of SPECIES[speciesId].learnset) {
      if (entry.level !== level) continue;
      const result = learnMove(moveSlots, entry.move);
      moveSlots = result.moveSlots;
      events.push(result.event);
    }
  }

  if (shouldEvolve(speciesId, level)) {
    const fromId = speciesId;
    speciesId = SPECIES[fromId].evolvesInto;
    events.push({ type: "evolved", from: fromId, to: speciesId });
  }

  const oldMaxHp = computeStatsAtLevel(SPECIES[member.speciesId].baseStats, member.level).hp;
  const stats = computeStatsAtLevel(SPECIES[speciesId].baseStats, level);
  const hpGained = Math.max(0, stats.hp - oldMaxHp);
  const nextCurrentHp = currentHp <= 0 ? 0 : Math.min(stats.hp, currentHp + hpGained);

  return { level, xp, speciesId, stats, currentHp: nextCurrentHp, moveSlots, events };
}
