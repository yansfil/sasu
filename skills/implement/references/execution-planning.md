# Execution Planning And Coordination

Read this reference before `plan-execution`, while implementing tasks, when assigning subagents, or when diagnosing ready, deviation, and parallel behavior.

## Contents

- [Artifact Roles](#artifact-roles)
- [Planning And Coverage Check](#planning-and-coverage-check)
- [Task Executor Fields](#task-executor-fields)
- [Implementation Loop](#implementation-loop)
- [Ready And Parallel Guidance](#ready-and-parallel-guidance)
- [Subagent Coordination](#subagent-coordination)
- [Completion Rules](#completion-rules)
- [Soft-Gate Deviations](#soft-gate-deviations)

## Artifact Roles

- The PRD owns product requirements, acceptance criteria, PRD-level tasks, major technical structure changes, the verification contract, the test mode contract, human review needs, and implementation guardrails.
- `state.json` is the single source of truth for progress. PRD tasks live in `state.tasks`, and `plan-execution` writes the executor fields onto those same task items, so there is exactly one place a task's status and plan are recorded.
- `state.verificationPlan` holds the repo-specific proof plan derived from the PRD Verification Contract, and `state.executionPlan` holds plan metadata (status, gaps, whether a task plan was applied); both live inside `state.json` with no separate plan files.
- `executionPlan` owns execution units, dependencies, `writeScope`, and parallel coordination.
- `verificationPlan` owns exact commands, cwd, proof tools, evidence kinds, and repo-derived target and runtime strategies.
- `implementation-result.md` owns the actual file/module structure selected during implementation and its responsibility boundaries.
- `artifacts/manifest.jsonl` is the durable evidence registration trail.
- `state.deviations` records soft-gate deviations that a completion review must explicitly accept: the fidelity review's Deviation Audit on every profile, plus the final adversarial review on `high-risk`.

There are no derived view files. `status` renders the current plans, counts, ready tasks, and violations on demand from `state.json`.

Do not add executor-only fields to the PRD.
`writeScope`, `parallelSafe`, `risk`, low-level `dependsOn`, owner, ready state, and subagent scheduling belong to implementation artifacts.
`writeScope` coordinates concurrent writers only.
It never narrows a judge lane, a freshness fingerprint, or the changed files a completion review may inspect.

## Planning And Coverage Check

`init` builds both plans automatically: it validates the PRD tasks, records traceability from `T#` to `AC#` and `V#`, and reports gaps, so a default sequential run needs no separate planning command.
Default tasks have no declared write scope, medium risk, no dependencies, and `parallelSafe: false`.
The harness does not infer file ownership, task risk, or dependencies from PRD prose.
Run `plan-execution` only to apply an explicit task plan or to replan after PRD task changes.

When `execution.parallel` is enabled and parallel work is useful, inspect the repository and write one compact task-plan JSON object keyed by PRD task ID:

```json
{
  "T1": {
    "dependsOn": [],
    "writeScope": ["src/feature-a", "tests/feature-a.test.js"],
    "risk": "low",
    "parallelSafe": true
  },
  "T2": {
    "dependsOn": ["T1"],
    "writeScope": ["src/integration"],
    "risk": "medium",
    "parallelSafe": false
  }
}
```

Then run:

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js plan-execution \
  --task-plan <task-plan.json>
```

The task plan is an agent-owned implementation input, not a PRD artifact.
The harness validates task IDs, dependencies, dependency cycles, repository-relative normalized write scopes, and the rule that high-risk or unscoped work cannot be parallel-safe.
A task omitted from an explicit task plan is reset to conservative sequential defaults, so include every task you want to keep a declared scope for.

Inspect the `init` or `plan-execution` output, or `status`, after planning.
The execution plan reports these gaps: `task_without_requirement`, `task_without_acceptance_mapping`, `missing_write_scope` (parallel enabled but a task declares no scope), `no_prd_tasks`, and `execution_dependency_cycle`.
Only `no_prd_tasks` and `execution_dependency_cycle` are blocking.
`status` lists ready tasks; ready never proves final eligibility.

The main agent owns the post-planning coverage check.
When the PRD references an intake qa-log, read it completely and compare its material intent with PRD decisions, verification coverage, the task plan, structure lock, ambiguity, and unmapped scope.
Treat summaries and parsed intent samples as navigation aids rather than substitutes for the canonical qa-log.
Record material findings in `context-notes.md` and stop on material blockers.

## Task Executor Fields

Beyond its PRD-parsed `id`, `title`, `text`, `requirements`, and `acceptanceCriteria`, each task in `state.tasks` carries:

- `dependsOn`: task IDs that must complete first.
- `writeScope`: agent-declared repository-relative files or directories used only for ownership and parallel-conflict checks.
- `parallelSafe`: false when safety is uncertain.
- `risk`: `low`, `medium`, or `high`.
- `owner`: the optional coordinator or `subagent:<id>`.
- `status`: `pending`, `in_progress`, `complete`, `blocked`, or `deferred`.
- `evidence` and `artifacts`: the proof attached to the task.

Assign ownership with:

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js assign \
  --id T1 \
  --owner subagent:<id>
```

Assignment never implies completion.

## Implementation Loop

For each ready task:

1. Re-read the relevant files.
2. Make the smallest change that satisfies the mapped requirements and acceptance criteria.
3. Record material decisions in `context-notes.md`.
4. Run the smallest relevant verification while source is changing.
5. Record task and acceptance evidence through the harness.

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js mark \
  --kind task \
  --id T1 \
  --status complete \
  --ac AC1 \
  --evidence "<file/test/runtime evidence>"
```

Repeated same-status updates may use comma-separated IDs.

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js mark \
  --kind task \
  --id T1,T2 \
  --status complete \
  --evidence "<shared evidence>"

node ~/.codex/skills/implement/scripts/prd_state_harness.js mark \
  --kind ac \
  --id AC1,AC2 \
  --status met \
  --evidence "<shared evidence>"
```

`--ac` is valid only with `--kind task --status complete`: it marks those acceptance criteria met with the same evidence, so a task and the criteria its evidence proves close in one call.

## Ready And Parallel Guidance

The harness recommends ready tasks but does not start work or spawn subagents.
Execution is sequential by default.
Parallel ready groups are computed only when `agents/config.json` sets `execution.parallel: true`, normally configured through `$ho-setup`.
With the default off, `ready` returns `readyParallelGroups: []` and the coordinator works one task at a time.

When parallel execution is enabled, a task can appear in a parallel group only when:

- all dependencies are complete.
- `parallelSafe` is true.
- risk is `low` or `medium`.
- write scopes are disjoint.
- the agent's semantic task assessment is not `high` risk.

The coordinator decides whether parallel work is useful and remains responsible for final edits, reconciliation, and verification.

## Subagent Coordination

Parallelize only when work is both safe and useful.

- Check the ready list (`status` or the latest mark output) before assigning work.
- Give each worker a bounded task with exact file ownership or a read-only scope, and record it with `assign`.
- Tell workers they are not alone in the codebase and must not revert other changes.
- Reviewer and verifier sidecars are read-only and must not run `mark`, `assign`, `requirements-review-record`, `review-record`, `finalize`, or Goal tools.
- Only the coordinator mutates harness state, applies final edits, resolves conflicts, reruns verification, and records final outcomes.
- If no subagent facility is available, use safe shell parallelism for independent reads and checks.

The final adversarial reviewer has additional ownership and freshness rules in `reviews-and-finalization.md`.

## Completion Rules

You close a task explicitly, with evidence. Mark it `complete` only when:

- its mapped acceptance criteria are met or are being closed in the same call with `--ac`.
- every mapped required verification item passes.
- mapped optional verification items pass or are explicitly skipped or blocked with evidence.

A premature task mark cannot buy a complete receipt: `finalize` still refuses while any acceptance criterion is unmet, any required verification item has not passed, or any tracked item lacks evidence.

`blocked` and `skipped` never count as completion for required verification.
They can justify a blocked final outcome but must not produce a complete receipt.
Verification items are required by default unless the PRD contract marks `Required For Done` as `no` or `no/blockable`.

## Soft-Gate Deviations

Record a deviation when execution order, write scope, task shape, or verifier substitution differs from the plan.
Capable agents may use a better local path when it preserves the PRD contract, but the change must remain auditable.

Explicit deviation records are required for:

- completing a task while its declared dependencies are still open. The harness records this `ready_order` deviation automatically in any mode; reorders of independent tasks stay silent.
- touching files outside the declared write scope.
- replacing a planned verification command with an equivalent command.
- adding verification or release-hygiene work that maps to existing PRD scope.

The fidelity review's Deviation Audit (and the final review on `high-risk`) decides whether each deviation is acceptable.
Unrecorded deviations are PRD drift.
