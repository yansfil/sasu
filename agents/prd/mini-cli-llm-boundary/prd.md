---
topic: "checkshirt 단일 CLI - LLM judge 게이트"
status: "ready"
human_approval: "approved"
review_profile: "standard"
review_rationale: "프로덕션 데이터/인증/외부 과금 경계는 건드리지 않으나, 구현 파이프라인의 상태·게이트 도구를 재구성하므로 하네스 회귀 위험이 있는 표준 엔지니어링 변경이다."
source_intake: "agents/intake/mini-cli-llm-boundary/qa-log.md"
source_clarity: "none"
created_at: "2026-07-16"
updated_at: "2026-07-16"
---

# PRD: checkshirt 단일 CLI - LLM judge 게이트

## 1. Summary

checkshirt 하네스에 공식 단일 TypeScript CLI를 신설한다.
CLI는 기존 implement 내장 lib(7,930줄 JS)을 흡수해 상태머신, 게이트, 검증 실행, receipt를 소유한다.
LLM은 headless one-shot 판단 호출(claude -p / codex exec)에만 사용하며, CLI는 심판 전용 도구다.
v1 게이트 3종을 도입한다: ① gap audit(인터뷰 closure), ② 스펙 게이트(PRD 충실도+자체완결성), ③ semantic verify(mechanical 선행 후 diff vs AC 판정).
게이트는 하드 블록이며 사용자 오버라이드만 해제 가능하고, 모든 판정과 deviation이 기록된다.
스킬 interview-me, gen-prd, implement가 게이트 지점에서 CLI를 호출하도록 개정하고, please는 게이트 재시도 루프 의미론만 경량 반영한다.

Approval checklist:

- 통합 스코프: 신규 CLI가 implement lib을 흡수해 단일 CLI가 되고 스킬 3종 + please 경량 개정이 포함된다 (§3, §5).
- 게이트 3종 계약과 하드 블록/사용자 오버라이드/deviation 기록 의미론 (§6 R3-R6, §7 AC4-AC8).
- 영구 비목표(구현 실행)와 v2 이연(consensus, 구현 subagent 라우팅, hoyeon-cli 대체) (§3).
- judge 듀얼 백엔드(claude/codex), fail-closed, 출력 방어, receipt 기록 (§6 R2, R6).
- tier→model 기본 매핑(게이트 ①②=frugal, ③=standard)과 재시도 예산 기본 2회 (§6 R7).
- CLI 바이너리 이름 결정 (§4.2).
- 검증 모드에 실제 judge 백엔드 스모크(구독 토큰 소모) 포함 (§9.1).

## 2. Problem, Goal, And Users

사용자는 이 하네스의 소유자이자 단독 사용자인 호연님과, 하네스 스킬을 실행하는 코딩 에이전트(Claude Code, Codex)다.

문제:

- 하네스 엔지니어링 도구가 복잡해지고 있다.
  결정적 로직(상태 전이, 게이트 판정, PRD 파싱, 검증 실행)이 스킬 프롬프트와 스킬 디렉토리 내장 JS(7,930줄)에 흩어져 있어 테스트와 버전 관리가 어렵다.
- 검증 판단을 구현한 에이전트 자신이 수행해 self-verification bias가 있다.
- 코드 섬이 3개다: hoyeon-cli(구 워크플로), implement 내장 lib, 스킬 프롬프트.
  cli-sync 버전 skew 경고가 이 구조의 실패 모드를 실증하고 있다.

목표:

- ouroboros 분석에서 검증한 강점(독립 판정, mechanical-first 검증, gap 목록 게이트)을 단순한 단일 CLI로 이식한다.
- 스킬은 얇은 오케스트레이션 프롬프트로, CLI는 테스트 가능한 결정 로직으로 역할을 분리한다.
- 판정은 구현 컨텍스트와 격리된 신선한 judge가 수행해 리뷰어 독립성을 확보한다.

## 3. Scope And Non-Goals

포함:

- `cli/` TypeScript 워크스페이스 신설과 단일 바이너리 빌드/설치.
- judge 어댑터 2종(claude -p, codex exec)과 공통 one-shot 판정 인터페이스.
- 게이트 3종(gap audit, spec, verify)과 통일된 gap 목록 출력 계약.
- 게이트 상태머신: 하드 블록, 사용자 오버라이드(사유 필수), deviation 기록, fail-closed.
- mechanical verify 실행기(config 선언 1순위, 매니페스트 자동 감지 폴백).
- tier→model config와 judge 호출 receipt 기록.
- implement 내장 lib의 CLI 흡수와 스킬 개정(interview-me, gen-prd, implement, please 경량).
- ho-setup doctor 확장(judge 바이너리/인증, verify 커맨드, 버전 계약 진단).

