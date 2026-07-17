---
topic: "judge fan-out"
status: "ready"
human_approval: "approved"
review_profile: "standard"
review_rationale: "CLI 내부 판정 아키텍처 변경으로 프로덕션 데이터/인증/과금 접점은 없으나, 모든 프로젝트의 게이트 판정 경로와 판정 품질에 영향을 주는 런타임 계약 변경이므로 standard."
source_intake: "agents/intake/judge-fanout/qa-log.md"
source_clarity: "none"
created_at: "2026-07-17"
updated_at: "2026-07-17"
---

# PRD: judge fan-out

## 1. Summary

checkshirt의 gap-audit/spec 게이트 판사를 "단일 판사가 문서 전체를 exhaustive하게 훑는" 구조에서 "좁은 레인 판사 여러 명을 병렬로 보내고 CLI가 기계적으로 병합하는" fan-out 구조로 바꾼다.
목표는 같은 gap 목록 판정을 절반 이하의 벽시계 시간에, 단일 판사 동등 이상의 탐지력으로 내리는 것이다.
같은 사이클에 이미 확인된 결함 2건을 동봉한다: codex 판사의 최선 격리(완전 차단은 codex CLI 미지원으로 불가 - 한계 문서화 포함), 기계 검사 명령 타임아웃.
verify의 semantic 판사는 이번 사이클에서 손대지 않는다 (사용자 결정).

Approval checklist:

- 범위: gap-audit/spec 판사만 fan-out. verify semantic은 완전히 그대로 (§3 Non-Goals, D-05).
- 레인 구성: gap-audit 4레인(문서 영역), spec 3레인(심사 종류). 고정, 프로젝트별 커스터마이즈 없음 (§5, D-06).
- 기본 동작 변경: fan-out이 기본 on, `judge.fanout: false`로 단일 판사 복귀 (§6 R5).
- 합격선: 지뢰 3개 A/B 캘리브레이션에서 탐지 동률 이상 + 시간 50% 이하 - 이게 required-for-done 검증이다 (§9.2 V6, D-10).
- 동봉 수리: codex 판사 최선 격리(-C 빈 임시루트 + ephemeral + 사용자설정 무시 + 프롬프트 도구금지; 완전 차단은 codex CLI 미지원이라 잔여 리스크 문서화), 기계 검사 타임아웃 기본 10분 (§6 R7/R8, D-07).
- 토큰 비용: 입력 토큰이 레인 수만큼 증가 (~3-4배)를 수용 (D-02).
- delivery mode: local (main 직접 커밋, 기존 관행 유지).

## 2. Problem, Goal, And Users

사용자는 이 하네스로 인터뷰→PRD→구현 파이프라인을 실사용 중이며, 게이트 판정이 대화 흐름을 막는 것이 현재 최대 불만이다.
2026-07-17 수정(one-shot 강제, frugal→sonnet)으로 107~260초가 ~80초까지 내려왔지만, 남은 80초의 원인은 구조적이다: 판사 1명이 문서 전체에 대해 "빠짐없이 찾아라"는 지시를 받아 ~7k 토큰을 심의한다.
ouroboros의 차원별 fan-out에서 속도 기법만 이식한다 - 좁은 질문 여러 개를 병렬로 던지면 각 판사의 심의가 짧아지고 전체 시간은 가장 느린 레인만큼만 걸린다.
단, ouroboros의 스칼라 점수 출력은 이식하지 않는다 (원 PRD mini-cli-llm-boundary의 D-05에서 기각된 결정의 유지이며, 이 문서의 D-01이 gap 목록 형식 보존을 재확인한다): 출력은 지금과 동일한 gap findings 목록이다.
사용자의 최상위 의도는 "파이프라인 전체가 빠르고 정확하게" - 속도를 위해 탐지력을 희생하면 실패다 (D-03).

## 3. Scope And Non-Goals

포함:

