# Reviews And Finalization

## Contents

- [Review Profiles](#review-profiles)
- [Design Lane](#design-lane)
- [Risk Lane](#risk-lane)
- [Fidelity Rubric](#fidelity-rubric)
- [Unified Verdict](#unified-verdict)
- [Finalize](#finalize)
- [Confirm](#confirm)
- [Blocked Handoff](#blocked-handoff)

Read this reference before unified verify, finalize, or a blocked handoff.

## Review Profiles

| Profile | Unified lanes |
| --- | --- |
| `trivial` | acceptance and fidelity in parallel |
| `standard` | acceptance, fidelity, and design in parallel |
| `high-risk` | acceptance and fidelity vote; design reviews in parallel; risk reviews after them into a ledger |

Acceptance, fidelity, and design use the project `routine` judge profile.
The risk lane uses `high-risk`; the defaults are Codex Luna/Sol xhigh with Claude Sonnet 5/Opus 5 xhigh fallbacks respectively.

## Design Lane

The design lane reviews the shape of the code - one-cause-N-symptom patching, patch-on-patch accretion, structure drift against the PRD's Technical structure, needless complexity, dead weight - the one failure class the other lanes explicitly do not read for.
It reads this run's own diff against the pre-run commit, so it judges what the run did, not what the repository already looked like.

It has no verdict: it never fails the run, never consumes fix budget, and a lane error leaves the attempt untouched.
It produces comments, `finalize --status complete` refuses while any is unanswered, and a comment is answered in exactly one of two ways:

- **Fix it**, then re-run `sasu implement verify`; the lane stops reporting it and the comment resolves itself. No flag claims a fix, because a claim is not a measurement.
- **Accept it**: `sasu implement design --id <D#> --accept "<why it is being left alone>"`, recorded beside the comment in `state.json` and `implementation-result.md`.

Identity is the file path - one comment per file - so re-wording or re-labelling one defect keeps one comment with one id, which is what bounds the loop (PRINCIPLES 13).
The `verify` response carries `design.open` in full plus the count in `message`; relay open comments to the user rather than accepting them all to clear the gate.

This lane owns quality review; do not spawn ad-hoc adversarial review subagents on top of it.
A prior run burned 92 minutes on five self-invoked review rounds against a verify gate that never returned a criterion FAIL.

## Risk Lane

The high-risk reviewer runs after acceptance and fidelity because their results are part of its input.
Its lane-local PASS, FAIL, or ERROR is recorded on the attempt but does not vote on the unified verdict.
A successful result updates the single risk ledger in `state.json`: unresolved prior findings stay open, delta-proven resolved findings become `fixed`, and findings marked `new` receive the next stable `RF<n>` id.
A risk ERROR changes no ledger entry.

An open blocking finding prevents `finalize --status complete`; an open advisory finding stays visible without blocking completion.

- **Fix it**, then re-run `sasu implement verify`; the next risk review must disposition it as resolved and ground a prior blocking resolution in an exact changed path or new evidence item.
- **Accept it** with the user's approval verbatim: `sasu implement risk --accept --id <RF#> --evidence "<verbatim user approval>"`.

Both blocking and advisory findings may be accepted.
The acceptance evidence and every judge-proven resolution remain beside the finding in `state.json` and `implementation-result.md`.

## Fidelity Rubric

The fidelity judge always answers the same five questions:

1. Was the original goal preserved?
2. Were accepted decisions and constraints preserved?
3. Were rejected options and non-goals kept out?
4. Did deviations avoid distorting intent?
5. Are completion and status claims honest?

The context changes with the PRD source.
Conversation-only PRDs use the Decisions table as canonical intent.
Qa-log PRDs use the full qa-log unless a fresh spec gate already proved the qa-log to PRD leg; the Decisions table is always in the prompt as the PRD's own record.

Fidelity does not rejudge per-row artifact sufficiency or code correctness.
The acceptance judge owns those questions.

## Unified Verdict

Run `sasu implement verify`.

The unified verdict is PASS only when acceptance and fidelity are PASS.
Design has no verdict, and the risk lane's local verdict updates the ledger instead of voting.
NOT_RUN, FAIL, BLOCKED, ERROR, and STALE are not completion states.

A source or evidence change after PASS makes the result stale.
Run verify again explicitly after the implementation and final evidence are coherent.
Each explicit run returns the current fix budget and consecutive voting-lane judge-error gauges.
When `budgetExhausted` or `judgeErrorLoop` is true, the CLI refuses further verification work.
From that terminal state there are exactly two exits, both recorded in the same `state.json`:

- `sasu implement finalize --status blocked` closes the run honestly with the open findings in the receipt.
- `sasu implement verify --grant-budget "<the user's words verbatim>"` records the user's explicit go-ahead and opens one fresh fix budget.

Do not archive, rename, or replace `state.json` to start over; a fresh run discards every settled verdict and re-judges every criterion from zero.

## Finalize

Run `sasu implement finalize`.

Finalize validates only current state, source hashes, artifact hashes, the fresh unified PASS, every `check:` row green and every `judge:` row PASS, no parked row, design dispositions, and the absence of open blocking risk findings.
It performs no tests, judge calls, capture calls, browser work, or subprocess execution.

An OPEN `human:` row does not block it: the run closes `complete-pending-human`, and the receipt's score counts machine and judge rows apart from human rows.
Successful finalize writes `agents/runs/<topic-slug>/receipt.json` and `agents/runs/<topic-slug>/implementation-result.md`, both carrying the Behaviors table with one result per row.
Both outputs derive from `state.json`; they are not independent completion ledgers.

Running finalize again with the same completion fingerprint returns the existing result.

## Confirm

`sasu implement confirm --issuer human --row B<n> --evidence "<the user's words>"` closes one OPEN `human:` row and rewrites the receipt in place; when the last OPEN row closes the receipt becomes `complete`.
`--reject` records what the user found wrong and leaves the row OPEN, with the words shown beside it in the receipt; the fix is a new run.
Only the human issuer is accepted, and a closed run never reopens.

## Blocked Handoff

When proof cannot pass, report the failed stage, exact observable error, recovery path, open items, and stale inputs.
Do not generate a complete receipt and do not soften the status into Done.
