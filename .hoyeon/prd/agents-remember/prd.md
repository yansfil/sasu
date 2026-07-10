---
topic: "agents namespace migration and remember skill"
status: "ready"
human_approval: "approved"
human_approval_note: "2026-07-10 대화에서 승인. 유저 발언: '어어 그거 괜찮은 것 같아!' + pantry가 AGENTS.md에 구조 섹션을 시드하라는 추가 요청(R15로 반영)."
source_intake: "current conversation"
source_clarity: "none"
created_at: "2026-07-10"
updated_at: "2026-07-10"
---

# PRD: agents 네임스페이스 전환 + remember 스킬

## 1. Summary

이 PRD는 하네스의 두 단계 변경을 계약한다.
1단계는 대상 프로젝트의 하네스 네임스페이스를 `.hoyeon`에서 보이는 단일 폴더 `agents/`로 전환한다 (`agents/prd/**`, `agents/implement/**`, `agents/config.json`).
2단계는 에이전트가 배운 것을 문서가 아닌 강제 장치로 착지시키는 rules 엔진(`agents/rules/**` + CLI 서브커맨드)과 remember 스킬을 새 구조 위에 구현하고, pantry 초기 설정이 AGENTS.md에 이 구조를 시드하게 한다.

Approval checklist:

- 구조 확정: `agents/{prd,implement,rules}` 단일 네임스페이스, gitignore는 `agents/implement/` 한 줄 (3장, R1, R3)
- 설정 위치: `.hoyeon/config.json` → `agents/config.json` 이사 (4.2장 D2)
- 레거시 호환: 기존 `.hoyeon` run과 PRD는 읽기 fallback으로 계속 동작, 일괄 마이그레이션 도구는 비범위 (3장, R2)
- remember 모델: fact / invariant / regression 3착지점 + 원장(INDEX.md) 분리, 검사 불가능한 규칙은 등록 거부 (R6-R8, R12)
- 강제 배선: deliver fail-closed 게이트 + doctor 위생 검사 + fulfill plan 자동 주입, 새 훅은 추가하지 않음 (R9-R11)
- AGENTS.md 규약: AGENTS.md 메인 + CLAUDE.md는 항상 symlink, doctor가 검사, pantry 셋업이 구조 섹션 시드 (R10, R12, R15)
- 검증 모드: automated behavior 필수 + 설치본 CLI smoke 필수 (9장)
- delivery mode: local (이 repo main 직커밋, PR 자동화 없음) (4.2장 D3)

## 2. Problem, Goal, And Users

유저는 이호연 단독이며, 이 하네스는 Codex와 Claude Code 두 런타임에서 개인 엔지니어링 파이프라인으로 쓰인다.

문제 1: 에이전트가 같은 실수를 반복한다.
교훈이 남더라도 문서 한 줄로만 남아 아무도 다시 읽지 않고 썩으며, 다음 PRD나 구현에 기계적으로 반영되지 않는다.

문제 2: `.hoyeon` dot-네임스페이스가 커밋 자산(PRD)과 휘발성 런타임 상태를 한 트리에 섞어서, "prd는 추적하고 implement는 무시하는" 예외적 gitignore 정책을 doctor가 강제해야 한다.
dot-폴더라 사람이 PR에서 리뷰하지도 않는다.

목표: 보이는 단일 네임스페이스(`agents/`)로 정책을 한 줄로 줄이고, 배운 것이 검사 규칙 / 테스트 / 자동 주입된 verification 항목으로 착지해서 "학습 = 강제 장치 생성"이 성립하는 루프를 만든다.

## 3. Scope And Non-Goals

포함 (Scope):

- 대상 프로젝트 파일시스템 계약을 `agents/` 네임스페이스로 전환하고 레거시 `.hoyeon` 읽기 fallback을 유지한다.
- rules 엔진: invariant 파일 형식, 원장, CLI 서브커맨드(`rules add|check|relevant`), deliver 게이트, doctor 위생 검사, fulfill plan 주입.
- remember 스킬 신설: 분류(fact/invariant/regression), 라우팅(project/user/harness), 착지 절차, 양 런타임 설치.
- SKILL.md 6종, README, 테스트, golden, installer 갱신.

비범위 (Non-Goals):

