---
topic: "게이트 루프: judge 한 번은 빠른데 사이클이 느린 문제를 배관에서 고친다"
status: "ready"
# human_approval evidence - user 2026-09-03 verbatim: "ㅇㅇ 그렇게 하자", "자 그럼이제 이것들 바탕으로 PRD 만들어보자"
human_approval: "approved"  # user 2026-09-03 verbatim: 승인하고 fable 5.1 pane 띄워서 구현 시작해
review_profile: "high-risk"
review_rationale: "사람이 개입하는 지점을 줄이는 변경이다. 잘못 줄이면 에이전트가 자기 제안을 승인으로 둔갑시키는 실패(7084c601에서 4회 관측)가 다시 통과한다. 반대로 지금 상태는 사용자가 빈 evidence로 reopen을 치는 버튼 노릇을 하고 있어, 사람 접점이 있어도 판단이 없다."
source_intake: "current conversation"
adversarial_review: "2026-09-03 Fable 5.1 적대 검토 2라운드. 1라운드가 judge 삭제안을 기각, 2라운드가 gap-audit을 spec에 접는 안을 기각. 이 PRD는 두 라운드 모두 살아남은 부분만 담는다. 반영 내역은 4.3."
created_at: "2026-09-03"
updated_at: "2026-09-03"
---

# PRD: 게이트 루프 배관

## 1. Summary

10개 세션(8/27~9/3, 활성 3,434분)의 타임스탬프를 재보면 gap-audit judge 한 번은 4레인 병렬로 1~5분이다.
그런데 첫 호출에서 최종 PASS까지는 71분(swift-shell-pivot), 47분(hide-rebrand), 29분(implement-check)이 걸렸고, 셋 중 둘은 사용자 override나 frontmatter 손수정으로 끝났다.
차이는 judge가 아니라 judge를 감싸는 루프에서 난다: 첫 사이클부터 소진되는 라운드 예산, 재실행마다 새 지적을 내는 전체 재판정, 기계적 편집이 drift로 잡혀 봉인이 풀리는 것, 에이전트가 손으로 쓰는 감사 기록, 봉인된 qa-log가 정상 범위 추가를 거부하는 것.
이 PRD는 judge의 판정 내용과 레인 구성은 그대로 두고 그 배관만 고친다.
목표 수치는 위 세 세션의 루프 시간을 judge 호출 수 × 5분 + 사람 질문 1묶음으로 내리는 것이다.

## 2. Problem, Goal, And Users

사용자는 호연 한 명이고, 실행자는 인터뷰와 PRD를 쓰는 에이전트 세션이다.
문제는 gap-audit BLOCK 뒤에 일어나는 일이 판단이 아니라 의식이라는 것이다.
타임라인에 기록된 reopen evidence는 "가", "재심사 고고", "게이트 다시 돌려 마지막으로!", "제발 빨리 어떻게든 실행해ㅑ돼"다.
사람이 결정해야 할 finding(requiresHuman)과 에이전트가 코드를 다시 읽으면 닫을 수 있는 finding이 같은 BLOCK으로 묶여 있어서, 후자를 닫으려고 전자를 위한 사람 접점을 소비한다.
목표는 사람 접점을 "결정이 필요한 finding을 한 번에 묶어 묻는 것" 하나로 줄이고, 나머지는 에이전트와 하네스가 알아서 돌게 하는 것이다.

### 2.1 User Scenarios

