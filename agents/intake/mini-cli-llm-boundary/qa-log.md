---
topic: "checkshirt 단일 CLI - LLM judge 게이트 경계 설계"
status: "complete"
target_handoff: "prd"
where: "brownfield"
selected_packs: "compatibility, provider, verification, operation, risk, ux"
created_at: "2026-07-16"
updated_at: "2026-07-16"
question_count: 12
normalization_policy: "raw-capture-with-checkpoint-backfill"
normalization_checkpoint_every: 10
---

# Interview Log: checkshirt 단일 CLI - LLM judge 게이트 경계

## Current Understanding

- ouroboros의 강점(독립 판정, mechanical-first 검증, tier 라우팅 정책)을 checkshirt 하네스에 이식하되, 실행 오케스트레이션은 이식하지 않는다.
- 신규 CLI는 checkshirt의 공식 단일 CLI가 되어 implement lib(9.4k JS)을 흡수하고, 스킬들은 얇은 오케스트레이션 프롬프트로 CLI에 의존한다.
- CLI의 LLM 사용은 판단(judgment) one-shot 호출에만 한정: claude -p / codex exec headless. 구현(멀티턴 코딩)은 영구 비목표.
- v1 게이트 3종: ① gap audit(인터뷰 closure), ② 스펙 게이트(PRD 계약), ③ semantic verify(diff vs AC). consensus와 구현 subagent tier 라우팅은 v2.

## Intake Cursor

- next_decision_id: D-25
- next_question: none (closure 완료)
- last_materiality_sweep: Sweep 3 (Audit 1 해소 후)
- outstanding_raw_entries: 0
- next_checkpoint_at: n/a (완료)

## Decision Register

