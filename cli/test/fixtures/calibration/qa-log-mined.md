---
topic: "workspace-notes-sync"
status: "active"
where: "brownfield"
selected_packs: "ux, data, provider, risk, verification"
created_at: "2026-07-10"
updated_at: "2026-07-12"
question_count: 15
normalization_policy: "raw-capture-with-checkpoint-backfill"
normalization_checkpoint_every: 10
---

# Interview Log: workspace notes sync

## Current Understanding

- 팀 워크스페이스의 회의 노트를 개인 노트 앱과 양방향 동기화하는 기능을 만든다.
- 동기화는 백그라운드 주기 동기화(5분)와 수동 "지금 동기화" 버튼 두 경로를 가진다.
- 외부 제공자는 NotesHub API v2를 사용한다 (팀 계정, API 키는 워크스페이스 관리자가 발급).
- 노트는 마크다운 본문 + 제목 + 태그로 구성되고, 첨부파일은 이번 범위에서 제외한다.

## Intake Cursor

- next_decision_id: D-17
- next_question: none
- last_materiality_sweep: after Q15
- outstanding_raw_entries: 0
- next_checkpoint_at: 20

## Decision Register

| ID | Kind | Area | Decision / fact | Priority | Source / owner | Status | PRD mapping / revisit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| D-01 | decision | scope | 양방향 동기화 (워크스페이스 ↔ NotesHub), 첨부파일은 non-goal | P0 | user Q1 | resolved | R/AC, non-goal |
| D-02 | decision | ux | 동기화 경로 2개: 5분 주기 백그라운드 + 수동 버튼. 수동 동기화 중에는 버튼이 스피너로 바뀌고 완료 토스트를 띄운다 | P1 | user Q2 | resolved | R/AC |
| D-03 | decision | data | 노트 매핑은 노트별 external_id 컬럼으로 유지, 매핑 테이블 별도 생성 안 함 | P1 | user Q3 | resolved | R |
| D-04 | fact | provider | NotesHub API v2는 노트 단건 upsert만 지원, 배치 endpoint 없음 (docs.noteshub.example/v2) | P1 | provider docs | resolved | R/guardrail |
| D-05 | decision | provider | API 키는 워크스페이스 설정 화면에서 관리자만 등록/교체 가능 | P1 | user Q4 | resolved | R/AC |
| D-06 | decision | ux | 태그는 이름 기준 매칭으로 동기화하고, 상대편에 없는 태그는 자동 생성한다 | P1 | user Q5 | resolved | R/AC |
| D-07 | decision | data | 제목 없는 노트는 본문 첫 줄을 잘라 제목으로 쓴다 (양쪽 동일 규칙) | P2 | user Q6 | resolved | R |
| D-08 | decision | scope | 동기화 대상은 회의 노트 폴더 하나로 한정, 개인 폴더 전체 동기화는 명시적 non-goal (revisit: 사용자 요청 3건 이상) | P0 | user Q7 | resolved | non-goal |
| D-09 | decision | verification | 동기화 로직은 provider를 fake로 대체한 통합 테스트로 검증, 실 API는 스테이징 키로 스모크 1회 | P1 | agent proposal, user 동의 Q8 | resolved | V |
| D-10 | decision | ux | 노트 목록에 마지막 동기화 시각을 상대 시간("3분 전")으로 표시 | P2 | user Q9 | resolved | R/AC |
| D-11 | decision | data | 본문 1MB 초과 노트는 해당 노트만 동기화 스킵하고 "너무 커서 동기화 제외" 배지를 단다. 본문이 1MB 이하로 줄면 다음 주기에 자동 포함. 다른 노트의 동기화는 영향 없음 | P1 | user Q10 | resolved | R/AC |
| D-12 | decision | scope | 아카이브된 노트는 동기화 대상에서 제외하고, 아카이브 해제 시 다음 주기부터 다시 포함. 아카이브 상태 자체는 동기화하지 않는다 (NotesHub에 대응 개념 없음) | P1 | user Q11 | resolved | R, non-goal |
| D-13 | decision | data | 마크다운은 CommonMark 교집합만 서식으로 변환하고, 비지원 문법(예: 콜아웃, 내부 위키링크)은 원문 텍스트 그대로 보존한다. 링크/이미지 URL은 변환 없이 유지. 왕복 후 원문이 달라지지 않는 무손실 원칙 | P1 | user Q12 | resolved | R/AC |
| D-14 | decision | operation | 동기화 이벤트(방향, 노트 id, 결과, 소요 시간)는 sync_events 테이블에 30일 보존. UI 노출은 없고 운영 조회용. 30일 경과분은 일일 잡으로 삭제 | P2 | user Q13 | resolved | R |
| D-15 | decision | risk | 폴더 접근 권한이 있는 멤버의 노트만 동기화 대상. 멤버가 권한을 잃으면 그 시점 이후 변경은 반영하지 않되, 이미 동기화된 내용은 회수하지 않는다 (revisit: 보안 요건 강화 시) | P1 | user Q14 | resolved | R/risk |
| D-16 | decision | operation | 동기화 실패 안내는 목록 헤더 배너로만 한다. 이메일/슬랙 알림은 명시적 non-goal (revisit: 관리자 다수 요청 시) | P2 | user Q15 | resolved | non-goal |

