// Wild encounter rolls (R6). Pure engine module - every probability takes
// the injected rng (R22).
import { ENCOUNTERS, BASE_ENCOUNTER_RATE } from "../data/encounters.js";
import { MAPS } from "../data/maps.js";

/** @returns {boolean} whether stepping onto a grass tile triggers an encounter this step. */
export function rollEncounterTriggered({ characterEncounterMultiplier = 1, rng }) {
  const chance = Math.min(1, BASE_ENCOUNTER_RATE * characterEncounterMultiplier);
  return rng.chance(chance);
}

/** @returns {string|null} a species id drawn from `mapId`'s weighted table, or null if the map has none. */
export function pickWildSpecies(mapId, rng) {
  const table = ENCOUNTERS[mapId];
  if (!table || table.length === 0) return null;
  return rng.weightedPick(table.map(entry => ({ item: entry.speciesId, weight: entry.weight })));
}

/** @returns {number} a level within `mapId`'s table B level range. */
export function pickWildLevel(mapId, rng) {
  const [min, max] = MAPS[mapId].levelRange;
  return rng.int(min, max);
}

/** @returns {{speciesId: string, level: number}|null} null when no encounter triggers or the map has no table. */
export function rollWildEncounter({ mapId, characterEncounterMultiplier = 1, rng }) {
  if (!rollEncounterTriggered({ characterEncounterMultiplier, rng })) return null;
  const speciesId = pickWildSpecies(mapId, rng);
  if (!speciesId) return null;
  return { speciesId, level: pickWildLevel(mapId, rng) };
}
