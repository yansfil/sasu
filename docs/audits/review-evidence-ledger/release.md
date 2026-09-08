# 병렬 리뷰와 요구사항 근거 기록

승인 범위는 기존 병렬 Fidelity·Code 실행을 생산 계약으로 승격하고, 누락 검사와 수정할 수 없는 과거 판단 기록을 추가하는 것이다.
별도 실험, 리뷰 역할, 명령, 설정 항목, 원장 파일은 추가하지 않았다.

## 계약

CLI는 `0.10.0`, state는 `sasu.implement.state.v10`, receipt는 `sasu.implement.receipt.v6`이다.
기준 커밋은 `2b1f638dd587261be7e7b0e600db16657421971d`이다.
퇴역한 실험 형식의 마지막 지원 커밋은 이 기준 커밋이고, 이전 통합 형식의 지원 커밋은 `3f549dcfff71fe1f7fa974a383f6e8a055ce8463`이다.
구형 상태를 읽거나 변환하는 경로는 제공하지 않는다.

두 역할은 같은 원래 입력과 실제 증거를 받고 현재 동료 판단을 보지 않는다.
필수 suite의 실제 실행, 읽기 허용 범위, 하나의 실행 lease·시도·수정 예산, 열린 finding 이력과 독립적인 고위험 검사는 유지한다.

`verificationAttempts[].reviews.{fidelity,code}.result.assessments`에는 `requirementRefs`, `conclusion`, `rationale`, `evidenceRefs`를 기록한다.
Fidelity는 모든 Bn을 정확히 한 번 포함하며, 같은 근거가 적용되는 요구사항은 하나의 항목으로 묶을 수 있다.
Code는 구현·연결·오류 경로의 자체 판단 근거를 기록하고 모든 Bn 목록을 반복할 필요가 없다.
하나의 완전한 소스나 실제 관측은 여러 요구사항을 함께 뒷받침할 수 있다.
요구사항별 실행 명령, 별도 테스트·증거 파일, 상태 전이, 모델 호출은 요구하지 않는다.

`satisfied`에는 실제 제공된 소스·실행 로그·관측의 참조가 필요하다.
PRD·결정문·읽지 못한 경로 목록만으로 충족을 기록할 수 없다.
`unresolved`에는 해당 요구사항의 blocking finding이 필요하고 완료를 막는다.
`pending-human`은 원문 인용이 검증된 대응 사후 인간 확인 finding이 있을 때만 허용하며 `complete-pending-human`을 보존한다.
선행 승인·결함·누락된 증거를 사후 확인으로 바꾸지 않는다.
이 검사는 구조적 누락과 근거 기록을 드러내며 모델 판단의 진실성을 증명하지 않는다.

각 시도에 PRD 해시와 당시 `reviewContext`를 고정한다.
이미 확정된 역할 결과·호출 기록과 종료된 시도는 CLI 저장 경계에서 변경·삭제·재정렬을 거부한다.
수정은 새 시도로 추가하며, 같은 `state.json`이 유일한 기록이다.
receipt와 ship·benchmark는 고정된 결과와 입력 식별자를 확인한다.

## 검증

최종 소스에서 dist를 삭제한 뒤 build → noEmit → root → unit → E2E를 순서대로 실행했다.
모든 명령이 성공했으며 root 102/102, unit 462/462, E2E 128/128이 통과했다.
정확한 명령·시간·로그는 [순차 실행 기록](checks/sequential-checks.json)에 있다.
실제 backend를 호출하지 않은 이 테스트 결과는 라이브 완료 검증을 대신하지 않는다.

집중 회귀는 Bn 누락·중복·알 수 없는 참조, 비어 있는 근거, PRD만 인용한 충족 주장, 공유 소스에 의한 30개 요구사항 기록, 실패 후 수정 이력, 병렬 역할 독립성, finalize 거부, B-row의 사후 인간 판단을 다룬다.
격리된 검사에서는 과거 기록 보호 및 unresolved 완료 거부를 각각 제거하면 대응 회귀가 실패했다.
사후 인간 판단 기록을 지운 완료 상태도 보호 추가 전에는 탐지되지 않았고 추가 후에는 거부됐다.

