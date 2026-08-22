---
topic: "logscan"
status: "ready"
human_approval: "approved"
human_approval_note: "2026-08-22 사용자가 implement 오케스트레이션 병렬화 측정을 위한 고정 워크로드로 이 PRD를 승인했다."
review_profile: "standard"
review_rationale: "로컬 파일만 읽는 오프라인 CLI로 인증, 결제, 네트워크 호출, 서버 데이터, 되돌릴 수 없는 부수효과가 없다. 쓰기 대상은 표준 출력뿐이다."
source_intake: "current conversation"
created_at: "2026-08-22"
updated_at: "2026-08-22"
---

# PRD: logscan

## 1. Summary

저장소 루트의 `logscan/`에 설치와 빌드 없이 실행되는 오프라인 로그 포렌식 CLI를 만든다.
고정 포맷의 로그 파일을 읽어 서로 독립적인 탐지기 5종을 돌리고, 결과를 심각도 순으로 집계해 사람이 읽는 리포트와 JSON으로 내보내며, 심각도 임계값에 따른 종료 코드를 반환한다.
런타임 npm 의존성과 네트워크 호출은 없고 Node 내장 모듈과 내장 테스트 러너만 사용한다.

이 PRD는 동시에 sasu 하네스의 병렬 오케스트레이션 측정용 고정 워크로드다.
`pokemon-rpg` 케이스는 task 의존성이 완전 직렬이라 fan-out 폭이 1이고, 구현 구간의 병렬화 이득을 관측할 수 없다.
이 케이스는 의도적으로 폭 5의 독립 capability를 갖는다: T2부터 T6은 서로를 참조하지 않고, 각자 자기 탐지기 모듈과 자기 테스트 파일만 소유한다.

제품 계약은 사용자가 관찰할 행동, 고정 규칙, 검증 의도만 소유한다.
정확한 파일 배치, 모듈 분할, 실행 명령은 저장소를 읽은 구현 계획이 바인딩한다.

Approval checklist:

- 스코프와 non-goal - §3
- 고정 로그 문법과 탐지 규칙 - §6
- task 의존성 그래프가 폭 5의 fan-out을 갖는다는 계약 - §8
- required-for-done 검증 모드와 고유 실패 책임 - §9
- 탐지 규칙 임의 축소 금지 - §11

## 2. Problem, Goal, And Users

**Problem.**
하네스를 개선하는 사람은 구현 구간의 wall-clock이 실제로 병렬화로 줄어드는지 알아야 한다.
현재 고정 벤치마크는 완전 직렬 체인이라 오케스트레이션 전략을 바꿔도 비교 대상이 생기지 않는다.
동시에 워크로드가 너무 얕으면 각 task가 몇 초에 끝나 전략 차이가 측정 잡음에 묻힌다.

**Goal.**
독립 capability 5개가 실제로 각각 유의미한 구현량을 갖는 워크로드를 제공한다.
탐지 규칙은 경계값까지 결정적으로 재현 가능해야 한다.
각 acceptance criterion은 기계 실행으로 독립 판정할 수 있어야 한다.

**Users.**

- 로그 파일에서 이상 신호를 한 번에 훑고 싶은 운영자.
- 이 저장소에서 implement 오케스트레이션 전략을 비교 측정하는 사람과 에이전트.

## 3. Scope And Non-Goals

### In Scope

- 고정 문법의 로그 파일을 읽어 구조화 레코드로 파싱하고, 깨진 줄을 버리지 않고 별도로 계수한다.
- 탐지기 5종: 트래픽 버스트, 에러 클러스터, 지연 회귀, 고아 요청, 비밀정보 노출.
- 탐지 결과의 심각도 등급화, 서비스 단위 상관 묶음, 사람이 읽는 리포트, `--json` 출력.
- `--fail-on` 임계값에 따른 종료 코드 계약.
- Node 내장 테스트 러너 기반 회귀 테스트와 CLI 실증.

### Non-Goals

