// Full-restore and party-wipe recovery (R18, and the R11/R7 Pokemon Center
// heal-and-PP-restore tile). Pure engine module.
import { MAPS } from "../data/maps.js";

export function healPartyFully(party) {
  return party.map(member => ({
    ...member,
    currentHp: member.stats.hp,
    moveSlots: member.moveSlots.map(slot => ({ ...slot, pp: slot.maxPp })),
  }));
}

/**
 * R18: a full party wipe is not a game over - it returns the player to the
 * town Pokemon Center with the whole party healed, save data intact.
 */
export function recoverFromWipe(party) {
  return {
    party: healPartyFully(party),
    mapId: "center",
    x: MAPS.center.spawn.x,
    y: MAPS.center.spawn.y,
  };
}
