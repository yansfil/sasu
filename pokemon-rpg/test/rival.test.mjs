import { test } from "node:test";
import assert from "node:assert/strict";
import { assignRival, buildRivalParty, BOSS_SPECIES_ID } from "../src/engine/rival.js";
import { CHARACTER_CYCLE, CHARACTERS } from "../src/data/characters.js";
import { SPECIES } from "../src/data/species.js";

test("[AC21] the rival cycle is 지우->이슬이->웅->그린->민들레->지우", () => {
  assert.deepEqual(
    CHARACTER_CYCLE.map(id => assignRival(id)),
    ["iseul", "woong", "green", "mindeulle", "jiwoo"],
  );
});

test("[AC21] every one of the 5 character choices produces a valid 3-mon rival party including the boss species and the rival's final-evolution starter", () => {
  for (const chosenId of CHARACTER_CYCLE) {
    const { rivalCharacterId, party } = buildRivalParty(chosenId);
    assert.equal(rivalCharacterId, assignRival(chosenId));
    assert.equal(party.length, 3);
    const speciesIds = party.map(m => m.speciesId);
    assert.ok(speciesIds.includes(BOSS_SPECIES_ID), `party for ${chosenId} must include ${BOSS_SPECIES_ID}`);

    const rivalStarter = CHARACTERS[rivalCharacterId].partnerSpeciesId;
    let expectedFinal = SPECIES[rivalStarter];
    while (expectedFinal.evolvesInto) expectedFinal = SPECIES[expectedFinal.evolvesInto];
    assert.ok(speciesIds.includes(expectedFinal.id), `party for ${chosenId} must include the rival starter's final evolution ${expectedFinal.id}`);
  }
});

test("[R15] rival is never the character the player chose", () => {
  for (const chosenId of CHARACTER_CYCLE) {
    assert.notEqual(assignRival(chosenId), chosenId);
  }
});