- 기존 프로젝트들의 `.hoyeon` 트리를 일괄 이동시키는 마이그레이션 도구 (fallback 읽기로 충분, 후속 후보).
- 매 툴콜마다 invariant를 실시간 검사하는 PreToolUse 류 신규 훅 (검토 후 기각: 비용과 소음 대비 이득 없음, pre-push가 올바른 초크포인트).
- harness 결함으로 분류된 교훈의 자동 적용 (remember는 이 repo SKILL.md 수정 제안 diff까지만 만들고, 적용은 사람 확인).
- butler 스킬 이름 세트 변경, npm 런타임 의존성 추가.
- 이 run 자체의 산출물 위치 변경 (이 run은 현행 `.hoyeon` 경로로 시작하며, 새 구조는 이후 run부터 적용).

## 4. Pre-Work And Required Decisions

### 4.1 Pre-Work Before Implementation

None required.
모든 작업이 로컬 코드/문서/테스트이며 자격증명, 계정, 결제, 외부 권한이 필요 없다.

### 4.2 Human Decisions Before PRD Approval

- D1. `agents/{prd,implement,rules}` 구조와 `agents/implement/` 단일 gitignore 정책 승인. 대화에서 유저가 직접 제안하고 합의됨, 최종 재확인.
- D2. pantry 설정 파일을 `agents/config.json`으로 이사하는 것 승인. 에이전트 제안, 미확정.
- D3. delivery mode `local` 승인: 이 repo main에 직커밋, PR 자동화 없음. 기존 작업 방식과 동일.
- D4. 한 PRD로 두 단계(구조 전환 → rules/remember)를 순차 진행하는 스코프 승인.

### 4.3 Decision Traceability For Fidelity Review

수용된 결정:

- 스킬 이름은 `remember` (유저: "remember로 가자"). → R12
- 교훈은 3착지점으로만 착지: fact→docs+AGENTS.md 인덱스, invariant→기계 검사 규칙, regression→프로젝트 네이티브 테스트 (에이전트 제안, 유저 합의). → R6, R12
- 원장(INDEX.md)과 본문 분리: 원장은 메타데이터+증거 링크만, 본문은 착지점에 (에이전트 제안, 유저 합의). → R8
- AGENTS.md가 메인이고 CLAUDE.md는 항상 symlink (유저 제안). → R10, R12
- `agents/` 단일 네임스페이스에 prd/ implement/ 둘 다 포함, gitignore는 `agents/implement/`만 (유저 제안: "agents 안에 prd/ implement/ 2개를 넣게 하자"). → R1, R3
- `.hoyeon` 폐지, 레거시는 읽기 fallback (유저: ".hoyeon도 없어도 될듯"). → R2
- 강제는 새 훅이 아니라 코드 체크포인트 3곳: rules CLI, deliver 게이트, doctor (에이전트 제안, 유저가 "hook이나 코드 레벨에서 조이는게 나으려나" 질문 후 합의). → R7, R9, R10
- 규칙 참조는 모델 성실함이 아니라 기계 주입: promise 단계 best-effort 인용 + fulfill plan 시점 자동 주입 (유저 질문 "PRD 세울때 rule 참조가 자연스럽게 되려나"에 대한 설계). → R11
- 검사 불가능한 다짐은 invariant 등록 거부, 증거 링크 필수, 중복 검사 (쓰레기 축적 방지 게이트). → R6, R7
- receipt 직후 deviations 스캔으로 remember 자동 제안. → R13
- pantry 초기 설정이 AGENTS.md에 하네스 구조 섹션을 시드 (유저 추가 요청: "처음 설정할때 config 물어보는 거 뿐만 아니라 AGENTS.md에 기본적인 이 구조에 대해서도 적게"). → R15, AC9

기각된 대안:

- 규칙을 `.hoyeon/rules/`에 두기: 도구 네임스페이스에 프로젝트 지식을 가두고 리뷰 가시성이 없어 기각.
- 규칙을 `docs/rules/`에 두기: docs는 사람용으로 분리하자는 유저 방향에 따라 `agents/rules/`로 확정.
- 런타임 상태를 dot-폴더(.hoyeon)에 유지하는 A안: 유저의 단일 네임스페이스 안이 gitignore 동등 + 설명 단순 + 도구 브랜딩 제거로 우세하여 기각.
- 매 툴콜 실시간 invariant 검사 훅: 기각 (위 비범위).

