---
topic: "judge fan-out: lane-parallel gate judges for fast and accurate gates"
status: "complete"
where: "brownfield"
selected_packs: "ux, compatibility, provider, risk, verification"
created_at: "2026-07-17"
updated_at: "2026-07-17"
question_count: 0
normalization_policy: "raw-capture-with-checkpoint-backfill"
normalization_checkpoint_every: 10
---

# Interview Log: judge fan-out

## Current Understanding

- gap-audit/spec 게이트의 남은 지연 원인은 "판사 1명이 문서 전체를 빠짐없이 훑는" 구조다 (sonnet 기준 26KB 문서 ~80초, 출력 ~7k 토큰).
- ouroboros의 차원별 fan-out에서 속도 기법만 가져온다: 좁은 레인 판사 여러 명을 병렬로 보내고 CLI가 기계적으로 합친다. 점수화(D-05 기각)는 가져오지 않고 gap 목록 형식을 유지한다.
- 사용자의 최상위 의도: 특정 게이트만이 아니라 파이프라인 전체가 "빠르고 정확하게" 도는 것. 속도를 위해 finding 품질을 희생하지 않는다.
- 같은 사이클에 이미 확인된 결함 2개를 동봉한다: codex 판사의 저장소 읽기 차단, 기계 검사(test/lint/build) 타임아웃.

## Intake Cursor

- next_decision_id: D-15
- next_question: none (P0/P1 전부 resolved - 마감 절차 진입)
- last_materiality_sweep: Sweep 2 (Q1 답변 후)
- outstanding_raw_entries: 0
- next_checkpoint_at: 10

## Decision Register

