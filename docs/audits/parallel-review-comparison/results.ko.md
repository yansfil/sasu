# 통합 리뷰와 병렬 리뷰 비교 결과

**통합 리뷰를 기본값으로 유지한다.**
실제 비교를 마쳤으며, 두 제품 실행 모두 첫 검증 PASS와 `complete` receipt에 도달했다.
분리 리뷰가 추가로 찾은 결함은 없었고, 이번 제품의 리뷰 시간과 실행량은 늘었다.
Herdr Observer + Implementor 역할은 그대로 유지한다.
실험 후보는 전역 설치하거나 main에 병합하지 않았다.

## 완료 근거

[통합 원본 보고서](evidence/products/unified/report.json)와 [분리 원본 보고서](evidence/products/split/report.json)는 모두 `validRun: true`이다.
기존 리포터가 생성한 [비교 결과](evidence/comparison.json)는 `strictlyComparable: true`, 불일치 사유 0개이다.
원본 보고서와 비교 JSON은 수작업으로 수정하지 않았다.

| 제품 실행 지표 | 통합 | 분리 |
| --- | ---: | ---: |
| 최종 상태 | complete | complete |
| 지시 전달 → receipt | 248.7초 | 242.5초 |
| start → receipt, 원본 리포터 | 90.5초 | 107.7초 |
| 전체 verify | 25.5초 | 39.0초 |
| 리뷰 경과시간 | 24.9초 | 38.6초 |
| 리뷰 기록의 실행시간 합 | 24.9초 | 58.2초 |
| 검증 라운드 / 실제 리뷰 실행 | 1 / 1 | 1 / 2 |
| 필수 suite 실행 / 제품 수정 라운드 | 1 / 0 | 1 / 0 |
| 재시도 / 열린 항목 / 고위험 리뷰 | 0 / 0 / 0 | 0 / 0 / 0 |
| 별도 독립 평가 시간 | 163.5초 | 201.5초 |

분리의 Fidelity와 Code는 7ms 간격으로 시작했고 19.58초 동안 겹쳐 실행됐다.
후보 리포터의 `timing.reviewExecutions`와 `efficiency.reviewInvocationsByRole`가 두 실제 실행을 각각 보존한다.
두 native 실행자는 서로 다른 새 세션이며, 통합 receipt 이후에 분리 실행을 시작했다.
지시 전달부터의 6.2초 차이에는 준비와 경로 복구 차이가 섞여 있어 분리 리뷰의 속도 개선으로 해석하지 않는다.
독립 평가와 receipt 이후 실행자의 결과 정리 시간은 구현 시간에 넣지 않았다.

## 실제 품질 호출

기존 소스 fixture 여섯 개와 실제 이미지 첨부 한 개를 양쪽에 실행했다.
계약·소스·증거 바이트와 외부 기대값을 먼저 고정했고, 각 사례에서 통합 다음 분리 순서를 지켰다.
심은 정답은 리뷰어에게 제공하지 않았고, 받아들인 오판을 다시 돌려 바꾸는 행위도 없었다.

| 고정 사례 | 통합 | 분리 |
| --- | --- | --- |
| complete | 차단 없음 | 두 역할 모두 차단 없음 |
| middle-omission | B17 결함 발견 | 두 역할 모두 같은 B17 결함 발견 |
| final-omission | B30 결함 발견 | 두 역할 모두 같은 B30 결함 발견 |
| unwired | B28 호출 연결 결함 발견 | 두 역할 모두 같은 연결 결함 발견 |
| storage-failure | B31 예외 삼킴 발견 | 두 역할 모두 같은 예외 삼킴 발견 |
| authorized-assumptions | 새 인간 승인 요구 없음 | 새 인간 승인 요구 없음 |
| 실제 이미지 첨부 | 기대 충족 | 두 역할 모두 기대 충족 |

양쪽 모두 기대 결과 7/7, 놓친 심은 결함 0, 무관한 차단 0, 엄격한 출력 형식 오류 0, 재시도 0이다.
분리의 결함 중복은 같은 B 번호만 보고 센 것이 아니라, 실제 입력·실패 표현식·수정 요구가 같은 네 쌍을 확인한 결과이다.
네 결함에 대해 통합은 4개, 분리는 8개의 원시 finding을 반환했으며, 제품 수정을 위한 상태 병합 실험으로 바꾸지 않았다.