명시적 비목표(v2 이연, revisit: v1 안정화 후):

- ④ multi-model consensus 게이트.
  사용자 결과: 경계선 판정의 크로스 벤더 재확인이 없다.
  근거: v1 검증 부담 최소화(D-02).
- 구현 subagent tier 라우팅(route/escalation의 implement 접점).
  사용자 결과: 구현 작업의 모델 자동 승급이 없다.
  근거: implement 스킬 접점 + Codex 세션 모델 오버라이드 수단(enforced vs advised) 조사가 선행 필요(D-14).
- hoyeon-cli 대체와 cli-sync 훅 정리(D-17).

영구 비목표:

- CLI의 구현 실행(멀티턴 코딩)과 standalone run 모드(D-07).
  근거: 실행 오케스트레이션은 ouroboros orchestrator(57k LOC)급 복잡도를 상속한다.
  구현은 호스트 에이전트가 유지한다.
- 숫자 ambiguity 점수 게이트(D-05 기각).
  interview-me의 "숫자 게이트 금지" 계약은 유지된다.

## 4. Pre-Work And Required Decisions

### 4.1 Pre-Work Before Implementation

None required.
judge 백엔드가 사용하는 claude/codex 바이너리와 구독 인증이 이 머신에 이미 존재함을 인터뷰에서 확인했다.

### 4.2 Human Decisions Before PRD Approval

전 항목 승인됨 (2026-07-16, 사용자 발언 "음 그렇게 하자!" - Approval checklist와 사람 결정 3건 제시에 대한 직접 응답):

- CLI 바이너리 이름: `checkshirt` (추천 수용).
- 실제 judge 백엔드 스모크(V4)의 구독 토큰 소모: 승인.
- lib 흡수 방식: incremental wrap 승인 - `cli/`가 기존 lib 모듈을 이동·재수출하고 기존 테스트를 그대로 통과시킨 뒤, 스킬 진입점을 CLI 커맨드로 전환한다.
  rewrite cutover는 회귀면이 넓어 기각.

### 4.3 Decision Traceability For Fidelity Review

- D-01 (user Q1): checkshirt 단일 CLI 통합, implement lib 흡수 → R1, R8, T1, T9. 추천(판단 전용 최소 CLI)보다 큰 스코프를 사용자가 명시 선택.
- D-02 (user Q2): v1 게이트 = ①②③, consensus는 v2 → R3-R5, non-goal.
- D-04 (fact): interview-me의 숫자 게이트 금지 조항 → 게이트 ① 설계 제약, 계약 유지.
- D-05 (user Q3/Q3-b): 숫자 ambiguity 점수 명시 기각, gap 목록 게이트 채택 → R3, rejected option. 기각 근거: LLM 스칼라 미보정, gap 은닉, Goodhart 위험, headless 전제 부재.
- D-03 (user Q4): 듀얼 judge 백엔드 + config 우선순위 → R2, R7.
- D-13 (user Q5): 하드 블록 + 사용자 오버라이드(deviation 기록), 소프트 블록 기각(reward hacking 경로) → R6, AC7.
- D-14 (user Q6 + "우선 v1까지만 가보자"): tier 라우팅은 judge 호출에만 v1 적용 → R7, non-goal(구현 라우팅).
- D-08 (user Q7): verify 커맨드 = config 선언 1순위 + 매니페스트 자동 감지 폴백. PRD 문서에서 커맨드 추출안 기각(LLM 작성 문서의 커맨드 실행 리스크) → R5, AC14.
- D-06 (user Q8): 이 repo `cli/` 워크스페이스, TS. 별도 repo와 hoyeon-cli 합류 기각 → R1, T1.
- D-07 (user Q9-1): 구현 실행 영구 비목표 → non-goal, guardrail.
- D-15 (user Q9-2): judge 불능 시 fail-closed → R6, AC8.
- D-16 (user Q9-3): 출력 방어(스키마 검증 + 1회 재시도 + 도구 차단) + judge 호출 수/모델 receipt 기록 → R2, AC2, AC9.
- D-17 (user Q9-4): hoyeon-cli 대체 이연 → non-goal, guardrail.
- D-21 (user Q10): 게이트 ② = 충실도(PRD+qa-log 대조) + 자체완결성(AC 검증가능성, 모호어, verification contract). PRD 단독 판정안과 기존 자체점검 유지안 기각 → R4, AC5.
- D-22 (user Q11): please 중 BLOCK = 자율 수정→재게이트 루프, 사람 결정 finding 또는 예산 소진 시에만 정지. 자동 오버라이드안과 무조건 정지안 기각 → R6, R9, AC12.
- D-18 (user Q12): 스킬 개정 범위 = interview-me, gen-prd, implement + please 경량. ship 무개정 → R9, T10.
- D-19 (user Q12): tier 기본 매핑 = 게이트 ①② frugal(haiku급), ③ standard(sonnet급) → R7, AC10.
- D-09 (fact): 듀얼 런타임 제약 - CLI는 외부 바이너리로 양쪽 세션에서 호출 → 제약, guardrail.
- D-10 (fact): hoyeon-cli는 별도 repo(~/team-attention/hoyeon/cli) 소스이며 구 워크플로 전용, cli-sync 버전 skew 경고 실증 → context-only fact, D-17 이연 결정과 guardrail의 입력.
- D-11 (fact, 감사 정정): lib 실측 7,930줄 21개 파일 → R8 컨텍스트.
- D-12 (assumption, deferred): 크로스 벤더 judge 독립성 기본값은 config 설계 시 결정 → 이연 결정, T8에서 처리.
- D-20 (assumption): 게이트 아티팩트는 agents/ 네임스페이스 하위 저장 → AC9, 아티팩트 경로.
- D-23 (assumption): 게이트별 자율 수정 재시도 예산 기본 2회, config 조정 가능 → R7, AC12. agent default임을 유지.
- D-24 (감사자 지적): codex exec의 도구 차단/JSON 출력 플래그 동등물 미검증 → T3 스파이크, V4.

