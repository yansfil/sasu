// Pokedex tracking (R16). Pure engine module; sighted/caught sets are plain
// arrays at the state boundary (save.js serializes them) but handled as
// Sets internally for O(1) membership checks.
export const CAUGHT_ACHIEVEMENT_THRESHOLD = 12;

export function createPokedex() {
  return { seen: new Set(), caught: new Set() };
}

export function recordSeen(pokedex, speciesId) {
  return { seen: new Set(pokedex.seen).add(speciesId), caught: pokedex.caught };
}

export function recordCaught(pokedex, speciesId) {
  return { seen: new Set(pokedex.seen).add(speciesId), caught: new Set(pokedex.caught).add(speciesId) };
}

export function caughtCount(pokedex) {
  return pokedex.caught.size;
}

/** R16: achievement is independent of the ending condition. */
export function hasAchievement(pokedex) {
  return caughtCount(pokedex) >= CAUGHT_ACHIEVEMENT_THRESHOLD;
}

export function toSaveShape(pokedex) {
  return { seen: [...pokedex.seen], caught: [...pokedex.caught] };
}

export function fromSaveShape(shape) {
  return { seen: new Set(shape?.seen || []), caught: new Set(shape?.caught || []) };
}