- gap-audit 판사 fan-out: 문서 영역 4레인 병렬 심사 + 기계적 병합.
- spec 판사 fan-out: 심사 종류 3레인(fidelity/testability/verification completeness) 병렬 심사 + 기계적 병합.
- judge 호출부의 비동기 병렬화 리팩터링 (기존 타임아웃/재시도/기록 의미 보존).
- `judge.fanout` 설정 (기본 on, off 시 기존 단일 판사 경로).
- 재심 수렴 규칙의 병합 목록 적용.
- codex 판사 최선 격리 (완전 차단 아님 - R7의 한계 문서화 포함).
- 기계 검사(test/lint/typecheck/build) 명령 타임아웃.
- 실문서 A/B 캘리브레이션 (합격선: D-10).
- README/ho-setup 문서 갱신.

Non-Goals (모두 의도적 결정):

- verify semantic 판사는 fan-out도 측정 추가도 하지 않는다. 사용자 결정 (D-05, Q1 "verify 완전 그대로"). per-AC fan-out은 기각이 아닌 보류이며, 재검토 트리거는 verify 지연이 실사용 병목으로 관찰될 때. 사용자 영향: verify는 계속 ~80초대.
- 스칼라 점수 게이트는 도입하지 않는다 (원 PRD mini-cli-llm-boundary의 D-05 기각 유지).
- 레인 단위 부분 재시도는 도입하지 않는다 - 레인 실패 시 전체 fan-out 재실행 (UX-01, 단순성 우선). 사용자 영향: 레인 1개 실패에도 전체 재실행 비용.
- 프로젝트별 레인 커스터마이즈는 없다 - 레인은 코드에 고정 (D-06). 재검토 트리거: 캘리브레이션이나 실사용에서 레인 간 체계적 누락 관찰 시.
- 구현 실행의 CLI 이관 없음 (원 PRD D-07 영구 non-goal 유지).

## 4. Pre-Work And Required Decisions

### 4.1 Pre-Work Before Implementation

None required - 판사 백엔드(claude CLI)는 이미 이 머신에 로그인되어 있고, 나머지는 전부 에이전트가 할 수 있는 작업이다.

### 4.2 Human Decisions Before PRD Approval

- 이 PRD의 Approval checklist 승인 (특히 fan-out 기본 on과 verify 제외).

### 4.3 Decision Traceability For Fidelity Review

