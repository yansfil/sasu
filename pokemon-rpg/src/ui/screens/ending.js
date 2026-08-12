// Ending screen (R15, AC20, AC21). Shown after the rival is defeated; the
// player can keep playing everywhere except the boss room.
export function render(ctx) {
  const { root, state } = ctx;
  root.innerHTML = `
    <section class="screen" aria-label="엔딩">
      <h1>엔딩</h1>
      <div class="panel">
        <p>${ctx.characterName()}은(는) 라이벌을 꺾고 여정을 완수했다!</p>
        <p>화산 정상 보스방을 제외한 모든 곳에서 계속 플레이할 수 있습니다.</p>
      </div>
      <button data-action="continue" class="button">계속 플레이</button>
    </section>
  `;
  root.querySelector("[data-action=continue]").addEventListener("click", () => ctx.continueAfterEnding());
}

export function handleAction(ctx, action) {
  if (action === "confirm" || action === "cancel") ctx.continueAfterEnding();
}
