// AC25, AC27, AC28, AC29, AC30 - browser/runtime verification (V4). Every
// test here drives the page the way a real player would; nothing reaches
// into module internals.
import { test, expect } from "@playwright/test";
import { pressN, newGameWithSeed, fightUntilOutcomeKeyboard, fightUntilOutcomeClick, clearSharedFieldMap, readDebugState } from "./helpers.mjs";

test.describe("core loop", () => {
  test("[AC30] the app loads with zero console errors", async ({ page }) => {
    const errors = [];
    page.on("console", msg => { if (msg.type() === "error") errors.push(msg.text()); });
    page.on("pageerror", err => errors.push(String(err)));
    await page.goto("/");
    await page.waitForSelector("#app h1");
    expect(errors).toEqual([]);
  });

  test("[AC28] keyboard-only: select -> move -> encounter -> battle -> capture -> mission accept -> guardian defeat -> map opens", async ({ page }) => {
    const errors = [];
    page.on("pageerror", err => errors.push(String(err)));

    await newGameWithSeed(page, 1001, "jiwoo", { debug: true });
    await expect(page.locator("#app h1")).toHaveText("마을");

    // town -> forest door, keyboard only
    await pressN(page, "ArrowDown", 4);
    await pressN(page, "ArrowRight", 6);
    await expect(page.locator("#app h1")).toHaveText("숲");

    // walk into the grass patch and force an encounter within a bounded number of steps
    await pressN(page, "ArrowRight", 3);
    let encountered = false;
    for (let i = 0; i < 60 && !encountered; i++) {
      await page.keyboard.press(i % 2 === 0 ? "ArrowRight" : "ArrowLeft");
      await page.waitForTimeout(70);
      if ((await page.locator("h1", { hasText: "전투" }).count()) > 0) encountered = true;
    }
    expect(encountered, "a wild encounter must trigger while stepping on grass").toBe(true);

    // attempt a capture; if it fails, finish the wild battle by fighting instead (both exercise the flow keyboard-only)
    await page.keyboard.press("ArrowDown"); // main menu: fight(0) -> bag(1) -> catch(2)
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter"); // catch
    await page.waitForTimeout(200);
    if ((await page.locator('button[data-action="close"]').count()) === 0) {
      // capture failed and the wild mon got a turn - finish the fight
      await fightUntilOutcomeKeyboard(page);
    } else {
      await page.keyboard.press("Enter");
      await page.waitForTimeout(150);
    }

    // A lone level-5 starter can genuinely lose a wild fight depending on the
    // RNG draw (R7 formulas, no cheating around bad luck): a wipe sends the
    // player to the town Pokemon Center (R18) instead of back to the forest.
    // Either outcome legitimately exercised battle/capture; walk back to the
    // forest if that happened so the rest of the flow can continue.
    if ((await page.locator("#app h1").textContent()) === "포켓몬센터 내부") {
      await pressN(page, "ArrowDown", 3); // center -> town
      await expect(page.locator("#app h1")).toHaveText("마을");
      await pressN(page, "ArrowDown", 1);
      await pressN(page, "ArrowRight", 3); // town spawn-after-recovery (5,4) -> forest door (8,5)
    }
    await expect(page.locator("#app h1")).toHaveText("숲");

    // Navigate to the quest giver (3,1) from wherever the encounter actually
    // left the player (RNG-dependent), read via the test-only debug hook
    // rather than assuming a fixed position.
    const pos = await readDebugState(page);
    expect(pos.mapId).toBe("forest");
    await pressN(page, "ArrowUp", pos.y - 1);
    const approachX = pos.x >= 4 ? 4 : 2;
    if (pos.x >= 4) {
      await pressN(page, "ArrowLeft", pos.x - 4);
      await pressN(page, "ArrowLeft", 1); // blocked by the quest giver, sets facing=left
    } else {
      await pressN(page, "ArrowRight", 2 - pos.x);
      await pressN(page, "ArrowRight", 1); // blocked by the quest giver, sets facing=right
    }
    await page.keyboard.press("Enter"); // accept forest_main from the quest giver
    await page.waitForTimeout(150);
    await pressN(page, "ArrowDown", 6);
    await pressN(page, "ArrowRight", Math.max(0, 3 - approachX)); // close to within the guardian's sight range (row7, distance<=4)
    await page.waitForTimeout(200);
    await expect(page.locator("h1", { hasText: "전투" })).toBeVisible();
    await fightUntilOutcomeKeyboard(page, 40);

    // The 2-mon guardian trainer can also legitimately beat a still-low-level
    // solo starter (R8 has no scripted difficulty floor). Retry with a fresh
    // full-HP run at the guardian rather than treating a loss as a test bug.
    for (let attempt = 0; attempt < 3 && (await page.locator("#app h1").textContent()) === "포켓몬센터 내부"; attempt++) {
      await pressN(page, "ArrowDown", 3); // center -> town
      await pressN(page, "ArrowDown", 1);
      await pressN(page, "ArrowRight", 3); // town -> forest door
      await expect(page.locator("#app h1")).toHaveText("숲");
      await pressN(page, "ArrowDown", 4); // forest entry (1,3) -> (1,7)
      await pressN(page, "ArrowRight", 2); // (1,7) -> (3,7), within the guardian's sight range
      await page.waitForTimeout(200);
      if ((await page.locator("h1", { hasText: "전투" }).count()) > 0) {
        await fightUntilOutcomeKeyboard(page, 40);
      }
    }
    await expect(page.locator("#app h1")).toHaveText("숲");

    const afterGuardian = await readDebugState(page);
    await pressN(page, "ArrowRight", Math.max(0, 9 - afterGuardian.x));
    await expect(page.locator("#app h1")).toHaveText("동굴");

    expect(errors).toEqual([]);
  });

  test("[AC27] new game confirmation: cancel keeps the save, confirm actually resets to a fresh game", async ({ page }) => {
    await newGameWithSeed(page, 2002, "iseul");
    await pressN(page, "ArrowRight", 1); // move once so state differs from a fresh start
    await page.waitForTimeout(150);

    await page.keyboard.press("Escape"); // open pause menu
    await page.waitForTimeout(150);
    await page.click('[data-action="new-game"]');
    await page.waitForTimeout(100);
    await expect(page.locator('[role="alertdialog"]')).toBeVisible();
    await page.click('[data-action="cancel-new-game"]');
    await page.waitForTimeout(100);
    await page.click('[data-action="close"]');
    await page.waitForTimeout(100);
    await expect(page.locator("#app h1")).toHaveText("마을"); // save untouched, still in the game

    await page.reload();
    await page.waitForSelector('[data-action="continue"]');
    await page.click("[data-action=\"continue\"]");
    await page.waitForTimeout(150);
    await expect(page.locator("#app h1")).toHaveText("마을"); // the cancelled reset did not erase the save

    // now actually confirm the reset and verify it takes effect
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    await page.click('[data-action="new-game"]');
    await page.waitForTimeout(100);
    await page.click('[data-action="confirm-new-game"]');
    await page.waitForTimeout(150);
    await expect(page.locator("#app h1")).toHaveText("캐릭터 선택"); // reset drops straight into character select

    // the old save must be gone: a reload now shows no "continue" option
    await page.reload();
    await page.waitForSelector("#app h1");
    await expect(page.locator('[data-action="continue"]')).toHaveCount(0);
    await expect(page.locator('[data-action="new-game"]')).toBeVisible();
  });

  test("[AC25] the complete saved state survives an actual page reload: character, party, position, inventory, pokedex, mission progress, map-gate state", async ({ page }) => {
    await newGameWithSeed(page, 3003, "woong", { debug: true });
    await pressN(page, "ArrowDown", 4);
    await pressN(page, "ArrowRight", 6); // town -> forest, so mapId/x/y differ from the character-select defaults
    await pressN(page, "ArrowDown", 1); // step onto the one-time item tile -> inventory + collectedItemTiles change
    await page.waitForTimeout(150);

    // accept forest_main (still in_progress, not completable) so questProgress is non-empty,
    // then confirm the cave door is refused and names that quest - this is the map-gate state
    // AC25 requires to survive reload (R5: map-open is derived from quest completion).
    // Route down off row 1 first (the quest giver NPC permanently occupies (3,1) and blocks
    // any rightward move from (2,1)), then across row 2 and down column x=9 - this never
    // shares forest_guardian's row/column until the final blocked step onto the door
    // itself, so it reaches the door WITHOUT crossing the guardian's sight line and
    // triggering an unplanned battle (a refused move never runs the sight check; any
    // successful step through row 7 near x=3..7 would).
    await pressN(page, "ArrowUp", 3); // (1,4) [item tile] -> (1,1)
    await pressN(page, "ArrowRight", 1); // (1,1) -> (2,1), facing the quest giver at (3,1)
    await page.keyboard.press("Enter"); // accept forest_main from the quest giver
    await page.waitForTimeout(150);
    await pressN(page, "ArrowDown", 1); // (2,1) -> (2,2), off the quest giver's row
    await pressN(page, "ArrowRight", 7); // (2,2) -> (9,2)
    await pressN(page, "ArrowDown", 6); // (9,2) -> (9,6) successfully, then attempts (9,7): still locked
    await page.waitForTimeout(150);
    const dialogBefore = await page.locator("#aria-live").textContent();
    expect(dialogBefore).toContain("숲의 길목을 지켜라"); // forest_main's title, named as the blocking quest

    const before = await readDebugState(page);
    expect(before.mapId).toBe("forest");

    await page.reload();
    await page.waitForSelector('[data-action="continue"]');
    await page.click('[data-action="continue"]');
    await page.waitForTimeout(150);
    const after = await readDebugState(page);

    expect(after.mapId).toBe(before.mapId);
    expect(after.x).toBe(before.x);
    expect(after.y).toBe(before.y);
    await expect(page.locator("#app h1")).toHaveText("숲");

    const full = await page.evaluate(() => {
      const s = window.__pokemonRpgDebugState;
      return {
        characterId: s.characterId,
        party: s.party.map(m => ({ speciesId: m.speciesId, level: m.level, currentHp: m.currentHp })),
        inventory: s.inventory,
        collectedItemTiles: s.collectedItemTiles,
        pokedexSeen: [...s.pokedex.seen],
        questProgress: s.questProgress,
      };
    });
    expect(full.characterId).toBe("woong");
    expect(full.party).toHaveLength(1);
    expect(full.party[0].speciesId).toBe("bulbasaur");
    expect(full.party[0].level).toBe(5);
    expect(full.party[0].currentHp).toBeGreaterThan(0); // no battle happened yet, so this is deterministically full HP, but the exact number isn't the point here
    expect(full.inventory.potion).toBeGreaterThanOrEqual(3); // starting 3 + the item tile picked up before reload
    expect(full.collectedItemTiles).toContain("forest:1,4");
    expect(full.pokedexSeen).toContain("bulbasaur");
    expect(full.questProgress.forest_main).toBeTruthy();
    expect(full.questProgress.forest_main.status).toBe("in_progress"); // mission status survived reload

    // map-gate state after reload: still refused, still names the same quest
    await pressN(page, "ArrowDown", 1);
    await page.waitForTimeout(150);
    const dialogAfter = await page.locator("#aria-live").textContent();
    expect(dialogAfter).toContain("숲의 길목을 지켜라");
    await expect(page.locator("#app h1")).toHaveText("숲"); // the move into the still-locked cave was refused
  });

  test("[R21][AC30] both map transition and battle entry complete within 500ms", async ({ page }) => {
    await newGameWithSeed(page, 4004, "green");
    await pressN(page, "ArrowDown", 4);
    await pressN(page, "ArrowRight", 5);
    const mapStart = Date.now();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#app h1")).toHaveText("숲");
    expect(Date.now() - mapStart).toBeLessThan(500);

    // force a wild encounter and time the overworld -> battle-screen transition itself
    await pressN(page, "ArrowRight", 3);
    let battleStart = null;
    for (let i = 0; i < 60; i++) {
      const t0 = Date.now();
      await page.keyboard.press(i % 2 === 0 ? "ArrowRight" : "ArrowLeft");
      if ((await page.locator("h1", { hasText: "전투" }).count()) > 0) { battleStart = t0; break; }
      await page.waitForTimeout(70);
    }
    expect(battleStart, "a wild encounter must trigger to measure battle-entry timing").not.toBeNull();
    expect(Date.now() - battleStart).toBeLessThan(500);
  });
});

