---
topic: "gate-prelint-json: 판사 호출 전 0원 기계식 문서 lint + --json 출력 완성"
status: "complete"
where: "brownfield"
selected_packs: "compatibility, verification, ux"
created_at: "2026-07-17"
updated_at: "2026-07-17"
question_count: 5
normalization_policy: "raw-capture-with-checkpoint-backfill"
normalization_checkpoint_every: 10
---

# Interview Log: gate-prelint-json

## Current Understanding

- 세 게이트(gap-audit/spec/verify) 입구 전부에 판사 호출 전 결정적 문서 prelint를 추가한다: 하드블록(exit 1) + 판사 미호출(토큰 0) + 재시도 예산 미소모. verify는 prelint → 기계 검사 → 판사 순.
- 규칙 세트는 거짓 양성 0 목표의 확정 목록(Q3 preview 수락): qa-log(필수 섹션/Register 파싱/dangling decision_ids/frontmatter enum/P0-P1 open 차단), PRD(필수 섹션/frontmatter enum/dangling Covers/미커버 AC/Mode 정합), 파싱 불가=fail-closed. ID 연속성 검사는 명시적 non-goal.
- 게이트 입구 lint의 단일 소유자는 checkshirt. interview-me 스킬 문서에서 validate_intake.mjs 단계를 제거하고 게이트 호출로 대체. plan-verification은 별개 목적으로 유지.
- --json은 이미 gate/verify/status에 존재(미문서화). 완전 완성: doctor/override 추가, USAGE+README 문서화, contractVersion 필드, 스킬의 --json 소비 갱신, prelint findings 포함. exit code 계약(0/1/2) 불변.
- 사용자 최우선 가치: 단순하면서도 빠르고 정확하게 검증을 강제하는 것.

## Intake Cursor

- next_decision_id: D-08
- next_question: none (closure)
- last_materiality_sweep: Sweep 1 (after Q3)
- outstanding_raw_entries: 0
- next_checkpoint_at: 10

## Decision Register

