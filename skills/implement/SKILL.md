---
name: implement
description: |
  Project-local approved-PRD implementation orchestrator.
  Use when the user invokes "$implement", explicitly asks to execute an approved
  PRD through the receipt-backed workflow, or wants PRD tasks turned into an
  execution plan, TaskGraph, verification evidence, profile-aware reviews, and
  a strict completion receipt.
  Do not use for ordinary implementation requests that have no approved PRD.
---

# implement

Artifacts live under the visible `agents/` namespace at `agents/implement/**` and `agents/implement/.prd-implement-active.json`.
A legacy `.hoyeon/implement/**` tree from older runs remains readable as a fallback.

Use this skill to implement an approved PRD end to end.
This is the execution counterpart to `gen-prd`.
It turns a human-reviewed PRD into implementation state, execution nodes, verification evidence, profile-aware reviews, and a strict receipt.
Match the user's language by default.

## Inputs

Prefer an explicit PRD path:

```text
agents/prd/<topic-slug>/prd.md
```

If none is provided, inspect `agents/prd/` for the matching or most recent PRD.

Current PRDs should include:

- `## 4. Pre-Work And Required Decisions`.
- `## 5. Major Technical Structure Changes`.
- `## 7. Acceptance Criteria`.
- `## 8. PRD-Level Tasks`.
- `## 9. Verification Contract`.
- `## 10. Risks And Open Decisions`.
- `## 11. Implementation Guardrails`.
- `## 12. Implementation Result Report Contract`.

Current PRDs use one `prd.md`, an inline semantic self-check, and the stateless Harness Readiness Gate.
Legacy PRDs may have `intent-scope-audit.md` or `verification-contract-audit.md`; read those files when present.

Stop when required pre-work, human approval, credentials, migration windows, production data, or product decisions remain unresolved.

The agent owns semantic review-profile judgment after reading the complete PRD and relevant repo context.
Current PRDs declare `review_profile` and `review_rationale`; the harness validates that contract and defaults a missing declaration to `standard` instead of trying to understand natural language with regex.
Use `trivial` only when no user-visible behavior, runtime contract, persistent data, access boundary, external side effect, or delivery risk changes.
Use `standard` for normal engineering work and all small user-facing changes, and `high-risk` for sensitive, destructive, irreversible, or production-affecting work.
Initialization captures the dirty-worktree baseline in `initialWorktreeSnapshot`, and the final result compares it with the receipt snapshot so unrelated existing changes remain auditable.

## Reference Routing

The entrypoint owns lifecycle ordering, hard stops, primary commands, and completion authority.
Read each directly linked reference completely when its condition applies.
References do not require nested reference chasing.

| Reference | Read when |
| --- | --- |
| [`references/execution-graph.md`](references/execution-graph.md) | Before `plan-execution`, during node implementation or subagent assignment, when modifying this skill, or when diagnosing TaskGraph, roll-up, and parallel behavior. |
| [`references/verification-and-evidence.md`](references/verification-and-evidence.md) | Before `plan-verification`, before running any required `V#`, and whenever runtime evidence is recorded, replaced, refreshed, or rejected. |
| [`references/reviews-and-finalization.md`](references/reviews-and-finalization.md) | Before the acceptance sweep, requirements fidelity review, final adversarial review, receipt finalization, or blocked and partial handoff. |
| [`references/worktrees-and-delivery.md`](references/worktrees-and-delivery.md) | When `agents/config.json` exists, delivery is `pr`, worktrees are enabled, an existing run is resumed, session binding needs diagnosis, or a local active pointer must be cleaned. |

## Core Invariants

