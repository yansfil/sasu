# Reviews And Finalization

Read this reference before unified verify, finalize, or a blocked handoff.

## Review Profiles

| Profile | Unified lanes |
| --- | --- |
| `trivial` | acceptance and fidelity in parallel |
| `standard` | acceptance and fidelity in parallel |
| `high-risk` | acceptance and fidelity in parallel, then risk |

The CLI executes these policies.
There is no manual prompt generation or review-record step.
Acceptance and fidelity use the project `routine` judge profile.
The additional risk lane uses the `high-risk` judge profile.
By default those profiles are Codex Luna xhigh and Codex Sol xhigh, with Claude Sonnet 5 xhigh and Claude Opus 5 xhigh fallbacks respectively.

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
When `budgetExhausted` or `judgeErrorLoop` is true, the CLI refuses further verification work and the run moves to a blocked handoff.

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
