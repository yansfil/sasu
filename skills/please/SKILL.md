---
name: please
description: |
  All-in-one PRD pipeline runner. Use when the user invokes "$please", asks to
  take the current conversation and carry it through to a finished
  implementation in one shot, wants the gen-prd then implement then ship chain
  run automatically without approval round-trips, or says things like "그냥
  끝까지 해줘", "대화한 대로 구현까지 해줘", "one shot implement this".
---

# please

Use this skill to run the full PRD pipeline from the current conversation to a finished implementation in a single invocation, with no human approval round-trips except for risky work.

This skill is an orchestrator, not a new pipeline.
It chains the existing `gen-prd`, `implement`, and `ship` skills and their harnesses exactly as written.
Where this document is silent, the chained skill's own rules apply unchanged.
Read `~/.codex/skills/gen-prd/SKILL.md`, `~/.codex/skills/implement/SKILL.md`, and (when delivery mode is `pr`) `~/.codex/skills/ship/SKILL.md` before executing their stages.

Match the user's language by default.

## What This Skill Changes Versus The Manual Chain

Only three things differ from running the skills by hand:

1. The PRD source is the current conversation, not a required intake artifact.
2. The human PRD-approval round-trip is replaced by recording the user's `$please` invocation as the approval deviation.
3. The stage transitions (PRD ready -> implement -> ship) happen automatically instead of waiting for the user to invoke the next skill.

Everything else stays identical: harness state files, review profiles, audits, verification evidence, receipts, delivery config, and hard stops.
Do not weaken any gate because this is the automated path.

## Inputs

The requirement source is the current conversation.
An argument after `$please` is a topic brief or emphasis, not a replacement for the conversation.

Before starting, capture verbatim the user message that invoked `$please` (including any argument).
This exact text is passed to `init --allow-unapproved-prd` later; losing it forces a stop to re-ask.

If `agents/interview/<topic-slug>/qa-log.md` exists for the same topic (or the legacy `agents/intake/<topic-slug>/qa-log.md` from before the rename), use it as an additional canonical interview source per the `gen-prd` skill's normal input rules.

## Ambiguity Policy

Follow the `gen-prd` skill's rule: ask only contract-breaking questions.
A question is contract-breaking when a wrong guess would change scope, data shape, external-service choice, delivery mode, or destroy work.
Everything else becomes an explicit assumption recorded in the PRD's `Decision Traceability For Fidelity Review` section, so the fidelity review can audit it later.
Do not run an interactive interview; the conversation already happened.
Before drafting, perform a silent product-completeness sweep over the full intended user journey, relevant UX states, accessibility, responsive behavior, performance, security, operation, support, and recovery boundaries.
Apply only relevant boundaries and ask only when a missing answer is contract-breaking.
Do not silently reduce the product to an MVP because the pipeline is automated.

## Stage 1: PRD

Write the PRD by following the `gen-prd` skill in full:

- Output to `agents/prd/<topic-slug>/prd.md` with every required section.
- `source_intake: "current conversation"` unless a real intake file exists.
- Preserve conversation decisions in Decision Traceability: accepted proposals, rejected options, and the assumptions made under the Ambiguity Policy above.
- Run the semantic losslessness sweep required by `gen-prd`; do not treat silence or a topic change as approval.
- Preserve a coherent production-quality product boundary, with every deliberate omission recorded as a non-goal or deferred decision with consequence, rationale, and revisit condition.
- Assign `review_profile` semantically from the complete product and engineering effects and write a concrete `review_rationale`; use `standard` for small user-facing work and `high-risk` for sensitive or irreversible effects.
- Run the semantic losslessness sweep, Inline Self-Check Before Ready, and Harness Readiness Gate (`plan-verification --prd`) exactly as the `gen-prd` skill requires.
- Mark `status: ready` only when those gates pass.
- Leave `human_approval: "pending"`.
  Never write `approved`; the user did not review the document, and the deviation record in Stage 2 is the honest representation of what happened.

Emit a compact summary of the PRD in chat before implementing: scope, non-goals, PRD-level tasks, verification modes, delivery mode, and the assumptions made.
This is informational, not a blocking approval request.
Continue immediately; the user can interrupt.