| ID | Kind | Area | Decision / fact | Priority | Source / owner | Status | PRD mapping / revisit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| D-01 | decision | architecture | checkshirt 단일 CLI로 통합: 신규 CLI가 implement lib(9.4k JS)을 흡수해 공식 단일 CLI가 되고, 모든 스킬이 이 CLI에 의존. hoyeon-cli는 장기 대체 대상 | P0 | user (Q1) | resolved | R#: CLI 통합, T#: lib 흡수 마이그레이션 |
| D-02 | decision | scope | v1 판단 게이트 = ① gap audit + ② 스펙 게이트 + ③ semantic verify. ④ consensus는 v2 이연 | P0 | user (Q2) | resolved | R#: 게이트 3종, non-goal: consensus |
| D-03 | decision | provider | 듀얼 judge 백엔드 (claude -p + codex exec) v1 구현. agents/config.json에서 기본 judge 지정, 미설정 시 설치 바이너리 자동 감지 | P1 | user (Q4) | resolved | R#: judge 어댑터 2종, config 스키마 |
| D-04 | fact | compatibility | interview-me 스킬 계약이 "숫자 ambiguity score를 완료 게이트로 사용 금지"를 명시 | P0 | ~/.claude/skills/interview-me/SKILL.md Core Contract | resolved | D-05가 충돌 해소 |
| D-05 | decision | scope | 숫자 ambiguity 점수 미채택(명시적 기각). 게이트 ①은 gap audit 목록 게이트: 독립 judge가 material gap 구조화 목록 반환, 빈 목록 = PASS. 체크포인트/핸드오프 직전에만 호출 | P0 | user (Q3/Q3-b) | resolved | R#: gap-audit judge, rejected: 스칼라 채점 |
| D-06 | decision | infra | TypeScript/Node, engineering-harness repo 내 cli/ 워크스페이스. 스킬과 동일 repo 버전링으로 skew 구조적 제거. 설치는 install-local-skills 경로에 CLI 빌드/링크 추가 | P1 | user (Q8, 언어는 추천 수용) | resolved | T#: cli/ 스캐폴드, 설치 스크립트 확장 |
| D-07 | decision | scope | 구현 실행(멀티턴 코딩)은 CLI 영구 비목표. 호스트 에이전트 유지, standalone run 모드 없음 | P0 | user (Q9-1) | resolved | non-goal 확정 |
| D-08 | decision | verification | mechanical verify 커맨드: agents/config.json 선언 1순위, 없으면 매니페스트(package.json/pyproject 등) 자동 감지 + config 기록 제안. ho-setup doctor가 검증 | P1 | user (Q7) | resolved | R#: config 스키마 + 감지기, V#: doctor 체크 |
| D-09 | fact | compatibility | checkshirt는 듀얼 런타임: 스킬이 Claude Code와 Codex 양쪽에서 동일 동작해야 함. CLI는 외부 바이너리라 양쪽 세션에서 호출 가능 | P0 | README.md "Dual Runtime, One Source" | resolved | 제약으로 반영 |
| D-10 | fact | compatibility | hoyeon-cli(v1.7.1) 소스는 별도 repo(~/team-attention/hoyeon/cli, TS), 구 specify/blueprint 워크플로 전용, cli-sync 훅에 버전 skew 경고 존재 | P1 | which hoyeon-cli, SessionStart hook 로그 | resolved | D-17 마이그레이션 입력 |
| D-11 | fact | compatibility | skills/implement/scripts/lib은 7,930줄 JS 21개 파일(state_store, prd_parser, reviews, rules, git 등), scripts 전체 8,040줄, repo JS 총 9,175줄 - 스킬 디렉토리 내장 배포 | P1 | 감사자 wc -l 재측정 (초기 9,393줄 수치 정정) | resolved | D-01 흡수 대상 |
| D-12 | assumption | provider | 크로스 벤더 독립성 기본값(구현 런타임과 다른 벤더를 judge로 권장)은 config 기본값 설계 시 결정 | P2 | agent default | deferred | revisit: config 스키마 확정 시 |
| D-13 | decision | workflow | 게이트 강제성: 하드 블록 + 사용자 명시 오버라이드. 에이전트는 BLOCK 우회 불가(CLI 상태머신이 다음 단계 거부), 사용자 오버라이드는 deviation으로 receipt에 기록 | P0 | user (Q5) | resolved | R#: 상태머신 게이트 규칙, AC#: 오버라이드 기록 |
| D-14 | decision | scope | tier 라우팅 v1 = CLI 자신의 judge 호출에만 적용(정책 함수 + tier→model config는 v1 구현). 구현 subagent 라우팅(route/escalation + implement 접점)은 v2 이연 | P0 | user (Q6 + 후속 확인) | resolved | non-goal: v1 구현 라우팅, revisit: v2 시 Codex 모델 오버라이드 수단 조사 |
| D-15 | decision | risk | judge 백엔드 불능 시 fail-closed: 게이트 BLOCK 유지, 명확한 에러 + 사용자 오버라이드 경로 제공 | P1 | user (Q9-2) | resolved | AC#: 불능 시나리오 |
| D-16 | decision | provider | judge 출력 방어: JSON 스키마 검증 + 1회 재시도 + 도구 차단 플래그. judge 호출 수/사용 모델을 receipt에 기록 | P1 | user (Q9-3) | resolved | AC#: 파싱 방어, receipt 필드 |
| D-17 | decision | operation | hoyeon-cli 대체는 v1 안정화 이후로 이연 (cli-sync 훅 정리 포함) | P2 | user (Q9-4) | deferred | revisit: v1 안정화 후 |
| D-18 | decision | scope | v1 스킬 접점 = interview-me(①), gen-prd(②), implement(③) 3종 개정 + please 경량 개정(D-22 게이트 재시도 루프 의미론 반영). ship은 무개정 | P1 | user (Q12, Q11 결과 반영) | resolved | R#: 스킬 개정 3종 + please 경량 |
| D-19 | decision | provider | tier→model 기본 매핑: gap audit/스펙 게이트 = frugal(haiku급), semantic verify = standard(sonnet급). config로 오버라이드 가능 | P2 | user (Q12) | resolved | config 기본값, revisit: 판정 품질 관찰 후 |
| D-20 | assumption | operation | 게이트 판정 결과물(judge 원출력, verdict, gap 목록)은 agents/ 네임스페이스 하위에 아티팩트로 저장 | P2 | agent default (기존 agents/ 관례) | resolved | AC#: 아티팩트 경로 |
| D-21 | decision | scope | 게이트 ② 계약 = 충실도 + 자체완결성. 입력: PRD + qa-log(Decision Register). 판정: (a) 모든 material 결정이 PRD에 왜곡 없이 반영(충실도), (b) AC 검증가능성 + 모호어 부재, (c) verification contract 완결성. 출력: ①과 동일한 gap 목록 포맷(빈 목록=PASS) - 게이트 3종 출력 계약 통일 | P0 | user (Q10) | resolved | R#: spec-gate judge 계약 |
| D-22 | decision | workflow | please 중 BLOCK 의미론: BLOCK은 정지가 아니라 "PASS 전 통과 불가". 에이전트가 고칠 수 있는 finding은 자율 수정→재게이트 루프, 사람 결정이 필요한 finding 또는 재시도 예산 소진 시에만 정지. D-13과 please 계약 모두 보존 | P0 | user (Q11) | resolved | R#: 게이트 재시도 루프, please 경량 개정 |
| D-23 | assumption | workflow | 게이트별 자율 수정 재시도 예산 기본값 2회(소진 시 정지·사용자 호출). config로 조정 가능 | P2 | agent default | resolved | config 기본값, revisit: 운영 관찰 후 |
| D-24 | assumption | provider | codex exec의 도구 차단/JSON 출력 플래그 동등물은 v1 구현 시 검증 필요(claude -p 대비 미확인) | P1 | 감사자 지적 | resolved | T#: codex 어댑터 스파이크, V#: 어댑터 스모크 |

