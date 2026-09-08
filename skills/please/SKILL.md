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

This skill is a two-phase coordinator around the existing pipeline, not a new pipeline.
In a direct Herdr invocation, the user-facing main session is the Spec Owner through interview closure and PRD readiness.
Only after the PRD is `ready` does it dispatch one fresh Implementor pane for the existing `implement` and `ship` stages, then become the Observer.
Outside Herdr, the current session runs the same stages locally without a role handoff.
A marked Implementor pane runs implementation and conditional delivery only from the ready PRD it received; it never authors or repairs the qa-log or PRD.
Where this document is silent, the chained skill's own rules apply unchanged.
Read `~/.codex/skills/interview-me/SKILL.md` when an existing qa-log still needs closure, `~/.codex/skills/gen-prd/SKILL.md` before authoring the PRD, `~/.codex/skills/implement/SKILL.md` before dispatch or inline implementation, and (when delivery mode is `pr`) `~/.codex/skills/ship/SKILL.md` before delivery.

Match the user's language by default.

## Session Entry

Before any repository write or mutating `sasu` command, read `~/.codex/skills/implement/references/observer-and-herdr.md` completely and apply its phase-aware role router.

- A direct invocation in Herdr without the Implementor pane marker remains the user-facing Spec Owner through Inputs, ambiguity resolution, qa-log closure when applicable, and Stage 1.
  It must not open an Implementor or become read-only before the PRD reaches `status: ready`.
- Once Stage 1 is sealed, that same main session dispatches exactly one right-side sibling Implementor with the ready PRD path and `PIPELINE: implement`, then becomes the Observer.
- A pane marked `SASU_HERDR_ROLE=implementor` requires that ready PRD handoff, skips Inputs and Stage 1, executes Stages 2 and 3 only, and never opens another Implementor.
- Outside Herdr, execute every stage inline and state once that Observer isolation was unavailable.

While the implementation phase is active after dispatch, the Observer is read-only for project files and Sasu state.
Only an explicit user-evidenced specification change may pause implementation and return the main session to the Spec Owner phase under the gate-reopen contract below.
It monitors lifecycle and receipts, resolves reversible in-scope blocks under the Ambiguity Policy, asks the user only for hard stops, and returns the final report.
If Herdr dispatch fails, the unmarked session keeps the sealed PRD, remains the user-facing session, and reports the dispatch failure without implementing inline.
It must never turn itself into an inline Implementor while `HERDR_ENV=1`.
`sasu implement dispatch --name <agent> --prd <ready-prd-path>` is the only allowed pane-creation path for this workflow.
Pass the lossless handoff on its stdin and call it exactly once.
Do not replace either dispatch or handoff with raw `herdr pane split`, `herdr pane run`, messaging tools, or repeated dispatch attempts.

## What This Skill Changes Versus The Manual Chain

Only four things differ from running the skills by hand:

1. The PRD source is the current conversation, not a required intake artifact.
2. The human PRD-approval round-trip is replaced by recording the user's `$please` invocation as the approval deviation.
3. The stage transitions (PRD ready -> implement -> ship) happen automatically instead of waiting for the user to invoke the next skill.
4. In Herdr, the user-facing session owns the qa-log and PRD, then observes one fresh Implementor pane for code, run state, verification, and delivery.

Everything else stays identical: harness state files, review profiles, audits, verification evidence, receipts, delivery config, and hard stops.
Do not weaken any gate because this is the automated path.

## Inputs

The requirement source is the current conversation.
An argument after `$please` is a topic brief or emphasis, not a replacement for the conversation.
In a direct Herdr run, the unmarked main session owns every command and artifact in this section and Stage 1.
Never put interview closure, gate delegation, gap-audit, or PRD authoring into the Implementor handoff.

Before starting, capture verbatim the user message that invoked `$please` (including any argument).
This exact text is passed to `sasu implement start --allow-unapproved-prd` later; losing it forces a stop to re-ask.

Inspect dirty judged source before the first gate run:

```sh
sasu implement intake
```

When `required` is false, keep no disposition and continue.
When `required` is true, show the returned paths and ask the returned question exactly once with its three returned options:

- `먼저 커밋하고 시작`: commit exactly the listed work only after the user chooses it, rerun `sasu implement intake`, and continue only when it reports a clean tree so the actual commit becomes the baseline.
- `기존 작업으로 이어서 시작`: retain `pre-existing` as the dirty disposition.
- `이번 작업에 포함`: retain `run-owned` as the dirty disposition.

This ownership fact is the one required human intake exception to the normal `$please` assumption policy because neither the Spec Owner nor the harness can infer who owns uncommitted bytes.
Do not defer this question to the Implementor.
Do not dispatch while `commit-first` remains unresolved.
For `pre-existing` or `run-owned`, write the retained value into the handoff packet's `DIRTY ATTRIBUTION` line and pass it later to `sasu implement start`; never ask again.