- Never implement a pending PRD without explicit human approval or a verbatim approval deviation allowed by the calling workflow, such as `$please`.
- Treat Major Technical Structure Changes as the approved structure lock and pause before material deviation.
- Do not add unmapped scope, hidden user flows, unapproved services, schemas, external calls, or destructive actions.
- Only the coordinator mutates harness state, reconciles subagents, applies final edits, and records completion outcomes.
- Every required verification item must pass with valid artifact-backed evidence from the actual run.
- Requirements fidelity reads the complete canonical intake qa-log when the PRD references one and compares qa-log intent through the PRD to the implementation result.
- Requirements fidelity review precedes final adversarial review when the effective policy requires both, and source or evidence changes make affected reviews stale.
- `receipt.json` is the only implementation completion proof; Goal state and chat claims merely mirror it.
- PR creation, CI, and merge are post-receipt delivery outcomes and never required implementation verification.

## Output Artifacts

Harness-managed state and views:

```text
agents/implement/<topic-slug>/checklist.md
agents/implement/<topic-slug>/verification-plan.json
agents/implement/<topic-slug>/verification-plan.md
agents/implement/<topic-slug>/execution-plan.json
agents/implement/<topic-slug>/execution-plan.md
agents/implement/<topic-slug>/taskgraph.json
agents/implement/<topic-slug>/taskgraph.md
agents/implement/<topic-slug>/state.json
agents/implement/<topic-slug>/ledger.jsonl
agents/implement/<topic-slug>/verification.md
agents/implement/<topic-slug>/artifacts/manifest.jsonl
agents/implement/<topic-slug>/receipt.json
agents/implement/<topic-slug>/implementation-result.md
agents/implement/.prd-implement-active.json
agents/implement/.prd-implement-sessions/<encoded-session-id>.json
```

Agent-created notes, reviews, and evidence:

```text
agents/implement/<topic-slug>/context-notes.md
agents/implement/<topic-slug>/artifacts/logs/*.log
agents/implement/<topic-slug>/artifacts/screenshots/*
agents/implement/<topic-slug>/artifacts/browser/*
agents/implement/<topic-slug>/artifacts/api/*
agents/implement/<topic-slug>/artifacts/db/*
agents/implement/<topic-slug>/review/requirements-fidelity-review.md
agents/implement/<topic-slug>/review/final-review.md
```

## Required Flow

```text
goal tracking opened
  -> PRD Verification Contract
  -> Verification Planner
  -> Execution Plan
  -> TaskGraph
  -> main-agent coverage check
  -> ready node implementation
  -> verify-run / record-artifact
  -> requirements fidelity review
  -> blocked/partial handoff when completion is impossible
  -> final adversarial review when required
  -> runtime cleanup
  -> receipt
  -> PR delivery handoff when delivery mode is pr
```

## 1. Confirm Readiness

Before editing:

1. Read the PRD and confirm `status: ready`.
2. Confirm `human_approval: "approved"` or obtain the verbatim approval deviation authorized by the calling workflow.
3. Never set human approval yourself; when the user explicitly approves in conversation, either update frontmatter with that quoted approval in the implementation notes or pass the exact approval to `init --allow-unapproved-prd`.
4. Confirm blocking pre-work and human decisions are resolved.
5. Treat Major Technical Structure Changes as the approved structure lock.
6. Read legacy side audits when they exist and stop on unresolved failures unless the user explicitly accepts the risk.
7. Read Implementation Guardrails and Risks.
8. Read `agents/config.json` when it exists.
9. Run `doctor` when delivery, worktree sync, or PR and CI readiness is uncertain.
10. Inspect `git status --short` and preserve unrelated changes.
11. Read the files likely to be touched before editing.

For files around 1000 lines or longer, use `rg` to locate relevant functions or sections and read only those ranges.
Avoid repeatedly loading whole large files because context loss can force costly re-reads.

If delivery is `pr`, the implementation receipt proves implementation completion, but the user-facing workflow remains open until `$ship` creates or updates the PR and required CI passes or delivery is explicitly blocked.

Pause before material structure deviations, unmapped scope, production data, credentials, destructive DB changes, billing, or irreversible deployment actions.

