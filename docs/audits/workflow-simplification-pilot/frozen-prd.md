---
topic: "link-pocket"
status: "ready"
human_approval: "pending"
review_profile: "standard"
review_rationale: "로컬 브라우저 데이터의 생성·수정·삭제와 복구를 포함하는 새 사용자 화면이지만 외부 계정, 민감 데이터, 유료 호출, 배포 효과는 없다."
source_intake: "current conversation"
created_at: "2026-09-08"
updated_at: "2026-09-08"
---

# PRD: Link Pocket

## Goal

계정이나 외부 서비스 없이 같은 브라우저에서 유용한 링크를 안전하게 저장하고, 빠르게 찾고, 열고, 수정하고, 삭제 후 복구할 수 있는 단일 페이지 작업공간을 만든다.

## Non-goals

- 인증, 사용자 계정, 기기·프로필 간 동기화, 공유와 협업은 제공하지 않으므로 데이터는 현재 브라우저 프로필에만 남으며, 별도 다중 사용자 요구와 데이터 경계 승인이 생길 때 재검토한다.
- 분석, 외부 API, 유료 서비스, 원격 메타데이터·favicon 조회, 실제 사용자 데이터와 배포는 포함하지 않으므로 링크 정보가 자동 보강되거나 외부로 전송되지 않으며, 별도 운영 범위가 승인될 때 재검토한다.
- 여러 탭에서 동시에 편집한 결과의 충돌 조정은 보장하지 않으므로 마지막으로 성공한 전체 문서 저장이 남으며, 다중 탭 사용이 요구되면 revision 기반 충돌 UX를 재검토한다.
- starter의 Vite·TypeScript·Playwright 스택과 package scripts를 교체하거나 병렬 제품 기반을 추가하지 않으며, 현 스택으로 계약을 충족할 수 없다는 근거와 구조 변경 승인이 생길 때만 재검토한다.

## Decisions