## Raw Q&A

### Q1: 동기화 방향과 첨부파일
- decision_ids: D-01
- route: user-decision
- asked: 단방향(워크스페이스→개인)으로 시작할지, 양방향으로 갈지. 첨부파일 포함 여부.
- recommended: 양방향 + 첨부 제외 (첨부는 저장소 용량/권한 문제가 커서 별도 사이클 권장)
- answer: 양방향으로 가자. 첨부는 빼고. 나중에 요청 많으면 다시 보자.
- needs_normalization: false

### Q2: 동기화 트리거와 피드백
- decision_ids: D-02
- route: user-decision
- asked: 주기 동기화 간격과 수동 트리거 UX.
- recommended: 5분 주기 + 수동 버튼, 진행 중 스피너
- answer: 5분이면 충분. 수동 버튼 누르면 돌아가는 게 보여야 하고 끝나면 토스트.
- needs_normalization: false

### Q3: 노트 매핑 저장
- decision_ids: D-03
- route: mixed
- asked: 노트-외부노트 매핑을 별도 테이블로 갈지 컬럼으로 갈지. 현재 notes 테이블에 여유 컬럼 있음 (schema.sql:41 확인).
- recommended: external_id 컬럼 (매핑이 1:1이고 이력 필요 없음)
- answer: 컬럼으로 가자.
- needs_normalization: false

### Q4: API 키 관리
- decision_ids: D-05
- route: user-decision
- asked: NotesHub API 키를 누가 어디서 관리하는지.
- recommended: 워크스페이스 설정에서 관리자 전용
- answer: 관리자만. 일반 멤버는 키 존재 여부만 보이면 됨.
- needs_normalization: false

### Q5: 태그 동기화
- decision_ids: D-06
- route: user-decision
- asked: 태그를 어떻게 맞출지 (이름 매칭 vs 매핑 관리 vs 동기화 제외).
- recommended: 이름 매칭 + 자동 생성
- answer: 이름 매칭으로 하고 없으면 만들어. 태그 색깔까지는 안 맞춰도 돼.
- needs_normalization: false

### Q6: 제목 없는 노트
- decision_ids: D-07
- route: user-decision
- asked: NotesHub는 제목 필수, 우리 쪽은 제목 없는 노트 허용 - 변환 규칙.
- recommended: 본문 첫 줄 40자 절단
- answer: 그렇게 해.
- needs_normalization: false

### Q7: 동기화 범위
- decision_ids: D-08
- route: user-decision
- asked: 폴더 전체냐 회의 노트 폴더 한정이냐.
- recommended: 회의 노트 폴더 한정 (범위 폭발 방지)
- answer: 회의 노트만. 전체 동기화는 하지 마 - 사람들이 개인 메모까지 올라가는 걸 싫어할 거야.
- needs_normalization: false