- **로그 수집, 스트리밍, tail 추적.**
  결과는 완결된 파일 하나를 읽는 일회성 실행이다.
  입력 경로를 바꾸면 파이프라인 설계가 필요하므로 제외한다.
  지속 감시 요구가 생기면 재검토한다.
- **정규식 사용자 정의 탐지기와 플러그인 로딩.**
  탐지기는 §6에 고정된 5종이다.
  외부 코드 로딩은 신뢰 경계를 만들므로 제외한다.
- **JSON 로그, logfmt, syslog 등 다중 입력 문법.**
  §6.1의 단일 문법만 지원한다.
- **네트워크 전송, 알림, 티켓 생성.**
  출력은 표준 출력뿐이다.
- **런타임 npm 의존성, 번들러, 트랜스파일러.**
  Node 내장 모듈만 사용한다.
- **머신러닝 기반 이상탐지.**
  탐지는 §6.2의 고정 임계값 규칙이다.

## 4. Pre-Work And Required Decisions

### 4.1 Pre-Work Before Implementation

`None required.`

계정, 자격증명, 결제, 외부 서비스가 필요하지 않다.

### 4.2 Human Decisions Before PRD Approval

- §3의 스코프와 non-goal을 승인한다.
- §6.1 로그 문법과 §6.2 탐지 규칙의 구체 임계값을 고정 계약으로 승인한다.
- §8의 task 의존성 그래프가 T1 이후 폭 5로 갈라지고 T7에서 합류한다는 구조를 승인한다.
- §9의 검증 모드와 pass intent를 승인하고, 구체 명령은 구현 시 바인딩한다는 경계를 승인한다.

### 4.3 Decision Traceability For Fidelity Review

이 고정 benchmark PRD는 승인된 결정을 아래 표에 자체 포함한다.
실행 worktree에서는 이 절이 fidelity review의 canonical source다.

| ID | Type | PRD disposition |
| --- | --- | --- |
| D-01 | scope | 완결된 파일 하나를 읽는 일회성 CLI로 한정하고 수집·스트리밍은 제외한다(§3). |
| D-02 | scope | 탐지기는 고정 5종이며 플러그인 로딩을 두지 않는다(§3, §6.2). |
| D-03 | contract | 로그 문법은 §6.1 하나뿐이고 다중 포맷을 지원하지 않는다. |
| D-04 | contract | 깨진 줄은 조용히 버리지 않고 `malformed` 카운트로 보고한다(AC2). |
| D-05 | contract | 모든 임계값은 §6.2에 고정되며 사용자 설정으로 노출하지 않는다. |
| D-06 | contract | p95는 nearest-rank 방식으로 계산한다(§6.2 D3). |
| D-07 | contract | 비밀정보는 원문 그대로 출력하지 않고 마스킹해 보고한다(§6.2 D5, AC12). |
| D-08 | structure | T2부터 T6은 서로를 import 하지 않으며 각자 자기 탐지기 모듈만 소유한다(§8, §11). |
| D-09 | contract | 종료 코드는 0/1/2 세 가지이며 `--fail-on` 기본값은 `high`다(§6.3). |
| D-10 | dependency | 런타임 npm 의존성 0을 유지하고 Node 내장 모듈과 내장 테스트 러너만 쓴다(§3, AC16). |
| D-11 | verification | 검증은 정적 검사, 규칙 회귀, CLI 실증 세 모드로 하고 브라우저와 시각 판정은 두지 않는다(§9). |
| D-12 | measurement | 이 케이스의 목적은 구현 구간 병렬화 측정이며 앱에 계측 코드를 넣지 않는다(§11). |

## 5. Major Technical Structure Changes

- 저장소 루트에 새 제품 디렉터리 `logscan/`을 만든다. 기존 `cli/`, `skills/`, `tests/`, `agents/`는 건드리지 않는다.
- 파싱 계층, 탐지 계층, 집계·표현 계층의 책임 경계를 분리한다.
  탐지기는 파싱된 레코드 배열만 입력으로 받고 파일 입출력과 출력 포맷을 알지 못한다.