## Raw Q&A

### Q1: CLI 포지셔닝
- decision_ids: D-01
- route: user-decision
- asked: 판단 전용 신규 CLI / checkshirt 단일 CLI 통합 / hoyeon-cli 확장 중 v1 경계
- recommended: 판단 전용 신규 CLI (최소 복잡도)
- answer: checkshirt 단일 CLI로 통합 - implement lib 흡수, 스킬 전부 이 CLI 의존
- immediate_notes: 사용자가 추천보다 큰 스코프 선택. 코드 섬 정리를 한 번에. 언어는 TS로 기울음(Q8에서 확정). hoyeon-cli는 장기 대체 대상(Q9-4에서 이연 확정).
- needs_normalization: false

### Q2: v1 판단 게이트 범위
- decision_ids: D-02, D-05
- route: user-decision
- asked: LLM 직접 호출 게이트를 ①ambiguity ②스펙 게이트 ③semantic verify ④consensus 중 어디까지
- recommended: ③만 (최소 리스크)
- answer: ①②③ 게이트 3종, consensus만 v2 이연
- immediate_notes: ①이 포함되며 D-04 충돌 해소 필요해짐 → Q3에서 처리.
- needs_normalization: false

### Q3 / Q3-b: ambiguity 점수의 지위
- decision_ids: D-04, D-05
- route: mixed (분석 제시 후 user-decision)
- asked: 숫자 게이트 vs 대안. 사용자가 "점수화 꼭 해야 하나?"로 반문 → 스칼라 점수의 문제(보정 안 됨, gap 은닉, Goodhart, headless 전제 부재) 분석 제시
- recommended: gap audit 목록 게이트
- answer: gap audit 목록 게이트 채택
- immediate_notes: ouroboros 스칼라 채점의 의도적 기각. 근거: LLM 스칼라는 미보정(0.19 vs 0.22 무의미), 점수는 gap을 은닉, Goodhart 위험, ouroboros의 점수는 headless 자율 인터뷰 전제인데 checkshirt는 human-in-the-loop. gap 목록은 이진 판정(빈 목록=PASS)이라 기계 검증성 동일하면서 출력이 곧 다음 질문 후보.
- needs_normalization: false

### Q4: judge 백엔드 구성
- decision_ids: D-03, D-12
- route: user-decision
- asked: claude -p 단독 / 듀얼 백엔드 + 설정 / 호스트 런타임 따라가기
- recommended: 듀얼 백엔드 + 설정 우선순위
- answer: 듀얼 백엔드 + 설정 우선순위 채택
- immediate_notes: claude 구독 + ChatGPT 플랜 둘 다 보유. 어댑터 인터페이스 동일(one-shot judge). v2 consensus의 토대. 크로스 벤더 독립성 기본값은 D-12로 이연.
- needs_normalization: false

### Q5: 게이트 강제성
- decision_ids: D-13
- route: user-decision
- asked: BLOCK 시 하드 블록+사용자 오버라이드 / 소프트 블록 / 게이트별 차등
- recommended: 하드 블록 + 사용자 오버라이드 (deviation 기록)
- answer: 하드 블록 + 사용자 오버라이드 채택
- immediate_notes: CLI가 단계 전이를 소유하는 상태머신이어야 강제 가능 → D-01(state_store 흡수)과 정합. reward hacking 차단이 근거.
- needs_normalization: false

### Q6: tier 라우팅 v1 스코프
- decision_ids: D-14
- route: mixed (implement 라우팅 동작 방식 설명 후 user-decision)
- asked: judge 호출에만 v1 / 구현 subagent 라우팅까지 v1 / 전체 v2
- recommended: judge 호출에만 v1
- answer: "우선 v1까지만 가보자" - judge 호출에만 v1 적용 확정
- immediate_notes: 사용자가 implement 라우팅 동작(route→model 적용→verify 실패→escalation 왕복) 설명을 요청해 이해 후 결정. v2 선행 조건: implement 스킬 route 접점 + Codex 세션 task별 모델 오버라이드 수단 조사(enforced vs advised 격차).
- needs_normalization: false