- SC1. 인터뷰가 끝나고 gap-audit이 P1 13건을 낸다. 에이전트가 코드와 Herdr 문서를 다시 읽어 9건을 닫고 재실행한다. 재실행은 열린 4건만 다시 보고 새 지적을 내지 않는다. 남은 4건은 requiresHuman이라 한 묶음으로 사용자에게 간다. 사용자가 답하면 PASS.
- SC2. 봉인 PASS 뒤 prelint가 Decision Register의 Q 앵커 보정을 요구한다. 에이전트가 앵커만 고친다. 게이트는 STALE로 돌아가지 않는다.
- SC3. 봉인 PASS 뒤 사용자가 "아 근데 마지막으로 Settings 토글도"라고 범위를 추가한다. `sasu gate reopen`이 성공하고 새 사이클이 열린다. frontmatter를 손으로 고치지 않는다.
- SC4. 매 judge 실행 뒤 qa-log의 Audit History 블록과 status가 하네스 손으로 기록된다. 에이전트는 python으로 그 블록을 쓰지 않는다.
- SC5. 에이전트가 사용자 제안 두 개를 자기가 "resolved"로 표시한다. gap-audit이 아니라도 spec fidelity가 Raw Q&A의 사용자 답변 원문과 대조해 이를 잡는다.

## 3. Scope And Non-Goals

범위: `cli/src/gates/commands.ts`, `gates/store.ts`, `gates/prompts.ts`, `gates/prelint.ts`, `interview/qalog.ts`, `skills/interview-me/SKILL.md`, `skills/gen-prd/SKILL.md`.

비목표:

- PRD 템플릿을 Goal/Decisions/Behaviors 세 블록으로 줄이는 것. `implement start`가 tasks/AC/verification 목록과 Judgment 표를 요구하므로(`implement/commands.ts:592-601`) contract 파서, AC별 verify 바인딩, receipt 스키마를 함께 바꿔야 한다. 이 PRD가 착지한 뒤 별도 PRD로 한다.
- gap-audit 레인의 삭제나 spec으로의 통합. 적대 검토 2라운드가 기각했다: gap-audit 레인은 빠진 결정을 찾고 spec 레인은 있는 행을 판정하므로 서로 대체가 안 된다.
- judge 모델, 레인 수, 병렬도의 변경.
- self-bricking(빌드 산출물 digest)은 798e7ec로 착지했으므로 여기서 다루지 않는다.

## 4. Pre-Work And Required Decisions

### 4.1 Pre-Work Before Implementation

- 세 세션(swift-shell-pivot 7084c601, hide-rebrand ea9f12f2, implement-check 2f6a5a02)의 gap-audit 사이클을 `agents/runs/gate-loop/baseline.md`에 호출 시각, 판정 시각, 사이클 수, 종료 방식으로 옮겨 적는다. V5의 비교 기준이다.

### 4.2 Human Decisions Before PRD Approval

- 없음. 4.3의 결정은 모두 이 대화에서 사용자가 이미 내렸거나 위임했다.

### 4.3 Decision Traceability For Fidelity Review

