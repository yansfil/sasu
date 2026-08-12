// Pokedex screen (R16, AC22). Lists all 20 species, marking seen/caught,
// and shows the 12-catch achievement.
import { SPECIES } from "../../data/species.js";
import { hasAchievement, caughtCount, CAUGHT_ACHIEVEMENT_THRESHOLD } from "../../engine/pokedex.js";
import { renderSpeciesSprite } from "../sprites.js";

export function render(ctx) {
  const { root, state } = ctx;
  const dex = state.pokedex;
  root.innerHTML = `
    <section class="screen" aria-label="도감">
      <h1>도감</h1>
      <p>포획 ${caughtCount(dex)}종 / ${Object.keys(SPECIES).length}종
        ${hasAchievement(dex) ? `<span class="status-pill">달성! (${CAUGHT_ACHIEVEMENT_THRESHOLD}종 이상 포획)</span>` : ""}
      </p>
      <div class="card-grid">
        ${Object.values(SPECIES).map(sp => {
          const seen = dex.seen.has(sp.id);
          const caught = dex.caught.has(sp.id);
          return `<div class="card">
            ${seen ? renderSpeciesSprite(sp) : `<div style="width:72px;height:72px;background:#333">?</div>`}
            <strong>${seen ? sp.name : "???"}</strong>
            <span class="status-pill">${caught ? "포획" : seen ? "조우" : "미발견"}</span>
          </div>`;
        }).join("")}
      </div>
      <button data-action="close" class="button">닫기</button>
    </section>
  `;
  root.querySelector("[data-action=close]").addEventListener("click", () => ctx.closeSubscreen());
}

export function handleAction(ctx, action) {
  if (action === "cancel" || action === "confirm") ctx.closeSubscreen();
}
