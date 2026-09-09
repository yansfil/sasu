# Reviews And Finalization

## Contents

- [Full-Contract Review](#full-contract-review)
- [High-Risk Review](#high-risk-review)
- [Reverification And Convergence](#reverification-and-convergence)
- [Finalize](#finalize)
- [Human Confirmation](#human-confirmation)
- [Blocked Handoff](#blocked-handoff)

## Full-Contract Review

All profiles use concurrent independent Fidelity and Code reviews in the routine path.
Both read every requirement and decision, inspect actual implementation and related source, and assess executed required-suite results, shared QA observations, and previous findings.
Both receive the same fixed original inputs without the current peer verdict.
They read the complete contract from the generated review documents and independently discover related files inside the fixed product source copy.
Changed files are starting points, not the review scope: an unchanged caller or omitted route remains relevant when the contract requires it.
No manual artifact registration is needed for ordinary surrounding source already present in the copy.
File names alone are not content evidence; product and evidence reads stay within the copied source and registered evidence rather than the live worktree or other host data.
Native read restrictions enforce that boundary; the minimal OS/runtime substrate required by the review engine does not supply additional review evidence.
Fidelity owns complete intent and observable behavior fulfillment, including omitted requirements and explicit human authority.
Code review owns concrete implementation, integration and error-path defects and consequential design problems.
Cosmetic preferences and speculative improvements remain advisory.
Neither requires a separate execution, artifact, or model call for each requirement or assumes the other role has passed.
The two roles replace the comprehensive review; no third general judge combines their judgments.

Results contain a summary, grouped `assessments`, exception findings, and explicit prior dispositions.
Each assessment contains:

| Field | Contract |
| --- | --- |
| `requirementRefs` | Approved requirement or decision references for the semantic group. Fidelity includes every Bn exactly once across its groups; Code does not repeat an all-Bn accounting form. |
| `conclusion` | `satisfied`, `unresolved`, or `pending-human`. Unresolved coverage cannot pass; pending-human requires a corresponding validated post-completion human-confirmation finding for every cited requirement. |
| `rationale` | A short, concrete assessment of the implementation and the grounds for the conclusion. Empty rationale is invalid. |
| `evidenceRefs` | Valid references from the fixed review input. A satisfied assessment includes actual inspected source, an execution log, or an artifact, not only PRD text or file names. |

Both roles record meaningful assessment grounds.
Each requirement or decision reference appears at most once across a role's assessments; findings may cite those references independently.
One shared complete source file, test result, or observation may support many requirements in one assessment.
For example, deterministic `command(n)` source implementing 1 through 30 can support B1 through B30 together; it does not require 30 separate test executions.
That example does not waive runtime evidence when the actual behavior or risk requires it.
The CLI rejects missing or duplicate Fidelity coverage, unknown references, empty grounds, invalid evidence, and inconsistent unresolved coverage.
A defect names concrete unmet contract content or insufficient evidence with actual source or observation references and a next action.
An optional improvement beyond the satisfied contract is advisory and does not block completion.
A genuine human-confirmation finding cites existing decision/risk/user-instruction provenance.
Use only the supplied `humanSources` keys and an exact quote within that source's existing quote boundary.
Admission approval is authority metadata; pending frontmatter and agent assumptions alone do not create confirmation gates.
`pending-human` preserves permitted after-the-fact judgment without asserting satisfaction or moving genuine prerequisites past completion.
The CLI checks each result's shape and references and derives the outcome from the shared open issues; a PASS string cannot override a defect.
Each actual review, including its assessments, timing, provider calls and trace, remains separate in `verificationAttempts[].reviews.fidelity` and `verificationAttempts[].reviews.code`.
A missing or failed role keeps the attempt incomplete while preserving the peer's actual result.

The complete review input, structural requirement accounting, and valid inspectable grounds are mechanical guarantees; satisfaction of the contract is independent semantic judgment.
Do not claim that coverage records prove the conclusions correct or establish zero omissions.
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
The CLI preserves each settled role result in the existing `verificationAttempts` history with its attempt, source, PRD, and input identity.
Later corrections append a new attempt; CLI mutations cannot rewrite or delete a settled historical judgment.
`state.json` remains the only physical state record, with no separate review ledger file or second writer.
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

`sasu implement finalize` validates current state and input/evidence identity, required-suite results, both complete routine reviews and their assessment coverage, open defects, risks, and human authority.
It performs no tests, judge calls, captures, or external commands.
The `sasu.implement.state.v10` state is persisted before the `sasu.implement.receipt.v6` receipt and implementation Markdown are derived from it.
The receipt retains both independent role results and their assessment grounds; the implementation Markdown summarizes the results, actual execution, observations, unresolved issues, approval history, and delivery conditions without requiring a separate requirement PASS table.
Retired unified v9/v5 runs require their last supporting commit `3f549dcfff71fe1f7fa974a383f6e8a055ce8463`; experimental parallel v9/v5 runs require `2b1f638dd587261be7e7b0e600db16657421971d`.
The production reader rejects those shapes explicitly without migration or historical-result normalization.
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
