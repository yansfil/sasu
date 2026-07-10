---
name: ho-scope
description: |
  Project-local pre-PRD requirements intake. Use when the user invokes
  "$ho-scope", asks to clarify, pressure-test, reduce ambiguity, prepare a PRD
  handoff, or wants requirements questioned across product, scope, UX/design,
  technical, verification, risk, operation, and documented-domain axes before
  writing a PRD.
  Runs low-latency main-agent-led Q&A by raw-capturing answers in qa-log.md,
  checkpoint-backfilling every 10 answered questions or sooner for high-risk
  topics, and fully normalizing the log before prd-handoff.md.
---

# ho-scope

Intake artifacts live under the visible `agents/` namespace (`agents/intake/**`);
legacy `.hoyeon/intake/**` files stay readable as a fallback.

Use this skill before `ho-spec` when the request is ambiguous or when the user wants the idea pressure-tested before implementation planning.
The job is to reduce ambiguity and produce a PRD handoff artifact.
Do not implement code, write the PRD itself, create execution plans, or mutate implementation state.
Match the user's language by default.
Compatibility aliases follow this same flow and write to `agents/intake/`.

## Operating Contract

- Use tiered questioning to protect the user's time:
  - Ask exactly one user-facing question at a time for high-risk axes
    (Risk, Operation, Verification under risk escalation), contradiction or
    misunderstanding checks, and open design questions that need real thought.
  - For low-risk confirm-only items where you already have a strong default,
    batch 3 to 5 of them into one message as a default-assumption block: state
    each assumption with its recommended answer and ask the user to only call
    out the ones that are wrong. Silence or "그대로 진행" adopts the defaults.
  - Record each batched item as its own Q entry with the adopted default as
    the answer and `status: assumption` until the user confirms or corrects it.
  - Never batch questions about sensitive data, credentials, migrations,
    payments, production data, irreversible effects, or anything the user has
    already answered inconsistently.
- Keep the conversation fast by appending raw Q&A first and normalizing the log later.
- Own normal Q&A in the main agent.
- Do not spawn, keep, resume, or update subagents during ordinary intake turns.
- Use one fresh independent auditor only as a final closure check before `prd-handoff.md` when the intake is non-trivial, subagent tools are available, and the user has not opted out.
- Stop when the PRD handoff is good enough, not when every possible detail is exhausted.

## Low-Latency Logging

Create `agents/intake/<topic-slug>/qa-log.md` before the first question.
The initial log may be a stub with current understanding, provisional Axis Map, and Q1 rationale.

During Q&A, prefer this fast path:

1. Record the latest answer as raw capture in `qa-log.md`.
2. Mark the entry with `needs_normalization: true`.
3. Update only the minimum cursor fields needed to choose the next question.
4. Ask the next question without fully polishing every section.

Do a checkpoint backfill after every 10 answered questions, before asking the next question.
At each checkpoint, normalize all outstanding raw Q&A entries, refresh the Axis Map, consolidate decisions and assumptions, and record the latest misunderstanding check.
If the request touches production data, migrations, PII, credentials, external APIs, payments, cost, legal/compliance, irreversible side effects, or user-facing launch gates, do not wait for 10 answers.
For high-risk intake, normalize risk, operation, and verification notes every 2 to 3 answered questions or immediately after a material risk answer.

Before writing `prd-handoff.md`, run a mandatory full backfill.
Resolve every `needs_normalization: true`, complete the Axis Closure Matrix, classify open questions, record audit history, and make the handoff consistent with the final log.
Do not treat the raw log as handoff-ready until this final backfill is complete.

## Axis Board

The main agent selects axes.
Do not ask the user to choose axis labels.
Select only axes that affect PRD quality, implementation safety, or verification coverage.
Track each axis as `selected`, `watch`, or `not-selected`.
Selected axes require closure before handoff.
Watch axes are revisited after material answers or repo/doc findings.
Not-selected axes do not need handoff content unless new evidence makes them relevant.

