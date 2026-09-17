# Native agent reviews and disposition

Read this reference before review or delivery preparation.

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
Each item names severity, affected behavior, code or evidence location, and the proposed fix.

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
There is no accumulated finding ledger, correction budget, finalize step, or receipt.

## PR sections

The pull request contains:

- deterministic verification result and current input identity;
- review availability;
- Fix now findings and dispositions;
- Follow-up improvements;
- unresolved concerns for human judgment;
- reviewer-visible screenshots or evidence where applicable.