### Delivery

이 작업의 산출물은 이 repo의 코드/스킬 변경이며 사용자가 PR 자동화를 요청하지 않았다.
delivery mode: local (기본).
ship 관련 자동화는 스코프 밖이다.

## 5. Major Technical Structure Changes

- `cli/` TypeScript 워크스페이스 신설.
  스킬과 동일 repo 버전링으로 스킬↔CLI 버전 skew를 구조적으로 제거한다.
  설치는 기존 install-local-skills 경로에 CLI 빌드/링크를 통합한다.
- `skills/implement/scripts/lib`(7,930줄) 소멸 → `cli/`로 흡수.
  스킬 디렉토리에는 프롬프트와 얇은 진입점만 남는다.
- 게이트 상태머신 도입: 게이트 판정이 단계 전이를 소유하며, 스킬은 전이를 CLI에 위임한다.
- judge 어댑터 경계 신설: one-shot 판정 전용, 도구 차단, 스키마 검증.
  구현 실행 경계는 만들지 않는다.
- 게이트 3종의 출력 계약 통일(gap 목록 JSON)로 judge 프롬프트/파서를 공용화한다.

## 6. Requirements

- R1. `cli/` 워크스페이스(TS)를 신설하고 단일 바이너리로 빌드한다.
  install-local-skills 실행 시 CLI가 함께 빌드/링크되고, `--contract-version`으로 스킬이 버전 계약을 확인할 수 있다.
- R2. judge 어댑터 2종(claude -p, codex exec)을 공통 인터페이스 `judge(prompt, tier) → JSON`으로 구현한다.
  도구 차단 플래그 적용, 출력 JSON 스키마 검증, 실패 시 1회 재시도, 2회 실패 시 typed error.
  모든 호출의 백엔드/모델/횟수를 기록한다.
- R3. 게이트 ① `gate gap-audit`: qa-log를 입력으로 material gap 구조화 목록을 반환한다.
  빈 목록 = PASS.
  숫자 점수는 출력에 포함하지 않는다.
- R4. 게이트 ② `gate spec`: PRD + qa-log(Decision Register)를 입력으로 (a) 결정 충실도, (b) AC 검증가능성과 모호어 부재, (c) verification contract 완결성을 판정해 gap 목록을 반환한다.
- R5. 게이트 ③ `verify`: mechanical(테스트/린트/빌드) 선행 실행 후 PASS 시에만 semantic judge(diff + AC → AC별 verdict와 근거)를 호출한다.
  mechanical 커맨드는 agents/config.json 선언이 1순위, 없으면 매니페스트 자동 감지 후 config 기록을 제안한다.