### Q7: mechanical verify 커맨드 소스
- decision_ids: D-08
- route: user-decision
- asked: config 선언+자동감지 폴백 / config 필수 / PRD verification contract 추출
- recommended: config 선언 + 자동감지 폴백
- answer: config 선언 + 자동감지 폴백 채택
- immediate_notes: PRD 추출안은 LLM이 쓴 문서의 커맨드를 실행하는 리스크로 비추천. ho-setup doctor 검증 접점 추가.
- needs_normalization: false

### Q8: CLI 거주지/배포/언어
- decision_ids: D-06
- route: user-decision
- asked: 이 repo cli/ 워크스페이스 / 별도 repo+npm / hoyeon-cli repo 합류. 언어는 TS 추천 명시
- recommended: 이 repo cli/ 워크스페이스, TS
- answer: 이 repo cli/ 워크스페이스 채택 (TS 추천에 이의 없음)
- immediate_notes: 스킬↔CLI 동일 repo 버전링으로 skew 구조적 제거. cli-sync류 원격 업데이트 문제 재발 방지.
- needs_normalization: false

### Q9: 기본값 배치 (4종)
- decision_ids: D-07, D-15, D-16, D-17
- route: user-decision (배치 확인)
- asked: ①구현 실행 영구 비목표 ②judge 불능 시 fail-closed ③출력 방어+receipt 기록 ④hoyeon-cli 대체 이연
- recommended: 전부 채택
- answer: 쉬운 설명 요청 후 "어어 맞다" - 전부 채택
- immediate_notes: 한 줄 합의: "CLI는 심판 전용이고, 확신 없으면 멈추고, 뭘 했는지 다 기록하고, 옛날 것 청소는 나중에."
- needs_normalization: false

### Q10: 게이트 ② 스펙 게이트 계약 (감사 blocking)
- decision_ids: D-21
- route: user-decision
- asked: 충실도+자체완결성 / PRD 단독 자체완결성 / 기존 gen-prd 자체점검 유지
- recommended: 충실도 + 자체완결성
- answer: 충실도 + 자체완결성 채택
- immediate_notes: 최종 감사자가 "게이트 ②는 이름뿐"을 최고 리스크 blocker로 지적해 발생한 질문. 게이트 3종 출력 계약(gap 목록) 통일이 부수 확정.
- needs_normalization: false

### Q11: please 자율 실행과 하드 블록의 충돌 (감사 blocking)
- decision_ids: D-22, D-23
- route: user-decision
- asked: 수정 재시도 후 진짜만 정지 / please 자동 오버라이드 / 무조건 정지
- recommended: 수정 재시도 후 진짜만 정지
- answer: 수정 재시도 후 진짜만 정지 채택
- immediate_notes: BLOCK을 "정지"가 아닌 "PASS 전 통과 불가"로 재정의. 에이전트 수정→재게이트는 우회가 아님(D-13 보존). please의 "안 멈춤" 계약도 보존. 재시도 예산 기본 2회(D-23, agent default).
- needs_normalization: false

### Q12: 미확인 기본값 일괄 확인 (감사 지적)
- decision_ids: D-18, D-19
- route: user-decision (배치 확인)
- asked: v1 스킬 개정 3종 + ship/please 무개정, tier 기본 매핑(게이트①②=haiku급, ③=sonnet급)
- recommended: 맞다
- answer: "맞다" + "ㅇㅇㅇ" 재확인. 단 Q11 결과로 please 경량 개정이 추가됨(D-18 갱신)
- immediate_notes: agent default였던 D-18/D-19가 user 확인으로 승격.
- needs_normalization: false

## UX Scenario Cards

### UX-01: 인터뷰 핸드오프 gap audit (게이트 ①)
- trigger: interview-me가 closure에 도달해 prd-handoff 작성 직전, 스킬이 `cli gate gap-audit <qa-log>` 호출
- happy path: judge가 빈 gap 목록 반환 → PASS 기록 → 스킬이 handoff 작성 진행. 사용자는 "gap audit 통과" 한 줄만 봄
- state / failure: material gap 목록과 함께 BLOCK → 스킬이 gap을 다음 질문 후보로 변환해 사용자에게 제시. judge 백엔드 불능 시 명확한 에러 + 오버라이드 안내(D-15)
- recovery: 사용자가 gap에 답하면 재audit, 또는 명시적 오버라이드(deviation 기록) 후 진행
- proof: E2E - gap이 있는 qa-log 픽스처로 BLOCK, 보완 후 PASS 시나리오 자동화
- linked decisions: D-02, D-05, D-13, D-15

