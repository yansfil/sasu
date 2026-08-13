---
name: implement
description: |
  Project-local approved-PRD implementation orchestrator.
  Use when the user invokes "$implement", explicitly asks to execute an approved
  PRD through the receipt-backed workflow, or wants PRD tasks implemented and
  proven through one unified verification command.
  Do not use for ordinary implementation requests that have no approved PRD.
---

# implement

Use this skill to implement an approved PRD end to end.
Match the user's language by default.

The public closing flow is intentionally small:

```text
implementation complete
  -> final evidence registered
  -> sasu implement verify
  -> sasu implement finalize
```

`state.json` is the only machine record.
`receipt.json` and `implementation-result.md` are derived outputs.

## Reference Routing

Read each directly linked reference completely when its condition applies.

| Reference | Read when |
| --- | --- |
| [`references/execution-planning.md`](references/execution-planning.md) | Before implementation, while closing tasks, or when execution order is unclear. |
| [`references/verification-and-evidence.md`](references/verification-and-evidence.md) | Before capturing or registering final runtime evidence and before unified verify. |
| [`references/reviews-and-finalization.md`](references/reviews-and-finalization.md) | Before unified verify, finalize, or a blocked handoff. |
| [`references/worktrees-and-delivery.md`](references/worktrees-and-delivery.md) | When delivery is `pr`, a worktree is configured, or post-receipt delivery is requested. |

## Core Invariants

- Never implement a pending PRD without explicit human approval or the user's verbatim conversational approval.
- Treat Major Technical Structure Changes as the approved structure boundary.
- Do not add unmapped scope, services, schemas, external calls, destructive actions, or compatibility paths.
- Verification proof is never reduced to save ceremony.
- The CLI executes deterministic verification before any LLM judge.
- Acceptance and fidelity are separate LLM calls and neither consumes the other's result.
- Required verification must be a fresh PASS on the current source and registered evidence.
- `sasu implement finalize` never runs tests, judges, capture tools, or external commands.
- `state.json` is the completion authority; the receipt is its portable derived proof.
- Commit, push, PR creation, CI, and merge are post-receipt delivery outcomes.

## 1. Confirm Readiness

Before editing:

1. Read the complete PRD.
2. Confirm `status: ready`.
3. Confirm `human_approval: "approved"` or preserve the user's exact `$implement ...` instruction as conversational approval.
4. Resolve all pre-work and human decisions in section 4.
5. Read the structure lock, risks, and guardrails.
6. Inspect `git status --short` and preserve unrelated changes.
7. Read likely implementation files before editing.

Stop for unresolved product decisions, credentials, production data, billing, destructive migrations, irreversible deployment, or a material structure deviation.

## 2. Start The Run

Do not create a Codex Goal unless the user explicitly requested goal tracking.

Start the machine record from the repository root:

```sh
sasu implement start --prd agents/prd/<topic-slug>/prd.md
```

When approval exists only in conversation, record it verbatim:

```sh
sasu implement start \
  --prd agents/prd/<topic-slug>/prd.md \
  --allow-unapproved-prd '<verbatim user approval>'
```

Inspect current state with:

```sh
sasu implement status
```

Old implement state schemas are intentionally unsupported.
Start a new run instead of migrating or adapting them.

## 3. Implement Tasks

Execution order comes from the PRD's task dependencies.
A task without a `Depends on:` clause depends on the previous task, so a plain task list runs sequentially; explicit `Depends on:` declarations (approved with the PRD) are the only thing that unlocks out-of-chain order.
The CLI rejects closing a task before its dependencies are complete, and each close response lists the remaining tasks with which are `ready`.

Tasks whose dependencies are all complete may be implemented in any order, including concurrently through worker subagents.
When fanning out, this session remains the orchestrator: brief each worker with the mapped requirement, acceptance criteria, and file scope directly; workers return changed files, focused check results, and evidence text.
Workers never run `sasu` commands — the orchestrating session reviews each result and closes the task itself, staying the only writer of `state.json`.

For each task:

1. Re-read the mapped requirement and acceptance criteria.
2. Make the smallest complete change.
3. Run a focused development check when useful.
4. Close the task with concrete implementation evidence.