| 품질 호출 지표 | 통합 | 분리 |
| --- | ---: | ---: |
| 사례 경과시간 합 | 169.6초 | 153.0초 |
| 실제 content 실행 | 7 | 14 |
| 별도 backend preflight | 1 | 1 |
| 원시 trace 기준 content 프로세스 시간 합 | 163.9초 | 280.4초 |

품질 호출의 실제 프로세스 23개는 preflight 2개와 content 21개로 구분되어 있다.
[고정 roster](evidence/quality/roster.json), [모든 결과](evidence/quality/results.json), [원시 프로세스 측정](evidence/quality/process-measurements.json), [원시 trace](evidence/quality/provider-traces/)를 보존했다.
리뷰 기록의 duration은 preflight 대기까지 포함할 수 있으므로 위 프로세스 전용 합계와 구분한다.
내부 도구 turn을 별도 리뷰로 세지 않으며, 제품 기록의 accepted usage를 전체 공급자 요청 수나 청구 비용으로 바꾸지 않는다.

## 같은 입력과 고정 소스

| 좌표 | 값 |
| --- | --- |
| 통합 harness | `3f549dcfff71fe1f7fa974a383f6e8a055ce8463` |
| 분리 harness | `6b88d83ce325a2a871af69d4e32cdf737c6dc229` |
| 분리 source tree | `9dcc328bbde0a9ee588539ef14b61d3f69b6a08f` |
| 공통 blank starter | `c8191eff3b08cd63a7c349c7eda964fcd6bac83d` |
| 공통 PRD SHA-256 | `44238bd5792dc5103f0ead8690f49fe540c231bd7c07e41d79157f757ce6bb3e` |
| 공통 시작 source fingerprint | `5f4b1b1b1da355fb5aaa3334e6b1e969253452f4b206a8ca7093ad235af2fa5e` |
| 공통 case SHA-256 | `0239d760d068afd956679a19fc515b0922fdfefa83d4ade1c71519f2299b9dd4` |
| 공통 config SHA-256 | `6e61057a21be9bd6bc74b60924a7f23043aa090a5335ddaccc95e02f81653460` |
| 리뷰 모델 | Codex Luna xhigh, fallback null |
| 구현 모델 | 새 native Codex Sol medium 세션 각 1개 |
| 통합 세션 / pane | `01a080ec-f833-74c2-b8ad-de56f6920e5f` / `w72:pM` |
| 분리 세션 / pane | `01a080f1-31ef-7ea1-9191-5cec1e984ada` / `w72:pN` |

`agents/config.json`은 소스 fingerprint에서 제외되므로 별도 해시를 비교했다.
각 세션이 `prepare-run`을 정확히 한 번 호출했고, 반환된 별도 worktree와 run-1 좌표를 사용했다.
두 실행의 역할은 실제 환경의 `SASU_HERDR_ROLE=implementor`와 native 세션 식별자로 확인했다.
[전체 실행 좌표](evidence/execution.json)와 각 [통합](evidence/products/unified/run-binding.json)·[분리](evidence/products/split/run-binding.json) 준비 기록을 보존했다.

## 단계 시간과 한계

[단계 측정 원본](evidence/phase-measurements.json)은 서로 겹치지 않는 구간을 사용한다.

| 구간 경과시간 | 통합 | 분리 |
| --- | ---: | ---: |
| 준비 | 141.6초 | 134.8초 |
| start 경로 복구 | 16.6초 | 0초 |
| 최초 구현 구간 | 43.7초 | 45.6초 |
| 집중 QA 구간 | 12.6초 | 9.7초 |
| 필수 suite | 0.5초 | 0.3초 |
| 리뷰 | 24.9초 | 38.6초 |
| 그 외 verify 처리 | 0.1초 | 0.1초 |
| 제품 수정 | 0초 | 0초 |
| PASS → receipt | 8.8초 | 13.4초 |

구간 경과시간은 실제 작업량 추정치가 아니다.
도구 호출과 실행 중 verify 바깥의 무관측 시간 220.3초·200.7초는 별도 unattributed 값으로 남겼고 낭비로 단정하지 않았다.
새 Sol 평가자는 다른 실행의 결론 없이 각 세션을 읽었으며, 과정 점수는 통합 100점·분리 95점이다.
분리 평가자는 잘린 대량 지침을 겹쳐 읽은 준비 과정에 P2 하나를 남겼고, 두 실행 모두 회피한 리뷰나 거짓 완료는 지적하지 않았다.
이 점수는 제품 품질 점수가 아니다.