- 탐지기는 공통 인터페이스를 통해 등록된다: 각 탐지기는 `{ id, run(records) -> Finding[] }` 형태를 만족한다.
  이 인터페이스가 T2부터 T6이 서로를 참조하지 않고 병렬 구현될 수 있게 하는 경계다.
- Node 내장 테스트 러너를 쓰며 탐지기마다 자기 테스트 파일을 소유한다.

## 6. Requirements

### 6.1 Fixed Log Grammar

로그 한 줄의 문법은 다음 하나로 고정한다.

```text
<ISO8601> <LEVEL> <service> [req=<id>] [dur=<n>ms] msg="<text>"
```

- `<ISO8601>`은 `2026-08-22T10:15:30.123Z` 형태의 UTC 타임스탬프다.
- `<LEVEL>`은 `DEBUG`, `INFO`, `WARN`, `ERROR` 중 하나다.
- `<service>`는 공백 없는 식별자다.
- `req=`와 `dur=`는 선택이며 `dur`은 정수 밀리초다.
- `msg="..."`는 필수이며 값 안의 `\"`는 이스케이프된 큰따옴표다.
- 위 문법에 맞지 않는 줄은 `malformed`로 계수하고 원본 줄 번호를 보존한다.
- 빈 줄과 `#`로 시작하는 줄은 주석으로 무시하며 `malformed`가 아니다.

### 6.2 Fixed Detection Rules

- **D1 traffic-burst.**
  서비스별로 첫 레코드 시각을 기준으로 60초 tumbling window를 만든다.
  빈 window도 개수 0으로 포함한다.
  해당 서비스의 window 개수 중앙값을 `m`이라 할 때, 개수가 `10` 이상이고 동시에 `3 * m` 이상인 window를 버스트로 보고한다.
  `m`이 0이면 `3 * m` 조건은 만족한 것으로 본다.
  severity는 `low`다.
- **D2 error-cluster.**
  `ERROR` 레코드의 `msg`를 정규화한다: 8자리 이상 16진수 연속은 `<hex>`, 그 외 숫자 연속은 `#`, 큰따옴표로 감싼 부분 문자열은 `<str>`로 치환한다.
  정규화 후 동일 signature가 `5`회 이상 나타나면 클러스터로 보고하며 대표 원문 1개와 발생 횟수를 포함한다.
  severity는 `high`다.
- **D3 latency-regression.**
  `dur`이 있는 레코드를 서비스별로 시간 오름차순 정렬한다.
  표본이 `40`개 미만이면 그 서비스는 판정하지 않는다.
  앞 절반과 뒤 절반으로 나누고 각각의 p95를 nearest-rank(`ceil(0.95 * n)`번째, 1-based)로 구한다.
  `p95(뒤) >= 1.5 * p95(앞)`이면 회귀로 보고하며 두 값을 포함한다.
  severity는 `medium`이다.
- **D4 orphan-request.**
  `req` 값이 있는 레코드를 요청 id로 묶는다.
  `msg`가 `start `로 시작하는 레코드가 있으나 같은 id에 더 나중 시각의 `end ` 또는 `fail `로 시작하는 레코드가 없으면 고아 요청으로 보고한다.
  `start ` 없이 `end `만 있는 id도 고아로 보고하되 사유를 구분한다.
  severity는 `high`다.
- **D5 secret-leak.**
  레벨과 무관하게 모든 레코드의 `msg`에서 다음을 탐지한다.
  AWS 액세스 키 `AKIA[0-9A-Z]{16}`, `Bearer [A-Za-z0-9._-]{20,}`, `-----BEGIN` 으로 시작하고 `PRIVATE KEY-----`로 끝나는 헤더, `password=` 뒤에 이어지는 공백 아닌 문자 1자 이상.
  보고 시 매칭 문자열은 앞 4자만 남기고 나머지를 `*`로 마스킹한다.
  severity는 `critical`이다.

### 6.3 Aggregation And Exit Contract

