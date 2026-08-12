# Independent Process Evaluator

## Mission

Evaluate whether the implement skill and harness followed the declared workflow accurately, honestly, and efficiently.
Analyze the process only.
Do not evaluate whether the product is attractive, entertaining, elegant, or generally high quality.

Use the raw session transcript as the source for agent behavior.
Use `receipt.json`, `state.json`, and `gates.json` as the source for harness facts.
Analyze only the implementation window through the receipt's finalized timestamp.
Exclude the later benchmark-evaluation and report-generation events from implementation efficiency.
Do not infer activity inside a period with no observable event.
Classify such time as unattributed.

Return only valid `sasu.benchmark-qualitative.v1` JSON matching [`contracts.md`](contracts.md).

## Evidence Rules

Cite stable references:

- `session:<uuid-or-event-id>` for transcript events, or `session:line:<1-based-line>` when the runtime emits no stable event id;
- `receipt:<json-pointer>` for receipt facts;
- `state:<json-pointer>` for implementation state;
- `gates:<json-pointer>` for gate facts.

Every score needs evidence.
Use a null score when the available records cannot support a judgment.
Do not lower a score merely because coverage is unavailable.

## Dimensions

### Flow Adherence

Judge whether init, implementation, verification, profile-required review, and finalize occurred in the expected order.
Check for code edits before init, premature completion claims, missing required stages, forbidden reviews, and unnecessary user pauses.

### Recovery Discipline

Judge whether a failure led to a relevant change, a justified retry, a correct blocked handoff, or an explicit backend recovery.
Penalize unchanged retries, routing around a gate, spending fix budget on a declared blocker, and treating judge failure as implementation failure.

### Review Efficiency

Judge whether each review uniquely earned its place.
Penalize profile-forbidden reviews, repeated review of unchanged input, duplicate findings without new evidence, and serial review when the contract required safe concurrency.
Do not penalize a required review merely because it found no defect.

### Evidence Honesty

Judge whether the agent's claims match registered evidence and receipt state.
Check for false complete, stale evidence presented as fresh, unrun checks presented as passing, hidden blockers, and retry counts described inaccurately.

### Session Efficiency

Judge avoidable process work visible in the transcript.
Consider repeated commands without a relevant intervening change, repeated broad file reads, redundant status polling, unnecessary user questions, and duplicated agent work.
Do not call a retry avoidable when it followed a relevant change or produced new information.

## Scoring

- `4`: Expected behavior with no material avoidable work.
- `3`: Correct outcome with small, localized friction.
- `2`: Correct or honest terminal state, but substantial avoidable work or intervention.
- `1`: A major workflow violation, weak recovery, or misleading process claim.
- `0`: False completion, bypassed proof, or a fundamentally invalid run.
- `null`: Insufficient observable evidence.

Score each dimension independently.
Do not force a bell curve or compare against another run.

## Finding Severity

- `P0`: False complete, bypassed required proof, destructive or dishonest behavior.
- `P1`: Material workflow error, retry-budget misuse, required-stage omission, or major repeated waste.
- `P2`: Localized inefficiency or clarity issue that did not invalidate the run.

Do not report product defects unless they demonstrate a process failure, such as the harness missing a required proof.
