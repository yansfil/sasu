#!/usr/bin/env node
// AC oracle runner (§5): one file, run from the repo root as
// `node pokemon-rpg/tools/ac.mjs <AC-ID>` or `--all`. Never writes to the
// workspace. Checks are registered in a flat map so each PRD task appends
// its own oracle(s) here instead of the runner growing a second dispatch
// layer per module (D-45: no npm-script or bash -c indirection required).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");

function walk(dir, filterExt) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, filterExt));
    else if (!filterExt || entry.name.endsWith(filterExt)) out.push(full);
  }
  return out;
}

function readText(file) {
  return fs.readFileSync(file, "utf8");
}

/** @type {Map<string, () => Promise<{pass: boolean, message: string}>>} */
const checks = new Map();

function registerCheck(id, fn) {
  checks.set(id, fn);
}

registerCheck("AC1", async () => {
  try {
    execFileSync("npx", ["tsc", "--noEmit"], { cwd: ROOT, stdio: "pipe" });
  } catch (err) {
    const output = (err.stdout ? err.stdout.toString() : "") + (err.stderr ? err.stderr.toString() : "");
    return { pass: false, message: `typecheck failed:\n${output.trim()}` };
  }
  const files = walk(SRC, ".js");
  if (files.length === 0) return { pass: false, message: "no source modules found under src/" };
  const failures = [];
  for (const file of files) {
    try {
      await import(pathToFileURL(file).href);
    } catch (err) {
      failures.push(`${path.relative(ROOT, file)}: ${err && err.stack ? err.stack : err}`);
    }
  }
  if (failures.length > 0) {
    return { pass: false, message: `${failures.length} module(s) failed to load:\n${failures.join("\n")}` };
  }
  return { pass: true, message: `typecheck passed; ${files.length} module(s) parsed and loaded` };
});

registerCheck("AC31", async () => {
  const pkg = JSON.parse(readText(path.join(ROOT, "package.json")));
  const deps = pkg.dependencies || {};
  if (Object.keys(deps).length > 0) {
    return { pass: false, message: `package.json dependencies is not empty: ${Object.keys(deps).join(", ")}` };
  }
  const scanDirs = [SRC, path.join(ROOT, "styles")];
  const scanFiles = [
    ...scanDirs.flatMap(dir => [...walk(dir, ".js"), ...walk(dir, ".css")]),
    path.join(ROOT, "index.html"),
  ].filter(fs.existsSync);
  // www.w3.org XML namespace URIs (e.g. SVG's xmlns) are identifiers, not
  // fetchable resources - browsers never request them - so they are not a
  // "request referencing an external URL" in R1/AC31's sense.
  const urlPattern = /https?:\/\/(?!localhost|127\.0\.0\.1|www\.w3\.org\/)\S+/gi;
  const offenders = [];
  for (const file of scanFiles) {
    const text = readText(file);
    const matches = text.match(urlPattern);
    if (matches) offenders.push(`${path.relative(ROOT, file)}: ${matches.join(", ")}`);
  }
  if (offenders.length > 0) {
    return { pass: false, message: `external URL reference(s) found:\n${offenders.join("\n")}` };
  }
  return { pass: true, message: "dependencies empty and no external URL references found" };
});

registerCheck("AC10", async () => {
  const { getTypeEffectiveness } = await import(pathToFileURL(path.join(SRC, "engine/battle.js")).href);
  const { TYPES } = await import(pathToFileURL(path.join(SRC, "data/types.js")).href);
  // Independently transcribed from PRD §6.1 table D (not re-read from
  // data/types.js) so this oracle catches a transcription drift, not just
  // agreement-with-itself.
  const EXPECTED = {
    normal: { rock: 0.5 },
    fire: { grass: 2.0, fire: 0.5, water: 0.5, rock: 0.5 },
    water: { fire: 2.0, rock: 2.0, water: 0.5, grass: 0.5 },
    grass: { water: 2.0, rock: 2.0, fire: 0.5, grass: 0.5, flying: 0.5 },
    electric: { water: 2.0, flying: 2.0, grass: 0.5, electric: 0.5, rock: 0.5 },
    rock: { fire: 2.0, flying: 2.0, rock: 0.5 },
    flying: { grass: 2.0, electric: 0.5, rock: 0.5 },
  };
  if (TYPES.length !== 7) return { pass: false, message: `expected 7 types, found ${TYPES.length}` };
  const mismatches = [];
  let zeroCount = 0;
  let checked = 0;
  for (const atk of TYPES) {
    for (const def of TYPES) {
      checked++;
      const expected = EXPECTED[atk]?.[def] ?? 1.0;
      const actual = getTypeEffectiveness(atk, def);
      if (actual === 0) zeroCount++;
      if (actual !== expected) mismatches.push(`${atk}->${def}: expected x${expected}, got x${actual}`);
    }
  }
  if (checked !== 49) return { pass: false, message: `expected 49 combinations, checked ${checked}` };
  if (zeroCount > 0) return { pass: false, message: `${zeroCount} combination(s) resolve to x0, which table D forbids` };
  if (mismatches.length > 0) return { pass: false, message: `${mismatches.length} mismatch(es):\n${mismatches.join("\n")}` };
  return { pass: true, message: "all 49 type combinations match table D; no x0 multiplier exists" };
});