## 2. Start Goal Tracking

Use the runtime Goal or task surface as lifecycle and progress control.
It never replaces the receipt.

With Codex Goal tools:

1. Call `get_goal`.
2. Create a Goal for the PRD when none exists.
3. Continue an active Goal only when it is the same implementation.
4. Ask before replacing or mixing an unrelated Goal.
5. Use `update_plan` only as a progress mirror.
6. Do not call `update_goal complete` before a successful complete receipt and any required PR delivery handoff.
7. For blocked or partial handoff, follow the Goal tool's own blocked-status contract and never claim completion.

In Claude Code, apply the same rules to TaskCreate and TaskUpdate.
Do not complete the final task before the receipt exists and any required PR delivery handoff is complete or explicitly blocked.

When no Goal or task tools exist, record that limitation in `context-notes.md` or the final report.

## 3. Initialize State

From the target repository root, initialize and inspect status:

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js init --prd <prd-path>
node ~/.codex/skills/implement/scripts/prd_state_harness.js status
```

For conversational approval, pass its exact text through `--allow-unapproved-prd`.
Initialization fails when PRD approval is pending and no allowed deviation is recorded.

Bind a session ID and handle PR delivery or worktrees according to `references/worktrees-and-delivery.md` when those conditions apply.

The harness extracts PRD-level tasks, acceptance criteria, verification items, test modes, and structure locks into durable state.
It records the PRD's agent-declared `trivial`, `standard`, or `high-risk` profile, with `standard` as the safe missing-value fallback.
Read `references/reviews-and-finalization.md` for the exact gate owned by each profile and override only a genuinely wrong semantic judgment.

`init` refuses to overwrite existing state without `--force`.
Use `--force` only when the user explicitly requests a clean restart.

## 4. Plan Before Implementation

Plan verification first:

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js plan-verification
```

Do not implement while the verification plan has blocking gaps.
Read `references/verification-and-evidence.md` for planner semantics, command binding, evidence classes, and safe live-proof rules.

Then plan execution and inspect ready work:

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js plan-execution
node ~/.codex/skills/implement/scripts/prd_state_harness.js ready
```

When parallel execution is enabled and a useful split exists, inspect the repo and pass one explicit task-plan JSON file to `plan-execution --task-plan <path>`.
Do not put file ownership or low-level dependencies in the PRD.
Without an explicit task plan, nodes remain safely sequential.

Perform the main-agent coverage check before editing.
Inspect intent sources, verification coverage, execution nodes, TaskGraph gates, ambiguity, structure-lock drift, and unmapped scope.
Record material findings in `context-notes.md` and stop on a material blocker.
Use `references/execution-graph.md` for node fields, roll-ups, deviations, and parallel guidance.

## 5. Implement Ready Nodes

Work only on ready nodes unless an equivalent order is recorded as a deviation.
For each node, re-read relevant files, make the smallest mapped change, record material decisions, run a focused check, and attach evidence.

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js mark-node \
  --id N1 \
  --status complete \
  --evidence "<file/test/runtime evidence>"

node ~/.codex/skills/implement/scripts/prd_state_harness.js mark \
  --kind ac \
  --id AC1 \
  --status met \
  --evidence "<evidence>"
```

Task completion rolls up from nodes, mapped acceptance criteria, and verification.
Do not manually close a task merely because one node is done.

Parallelize only when an agent-declared task plan and `ready` both say the work is safe and the split is useful.
Give subagents bounded, disjoint ownership and keep reviewers read-only.
The coordinator remains responsible for reconciliation, verification, and every harness state mutation.

## 6. Verify And Register Evidence

Run shell verification through the harness:

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js verify-run \
  --id V1 \
  -- <exact command>
```

Register browser, API, DB, or runtime evidence immediately after the actual run:

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js record-artifact \
  --id V3 \
  --kind screenshot \
  --path <path> \
  --description "<what this proves>"
```

