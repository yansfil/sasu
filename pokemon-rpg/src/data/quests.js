// Pure data: mission definitions (R13). Each field map gets exactly one
// main mission (trainer_defeat against that map's route-guardian trainer,
// referenced by npcId into data/maps.js) plus 3 side missions, covering all
// 4 mission types across the full set. 4 main x (4 field maps) + 12 side =
// 16 total, within the 12-16 side-mission band R13 requires.
//
// type: "capture_species" | "trainer_defeat" | "item_collect" | "wild_defeat_n"
// target shape follows type:
//   capture_species: { speciesId, count }
//   trainer_defeat:  { npcId }
//   item_collect:    { itemId, count }   (deliver N of an existing item - no
//                                         new item category, R11 non-goal)
//   wild_defeat_n:   { mapId, count }
export const QUESTS = {
  forest_main: {
    id: "forest_main", mapId: "forest", isMain: true, type: "trainer_defeat",
    title: "숲의 길목을 지켜라", description: "숲 훈련생을 꺾고 동굴로 가는 길을 연다.",
    target: { npcId: "forest_guardian" },
    reward: { items: [{ itemId: "pokeball", count: 3 }] },
  },
  forest_side1: {
    id: "forest_side1", mapId: "forest", isMain: false, type: "capture_species",
    title: "숲의 친구들", description: "이상해씨를 1마리 포획해서 데려오라.",
    target: { speciesId: "bulbasaur", count: 1 },
    reward: { items: [{ itemId: "potion", count: 2 }] },
  },
  forest_side2: {
    id: "forest_side2", mapId: "forest", isMain: false, type: "item_collect",
    title: "구급상자 보충", description: "상처약 2개를 모아 전달하라.",
    target: { itemId: "potion", count: 2 },
    reward: { items: [{ itemId: "pokeball", count: 2 }] },
  },
  forest_side3: {
    id: "forest_side3", mapId: "forest", isMain: false, type: "wild_defeat_n",
    title: "숲 정리", description: "숲의 야생 몬스터를 3마리 물리쳐라.",
    target: { mapId: "forest", count: 3 },
    reward: { items: [{ itemId: "potion", count: 1 }] },
  },

  cave_main: {
    id: "cave_main", mapId: "cave", isMain: true, type: "trainer_defeat",
    title: "동굴의 파수꾼", description: "동굴 훈련생을 꺾고 해변수로로 가는 길을 연다.",
    target: { npcId: "cave_guardian" },
    reward: { items: [{ itemId: "pokeball", count: 3 }] },
  },
  cave_side1: {
    id: "cave_side1", mapId: "cave", isMain: false, type: "capture_species",
    title: "전기쥐 포획", description: "피카츄를 1마리 포획해서 데려오라.",
    target: { speciesId: "pikachu", count: 1 },
    reward: { items: [{ itemId: "potion", count: 2 }] },
  },
  cave_side2: {
    id: "cave_side2", mapId: "cave", isMain: false, type: "trainer_defeat",
    title: "동굴의 도전자", description: "동굴 안 또 다른 훈련생을 꺾어라.",
    target: { npcId: "cave_challenger" },
    reward: { items: [{ itemId: "pokeball", count: 2 }] },
  },
  cave_side3: {
    id: "cave_side3", mapId: "cave", isMain: false, type: "item_collect",
    title: "동굴 구급함", description: "상처약 2개를 모아 전달하라.",
    target: { itemId: "potion", count: 2 },
    reward: { items: [{ itemId: "pokeball", count: 2 }] },
  },

  waterway_main: {
    id: "waterway_main", mapId: "waterway", isMain: true, type: "trainer_defeat",
    title: "해변수로의 수문장", description: "해변수로 훈련생을 꺾고 화산으로 가는 길을 연다.",
    target: { npcId: "waterway_guardian" },
    reward: { items: [{ itemId: "pokeball", count: 3 }] },
  },
  waterway_side1: {
    id: "waterway_side1", mapId: "waterway", isMain: false, type: "capture_species",
    title: "조개 채집", description: "셀러를 1마리 포획해서 데려오라.",
    target: { speciesId: "shellder", count: 1 },
    reward: { items: [{ itemId: "potion", count: 2 }] },
  },
  waterway_side2: {
    id: "waterway_side2", mapId: "waterway", isMain: false, type: "wild_defeat_n",
    title: "수로 순찰", description: "해변수로의 야생 몬스터를 3마리 물리쳐라.",
    target: { mapId: "waterway", count: 3 },
    reward: { items: [{ itemId: "potion", count: 1 }] },
  },
  waterway_side3: {
    id: "waterway_side3", mapId: "waterway", isMain: false, type: "item_collect",
    title: "몬스터볼 보충", description: "몬스터볼 2개를 모아 전달하라.",
    target: { itemId: "pokeball", count: 2 },
    reward: { items: [{ itemId: "potion", count: 2 }] },
  },

  volcano_main: {
    id: "volcano_main", mapId: "volcano", isMain: true, type: "trainer_defeat",
    title: "화산의 최종 관문", description: "화산 훈련생을 꺾고 화산 정상으로 가는 길을 연다.",
    target: { npcId: "volcano_guardian" },
    reward: { items: [{ itemId: "pokeball", count: 3 }] },
  },
  volcano_side1: {
    id: "volcano_side1", mapId: "volcano", isMain: false, type: "capture_species",
    title: "불여우 포획", description: "식스테일을 1마리 포획해서 데려오라.",
    target: { speciesId: "vulpix", count: 1 },
    reward: { items: [{ itemId: "potion", count: 2 }] },
  },
  volcano_side2: {
    id: "volcano_side2", mapId: "volcano", isMain: false, type: "trainer_defeat",
    title: "화산의 도전자", description: "화산 안 또 다른 훈련생을 꺾어라.",
    target: { npcId: "volcano_challenger" },
    reward: { items: [{ itemId: "pokeball", count: 2 }] },
  },
  volcano_side3: {
    id: "volcano_side3", mapId: "volcano", isMain: false, type: "wild_defeat_n",
    title: "화산 경계", description: "화산의 야생 몬스터를 3마리 물리쳐라.",
    target: { mapId: "volcano", count: 3 },
    reward: { items: [{ itemId: "potion", count: 1 }] },
  },
};

export const MAIN_QUEST_IDS = ["forest_main", "cave_main", "waterway_main", "volcano_main"];
