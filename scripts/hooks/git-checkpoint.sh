#!/bin/bash
# 턴 종료 시 워킹트리를 체크포인트 커밋으로 저장한다.
# Claude Code / Codex 공용 Stop 훅. 전역 적용이므로 방어적으로 동작한다.
#
# 한 세션이 여러 턴을 굴러도 체크포인트는 하나만 남는다. 직전 커밋이 이미
# 체크포인트이고 아직 push되지 않았으면 새로 쌓지 않고 그 커밋에 접는다.
# 접히기 전 버전은 reflog에 남는다 (git reflog).
#
# 체크포인트는 히스토리가 아니라 그물이다. 의미 있는 커밋 메시지는 에이전트가
# 직접 커밋할 때만 나오므로, 작업이 끝나면 에이전트가 스스로 커밋해야 한다.
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

# 직전 커밋도 체크포인트이고 아직 어떤 원격에도 올라가지 않았다면, 새로 쌓지 않고
# 그 커밋에 접는다. 한 세션이 N턴을 굴러도 체크포인트는 하나만 남는다.
# 접힌 이전 버전은 reflog에 그대로 있으므로 복구 경로는 유지된다.
amend=""
base="HEAD"
case "$(git log -1 --format='%s' 2>/dev/null)" in
  "checkpoint:"*)
    if [ -z "$(git branch -r --contains HEAD 2>/dev/null)" ] \
       && git rev-parse --verify -q HEAD~1 >/dev/null 2>&1; then
      amend="--amend"
      base="HEAD~1"
    fi
    ;;
esac

# 메시지는 훅이 알 수 있는 것만 담는다. 훅은 이번 턴이 무엇을 했는지 모르므로
# 의미 있는 제목은 에이전트가 직접 커밋할 때만 나온다. 여기서는 어디를 건드렸는지만 남긴다.
status=$(git diff --cached --name-status "$base" 2>/dev/null)
n=$(printf '%s\n' "$status" | grep -c .)
scope=$(printf '%s\n' "$status" | awk '{print $NF}' \
  | awk -F/ '{print (NF>1 ? $1 : "(root)")}' | sort -u | head -3 | paste -sd, - | sed 's/,/, /g')
[ -z "$scope" ] && scope="(root)"
extra=$(printf '%s\n' "$status" | awk '{print $NF}' \
  | awk -F/ '{print (NF>1 ? $1 : "(root)")}' | sort -u | wc -l | tr -d ' ')
[ "$extra" -gt 3 ] && scope="$scope +$((extra - 3))"

counts=""
for pair in "A:new" "M:edited" "D:deleted"; do
  code=${pair%%:*}; word=${pair#*:}
  c=$(printf '%s\n' "$status" | grep -c "^${code}")
  [ "$c" -gt 0 ] && counts="${counts}${counts:+, }${c} ${word}"
done
[ -z "$counts" ] && counts="${n} file(s)"

msg="checkpoint: ${scope} (${counts})"
if git commit -q --no-verify $amend -m "$msg" 2>>"$LOG"; then
  log "${amend:+amended }committed $n file(s) on $branch :: $msg"
else
  log "commit failed on $branch"
fi
exit 0