- 심각도 순서는 `critical` > `high` > `medium` > `low`다.
- 리포트는 심각도 내림차순, 같은 심각도 안에서는 탐지기 id 사전순, 그 안에서는 subject 사전순으로 정렬한다.
- 같은 서비스에 속한 findings는 리포트에서 하나의 상관 묶음으로 제시하고 그 서비스의 최고 심각도를 묶음 심각도로 표시한다.
- `--json`은 `{ summary, findings, malformed }` 구조를 표준 출력에 낸다.
- `--fail-on <level>`의 기본값은 `high`다.
- 종료 코드: 임계값 이상 finding이 없으면 `0`, 하나 이상이면 `1`, 사용법 오류나 입력 파일 오류면 `2`다.

### 6.4 Requirement List

- R1. CLI는 로그 파일 경로 하나를 인자로 받아 실행되며 설치 단계 없이 동작한다.
- R2. §6.1 문법을 파싱해 구조화 레코드를 만들고 malformed 줄을 줄 번호와 함께 계수한다.
- R3. 주석과 빈 줄을 malformed로 세지 않는다.
- R4. 탐지기는 §5의 공통 인터페이스로 등록되며 파싱 결과만 입력으로 받는다.
- R5. D1 traffic-burst를 §6.2대로 구현한다.
- R6. D2 error-cluster를 §6.2대로 구현한다.
- R7. D3 latency-regression을 §6.2대로 구현한다.
- R8. D4 orphan-request를 §6.2대로 구현한다.
- R9. D5 secret-leak을 §6.2대로 구현하고 원문 비밀정보를 출력하지 않는다.
- R10. 심각도 등급과 정렬 규칙을 §6.3대로 적용한다.
- R11. 서비스 단위 상관 묶음을 리포트에 제시한다.
- R12. `--json` 출력과 사람이 읽는 리포트를 모두 제공한다.
- R13. `--fail-on`과 종료 코드 계약을 §6.3대로 지킨다.
- R14. 런타임 npm 의존성과 네트워크 호출이 0이다.

## 7. Acceptance Criteria

- AC1. 모든 소스 모듈이 구문 오류 없이 해석되고 CLI 진입이 실패하지 않는다.
- AC2. §6.1 문법의 유효 줄이 구조화 레코드로 파싱되고, 문법 위반 줄은 원본 줄 번호와 함께 malformed로 계수되며, 빈 줄과 `#` 주석은 malformed에 포함되지 않는다.
- AC3. `msg` 값 안의 이스케이프된 큰따옴표가 값의 끝으로 오인되지 않는다.
- AC4. 탐지기 5종이 모두 공통 인터페이스로 등록되어 있고, 각 탐지기 모듈은 다른 탐지기 모듈을 import 하지 않는다.
- AC5. D1은 개수 10 이상이면서 중앙값의 3배 이상인 window만 보고하고, 경계값(정확히 10, 정확히 3배)을 포함하며, 빈 window를 중앙값 계산에 포함한다.
- AC6. D2는 숫자·16진수·따옴표 문자열을 정규화한 뒤 5회 이상인 signature만 보고하고 4회는 보고하지 않으며 대표 원문과 횟수를 포함한다.
- AC7. D3은 표본 40개 미만 서비스를 판정하지 않고, nearest-rank p95를 쓰며, 정확히 1.5배인 경우를 회귀로 보고한다.
- AC8. D4는 end/fail 없는 start를 고아로 보고하고, start 없는 end도 사유를 구분해 보고하며, start 뒤 end가 있는 요청은 보고하지 않는다.
- AC9. D5는 AWS 키, Bearer 토큰, 프라이빗 키 헤더, password= 네 종류를 모두 탐지한다.
- AC10. D5 출력의 어떤 필드에도 매칭 원문 전체가 남지 않고 앞 4자만 노출된다.
- AC11. 리포트가 심각도 내림차순, 탐지기 id, subject 순으로 정렬된다.
- AC12. 같은 서비스의 findings가 하나의 상관 묶음으로 제시되고 묶음 심각도가 그 서비스 최고 심각도와 같다.
- AC13. `--json` 출력이 `summary`, `findings`, `malformed` 키를 갖는 유효한 JSON이다.
- AC14. `--fail-on` 기본값이 `high`이며 임계값 이상 finding이 없으면 종료 코드 0, 있으면 1이다.
- AC15. 존재하지 않는 파일 경로와 인자 누락이 종료 코드 2를 낸다.
- AC16. 런타임 의존성 항목이 0이고 소스에 네트워크 호출이 없다.

