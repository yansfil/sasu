// Pause menu (R14, R16, R17). Simple list navigation to the quest log,
// pokedex, party view, or the new-game confirmation flow.
const OPTIONS = [
  { action: "quest-log", label: "퀘스트 로그" },
  { action: "pokedex", label: "도감" },
  { action: "party", label: "파티" },
  { action: "new-game", label: "새로 시작" },
  { action: "close", label: "닫기" },
];

export function render(ctx) {
  const { root, state } = ctx;
  const cursor = state.selection.menuIndex ?? 0;
  root.innerHTML = `
    <section class="screen" aria-label="메뉴">
      <h1>메뉴</h1>
      <div class="list" role="menu">
        ${OPTIONS.map((o, i) => `<button data-action="${o.action}" class="button ${i === cursor ? "selected" : ""}">${o.label}</button>`).join("")}
      </div>
      ${state.newGameConfirm ? `
        <div class="panel" role="alertdialog" aria-label="새로 시작 확인">
          <p>기존 세이브가 삭제됩니다. 정말 새로 시작할까요?</p>
          <div class="list">
            <button data-action="confirm-new-game" class="button">확인</button>
            <button data-action="cancel-new-game" class="button">취소</button>
          </div>
        </div>
      ` : ""}
      ${state.selection.showParty ? renderPartyPanel(ctx) : ""}
    </section>
  `;
  root.querySelectorAll("[data-action]").forEach(btn => {
    btn.addEventListener("click", () => ctx.menuClick(btn.dataset.action));
  });
}

function renderPartyPanel(ctx) {
  return `<div class="panel list">
    ${ctx.state.party.map(m => `<div class="list-item"><span>${ctx.speciesName(m.speciesId)} Lv${m.level}</span><span>HP ${m.currentHp}/${m.stats.hp}</span></div>`).join("")}
  </div>`;
}

export function handleAction(ctx, action) {
  const { state } = ctx;
  if (state.newGameConfirm) {
    if (action === "confirm") return ctx.menuClick("confirm-new-game");
    if (action === "cancel") return ctx.menuClick("cancel-new-game");
    return;
  }
  const cursor = state.selection.menuIndex ?? 0;
  if (action === "up") {
    state.selection.menuIndex = (cursor + OPTIONS.length - 1) % OPTIONS.length;
    ctx.rerender();
  } else if (action === "down") {
    state.selection.menuIndex = (cursor + 1) % OPTIONS.length;
    ctx.rerender();
  } else if (action === "confirm") {
    ctx.menuClick(OPTIONS[cursor].action);
  } else if (action === "cancel") {
    ctx.menuClick("close");
  }
}
