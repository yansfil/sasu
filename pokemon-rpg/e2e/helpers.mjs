// Shared helpers for the e2e suite. Nothing here is committed as a
// standalone script - it only exists to keep game.spec.js and
// screenshots.spec.js from repeating the same low-level page choreography.

export async function readDebugState(page) {
  return page.evaluate(() => {
    const s = window.__pokemonRpgDebugState;
    return s ? { mapId: s.mapId, x: s.x, y: s.y, screen: s.screen } : null;
  });
}

export async function pressN(page, key, n = 1, delay = 70) {
  for (let i = 0; i < n; i++) {
    await page.keyboard.press(key);
    await page.waitForTimeout(delay);
  }
}

export async function newGameWithSeed(page, seed, characterId, { debug = false } = {}) {
  await page.goto(`/?seed=${seed}${debug ? "&debug=1" : ""}`);
  await page.waitForSelector("#app h1");
  const hasContinue = (await page.locator('[data-action="continue"]').count()) > 0;
  if (hasContinue) {
    await page.click('[data-action="new-game"]');
    await page.waitForTimeout(100);
    if ((await page.locator('[data-action="confirm-new-game"]').count()) > 0) {
      await page.click('[data-action="confirm-new-game"]');
      await page.waitForTimeout(100);
    }
  } else {
    await page.click('[data-action="new-game"]');
  }
  await page.waitForTimeout(150);
  await page.click(`.card[data-id="${characterId}"]`);
  await page.waitForTimeout(150);
}

async function readPlayerHpFraction(page) {
  const text = await page.locator(".battle-slot").nth(1).locator("span").last().textContent();
  const match = text && text.match(/(\d+)\/(\d+)/);
  if (!match) return 1;
  return Number(match[1]) / Number(match[2]);
}

/** Keyboard-only battle resolution: fight with the first usable move every round, healing via the bag when low, auto-switching on a forced faint. */
export async function fightUntilOutcomeKeyboard(page, maxRounds = 25) {
  for (let round = 0; round < maxRounds; round++) {
    if ((await page.locator('button[data-action="close"]').count()) > 0) {
      await page.keyboard.press("Enter");
      await page.waitForTimeout(150);
      return "resolved";
    }
    // A forced switch after a faint shows the party list directly (no main menu this round).
    if ((await page.locator('.list[role="menu"] button[data-action="switch"]').count()) > 0) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const first = page.locator('.list[role="menu"] button[data-action="switch"]').first();
        if ((await first.getAttribute("disabled")) === null) break;
        await page.keyboard.press("ArrowDown");
        await page.waitForTimeout(80);
      }
      await page.keyboard.press("Enter");
      await page.waitForTimeout(150);
      continue;
    }

    const hpFraction = await readPlayerHpFraction(page);
    const potionAvailable = (await page.locator('button[data-action="use-potion"]:not([disabled])').count()) > 0;
    if (hpFraction < 0.35 && potionAvailable) {
      await page.keyboard.press("ArrowDown"); // main menu: fight(0) -> bag(1)
      await page.keyboard.press("Enter");
      await page.waitForTimeout(120);
      await page.keyboard.press("Enter"); // bag cursor starts at the potion
      await page.waitForTimeout(200);
      continue;
    }

    await page.keyboard.press("Enter"); // main menu cursor starts at "fight"
    await page.waitForTimeout(120);
    // move-grid cursor starts at slot 0; if it is disabled (0 PP), step down until an enabled one is focused.
    for (let attempt = 0; attempt < 4; attempt++) {
      const firstButton = page.locator(".move-grid button").first();
      const disabled = await firstButton.getAttribute("disabled");
      if (disabled === null) break;
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(80);
    }
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
  }
  return "timeout";
}

/** Mouse-driven battle resolution used only for the screenshot/story-progress walkthrough (not the AC28 keyboard proof). */
export async function fightUntilOutcomeClick(page, { maxRounds = 25, healBelowFraction = 0.3 } = {}) {
  for (let round = 0; round < maxRounds; round++) {
    if ((await page.locator('button[data-action="close"]').count()) > 0) {
      await page.click('button[data-action="close"]');
      await page.waitForTimeout(150);
      return "resolved";
    }
    if ((await page.locator('.list[role="menu"] button[data-action="switch"]').count()) > 0) {
      const enabled = page.locator('.list[role="menu"] button[data-action="switch"]:not([disabled])').first();
      if ((await enabled.count()) > 0) { await enabled.click(); await page.waitForTimeout(150); continue; }
    }
    const potionAvailable = (await page.locator('button[data-action="use-potion"]:not([disabled])').count()) > 0;
    const lowHp = await isPlayerHpLow(page, healBelowFraction);
    if (lowHp && potionAvailable) {
      await page.click('button[data-action="bag"]');
      await page.waitForTimeout(100);
      await page.click('button[data-action="use-potion"]');
      await page.waitForTimeout(200);
      continue;
    }
    if ((await page.locator('button[data-action="fight"]').count()) > 0) {
      await page.click('button[data-action="fight"]');
      await page.waitForTimeout(100);
    }
    const move = page.locator(".move-grid button:not([disabled])").first();
    if ((await move.count()) > 0) {
      await move.click();
    } else {
      await page.click('button[data-action="back"]');
    }
    await page.waitForTimeout(200);
  }
  return "timeout";
}

async function isPlayerHpLow(page, fraction) {
  const text = await page.locator(".battle-slot").nth(1).locator("span").last().textContent();
  const match = text && text.match(/(\d+)\/(\d+)/);
  if (!match) return false;
  return Number(match[1]) / Number(match[2]) < fraction;
}

/**
 * The shared field-map layout (cave/waterway/volcano) route: accept the main
 * quest, then walk down column x=2 (not x=3) to row 7 before stepping right -
 * cave and volcano also have a side "challenger" trainer at (7,5) whose
 * sight range would otherwise trigger an unplanned battle at x=3,y=5 on the
 * way down (distance 4). Column x=2 stays 5 away the whole descent.
 */
export async function clearSharedFieldMap(page, fightFn) {
  await pressN(page, "ArrowRight", 1);
  await pressN(page, "ArrowUp", 1); // blocked (quest giver above), just sets facing
  await page.keyboard.press("Enter"); // accept main quest
  await page.waitForTimeout(150);
  await pressN(page, "ArrowLeft", 1); // back to x=2, out of the challenger's row-5 sight line
  await pressN(page, "ArrowDown", 5);
  await pressN(page, "ArrowRight", 1); // x=3,y=7: within only the guardian's sight range
  await page.waitForTimeout(200);
  if ((await page.locator("h1", { hasText: "전투" }).count()) > 0) await fightFn(page);
  await pressN(page, "ArrowRight", 6);
  await page.waitForTimeout(200);
}