- D-01 (user, resolved): gap-audit/spec 판사를 레인별 병렬 fan-out으로 전환, 출력은 gap findings 목록 유지. 근거 발언: "어어 fan-out 좋은 것 같음", "바로 태워". → R1, R2, AC1, AC2.
- D-02 (user, resolved): 레인 수 배 토큰 증가 수용. 근거 발언: "병렬 괜찮아 어차피 토큰 그렇게 안비싸서". → 가드레일(§11), context.
- D-03 (user, resolved): 최상위 목표는 전체 게이트가 "빠르고 정확하게" - 속도가 탐지력을 깎으면 안 됨. 근거 발언: "결국 내가 원하는건 나머지도 결국에는 빠르고 정확하게 되는 게 중요해". → AC9의 이중 합격선, V6.
- D-04 (fact, 세션 실측): 남은 지연 = 단일 판사의 전문서 exhaustive 심의 (sonnet ~80s/26KB, 이전 haiku는 146-238s + verdict 불안정). → 문제 정의(§2), V6 기준선.
- D-05 (user, resolved): verify semantic은 이번 사이클 완전 제외 (Q1 답변 "verify 완전 그대로"). per-AC fan-out은 보류. → non-goal.
- D-06 (assumption, agent): 레인 고정 - gap-audit 4레인(목표/범위·UX/행동·데이터/기술·리스크/운영/검증), spec 3레인(fidelity·testability·verification completeness). `judge.fanout: false` 탈출구, 기본 on. → R1, R2, R5; revisit: 레인 간 누락/중복 관찰 시.
- D-07 (user, resolved, 구현 중 재개정): 동봉 수리 2건 - (a) codex 판사 격리: 원래 "완전 차단"이었으나 라이브 스파이크에서 codex CLI가 셸 비활성화를 미지원함이 판명되어(4가지 방법 전부 무효) 사용자가 "최선 격리 + 한계 문서화"로 재확정 (Q3, "최선 격리 + 한계 문서화 (Recommended)" 채택). 기각 대안: codex opt-in 제한(원 PRD D-04 듀얼 백엔드 약화), AC7 Blocked 잔류. (b) 기계 검사 타임아웃. → R7, R8, AC7, AC8.
- D-08 (assumption, agent): 병합은 전부 기계적 - 합집합, 차단급 1개 이상이면 BLOCK, 정규화 비교 dedupe, fan-out 1라운드 = attempt 1회, 레인 judge 오류 시 fail-closed, 레인별 기존 1회 파싱 재시도 유지. 레인 간 근사중복은 수용된 트레이드오프로 캘리브레이션에서 비율 관찰. → R3, AC3, AC4, 리스크(§10); revisit: dedupe 오탐/근사중복 과다 시.
- D-09 (assumption, agent): 재심 수렴(이전 지적+새 P0만 차단)은 병합 목록 기준 적용, 이전 findings는 area 매칭으로 해당 레인 주입 + 매칭 불가 시 전 레인 주입, origin 라벨링 유지. → R4, AC6.
- D-10 (user, resolved + agent 확장): A/B 캘리브레이션 합격선 = 지뢰 3개 문서에서 fan-out 탐지 수 ≥ 단일 판사 탐지 수(동률 허용) AND fan-out 시간 ≤ 단일 판사의 50%. Q2 답변 "탐지 동률 이상 + 시간 절반"(권고 채택). 기각된 대안: 전수 탐지(3/3, 비결정성 노이즈로 기각), 시간만(D-03과 긴장으로 기각). 게이트 재심 지적으로 agent가 확장: 변환되는 두 게이트 각각 독립 코퍼스(qa-log형/PRD형)로 같은 합격선을 통과해야 함. → AC9, V6.
- D-14 (assumption, agent): 병렬 레인 호출의 provider rate-limit(429류)은 backoff 없이 해당 레인 judge 오류로 fail-closed (기존 원칙의 선언적 적용), 동시성 상한은 레인 수. → 리스크(§10); revisit: throttling 관찰 시.
- D-11 (assumption, agent): 기계 검사 타임아웃 기본 10분/명령, `verify.commandTimeoutMs`로 조정, 초과 시 해당 명령 FAIL(fail-closed). → R8, AC8; revisit: 느린 스위트에서 오탐 시.
- D-12 (fact, repo): 현재 judge 호출은 spawnSync 동기 - 비동기 병렬화 필요. 게이트 명령 인터페이스와 gates.json 스키마는 스킬 4종이 소비하므로 하위호환(추가 필드만) 필수. → R6, AC10.
- D-13 (fact, repo + 게이트 finding 대응): 레인 행(hang)은 기존 `judge.timeoutMs`(기본 180s)가 spawn 타임아웃으로 각 호출에 상속되어 커버 - 타임아웃 레인은 judge 오류로 fail-closed. 리팩터링 후에도 per-호출 타임아웃 유지를 회귀 테스트로 고정. → R6, AC4, V5.
- gap-audit 게이트 Audit 1 (fail → 해소): 합격선 미정은 D-10으로, 레인 행 처리는 D-13으로 해소. Audit 2 pass.
- gap-audit 게이트 Audit 3 (fail → 해소, 문서 개정 후 재심): spec 게이트 독립 캘리브레이션 부재는 D-10 확장(PRD형 코퍼스 + 게이트별 동일 합격선)으로, rate-limit 처리 미정은 D-14(레인 judge 오류로 fail-closed)로, 근사중복 미명시는 D-08 트레이드오프 수용 기록으로 해소. 이후 재심 pass.

## 5. Major Technical Structure Changes

