// Single-slot save/load (R17). Pure engine module: `storage` is injected
// (the Web Storage API shape: getItem/setItem/removeItem) so this file
// never touches a global and stays testable under plain node --test.
//
// "맵 개방 상태" (§5's save-target list) is not stored as its own redundant
// field: whether cave/waterway/volcano/boss_room are open is entirely a
// function of questProgress (engine/world.js's isPortalLocked reads quest
// completion, never a separate flag), so persisting questProgress already
// persists map-open state - a second copy would just be a second place for
// the two to drift apart.
import { toSaveShape, fromSaveShape } from "./pokedex.js";

export const SAVE_KEY = "pokemon-rpg-save-v1";
export const SAVE_VERSION = 1;

export function serialize(state) {
  return JSON.stringify({
    version: SAVE_VERSION,
    characterId: state.characterId,
    party: state.party,
    mapId: state.mapId,
    x: state.x,
    y: state.y,
    inventory: state.inventory,
    pokedex: toSaveShape(state.pokedex),
    questProgress: state.questProgress,
    defeatedTrainers: state.defeatedTrainers,
    collectedItemTiles: state.collectedItemTiles,
    endingAchieved: state.endingAchieved,
  });
}

export function deserialize(json) {
  const raw = JSON.parse(json);
  if (raw.version !== SAVE_VERSION) {
    throw new Error(`unsupported save version ${raw.version}, expected ${SAVE_VERSION}`);
  }
  return { ...raw, pokedex: fromSaveShape(raw.pokedex) };
}

export function saveToStorage(storage, state) {
  storage.setItem(SAVE_KEY, serialize(state));
}

export function loadFromStorage(storage) {
  const raw = storage.getItem(SAVE_KEY);
  if (raw === null || raw === undefined) return null;
  return deserialize(raw);
}

export function hasSave(storage) {
  return storage.getItem(SAVE_KEY) !== null && storage.getItem(SAVE_KEY) !== undefined;
}

/** R17: "새로 시작" is destructive and irreversible, so it is a distinct explicit call, never implicit. */
export function clearSave(storage) {
  storage.removeItem(SAVE_KEY);
}

export function recordTrainerDefeat(defeatedTrainers, npcId) {
  if (defeatedTrainers.includes(npcId)) return defeatedTrainers;
  return [...defeatedTrainers, npcId];
}

export function isTrainerDefeated(defeatedTrainers, npcId) {
  return defeatedTrainers.includes(npcId);
}

export function itemTileKey(mapId, x, y) {
  return `${mapId}:${x},${y}`;
}

export function recordItemCollected(collectedItemTiles, mapId, x, y) {
  const key = itemTileKey(mapId, x, y);
  if (collectedItemTiles.includes(key)) return collectedItemTiles;
  return [...collectedItemTiles, key];
}

export function isItemCollected(collectedItemTiles, mapId, x, y) {
  return collectedItemTiles.includes(itemTileKey(mapId, x, y));
}
