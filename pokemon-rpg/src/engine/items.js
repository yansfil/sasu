// Item and inventory rules (R11). Only two item kinds exist by design
// (pokeball, potion - shop/currency is an explicit non-goal); nothing here
// invents a third.
export const ITEMS = {
  pokeball: { id: "pokeball", name: "몬스터볼" },
  potion: { id: "potion", name: "상처약", baseHeal: 20 },
};

export function createInventory(startingPokeballs, startingPotions) {
  return { pokeball: startingPokeballs, potion: startingPotions };
}

export function hasItem(inventory, itemId, count = 1) {
  return (inventory[itemId] || 0) >= count;
}

export function addItem(inventory, itemId, count = 1) {
  return { ...inventory, [itemId]: (inventory[itemId] || 0) + count };
}

export function consumeItem(inventory, itemId, count = 1) {
  if (!hasItem(inventory, itemId, count)) throw new Error(`not enough ${itemId} in inventory`);
  return { ...inventory, [itemId]: inventory[itemId] - count };
}

/**
 * Applies a potion to a battler-shaped member ({currentHp, stats: {hp}} -
 * the same canonical shape growth.js/party.js/save.js use throughout).
 * R11: heal amount is scaled by the active character's heal trait (e.g. 웅
 * x1.30). Clamped to the member's max HP.
 * @returns {{currentHp: number, healed: number}}
 */
export function applyPotion(member, characterHealMultiplier = 1) {
  const amount = Math.floor(ITEMS.potion.baseHeal * characterHealMultiplier);
  const nextHp = Math.min(member.stats.hp, member.currentHp + amount);
  return { currentHp: nextHp, healed: nextHp - member.currentHp };
}
