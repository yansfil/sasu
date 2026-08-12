// Party roster rules (R10). Pure engine module: party is a plain array of
// battler-shaped members (see engine/battle.js for that shape); every
// function here returns a new array rather than mutating the caller's.
export const MAX_PARTY_SIZE = 6;

export function canAddToParty(party) {
  return party.length < MAX_PARTY_SIZE;
}

export function addToParty(party, member) {
  if (!canAddToParty(party)) throw new Error("party is full");
  return [...party, member];
}

export function reorderParty(party, fromIndex, toIndex) {
  const next = [...party];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

export function isAlive(member) {
  return member.currentHp > 0;
}

export function isPartyWiped(party) {
  return party.every(member => !isAlive(member));
}

/** @returns {number} index of the first living member, or -1 if the whole party fainted. */
export function firstAliveIndex(party, fromIndex = 0) {
  for (let i = fromIndex; i < party.length; i++) {
    if (isAlive(party[i])) return i;
  }
  return -1;
}

/** R18: a fainted lead must be swapped for a living member before the battle can continue. */
export function needsLeadReplacement(party, activeIndex) {
  return !isAlive(party[activeIndex]) && firstAliveIndex(party) !== -1;
}
