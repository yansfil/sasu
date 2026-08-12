// Overworld screen (R3, R19, R21). Renders the current map's grid, the
// player, and a party/inventory summary bar. All movement/interaction rules
// are resolved by ctx (main.js) via engine calls - this file only paints.
import { MAPS } from "../../data/maps.js";
import { renderTileSprite } from "../sprites.js";

const VIEW_COLS = 9;
const VIEW_ROWS = 7;

export function render(ctx) {
  const { root, state } = ctx;
  const map = MAPS[state.mapId];
  const rows = map.grid.length;
  const cols = map.grid[0].length;

  let tilesHtml = "";
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const npc = (map.npcs || []).find(n => n.x === x && n.y === y);
      tilesHtml += `<div class="tile" style="grid-column:${x + 1}; grid-row:${y + 1}">${
        npc ? `<div aria-hidden="true" style="width:100%;height:100%;background:#e0435e;border-radius:4px"></div>` : renderTileSprite(map.grid[y][x])
      }</div>`;
    }
  }

  const camX = Math.max(0, Math.min(cols - VIEW_COLS, state.x - Math.floor(VIEW_COLS / 2)));
  const camY = Math.max(0, Math.min(rows - VIEW_ROWS, state.y - Math.floor(VIEW_ROWS / 2)));

  root.innerHTML = `
    <section class="screen" aria-label="오버월드: ${map.name}">
      <h1>${map.name}</h1>
      <div class="overworld-viewport" style="max-width:calc(var(--tile-size) * ${VIEW_COLS})">
        <div class="overworld-grid" style="
          grid-template-columns: repeat(${cols}, var(--tile-size));
          grid-template-rows: repeat(${rows}, var(--tile-size));
          left: calc(-1 * var(--tile-size) * ${camX});
          top: calc(-1 * var(--tile-size) * ${camY});
        ">${tilesHtml}</div>
        <div class="player-sprite" aria-hidden="true" style="
          left: calc(var(--tile-size) * ${state.x - camX});
          top: calc(var(--tile-size) * ${state.y - camY});
          background:#5b7fd6; border-radius:50%;
        "></div>
      </div>
      <div class="panel">
        <strong>${ctx.characterName()}</strong> · 몬스터볼 ${state.inventory.pokeball} · 상처약 ${state.inventory.potion}
        <div class="list">
          ${state.party.map(m => `<span>${ctx.speciesName(m.speciesId)} Lv${m.level} HP ${m.currentHp}/${m.stats.hp}</span>`).join(" ")}
        </div>
      </div>
      ${state.dialog ? `<div class="panel" role="status">${state.dialog}</div>` : ""}
    </section>
  `;
}

export function handleAction(ctx, action) {
  if (["up", "down", "left", "right"].includes(action)) {
    ctx.moveOverworld(action);
  } else if (action === "confirm") {
    ctx.interactOverworld();
  } else if (action === "cancel") {
    ctx.openMenu();
  }
}