## 8. PRD-Level Tasks

이 task는 승인할 제품 capability를 묶는 단위다.
PRD가 capability 간 완료 의존성을 소유한다.
이 워크로드의 의존성 그래프는 T1에서 시작해 T2부터 T6으로 폭 5로 갈라지고 T7에서 합류한다.
T2부터 T6은 서로의 산출물을 필요로 하지 않으며 각자 자기 탐지기 모듈과 자기 테스트 파일만 쓴다.

- T1. 입력 파싱과 탐지기 등록 경계를 완성한다.
  CLI 진입, §6.1 문법 파서, malformed 계수, 주석·빈 줄 처리, 탐지기 공통 인터페이스와 레지스트리, 테스트 러너 배선을 연결한다.
  Covers R1, R2, R3, R4, AC1, AC2, AC3, AC4. Depends on: none.
- T2. D1 traffic-burst 탐지기를 완성한다.
  60초 tumbling window, 빈 window 포함, 중앙값 대비 3배와 절대 10건 경계 규칙을 구현하고 자기 테스트로 경계값을 고정한다.
  Covers R5, AC5. Depends on: T1.
- T3. D2 error-cluster 탐지기를 완성한다.
  16진수·숫자·따옴표 문자열 정규화, 5회 임계, 대표 원문과 횟수 보고를 구현하고 자기 테스트로 경계값을 고정한다.
  Covers R6, AC6. Depends on: T1.
- T4. D3 latency-regression 탐지기를 완성한다.
  서비스별 시간 정렬, 40표본 하한, 전후 절반 분할, nearest-rank p95, 1.5배 경계 규칙을 구현하고 자기 테스트로 경계값을 고정한다.
  Covers R7, AC7. Depends on: T1.
- T5. D4 orphan-request 탐지기를 완성한다.
  요청 id 묶기, start 뒤 end/fail 부재 판정, start 없는 end의 사유 구분을 구현하고 자기 테스트로 경계값을 고정한다.
  Covers R8, AC8. Depends on: T1.
- T6. D5 secret-leak 탐지기를 완성한다.
  네 가지 패턴 탐지와 앞 4자 마스킹을 구현하고 원문 유출이 없음을 자기 테스트로 고정한다.
  Covers R9, AC9, AC10. Depends on: T1.
- T7. 집계와 출력 계약을 완성한다.
  심각도 등급화, §6.3 정렬, 서비스 상관 묶음, 사람이 읽는 리포트, `--json`, `--fail-on`과 종료 코드, 의존성 0 증명을 연결한다.
  Covers R10, R11, R12, R13, R14, AC11, AC12, AC13, AC14, AC15, AC16. Depends on: T2, T3, T4, T5, T6.

## 9. Verification Contract

### 9.1 Test Mode Contract

| Mode | Required For Done | Covers | Human Decision |
| --- | --- | --- | --- |
| build/static | yes | 소스 유효성, 런타임 의존성 0, 탐지기 간 import 격리 | none |
| automated behavior | yes | 파싱 규칙, 탐지 규칙 경계값, 집계와 정렬 | none |
| cli/runtime | yes | 실제 CLI 실행, 출력 형태, 종료 코드 계약 | none |

구현 계획은 verify 전에 각 V 항목에 정확한 명령과 작업 디렉터리를 바인딩해야 한다.

### 9.2 Required Agent Verification

