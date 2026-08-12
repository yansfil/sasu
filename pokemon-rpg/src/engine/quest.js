// Mission state machine (R13, R14) plus trainer-sight detection. Pure
// engine module: progress is a plain { [questId]: { status, count } } map
// the caller threads through save state.
import { MAIN_QUEST_IDS } from "../data/quests.js";
import { MAPS } from "../data/maps.js";

export const QUEST_STATUS = {
  UNACCEPTED: "unaccepted",
  IN_PROGRESS: "in_progress",
  COMPLETABLE: "completable",
  CLAIMED: "claimed",
};

function stateOf(progress, questId) {
  return progress[questId] || { status: QUEST_STATUS.UNACCEPTED, count: 0 };
}

/** @returns {boolean} whether a mission's objective is done, whether or not its reward was claimed yet (used for R5/R15 map/boss-room gating). */
export function isQuestDone(progress, questId) {
  const status = stateOf(progress, questId).status;
  return status === QUEST_STATUS.COMPLETABLE || status === QUEST_STATUS.CLAIMED;
}

export function acceptQuest(progress, questId) {
  const current = stateOf(progress, questId);
  if (current.status !== QUEST_STATUS.UNACCEPTED) return progress;
  return { ...progress, [questId]: { status: QUEST_STATUS.IN_PROGRESS, count: 0 } };
}

/**
 * Advances every in-progress quest whose type/target matches this event.
 * eventType: "capture_species" | "trainer_defeat" | "wild_defeat_n"
 * (item_collect has no event - see checkItemCollectCompletable, since it is
 * checked on demand against the inventory rather than counted incrementally.)
 */
export function recordProgressEvent(progress, quests, eventType, payload) {
  let next = progress;
  for (const [id, quest] of Object.entries(quests)) {
    const state = stateOf(progress, id);
    if (state.status !== QUEST_STATUS.IN_PROGRESS || quest.type !== eventType) continue;
    const matches =
      (eventType === "capture_species" && payload.speciesId === quest.target.speciesId) ||
      (eventType === "wild_defeat_n" && payload.mapId === quest.target.mapId) ||
      (eventType === "trainer_defeat" && payload.npcId === quest.target.npcId);
    if (!matches) continue;
    const targetCount = quest.target.count ?? 1;
    const count = state.count + 1;
    next = { ...next, [id]: { status: count >= targetCount ? QUEST_STATUS.COMPLETABLE : QUEST_STATUS.IN_PROGRESS, count } };
  }
  return next;
}

/** item_collect quests become completable once the inventory holds enough of the target item. */
export function checkItemCollectCompletable(progress, quests, questId, inventory) {
  const quest = quests[questId];
  const state = stateOf(progress, questId);
  if (state.status !== QUEST_STATUS.IN_PROGRESS || quest.type !== "item_collect") return progress;
  if ((inventory[quest.target.itemId] || 0) < quest.target.count) return progress;
  return { ...progress, [questId]: { ...state, status: QUEST_STATUS.COMPLETABLE } };
}

/**
 * R13/AC18: rejects a claim outside COMPLETABLE, delivers the reward exactly
 * once, and (for item_collect) consumes the delivered items.
 */
export function claimReward(progress, quests, questId, inventory) {
  const state = stateOf(progress, questId);
  if (state.status !== QUEST_STATUS.COMPLETABLE) {
    return { progress, inventory, claimed: false, reason: state.status === QUEST_STATUS.CLAIMED ? "already_claimed" : "not_completable" };
  }
  const quest = quests[questId];
  let nextInventory = { ...inventory };
  if (quest.type === "item_collect") {
    nextInventory[quest.target.itemId] = nextInventory[quest.target.itemId] - quest.target.count;
  }
  for (const rewardItem of quest.reward.items) {
    nextInventory[rewardItem.itemId] = (nextInventory[rewardItem.itemId] || 0) + rewardItem.count;
  }
  const nextProgress = { ...progress, [questId]: { status: QUEST_STATUS.CLAIMED, count: state.count } };
  return { progress: nextProgress, inventory: nextInventory, claimed: true, reason: null };
}

/** @returns {{id:string, status:string, count:number, target: object, title:string}[]} the quest log for every accepted mission (R14). */
export function listAcceptedQuests(progress, quests) {
  return Object.entries(quests)
    .filter(([id]) => stateOf(progress, id).status !== QUEST_STATUS.UNACCEPTED)
    .map(([id, quest]) => ({ id, status: stateOf(progress, id).status, count: stateOf(progress, id).count, target: quest.target, title: quest.title }));
}

/** R15 boss-room gate input: all 4 main missions must be at least completable. */
export function allMainQuestsDone(progress) {
  return MAIN_QUEST_IDS.every(id => isQuestDone(progress, id));
}

const SIGHT_BLOCKING_TILES = new Set(["#", "~", "^"]);

/**
 * R13 트레이너 시야 감지: same row/column within `sightRange`, with no
 * blocking tile between the trainer and the player.
 */
export function isTrainerNpcInSight(mapId, trainerNpc, playerX, playerY, sightRange = 4) {
  const map = MAPS[mapId];
  if (trainerNpc.x === playerX && trainerNpc.y !== playerY) {
    if (Math.abs(trainerNpc.y - playerY) > sightRange) return false;
    const [y1, y2] = [Math.min(trainerNpc.y, playerY), Math.max(trainerNpc.y, playerY)];
    for (let y = y1 + 1; y < y2; y++) if (SIGHT_BLOCKING_TILES.has(map.grid[y][playerX])) return false;
    return true;
  }
  if (trainerNpc.y === playerY && trainerNpc.x !== playerX) {
    if (Math.abs(trainerNpc.x - playerX) > sightRange) return false;
    const [x1, x2] = [Math.min(trainerNpc.x, playerX), Math.max(trainerNpc.x, playerX)];
    for (let x = x1 + 1; x < x2; x++) if (SIGHT_BLOCKING_TILES.has(map.grid[playerY][x])) return false;
    return true;
  }
  return false;
}
