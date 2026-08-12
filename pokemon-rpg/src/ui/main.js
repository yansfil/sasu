// App entry point and orchestrator (R2-R21). This is the one place UI
// state, engine calls, and DOM updates meet: screens/*.js only paint given
// state and report user intent back through the `ctx` object built here.
//
// Top-level code never touches document/window/localStorage directly - only
// `boot()` does, and it only runs when a document exists (see the guard at
// the bottom). That keeps this module safely dynamic-importable under plain
// Node for AC1's parse+load check.
import { CHARACTERS, CHARACTER_CYCLE, DEFAULT_STARTING_POKEBALLS, DEFAULT_STARTING_POTIONS } from "../data/characters.js";
import { MAPS } from "../data/maps.js";
import { SPECIES } from "../data/species.js";
import { QUESTS } from "../data/quests.js";
import { MOVES } from "../data/moves.js";
import { createRng } from "../engine/rng.js";
import { createMonster, gainExperience } from "../engine/growth.js";
import { resolveMove, getTileEffect } from "../engine/world.js";
import { rollWildEncounter } from "../engine/encounter.js";
import { executeMove, pickAiMove, consumePp, resolveTurnOrder } from "../engine/battle.js";
import { attemptCapture, attemptFlee, isFleeAllowed, isCaptureAllowed, nextAliveOpponentIndex } from "../engine/capture.js";
import { canAddToParty, addToParty, isPartyWiped, firstAliveIndex, isAlive } from "../engine/party.js";
import { applyPotion, consumeItem, addItem } from "../engine/items.js";
import { acceptQuest, recordProgressEvent, checkItemCollectCompletable, claimReward, isQuestDone, allMainQuestsDone, isTrainerNpcInSight, QUEST_STATUS } from "../engine/quest.js";
import { buildRivalParty } from "../engine/rival.js";
import { createPokedex, recordSeen, recordCaught } from "../engine/pokedex.js";
import { saveToStorage, loadFromStorage, hasSave, clearSave, recordTrainerDefeat, isTrainerDefeated, recordItemCollected, isItemCollected } from "../engine/save.js";
import { healPartyFully, recoverFromWipe } from "../engine/recovery.js";
import { bindKeyboard } from "./input.js";
import * as titleScreen from "./screens/title.js";
import * as characterSelectScreen from "./screens/characterSelect.js";
import * as overworldScreen from "./screens/overworld.js";
import * as battleScreen from "./screens/battle.js";
import * as menuScreen from "./screens/menu.js";
import * as questLogScreen from "./screens/questLog.js";
import * as pokedexScreen from "./screens/pokedex.js";
import * as endingScreen from "./screens/ending.js";

const SCREENS = {
  title: titleScreen,
  characterSelect: characterSelectScreen,
  overworld: overworldScreen,
  battle: battleScreen,
  menu: menuScreen,
  questLog: questLogScreen,
  pokedex: pokedexScreen,
  ending: endingScreen,
};

// engine/battle.js's battler contract reads `.species.type`; save state only
// stores the compact `speciesId` (see engine/save.js). This resolves the
// two at the one boundary that needs both, without changing either
// contract or duplicating species data onto every saved party member.
function battlerView(member) {
  return { ...member, species: SPECIES[member.speciesId] };
}

const WILD_XP_PER_LEVEL = 16;
const TRAINER_XP_PER_LEVEL = 22;

function freshState(characterId, forcedSeed) {
  const character = CHARACTERS[characterId];
  const startingPokeballs = character.traitEffect.type === "starting_pokeballs" ? character.traitEffect.value : DEFAULT_STARTING_POKEBALLS;
  const town = MAPS.town;
  return {
    screen: "characterSelect",
    characterId,
    party: [createMonster(character.partnerSpeciesId, 5)],
    mapId: "town",
    x: town.spawn.x,
    y: town.spawn.y,
    inventory: { pokeball: startingPokeballs, potion: DEFAULT_STARTING_POTIONS },
    pokedex: recordSeen(createPokedex(), character.partnerSpeciesId),
    questProgress: {},
    defeatedTrainers: [],
    collectedItemTiles: [],
    endingAchieved: false,
    // A test-only ?seed= URL param can force this instead of Date.now() (§5:
    // "이 훅은 UI에 새 사용자 흐름을 추가하지 않으며" - no new player-facing
    // flow, just deterministic replay for the e2e suite).
    rngSeed: forcedSeed ?? Date.now(),
    facing: "down",
    dialog: null,
    battle: null,
    newGameConfirm: false,
    selection: {},
  };
}