- D-01. judge 레인 구성(gap-audit 4, spec 2)과 판정 내용은 그대로 둔다. 사용자 verbatim: "ㅇㅇ 그렇게 하자". 적대 검토 1라운드가 judge 삭제안을, 2라운드가 gap-audit 흡수안을 기각한 결과다.
- D-02. gap-audit의 goal-scope와 data-tech 레인 finding은 BLOCK이 아니라 경고로 낮춘다. 사용자 질문 "gap-audit 저 4개도 필요할까 꼭?"에 대한 답으로, 두 레인이 잡은 것 중 사람 결정이 필요했던 건은 있었으나(D-13 브라우저 임베딩 오기록, 기기 전환/탭 소유권) 대부분은 에이전트가 코드를 다시 읽어 닫았다. 경고는 보이되 막지 않는다. 단 requiresHuman인 finding은 레인과 무관하게 D-04를 따른다.
- D-03. 재실행은 열린 finding만 재판정한다. 사용자 verbatim: "불필요하게 뭔가 동작하는건 없는걸까?". hide-rebrand에서 cycle 2 → 3 → 4가 각각 새 지적(버전 하한, upgrade 명령, curl 불일치)을 냈고 이것이 비수렴의 실체였다.
- D-04. 라운드 예산(semantic rounds 2/2)과 CLOSURE EXHAUSTED를 없앤다. requiresHuman이 아닌 finding은 에이전트가 고치고 다시 돌리며, requiresHuman finding만 한 묶음으로 사용자에게 간다. 근거는 reopen evidence 원문 4건이 모두 결정이 아니라 버튼이었다는 관측.
- D-05. drift 해시는 Decision Register의 결정 내용과 Raw Q&A 각 턴의 답변 원문을 센다. Q 앵커, 턴 라벨, Audit History, frontmatter, status는 제외한다. 근거는 implement-bc에서 prelint가 요구한 앵커 보정 한 줄이 봉인 PASS를 BLOCKED로 되돌리고 새 finding 10건을 내서 override로 끝난 것. 답변 원문을 포함하는 이유는 D-08이 그 원문을 spec 판사의 대조 증거로 삼기 때문이다: 봉인 뒤 답변을 고치거나 지워도 STALE이 안 되면 기록된 동의가 봉인된 판정과 어긋날 수 있다(2026-09-06 verify 위험 판사 RF2, amendment 1로 반영).
- D-06. Audit History와 status는 하네스가 쓴다. 근거는 hide-rebrand에서 에이전트가 python으로 세 번 그 블록을 쓰고 "placeholder written - will update result after gate run"이라 적은 것.
- D-07. 봉인된 qa-log에 대한 `gate reopen`은 정상 명령으로 성공한다. 근거는 pet-integration 15:42와 hide-rebrand 15:11의 exit 1 "qa-log is complete and sealed".
- D-08. spec fidelity 프롬프트에 한 문장을 더한다: 결정의 근거는 Raw Q&A의 사용자 답변 원문이며, Decision Register의 resolved 표시는 에이전트가 쓴 것이므로 증거가 아니다. 사용자 verbatim: "spec은 괜찮은것같은데". 근거는 7084c601에서 에이전트가 자기 제안을 resolved로 표시한 것을 gap-audit이 3회 잡았고, 이 PRD가 gap-audit 사이클 수를 줄이므로 그 catch가 spec에도 있어야 한다.
- D-09. prelint에 규칙 하나를 더한다: PRD가 인용한 Qn에 비어 있지 않은 사용자 답변이 있어야 한다. 적대 검토 2라운드 finding 7. 기존 12종은 이 PRD에서 건드리지 않는다(템플릿 PRD의 몫).
- D-10. `/please`처럼 인터뷰가 없는 경로에는 judge를 돌리지 않는다. fidelity가 대조할 사용자 발화가 없어 항상 PASS로 퇴화한다. 적대 검토 2라운드 finding 6.

## 5. Major Technical Structure Changes

- `gates/commands.ts`의 사이클 상태기계에서 `closure-blocked` 단계와 라운드 카운터를 제거하고, 판정 결과를 `open findings` 집합으로 축소한다. 재실행 입력은 `priorFindingsFor`가 이미 만드는 목록이며, 레인 프롬프트는 그 목록 밖의 새 finding을 내지 못하게 `rerun` 모드에서 명시된다.
- `gates/store.ts`의 입력 해시가 qa-log 전체가 아니라 Decision Register의 결정 셀과 Raw Q&A 답변 원문만 정규화해 계산한다.
- `interview/qalog.ts`가 Audit History 블록 쓰기와 status 전이를 소유한다. 스킬 문서에서 에이전트가 그 블록을 쓰라는 지시를 삭제한다.
- `gates/prompts.ts`의 spec fidelity scope에 D-08 문장을 더하고, gap-audit 레인에 `blocking: boolean`을 둬 goal-scope와 data-tech를 false로 둔다.

## 6. Requirements

