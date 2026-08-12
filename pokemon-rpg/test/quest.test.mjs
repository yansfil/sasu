import { test } from "node:test";
import assert from "node:assert/strict";
import {
  QUEST_STATUS, acceptQuest, recordProgressEvent, checkItemCollectCompletable,
  claimReward, listAcceptedQuests, allMainQuestsDone, isTrainerNpcInSight, isQuestDone,
} from "../src/engine/quest.js";
import { QUESTS, MAIN_QUEST_IDS } from "../src/data/quests.js";
import { MAPS } from "../src/data/maps.js";

test("[AC18] a quest only transitions unaccepted -> in_progress -> completable -> claimed", () => {
  let progress = {};
  assert.equal(isQuestDone(progress, "forest_side1"), false);
  progress = acceptQuest(progress, "forest_side1");
  assert.equal(progress.forest_side1.status, QUEST_STATUS.IN_PROGRESS);
  progress = recordProgressEvent(progress, QUESTS, "capture_species", { speciesId: "bulbasaur" });
  assert.equal(progress.forest_side1.status, QUEST_STATUS.COMPLETABLE);
  assert.equal(isQuestDone(progress, "forest_side1"), true);
});

test("[AC17] every field map has exactly 1 main mission and 3-4 side missions; all 4 types are used", () => {
  const byMap = {};
  for (const quest of Object.values(QUESTS)) {
    byMap[quest.mapId] = byMap[quest.mapId] || { main: 0, side: 0 };
    if (quest.isMain) byMap[quest.mapId].main += 1;
    else byMap[quest.mapId].side += 1;
  }
  for (const [mapId, counts] of Object.entries(byMap)) {
    assert.equal(counts.main, 1, `${mapId} must have exactly 1 main mission`);
    assert.ok(counts.side >= 3 && counts.side <= 4, `${mapId} side count out of 3-4: ${counts.side}`);
  }
  const totalSide = Object.values(QUESTS).filter(q => !q.isMain).length;
  assert.ok(totalSide >= 12 && totalSide <= 16);
  const types = new Set(Object.values(QUESTS).map(q => q.type));
  assert.deepEqual([...types].sort(), ["capture_species", "item_collect", "trainer_defeat", "wild_defeat_n"]);
});

test("[AC18] claiming before completable is rejected; claiming twice is rejected", () => {
  let progress = acceptQuest({}, "forest_side3");
  const rejected = claimReward(progress, QUESTS, "forest_side3", {});
  assert.equal(rejected.claimed, false);
  assert.equal(rejected.reason, "not_completable");

  progress = recordProgressEvent(progress, QUESTS, "wild_defeat_n", { mapId: "forest" });
  progress = recordProgressEvent(progress, QUESTS, "wild_defeat_n", { mapId: "forest" });
  progress = recordProgressEvent(progress, QUESTS, "wild_defeat_n", { mapId: "forest" });
  assert.equal(progress.forest_side3.status, QUEST_STATUS.COMPLETABLE);
  const first = claimReward(progress, QUESTS, "forest_side3", { potion: 0 });
  assert.equal(first.claimed, true);
  assert.equal(first.inventory.potion, 1);
  const second = claimReward(first.progress, QUESTS, "forest_side3", first.inventory);
  assert.equal(second.claimed, false);
  assert.equal(second.reason, "already_claimed");
  assert.equal(second.inventory.potion, 1, "reward must not be granted twice");
});

test("[R13] item_collect quests become completable only once the inventory holds enough of the item", () => {
  let progress = acceptQuest({}, "forest_side2");
  progress = checkItemCollectCompletable(progress, QUESTS, "forest_side2", { potion: 1 });
  assert.equal(progress.forest_side2.status, QUEST_STATUS.IN_PROGRESS);
  progress = checkItemCollectCompletable(progress, QUESTS, "forest_side2", { potion: 2 });
  assert.equal(progress.forest_side2.status, QUEST_STATUS.COMPLETABLE);
});

test("[R13] trainer_defeat progress only advances for the matching npcId", () => {
  let progress = acceptQuest({}, "forest_main");
  progress = recordProgressEvent(progress, QUESTS, "trainer_defeat", { npcId: "some_other_trainer" });
  assert.equal(progress.forest_main.status, QUEST_STATUS.IN_PROGRESS);
  progress = recordProgressEvent(progress, QUESTS, "trainer_defeat", { npcId: "forest_guardian" });
  assert.equal(progress.forest_main.status, QUEST_STATUS.COMPLETABLE);
});

test("[R14] listAcceptedQuests only includes accepted (non-unaccepted) missions", () => {
  let progress = acceptQuest({}, "cave_side1");
  const log = listAcceptedQuests(progress, QUESTS);
  assert.equal(log.length, 1);
  assert.equal(log[0].id, "cave_side1");
});

test("[R15] allMainQuestsDone is true only once all 4 main missions are completable/claimed", () => {
  let progress = {};
  for (const id of MAIN_QUEST_IDS.slice(0, 3)) {
    progress = acceptQuest(progress, id);
    progress = recordProgressEvent(progress, QUESTS, "trainer_defeat", { npcId: QUESTS[id].target.npcId });
  }
  assert.equal(allMainQuestsDone(progress), false);
  const lastId = MAIN_QUEST_IDS[3];
  progress = acceptQuest(progress, lastId);
  progress = recordProgressEvent(progress, QUESTS, "trainer_defeat", { npcId: QUESTS[lastId].target.npcId });
  assert.equal(allMainQuestsDone(progress), true);
});

test("[R13] trainer sight detection triggers along a clear row/column within range and not diagonally", () => {
  const trainer = MAPS.forest.npcs.find(n => n.id === "forest_guardian"); // (7,7)
  assert.equal(isTrainerNpcInSight("forest", trainer, 7, 5, 4), true); // same column, distance 2
  assert.equal(isTrainerNpcInSight("forest", trainer, 5, 7, 4), true); // same row, distance 2
  assert.equal(isTrainerNpcInSight("forest", trainer, 7, 1, 4), false); // out of range
  assert.equal(isTrainerNpcInSight("forest", trainer, 5, 5, 4), false); // diagonal, no line
});
