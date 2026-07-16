# PRD Handoff: checkshirt 단일 CLI - LLM judge 게이트

> Date: 2026-07-16
> Source: agents/intake/mini-cli-llm-boundary/qa-log.md
> Interview skill: interview-me

## Clear Outcome

checkshirt 하네스에 공식 단일 TypeScript CLI를 신설한다.
CLI는 기존 implement 내장 lib(7,930줄 JS)을 흡수해 상태머신·게이트·검증 실행을 소유하고, LLM은 headless one-shot 판단 호출(claude -p / codex exec)에만 사용하는 심판 전용 도구가 된다.
v1 게이트 3종: ① gap audit(인터뷰 closure), ② 스펙 게이트(PRD 충실도+자체완결성), ③ semantic verify(diff vs AC, mechanical 선행).
스킬 interview-me/gen-prd/implement가 게이트 지점에서 CLI를 호출하도록 개정하고, please는 게이트 재시도 루프 의미론만 경량 반영한다.
구현 실행(멀티턴 코딩)은 CLI의 영구 비목표로, 호스트 에이전트가 유지한다.

한 줄 요약: "CLI는 심판 전용이고, 확신 없으면 멈추고, 뭘 했는지 다 기록하고, 옛날 것 청소는 나중에."

## Product Completeness Boundary

- 포함: 게이트 3종 + judge 어댑터 2종(claude/codex) + mechanical verify 실행기 + 상태머신(하드 블록/오버라이드/deviation 기록) + tier→model config + implement lib 흡수 + 스킬 3종 개정 + please 경량 개정 + ho-setup doctor 확장.
- 명시적 제외(v2 이연): ④ multi-model consensus, 구현 subagent tier 라우팅(route/escalation의 implement 접점), hoyeon-cli 대체 및 cli-sync 훅 정리.
- 영구 비목표: CLI의 구현 실행/standalone run 모드 (D-07).

## Decision Trace And Requirement Mapping

| Decision | User intent or evidence | Represented by | Remaining gap |
| --- | --- | --- | --- |
| D-01 단일 CLI 통합 + lib 흡수 | user Q1 | R#: cli/ 워크스페이스, T#: lib 흡수 마이그레이션 | none (흡수 방식 incremental vs cutover는 PRD 기술구조 결정) |
| D-02 게이트 3종, consensus v2 | user Q2 | R#: 게이트 3종, non-goal | none |
| D-05 gap audit 목록 게이트 (스칼라 기각) | user Q3/Q3-b | R#: gap-audit judge, rejected option | none |
| D-03 듀얼 judge 백엔드 + config | user Q4 | R#: 어댑터 2종, config 스키마 | none |
| D-13 하드 블록 + 사용자 오버라이드 | user Q5 | R#: 상태머신 규칙, AC#: deviation 기록 | none |
| D-14 tier 라우팅 judge만 v1 | user Q6 | non-goal: 구현 라우팅, revisit: v2 | none |
| D-08 verify 커맨드 config+자동감지 | user Q7 | R#: config 스키마+감지기, V#: doctor | none |
| D-06 TS, 이 repo cli/ 워크스페이스 | user Q8 | T#: 스캐폴드, 설치 스크립트 확장 | none |
| D-07 구현 실행 영구 비목표 | user Q9-1 | non-goal | none |
| D-15 judge 불능 fail-closed | user Q9-2 | AC#: 불능 시나리오 | none |
| D-16 출력 방어 + receipt 기록 | user Q9-3 | AC#: 파싱 방어, receipt 필드 | none |
| D-17 hoyeon-cli 대체 이연 | user Q9-4 | deferred, revisit: v1 안정화 후 | deferred |
| D-21 스펙 게이트 = 충실도+자체완결성 | user Q10 | R#: spec-gate judge 계약 | none |
| D-22 please BLOCK = 수정 재시도 루프 | user Q11 | R#: 재시도 루프, please 경량 개정 | none |
| D-18 스킬 개정 범위 (3종+please 경량) | user Q12 | R#: 스킬 개정 | none |
| D-19 tier 기본 매핑 (①②haiku급/③sonnet급) | user Q12 | config 기본값 | none |
| D-12 크로스 벤더 독립성 기본값 | agent, deferred | config 설계 시 결정 | deferred |
| D-23 재시도 예산 기본 2회 | agent default | config 기본값 | none (revisit: 운영 관찰) |
| D-24 codex 플래그 동등물 미검증 | 감사자 지적 | T#: codex 어댑터 스파이크 | none (v1 태스크화) |

