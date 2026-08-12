// Overworld movement, tile effects, and mission gating (R3, R4, R5, R6).
// Pure engine module: takes map/quest state as plain data, returns plain
// descriptors; the DOM-touching camera/rendering is entirely T9's job.
import { MAPS } from "../data/maps.js";

export const DIRECTIONS = {
  up: { dx: 0, dy: -1 },
  down: { dx: 0, dy: 1 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
};

const BLOCKING_TILES = new Set(["#", "~", "^"]);

export function tileAt(map, x, y) {
  const row = map.grid[y];
  if (row === undefined) return null;
  return row[x] ?? null;
}

export function isWalkable(map, x, y, npcOccupiedSet = null) {
  const tile = tileAt(map, x, y);
  if (tile === null || BLOCKING_TILES.has(tile)) return false;
  if (npcOccupiedSet && npcOccupiedSet.has(`${x},${y}`)) return false;
  return true;
}

export function computeNextPosition(x, y, direction) {
  const delta = DIRECTIONS[direction];
  if (!delta) throw new Error(`unknown direction: ${direction}`);
  return { x: x + delta.dx, y: y + delta.dy };
}

/**
 * `portal` is a MAPS[id].portals entry. `questState` is
 * `{ isQuestComplete(id): boolean, allMainComplete: boolean, endingAchieved: boolean }`.
 * R15: the "ALL_MAIN"-gated boss room additionally refuses re-entry once the
 * ending has been achieved (AC20), on top of requiring all 4 main missions.
 */
export function isPortalLocked(portal, questState) {
  if (portal.locked === null) return false;
  if (portal.locked === "ALL_MAIN") return !questState.allMainComplete || Boolean(questState.endingAchieved);
  return !questState.isQuestComplete(portal.locked);
}

/**
 * Resolves one step of movement: collision, then portal gating. Never
 * mutates anything - the caller applies the returned position/transition.
 */
export function resolveMove(mapId, x, y, direction, questState, npcOccupiedSet = null) {
  const map = MAPS[mapId];
  const { x: nx, y: ny } = computeNextPosition(x, y, direction);
  if (!isWalkable(map, nx, ny, npcOccupiedSet)) {
    return { moved: false, reason: "blocked", x, y };
  }
  const portal = map.portals[`${nx},${ny}`];
  if (portal) {
    if (isPortalLocked(portal, questState)) {
      return { moved: false, reason: "locked", lockedBy: portal.locked, x, y };
    }
    return { moved: true, reason: null, x: nx, y: ny, transition: { toMap: portal.toMap, toX: portal.toX, toY: portal.toY } };
  }
  return { moved: true, reason: null, x: nx, y: ny, transition: null };
}

/** @returns {{type: "item"|"sign"|"heal"|"grass"|"none", item?: object, text?: string}} */
export function getTileEffect(mapId, x, y) {
  const map = MAPS[mapId];
  const tile = tileAt(map, x, y);
  const key = `${x},${y}`;
  if (tile === "I" && map.items[key]) return { type: "item", item: map.items[key] };
  if (tile === "S" && map.signs[key]) return { type: "sign", text: map.signs[key] };
  if (tile === "H") return { type: "heal" };
  if (tile === "G" && map.kind === "field") return { type: "grass" };
  return { type: "none" };
}
