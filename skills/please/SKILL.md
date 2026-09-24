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
Record the user's verbatim invocation once with `sasu gate delegate --slug <topic-slug> --evidence "<the user's words>"` before gap-audit or spec.
Record reversible choices within the intent as vetoable agent-owned assumptions, including important or user-visible behavior, UX, layout, and taste.
Importance (P0/P1/P2) is not decision authority; never downgrade impact merely to call a choice an assumption.
Stop only when work needs new authority for credentials, money/cost, production data, destructive or irreversible effects, security/privacy/auth policy, public contract/migration, or a truly unresolvable core-intent contradiction.

When a qa-log is needed, run its existing gap-audit and spec gates.
Keep `qa-log.md` as the one canonical interview artifact.
During this stage, do not treat silence or a topic change as approval.
Run `interview sync` once more immediately before the final normalization and gap-audit.
Fix agent-resolvable PRD defects and rerun the affected gate.
Gap-audit is the single user-facing decision boundary.
Present only gap-audit's `NEEDS_HUMAN` bundle to the user.
Spec returns agent-fixable defects as `BLOCK`; fix the PRD using established intent and evidence.
When spec reports `nextGate: gap-audit`, run gap-audit on the same qa-log, resolve its authority bundle there, then repair and resume spec.
The CLI permits one targeted gap-audit delta for each new spec referral even if gap-audit was sealed; never fabricate a user reopen or answer.
Spec never asks the user directly or seals a decision via `gate answer --gate spec`.
Never run `sasu gate override` yourself.

Start implementation only from a complete ready PRD.
In Herdr, the user-facing session remains the Observer and dispatches one marked Implementor after the PRD is ready.
Outside Herdr, the current session may execute the same steps directly.
Never recursively dispatch an Implementor.

During implementation, preserve every requirement, run actual product observation, and register material evidence.
Review committed heads with native subagents before the full verification, then run `sasu implement verify` for deterministic checks on the final committed candidate.
Follow the CLI's `Next action:` response after verification.
On PASS it states whether the last reviewed head already matches the report or one follow-up review is needed; on FAIL it names the failed commands to reproduce before the next full verify.
The `implement` skill remains the authority for review scope and disposition.

Use `$ship` for the configured delivery mode.
The pull request carries the current verification report, evidence, Fix now dispositions, Follow-up improvements, CI status, and human review focus.
Merge only with explicit user approval and repository-required reviews.

## Final Report

Report the implemented behavior, current verification report, actual checks and observations, review availability, fixed findings, follow-up improvements, delivery result, CI state, and any human decision still required.