- R1. gap-audit 재실행은 직전 판정의 열린 finding만 입력으로 받고, 출력의 finding id 집합은 입력 집합의 부분집합이다. 결정 내용이 바뀐 레인은 예외로 새 finding을 낼 수 있다.
- R2. 라운드 예산과 CLOSURE EXHAUSTED 상태가 존재하지 않는다. 판정 뒤 열린 finding이 requiresHuman뿐이면 `gate status`가 그 묶음을 사용자 질문으로 출력하고, 하나도 없으면 봉인 PASS다.
- R3. goal-scope와 data-tech 레인의 finding은 경고로 기록되고 PASS를 막지 않는다. requiresHuman이 붙은 finding은 레인과 무관하게 R2의 묶음에 들어간다.
- R4. 봉인 PASS 뒤 Q 앵커, Audit History, frontmatter, status의 변경은 STALE을 만들지 않는다. Decision Register의 결정 셀 변경과 Raw Q&A 답변 원문 변경만 STALE을 만든다.
- R5. `sasu gate gap-audit`과 `sasu gate spec`이 실행될 때 하네스가 qa-log의 Audit History에 그 실행을 기록하고 status를 전이한다. 스킬 문서는 에이전트에게 그 블록을 쓰라고 지시하지 않는다.
- R6. `sasu gate reopen`은 qa-log의 봉인 여부와 무관하게 성공하고, evidence 원문을 새 Q 턴으로 Raw Q&A에 붙인다.
- R7. spec fidelity 레인 프롬프트가 D-08 문장을 포함한다.
- R8. prelint가 PRD의 Qn 인용마다 해당 Q의 사용자 답변이 비어 있지 않은지 검사하고, 비었으면 `prd-cited-question-unanswered`로 막는다.
- R9. `source_intake`가 qa-log가 아닌 PRD에 대해 `implement start`가 gap-audit과 spec PASS를 요구하지 않는다(현행 유지를 명시). 대신 receipt에 "judge 미실행: 사용자 발화 없음"이 기록된다.
- R10. 위 변경으로 삭제되는 상태(`closure-blocked`, 라운드 카운터, 스킬의 수동 Audit History 지시)는 같은 변경에서 제거되고 호환 경로를 남기지 않는다.

## 7. Acceptance Criteria

| ID | Criterion | Judgment | Evidence Declaration |
| --- | --- | --- | --- |
| AC1 | 열린 finding 3건으로 재실행하면 출력 finding id가 그 3건의 부분집합이고, 결정 셀이 바뀐 레인이 없으면 새 id가 없다. Covers R1. | machine | - |
| AC2 | 결정 셀이 바뀐 레인 하나에서는 새 finding이 허용되고 다른 레인에서는 허용되지 않는다. Covers R1. | machine | - |
| AC3 | 코드와 상태 파일 어디에도 `closure-blocked`, `closureExhausted`, semantic round 카운터가 남아 있지 않다. Covers R2, R10. | machine | - |
| AC4 | 판정 뒤 열린 finding이 requiresHuman 2건뿐이면 `gate status`가 두 건을 한 묶음으로 출력하고 verdict는 `NEEDS_HUMAN`이며, 사용자 답이 기록되면 재실행 없이 PASS로 봉인된다. Covers R2. | machine | - |
| AC5 | goal-scope 레인이 P1 finding을 내고 다른 레인이 비어 있으면 verdict가 PASS이고 그 finding이 warnings에 있다. Covers R3. | machine | - |
| AC6 | data-tech 레인이 requiresHuman finding을 내면 R2의 묶음에 들어가고 PASS가 아니다. Covers R3. | machine | - |
| AC7 | 봉인 PASS 뒤 Q 앵커 한 줄, Audit History 한 블록, status 한 값을 바꿔도 `gate status`가 STALE이 아니다. Covers R4. | machine | - |
| AC8 | 봉인 PASS 뒤 Decision Register의 결정 셀 한 곳을 바꾸면 STALE이다. Covers R4. | machine | - |
| AC9 | `gate gap-audit` 실행 뒤 qa-log의 Audit History에 그 실행의 블록이 있고 status가 전이돼 있으며, 실행 전후 diff에 에이전트 쓰기가 없다. Covers R5. | machine | - |
| AC10 | `skills/interview-me/SKILL.md`와 `skills/gen-prd/SKILL.md`에 에이전트가 Audit History를 쓰라는 지시가 없다. Covers R5, R10. | machine | - |
| AC11 | status가 complete이고 봉인된 qa-log에 `gate reopen --evidence "..."`를 실행하면 exit 0이고 Raw Q&A 끝에 그 evidence가 새 Q 턴으로 붙어 있다. Covers R6. | machine | - |
| AC12 | spec fidelity 프롬프트 문자열에 D-08 문장이 있다. Covers R7. | machine | - |
| AC13 | Decision Register에 resolved로 표시됐지만 Raw Q&A의 해당 답변이 비어 있는 결정을 PRD가 옮겨 적은 경우, spec fidelity가 그것을 finding으로 낸다. Covers R7. | judged | 고정 qa-log/PRD 픽스처 한 쌍에 대해 spec 레인을 실제로 돌리고 finding 목록을 run 디렉터리에 남긴다 |
| AC14 | PRD가 답변 없는 Qn을 인용하면 prelint가 `prd-cited-question-unanswered`를 내고, 답변이 있으면 내지 않는다. Covers R8. | machine | - |
| AC15 | `source_intake`가 qa-log가 아닌 PRD로 `implement start`가 judge PASS 없이 시작되고 receipt에 judge 미실행 사유가 있다. Covers R9. | machine | - |
| AC16 | 4.1의 세 세션 qa-log를 새 코드로 재생하면 각 루프가 judge 호출 수 × 5분 + 사람 질문 1묶음 안에 봉인 PASS 또는 NEEDS_HUMAN에 도달하고, 사용자 override 없이 끝난다. Covers R1-R7. | judged | 세 qa-log 사본에 대해 재생 스크립트를 돌리고 사이클 수, 호출 수, 종료 verdict를 baseline.md 옆에 기록한다 |