유보된 결정:

- 기존 프로젝트 일괄 마이그레이션 도구: 후속 후보로 유보. → 비범위
- promise 단계의 `rules relevant` 토픽 매칭 정밀도 개선: 이번엔 best-effort로 시작. → R11

## 5. Major Technical Structure Changes

- 대상 프로젝트 파일시스템 계약 변경: 하네스의 공개 인터페이스인 산출물 경로가 `.hoyeon/**`에서 `agents/**`로 바뀐다. 레거시 경로는 읽기 fallback으로 인식된다.
- 하네스 CLI(`prd_state_harness.js`)에 rules 서브커맨드군이 추가되고, rules 로직은 `scripts/lib/` 레이어 규칙(비순환)을 따르는 신규 모듈로 들어간다.
- deliver 파이프라인(`prd_ship.js`)에 push 전 rules 게이트 단계가 추가된다 (기존 allowlist 게이트와 동일한 fail-closed + `--reason` override 패턴).
- 신규 스킬 remember가 추가되고 installer 설치 목록에 등록된다.
- 신규 API, DB, 인프라, 외부 서비스 경계 변화는 없다.

## 6. Requirements

1단계 (구조 전환):

- R1. 대상 프로젝트의 기본 산출물 경로가 `agents/`가 된다: PRD는 `agents/prd/<slug>/prd.md`, 런타임 상태는 `agents/implement/<slug>/**`, 활성 포인터는 `agents/implement/` 아래, pantry 설정은 `agents/config.json`. 경로 루트는 pantry 설정으로 오버라이드 가능하다.
- R2. 레거시 fallback: 새 경로에 대상이 없으면 `.hoyeon/prd/**`, `.hoyeon/implement/**`, `.hoyeon/config.json`을 읽어 기존 활성 run(status/mark/review/receipt)과 기존 PRD 참조가 깨지지 않는다. 새 run의 쓰기는 항상 새 경로다.
- R3. gitignore 정책 전환: doctor가 `agents/implement/` ignore 라인을 강제하고, 레거시 `.hoyeon` 트리가 존재하면 마이그레이션 안내를 리포트한다.
- R4. 코드 전반에 흩어진 `.hoyeon` 경로 리터럴(`prd_ship.js`의 중복 상수와 staging allowlist 포함)을 공용 상수로 중앙화한 뒤 플립한다.
- R5. SKILL.md 6종(listen/promise/fulfill/deliver/pantry/please), README, 테스트, golden의 경로 서술을 새 구조로 갱신하고, 잔여 `.hoyeon` 참조는 레거시 호환 서술만 남긴다.

2단계 (rules 엔진 + remember):