Immediately bind that invocation to the topic before the first gate run:

```sh
sasu gate delegate --slug <topic-slug> \
  --evidence "<verbatim $please invocation message>"
```

Do not run gap-audit or spec until this command succeeds.
The record is immutable and same-value retries are idempotent.

If `agents/interview/<topic-slug>/qa-log.md` exists for the same topic (or the legacy `agents/intake/<topic-slug>/qa-log.md` from before the rename), use it as an additional canonical interview source per the `gen-prd` skill's normal input rules.
The main session is the sole qa-log writer for this run.
When that qa-log is not complete, read the `interview-me` skill, run `sasu interview sync --slug <topic-slug>` before interpreting its outstanding state, and finish its raw capture, full normalization, closure, and audit bookkeeping in the current main session before drafting the PRD.
Run `interview sync` once more immediately before the final normalization and gap-audit so the last human answer cannot be omitted.
A complete qa-log remains read-only: an idempotent `interview sync` may confirm that it has no new turns, while any later turn still requires an explicit reopen before import.
Do not dispatch an Implementor to finish or reinterpret an active qa-log.

Before authoring a PRD from a real qa-log, require its live closure verdict:

```sh
sasu gate gap-audit --slug <topic-slug> --qa-log agents/interview/<topic-slug>/qa-log.md
```

Run gap-audit and, after an agent-fixable BLOCK, fix the open findings and re-run under the gate rules below.
Do not draft the PRD until gap-audit is PASS, which marks the qa-log `status: complete` under the `interview-me` closure contract.
Conversation-only PRDs have no qa-log and skip this gate rather than manufacturing an intake artifact.

## Ambiguity Policy

The `$please` invocation is the user's standing decision to trade questions for recorded, veto-able assumptions.
Default to deciding, not asking: if a reasonable senior implementer could pick a defensible default from the conversation, the repository's conventions, and `agents/config.json`, and a wrong pick is reversible in code, it is an assumption - never a question.
Record every such assumption as a Decisions row labelled as an assumption, restate it in the pre-implementation PRD summary and the final report, and let the user veto it after the fact.

Ask only when one of these holds:

- The answer is in the hard-stop class: credentials, billing or external spend, production data, destructive or irreversible actions, or an auth/security product decision.
- No defensible default exists and a wrong guess is expensive to reverse: an external-service commitment, a persistent data shape, or delivery mode with no config and no conversational signal.

`gen-prd`'s standalone prompts do not apply here: the conversation is the interview, so never ask its "no interview source" blocking question or recommend `$interview-me` mid-run.
When a short affirmative in the conversation is ambiguous, resolve it by the strongest contextual reading and record the reading as an assumption instead of asking.

When something does clear the bar for asking, front-load it: finish the completeness sweep first, collect every qualifying question together with the human-only prerequisites the PRD's Risks section will name into one single message at the start of the run, and attach a recommended default to each so one short reply can settle everything.
After that single upfront message, do not ask again mid-run; the only later stops are hard stops that first materialize during execution (a failed verification needing a product decision, an unexpected destructive step, a credential that turns out to be required).
Before drafting, perform a silent product-completeness sweep over the full intended user journey, relevant UX states, accessibility, responsive behavior, performance, security, operation, support, and recovery boundaries.
Apply only relevant boundaries and ask only when a missing answer is contract-breaking.
Do not silently reduce the product to an MVP because the pipeline is automated.

## Stage 1: PRD

The user-facing main session writes and seals the PRD by following the `gen-prd` skill in full.
The Implementor never runs this stage.

- Output to `agents/prd/<topic-slug>/prd.md` with every required section.
- `source_intake: "current conversation"` unless a real intake file exists.
- Preserve conversation decisions in the Decisions table: accepted proposals, rejected options, and the assumptions made under the Ambiguity Policy above, each assumption labelled as one.
  The `$please` invocation authorizes making reversible choices; it does not turn those choices into user-approved scope, structure, or verification decisions.
  Only hard-stop-class decisions (per the Ambiguity Policy) may remain open in Risks.
  Keep Risks honest - genuinely human-only prerequisites (credentials, accounts, owner-identity steps) still block and still get asked, in one message.
- Preserve a coherent production-quality product boundary, with every deliberate omission recorded as a non-goal or deferred decision with consequence, rationale, and revisit condition.
- Assign `review_profile` semantically from the complete product and engineering effects and write a concrete `review_rationale`; use `standard` for small user-facing work and `high-risk` for sensitive or irreversible effects.
- Run the Inline Self-Check Before Ready (including its losslessness item; do not treat silence or a topic change as approval) and the Harness Readiness Gate (`sasu prd readiness --prd`) exactly as the `gen-prd` skill requires.
- Flip the status with `sasu prd ready --prd <path>` - the CLI refuses while
  readiness has blocking gaps; never edit the frontmatter line by hand.
