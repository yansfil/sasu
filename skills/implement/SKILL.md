---
name: implement
description: |
  Project-local approved-PRD implementation orchestrator.
  Use when the user invokes "$implement", explicitly asks to execute an approved
  PRD through the receipt-backed workflow, or wants PRD tasks turned into an
  execution plan, verification evidence, profile-aware reviews, and
  a strict completion receipt.
  Do not use for ordinary implementation requests that have no approved PRD.
---

# implement

Artifacts live under the visible `agents/` namespace at `agents/implement/**` and `agents/implement/.prd-implement-active.json`.
`agents/` is the only namespace the harness reads or writes.

Use this skill to implement an approved PRD end to end.
This is the execution counterpart to `gen-prd`.
It turns a human-reviewed PRD into implementation state, an executable task plan, verification evidence, profile-aware reviews, and a strict receipt.
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
- `## 6. Requirements`.
- `## 7. Acceptance Criteria`.
- `## 8. PRD-Level Tasks`.
- `## 9. Verification Contract`.
- `## 10. Risks And Open Decisions`.
- `## 11. Implementation Guardrails`.
- `## 12. Implementation Result Report Contract`.

PRDs use one `prd.md`, an inline semantic self-check, and the stateless Harness Readiness Gate.

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
| [`references/execution-planning.md`](references/execution-planning.md) | Before `plan-execution`, during task implementation or subagent assignment, when modifying this skill, or when diagnosing ready, deviation, and parallel behavior. |
| [`references/verification-and-evidence.md`](references/verification-and-evidence.md) | Before `plan-verification`, before running any required `V#`, and whenever runtime evidence is recorded, replaced, refreshed, or rejected. |
| [`references/reviews-and-finalization.md`](references/reviews-and-finalization.md) | Before the acceptance sweep, requirements fidelity review, final adversarial review, receipt finalization, or blocked and partial handoff. |
| [`references/worktrees-and-delivery.md`](references/worktrees-and-delivery.md) | When `agents/config.json` exists, delivery is `pr`, worktrees are enabled, an existing run is resumed, session binding needs diagnosis, or a local active pointer must be cleaned. |

## Core Invariants

- Never implement a pending PRD without explicit human approval or a verbatim approval deviation allowed by the calling workflow, such as `$please`.
- Treat Major Technical Structure Changes as the approved structure lock and pause before material deviation.
- Do not add unmapped scope, hidden user flows, unapproved services, schemas, external calls, or destructive actions.
- Only the coordinator mutates harness state, reconciles subagents, applies final edits, and records completion outcomes.
- Every required verification item must pass with valid artifact-backed evidence from the actual run.
- Requirements fidelity compares qa-log intent through the PRD to the implementation result; it reads the complete canonical qa-log unless a fresh spec-gate PASS settles the qa-log→PRD leg, in which case the generated prompt narrows the read to the PRD's Decision Traceability plus the implementation (see `references/reviews-and-finalization.md`).
- Requirements fidelity review precedes final adversarial review when the effective policy requires both, and source or evidence changes make affected reviews stale.
- `receipt.json` is the only implementation completion proof; Goal state and chat claims merely mirror it.
- PR creation, CI, and merge are post-receipt delivery outcomes and never required implementation verification.

## Output Artifacts

`state.json` is the single machine record: tasks, acceptance criteria,
verification items with evidence, both plans, and recorded deviations all live
inside it. There are no derived view files; `status` renders the current
picture on demand.

Ownership stays explicit:

- `executionPlan` owns execution units, dependencies, `writeScope`, and parallel coordination.
- `verificationPlan` owns commands, cwd, proof tools, evidence kinds, and repo-derived target and runtime strategies.
- `implementation-result.md` reports the file/module structure actually selected and its responsibility boundaries.

```text
agents/implement/<topic-slug>/state.json
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
  -> init (semantic verification and execution plans auto-built)
  -> main-agent coverage check
  -> ready task implementation
  -> verify-run binds exact command/cwd / record-artifact (covered ACs auto-met on verification pass)
  -> residue check + code freeze
  -> sasu verify gate ∥ requirements fidelity review (concurrent, read-only)
  -> blocked/partial handoff when completion is impossible
  -> final adversarial review when required
  -> runtime cleanup
  -> receipt (finalize re-runs required command verifications first)
  -> PR delivery handoff when delivery mode is pr
```

## 1. Confirm Readiness

Before editing:

1. Read the PRD and confirm `status: ready`.
2. Confirm `human_approval: "approved"` or obtain the verbatim approval deviation authorized by the calling workflow.
3. Never set human approval yourself; when the user explicitly approves in conversation, either update frontmatter with that quoted approval in the implementation notes or pass the exact approval to `init --allow-unapproved-prd`.
4. Dispose of every `## 4` pre-work item; `init` lists them all in `preWorkChecklist` and the Stop hook blocks the run while any is `pending` (section 3).
5. Treat Major Technical Structure Changes as approved system-boundary constraints, not a file-layout lock.
6. Read Implementation Guardrails and Risks.
7. Read `agents/config.json` when it exists.
8. Run `doctor` when delivery, worktree sync, or PR and CI readiness is uncertain.
9. Inspect `git status --short` and preserve unrelated changes.
10. Read the files likely to be touched before editing.

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
Keep the mirror lightweight: one task for the whole run, or at most one update per phase boundary.
Do not mirror every task, acceptance criterion, or verification item; harness state is the single bookkeeping surface and a second per-item tracker only burns turns.

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
It extracts every `## 4.1` pre-work bullet into `preWorkChecklist` without guessing what the prose means.
An approved PRD has already settled its `## 4.2` human decisions, so those rows start resolved with approval evidence.
Ask the user about ALL the `human` ones in ONE batched message (in Claude Code, one AskUserQuestion call listing every item) BEFORE starting task implementation, then record every item with `mark --kind prework --id <ids> --status human|agent|resolved --evidence "<what was asked/decided>"`.
The Stop hook refuses to advance the run past the first task mark while any item is still `pending`.
Record items the user defers as blockers on the affected tasks and proceed on unaffected tasks.
It records the PRD's agent-declared `trivial`, `standard`, or `high-risk` profile, with `standard` as the safe missing-value fallback.
Read `references/reviews-and-finalization.md` for the exact gate owned by each profile and override only a genuinely wrong semantic judgment.

`init` refuses to overwrite existing state without `--force`.
Use `--force` only when the user explicitly requests a clean restart.

If the PRD file changes after init, `status` reports a snapshot violation.
Recover with `reconcile`, never with `init --force`:

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js reconcile --reason "<why the PRD changed>"
```

`reconcile` refreshes the PRD snapshot in place: items whose definition is unchanged keep their status, evidence, and artifacts; items whose text changed reset to pending with an audit note; removed items are archived in full inside the recorded deviation.
`init --force` wipes every mark and forces a full re-marking pass, so it is only for a user-requested clean restart.

## 4. Plan Before Implementation

`init` already built both plans: the semantic verification plan from the PRD Verification Contract and the default sequential execution plan with `T#` to `AC#`/`V#` traceability.
Inspect the init output (or `status`) for blocking gaps and ready tasks.

Do not implement while the verification plan has contract-phase gaps or the execution plan has blocking gaps.
`needs_binding` is expected for greenfield command checks and does not block implementation.
Fix semantic PRD gaps with `reconcile`, then rerun the planner:

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js plan-verification
node ~/.codex/skills/implement/scripts/prd_state_harness.js plan-execution
```

Read `references/verification-and-evidence.md` for planner semantics, command binding, evidence classes, and safe live-proof rules.

After the repository contains a verifier, run it through the harness.
Immediately before invoking it, confirm the selected cwd and runner or package
script now exist.
The first run validates the cwd, binds the exact command and cwd into
`state.verificationPlan`, executes it, and makes a missing executable or script
an observable failed run.
Planning does not require greenfield executors to exist before implementation.
Later substitutions require a recorded deviation:

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js verify-run \
  --id <Vn> \
  --cwd <repo-relative-dir> \
  -- <command...>
```

When parallel execution is enabled and a useful split exists, inspect the repo and pass one explicit task-plan JSON file to `plan-execution --task-plan <path>`.
Do not put file ownership or low-level dependencies in the PRD.
Without an explicit task plan, tasks remain safely sequential.

Perform the main-agent coverage check before editing.
Inspect intent sources, verification coverage, the task plan and its gaps, ambiguity, structure-lock drift, and unmapped scope.
Record material findings in `context-notes.md` and stop on a material blocker.
Use `references/execution-planning.md` for task executor fields, deviations, and parallel guidance.

## 5. Implement Ready Tasks

Work only on ready tasks unless an equivalent order is recorded as a deviation.
For each task, re-read relevant files, make the smallest mapped change, record material decisions, run a focused check, and attach evidence.

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js mark \
  --kind task \
  --id T1 \
  --status complete \
  --ac AC1,AC2 \
  --evidence "<file/test/runtime evidence>"

node ~/.codex/skills/implement/scripts/prd_state_harness.js mark \
  --kind ac \
  --id AC5 \
  --status not_met \
  --evidence "<why the criterion is not satisfied>"