- judge 호출 계층(cli/src/judge)이 동기 단일 호출에서 비동기 병렬 다중 호출로 바뀐다. 호출별 타임아웃, 1회 파싱 재시도, JudgeCallRecord 기록 의미는 레인별로 보존된다.
- 게이트 계층(cli/src/gates)에 레인 정의, fan-out 오케스트레이션, 기계적 병합(합집합/BLOCK 판정/dedupe)이 추가된다. 게이트 명령 인터페이스(명령어/플래그/exit code)와 gates.json 스키마는 하위호환을 유지하며 레인 관련 정보는 추가 필드/아티팩트로만 기록한다.
- 설정 계층에 `judge.fanout`(boolean, 기본 true)과 `verify.commandTimeoutMs`(기본 600000)가 추가된다.
- codex 백엔드의 실행 인자가 저장소 접근을 차단하는 방향으로 바뀐다 (판사 계약: 프롬프트 안의 문서만 심사).
- DB/스키마/인프라/배포/외부 서비스 변경 없음.

## 6. Requirements

- R1. gap-audit 판사는 fan-out 기본 경로에서 문서 영역 4레인(①목표/범위/non-goal ②UX/행동/상태/복구 ③데이터/기술구조/외부연동 ④리스크/운영/검증증명)으로 분할되어 병렬 심사되고, 각 레인은 자기 영역의 gap만 보고하도록 지시받는다. 출력 형식은 기존 findings 스키마와 동일하다. Covers AC1, AC9.
- R2. spec 판사는 심사 종류 3레인(①fidelity: Decision Register→PRD 대응 ②testability: AC 관찰가능성 ③verification completeness: 검증 계약 완결성)으로 분할되어 병렬 심사된다. Covers AC2.
- R3. 레인 결과 병합은 전부 기계적이다: findings 합집합, 차단급(P0/P1) finding이 1개 이상이면 BLOCK, 정규화 문자열 비교로 중복 제거, fan-out 1라운드는 게이트 attempt 1회로 계산된다. Covers AC3.
- R4. 재심 수렴 규칙(이전 지적 + 새 P0만 차단, 나머지 새 finding은 P2 강등)은 병합된 목록 기준으로 동작하며, 이전 findings는 area 매칭으로 해당 레인에 주입되고 매칭 불가 항목은 전 레인에 주입되며 origin 라벨링 요구가 유지된다. Covers AC6.
- R5. `judge.fanout` 설정(기본 true)이 존재하고, false면 기존 단일 판사 경로가 변경 없이 동작한다. Covers AC5.
- R6. judge 호출부는 비동기 병렬 실행으로 리팩터링되되 호출별 `judge.timeoutMs` 타임아웃, 1회 파싱 재시도, 레인별 JudgeCallRecord 기록이 보존되고, 레인 하나라도 judge 오류(타임아웃 포함)면 게이트는 ERROR로 fail-closed되며 실패한 레인이 출력에 명시된다. 게이트 명령 인터페이스와 gates.json 스키마는 하위호환(추가 필드만)을 유지한다. Covers AC4, AC10.
- R7. codex 판사는 최선 격리로 실행된다: 빈 임시 작업 루트(-C), --ephemeral, --ignore-user-config, 그리고 판사 프롬프트의 도구 사용 금지 지시. 완전한 셸/읽기 차단은 codex CLI가 지원하지 않음이 라이브 스파이크로 확인되어(2026-07-17: sandbox_permissions=[], tools.shell=false, deny-all .rules, approval_policy=untrusted 모두 무효) 사용자 결정으로 "최선 격리 + 한계 문서화"로 재정의되었다. Covers AC7.
- R8. 기계 검사(test/lint/typecheck/build) 명령은 기본 10분(`verify.commandTimeoutMs`로 조정) 타임아웃을 가지며, 초과 시 해당 명령은 FAIL로 처리되어 semantic 판사에 도달하지 않는다. Covers AC8.
- R9. 사용자 체감 인터페이스는 불변이다: 같은 명령, 같은 exit code 규약, 같은 findings 출력 형식. 레인 귀속 정보는 게이트 아티팩트에 기록된다. Covers AC1, AC10.
- R10. README의 CLI 섹션과 ho-setup의 judge 설정 문서가 fanout/commandTimeoutMs를 반영한다. Covers AC10.

