---
name: interview-me
description: |
  Project-local pre-PRD requirements interview.
  Use when the user invokes "$interview-me", asks to interview an idea,
  clarify or pressure-test requirements, reduce ambiguity, prepare a PRD
  handoff, or wants UX, behavior, scope, technical, verification, risk,
  operation, and documented-domain decisions captured before writing a PRD.
  The "$ho-interview" and "$ho-scope" compatibility aliases follow this same workflow.
  Run low-latency main-agent-led Q&A with raw capture, decision tracking,
  targeted UX scenario coverage, periodic checkpoint backfill, and a final
  PRD handoff.
---

# interview-me

Use this skill before gen-prd when an idea needs a decision-quality interview.
Write artifacts under agents/intake/<topic-slug>/.
Keep legacy .hoyeon/intake artifacts readable as fallback only.
Do not implement code, write the PRD itself, create an execution plan, or mutate product implementation state.
Match the user's language by default.

## Core Contract

- Keep the interview fast.
- Ask only questions that change scope, behavior, acceptance, risk, implementation safety, or verification.
- Keep the two existing artifacts only: qa-log.md and prd-handoff.md.
- Own ordinary Q&A in the main agent.
- Do not spawn, retain, resume, or update subagents during ordinary questions.
- Use one fresh independent auditor only for non-trivial final closure when subagent tools are available and the user has not opted out.
- Do not use a numeric ambiguity score as a completion gate.
- Stop when the intended product is coherent, material decisions are traceable, and completion is testable, not when every imaginable detail is exhausted.

## Product Completeness Default

Scope a coherent, production-quality product rather than an intentionally disposable MVP.
Do not use first implementation, prototype, MVP, or time pressure as an implicit reason to omit product behavior or quality.
Cover the complete primary journey and the relevant failure, recovery, accessibility, responsive, performance, security, operation, and support boundaries.
Ask the user only when those boundaries require product or taste judgment.
Derive ordinary engineering quality from the repo and established practice without turning completeness into a questionnaire.
Any deliberate scope reduction must be an explicit decision with the omitted behavior, user consequence, rationale, and revisit condition recorded in the Decision Register.

## Low-Latency Capture

Create agents/intake/<topic-slug>/qa-log.md before Q1.
Capture each answer immediately in raw form.
Set needs_normalization: true until its decision, provenance, and impact are normalized.
Update only the next-question cursor and affected Decision Register rows.
Do not make the user wait for prose polishing.

Normalize outstanding answers every 10 answered questions.
Normalize after every 2 to 3 answers for high-risk work.
High-risk work includes production data, migrations, PII, credentials, external APIs, payments, cost, legal or compliance, irreversible side effects, and user-facing launch gates.
Run a mandatory full normalization before writing prd-handoff.md.

## Preflight And Routing

Before Q1, inspect only the repo and docs facts that can change the interview.
Record exact paths or URLs for facts that constrain the request.
Do not ask the user for a fact that can be verified locally.

Classify the request without asking a separate questionnaire:

- Where: greenfield, brownfield, docs-only, or unknown.
- Surfaces: user-facing UI, workflow or state machine, data, auth or access, external provider, migration, operation or launch.
- Required packs: UX, compatibility, data, provider, risk, operation, verification, documented-domain.

Route each candidate answer before asking:

| Answer kind | Source of truth | Interview behavior |
| --- | --- | --- |
| Existing fact | code, config, docs, or verified research | Record the evidence and tell the user briefly. |
| Product or UX decision | user | Ask one focused question with a recommendation when useful. |
| Mixed fact and decision | code or docs plus user judgment | Present verified facts, then ask the user to choose the intended behavior. |
| Unknown external fact | current primary source | Research only when it materially changes a decision, then ask the user to confirm the decision. |

Never convert an existing implementation fact into a new product decision without user confirmation.
Never treat an agent inference as user intent.

## Decision Register

Maintain one compact Decision Register in qa-log.md.
Create nodes only for material facts, decisions, assumptions, risks, and verification boundaries.
Do not create generic filler nodes.

Prioritize the next question by material impact times unresolved uncertainty.
Prefer a node that unblocks multiple requirements, scenarios, or verification items.
Reopen an affected node when later evidence, a changed answer, or a contradiction invalidates it.
Do not mark a node resolved merely because its parent axis sounds resolved.

Use these fields for every entry:

| ID | Kind | Area | Decision / fact | Priority | Source / owner | Status | PRD mapping / revisit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| D-01 | fact / decision / assumption | UX/design |  | P0 / P1 / P2 | user, repo path:line, provider URL, or agent default | open / resolved / deferred / blocking / rejected | R#/AC#/T#/V#/non-goal, plus revisit trigger when needed |