| ID | Kind | Area | Decision / fact | Priority | Source / owner | Status | PRD mapping / revisit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| D-01 | fact | compatibility | `--json`은 이미 gate gap-audit/spec/verify/status에 구현됨 (`cli/src/cli.ts:95-127,178`); doctor/override에는 없음; USAGE에 미문서화 | P1 | repo cli/src/cli.ts:127 | resolved | 후보 2의 실제 범위를 "완성+문서화"로 재정의 |
| D-02 | decision | verification | prelint 실패 = 하드블록(exit 1) + 판사 미호출(토큰 0) + 재시도 예산 미소모. verify mechanical-first와 동일 원리 | P0 | user (Q1) | resolved | R#/AC# 핵심 |
| D-03 | decision | compatibility | 게이트 입구 lint는 checkshirt 단일 소유. interview-me 스킬 문서에서 validate_intake.mjs 단계 제거(게이트가 prelint 내장). plan-verification은 별개 목적으로 유지, 중복 규칙은 checkshirt 기준 | P0 | user (Q2) | resolved | T# 스킬 문서 갱신 |
| D-04 | decision | verification | 규칙 세트 확정: qa-log(필수 섹션/Register 파싱/dangling decision_ids/frontmatter enum/P0-P1 open 차단), PRD(필수 섹션/frontmatter enum/dangling Covers/미커버 AC/Mode 정합), 파싱 불가=fail-closed. ID 연속성 검사는 제외(non-goal, 오판 위험) | P1 | user (Q3, 제안 수락) | resolved | R# 규칙 목록, 미커버-AC non-goal |
| D-05 | decision | ux | --json 완전 완성: doctor/override 추가(전 명령), USAGE+README 문서화, contractVersion 필드, 스킬의 --json 소비 갱신, prelint findings 포함. exit code 계약 불변 | P1 | user (Q4) | resolved | R#/T# |
| D-06 | decision | verification | verify 게이트 입구에도 동일 PRD prelint 적용. 순서: prelint(0원, 실패 시 즉시 exit 1) → 기계 검사 → 판사. 세 게이트 모두 mechanical-first로 통일 | P1 | user (Q5) | resolved | R#/AC# |
| D-07 | assumption | ux | prelint 통과 시 출력은 한 줄 요약(`[prelint] ok`), 실패 시 `[prelint]` 라벨 + 규칙 ID + 줄 번호. 판사 findings와 시각적으로 구분. 저위험·가역적 출력 포맷으로 사용자 확인 불요, 사용자 이의 시 즉시 변경 가능 | P2 | agent default (저위험/가역 명시) | resolved | R#; 라이브 사용에서 라벨이 혼동되면 재검토 |
| D-08 | decision | data | prelint 규칙의 실행 가능 명세 확정 (Evidence의 "Prelint 실행 명세" 절: 정확한 헤더 문자열, enum 허용값 집합, dangling 판정 알고리즘, 범위 확장 규칙) | P1 | agent (gap-audit finding 해소, Q3 결정의 구체화) | resolved | R# 규칙 명세 |
| D-09 | decision | compatibility | validate_intake.mjs 이식 방식: 규칙 의미론만 checkshirt TypeScript로 신규 구현(코드 복사 없음), 스크립트 파일은 스킬 저장소에 보존하되 interview-me 스킬 문서에서 참조 제거(무참조화). plan-verification은 변경 없음 | P1 | agent (Q2 결정의 구체화) | resolved | T# 스킬 문서 갱신 |
| D-10 | decision | data | --json 스키마에서 prelint 결과는 judge findings와 병합하지 않고 별도 최상위 키 `prelint: {ok, findings[]}`로 분리 (origin 구분 보존). contractVersion은 최상위 필드 | P2 | agent default (가역적, D-07과 일관) | resolved | R# JSON 스키마 |
| D-11 | decision | risk | prelint 자체의 모든 실행 오류(I/O 오류, 예기치 못한 예외 포함)도 문서 파싱 실패와 동일하게 균일 fail-closed: exit 1 + 판사 미호출 + 원인 출력 | P1 | agent (fail-closed 철학 일관 적용) | resolved | R#/AC# |
| D-12 | decision | verification | 규칙별 진위 검증: cli/test/fixtures/prelint/에 규칙당 최소 결함 문서 1개 + 결함 없는 qa-log/PRD 각 1개. 유닛 테스트가 각 규칙이 자기 결함에서만 발화(true positive)하고 정상 문서에서 findings 0(false positive 0)임을 단언. 테스트는 기존 `node --test` 스위트(cli/test/unit, pre-push/CI에서 기존 게이트 테스트와 함께 실행)에 편입 | P1 | agent (gap-audit finding 해소) | resolved | V#/T# |

## Raw Q&A

### Q1: prelint 실패의 게이트 내 의미
- decision_ids: D-02
- route: user-decision
- asked: prelint 실패 시 게이트 동작 (하드블록/예산/판사 호출 여부)
- recommended: 하드블록 + 재시도 예산 미소모 + 판사 미호출 (verify mechanical-first와 동일 원리)
- answer: 하드블록 + 예산 미소모 (Recommended 채택)
- immediate_notes: exit 1, 판사 토큰 0, lint 실패 재시도는 attempt로 카운트하지 않음. 0원 검사라 무한 재수정 무해.
- needs_normalization: false

### Q2: lint 규칙 소유권
- decision_ids: D-03
- route: user-decision
- asked: checkshirt prelint vs validate_intake.mjs vs plan-verification 중복 정리
- recommended: checkshirt 단일 소유 - 스킬 문서에서 validate_intake.mjs 단계 제거, 게이트 호출만 유지; plan-verification은 별개 목적(실행 계획 파생)으로 유지하되 중복 규칙은 checkshirt 기준
- answer: checkshirt가 단일 소유자 (Recommended 채택)
- immediate_notes: interview-me 스킬 문서의 validator 단계 제거 + gap-audit 게이트 안내로 대체가 범위에 포함됨. validate_intake.mjs 스크립트 자체의 삭제 여부는 스킬 저장소 관리 문제로, 스킬 문서가 참조를 끊으면 충분.
- needs_normalization: false

