# Unified versus split review fresh implementation pair

Status: quality 14/14 expected outcomes, both product receipts complete, both native reports valid, and comparison strictly comparable. Recommendation: retain unified default.
Source candidate is frozen at `6b88d83ce325a2a871af69d4e32cdf737c6dc229`; the previously passed same-source suites are not rerun.
Execution order was fixed before the first call: unified then split for each quality case, and unified then split for non-overlapping native product windows.
See `execution.json`, `manifest.json`, and `/private/tmp/sasu-parallel-quality-5_c0rs1c/roster.json` for current coordinates.
The one-line source_intake restoration is preserved under `input-corrections/source-intake/`; product behaviors, decisions and approval were unchanged.
The restored paired PRD SHA-256 is `44238bd5792dc5103f0ead8690f49fe540c231bd7c07e41d79157f757ce6bb3e`.
The original preparation text below remains command guidance; its pending candidate placeholder has now been bound.

## Fixed coordinates

- Unified launcher: `/private/tmp/sasu-parallel-review-prep/unified`
- Split launcher: `/private/tmp/sasu-parallel-review-prep/split`
- Case path in both launchers: `benchmarks/task-list-review-comparison/benchmark.json`
- PRD path in both launchers: `benchmarks/task-list-review-comparison/prd.md`
- PRD topic and its parent directory: `task-list-review-comparison`
- Product base commit: `c8191eff3b08cd63a7c349c7eda964fcd6bac83d`
- Baseline harness commit: `3f549dcfff71fe1f7fa974a383f6e8a055ce8463`
- Candidate harness: `/Users/hoyeonlee/projects/sasu.worktrees/parallel-review-comparison`, frozen and verified at `6b88d83ce325a2a871af69d4e32cdf737c6dc229`.
- Executor for each arm: Codex `gpt-5.6-sol`, medium, fresh native session.
- Routine judge in both starter trees: Codex `gpt-5.6-luna`, xhigh, fallback null.
- Post-receipt process evaluator in both arms: fresh Codex `gpt-5.6-sol`, using `sasu.benchmark-qualitative.v1`.

The fixed PRD reuses the previously authorized task-list case and its recorded approval note.
The coordinator must still confirm that the current comparison authorization covers these exact fresh runs and must obtain readiness from each pinned harness before implementation.
`prepare-run` enforces `status: ready`, `human_approval: approved`, and current `sasu prd readiness`.

## Pre-launch checks

Run these only after the split candidate is complete.

```sh
test "$(git -C /Users/hoyeonlee/projects/sasu rev-parse HEAD)" = 3f549dcfff71fe1f7fa974a383f6e8a055ce8463
git -C /Users/hoyeonlee/projects/sasu.worktrees/parallel-review-comparison merge-base --is-ancestor 3f549dcfff71fe1f7fa974a383f6e8a055ce8463 6b88d83ce325a2a871af69d4e32cdf737c6dc229
test "$(git -C /private/tmp/sasu-parallel-review-prep/unified rev-parse HEAD)" = c8191eff3b08cd63a7c349c7eda964fcd6bac83d
test "$(git -C /private/tmp/sasu-parallel-review-prep/split rev-parse HEAD)" = c8191eff3b08cd63a7c349c7eda964fcd6bac83d
cmp /private/tmp/sasu-parallel-review-prep/unified/benchmarks/task-list-review-comparison/prd.md /private/tmp/sasu-parallel-review-prep/split/benchmarks/task-list-review-comparison/prd.md
cmp /private/tmp/sasu-parallel-review-prep/unified/benchmarks/task-list-review-comparison/benchmark.json /private/tmp/sasu-parallel-review-prep/split/benchmarks/task-list-review-comparison/benchmark.json
cmp /private/tmp/sasu-parallel-review-prep/unified/package.json /private/tmp/sasu-parallel-review-prep/split/package.json
cmp /private/tmp/sasu-parallel-review-prep/unified/test/task-list.test.mjs /private/tmp/sasu-parallel-review-prep/split/test/task-list.test.mjs
cmp /private/tmp/sasu-parallel-review-prep/unified/agents/config.json /private/tmp/sasu-parallel-review-prep/split/agents/config.json
test ! -e /private/tmp/sasu-parallel-review-prep/unified/src/task-list.mjs
test ! -e /private/tmp/sasu-parallel-review-prep/split/src/task-list.mjs
```

Build and verify each harness at its pinned commit before its native session.
Do not install either harness globally.
The executor prompt must bind every Sasu command and skill read to its arm's exact harness path.

## Native implementation launches

Use separate fresh native Codex sessions and do not overlap implementation windows.
Alternate order if repeating the experiment; for this first pair, record the chosen order before launch.

Unified session first action after reading the baseline benchmark and implement skill contracts:

```sh
cd /private/tmp/sasu-parallel-review-prep/unified
node /Users/hoyeonlee/projects/sasu/skills/benchmark-implement/scripts/benchmark_report.js prepare-run --case benchmarks/task-list-review-comparison/benchmark.json
```

Split session first action after reading the candidate benchmark and implement skill contracts:

```sh
cd /private/tmp/sasu-parallel-review-prep/split
node /Users/hoyeonlee/projects/sasu.worktrees/parallel-review-comparison/skills/benchmark-implement/scripts/benchmark_report.js prepare-run --case benchmarks/task-list-review-comparison/benchmark.json
```

Call each `prepare-run` exactly once in its own fresh native session.
Use only its returned `worktree`, `prd`, `runDir`, `gates`, `resultDir`, and `runId`.
Start the implement run before creating `src/task-list.mjs`.
Use the exact CLI from the same harness as the reporter, and bind the implement run to that native session ID.
Stop the implementation clock at receipt creation.
Preserve blocked or exhausted outcomes instead of reserving a replacement run.

## Post-receipt evaluator and native reports

For each arm, locate the transcript with its own harness reporter:

```sh
node ARM_HARNESS/skills/benchmark-implement/scripts/benchmark_report.js locate-session --runtime codex --session-id SESSION_ID
```

After both receipts exist, launch one fresh read-only Codex `gpt-5.6-sol` evaluator per arm with no inherited context.
Give it only the case contract, evaluator rubric, raw transcript through receipt, receipt, state, gates, and paths needed to validate cited events.
Measure evaluator wall clock separately and save only valid `sasu.benchmark-qualitative.v1` JSON at the reserved result directory's `qualitative.json`.

Generate each native report from the same harness that prepared that arm:

```sh
cd ARM_LAUNCHER
node ARM_HARNESS/skills/benchmark-implement/scripts/benchmark_report.js report \
  --case benchmarks/task-list-review-comparison/benchmark.json \
  --run-id task-list-review-comparison-run-N \
  --run-dir PREPARED_WORKTREE/agents/runs/task-list-review-comparison \
  --runtime codex \
  --model gpt-5.6-sol \
  --session-id SESSION_ID \
  --session TRANSCRIPT_JSONL \
  --qualitative agents/benchmarks/task-list-review-comparison/task-list-review-comparison-run-N/qualitative.json
```

Copy the two completed `report.json` files into one coordinator-owned comparison directory, preserving their bytes, then use the existing candidate reporter:

```sh
node /Users/hoyeonlee/projects/sasu.worktrees/parallel-review-comparison/skills/benchmark-implement/scripts/benchmark_report.js compare \
  --baseline /absolute/path/to/unified-report.json \
  --candidate /absolute/path/to/split-report.json \
  --output /private/tmp/sasu-parallel-review-prep/comparison.json
```

The native comparison should be strictly comparable because the case hash, PRD hash, starting HEAD, starting source fingerprint, executor runtime, and executor model are fixed equal.
The harness identity is expected to differ and is reported separately as the experiment variable.

## Measurement interpretation

The existing reporter is authoritative for receipt-backed implementation timing and process counts.
`wallClockSeconds` is state creation through receipt.
`verificationUnionSeconds` is elapsed verify time without overlap double counting, while `verificationSumSeconds` sums verify resources.
`commandUnionSeconds` is elapsed required-suite command time and `verificationCommandSeconds` sums command durations.
`judgeUnionSeconds` is elapsed backend content-execution time and `judgeSeconds` sums concurrent backend durations.
`judgeInvocations` counts persisted logical judge records with at least one content execution.
`judgeCalls` sums their actual answering attempts, including parse retries and fallback attempts.
A backend preflight has `attempts: 0`, so it is excluded from both counts even though it contributes to outer verify wall clock.
Internal model tool turns are not separate judge calls.
Provider usage includes only usage attached to accepted answering records; do not infer retry, preflight, or total token cost from it.

For the split arm, the candidate state must retain Fidelity and Code review as two real judge records with independent timings, retries, traces, results, and usage.
If it stores them behind one synthetic record, the current reporter will undercount `judgeInvocations`, distort `judgeUnionSeconds`, and violate the experiment contract.
The unified reporter counts one `reviewInvocations` entry for its one routine role per attempt.
The candidate reporter counts both actual roles and exposes `reviewInvocationsByRole` plus `timing.reviewExecutions`; neither count is the number of repair rounds.

The post-receipt evaluator duration stays in `timing.evaluationSeconds` and must never be added to implementation wall clock.
For handoff-to-receipt and the requested preparation, initial implementation, focused QA, repair/recovery, and PASS-to-receipt phases that the native reporter does not expose directly, derive intervals once from raw transcript and state events after both receipts.
Keep this supplemental phase table separate from native reports, preserve unattributed time, and do not replace the reporter's receipt-backed metrics.

One small causal pair can reveal mechanics and obvious regressions but cannot establish a general speedup.