최초 전체 suite 동시 실행에서는 root 문서 검사 2건, unit fixture 2건, E2E 모듈 로딩 1건이 실패했다.
문서에는 필요한 목차를 추가하고, 변경된 문구·참조 계약에 맞게 테스트 입력을 수정했다.
E2E 로딩 오류는 root 설치 테스트가 동일 dist를 재빌드하던 동시 실행에서 발생했고, 소스 변경 없이 분리 실행 및 최종 순차 실행에서는 재현되지 않았다.
설치기 동시성 설계는 변경하지 않았다.
[최초 실패 로그](failures/)와 철회한 첫 동결 명세도 보존했다.

139개 소스·배포 파일의 [최종 동결 명세](checks/final-frozen-manifest.json)는 설치 테스트의 마지막 재빌드 이후 작성했다.
전체 로그·명세 해시는 [증거 해시](evidence-hashes.json)에 있다.
루트가 이 빌드에서 수행하는 실제 backend 릴리스 검사는 별도 결과로 구분한다.
통합·전역 설치·이전 run 변경은 이 작업에서 수행하지 않았다.

## 실제 릴리스 검증

두 backend 모두 정상 CLI의 start → verify → finalize로 state v10·receipt v6의 `complete`에 도달했다.
실행 helper와 실제 상태·영수증·CLI 출력·suite 로그·시도별 입력은 [라이브 증거](live/)에 보존했다.
[원본과 보관 파일 대응](live/archive-map.json)에는 각 파일의 SHA-256이 있다.

| Backend와 시도 | 실제 verify 시간 | 판정과 완료 |
| --- | ---: | --- |
| Codex, command(30) 누락 | 39.093초 | B30만 FAIL, finalize 거부 |
| Codex, 소스 수정 후 | 28.806초 | PASS, complete |
| Claude, 처음부터 정상 소스 | 66.669초 | PASS, complete |

Codex 전체 helper 실행은 70.367초, Claude는 68.629초였다.
두 프로젝트는 동시에 실행됐고 시나리오도 다르므로 이 수치를 성능 비교로 해석하지 않는다.
모델은 각각 Luna xhigh와 Sonnet 5 xhigh, fallback은 null이었다.
성공한 역할 기록은 6개이지만 실제 content 실행은 7회였다.
Claude Fidelity에서 `priorDispositions must be an array` 형식 오류 후 같은 backend로 1회 재시도했으며, 해당 오류와 소요 시간 37.962초가 실제 판단 기록에 남아 있다.
전체 provider 요청 수나 오류 시도의 토큰 사용량을 성공 기록만으로 추정하지 않는다.

누락 시도에서는 두 역할이 B30에 대한 F1/F2를 남겼으며, 다른 Bn의 미실행만을 이유로 한 blocker는 없었다.
수정 후 기존 finding은 삭제되지 않고 resolved로 남았다.
FAIL과 PASS 시도의 저장된 JSON은 finalize 뒤에도 동일했다.
정상 결과의 Fidelity는 양쪽 모두 단 하나의 공유 assessment로 B1~B30을 정확히 한 번 기록하고 실제 완전한 소스를 인용했다.
필수 suite는 command(1)만 실행했으며, 나머지 29개의 실행을 만들어내지 않았다.

두 프로젝트의 PRD SHA-256은 `e42b74972b803ebe3e4471c1c430207e88fa4de829deb5259ed7a60cf5e50811`이다.
최종 공개 소스 SHA-256은 `b170d68c824ab87596160d7a2b2583c6f95146044fdf84ed3787cfde145f90b0`이다.
라이브 실행은 커밋 전 동결된 변경을 사용했으므로 summary의 candidateCommit은 기준 HEAD이고, 실제 코드·dist 식별은 동결 명세로 보완한다.
루트의 846개 원본 항목은 실행 전후 모두 동일했다.
실행 뒤 추가된 파일은 이 감사 보고서와 증거뿐이었다.
검증용 CLI는 `/Users/hoyeonlee/projects/sasu.worktrees/review-evidence-ledger/cli/dist/cli.js`이고, 기존 전역 설치는 이 작업에서 변경하지 않았다.
최종 main 통합·설치 결과는 아래에 별도로 기록한다.