## UX Behavior And State Seeds

qa-log의 UX 카드 5종을 그대로 계승한다:

- UX-01 인터뷰 핸드오프 gap audit: PASS 한 줄 / BLOCK 시 gap 목록이 다음 질문 후보로 전환.
- UX-02 implement 검증: mechanical FAIL 시 semantic 생략(비용 절약), AC별 판정 근거 표시, 상태머신이 전이 거부.
- UX-03 judge 불능: fail-closed, 원인·해결·오버라이드 명령을 명시한 에러.
- UX-04 gen-prd 스펙 게이트: 충실도/AC 검증가능성/verification contract gap 목록, 에이전트 보완→재게이트.
- UX-05 사용자 오버라이드: 사유 필수, deviation 기록, 에이전트 대행 금지 명문화.

## Domain Terms And Documented Decisions

- judge: CLI가 headless로 호출하는 one-shot 판정 LLM. 구현 컨텍스트와 격리된 독립 리뷰어.
- 게이트(gate): 상태머신 전이를 막을 수 있는 판정 지점. BLOCK은 "정지"가 아니라 "PASS 전 통과 불가"(D-22).
- gap 목록: 게이트 3종의 통일 출력 계약. 구조화된 finding 배열, 빈 배열 = PASS.
- deviation: 사용자 오버라이드의 감사 기록. receipt에 잔존.
- tier: frugal/standard/frontier. v1은 judge 호출의 모델 선택에만 사용.
- 기존 계약과의 정합: interview-me의 "숫자 게이트 금지" 조항은 유지된다 - gap audit은 목록 기반이라 충돌 없음 (D-04/D-05).

## Requirement Seeds

- R1. cli/ 워크스페이스(TS)를 engineering-harness에 신설하고 단일 바이너리(가칭)로 빌드·설치한다. install-local-skills 경로에 빌드/링크 통합.
- R2. judge 어댑터 2종: claude -p, codex exec. 공통 인터페이스 judge(prompt, tier) → JSON. 스키마 검증 + 1회 재시도 + 도구 차단, 호출 수/모델 receipt 기록 (D-16). codex 플래그 동등물은 스파이크로 검증 (D-24).
- R3. 게이트 ① gap-audit: 입력 qa-log → material gap 목록. 체크포인트/핸드오프 직전 호출.
- R4. 게이트 ② spec: 입력 PRD + qa-log(Decision Register) → 충실도/AC 검증가능성/모호어/verification contract gap 목록 (D-21).
- R5. 게이트 ③ verify: mechanical(config 선언 1순위, 매니페스트 자동 감지 폴백) 선행 → PASS 시에만 semantic judge(diff vs AC, AC별 verdict+근거) (D-08).
- R6. 상태머신: 게이트 BLOCK 시 다음 단계 전이 거부(하드 블록). 사용자 오버라이드 명령(사유 필수)만 해제 가능, deviation 기록 (D-13). judge 불능 시 fail-closed (D-15).
- R7. tier→model config: agents/config.json에 judge 백엔드 선택, tier 매핑(기본 ①②=haiku급, ③=sonnet급), 재시도 예산(기본 2회) (D-03/D-19/D-23).
- R8. implement lib(7,930줄) 흡수: state_store/prd_parser/reviews/rules 등을 cli/로 이동, implement 스킬은 CLI 커맨드 호출로 전환 (D-01/D-11).
- R9. 스킬 개정: interview-me(R3 접점), gen-prd(R4 접점), implement(R5/R6 접점), please(D-22 재시도 루프 + 정지 조건) (D-18).
- R10. ho-setup doctor 확장: judge 바이너리/인증 상태, verify 커맨드 설정, CLI 버전 계약 진단 (D-08).

## Non-Goals And Rejected Options

- 비목표(영구): CLI의 구현 실행/standalone run (D-07). 그 순간 ouroboros orchestrator(57k LOC)의 복잡도를 상속한다는 것이 근거.
- 비목표(v1): multi-model consensus(④), 구현 subagent tier 라우팅, hoyeon-cli 대체.
- 기각: 숫자 ambiguity 점수 게이트 (ouroboros식). 근거: LLM 스칼라 미보정, gap 은닉, Goodhart 위험, headless 전제 부재. gap 목록 게이트로 대체 (D-05).
- 기각: 소프트 블록 (에이전트 자율 통과) - reward hacking 경로 (Q5).
- 기각: PRD verification contract에서 verify 커맨드 추출 - LLM 작성 문서의 커맨드 실행 리스크 (Q7).

