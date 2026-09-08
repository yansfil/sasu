# Sasu 0.8 and 0.9 matched process comparison

Generated from `comparison.json` on 2026-09-08.

## Result

The two versions made the same product decision in both matched cases.
The healthy implementation passed and produced a receipt in both versions.
The planted omission failed without a receipt in both versions, and both reviews identified B6: the one-item summary says `1 items` instead of `1 item`.

| Fixture | Version | Unified result | Receipt | Public CLI commands | Required suites | Judge calls | Verify command | Judge wall union | Judge resource sum | Input tokens | State bytes |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Healthy | 0.8 | PASS | yes | 9 | 1 | 8 | 20.608 s | 19.953 s | 131.165 s | 180,946 | 29,101 |
| Healthy | 0.9 | PASS | yes | 4 | 1 | 1 | 26.395 s | 25.977 s | 25.977 s | 24,975 | 9,955 |
| B6 omission | 0.8 | FAIL | no | 8 | 1 | 8 | 20.102 s | 19.749 s | 123.888 s | 180,884 | 28,419 |
| B6 omission | 0.9 | FAIL | no | 3 | 1 | 1 | 33.480 s | 33.129 s | 33.129 s | 24,991 | 10,739 |

`Judge wall union` merges overlapping judge intervals, while `Judge resource sum` adds every lane duration.
The old verifier ran six acceptance lanes, fidelity, and design concurrently, so its summed resource time is much larger than its elapsed time.

The workflow simplification removed five public command invocations in each case.
The healthy path changed from start, six row artifact registrations, verify, and finalize to start, one run artifact registration, verify, and finalize.
The failed path has the same difference without finalize.
It also reduced the judge fanout from eight calls to one whole-requirements review while keeping the same one mandatory test suite.
The resulting state file was 19,146 bytes smaller for the healthy case and 17,680 bytes smaller for the omission case, reductions of 65.8% and 62.2% respectively.

The old 0.8 state recorded its design lane as `FAIL` with an empty `comments` array in both cases.
That lane did not block the healthy unified PASS or its receipt, so this report treats it as old lane bookkeeping rather than a product defect.

## Controlled inputs

Both versions used byte-identical healthy source, byte-identical omission source, and the same test suite.
The semantic contract contains the same goal, decision, and six behavior statements.
Only the required PRD mechanics differ: 0.8 uses the four-column behavior table and 0.9 uses the three-column table.
Both used the project-local routine profile with Codex Luna at xhigh effort, no fallback, a retry budget of one, and one `verify` call per trial.
The old sequence followed its documented completion path and did not add separate `check` calls on top of `verify`.

## Timing limits

These are deterministic process replays over fixed implementation bytes, not independent implementations.
They do not measure implementation speed.
The single healthy 0.9 verify was 5.787 seconds slower than 0.8, and the single omission verify was 13.378 seconds slower.
Those differences do not support a speedup or slowdown claim because judge latency varied and every comparison process overlapped an unrelated mutation verification.

| Comparison process | Process interval UTC | Concurrent mutation verification |
| --- | --- | --- |
| 0.8 healthy | 08:58:16.871 to 08:58:38.224 | V1 for 21.353 s, V2 for 18.046 s, V3 for 21.353 s |
| 0.9 healthy | 09:00:53.371 to 09:01:20.036 | V1 for 26.665 s |
| 0.8 omission | 09:01:43.673 to 09:02:04.204 | V1 for 20.531 s |
| 0.9 omission | 09:02:13.233 to 09:02:46.872 | V1 for 33.639 s |

Mutation V1 ran from 08:57:50.190 to 09:02:51.207 UTC and spent about five minutes inside a browser-bearing required suite.
Mutation V2 and V3 ended at 08:58:34.917 and 08:58:39.221 UTC.
This overlap can affect host and backend wall time, so the reliable comparison here is the observed structural count, state size, model usage, and matching semantic outcome.

## Provenance

Version 0.8 was executed from detached commit `488d3cc7d6e99742e7f68a1680fcb101710c8e20`.
Its normal build exposed a pre-existing TypeScript library mismatch, so the unchanged source was compiled with ES2022 and DOM libraries; the built CLI hash is recorded in `baseline-build.json`.
Version 0.9 was executed from correction commit `f6963672454207cbce08908cc33eaf6e74d866c7`.
The raw measurements, implementation and suite hashes, native session ID, per-command events, lane times, and overlap intervals remain in `comparison.json` and the four `results/*/process.json` files.