### Q8: 검증 방식
- decision_ids: D-09
- route: mixed
- asked: 실 API를 테스트에서 어떻게 다룰지.
- recommended: fake provider 통합 테스트 + 스테이징 키 스모크 1회
- answer: 좋아, 실 키로 CI 돌리는 건 하지 말자.
- needs_normalization: false

### Q9: 동기화 상태 표시
- decision_ids: D-10
- route: user-decision
- asked: 사용자가 동기화 상태를 어디서 확인하는지.
- recommended: 노트 목록 헤더에 상대 시간
- answer: "3분 전 동기화됨" 같은 식이면 충분.
- needs_normalization: false

### Q10: 대용량 노트
- decision_ids: D-11
- route: mixed
- asked: NotesHub는 본문 1MB 제한이 있는데 (docs.noteshub.example/v2/limits), 우리 쪽에는 제한이 없어서 초과 노트를 어떻게 다룰지. 옵션: (a) 잘라서 올림, (b) 해당 노트만 스킵 + 배지, (c) 전체 동기화 중단.
- recommended: (b) 해당 노트만 스킵 + 배지 - 자르면 데이터 손실이고, 전체 중단은 노트 하나 때문에 워크스페이스 전체가 볼모가 됨
- answer: "잘라서 올리는 건 절대 안 돼, 회의록 뒷부분이 날아가는 거잖아. 그 노트만 빼고 나머지는 계속 돌아야지. 배지 달아주면 본인이 알아서 줄이든 나누든 할 거야. 줄이면 자동으로 다시 올라가는 거지? 그러면 완벽해."
- immediate_notes: 스킵은 노트 단위 격리, 복귀는 자동 (다음 주기). 배지 문구는 구현에서 제안 후 확정.
- needs_normalization: false

### Q11: 아카이브 노트
- decision_ids: D-12
- route: user-decision
- asked: 워크스페이스의 아카이브 기능과 동기화의 상호작용. NotesHub에는 아카이브 개념이 없음.
- recommended: 아카이브 = 동기화 제외, 해제 시 재포함
- answer: "아카이브한 건 끝난 회의니까 굳이 개인 노트에 계속 밀어넣을 필요 없어. 해제하면 다시 붙는 걸로. NotesHub 쪽에서 아카이브 흉내를 내려고 태그 같은 걸 만들지는 마 - 지저분해져."
- immediate_notes: 아카이브 상태의 표현을 상대편에 만들지 않는 것까지가 결정 (태그 우회 금지).
- needs_normalization: false

### Q12: 마크다운 방언
- decision_ids: D-13
- route: mixed
- asked: 우리 에디터는 콜아웃(:::info)과 위키링크([[노트명]])를 지원하는데 NotesHub는 CommonMark만 지원. 변환 정책.
- recommended: CommonMark 교집합만 변환, 비지원 문법은 원문 텍스트 보존 (왕복 무손실)
- answer: "무손실이 제일 중요해. NotesHub에서 :::info가 그냥 글자로 보이는 건 괜찮은데, 다시 돌아왔을 때 내 콜아웃이 깨져 있으면 그건 못 참아. 링크는 그대로 두고. 요약하면 - 예쁘게 보이는 것보다 안 깨지는 게 우선."
- immediate_notes: 원문 보존이 우선순위 1, 상대편 렌더링 품질은 우선순위 2로 명시됨. 왕복 round-trip 테스트가 검증 시드.
- needs_normalization: false

### Q13: 동기화 이력
- decision_ids: D-14
- route: user-decision
- asked: 동기화가 뭘 했는지 추적할 수 있어야 하는지 (디버깅/운영).
- recommended: sync_events 테이블 30일 보존, UI 없음
- answer: "사용자한테 보여줄 필요까지는 없고, 문제 생겼을 때 우리가 조회할 수 있으면 돼. 한 달치면 충분하고 그 뒤는 지워."
- needs_normalization: false