- Product: problem, goal, user, use case, success signal.
- Scope: in-scope behavior, non-goals, constraints, edge cases.
- UX/design: flow, tone, layout, content, taste decisions, human approval.
- Technical: API, DB, infra, auth, external services, data flow, architecture.
- Verification: required proof, automated tests, browser/runtime proof, live/API/DB probes, human-only checks.
- Risk: production data, migrations, PII, side effects, credentials, cost.
- Operation: pre-work, assets, accounts, seed data, approvals, launch gates.
- Documented-domain: existing glossary, `CONTEXT.md`, `CONTEXT-MAP.md`, ADRs, docs, domain terms, and documented decisions.

## Risk Escalation

If the request touches production data, migrations, PII, credentials, external APIs, payments, cost, legal/compliance, irreversible side effects, or user-facing launches, promote Risk, Operation, and Verification to required axes.
Do not write the handoff until those axes are classified as `resolved`, `assumption`, `deferred`, or `blocking`.

Apply these node-level modifiers when relevant:

- Sensitive data or credentials: require Data/Security and Access questions.
- External exposure or multi-user collaboration: require Access/Security questions.
- Irreversible effects, migrations, or production data: require Risk/Compatibility and rollback questions.
- High scale, cost, or external APIs: require Infra/Architecture and rate-limit questions.
- Brownfield changes: require Compatibility questions for existing URL, API, DB, data, and user-flow contracts.
- User-facing UI: require State questions for empty, loading, error, permission-denied, and partial-success states.

## Question Rules

- Ask every question needed to make selected and risk-escalated axes PRD-ready.
- Prefer a batched default-assumption block over a chain of one-word
  confirmations. If the last 2 to 3 answers were bare confirmations of your
  recommendations, switch the remaining low-risk items to a batch.
- Include a recommended answer when useful.
- Explain briefly why the question matters for PRD quality or implementation safety.
- Inspect local code/docs before asking when the answer can be discovered.
- If the user uses a vague or overloaded term, propose a precise canonical term and ask for confirmation.
- If local code/docs contradict the user's statement, surface the contradiction and ask which source should govern.
- Do not ask questions that do not affect PRD quality or implementation safety.
- Treat "I don't know" as a valid answer and record it as an open question.
- Do not repeat a question.
- If unresolved, record a default assumption, `deferred`, or `blocking` and move on.
- Preserve free-text answers that carry reasoning, constraints, or scope.
- If structuring a free-text answer may lose intent, confirm the structure before relying on it.
- If one branch dominates several questions, zoom back out and check other unresolved axes before going deeper.
- Every 2 to 3 user answers, run a local adversarial misunderstanding check and use it to choose the next question or record an ambiguity.
- Before handoff, restate the agreed goal in one sentence and confirm that another agent would build the intended outcome from that line.

## Documented Domain Checks

Use documented-domain checks when domain language, existing documentation, or brownfield behavior can change PRD meaning.
This axis is often `watch`; select it only when terminology, documented decisions, or code/docs contradictions matter for requirements quality.

- Inspect `CONTEXT.md`, `CONTEXT-MAP.md`, `docs/`, `docs/adr/`, and context-specific docs only enough to detect terminology, boundary, or documented-decision conflicts.
- Do not create or mutate `CONTEXT.md`, ADRs, or docs by default.
- Record resolved terms and decisions in `qa-log.md`.
- Update docs only when the user explicitly asks or the repo workflow requires docs edits during intake.
- If a user term conflicts with docs or glossary language, ask which meaning should govern.
- Offer an ADR only when the decision is hard to reverse, surprising without context, and the result of a real trade-off.

## Artifacts

Create a topic directory:

```text
agents/intake/<topic-slug>/
  qa-log.md
  prd-handoff.md
```

Use short kebab-case topic slugs.
If the user provides a name, normalize it instead of inventing a different one.

## qa-log.md Shape

Use this structure.
Keep raw capture lightweight during Q&A, then complete the normalized sections at checkpoint and final backfill time.

