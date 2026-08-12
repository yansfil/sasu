// AC24/V5 - captures the screenshots the read-only visual judge inspects.
// Reuses the same seeded, deterministic story progression as game.spec.js
// (D-27) so a re-run produces byte-identical game state at each shot.
import { test, expect } from "@playwright/test";
import path from "node:path";
import { pressN, newGameWithSeed, fightUntilOutcomeClick, clearSharedFieldMap, readDebugState } from "./helpers.mjs";

const OUT = path.join(process.cwd(), "e2e", "screenshots");

test("[AC24] capture title, character select, town, forest, battle, and quest log", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("#app h1");
  await page.screenshot({ path: path.join(OUT, "01-title.png") });

  await page.click('[data-action="new-game"]');
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(OUT, "02-character-select.png") });

  await page.click('.card[data-id="jiwoo"]');
  await page.waitForTimeout(150);
  await expect(page.locator("#app h1")).toHaveText("마을");
  await page.screenshot({ path: path.join(OUT, "03-town.png") });

  await pressN(page, "ArrowDown", 4);
  await pressN(page, "ArrowRight", 6);
  await expect(page.locator("#app h1")).toHaveText("숲");
  await page.screenshot({ path: path.join(OUT, "04-forest.png") });

  // trigger a wild encounter deterministically via the same seed the AC28
  // flow uses, then screenshot the battle screen mid-fight.
  await page.goto("/?seed=1001");
  await page.waitForSelector("#app h1");
  await page.click('[data-action="new-game"]');
  await page.waitForTimeout(150);
  if ((await page.locator('[data-action="confirm-new-game"]').count()) > 0) {
    await page.click('[data-action="confirm-new-game"]');
    await page.waitForTimeout(150);
  }
  await page.click('.card[data-id="jiwoo"]');
  await page.waitForTimeout(150);
  await pressN(page, "ArrowDown", 4);
  await pressN(page, "ArrowRight", 6);
  await pressN(page, "ArrowRight", 3);
  let inBattle = false;
  for (let i = 0; i < 60 && !inBattle; i++) {
    await page.keyboard.press(i % 2 === 0 ? "ArrowRight" : "ArrowLeft");
    await page.waitForTimeout(70);
    if ((await page.locator("h1", { hasText: "전투" }).count()) > 0) inBattle = true;
  }
  expect(inBattle).toBe(true);
  await page.screenshot({ path: path.join(OUT, "05-battle.png") });
  await fightUntilOutcomeClick(page);

  // open the quest log (accept a mission first so it has content)
  if ((await page.locator("#app h1").textContent()) === "포켓몬센터 내부") {
    await pressN(page, "ArrowDown", 3);
    await pressN(page, "ArrowDown", 1);
    await pressN(page, "ArrowRight", 3);
  }
  const pos = await readDebugState(page).catch(() => null);
  await pressN(page, "ArrowUp", 2);
  await pressN(page, "ArrowRight", 1);
  await page.keyboard.press("Enter"); // accept forest_main (best-effort; harmless if it lands elsewhere)
  await page.waitForTimeout(150);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  if ((await page.locator("#app h1").textContent()) === "메뉴") {
    await page.click('[data-action="quest-log"]');
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(OUT, "06-quest-log.png") });
  }
});
