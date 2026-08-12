// Pure data: the move roster. Every move deals damage (no status/buff moves -
// stat-stage changes and status ailments are an explicit non-goal, PRD §3).
// power/accuracy/pp feed the R7 damage formula and PP-exhaustion rules
// directly; nothing here is derived or computed.
export const MOVES = {
  tackle: { name: "몸통박치기", type: "normal", power: 40, accuracy: 100, pp: 35 },
  scratch: { name: "할퀴기", type: "normal", power: 40, accuracy: 100, pp: 35 },
  headbutt: { name: "박치기", type: "normal", power: 70, accuracy: 100, pp: 15 },
  hyper_voice: { name: "큰소리", type: "normal", power: 90, accuracy: 100, pp: 10 },
  giga_impact: { name: "기가임팩트", type: "normal", power: 150, accuracy: 90, pp: 5 },

  ember: { name: "불씨", type: "fire", power: 40, accuracy: 100, pp: 25 },
  flame_burst: { name: "화염방사", type: "fire", power: 90, accuracy: 100, pp: 15 },
  fire_blast: { name: "대문자불꽃", type: "fire", power: 110, accuracy: 85, pp: 5 },

  water_gun: { name: "물대포", type: "water", power: 40, accuracy: 100, pp: 25 },
  bubble_beam: { name: "거품광선", type: "water", power: 65, accuracy: 100, pp: 20 },
  hydro_pump: { name: "하이드로펌프", type: "water", power: 110, accuracy: 80, pp: 5 },

  vine_whip: { name: "덩굴채찍", type: "grass", power: 45, accuracy: 100, pp: 25 },
  razor_leaf: { name: "잎날가르기", type: "grass", power: 65, accuracy: 95, pp: 25 },
  solar_beam: { name: "솔라빔", type: "grass", power: 120, accuracy: 100, pp: 10 },

  thunder_shock: { name: "전기충격", type: "electric", power: 40, accuracy: 100, pp: 30 },
  spark: { name: "스파크", type: "electric", power: 65, accuracy: 100, pp: 20 },
  thunderbolt: { name: "십만볼트", type: "electric", power: 90, accuracy: 100, pp: 15 },
  thunder: { name: "번개", type: "electric", power: 110, accuracy: 70, pp: 10 },

  rock_throw: { name: "돌던지기", type: "rock", power: 50, accuracy: 90, pp: 15 },
  rock_slide: { name: "바위굴리기", type: "rock", power: 75, accuracy: 90, pp: 10 },
  stone_edge: { name: "스톤엣지", type: "rock", power: 100, accuracy: 80, pp: 5 },

  gust: { name: "돌풍", type: "flying", power: 40, accuracy: 100, pp: 35 },
  wing_attack: { name: "날개치기", type: "flying", power: 60, accuracy: 100, pp: 25 },
  hurricane: { name: "폭풍", type: "flying", power: 110, accuracy: 70, pp: 10 },
};