### UX-02: implement 검증 흐름 (게이트 ③)
- trigger: implement가 task diff 제출, 스킬이 `cli verify <task>` 호출
- happy path: mechanical(테스트/린트) PASS → semantic judge PASS → 다음 task 전이 허용. 사용된 judge 모델/호출 수가 receipt에 누적
- state / failure: mechanical FAIL 시 semantic 없이 즉시 FAIL(비용 절약, 실행 로그 표시). semantic FAIL 시 AC별 판정 근거 표시. CLI 상태머신이 다음 단계 전이 거부(D-13)
- recovery: 에이전트 수정 후 재제출, 또는 사용자 오버라이드(deviation 기록)
- proof: E2E - 의도적 테스트 실패 diff로 mechanical FAIL, AC 미충족 diff로 semantic FAIL, 정상 diff로 PASS
- linked decisions: D-02, D-08, D-13, D-16, D-19

### UX-03: judge 백엔드 불능
- trigger: claude/codex 바이너리 없음, 인증 만료, 또는 판정 출력이 스키마 검증 2회 실패
- happy path: n/a (예외 흐름)
- state / failure: 게이트는 BLOCK 유지(fail-closed). 원인(바이너리/인증/파싱)과 해결 방법, 오버라이드 명령을 명시한 에러 출력
- recovery: 백엔드 복구 후 재시도, 또는 사용자 오버라이드
- proof: 유닛테스트 - 바이너리 부재/비정상 출력 모킹으로 fail-closed 확인
- linked decisions: D-15, D-16

### UX-04: gen-prd 스펙 게이트 (게이트 ②)
- trigger: gen-prd가 PRD 초안 완성 후 `cli gate spec <prd> <qa-log>` 호출
- happy path: judge가 빈 gap 목록 반환 → PASS → PRD가 human_approval 단계로 진행
- state / failure: 충실도 위반(누락/왜곡된 결정), 검증 불가 AC, 모호어, verification contract 공백이 gap 목록으로 BLOCK. 에이전트가 finding별로 PRD를 보완 후 재게이트 (please 중에는 D-22 루프)
- recovery: 재시도 예산(기본 2회) 소진 또는 사람 결정 필요 finding 시 정지, 사용자에게 gap 목록 제시. 사용자 오버라이드 시 deviation 기록
- proof: E2E - 결정 하나를 의도적으로 누락한 PRD 픽스처로 BLOCK, 보완 후 PASS
- linked decisions: D-21, D-22, D-13, D-19

### UX-05: 사용자 오버라이드 흐름 (게이트 공통)
- trigger: 게이트 BLOCK 상태에서 사용자가 진행을 원함
- happy path: 사용자가 명시적 오버라이드 명령(예: `cli gate override <gate-id> --reason "..."`) 실행 → 사유와 함께 deviation이 상태/receipt에 기록 → 상태머신이 다음 단계 전이 허용
- state / failure: 에이전트가 오버라이드 명령을 대신 실행하는 것은 금지(스킬 계약에 명시). 사유 미기재 시 거부
- recovery: n/a (오버라이드 자체가 복구 경로)
- proof: 유닛테스트 - 오버라이드 후 전이 허용 + deviation 레코드 존재 확인. 스킬 문서에 에이전트 대행 금지 명문화
- linked decisions: D-13, D-15

## Evidence From Code, Docs, Or Research

- checkshirt README: "One PRD pipeline, two runtimes" - 모든 스킬/스크립트가 Codex와 Claude Code 양쪽을 서빙 (README.md)
- interview-me 계약: "Do not use a numeric ambiguity score as a completion gate" (~/.claude/skills/interview-me/SKILL.md Core Contract)
- ouroboros 분석 (이 세션 앞부분, scratchpad 클론): 전체 219k LOC 중 핵심 개념 ~7k. model_routing.py 537줄 순수 정책(frugal/standard/frontier 사다리, 실패 시 1단 승급), evaluation 3단계(mechanical $0 → semantic → consensus 트리거식), ambiguity = 1 - Σ(clarity×weight) 스칼라 게이트(기각됨), reviewer_independence.py의 독립 리뷰어 개념(채택됨)
- hoyeon-cli --help: req/plan/learning/issue/session 그룹, "cli does not parse .md" 철학. 소스 ~/team-attention/hoyeon/cli/dist/cli.js
- skills/implement/scripts/lib: 9,393줄 JS - state_store, state_data, prd_parser, reviews, rules, git, planning, hooks, artifacts, render 등
- SessionStart 훅 로그: "[cli-sync] Failed to update hoyeon-cli to 1.6.0 (current: 1.7.1)" - 버전 skew 실증