## 7. Acceptance Criteria

- AC1. fan-out 경로의 `checkshirt gate gap-audit`은 4레인을 병렬 심사한 뒤 기존과 동일한 스키마의 병합 verdict/findings를 반환하고, 레인별 judge 기록이 gates.json/아티팩트에 남는다.
- AC2. fan-out 경로의 `checkshirt gate spec`은 fidelity/testability/verification-completeness 3레인으로 심사된다.
- AC3. 어느 레인이든 차단급 finding을 반환하면 병합 verdict는 BLOCK이고, 전 레인이 빈 목록이면 PASS이며, 정규화상 동일한 finding은 1건으로 병합된다.
- AC4. 레인 1개가 judge 오류(잘못된 출력 2회, 바이너리 부재, 타임아웃)면 게이트는 ERROR fail-closed로 기록되고 출력에 실패 레인이 명시된다.
- AC5. `judge.fanout: false`면 judge 호출이 정확히 1회(기존 단일 판사 경로)로 동작한다.
- AC6. 직전 BLOCK 후 재실행 시 각 레인 프롬프트에 이전 findings가 주입되고, 병합 결과에 수렴 규칙(이전 지적/새 P0만 차단, 나머지 P2 강등)이 적용된다.
- AC7. codex 백엔드 판사 호출 인자에 격리 구성(-C <빈 임시 디렉터리>, --ephemeral, --ignore-user-config)이 포함되고 판사 프롬프트에 도구 사용 금지 지시가 들어가며(유닛 검증), README/ho-setup에 "codex 판사는 셸 완전 비활성화 미지원 - 리뷰어 격리는 claude 백엔드가 더 강함" 한계가 문서화된다.
- AC8. 기계 검사 명령이 행에 걸리면 `verify.commandTimeoutMs`(기본 600000ms) 시점에 해당 명령이 FAIL로 기록되고 게이트가 fail-closed된다.
- AC9. 게이트별 독립 A/B 캘리브레이션: gap-audit은 지뢰 3개를 심은 qa-log형 코퍼스, spec은 지뢰 3개를 심은 PRD형 코퍼스(각각 교차 영역 지뢰 1개 이상 포함)에서, 각 게이트가 "fan-out 지뢰 탐지 수 ≥ 단일 판사 탐지 수 AND fan-out 벽시계 시간 ≤ 단일 판사의 50%"를 충족. 레인 간 근사중복 발견 비율을 결과 아티팩트에 관찰 항목으로 기록.
- AC10. 기존 소비자 계약이 깨지지 않는다: 게이트 명령/플래그/exit code 불변, gates.json 변경은 추가 필드만, 기존 CLI 유닛/e2e/저장소 회귀(스킬 wiring 포함) 전부 통과, 문서 갱신 완료.

## 8. PRD-Level Tasks

- T1. judge 호출부 비동기 병렬화 리팩터링 (타임아웃/재시도/기록 의미 보존). Covers R6.
- T2. gap-audit 4레인 프롬프트 정의 + fan-out 오케스트레이션. Covers R1.
- T3. spec 3레인 프롬프트 정의 + 동일 오케스트레이션 재사용. Covers R2.
- T4. 기계적 병합기(합집합/BLOCK 판정/정규화 dedupe/attempt 계산) + 재심 수렴 통합(area 라우팅 주입 포함). Covers R3, R4.
- T5. `judge.fanout` 설정 추가 및 단일 판사 경로 보존. Covers R5.
- T6. codex 백엔드 저장소 접근 차단 (프롬프트 전달 방식 포함 스파이크 후 적용). Covers R7.
- T7. 기계 검사 타임아웃 (`verify.commandTimeoutMs`, 기본 600000). Covers R8.
- T8. 회귀 테스트: 병합기/수렴/설정 유닛, stub 레인 기반 e2e(BLOCK/PASS/레인 오류/flag-off), per-호출 타임아웃 회귀, codex 인자 구성 검증. Covers R1-R8, AC10.
- T9. A/B 캘리브레이션: qa-log형/PRD형 지뢰 3개 코퍼스 2종 준비, 단일 vs fan-out 실측 스크립트(게이트 선택 지원), 게이트별 결과 아티팩트 기록. Covers AC9.
- T10. README + ho-setup 문서 갱신. Covers R10.

