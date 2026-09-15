---
name: quick
description: |
  Fast path for a small implementation from the current conversation.
  Use when the user invokes "$quick" or asks for a bounded change without the
  full PRD pipeline. Do not use when an approved PRD already exists.
---

# quick

Implement a small, bounded conversation contract and return a reviewable result.
Match the user's language.

## Contract

Before editing, state the goal, observable behaviors, non-goals, risky boundaries, and required checks in a compact message or local note.
Preserve every requested behavior.
Treat reversible implementation details as agent-owned assumptions, not user approval.
Ask only when the change needs new authority for credentials, money, production data, destructive effects, or security policy.

## Implement And Check

Inspect the current source and project instructions.
Implement the smallest complete change.
Fix low-risk bugs directly related to the touched behavior or necessary error paths.
Run the repository checks that exercise the actual caller-visible result.
For UI or native work, observe the running product and collect real visual evidence.

## Native Review

Use the runtime's native subagent facility for a visible Code review after checks pass.
Add Fidelity when the contract has several behaviors or interpretation risk.
Add Security for authentication, authorization, secrets, destructive data, or other high-risk boundaries.
Do not launch review through a Sasu CLI model process.

Ask reviewers to return:

```markdown
## Fix now

- Concrete current-scope defects with source or evidence locations.

## Follow-up improvements

- Useful work outside the current contract.

## What was checked

- Files, tests, flows, evidence, and unavailable checks.
```

Fix valid current-scope findings, rerun affected checks, and review the new head when source changes.
Reviewer unavailability stays visible and does not turn passing deterministic checks into a failure.

## Finish

Commit coherent work according to the repository instructions.
Report the change, actual checks, review availability, Fix now dispositions, Follow-up improvements, and remaining human review.
Use the repository's normal pull request workflow when delivery was requested.
