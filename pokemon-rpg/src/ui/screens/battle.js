// Battle screen (R7, R8). Presentation + menu navigation only; all damage,
// capture, and PP rules live in engine/battle.js and engine/capture.js -
// this file calls ctx methods that wrap them.
import { MOVES } from "../../data/moves.js";
import { SPECIES } from "../../data/species.js";
import { renderSpeciesSprite, typeBadgeHtml } from "../sprites.js";

function hpBar(current, max) {
  const pct = Math.max(0, Math.min(100, (current / max) * 100));
  return `<div class="hp-bar"><div class="hp-bar-fill ${pct <= 25 ? "low" : ""}" style="width:${pct}%"></div></div>`;
}

function battlerCard(label, member) {
  const species = SPECIES[member.speciesId];
  return `
    <div class="battle-slot">
      ${renderSpeciesSprite(species)}
      <strong>${label} ${species.name} Lv${member.level}</strong>
      ${typeBadgeHtml(species.type)}
      ${hpBar(member.currentHp, member.stats.hp)}
      <span>HP ${Math.max(0, member.currentHp)}/${member.stats.hp}</span>
    </div>
  `;
}

export function render(ctx) {
  const { root, state } = ctx;
  const battle = state.battle;
  const player = state.party[battle.playerIndex];
  const opponent = battle.mode === "trainer" ? battle.opponentParty[battle.opponentIndex] : battle.opponent;

  let menuHtml = "";
  if (battle.outcome) {
    menuHtml = `<div class="panel"><p>${battle.outcomeText}</p><button data-action="close" class="button">확인</button></div>`;
  } else if (battle.menu === "fight") {
    menuHtml = `<div class="move-grid" role="menu" aria-label="기술 선택">
      ${player.moveSlots.map((slot, i) => {
        const move = MOVES[slot.moveId];
        const disabled = slot.pp <= 0;
        return `<button data-action="move" data-index="${i}" class="button ${i === battle.cursor ? "selected" : ""}" ${disabled ? "disabled" : ""}>${move.name} (${slot.pp}/${slot.maxPp})</button>`;
      }).join("")}
      <button data-action="back" class="button">뒤로</button>
    </div>`;
  } else if (battle.menu === "bag") {
    menuHtml = `<div class="list" role="menu" aria-label="가방">
      <button data-action="use-potion" class="button ${battle.cursor === 0 ? "selected" : ""}" ${state.inventory.potion <= 0 ? "disabled" : ""}>상처약 사용 (${state.inventory.potion}개)</button>
      <button data-action="back" class="button">뒤로</button>
    </div>`;
  } else if (battle.menu === "party") {
    menuHtml = `<div class="list" role="menu" aria-label="파티 교체">
      ${state.party.map((m, i) => `<button data-action="switch" data-index="${i}" class="button ${i === battle.cursor ? "selected" : ""}" ${m.currentHp <= 0 || i === battle.playerIndex ? "disabled" : ""}>${SPECIES[m.speciesId].name} Lv${m.level} HP ${m.currentHp}/${m.stats.hp}</button>`).join("")}
      ${battle.forcedSwitch ? "" : `<button data-action="back" class="button">뒤로</button>`}
    </div>`;
  } else {
    const options = [
      { action: "fight", label: "싸우기" },
      { action: "bag", label: "가방" },
    ];
    if (battle.mode === "wild") {
      options.push({ action: "catch", label: "포획" });
      options.push({ action: "run", label: "도망" });
    } else {
      options.push({ action: "party", label: "교체" });
    }
    menuHtml = `<div class="list" role="menu" aria-label="전투 메뉴">
      ${options.map((o, i) => `<button data-action="${o.action}" class="button ${i === battle.cursor ? "selected" : ""}">${o.label}</button>`).join("")}
    </div>`;
  }

  root.innerHTML = `
    <section class="screen" aria-label="전투: ${battle.mode === "wild" ? "야생" : "트레이너"}">
      <h1>${battle.mode === "wild" ? "야생 전투" : `${battle.trainerNpc ? battle.trainerNpc.id : "트레이너"} 전투`}</h1>
      <div class="battle-field">
        ${battlerCard("상대", opponent)}
        ${battlerCard("내", player)}
      </div>
      <div class="log" aria-live="off">${battle.log.slice(-6).map(l => `<p>${l}</p>`).join("")}</div>
      ${menuHtml}
    </section>
  `;
  root.querySelectorAll("[data-action]").forEach(btn => {
    btn.addEventListener("click", () => ctx.battleClick(btn.dataset.action, btn.dataset.index !== undefined ? Number(btn.dataset.index) : null));
  });
}

export function handleAction(ctx, action) {
  const battle = ctx.state.battle;
  if (battle.outcome) {
    if (action === "confirm" || action === "cancel") ctx.battleClick("close");
    return;
  }
  const menuSize = ctx.battleMenuSize();
  if (action === "up" || action === "left") {
    battle.cursor = (battle.cursor + menuSize - 1) % menuSize;
    ctx.rerender();
  } else if (action === "down" || action === "right") {
    battle.cursor = (battle.cursor + 1) % menuSize;
    ctx.rerender();
  } else if (action === "confirm") {
    ctx.battleConfirmCursor();
  } else if (action === "cancel") {
    if (battle.menu !== "main" && !battle.forcedSwitch) ctx.battleClick("back");
  }
}