- R6. 게이트 상태머신: BLOCK 시 다음 단계 전이를 거부한다(하드 블록).
  사용자 오버라이드 커맨드(사유 필수)만 해제할 수 있고 deviation으로 기록된다.
  judge 불능(바이너리 부재, 인증 만료, 스키마 2회 실패) 시 fail-closed로 BLOCK을 유지하고 원인과 복구/오버라이드 경로를 명시한 에러를 낸다.
  에이전트가 고칠 수 있는 finding은 수정→재게이트 루프를 허용하며 이는 우회가 아니다.
- R7. config: judge 백엔드 선택, tier→model 매핑(기본: 게이트 ①②=frugal/haiku급, ③=standard/sonnet급), 재시도 예산(기본 2회)을 agents/config.json에서 오버라이드할 수 있다.
  크로스 벤더 독립성 기본값(D-12)은 config 스키마 설계 시 확정해 문서화한다.
- R8. implement lib 흡수: state_store, prd_parser, reviews, rules 등 기존 lib 모듈을 `cli/`로 이동하고, 기존 회귀 테스트(golden 포함)가 계속 통과한다.
  기존 `agents/implement/*` 상태 파일과의 하위호환을 유지한다.
- R9. 스킬 개정: interview-me(체크포인트/핸드오프 직전 R3 호출), gen-prd(ready 전 R4 호출), implement(task 제출 시 R5/R6 경유), please(R6의 재시도 루프와 정지 조건 반영).
  ship은 개정하지 않는다.
  스킬 문서에 "에이전트의 오버라이드 대행 금지"를 명문화한다.
- R10. ho-setup doctor 확장: judge 바이너리/인증 상태, verify 커맨드 설정 유무, CLI 버전 계약을 진단한다.

## 7. Acceptance Criteria

- AC1. `cli/` 빌드가 성공하고 install-local-skills 경로로 바이너리가 설치되며 `--contract-version`이 버전을 출력한다.
- AC2. claude judge 어댑터가 one-shot 판정을 스키마 검증된 JSON으로 반환하고, 비정상 출력 시 정확히 1회 재시도 후 typed error를 낸다.
- AC3. codex judge 어댑터가 동일 인터페이스 계약을 만족한다(도구 차단/JSON 출력 동등물 스파이크 포함).
- AC4. gap이 있는 qa-log 픽스처에 `gate gap-audit`이 비어 있지 않은 gap 목록과 BLOCK을, 완결된 픽스처에 PASS를 반환한다.
- AC5. Decision Register 결정 하나를 의도적으로 누락한 PRD 픽스처에 `gate spec`이 충실도 gap을 포함한 BLOCK을, 보완된 픽스처에 PASS를 반환한다.
- AC6. `verify`가 테스트 실패 diff에 semantic 호출 없이 mechanical FAIL을, mechanical 통과 + AC 미충족 diff에 AC별 근거를 포함한 semantic FAIL을, 정상 diff에 PASS를 반환한다.
- AC7. BLOCK 상태에서 다음 단계 전이 커맨드가 거부되고, `--reason` 있는 오버라이드만 해제하며 deviation 레코드가 남고, 사유 없는 오버라이드는 거부된다.
- AC8. judge 바이너리 부재/비정상 출력 모킹 시 게이트가 BLOCK을 유지하며(fail-closed) 에러에 원인과 오버라이드 경로가 포함된다.
- AC9. receipt와 agents/ 하위 게이트 아티팩트에 judge 호출 수, 사용 백엔드/모델, deviation이 기록된다.
- AC10. tier→model 기본 매핑이 문서화된 기본값으로 동작하고 agents/config.json으로 오버라이드된다.
- AC11. lib 흡수 후 기존 회귀 테스트 전체(golden 포함)가 통과하고, 기존 `agents/implement/*` 상태 파일을 읽는 하위호환이 유지된다.
- AC12. 재시도 예산(기본 2회) 내 수정→재게이트 루프가 동작하고, 예산 소진 시 정지 상태와 안내가 남는다.
- AC13. doctor가 judge 바이너리/인증, verify 커맨드 설정, 버전 계약 상태를 진단 결과로 출력한다.
- AC14. verify 커맨드가 config 선언 시 그것을 사용하고, 미선언 시 매니페스트에서 감지해 config 기록을 제안한다.

## 8. PRD-Level Tasks