이번 표본은 소스 중심의 작은 품질 사례와 제품 한 쌍이다.
제품 수정 라운드가 발생하지 않았으므로 복잡한 결함의 수정·재검토 수렴 속도는 측정되지 않았다.
새 UI, 외부 서비스, 실제 고위험 경계의 우열도 이 결과에서 주장하지 않는다.
품질과 두 제품 구현 구간은 서로 겹치지 않았지만 이 머신 전체의 외부 부하나 순서 효과를 통제한 반복 실험은 아니다.

## 보존한 실패와 변경하지 않은 경계

준비 PRD의 `source_intake`가 존재하지 않는 상대 파일로 해석됐는데 readiness만으로는 이를 잡지 못했다.
양쪽 실제 intentSource 오류를 확인한 뒤, 원래 승인 자료의 `current conversation` 한 줄만 동일하게 복원하고 호출 전에 다시 고정했다.
[수정 전후 바이트와 검증](evidence/preparation/input-corrections/source-intake/) 및 별도 보존 커밋 `7f3bfea`를 남겼다.
계약 행동·결정·승인 문구·제품 테스트는 변경하지 않았다.

통합의 첫 start는 `/var`와 `/private/var` 경로 별칭 때문에 거절됐고, 같은 PRD를 상대 경로로 지정해 복구했다.
예약·예산·상태 초기화는 없었다.
native 실행 전 셸 alias 충돌과 신뢰 디렉터리 화면은 기록하고 종료했으며, 양쪽 모두 전역 trust 설정을 바꾸지 않는 persistent `codex exec`로 동일하게 실행했다.
실행자는 프로젝트 외부에 staging한 실제 project-local skill과 해당 arm의 원본 CLI·리포터를 사용했다.
복사한 리포터의 상대 harness-root 제한 때문에 원본 리포터 경로를 명시했으며 새 설치 모드는 추가하지 않았다.
현재 레이아웃에 `gates.json`이 없다는 사실은 양쪽 보고서와 평가에 그대로 반영했다.

소스는 비교 중 바꾸지 않았고 [82개 source/dist 해시](evidence/frozen-source-check.json)가 유지됐다.
이미 통과한 clean build, root 100, unit 453, E2E 125, typecheck는 반복하지 않았으며 [기존 로그와 소스 변경 목록](evidence/source-checks/handoff.md)을 보존했다.
이 결과를 위해 추가 실험·새 리뷰 루프·소스 재설계·전역 설치·이전 실행 변경은 하지 않았다.
[원본 artifact 공백 검사](evidence/artifact-whitespace-check.txt)의 경고는 입력·로그 바이트를 보존하기 위해 그대로 남겼고, 새 결과 문서의 diff 검사는 통과했다.

## 재현과 증거 위치

원래 리포터 호출 인자는 [report-invocations.json](evidence/preparation/report-invocations.json), 비교 인자는 [comparison-invocation.json](evidence/preparation/comparison-invocation.json)에 있다.
실제 입력은 [case](evidence/case/), 품질용 외부 runner는 [run-quality.mjs](evidence/quality/run-quality.mjs), staging·native 실행 안내는 [RUNBOOK](evidence/preparation/RUNBOOK.md)에 있다.
이 명령들은 이미 실행한 기록이며, 결과 재해석을 위해 유료 호출이나 prepare-run을 다시 실행할 필요는 없다.
전체 native 원시 세션은 기존 개인 지침과 다른 세션 목록까지 포함하므로 로컬 원본을 보존하고, 저장소에는 [통합](evidence/products/unified/native-transcript-identity.json)·[분리](evidence/products/split/native-transcript-identity.json) 경로·해시와 필요한 실행 기록을 남겼다.
증거 파일의 SHA-256 목록은 [SHA256SUMS](SHA256SUMS)에 있다.

승인된 비교의 필수 실행과 보고를 모두 마쳤으며, 이번 근거로는 분리 방식을 채택하지 않는다.
기존 통합 기본값을 유지하고, 별도의 승인 없이 추가 비교나 rollout을 진행하지 않는다.