### Q3: prelint 규칙 세트 확정
- decision_ids: D-04
- route: mixed
- asked: prelint 규칙 세트 수준 (제안 세트 / 최소 / 더 엄격)
- recommended: 거짓 양성 0 목표의 제안 세트 - qa-log(필수 섹션, Register 파싱+필수 컬럼, dangling decision_ids, frontmatter enum, P0/P1 open 차단) + PRD(필수 섹션 1~12, frontmatter enum, dangling Covers 참조, 미커버 AC, V Mode와 Test Mode Contract 정합) + 공통(파싱 불가 = fail-closed, ID 연속성 검사는 오판 위험으로 제외)
- answer: 제안 세트 그대로 (Recommended 채택, preview 전문 수락)
- immediate_notes: 규칙별 finding은 기존 judge findings 스키마 재사용, 위치(줄 번호) 포함. ID 연속성 검사 제외는 명시적 non-goal.
- needs_normalization: false

### Q4: --json 완성 범위
- decision_ids: D-05, D-01
- route: user-decision
- asked: --json 잔여 완성 범위 (완전 완성 / CLI만 / 문서화만)
- recommended: 완전 완성 - doctor/override에 --json 추가(전 명령 커버), USAGE+README 문서화, JSON에 contractVersion 필드, 스킬 문서가 게이트 결과를 --json으로 소비하도록 갱신, prelint findings도 동일 JSON 구조에 포함
- answer: 완전 완성 (Recommended 채택)
- immediate_notes: exit code 계약(0/1/2)은 불변. 기존 --json 소비자(있다면)와의 호환: contractVersion 추가는 필드 추가라 비파괴.
- needs_normalization: false

### Q5: verify 게이트 입구에도 PRD prelint 적용
- decision_ids: D-06
- route: user-decision
- asked: verify가 판사에게 보내는 PRD에도 같은 prelint를 걸지 (spec PASS 후 편집/단독 호출 경로 방어)
- recommended: 적용 - 순서는 PRD prelint(0원) → 기계 검사(테스트/린트) → 판사. 세 게이트 모두 "기계가 거를 수 있는 건 판사에게 안 보낸다"로 통일
- answer: verify에도 적용 (Recommended 채택)
- immediate_notes: prelint는 기계 검사보다 먼저 (0초 vs 수십 초). prelint 실패 시 verify의 기계 검사도 실행하지 않음 (문서가 깨졌는데 테스트 돌릴 이유 없음... 단, 기계 검사는 코드 검사라 독립적 - 구현에서 순서만 지키면 됨. prelint 실패 = 즉시 exit 1).
- needs_normalization: false

## UX Scenario Cards

### UX-01: 게이트 호출 에이전트가 prelint 차단을 만나 자가 수정
- trigger: 스킬(interview-me/gen-prd/implement)이 checkshirt gate/verify를 호출
- happy path: 문서가 구조적으로 온전하면 prelint 통과가 출력에 한 줄로 표시되고 판사 판정으로 진행. 결함이 있으면 exit 1 + 규칙별 finding(위치·줄 번호 포함)이 출력되고, 에이전트가 0원으로 문서를 고쳐 즉시 재실행
- state / failure: prelint 실패가 판사 findings와 구분되지 않으면 에이전트가 "판사 지적"으로 오해해 재시도 예산을 아끼려 함 - 출력에 기계 검사임을 명시(`[prelint]` 라벨)하고 예산 미소모를 표기
- recovery: 무한 재수정 허용 (0원, attempt 미카운트). 파싱 불가 문서도 fail-closed로 같은 경로
- proof: e2e 테스트 (결함 문서 → exit 1 + 판사 미호출(judge call 기록 0 증가) + 예산 미소모, 수정 후 → 판사 진행) + 라이브 스모크
- linked decisions: D-02, D-04, D-06

