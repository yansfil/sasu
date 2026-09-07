---
name: interview-me
description: |
  Project-local pre-PRD requirements interview.
  Use when the user invokes "$interview-me", asks to interview an idea,
  clarify or pressure-test requirements, reduce ambiguity, prepare a PRD
  source, or wants UX, behavior, scope, technical, verification, risk,
  operation, and documented-domain decisions captured before writing a PRD.
  Run low-latency main-agent-led Q&A with raw capture, decision tracking,
  targeted UX scenario coverage, periodic checkpoint backfill, and a final
  PRD-ready qa-log.
---

# interview-me

Use this skill before gen-prd when an idea needs a decision-quality interview.
Write artifacts under agents/interview/<topic-slug>/.
Do not implement code, write the PRD itself, create an execution plan, or mutate product implementation state.
Match the user's language by default.

## Core Contract

- Keep the interview fast.
- Ask only questions that change scope, behavior, acceptance, risk, implementation safety, or verification.
- Keep one canonical artifact only: qa-log.md.
- Own ordinary Q&A in the main agent.
- Do not spawn, retain, resume, or update subagents during ordinary questions.
- Closure judgment is owned by the sasu gap-audit gate; use one fresh independent auditor subagent only as the recorded fallback when the sasu binary or judge backend is unavailable.
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

The live Claude or Codex session JSONL is the raw source during ordinary Q&A.
The sasu interview CLI streams that file and owns transcript bindings, deduplication, Raw Q&A imports, counters, and cursor bookkeeping.
The agent owns question choice and checkpoint-time semantic normalization.
Never read or parse the session JSONL by hand, and never hand-edit the qa-log for a mutation an interview command can perform.
When a Decision Register row comes directly from the initial request rather than a later Q&A pair, use `user invocation: <runtime>:<session-id>:<start-ref>` copied from the bound Transcript Sources row; prelint accepts it only when the ref matches that boundary.

Create agents/interview/<topic-slug>/qa-log.md before Q1.
`init` automatically binds the current agent session and records the invocation message as the start boundary:

~~~sh
sasu interview init --slug <topic-slug> --topic "<topic>" --where <where> --packs "<packs>" --understanding "<one bullet per line>"
~~~

When the user explicitly sets a question count, add `--question-limit <n>` to this same init command.
Do not invent a numeric limit when the user did not provide one.
The cursor reports `questionBudgetReached` at the limit and `questionBudgetExceeded` when the transcript contains a later exchange.
An overage remains captured and non-blocking because a correction or closure response is not necessarily another question; stop asking, review the exchange, and pause only when the interaction budget was actually exceeded.

If automatic discovery is unavailable or you are deliberately recovering a known prior session, pass its JSONL explicitly with `--transcript <session.jsonl>`.
The explicit path is the override; do not pass it in a normal current-session flow.

Ordinary answered questions require no tool call and no qa-log write.
Keep the unresolved decision queue in the live conversation and ask the next question immediately.
At a checkpoint, on resume after interruption or compaction, and immediately before closure, import every completed assistant-text -> human-answer pair in one command:

~~~sh
sasu interview sync --slug <slug>
~~~

- `sync` reads JSONL line by line, ignores tool results, sidechains, system and developer messages, and imports only completed visible assistant text paired with the next human input.
- Every imported entry carries a stable `source_ref`; rerunning `sync` is idempotent and reports already-present turns without duplicating them.
- A resumed agent session is bound on its first `sync`; run it before asking the first resumed question so its invocation becomes the new start boundary.
- The CLI maintains question_count, updated_at, the Intake Cursor, outstanding_raw_entries, next_decision_id, and needs_normalization; never maintain them by hand.
- New raw entries start with `decision_ids: none`, `route: mixed`, and `needs_normalization: true` until their provenance and impact are normalized at a checkpoint.
- `decision_ids` is CLI-owned, not a checkpoint field: `interview decision` anchors a resolved, user-sourced decision (Kind `decision`, Status `resolved`, Source naming `user`/`사용자`) onto a Raw Q&A turn's `decision_ids` the moment it writes the Decision Register row. The default target is the most recently synced Q turn; pass `--anchor Q<n>` when the real exchange sits on an earlier turn instead, and `--anchor none` to record the row without an anchor. A decision that is not user-sourced never gets an anchor, with or without `--anchor`. Never hand-edit `decision_ids`.
- Every mutating interview command re-runs the structural prelint (closure-only rules excluded) and prints [drift] findings; fix drift immediately.
- `interview decision` also reports `[drift] interview-decision-cadence` once more than three separate conversation turns have each triggered a decision write since the last checkpoint.
That is the per-turn write pattern this section forbids: when it fires, stop writing between answers and batch the D# upserts at the next checkpoint.
A whole batch of upserts made at one checkpoint counts as the single turn it happens on, so a legitimate batch never trips it.
- Do not rewrite Current Understanding, UX Scenario Cards, Evidence, or checkpoint prose on every turn; batch them into the checkpoint.
- Do not make the user wait for capture or prose polishing between answers.