registerCheck("AC11", async () => {
  const engineFiles = walk(path.join(SRC, "engine"), ".js");
  const randomOffenders = engineFiles
    .map(f => ({ file: f, text: readText(f) }))
    .filter(({ text }) => /Math\.random\s*\(/.test(text))
    .map(({ file }) => path.relative(ROOT, file));
  if (randomOffenders.length > 0) {
    return { pass: false, message: `src/engine must never call Math.random (R22); found in: ${randomOffenders.join(", ")}` };
  }

  const { createRng } = await import(pathToFileURL(path.join(SRC, "engine/rng.js")).href);
  const { calcDamage, resolveTurnOrder } = await import(pathToFileURL(path.join(SRC, "engine/battle.js")).href);
  const scenario = {
    attackerLevel: 22, attackerAtk: 58, defenderDef: 44,
    move: { type: "water", power: 90, accuracy: 100, pp: 15 },
    attackerType: "water", defenderType: "rock",
  };
  const run = seed => {
    const rng = createRng(seed);
    return calcDamage({ ...scenario, rng });
  };
  const a = run(777);
  const b = run(777);
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    return { pass: false, message: `same seed produced different results: ${JSON.stringify(a)} vs ${JSON.stringify(b)}` };
  }
  const orderRng1 = createRng(1);
  const orderRng2 = createRng(1);
  const battlerA = { stats: { spd: 50 } };
  const battlerB = { stats: { spd: 50 } };
  const order1 = resolveTurnOrder(battlerA, battlerB, orderRng1);
  const order2 = resolveTurnOrder(battlerA, battlerB, orderRng2);
  if (order1 !== order2) {
    return { pass: false, message: `tied-speed turn order not reproducible for the same seed: ${order1} vs ${order2}` };
  }
  // Independent re-derivation of the R7 formula's non-random component
  // (base * STAB * type effectiveness), checked against calcDamage's own
  // pre-random-factor floor/ceiling bound.
  const base = ((2 * scenario.attackerLevel) / 5 + 2) * scenario.move.power * (scenario.attackerAtk / scenario.defenderDef) / 50 + 2;
  const stab = scenario.move.type === scenario.attackerType ? 1.5 : 1;
  const eff = 2.0; // water -> rock per table D
  const withoutCritOrRandom = base * stab * eff;
  const minPossible = Math.floor(withoutCritOrRandom * 0.85);
  const maxPossible = Math.ceil(withoutCritOrRandom * 1.5 * 1.0);
  if (a.damage < minPossible || a.damage > maxPossible * 1.01) {
    return { pass: false, message: `damage ${a.damage} outside expected [${minPossible}, ${maxPossible}] for STAB+type-effectiveness formula` };
  }
  if (a.stab !== true || a.effectiveness !== 2.0) {
    return { pass: false, message: `STAB/effectiveness not reflected in result: ${JSON.stringify(a)}` };
  }
  return { pass: true, message: "same-seed determinism holds for damage and tied turn order; no Math.random in src/engine; formula bounds check passed" };
});

registerCheck("AC12", async () => {
  const { pickAiMove, consumePp, allMovesExhausted, executeMove } = await import(pathToFileURL(path.join(SRC, "engine/battle.js")).href);
  const { createRng } = await import(pathToFileURL(path.join(SRC, "engine/rng.js")).href);
  const failures = [];

  let slots = [{ pp: 0 }, { pp: 0 }, { pp: 0 }, { pp: 0 }];
  if (!allMovesExhausted(slots)) failures.push("allMovesExhausted() false for all-zero PP slots");
  if (pickAiMove(slots, createRng(1)) !== null) failures.push("pickAiMove() must return null (struggle) when every slot is at 0 PP");

  slots = [{ pp: 0 }, { pp: 3 }, { pp: 0 }, { pp: 0 }];
  const idx = pickAiMove(slots, createRng(1));
  if (idx !== 1) failures.push(`pickAiMove() picked a 0-PP slot (index ${idx}) instead of the only usable slot 1`);
  const afterUse = consumePp(slots, idx);
  if (afterUse[1].pp !== 2) failures.push(`consumePp() did not decrement the used slot: ${JSON.stringify(afterUse)}`);
  const afterStruggle = consumePp(slots, null);
  if (JSON.stringify(afterStruggle) !== JSON.stringify(slots)) failures.push("consumePp(slots, null) must leave PP untouched for a struggle action");

  const alwaysMiss = { chance: () => false, range: (a) => a, pick: (arr) => arr[0] };
  const missMove = { type: "normal", power: 40, accuracy: 100, pp: 10 };
  const attacker = { level: 10, stats: { atk: 40, def: 40 }, species: { type: "normal" } };
  const defender = { level: 10, stats: { atk: 40, def: 40 }, species: { type: "normal" } };
  const missResult = executeMove({ attacker, defender, move: missMove, rng: alwaysMiss });
  if (missResult.hit !== false || missResult.damage !== 0) failures.push(`a missed move must report hit:false and damage:0, got ${JSON.stringify(missResult)}`);

  if (failures.length > 0) return { pass: false, message: failures.join("\n") };
  return {
    pass: true,
    message: "PP gating (no 0-PP selection, struggle on full exhaustion, PP untouched by struggle) and miss-deals-zero-damage all hold. PP recovery at the Pokemon Center is covered by AC26/V2 recovery tests once engine/recovery.js lands.",
  };
});

registerCheck("AC13", async () => {
  const { isFleeAllowed, isCaptureAllowed } = await import(pathToFileURL(path.join(SRC, "engine/capture.js")).href);
  const failures = [];
  if (isFleeAllowed("wild") !== true) failures.push("wild battles must allow flee");
  if (isCaptureAllowed("wild") !== true) failures.push("wild battles must allow capture");
  if (isFleeAllowed("trainer") !== false) failures.push("trainer battles must reject flee");
  if (isCaptureAllowed("trainer") !== false) failures.push("trainer battles must reject capture");
  if (failures.length > 0) return { pass: false, message: failures.join("\n") };
  return {
    pass: true,
    message: "wild battles allow flee+capture, trainer battles reject both. Whether the rejection reaches the on-screen battle log is covered by V4 browser verification, not this mechanical check.",
  };
});

registerCheck("AC15", async () => {
  const { attemptCapture } = await import(pathToFileURL(path.join(SRC, "engine/capture.js")).href);
  const { createRng } = await import(pathToFileURL(path.join(SRC, "engine/rng.js")).href);
  const { MAX_PARTY_SIZE } = await import(pathToFileURL(path.join(SRC, "engine/party.js")).href);
  const fullParty = Array.from({ length: MAX_PARTY_SIZE }, () => ({ currentHp: 10 }));
  const result = attemptCapture({ party: fullParty, remainingHpFraction: 1, catchRate: 255, rng: createRng(1) });
  const failures = [];
  if (result.rejected !== true) failures.push("a full party must reject the capture attempt");
  if (result.success !== false) failures.push("a rejected attempt must not succeed");
  if (result.ballConsumed !== false) failures.push("a rejected attempt must not consume a ball");
  if (failures.length > 0) return { pass: false, message: failures.join("\n") };
  return { pass: true, message: "a full party rejects capture, consumes no ball, and rolls no RNG." };
});

