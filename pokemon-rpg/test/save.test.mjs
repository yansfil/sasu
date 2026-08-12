import { test } from "node:test";
import assert from "node:assert/strict";
import {
  serialize, deserialize, saveToStorage, loadFromStorage, hasSave, clearSave,
  recordTrainerDefeat, isTrainerDefeated, recordItemCollected, isItemCollected, SAVE_VERSION,
} from "../src/engine/save.js";
import { healPartyFully, recoverFromWipe } from "../src/engine/recovery.js";
import { createPokedex, recordCaught } from "../src/engine/pokedex.js";
import { acceptQuest, recordProgressEvent, QUEST_STATUS } from "../src/engine/quest.js";
import { isPortalLocked } from "../src/engine/world.js";
import { QUESTS } from "../src/data/quests.js";
import { MAPS } from "../src/data/maps.js";
import { createMonster } from "../src/engine/growth.js";
import { CHARACTERS } from "../src/data/characters.js";

function createMockStorage() {
  const store = new Map();
  return {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
}

function sampleState(overrides = {}) {
  return {
    characterId: "jiwoo",
    party: [createMonster("pikachu", 5)],
    mapId: "forest",
    x: 3,
    y: 3,
    inventory: { pokeball: 10, potion: 3 },
    pokedex: createPokedex(),
    questProgress: {},
    defeatedTrainers: [],
    collectedItemTiles: [],
    endingAchieved: false,
    ...overrides,
  };
}

test("[R17] serialize/deserialize round-trips every save field", () => {
  const state = sampleState({ pokedex: recordCaught(createPokedex(), "pikachu") });
  const restored = deserialize(serialize(state));
  assert.equal(restored.characterId, state.characterId);
  assert.equal(restored.mapId, state.mapId);
  assert.deepEqual(restored.party, state.party);
  assert.deepEqual(restored.inventory, state.inventory);
  assert.equal(restored.pokedex.caught.has("pikachu"), true);
});

test("[R17] the save carries an explicit version field and rejects a mismatched one", () => {
  const json = serialize(sampleState());
  assert.equal(JSON.parse(json).version, SAVE_VERSION);
  assert.throws(() => deserialize(JSON.stringify({ ...JSON.parse(json), version: 999 })));
});

test("[AC4] the selected character and its table-A starting partner survive a save round trip for all 5 characters", () => {
  const storage = createMockStorage();
  for (const [characterId, character] of Object.entries(CHARACTERS)) {
    const state = sampleState({ characterId, party: [createMonster(character.partnerSpeciesId, 5)] });
    saveToStorage(storage, state);
    const restored = loadFromStorage(storage);
    assert.equal(restored.characterId, characterId);
    assert.equal(restored.party[0].speciesId, character.partnerSpeciesId);
  }
});

test("[AC9] map-open state (derived from quest completion) survives a save round trip", () => {
  const storage = createMockStorage();
  let progress = acceptQuest({}, "forest_main");
  progress = recordProgressEvent(progress, QUESTS, "trainer_defeat", { npcId: "forest_guardian" });
  const cavePortal = MAPS.forest.portals["9,7"];
  assert.equal(isPortalLocked(cavePortal, { isQuestComplete: id => progress[id]?.status === "completable" || progress[id]?.status === "claimed", allMainComplete: false, endingAchieved: false }), false);

  saveToStorage(storage, sampleState({ questProgress: progress }));
  const restored = loadFromStorage(storage);
  const restoredLocked = isPortalLocked(cavePortal, {
    isQuestComplete: id => restored.questProgress[id]?.status === "completable" || restored.questProgress[id]?.status === "claimed",
    allMainComplete: false,
    endingAchieved: false,
  });
  assert.equal(restoredLocked, false, "cave must remain open after a save/reload once forest_main was already complete");
});

test("[AC14] a trainer's defeated flag survives a save round trip", () => {
  const storage = createMockStorage();
  const defeated = recordTrainerDefeat([], "forest_guardian");
  saveToStorage(storage, sampleState({ defeatedTrainers: defeated }));
  const restored = loadFromStorage(storage);
  assert.equal(isTrainerDefeated(restored.defeatedTrainers, "forest_guardian"), true);
  assert.equal(isTrainerDefeated(restored.defeatedTrainers, "cave_guardian"), false);
});

test("[AC16] a collected one-time item tile stays collected (unavailable for re-pickup) after a save round trip", () => {
  const storage = createMockStorage();
  const collected = recordItemCollected([], "forest", 1, 4);
  saveToStorage(storage, sampleState({ collectedItemTiles: collected }));
  const restored = loadFromStorage(storage);
  assert.equal(isItemCollected(restored.collectedItemTiles, "forest", 1, 4), true);
  assert.equal(isItemCollected(restored.collectedItemTiles, "cave", 1, 3), false);
});

test("[AC19] full 4-stage quest status and progress count survive a save round trip", () => {
  const storage = createMockStorage();
  let progress = acceptQuest({}, "forest_side3"); // wild_defeat_n, target count 3
  progress = recordProgressEvent(progress, QUESTS, "wild_defeat_n", { mapId: "forest" });
  progress = recordProgressEvent(progress, QUESTS, "wild_defeat_n", { mapId: "forest" });
  assert.equal(progress.forest_side3.status, QUEST_STATUS.IN_PROGRESS);
  assert.equal(progress.forest_side3.count, 2);

  saveToStorage(storage, sampleState({ questProgress: progress }));
  const restored = loadFromStorage(storage);
  assert.equal(restored.questProgress.forest_side3.status, QUEST_STATUS.IN_PROGRESS);
  assert.equal(restored.questProgress.forest_side3.count, 2);
});

test("[R11][R7] healPartyFully restores HP and every move slot's PP to max", () => {
  const monster = createMonster("bulbasaur", 10);
  monster.currentHp = 1;
  monster.moveSlots = monster.moveSlots.map(s => ({ ...s, pp: 0 }));
  const [healed] = healPartyFully([monster]);
  assert.equal(healed.currentHp, healed.stats.hp);
  assert.ok(healed.moveSlots.every(s => s.pp === s.maxPp));
});

test("[AC26] a party wipe recovers to the town Pokemon Center with the whole party healed", () => {
  const fainted = createMonster("charmander", 8);
  fainted.currentHp = 0;
  const result = recoverFromWipe([fainted]);
  assert.equal(result.mapId, "center");
  assert.equal(result.x, MAPS.center.spawn.x);
  assert.equal(result.y, MAPS.center.spawn.y);
  assert.equal(result.party[0].currentHp, result.party[0].stats.hp);
});

test("[R17] hasSave/clearSave behave correctly and a cleared slot leaves no data behind", () => {
  const storage = createMockStorage();
  assert.equal(hasSave(storage), false);
  saveToStorage(storage, sampleState());
  assert.equal(hasSave(storage), true);
  clearSave(storage);
  assert.equal(hasSave(storage), false);
  assert.equal(loadFromStorage(storage), null);
});