Count answered questions in the live conversation and checkpoint every 10 answers.
Normalize after every 2 to 3 answers for high-risk work.
High-risk work includes production data, migrations, PII, credentials, external APIs, payments, cost, legal or compliance, irreversible side effects, and user-facing launch gates.
Treat a checkpoint as due early when a P0 node is reopened or invalidated.
At a checkpoint, run `interview sync` first, read the newly imported entries once, upsert their material D# rows with `interview decision` (the anchor lands automatically), then batch-edit only the semantic fields code cannot infer: label, route, recommended, and immediate_notes.
Pass `--anchor Q<n>` on the `interview decision` call itself when the real exchange sits on an earlier turn than the one just synced, and `--anchor none` when a resolved user-sourced decision genuinely has no turn to anchor to (e.g. a pre-interview fact); do this at write time, not as a later hand-edit.
Then run one local intent, impact, and verification sweep over the resolved decisions.
The sweep's outcome is the `--gap` value: either no material gap or the one highest-impact follow-up; do not turn it into a second user interview.
Then record the checkpoint:

~~~sh
sasu interview checkpoint --slug <slug> --normalized pending --register-changes "<summary>" --reopened "<D#>" --gap "<highest remaining gap>"
~~~

For the ordinary checkpoint path, pass `--normalized pending` so the CLI snapshots and flips every currently outstanding entry after your semantic edits.
Never edit `needs_normalization` or `outstanding_raw_entries` yourself; the checkpoint command owns both fields.
Use an explicit list such as `--normalized "Q1,Q2"` only for a deliberate partial repair; naming an already-normalized entry aborts the whole checkpoint without writing anything.

Run a mandatory `interview sync` immediately before the final full normalization, even when the last checkpoint was recent.
Then mark qa-log.md complete and hand it to gen-prd.
If the sasu binary is unavailable, fall back to direct edits that follow the artifact template exactly and record that fallback in the log.

## On-Demand Coherence Check

Run the advisory coherence check only when the local checkpoint sweep identifies a concrete contradiction among resolved decisions or plausible drift from the stated goal:

~~~sh
sasu interview coherence --slug <slug>
~~~

