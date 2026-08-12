// Pure data: the 7 elemental types and the 7x7 type effectiveness chart
// (PRD table D, §6.1). No lookup functions here - src/engine/battle.js reads
// this table; keeping it data-only preserves the 3-layer split (§5).
export const TYPES = ["normal", "fire", "water", "grass", "electric", "rock", "flying"];

export const TYPE_NAMES = {
  normal: "노말",
  fire: "불",
  water: "물",
  grass: "풀",
  electric: "전기",
  rock: "바위",
  flying: "비행",
};

// TYPE_CHART[attackType][defendType] = multiplier. Any combination absent
// from a row is x1.0 by construction (table D: "표에 없는 조합은 x1.0이며
// 무효(x0)는 없다"). No entry in this file is ever 0.
export const TYPE_CHART = {
  normal: { rock: 0.5 },
  fire: { grass: 2.0, fire: 0.5, water: 0.5, rock: 0.5 },
  water: { fire: 2.0, rock: 2.0, water: 0.5, grass: 0.5 },
  grass: { water: 2.0, rock: 2.0, fire: 0.5, grass: 0.5, flying: 0.5 },
  electric: { water: 2.0, flying: 2.0, grass: 0.5, electric: 0.5, rock: 0.5 },
  rock: { fire: 2.0, flying: 2.0, rock: 0.5 },
  flying: { grass: 2.0, electric: 0.5, rock: 0.5 },
};
