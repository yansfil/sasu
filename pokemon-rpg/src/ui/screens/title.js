// Title screen (R2, AC27). Presentation only - reads ctx.state, calls
// ctx actions; never touches engine rules directly.
export function render(ctx) {
  const { root, state } = ctx;
  const hasSave = ctx.hasSave;
  root.innerHTML = `
    <section class="screen" aria-label="타이틀">
      <h1>포켓몬 RPG</h1>
      <div class="panel list">
        ${hasSave ? `<button data-action="continue" class="button">이어하기</button>` : ""}
        <button data-action="new-game" class="button">새로 시작</button>
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
    </section>
  `;
  root.querySelectorAll("[data-action]").forEach(btn => {
    btn.addEventListener("click", () => ctx.dispatchClick(btn.dataset.action));
  });
}

export function handleAction(ctx, action) {
  const { state } = ctx;
  if (state.newGameConfirm) {
    if (action === "confirm") return ctx.dispatchClick("confirm-new-game");
    if (action === "cancel") return ctx.dispatchClick("cancel-new-game");
    return;
  }
  if (action === "confirm") {
    return ctx.dispatchClick(ctx.hasSave ? "continue" : "new-game");
  }
}