## Stage 2: Implement

Run the `implement` skill in full, with one difference at init:

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js init \
  --prd agents/prd/<topic-slug>/prd.md \
  --allow-unapproved-prd "<verbatim $please invocation message>" \
  --session-id "${CODEX_SESSION_ID:-${CODEX_THREAD_ID:-${CLAUDE_SESSION_ID}}}"
```

Rules:

- The PRD, explicit CLI value, and project policy each declare a review safety floor; the harness uses the strongest one.
  The harness does not infer risk from natural-language keywords and safely defaults a missing declaration to `standard`.
  Runtime flags can raise the floor but cannot silently lower stronger PRD or project policy; `trivial` is only for bounded work with no changed user-visible or runtime behavior.
- Worktree, parallel execution, and delivery mode come from `agents/config.json` as usual.
  An explicit delivery request in the conversation overrides the config for this run (pass `--delivery`).
- If no `agents/config.json` exists, proceed with local-delivery defaults and mention `$ho-setup` once in the final report.
  Do not enable `pr` delivery without config or an explicit conversation agreement, because automated pushes need the user's standing consent.
- If `init` reports an existing active run for the same topic, resume it.
  Use `--force` only when the user explicitly asked for a clean restart.
- All verification, evidence, fidelity review, final review, and `finalize` requirements apply unchanged.

## Stage 3: Ship (Conditional)

After `finalize --status complete`:

- If the effective delivery mode is `pr`, run the `ship` skill in full: preflight, body, ship, CI watch, and its failure loop.
- If delivery mode is `local`, run `cleanup-active` per the `implement` skill and stop after the receipt.

Do not commit or push anything in local mode unless the conversation agreed to it.

## Stops

Never stop for stage transitions or document approval.
Stop and ask only when:

- a contract-breaking ambiguity has no defensible assumption.
- any `implement` or `ship` hard stop fires: DB migrations against real data, auth/security surfaces needing decisions, payments or billing, production data, credentials, destructive or irreversible actions, external spend, unmapped scope, or structure-lock deviations.
- a required verification fails in a way that needs a product decision.
- delivery would push or open a PR without config-based or conversational consent.
- a checkshirt gate stop condition fires (below).

## Checkshirt Gates In The Autonomous Loop

A checkshirt gate BLOCK is not a stop: it means "cannot pass until PASS".
When a gate (gap-audit, spec, or verify) blocks during a `$please` run:

1. Fix every agent-fixable finding (amend the qa-log or PRD, fix the code), then re-run the same gate.
2. Repeat within the gate's retry budget (default 3 autonomous fix attempts).
3. Stop and hand the findings to the user only when a finding is marked `needs human decision`, or the gate output says the retry budget is exhausted.

Never run `checkshirt gate override` yourself: the override is user-only, and the `$please` invocation authorizes skipping approval round-trips, not overriding failed quality gates.
A gate PASS is pinned to the input document's content hash: if you edit the qa-log or PRD after its gate passed, `checkshirt gate status` reports the gate `STALE`, and you must re-run that gate on the current document before treating it as passed.
Record each gate outcome in the final report.

When blocked, follow the `implement` blocked/partial handoff rules; do not soften status to `Done`.

## Artifacts

Leave all `agents/prd/<slug>` and `agents/implement/<slug>` files in place.
No cleanup beyond what the chained skills already do.
`agents/implement/**` is expected to be gitignored (the doctor enforces this), so these files never enter commits or PRs.

## Final Report

One combined report covering the whole run:

- Status: `Done`, `Partially Done`, or `Blocked`.
- PRD path and the approval-deviation note (invocation recorded via `--allow-unapproved-prd`).
- The assumptions made under the Ambiguity Policy, so the user can veto any of them after the fact.
- Everything the `implement` Implementation Result Report Contract requires: user-visible changes, structure conformance, AC status, verification evidence by mode, review verdicts, deviations, remaining human review.
- When shipped: PR URL, branch, CI verdict per the `ship` final report.
- When config was absent: a one-line `$ho-setup` suggestion.