```markdown
---
topic: "<topic>"
status: "active | paused | complete"
target_handoff: "prd"
where: "greenfield | brownfield | docs-only | unknown"
created_at: "YYYY-MM-DD"
updated_at: "YYYY-MM-DD"
question_count: 0
normalization_policy: "raw-capture-with-checkpoint-backfill"
normalization_checkpoint_every: 10
final_auditor_agent_id: "<agent-id | none>"
final_auditor_status: "pending | pass | fail | unavailable | skipped"
---

# Intake Q&A Log: <topic>

## Current Understanding

## Intake Cursor

- next_question:
- latest_misunderstanding_check:
- outstanding_raw_entries:
- next_checkpoint_at:

## Axis Map

| Axis | Track | Why | Closure status | Evidence / notes |
| --- | --- | --- | --- | --- |
| Product | selected / watch / not-selected |  | open / resolved / assumption / deferred / blocking |  |
| Scope | selected / watch / not-selected |  | open / resolved / assumption / deferred / blocking |  |
| UX/design | selected / watch / not-selected |  | open / resolved / assumption / deferred / blocking |  |
| Technical | selected / watch / not-selected |  | open / resolved / assumption / deferred / blocking |  |
| Verification | selected / watch / not-selected |  | open / resolved / assumption / deferred / blocking |  |
| Risk | selected / watch / not-selected |  | open / resolved / assumption / deferred / blocking |  |
| Operation | selected / watch / not-selected |  | open / resolved / assumption / deferred / blocking |  |
| Documented-domain | selected / watch / not-selected |  | open / resolved / assumption / deferred / blocking |  |

## Raw Q&A

### Q1: <short label>
- axis:
- status: raw-captured | normalized | assumption | deferred | blocking | open
- asked:
- recommended:
- answer:
- immediate_notes:
- needs_normalization: true | false

## Normalized Decisions, Assumptions, And Open Questions

- confirmed:
- assumptions:
- blocking for PRD:
- deferred to implementation:
- human taste or approval:

## Evidence From Code Or Docs

## Documented Domain Checks

- docs inspected:
- canonical terms:
- glossary/code conflicts:
- concrete scenarios tested:
- docs mutation:
- ADR candidate:

## Checkpoint History

### Checkpoint N
- after_question:
- normalized_entries:
- axis_changes:
- misunderstanding_check:
- remaining_raw_entries:

## Audit History

### Audit N
- type: local | final-auditor
- auditor_agent_id:
- result: pass | fail | unavailable | skipped
- ambiguity:
- highest-risk assumption:
- final-blocking-question:
- handoff impact:
- fallback reason:
```

## prd-handoff.md Shape

```markdown
# PRD Handoff: <topic>

> Date: YYYY-MM-DD
> Source: `agents/intake/<topic-slug>/qa-log.md`

## Clear Outcome

## Axis Decisions

## Domain Terms And Documented Decisions

## Requirement Seeds

## Non-Goals

## Pre-Work And Human Decisions

## Major Technical Structure Signals

## Test And Verification Seeds

## Risks, Side Effects, And Sensitive Data

## Human Review Needed

## Open Questions

## Suggested Next Step

`$ho-spec --context agents/intake/<topic-slug>/prd-handoff.md "<topic>"`
```

## Loop

1. Mirror the current understanding in 2 to 4 bullets.
2. Create `qa-log.md` before Q1 with current understanding, provisional axes, and Q1 rationale.
3. Apply risk escalation and required node checks.
4. Ask the next main-agent-authored question, or a batched default-assumption
   block when the pending items are low-risk confirmations.
5. On each answer, raw-capture the answer in `qa-log.md`, update the cursor, and ask the next question.
6. Every 2 to 3 answers, run the misunderstanding check and record it in raw or normalized form.
7. Every 10 answered questions, checkpoint-backfill outstanding raw entries before continuing.
8. For high-risk intake, checkpoint Risk, Operation, and Verification every 2 to 3 answers or immediately after material risk answers.
9. When the handoff seems good enough, restate the agreed goal in one sentence and get confirmation.
10. Run final backfill, quality gate, and final auditor closure check or recorded local fallback.
11. If closure finds a material blocker, ask one final blocking question or classify it as `blocking` or `deferred`.
12. If closure passes or blockers are explicitly classified, write `prd-handoff.md` and point to `$ho-spec`.

