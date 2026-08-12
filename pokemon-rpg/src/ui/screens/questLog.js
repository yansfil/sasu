// Quest log screen (R14). Lists every accepted mission with its current
// status and progress.
import { QUESTS } from "../../data/quests.js";
import { listAcceptedQuests, QUEST_STATUS } from "../../engine/quest.js";

const STATUS_LABEL = {
  [QUEST_STATUS.UNACCEPTED]: "미수락",
  [QUEST_STATUS.IN_PROGRESS]: "진행중",
  [QUEST_STATUS.COMPLETABLE]: "완료가능",
  [QUEST_STATUS.CLAIMED]: "보상수령완료",
};

export function render(ctx) {
  const { root, state } = ctx;
  const accepted = listAcceptedQuests(state.questProgress, QUESTS);
  root.innerHTML = `
    <section class="screen" aria-label="퀘스트 로그">
      <h1>퀘스트 로그</h1>
      <div class="list">
        ${accepted.length === 0 ? "<p>수락한 미션이 없습니다.</p>" : accepted.map(q => `
          <div class="list-item">
            <span>${q.title}</span>
            <span class="status-pill">${STATUS_LABEL[q.status]}${q.target.count ? ` (${q.count}/${q.target.count})` : ""}</span>
          </div>
        `).join("")}
      </div>
      <button data-action="close" class="button">닫기</button>
    </section>
  `;
  root.querySelector("[data-action=close]").addEventListener("click", () => ctx.closeSubscreen());
}

export function handleAction(ctx, action) {
  if (action === "cancel" || action === "confirm") ctx.closeSubscreen();
}
