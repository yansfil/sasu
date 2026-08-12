import { test } from "node:test";
import assert from "node:assert/strict";
import { tileAt, isWalkable, computeNextPosition, isPortalLocked, resolveMove, getTileEffect } from "../src/engine/world.js";
import { MAPS } from "../src/data/maps.js";

function questState(completedIds, { allMainComplete = false, endingAchieved = false } = {}) {
  return {
    isQuestComplete: id => completedIds.includes(id),
    allMainComplete,
    endingAchieved,
  };
}

test("[R3] wall/water/rock tiles block movement; path/grass/door do not", () => {
  const map = MAPS.forest;
  assert.equal(isWalkable(map, 0, 0), false); // border wall
  assert.equal(isWalkable(map, 4, 2), true); // grass
  assert.equal(isWalkable(map, 9, 7), true); // door
});

test("[R3] computeNextPosition applies the 4 directions", () => {
  assert.deepEqual(computeNextPosition(5, 5, "up"), { x: 5, y: 4 });
  assert.deepEqual(computeNextPosition(5, 5, "down"), { x: 5, y: 6 });
  assert.deepEqual(computeNextPosition(5, 5, "left"), { x: 4, y: 5 });
  assert.deepEqual(computeNextPosition(5, 5, "right"), { x: 6, y: 5 });
  assert.throws(() => computeNextPosition(0, 0, "diagonal"));
});

test("[AC8] entering an unopened field map is refused and names the blocking quest", () => {
  const forest = MAPS.forest;
  const cavePortal = forest.portals["9,7"];
  assert.equal(isPortalLocked(cavePortal, questState([])), true);
  const move = resolveMove("forest", 8, 7, "right", questState([]));
  assert.equal(move.moved, false);
  assert.equal(move.reason, "locked");
  assert.equal(move.lockedBy, "forest_main");
});

test("[AC8] completing the gating main quest opens the next field map", () => {
  const move = resolveMove("forest", 8, 7, "right", questState(["forest_main"]));
  assert.equal(move.moved, true);
  assert.equal(move.transition.toMap, "cave");
});

test("[R5] a blocked move never changes position", () => {
  const move = resolveMove("cave", 8, 7, "right", questState([]));
  assert.equal(move.moved, false);
  assert.equal(move.x, 8);
  assert.equal(move.y, 7);
});

test("[AC20] the boss room gate needs all 4 main quests and refuses re-entry after the ending", () => {
  const volcano = MAPS.volcano;
  const bossPortal = volcano.portals["9,7"];
  assert.equal(isPortalLocked(bossPortal, questState([], { allMainComplete: false })), true);
  assert.equal(isPortalLocked(bossPortal, questState([], { allMainComplete: true, endingAchieved: false })), false);
  assert.equal(isPortalLocked(bossPortal, questState([], { allMainComplete: true, endingAchieved: true })), true);
});

test("[R3] tile effects: item, sign, heal, and grass are reported distinctly", () => {
  assert.equal(getTileEffect("forest", 1, 4).type, "item");
  assert.equal(getTileEffect("forest", 8, 4).type, "sign");
  assert.equal(getTileEffect("center", 3, 2).type, "heal");
  assert.equal(getTileEffect("forest", 4, 2).type, "grass");
  assert.equal(getTileEffect("forest", 1, 1).type, "none");
});

test("[AC7] dedicated maps have no grass tiles at all (structurally zero encounters)", () => {
  for (const id of ["town", "center", "boss_room"]) {
    const map = MAPS[id];
    const hasGrass = map.grid.some(row => row.includes("G"));
    assert.equal(hasGrass, false, `${id} must not contain a grass tile`);
  }
});