## main 통합과 설치 완료

소스 커밋 `b9d741e2428b0b31797fdc0e3da790745ada4974`를 로컬 main에 fast-forward로 통합했다.
기존 `node scripts/install-local-skills.mjs`로 양쪽 런타임을 갱신했고, 실제 PATH의 `sasu --contract-version`은 `0.10.0`이다.
전역 실행 파일은 main의 `cli/dist/cli.js`를 가리킨다.

라이브 검증 전 동결한 846개 소스·빌드 항목은 main 설치 후에도 모두 동일했다.
추가된 항목은 이 릴리스의 감사 기록뿐이며, 검사한 코드와 설치한 코드 사이에 변경은 없다.
양쪽 런타임의 스킬 20개, 계약 파일 49개가 소스와 정확히 일치하고 모든 `SKILL.md`는 일반 파일이다.
`codex debug prompt-input`에서도 정규 스킬 10개가 실제 모델 입력 목록에 나타나는 것을 확인했다.
Claude 설치본은 경로·호출 문법 변환을 포함한 파일 일치로 확인했으며, 설치 후 별도 대화형 제품 실행을 추가하지 않았다.
두 런타임의 기존 hook·settings 파일 해시도 설치 전과 동일하다.
설치기가 표시한 Claude hook의 `changed: true`는 최종 바이트 변경을 뜻하지 않았다.

[설치 바인딩](installation/binding.json), [스킬 파일 비교](installation/installed-after.json), [스킬 인식 결과](installation/skill-discovery.json), [설치 로그](installation/install.log)에 근거를 보관했다.
문서에 적힌 suite와 라이브 결과는 소스 커밋의 결과이며, 이후 변경은 이 설치 기록뿐이다.
코드와 설치 반영은 완료됐고 원격 push는 수행하지 않았다.
기존 v9 run과 이전 제품 pilot의 실패 상태·예산은 변경하지 않았다.
새 버전은 퇴역 상태 형식을 자동 변환하지 않으므로, 기존 run을 그대로 새 버전에서 이어갈 수 있다는 의미는 아니다.

## 변경 파일

생산 코드·소비자·정책·소스 스킬:

- `AGENTS.md`
- `PRINCIPLES.md`
- `README.md`
- `cli/package-lock.json`
- `cli/package.json`
- `cli/src/cli.ts`
- `cli/src/doctor.ts`
- `cli/src/implement/commands.ts`
- `cli/src/implement/prompts.ts`
- `cli/src/implement/store.ts`
- `cli/src/implement/types.ts`
- `cli/src/implement/verification-activity.ts`
- `cli/src/judge/types.ts`
- `skills/benchmark-implement/SKILL.md`
- `skills/benchmark-implement/references/contracts.md`
- `skills/benchmark-implement/scripts/benchmark_report.js`
- `skills/gen-prd/SKILL.md`
- `skills/implement/SKILL.md`
- `skills/implement/references/reviews-and-finalization.md`
- `skills/implement/references/verification-and-evidence.md`
- `skills/please/SKILL.md`
- `skills/ship/SKILL.md`
- `skills/ship/scripts/prd_ship.js`
- `cli/src/implement/review-contract.ts`

테스트·검증 helper:

- `cli/test/e2e/implement-parallel-review.test.mjs`
- `cli/test/e2e/implement.test.mjs`
- `cli/test/helpers/implement-fixture.mjs`
- `cli/test/helpers/implement-live-review.mjs`
- `cli/test/helpers/implement-state.mjs`
- `cli/test/unit/doctor-integrity.test.mjs`
- `cli/test/unit/implement-envelope.test.mjs`
- `cli/test/unit/implement-prompts.test.mjs`
- `cli/test/unit/implement-runner.test.mjs`
- `cli/test/unit/implement-store.test.mjs`
- `cli/test/unit/implement-verification-activity.test.mjs`
- `tests/benchmark_report.test.mjs`
- `tests/implement_skill_structure.test.mjs`
- `tests/prd_ship.test.mjs`
- `cli/test/unit/implement-review-contract.test.mjs`