### UX-02: 에이전트가 --json으로 게이트 결과를 기계적으로 소비
- trigger: 스킬이 게이트 결과에서 verdict/findings/예산 잔량을 읽어야 할 때
- happy path: `--json` 플래그로 전 명령(gate, verify, status, doctor, override)이 contractVersion 포함 구조화 JSON을 출력, 스킬은 텍스트 스크래핑 없이 파싱
- state / failure: JSON 스키마가 소리 없이 바뀌면 소비자가 깨짐 - contractVersion 필드로 감지 가능하게 함
- recovery: exit code 계약(0/1/2)은 텍스트/JSON 모드 동일하므로 파싱 실패 시에도 차단 여부는 판별 가능
- proof: e2e 테스트 (전 명령 --json 출력이 유효 JSON + contractVersion 포함) + 스킬 문서 갱신 확인
- linked decisions: D-01, D-05


## Evidence From Code, Docs, Or Research

- `cli/src/cli.ts:127` `const asJson = args.flags.get("json") === true;` - gate gap-audit/spec(164,174), verify(157), gate status(178)에서 사용. doctor(139-146)와 gate override(188-196)는 텍스트 전용. USAGE 문자열에 `--json` 언급 없음.
- `cli/src/cli.ts` exit code 계약: 0=pass, 1=block/fail, 2=usage 오류.
- verify 게이트 선례: 기계 검사(테스트/린트) 실패 시 판사 미호출, 토큰 0 소비 (`cli/src/gates/commands.ts` mechanical-first).
- 스킬측 기존 기계 검사: `~/.claude/skills/interview-me/scripts/validate_intake.mjs` (179줄, qa-log 구조 검사), `prd_state_harness.js plan-verification` (PRD 파싱/AC 커버리지, stateless 프리체크). checkshirt prelint와 역할 중복 가능.
- 게이트 findings 스키마: `{area, severity(P0/P1/P2), missing, recommendation, requiresHuman}` - prelint findings도 동일 스키마 재사용 가능.

### Prelint 실행 명세 (D-08)

qa-log 규칙 (gap-audit, verify 아님):

- 필수 섹션: `## Current Understanding`, `## Decision Register`, `## Raw Q&A`, `## Audit History

### Audit 1
- type: gap-audit-gate
- result: fail
- missing decision_ids: 없음 (규칙 명세 구체성 3건 P1: 실행 명세 부재, validate_intake.mjs 이식 방식 불명, 규칙별 검증 부재; P2 3건: D-07 출처, JSON 배치, prelint 자체 오류)
- unsupported assumptions: D-07이 비공식 revisit 트리거로 기록됨
- UX or behavior gap: 없음
- highest-risk blocker: 규칙별 true/false positive 검증 부재
- final-blocking-question: 없음 (전부 에이전트 해소 가능 항목)
- PRD impact: D-08~D-12 신설 + D-07 보강 + Prelint 실행 명세 절 추가로 해소

### Audit 2
- type: gap-audit-gate
- result: pass
- missing decision_ids: 없음
- unsupported assumptions: 없음
- UX or behavior gap: 없음
- highest-risk blocker: 없음
- final-blocking-question: 없음
- PRD impact: P2 자문 1건(픽스처 테스트의 CI 연결 명시) - D-12에 기존 node --test 스위트 편입으로 반영` (정확한 `## ` 헤더 문자열 일치). 나머지 템플릿 섹션은 선택.
- frontmatter enum: `status` ∈ {active, paused, complete}, `where` ∈ {greenfield, brownfield, docs-only, unknown}.
- Decision Register: 헤더 행이 8개 컬럼(ID, Kind, Area, Decision / fact, Priority, Source / owner, Status, PRD mapping / revisit) 포함해야 파싱 성공. 행 값 검증: Kind ∈ {fact, decision, assumption}, Priority ∈ {P0, P1, P2}, Status ∈ {open, resolved, deferred, blocking, rejected}.
- P0/P1 open 차단: Priority가 P0 또는 P1이고 Status가 open인 행 존재 시 finding (blocking/deferred/rejected는 명시적 분류이므로 통과).
- dangling decision_ids: Raw Q&A의 `decision_ids:` 값에서 `/D-\d+/` 토큰 추출, 각 토큰이 Register의 ID 열에 존재해야 함. `none`은 허용.

PRD 규칙 (spec 및 verify 입구):