## 9. Verification Contract

### 9.1 Test Mode Contract

| Mode | Required For Done | Covers | Human Decision |
| --- | --- | --- | --- |
| build/static | yes | CLI 빌드/타입 건강 | none |
| automated behavior | yes | 병합/수렴/설정/fail-closed/하위호환 회귀 | none |
| live judge calibration | yes | 실판사 A/B 합격선(속도+탐지력)과 라이브 동작 | none (합격선은 D-10으로 사용자가 이미 확정) |

브라우저/runtime 모드 없음: 이 제품의 사용자 접점은 CLI stdout/exit code이며 automated behavior(e2e)가 그 접점을 직접 검증한다.

### 9.2 Required Agent Verification

| ID | Mode | Covers | Method | Artifact | Pass Criteria | Environment | Required For Done | Can Be Blocked | Safe Probe | Live Proof | Side Effect | Sensitive Data Policy |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| V1 | build/static | R6, AC10 | `pnpm -C cli build` | command-log | exits 0 | local shell | yes | no | none | command log | none | no secrets |
| V2 | automated behavior | R3, R4, R5, AC3, AC5, AC6 | `pnpm -C cli test` | command-log | 유닛 전부 통과 (병합기 합집합/BLOCK/dedupe, 수렴 area 라우팅, fanout flag 회귀 보호) | local shell | yes | no | none | command log | none | no secrets |
| V3 | automated behavior | R1, R2, R6, R9, AC1, AC2, AC4 | `pnpm -C cli test:e2e` | command-log | stub 레인 기반 e2e 전부 통과 (병렬 fan-out BLOCK/PASS, 레인 오류 fail-closed에 레인명 표기, flag-off 단일 호출) | local shell | yes | no | none | command log | none | no secrets |
| V4 | automated behavior | R7, R8, AC7, AC8 | `pnpm -C cli test` (backends/mechanical 유닛 포함) | command-log | codex 인자에 저장소 차단 구성 검증 + 기계 검사 행 시뮬레이션이 commandTimeoutMs에 FAIL 처리 | local shell | yes | no | none | command log | none | no secrets |
| V5 | automated behavior | R6, AC4, AC10 | `node --test "tests/*.test.mjs"` | command-log | 저장소 회귀(스킬 wiring, prd parser 등) 전부 통과 + per-호출 타임아웃 회귀 테스트 통과 | local shell | yes | no | none | command log | none | no secrets |
| V6 | live judge calibration | D-10, AC9 | `node cli/scripts/fanout_ab_calibration.mjs --gate gap-audit --doc <qa-log형 지뢰 코퍼스>` 및 `--gate spec`으로 PRD형 코퍼스 1회씩 | 게이트별 json 결과 아티팩트 + command-log | 두 게이트 각각: fan-out 지뢰 탐지 수 ≥ 단일 판사 탐지 수 AND fan-out 시간 ≤ 단일 시간의 50% (근사중복 비율은 관찰 기록) | local shell + claude CLI 로그인 (구독 사용량 소모, 실 API 호출) | yes | no | 판사 도구 전면 차단(one-shot)이라 저장소/외부 부작용 없음 | 실판사 호출 로그 + 측정 json | 구독 토큰 사용 외 없음 | 문서는 로컬 테스트 픽스처만 사용, 비밀 없음 |
| V7 | automated behavior | R10, AC10 | `grep -l "judge.fanout" README.md skills/ho-setup/SKILL.md && grep -l "commandTimeoutMs" skills/ho-setup/SKILL.md` | command-log | 두 grep 모두 exit 0 - README와 ho-setup이 새 설정 키를 실제로 문서화했음을 기계 확인 | local shell | yes | no | none | command log | none | no secrets |

