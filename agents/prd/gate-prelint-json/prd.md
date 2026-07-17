---
topic: "gate-prelint-json: 판사 호출 전 0원 기계식 문서 lint + --json 출력 완성"
status: "ready"
human_approval: "approved"
review_profile: "standard"
review_rationale: "게이트 차단 동작(런타임 계약)을 바꾸는 CLI 변경이지만 외부 서비스/데이터/자격증명 접점이 없고 전 규칙이 픽스처 테스트로 검증된다."
source_intake: "agents/intake/gate-prelint-json/qa-log.md"
source_clarity: "none"
created_at: "2026-07-17"
updated_at: "2026-07-17"
---

# PRD: gate-prelint-json

## 1. Summary

checkshirt의 세 게이트(gap-audit, spec, verify) 입구에 판사 호출 전 결정적 문서 prelint를 추가하고, 이미 부분 구현돼 있던 `--json` 출력을 전 명령으로 완성한다.
prelint는 구조 결함(누락 섹션, dangling ID 참조, 잘못된 enum, 미커버 AC 등)을 0원/0초에 줄 번호와 함께 차단해 판사 토큰을 의미 판단에만 쓰게 하고, `--json`은 스킬이 게이트 결과를 텍스트 스크래핑 없이 기계적으로 소비하게 한다.
verify 게이트의 mechanical-first 원리("기계가 거를 수 있는 건 판사에게 안 보낸다")를 문서 게이트 전체로 확장하는 작업이다.

Approval checklist:

- prelint 실패는 하드블록(exit 1) + 판사 미호출(토큰 0) + 재시도 예산 미소모다 (섹션 6 R1).
- 규칙 세트는 거짓 양성 0 목표의 확정 목록이며 ID 연속성 검사는 non-goal이다 (섹션 3, 6 R2-R3).
- verify 게이트 입구에도 같은 PRD prelint가 걸린다: prelint → 기계 검사 → 판사 순 (섹션 6 R4).
- 게이트 입구 lint의 단일 소유자는 checkshirt가 되고, interview-me 스킬 문서에서 validate_intake.mjs 단계가 제거된다 (섹션 6 R7).
- `--json`은 doctor/override까지 전 명령 완성 + contractVersion 필드 + prelint 결과는 별도 `prelint` 키 (섹션 6 R5-R6).
- delivery mode: local (main 직푸시, 기존 사이클과 동일).

## 2. Problem, Goal, And Users