Use Kind values fact, decision, or assumption.
Use Source / owner to distinguish user decisions, code or docs facts, provider evidence, and agent defaults.
Use P0 for a decision that can invalidate the handoff or primary experience.
Use P1 for a material decision that changes implementation or verification.
Use P2 for a bounded detail that can safely remain deferred.
Use Status only for lifecycle state; an adopted assumption is Kind `assumption` with Status `resolved`, not a separate status.

Only silently adopt a default when it is reversible, does not change user-visible behavior, scope, public or provider contract, data shape, auth, security, cost, or launch criteria, and has an explicit verification path.
Record every adopted default as Kind assumption with its source and revisit trigger.

## UX And Behavior Pack

Select UX/design whenever a person sees, enters, changes, approves, or recovers from a product flow.
Do not reduce UX to visual style.
Treat behavior, state, recovery, and proof as first-class UX decisions.

For each primary user flow, create one UX Scenario Card.
Ask only about states that the proposed flow can actually reach.
Do not interrogate every state for a static or non-interactive change.

Required UX nodes when relevant:

- Primary user, job, and entry trigger.
- Golden path and observable success state.
- Empty, loading, error, permission-denied, and partial-success states that can occur.
- Data entry, validation, save, retry, cancel, undo, destructive action, and recovery behavior.
- Access or role differences.
- Existing navigation, route, responsive, and accessibility constraints for brownfield UI.
- Copy, visual taste, and human approval boundaries.
- Browser, runtime, or human proof for the flow.

Use this card shape:

~~~markdown
## UX Scenario Cards

### UX-01: <primary flow>
- trigger:
- happy path:
- state / failure:
- recovery:
- proof:
- linked decisions: D-01, D-02
~~~

The happy path describes what the user does and sees.
The state / failure line names the meaningful unhappy state, not a generic error placeholder.
The proof line names the observable check that will prove the scenario.
If copy or visual taste requires human judgment, mark that explicitly instead of inventing it.

## Conditional Packs

Activate only packs that the preflight classifies as relevant.

### Brownfield Compatibility

Map each affected route, API, table, job, client, event, or user flow.
Record the observed current contract, intended change, compatibility requirement, rollback or migration boundary, and regression proof.
Treat a discovered repo fact as evidence, not approval to change it.

### Data And State

Capture source of truth, owner, lifecycle or state transition, retention, synchronization or import-export, and failure recovery when data is created, changed, or displayed.

### External Provider

Capture exact provider contract, environment, cost or rate limit, credentials owner, retry or idempotency, fallback, and safe proof mode.

### Access And Risk

Capture actor or role, sensitive boundary, approval, audit or notification need, and rollback or kill-switch behavior when relevant.

### Operation And Launch

Capture required accounts, assets, seed data, rollout, observability, alert or support path, and launch gate when relevant.

### Verification

For every in-scope primary behavior, capture an observable result, a negative guarantee where relevant, and a proof mode.
Use automated behavior by default for changed code behavior.
Use browser or runtime, API, DB, external, and human proof only where they prove something distinct.

## Question Rules

- Ask exactly one user-facing question at a time for P0 or P1 decisions, contradictions, UX choices that need judgment, and risk or operation questions.
- Batch 3 to 5 low-risk confirmations only when they satisfy the silent-default rule.
- Explain briefly why a question changes the outcome or proof.
- Include a recommended answer when it reduces cognitive load without concealing alternatives.
- Preserve free-text reasoning, constraints, non-goals, and objections.
- For a material free-text answer, normalize a Decision Packet before relying on it.
- Confirm the packet only when interpretation could lose intent or alter scope.
- Do not repeat a resolved question unless new evidence reopened its node.
- Treat I do not know as valid and classify the node as deferred or blocking.
- If one branch dominates, revisit the highest-impact unresolved node in another selected pack.

Use this Decision Packet for material free-text answers:

~~~markdown
- decision:
- reasoning:
- constraints:
- explicit non-goals:
- verified facts:
- unresolved follow-up:
- source:
~~~

Run a local intent, impact, and verification sweep after three material decisions or when a P0 node changes.
The sweep must produce either no material gap or one highest-impact follow-up.
Do not turn the sweep into a second user interview.

## Artifacts

Use this qa-log.md structure.
Keep raw capture light during the interview.
Complete every normalized field before handoff.

~~~markdown
---
topic: "<topic>"
status: "active | paused | complete"
target_handoff: "prd"
where: "greenfield | brownfield | docs-only | unknown"
selected_packs: "ux, compatibility, data, provider, risk, operation, verification, documented-domain"
created_at: "YYYY-MM-DD"
updated_at: "YYYY-MM-DD"
question_count: 0
normalization_policy: "raw-capture-with-checkpoint-backfill"
normalization_checkpoint_every: 10
---

