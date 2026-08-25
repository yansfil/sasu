#!/bin/bash
# WorktreeCreate 훅. 워크트리 생성을 대체한다.
# 계약: 성공 시 워크트리 경로를 stdout으로 출력. 0이 아닌 종료 코드는 생성을 중단시킨다.
#
# 기본 동작과의 차이 두 가지:
#  1) 더러운 트리면 먼저 체크포인트를 찍는다. 미커밋 WIP이 워크트리로 따라간다.
#  2) <repo>/.claude/worktree-bootstrap.sh 가 있으면 실행한다 (env 심링크, 의존성 설치 등).

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="${SASU_HOOK_LOG:-$HOME/.sasu/hooks.log}"
mkdir -p "$(dirname "$LOG")" 2>/dev/null
log() { printf '%s %s [worktree] %s\n' "$(date '+%F %T')" "${PWD}" "$1" >> "$LOG" 2>/dev/null; }
die() { echo "$1" >&2; log "ABORT: $1"; exit 1; }

input=$(cat)
name=$(printf '%s' "$input" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("name","") or "")' 2>/dev/null)
[ -z "$name" ] && die "WorktreeCreate: 입력 JSON에 name이 없습니다"

top=$(git rev-parse --show-toplevel 2>/dev/null) || die "git 저장소가 아닙니다"
cd "$top" || die "cd 실패: $top"

# 더러우면 막지 않고 체크포인트를 찍어 WIP이 워크트리로 따라가게 한다
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  log "dirty tree, checkpointing before worktree '$name'"
  "$HOOK_DIR/git-checkpoint.sh" >/dev/null 2>&1
  remaining=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  [ "$remaining" != "0" ] && echo "note: ${remaining}개 항목은 체크포인트에서 제외되어 워크트리에 따라가지 않습니다 (secret 후보 또는 10MB 초과). 자세한 내용은 $LOG" >&2
fi

dir="$top/.claude/worktrees/$name"
[ -e "$dir" ] && die "이미 존재합니다: $dir"
mkdir -p "$top/.claude/worktrees" || die "디렉터리 생성 실패"

# 브랜치 이름 충돌 회피
branch="$name"
i=2
while git show-ref --verify -q "refs/heads/$branch"; do branch="$name-$i"; i=$((i+1)); done

# 기본 브랜치가 아니라 HEAD에서 분기한다. 방금 찍은 체크포인트가 여기 들어있다.
if ! out=$(git worktree add --quiet -b "$branch" "$dir" HEAD 2>&1); then
  die "git worktree add 실패: $out"
fi

bootstrap="$top/.claude/worktree-bootstrap.sh"
if [ -x "$bootstrap" ]; then
  if ! bout=$("$bootstrap" "$dir" 2>&1); then
    git worktree remove --force "$dir" 2>/dev/null
    git branch -D "$branch" 2>/dev/null
    die "worktree-bootstrap.sh 실패, 워크트리를 되돌렸습니다: $bout"
  fi
  log "bootstrap ok: $dir"
fi

log "created $dir on $branch from $(git rev-parse --short HEAD)"
echo "$dir"
