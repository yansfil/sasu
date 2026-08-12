// Rival assignment and final-battle party (R15). Pure engine module.
import { CHARACTERS, CHARACTER_CYCLE } from "../data/characters.js";
import { SPECIES } from "../data/species.js";
import { createMonster } from "./growth.js";

export const BOSS_SPECIES_ID = "moltres";
export const RIVAL_FILLER_SPECIES_ID = "geodude";
export const RIVAL_PARTY_LEVEL = 28;

/** @returns {string} the character id assigned as rival: the next entry after `chosenCharacterId` in the fixed cycle. */
export function assignRival(chosenCharacterId) {
  const index = CHARACTER_CYCLE.indexOf(chosenCharacterId);
  if (index === -1) throw new Error(`unknown character: ${chosenCharacterId}`);
  return CHARACTER_CYCLE[(index + 1) % CHARACTER_CYCLE.length];
}

function finalEvolutionOf(speciesId) {
  let current = SPECIES[speciesId];
  while (current.evolvesInto) current = SPECIES[current.evolvesInto];
  return current.id;
}

/**
 * R15: exactly 3 members, always including the rival's starter's final
 * evolution and the boss-only species (파이어/moltres).
 */
export function buildRivalParty(chosenCharacterId, level = RIVAL_PARTY_LEVEL) {
  const rivalCharacterId = assignRival(chosenCharacterId);
  const rivalStarterFinal = finalEvolutionOf(CHARACTERS[rivalCharacterId].partnerSpeciesId);
  const speciesIds = [rivalStarterFinal, BOSS_SPECIES_ID, RIVAL_FILLER_SPECIES_ID];
  return {
    rivalCharacterId,
    party: speciesIds.map(speciesId => createMonster(speciesId, level)),
  };
}