| D-n | 결정 | 근거 |
| --- | --- | --- |
| D-01 | Link Pocket은 링크의 저장, 탐색, 열기, 수정, 삭제와 복구를 한 화면에서 수행하는 로컬 웹 앱으로 정한다. | 가정: 코디네이터가 시험용으로 제공한 seed-brief의 제품 선택이며 사용자가 제품 항목을 직접 승인한 것은 아니다. |
| D-02 | 제품은 계정, 외부 API, 유료 서비스, 배포와 실제 사용자 데이터 없이 로컬에서 결정적으로 동작한다. | 가정: 코디네이터가 시험용으로 제공한 seed-brief의 제품 조건이다. |
| D-03 | 헤더와 Add link, 검색·태그 제어, compact link rows를 한 작업공간에 두고 생성·수정은 컬렉션 위의 modal로 연다. | 가정: seed-brief의 obvious layout candidate를 그대로 채택했으며 다른 구조에 대한 사용자 선택은 없었다. |
| D-04 | 링크는 stable id, 필수 title·URL, 선택 note·tags, createdAt·updatedAt과 안정적인 정렬 순서를 보존한다. | 가정: seed-brief 요구 6, 9, 14, 29를 손실 없이 연결하기 위한 데이터 계약이다. |
| D-05 | 저장의 유일한 영속 경계는 `link-pocket:data:v1` 키의 `{ version: 1, nextOrder, items }` 문서이며 README에도 같은 키를 기록한다. | 가정: seed-brief 요구 15-18과 문서화 제약을 만족하는 작성자 선택이다. |
| D-06 | 키가 없는 경우만 정상 empty로 보고, JSON·스키마가 잘못됐거나 version이 1이 아니면 원문을 보존한 채 load failure로 닫는다. | 가정: seed-brief 요구 17-18과 engineering 원칙 4·10의 명시적 실패 경계를 적용했다. |
| D-07 | create·edit·delete·undo는 다음 전체 문서를 먼저 영속화한 뒤 화면 상태를 확정하고, 실패하면 직전 컬렉션과 사용자의 미완료 작업을 보존한다. | 가정: seed-brief 요구 19, 29와 engineering 원칙 4·11의 수렴 가능한 재시도 경계를 적용했다. |
| D-08 | 목록은 `updatedAt`을 표시하고 증가하는 `nextOrder`에서 발급한 정렬 값의 내림차순으로 배치하며, undo는 삭제 전 정렬 값을 복원한다. | 가정: 동일 시각과 브라우저 시계 변화에도 요구 14·29의 순서를 결정적으로 보장하는 작성자 선택이다. |
| D-09 | 검색은 정규화한 query를 title·URL·note·tags에 대소문자 없이 적용하고, 선택 tag와 교집합으로 결합한다. | 가정: seed-brief 요구 20-26의 검색 의미를 통합했다. |
| D-10 | URL 열기는 안전한 새 탭, 복사는 exact saved URL과 item-scoped feedback, 삭제는 10초 동안 한 건의 undo를 제공하며 undo 성공도 즉시 영속화한다. | 가정: seed-brief 요구 27-29에 필요한 사소한 시간·복구 정책을 작성자가 선택했다. |
| D-11 | 접근 가능한 이름, visible focus, modal 진입 focus, Escape 취소, focus를 뺏지 않는 live feedback을 키보드·보조기술 계약으로 둔다. | 가정: seed-brief 요구 30을 상호작용 의미 단위로 보존했다. |
| D-12 | 360 CSS px부터 desktop까지 compact list 흐름을 유지하고, 실제 데이터에서 나온 count와 상태만 표시한다. | 가정: seed-brief 요구 1-4, 23, 31-32와 design 원칙 1·2·4·9·10·12를 적용했다. |
| D-13 | 기존 Vite·TypeScript 런타임과 Playwright·Chrome 검증 경계를 유지하고 새 런타임 패키지를 추가하지 않는다. | 가정: starter 소스와 package.json, engineering 원칙 2·7에 따른 가장 단순한 완전 구현 경계다. |
| D-14 | committed browser tests는 자체 서버와 브라우저를 시작·정리하고 Chromux를 사용하지 않으며, 기존 `npm run check`를 전체 검증 진입점으로 유지한다. | 가정: seed-brief 제약과 starter의 package scripts·Playwright browser-server 경계를 반영했다. |

## Behaviors

