// Character select screen (R2, AC2, AC3, AC4). 5 cards, each with sprite,
// name, starting partner, and the trait's numeric effect spelled out.
import { CHARACTERS } from "../../data/characters.js";
import { SPECIES } from "../../data/species.js";
import { renderCharacterSprite } from "../sprites.js";

const ORDER = ["jiwoo", "iseul", "woong", "green", "mindeulle"];

export function render(ctx) {
  const { root, state } = ctx;
  const cursor = state.selection.characterIndex ?? 0;
  root.innerHTML = `
    <section class="screen" aria-label="캐릭터 선택">
      <h1>캐릭터 선택</h1>
      <div class="card-grid" role="listbox" aria-label="플레이어블 캐릭터 5명">
        ${ORDER.map((id, i) => {
          const c = CHARACTERS[id];
          const partner = SPECIES[c.partnerSpeciesId];
          return `
            <div class="card ${i === cursor ? "selected" : ""}" role="option" aria-selected="${i === cursor}" data-index="${i}" data-id="${id}" tabindex="0">
              ${renderCharacterSprite(c)}
              <strong>${c.name}</strong>
              <span>시작 파트너: ${partner.name}</span>
              <span>${c.traitName}</span>
              <span>${c.traitDescription}</span>
            </div>
          `;
        }).join("")}
      </div>
      <p>방향키로 고르고 Z/Enter로 확정하세요.</p>
    </section>
  `;
  root.querySelectorAll(".card").forEach(card => {
    card.addEventListener("click", () => ctx.selectCharacter(card.dataset.id));
  });
}

export function handleAction(ctx, action) {
  const { state } = ctx;
  const cursor = state.selection.characterIndex ?? 0;
  if (action === "left" || action === "up") {
    state.selection.characterIndex = (cursor + ORDER.length - 1) % ORDER.length;
    ctx.rerender();
  } else if (action === "right" || action === "down") {
    state.selection.characterIndex = (cursor + 1) % ORDER.length;
    ctx.rerender();
  } else if (action === "confirm") {
    ctx.selectCharacter(ORDER[cursor]);
  }
}
