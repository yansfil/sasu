---
topic: "workspace-notes-sync"
status: "complete"
where: "brownfield"
selected_packs: "ux, data, provider, risk, verification"
created_at: "2026-07-10"
updated_at: "2026-07-13"
question_count: 12
normalization_policy: "raw-capture-with-checkpoint-backfill"
normalization_checkpoint_every: 10
---

# Interview Log: workspace notes sync (complete)

## Current Understanding

- 팀 워크스페이스의 회의 노트를 개인 노트 앱(NotesHub)과 양방향 동기화한다.
- 5분 주기 백그라운드 + 수동 버튼. 첨부파일 제외, 회의 노트 폴더 한정.
- 삭제/충돌/rate-limit까지 결정 완료.

## Decision Register

| ID | Kind | Area | Decision / fact | Priority | Source / owner | Status | PRD mapping / revisit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| D-01 | decision | scope | 양방향 동기화, 첨부파일은 non-goal | P0 | user Q1 | resolved | R/AC, non-goal |
| D-02 | decision | ux | 5분 주기 + 수동 버튼(스피너/완료 토스트) | P1 | user Q2 | resolved | R/AC |
| D-03 | decision | data | 노트 매핑은 external_id 컬럼 | P1 | user Q3 | resolved | R |
| D-04 | fact | provider | NotesHub API v2는 단건 upsert만, 배치 없음, 분당 60 요청 한도 | P1 | provider docs | resolved | R/guardrail |
| D-05 | decision | provider | API 키는 워크스페이스 관리자 전용 관리 | P1 | user Q4 | resolved | R/AC |
| D-06 | decision | ux | 태그는 이름 매칭 + 자동 생성 | P1 | user Q5 | resolved | R/AC |
| D-07 | decision | data | 제목 없는 노트는 본문 첫 줄 40자 절단 | P2 | user Q6 | resolved | R |
| D-08 | decision | scope | 회의 노트 폴더 한정, 전체 동기화는 non-goal | P0 | user Q7 | resolved | non-goal |
| D-09 | decision | verification | fake provider 통합 테스트 + 스테이징 키 스모크 1회 | P1 | agent proposal, user 동의 Q8 | resolved | V |
| D-10 | decision | ux | 목록 헤더에 마지막 동기화 상대 시간 표시 | P2 | user Q9 | resolved | R/AC |
| D-11 | decision | data | 삭제는 soft-delete 전파: 한쪽에서 삭제되면 상대편은 휴지통으로 이동, 30일 보존 후 영구 삭제 | P0 | user Q10 | resolved | R/AC |
| D-12 | decision | ux | 편집 충돌은 자동 병합하지 않는다 - 자동 병합(auto-merge) 옵션은 명시적으로 기각. 충돌 노트는 "충돌" 배지를 달고 사용자가 두 버전을 나란히 보고 수동으로 해결한다 | P0 | user Q11 (자동 병합 기각 발언: "자동으로 합치면 회의록이 망가져, 절대 하지 마") | resolved | R/AC + 기각 옵션 가시화 |
| D-13 | decision | provider | rate-limit 대응: 분당 50 요청으로 자체 상한, 초과분은 다음 주기로 이월, 429 수신 시 지수 백오프(최대 3회) | P1 | user Q12 | resolved | R/AC/V |
| D-14 | decision | data | 본문 1MB 초과 노트는 해당 노트만 동기화 스킵 + "너무 커서 동기화 제외" 배지, 1MB 이하로 줄면 다음 주기 자동 포함 | P1 | user Q13 | resolved | R/AC |
| D-15 | decision | scope | 아카이브된 노트는 동기화 제외, 해제 시 다음 주기부터 재포함. 상대편에 아카이브 표현(태그 우회 포함)을 만들지 않는다 | P1 | user Q14 | resolved | R, non-goal |
| D-16 | decision | data | 마크다운은 CommonMark 교집합만 변환, 비지원 문법(콜아웃/위키링크)은 원문 텍스트 보존. 왕복 후 원문 불변이 우선순위 1 | P1 | user Q15 | resolved | R/AC/V |
| D-17 | decision | operation | 동기화 이벤트는 sync_events 테이블 30일 보존, UI 노출 없음, 30일 경과분 일일 잡 삭제 | P2 | user Q16 | resolved | R |
| D-18 | decision | risk | 폴더 접근 권한 있는 멤버의 노트만 대상, 권한 상실 이후 변경 미반영, 기존 반영분 회수 안 함 (revisit: 보안 요건 강화) | P1 | user Q17 | resolved | R/AC |
| D-19 | decision | operation | 실패 안내는 목록 헤더 배너로만. 이메일/슬랙 알림은 non-goal (revisit: 관리자 다수 요청) | P2 | user Q18 | resolved | non-goal |

## Raw Q&A

