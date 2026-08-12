// Pure data: per-field-map wild encounter tables (R6). Weights are relative,
// not required to sum to 100. Only species whose data/species.js
// `encounterMaps` names this map appear here (AC7 diffs the two). Mew's
// volcano weight is deliberately far below its neighbors (R6: "현저히 낮은
// 가중치").
export const BASE_ENCOUNTER_RATE = 0.1;

export const ENCOUNTERS = {
  forest: [
    { speciesId: "bulbasaur", weight: 25 },
    { speciesId: "jigglypuff", weight: 20 },
    { speciesId: "pidgey", weight: 20 },
    { speciesId: "sandshrew", weight: 20 },
    { speciesId: "paras", weight: 15 },
  ],
  cave: [
    { speciesId: "pikachu", weight: 40 },
    { speciesId: "geodude", weight: 30 },
    { speciesId: "magnemite", weight: 30 },
  ],
  waterway: [
    { speciesId: "squirtle", weight: 30 },
    { speciesId: "pidgey", weight: 20 },
    { speciesId: "pidgeotto", weight: 20 },
    { speciesId: "shellder", weight: 30 },
  ],
  volcano: [
    { speciesId: "charmander", weight: 30 },
    { speciesId: "geodude", weight: 30 },
    { speciesId: "vulpix", weight: 35 },
    { speciesId: "mew", weight: 5 },
  ],
};
