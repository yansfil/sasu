# Reviews And Finalization

Read this reference before unified verify, finalize, or a blocked handoff.

## Review Profiles

| Profile | Unified lanes |
| --- | --- |
| `trivial` | acceptance and fidelity in parallel |
| `standard` | acceptance, fidelity, and design in parallel |
| `high-risk` | acceptance, fidelity, and design in parallel, then risk |

The CLI executes these policies; there is no manual prompt generation or review-record step.
Acceptance, fidelity, and design use the project `routine` judge profile.
The additional risk lane uses the `high-risk` judge profile.
By default those profiles are Codex Luna xhigh and Codex Sol xhigh, with Claude Sonnet 5 xhigh and Claude Opus 5 xhigh fallbacks respectively.

## Design Lane

The design lane reviews the shape of the code - one-cause-N-symptom patching, patch-on-patch accretion, structure drift against PRD §5, needless complexity, dead weight - the one failure class the other lanes explicitly do not read for.
It reads this run's own diff against the pre-run commit, so it judges what the run did, not what the repository already looked like.

It has no verdict: it never fails the run, never consumes fix budget, and a lane error leaves the attempt untouched.
It produces comments, `finalize --status complete` refuses while any is unanswered, and a comment is answered in exactly one of two ways:

- **Fix it**, then re-run `sasu implement verify`; the lane stops reporting it and the comment resolves itself. No flag claims a fix, because a claim is not a measurement.
- **Accept it**: `sasu implement design --id <D#> --accept "<why it is being left alone>"`, recorded beside the comment in `state.json` and `implementation-result.md`.

Identity is the file path - one comment per file - so re-wording or re-labelling one defect keeps one comment with one id, which is what bounds the loop (PRINCIPLES 13).
The `verify` response carries `design.open` in full plus the count in `message`; relay open comments to the user rather than accepting them all to clear the gate.

This lane owns quality review; do not spawn ad-hoc adversarial review subagents on top of it.
A prior run burned 92 minutes on five self-invoked review rounds against a verify gate that never returned a criterion FAIL.

## Fidelity Rubric

The fidelity judge always answers the same five questions:

1. Was the original goal preserved?
2. Were accepted decisions and constraints preserved?
3. Were rejected options and non-goals kept out?
4. Did deviations avoid distorting intent?
5. Are completion and status claims honest?

The context changes with the PRD source.
Conversation-only PRDs use Decision Traceability as canonical intent.
Qa-log PRDs use the full qa-log unless a fresh spec gate already proved the qa-log to PRD leg.

Fidelity does not rejudge per-verification artifact sufficiency or code correctness.
The acceptance judge owns those questions.

## Unified Verdict

Run:

```sh
sasu implement verify
```

The unified verdict is PASS only when every required lane is PASS.
NOT_RUN, FAIL, BLOCKED, ERROR, and STALE are not completion states.

A source or evidence change after PASS makes the result stale.
Run verify again explicitly after the implementation and final evidence are coherent.
Each explicit run returns the current fix budget and consecutive judge-error gauges.
When `budgetExhausted` or `judgeErrorLoop` is true, the CLI refuses further verification work.
From that terminal state there are exactly two exits, both recorded in the same `state.json`:

- `sasu implement finalize --status blocked` closes the run honestly with the open findings in the receipt.
- `sasu implement verify --grant-budget "<the user's words verbatim>"` records the user's explicit go-ahead and opens one fresh fix budget.

Do not archive, rename, or replace `state.json` to start over; a fresh run discards every settled verdict and re-judges every criterion from zero.

## Finalize

Run:

```sh
sasu implement finalize
```

Finalize validates only current state, source hashes, artifact hashes, and the fresh unified PASS.
It performs no tests, judge calls, capture calls, browser work, or subprocess execution.

Successful finalize writes:

```text
agents/runs/<topic-slug>/receipt.json
agents/runs/<topic-slug>/implementation-result.md
```

Both outputs derive from `state.json`.
They are not independent completion ledgers.

Running finalize again with the same completion fingerprint returns the existing result.

## Blocked Handoff

When proof cannot pass, report the failed stage, exact observable error, recovery path, open items, and stale inputs.
Do not generate a complete receipt and do not soften the status into Done.