Use `chromux` for browser QA when available.
Required verification is not complete without a passing status and a valid evidence kind.
Do not use self-authored summaries or harness state files as proof.

Read `references/verification-and-evidence.md` for exact-command deviations, cost-bearing benchmark controls, artifact placement, registration, hash refresh, and required-verification semantics.

## 7. Review And Finalize

Sweep every acceptance criterion before review and keep working while a required criterion is unmet without a concrete blocker.

Generate and complete requirements fidelity first:

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js requirements-review-prompt
node ~/.codex/skills/implement/scripts/prd_state_harness.js requirements-review-record \
  --status pass \
  --report agents/implement/<topic-slug>/review/requirements-fidelity-review.md \
  --summary "<verdict>"
```

For `trivial`, the main agent performs a compact fidelity review.
For policy v2 `standard`, a fresh independent read-only reviewer performs the single combined fidelity review when multi-agent tools are available, while the coordinator alone records it.
For `high-risk` and legacy `standard`, the main agent performs full fidelity before the required independent final review.
Every fidelity review must compare the complete original qa-log or conversation source, accepted and rejected decisions, PRD scope, acceptance criteria, registered evidence, and the claimed result.
Do not use a handoff summary or the harness's parsed intent sample as a substitute for reading the canonical source.
Fail when a material answer, accepted recommendation, objection, constraint, rejected option, non-goal, or assumption is lost or changes provenance across `qa-log -> PRD -> implementation`.
Harness-owned mechanical gates remain authoritative, so reviewers rerun full suites or hashes only when recorded evidence is inconsistent, missing, or suspicious.

When the review profile requires a final adversarial review, generate its prompt after recording fidelity and use a fresh independent read-only sidecar when multi-agent tools are available.

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js review-prompt
node ~/.codex/skills/implement/scripts/prd_state_harness.js review-record \
  --status pass \
  --report agents/implement/<topic-slug>/review/final-review.md \
  --summary "<verdict>"
```

Stop verification-only runtime processes before finalization or final review unless an explicit exception is recorded.
Any source, plan, evidence, artifact, or deviation change after a passing review makes affected reviews stale.

Read `references/reviews-and-finalization.md` for required report sections, artifact audits, freshness, profile-specific depth, blocked and partial handoff, and completion checks.

After all gates pass, finalize:

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js finalize \
  --status complete \
  --summary "<evidence-backed summary>"
```

Do not report `Done` or complete the tracked Goal until `receipt.json` exists and `status` reports zero open tracked items.
For local delivery, clean active pointers after the receipt.
For PR delivery, continue through `$ship` according to `references/worktrees-and-delivery.md` before completing the tracked Goal.

## Hard Stops

Stop and ask when:

- required pre-work is incomplete.
- PRD status is not `ready` or approval is absent without an authorized verbatim deviation.
- work adds unmapped scope or changes the approved structure.
- credentials, billing, production data, destructive DB changes, or irreversible deploy steps are required but not approved.
- verification failure requires a product or structure decision.
- delivery would push or open a PR without configuration-based or conversational consent.

## Final Report

Use the PRD's Implementation Result Report Contract.
The generated `implementation-result.md` includes the effective policy matrix, approval and deviations, execution and verification evidence, initial-versus-final worktree scope, delivery boundaries, reviews, receipt, and the coordinator's existing `context-notes.md`.
At minimum report:

- Status: `Done`, `Partially Done`, or `Blocked`.
- user-visible changes.
- major technical changes and structure conformance.
- completed, deferred, and added tasks.
- acceptance-criterion status.
- verification evidence by test mode.
- automated tests added or updated and the regression risk each protects.
- requirements fidelity and final-review verdicts.
- delivery mode and, when `pr`, `$ship` status, PR URL, branch, and CI verdict.
- deviations.
- remaining human review.
- not-done items, risks, and follow-ups.
