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

This skill is an Observer entrypoint around the existing pipeline, not a new pipeline.
In a direct Herdr invocation, the main session observes while one fresh Implementor pane runs the existing `gen-prd`, `implement`, and `ship` skills and their harnesses exactly as written.
In a delegated Implementor pane or outside Herdr, the current session runs that same chain locally.
Where this document is silent, the chained skill's own rules apply unchanged.
Read `~/.codex/skills/gen-prd/SKILL.md`, `~/.codex/skills/implement/SKILL.md`, and (when delivery mode is `pr`) `~/.codex/skills/ship/SKILL.md` before executing their stages.

Match the user's language by default.

## Session Entry

Before any repository write or mutating `sasu` command, read `~/.codex/skills/implement/references/observer-and-herdr.md` completely and apply its role router.

- A direct invocation in Herdr without the Implementor pane marker remains the user-facing Observer, opens exactly one right-side sibling Implementor pane, sends a lossless handoff, and does not execute the pipeline itself.
- A pane marked `SASU_HERDR_ROLE=implementor` executes every stage below in the current pane and never opens another Implementor.
- The nested `implement` stage of this run remains in this same Implementor pane.
- Outside Herdr, execute inline and state once that Observer isolation was unavailable.

After dispatch, the Observer is read-only for project files and Sasu state.
It monitors lifecycle and receipts, resolves reversible in-scope blocks under the Ambiguity Policy, asks the user only for hard stops, and returns the final report.
If Herdr dispatch fails, the unmarked session remains the Observer and reports the dispatch failure.
It must never turn itself into an inline Implementor while `HERDR_ENV=1`.
The dispatch helper is the only allowed pane-creation path for this workflow.
Pass the lossless handoff on its stdin and call it exactly once.
Do not replace either dispatch or handoff with raw `herdr pane split`, `herdr pane run`, messaging tools, or repeated dispatch attempts.

## What This Skill Changes Versus The Manual Chain

Only four things differ from running the skills by hand:

1. The PRD source is the current conversation, not a required intake artifact.
2. The human PRD-approval round-trip is replaced by recording the user's `$please` invocation as the approval deviation.
3. The stage transitions (PRD ready -> implement -> ship) happen automatically instead of waiting for the user to invoke the next skill.
4. In Herdr, the user-facing session observes one fresh Implementor pane instead of writing code or Sasu state itself.

Everything else stays identical: harness state files, review profiles, audits, verification evidence, receipts, delivery config, and hard stops.
Do not weaken any gate because this is the automated path.

## Inputs

The requirement source is the current conversation.
An argument after `$please` is a topic brief or emphasis, not a replacement for the conversation.

Before starting, capture verbatim the user message that invoked `$please` (including any argument).
This exact text is passed to `sasu implement start --allow-unapproved-prd` later; losing it forces a stop to re-ask.

Immediately bind that invocation to the topic before the first gate run:

```sh
sasu gate delegate --slug <topic-slug> \
  --evidence "<verbatim $please invocation message>"
```

Do not run gap-audit or spec until this command succeeds.
The record is immutable and same-value retries are idempotent.

If `agents/interview/<topic-slug>/qa-log.md` exists for the same topic (or the legacy `agents/intake/<topic-slug>/qa-log.md` from before the rename), use it as an additional canonical interview source per the `gen-prd` skill's normal input rules.

Before authoring a PRD from a real qa-log, require its live closure verdict:

```sh
sasu gate gap-audit --slug <topic-slug> --qa-log agents/interview/<topic-slug>/qa-log.md
```

Run the full gap-audit once and, only after an agent-fixable BLOCK, its one closure review under the bounded gate rules below.
Do not draft the PRD until gap-audit is PASS.
Conversation-only PRDs have no qa-log and skip this gate rather than manufacturing an intake artifact.

## Ambiguity Policy

The `$please` invocation is the user's standing decision to trade questions for recorded, veto-able assumptions.
Default to deciding, not asking: if a reasonable senior implementer could pick a defensible default from the conversation, the repository's conventions, and `agents/config.json`, and a wrong pick is reversible in code, it is an assumption — never a question.
Record every such assumption in the PRD's `Decision Traceability For Fidelity Review` section, restate it in the pre-implementation PRD summary and the final report, and let the user veto it after the fact.

Ask only when one of these holds:

- The answer is in the hard-stop class: credentials, billing or external spend, production data, destructive or irreversible actions, or an auth/security product decision.
- No defensible default exists and a wrong guess is expensive to reverse: an external-service commitment, a persistent data shape, or delivery mode with no config and no conversational signal.

`gen-prd`'s standalone prompts do not apply here: the conversation is the interview, so never ask its "no interview source" blocking question or recommend `$interview-me` mid-run.
When a short affirmative in the conversation is ambiguous, resolve it by the strongest contextual reading and record the reading as an assumption instead of asking.

When something does clear the bar for asking, front-load it: finish the completeness sweep first, collect every qualifying question together with the `4.1` human-only pre-work items into one single message at the start of the run, and attach a recommended default to each so one short reply can settle everything.
After that single upfront message, do not ask again mid-run; the only later stops are hard stops that first materialize during execution (a failed verification needing a product decision, an unexpected destructive step, a credential that turns out to be required).
Before drafting, perform a silent product-completeness sweep over the full intended user journey, relevant UX states, accessibility, responsive behavior, performance, security, operation, support, and recovery boundaries.
Apply only relevant boundaries and ask only when a missing answer is contract-breaking.
Do not silently reduce the product to an MVP because the pipeline is automated.

## Stage 1: PRD

Write the PRD by following the `gen-prd` skill in full:

- Output to `agents/prd/<topic-slug>/prd.md` with every required section.
- `source_intake: "current conversation"` unless a real intake file exists.
- Preserve conversation decisions in Decision Traceability: accepted proposals, rejected options, and the assumptions made under the Ambiguity Policy above.
- Author `4.2 Human Decisions Before PRD Approval` as `None required` by default only when every product decision is either grounded in the conversation/intake or recorded as an agent-owned reversible assumption in Decision Traceability.
  The `$please` invocation authorizes making reversible choices; it does not turn those choices into user-approved scope, structure, or verification decisions.
  Only hard-stop-class decisions (per the Ambiguity Policy) may remain in `4.2`.
  Keep `4.1 Pre-Work` honest — genuinely human-only items (credentials, accounts, owner-identity steps) still block and still get asked, in one message.
- Preserve a coherent production-quality product boundary, with every deliberate omission recorded as a non-goal or deferred decision with consequence, rationale, and revisit condition.
- Assign `review_profile` semantically from the complete product and engineering effects and write a concrete `review_rationale`; use `standard` for small user-facing work and `high-risk` for sensitive or irreversible effects.
- Run the Inline Self-Check Before Ready (including its losslessness item; do not treat silence or a topic change as approval) and the Harness Readiness Gate (`sasu prd readiness --prd`) exactly as the `gen-prd` skill requires.
- Mark `status: ready` only when those gates pass.
- Leave `human_approval: "pending"`.
  Never write `approved`; the user did not review the document, and the deviation record in Stage 2 is the honest representation of what happened.

Emit a compact summary of the PRD in chat before implementing: scope, non-goals, PRD-level tasks, verification modes, delivery mode, and the assumptions made.
This is informational, not a blocking approval request.
Continue immediately; the user can interrupt.

## Stage 2: Implement

Run the `implement` skill in full, with conversational approval recorded at start:

```sh
sasu implement start \
  --prd agents/prd/<topic-slug>/prd.md \
  --allow-unapproved-prd "<verbatim $please invocation message>"
```

Rules:

- The PRD declares the review profile; a missing or invalid value safely defaults to `standard`.
- Task order follows the PRD dependencies. Independent ready tasks may run concurrently; only this Implementor session closes tasks in `state.json`.
- If no `agents/config.json` exists, proceed with local-delivery defaults and mention `$sasu-setup` once in the final report.
  Do not enable `pr` delivery without config or an explicit conversation agreement, because automated pushes need the user's standing consent.
- Existing or old-schema runs are not resumed or migrated. Start a new topic slug after explicitly retiring obsolete state.
- Resolve section 4 before start. Ask all user-owned blocking items in one message.
- Final evidence registration, unified verify, and state-only finalize requirements apply unchanged.

## Stage 3: Ship (Conditional)

After `sasu implement finalize`:

- If the effective delivery mode is `pr`, run the `ship` skill in full: preflight, body, ship, CI watch, and its failure loop.
- If delivery mode is `local`, stop after the receipt.

Do not commit or push anything in local mode unless the conversation agreed to it.

## Stops