- Leave `human_approval: "pending"` (`sasu prd approve` exists for the user's
  explicit approval and has no place in the delegated path).
  Never write `approved`; the user did not review the document, and the deviation record in Stage 2 is the honest representation of what happened.

Emit a compact summary of the PRD in chat before implementing: goal, non-goals, the complete behaviors and cited decisions, delivery mode, and the assumptions made.
This is informational, not a blocking approval request.
Continue immediately to the implementation dispatch below; the user can interrupt.

## Implementation Dispatch

This is the only transition from specification work to implementation work.

In a direct Herdr run, dispatch only after all of these are true:

- the qa-log is complete and its gap-audit PASS is current, when a qa-log exists.
- the PRD body is complete, `sasu prd readiness --prd` passes, and the applicable spec gate is current.
- the PRD frontmatter says `status: ready`.
- every human-owned prerequisite the PRD's Risks section names is resolved.

Dispatch exactly once with the ready PRD path, through the `Dispatch One Implementor`
and `Handoff Packet` contracts in the Observer reference. Run that command as the
reference states it; this document deliberately keeps no second copy of it. The
copy that used to live here drifted from the reference once the herdr adapter
boundary landed (T10) - it lost `--model`/`--effort` and the role-helper marker
check - and a restated command is exactly the thing that can drift again.

Fill the packet's placeholders as follows for `$please`:

- `ROLE`: Implementor, confirming the marker through the role helper and never dispatching recursively.
- `PIPELINE: implement via ~/.codex/skills/implement/SKILL.md` - never `please`.
- `ORIGINAL INVOCATION`: the `$please` invocation message, verbatim.
- `GOAL AND CONTEXT`: implement the sealed PRD; include only operational context not represented there.
- `AUTHORITY`: reversible in-contract implementation defaults are autonomous; contract changes and hard stops return to the Observer.
- `SOURCE`: the current cwd and `agents/prd/<topic-slug>/prd.md`.
- `RETURN CONTRACT`: status, changed paths, assumptions, verdicts, timing, and unresolved items.

Do not send `PIPELINE: please`.
The ready PRD is the canonical implementation contract, so do not duplicate or reinterpret the full conversation in the handoff.
After successful dispatch, the main session becomes the read-only Observer and arms `sasu implement await` from the Observer reference.

A marked Implementor starts here, verifies that the handoff supplied a ready PRD, and proceeds to Stage 2.
It must emit `OBSERVER_BLOCK` instead of creating or repairing a missing, draft, or stale PRD.

Outside Herdr, skip dispatch and continue inline to Stage 2.

## Stage 2: Implement

Only the marked Implementor, or the same inline session outside Herdr, runs the `implement` skill in full with conversational approval recorded at start:

```sh
sasu implement start \
  --prd agents/prd/<topic-slug>/prd.md \
  --allow-unapproved-prd "<verbatim $please invocation message>" \
  [--dirty-attribution <pre-existing|run-owned>]
```

The optional disposition must exactly match the `DIRTY ATTRIBUTION` value in the dispatch handoff or the inline Spec Owner's retained intake result.
Its presence means the user already answered; the Implementor must not ask again.

Rules:

- Treat the qa-log and PRD body as sealed, read-only inputs.
  The Implementor must not amend their decisions, traceability, scope, or acceptance criteria.
- A reversible implementation choice that stays within the contract may proceed and must be listed in the final report.
  A discovery that changes scope, an acceptance criterion, major structure, or product behavior must emit `OBSERVER_BLOCK`; it is never repaired by silently editing the specification from the Implementor pane.
- The PRD declares the review profile; readiness rejects invalid declared values.
- Choose implementation order and shared actual QA flows freely while preserving the complete contract.
  Do not create per-requirement outcomes or a replacement Markdown checklist.
  The Implementor coordinates run commands, and the CLI alone writes `state.json`.
- If no `agents/config.json` exists, proceed with local-delivery defaults and mention `$sasu-setup` once in the final report.
  Do not enable `pr` delivery without config or an explicit conversation agreement, because automated pushes need the user's standing consent.
- Existing or old-schema runs are not resumed or migrated. Start a new topic slug after explicitly retiring obsolete state.
- Require the Risks section's human-owned prerequisites to have been resolved by the main session before dispatch.
  If a human-owned blocker remains, emit `OBSERVER_BLOCK`; do not ask from the Implementor pane.
