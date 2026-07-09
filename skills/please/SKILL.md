---
name: please
description: |
  All-in-one PRD pipeline runner. Use when the user invokes "$please", asks to
  take the current conversation and carry it through to a finished
  implementation in one shot, wants the promise -> fulfill -> deliver chain (legacy prd -> prd-implement -> prd-ship)
  run automatically without approval round-trips, or says things like "그냥
  끝까지 해줘", "대화한 대로 구현까지 해줘", "one shot implement this".
---

# please

Use this skill to run the full PRD pipeline from the current conversation to a finished implementation in a single invocation, with no human approval round-trips except for risky work.

This skill is an orchestrator, not a new pipeline.
It chains the existing `promise`, `fulfill`, and `deliver` skills and their harnesses exactly as written.
Where this document is silent, the chained skill's own rules apply unchanged.
Read `~/.codex/skills/prd/SKILL.md`, `~/.codex/skills/prd-implement/SKILL.md`, and (when delivery mode is `pr`) `~/.codex/skills/prd-ship/SKILL.md` before executing their stages.

Match the user's language by default.

## What This Skill Changes Versus The Manual Chain

Only three things differ from running the skills by hand:

1. The PRD source is the current conversation, not an intake handoff.
2. The human PRD-approval round-trip is replaced by recording the user's `$please` invocation as the approval deviation.
3. The stage transitions (PRD ready -> implement -> ship) happen automatically instead of waiting for the user to invoke the next skill.

Everything else stays identical: harness state files, review profiles, audits, verification evidence, receipts, delivery config, and hard stops.
Do not weaken any gate because this is the automated path.

## Inputs

The requirement source is the current conversation.
An argument after `$please` is a topic brief or emphasis, not a replacement for the conversation.

Before starting, capture verbatim the user message that invoked `$please` (including any argument).
This exact text is passed to `init --allow-unapproved-prd` later; losing it forces a stop to re-ask.

If `.hoyeon/intake/<topic-slug>/prd-handoff.md` happens to exist for the same topic, use it as an additional source per the `promise` skill's normal input rules.

## Ambiguity Policy

Follow the `promise` skill's rule: ask only contract-breaking questions.
A question is contract-breaking when a wrong guess would change scope, data shape, external-service choice, delivery mode, or destroy work.
Everything else becomes an explicit assumption recorded in the PRD's `Decision Traceability For Fidelity Review` section, so the fidelity review can audit it later.
Do not run an interview; the conversation already happened.

## Stage 1: PRD

Write the PRD by following the `promise` skill in full:

- Output to `.hoyeon/prd/<topic-slug>/prd.md` with every required section.
- `source_intake: "current conversation"` unless a real intake file exists.
- Preserve conversation decisions in Decision Traceability: accepted proposals, rejected options, and the assumptions made under the Ambiguity Policy above.
- Run the Inline Self-Check Before Ready and the Harness Readiness Gate (`plan-verification --prd`) exactly as the `promise` skill requires.
- Mark `status: ready` only when those gates pass.
- Leave `human_approval: "pending"`.
  Never write `approved`; the user did not review the document, and the deviation record in Stage 2 is the honest representation of what happened.

Emit a compact summary of the PRD in chat before implementing: scope, non-goals, PRD-level tasks, verification modes, delivery mode, and the assumptions made.
This is informational, not a blocking approval request.
Continue immediately; the user can interrupt.

## Stage 2: Implement

Run the `fulfill` skill in full, with one difference at init:

```sh
node ~/.codex/skills/prd-implement/scripts/prd_state_harness.js init \
  --prd .hoyeon/prd/<topic-slug>/prd.md \
  --allow-unapproved-prd "<verbatim $please invocation message>" \
  --session-id "${CODEX_SESSION_ID:-${CODEX_THREAD_ID:-}}"
```

Rules:

- The review profile is whatever the harness assigns.
  Do not lower it for speed; `trivial` already skips what can be skipped.
- Worktree, parallel execution, and delivery mode come from `.hoyeon/config.json` as usual.
  An explicit delivery request in the conversation overrides the config for this run (pass `--delivery`).
- If no `.hoyeon/config.json` exists, proceed with local-delivery defaults and mention `$pantry` once in the final report.
  Do not enable `pr` delivery without config or an explicit conversation agreement, because automated pushes need the user's standing consent.
- If `init` reports an existing active run for the same topic, resume it.
  Use `--force` only when the user explicitly asked for a clean restart.
- All verification, evidence, fidelity review, final review, and `finalize` requirements apply unchanged.

## Stage 3: Ship (Conditional)

After `finalize --status complete`:

- If the effective delivery mode is `pr`, run the `deliver` skill in full: preflight, body, ship, CI watch, and its failure loop.
- If delivery mode is `local`, run `cleanup-active` per the `fulfill` skill and stop after the receipt.

Do not commit or push anything in local mode unless the conversation agreed to it.

## Stops

Never stop for stage transitions or document approval.
Stop and ask only when:

- a contract-breaking ambiguity has no defensible assumption.
- any `fulfill` or `deliver` hard stop fires: DB migrations against real data, auth/security surfaces needing decisions, payments or billing, production data, credentials, destructive or irreversible actions, external spend, unmapped scope, or structure-lock deviations.
- a required verification fails in a way that needs a product decision.
- delivery would push or open a PR without config-based or conversational consent.

When blocked, follow the `fulfill` blocked/partial handoff rules; do not soften status to `Done`.

## Artifacts

Leave all `.hoyeon/prd/<slug>` and `.hoyeon/implement/<slug>` files in place.
No cleanup beyond what the chained skills already do.
`.hoyeon/implement/**` is expected to be gitignored (the doctor enforces this), so these files never enter commits or PRs.

## Final Report

One combined report covering the whole run:

- Status: `Done`, `Partially Done`, or `Blocked`.
- PRD path and the approval-deviation note (invocation recorded via `--allow-unapproved-prd`).
- The assumptions made under the Ambiguity Policy, so the user can veto any of them after the fact.
- Everything the `fulfill` Implementation Result Report Contract requires: user-visible changes, structure conformance, AC status, verification evidence by mode, review verdicts, deviations, remaining human review.
- When shipped: PR URL, branch, CI verdict per the `deliver` final report.
- When config was absent: a one-line `$pantry` suggestion.
