import { test } from "node:test";
import assert from "node:assert/strict";
import { createRng } from "../src/engine/rng.js";
import { rollEncounterTriggered, pickWildSpecies, pickWildLevel, rollWildEncounter } from "../src/engine/encounter.js";
import { ENCOUNTERS } from "../src/data/encounters.js";
import { MAPS } from "../src/data/maps.js";

test("[R6] a higher character multiplier triggers encounters more often over many rolls", () => {
  const rng1 = createRng(10);
  const rng2 = createRng(10);
  let baseHits = 0;
  let boostedHits = 0;
  for (let i = 0; i < 2000; i++) {
    if (rollEncounterTriggered({ characterEncounterMultiplier: 1, rng: rng1 })) baseHits++;
    if (rollEncounterTriggered({ characterEncounterMultiplier: 1.2, rng: rng2 })) boostedHits++;
  }
  assert.ok(boostedHits > baseHits, `expected boosted (${boostedHits}) > base (${baseHits})`);
});

test("[AC7] every field map only ever produces species declared in its own encounter table", () => {
  const rng = createRng(2026);
  for (const mapId of Object.keys(ENCOUNTERS)) {
    const allowed = new Set(ENCOUNTERS[mapId].map(e => e.speciesId));
    for (let i = 0; i < 500; i++) {
      const speciesId = pickWildSpecies(mapId, rng);
      assert.ok(allowed.has(speciesId), `${mapId} produced unlisted species ${speciesId}`);
    }
  }
});

test("[AC7] mew only ever appears in the volcano table", () => {
  for (const [mapId, table] of Object.entries(ENCOUNTERS)) {
    const hasMew = table.some(e => e.speciesId === "mew");
    if (mapId === "volcano") assert.equal(hasMew, true);
    else assert.equal(hasMew, false, `${mapId} must not list mew`);
  }
});

test("[R6] pickWildLevel stays within the map's table B level range", () => {
  const rng = createRng(1);
  for (const mapId of Object.keys(ENCOUNTERS)) {
    const [min, max] = MAPS[mapId].levelRange;
    for (let i = 0; i < 200; i++) {
      const level = pickWildLevel(mapId, rng);
      assert.ok(level >= min && level <= max, `${mapId} produced out-of-range level ${level}`);
    }
  }
});

test("[R6] rollWildEncounter returns null when the roll does not trigger", () => {
  const alwaysMiss = { chance: () => false };
  assert.equal(rollWildEncounter({ mapId: "forest", rng: alwaysMiss }), null);
});

test("[R6] rollWildEncounter returns a species+level pair when triggered", () => {
  const alwaysHit = { chance: () => true, weightedPick: entries => entries[0].item, int: (min) => min };
  const result = rollWildEncounter({ mapId: "cave", rng: alwaysHit });
  assert.ok(result.speciesId);
  assert.ok(result.level >= MAPS.cave.levelRange[0]);
});
