# Full implementation process comparison

This is one sequential exploratory pair, so it does not estimate a general speedup.
The old v1 and new v2 native benchmark reports remain separate because their schemas are not cross-compatible.
The six Behavior texts are exactly equal: yes.
Post-receipt evaluation is excluded from these clocks and executor token counts.

| Version | Status | Handoff to receipt | State start to receipt | Handoff to state start | State start to first verify | Verify-attempt wall | Between-attempt recovery | Final PASS to receipt | Suite wall | Judge wall union | Judge resource sum |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| old | complete | 445.595 s | 166.230 s | 279.365 s | 125.532 s | 25.965 s | 0.000 s | 14.733 s | 0.547 s | 25.305 s | 172.397 s |
| new | complete | 352.992 s | 280.981 s | 72.011 s | 147.020 s | 63.009 s | 9.605 s | 61.346 s | 0.483 s | 62.353 s | 62.353 s |

The five coarse phases are disjoint except for a possible 1 ms timestamp rounding difference.
State start to first verify is an observable interval containing implementation, evidence writing, focused checks, and any waits. It is not pure model coding time.
Suite and judge figures are nested details inside verification, and judge resource sum can exceed wall time when lanes run concurrently.
The old preparation interval includes an invalid-topic preparation failure, a coordinator correction gap, and retry. The new run started after that symmetric fixture correction.
Both native benchmark reporters refused the actual run directory because the prepared metadata predicted matched-task-list-library while the CLI created task-list-full. Their raw exit-1 records remain under ../native-report-attempts, so no native v1/v2 report is presented.
The new run's 61.346 s after its successful verify includes an ENOSPC finalize failure and recovery. It is an observed environmental confound, not a clean measurement of routine finalization latency.
The implementation source outputs are not byte-identical. Old src/task-list.mjs is 871 bytes with SHA-256 eb528006ac5f59b48afdef1f6e61977d0b785f5338f9587ffe9eaa25a23f3ce3; new is 866 bytes with SHA-256 8e7bb99c244fe20910da120027e11b28ff728ecf550eba6311ce8100c45058a6.
The old test is the exact 905-byte starter. The new 1,365-byte test preserves those 905 bytes as an exact prefix and appends tests; package.json and agents/config.json remain byte-identical to the shared starter in both runs.

## old

The executor session was 01a0806c-4f72-7920-8143-d7fa85a16bfc with gpt-5.6-sol:medium.
Executor usage through the receipt boundary was 1,288,042 input, 1,212,416 cached input, 7,873 output, and 3,325 reasoning tokens.
The run recorded 8 judge result lanes and 8 actual judge calls with 318,104 input and 3,051 output tokens where usage was available. Usage covers 8 calls and is unavailable for 0.
Observed exact local skill reads: yes /private/tmp/sasu-full-implementation-comparison/old/.agents/skills/benchmark-implement/SKILL.md; yes /private/tmp/sasu-full-implementation-comparison/old/.agents/skills/implement/SKILL.md.
Observed pinned CLI use: yes /Users/hoyeonlee/projects/sasu.worktrees/workflow-baseline/cli/dist/cli.js.
Receipt sasu.implement.receipt.v4 finalized 2026-09-08T09:58:13.439Z, source fingerprint d54a84ecc09cca375d042417aad1ce2b55a83790ebd54a421dc4214a57c76f0b, completion fingerprint 2b5bbc9f9b5ee875c39ed5dee517e00d42e6fc101b230685bab86a1c87170b6b.
Failed verification attempts: none.
Transcript command or policy failures: 2026-09-08T09:52:24.024Z exit 1: /bin/zsh -lc node /Users/hoyeonlee/projects/sasu.worktrees/workflow-baseline/skills/benchmark-implement/scripts/benchmark_report.js prepare-run --case benchmarks/task-list-full/benchmark.json.
Events after the final successful verify: 2026-09-08T09:58:13.220Z implement finalize.
The initial preparation failure occurred 96.180 s after handoff, allocated no run, and the retry began 154.006 s after that failure.
The reporter predicted /var/folders/_c/xjlzc0fd7gg04kcy18q5bd240000gn/T/sasu-benchmark-task-list-full-UNOlgg/worktree/agents/runs/matched-task-list-library/state.json, while the actual CLI state was /var/folders/_c/xjlzc0fd7gg04kcy18q5bd240000gn/T/sasu-benchmark-task-list-full-UNOlgg/worktree/agents/runs/task-list-full/state.json; both paths remain recorded.

## new

The executor session was 01a08074-a1aa-7ff1-93b2-da2f6d148efa with gpt-5.6-sol:medium.
Executor usage through the receipt boundary was 1,135,966 input, 1,068,672 cached input, 7,051 output, and 2,940 reasoning tokens.
The run recorded 2 judge result lanes and 3 actual judge calls with 25,349 input and 899 output tokens where usage was available. Usage covers 1 calls and is unavailable for 2.
Observed exact local skill reads: yes /private/tmp/sasu-full-implementation-comparison/new/.agents/skills/benchmark-implement/SKILL.md; yes /private/tmp/sasu-full-implementation-comparison/new/.agents/skills/implement/SKILL.md.
Observed pinned CLI use: yes /Users/hoyeonlee/projects/sasu/cli/dist/cli.js.
Receipt sasu.implement.receipt.v5 finalized 2026-09-08T10:05:19.952Z, source fingerprint a5b3701f70d45ecf324ea206e4567f5d7b0f341d290e5cedb9bbcf6eb377465e, completion fingerprint 5d3fa8da4816ed602f0c34b24f75cd08b24e8f4cbaa88beb4e47963b1b197236.
Failed verification attempts: 7a090e58-b294-40fd-a865-96e8874536d3 ERROR (38.087 s): judge-invalid-output (backend: codex): codex exec produced no last message.
Transcript command or policy failures: 2026-09-08T10:03:44.084Z exit 1: /bin/zsh -lc node /Users/hoyeonlee/projects/sasu/cli/dist/cli.js implement verify --json; 2026-09-08T10:04:29.857Z exit 2: /bin/zsh -lc node /Users/hoyeonlee/projects/sasu/cli/dist/cli.js implement finalize --json; 2026-09-08T10:05:08.573Z tool-rejection: rejected rm cleanup, then finalize.
Events after the final successful verify: 2026-09-08T10:04:29.682Z implement finalize; 2026-09-08T10:04:49.364Z filesystem and stale-temp diagnostics; 2026-09-08T10:05:08.538Z rejected rm cleanup, then finalize (tool-rejection); 2026-09-08T10:05:19.626Z trash stale temp files, then finalize.
The reporter predicted /var/folders/_c/xjlzc0fd7gg04kcy18q5bd240000gn/T/sasu-benchmark-task-list-full-PEYZT9/worktree/agents/runs/matched-task-list-library/state.json, while the actual CLI state was /var/folders/_c/xjlzc0fd7gg04kcy18q5bd240000gn/T/sasu-benchmark-task-list-full-PEYZT9/worktree/agents/runs/task-list-full/state.json; both paths remain recorded.