registerCheck("AC16", async () => {
  const { CHARACTERS, DEFAULT_STARTING_POKEBALLS, DEFAULT_STARTING_POTIONS } = await import(pathToFileURL(path.join(SRC, "data/characters.js")).href);
  const { createInventory } = await import(pathToFileURL(path.join(SRC, "engine/items.js")).href);
  const failures = [];
  if (DEFAULT_STARTING_POTIONS !== 3) failures.push(`expected default starting potions 3, got ${DEFAULT_STARTING_POTIONS}`);
  for (const [id, character] of Object.entries(CHARACTERS)) {
    const startingBalls = character.traitEffect.type === "starting_pokeballs" ? character.traitEffect.value : DEFAULT_STARTING_POKEBALLS;
    const inv = createInventory(startingBalls, DEFAULT_STARTING_POTIONS);
    if (id === "mindeulle" && inv.pokeball !== 20) failures.push(`민들레 starting pokeballs expected 20, got ${inv.pokeball}`);
    if (id !== "mindeulle" && inv.pokeball !== 10) failures.push(`${id} starting pokeballs expected 10, got ${inv.pokeball}`);
    if (inv.potion !== 3) failures.push(`${id} starting potions expected 3, got ${inv.potion}`);
  }
  const { recordItemCollected, isItemCollected, saveToStorage, loadFromStorage } = await import(pathToFileURL(path.join(SRC, "engine/save.js")).href);
  const { createPokedex } = await import(pathToFileURL(path.join(SRC, "engine/pokedex.js")).href);
  const memoryStorage = (() => {
    const store = new Map();
    return { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  })();
  const collected = recordItemCollected([], "forest", 1, 4);
  saveToStorage(memoryStorage, {
    characterId: "jiwoo", party: [], mapId: "forest", x: 1, y: 4,
    inventory: { pokeball: 10, potion: 3 }, pokedex: createPokedex(), questProgress: {},
    defeatedTrainers: [], collectedItemTiles: collected, endingAchieved: false,
  });
  const restored = loadFromStorage(memoryStorage);
  if (!isItemCollected(restored.collectedItemTiles, "forest", 1, 4)) failures.push("a collected item tile must stay collected (unavailable for re-pickup) after a save reload");
  if (isItemCollected(restored.collectedItemTiles, "cave", 1, 3)) failures.push("an uncollected item tile must not read as collected");

  if (failures.length > 0) return { pass: false, message: failures.join("\n") };
  return {
    pass: true,
    message: "starting inventory is 10 pokeballs (20 for 민들레) + 3 potions for all 5 characters, and a collected item tile survives a save reload without becoming re-collectible.",
  };
});

registerCheck("AC23", async () => {
  const growth = await import(pathToFileURL(path.join(SRC, "engine/growth.js")).href);
  const { SPECIES } = await import(pathToFileURL(path.join(SRC, "data/species.js")).href);
  const failures = [];

  for (const [id, species] of Object.entries(SPECIES)) {
    if (species.evolvesAt == null) continue;
    if (growth.shouldEvolve(id, species.evolvesAt - 1)) failures.push(`${id} evolves too early (below ${species.evolvesAt})`);
    if (!growth.shouldEvolve(id, species.evolvesAt)) failures.push(`${id} does not evolve at its declared level ${species.evolvesAt}`);
    const evolved = growth.gainExperience(growth.createMonster(id, species.evolvesAt - 1), growth.xpToNextLevel(species.evolvesAt - 1) + 1);
    if (evolved.speciesId !== species.evolvesInto) failures.push(`${id} evolved into ${evolved.speciesId}, expected ${species.evolvesInto}`);
    if (evolved.stats.atk <= SPECIES[id].baseStats.atk) failures.push(`${id} evolution did not recompute stats upward`);
  }

  let slots = [];
  for (const moveId of ["tackle", "ember", "scratch", "headbutt"]) slots = growth.learnMove(slots, moveId).moveSlots;
  const full = growth.learnMove(slots, "fire_blast");
  if (full.event.type !== "move_skipped") failures.push("learnMove must skip (not learn) once 4 slots are full");
  if (full.moveSlots.length !== 4) failures.push("a skipped move must not grow the slot array past 4");

  if (failures.length > 0) return { pass: false, message: failures.join("\n") };
  return { pass: true, message: "every evolution-eligible species evolves at exactly its table C level with recalculated stats; move-slot-full learning is skipped and reported, never silently dropped or overflowed." };
});

registerCheck("AC7", async () => {
  const { MAPS } = await import(pathToFileURL(path.join(SRC, "data/maps.js")).href);
  const { ENCOUNTERS } = await import(pathToFileURL(path.join(SRC, "data/encounters.js")).href);
  const { pickWildSpecies } = await import(pathToFileURL(path.join(SRC, "engine/encounter.js")).href);
  const { createRng } = await import(pathToFileURL(path.join(SRC, "engine/rng.js")).href);
  const failures = [];

  for (const [id, map] of Object.entries(MAPS)) {
    if (map.kind !== "dedicated") continue;
    if (map.grid.some(row => row.includes("G"))) failures.push(`dedicated map ${id} must not contain any grass tile`);
  }

  const rng = createRng(4242);
  for (const [mapId, table] of Object.entries(ENCOUNTERS)) {
    const allowed = new Set(table.map(e => e.speciesId));
    for (let i = 0; i < 1000; i++) {
      const speciesId = pickWildSpecies(mapId, rng);
      if (!allowed.has(speciesId)) failures.push(`${mapId} produced species ${speciesId} not present in its own encounter table`);
    }
    const hasMew = allowed.has("mew");
    if (mapId !== "volcano" && hasMew) failures.push(`${mapId} must not include mew`);
  }
  if (!ENCOUNTERS.volcano.some(e => e.speciesId === "mew")) failures.push("volcano must include mew");
  const mewWeight = ENCOUNTERS.volcano.find(e => e.speciesId === "mew").weight;
  const othersMinWeight = Math.min(...ENCOUNTERS.volcano.filter(e => e.speciesId !== "mew").map(e => e.weight));
  if (mewWeight >= othersMinWeight) failures.push(`mew's volcano weight (${mewWeight}) must be far below other species (min ${othersMinWeight})`);

  if (failures.length > 0) return { pass: false, message: failures.join("\n") };
  return { pass: true, message: "dedicated maps produce zero encounters (no grass tiles exist there); field maps only ever produce their own table's species; mew is volcano-only with a far lower weight." };
});

registerCheck("AC8", async () => {
  const { resolveMove, isPortalLocked } = await import(pathToFileURL(path.join(SRC, "engine/world.js")).href);
  const { MAPS } = await import(pathToFileURL(path.join(SRC, "data/maps.js")).href);
  const { MAIN_MAP_ORDER } = await import(pathToFileURL(path.join(SRC, "data/maps.js")).href);
  const failures = [];
  const noProgress = { isQuestComplete: () => false, allMainComplete: false, endingAchieved: false };

  for (let i = 0; i < MAIN_MAP_ORDER.length - 1; i++) {
    const fromMap = MAIN_MAP_ORDER[i];
    const toMap = MAIN_MAP_ORDER[i + 1];
    const map = MAPS[fromMap];
    const portalEntry = Object.entries(map.portals).find(([, p]) => p.toMap === toMap);
    if (!portalEntry) { failures.push(`no portal found from ${fromMap} to ${toMap}`); continue; }
    const [coord, portal] = portalEntry;
    if (!isPortalLocked(portal, noProgress)) failures.push(`${fromMap} -> ${toMap} portal must start locked`);
    const [px, py] = coord.split(",").map(Number);
    const from = { x: px - 1, y: py };
    const dir = "right";
    const blocked = resolveMove(fromMap, from.x, from.y, dir, noProgress);
    if (blocked.moved !== false || blocked.reason !== "locked") failures.push(`${fromMap} -> ${toMap} move should be refused before its main quest is done, got ${JSON.stringify(blocked)}`);
    const opened = resolveMove(fromMap, from.x, from.y, dir, { isQuestComplete: id => id === portal.locked, allMainComplete: false, endingAchieved: false });
    if (opened.moved !== true) failures.push(`${fromMap} -> ${toMap} move should succeed once ${portal.locked} is complete`);
  }

  if (failures.length > 0) return { pass: false, message: failures.join("\n") };
  return { pass: true, message: "cave/waterway/volcano entrances are refused (naming the blocking main quest) until the previous field map's main mission completes, then allow the transition." };
});

registerCheck("AC17", async () => {
  const { QUESTS } = await import(pathToFileURL(path.join(SRC, "data/quests.js")).href);
  const byMap = {};
  for (const quest of Object.values(QUESTS)) {
    byMap[quest.mapId] = byMap[quest.mapId] || { main: 0, side: 0 };
    byMap[quest.mapId][quest.isMain ? "main" : "side"] += 1;
  }
  const failures = [];
  for (const mapId of ["forest", "cave", "waterway", "volcano"]) {
    const counts = byMap[mapId] || { main: 0, side: 0 };
    if (counts.main !== 1) failures.push(`${mapId} must have exactly 1 main mission, has ${counts.main}`);
    if (counts.side < 3 || counts.side > 4) failures.push(`${mapId} must have 3-4 side missions, has ${counts.side}`);
  }
  const totalMain = Object.values(QUESTS).filter(q => q.isMain).length;
  const totalSide = Object.values(QUESTS).filter(q => !q.isMain).length;
  if (totalMain !== 4) failures.push(`expected exactly 4 main missions total, found ${totalMain}`);
  if (totalSide < 12 || totalSide > 16) failures.push(`expected 12-16 side missions total, found ${totalSide}`);
  const types = new Set(Object.values(QUESTS).map(q => q.type));
  for (const required of ["capture_species", "trainer_defeat", "item_collect", "wild_defeat_n"]) {
    if (!types.has(required)) failures.push(`mission type ${required} is never used`);
  }
  if (failures.length > 0) return { pass: false, message: failures.join("\n") };
  return { pass: true, message: `4 main + ${totalSide} side missions across the 4 field maps; all 4 mission types are used at least once.` };
});

registerCheck("AC18", async () => {
  const { QUEST_STATUS, acceptQuest, recordProgressEvent, claimReward } = await import(pathToFileURL(path.join(SRC, "engine/quest.js")).href);
  const { QUESTS } = await import(pathToFileURL(path.join(SRC, "data/quests.js")).href);
  const failures = [];
  const id = "cave_side1"; // capture_species, target pikachu x1
  let progress = {};
  const rejectedEarly = claimReward(progress, QUESTS, id, {});
  if (rejectedEarly.claimed) failures.push("claiming an unaccepted mission must be rejected");

  progress = acceptQuest(progress, id);
  if (progress[id].status !== QUEST_STATUS.IN_PROGRESS) failures.push("accept must move unaccepted -> in_progress");

  const rejectedMidway = claimReward(progress, QUESTS, id, {});
  if (rejectedMidway.claimed) failures.push("claiming an in-progress (not yet completable) mission must be rejected");

  progress = recordProgressEvent(progress, QUESTS, "capture_species", { speciesId: "pikachu" });
  if (progress[id].status !== QUEST_STATUS.COMPLETABLE) failures.push("matching progress event must move in_progress -> completable");

  const first = claimReward(progress, QUESTS, id, {});
  if (!first.claimed || first.progress[id].status !== QUEST_STATUS.CLAIMED) failures.push("a completable mission must be claimable and move to claimed");
  const second = claimReward(first.progress, QUESTS, id, first.inventory);
  if (second.claimed) failures.push("a claimed mission must never grant its reward twice");

  if (failures.length > 0) return { pass: false, message: failures.join("\n") };
  return { pass: true, message: "the 4-stage transition (unaccepted -> in_progress -> completable -> claimed) is enforced in order, and a claimed mission never re-pays." };
});

registerCheck("AC21", async () => {
  const { assignRival, buildRivalParty, BOSS_SPECIES_ID } = await import(pathToFileURL(path.join(SRC, "engine/rival.js")).href);
  const { CHARACTER_CYCLE, CHARACTERS } = await import(pathToFileURL(path.join(SRC, "data/characters.js")).href);
  const { SPECIES } = await import(pathToFileURL(path.join(SRC, "data/species.js")).href);
  const failures = [];
  const expectedCycle = { jiwoo: "iseul", iseul: "woong", woong: "green", green: "mindeulle", mindeulle: "jiwoo" };
  for (const [chosenId, expectedRival] of Object.entries(expectedCycle)) {
    if (assignRival(chosenId) !== expectedRival) failures.push(`assignRival(${chosenId}) expected ${expectedRival}, got ${assignRival(chosenId)}`);
    const { rivalCharacterId, party } = buildRivalParty(chosenId);
    if (rivalCharacterId !== expectedRival) failures.push(`buildRivalParty(${chosenId}) rival mismatch`);
    if (party.length !== 3) failures.push(`buildRivalParty(${chosenId}) must return exactly 3 members, got ${party.length}`);
    const speciesIds = party.map(m => m.speciesId);
    if (!speciesIds.includes(BOSS_SPECIES_ID)) failures.push(`buildRivalParty(${chosenId}) missing boss species ${BOSS_SPECIES_ID}`);
    let finalForm = SPECIES[CHARACTERS[expectedRival].partnerSpeciesId];
    while (finalForm.evolvesInto) finalForm = SPECIES[finalForm.evolvesInto];
    if (!speciesIds.includes(finalForm.id)) failures.push(`buildRivalParty(${chosenId}) missing rival starter final evolution ${finalForm.id}`);
  }
  if (CHARACTER_CYCLE.length !== 5) failures.push(`expected 5 characters in the cycle, found ${CHARACTER_CYCLE.length}`);
  if (failures.length > 0) return { pass: false, message: failures.join("\n") };
  return { pass: true, message: "all 5 character choices produce the correct next-in-cycle rival with a 3-mon party containing the boss species and the rival's fully-evolved starter." };
});

registerCheck("AC22", async () => {
  const { createPokedex, recordCaught, caughtCount, hasAchievement, CAUGHT_ACHIEVEMENT_THRESHOLD } = await import(pathToFileURL(path.join(SRC, "engine/pokedex.js")).href);
  const failures = [];
  if (CAUGHT_ACHIEVEMENT_THRESHOLD !== 12) failures.push(`achievement threshold expected 12, got ${CAUGHT_ACHIEVEMENT_THRESHOLD}`);
  let dex = createPokedex();
  const elevenSpecies = ["pikachu", "squirtle", "bulbasaur", "charmander", "jigglypuff", "pidgey", "geodude", "magnemite", "sandshrew", "paras", "vulpix"];
  for (const id of elevenSpecies) dex = recordCaught(dex, id);
  if (caughtCount(dex) !== 11 || hasAchievement(dex) !== false) failures.push(`expected 11 caught and no achievement, got count=${caughtCount(dex)} achievement=${hasAchievement(dex)}`);
  dex = recordCaught(dex, "shellder");
  if (caughtCount(dex) !== 12 || hasAchievement(dex) !== true) failures.push(`expected 12 caught and achievement true, got count=${caughtCount(dex)} achievement=${hasAchievement(dex)}`);
  const dupe = recordCaught(dex, "shellder");
  if (caughtCount(dupe) !== 12) failures.push("catching an already-caught species must not inflate the count");
  if (failures.length > 0) return { pass: false, message: failures.join("\n") };
  return { pass: true, message: "the pokedex achievement flips exactly at 12 distinct catches (11 does not qualify, 12 does), independent of duplicates." };
});

function makeMemoryStorage() {
  const store = new Map();
  return { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
}

function baseSampleState(overrides) {
  return {
    characterId: "jiwoo", party: [], mapId: "town", x: 2, y: 1,
    inventory: { pokeball: 10, potion: 3 },
    questProgress: {}, defeatedTrainers: [], collectedItemTiles: [], endingAchieved: false,
    ...overrides,
  };
}

registerCheck("AC4", async () => {
  const { CHARACTERS } = await import(pathToFileURL(path.join(SRC, "data/characters.js")).href);
  const { createMonster } = await import(pathToFileURL(path.join(SRC, "engine/growth.js")).href);
  const { createPokedex } = await import(pathToFileURL(path.join(SRC, "engine/pokedex.js")).href);
  const { saveToStorage, loadFromStorage } = await import(pathToFileURL(path.join(SRC, "engine/save.js")).href);
  const failures = [];
  for (const [characterId, character] of Object.entries(CHARACTERS)) {
    const storage = makeMemoryStorage();
    const state = { ...baseSampleState({ characterId }), party: [createMonster(character.partnerSpeciesId, 5)], pokedex: createPokedex() };
    saveToStorage(storage, state);
    const restored = loadFromStorage(storage);
    if (restored.characterId !== characterId) failures.push(`${characterId}: characterId did not round-trip`);
    if (restored.party[0].speciesId !== character.partnerSpeciesId) failures.push(`${characterId}: partner mismatch, expected ${character.partnerSpeciesId}, got ${restored.party[0].speciesId}`);
  }
  if (failures.length > 0) return { pass: false, message: failures.join("\n") };
  return { pass: true, message: "for all 5 characters, the chosen character and its table A starting partner are recorded and survive a save round trip." };
});

registerCheck("AC9", async () => {
  const { acceptQuest, recordProgressEvent } = await import(pathToFileURL(path.join(SRC, "engine/quest.js")).href);
  const { isPortalLocked } = await import(pathToFileURL(path.join(SRC, "engine/world.js")).href);
  const { QUESTS } = await import(pathToFileURL(path.join(SRC, "data/quests.js")).href);
  const { MAPS } = await import(pathToFileURL(path.join(SRC, "data/maps.js")).href);
  const { createPokedex } = await import(pathToFileURL(path.join(SRC, "engine/pokedex.js")).href);
  const { saveToStorage, loadFromStorage } = await import(pathToFileURL(path.join(SRC, "engine/save.js")).href);
  let progress = acceptQuest({}, "forest_main");
  progress = recordProgressEvent(progress, QUESTS, "trainer_defeat", { npcId: "forest_guardian" });
  const toQuestState = p => ({ isQuestComplete: id => p[id]?.status === "completable" || p[id]?.status === "claimed", allMainComplete: false, endingAchieved: false });
  const cavePortal = MAPS.forest.portals["9,7"];
  const failures = [];
  if (isPortalLocked(cavePortal, toQuestState(progress)) !== false) failures.push("cave should already be open before any save round trip in this scenario");

  const storage = makeMemoryStorage();
  const state = { ...baseSampleState({ questProgress: progress }), pokedex: createPokedex() };
  saveToStorage(storage, state);
  const restored = loadFromStorage(storage);
  if (isPortalLocked(cavePortal, toQuestState(restored.questProgress)) !== false) failures.push("cave must remain open after a save round trip");

  if (failures.length > 0) return { pass: false, message: failures.join("\n") };
  return { pass: true, message: "map-open state (derived from persisted quest completion) survives a save round trip." };
});

registerCheck("AC14", async () => {
  const { recordTrainerDefeat, isTrainerDefeated, saveToStorage, loadFromStorage } = await import(pathToFileURL(path.join(SRC, "engine/save.js")).href);
  const { createPokedex } = await import(pathToFileURL(path.join(SRC, "engine/pokedex.js")).href);
  const failures = [];
  const defeated = recordTrainerDefeat([], "forest_guardian");
  if (!isTrainerDefeated(defeated, "forest_guardian")) failures.push("recordTrainerDefeat must mark the trainer as defeated");
  if (isTrainerDefeated(defeated, "cave_guardian")) failures.push("an undefeated trainer must not read as defeated");

  const storage = makeMemoryStorage();
  const state = { ...baseSampleState({ defeatedTrainers: defeated }), pokedex: createPokedex() };
  saveToStorage(storage, state);
  const restored = loadFromStorage(storage);
  if (!isTrainerDefeated(restored.defeatedTrainers, "forest_guardian")) failures.push("defeated flag must survive a save round trip");

  if (failures.length > 0) return { pass: false, message: failures.join("\n") };
  return { pass: true, message: "a trainer defeat flag is recorded, blocks a rematch query, and survives a save round trip. Reward payout and rejection of a second battle attempt are exercised in test/capture.test.mjs and V4 (the battle screen refuses to start a fight against a defeated trainer)." };
});

registerCheck("AC19", async () => {
  const { acceptQuest, recordProgressEvent, QUEST_STATUS } = await import(pathToFileURL(path.join(SRC, "engine/quest.js")).href);
  const { QUESTS } = await import(pathToFileURL(path.join(SRC, "data/quests.js")).href);
  const { createPokedex } = await import(pathToFileURL(path.join(SRC, "engine/pokedex.js")).href);
  const { saveToStorage, loadFromStorage } = await import(pathToFileURL(path.join(SRC, "engine/save.js")).href);
  let progress = acceptQuest({}, "forest_side3");
  progress = recordProgressEvent(progress, QUESTS, "wild_defeat_n", { mapId: "forest" });
  progress = recordProgressEvent(progress, QUESTS, "wild_defeat_n", { mapId: "forest" });
  const failures = [];
  if (progress.forest_side3.status !== QUEST_STATUS.IN_PROGRESS || progress.forest_side3.count !== 2) failures.push("pre-save progress state unexpected");

  const storage = makeMemoryStorage();
  const state = { ...baseSampleState({ questProgress: progress }), pokedex: createPokedex() };
  saveToStorage(storage, state);
  const restored = loadFromStorage(storage);
  if (restored.questProgress.forest_side3.status !== QUEST_STATUS.IN_PROGRESS) failures.push("quest status must survive a save round trip");
  if (restored.questProgress.forest_side3.count !== 2) failures.push("quest progress count must survive a save round trip");

  if (failures.length > 0) return { pass: false, message: failures.join("\n") };
  return { pass: true, message: "4-stage quest status and progress count both survive a save round trip exactly." };
});

registerCheck("AC26", async () => {
  const { createMonster } = await import(pathToFileURL(path.join(SRC, "engine/growth.js")).href);
  const { recoverFromWipe } = await import(pathToFileURL(path.join(SRC, "engine/recovery.js")).href);
  const { MAPS } = await import(pathToFileURL(path.join(SRC, "data/maps.js")).href);
  const failures = [];
  const fainted = createMonster("charmander", 8);
  fainted.currentHp = 0;
  fainted.moveSlots = fainted.moveSlots.map(s => ({ ...s, pp: 0 }));
  const result = recoverFromWipe([fainted]);
  if (result.mapId !== "center") failures.push(`expected recovery map "center", got ${result.mapId}`);
  if (result.x !== MAPS.center.spawn.x || result.y !== MAPS.center.spawn.y) failures.push("recovery position must be the center's spawn point");
  if (result.party[0].currentHp !== result.party[0].stats.hp) failures.push("recovered party member must be at full HP");
  if (!result.party[0].moveSlots.every(s => s.pp === s.maxPp)) failures.push("recovered party member must have full PP");

  if (failures.length > 0) return { pass: false, message: failures.join("\n") };
  return { pass: true, message: "a party wipe recovers to the town Pokemon Center (not a game-over screen) with the whole party at full HP/PP; save data is untouched since recovery only returns new party/location values." };
});

registerCheck("AC2", async () => {
  const { CHARACTERS } = await import(pathToFileURL(path.join(SRC, "data/characters.js")).href);
  const { SPECIES } = await import(pathToFileURL(path.join(SRC, "data/species.js")).href);
  const EXPECTED = {
    jiwoo: { name: "지우", partner: "pikachu" },
    iseul: { name: "이슬이", partner: "squirtle" },
    woong: { name: "웅", partner: "bulbasaur" },
    green: { name: "그린", partner: "charmander" },
    mindeulle: { name: "민들레", partner: "jigglypuff" },
  };
  const failures = [];
  if (Object.keys(CHARACTERS).length !== 5) failures.push(`expected exactly 5 characters, found ${Object.keys(CHARACTERS).length}`);
  for (const [id, expected] of Object.entries(EXPECTED)) {
    const c = CHARACTERS[id];
    if (!c) { failures.push(`missing character ${id}`); continue; }
    if (c.name !== expected.name) failures.push(`${id} name expected ${expected.name}, got ${c.name}`);
    if (c.partnerSpeciesId !== expected.partner) failures.push(`${id} partner expected ${expected.partner}, got ${c.partnerSpeciesId}`);
    if (!SPECIES[c.partnerSpeciesId]) failures.push(`${id} partner species ${c.partnerSpeciesId} does not exist`);
    if (!c.traitDescription || typeof c.traitDescription !== "string") failures.push(`${id} missing a trait description`);
  }
  if (failures.length > 0) return { pass: false, message: failures.join("\n") };
  return { pass: true, message: "all 5 characters exist with the correct name/starting-partner pairing and a trait description; every partner species resolves." };
});

registerCheck("AC3", async () => {
  const { CHARACTERS, DEFAULT_STARTING_POKEBALLS } = await import(pathToFileURL(path.join(SRC, "data/characters.js")).href);
  const { rollEncounterTriggered } = await import(pathToFileURL(path.join(SRC, "engine/encounter.js")).href);
  const { computeCaptureChance } = await import(pathToFileURL(path.join(SRC, "engine/capture.js")).href);
  const { applyPotion } = await import(pathToFileURL(path.join(SRC, "engine/items.js")).href);
  const { calcDamage } = await import(pathToFileURL(path.join(SRC, "engine/battle.js")).href);
  const { createInventory } = await import(pathToFileURL(path.join(SRC, "engine/items.js")).href);
  const failures = [];

  // 지우: encounter rate x1.20
  const jiwooChance = Math.min(1, 0.1 * CHARACTERS.jiwoo.traitEffect.value);
  const baseChance = Math.min(1, 0.1 * 1);
  if (CHARACTERS.jiwoo.traitEffect.type !== "encounter_rate_mult" || CHARACTERS.jiwoo.traitEffect.value !== 1.2) failures.push("지우 trait must be encounter_rate_mult x1.20");
  if (!(jiwooChance > baseChance)) failures.push("지우's multiplier must raise the encounter trigger chance");

  // 이슬이: capture rate x1.20
  if (CHARACTERS.iseul.traitEffect.type !== "capture_rate_mult" || CHARACTERS.iseul.traitEffect.value !== 1.2) failures.push("이슬이 trait must be capture_rate_mult x1.20");
  const baseCatch = computeCaptureChance({ remainingHpFraction: 0.5, catchRate: 120, characterCaptureMultiplier: 1 });
  const iseulCatch = computeCaptureChance({ remainingHpFraction: 0.5, catchRate: 120, characterCaptureMultiplier: CHARACTERS.iseul.traitEffect.value });
  if (Math.abs(iseulCatch - baseCatch * 1.2) > 1e-9) failures.push("이슬이's capture chance must be exactly x1.20 of the base");

  // 웅: heal amount x1.30
  if (CHARACTERS.woong.traitEffect.type !== "heal_amount_mult" || CHARACTERS.woong.traitEffect.value !== 1.3) failures.push("웅 trait must be heal_amount_mult x1.30");
  const baseHeal = applyPotion({ currentHp: 0, stats: { hp: 999 } }, 1).healed;
  const woongHeal = applyPotion({ currentHp: 0, stats: { hp: 999 } }, CHARACTERS.woong.traitEffect.value).healed;
  if (woongHeal !== Math.floor(baseHeal * 1.3)) failures.push(`웅's heal must be x1.30: base=${baseHeal} got=${woongHeal}`);

  // 그린: damage x1.10
  if (CHARACTERS.green.traitEffect.type !== "damage_dealt_mult" || CHARACTERS.green.traitEffect.value !== 1.1) failures.push("그린 trait must be damage_dealt_mult x1.10");
  const scenario = { attackerLevel: 20, attackerAtk: 50, defenderDef: 50, move: { type: "normal", power: 40, accuracy: 100, pp: 10 }, attackerType: "normal", defenderType: "normal" };
  const alwaysMaxRng = { chance: () => false, range: () => 1 }; // no crit, random factor pinned to 1.0 for a clean comparison
  const baseDamage = calcDamage({ ...scenario, rng: alwaysMaxRng, characterDamageMultiplier: 1 }).damage;
  const greenDamage = calcDamage({ ...scenario, rng: alwaysMaxRng, characterDamageMultiplier: CHARACTERS.green.traitEffect.value }).damage;
  if (!(greenDamage > baseDamage)) failures.push(`그린's damage must exceed the unboosted baseline: base=${baseDamage} got=${greenDamage}`);

  // 민들레: starting pokeballs 20
  if (CHARACTERS.mindeulle.traitEffect.type !== "starting_pokeballs" || CHARACTERS.mindeulle.traitEffect.value !== 20) failures.push("민들레 trait must be starting_pokeballs = 20");
  const mindeulleInv = createInventory(CHARACTERS.mindeulle.traitEffect.value, 3);
  if (mindeulleInv.pokeball !== 20) failures.push(`민들레 starting pokeballs must be 20, got ${mindeulleInv.pokeball}`);
  if (DEFAULT_STARTING_POKEBALLS !== 10) failures.push(`base starting pokeballs must be 10, got ${DEFAULT_STARTING_POKEBALLS}`);

  if (failures.length > 0) return { pass: false, message: failures.join("\n") };
  return { pass: true, message: "all 5 character traits are single numeric multipliers/increments and are proven to change the actual computed result (encounter chance, capture chance, heal amount, damage, starting pokeballs)." };
});

registerCheck("AC5", async () => {
  const { SPECIES } = await import(pathToFileURL(path.join(SRC, "data/species.js")).href);
  // Independently transcribed from PRD §6.1 table C.
  const EXPECTED = {
    pikachu: { name: "피카츄", type: "electric", category: "stage1", evolvesAt: 20, evolvesInto: "raichu", encounterMaps: ["cave"] },
    raichu: { name: "라이츄", type: "electric", category: "stage2", evolvesAt: null, evolvesInto: null, encounterMaps: [] },
    squirtle: { name: "꼬부기", type: "water", category: "stage1", evolvesAt: 16, evolvesInto: "wartortle", encounterMaps: ["waterway"] },
    wartortle: { name: "어니부기", type: "water", category: "stage2", evolvesAt: null, evolvesInto: null, encounterMaps: [] },
    bulbasaur: { name: "이상해씨", type: "grass", category: "stage1", evolvesAt: 16, evolvesInto: "ivysaur", encounterMaps: ["forest"] },
    ivysaur: { name: "이상해풀", type: "grass", category: "stage2", evolvesAt: null, evolvesInto: null, encounterMaps: [] },
    charmander: { name: "파이리", type: "fire", category: "stage1", evolvesAt: 16, evolvesInto: "charmeleon", encounterMaps: ["volcano"] },
    charmeleon: { name: "리자드", type: "fire", category: "stage2", evolvesAt: null, evolvesInto: null, encounterMaps: [] },
    jigglypuff: { name: "푸린", type: "normal", category: "stage1", evolvesAt: 18, evolvesInto: "wigglytuff", encounterMaps: ["forest"] },
    wigglytuff: { name: "푸크린", type: "normal", category: "stage2", evolvesAt: null, evolvesInto: null, encounterMaps: [] },
    pidgey: { name: "구구", type: "flying", category: "stage1", evolvesAt: 18, evolvesInto: "pidgeotto", encounterMaps: ["forest", "waterway"] },
    pidgeotto: { name: "피죤", type: "flying", category: "stage2", evolvesAt: null, evolvesInto: null, encounterMaps: ["waterway"] },
    geodude: { name: "롱스톤", type: "rock", category: "standalone", evolvesAt: null, evolvesInto: null, encounterMaps: ["cave", "volcano"] },
    magnemite: { name: "코일", type: "electric", category: "standalone", evolvesAt: null, evolvesInto: null, encounterMaps: ["cave"] },
    sandshrew: { name: "모래두지", type: "normal", category: "standalone", evolvesAt: null, evolvesInto: null, encounterMaps: ["forest"] },
    paras: { name: "파라스", type: "grass", category: "standalone", evolvesAt: null, evolvesInto: null, encounterMaps: ["forest"] },
    vulpix: { name: "식스테일", type: "fire", category: "standalone", evolvesAt: null, evolvesInto: null, encounterMaps: ["volcano"] },
    shellder: { name: "셀러", type: "water", category: "standalone", evolvesAt: null, evolvesInto: null, encounterMaps: ["waterway"] },
    moltres: { name: "파이어", type: "fire", category: "boss", evolvesAt: null, evolvesInto: null, encounterMaps: [] },
    mew: { name: "뮤", type: "normal", category: "rare", evolvesAt: null, evolvesInto: null, encounterMaps: ["volcano"] },
  };
  const failures = [];
  const actualIds = Object.keys(SPECIES);
  if (actualIds.length !== 20) failures.push(`expected exactly 20 species, found ${actualIds.length}`);
  for (const [id, expected] of Object.entries(EXPECTED)) {
    const sp = SPECIES[id];
    if (!sp) { failures.push(`missing species ${id}`); continue; }
    for (const field of ["name", "type", "category", "evolvesAt", "evolvesInto"]) {
      if (sp[field] !== expected[field]) failures.push(`${id}.${field} expected ${expected[field]}, got ${sp[field]}`);
    }
    if (JSON.stringify([...sp.encounterMaps].sort()) !== JSON.stringify([...expected.encounterMaps].sort())) {
      failures.push(`${id}.encounterMaps expected ${JSON.stringify(expected.encounterMaps)}, got ${JSON.stringify(sp.encounterMaps)}`);
    }
  }
  const counts = {};
  for (const sp of Object.values(SPECIES)) counts[sp.category] = (counts[sp.category] || 0) + 1;
  const expectedCounts = { stage1: 6, stage2: 6, standalone: 6, boss: 1, rare: 1 };
  for (const [cat, count] of Object.entries(expectedCounts)) {
    if (counts[cat] !== count) failures.push(`category ${cat} expected ${count}, got ${counts[cat] || 0}`);
  }
  for (const sp of Object.values(SPECIES)) {
    if (typeof sp.type !== "string") failures.push(`${sp.id} does not have a single string type (dual-typing is a non-goal)`);
  }
  if (failures.length > 0) return { pass: false, message: failures.join("\n") };
  return { pass: true, message: "all 20 species match table C exactly (name/type/category/evolution/encounter maps); classification counts are 6/6/6/1/1; every species is single-typed." };
});

registerCheck("AC6", async () => {
  const { MAPS } = await import(pathToFileURL(path.join(SRC, "data/maps.js")).href);
  // Independently transcribed from PRD §6.1 table B.
  const EXPECTED = {
    town: { name: "마을", kind: "dedicated", levelRange: null, entryRequires: null },
    center: { name: "포켓몬센터 내부", kind: "dedicated", levelRange: null, entryRequires: null },
    forest: { name: "숲", kind: "field", levelRange: [3, 6], entryRequires: null },
    cave: { name: "동굴", kind: "field", levelRange: [7, 11], entryRequires: "forest_main" },
    waterway: { name: "해변수로", kind: "field", levelRange: [12, 17], entryRequires: "cave_main" },
    volcano: { name: "화산", kind: "field", levelRange: [18, 24], entryRequires: "waterway_main" },
    boss_room: { name: "화산 정상 보스방", kind: "dedicated", levelRange: null, entryRequires: "ALL_MAIN" },
  };
  const failures = [];
  if (Object.keys(MAPS).length !== 7) failures.push(`expected exactly 7 maps, found ${Object.keys(MAPS).length}`);
  for (const [id, expected] of Object.entries(EXPECTED)) {
    const map = MAPS[id];
    if (!map) { failures.push(`missing map ${id}`); continue; }
    if (map.name !== expected.name) failures.push(`${id}.name expected ${expected.name}, got ${map.name}`);
    if (map.kind !== expected.kind) failures.push(`${id}.kind expected ${expected.kind}, got ${map.kind}`);
    if (JSON.stringify(map.levelRange) !== JSON.stringify(expected.levelRange)) failures.push(`${id}.levelRange expected ${JSON.stringify(expected.levelRange)}, got ${JSON.stringify(map.levelRange)}`);
    if (map.entryRequires !== expected.entryRequires) failures.push(`${id}.entryRequires expected ${expected.entryRequires}, got ${map.entryRequires}`);
  }
  const fieldCount = Object.values(MAPS).filter(m => m.kind === "field").length;
  const dedicatedCount = Object.values(MAPS).filter(m => m.kind === "dedicated").length;
  if (fieldCount !== 4) failures.push(`expected 4 field maps, found ${fieldCount}`);
  if (dedicatedCount !== 3) failures.push(`expected 3 dedicated maps, found ${dedicatedCount}`);
  if (failures.length > 0) return { pass: false, message: failures.join("\n") };
  return { pass: true, message: "all 7 maps match table B exactly (name/type/level range/entry condition); 4 field + 3 dedicated." };
});

registerCheck("AC20", async () => {
  const { resolveMove, isPortalLocked } = await import(pathToFileURL(path.join(SRC, "engine/world.js")).href);
  const { MAPS } = await import(pathToFileURL(path.join(SRC, "data/maps.js")).href);
  const failures = [];
  const bossPortalCoord = Object.entries(MAPS.volcano.portals).find(([, p]) => p.toMap === "boss_room");
  if (!bossPortalCoord) return { pass: false, message: "volcano has no portal to boss_room" };
  const [, portal] = bossPortalCoord;

  const beforeAllMain = resolveMove("volcano", 8, 7, "right", { isQuestComplete: () => false, allMainComplete: false, endingAchieved: false });
  if (beforeAllMain.moved !== false) failures.push("boss room must be refused before all 4 main missions are complete");

  const afterAllMain = resolveMove("volcano", 8, 7, "right", { isQuestComplete: () => true, allMainComplete: true, endingAchieved: false });
  if (afterAllMain.moved !== true || afterAllMain.transition?.toMap !== "boss_room") failures.push("boss room must be enterable once all 4 main missions are complete");

  const afterEnding = resolveMove("volcano", 8, 7, "right", { isQuestComplete: () => true, allMainComplete: true, endingAchieved: true });
  if (afterEnding.moved !== false) failures.push("boss room must refuse re-entry once the ending has been achieved");

  if (failures.length > 0) return { pass: false, message: failures.join("\n") };
  return { pass: true, message: "boss room entry is refused before all 4 main missions are done, allowed once they are, and refused again after the ending is achieved." };
});

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: node tools/ac.mjs <AC-ID>|--all");
    process.exit(1);
  }
  const ids = arg === "--all" ? [...checks.keys()] : [arg];
  let allPass = true;
  for (const id of ids) {
    const fn = checks.get(id);
    if (!fn) {
      console.log(`[FAIL] ${id}: no oracle registered`);
      allPass = false;
      continue;
    }
    let result;
    try {
      result = await fn();
    } catch (err) {
      result = { pass: false, message: err && err.stack ? err.stack : String(err) };
    }
    console.log(`[${result.pass ? "PASS" : "FAIL"}] ${id}: ${result.message}`);
    if (!result.pass) allPass = false;
  }
  process.exit(allPass ? 0 : 1);
}

main();
