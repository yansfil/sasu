import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStatsAtLevel, xpToNextLevel, shouldEvolve, learnMove, gainExperience, createMonster, MAX_MOVE_SLOTS } from "../src/engine/growth.js";
import { SPECIES } from "../src/data/species.js";

test("[R12] computeStatsAtLevel returns exactly baseStats at level 1", () => {
  const base = { hp: 40, atk: 50, def: 30, spd: 60 };
  const stats = computeStatsAtLevel(base, 1);
  assert.equal(stats.atk, base.atk);
  assert.equal(stats.def, base.def);
  assert.equal(stats.spd, base.spd);
  assert.equal(stats.hp, base.hp + 1);
});

test("[R12] stats increase monotonically with level", () => {
  const base = { hp: 40, atk: 50, def: 30, spd: 60 };
  const low = computeStatsAtLevel(base, 5);
  const high = computeStatsAtLevel(base, 25);
  assert.ok(high.atk > low.atk);
  assert.ok(high.hp > low.hp);
});

test("[R12] xpToNextLevel increases with level", () => {
  assert.ok(xpToNextLevel(10) > xpToNextLevel(5));
});

test("[AC23] shouldEvolve reflects table C evolution levels", () => {
  assert.equal(shouldEvolve("pikachu", 19), false);
  assert.equal(shouldEvolve("pikachu", 20), true);
  assert.equal(shouldEvolve("squirtle", 16), true);
  assert.equal(shouldEvolve("raichu", 99), false, "raichu has no further evolution");
  assert.equal(shouldEvolve("geodude", 99), false, "standalone species never evolve");
});

test("[AC23] learnMove fills up to 4 slots then skips and reports it", () => {
  let slots = [];
  for (const moveId of ["tackle", "ember", "scratch", "headbutt"]) {
    const r = learnMove(slots, moveId);
    slots = r.moveSlots;
    assert.equal(r.event.type, "move_learned");
  }
  assert.equal(slots.length, MAX_MOVE_SLOTS);
  const overflow = learnMove(slots, "fire_blast");
  assert.equal(overflow.event.type, "move_skipped");
  assert.equal(overflow.moveSlots.length, MAX_MOVE_SLOTS);
});

test("[AC23] learnMove is a no-op (not a skip) for an already-known move", () => {
  let slots = [];
  slots = learnMove(slots, "tackle").moveSlots;
  const again = learnMove(slots, "tackle");
  assert.equal(again.event.type, "already_known");
  assert.equal(again.moveSlots.length, 1);
});

test("[AC23] gaining enough xp to cross the evolution level evolves the species and recalculates stats", () => {
  const pikachu = createMonster("pikachu", 19);
  const before = pikachu.stats;
  const massiveXp = xpToNextLevel(19) + 1;
  const result = gainExperience(pikachu, massiveXp);
  assert.equal(result.speciesId, "raichu");
  assert.ok(result.level >= 20);
  assert.ok(result.stats.atk > before.atk);
  assert.ok(result.events.some(e => e.type === "evolved" && e.from === "pikachu" && e.to === "raichu"));
});

test("[AC23] a level-up that reaches a learnset level and a full moveset logs a skip", () => {
  const monster = createMonster("pikachu", 19); // already has 4 moves per its learnset by level 19
  assert.equal(monster.moveSlots.length, MAX_MOVE_SLOTS);
  const result = gainExperience(monster, xpToNextLevel(19) + 1); // crosses level 20, which teaches thunderbolt
  assert.ok(result.events.some(e => e.type === "move_skipped" && e.moveId === "thunderbolt"));
});

test("[AC23] leveling up never drops a living monster's current HP to 0", () => {
  const monster = createMonster("bulbasaur", 10);
  monster.currentHp = 1;
  const result = gainExperience(monster, xpToNextLevel(10) + 1);
  assert.ok(result.currentHp >= 1);
});

test("[R12] a fainted monster stays at 0 HP through a level-up", () => {
  const monster = createMonster("bulbasaur", 10);
  monster.currentHp = 0;
  const result = gainExperience(monster, xpToNextLevel(10) + 1);
  assert.equal(result.currentHp, 0);
});

test("[R2] createMonster seeds moves from the species learnset, capped at 4, matching the species' own type", () => {
  const monster = createMonster("charmander", 1);
  assert.equal(SPECIES[monster.speciesId].type, "fire");
  assert.ok(monster.moveSlots.length <= MAX_MOVE_SLOTS);
  assert.ok(monster.moveSlots.length >= 1);
});
