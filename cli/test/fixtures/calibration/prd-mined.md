---
topic: "workspace-notes-sync"
status: "draft"
human_approval: "pending"
review_profile: "standard"
review_rationale: "런타임 동기화 동작과 외부 provider 연동을 추가하는 일반 제품 변경."
source_intake: "agents/intake/workspace-notes-sync/qa-log.md"
source_clarity: "none"
created_at: "2026-07-13"
updated_at: "2026-07-13"
---

# PRD: workspace notes sync

## 1. Summary

팀 워크스페이스의 회의 노트를 NotesHub와 양방향 동기화한다. 5분 주기 백그라운드 동기화와 수동 동기화 버튼을 제공하고, 삭제는 soft-delete로 전파한다.

Approval checklist:

- 범위: 회의 노트 폴더 한정, 첨부파일 제외 (§3)
- 삭제 전파: soft-delete + 30일 보존 (§6 R5)
- 충돌 처리 방식 (§6 R6)
- 검증: fake provider 통합 테스트 중심 (§9)

## 2. Problem, Goal, And Users

회의 노트가 팀 워크스페이스와 개인 노트 앱에 이중으로 존재해서 수동 복사가 잦다. 양방향 동기화로 한 곳에서 편집해도 양쪽이 맞게 한다. 사용자는 워크스페이스 멤버 전원이며, API 키 관리는 관리자 몫이다.

## 3. Scope And Non-Goals

포함: 회의 노트 폴더의 노트(제목/본문/태그) 양방향 동기화, 5분 주기 + 수동 트리거, soft-delete 전파, rate-limit 자체 상한.

Non-Goals:

- 첨부파일 동기화 (저장소 용량/권한 문제, revisit: 사용자 요청 누적 시)
- 개인 폴더 전체 동기화 (사용자 명시 거부)
- 태그 색상 동기화

## 4. Pre-Work And Required Decisions

### 4.1 Pre-Work Before Implementation

- NotesHub 팀 계정 API 키 발급 (워크스페이스 관리자만 가능 - 계정 소유권 필요)

### 4.2 Human Decisions Before PRD Approval

- Approval checklist 승인

### 4.3 Decision Traceability For Fidelity Review

- D-01 (user): 양방향 + 첨부 제외 → R1, non-goal
- D-02 (user): 5분 주기 + 수동 버튼 → R2, AC2
- D-03 (user): external_id 컬럼 매핑 → R3
- D-04 (fact): NotesHub 단건 upsert만, 분당 60 한도 → R7, guardrail
- D-05 (user): API 키 관리자 전용 → R4, AC4
- D-06 (user): 태그 이름 매칭 + 자동 생성 → R8
- D-07 (user): 제목 없는 노트는 첫 줄 절단 → R3
- D-08 (user): 회의 노트 폴더 한정 → non-goal
- D-09 (assumption): fake provider 검증 → V1, V2
- D-10 (user): 상대 시간 표시 → R2, AC3
- D-11 (user): soft-delete 전파 + 30일 → R5, AC5
- D-12 (user): 충돌 처리 → R6, AC6
- D-13 (user): rate-limit 자체 상한 + 백오프 → R7, AC7
- D-14 (user): 1MB 초과 노트 스킵 + 배지 + 자동 복귀 → R9, AC8
- D-15 (user): 아카이브 제외 + 상대편 아카이브 표현 금지 → R10, non-goal
- D-16 (user): CommonMark 교집합 변환 + 원문 보존 (왕복 무손실) → R11, AC9
- D-17 (user): sync_events 30일 보존, UI 없음 → R12, AC10
- D-18 (user): 권한 경계 (상실 이후 미반영, 회수 안 함) → R13, AC11
- D-19 (user): 실패 안내는 배너만, 이메일/슬랙 non-goal → R2, non-goal

## 5. Major Technical Structure Changes

- NotesHub API v2 연동 클라이언트 신설 (Bearer 키, 단건 upsert)
- notes 테이블에 external_id, sync_state 컬럼 추가
- 5분 주기 동기화 잡을 기존 스케줄러(jobs/scheduler.ts 패턴)에 등록

