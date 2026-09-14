# Results: impact-scoped re-review and same-input lane repair, live

Recorded on 2026-09-14, 22:35 to 22:53 KST; both builds ran concurrently on one machine with real judges.
Raw records: `evidence/<label>/rounds.json` (R1 to R4), `evidence/<label>/rounds-repair.json` (R5, R6), `evidence/<label>/state.json` (the run's own authority, seven attempts each), `evidence/<label>/R*.log` (each verify's `--json` output), the driver console logs beside them, and `SHA256SUMS`.
Host paths are replaced by `<exp>`, `<projects>`, `<tmp>` and `<home>` placeholders in the copied records; the hashes cover the copied files.

## What was measured

Two questions, one fixture, one run of five correction rounds followed by one induced backend error and one same-input re-verify.

1. Does an impact-scoped (`focused`) round cost less than a whole re-review while still catching a defect that hides behind a local-looking change?
2. After one review lane ends in a backend error on an otherwise settled attempt, does the next verify on identical input rerun only the lost lane, and what does that save?

Cost columns count only executed judge calls: a carried lane runs no judge, reads nothing and spends no tokens.
Reads are the audited read commands of the answering attempt; chars are the metered read output; tokens are the provider's reported usage of the answering attempt (input includes cached input).

## Rounds R1 to R4: impact-scoped re-review

| Round | Build | Verdict | Wall | Mode | Fidelity | Code | Reads / chars | Input tok (cached) / output | Findings (refs) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| R1 full implementation | baseline | FAIL | 68 s | whole | FAIL 66 s | PASS 57 s | 6 / 19,865 | 222,512 (172,032) / 4,794 | F1 B31/D-02 |
| | candidate | PASS | 75 s | full | PASS 66 s | PASS 73 s | 8 / 23,208 | 285,601 (259,584) / 5,689 | none |
| R2 local refactor of `value7` | baseline | FAIL | 62 s | whole | FAIL 56 s | FAIL 60 s | 5 / 19,185 | 195,065 (144,640) / 4,353 | F1 open, F2 (smoke coverage) |
| | candidate | FAIL | 93 s | focused | PASS 92 s, focused | FAIL 61 s, focused | 7 / 19,185 | 259,292 (216,832) / 5,339 | F1 B31/D-02 |
| R3 shared helper defect (`present` drops values above 24) | baseline | FAIL | 154 s | whole | FAIL 72 s | FAIL 152 s | 5 / 18,615 | 200,177 (177,408) / 6,739 | F3, F4 B25..B30/D-01 by both roles |
| | candidate | FAIL | 116 s | focused | FAIL 115 s, focused (Claude fallback) | FAIL 76 s, widened | 13 / 39,447 | 157,376 (225,677) / 8,207 | F2, F3 B25..B30/D-01 by both roles |
| R3b helper restored | baseline | FAIL | 76 s | whole | FAIL 65 s | FAIL 74 s | 6 / 20,540 | 240,217 (196,608) / 5,899 | F3, F4 resolved by both; F1, F2 open; F5, F6 re-raised |
| | candidate | FAIL | 88 s | focused | FAIL 86 s, focused | FAIL 72 s, widened | 8 / 17,801 | 303,873 (258,560) / 7,035 | F2, F3 resolved by both; F1 open |
| R4 unrelated comment plus a registered log contradicting B30 | baseline | FAIL | 100 s | whole | FAIL 99 s | FAIL 93 s | 9 / 25,660 | 356,655 (307,456) / 8,719 | B30 satisfied by both roles; F1, F2, F5, F6 open |
| | candidate | FAIL | 120 s | focused | FAIL 97 s, focused | FAIL 118 s, focused | 10 / 33,197 | 390,186 (351,232) / 10,178 | B30 satisfied by both roles; F1 open |

Totals R1 to R4 (five verifies, ten judge calls each):

| Build | Wall | Judge calls (attempts) | Reads / chars | Input tok (cached) / output |
| --- | --- | --- | --- | --- |
| baseline | 460 s | 10 (11) | 31 / 103,865 | 1,214,626 (998,144) / 30,504 |
| candidate | 492 s | 10 (11) | 46 / 132,838 | 1,396,328 (1,311,885) / 36,448 |

Carried assessments in R2 to R4: 0 of 2 to 3 per role in every candidate round.
Each focused round was planned by the harness (`reviewScope.mode = "focused"`, reason naming the anchor attempt and the changed paths) and each role declared its scope with a traced reason.
The Code role widened in R3 and R3b ("the changed formatter is shared by every public command result") and stayed focused in R2 and R4; Fidelity stayed focused in all four with the caller trace in its reason.
No role chose to carry a ground: on this fixture every requirement reaches the changed file through one call path, so the judges re-reviewed everything they were allowed to carry.

Detection, R1 to R4:

- R3 planted defect: both builds, both roles found it and named B25..B30 (baseline F3/F4, candidate F2/F3).
- R3b: both builds resolved it explicitly in both roles.
- R4 contradicting log: neither build reacted; both roles on both builds marked B30 satisfied from the source and did not cite the registered runtime log.
  This round did not discriminate between the builds; it is a shared miss recorded here, not a difference the change introduced.
- B31 noise: judges on both builds flagged the fixture's `save` for not extracting `message` from a thrown plain object (B31/D-02) in most rounds.
  The PRD wording covers it, so the finding is defensible and identical across builds; it is why the baseline never reached PASS and exhausted its five-attempt budget before R5.

Cost, R1 to R4: no reduction on this fixture.
The candidate spent more wall time and more input tokens per round because the focused prompt adds the anchor grounds document and the scope rules, and the judges then re-reviewed the same surface.
The R3 candidate Fidelity lane also crossed to the Claude fallback after two shell-composition rejections, which is provider noise, not scope.

## Rounds R5 and R6: same-input lane repair

R5: verify with the Code lane's judge killed by the driver (Codex `SIGKILL` about 6.5 s in, then the Claude fallback `SIGKILL` about 1.3 s later), so the Code lane ends in `judge-auth-or-runtime` while Fidelity settles.
R6: verify again with no change to source, evidence, contract or policy.
The baseline needed `verify --grant-budget` before R5 because its five failed attempts had exhausted the budget; the grant text records that it came from the driver, not a person.

| Round | Build | Verdict | Wall | Mode | Fidelity | Code | Judge calls | Reads / chars | Input tok (cached) / output |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| R5 Code lane killed | baseline | ERROR | 94 s | whole | FAIL 91 s | ERROR 6 s | 2 | 3 / 8,662 | 126,197 (106,496) / 4,342 |
| | candidate | ERROR | 80 s | focused | FAIL 77 s | ERROR 6 s | 2 | 4 / 12,325 | 158,512 (129,792) / 3,491 |
| R6 same input | baseline | FAIL | 119 s | whole | FAIL 117 s (rerun) | FAIL 68 s (rerun) | 2 | 8 / 24,573 | 329,455 (293,376) / 8,722 |
| | candidate | FAIL | 90 s | repair | carried from R5, byte-equal | FAIL 88 s | 1 | 5 / 10,730 | 189,696 (161,280) / 3,728 |

R6 candidate facts checked in `state.json`: the R6 attempt names R5 as `referenceAttemptId` with `carriedLanes: ["fidelity"]`; the R6 Fidelity lane record equals the R5 record byte for byte apart from `carriedFrom`; both attempts share one `inputFingerprint`; the sealed suite ran again in R6 (620 ms); the open finding kept its id (F1) and the finding ledger did not grow; the Code lane's fresh review was built from the pinned ledger snapshot, so it could not see the Fidelity verdict from R5 (the prompt itself is not persisted; the stub-backend e2e test checks that isolation, the live run checks the records).

R6 saving on this fixture, candidate versus baseline: one judge call instead of two, 29 s less wall (90 s versus 119 s), 3 fewer reads and 13,843 fewer read chars, 139,759 fewer input tokens and 4,994 fewer output tokens.
On the incident that motivated the issue (guarded-agent-prompt run: Fidelity FAIL after 451 s and Code error after 763 s, then a whole re-review of 513 s) the same policy would have rerun only the Code lane.

## Reading the two halves together

- The repair half is the measured win: a lost lane no longer costs the settled lane's review again, and every reuse is pinned to the same input and the same policy.
- The focused half is a correctness-preserving no-op on this fixture: the harness planned it, the roles reasoned about reach, and they chose to re-review everything.
  That is the intended fail-safe when a change reaches every requirement; it means the cost side of the focused round is unproven here and needs a fixture where most requirements do not reach the changed file.
- Nothing in either half reduced detection: the planted R3 defect was found in both builds by both roles, and the one miss (R4) is shared.

## Limits

- One small fixture, one run per build, real judges: the numbers are this run's, not a distribution.
  Wall times of the two builds overlap in provider latency because they ran concurrently.
- The driver sent `pkill -f "codex exec"` once earlier in the evening while restarting the aborted first attempt; only the driver's own four judge processes existed at that moment, and one orphaned Codex process from the aborted attempt was confirmed by its working directory before being killed.
- The R5 kill targeted the Code lane by matching its prompt in the process arguments; the Claude fallback was matched as the next new child of the verify process after that kill.
  The lane that errored is confirmed from `state.json` in both builds.
- The candidate CLI was rebuilt at 22:34 KST (help text), one minute before the run start; `cli/dist/implement/review-scope.js` from that build matches the committed source.
- The aborted first attempt (fixture `save` could throw while formatting a non-Error) is kept under `evidence/aborted/` and is not counted.