- R6. invariant 규칙 파일 형식을 정의한다: `agents/rules/invariants/<id>.md`, frontmatter에 `id`, `status`, `evidence`(필수, 비어 있으면 거부), `trigger.paths`(glob 목록), `check`(`type: command|grep|manual` + 실행 정의), 본문은 한 문단 설명. `trigger` 또는 실행 가능한 `check`가 없는 규칙은 invariant로 등록할 수 없다.
- R7. 하네스 CLI에 rules 서브커맨드를 추가한다: `rules add`(형식 검증 + 기존 규칙 중복 검사 + 원장 갱신), `rules check`(git 변경 파일과 trigger 매칭 → check 실행 → 구조화 결과와 비정상 종료코드), `rules relevant`(경로/키워드로 관련 규칙 조회). 원장과 규칙 파일은 이 커맨드를 통해서만 갱신되는 것을 규약으로 한다.
- R8. 원장 `agents/rules/INDEX.md`는 id, kind(fact/invariant/regression), 착지점 경로, 증거 링크, 상태를 한 줄씩 기록하고, 미착지 교훈은 `agents/rules/pending/<id>.md`에 남는다.
- R9. deliver가 push 전에 `rules check`를 실행한다: FAIL은 fail-closed로 배송을 중단하고 `--reason` override는 ship log에 기록되며, `pending/`이 비어 있지 않으면 WARN을 출력한다.
- R10. doctor 위생 검사를 확장한다: CLAUDE.md가 AGENTS.md를 가리키는 symlink인지, `agents/implement/` gitignore 라인이 있는지, 원장의 착지점 경로와 규칙 trigger 대상이 실존하는지(부패 검사), `agents/`가 하네스 구조가 아닌 기존 폴더와 충돌하는지 검사하고 각각 교정 안내를 낸다.
- R11. fulfill이 plan 시점에 invariant trigger와 execution write scope를 보수적으로(경로 접두 기준) 매칭해서 걸리는 규칙을 verification 항목으로 자동 주입한다. 매칭의 정확한 강제는 changed-file 기준인 deliver 게이트(R9)가 담당하며, plan 주입은 best-effort임을 산출물에 명시한다.
- R12. remember 스킬을 신설한다: 교훈을 fact/invariant/regression으로 분류하고 project/user/harness로 라우팅한다. fact는 docs 본문 + AGENTS.md 인덱스 한 줄(인덱스 총량 상한 명시)로, invariant는 `rules add`로, regression은 프로젝트 네이티브 테스트 작성 또는 `pending/` 등록으로 착지한다. user 교훈은 유저 공용 참조 파일에 확인 후 기록하고, harness 교훈은 이 repo 수정 제안으로 라우팅한다. CLAUDE.md가 실파일이면 AGENTS.md로 병합 후 symlink 교체를 제안하되 diff 확인을 받는다.
- R13. fulfill receipt 생성 직후 deviations를 스캔해서 remember 후보(반복 유형, 리뷰 fail 사유)를 receipt 출력에 제안으로 포함한다.
- R14. installer가 remember 스킬을 양 런타임에 설치하고 기존 스킬 갱신과 함께 idempotent하게 동작한다.
- R15. pantry 초기 설정이 config 질문과 함께 대상 프로젝트의 AGENTS.md에 하네스 구조 섹션을 시드한다: `agents/` 네임스페이스 설명(prd/implement/rules의 역할과 커밋 정책), `agents/rules/` 참조 방법, CLAUDE.md symlink 규약. AGENTS.md가 없으면 생성 후 CLAUDE.md symlink를 만들고, 이미 있으면 marker 기반으로 섹션만 추가/갱신해서 재실행해도 중복되지 않는다(idempotent).

## 7. Acceptance Criteria

- AC1. 새 프로젝트에서 init하면 state.json, 활성 포인터, run 산출물이 `agents/implement/<slug>/` 아래에 생성되고 `agents/prd/` 경로의 PRD를 읽는다.
- AC2. 레거시 `.hoyeon` 경로만 있는 기존 run에 대해 status/mark/review/receipt가 회귀 없이 동작한다 (fallback 전용 테스트로 증명).
- AC3. doctor가 새 정책을 리포트한다: `agents/implement/` gitignore 검사, CLAUDE.md symlink 검사, 레거시 `.hoyeon` 감지 안내, 원장 부패 검사.
- AC4. `rules add`가 증거 없는 규칙과 검사 불가능한 규칙을 거부하고, 유효한 invariant는 파일 생성 + INDEX.md 원장 등록까지 원자적으로 수행한다.
- AC5. trigger에 걸리는 파일이 변경된 상태에서 check가 실패하면 `rules check`가 비정상 종료코드를 내고, deliver가 이를 fail-closed로 반영하며 `--reason` override가 ship log에 남는다.
- AC6. write scope가 invariant trigger에 걸리는 PRD로 plan을 만들면 해당 규칙이 verification 항목으로 자동 주입된다.
- AC7. 설치 후 양 런타임 설치 경로의 심링크 경유 실행으로 doctor가 정상 동작하고, remember SKILL.md가 양쪽 설치 루트에 존재한다.
- AC8. 전체 테스트 스위트(기존 + 신규 rules/fallback 테스트)가 green이고 golden이 새 경로 기준으로 결정적으로 재생성된다.
- AC9. pantry 셋업을 실행하면 AGENTS.md에 하네스 구조 섹션이 생기고(없으면 파일 생성 + CLAUDE.md symlink), 같은 셋업을 재실행해도 섹션이 중복되지 않는다.

## 8. PRD-Level Tasks