| # | 사용자가 관찰하는 행동 | 결정 |
| --- | --- | --- |
| B1 | 앱은 `Link Pocket` 제목의 단일 페이지 작업공간으로 열리고, 주 화면에 저장된 링크 목록과 현재 보이는 항목 수가 함께 나타난다. | D-01, D-03, D-12 |
| B2 | 초기 저장 문서를 판별하는 동안 loading 상태가 보이고, 판별 전에는 empty나 sample link를 성공 상태처럼 보이지 않는다. | D-05, D-06, D-12 |
| B3 | 정상 저장 항목이 0개일 때만 목적을 설명하는 first-time empty와 기본 `Add link`가 보이며, 항목이 하나라도 있으면 이 메시지는 보이지 않는다. | D-01, D-03, D-12 |
| B4 | `Add link`를 실행하면 기존 컬렉션을 가리지 않고 그 위에 집중된 생성 modal이 열린다. | D-03 |
| B5 | 생성·수정 modal은 필수 title·URL과 선택 note·tags 필드를 제공한다. | D-04 |
| B6 | title은 앞뒤 공백을 제거해 저장하며, 제거 후 빈 값이면 입력값을 잃지 않고 해당 필드에서 오류를 알린다. | D-04, D-07 |
| B7 | URL은 유효한 `http://` 또는 `https://`만 받아들이며, 그 밖의 값은 입력값을 잃지 않고 해당 필드에서 오류를 알린다. | D-04, D-07 |
| B8 | 쉼표로 입력한 tags는 각각 앞뒤 공백과 빈 항목을 제거하고, 대소문자만 다른 중복은 처음 입력한 표기를 남긴다. | D-04 |
| B9 | 유효한 생성 저장은 정확히 한 항목을 목록에 추가하고 modal을 닫으며, 중복 제출은 항목을 더 만들지 않는다. | D-04, D-07 |
| B10 | 새 링크 생성을 취소하면 아무 항목도 만들지 않고 기존 컬렉션을 그대로 유지한다. | D-03, D-07 |
| B11 | 수정을 열면 선택한 항목의 같은 필드가 미리 채워지고, 저장하면 duplicate 없이 그 stable id의 항목만 갱신한다. | D-04, D-07 |
| B12 | 각 행은 마지막 수정 시각을 표시하고 새로 만들거나 수정한 항목은 가장 위로 이동하며, 동률이나 시계 변화에도 순서는 안정적이다. | D-04, D-08 |
| B13 | 같은 브라우저 프로필에서 전체 페이지를 reload하면 저장한 title·URL·note·tags와 정렬 순서가 그대로 복원된다. | D-04, D-05, D-08 |
| B14 | save·search·edit·delete는 `link-pocket:data:v1` 한 키의 로컬 데이터만 사용하고 네트워크 요청을 만들지 않는다. | D-02, D-05 |
| B15 | 저장 문서가 malformed이거나 지원하지 않는 version이면 앱은 이를 성공한 빈 컬렉션으로 바꾸거나 원문을 덮어쓰지 않는다. | D-06 |
| B16 | load failure 화면은 실패를 명시하고 `Retry`와 `Reset local data`를 제공하며, reset은 저장 컬렉션이 삭제된다고 밝히고 확인 전에는 실행하지 않는다. | D-05, D-06 |
| B17 | retry는 같은 키를 다시 읽고, reset 삭제가 실패하면 오류 상태와 원문을 유지하며, reset이 성공한 뒤에만 정상 empty로 전환한다. | D-05, D-06, D-07 |
| B18 | create나 edit을 영속화할 수 없으면 form 값과 기존 컬렉션을 유지하고 visible save error를 알리며 저장 성공을 표시하지 않는다. | D-07 |
| B19 | 저장 항목이 있으면 별도 화면 이동 없이 검색 필드가 목록과 함께 보인다. | D-03, D-09 |
| B20 | 검색은 입력할 때마다 title·URL·note·tags를 대소문자 없이 찾고 query의 앞뒤 공백은 결과를 바꾸지 않는다. | D-09 |
| B21 | visible count는 전체 저장 수가 아니라 현재 search·tag 교집합 결과의 실제 행 수로 즉시 갱신된다. | D-09, D-12 |
| B22 | 저장 항목은 있지만 결과가 0개이면 first-time empty와 구별되는 no-results가 보이고, `Clear search`로 전체 목록과 count를 복원한다. | D-09, D-12 |
| B23 | 행의 tag를 선택하면 그 tag로 필터링되고 이미 입력한 검색 query와 함께 적용된다. | D-09 |
| B24 | 저장 URL을 열면 새 브라우저 탭을 사용하고 열린 페이지가 Link Pocket 탭의 window를 제어할 수 없다. | D-10 |
| B25 | Copy URL은 선택한 항목의 저장 URL을 정확히 복사하고 그 행에 짧은 성공 feedback을 표시하며, 복사 실패도 거짓 성공 없이 알린다. | D-10, D-11 |
| B26 | Delete가 영속화되면 행이 즉시 사라지고 10초 undo가 나타나며, 실패하면 행을 유지하고 오류를 알린다. | D-07, D-10 |
| B27 | undo는 stable id, 모든 필드, timestamps와 이전 정렬 값을 포함한 완전한 항목을 복원해 영속화하며, 이후 reload에도 복원 결과가 남는다. | D-07, D-08, D-10 |
| B28 | 모든 form field와 icon-only action은 접근 가능한 이름이 있고, 키보드 focus 표시는 항상 보인다. | D-11 |
| B29 | modal을 열면 focus가 첫 입력으로 이동하고, `Escape`는 저장 없이 cancel과 같은 결과로 닫는다. | D-03, D-11 |
| B30 | save·copy·load·validation·persistence feedback은 보조기술에 발표되지만 현재 focus를 빼앗지 않는다. | D-07, D-11 |
| B31 | 360 CSS px와 desktop 폭에서 가로 page overflow 없이 사용할 수 있고, 긴 URL·tags도 경계를 깨지 않으며 primary action은 hover 없이 도달한다. | D-03, D-12 |
| B32 | loading, first-time empty, populated, filtered no-results, malformed-data와 save-failure가 시각적으로 구분되고, sample link나 hard-coded count는 어느 상태에도 나타나지 않는다. | D-06, D-07, D-12 |
| B33 | README는 `npm ci`, `npm run dev`, `npm run check`를 포함한 정확한 설치·로컬 실행·테스트 명령과 `link-pocket:data:v1` 저장 키를 알려준다. | D-05, D-13, D-14 |
| B34 | committed browser 검증은 자체 Vite server와 Chrome runner를 시작·정리하고 Chromux나 이미 실행 중인 브라우저에 의존하지 않는다. | D-13, D-14 |