### Q10: 삭제 전파
- decision_ids: D-11
- route: user-decision
- asked: 한쪽에서 노트가 삭제되면 상대편을 어떻게 할지.
- recommended: soft-delete 전파 + 30일 보존
- answer: 휴지통으로 보내고 30일 뒤 지워. 바로 지우는 건 무서워.
- needs_normalization: false

### Q11: 편집 충돌
- decision_ids: D-12
- route: user-decision
- asked: 같은 노트가 양쪽에서 편집됐을 때 (오프라인 포함).
- recommended: 자동 병합 (마지막 수정 우선) 또는 수동 해결
- answer: 자동으로 합치면 회의록이 망가져, 절대 하지 마. 충돌 배지 달고 내가 두 버전 보고 고를래.
- needs_normalization: false

### Q12: rate limit
- decision_ids: D-13
- route: mixed
- asked: NotesHub 분당 60 한도에 주기 동기화가 걸릴 수 있음 (노트 수백 건 워크스페이스).
- recommended: 자체 상한 50/분 + 이월 + 429 백오프
- answer: 그렇게 가. 한도 초과로 동기화가 조용히 죽는 것만 없게 해줘.
- needs_normalization: false

### Q13: 대용량 노트
- decision_ids: D-14
- route: mixed
- asked: NotesHub 본문 1MB 제한(413 응답) 대응. 옵션: 잘라 올림 / 노트만 스킵+배지 / 전체 중단.
- recommended: 노트만 스킵 + 배지 (자르면 손실, 전체 중단은 과잉)
- answer: "잘라 올리는 건 절대 안 돼 - 회의록 뒷부분이 날아가잖아. 그 노트만 빼고 계속 돌아. 줄이면 자동으로 다시 붙는 걸로."
- needs_normalization: false

### Q14: 아카이브 노트
- decision_ids: D-15
- route: user-decision
- asked: 아카이브 기능과 동기화의 상호작용 (NotesHub에 대응 개념 없음).
- recommended: 아카이브 = 제외, 해제 시 재포함
- answer: "끝난 회의를 개인 노트에 계속 밀어넣을 필요 없어. NotesHub 쪽에 태그로 아카이브 흉내 내는 것도 하지 마."
- needs_normalization: false

### Q15: 마크다운 방언
- decision_ids: D-16
- route: mixed
- asked: 콜아웃(:::info)/위키링크([[...]])는 NotesHub CommonMark 미지원 - 변환 정책.
- recommended: 교집합만 변환, 비지원은 원문 보존 (왕복 무손실)
- answer: "무손실이 제일 중요해. 저쪽에서 안 예쁘게 보이는 건 참아도 돌아왔을 때 깨져 있으면 못 참아."
- needs_normalization: false

### Q16: 동기화 이력
- decision_ids: D-17
- route: user-decision
- asked: 운영 디버깅용 동기화 추적 필요 여부.
- recommended: sync_events 30일, UI 없음
- answer: "우리가 조회만 할 수 있으면 돼. 한 달치면 충분."
- needs_normalization: false

### Q17: 권한 경계
- decision_ids: D-18
- route: user-decision
- asked: 폴더 권한 없는/잃은 멤버의 노트 처리.
- recommended: 권한 있는 노트만, 상실 이후 미반영, 기존분 회수 안 함
- answer: "권한 없는 건 안 나가야지. 이미 나간 걸 지우러 다니는 건 오버 - 보안 요건 빡세지면 그때 다시."
- needs_normalization: false

### Q18: 실패 알림
- decision_ids: D-19
- route: user-decision
- asked: 반복 실패 시 알림 채널.
- recommended: 헤더 배너만
- answer: "배너면 돼. 이메일까지 가면 스팸이야."
- needs_normalization: false

## UX Scenario Cards

### UX-01: 수동 동기화
- trigger: "지금 동기화" 버튼
- happy path: 스피너 → 완료 토스트 → 상대 시간 갱신
- state / failure: API 키 부재/만료 시 관리자 안내 배너
- recovery: 배너에서 키 관리 섹션으로 이동
- proof: fake provider 통합 테스트 + 브라우저 스모크
- linked decisions: D-02, D-05

### UX-02: 편집 충돌 해결
- trigger: 양쪽 동시 편집이 감지된 노트
- happy path: 노트에 "충돌" 배지, 열면 두 버전 나란히 비교, 사용자가 한쪽 선택 또는 수동 편집으로 해결
- state / failure: 해결 전까지 해당 노트는 동기화에서 제외되고 배지가 유지된다
- recovery: 해결 시 배지 제거 + 다음 주기에 정상 동기화
- proof: fake provider 통합 테스트 (충돌 시나리오 픽스처)
- linked decisions: D-12

## Audit History

### Audit 1
- type: gap-audit-gate
- result: pass
- missing decision_ids: 없음
- highest-risk blocker: 없음
- PRD impact: 마감