- T1. 경로 리터럴 중앙화: 흩어진 `.hoyeon` 리터럴을 공용 상수로 모으는 무동작 리팩토링, 기존 테스트 green 확인. Covers R4.
- T2. 네임스페이스 플립: 상수를 `agents/` 기준으로 전환하고 레거시 읽기 fallback과 `agents/config.json` 이사를 구현. Covers R1, R2.
- T3. 정책 전환: doctor gitignore/레거시 감지 갱신, deliver staging allowlist와 내부 경로 갱신. Covers R3, R4.
- T4. 문서/테스트 동기화: SKILL.md 6종, README, 테스트, golden을 새 구조로 갱신하고 잔여 `.hoyeon` 참조를 grep으로 검증. Covers R5.
- T5. rules 엔진: invariant 형식 파서/검증기, 원장 관리, `rules add|check|relevant` 서브커맨드와 단위 테스트. Covers R6, R7, R8.
- T6. 강제 배선 1: deliver rules 게이트(fail-closed + override 로그 + pending WARN)와 doctor 확장(symlink/부패/충돌 검사). Covers R9, R10.
- T7. 강제 배선 2: fulfill plan 주입(보수적 매칭 + best-effort 명시)과 receipt 직후 deviations 기반 remember 제안. Covers R11, R13.
- T8. remember 스킬: SKILL.md 작성(분류/라우팅/착지/병합 절차), installer 등록, 양 런타임 설치 검증. Covers R12, R14.
- T9. pantry 셋업 시드: 초기 설정 흐름에 AGENTS.md 구조 섹션 시드(생성/marker 갱신/symlink)를 추가하고 idempotent 동작을 테스트로 증명. Covers R15.
- T10. 검증 마감: 신규 시나리오 회귀 테스트 정리, golden 재생성, README의 새 구조/커맨드 문서화. 순수 검증과 릴리스 위생.

## 9. Verification Contract

### 9.1 Test Mode Contract

| Mode | Required For Done | Covers | Human Decision |
| --- | --- | --- | --- |
| build/static | yes | 데이터 레이어 JSDoc 타입 무결성 | none |
| automated behavior | yes | 경로 전환/fallback/rules 엔진/게이트의 핵심 동작과 회귀 | none |
| browser/runtime | yes | 설치본 심링크 경유 CLI 런타임 smoke (브라우저 아님, 터미널 CLI 실행) | none |

### 9.2 Required Agent Verification

| ID | Mode | Covers | Method | Artifact | Pass Criteria | Environment | Required For Done | Can Be Blocked | Safe Probe | Side Effect | Sensitive Data Policy |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| V1 | build/static | R4, R6, R7 | `npx -p typescript tsc --noEmit --allowJs --target es2022 --module commonjs --skipLibCheck skills/fulfill/scripts/lib/state_data.js skills/fulfill/scripts/lib/types.js` 및 신규 rules 모듈 포함 | command-log | exits 0 | local shell | yes | no | none (로컬 전용) | none | 비밀값 없음 |
| V2 | automated behavior | R1, R2, R3, R5, R15, AC1, AC2, AC3, AC8, AC9 | `node --test tests/*.test.mjs` (신규 fallback/경로 전환 테스트 포함, golden은 `UPDATE_GOLDEN=1` 재생성 후 재실행으로 결정성 확인) | command-log | 전체 테스트 pass, 재실행 시 golden diff 없음 | local shell | yes | no | none (로컬 전용) | 임시 fixture 디렉터리 생성/삭제만 | 비밀값 없음 |
| V3 | automated behavior | R6, R7, R8, R9, R11, R13, AC4, AC5, AC6 | `node --test tests/*.test.mjs` 중 rules 엔진 단위 테스트와 게이트/주입 시나리오 테스트 (임시 git repo fixture에서 add 거부, check 실패 종료코드, deliver fail-closed, plan 주입을 각각 검증) | command-log | 해당 시나리오 테스트 전부 pass | local shell | yes | no | none (외부 API 아님, 임시 로컬 git fixture만 사용) | 임시 fixture 디렉터리 생성/삭제만 | 비밀값 없음 |
| V4 | browser/runtime | R1, R10, R12, R14, AC3, AC7 | 설치 후 `node ~/.claude/skills/fulfill/scripts/prd_state_harness.js doctor`와 `node ~/.codex/skills/fulfill/scripts/prd_state_harness.js doctor`를 실행하고 양쪽 설치 루트에 remember SKILL.md 존재를 확인 | command-log | 양 런타임 doctor 정상 출력(신규 검사 항목 포함), remember 설치 확인 | local shell (터미널 CLI, 브라우저 불필요) | yes | no | none (로컬 전용) | 설치 스크립트의 심링크 갱신만 | 비밀값 없음 |

