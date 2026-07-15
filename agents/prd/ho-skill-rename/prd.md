---
topic: "ho- prefix skill rename to the checkshirt-boy developer concept"
status: "ready"
human_approval: "approved"
human_approval_note: "2026-07-10 대화에서 승인. 유저 발언: '오오 그렇게 가자!!! legacy alias는 빼도 됨! 어어 그렇게 하자 그리고 직커밋까지하고' + 마스코트 이미지 태스크 추가 요청(R8/T6로 반영, '그거까지해서 작업 해버려!!')."
source_intake: "current conversation"
source_clarity: "none"
created_at: "2026-07-10"
updated_at: "2026-07-10"
---

# PRD: ho- prefix 스킬 리네임 (checkshirt-boy 컨셉)

## 1. Summary

butler 컨셉의 스킬 세트를 "체크셔츠 입은 쌉고수 개발자 한 명을 부리는" 컨셉으로 전환한다.
스킬 이름은 실제 개발 워크플로 동사에 `ho-` prefix를 붙인 형태가 되고(`ho-scope`, `ho-spec`, `ho-build`, `ho-ship`, `ho-setup`), `please`와 `remember`는 이미 고유하고 말맛이 좋아 그대로 둔다.
기능/동작/스키마 변경은 없다: 이름, 문서 톤, 설치/참조 배선만 바뀐다.

Approval checklist:

- 이름 확정: listen→`ho-scope`, promise→`ho-spec`, fulfill→`ho-build`, deliver→`ho-ship`, pantry→`ho-setup`, `please`/`remember` 유지 (4.2장 D1)
- `ho:` 콜론 표기는 플랫폼 제약(콜론은 플러그인 네임스페이스 전용)으로 하이픈 `ho-`로 실현, 플러그인화는 후속 유보 (4.2장 D1, 4.3장)
- legacy alias 제거: butler 이름과 그 이전 이름의 트리거 문구를 남기지 않고 새 이름으로만 호출 (D2, 유저 확정)
- checkshirt-boy 페르소나는 README 전면 + SKILL.md description 라이트 터치 범위 (D3)
- 마스코트 이미지: 유저 제공 레퍼런스 이미지의 전체적인 느낌(굵은 흑백 외곽선, 검정 배경)에 체크셔츠를 입힌 마스코트를 codex-rescue로 생성해 README에 게시 (D5, R8)
- 검증 모드: automated behavior + 양 런타임 설치본 CLI smoke, 전부 required (9장)
- delivery mode: local (main 직커밋, PR 없음) (D4)

## 2. Problem, Goal, And Users

유저는 이호연 단독이며 이 harness를 Codex와 Claude Code 양쪽의 일상 파이프라인으로 쓴다.

문제: butler 이름(`pantry`, `promise`, `fulfill`)은 세계관을 알아야 뜻이 통해서 호출할 때마다 머릿속 번역이 한 번 필요하고, 특히 설정 스킬(`pantry`)은 이름에서 역할이 전혀 드러나지 않는다.
또한 일반 동사(`spec`, `build`)만 쓰면 이 머신의 다른 마켓플레이스 스킬들(`specify`, `execute`, `plan` 등)과 충돌한다.

목표: 실제 개발 어휘 그대로의 동사에 짧은 시그니처 prefix(`ho-`)를 붙여 즉시 이해되면서 충돌 없는 이름 체계를 만들고, "체크셔츠 쌉고수 개발자" 페르소나로 문서 톤을 통일한다.

## 3. Scope And Non-Goals

포함 (Scope):

- repo `skills/` 디렉터리와 SKILL.md frontmatter name 리네임 (매핑은 Summary와 R1에 고정).
- SKILL.md 6종 + remember의 상호참조(호출 토큰, 스크립트 경로, 형제 스킬 언급) 전부 새 이름으로 갱신.
- installer 갱신: 스킬 목록, 호출 토큰 치환, 자기 소유 구이름 설치 디렉터리 정리, 훅 등록 경로 갱신.
- 스크립트의 형제/하네스 경로 fallback 체인에 새 이름을 최우선으로 추가.
- README를 checkshirt-boy 컨셉으로 갱신하고 SKILL.md description에 라이트 페르소나 톤 적용.
- 테스트/golden 갱신과 설치 후 양 런타임 검증.