## Pre-Work And Human Decisions

- implement lib 흡수 방식(incremental wrap vs rewrite cutover)과 기존 agents/implement/* 상태 파일 하위호환은 PRD의 기술구조 결정으로 명시할 것 (Audit 1 지적).
- 진행 중인 implement 런이 있는 프로젝트에서의 CLI 전환 시점 가이드 필요.

## Major Technical Structure Signals

- cli/ 워크스페이스 신설 (TS, 이 repo). 스킬과 동일 버전링으로 skew 구조적 제거.
- skills/implement/scripts/lib 소멸 → cli/ 흡수. 스킬 디렉토리는 프롬프트+얇은 진입점만 잔존.
- 게이트 3종의 출력 계약 통일(gap 목록)로 judge 프롬프트/파서 공용화 가능.
- 듀얼 런타임 제약: CLI는 외부 바이너리라 Claude Code/Codex 세션 양쪽에서 동일 호출 (D-09).

## Test And Verification Seeds

- V1. 정책/파서 유닛: tier 매핑, 상태 전이(하드 블록/오버라이드), gap 목록 스키마 검증, 재시도 예산.
- V2. judge 어댑터 스모크: 실제 claude -p / codex exec 각 1콜로 JSON 계약 확인 (CI 외 로컬 게이트).
- V3. fail-closed 유닛: 바이너리 부재/비정상 출력 모킹 → BLOCK 유지 + 에러 메시지 (UX-03).
- V4. E2E 게이트 ①: gap 있는 qa-log 픽스처 BLOCK → 보완 후 PASS (UX-01).
- V5. E2E 게이트 ②: 결정 누락 PRD 픽스처 BLOCK → 보완 후 PASS (UX-04).
- V6. E2E 게이트 ③: 테스트 실패 diff mechanical FAIL(semantic 생략 확인), AC 미충족 diff semantic FAIL, 정상 diff PASS (UX-02).
- V7. 오버라이드: 사유 필수, deviation 레코드, 전이 해제 (UX-05).
- V8. 스킬 회귀: 개정된 interview-me/gen-prd/implement가 기존 아티팩트 계약(qa-log, prd.md, receipt)을 깨지 않음. 기존 implement E2E가 CLI 경유로도 통과.
- V9. receipt 필드: judge 호출 수/모델/deviation이 receipt에 기록됨 (D-16).

## Risks, Side Effects, And Sensitive Data

- lib 흡수가 최대 리스크: 7,930줄 이동 중 기존 implement 흐름 회귀 가능. V8로 방어, 흡수 방식은 pre-work 결정.
- judge 레이턴시: claude -p 부팅 수 초. 게이트 호출을 체크포인트/제출 시점으로 한정해 빈도 최소화 (설계에 이미 반영).
- 구독 quota 이중 소모: 세션 에이전트 + judge가 같은 구독 사용. receipt 기록으로 가시화 (D-16).
- claude/codex CLI 플래그 변경(외부 의존): 어댑터 시작 시 버전 체크 + V2 스모크로 감지.
- 민감 데이터: judge에 diff/qa-log가 전달됨 - 기존에도 같은 구독의 에이전트가 보던 데이터라 신규 노출면 없음. 외부 API 키 신설 없음.

## Human Review Needed

- 게이트 ② 충실도 판정의 실제 품질(오탐/미탐)은 초기 런에서 사람이 gap 목록을 검토하며 캘리브레이션 필요.
- CLI 커맨드 네이밍/바이너리 이름은 taste 결정.
- please 경량 개정 문구가 "안 멈춤" 철학을 훼손하지 않는지 검토.

## Open Questions

- D-12: judge 기본값을 구현 런타임과 다른 벤더로 할지 (config 스키마 설계 시).
- D-17: hoyeon-cli 대체/cli-sync 정리 시점 (v1 안정화 후).
- v2: 구현 subagent 라우팅 시 Codex 세션의 task별 모델 오버라이드 수단 (enforced vs advised).

## Suggested Next Step

/gen-prd --context agents/intake/mini-cli-llm-boundary/prd-handoff.md "checkshirt 단일 CLI - LLM judge 게이트"