This is an independent diagnostic - it has no access to the interview conversation and reads only the resolved decisions plus the Current Understanding summary, so it can test a specific direction-drift suspicion without inheriting the turn-by-turn framing that biases the interviewing agent.
It judges coherence, not completeness: it reports only contradictions among resolved decisions and drift away from the stated goal, never missing decisions (that is the closure gate's job).
It is advisory and never blocks: it does not touch gate state or the retry budget, a judge failure is safe to ignore, and it self-skips until at least three decisions are resolved.
Treat any finding as a high-priority next-question candidate - a P0 coherence finding means the interview may be building on an invalidated premise, so resolve it with the user before piling on more questions.
A PASS with no findings is the common, correct result; do not manufacture follow-ups from it.
Do not run it on routine checkpoints, merely because three decisions exist, or inside the answer-to-question path.

## Turn Protocol

The path from receiving an answer to asking the next question is the latency budget; everything else must stay out of it.

1. Interpret the answer in the live context and update the in-memory unresolved decision queue.
2. Ask the next question in the same reply without any qa-log, transcript, status, or decision command.
3. Run `interview sync` only when resuming, at a checkpoint, or before closure.
4. Repo or docs verification inside this path is at most one bounded lookup, and only when its result changes which question to ask next; batch anything broader into preflight or a checkpoint.
5. UX Scenario Cards, Evidence, and Current Understanding edits happen at their trigger but never between an answer and the next question unless the next question depends on them; otherwise fold them into the next checkpoint.
6. Between checkpoints, the live P0/P1 queue is the standing next-question queue; each checkpoint persists it into the Decision Register before the conversation proceeds.

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
Use Status only for lifecycle state; a permitted P2 adopted default is Kind `assumption` with Status `resolved`, not a separate status.

Only silently adopt a default when it is reversible, does not change user-visible behavior, scope, public or provider contract, data shape, auth, security, cost, or launch criteria, and has an explicit verification path.
Classify every silently adopted default as P2.
Never mark a P0 or P1 assumption resolved: ask for explicit user agreement and record it as a decision, convert exact repository evidence into a fact, or defer the assumption with an owner and revisit trigger.
Request explicit confirmation whenever a proposed resolution selects user-visible behavior, data lifecycle, a public or provider contract, compatibility or deprecation, auth or security, cost, or launch intent.
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

- Treat an explicit question-count limit or interview timebox as a hard interaction budget.
  When that budget is a question count, persist it with `interview init --question-limit <n>` so the cursor surfaces the boundary without a per-turn command.
  Never exceed it to satisfy coherence or gap-audit findings.
  At the limit, run the final sync and normalization, review whether any later captured exchange was a correction or closure response, audit once, record every remaining material gap, and mark the qa-log `paused` rather than asking another question or claiming PRD readiness.
  Do not convert unresolved user-visible, scope, data, provider, access, cost, or lifecycle gaps into agent defaults merely to close within the budget.
- Ask exactly one user-facing question at a time for P0 or P1 decisions, contradictions, UX choices that need judgment, and risk or operation questions.
- Batch 3 to 5 low-risk confirmations only when they satisfy the silent-default rule.
- Explain briefly why a question changes the outcome or proof.
- Include a recommended answer when it reduces cognitive load without concealing alternatives.
- Preserve free-text reasoning, constraints, non-goals, and objections.
- For a material free-text answer, normalize a Decision Packet before relying on it.
- Confirm the packet only when interpretation could lose intent or alter scope.
- `interview decision` anchors a resolved user-sourced decision onto a Raw Q&A entry automatically; use `--anchor none` only when the entry has no real turn to anchor to (a pre-interview fact, a repo-derived decision), and explain why in `immediate_notes`.
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

Record the packet as the imported entry's `immediate_notes` value during checkpoint normalization; the qa-log has no separate Decision Packets section.

## Artifacts

Use this qa-log.md structure.
The interview CLI creates it and owns the mechanical fields; the template below is the contract for the agent-owned sections (Current Understanding, UX Scenario Cards, Evidence, Documented Domain Checks) and the manual fallback when sasu is unavailable.
`## Audit History` and the frontmatter `status` are harness-owned: every `sasu gate gap-audit`, `gate spec`, `gate answer`, and `gate reopen` run records itself there, and never write into that section yourself.
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
question_limit: <positive integer only when explicitly set; omit otherwise>
normalization_policy: "transcript-sync-with-checkpoint-backfill"
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

## Transcript Sources

| Runtime | Session ID | Start ref |
| --- | --- | --- |
| codex | <session-id> | <invocation-message-ref> |

## Decision Register

| ID | Kind | Area | Decision / fact | Priority | Source / owner | Status | PRD mapping / revisit |
| --- | --- | --- | --- | --- | --- | --- | --- |

## Raw Q&A

### Q1: <short label>
- decision_ids:
- route: fact | user-decision | mixed | research
- source_ref: <runtime>:<session-id>:<human-message-ref>
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

## Audit History
~~~

## Loop And Closure

1. Mirror current understanding in 2 to 4 bullets.
2. Preflight the repository and classify relevant packs.
3. Create qa-log.md with `sasu interview init`, then seed the preflight facts as register rows with `interview decision`.
4. Ask the highest-impact unresolved decision, or a valid low-risk confirmation block.
5. Continue ordinary questions with no recording command; keep decisions in live context until the next checkpoint.
6. Create or refresh a UX Scenario Card as soon as a user-facing primary flow is in scope, outside the answer-to-question path when possible.
7. Every 10 answers, every 2 to 3 high-risk answers, or immediately when a P0 premise changes: run `interview sync`, batch-normalize the imported entries and Decision Register, run the intent, impact, and verification sweep, and record it with `interview checkpoint`; run `interview coherence` only if that sweep surfaces a concrete contradiction or goal-drift suspicion.
8. Before closure, restate the agreed goal in one sentence and confirm that another agent would build the intended outcome from that line.
9. Run `interview sync` again, then full normalization and `interview checkpoint`.
10. Run the sasu gap-audit gate. Fall back to one fresh independent read-only auditor subagent (in Claude Code, the default general-purpose subagent) or a recorded local fallback only when the `sasu` binary or its judge backend is unavailable.
11. If there is a material blocker, ask one exact blocking question or classify it as blocking or deferred in qa-log.md.
12. The gate marks qa-log.md `status: complete` when it seals PASS; once it has, suggest `$gen-prd --context agents/interview/<topic-slug>/qa-log.md "<topic>"`.

## Gap-Audit Gate (sasu)

Independent closure judgment is owned by the sasu CLI.
Run it after full normalization, before marking the qa-log complete:

~~~sh
sasu gate gap-audit --slug <topic-slug> --qa-log agents/interview/<topic-slug>/qa-log.md
~~~

The gate owns the mechanical document lint: it runs a deterministic prelint
(required sections, Decision Register integrity, dangling `decision_ids`,
frontmatter enums, open P0/P1 nodes) before the judge, so no separate
validator step is needed.
A `[prelint]` failure is a $0 structural defect with a rule ID and line
number: fix the document and re-run freely - prelint failures never call the
judge and never consume the retry budget.

- The gate keeps an open findings set, not a round budget. Every judged run ends in one of three states:
  - `BLOCK`: at least one open finding is agent-fixable (`requiresHuman: false`).
    Resolve every such finding in the qa-log, then re-run.
    The rerun judges only the findings still open (by their `F<n>` id) and may add a finding only in a lane whose Decision Register rows changed, so the set can only shrink.
  - `NEEDS_HUMAN`: every open finding needs a human decision.
    Ask the user the whole bundle in one message, record the decisions they give in the Decision Register, then record their words with `sasu gate answer --slug <topic-slug> --gate gap-audit --evidence "<the user's words>"`.
    That seals PASS without another judge call; do not re-run the gate to "confirm" an answer.
  - `PASS`: the cycle is sealed.
- A gap finding is not an answer; treat it only as evidence that a decision or source is missing.
- `requiresHuman: false` does not authorize resolution.
  Close such a finding only with an explicit user answer, exact repository evidence recorded as a fact, or a reversible P2 internal default that satisfies the silent-default rule.
  Otherwise ask one focused question or defer it with an owner and revisit trigger, then re-run.
- Never promote a judge recommendation into a user decision or strengthen its scope, duration, lifecycle, compatibility, security, cost, or launch policy beyond the cited answer.
- Prefer `--json` when consuming the result programmatically: it returns a structured object (top-level `contractVersion`, a `prelint` key separate from judge findings, verdict/attempt state) instead of scraping text.
- A finding marked `needs human decision` must go to the user; never invent the answer.
- Only a later explicit user change request may open another cycle with
  `sasu gate reopen --slug <topic-slug> --gate gap-audit --evidence "<the user's words>"`; it works on a sealed log too.
  Reopen evidence stays in the gate ledger and is supplied directly to the judge; reopening does not create a Raw Q&A answer or invalidate the sibling gate by itself.
  An operational approval requires no interview sync.
  If the user's words change a requirement, record the actual answer and normalize its decisions before re-running; those substantive edits still invalidate affected gates.
  `--grant-budget` retries only a repaired judge backend after its error streak; it never changes the open set.
- If the judge backend is unavailable, the gate fails closed; report the printed cause and recovery to the user, then use one fresh independent read-only auditor subagent (in Claude Code, the default general-purpose subagent) or a recorded local fallback as the closure audit.
- Never run `sasu gate override` yourself: the override is a user-only command, and the recorded deviation must carry the user's own reason.
- The gate records each run in the qa-log's `## Audit History` and moves `status` itself; report the printed result, and if the judge was unavailable and a fallback auditor was used, report that in the conversation rather than writing into the log.
- The PASS is pinned to the Decision Register's decision cells (id, kind, area, decision text, priority, status) and seals the review cycle: Q anchors, Audit History, frontmatter, and the Register's source and mapping cells may change afterwards without effect, while a changed decision makes `sasu gate status` report `STALE`, and the CLI refuses automatic re-judgment until the decision is restored or the user explicitly authorizes `gate reopen`.
- PASS may retain P2 advisory notes; record them without editing the qa-log merely to chase them.
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
- The gap-audit gate (or its recorded fallback audit) found no hidden material blocker.