| ID | Kind | Area | Decision / fact | Priority | Source / owner | Status | PRD mapping / revisit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| D-01 | decision | architecture | gap-audit/spec 판사를 고정 레인별 병렬 fan-out으로 전환하되 출력은 지금과 동일한 gap findings 목록 형식 유지 (점수화 금지 유지) | P0 | user: "어어 fan-out 좋은 것 같음", "바로 태워" (2026-07-17 대화) | resolved | R#/AC# |
| D-02 | decision | cost | fan-out으로 입력 토큰 ~레인 수 배 증가를 수용 | P1 | user: "병렬 괜찮아 어차피 토큰 그렇게 안비싸서" | resolved | context/guardrail |
| D-03 | decision | goal | 최상위 목표는 파이프라인 전체 게이트가 "빠르고 정확하게" 도는 것; 속도가 finding 품질(정확도)을 깎으면 안 됨 | P0 | user: "결국 내가 원하는건 나머지도 결국에는 빠르고 정확하게 되는 게 중요해" | resolved | AC#/V# (속도+정확도 이중 기준) |
| D-04 | fact | latency | 2026-07-17 수정(--tools "" one-shot, frugal→sonnet) 후 남은 지연 = 단일 판사의 전문서 exhaustive 심의. 실측: 26KB qa-log에 sonnet ~80s/~7k tok, haiku 146-238s/11-20k tok + verdict 불안정 | P1 | 세션 실측; cli/src/config.ts:34-41 주석 | resolved | context |
| D-05 | decision | scope | verify semantic judge는 이번 사이클에서 완전히 손대지 않음 (fan-out도, 측정 추가도 없음) - per-AC fan-out은 명시적 기각이 아니라 "이번 범위 아님"으로 보류 | P1 | user: Q1 답변 "verify 완전 그대로" | resolved | non-goal; revisit: verify 지연이 실사용 병목으로 관찰되면 |
| D-06 | assumption | architecture | 레인은 게이트별 고정: gap-audit은 문서 영역 4레인(①목표/범위/non-goal ②UX/행동/상태/복구 ③데이터/기술구조/외부연동 ④리스크/운영/검증증명), spec은 심사 종류 3레인(①fidelity ②testability ③verification completeness - 게이트의 원래 3중 심사 기준과 정렬). `judge.fanout: false`로 단일 판사 복귀 가능, 기본 on | P1 | agent default (ouroboros dimension_specs 참조 + spec 게이트 기존 심사 기준) | resolved | R#; revisit: 캘리브레이션에서 레인 간 누락/중복 관찰 시 |
| D-07 | decision | scope | 동봉 수리 2건: (a) codex 판사 격리 - 구현 중 스파이크로 "완전 차단"이 codex CLI 미지원임이 판명되어(4가지 방법 라이브 검증 실패) 사용자가 "최선 격리(-C 빈 임시루트 + --ephemeral + --ignore-user-config + 프롬프트 도구금지 지시) + 한계 문서화"로 재확정, (b) 기계 검사 명령에 타임아웃 추가 (현재 무한 대기 가능) | P1 | user: 설계안 승인("바로 태워") + 구현 중 재질의 답변 "최선 격리 + 한계 문서화 (Recommended)" (2026-07-17) | resolved | R#/T#; 기각 대안: codex opt-in 제한(D-04 듀얼백엔드 약화로 기각), AC7 Blocked 유지(기각) |
| D-08 | assumption | mechanics | 병합은 전부 기계적: 레인 findings 합집합, 차단급 finding 1개 이상이면 BLOCK, 정규화 문자열 비교로 중복 제거, fan-out 1라운드 = 게이트 attempt 1회, 레인 하나라도 judge 오류면 fail-closed(ERROR), 레인별 호출은 기존 runner의 1회 파싱 재시도 유지. 알려진 트레이드오프(수용): 겹치는 레인이 같은 이슈를 다른 표현으로 보고하면 문자열 dedupe가 못 잡아 근사중복 finding이 남을 수 있음 - 캘리브레이션에서 비율 관찰(D-10), 완화책은 레인 프롬프트의 상호배제 지시 | P1 | agent default (기존 게이트 원칙 연장) | resolved | R#/AC#; revisit: dedupe 오탐/근사중복 과다 관찰 시 |
| D-14 | assumption | provider | 병렬 레인 호출 중 provider rate-limit(429류) 오류는 별도 backoff 없이 해당 레인의 judge 오류로 취급되어 D-08 fail-closed 규칙에 그대로 걸림. v1 동시성 상한은 레인 수(최대 4)로 자연 제한 | P1 | agent default (기존 fail-closed 원칙 연장) | resolved | R#/risk; revisit: 캘리브레이션이나 실사용에서 throttling 관찰 시 backoff 도입 검토 |
| D-09 | assumption | convergence | 재심 수렴 규칙(이전 지적+새 P0만 차단, 나머지 P2 강등)은 병합된 목록 기준으로 그대로 적용. 이전 findings는 area 매칭으로 해당 레인에 주입하고 매칭 불가 항목은 전 레인에 주입, origin 라벨링 요구 유지 | P1 | agent default (applyRerunConvergence 연장) | resolved | R#/AC# |
| D-10 | decision | verification | 정확도 증명 = 실문서 A/B 캘리브레이션, 합격선 확정: 지뢰(의도적으로 빠뜨린 결정) 3개를 심은 문서에서 (a) fan-out의 지뢰 탐지 수 ≥ 단일 판사의 탐지 수 (동률 허용), (b) fan-out 벽시계 시간 ≤ 단일 판사의 50%. 두 조건 모두 충족해야 합격. 게이트 재심 지적으로 확장: 변환되는 두 게이트 각각 독립 캘리브레이션 - gap-audit은 qa-log형 코퍼스, spec은 PRD형 코퍼스(각 지뢰 3개, 교차 영역 지뢰 1개 이상 포함)로 같은 이중 기준을 게이트별로 통과해야 함. 캘리브레이션 중 레인 간 근사중복 발견 비율도 비공식 관찰 항목으로 기록 | P1 | user: Q2 답변 "탐지 동률 이상 + 시간 절반" + agent 확장(사용자 합격선을 spec 게이트에 동일 적용) | resolved | AC#/V# |
| D-11 | assumption | mechanics | 기계 검사 타임아웃 기본 10분/명령, `verify.commandTimeoutMs`로 조정 가능; 초과 시 해당 명령 FAIL 처리(fail-closed) | P2 | agent default | resolved | R#; revisit: 느린 스위트 프로젝트에서 오탐 시 |
| D-12 | fact | compatibility | 현재 judge 호출부는 spawnSync(동기 블로킹)라 병렬 불가 - fan-out은 비동기 병렬 spawn 리팩터링이 전제 (cli/src/judge/backends.ts, runner.ts). 게이트 명령 인터페이스와 gates.json 스키마는 소비자(스킬 4종)가 있으므로 하위호환 유지 필요 | P1 | repo: cli/src/judge/backends.ts:47, runner.ts | resolved | R#/guardrail |
| D-13 | fact | risk | 레인별 judge 호출이 행에 걸리는 경우는 기존 `judge.timeoutMs`(기본 180초, agents/config.json으로 조정)가 spawn 타임아웃으로 각 호출에 상속되어 커버됨 - 타임아웃된 레인은 judge-timeout 오류가 되어 D-08의 fail-closed 규칙에 그대로 걸림. 별도 레인 타임아웃 개념 불필요, 단 리팩터링 후에도 per-호출 타임아웃이 유지됨을 회귀 테스트로 고정 | P1 | repo: cli/src/config.ts:49, cli/src/judge/backends.ts:50 (spawn timeout) + 게이트 finding 대응 | resolved | R#/V# |