## 6. Requirements

- R1. 회의 노트 폴더의 노트(제목/본문/태그)가 워크스페이스와 NotesHub 간 양방향 동기화된다.
- R2. 동기화는 5분 주기 백그라운드와 수동 "지금 동기화" 버튼 두 경로로 동작하고, 목록 헤더에 마지막 동기화 시각이 상대 시간으로 표시된다.
- R3. 노트 매핑은 notes.external_id 컬럼으로 유지되고, 제목 없는 노트는 본문 첫 줄 40자를 제목으로 변환한다.
- R4. NotesHub API 키는 워크스페이스 설정에서 관리자만 등록/교체할 수 있고, 일반 멤버에게는 키 존재 여부만 보인다.
- R5. 한쪽에서 삭제된 노트는 상대편에서 휴지통으로 이동하고 30일 보존 후 영구 삭제된다.
- R6. 같은 노트가 양쪽에서 편집된 경우 시스템이 두 버전을 자동 병합(auto-merge)하여 최신 상태로 만든다.
- R7. 동기화는 분당 50 요청 자체 상한을 지키고, 초과분은 다음 주기로 이월하며, 429 수신 시 지수 백오프(최대 3회) 후 실패를 기록한다.
- R8. 태그는 이름 기준으로 매칭되고 상대편에 없는 태그는 자동 생성된다.
- R9. 본문 1MB 초과 노트는 해당 노트만 동기화에서 스킵되어 "너무 커서 동기화 제외" 배지가 표시되고, 본문이 1MB 이하로 줄면 다음 주기에 자동으로 다시 포함된다. 다른 노트의 동기화는 영향받지 않는다.
- R10. 아카이브된 노트는 동기화 대상에서 제외되고 해제 시 다음 주기부터 재포함된다. 상대편(NotesHub)에 아카이브 상태의 표현(태그 우회 포함)을 만들지 않는다.
- R11. 마크다운 변환은 CommonMark 교집합만 서식으로 변환하고 비지원 문법(콜아웃, 위키링크)은 원문 텍스트를 보존한다. 동기화 왕복 후 원문 마크다운이 바이트 단위로 달라지지 않는다.
- R12. 동기화 이벤트(방향, 노트 id, 결과, 소요 시간)는 sync_events 테이블에 기록되어 30일 보존되고, 30일 경과분은 일일 잡이 삭제한다. 사용자 UI에는 노출되지 않는다.
- R13. 폴더 접근 권한이 있는 멤버의 노트만 동기화 대상이다. 권한 상실 시점 이후의 변경은 반영되지 않으며, 이미 동기화된 내용은 회수하지 않는다.

## 7. Acceptance Criteria

- AC1. 한쪽에서 만든 노트가 다음 동기화 주기 안에 상대편에 나타난다.
- AC2. 수동 동기화 버튼을 누르면 진행 스피너가 표시되고 완료 시 토스트와 함께 헤더의 상대 시간이 갱신된다.
- AC3. 동기화가 적절히 빠르게 완료되어 사용자가 불편을 느끼지 않는다.
- AC4. 관리자가 아닌 멤버에게는 API 키 등록/교체 UI가 노출되지 않는다.
- AC5. 한쪽에서 삭제한 노트가 상대편 휴지통으로 이동하고, 30일 경과 시 영구 삭제된다.
- AC6. 양쪽에서 편집된 노트가 데이터 손실 없이 하나의 최신 버전으로 수렴한다.
- AC7. 분당 요청이 50을 넘지 않고, 429 발생 시 백오프 후 재시도가 기록된다.
- AC8. 1MB 초과 노트가 포함된 동기화에서 해당 노트만 스킵되어 배지가 표시되고 나머지 노트는 정상 동기화되며, 본문 축소 후 다음 주기에 배지가 사라지고 동기화된다.
- AC9. 콜아웃과 위키링크가 포함된 노트가 NotesHub로 나갔다가 돌아와도 원문 마크다운이 그대로 유지된다.
- AC10. 동기화 실행마다 sync_events에 행이 남고, 31일 지난 행은 조회되지 않는다.
- AC11. 폴더 권한이 없는 멤버의 노트는 동기화 대상 목록에 포함되지 않고, 권한 상실 후의 편집이 상대편에 반영되지 않는다.

