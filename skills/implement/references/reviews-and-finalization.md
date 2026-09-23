# Native agent reviews and disposition

Read this reference before review or delivery preparation.

## Contents

- [Purpose](#purpose)
- [Run reviewers](#run-reviewers)
- [Reviewer scopes](#reviewer-scopes)
- [Review continuity](#review-continuity)
- [Review availability](#review-availability)
- [Reviewer output](#reviewer-output)
- [Parent judgment](#parent-judgment)
- [PR sections](#pr-sections)

## Purpose

Agent review is a visible second opinion.
It helps find bugs and useful improvements, but it is not a hidden completion gate.
The deterministic report, GitHub CI, and human review carry the enforceable facts and decisions.

## Run reviewers

After `sasu implement verify` reports PASS, run Fidelity and Code concurrently using the current runtime's native subagent facility: the Agent tool in Claude Code, `spawn_agent` in Codex.
A Herdr pane is not a subagent; do not run reviewers with `herdr pane split` or `herdr agent start` even when the Implementor itself lives in a Herdr pane.
Add Security for a `high-risk` PRD.
Give every reviewer the approved PRD, current base/head, current source, deterministic verification report, and registered evidence.
Do not invoke a Sasu judge command or background model process.

## Reviewer scopes

Fidelity checks every approved behavior against the observable implementation outcome and actual evidence.
Code checks implementation quality, integration, concurrency, data flow, and error paths.
Security checks authentication, authorization, secrets, destructive data, and abuse boundaries when the PRD is `high-risk`.

Sasu sets no reviewer turn limit.
Use the runtime's visible progress and transcript to supervise the work.
Ask one review set per current head.
Do not automatically repeat an unchanged review until it returns PASS.

## Review continuity

The first review checks the complete approved contract.
After a fix, fresh review means a judgment of the new verified input, not discarding the previous review context.
Give each reviewer the previous review's actual reviewed HEAD, its ordinary Markdown findings and coverage, the diff from that HEAD to the current HEAD, and the parent's dispositions with fix or regression-test evidence.
Include material evidence changes and any human-approved PRD amendments with their decision references and approval evidence.
The previous deterministic verification HEAD is not necessarily a reviewed HEAD; never substitute it for missing review history.
These are handoff materials in the existing run directory, not a new CLI flag, findings ledger, or state schema.

Start the re-review with unresolved findings, each proposed fix's closure condition, and the affected callers, dependencies, and error paths.
Keep responsibility for the complete reviewer scope: account for prior coverage that remains applicable, explicitly identify reused evidence, and inspect any newly affected or previously unverified behavior.
If the previous review or its identity is unavailable, or its coverage no longer applies, perform the missing full-scope review rather than assuming it passed.
New evidence of a concrete contract violation or regression remains a Fix now item, including in unchanged code that the current change depends on.
Do not reopen a resolved item without explaining the new evidence or changed assumption; nonessential expansion remains a Follow-up improvement.
Review continuity changes where reviewers begin, not the required suites, source freshness, independent Security review, or human approval boundaries.

## Review availability

If a reviewer fails, record:

```text
REVIEW_UNAVAILABLE
reviewer: Fidelity|Code|Security
cause: visible runtime error or interruption
```

This is not a product failure and does not change deterministic PASS.
Keep it visible for the human reviewer.

## Reviewer output

Each reviewer returns ordinary Markdown with three sections.

### Fix now

Concrete bugs in the approved behavior, touched flow, necessary error path, or regression coverage.
Each item names severity, affected behavior, code or evidence location, concrete failure evidence or a traceable failure path, and the proposed fix.
State a closure condition: the observable outcome or check that would resolve this finding within the approved contract.
Separate an observed failure from an inferred risk; missing evidence is not proof that the product failed.

### Follow-up improvements

Useful cleanup, refactoring, polish, performance work, or product expansion not needed for the current contract.
These items do not block the current PR.

### What was checked

Files, callers, flows, tests, and evidence actually inspected, plus unavailable material.

## Parent judgment

The parent agent evaluates reviewer findings rather than applying them blindly.
Fix a valid Fix now item when it stays within the approved contract and touched behavior.
Record the disposition of every Fix now item in the PR summary.

A suggestion becomes a Follow-up improvement when it is nonessential for the current contract.
A finding needs human input when the proposed fix changes product behavior, authorization, data policy, destructive effects, public scope, or another approved decision.

After any source or material evidence change, rerun deterministic verification and request fresh reviews for the new head.
Carry the review context above into that request, including rejected findings and their reasons rather than only the fixes.
Once valid current-scope findings are resolved and the current verification and review disposition are complete, proceed to the authorized delivery instead of requesting another unchanged review for reassurance.
Unresolved concerns and unavailable reviews remain visible under the existing delivery and human review rules; they are never relabeled as PASS.
There is no accumulated finding ledger, correction budget, finalize step, or receipt.

## PR sections

The pull request contains:

- deterministic verification result and current input identity;
- review availability;
- Fix now findings and dispositions;
- Follow-up improvements;
- unresolved concerns for human judgment;
- reviewer-visible screenshots or evidence where applicable.