비범위 (Non-Goals):

- 스킬의 기능, 절차, 하네스 동작, state 스키마, agents/ 네임스페이스 계약 변경 (이름과 문서만 바뀐다).
- `/ho:build` 콜론 표기를 위한 플러그인 패키징 (Claude 전용이 되어 듀얼 런타임 대칭이 깨지므로 후속 검토로 유보).
- 브레인스토밍 전용 스킬 또는 `ho-scope`의 발산(explore) 모드 (후속 후보).
- 다른 프로젝트에 남아 있는 옛 이름 언급의 일괄 정리 (self-locating 스크립트라 런타임 영향 없음).

## 4. Pre-Work And Required Decisions

### 4.1 Pre-Work Before Implementation

None required.
모든 작업이 로컬 리네임/문서/설치이며 자격증명이나 외부 권한이 필요 없다.

### 4.2 Human Decisions Before PRD Approval

- D1. 이름 세트와 `ho-` 하이픈 실현 승인: 유저가 "ho: 이렇게 가버리자"로 prefix를 정했으나, 콜론은 Claude Code에서 플러그인 네임스페이스 전용 문법이라 유저 스킬 이름에 쓸 수 없음이 공식 문서로 확인됨. 하이픈 `ho-`가 양 런타임 동일하게 동작하는 가장 가까운 실현이다.
- D2. legacy alias 제거 승인: 유저가 "legacy alias는 빼도 됨"으로 확정. 옛 이름(butler, pre-butler)의 트리거 문구를 description에서 제거하고 새 이름으로만 호출한다.
- D3. 페르소나 적용 범위 승인: README 전면 + description 라이트 터치 (SKILL.md 본문 절차는 톤 변경 없이 유지).
- D4. delivery mode `local` 승인: main 직커밋, PR 없음. 유저가 "직커밋까지 하고"로 확정.
- D5. 마스코트 이미지 승인: 유저 제공 레퍼런스의 느낌을 유지한 체크셔츠 버전을 codex-rescue로 생성해 repo에 커밋하고 README에 게시. 최종 그림 취향 판단은 Human Verification으로 남긴다.

### 4.3 Decision Traceability For Fidelity Review

수용된 결정:

- "쌉고수 개발자 한 명 부리는 느낌" 컨셉 전환 (유저 발제). → R5, README/description 톤
- 개발 워크플로 동사 이름 세트 scope/spec/build/ship/setup (에이전트 제안, 유저가 방향 수용). → R1
- `please`는 유지 (유저: "please는 괜찮은 것 같고"). → R1에서 제외 목록
- 일반 단어 충돌 때문에 prefix 필요 (유저: "너무 용어가 일반적이라 앞에 뭘 좀 prefix 붙이는게 낫나" + 에이전트 동의). → R1
- prefix는 `ho` (유저: "ho: 이렇게 가버리자"). 콜론은 플랫폼 제약으로 하이픈 실현 (claude-code-guide 조사: 유저 스킬은 kebab-case만, 콜론은 플러그인 네임스페이스 전용). → R1, D1
- 컨셉은 checkshirt-boy (유저: "체크셔츠 개발자가 많이 입는 느낌"). → R5
- `remember`는 이름 유지 (직전 PRD에서 확정된 스킬, 이름이 이미 명령어로 자연스러움). → R1 제외 목록
- legacy alias는 제거 (유저: "legacy alias는 빼도 됨" - 에이전트의 유지 제안을 뒤집은 결정). → R2, D2
- 마스코트 이미지 추가 (유저: "이 이미지의 전체적인 느낌에 체크셔츠 입은 느낌으로", codex-rescue 사용 지정). 레퍼런스는 굵은 흑백 외곽선 + 검정 배경의 안경 쓴 캐릭터. → R8, T6, D5

