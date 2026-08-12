import { test } from "node:test";
import assert from "node:assert/strict";
import { createRng } from "../src/engine/rng.js";
import { isFleeAllowed, isCaptureAllowed, computeCaptureChance, attemptCapture, computeFleeChance, nextAliveOpponentIndex } from "../src/engine/capture.js";
import { MAX_PARTY_SIZE, canAddToParty, addToParty, isPartyWiped, firstAliveIndex, needsLeadReplacement } from "../src/engine/party.js";
import { createInventory, hasItem, addItem, consumeItem, applyPotion, ITEMS } from "../src/engine/items.js";

test("[AC13] wild battles allow flee and capture; trainer battles allow neither", () => {
  assert.equal(isFleeAllowed("wild"), true);
  assert.equal(isCaptureAllowed("wild"), true);
  assert.equal(isFleeAllowed("trainer"), false);
  assert.equal(isCaptureAllowed("trainer"), false);
});

test("[AC14] trainer party advances to the next living member on faint", () => {
  const party = [{ currentHp: 0 }, { currentHp: 0 }, { currentHp: 30 }];
  assert.equal(nextAliveOpponentIndex(party, 0), 2);
  const wiped = [{ currentHp: 0 }, { currentHp: 0 }];
  assert.equal(nextAliveOpponentIndex(wiped, 0), -1);
});

test("[R9] capture chance formula multiplies all four factors and clamps to [0,1]", () => {
  const chance = computeCaptureChance({ remainingHpFraction: 0.5, catchRate: 120, characterCaptureMultiplier: 1.2 });
  const expected = 0.5 * (120 / 255) * 1.0 * 1.2;
  assert.ok(Math.abs(chance - expected) < 1e-9);
  const clamped = computeCaptureChance({ remainingHpFraction: 1, catchRate: 255, characterCaptureMultiplier: 5 });
  assert.equal(clamped, 1);
});

test("[AC15] a full party rejects capture without consuming a ball or rolling", () => {
  const fullParty = Array.from({ length: MAX_PARTY_SIZE }, () => ({ currentHp: 10 }));
  const result = attemptCapture({ party: fullParty, remainingHpFraction: 0.9, catchRate: 255, rng: createRng(1) });
  assert.equal(result.rejected, true);
  assert.equal(result.reason, "party_full");
  assert.equal(result.success, false);
  assert.equal(result.ballConsumed, false);
});

test("[AC15] a non-full party can attempt capture and spends a ball either way", () => {
  const party = [{ currentHp: 10 }];
  const result = attemptCapture({ party, remainingHpFraction: 1, catchRate: 255, rng: createRng(1) });
  assert.equal(result.rejected, false);
  assert.equal(result.ballConsumed, true);
});

test("[R8] flee chance favors the faster side but is never 0 or 1", () => {
  assert.ok(computeFleeChance({ playerSpd: 100, opponentSpd: 10 }) > 0.5);
  assert.equal(computeFleeChance({ playerSpd: 1, opponentSpd: 1000 }), 0.1);
  assert.equal(computeFleeChance({ playerSpd: 1000, opponentSpd: 1 }), 0.95);
});

test("[R10] party caps at 6 and rejects a 7th add", () => {
  let party = [];
  for (let i = 0; i < MAX_PARTY_SIZE; i++) {
    assert.equal(canAddToParty(party), true);
    party = addToParty(party, { id: i });
  }
  assert.equal(canAddToParty(party), false);
  assert.throws(() => addToParty(party, { id: "overflow" }));
});

test("[R18] party-wipe and lead-replacement detection", () => {
  const wiped = [{ currentHp: 0 }, { currentHp: 0 }];
  assert.equal(isPartyWiped(wiped), true);
  const partial = [{ currentHp: 0 }, { currentHp: 5 }];
  assert.equal(isPartyWiped(partial), false);
  assert.equal(firstAliveIndex(partial), 1);
  assert.equal(needsLeadReplacement(partial, 0), true);
  assert.equal(needsLeadReplacement(partial, 1), false);
});

test("[AC16] starting inventory helpers track pokeball/potion counts only", () => {
  const inv = createInventory(10, 3);
  assert.deepEqual(inv, { pokeball: 10, potion: 3 });
  assert.equal(hasItem(inv, "potion", 3), true);
  assert.equal(hasItem(inv, "potion", 4), false);
  const added = addItem(inv, "pokeball", 2);
  assert.equal(added.pokeball, 12);
  const consumed = consumeItem(added, "pokeball", 5);
  assert.equal(consumed.pokeball, 7);
  assert.throws(() => consumeItem(inv, "potion", 10));
});

test("[R11] potion heal amount scales with the character's heal multiplier and clamps to max HP", () => {
  const member = { currentHp: 50, stats: { hp: 100 } };
  const base = applyPotion(member, 1);
  assert.equal(base.healed, ITEMS.potion.baseHeal);
  const boosted = applyPotion(member, 1.3);
  assert.equal(boosted.healed, Math.floor(ITEMS.potion.baseHeal * 1.3));
  const nearFull = { currentHp: 95, stats: { hp: 100 } };
  const clamped = applyPotion(nearFull, 1);
  assert.equal(clamped.currentHp, 100);
  assert.equal(clamped.healed, 5);
});