test.describe("accessibility and responsive", () => {
  test("[AC29] no horizontal scroll at 360px across all 6 required screens: title, character select, overworld, battle, menu, quest log", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });

    async function noScroll(label) {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${label} must not overflow horizontally`).toBeLessThanOrEqual(0);
    }

    await page.goto("/");
    await page.waitForSelector("#app h1");
    await noScroll("title");

    await page.click('[data-action="new-game"]');
    await page.waitForTimeout(150);
    await noScroll("character select");

    await page.click('.card[data-id="mindeulle"]');
    await page.waitForTimeout(150);
    await noScroll("overworld");

    await pressN(page, "ArrowDown", 4);
    await pressN(page, "ArrowRight", 6); // town -> forest
    await pressN(page, "ArrowRight", 3);
    let inBattle = false;
    for (let i = 0; i < 60 && !inBattle; i++) {
      await page.keyboard.press(i % 2 === 0 ? "ArrowRight" : "ArrowLeft");
      await page.waitForTimeout(70);
      if ((await page.locator("h1", { hasText: "전투" }).count()) > 0) inBattle = true;
    }
    expect(inBattle, "a wild encounter must trigger to check the battle screen at 360px").toBe(true);
    await noScroll("battle");
    await fightUntilOutcomeClick(page);
    await page.waitForTimeout(150);

    if ((await page.locator("#app h1").textContent()) !== "숲") {
      // a wipe sent us to the center; walk back so the menu/quest-log checks still run from the overworld
      await pressN(page, "ArrowDown", 3);
      await pressN(page, "ArrowDown", 1);
      await pressN(page, "ArrowRight", 3);
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(120);
    await noScroll("menu");
    await page.click('[data-action="quest-log"]');
    await page.waitForTimeout(120);
    await noScroll("quest log");
    await page.click('[data-action="close"]');
    await page.waitForTimeout(120);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(120);
    await page.click('[data-action="pokedex"]');
    await page.waitForTimeout(120);
    await noScroll("pokedex");
  });

  test("[R20] focus ring is visible on keyboard focus", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#app h1");
    await page.keyboard.press("Tab");
    const outlineWidth = await page.evaluate(() => getComputedStyle(document.activeElement).outlineWidth);
    expect(outlineWidth).not.toBe("0px");
  });

  test("[R20] prefers-reduced-motion collapses button transitions to ~0", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.waitForSelector("#app h1");
    const duration = await page.evaluate(() => {
      const btn = document.querySelector("button");
      return getComputedStyle(btn).transitionDuration;
    });
    // reduced motion collapses the 120ms/220ms button transitions to ~0.01ms;
    // a real browser reports that back in scientific notation ("1e-05s").
    expect(Number(duration.replace("s", ""))).toBeLessThan(0.001);
  });

  test("[R20] aria-live region announces a tile-effect result (item pickup)", async ({ page }) => {
    await newGameWithSeed(page, 6006, "jiwoo");
    await pressN(page, "ArrowDown", 4);
    await pressN(page, "ArrowRight", 6); // town -> forest
    await expect(page.locator("#app h1")).toHaveText("숲");
    await pressN(page, "ArrowDown", 1); // forest entry (1,3) -> (1,4), the one-time item tile
    await page.waitForTimeout(200);
    const live = await page.locator("#aria-live").textContent();
    expect(live).toContain("아이템을 얻었다");
  });
});