## Technical structure

기존 Vite·TypeScript 단일 페이지 런타임 안에서 collection 상태와 파생 search·tag 결과, form·feedback 상호작용, 저장 경계를 분리한다.
브라우저 저장 경계는 `link-pocket:data:v1`의 version 1 문서 전체를 검증하고 읽기·쓰기·삭제 실패를 caller-visible 결과로 반환하며, UI는 성공한 영속화 뒤에만 컬렉션을 확정한다.
각 항목의 stable id, timestamps와 monotonic order가 편집·정렬·undo의 데이터 진실이고, schema migration은 만들지 않으며 지원하지 않는 version을 명시적 load failure로 보낸다.
백엔드, API, 데이터베이스, 인증, 결제, email, queue, remote sync와 production infrastructure는 추가하지 않는다.
검증은 기존 Playwright Chrome 경계와 `npm run check`를 확장해 실제 브라우저에서 주요 흐름과 실패·복구 결과를 관찰하되, committed test 바깥의 수동 브라우저 QA는 구현 단계의 별도 실행 증거로 남긴다.

## Risks

- 브라우저 용량 제한, privacy mode나 정책으로 로컬 쓰기가 실패할 수 있으므로 persist-then-publish와 visible 오류로 메모리·화면이 거짓 성공 상태가 되는 것을 막는다.
- malformed 문서를 임의 보정하면 저장 데이터를 잃거나 다른 의미로 바꿀 수 있으므로 전체 schema를 fail-closed로 검증하고 raw 값은 확인된 reset 전까지 보존한다.
- `Reset local data`는 되돌릴 수 없는 삭제이므로 대상과 결과를 명시하고 확인 뒤 실행하며, 사용자 승인 전 production 또는 실제 사용자 데이터에는 적용하지 않는다.
- delete·undo가 일부 필드나 정렬 값을 잃을 수 있으므로 완전한 항목 snapshot을 복원하고 성공한 전체 문서를 다시 읽을 수 있어야 한다.
- 여러 탭의 stale write는 현재 범위에서 조정되지 않으므로 다중 탭 안전성을 주장하지 않고, 요구가 생기면 충돌 감지와 storage 구조를 다시 승인받는다.
- popup·clipboard 권한이나 브라우저 정책은 open·copy를 막을 수 있으므로 item-scoped 실패를 알리고 성공으로 가장하지 않는다.
- 긴 URL·tags와 실제 문구가 작은 화면에서 overflow 또는 focus 손실을 만들 수 있으므로 실제 360px·desktop Chrome에서 wrapping, spacing, keyboard와 announcement를 함께 확인한다.
- 코드·README의 저장 key/version이 어긋날 수 있으므로 한 계약 값을 사용하고 둘의 일치를 전체 검증에 포함한다.
- 외부 credential, 계정, 구매, 실제 데이터와 배포는 필요하지 않다.
