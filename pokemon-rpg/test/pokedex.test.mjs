import { test } from "node:test";
import assert from "node:assert/strict";
import { createPokedex, recordSeen, recordCaught, caughtCount, hasAchievement, toSaveShape, fromSaveShape, CAUGHT_ACHIEVEMENT_THRESHOLD } from "../src/engine/pokedex.js";

test("[R16] seen and caught are tracked separately", () => {
  let dex = createPokedex();
  dex = recordSeen(dex, "pikachu");
  assert.equal(dex.seen.has("pikachu"), true);
  assert.equal(dex.caught.has("pikachu"), false);
  dex = recordCaught(dex, "pikachu");
  assert.equal(dex.caught.has("pikachu"), true);
});

test("[AC22] the achievement flips exactly at 12 distinct catches, not 11", () => {
  let dex = createPokedex();
  const species = ["pikachu", "squirtle", "bulbasaur", "charmander", "jigglypuff", "pidgey", "geodude", "magnemite", "sandshrew", "paras", "vulpix"];
  for (const id of species) dex = recordCaught(dex, id);
  assert.equal(caughtCount(dex), 11);
  assert.equal(hasAchievement(dex), false);
  dex = recordCaught(dex, "shellder");
  assert.equal(caughtCount(dex), 12);
  assert.equal(CAUGHT_ACHIEVEMENT_THRESHOLD, 12);
  assert.equal(hasAchievement(dex), true);
});

test("[AC22] catching the same species twice does not inflate the count", () => {
  let dex = createPokedex();
  dex = recordCaught(dex, "pikachu");
  dex = recordCaught(dex, "pikachu");
  assert.equal(caughtCount(dex), 1);
});

test("[R16] save-shape round trip preserves seen/caught membership", () => {
  let dex = createPokedex();
  dex = recordCaught(dex, "mew");
  dex = recordSeen(dex, "moltres");
  const shape = toSaveShape(dex);
  const restored = fromSaveShape(shape);
  assert.equal(restored.caught.has("mew"), true);
  assert.equal(restored.seen.has("moltres"), true);
});