| ID | Mode | Covers | Pass Intent | Required For Done | Can Be Blocked |
| --- | --- | --- | --- | --- | --- |
| V1 | build/static | R1, R4, R14, AC1, AC4, AC16 | 전체 소스가 정적으로 유효하고, 런타임 의존성과 네트워크 호출이 없으며, 탐지기 모듈이 서로를 import 하지 않음을 판정한다. | yes | no |
| V2 | automated behavior | R2, R3, R5, R6, R7, R8, R9, R10, R11, AC2, AC3, AC5, AC6, AC7, AC8, AC9, AC10, AC11, AC12 | 파싱과 탐지 규칙의 경계값을 DOM·프로세스와 무관한 순수 함수 경계에서 판정하고, 각 machine-testable AC를 독립 선택할 수 있다. | yes | no |
| V3 | cli/runtime | R1, R12, R13, AC13, AC14, AC15 | 실제로 기동한 CLI 프로세스에서 사람이 읽는 리포트, `--json` 구조, `--fail-on` 동작, 종료 코드 0/1/2를 판정한다. | yes | no |

각 V 행은 독립적으로 실행하거나 판정할 수 있는 고유 실패 책임을 가진다.

### 9.3 Human Verification

- HV1. 사람이 읽는 리포트가 운영자에게 실제로 읽을 만한지 판단한다.
  자동 검증은 정렬과 묶음 구조를 증명하지만 가독성은 증명하지 않는다.

## 10. Risks And Open Decisions

- **R-1. 워크로드가 한 실행에서 완주되지 않을 수 있다.**
  의도된 측정 조건이다. 스코프를 줄이지 않고 미완료 범위와 원인을 그대로 보고한다.
- **R-2. 병렬 구현 시 T2부터 T6이 공유 파일을 건드리면 측정이 오염된다.**
  §5의 인터페이스 경계와 §11의 write scope 규칙이 이를 막아야 한다.
  실제로 충돌이 발생하면 축소하지 말고 그대로 보고한다.
- **R-3. 경계값 규칙이 많아 오해석 위험이 있다.**
  AC5부터 AC10이 각 경계값을 고정 계약과 직접 대조한다.
- **운영 조건.**
  verify FAIL은 override하지 않는다.
  벤치마크 원본은 `agents/` 밖에 보관하고 실행마다 새 run으로 복사한다.

## 11. Implementation Guardrails

- §6.1 문법과 §6.2 탐지 규칙의 임계값을 임의로 바꾸거나 줄이지 않는다.
- 탐지기 5종을 하나라도 생략하거나 합치지 않는다.
- 각 탐지기 모듈은 다른 탐지기 모듈을 import 하지 않는다.
- 런타임 npm 의존성, 번들러, 트랜스파일러, 네트워크 호출을 도입하지 않는다.
- 제품 변경은 `logscan/` 경계 안에 둔다.
  `agents/`는 실행 기록만 소유하며 제품이나 검증 입력이 아니다.
- 저장소의 기존 `cli/`, `skills/`, `tests/`를 수정하지 않는다.
- 앱에 실행 시간 계측 코드나 벤치마크 리포트 생성기를 넣지 않는다.
- 실패와 blocked 상태를 pass로 표시하지 않는다.

## 12. Implementation Result Report Contract

구현 결과는 다음을 보고한다.

- 상태를 `Done`, `Partially Done`, `Blocked` 중 하나로 보고한다.
- 사용자가 CLI를 실행하는 방법과 대표 출력을 요약한다.
- 구현 계획이 선택한 책임 경계와 탐지기 인터페이스를 설명한다.
- T1부터 T7, R1부터 R14, AC1부터 AC16, V1부터 V3의 상태를 보고한다.
- 바인딩한 정확한 검증 명령과 각 명령이 증명한 pass intent를 보고한다.
- 승인된 의미 계약과 다른 편차, 축소, blocked 항목을 숨기지 않는다.
- 사람에게 남은 판단은 HV1만 보고한다.
- 딜리버리는 `local`이며 커밋, 푸시, PR이 없음을 보고한다.