### 9.3 Human Verification

None required - 합격선(D-10)과 범위(D-05)를 사용자가 인터뷰에서 이미 확정했고, 나머지는 전부 기계/실측 증명이 가능하다.

## 10. Risks And Open Decisions

- 레인 분할로 인한 교차 영역 gap 누락 가능성 (예: UX와 데이터에 걸친 결정): 레인 프롬프트에 "겹치면 보고하라, dedupe는 CLI가 한다"를 명시해 완화. V6의 지뢰에 교차 영역 지뢰 1개 이상 포함해 실측. 잔여 리스크는 D-06 revisit 트리거로 관리.
- 레인 간 근사중복(같은 이슈의 다른 표현)은 문자열 dedupe가 못 잡는 수용된 트레이드오프 (D-08): 캘리브레이션에서 비율을 관찰 기록하고, 과다 시 revisit.
- provider rate-limit(429류)은 별도 backoff 없이 해당 레인 judge 오류로 fail-closed 처리 (D-14): 동시성은 레인 수(≤4)로 자연 상한, throttling 관찰 시 backoff 도입 재검토.
- 병렬 레인 수만큼 판사 호출이 늘어 잘못된 출력/재시도 확률도 레인 수 배로 늘어남: fail-closed는 유지되므로 안전 방향 실패이며, 재실행 비용 증가만 발생. 캘리브레이션에서 관찰.
- 구독 rate limit: 동시 3-4 호출은 실측상 문제없으나, 향후 레인 증가 시 재검토.
- codex 판사 잔여 리스크: 최선 격리에도 판사 모델이 도구 금지 지시를 어기고 파일을 읽을 낮은 가능성이 남음. 영향 범위는 판정 편향에 한정 (read-only 샌드박스라 쓰기/유출 불가). codex CLI가 셸 비활성화를 지원하면 완전 차단으로 승격 (revisit 트리거).
- 열린 결정 없음. 보류: verify semantic 개선 (D-05 revisit 트리거 참조).

## 11. Implementation Guardrails

- 범위 확장 금지: verify semantic 경로, 점수화, 레인 커스터마이즈, 레인 부분 재시도를 이번 사이클에 추가하지 않는다.
- 게이트 명령 인터페이스(명령/플래그/exit code)와 gates.json 기존 필드의 의미를 바꾸지 않는다 - 추가만 허용.
- 판사 원칙 불변: one-shot, 도구 없음, fail-closed, 스키마 검증 + 1회 재시도, override는 사용자 전용.
- 신선도 해시/수렴 규칙 등 기존 게이트 무결성 장치를 우회하는 코드를 넣지 않는다.
- 실판사 호출은 V6 캘리브레이션과 스모크에 한정하고, 개발 중 반복 검증은 stub 백엔드를 쓴다 (토큰 절약, D-02는 운영 비용 수용이지 개발 낭비 승인이 아님).
- 새 외부 의존성/서비스/스키마 추가 금지.

## 12. Implementation Result Report Contract

구현 에이전트는 다음을 보고한다:

- status: Done / Partially Done / Blocked.
- 사용자 체감 변화: 게이트 명령별 벽시계 시간 (캘리브레이션 실측 수치 인용).
- 주요 변경 모듈 (judge 호출부, 게이트 오케스트레이션, 병합기, 설정, codex 백엔드, mechanical).
- 승인된 구조(§5) 준수 여부와 이탈 시 사유.
- T1-T10 완료 상태.
- R/AC/V 커버리지 표와 각 V의 증거 아티팩트 경로.
- V6 A/B 결과: 단일 vs fan-out의 시간, 지뢰 탐지 수, 합격선 충족 여부.
- 추가/갱신된 자동 테스트와 각각이 막는 회귀 리스크.
- deviations (검증 명령 이탈 포함).
- 남은 인간 리뷰 항목과 후속 후보 (verify semantic 보류 상태 포함).