## Raw Q&A

### Q1: verify semantic judge의 이번 사이클 범위
- decision_ids: D-05
- route: user-decision
- asked: verify의 semantic 판사는 이번에 어떻게 할까 - 구조 유지+측정만(권고) / per-AC fan-out 포함 / 완전 그대로
- recommended: 구조 유지 + 캘리브레이션에서 시간 측정만 기록
- answer: "verify 완전 그대로" - 측정도 이번 범위에서 제외, gap-audit/spec fan-out에만 집중
- immediate_notes: 권고보다도 작은 범위를 선택. 사용자의 "나머지도 빠르고 정확하게"는 장기 방향이지 이번 사이클에 verify를 욱여넣으라는 뜻이 아님이 확인됨. verify 재검토 트리거는 실사용 병목 관찰.
- needs_normalization: false

### Q2: A/B 캘리브레이션 합격선
- decision_ids: D-10
- route: user-decision
- asked: 지뢰를 몇 개 심고 어느 선을 넘어야 fan-out 합격인가 (gap-audit 게이트가 needs-human으로 지목한 결정)
- recommended: 지뢰 3개, fan-out 탐지 수 ≥ 단일 판사 탐지 수(동률 허용), 벽시계 시간 ≤ 단일 판사의 50%
- answer: 권고안 채택 - "탐지 동률 이상 + 시간 절반"
- immediate_notes: "전수 탐지(3/3)" 옵션은 LLM 비결정성 노이즈로 불합격이 날 수 있어 기각, "시간만" 옵션은 D-03의 정확도 보장과 긴장이라 기각. 합격선이 AC로 직행.
- needs_normalization: false

### Q3: codex 판사 차단 불가 판명 후 AC7 처리 (구현 중 재개정)
- decision_ids: D-07
- route: mixed
- asked: codex exec에서 셸/파일 읽기를 끄는 4가지 방법(sandbox_permissions=[], tools.shell=false, deny-all .rules, approval_policy=untrusted)을 전부 라이브 검증했으나 모두 저장소 읽기를 막지 못함. AC7("완전 차단")을 어떻게 처리할지.
- recommended: 최선 격리 + 한계 문서화 (완전 차단은 codex CLI 지원 시 재검토)
- answer: "최선 격리 + 한계 문서화 (Recommended)" 채택
- immediate_notes: 기각 대안 - codex opt-in 제한(듀얼 백엔드 D-04 약화), AC7 Blocked 잔류(partial receipt). 잔여 리스크는 판사 모델이 지시를 어기고 읽을 낮은 가능성이며 영향은 판정 편향에 한정(쓰기/유출 아님 - read-only 샌드박스 유지).
- needs_normalization: false

## UX Scenario Cards

### UX-01: 에이전트가 인터뷰 마감에서 gap-audit을 돌린다
- trigger: interview-me 마감 단계에서 `checkshirt gate gap-audit --slug X --qa-log ...` 실행
- happy path: 레인 4개가 병렬로 심사되고, 기존과 동일한 형식의 병합된 findings 목록(또는 PASS)이 기존과 동일한 exit code 규약으로 출력된다. 사용자 체감은 "같은 명령이 그냥 빨라짐"
- state / failure: 레인 중 하나가 judge 오류(타임아웃/인증)면 게이트 전체가 ERROR로 fail-closed되고, 어느 레인이 왜 실패했는지 출력에 명시된다
- recovery: 재실행 시 전체 fan-out 재시도 (레인 단위 부분 재시도는 도입하지 않음 - 단순성 우선)
- proof: e2e 테스트(stub 레인 응답) + 실문서 라이브 A/B 캘리브레이션
- linked decisions: D-01, D-06, D-08, D-10

## Evidence From Code, Docs, Or Research