Never stop for stage transitions or document approval.
Stop and ask only when:

- a contract-breaking ambiguity has no defensible assumption.
- any `implement` or `ship` hard stop fires: DB migrations against real data, auth/security surfaces needing decisions, payments or billing, production data, credentials, destructive or irreversible actions, external spend, unmapped scope, or structure-lock deviations.
- a required verification fails in a way that needs a product decision.
- delivery would push or open a PR without config-based or conversational consent.
- a sasu gate stop condition fires (below).

## Sasu Gates In The Autonomous Loop

The Inputs stage already recorded the delegation before the first gate, quoting the invocation captured for `--allow-unapproved-prd`.
Every later gap-audit/spec run on the slug then applies the delegated-run disposition automatically.
Never overwrite it, clear it, pass `--assume-human-findings` again, or use placeholder/composed evidence; the original recorded invocation is the only authority for this topic.
This removes the per-call memory burden that, in measured delegated runs, caused both omitted autonomy and fabricated replacement evidence.

The CLI then converts non-P0 human-consent findings into a recorded assumption ledger instead of a block: the run proceeds, and each assumed finding must be written into the PRD's Decision Traceability with the default you chose, restated in the pre-implementation summary, and listed at the TOP of the final report as "human decisions replaced by assumptions" so the user can veto while it is still cheap.
P0 findings still block under this flag; they mean invented consent or an unimplementable document, and no delegation covers that.
This flag is the delegated-run counterpart of `--allow-unapproved-prd` and carries the same rule: only the user's own delegating message is valid evidence, never text you compose.

Gap-audit and spec use a bounded review cycle, not a retry loop:

1. Run the full review once.
2. If it BLOCKs, fix every agent-fixable finding and run the one allowed closure review.
3. If closure BLOCKs, stop and hand the remaining findings to the user.
   A third autonomous judgment is forbidden.
   Only a later explicit user change request opens a new cycle through `sasu gate reopen --slug <topic-slug> --gate <gap-audit|spec> --evidence "<the user's words>"`.
4. If either review PASSes, the cycle is sealed.
   Preserve any P2 notes as advisory findings and do not edit the document merely to chase them.

Standalone verify and unified implement verify retain their own convergence and budget rules.
Judge backend ERRORs do not consume either PRD semantic round; if the configured judge-error bound fires, repair the backend and use `--grant-budget` only with the user's verbatim approval to retry that broken backend.
Stop immediately when a P0 finding blocks under the delegated disposition, when closure is exhausted, or when a verify gate reports its terminal cause.

Never run `sasu gate override` yourself: the override is user-only, and the `$please` invocation authorizes skipping approval round-trips, not overriding failed quality gates.
A gate PASS is pinned to the input document's content hash and sealed: if you edit the qa-log or PRD body afterwards, `sasu gate status` reports `STALE` and the CLI refuses an automatic re-judgment at $0.
Restore the sealed input or stop for an explicit user-evidenced `gate reopen`; never reopen a cycle from the agent's own initiative.
Record each gate outcome in the final report.

When blocked, never invoke `AskUserQuestion`, `request_user_input`, or an interactive question UI.
Emit the structured `OBSERVER_BLOCK` packet from the Observer reference as final text and end the turn so Herdr settles for the Observer.
The Observer decides reversible in-scope questions and resumes this Implementor; it forwards only a hard stop to the user.
Follow the `implement` blocked/partial handoff rules and do not soften status to `Done`.

## Artifacts

Leave all `agents/prd/<slug>` and `agents/runs/<slug>` files in place.
No cleanup beyond what the chained skills already do.
`agents/runs/**` is expected to be gitignored (the doctor enforces this), so these files never enter commits or PRs.

## Final Report

The Implementor returns one combined report covering the whole run to the Observer.
The Observer checks completion authority and presents it to the user without rerunning verification.

- Status: `Done`, `Partially Done`, or `Blocked`.
- PRD path and the approval-deviation note (invocation recorded via `--allow-unapproved-prd`).
- The assumptions made under the Ambiguity Policy, so the user can veto any of them after the fact.
- Everything the `implement` Implementation Result Report Contract requires: user-visible changes, structure conformance, AC status, verification evidence by mode, review verdicts, deviations, remaining human review.
- When shipped: PR URL, branch, CI verdict per the `ship` final report.
- When config was absent: a one-line `$sasu-setup` suggestion.