```

Batch related marks instead of running one command per item: `--id` accepts comma lists, and `mark --kind task --ac` closes a completed task plus the acceptance criteria its evidence proves in one call.
Do not hand-mark an AC `met` that covering verification will prove: the harness auto-mets a pending AC when its covering verification settles with a pass, so manual `met` is only for ACs whose proof genuinely lives outside the verification contract, and `not_met`/`blocked` stay manual judgments.
Every mark command already returns updated counts and the next item, so do not poll `status` between marks.

You close a task yourself, with evidence that its mapped acceptance criteria and verification are satisfied.
The receipt gates still refuse to finalize while any AC or required verification item is open, so a premature task mark cannot buy a complete receipt.

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
Browser QA must cover the state-dependent UI variants the acceptance criteria name (for example each status an admin row can be in), not only the happy path.
Required verification is not complete without a passing status and a valid evidence kind.
Do not use self-authored summaries or harness state files as proof.

Any verification, test, seed, or migration that writes to a database must target a disposable local or branch database.
`plan-verification` flags likely DB-touching checks with a `db-safety` warning; confirm the connection target once before the first such run.
A production connection string in a test path is a hard stop.

Read `references/verification-and-evidence.md` for exact-command deviations, cost-bearing benchmark controls, artifact placement, registration, hash refresh, and required-verification semantics.

### Verify Gate (sasu)

Per completed task, run only the project's mechanical checks (tests/lint;
$0, no judge). Then, after every code-changing task is complete and the
acceptance sweep has frozen the code, submit the full run diff to the sasu
verify gate once:

```sh
sasu verify --slug <topic-slug> --prd <prd-path> --base <baseline-ref>
```

The gate and the requirements fidelity review divide the semantic lane and
neither consumes the other's output, so never serialize them. Ownership and
concurrency are different axes: the review profile decides who writes the
fidelity review, not whether the gate waits for it.

- `trivial`: no sidecar; the main agent writes the compact fidelity review
  (gate concurrency is moot).
- `standard`: launch the independent read-only fidelity reviewer as a
  background sidecar and run `sasu verify` while it works; the coordinator
  records both results as they land.
- `high-risk`: fidelity is main-agent-owned, but that does not force
  serialization - run `sasu verify` in the background and write the full
  main-agent fidelity review while the gate runs; the required independent
  final adversarial review is spawned as a fresh read-only sidecar only
  after fidelity is recorded (it must still follow fidelity).

If the gate fails and the fix changes code, the fidelity review goes stale
under the normal freshness rule and re-runs; accept that occasional cost
instead of always paying a serial wait.

The gate judges the diff against the PRD's complete acceptance criteria and
enforces the timing itself: while the slug's implement state still has
pending or in-progress tasks, `sasu verify` refuses at zero cost (no attempt
recorded, no budget spent) - missing ACs would fail legitimately and burn the
retry budget. Finish or mark the tasks first; pass `--allow-open-tasks` only
when judging an intentionally partial diff is the point. The gate first runs a
deterministic PRD prelint (structure, dangling Covers references, uncovered
ACs, mode conformance), then the mechanical checks (config-declared commands
win; manifest detection is the fallback), and sends the diff plus the
acceptance criteria to an independent judge only after both pass.
A mechanical command whose latest `verify-run` pass was earned on the
identical tree fingerprint is not re-executed: the gate reuses that recorded
pass (same rule as finalize's reverification skip) and stamps the reused
verification ID on the run, so the honest flow of verify-running the suite
and then calling the gate on frozen code pays for the suite once.

- Exit 1 with a `[prelint]` failure: the PRD itself is structurally broken;
  fix the cited rule/line and re-run - no judge call, no mechanical run, no
  retry-budget attempt was spent.
- Exit 1 with a mechanical failure: fix the failing check; the judge was not
  consulted and no tokens were spent.
- Prefer `--json` when consuming gate results programmatically: it returns a
  structured object (top-level `contractVersion`, a `prelint` key separate
  from judge findings, per-criterion verdicts) instead of scraping text.
- Exit 1 with per-criterion semantic failures: address each cited criterion
  and re-run. The budget is N chances to fix and re-verify, not N identical
  retries - re-running with nothing changed is refused at $0 and spends no
  attempt. A refusal settles the identical question only: it names the base the
  verdict was judged against, so if that is not the commit the work started
  from, re-run with a corrected `--base` instead of closing out. When the
  printed retry budget is exhausted, or a re-run is refused and the base is
  right, stop and hand the findings to the user.
- Fail-closed judge errors report their cause and recovery; the gate stays
  blocked until it passes or the user overrides.
- Never run `sasu gate override` yourself: overrides are user-only, and
  the recorded deviation must carry the user's own reason.
- Record the gate's PASS (or the user's override) as task/AC evidence; the
  gate state lives under `agents/gates/<topic-slug>/`.
- Enforcement: `finalize` and the completion checks refuse a gate that ran
  and is BLOCKED, or whose PASS went stale because its inputs changed.
  A BLOCKED gate counts as the blocker itself once it is terminal - retry budget exhausted, or an identical re-run refused on the unchanged tree so the remaining budget is unspendable: `finalize --status blocked` is the honest exit, and the receipt stamps the gate snapshot (verdict, attempts, findings, terminal cause) without ever claiming a budget it did not spend.
  A gate that never ran does not block completion, but its `NOT_RUN` status
  is stamped into `receipt.json` and `implementation-result.md`, so skipping
  it is always visible and needs the recorded reason below.
- If the `sasu` binary is unavailable, record that limitation in
  `context-notes.md` and continue with the PRD verification contract alone.

## 7. Review And Finalize

Acceptance criteria close themselves: when every verification item covering a pending AC is settled and at least one passed, the harness marks it met with derived evidence (`autoMetAcceptanceCriteria` in the mark/verify-run output).
Before review, check only the residue - ACs still open mean uncovered contract or missing verification runs, and `not_met`/`blocked` remain manual judgments.
Keep working while a required criterion is unmet without a concrete blocker.

Generate requirements fidelity and run it concurrently with the sasu verify gate (both are read-only over the frozen code; fidelity precedes only the final adversarial review, not the gate):

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js requirements-review-prompt
node ~/.codex/skills/implement/scripts/prd_state_harness.js requirements-review-record \
  --status pass \
  --report agents/implement/<topic-slug>/review/requirements-fidelity-review.md \
  --summary "<verdict>"
```