기각된 대안:

- `ace-`/`gosu-`/사람이름 prefix: 유저가 `ho`로 확정하며 기각.
- `check-` prefix: `/check-build`가 "빌드를 검사"로 읽히는 의미 충돌로 에이전트가 비추천, 유저도 선택하지 않음.
- prefix 없는 일반 동사(`/spec`, `/build`): 마켓플레이스 스킬 충돌로 기각.
- 플러그인화로 진짜 `/ho:build` 얻기: Codex에 플러그인 시스템이 없어 듀얼 런타임 대칭이 깨지므로 지금은 기각, 후속 유보.

유보된 결정:

- 브레인스토밍은 스킬 없이 일반 대화로 (발산=대화, 수렴=`ho-scope`, 굳히기=`ho-spec`). `--explore` 모드나 `/ho-jam`은 후속 후보. → 비범위

## 5. Major Technical Structure Changes

- 스킬의 공개 호출명이 바뀐다: 유저 인터페이스 변경이지만 내부 아키텍처, 데이터 흐름, 스키마, API 경계 변화는 없다.
- 설치 훅 등록이 참조하는 하네스 스크립트 경로가 `~/.*/skills/fulfill/...`에서 `~/.*/skills/ho-build/...`로 바뀐다 (installer가 idempotent하게 재등록하고 stale 항목을 정리).
- 그 외 No major technical structure change expected.

## 6. Requirements

- R1. repo `skills/` 디렉터리와 각 SKILL.md frontmatter `name:`을 리네임한다: `listen`→`ho-scope`, `promise`→`ho-spec`, `fulfill`→`ho-build`, `deliver`→`ho-ship`, `pantry`→`ho-setup`. `please`와 `remember`는 이름을 유지한다.
- R2. SKILL.md 전체(7종)의 상호참조를 새 이름으로 갱신한다: 호출 토큰(`$fulfill` 등), 스크립트 경로(`~/.codex/skills/fulfill/scripts/...` 등), 형제 스킬 언급. legacy alias 트리거 문구(butler 이름과 pre-butler 이름)는 description에서 제거해 새 이름으로만 호출된다.
- R3. installer를 갱신한다: `SKILL_NAMES`와 호출 토큰 치환 목록이 새 이름 기준이 되고, 자기 소유(frontmatter name 검사)인 구이름 설치 디렉터리(butler 이름 포함)를 정리하며, 훅 등록이 새 `ho-build` 경로로 이루어지고 기존 훅 파일의 stale fulfill 경로 항목이 교체된다.
- R4. 스크립트의 self-locate fallback 체인에 새 이름을 최우선으로 추가한다: 형제 스킬 조회는 `ho-ship`→`deliver`→`prd-ship`, 하네스 조회는 `ho-build`→`fulfill`→`prd-implement` 순.
- R5. README를 checkshirt-boy 컨셉으로 갱신한다: 파이프라인 다이어그램(`ho-scope`→`ho-spec`→`ho-build`→`ho-ship`, `please`=원샷), 스킬 표, 컨셉 소개. SKILL.md description에는 라이트 페르소나 톤만 입히고 본문 절차 텍스트는 톤 변경하지 않는다.
- R6. 테스트와 golden을 새 이름 기준으로 갱신한다: 설치 테스트의 경로/치환 검증, 하네스 테스트의 스크립트 경로 상수, golden 재생성과 결정성 확인.
- R7. 설치를 실행해 양 런타임 설치 루트에 7개 스킬(`ho-scope`, `ho-spec`, `ho-build`, `ho-ship`, `ho-setup`, `please`, `remember`)이 존재하고, 새 경로의 doctor가 정상 동작하며, 잔여 구이름 참조가 데이터 호환 서술(레거시 경로/파일명 설명) 외에 남지 않음을 grep으로 감사한다.
- R8. checkshirt-boy 마스코트 이미지를 생성해 repo에 커밋하고 README 상단에 게시한다: 유저 제공 레퍼런스의 전체적인 느낌(굵은 흑백 외곽선, 검정 배경, 안경)을 유지하되 체크셔츠를 입힌 버전. 생성은 codex-rescue 경유를 우선 시도하고, codex가 이미지 생성을 지원하지 않으면 레퍼런스 스타일을 따라 수제 SVG로 대체하며 그 전환을 deviation으로 기록한다.