### Q14: 권한 경계
- decision_ids: D-15
- route: user-decision
- asked: 폴더 접근 권한이 없는 멤버의 노트, 그리고 권한을 잃은 멤버의 기존 동기화분 처리.
- recommended: 권한 있는 노트만 대상, 상실 이후 변경 미반영 + 기존 반영분은 회수 안 함
- answer: "권한 없는 건 당연히 안 나가야지. 이미 나간 걸 지우러 다니는 건 오버 같아 - 어차피 팀 회의록이고. 다만 보안 요건이 빡세지면 그때 다시 보자."
- immediate_notes: 회수 non-goal에 revisit 조건 부착 (보안 요건 강화 시).
- needs_normalization: false

### Q15: 실패 알림
- decision_ids: D-16
- route: user-decision
- asked: 동기화가 계속 실패할 때 사용자/관리자에게 어떻게 알릴지.
- recommended: 목록 헤더 배너만 (이메일/슬랙은 인프라 추가라 별도 사이클)
- answer: "배너면 돼. 이메일까지 가면 스팸이야. 관리자들이 진짜로 원하면 그때 넣자."
- needs_normalization: false

## UX Scenario Cards

### UX-01: 수동 동기화
- trigger: 사용자가 노트 목록 헤더의 "지금 동기화" 버튼을 누른다
- happy path: 버튼이 스피너로 바뀌고, 완료되면 "동기화 완료" 토스트와 함께 마지막 동기화 시각이 갱신된다
- state / failure: API 키가 없거나 만료된 경우 관리자에게 키 등록을 안내하는 배너를 띄운다
- recovery: 배너의 링크가 워크스페이스 설정의 키 관리 섹션으로 이동한다
- proof: fake provider 통합 테스트 + 브라우저 스모크
- linked decisions: D-02, D-05

### UX-02: 백그라운드 동기화
- trigger: 5분 주기 스케줄러
- happy path: 사용자 개입 없이 변경분이 양방향 반영되고 헤더의 상대 시간이 갱신된다
- state / failure: 사용자가 같은 노트를 양쪽에서 편집한 경우의 처리 (오프라인 편집 포함)
- recovery: 편집 충돌 상황의 복구 흐름
- proof: fake provider 통합 테스트
- linked decisions: D-02, D-06

### UX-03: 대용량 노트 스킵
- trigger: 본문 1MB 초과 노트가 동기화 대상에 포함됨
- happy path: 해당 노트만 스킵되고 "너무 커서 동기화 제외" 배지가 노트 행에 표시되며, 나머지 노트는 정상 동기화된다
- state / failure: 사용자가 배지를 눌렀을 때 이유(1MB 제한)와 해결 방법(본문 줄이기/노트 나누기)을 설명하는 팝오버
- recovery: 본문이 1MB 이하로 줄면 다음 주기에 배지가 사라지고 자동 동기화된다
- proof: fake provider 통합 테스트 (1MB 경계 픽스처) + 브라우저 스모크
- linked decisions: D-11

### UX-04: API 키 교체
- trigger: 관리자가 워크스페이스 설정에서 기존 키를 새 키로 교체
- happy path: 새 키가 /v2/me 프로브로 검증된 뒤 저장되고, 다음 동기화부터 새 키 사용. 성공 토스트
- state / failure: 프로브 실패(401) 시 기존 키를 유지한 채 "키가 유효하지 않습니다" 인라인 오류 표시
- recovery: 기존 키가 만료된 상태라면 목록 헤더 배너가 관리자에게 재등록을 안내 (UX-01과 동일 배너)
- proof: fake provider 통합 테스트 + 브라우저 스모크
- linked decisions: D-05

## Documented Domain Checks

- docs inspected: docs.noteshub.example/v2 (API 발췌를 Evidence에 기록), 사내 sync 용어집 없음
- canonical terms: "동기화 주기"(5분), "수동 동기화", "회의 노트 폴더", "external_id"
- glossary or code conflicts: 없음
- concrete scenarios tested: UX-01~UX-04
- docs mutation: 없음
- ADR candidate: 아니오

## Evidence From Code, Docs, Or Research

