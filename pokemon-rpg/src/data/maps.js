// Pure data: 7 maps (PRD table B, §6.1 - fixed contract: name/type/level
// range/entry condition). Tile grids, portal coordinates, NPC placement and
// rosters, item/sign locations are agent-authored content that realizes the
// table (§4.3 A3) - engine/world.js and engine/encounter.js are the only
// code that reads and interprets these grids.
//
// Tile legend: '#' wall, '.' path, 'G' grass (walkable + encounter roll on
// field maps only), 'D' door/portal, 'I' one-time item, 'S' sign, 'H' heal.
// A portal's `locked` is null (always open) or a quest id from data/quests.js
// whose completion (or the sentinel "ALL_MAIN") opens it - engine/world.js
// resolves that against quest state; this file only names the gate.
export const MAIN_MAP_ORDER = ["forest", "cave", "waterway", "volcano"];

export const MAPS = {
  town: {
    id: "town", name: "마을", kind: "dedicated", theme: "town",
    levelRange: null, entryRequires: null,
    spawn: { x: 2, y: 1 },
    grid: [
      "###########",
      "#.........#",
      "#...S.....#",
      "#....D....#",
      "#.........#",
      "#.......D.#",
      "#.........#",
      "#.........#",
      "###########",
    ],
    portals: {
      "5,3": { toMap: "center", toX: 3, toY: 1, locked: null },
      "8,5": { toMap: "forest", toX: 1, toY: 3, locked: null },
    },
    items: {},
    signs: { "4,2": "마을 안내판: 오른쪽 아래 문은 포켓몬센터, 오른쪽 문은 숲으로 이어진다." },
    npcs: [
      { id: "town_nurse", kind: "town", x: 3, y: 4, dialog: "여기서 쉬고 싶다면 포켓몬센터로 가렴. 몸조심하고!", gift: { itemId: "potion", count: 1 } },
      { id: "town_guide", kind: "town", x: 7, y: 2, dialog: "방향키나 WASD로 움직이고, Z나 Enter로 확인, X나 Esc로 취소해." },
    ],
  },

  center: {
    id: "center", name: "포켓몬센터 내부", kind: "dedicated", theme: "indoor",
    levelRange: null, entryRequires: null,
    spawn: { x: 3, y: 1 },
    grid: [
      "#######",
      "#.....#",
      "#..H..#",
      "#.....#",
      "#..D..#",
      "#######",
    ],
    portals: {
      "3,4": { toMap: "town", toX: 5, toY: 4, locked: null },
    },
    items: {},
    signs: {},
    npcs: [],
  },

  forest: {
    id: "forest", name: "숲", kind: "field", theme: "forest",
    levelRange: [3, 6], entryRequires: null,
    spawn: { x: 3, y: 1 },
    grid: [
      "###########",
      "#.........#",
      "D...GGGG..#",
      "#...GGGG..#",
      "#I..GGGGS.#",
      "#...GGGG..#",
      "#...GGGG..#",
      "#........D#",
      "###########",
    ],
    portals: {
      "0,2": { toMap: "town", toX: 5, toY: 4, locked: null },
      "9,7": { toMap: "cave", toX: 2, toY: 2, locked: "forest_main" },
    },
    items: { "1,4": { itemId: "potion", count: 1 } },
    signs: { "8,4": "숲 안내판: 풀숲(초록 타일)에 들어가면 야생 몬스터를 만날 수 있다." },
    npcs: [
      { id: "forest_questgiver", kind: "mission", x: 3, y: 1, quests: ["forest_main", "forest_side1", "forest_side2", "forest_side3"] },
      {
        id: "forest_guardian", kind: "trainer", x: 7, y: 7,
        party: [{ species: "pidgey", level: 4 }, { species: "squirtle", level: 5 }],
        reward: { items: [{ itemId: "potion", count: 1 }] },
        questId: "forest_main",
      },
    ],
  },

  cave: {
    id: "cave", name: "동굴", kind: "field", theme: "cave",
    levelRange: [7, 11], entryRequires: "forest_main",
    spawn: { x: 2, y: 2 },
    grid: [
      "###########",
      "#.D.......#",
      "#..GGGG...#",
      "#I.GGGG...#",
      "#..GGGGS..#",
      "#..GGGG...#",
      "#..GGGG...#",
      "#........D#",
      "###########",
    ],
    portals: {
      "2,1": { toMap: "forest", toX: 8, toY: 6, locked: null },
      "9,7": { toMap: "waterway", toX: 2, toY: 2, locked: "cave_main" },
    },
    items: { "1,3": { itemId: "pokeball", count: 1 } },
    signs: { "7,4": "동굴 안내판: 발밑을 조심해. 여기도 풀숲처럼 야생 몬스터가 나온다." },
    npcs: [
      { id: "cave_questgiver", kind: "mission", x: 3, y: 1, quests: ["cave_main", "cave_side1", "cave_side2", "cave_side3"] },
      {
        id: "cave_guardian", kind: "trainer", x: 7, y: 7,
        party: [{ species: "geodude", level: 7 }, { species: "sandshrew", level: 8 }, { species: "pidgeotto", level: 9 }],
        reward: { items: [{ itemId: "potion", count: 1 }] },
        questId: "cave_main",
      },
      {
        id: "cave_challenger", kind: "trainer", x: 7, y: 5,
        party: [{ species: "magnemite", level: 8 }, { species: "geodude", level: 8 }],
        reward: { items: [{ itemId: "potion", count: 1 }] },
        questId: "cave_side2",
      },
    ],
  },

  waterway: {
    id: "waterway", name: "해변수로", kind: "field", theme: "waterway",
    levelRange: [12, 17], entryRequires: "cave_main",
    spawn: { x: 2, y: 2 },
    grid: [
      "###########",
      "#.D.......#",
      "#..GGGG...#",
      "#I.GGGG...#",
      "#..GGGGS..#",
      "#..GGGG...#",
      "#..GGGG...#",
      "#........D#",
      "###########",
    ],
    portals: {
      "2,1": { toMap: "cave", toX: 8, toY: 6, locked: null },
      "9,7": { toMap: "volcano", toX: 2, toY: 2, locked: "waterway_main" },
    },
    items: { "1,3": { itemId: "potion", count: 1 } },
    signs: { "7,4": "해변수로 안내판: 물살이 세다. 넘어가려면 화산 쪽 문을 찾아라." },
    npcs: [
      { id: "waterway_questgiver", kind: "mission", x: 3, y: 1, quests: ["waterway_main", "waterway_side1", "waterway_side2", "waterway_side3"] },
      {
        id: "waterway_guardian", kind: "trainer", x: 7, y: 7,
        party: [{ species: "shellder", level: 12 }, { species: "sandshrew", level: 13 }, { species: "magnemite", level: 14 }],
        reward: { items: [{ itemId: "potion", count: 1 }] },
        questId: "waterway_main",
      },
    ],
  },

  volcano: {
    id: "volcano", name: "화산", kind: "field", theme: "volcano",
    levelRange: [18, 24], entryRequires: "waterway_main",
    spawn: { x: 2, y: 2 },
    grid: [
      "###########",
      "#.D.......#",
      "#..GGGG...#",
      "#I.GGGG...#",
      "#..GGGGS..#",
      "#..GGGG...#",
      "#..GGGG...#",
      "#........D#",
      "###########",
    ],
    portals: {
      "2,1": { toMap: "waterway", toX: 8, toY: 6, locked: null },
      "9,7": { toMap: "boss_room", toX: 3, toY: 3, locked: "ALL_MAIN" },
    },
    items: { "1,3": { itemId: "pokeball", count: 1 } },
    signs: { "7,4": "화산 안내판: 정상으로 가는 길은 이 지역의 관문을 통과해야 열린다." },
    npcs: [
      { id: "volcano_questgiver", kind: "mission", x: 3, y: 1, quests: ["volcano_main", "volcano_side1", "volcano_side2", "volcano_side3"] },
      {
        id: "volcano_guardian", kind: "trainer", x: 7, y: 7,
        party: [{ species: "vulpix", level: 18 }, { species: "sandshrew", level: 19 }, { species: "geodude", level: 20 }],
        reward: { items: [{ itemId: "potion", count: 1 }] },
        questId: "volcano_main",
      },
      {
        id: "volcano_challenger", kind: "trainer", x: 7, y: 5,
        party: [{ species: "vulpix", level: 18 }, { species: "sandshrew", level: 19 }],
        reward: { items: [{ itemId: "potion", count: 1 }] },
        questId: "volcano_side2",
      },
    ],
  },

  boss_room: {
    id: "boss_room", name: "화산 정상 보스방", kind: "dedicated", theme: "boss",
    levelRange: null, entryRequires: "ALL_MAIN",
    spawn: { x: 3, y: 3 },
    grid: [
      "#######",
      "#.....#",
      "#..R..#",
      "#.....#",
      "#.....#",
      "#..D..#",
      "#######",
    ],
    portals: {
      "3,5": { toMap: "volcano", toX: 8, toY: 6, locked: null },
    },
    items: {},
    signs: {},
    npcs: [],
    rivalTrigger: { x: 3, y: 2 },
  },
};
