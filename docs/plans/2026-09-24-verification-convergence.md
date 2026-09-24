# Verification convergence: review before the final full verify

Status: planned and independently reviewed once on 2026-09-24; implemented on branch `fix/verification-convergence`.
Source: the proposal and review in `agents/runs/verification-convergence-plan-20260924/` of the record tree (run bookkeeping, not committed).
This amends one ordering of the [2026-09-15 stateless verification decision](2026-09-15-stateless-verification.md): native review no longer waits for a deterministic PASS.
Everything else in that decision stands.

## Problem

Long implementations repeated the full required suite and a fresh review after every small fix.
The CLI said "Do not review or ship this head until deterministic verification passes", so agents ran a full verify only to unlock review, then changed source again.
A failed verify named no failed command, so agents reran the whole suite on the same input instead of reproducing the one failure.

## Measured motivation

herdr-ide run `web-shell-pivot-s4`, `state.json` `verificationAttempts`, read on 2026-09-24.
Eight full verifies took about 27.6 minutes of attempt time; review and manual QA time is not recorded there and is not counted.
S1 is the Rust test suite, S2 the Swift test suite, S3 the Rust lint.

| Attempt | Verdict | Elapsed | S1 | S2 | S3 | Note |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | PASS | 6m23s | 105s | 259s | 19s | source changed after the PASS |
| 2 | PASS | 2m49s | 111s | 39s | 18s | source changed after the PASS |
| 3 | FAIL | 3m54s | 71s | 155s | 8s FAIL | only lint failed |
| 4 | PASS | 4m11s | 87s | 162s | 1s | source changed after the PASS |
| 5 | FAIL | 3m36s | 41s FAIL | 167s | 8s | after a source change |
| 6 | FAIL | 4m11s | 65s FAIL | 183s | 2s | attempts 6-8 share one inputFingerprint |
| 7 | FAIL | 1m13s | 35s FAIL | 28s | 8s | identical input |
| 8 | FAIL | 1m21s | 69s FAIL | 10s | 2s | identical input, a different test failed |

Attempts 1, 2, and 4 were followed by source changes, about 13.4 minutes; that is an upper bound on what moving review earlier can save, not a measured saving.
Attempts 6-8 reran identical input three times, about 6.7 minutes, and every one failed.
The table does not establish a flaky cause or that the environment was identical across attempts.
S2 passed all eight times and took about 60% of the time; skipping it would need affected-test inference, which this plan does not build.

## Flow

```text
PRD -> implement + focused tests/observation -> commit
  -> first review: complete contract; verification verdict NOT_RUN, STALE, or FAIL stated honestly
  -> fix -> commit -> focused tests -> follow-up review with prior context (closure and impact first)
  -> full `sasu implement verify` on the final committed candidate
       PASS: last reviewed HEAD equals the report head and registered evidence unchanged -> ship
             otherwise one short follow-up review, then ship
       FAIL: reproduce only the failed command(s), fix, commit, full verify again
Integration-risk changes may run an early full verify; the execution plan names when.
```

Example, replaying S4 attempt 5 under this flow.
The full verify fails in S1 on `multi_pane_terminal_session_destroy_releases_and_reaps_children` while S2 and S3 pass.
The CLI answers that ship is blocked, names `S1` with its command and exit code, and says to reproduce it in isolation.
The implementor runs that one test, records a hypothesis, fixes it, commits, and asks the same review context for closure and impact on the diff.
One full verify on the new head passes, and since the reviewed HEAD is the report head with unchanged evidence, delivery proceeds without another review.
The identical-input reruns of attempts 6-8 do not happen; if the implementor reruns anyway, the CLI states the consecutive count and that an unchanged rerun is a diagnostic reproduction, not a fix.

## What changed

- `sasu implement verify` FAIL and ERROR guidance names the failed required command ids and exit codes, or the error that stopped the run, says ship is blocked, and directs isolated reproduction, fix, commit, and a full rerun.
- When consecutive FAIL attempts share one `inputFingerprint`, the guidance adds one line with the count, read from `state.verificationAttempts` only; the run is never refused.
- PASS guidance states the deterministic follow-up condition in place of "rerun verify and review".
- `sasu implement status` no longer tells agents to wait for PASS before review; it discloses the current verdict and keeps delivery behind a current PASS.
- The implement, ship, and please skills, the implement references, `README.md`, `AGENTS.md`, and `PRINCIPLES.md` describe the same order.

## Deliberately not built

- No partial or quick verify, suite result cache, or affected-test inference; the final full verify runs every sealed required suite.
- No semantic ledger, reviewer state, or receipt; the follow-up condition is a comparison the implementor makes from the handoff and the report.
- No reviewer-process reuse mandate; the requirement is the context handoff, and a reviewer without it performs the full-scope review.
- No change to `runner.ts`, `inputIdentity`, the ship PASS gate, or the verification lease.
- No refusal, flag, or state field for repeated identical input; reproducing a failure is a legitimate diagnostic.
- Suite parallelism and a Draft PR before PASS remain separate work.

## Known limit

`inputIdentity` excludes command artifacts, so a new command log can carry meaning on the same input identity.
The follow-up condition compares registered evidence, not command logs, so a final log that contradicts a reviewed claim is caught only when the implementor reads it; this plan adds no gate for that.
The saving from earlier review is unmeasured beyond the upper bound above, and the cost of reviewers reading a head whose full verify has not run is also unmeasured.

## Principles

Sasu 2 and 13: verification stays smaller than implementation, and an unchanged input is not rerun to seek a favorable verdict.
Sasu 10: the failed commands and the repeated-input count are existing recorded facts, disclosed rather than enforced.
Engineering 4: an attempt that is neither PASS nor carries a failed command or an error raises instead of printing empty guidance.
Engineering 13: the class fixed is guidance that gated review on PASS, not one run's retry count.