## Documented Domain Checks

- docs inspected: README.md, skills/*/SKILL.md, ouroboros README/architecture/소스
- canonical terms: 판단(judgment) vs 실행(execution), 게이트(gate), gap audit, receipt, deviation, TaskGraph, review_profile, tier(frugal/standard/frontier), enforced vs advised
- glossary or code conflicts: interview-me의 숫자 게이트 금지 조항 → gap audit 목록 게이트로 해소(D-05). "judge"는 신규 도입 용어로 PRD에서 정의 필요
- concrete scenarios tested: UX-01~03 시나리오로 게이트 3종 + 불능 경로 커버
- docs mutation: 없음 (PRD 단계에서 README 스킬 표에 CLI 행 추가 필요할 것)
- ADR candidate: "CLI LLM 호출은 one-shot 판단에 한정, 실행 오케스트레이션 영구 비목표" (D-07)

## Checkpoint And Sweep History

### Checkpoint 1
- after_question: Q9
- normalized_entries: Q1~Q9 전체 (outstanding 0)
- register_changes: D-01~D-20 확정 (resolved 17, deferred 2: D-12/D-17, 전부 P2)
- reopened_decisions: 없음
- highest_remaining_gap: 없음 (P0/P1 전부 resolved)

### Sweep 1
- trigger: Q5 이후 (material 결정 5개 도달)
- intent_drift: 없음 - "단순한 CLI + 판단 경계"라는 원 의도 유지
- impact_gap: tier 라우팅 스코프 미결 → Q6으로 해소
- verification_gap: mechanical verify 커맨드 소스 미결 → Q7로 해소
- next_action: Q6 진행

### Sweep 2
- trigger: Q9 이후 closure 진입 전
- intent_drift: 없음. 통합 스코프(D-01)가 커졌으나 사용자가 명시 선택
- impact_gap: 스킬 접점 범위가 암묵적 → D-18 assumption으로 명시(3종 스킬 개정). tier→model 매핑 → D-19 기본값
- verification_gap: 게이트별 proof를 UX 카드에 명시 완료
- next_action: 검증기 + 최종 감사 + 한 줄 목표 확인

### Sweep 3
- trigger: Audit 1 fail 후 Q10~Q12 해소
- intent_drift: 없음
- impact_gap: 게이트 ② 계약(D-21), please 충돌(D-22) 해소. D-11 줄 수 정정
- verification_gap: UX-04/UX-05 카드 추가, D-24(codex 플래그 검증)를 v1 태스크로 명시
- next_action: 최종 정규화 + 검증기 재실행 + 핸드오프

## Audit History

### Audit 1
- type: final-auditor (독립 subagent, repo 검증 포함)
- result: fail
- missing decision_ids: 게이트 ② 계약(→D-21), please×하드블록 충돌(→D-22), lib 흡수 방식(→PRD 기술구조 결정으로 이관)
- unsupported assumptions: D-11 줄 수 부정확(→7,930으로 정정), D-16 codex 플래그 미검증(→D-24), D-18/19/20 미확인 기본값(→Q12 user 확인)
- UX or behavior gap: 게이트 ② 카드 부재(→UX-04), 오버라이드 흐름 미카드(→UX-05)
- highest-risk blocker: 게이트 ②가 이름뿐 - Q10으로 해소
- final-blocking-question: Q10/Q11로 분해해 사용자에게 질의, 전부 답변됨
- handoff impact: blocker 전부 해소, 핸드오프 진행 가능

### Audit 2
- type: local (Audit 1 지적사항 해소 확인)
- result: pass
- missing decision_ids: 없음 (P0/P1 전부 resolved 또는 revisit 트리거 있는 deferred)
- unsupported assumptions: 없음 (D-23은 P2 agent default로 기록, D-24는 v1 검증 태스크화)
- UX or behavior gap: 게이트 3종 + 불능 + 오버라이드 5개 카드 완비
- highest-risk blocker: 없음
- final-blocking-question: none
- handoff impact: ready