# Interview Log: <topic>

## Current Understanding

## Intake Cursor

- next_decision_id:
- next_question:
- last_materiality_sweep:
- outstanding_raw_entries:
- next_checkpoint_at:

## Decision Register

| ID | Kind | Area | Decision / fact | Priority | Source / owner | Status | PRD mapping / revisit |
| --- | --- | --- | --- | --- | --- | --- | --- |

## Raw Q&A

### Q1: <short label>
- decision_ids:
- route: fact | user-decision | mixed | research
- asked:
- recommended:
- answer:
- immediate_notes:
- needs_normalization: true | false

## UX Scenario Cards

## Evidence From Code, Docs, Or Research

## Documented Domain Checks

- docs inspected:
- canonical terms:
- glossary or code conflicts:
- concrete scenarios tested:
- docs mutation:
- ADR candidate:

## Checkpoint And Sweep History

### Checkpoint N
- after_question:
- normalized_entries:
- register_changes:
- reopened_decisions:
- highest_remaining_gap:

### Sweep N
- trigger:
- intent_drift:
- impact_gap:
- verification_gap:
- next_action:

## Audit History

### Audit N
- type: local | final-auditor
- result: pass | fail | unavailable | skipped
- missing decision_ids:
- unsupported assumptions:
- UX or behavior gap:
- highest-risk blocker:
- final-blocking-question:
- handoff impact:
~~~

Use this prd-handoff.md structure.

~~~markdown
# PRD Handoff: <topic>

> Date: YYYY-MM-DD
> Source: agents/intake/<topic-slug>/qa-log.md
> Interview skill: interview-me

## Clear Outcome

## Product Completeness Boundary

## Decision Trace And Requirement Mapping

| Decision | User intent or evidence | Represented by | Remaining gap |
| --- | --- | --- | --- |
| D-01 |  | R#, AC#, T#, V#, non-goal, human review, risk, or guardrail | none / deferred / blocking |

## UX Behavior And State Seeds

## Domain Terms And Documented Decisions

## Requirement Seeds

## Non-Goals And Rejected Options

## Pre-Work And Human Decisions

## Major Technical Structure Signals

## Test And Verification Seeds

## Risks, Side Effects, And Sensitive Data

## Human Review Needed

## Open Questions

## Suggested Next Step

$gen-prd --context agents/intake/<topic-slug>/prd-handoff.md "<topic>"
~~~

## Loop And Closure

1. Mirror current understanding in 2 to 4 bullets.
2. Preflight the repository and classify relevant packs.
3. Create qa-log.md with selected packs, a Decision Register, and Q1 rationale.
4. Ask the highest-impact unresolved decision, or a valid low-risk confirmation block.
5. Raw-capture the answer, update the affected D# nodes, and reopen invalidated nodes.
6. Create or refresh a UX Scenario Card as soon as a user-facing primary flow is in scope.
7. Run the materiality sweep at its trigger.
8. Checkpoint every 10 answers or earlier for high-risk work.
9. Before handoff, restate the agreed goal in one sentence and confirm that another agent would build the intended outcome from that line.
10. Run full normalization and the intake validator.
11. Run final auditor closure or recorded local fallback.
12. If there is a material blocker, ask one exact blocking question or classify it as blocking or deferred in the handoff.
13. Write prd-handoff.md only when the validator and closure are ready.

Run the validator from the installed skill path before final handoff:

~~~sh
node ~/.codex/skills/interview-me/scripts/validate_intake.mjs \
  agents/intake/<topic-slug>/qa-log.md \
  --handoff agents/intake/<topic-slug>/prd-handoff.md
~~~

The validator is a mechanical gap check, not a substitute for product judgment.

## Final Quality Gate

Before writing prd-handoff.md, verify:

- Every raw entry needed for handoff is normalized.
- Every P0 and P1 Decision Register entry is resolved, explicitly deferred, blocking, or rejected.
- Every fact, decision, and assumption has an owner and source or evidence.
- Every selected UX flow has a Scenario Card with a primary path, meaningful state or failure, recovery, and proof.
- Every material D# maps to a requirement, acceptance criterion, task, verification item, non-goal, human review, risk, or explicit deferred or blocking item.
- The full intended product journey and relevant quality boundaries are covered, and every deliberate omission is an explicit decision rather than an implicit MVP cut.
- Rejected options and non-goals remain visible.
- Required verification is seeded with an observable result.
- High-risk boundaries, compatibility, and operation needs are explicit when relevant.
- The final auditor or local closure audit has no hidden material blocker.