- T1. `cli/` 워크스페이스 스캐폴드, 빌드, install-local-skills 통합, `--contract-version`. Covers R1, AC1.
- T2. judge 공통 인터페이스 + claude -p 어댑터(도구 차단, 스키마 검증, 재시도, 기록). Covers R2, AC2.
- T3. codex exec 플래그 동등물 스파이크 + codex 어댑터. Covers R2, AC3.
- T4. 게이트 엔진: gap 목록 스키마, 상태머신(하드 블록/오버라이드/deviation), fail-closed, 재시도 루프. Covers R6, AC7, AC8, AC12.
- T5. `gate gap-audit` 커맨드와 judge 프롬프트. Covers R3, AC4.
- T6. `gate spec` 커맨드와 judge 프롬프트. Covers R4, AC5.
- T7. `verify` 커맨드: mechanical 실행기(config/감지) + semantic judge. Covers R5, AC6, AC14.
- T8. config 스키마: judge 선택, tier 매핑, 재시도 예산, 크로스 벤더 기본값(D-12) 확정. Covers R7, AC10.
- T9. lib 흡수 마이그레이션(incremental wrap) + 기존 테스트 이관 + 상태 파일 하위호환. Covers R8, AC11.
- T10. 스킬 개정 4종(interview-me, gen-prd, implement, please 경량) + 오버라이드 대행 금지 명문화. Covers R9, AC7 연계.
- T11. ho-setup doctor 확장. Covers R10, AC13.
- T12. cli/ 테스트 하네스와 게이트 픽스처(qa-log/PRD/diff) 구축. 순수 검증 태스크. Covers AC4-AC6 기반.

## 9. Verification Contract

### 9.1 Test Mode Contract

| Mode | Required For Done | Covers | Human Decision |
| --- | --- | --- | --- |
| build/static | yes | cli 빌드/타입체크와 repo 기존 테스트 건강 | none |
| automated behavior | yes | 게이트 엔진, 어댑터 방어, 흡수 회귀 (stub judge 사용) | none |
| live judge CLI | yes | 실제 claude -p / codex exec 계약 (구독 토큰 소모, 로컬 전용) | 토큰 소모 승인 (§4.2) |
| human calibration | no/blockable | 게이트 ② 판정 품질, please 문구, 네이밍 | 사용자 판단 |

### 9.2 Required Agent Verification

커맨드는 T1/T12가 만드는 `cli/` 워크스페이스 스크립트 기준의 계획 커맨드다.
구현 중 이름이 바뀌면 동등한 커맨드로 기록하고 receipt에 반영한다.

| ID | Mode | Covers | Method | Artifact | Pass Criteria | Environment | Required For Done | Can Be Blocked | Safe Probe | Side Effect | Sensitive Data Policy |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| V1 | build/static | R1, AC1 | `pnpm -C cli build && pnpm -C cli typecheck && node scripts/install-local-skills.mjs && checkshirt --contract-version` | command-log | 모든 커맨드 exit 0, contract-version이 semver 출력 | local shell | yes | no | none | none | no secrets |
| V2 | automated behavior | R2, R6, AC2, AC7, AC8, AC12 | `pnpm -C cli test` (유닛: 어댑터 스키마/재시도/typed error, 상태머신 하드블록/오버라이드/deviation, fail-closed, 재시도 예산) | command-log | 테스트 전부 통과 | local shell | yes | no | none | none | no secrets |
| V3 | automated behavior | R3-R5, AC4-AC6, AC14 | `pnpm -C cli test:e2e` (stub judge + qa-log/PRD/diff 픽스처로 게이트 3종 BLOCK/PASS 분기, mechanical 선행, config/감지 분기) | command-log + agents/ 하위 게이트 아티팩트 | E2E 전부 통과, BLOCK/PASS 분기가 픽스처 기대와 일치 | local shell | yes | no | stub judge라 외부 호출 없음 | none | no secrets |
| V4 | live judge CLI | R2, AC2, AC3 | `pnpm -C cli test:smoke` (실제 claude -p 1콜 + codex exec 1콜, 최소 판정 프롬프트) | command-log (사용 백엔드/모델/토큰 기록 포함) | 두 백엔드 모두 스키마 유효 JSON 반환 | local shell (구독 인증 필요) | yes | no | 최소 고정 판정 프롬프트 1콜/백엔드, 도구 차단으로 비변경성 보장 | 구독 토큰 소모만 (§4.2 승인) | 프롬프트에 시크릿/자격증명 미포함, 로그에 토큰 수만 기록 |
| V5 | automated behavior | R8, AC11 | `node --test tests/` (기존 회귀 스위트, golden 포함, 흡수된 lib 경로 대상) | command-log | 기존 테스트 전부 통과 | local shell | yes | no | none | none | no secrets |
| V6 | automated behavior | R7, AC9, AC10 | `pnpm -C cli test -- --grep "receipt|tier-config"` (receipt/아티팩트 필드, tier 기본값/오버라이드) | command-log | 해당 테스트 전부 통과 | local shell | yes | no | none | none | no secrets |
| V7 | automated behavior | R9, R10, AC13 | `node --test tests/implement_skill_structure.test.mjs` 확장분 + `checkshirt doctor` 실행 | command-log + doctor 출력 캡처 | 구조 테스트 통과, doctor가 judge/verify/버전 3개 진단 섹션 출력 | local shell | yes | no | doctor는 읽기 전용 진단 | none | no secrets |
| V8 | human calibration | R4, AC5 | 첫 실사용 런의 `gate spec` gap 목록을 사용자가 검토하고 오탐/미탐 메모 | agents/implement/mini-cli-llm-boundary/artifacts/gate-spec-calibration.md | 사용자 검토 메모가 아티팩트로 존재 | 사용자 세션 | no | yes | none | none | no secrets |