자동 검증 행이 보호하는 회귀 위험: V2는 "경로 전환이 기존 run과 golden 계약을 조용히 깨뜨리는" 위험, V3는 "rules 게이트가 산문으로만 존재하고 실제로는 아무것도 차단하지 못하는" 위험, V1은 "state 스키마 필드 오타가 런타임에야 드러나는" 위험을 각각 막는다.

### 9.3 Human Verification

None required.
단독 유저 도구이고 UI/카피/외부 계정 판단이 없으며, 구조 취향 판단은 본 PRD의 Approval checklist 승인으로 완결된다.

## 10. Risks And Open Decisions

- trigger glob과 write scope의 glob-대-glob 매칭은 정확 해가 없다. plan 주입은 보수적 접두 매칭 best-effort로 한정하고(산출물에 명시), 정확한 강제는 changed-file 기준 deliver 게이트가 담당한다 (R11 설계로 완화).
- 레거시 fallback 누락 시 기존 프로젝트의 활성 run이 깨진다. AC2 전용 테스트를 필수로 하고, fallback은 읽기 전용으로 한정해 쓰기 경로 분기를 없앤다.
- `agents/` 폴더가 대상 프로젝트의 실제 코드 디렉터리와 충돌할 수 있다. doctor 충돌 감지(R10) + pantry 경로 오버라이드(R1)로 방어한다.
- SKILL.md 6종에 걸친 87곳의 경로 서술 갱신에서 누락이 생길 수 있다. T4에 grep 기반 잔여 참조 검증을 포함한다.
- 이 run 자체는 레거시 경로로 시작하므로, 전환 직후 이 repo에 `.hoyeon`(이 run)과 `agents/`(신규 테스트 fixture)가 공존한다. doctor의 레거시 안내가 이 상태를 오탐하지 않도록 안내 문구를 정보성(WARN 아님)으로 한다.

Open decisions: 없음 (D1-D4는 승인 대기이며 blocking, 그 외 유보 항목은 4.3에 기록).

## 11. Implementation Guardrails

- 승인된 스코프를 확장하지 않는다: butler 스킬 이름 세트, 훅 등록 구조, state.v1 스키마의 기존 필드 의미를 바꾸지 않는다.
- npm 런타임 의존성을 추가하지 않는다 (repo 원칙: 표준 Node만).
- `scripts/lib/` 레이어 순서(비순환)를 유지하고, 신규 rules 모듈도 레이어 규칙을 따른다.
- 기존 활성 run과 유저의 다른 프로젝트 `.hoyeon` 데이터를 이동/삭제하지 않는다 (읽기 fallback만).
- 유저 레벨 파일(~/.claude, ~/.codex 공용 참조) 쓰기는 remember 실행 중에도 반드시 확인을 받는다.
- 커밋/브랜치/PR 텍스트에 에이전트/모델/도구 이름과 attribution을 넣지 않는다.
- 승인 없이 새 외부 서비스, 스키마, 백그라운드 잡, 네트워크 호출을 도입하지 않는다.

## 12. Implementation Result Report Contract

구현 에이전트는 다음을 보고한다:

- status: `Done` / `Partially Done` / `Blocked`.
- 유저 가시 변화: 새 폴더 구조, 새 CLI 서브커맨드, 신규 스킬, doctor 신규 검사 항목.
- 주요 변경 모듈: 경로 상수, `prd_ship.js` 게이트, rules 신규 모듈, installer, SKILL.md 6+1종.
- 승인된 기술 구조(5장) 준수 여부와 이탈 시 사유.
- T1-T10 완료 상태와 R/AC/V 커버리지 매핑.
- 모드별 검증 증거: V1-V4 command-log 경로.
- 추가/갱신된 자동 테스트 목록과 각각이 보호하는 회귀 위험.
- deviations 전체와 그 사유.
- 남은 사람 검토 항목과 후속 후보 (일괄 마이그레이션 도구, `rules relevant` 정밀도 개선 포함).
- delivery: local 커밋 해시 목록 (PR 없음).
