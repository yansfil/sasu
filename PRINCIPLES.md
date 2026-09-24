# Sasu principles

Sasu makes “done” inspectable without making proof heavier than the implementation.

> Verification is the senior sitting next to the implementation.
> It must be clean, intuitive, mistake-free, and efficient.

The [2026-09-15 stateless verification decision](docs/plans/2026-09-15-stateless-verification.md) replaces receipt-backed completion and in-CLI implementation judges.
The current flow recalculates deterministic facts from the approved PRD, Git state, required suites, and registered evidence.
Native runtime subagents provide visible semantic review, while GitHub CI and people make the delivery decision.

## 1. Preserve every requirement and review the complete contract

Every requirement stays in the approved PRD.
Fidelity review compares the whole contract with the current implementation and actual evidence.
Code review examines the implementation and its integration and error paths.
One source file, test, or product observation may support several requirements.
Requirement IDs locate findings; they are not progress states.

## 2. Verification must not outweigh implementation

The CLI runs reproducible checks and records their actual results.
It does not maintain semantic finding lifecycles, reviewer retries, correction budgets, or completion receipts.
Measure wall-clock time, command calls, repeated work, and review overlap when changing the flow.

## 3. Fix the one cause, not many symptoms

Repeated failures across commands usually point to a missing concept or a confused authority boundary.
Prefer one structural correction over flags and exceptions at each symptom.

## 4. Every stage earns its place

A stage must catch a failure no existing stage catches clearly.
Any new command, record, or gate names what it deletes or replaces.
PRD prelint, required suites, source freshness, evidence integrity, native review, CI, and human review each have a distinct owner.

## 5. Parallel by default

Run independent suites or review roles concurrently once their shared inputs are fixed.
Use a sequential dependency only when one result is required to construct the next input.

## 6. Observe product flows and risk boundaries

Evidence comes from the running product whenever behavior depends on UI, native runtime, external services, data, or environment.
Code existence and a successful build do not prove a user-visible result.
High-risk work adds focused security review for authentication, authorization, secrets, destructive data, and abuse boundaries.

## 7. The harness absorbs mechanical complexity

The CLI enforces input structure, execution facts, freshness, artifact integrity, state ownership, and concurrency safety.
The workflow user should not maintain duplicate checklists or proof ledgers.
Meaning and evidence sufficiency remain independent judgment.

## 8. The flow stays explainable

The current implementation flow fits in one diagram:

```text
PRD and committed Git head -> native review -> deterministic verify of the final head -> PR -> CI and people
```

A design that needs a wall of lifecycle prose should be simplified before implementation.

## 9. Measure it and re-verify

Retest recorded limits before using them in a new design.
Run the final repository-wide suite and a real end-to-end flow after meaningful harness changes.
Record the incident or measurement beside code whose shape depends on it.

## 10. Records stay honest and singular

`state.json` is the only mutable run record.
Verification attempts record what actually ran, including failures and unavailable work.
`verification-report.json` and `.md` derive from one current input identity.
A changed source, contract, suite, or evidence set makes an earlier report stale.
Reviewer failure is `REVIEW_UNAVAILABLE`, not PASS or implementation FAIL.

## 11. General rules use structure

Detection and validation must hold across repository shapes and contract sizes.
Do not key a guard on the wording or file layout of the incident that motivated it.

## 12. Compare outward before inventing

Check established repository and ecosystem patterns before adding machinery.
Import the useful idea and keep Sasu-specific code only where Sasu has a distinct contract.

## 13. Never loop on a stage that cannot converge

Tests converge on fixed input; generative review can always suggest another improvement.
Request one native review set for each head presented as current.
Fix concrete current-scope bugs, list useful later work under Follow-up improvements, and report unresolved advice with its reason.
Do not rerun unchanged input to seek a favorable verdict.