문제: 지금은 구조적으로 깨진 문서(존재하지 않는 D#를 참조하는 qa-log, 어떤 V에도 안 걸린 AC를 가진 PRD)도 그대로 판사에게 가서, 판사가 토큰과 수십 초를 써가며 기계적으로 잡을 수 있는 결함을 지적한다.
그만큼 판사 findings의 의미 판단 밀도가 떨어지고, 게이트 왕복이 느려지고, 재시도 예산이 구조 결함 수정에 낭비된다.
또한 스킬이 게이트 결과를 텍스트 출력에서 읽고 있어 출력 문구가 바뀌면 소비가 깨질 수 있다.

목표: 기계가 거를 수 있는 결함은 판사 호출 전에 0원으로 전부 거르고, 게이트 결과는 구조화된 JSON으로 소비 가능하게 한다.
사용자의 상위 가치는 "단순하면서도 빠르고 정확하게 검증을 강제하는 것"이다.

사용자: checkshirt를 호출하는 스킬 에이전트(interview-me, gen-prd, implement)와 그 결과를 읽는 이호연.

## 3. Scope And Non-Goals

포함:

- qa-log prelint (gap-audit 입구): 필수 섹션, Decision Register 파싱과 필수 컬럼, dangling decision_ids, frontmatter enum, P0/P1 open 차단.
- PRD prelint (spec 입구와 verify 입구 공용): 필수 섹션 1~12, frontmatter enum, dangling Covers 참조, 미커버 AC, 9.2 Mode와 9.1 Test Mode Contract 정합.
- prelint 실패 의미론: 하드블록 + 판사 미호출 + 예산 미소모, 모든 실행 오류(I/O, 예외 포함) 균일 fail-closed.
- `--json` 완성: doctor와 gate override 추가(전 명령 커버), USAGE와 README 문서화, 최상위 contractVersion 필드, prelint 결과는 별도 최상위 `prelint` 키.
- 스킬 문서 갱신: interview-me에서 validate_intake.mjs 단계 제거(게이트가 prelint 내장), 게이트 결과의 --json 소비 안내 (interview-me, implement).
- 규칙별 픽스처 검증: 규칙당 최소 결함 문서 1개 + 정상 문서로 true positive와 false positive 0을 유닛 테스트로 단언.

Non-goals:

- ID 연속성 검사(R1, R2, R4처럼 번호가 빈 경우): 의도적 삭제를 오판할 수 있어 명시적으로 제외한다. 사용자 결과: 번호 구멍은 통과. 재검토 조건: 실사용에서 번호 구멍이 실제 결함의 신호로 반복 관찰될 때.
- 판사 프롬프트나 fan-out 레인 변경: prelint는 판사 앞단에만 추가되고 판사 경로는 손대지 않는다.
- validate_intake.mjs 스크립트 파일 삭제: 스킬 저장소에 보존하되 interview-me 스킬 문서에서 참조만 제거한다(무참조화). 코드 복사 없이 규칙 의미론만 checkshirt TypeScript로 신규 구현한다.
- plan-verification(prd_state_harness) 변경: 별개 목적(실행 계획 파생)으로 유지. 중복 규칙의 기준은 checkshirt다.
- exit code 계약 변경: 0=pass, 1=block/fail, 2=usage 오류는 불변.
- 스칼라 점수 도입: findings 목록 형식 유지 (기존 원칙).

## 4. Pre-Work And Required Decisions

### 4.1 Pre-Work Before Implementation

None required. 전부 로컬 저장소와 이미 설치된 도구로 수행 가능하며 자격증명이나 사용자 소유 자원이 필요 없다.

### 4.2 Human Decisions Before PRD Approval

None beyond scope approval. 다섯 개 material 결정(실패 의미론, 규칙 소유권, 규칙 세트, --json 범위, verify 입구 적용)이 인터뷰 Q1~Q5에서 이미 확정됐다.

### 4.3 Decision Traceability For Fidelity Review

- D-01 (fact): `--json`은 이미 gate gap-audit/spec/verify/status에 구현돼 있었고 doctor/override 부재 + 미문서화 상태였다 (`cli/src/cli.ts:127`). 이 발견이 후보 2의 범위를 "완성+문서화"로 재정의했다. → R5, 컨텍스트 사실.
- D-02 (user, Q1): prelint 실패 = 하드블록(exit 1) + 판사 미호출(토큰 0) + 재시도 예산 미소모. 0원 검사라 무한 재수정 무해. 기각된 대안: "예산 소모" 및 "경고만 하고 판사 진행". → R1, AC1, AC2.
- D-03 (user, Q2): 게이트 입구 lint는 checkshirt 단일 소유. interview-me 스킬 문서에서 validate_intake.mjs 단계 제거, gap-audit 게이트 호출만 유지. plan-verification은 별개 목적으로 유지하되 중복 규칙은 checkshirt 기준. 기각된 대안: "공존+역할 분담", "독립 lint 서브커맨드 노출". → R7, T5, non-goal.
- D-04 (user, Q3, preview 전문 수락): 규칙 세트 확정 - qa-log(필수 섹션/Register 파싱/dangling decision_ids/frontmatter enum/P0-P1 open 차단), PRD(필수 섹션/frontmatter enum/dangling Covers/미커버 AC/Mode 정합), 파싱 불가=fail-closed, ID 연속성 검사 제외. 기각된 대안: "최소 세트만", "더 엄격하게(P2 포함 차단, UX 카드 필드 검사)". → R2, R3, non-goal.
- D-05 (user, Q4): --json 완전 완성 - doctor/override 추가, USAGE+README 문서화, contractVersion 필드, 스킬의 --json 소비 갱신, prelint findings 포함. exit code 계약 불변. 기각된 대안: "CLI만 완성", "문서화만". → R5, R6, T3, T5.
- D-06 (user, Q5): verify 게이트 입구에도 동일 PRD prelint 적용. 순서: prelint(0원, 실패 시 즉시 exit 1) → 기계 검사 → 판사. 기각된 대안: "gap-audit/spec만". → R4, AC4.
- D-07 (assumption, agent): prelint 출력 포맷 - 통과 시 `[prelint] ok` 한 줄, 실패 시 `[prelint]` 라벨 + 규칙 ID + 줄 번호로 판사 findings와 시각적 구분. 저위험/가역, 사용자 이의 시 즉시 변경. → R8.
- D-08 (agent, gap-audit finding 해소): 규칙별 실행 가능 명세(정확한 헤더 문자열, enum 허용값, dangling 판정 알고리즘, 범위 확장)는 qa-log "Prelint 실행 명세" 절이 원본. → R2, R3 세부.
- D-09 (agent, Q2 구체화): validate_intake.mjs는 규칙 의미론만 TypeScript로 신규 구현(코드 복사 없음), 스크립트 파일 보존 + 스킬 문서 무참조화. → T1, T5, non-goal.
- D-10 (agent default, 가역): JSON에서 prelint 결과는 judge findings와 병합하지 않고 별도 최상위 키 `prelint: {ok, findings[]}`, contractVersion은 최상위 필드. → R6, AC6.
- D-11 (agent): prelint 자체의 모든 실행 오류(I/O, 예외)도 균일 fail-closed(exit 1 + 판사 미호출 + 원인 출력). → R1, AC7.
- D-12 (agent, gap-audit finding 해소): 규칙별 픽스처 검증 - 규칙당 최소 결함 문서 1개 + 정상 문서, 기존 `node --test` 스위트 편입. → V2, T4.
- 게이트 감사 이력: gap-audit 1차 BLOCK(P1 3건: 실행 명세 부재, 이식 방식 불명, 규칙별 검증 부재) → D-08~D-12로 해소 → 재심 PASS. STALE 재심 1회 포함 최종 PASS.

## 5. Major Technical Structure Changes

- 게이트 실행 파이프라인에 새 단계 추가: 세 게이트 모두 `prelint(결정적, 0원) → [verify만: 기계 검사] → 판사` 순서가 된다. prelint 실패 시 이후 단계는 실행되지 않는다.
- 게이트 결과 스키마 확장: GateCommandResult에 최상위 `prelint` 키와 `contractVersion` 필드 추가 (기존 필드는 불변, 추가만 있는 비파괴 확장).
- 새 모듈 1개: 문서 prelint 규칙 엔진 (cli/src 내, 판사 백엔드와 독립적인 순수 함수 집합).
- 외부 서비스, DB, 스키마 마이그레이션, 인프라 변경 없음.

## 6. Requirements

- R1. prelint 실패는 게이트를 하드블록한다: exit 1, 판사 호출 0회(judge call 기록 증가 없음), 재시도 예산 미소모(attempts 카운트 불변). prelint 실행 중 발생하는 모든 오류(문서 파싱 불가, 파일 I/O 오류, 예기치 못한 예외)도 동일하게 fail-closed로 처리하고 원인을 출력한다.
- R2. qa-log prelint는 gap-audit 게이트 입구에서 다음 규칙을 검사한다: (a) 필수 섹션 `## Current Understanding`, `## Decision Register`, `## Raw Q&A`, `## Audit History` 존재, (b) frontmatter `status` ∈ {active, paused, complete} 및 `where` ∈ {greenfield, brownfield, docs-only, unknown}, (c) Decision Register 헤더가 8개 필수 컬럼(ID, Kind, Area, Decision / fact, Priority, Source / owner, Status, PRD mapping / revisit)을 포함하고 행 값이 Kind ∈ {fact, decision, assumption}, Priority ∈ {P0, P1, P2}, Status ∈ {open, resolved, deferred, blocking, rejected}를 만족, (d) Raw Q&A의 `decision_ids:` 토큰(`D-\d+` 형식, `none` 허용)이 전부 Register ID 열에 존재, (e) Priority P0/P1이면서 Status open인 행이 없음.
- R3. PRD prelint는 spec 게이트와 verify 게이트 입구에서 다음 규칙을 검사한다: (a) `## 1.` ~ `## 12.` 번호 헤더 12개 전부 존재(제목 문구 불문), (b) frontmatter `status` ∈ {draft, ready}, `human_approval` ∈ {pending, approved}, `review_profile` ∈ {trivial, standard, high-risk}, (c) 본문에서 정의된 R#/AC#/T#/V# ID를 수집하고 Covers 참조(같은 접두사 범위 표기 `R1-R4` 확장 포함)가 전부 정의된 ID를 가리킴, (d) 정의된 모든 AC#가 최소 1개 V 행의 Covers에 나타남, (e) 9.2 각 행의 Mode 값이 9.1 Test Mode Contract의 Mode 셀 중 하나와 일치(trim 후 문자열 비교).
- R4. verify 게이트의 실행 순서는 PRD prelint → 기계 검사(테스트/린트) → 판사이며, prelint 실패 시 기계 검사도 실행하지 않는다.
- R5. `--json` 플래그가 전 명령(gate gap-audit/spec/status/override, verify, doctor)에서 동작하고 USAGE 문자열과 README에 문서화된다.
- R6. 모든 `--json` 출력은 최상위 `contractVersion` 필드를 포함하고, prelint 결과는 judge findings와 병합되지 않은 별도 최상위 `prelint: {ok, findings[]}` 키로 출력된다. 기존 JSON 필드는 제거·개명하지 않는다(추가만 허용). exit code 계약(0/1/2)은 텍스트/JSON 모드에서 동일하다.
- R7. interview-me 스킬 문서에서 validate_intake.mjs 실행 단계가 제거되고 gap-audit 게이트 호출이 유일한 기계+판사 폐회 검사가 된다. interview-me와 implement 스킬 문서에 게이트 결과의 `--json` 소비 안내가 추가된다. validate_intake.mjs 파일 자체는 보존한다.
- R8. prelint의 텍스트 출력은 통과 시 `[prelint] ok` 한 줄, 실패 시 `[prelint]` 라벨과 규칙 ID, 줄 번호, 문제, 수정 방향을 finding마다 출력해 판사 findings와 시각적으로 구분된다.

## 7. Acceptance Criteria

- AC1. 구조 결함이 있는 qa-log로 `checkshirt gate gap-audit`를 실행하면 exit 1이고, 출력에 `[prelint]` 라벨의 finding(규칙 ID + 줄 번호)이 있으며, 게이트 상태의 judge call 수와 attempts가 실행 전과 같다.
- AC2. prelint 실패를 수정한 뒤 같은 게이트를 재실행하면 prelint를 통과하고 판사 판정으로 진행된다 (attempts는 판사 호출부터 카운트).
- AC3. R2/R3의 각 규칙에 대해 해당 결함만 가진 최소 픽스처 문서가 그 규칙의 finding을 발화시키고, 결함 없는 정상 qa-log/PRD 픽스처는 prelint findings 0건으로 통과한다.
- AC4. spec 게이트를 통과한 PRD에서 Covers가 dangling이 되도록 편집한 뒤 `checkshirt verify`를 실행하면 기계 검사와 판사 호출 없이 exit 1 + `[prelint]` finding이 출력된다.
- AC5. `checkshirt doctor --json`과 `checkshirt gate override --json`이 유효한 JSON을 출력하고, USAGE(`checkshirt help`)와 README에 `--json`이 문서화돼 있다.
- AC6. 전 명령의 `--json` 출력이 최상위 `contractVersion`을 포함하고, prelint가 실행된 게이트 결과에는 최상위 `prelint` 키가 있으며 judge findings 배열에 prelint finding이 섞이지 않는다.
- AC7. prelint에 읽기 불가 파일 경로를 주면 exit 1 + 원인 메시지로 fail-closed되고 판사는 호출되지 않는다.
- AC8. interview-me 스킬 문서에 validate_intake.mjs 실행 단계가 없고, interview-me/implement 스킬 문서에 `--json` 소비 안내가 있다.
- AC9. 기존 게이트 e2e/유닛 테스트 전체와 저장소 테스트 스위트가 여전히 통과한다 (prelint 추가가 정상 문서의 기존 판사 경로를 바꾸지 않음).

## 8. PRD-Level Tasks

- T1. prelint 규칙 엔진 구현: qa-log 규칙(R2)과 PRD 규칙(R3)을 순수 함수로 구현하고 finding에 규칙 ID와 줄 번호를 담는다. Covers R2, R3, AC3.
- T2. 게이트 파이프라인 통합: 세 게이트 입구에 prelint를 연결하고 실패 의미론(하드블록, 판사 미호출, 예산 미소모, 균일 fail-closed)과 verify 순서를 구현한다. Covers R1, R4, AC1, AC2, AC4, AC7.
- T3. 출력 통합: 텍스트 모드 `[prelint]` 라벨 출력(R8)과 JSON 모드 `prelint` 키 + contractVersion(R6), doctor/override `--json` 추가(R5)를 구현하고 USAGE/README를 갱신한다. Covers R5, R6, R8, AC5, AC6.
- T4. 규칙별 픽스처와 테스트: cli/test/fixtures/prelint/에 규칙당 최소 결함 문서와 정상 문서를 만들고, 규칙별 true positive/false positive 0 유닛 테스트와 게이트 통합 e2e 테스트를 기존 `node --test` 스위트에 추가한다. Covers AC1, AC3, AC4, AC7, AC9.
- T5. 스킬 문서 갱신: interview-me에서 validate_intake.mjs 단계 제거, interview-me/implement에 --json 소비 안내 추가. Covers R7, AC8.
- T6. 릴리스 정리: 버전 범프, 전 스위트 green 확인, 설치 갱신. Covers AC9 (release hygiene).

## 9. Verification Contract

### 9.1 Test Mode Contract

| Mode | Required For Done | Covers | Human Decision |
| --- | --- | --- | --- |
| build/static | yes | TypeScript 빌드, 문서 상태 검사 | none |
| automated behavior | yes | prelint 규칙별 발화/무발화, 게이트 파이프라인 의미론, JSON 스키마, 기존 회귀 | none |
| runtime CLI smoke | yes | 설치된 실제 바이너리의 라이브 동작 (결함 문서 차단 + 정상 문서 판사 진행) | none |

### 9.2 Required Agent Verification

| ID | Mode | Covers | Method | Artifact | Pass Criteria | Environment | Required For Done | Can Be Blocked | Safe Probe | Live Proof | Side Effect | Sensitive Data Policy |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| V1 | build/static | R1-R8 | `npm run build` (cli/) | command-log | exit 0 | local shell | yes | no | none | command log | none | no secrets |
| V2 | automated behavior | R2, R3, AC3 | `npm test` (cli/, 규칙별 픽스처 유닛 테스트 포함 - 각 규칙이 자기 결함에서만 발화하고 정상 픽스처는 findings 0, 거짓 양성 회귀 방지) | command-log | exit 0, prelint 규칙 테스트 전부 pass | local shell | yes | no | none | command log | none | no secrets |
| V3 | automated behavior | R1, R4, AC1, AC2, AC4, AC7 | `npm run test:e2e` (cli/, stub 백엔드로 prelint 실패 시 판사 미호출·예산 미소모·하드블록·verify 순서를 단언 - 실패 의미론 회귀 방지) | command-log | exit 0, prelint 파이프라인 e2e 전부 pass | local shell | yes | no | none | command log | none | no secrets |
| V4 | automated behavior | R5, R6, AC5, AC6 | `npm run test:e2e` (cli/, 전 명령 --json 유효성 + contractVersion + 분리된 prelint 키 단언 - 스킬 소비 계약 회귀 방지) | command-log | exit 0, JSON 계약 테스트 전부 pass | local shell | yes | no | none | command log | none | no secrets |
| V5 | automated behavior | AC9 | `npm test && npm run test:e2e` (cli/) 및 저장소 루트 `npm test` - 기존 스위트 전체 green으로 정상 문서의 기존 판사 경로 불변 보증 | command-log | 전 스위트 exit 0 | local shell | yes | no | none | command log | none | no secrets |
| V6 | runtime CLI smoke | AC1, AC2, AC4 | 설치된 `checkshirt` 바이너리로 결함 픽스처 문서 실행 → exit 1 + `[prelint]` finding + judge call 0 확인, 수정 문서로 재실행 → 판사 진행 확인 (stub 또는 라이브 백엔드) | command-log | 차단/진행이 기대와 일치 | local shell | yes | no | none | command log | 게이트 상태 파일이 스크래치 프로젝트에 생성됨 | no secrets |
| V7 | build/static | R7, AC8 | `grep`으로 interview-me 스킬 문서에 validate_intake.mjs 실행 단계 부재와 interview-me/implement 문서의 --json 안내 존재를 검사 | command-log | 부재/존재 검사 통과 | local shell | yes | no | none | command log | none | no secrets |

### 9.3 Human Verification

None required. 출력 포맷(D-07)은 저위험/가역 agent default로 채택됐고, 스코프·구조 승인은 PRD 승인에 포함된다.

## 10. Risks And Open Decisions

- 거짓 양성 위험: 실제 사용 문서의 표기 편차(테이블 공백, 헤더 변형)가 prelint에 걸릴 수 있다. 완화: 규칙은 Q3에서 확정한 명백한 결함만 검사하고, trim 후 비교와 번호 접두 일치 등 관용적 파싱을 쓰며, V2가 정상 문서 픽스처로 false positive 0을 고정한다. 그래도 발생하면 규칙 완화가 아니라 finding 문구로 안내하고 사용자에게 보고한다.
- 레거시 문서 위험: 구형 포맷(.hoyeon 시절) 문서가 게이트에 들어오면 prelint에 걸린다. 이는 의도된 fail-closed다 (게이트는 현행 템플릿 계약을 강제).
- --json 기존 소비자: 현재 --json을 쓰는 외부 소비자는 확인되지 않았고, 변경은 필드 추가뿐이라 비파괴다.
- Open decisions: 없음. ID 연속성 검사 재도입은 non-goal의 재검토 조건(실사용 신호 반복 관찰)으로만 남는다.

## 11. Implementation Guardrails

- 판사 프롬프트, fan-out 레인, 수렴 규칙, 재시도 예산 로직을 변경하지 않는다.
- Q3에서 확정한 규칙 세트를 넘어서는 검사를 추가하지 않는다 (특히 ID 연속성 검사 금지).
- 기존 JSON 필드를 제거하거나 개명하지 않는다. exit code 계약(0/1/2)을 바꾸지 않는다.
- validate_intake.mjs 코드를 복사하거나 파일을 삭제하지 않는다.
- prd_state_harness(plan-verification)를 수정하지 않는다.
- 스코프 밖 스킬 문서 변경은 하지 않는다 (R7에 명시된 갱신만).
- `checkshirt gate override`를 에이전트가 실행하지 않는다.

## 12. Implementation Result Report Contract

구현 에이전트는 다음을 보고한다:

- status: Done / Partially Done / Blocked.
- 사용자 가시 변경: 게이트 출력(텍스트 `[prelint]` 라벨, JSON 스키마), 새 차단 동작, 문서 변경.
- 구조 준수: 섹션 5의 파이프라인 순서와 비파괴 스키마 확장 준수 여부.
- 태스크 T1~T6 완료 상태와 R/AC/V 커버리지.
- 모드별 검증 증거 (V1~V7, 특히 V2 규칙별 매트릭스 결과와 V6 라이브 스모크 로그).
- 추가·갱신된 자동 테스트와 각각이 막는 회귀 위험.
- 편차(deviation)와 남은 사용자 검토 항목.
- 미완 항목과 후속 후보 (예: ID 연속성 검사 재검토 신호).