- notes 테이블에 external_id 후보 컬럼 여유 확인: schema.sql:41
- NotesHub API v2: 단건 upsert만 지원, 배치 없음, 인증은 Bearer 키 (docs.noteshub.example/v2)
- NotesHub API rate limit: 분당 60 요청 (docs.noteshub.example/v2/limits) - 회의 노트가 수백 건인 워크스페이스에서 주기 동기화가 이 한도에 걸릴 수 있음
- 기존 스케줄러 인프라: jobs/scheduler.ts에 5분 주기 잡 등록 패턴 존재
- 기존 토스트/배너 컴포넌트: components/feedback/에 Toast, Banner 재사용 가능 (UX-01의 완료 토스트와 키 안내 배너에 그대로 사용)
- 워크스페이스 설정 화면의 관리자 전용 섹션 패턴: settings/AdminSection.tsx (키 관리 UI가 이 패턴을 따름)

### NotesHub API v2 발췌 (docs.noteshub.example/v2, 2026-07-11 확인)

| Endpoint | Method | 설명 | 비고 |
| --- | --- | --- | --- |
| /v2/notes/{id} | GET | 노트 단건 조회 (title, body_md, tags[], updated_at, version) | ETag 지원 |
| /v2/notes/{id} | PUT | 노트 upsert (id는 클라이언트 지정 가능) | If-Match로 낙관적 잠금 |
| /v2/notes/{id} | DELETE | 노트 삭제 (영구 삭제, 휴지통 없음) | 복구 불가 |
| /v2/notes | GET | 목록 조회, updated_since 필터, 페이지당 50건 | cursor 페이지네이션 |
| /v2/tags | GET/POST | 태그 목록/생성 (이름 unique) | 색상 필드는 v2에서 읽기 전용 |
| /v2/me | GET | 키 유효성/스코프 확인 | 키 검증 프로브로 사용 가능 |

- 오류 규약: 401(키 무효), 404(노트 없음), 409(If-Match 버전 충돌), 413(본문 1MB 초과), 429(rate limit, Retry-After 헤더 포함)
- 한도: 분당 60 요청, 초과 시 429 + Retry-After(초). 문서상 "지속 초과 시 키가 일시 정지될 수 있음"
- 본문 제한: body_md 1MB (413)
- 페이지네이션: 50건/페이지, 수백 건 워크스페이스의 전체 목록 조회는 요청 여러 번 필요
- 409 응답 본문에 서버 버전의 updated_at과 version이 포함됨 (충돌 감지의 재료가 될 수 있음)

## Checkpoint And Sweep History

### Sweep 1
- trigger: Q7 이후 (P0 D-08 확정)
- intent_drift: 없음
- impact_gap: 태그 동기화와 제목 규칙이 미결이었음 → Q5, Q6으로 해소
- verification_gap: 실 API 검증 방식 미결 → Q8로 해소
- next_action: Q8

### Checkpoint 1
- after_question: Q10
- normalized_entries: Q1-Q10 전부 정규화 완료
- register_changes: D-01~D-11 확정
- reopened_decisions: 없음
- highest_remaining_gap: 아카이브/마크다운 방언/권한 경계 (Q11, Q12, Q14로 이어짐)

### Sweep 2
- trigger: Q12 이후 (무손실 원칙이 D-06 태그 자동 생성과 상호작용하는지 점검)
- intent_drift: 없음 - 태그는 이름만 동기화하므로 무손실 원칙과 충돌 없음 (색상은 v2 읽기 전용이라 애초에 못 씀)
- impact_gap: 동기화 이력과 실패 알림이 미결 → Q13, Q15로 해소
- verification_gap: 마크다운 왕복 무손실은 round-trip 테스트가 필요함을 D-13에 시딩
- next_action: Q13

## Audit History

### Audit 1
- type: local
- result: pass
- missing decision_ids: 없음
- unsupported assumptions: 없음
- UX or behavior gap: 없음
- highest-risk blocker: 없음
- final-blocking-question: 없음
- PRD impact: 마감 준비 완료