## 7. Acceptance Criteria

- AC1. 리네임 후 전체 테스트 스위트가 green이고 golden이 결정적으로 재생성된다.
- AC2. 양 런타임 설치 루트에 새 이름 7종이 설치되고, 구 butler 이름 설치 디렉터리는 제거되며, `node ~/.claude/skills/ho-build/scripts/prd_state_harness.js doctor`와 Codex 동등 경로가 exit 0으로 동작한다.
- AC3. 훅 파일(`~/.claude/settings.json`, `~/.codex/hooks.json`)의 하네스 훅이 새 `ho-build` 경로를 가리키고 stale fulfill 경로 항목이 남지 않는다.
- AC4. repo 전체 grep에서 구이름 참조는 데이터 호환 서술(레거시 경로/파일명) 문맥에만 남고, 스킬 호출용 alias 문구는 남지 않는다.
- AC5. README가 새 컨셉과 이름 체계를 반영하고, 각 SKILL.md description이 새 호출명만 담는다.
- AC6. 마스코트 이미지 파일이 repo에 존재하고 README가 이를 참조하며, 이미지가 레퍼런스의 스타일 요소(흑백 외곽선, 검정 배경, 안경)와 체크셔츠를 담는다 (스타일 판단 자체는 Human Verification).

## 8. PRD-Level Tasks

- T1. 디렉터리/frontmatter 리네임과 SKILL.md 상호참조 치환, legacy alias 문구 정리. Covers R1, R2.
- T2. installer 갱신(목록, 치환, 구디렉터리 정리, 훅 재등록/정리)과 스크립트 fallback 체인 갱신. Covers R3, R4.
- T3. README checkshirt-boy 컨셉 갱신 + description 라이트 톤. Covers R5.
- T4. 테스트/golden 갱신과 재생성. Covers R6.
- T5. 설치 실행, 양 런타임 smoke, 잔여 참조 grep 감사. Covers R7. 순수 검증과 릴리스 위생.
- T6. 마스코트 이미지 생성(codex-rescue 우선, SVG fallback)과 README 게시. Covers R8, AC6.

## 9. Verification Contract

### 9.1 Test Mode Contract

| Mode | Required For Done | Covers | Human Decision |
| --- | --- | --- | --- |
| automated behavior | yes | 리네임 후 하네스/설치 동작 회귀 | none |
| browser/runtime | yes | 설치본 심링크 경유 CLI smoke (브라우저 아님, 터미널 CLI 실행) | none |

### 9.2 Required Agent Verification

| ID | Mode | Covers | Method | Artifact | Pass Criteria | Environment | Required For Done | Can Be Blocked | Safe Probe | Side Effect | Sensitive Data Policy |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| V1 | automated behavior | R1, R2, R3, R4, R6, AC1, AC4 | `node --test tests/*.test.mjs` (리네임 반영 스위트, golden은 `UPDATE_GOLDEN=1` 재생성 후 재실행으로 결정성 확인) | command-log | 전체 테스트 pass, 재실행 시 golden diff 없음 | local shell | yes | no | none (로컬 전용) | 임시 fixture 생성/삭제만 | 비밀값 없음 |
| V2 | browser/runtime | R3, R5, R7, AC2, AC3, AC5 | 설치 후 `node ~/.claude/skills/ho-build/scripts/prd_state_harness.js doctor`와 Codex 동등 경로 실행, 설치 루트 7종 스킬 목록과 훅 파일의 새 경로를 확인하는 로그 수집 | command-log | 양 런타임 doctor exit 0, 스킬 7종 존재, 훅이 ho-build 경로, 구 디렉터리 제거 | local shell (터미널 CLI, 브라우저 불필요) | yes | no | none (로컬 전용) | 설치 심링크/훅 파일 갱신 | 비밀값 없음 |
| V3 | automated behavior | R8, AC6 | `test -f` 기반 마스코트 파일 실존 + README 참조 grep 확인 커맨드 실행, 생성된 이미지 파일을 artifact로 등록 | command-log | 마스코트 파일 존재, README가 참조, 파일이 비어 있지 않음 | local shell | yes | no | none (로컬 전용) | repo에 이미지 파일 추가 | 비밀값 없음 |