export function createApp(root, storage, announce, forcedSeed) {
  const state = { screen: "title", selection: {}, newGameConfirm: false, party: [] };
  let rng = createRng(1);

  const ctx = {
    root,
    state,
    hasSave: hasSave(storage),
    announce,
    characterName: () => (CHARACTERS[state.characterId] ? CHARACTERS[state.characterId].name : ""),
    speciesName: id => SPECIES[id].name,
    rerender: () => render(),
    dispatchClick,
    selectCharacter,
    moveOverworld,
    interactOverworld,
    openMenu,
    menuClick,
    closeSubscreen,
    battleClick,
    battleMenuSize,
    battleConfirmCursor,
    continueAfterEnding,
  };

  function render() {
    SCREENS[state.screen].render(ctx);
  }

  function autoSave() {
    saveToStorage(storage, state);
    ctx.hasSave = true;
  }

  function goto(screen) {
    state.screen = screen;
    render();
  }

  function dispatchClick(action) {
    if (action === "continue") return doContinue();
    if (action === "new-game") return doStartNewGame();
    if (action === "confirm-new-game") return doConfirmNewGame();
    if (action === "cancel-new-game") { state.newGameConfirm = false; return render(); }
  }

  function doContinue() {
    const restored = loadFromStorage(storage);
    Object.assign(state, restored);
    state.screen = "overworld";
    state.dialog = null;
    state.battle = null;
    rng = createRng(state.rngSeed);
    render();
  }

  function doStartNewGame() {
    if (hasSave(storage)) {
      state.newGameConfirm = true;
      return render();
    }
    goto("characterSelect");
  }

  function doConfirmNewGame() {
    clearSave(storage);
    state.newGameConfirm = false;
    ctx.hasSave = false;
    goto("characterSelect");
  }

  function selectCharacter(characterId) {
    Object.assign(state, freshState(characterId, forcedSeed));
    rng = createRng(state.rngSeed);
    state.screen = "overworld";
    autoSave();
    render();
  }

  // --- Overworld ---

  function questStateView() {
    return {
      isQuestComplete: id => isQuestDone(state.questProgress, id),
      allMainComplete: allMainQuestsDone(state.questProgress),
      endingAchieved: state.endingAchieved,
    };
  }

  function npcOccupiedSet(map) {
    const set = new Set();
    for (const npc of map.npcs || []) {
      if (npc.kind === "trainer" && isTrainerDefeated(state.defeatedTrainers, npc.id)) continue;
      set.add(`${npc.x},${npc.y}`);
    }
    return set;
  }

  function moveOverworld(direction) {
    state.facing = direction;
    const map = MAPS[state.mapId];
    const move = resolveMove(state.mapId, state.x, state.y, direction, questStateView(), npcOccupiedSet(map));
    if (!move.moved) {
      if (move.reason === "locked") {
        const questTitle = move.lockedBy === "ALL_MAIN" ? "메인 미션 4개 완료" : QUESTS[move.lockedBy]?.title || move.lockedBy;
        state.dialog = `아직 갈 수 없다. 필요한 미션: ${questTitle}`;
        announceText(state.dialog);
        render();
      }
      return;
    }
    state.dialog = null;
    if (move.transition) {
      state.mapId = move.transition.toMap;
      state.x = move.transition.toX;
      state.y = move.transition.toY;
      announceText(`${MAPS[state.mapId].name}(으)로 이동했다.`);
    } else {
      state.x = move.x;
      state.y = move.y;
    }
    applyTileEffect();
    autoSave();
    if (state.battle) return; // a wild encounter already started the battle screen
    if (maybeTriggerRivalBattle()) return;
    if (!maybeTriggerTrainerSight()) render();
  }

  function applyTileEffect() {
    const effect = getTileEffect(state.mapId, state.x, state.y);
    if (effect.type === "item") {
      if (!isItemCollected(state.collectedItemTiles, state.mapId, state.x, state.y)) {
        state.inventory = addItem(state.inventory, effect.item.itemId, effect.item.count);
        state.collectedItemTiles = recordItemCollected(state.collectedItemTiles, state.mapId, state.x, state.y);
        state.dialog = `아이템을 얻었다: ${effect.item.itemId === "pokeball" ? "몬스터볼" : "상처약"} x${effect.item.count}`;
        announceText(state.dialog);
      }
    } else if (effect.type === "sign") {
      state.dialog = effect.text;
      announceText(effect.text);
    } else if (effect.type === "heal") {
      state.party = healPartyFully(state.party);
      state.dialog = "파티가 전부 회복되었다.";
      announceText(state.dialog);
    } else if (effect.type === "grass") {
      const character = CHARACTERS[state.characterId];
      const multiplier = character.traitEffect.type === "encounter_rate_mult" ? character.traitEffect.value : 1;
      const encounter = rollWildEncounter({ mapId: state.mapId, characterEncounterMultiplier: multiplier, rng });
      if (encounter) startWildBattle(encounter);
    }
  }

  function maybeTriggerTrainerSight() {
    const map = MAPS[state.mapId];
    for (const npc of map.npcs || []) {
      if (npc.kind !== "trainer" || isTrainerDefeated(state.defeatedTrainers, npc.id)) continue;
      if (isTrainerNpcInSight(state.mapId, npc, state.x, state.y)) {
        startTrainerBattle(npc);
        return true;
      }
    }
    return false;
  }

  function interactOverworld() {
    const map = MAPS[state.mapId];
    const delta = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[state.facing];
    const fx = state.x + delta[0];
    const fy = state.y + delta[1];
    const npc = (map.npcs || []).find(n => n.x === fx && n.y === fy);
    if (!npc) return;
    if (npc.kind === "mission") return interactMissionGiver(npc);
    if (npc.kind === "town") return interactTownNpc(npc);
    if (npc.kind === "trainer" && !isTrainerDefeated(state.defeatedTrainers, npc.id)) return startTrainerBattle(npc);
  }

  function interactMissionGiver(npc) {
    for (const questId of npc.quests) {
      state.questProgress = checkItemCollectCompletable(state.questProgress, QUESTS, questId, state.inventory);
    }
    const claimable = npc.quests.find(id => state.questProgress[id]?.status === QUEST_STATUS.COMPLETABLE);
    if (claimable) {
      const result = claimReward(state.questProgress, QUESTS, claimable, state.inventory);
      state.questProgress = result.progress;
      state.inventory = result.inventory;
      state.dialog = `"${QUESTS[claimable].title}" 완료! 보상을 받았다.`;
      announceText(state.dialog);
      autoSave();
      return render();
    }
    const unaccepted = npc.quests.find(id => !state.questProgress[id] || state.questProgress[id].status === QUEST_STATUS.UNACCEPTED);
    if (unaccepted) {
      state.questProgress = acceptQuest(state.questProgress, unaccepted);
      state.dialog = `미션 수락: "${QUESTS[unaccepted].title}" - ${QUESTS[unaccepted].description}`;
      announceText(state.dialog);
      autoSave();
      return render();
    }
    state.dialog = "이 지역의 모든 미션을 완료했다.";
    render();
  }

  function interactTownNpc(npc) {
    if (npc.gift && !isItemCollected(state.collectedItemTiles, "npc-gift", npc.id, 0)) {
      state.inventory = addItem(state.inventory, npc.gift.itemId, npc.gift.count);
      state.collectedItemTiles = recordItemCollected(state.collectedItemTiles, "npc-gift", npc.id, 0);
      state.dialog = `${npc.dialog} (${npc.gift.itemId === "pokeball" ? "몬스터볼" : "상처약"} x${npc.gift.count} 받음)`;
      autoSave();
    } else {
      state.dialog = npc.dialog;
    }
    announceText(state.dialog);
    render();
  }

  function announceText(text) {
    announce(text);
  }

  // --- Menu / subscreens ---

  function openMenu() {
    state.selection.menuIndex = 0;
    goto("menu");
  }

  function menuClick(action) {
    if (action === "quest-log") return goto("questLog");
    if (action === "pokedex") return goto("pokedex");
    if (action === "party") { state.selection.showParty = !state.selection.showParty; return render(); }
    if (action === "new-game") { state.newGameConfirm = true; return render(); }
    if (action === "confirm-new-game") return doConfirmNewGame();
    if (action === "cancel-new-game") { state.newGameConfirm = false; return render(); }
    if (action === "close") { state.selection.showParty = false; return goto("overworld"); }
  }

  function closeSubscreen() {
    goto("overworld");
  }

  // --- Battle ---

  function startWildBattle(encounter) {
    const opponent = createMonster(encounter.speciesId, encounter.level);
    state.pokedex = recordSeen(state.pokedex, encounter.speciesId);
    state.battle = {
      mode: "wild",
      playerIndex: firstAliveIndex(state.party),
      opponent,
      log: [`야생 ${SPECIES[encounter.speciesId].name}이(가) 나타났다!`],
      menu: "main",
      cursor: 0,
      outcome: null,
      sourceMapId: state.mapId, sourceX: state.x, sourceY: state.y,
    };
    goto("battle");
  }

  function startTrainerBattle(npc) {
    state.battle = {
      mode: "trainer",
      playerIndex: firstAliveIndex(state.party),
      opponentParty: npc.party.map(p => createMonster(p.species, p.level)),
      opponentIndex: 0,
      trainerNpc: npc,
      log: [`${npc.id}이(가) 승부를 걸어왔다!`],
      menu: "main",
      cursor: 0,
      outcome: null,
      sourceMapId: state.mapId, sourceX: state.x, sourceY: state.y,
    };
    goto("battle");
  }

  function currentOpponent() {
    const b = state.battle;
    return b.mode === "trainer" ? b.opponentParty[b.opponentIndex] : b.opponent;
  }

  function battleMenuSize() {
    const b = state.battle;
    if (b.outcome) return 1;
    if (b.menu === "fight") return state.party[b.playerIndex].moveSlots.length + 1;
    if (b.menu === "bag") return 2;
    if (b.menu === "party") return state.party.length + (b.forcedSwitch ? 0 : 1);
    return b.mode === "wild" ? 4 : 3;
  }

  function battleConfirmCursor() {
    const b = state.battle;
    if (b.menu === "fight") {
      const moves = state.party[b.playerIndex].moveSlots;
      if (b.cursor < moves.length) return battleClick("move", b.cursor);
      return battleClick("back");
    }
    if (b.menu === "bag") return b.cursor === 0 ? battleClick("use-potion") : battleClick("back");
    if (b.menu === "party") {
      if (b.cursor < state.party.length) return battleClick("switch", b.cursor);
      return battleClick("back");
    }
    const mainOptions = b.mode === "wild" ? ["fight", "bag", "catch", "run"] : ["fight", "bag", "party"];
    return battleClick(mainOptions[b.cursor]);
  }

  function battleClick(action, index) {
    const b = state.battle;
    if (action === "close") {
      const outcome = b.outcome;
      const wasRivalWin = b.isRivalBattle && outcome === "win";
      state.battle = null;
      if (outcome === "wipe") {
        const recovery = recoverFromWipe(state.party);
        state.party = recovery.party;
        state.mapId = recovery.mapId;
        state.x = recovery.x;
        state.y = recovery.y;
      } else {
        state.mapId = b.sourceMapId; state.x = b.sourceX; state.y = b.sourceY;
      }
      autoSave();
      return goto(wasRivalWin ? "ending" : "overworld");
    }
    if (action === "back") { b.menu = "main"; b.cursor = 0; return render(); }
    if (action === "fight") { b.menu = "fight"; b.cursor = 0; return render(); }
    if (action === "bag") { b.menu = "bag"; b.cursor = 0; return render(); }
    if (action === "party") { b.menu = "party"; b.cursor = 0; return render(); }
    if (action === "move") return playerAttack(index);
    if (action === "use-potion") return playerUseItem();
    if (action === "catch") return playerCatch();
    if (action === "run") return playerRun();
    if (action === "switch") return playerSwitch(index);
  }

  function log(text) {
    state.battle.log.push(text);
    announceText(text);
  }

  function playerAttack(moveIndex) {
    const b = state.battle;
    const attacker = state.party[b.playerIndex];
    const defender = currentOpponent();
    const character = CHARACTERS[state.characterId];
    const dmgMult = character.traitEffect.type === "damage_dealt_mult" ? character.traitEffect.value : 1;
    const move = { id: attacker.moveSlots[moveIndex].moveId, ...MOVES[attacker.moveSlots[moveIndex].moveId] };
    const first = resolveTurnOrder({ stats: { spd: attacker.stats.spd } }, { stats: { spd: defender.stats.spd } }, rng);

    function doPlayerMove() {
      attacker.moveSlots = consumePp(attacker.moveSlots, moveIndex);
      const result = executeMove({ attacker: battlerView(attacker), defender: battlerView(defender), move, rng, characterDamageMultiplier: dmgMult });
      if (!result.hit) { log(`${move.name}이(가) 빗나갔다!`); return; }
      defender.currentHp = Math.max(0, defender.currentHp - result.damage);
      log(`${move.name}! ${result.damage} 데미지${result.crit ? " (급소)" : ""}${result.effectiveness > 1 ? " 효과가 굉장했다!" : result.effectiveness < 1 ? " 효과가 별로였다..." : ""}`);
    }
    function doOpponentMove() {
      const oppMoveIndex = pickAiMove(defender.moveSlots, rng);
      const oppMove = oppMoveIndex === null ? { id: "struggle", name: "발버둥", type: "normal", power: 40, accuracy: 100, pp: Infinity } : { id: defender.moveSlots[oppMoveIndex].moveId, ...MOVES[defender.moveSlots[oppMoveIndex].moveId] };
      if (oppMoveIndex !== null) defender.moveSlots = consumePp(defender.moveSlots, oppMoveIndex);
      const result = executeMove({ attacker: battlerView(defender), defender: battlerView(attacker), move: oppMove, rng });
      if (!result.hit) { log(`상대의 ${oppMove.name}이(가) 빗나갔다!`); return; }
      attacker.currentHp = Math.max(0, attacker.currentHp - result.damage);
      log(`상대의 ${oppMove.name}! ${result.damage} 데미지`);
    }

    if (first === "a") {
      doPlayerMove();
      if (defender.currentHp <= 0) return handleOpponentFaint();
      doOpponentMove();
      if (attacker.currentHp <= 0) return handlePlayerFaint();
    } else {
      doOpponentMove();
      if (attacker.currentHp <= 0) return handlePlayerFaint();
      doPlayerMove();
      if (defender.currentHp <= 0) return handleOpponentFaint();
    }
    b.menu = "main"; b.cursor = 0;
    render();
  }

  function playerUseItem() {
    const b = state.battle;
    const attacker = state.party[b.playerIndex];
    const character = CHARACTERS[state.characterId];
    const healMult = character.traitEffect.type === "heal_amount_mult" ? character.traitEffect.value : 1;
    state.inventory = consumeItem(state.inventory, "potion", 1);
    const result = applyPotion(attacker, healMult);
    attacker.currentHp = result.currentHp;
    log(`상처약 사용! HP ${result.healed} 회복`);
    opponentTurnAfterNonAttack();
  }

  function playerCatch() {
    const b = state.battle;
    const defender = currentOpponent();
    const character = CHARACTERS[state.characterId];
    const captureMult = character.traitEffect.type === "capture_rate_mult" ? character.traitEffect.value : 1;
    const attempt = attemptCapture({
      party: state.party,
      remainingHpFraction: defender.currentHp / defender.stats.hp,
      catchRate: SPECIES[defender.speciesId].catchRate,
      characterCaptureMultiplier: captureMult,
      rng,
    });
    if (attempt.rejected) {
      log("파티가 가득 차서 포획할 수 없다!");
      b.menu = "main"; b.cursor = 0;
      return render();
    }
    state.inventory = consumeItem(state.inventory, "pokeball", 1);
    if (attempt.success) {
      state.party = addToParty(state.party, defender);
      state.pokedex = recordCaught(state.pokedex, defender.speciesId);
      state.questProgress = recordProgressEvent(state.questProgress, QUESTS, "capture_species", { speciesId: defender.speciesId });
      log(`${SPECIES[defender.speciesId].name}을(를) 포획했다!`);
      b.outcome = "caught";
      b.outcomeText = "포획 성공!";
      autoSave();
      return render();
    }
    log("포획에 실패했다...");
    opponentTurnAfterNonAttack();
  }

  function playerRun() {
    const b = state.battle;
    const attacker = state.party[b.playerIndex];
    const defender = currentOpponent();
    const attempt = attemptFlee({ playerSpd: attacker.stats.spd, opponentSpd: defender.stats.spd, rng });
    if (attempt.success) {
      log("도망쳤다!");
      b.outcome = "fled";
      b.outcomeText = "도망에 성공했다.";
      return render();
    }
    log("도망칠 수 없었다!");
    opponentTurnAfterNonAttack();
  }

  function playerSwitch(index) {
    const b = state.battle;
    if (!isAlive(state.party[index]) || index === b.playerIndex) return;
    const wasForced = Boolean(b.forcedSwitch);
    b.playerIndex = index;
    b.forcedSwitch = false;
    log(`${SPECIES[state.party[index].speciesId].name} 교체!`);
    // R10: a voluntary switch costs a turn (the opponent gets to act); a
    // forced switch after a faint does not - the opponent already acted in
    // the sequence that caused the faint.
    if (wasForced) { b.menu = "main"; b.cursor = 0; render(); }
    else opponentTurnAfterNonAttack();
  }

  function opponentTurnAfterNonAttack() {
    const b = state.battle;
    const attacker = state.party[b.playerIndex];
    const defender = currentOpponent();
    const oppMoveIndex = pickAiMove(defender.moveSlots, rng);
    const oppMove = oppMoveIndex === null ? { id: "struggle", name: "발버둥", type: "normal", power: 40, accuracy: 100, pp: Infinity } : { id: defender.moveSlots[oppMoveIndex].moveId, ...MOVES[defender.moveSlots[oppMoveIndex].moveId] };
    if (oppMoveIndex !== null) defender.moveSlots = consumePp(defender.moveSlots, oppMoveIndex);
    const result = executeMove({ attacker: battlerView(defender), defender: battlerView(attacker), move: oppMove, rng });
    if (result.hit) {
      attacker.currentHp = Math.max(0, attacker.currentHp - result.damage);
      log(`상대의 ${oppMove.name}! ${result.damage} 데미지`);
    } else {
      log(`상대의 ${oppMove.name}이(가) 빗나갔다!`);
    }
    if (attacker.currentHp <= 0) return handlePlayerFaint();
    b.menu = "main"; b.cursor = 0;
    render();
  }

  function handleOpponentFaint() {
    const b = state.battle;
    const defender = currentOpponent();
    log(`상대 ${SPECIES[defender.speciesId].name}을(를) 쓰러뜨렸다!`);
    const attacker = state.party[b.playerIndex];
    const xpAward = defender.level * (b.mode === "trainer" ? TRAINER_XP_PER_LEVEL : WILD_XP_PER_LEVEL);
    const grown = gainExperience(attacker, xpAward);
    Object.assign(attacker, grown);
    for (const event of grown.events) {
      if (event.type === "level_up") log(`레벨 업! Lv${event.level}`);
      if (event.type === "evolved") log(`진화했다! ${SPECIES[event.to].name}(으)로!`);
      if (event.type === "move_skipped") log(`새 기술을 배우지 못했다 (슬롯 가득참): ${event.moveId}`);
      if (event.type === "move_learned") log(`새 기술을 배웠다: ${event.moveId}`);
    }

    if (b.mode === "wild") {
      state.questProgress = recordProgressEvent(state.questProgress, QUESTS, "wild_defeat_n", { mapId: b.sourceMapId });
      b.outcome = "win";
      b.outcomeText = "승리했다!";
      autoSave();
      return render();
    }

    const next = nextAliveOpponentIndex(b.opponentParty, b.opponentIndex + 1);
    if (next === -1) {
      if (b.isRivalBattle) {
        state.endingAchieved = true;
        b.outcome = "win";
        b.outcomeText = "라이벌을 꺾었다! 엔딩으로 이동한다.";
        autoSave();
        return render();
      }
      state.defeatedTrainers = recordTrainerDefeat(state.defeatedTrainers, b.trainerNpc.id);
      if (b.trainerNpc.reward) for (const item of b.trainerNpc.reward.items) state.inventory = addItem(state.inventory, item.itemId, item.count);
      if (b.trainerNpc.questId) state.questProgress = recordProgressEvent(state.questProgress, QUESTS, "trainer_defeat", { npcId: b.trainerNpc.id });
      b.outcome = "win";
      b.outcomeText = `${b.trainerNpc.id}을(를) 이겼다! 보상을 받았다.`;
      autoSave();
      return render();
    }
    b.opponentIndex = next;
    log(`상대가 다음 몬스터를 내보냈다: ${SPECIES[b.opponentParty[next].speciesId].name}`);
    b.menu = "main"; b.cursor = 0;
    render();
  }

  function handlePlayerFaint() {
    const b = state.battle;
    log(`${SPECIES[state.party[b.playerIndex].speciesId].name}이(가) 쓰러졌다!`);
    if (isPartyWiped(state.party)) {
      b.outcome = "wipe";
      b.outcomeText = "파티가 전멸했다... 포켓몬센터로 이동한다.";
      return render();
    }
    b.forcedSwitch = true;
    b.menu = "party";
    b.cursor = firstAliveIndex(state.party);
    render();
  }

  function continueAfterEnding() {
    goto("overworld");
  }

  // Rival battle hook: called by moveOverworld's tile-effect path via the
  // boss room's rival trigger tile (checked alongside item/sign/heal/grass).
  function maybeTriggerRivalBattle() {
    const map = MAPS[state.mapId];
    if (state.mapId !== "boss_room" || !map.rivalTrigger) return false;
    if (state.x !== map.rivalTrigger.x || state.y !== map.rivalTrigger.y) return false;
    const { party } = buildRivalParty(state.characterId);
    state.battle = {
      mode: "trainer",
      playerIndex: firstAliveIndex(state.party),
      opponentParty: party,
      opponentIndex: 0,
      trainerNpc: { id: "rival", reward: { items: [] } },
      log: ["라이벌이 최종 결전을 걸어왔다!"],
      menu: "main",
      cursor: 0,
      outcome: null,
      isRivalBattle: true,
      sourceMapId: state.mapId, sourceX: state.x, sourceY: state.y,
    };
    goto("battle");
    return true;
  }

  return { ctx, render, initTitle: () => goto("title") };
}

// --- Boot (browser only) ---

function boot() {
  const root = document.getElementById("app");
  const ariaLive = document.getElementById("aria-live");
  function announce(text) {
    ariaLive.textContent = "";
    // Re-set on the next frame so repeated identical messages still fire a
    // screen-reader announcement (an unchanged textContent would not).
    requestAnimationFrame(() => { ariaLive.textContent = text; });
  }
  const seedParam = new URLSearchParams(window.location.search).get("seed");
  const forcedSeed = seedParam !== null && seedParam !== "" ? Number(seedParam) : undefined;
  const app = createApp(root, window.localStorage, announce, forcedSeed);
  // Test-only state readout, active only behind an explicit ?debug=1 query
  // param - never on by default, never a player-facing flow. The e2e suite
  // uses this to navigate deterministically instead of guessing a position
  // from RNG-dependent encounter timing.
  if (new URLSearchParams(window.location.search).get("debug") === "1") {
    Object.defineProperty(window, "__pokemonRpgDebugState", { get: () => app.ctx.state });
  }
  bindKeyboard(window, action => {
    const handler = SCREENS[app.ctx.state.screen].handleAction;
    if (handler) handler(app.ctx, action);
  });
  app.initTitle();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
}
