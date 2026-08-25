#!/bin/bash
# 턴 종료 시 워킹트리를 체크포인트 커밋으로 저장한다.
# Claude Code / Codex 공용 Stop 훅. 전역 적용이므로 방어적으로 동작한다.
#
# 되돌리기:  git reset --soft HEAD~N
# 끄기:      touch .git/no-checkpoint   (저장소 단위)
#            AGENT_CHECKPOINT=0         (환경변수)
#
# 어떤 경우에도 0으로 종료한다. 훅 실패가 세션을 막으면 안 된다.

LOG="${SASU_HOOK_LOG:-$HOME/.sasu/hooks.log}"
mkdir -p "$(dirname "$LOG")" 2>/dev/null
log() { printf '%s %s %s\n' "$(date '+%F %T')" "${PWD}" "$1" >> "$LOG" 2>/dev/null; }

[ "${AGENT_CHECKPOINT:-1}" = "0" ] && exit 0

top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$top" || exit 0

[ -f "$(git rev-parse --git-path no-checkpoint)" ] && exit 0

# 진행 중인 git 작업에는 절대 끼어들지 않는다
for p in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD BISECT_LOG REVERT_HEAD; do
  path=$(git rev-parse --git-path "$p" 2>/dev/null)
  if [ -e "$path" ]; then log "skip: $p in progress"; exit 0; fi
done

# detached HEAD면 커밋이 갈 곳이 없다
branch=$(git branch --show-current 2>/dev/null)
[ -z "$branch" ] && { log "skip: detached HEAD"; exit 0; }

# 커밋이 하나도 없는 저장소는 건너뛴다 (git diff-index가 HEAD를 못 찾음)
git rev-parse --verify -q HEAD >/dev/null 2>&1 || { log "skip: no HEAD"; exit 0; }

git add -A 2>/dev/null || exit 0

# secret처럼 보이거나 지나치게 큰 파일은 스테이지에서 뺀다.
# .gitignore가 허술한 저장소에서 전역 자동 커밋이 사고를 내는 걸 막는 안전망이다.
git diff --cached --name-only -z 2>/dev/null | while IFS= read -r -d '' f; do
  case "$f" in
    *.example|*.sample|*.template) continue ;;
    *.env|.env|.env.*|*/.env|*/.env.*|*id_rsa*|*id_ed25519*|*id_ecdsa*|\
    *.pem|*.key|*.p12|*.pfx|*.keystore|*credentials.json|*/auth.json|.npmrc|*/.npmrc|*.jks)
      git restore --staged -- "$f" 2>/dev/null
      log "unstaged (secret-like): $f"
      continue ;;
  esac
  if [ -f "$f" ]; then
    size=$(wc -c < "$f" 2>/dev/null | tr -d ' ')
    if [ -n "$size" ] && [ "$size" -gt 10485760 ]; then
      git restore --staged -- "$f" 2>/dev/null
      log "unstaged (>10MB): $f"
    fi
  fi
done

git diff-index --quiet --cached HEAD -- 2>/dev/null && exit 0

n=$(git diff --cached --name-only 2>/dev/null | wc -l | tr -d ' ')
if git commit -q --no-verify -m "checkpoint: ${n} file(s)" 2>>"$LOG"; then
  log "committed $n file(s) on $branch"
else
  log "commit failed on $branch"
fi
exit 0
