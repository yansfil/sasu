---
name: interview-me
description: |
  Project-local pre-PRD requirements interview.
  Use when the user invokes "$interview-me", asks to interview an idea,
  clarify or pressure-test requirements, reduce ambiguity, prepare a PRD
  source, or wants UX, behavior, scope, technical, verification, risk,
  operation, and documented-domain decisions captured before writing a PRD.
  The "$ho-interview" and "$ho-scope" compatibility aliases follow this same workflow.
  Run low-latency main-agent-led Q&A with raw capture, decision tracking,
  targeted UX scenario coverage, periodic checkpoint backfill, and a final
  PRD-ready qa-log.
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
- Keep one canonical artifact only: qa-log.md.
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
Run a mandatory full normalization before marking qa-log.md complete and handing it to gen-prd.

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
Use P0 for a decision that can invalidate the PRD source or primary experience.
Use P1 for a material decision that changes implementation or verification.
Use P2 for a bounded detail that can safely remain deferred.
Use Status only for lifecycle state; an adopted assumption is Kind `assumption` with Status `resolved`, not a separate status.

Only silently adopt a default when it is reversible, does not change user-visible behavior, scope, public or provider contract, data shape, auth, security, cost, or launch criteria, and has an explicit verification path.
Record every adopted default as Kind assumption with its source and revisit trigger.
Treat a short affirmative answer such as `yes`, `응`, or `그렇게 하자` as acceptance only when it unambiguously refers to the immediately preceding explicit recommendation.
Record that source as a user-accepted recommendation in the relevant Q# rather than as an agent default.
Silence, lack of objection, a topic change, or continuing the interview is not user consent.
When the referent is ambiguous and the decision is material, ask one confirmation question; otherwise use only the silent-default rule above.

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
- Link every material Raw Q&A entry to at least one Decision Register ID; use `decision_ids: none` only when the entry has no PRD effect and explain why in `immediate_notes`.
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
Complete every normalized field before marking the file PRD-ready.

~~~markdown
---
topic: "<topic>"
status: "active | paused | complete"
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
- PRD impact:
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
9. Before closure, restate the agreed goal in one sentence and confirm that another agent would build the intended outcome from that line.
10. Run full normalization.
11. Run the checkshirt gap-audit gate, falling back to final auditor closure or a recorded local fallback only when the `checkshirt` binary is unavailable.
12. If there is a material blocker, ask one exact blocking question or classify it as blocking or deferred in qa-log.md.
13. Mark qa-log.md `status: complete` only when the gate and closure are ready, then suggest `$gen-prd --context agents/intake/<topic-slug>/qa-log.md "<topic>"`.

## Gap-Audit Gate (checkshirt)

Independent closure judgment is owned by the checkshirt CLI.
Run it after full normalization, before marking the qa-log complete:

~~~sh
checkshirt gate gap-audit --slug <topic-slug> --qa-log agents/intake/<topic-slug>/qa-log.md
~~~

The gate owns the mechanical document lint: it runs a deterministic prelint
(required sections, Decision Register integrity, dangling `decision_ids`,
frontmatter enums, open P0/P1 nodes) before the judge, so no separate
validator step is needed.
A `[prelint]` failure is a $0 structural defect with a rule ID and line
number: fix the document and re-run freely - prelint failures never call the
judge and never consume the retry budget.

- The gate is a hard block: exit 1 means closure is blocked and the findings list the material gaps.
- Findings are next-question candidates: resolve each finding with the user or in the register, then re-run the gate.
- Prefer `--json` when consuming the result programmatically: it returns a structured object (top-level `contractVersion`, a `prelint` key separate from judge findings, verdict/attempt state) instead of scraping text.
- A finding marked `needs human decision` must go to the user; never invent the answer.
- When the output says the retry budget is exhausted, stop and hand the findings to the user instead of re-running.
- If the judge backend is unavailable, the gate fails closed; report the printed cause and recovery to the user, then use the final-auditor subagent or a recorded local fallback as the closure audit.
- Never run `checkshirt gate override` yourself: the override is a user-only command, and the recorded deviation must carry the user's own reason.
- Record the gate result as an Audit entry (`type: gap-audit-gate`) in qa-log.md.
- The PASS is pinned to the qa-log's content hash (frontmatter and the `## Audit History` section are exempt as lifecycle bookkeeping): any other qa-log edit after the gate passed makes `checkshirt gate status` report `STALE`, and a stale gate must be re-run before handoff.
- The gate returns a findings list, never a numeric score; the numeric-gate ban in the Core Contract stands.

## Final Quality Gate

Before marking qa-log.md complete, verify:

- Every material raw entry needed by the PRD is normalized and linked to a Decision Register entry.
- Every P0 and P1 Decision Register entry is resolved, explicitly deferred, blocking, or rejected.
- Every fact, decision, and assumption has an owner and source or evidence.
- Every selected UX flow has a Scenario Card with a primary path, meaningful state or failure, recovery, and proof.
- Every material D# maps to a requirement, acceptance criterion, task, verification item, non-goal, human review, risk, or explicit deferred or blocking item.
- The full intended product journey and relevant quality boundaries are covered, and every deliberate omission is an explicit decision rather than an implicit MVP cut.
- Rejected options and non-goals remain visible.
- Required verification is seeded with an observable result.
- High-risk boundaries, compatibility, and operation needs are explicit when relevant.
- The final auditor or local closure audit has no hidden material blocker.