### 9.3 Human Verification

- 게이트 ② 충실도 판정 품질의 초기 캘리브레이션(V8): 첫 실사용에서 gap 목록이 실제 결함을 짚는지 사용자 검토.
- please 경량 개정 문구가 "안 멈춤" 철학을 훼손하지 않는지 검토.
- CLI 바이너리 이름과 커맨드 네이밍 taste 승인(§4.2와 연동).

## 10. Risks And Open Decisions

- lib 흡수(T9)가 최대 회귀 리스크다.
  V5의 기존 golden 스위트가 방어선이며, incremental wrap 방식(§4.2 추천)으로 회귀면을 좁힌다.
- judge 레이턴시: claude -p 부팅 수 초.
  게이트 호출을 체크포인트/제출 시점으로 한정해 빈도를 최소화한다(설계 반영).
- 구독 quota 이중 소모: 세션 에이전트와 judge가 같은 구독을 쓴다.
  receipt 기록(AC9)으로 가시화한다.
- claude/codex CLI 플래그 변경(외부 의존): 어댑터 버전 체크와 V4 스모크로 감지한다.
- codex 플래그 동등물 미검증(D-24): T3 스파이크가 v1 내 해소한다.
  스파이크 결과가 부정적이면 codex 어댑터의 방어 수준을 조정하고 사용자에게 보고한다.
- 열린 결정: D-12(크로스 벤더 judge 기본값)는 T8에서 확정한다 - deferred, blocking 아님.
  D-17(hoyeon-cli 대체 시점)은 v1 밖 - deferred.

## 11. Implementation Guardrails

- 스코프를 확장하지 않는다: consensus, 구현 subagent 라우팅, standalone run, 숫자 점수 게이트를 만들지 않는다.
- judge 어댑터에 멀티턴/도구 사용/세션 기능을 추가하지 않는다.
- hoyeon-cli, cli-sync 훅, ~/team-attention repo를 건드리지 않는다.
- 게이트 BLOCK을 에이전트가 오버라이드하는 코드 경로를 만들지 않는다.
- 기존 `agents/implement/*` 상태 파일 포맷을 결정 없이 깨지 않는다.
- 승인 없이 새 외부 서비스, API 키, 네트워크 의존을 도입하지 않는다.
- 듀얼 런타임 대칭을 깨지 않는다: 스킬 개정은 Claude Code와 Codex 양쪽 문구를 함께 갱신한다.

## 12. Implementation Result Report Contract

구현 에이전트는 다음을 보고한다:

- status: Done / Partially Done / Blocked.
- 사용자 가시 변경: 신설 CLI 커맨드 목록, 개정된 스킬 4종의 달라진 흐름.
- 주요 변경 모듈: cli/ 구조, 흡수된 lib 경로 매핑(구→신), 스킬 진입점.
- 승인된 기술 구조(§5) 준수 여부와 이탈.
- T1-T12 완료 상태.
- R/AC/V 커버리지 매트릭스.
- 모드별 검증 증거: build/static 로그, automated behavior 결과, live judge 스모크 출력(사용 토큰/모델 포함), human calibration 잔여 항목.
- 추가/갱신된 자동 테스트와 각각이 방어하는 회귀 리스크.
- deviations(오버라이드 포함)와 receipt 경로.
- 남은 human review 항목(V8, 네이밍, please 문구).
- 미완료 항목과 후속 후보(v2: consensus, 구현 라우팅, hoyeon-cli 대체).