- 지연 실측 (2026-07-17, meeting-hub 26KB qa-log): 단일 sonnet 판사 ~80s/6,969 tok; haiku 146-238s/11-20k tok에 verdict 불안정(PASS 0건→BLOCK 3건→PASS 0건→BLOCK 9건). 근거: 세션 replay, cli/src/config.ts:34-41.
- ouroboros fan-out 원형: scratchpad 클론 src/ouroboros/mcp/tools/subagent.py:1431 `build_ambiguity_dimension_fanout` - 차원별 미니 판사 병렬 + 호출자 측 기계적 집계. 단 출력이 스칼라 점수라 D-05(점수화 기각)와 충돌 → 형식은 gap 목록 유지.
- codex 판사 잔여 결함: cli/src/judge/backends.ts CodexBackend가 `--sandbox read-only`로 실행되어 저장소 열람 가능 - claude에서 잡은 "판사가 저장소를 뒤지는" 문제와 동일 원인.
- 기계 검사 타임아웃 부재: cli/src/mechanical.ts:88 spawnSync에 timeout 옵션 없음.
- 판사 호출 동기 구조: cli/src/judge/backends.ts:47 spawnSync - 병렬화하려면 async spawn 필요.
- 게이트 소비자: skills/interview-me, gen-prd, implement, please의 SKILL.md + tests/checkshirt_gate_wiring.test.mjs가 명령 인터페이스를 고정하고 있음.

## Documented Domain Checks

- docs inspected: README.md "The Checkshirt CLI" 섹션, agents/prd/mini-cli-llm-boundary/prd.md (D-05 점수화 기각, D-07 실행 비이관, D-15 fail-closed, D-16 스키마 검증)
- canonical terms: gate, lane(신규), fan-out(신규), findings, fail-closed, convergence, attempt/budget
- glossary or code conflicts: 없음 - "lane"은 신규 도입 용어로 PRD에서 정의 필요
- concrete scenarios tested: UX-01
- docs mutation: README CLI 섹션 + ho-setup의 judge config 문서에 fanout 설정 추가 필요
- ADR candidate: 아니오 (PRD Decision Traceability로 충분)

## Checkpoint And Sweep History

### Sweep 1
- trigger: register 선기록 직후 (P0 D-01/D-03 확정 시점)
- intent_drift: 없음 - 점수화 기각(구 D-05)과 실행 비이관(구 D-07) 원칙이 fan-out 설계에서도 유지됨을 확인
- impact_gap: verify semantic judge의 처리 범위가 미결 (D-05) - 사용자의 "나머지도 빠르게" 발언과 에이전트의 "verify 제외" 권고가 긴장 관계 → Q1
- verification_gap: 없음 - D-10이 속도+정확도 이중 기준을 시딩
- next_action: Q1

### Sweep 2
- trigger: Q1 답변 (P1 D-05 확정)
- intent_drift: 없음 - verify 제외는 사용자가 직접 고른 최소 범위이며, "빠르고 정확하게"의 장기 방향은 D-03에 유지됨
- impact_gap: 없음 - 남은 미결 P0/P1 없음. spec 레인 구성을 심사 종류 3레인으로 정교화(D-06 갱신, agent-owned 설계)
- verification_gap: 없음 - D-10의 속도+정확도 A/B가 gap-audit/spec 범위와 일치
- next_action: 전체 정규화 → validator → gap-audit 게이트

## Audit History

### Audit 1
- type: gap-audit-gate
- result: fail
- missing decision_ids: D-10 합격선 미정 (needs-human), 레인 행(hang) 처리 미정
- unsupported assumptions: 없음
- UX or behavior gap: 없음
- highest-risk blocker: fan-out 전체의 수용 기준(합격선)이 정의되지 않음
- final-blocking-question: Q2로 사용자에게 질의
- PRD impact: D-10 합격선이 AC/V로 직행, D-13(레인 타임아웃은 기존 judge.timeoutMs 상속) 신설

### Audit 2
- type: gap-audit-gate
- result: pass
- missing decision_ids: 없음
- unsupported assumptions: 없음
- UX or behavior gap: 없음
- highest-risk blocker: 없음
- final-blocking-question: 없음
- PRD impact: 마감 - 재심(attempts 1→PASS)에서 origin 라벨링 수렴 규칙 하 통과

### Audit 3
- type: gap-audit-gate
- result: fail
- missing decision_ids: spec 게이트 독립 캘리브레이션 미정(D-10 확장으로 해소), rate-limit 처리 미정(D-14 신설로 해소)
- unsupported assumptions: 없음
- UX or behavior gap: 레인 간 근사중복 트레이드오프 미명시(D-08에 수용 기록)
- highest-risk blocker: spec fan-out이 캘리브레이션 없이 출시될 수 있었음
- final-blocking-question: 불필요 - 사용자 합격선(D-10)의 충실한 확장과 기존 fail-closed 원칙의 선언적 적용으로 해소
- PRD impact: AC9/V6가 게이트별 2코퍼스 캘리브레이션으로 확장, risk에 rate-limit 수용과 근사중복 관찰 추가