## 8. PRD-Level Tasks

- T1. NotesHub 클라이언트 + 인증/키 관리. Covers R4, AC4.
- T2. 동기화 엔진 (양방향 diff, 매핑, 제목 변환). Covers R1, R3, AC1.
- T3. 삭제 전파 (soft-delete + 보존). Covers R5, AC5.
- T4. 충돌 수렴 처리. Covers R6, AC6.
- T5. rate-limit 상한/이월/백오프. Covers R7, AC7.
- T6. 트리거 2종 + 상태 표시 UI. Covers R2, AC2, AC3.
- T7. 통합 테스트 (fake provider) + 스테이징 스모크. 검증 태스크.
- T8. 대용량 스킵 + 배지 + 자동 복귀. Covers R9, AC8.
- T9. 마크다운 무손실 변환 계층 (왕복 round-trip 테스트 포함). Covers R11, AC9.
- T10. 아카이브 제외, 권한 경계, sync_events 기록/보존 잡. Covers R10, R12, R13, AC10, AC11.

## 9. Verification Contract

### 9.1 Test Mode Contract

| Mode | Required For Done | Covers | Human Decision |
| --- | --- | --- | --- |
| build/static | yes | repo 건강 | none |
| automated behavior | yes | 동기화 엔진/삭제/충돌/한도 회귀 | none |
| browser/runtime | yes | 수동 동기화 UX | 최종 UX 판단 |
| live external API | no/blockable | 스테이징 스모크 | 관리자 키 필요 |

### 9.2 Required Agent Verification

| ID | Mode | Covers | Pass Intent | Required For Done | Can Be Blocked |
| --- | --- | --- | --- | --- | --- |
| V1 | automated behavior | R1, R3, R5, R6, AC1, AC5, AC6 | fake provider 통합 테스트가 생성/수정/삭제/충돌 시나리오를 회귀 보호 | yes | no |
| V2 | automated behavior | R7, AC7 | 한도/이월/백오프 로직이 단위 테스트로 고정 | yes | no |
| V3 | browser/runtime | R2, AC2, AC3, R4, AC4 | 수동 동기화 흐름과 키 관리 노출 제어가 브라우저에서 동작 | yes | no |
| V4 | live external API | R1 | 스테이징 키로 왕복 1회 스모크 | no | yes |
| V5 | automated behavior | R9, R11, AC8, AC9 | 1MB 경계 픽스처와 콜아웃/위키링크 왕복 round-trip이 회귀 테스트로 고정 | yes | no |
| V6 | automated behavior | R10, R12, R13, AC10, AC11 | 아카이브 제외/권한 경계/sync_events 보존이 통합 테스트로 회귀 보호 | yes | no |

### 9.3 Human Verification

- 관리자 키 발급 및 스테이징 계정 소유권 (계정 소유자만 가능)

## 10. Risks And Open Decisions

- NotesHub API 스펙 변경 리스크: 클라이언트를 얇게 유지하고 계약 테스트로 감지.
- 수백 건 워크스페이스의 초기 동기화가 여러 주기에 걸쳐 완료됨 (rate-limit 이월): 초기 동기화 진행률 표시는 v2로 보류.

## 11. Implementation Guardrails

- NotesHub 배치 endpoint를 가정하지 않는다 (단건 upsert만).
- 회의 노트 폴더 밖의 노트를 읽거나 쓰지 않는다.
- 실 API 키를 CI에 넣지 않는다.

## 12. Implementation Result Report Contract

- status / 사용자 체감 변화 / R-AC-V 커버리지 / fake provider 테스트 증거 / 브라우저 증거 / deviations / 남은 인간 검증.
