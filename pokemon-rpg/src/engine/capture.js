// Capture and battle-mode branching rules (R8, R9). Pure engine module.
import { canAddToParty } from "./party.js";

// Single ball type only (R11 non-goal: no ball tiers) - kept as a named
// constant because R9's formula explicitly has a "볼 보정" term.
export const BALL_BONUS = 1.0;

export function isFleeAllowed(battleMode) {
  return battleMode === "wild";
}

export function isCaptureAllowed(battleMode) {
  return battleMode === "wild";
}

/**
 * R9: 남은 HP 비율 x 종족 포획률 x 볼 보정 x 캐릭터 특성 배율.
 * @returns {number} probability in [0, 1]
 */
export function computeCaptureChance({ remainingHpFraction, catchRate, ballBonus = BALL_BONUS, characterCaptureMultiplier = 1 }) {
  const chance = remainingHpFraction * (catchRate / 255) * ballBonus * characterCaptureMultiplier;
  return Math.max(0, Math.min(1, chance));
}

/**
 * Full capture attempt including the R10 full-party guard: a full party
 * rejects the attempt before any ball is spent or any roll happens
 * (AC15: "몬스터볼이 소모되지 않으며").
 */
export function attemptCapture({ party, remainingHpFraction, catchRate, characterCaptureMultiplier = 1, rng }) {
  if (!canAddToParty(party)) {
    return { rejected: true, reason: "party_full", success: false, ballConsumed: false, chance: 0 };
  }
  const chance = computeCaptureChance({ remainingHpFraction, catchRate, characterCaptureMultiplier });
  const success = rng.chance(chance);
  return { rejected: false, reason: null, success, ballConsumed: true, chance };
}

/**
 * R8: flee chance scales with the speed ratio between the fleeing side and
 * the opponent, floored/ceilinged so it is never a guaranteed success or
 * failure.
 */
export function computeFleeChance({ playerSpd, opponentSpd }) {
  const ratio = playerSpd / (playerSpd + opponentSpd);
  return Math.max(0.1, Math.min(0.95, ratio));
}

export function attemptFlee({ playerSpd, opponentSpd, rng }) {
  const chance = computeFleeChance({ playerSpd, opponentSpd });
  return { success: rng.chance(chance), chance };
}

/** @returns {number} index of the next living member in a trainer's party, or -1 when the whole party has fainted. */
export function nextAliveOpponentIndex(trainerParty, fromIndex) {
  for (let i = fromIndex; i < trainerParty.length; i++) {
    if (trainerParty[i].currentHp > 0) return i;
  }
  return -1;
}