자동 검증 행이 보호하는 회귀 위험: V1은 "리네임이 경로 배선을 조용히 깨뜨려 하네스가 자기 스크립트를 못 찾는" 위험, V2는 "설치/훅이 옛 경로에 남아 다음 세션부터 stop 훅과 스킬 목록이 죽는" 위험을 막는다.

### 9.3 Human Verification

- 페르소나 카피 톤의 최종 취향 판단 (README와 description 문구가 "checkshirt-boy" 느낌에 맞는지)은 사람 몫이다. 구현 완료 보고에서 대표 문구를 제시하고 유저가 후속 조정을 지시할 수 있다.
- 마스코트 이미지가 레퍼런스의 "전체적인 느낌"을 살렸는지의 최종 취향 판단. 구현 보고에서 이미지를 제시하고 유저가 재생성을 지시할 수 있다.

## 10. Risks And Open Decisions

- 훅 경로 교체가 불완전하면 다음 세션부터 stop 훅 연속성 루프가 끊긴다. installer의 idempotent 재등록 + stale 항목 정리(R3)와 V2의 훅 파일 확인으로 방어한다. 현재 활성 run이 없어(직전 run은 receipt 후 cleanup 완료) 진행 중 세션 파손 위험은 없다.
- SKILL.md 전반의 경로/토큰 참조가 많아 치환 누락 위험이 있다. T5의 grep 감사(AC4)를 필수로 한다.
- `remember`가 이번에 리네임되는 `ho-build` 경로의 커맨드를 인용하므로 함께 갱신해야 한다 (R2가 7종 전체를 다루는 이유).
- 다른 머신/프로젝트 문서에 남은 옛 이름 언급은 self-locating 스크립트 덕에 런타임 영향이 없고 비범위로 둔다.

Open decisions: 없음 (D1-D4는 승인 대기이며 blocking).

## 11. Implementation Guardrails

- 스킬의 절차/기능/하네스 동작/스키마를 변경하지 않는다: 이름, 경로 배선, 문서 톤만 바꾼다.
- `agents/` 네임스페이스 계약(직전 PRD 산출물)과 rules 엔진 동작을 건드리지 않는다.
- npm 런타임 의존성을 추가하지 않는다.
- 유저의 다른 스킬/훅 항목(orca 등 외부 훅, 마켓플레이스 스킬)을 건드리지 않는다: installer는 자기 소유 항목만 갱신/정리한다.
- 커밋/브랜치 텍스트에 에이전트/모델/도구 attribution을 넣지 않는다.

## 12. Implementation Result Report Contract

구현 에이전트는 다음을 보고한다:

- status: `Done` / `Partially Done` / `Blocked`.
- 유저 가시 변화: 새 호출명 표, legacy alias 동작 여부, README 컨셉.
- 변경 지점: 디렉터리 리네임 목록, installer, fallback 체인, 훅 파일 diff 요약.
- 승인 구조(5장) 준수 여부: 기능 무변경 확인.
- T1-T5 완료 상태와 R/AC/V 커버리지.
- 모드별 검증 증거: V1-V2 command-log 경로.
- 페르소나 대표 문구 샘플 (Human Verification 후속 판단용).
- deviations와 남은 사람 검토, 후속 후보 (플러그인화, ho-scope explore 모드).
- delivery: local 커밋 해시 목록 (PR 없음).