- 필수 섹션: `## 1.` ~ `## 12.` 번호 헤더 12개 전부 존재 (번호 접두 일치, 제목 문구는 불문).
- frontmatter enum: `status` ∈ {draft, ready}, `human_approval` ∈ {pending, approved}, `review_profile` ∈ {trivial, standard, high-risk}.
- ID 정의 수집: 본문 리스트 항목 `^\s*-\s*(R|AC|T|V)(\d+)[.:]` 및 9.2 테이블 ID 열에서 정의된 ID 집합 구성.
- dangling Covers: `Covers` 문구와 9.2 테이블 Covers 셀에서 참조 ID 추출. 같은 접두사의 범위 표기(`R1-R4`)는 확장. 참조됐지만 정의되지 않은 ID → finding (줄 번호 포함).
- 미커버 AC: 정의된 모든 AC#가 최소 1개 V 행의 Covers(범위 확장 후)에 나타나야 함.
- Mode 정합: 9.2 각 행의 Mode 값이 9.1 Test Mode Contract의 Mode 셀 중 하나와 일치 (trim 후 문자열 비교).

공통:

- 파싱 불가(테이블 구조 붕괴, frontmatter 부재)는 lint 실패 (fail-closed).
- prelint 실행 중 모든 오류(파일 I/O, 예외)도 동일 fail-closed (D-11).
- 각 finding: 규칙 ID + 줄 번호 + 문제 + 수정 방향. 기존 findings 스키마 `{area, severity, missing, recommendation, requiresHuman:false}`에 규칙 ID와 줄 번호를 담아 재사용, JSON에서는 최상위 `prelint` 키로 분리 (D-10).

## Documented Domain Checks

- docs inspected: README.md (게이트/판사 계약), skills/ho-setup/SKILL.md
- canonical terms: mechanical-first, fail-closed, findings(비수치), retry budget, freshness hash
- glossary or code conflicts: none observed
- concrete scenarios tested: n/a (인터뷰 단계)
- docs mutation: README/스킬 문서 갱신이 범위에 포함될 예정
- ADR candidate: lint 규칙 소유권 단일화 (D-03)

## Checkpoint And Sweep History

### Sweep 1
- trigger: 3개 material 결정 누적 (Q1-Q3)
- intent_drift: 없음 (모든 결정이 "단순·빠름·정확한 검증 강제"에 정렬)
- impact_gap: verify 게이트도 PRD를 판사에게 보내는데 prelint 범위가 gap-audit/spec 입구로만 정의됨 → Q5로 해소
- verification_gap: prelint의 "판사 미호출" 보장은 judge call 기록으로 관찰 가능해야 함 → UX-01 proof에 반영
- next_action: Q5 (verify 입구 적용 여부)

### Checkpoint 1
- after_question: Q5
- normalized_entries: Q1-Q5 전부 (needs_normalization: false)
- register_changes: D-02~D-06 resolved
- reopened_decisions: 없음
- highest_remaining_gap: 없음 - 규칙 세트/실패 의미/소유권/--json 범위/적용 지점 모두 확정

## Audit History

### Audit 1
- type: gap-audit-gate
- result: fail
- missing decision_ids: 없음 (규칙 명세 구체성 3건 P1: 실행 명세 부재, validate_intake.mjs 이식 방식 불명, 규칙별 검증 부재; P2 3건: D-07 출처, JSON 배치, prelint 자체 오류)
- unsupported assumptions: D-07이 비공식 revisit 트리거로 기록됨
- UX or behavior gap: 없음
- highest-risk blocker: 규칙별 true/false positive 검증 부재
- final-blocking-question: 없음 (전부 에이전트 해소 가능 항목)
- PRD impact: D-08~D-12 신설 + D-07 보강 + Prelint 실행 명세 절 추가로 해소

### Audit 2
- type: gap-audit-gate
- result: pass
- missing decision_ids: 없음
- unsupported assumptions: 없음
- UX or behavior gap: 없음
- highest-risk blocker: 없음
- final-blocking-question: 없음
- PRD impact: P2 자문 1건(픽스처 테스트의 CI 연결 명시) - D-12에 기존 node --test 스위트 편입으로 반영