When the user explicitly reduces or raises review scope mid-run (for example "리뷰 한번만 돌리고 마무리해"), record it with `review-policy --profile <profile> --reason "<their verbatim words>"` and follow the resulting effective policy instead of ignoring the request or silently skipping gates.

For `trivial`, the main agent performs a compact fidelity review.
For `standard`, a fresh independent read-only reviewer performs the single combined fidelity review when multi-agent tools are available, while the coordinator alone records it.
For `high-risk`, the main agent performs full fidelity before the required independent final review; ownership does not force serialization - write it while `sasu verify` runs in the background, and spawn the final-review sidecar only after fidelity is recorded.
Every fidelity review must compare the original intent source, accepted and rejected decisions, PRD scope, acceptance criteria, registered evidence, and the claimed result; the qa-log reading depth follows the spec-gate rule above (full read unless the generated prompt states the leg is settled).
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

`finalize --status complete` reuses a required command pass only when its recorded tree fingerprint is still exact.
It reruns stale or missing command-backed verification on the final tree before writing the receipt.
A nonzero exit rejects the receipt with a `Final reverification failed` violation.
Fix the failing check and finalize again - do not try to route around the re-run.

Do not report `Done` or complete the tracked Goal until `receipt.json` exists and `status` reports zero open tracked items.
For local delivery, clean active pointers after the receipt.
For PR delivery, continue through `$ship` according to `references/worktrees-and-delivery.md` before completing the tracked Goal.

## User Redirects And Pausing

The continuation stop hook drives the run while state is active.
When the user redirects to unrelated work, asks a side question, or explicitly asks to wrap up, do not fight the loop:

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js pause --reason "<the user's words>"
```

Then serve the user's request.
Any mark, verify, plan, review, or finalize command resumes the loop automatically, and `pause --clear` resumes it explicitly.
Pausing never claims completion; the receipt contract is unchanged.

## Hard Stops

Stop and ask when:

- required pre-work is incomplete.
- PRD status is not `ready` or approval is absent without an authorized verbatim deviation.
- work adds unmapped scope or changes the approved structure.
- credentials, billing, production data, destructive DB changes, or irreversible deploy steps are required but not approved.
- a test, seed, or migration would run against a production database or production connection string.
- verification failure requires a product or structure decision.
- delivery would push or open a PR without configuration-based or conversational consent.

## Final Report

Use the PRD's Implementation Result Report Contract.
The generated `implementation-result.md` includes the effective policy matrix, approval and deviations, execution and verification evidence, initial-versus-final worktree scope, delivery boundaries, reviews, receipt, and the coordinator's existing `context-notes.md`.
At minimum report:

- Status: `Done`, `Partially Done`, or `Blocked`.
- user-visible changes.
- major technical changes and structure conformance.
- actual file/module structure and the responsibility owned by each boundary.
- completed, deferred, and added tasks.
- acceptance-criterion status.
- verification evidence by test mode.
- automated tests added or updated and the regression risk each protects.
- requirements fidelity and final-review verdicts.
- delivery mode and, when `pr`, `$ship` status, PR URL, branch, and CI verdict.
- deviations.
- remaining human review.
- not-done items, risks, and follow-ups.