```sh
sasu implement task \
  --id T1 \
  --status complete \
  --evidence '<files and focused result>'
```

Closing a task means only that its implementation obligation is complete.
It does not mark acceptance criteria or verification as passed.

## 4. Register Final Runtime Evidence

The agent or an appropriate tool creates screenshots, API traces, DB captures, or other runtime evidence.
The CLI never creates those artifacts.

Register final evidence after the implementation is coherent and before unified verify:

```sh
sasu implement artifact \
  --id V3 \
  --kind screenshot \
  --path docs/screenshots/example.png \
  --description '<what this proves>'
```

Registration pins the file hash and current source fingerprint in `state.json`.
Changing the artifact or judged source makes the evidence stale.

Development-time screenshots and logs may remain temporary when they are not final evidence.

## 5. Unified Verify

After every task is closed and final evidence is registered, freeze implementation content and run:

```sh
sasu implement verify
```

The CLI owns this order:

1. Validate PRD, state, tasks, artifacts, and freshness.
2. Run deterministic prelint and mechanical commands.
3. Stop before LLM calls when mechanical proof fails.
4. Run the acceptance judge and fidelity judge concurrently as separate calls.
5. On `high-risk`, run one final risk judge after both base lanes finish.
6. Record the input fingerprint, lane verdicts, findings, errors, and timing in `state.json`.

Acceptance judge responsibility:

- Decide whether code and registered evidence satisfy every acceptance criterion.
- Receive the relevant mechanical output and text artifact bytes directly from the harness.
- Inspect only the exact run-owned changed files and visual artifacts placed in the disposable evidence workspace; execution, writes, broad file discovery, history inspection, and web access remain disabled.
- Cite concrete changed files, mechanical output, or registered artifacts actually used.

Fidelity judge responsibility:

- Decide whether the original goal, accepted decisions, constraints, rejected choices, non-goals, deviations, and completion claims preserve intent.
- Use a fixed rubric with context selected from the current PRD source situation.
- Do not repeat per-verification artifact sufficiency or code correctness judgment.

For a conversation-only PRD, Decision Traceability is the canonical intent source because the CLI cannot read chat history.
For a qa-log PRD, full qa-log is used unless a fresh spec gate already settled the qa-log to PRD leg.

Do not automatically retry a generative judge.
A new explicit verify command creates a new attempt.

## 6. Finalize

Finalize only after unified verify returns a fresh PASS:

```sh
sasu implement finalize
```

Finalize reads state and hashes only.
It rejects open tasks, unmet acceptance criteria, non-PASS verification, stale source, stale artifacts, missing high-risk risk PASS, and malformed state.
It does not run tests, judges, browser tools, capture tools, or other subprocesses.

Running finalize twice with the same input returns the same completed result without creating another verification attempt.

Do not report Done until:

- `receipt.json` exists.
- `implementation-result.md` exists.
- `sasu implement status` reports complete.
- required verification is fresh PASS.

## 7. Blocked Handoff

If required proof cannot pass, do not finalize and do not claim completion.
Report:

- the failed stage.
- the observable error and recovery.
- which tasks, ACs, or verification items remain open.
- whether source or artifact evidence is stale.
- whether the judge provider is unavailable.

Do not use overrides on the user's behalf.

## Hard Stops

Stop and ask when:

- approval or required pre-work is unresolved.
- the requested fix changes the approved structure or product behavior.
- credentials, billing, production data, destructive changes, or irreversible deployment are required.
- a required verification failure needs a product decision.
- delivery would push or open a PR without authorization.

## Final Report

Follow the PRD's Implementation Result Report Contract.

At minimum report:

- Status: Done, Partially Done, or Blocked.
- Public command and user-visible behavior changes.
- Actual module boundaries and removed legacy paths.
- Task and acceptance-criterion status.
- Verification evidence by mode.
- Acceptance, fidelity, and optional risk invocation IDs, verdicts, and timing.
- Evidence that mechanical failure made zero judge calls.
- Evidence that finalize made zero execution calls.
- Completion fingerprint and receipt path.
- Deviations and remaining risks.
