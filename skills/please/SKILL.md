---
name: please
description: |
  All-in-one PRD pipeline runner. Use when the user invokes "$please", asks to
  carry the current conversation through a finished implementation, or wants
  interview, PRD, implementation, review, and delivery handled in one run.
---

# please

Carry the user's current request through the existing Sasu workflow without creating a second workflow.
Match the user's language.

Read `~/.codex/skills/interview-me/SKILL.md`, `~/.codex/skills/gen-prd/SKILL.md`, `~/.codex/skills/implement/SKILL.md`, and `~/.codex/skills/ship/SKILL.md` when each stage applies.
Those skills keep authority over their own stage.

## Flow

```text
current request
  -> interview only unresolved product decisions
  -> generate and approve the complete PRD
  -> implement and observe actual behavior
  -> deterministic sasu implement verify
  -> visible native Fidelity and Code subagents
  -> fix current-scope defects and rerun on the new head
  -> local delivery or pull request with CI and human review
```

Use the current conversation as approval when the user explicitly asks for this one-shot pipeline.
Record reversible implementation choices as assumptions.
Stop only when work needs new authority for credentials, payment, production data, destructive effects, security policy, or another irreversible decision.

When a qa-log is needed, run its existing gap-audit and spec gates.
Keep `qa-log.md` as the one canonical interview artifact.
During this stage, do not treat silence or a topic change as approval.
Run `interview sync` once more immediately before the final normalization and gap-audit.
Fix agent-resolvable PRD defects and rerun the affected gate.
Present a `NEEDS_HUMAN` decision bundle to the user because it represents missing product authority.
Never run `sasu gate override` yourself.

Start implementation only from a complete ready PRD.
In Herdr, the user-facing session remains the Observer and dispatches one marked Implementor after the PRD is ready.
Outside Herdr, the current session may execute the same steps directly.
Never recursively dispatch an Implementor.

During implementation, preserve every requirement, run actual product observation, and register material evidence.
Run `sasu implement verify` for deterministic checks.
After PASS, use the runtime's native subagent facility to run Fidelity and Code reviews in parallel.
Add Security for high-risk work.
Sasu does not launch, limit, retry, or score these reviewers.

Place review output under:

- `Fix now` for concrete defects in the approved behavior or touched flow;
- `Follow-up improvements` for useful work outside the current contract;
- `What was checked` for source, tests, flows, and unavailable evidence.

Fix valid current-scope findings.
If source or evidence changes, rerun deterministic verification and request review for the new head.
Do not loop on unchanged input to seek a favorable opinion.
Report reviewer failure as `REVIEW_UNAVAILABLE` without rewriting deterministic PASS.

Use `$ship` for the configured delivery mode.
The pull request carries the current verification report, evidence, Fix now dispositions, Follow-up improvements, CI status, and human review focus.
Merge only with explicit user approval and repository-required reviews.

## Final Report

Report the implemented behavior, current verification report, actual checks and observations, review availability, fixed findings, follow-up improvements, delivery result, CI state, and any human decision still required.