- Register useful observations at run level with provenance, execute required suites and one independent full-contract review through verify, and use state-only finalize.
  A high-risk run retains a distinct safety check; open risks count toward the correction bound.
  A first failed verify remains active, and an exhausted or persistently failed attempt closes honestly with `finalize --status blocked`.
  Pending permitted human judgment may travel with delivery, but explicit open rejection blocks it.

## Stage 3: Ship (Conditional)

After `sasu implement finalize`:

- If the effective delivery mode is `pr`, run the `ship` skill in full: preflight, body, ship, CI watch, and its failure loop.
- If delivery mode is `local`, run the post-receipt local delivery command to create the semantic local commit and record its delivery result.

Local delivery never pushes, opens a PR, watches CI, or merges.

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

All gap-audit and spec cycles belong to the main session's pre-dispatch Spec Owner phase.
The Implementor never reruns those gates or edits their sealed qa-log and PRD inputs.

The CLI then converts non-P0 human-consent findings into a recorded assumption ledger instead of a block: the run proceeds, and each assumed finding must be written into the PRD's Decisions table as an assumption with the default you chose, restated in the pre-implementation summary, and listed at the TOP of the final report as "human decisions replaced by assumptions" so the user can veto while it is still cheap.
P0 findings still block under this flag; they mean invented consent or an unimplementable document, and no delegation covers that.
This flag is the delegated-run counterpart of `--allow-unapproved-prd` and carries the same rule: only the user's own delegating message is valid evidence, never text you compose.

Gap-audit and spec keep an open findings set, not a retry loop:

1. Run the review.
2. If it BLOCKs, fix every open agent-fixable finding and re-run; the rerun judges only the open findings by id and can add one only where the Decision Register changed, so the set can only shrink.
3. If it returns NEEDS_HUMAN, every open finding needs a human decision: stop, hand the whole bundle to the user in one message, and once they answer, record their words with `sasu gate answer --slug <topic-slug> --gate <gap-audit|spec> --evidence "<the user's words>"`, which seals PASS without another judge call.
   Only a later explicit user change request opens a new cycle through `sasu gate reopen --slug <topic-slug> --gate <gap-audit|spec> --evidence "<the user's words>"`.
4. If the review PASSes, the cycle is sealed.
   Preserve any P2 notes and warnings as advisory findings and do not edit the document merely to chase them.

Standalone verify and unified implement verify retain their own convergence and budget rules.
Judge backend ERRORs do not touch the open findings set; if the configured judge-error bound fires, repair the backend and use `--grant-budget` only with the user's verbatim approval to retry that broken backend.
Stop immediately when a P0 finding blocks under the delegated disposition, when a NEEDS_HUMAN bundle is raised, or when a verify gate reports its terminal cause.

Never run `sasu gate override` yourself: the override is user-only, and the `$please` invocation authorizes skipping approval round-trips, not overriding failed quality gates.
A gate PASS is pinned to the input document's content hash and sealed: if you edit the qa-log or PRD body afterwards, `sasu gate status` reports `STALE` and the CLI refuses an automatic re-judgment at $0.
Restore the sealed input or stop for an explicit user-evidenced `gate reopen`; never reopen a cycle from the agent's own initiative.
Record each gate outcome in the final report.

After dispatch, when the Implementor is blocked, never invoke `AskUserQuestion`, `request_user_input`, or an interactive question UI.
Emit the structured `OBSERVER_BLOCK` packet from the Observer reference as final text and end the turn so Herdr settles for the Observer.
The Observer decides reversible in-scope questions and resumes this Implementor; it forwards only a hard stop to the user.
If the block requires a specification change, the Observer must not tell the Implementor to diverge from the sealed PRD.
It asks for the explicit user change required by the gate-reopen contract; only then may the main session return to the Spec Owner phase, reopen and reseal the affected gate, and resume implementation from the updated ready PRD.
Follow the `implement` blocked/partial handoff rules and do not soften status to `Done`.

## Artifacts

Leave all `agents/prd/<slug>` and `agents/runs/<slug>` files in place.
No cleanup beyond what the chained skills already do.
`agents/runs/**` is expected to be gitignored (the doctor enforces this), so these files never enter commits or PRs.

## Final Report

The Implementor returns the implementation and conditional-delivery report to the Observer.
The Observer combines it with the PRD-stage results it already owns, checks completion authority, and presents one final report without rerunning verification.

- Status: `Done`, `Partially Done`, or `Blocked`.
- PRD path and the approval-deviation note (invocation recorded via `--allow-unapproved-prd`).
- The assumptions made under the Ambiguity Policy, so the user can veto any of them after the fact.
- Everything the `implement` Implementation Result Report Contract requires: user-visible changes, structure conformance, AC status, verification evidence by mode, review verdicts, deviations, remaining human review.
- When shipped: PR URL, branch, CI verdict per the `ship` final report.
- When config was absent: a one-line `$sasu-setup` suggestion.