## 8. PRD-Level Tasks

- T1. 4.1 baseline 기록. Covers 4.1. Depends on: none.
- T2. 사이클 상태기계에서 라운드 예산과 closure-blocked를 제거하고 open findings 집합과 NEEDS_HUMAN verdict를 도입. Covers R2, R10, AC3, AC4. Depends on: none.
- T3. 재실행 입력을 열린 finding으로 제한하고 레인 프롬프트의 rerun 모드에서 새 finding을 금지. Covers R1, AC1, AC2. Depends on: T2.
- T4. 레인에 blocking 속성을 두고 goal-scope, data-tech를 경고로. Covers R3, AC5, AC6. Depends on: T2.
- T5. 입력 해시를 결정 셀 정규화로 교체. Covers R4, AC7, AC8. Depends on: none.
- T6. Audit History와 status 전이를 qalog.ts로 옮기고 스킬 문서에서 수동 지시 삭제. Covers R5, R10, AC9, AC10. Depends on: T2.
- T7. 봉인 상태의 reopen 허용과 evidence의 Q 턴 추가. Covers R6, AC11. Depends on: T5.
- T8. spec fidelity 프롬프트 문장 추가와 픽스처 판정. Covers R7, AC12, AC13. Depends on: none.
- T9. prelint 규칙 `prd-cited-question-unanswered`. Covers R8, AC14. Depends on: none.
- T10. 인터뷰 없는 경로의 receipt 사유 기록. Covers R9, AC15. Depends on: none.
- T11. 세 세션 재생과 결과 기록. Covers AC16, SC1-SC4. Depends on: T2-T7.

## 9. Verification Contract

### 9.1 Test Mode Contract

| Mode | Required For Done | Covers | Human Decision |
| --- | --- | --- | --- |
| build/static | yes | TypeScript 빌드, 삭제 식별자 부재, 스킬 문서 문자열 | none |
| automated behavior | yes | judge 응답을 고정한 스텁으로 도는 사이클 상태기계, 해시, reopen, prelint 검사. 픽스처는 `cli/test/fixtures/gate-loop/` | none |
| live judge run | yes | 실제 spec 레인 호출 1회 (AC13) | none |
| e2e replay | yes | 세 세션 qa-log 사본 재생 (AC16), 기록은 `agents/runs/gate-loop/`에 두고 커밋하지 않는다 | none |
| regression | yes | 기존 `npm test` 전체 | none |