## Closure Matrix

Before handoff, every selected or risk-escalated axis and material node must be classified:

```markdown
## Axis Closure Matrix

| Axis | Node | Status | Evidence type | PRD impact | Blocking/deferred rationale |
| --- | --- | --- | --- | --- | --- |
| Product | success | resolved / assumption / deferred / blocking | user / code / docs / research / none |  |  |
| Scope | non-goals | resolved / assumption / deferred / blocking | user / code / docs / research / none |  |  |
| UX/design | state/access | resolved / assumption / deferred / blocking | user / code / docs / research / none |  |  |
| Technical | security/compatibility | resolved / assumption / deferred / blocking | user / code / docs / research / none |  |  |
| Verification | required proof | resolved / assumption / deferred / blocking | user / code / docs / research / none |  |  |
| Risk | sensitive boundaries | resolved / assumption / deferred / blocking | user / code / docs / research / none |  |  |
| Operation | pre-work/launch gate | resolved / assumption / deferred / blocking | user / code / docs / research / none |  |  |
| Documented-domain | glossary/docs decision | resolved / assumption / deferred / blocking | user / code / docs / research / none |  |  |
```

Do not hide uncertainty.
If an axis matters but is not answerable during intake, mark it as `blocking` or `deferred` and carry it into `prd-handoff.md`.
Do not mark high-risk unknowns as `assumption` unless the assumption is explicit, low-blast-radius, and accepted by the user.

## Final Auditor

Before writing `prd-handoff.md`, run one strict final audit when the intake is non-trivial, subagent tools are available, and the user has not opted out.
"Non-trivial" means any of: 3 or more expected PRD-level tasks, DB schema or migration changes, auth/security surfaces, payments or billing, external services or credentials, production data, or scope that spans more than one working session.
Spawn one fresh independent auditor for that closure check.
Send a compact, self-contained audit packet with `qa-log.md` path, selected axes, closure matrix, current understanding, decisions, assumptions, deferred items, blockers, open questions, evidence limits, and proposed handoff summary.

The final auditor returns:

- `Status: PASS | FAIL`.
- Missing ambiguity by axis.
- Unsupported assumptions.
- User-intent drift risk.
- Missing axis closure.
- Highest-risk blocker.
- One exact final blocking question if the handoff should not proceed.
- Handoff readiness verdict.

The final auditor must not ask the user directly, write files, maintain `qa-log.md`, make product decisions, generate the PRD, or expand the task beyond intake closure.
Record the final audit in `qa-log.md`.
If subagent tools are unavailable, the intake is trivial, or the user opted out, run the same closure audit locally and record the fallback reason.

## Quality Gate

Before writing `prd-handoff.md`, verify:

- All raw Q&A needed for handoff has `needs_normalization: false`.
- Product reason, target user, scope, non-goals, and success criteria are clear enough for PRD.
- Major technical structure signals are explicit, even if the answer is "none".
- Required verification methods are seeded or listed as open questions.
- Domain terms and documented-decision conflicts are resolved, deferred, or listed as open questions when relevant.
- Human decisions and pre-work are separated from implementation details.
- Risks, side effects, credentials, PII, external services, and production data boundaries are explicit when relevant.
- Open questions are classified as `blocking`, `deferred`, or human taste/approval.
- Selected and risk-escalated axes have entries in the Axis Closure Matrix.
- Material user decisions, accepted proposals, rejected options, deferred choices, and open decision blockers are captured in `qa-log.md` and reflected in `prd-handoff.md`.
- The latest misunderstanding check has been answered, resolved, or recorded as `blocking` or `deferred`.
- The final auditor or local closure audit has no material unresolved blocker, or the blocker is explicitly listed in `prd-handoff.md`.
