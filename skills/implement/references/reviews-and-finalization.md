# Reviews And Finalization

## Full-Contract Review

All profiles use concurrent independent Fidelity and Code reviews in this experimental routine path.
Both read every requirement and decision, actual implementation and permitted surrounding source, executed required-suite results, shared QA observations, and previous findings.
The source catalog supplies path metadata only; it is neither content evidence nor permission to read a file outside the allowlist.
One shared artifact containing current surrounding source can support many Bn references without a per-Bn mapping.
Fidelity owns complete intent and observable behavior fulfillment, including omitted requirements and explicit human authority.
Code review owns concrete implementation, integration and error-path defects and consequential design problems.
Cosmetic preferences and speculative improvements remain advisory.
Neither emits a success object for each requirement or assumes the other role has passed.
The two roles replace the comprehensive review; no third general judge combines their judgments.

Results contain a summary, exception findings, and explicit prior dispositions.
A defect names concrete unmet contract content or insufficient evidence with actual source or observation references and a next action.
An optional improvement beyond the satisfied contract is advisory and does not block completion.
A genuine human-confirmation finding cites existing decision/risk/user-instruction provenance.
The CLI checks each result's shape and references and derives the outcome from the shared open issues; a PASS string cannot override a defect.
Each actual review, including its timing, provider calls and trace, remains separate in `reviews.fidelity` and `reviews.code`.
A missing or failed role keeps the attempt incomplete while preserving the peer's actual result.

The complete review input is a mechanical guarantee; satisfaction of the contract is independent semantic judgment.
Do not claim that full-input inclusion proves zero omissions.
Actual planted-omission evaluation tests that judgment separately from JSON and fixture tests.

## High-Risk Review

`trivial` and `standard` use the same concurrent Fidelity and Code reviews and the same routine model profile.
`high-risk` adds a distinct safety check for data loss, permissions, destructive effects, and delivery risk using the same fixed inputs.
Independent checks may run concurrently.
The routine configured default is `gpt-5.6-luna` xhigh with `claude-sonnet-5` xhigh fallback.
The high-risk configured default is `gpt-5.6-sol` xhigh with `claude-opus-5` xhigh fallback.
These are code defaults, not a request to change a project's configured models.

Open blocking risks remain incomplete and consume the existing correction budget even when routine review succeeds.
A risk approval preserves the person's verbatim evidence and cannot exempt missing product requirements.
Use `sasu implement risk --accept --id <RF#> --evidence '<verbatim user approval>'` only within existing authority.
The human-only `risk --non-convergent` declaration allows honest blocked closure with the risk still open.

## Reverification And Convergence

Source, sealed PRD, linked intent, and registered evidence changes invalidate the current review.
A new verify executes the sealed suites and reviews the current inputs.
Old requirement results are never assembled into a new PASS.
Both roles receive the same prior open issues.
A prior issue closes only when both explicitly resolve it with evidence; a missing result, error or disputed disposition keeps it open.
Distinct defects remain distinct even when they cite the same Bn reference.
A new real omission in an unchanged file must be considered when grounded in concrete contract text and counterevidence.
Optional unrelated advice does not force another round.

The CLI owns the correction bound and separates implementation rounds from backend errors and pre-review input failures.
Do not create an extra unbounded adversarial loop.
A first FAIL leaves the run active for repair; it does not finalize implicitly.
Terminal conditions are an exhausted correction budget, three consecutive identical pre-judge failures on the same inputs, a bounded judge backend error loop, or recorded human risk non-convergence when those risks are the only remaining blockers.
Before closing an active run, explicit user approval can authorize continued verification through `verify --grant-budget "<the user's words>"`.
Without that continuation, use `sasu implement finalize --status blocked` once a recorded terminal condition applies.
Blocked finalization closes the run; a budget grant does not reopen a closed run.
Never replace run state to reset the budget.

## Finalize

`sasu implement finalize` validates current state and input/evidence identity, required-suite results, both complete routine reviews, open defects, risks, and human authority.
It performs no tests, judge calls, captures, or external commands.
The `v9.parallel-review` state is persisted before the `v5.parallel-review` receipt and implementation Markdown are derived from it.
Both outputs summarize actual execution and observations, both independent review results, unresolved issues, approval history, and delivery conditions without requirement PASS tables.
Repeated finalization of identical inputs is idempotent.

Permitted after-the-fact human judgment can produce `complete-pending-human`.
Payment, deletion, deployment authority, unresolved product policy, or missing access are prerequisites and cannot be moved into that status.
An explicit open human rejection always makes delivery ineligible.
A failed verify attempt permits an honest blocked receipt only when a recorded terminal condition applies, even if no judge result succeeded.
The receipt names the stopped phase and unexecuted work; the first failure stays active for repair.
For cancellation before verify, use `retire`.

## Human Confirmation

```sh
sasu implement confirm --issuer human --id <confirmation-id> --evidence "<the user's own words>"
sasu implement confirm --issuer human --id <confirmation-id> --reject --evidence '<what was wrong>'
```

Only a human issuer closes an actual confirmation item.
Response history and source freshness remain intact when the receipt is regenerated.
An explicit withdrawal and approval of the same result resolves a prior rejection without erasing its words.
A source fix after closure uses a new run; confirmation does not reopen implementation.
A later rejection records the outcome but does not automatically undo a delivery already made.

## Blocked Handoff

Report the current stage, actual error and recovery, open issues, failed or unavailable observations, and stale inputs.
Generate an honest blocked receipt when the recorded attempt supports terminal closure.
Never soften failed or unrun review into Done.
