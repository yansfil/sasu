// Pure data: 5 playable characters (PRD table A, §6.1 - fixed contract).
// Every trait is a single numeric multiplier or increment (§4.3 A4) so an
// engine module can apply it mechanically; no trait is prose-only.
// traitEffect.type: "encounter_rate_mult" | "capture_rate_mult" |
//   "heal_amount_mult" | "damage_dealt_mult" | "starting_pokeballs"
export const CHARACTERS = {
  jiwoo: {
    id: "jiwoo", name: "지우", partnerSpeciesId: "pikachu",
    traitName: "야생을 잘 찾는다",
    traitDescription: "인카운터 발생 확률 x1.20",
    traitEffect: { type: "encounter_rate_mult", value: 1.2 },
  },
  iseul: {
    id: "iseul", name: "이슬이", partnerSpeciesId: "squirtle",
    traitName: "포획에 능하다",
    traitDescription: "포획 성공 확률 x1.20",
    traitEffect: { type: "capture_rate_mult", value: 1.2 },
  },
  woong: {
    id: "woong", name: "웅", partnerSpeciesId: "bulbasaur",
    traitName: "회복에 능하다",
    traitDescription: "상처약 회복량 x1.30",
    traitEffect: { type: "heal_amount_mult", value: 1.3 },
  },
  green: {
    id: "green", name: "그린", partnerSpeciesId: "charmander",
    traitName: "공격적이다",
    traitDescription: "아군이 주는 데미지 x1.10",
    traitEffect: { type: "damage_dealt_mult", value: 1.1 },
  },
  mindeulle: {
    id: "mindeulle", name: "민들레", partnerSpeciesId: "jigglypuff",
    traitName: "준비성이 좋다",
    traitDescription: "시작 몬스터볼 20개 (기본 10개)",
    traitEffect: { type: "starting_pokeballs", value: 20 },
  },
};

export const DEFAULT_STARTING_POKEBALLS = 10;
export const DEFAULT_STARTING_POTIONS = 3;

// R15 rival cycle: 지우 -> 이슬이 -> 웅 -> 그린 -> 민들레 -> 지우. The rival
// is the next character after the one the player picked.
export const CHARACTER_CYCLE = ["jiwoo", "iseul", "woong", "green", "mindeulle"];
