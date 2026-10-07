# 공유 워킹트리의 변경과 검증

2026-09-07 WATCH 작업에서 WaitOptions와 호출부가 불일치해 다른 세션의 빌드와 검증이 막혔다.
타입과 호출부를 변경할 때는 양쪽을 하나의 편집 작업으로 함께 반영한다.
편집 직후 저장소 루트에서 ./cli/node_modules/.bin/tsc -p cli/tsconfig.json --noEmit을 실행한다.
자신의 변경으로 실패하면 다음 작업이나 인계 전에 자신의 범위에서 해결한다.
쓰기 중단 지시가 오면 즉시 멈추고, 이미 반영한 변경과 빌드 상태를 보고한다.
테스트는 cli/dist를 읽으므로, --noEmit 통과만으로 최신 코드가 검증되었다고 판단하지 않는다.
테스트 전에는 npm --prefix cli run build로 산출물을 갱신한다.
전체 검증 도중 소스가 바뀌면 그 결과를 변경 후 코드의 통과 증거로 사용하지 않는다.

## Current Git context

A run record at `<checkout>/agents/runs/<slug>/state.json` selects that checkout for source, suite execution, evidence, and delivery.
`loadState` derives this context from the validated record location; v14 records do not persist `projectRoot` or `worktree`.
A sibling invocation only finds the record, and duplicate slugs require an explicit `--state` path.
The current attached branch and configured delivery base determine the range through Git merge-base, so rebase and upstream merges do not retain obsolete start-time ancestry or upstream-only paths.
Verification pins HEAD, branch, base ref, base tip, source, sealed contract, suite, and evidence in its input identity.
Any change requires a new verification attempt, including a new HEAD with identical source bytes.
When origin is configured, `origin/<delivery.baseBranch>` must exist; without origin the local configured base must exist.
The default base branch is `main`, and missing or ambiguous Git inputs fail explicitly.
Non-Git and unborn projects can run deterministic checks with unavailable Git provenance, but native dispatch and delivery require an attached committed checkout.