### 9.2 Required Agent Verification

| ID | Mode | Covers | Pass Intent | Required For Done | Can Be Blocked |
| --- | --- | --- | --- | --- | --- |
| V1 | build/static | R1-R10, AC3, AC10, AC12 | TypeScript 빌드가 통과하고 삭제 대상 식별자와 스킬 문서의 수동 지시가 부재하며 프롬프트 문장이 존재한다 | yes | no |
| V2 | automated behavior | R1-R6, R8, R9, AC1, AC2, AC4-AC9, AC11, AC14, AC15 | 재실행 부분집합, 결정 변경 레인 예외, NEEDS_HUMAN 묶음과 봉인, 경고 레인, requiresHuman 승격, drift 제외/포함 4종, 하네스 기록, 봉인 reopen, prelint 신규 규칙의 수락 경로와 거부 경로가 각각 독립 검사로 잡힌다. 보호하는 회귀는 사람 접점을 줄이면서 requiresHuman finding이 조용히 통과하는 상태다 | yes | no |
| V3 | live judge run | R7, AC13, SC5 | 픽스처 한 쌍에 실제 spec 레인을 돌려 resolved 표시만 있고 답변이 없는 결정을 finding으로 낸다 | yes | no |
| V4 | e2e replay | R1-R7, AC16, SC1-SC4 | 세 세션 qa-log 재생이 override 없이 끝나고 사이클 수와 호출 수가 baseline보다 작다 | yes | no |
| V5 | regression | 기존 전체 | `npm test` 524건이 이 변경 뒤에도 통과하거나, 삭제된 상태를 검사하던 테스트만 같은 변경에서 함께 삭제된다 | yes | no |

### 9.3 Human Verification

- 다음 실제 인터뷰 한 번에서 NEEDS_HUMAN 묶음을 받아 답하는 경험: 묶음의 질문이 실제로 사람 결정이 필요한 것들뿐이었는지 호연이 판단한다. 에이전트가 답할 수 있었던 질문이 섞여 있으면 실패다.
- 이 PRD 승인 자체.

## 10. Risks And Open Decisions

- 사람 접점 축소가 지어낸 승인을 통과시킬 위험. 완화는 D-08(spec fidelity의 원문 대조)과 D-09(답변 없는 Q 인용 차단). 9.3의 첫 항목이 이 위험의 관측 지점이다.
- 재실행에서 새 finding을 금지하면 첫 판정이 놓친 진짜 gap이 영영 안 잡힐 위험. 결정 셀이 바뀐 레인은 예외로 둔 이유이며, 그 외의 gap은 spec 단계에서 다시 볼 기회가 있다.
- 결정 셀 정규화 해시가 너무 느슨하면 실제 결정 변경도 STALE을 안 만들 위험. AC8이 그 경계다.
- 열린 결정: 없음.

## 11. Implementation Guardrails

- 레인 프롬프트의 판정 기준 문장은 D-08 한 문장 추가 외에 바꾸지 않는다.
- 다른 PRD의 run 디렉터리와 qa-log를 읽기 전용으로만 쓴다. 재생은 사본으로 한다.
- 삭제되는 상태를 읽는 호환 경로를 남기지 않는다. 기존 `closure-blocked` 상태 파일이 있으면 로더가 명시적 오류를 낸다.
- 커밋과 PR 텍스트에 에이전트, 모델, 도구 이름을 넣지 않는다.

## 12. Implementation Result Report Contract

- status: Done, Partially Done, Blocked 중 하나.
- R1-R10 각각의 착지 여부와 AC1-AC16의 결과.
- 세 세션 재생 결과: baseline 대비 사이클 수, judge 호출 수, 종료 방식.
- 삭제한 상태와 테스트의 목록.
- 9.3을 위해 다음 인터뷰에서 사용자가 볼 것.
