# Execution Graph And Coordination

Read this reference before `plan-execution`, while implementing execution nodes, when assigning subagents, or when diagnosing TaskGraph and roll-up behavior.

## Contents

- [Artifact Roles](#artifact-roles)
- [Planning And Coverage Check](#planning-and-coverage-check)
- [Execution Node Rules](#execution-node-rules)
- [Implementation Loop](#implementation-loop)
- [Ready And Parallel Guidance](#ready-and-parallel-guidance)
- [Subagent Coordination](#subagent-coordination)
- [Roll-Up Rules](#roll-up-rules)
- [Soft-Gate Deviations](#soft-gate-deviations)

## Artifact Roles

- The PRD owns product requirements, acceptance criteria, PRD-level tasks, major technical structure changes, the verification contract, the test mode contract, human review needs, and implementation guardrails.
- `verification-plan.json` and `verification-plan.md` contain the repo-specific proof plan derived from the PRD Verification Contract.
- `execution-plan.json` and `execution-plan.md` contain implementation work units derived from PRD Tasks.
- `taskgraph.json` and `taskgraph.md` tie verification planning, execution nodes, task rollups, acceptance criteria, verification, requirements fidelity review, any policy-required final review, and receipt together.
- `ledger.jsonl` and `artifacts/manifest.jsonl` form the durable evidence trail.
- `state.deviations` records soft-gate deviations that the final reviewer must explicitly accept.

Do not add executor-only fields to the PRD.
`writeScope`, `parallelSafe`, `risk`, low-level `dependsOn`, owner, worker assignment, ready-node state, and subagent scheduling belong to implementation artifacts.

## Planning And Coverage Check

Run:

```sh
node ~/.codex/skills/ho-build/scripts/prd_state_harness.js plan-execution
node ~/.codex/skills/ho-build/scripts/prd_state_harness.js ready
```

`plan-execution` maps every PRD-level task to execution nodes, evidence expectations, and traceability from `T#` through `N#` to `AC#` and `V#`.
The PRD stays clean because executor details live in implementation artifacts.
The default conservative decomposition is one node per PRD-level task, although the coordinator may perform narrower mapped work inside a node.
Default nodes have no declared write scope, medium risk, no dependencies, and `parallelSafe: false`.
The harness does not infer file ownership, task risk, or dependencies from PRD prose.

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
node ~/.codex/skills/ho-build/scripts/prd_state_harness.js plan-execution \
  --task-plan <task-plan.json>
```

The task plan is an agent-owned implementation input, not a PRD artifact.
Omit tasks that should remain conservatively sequential.
The harness validates task IDs, dependencies, dependency cycles, repository-relative normalized write scopes, and the rule that high-risk or unscoped work cannot be parallel-safe.

Inspect `execution-plan.md`, `taskgraph.md`, or `status` after planning.
The TaskGraph must account for verification planning, execution planning, execution nodes, PRD task rollups, acceptance criteria, verification items, requirements fidelity review, any final review required by the effective policy, and receipt.
Policy v2 `trivial` and `standard` omit `REVIEW` entirely and connect `REQ_FIDELITY_REVIEW` directly to `FINALIZE`.
Policy v2 `high-risk` and legacy v1 states retain their existing `REQ_FIDELITY_REVIEW -> REVIEW -> FINALIZE` shape, although legacy `trivial` does not require the review to pass.
`ready` identifies runnable execution nodes and never proves final eligibility.

The main agent owns the post-planning coverage check.
Compare the original intent sources, PRD decisions, verification coverage, execution plan, TaskGraph, structure lock, ambiguity, and unmapped scope.
Record material findings in `context-notes.md` and stop on material blockers.

## Execution Node Rules

Each execution node has:

- `sourceTask`: the PRD-level task ID.
- `dependsOn`: execution node IDs that must complete first.
- `writeScope`: agent-declared repository-relative files or directories, normalized by the harness.
- `covers`: mapped requirements, acceptance criteria, and verification IDs.
- `parallelSafe`: false when safety is uncertain.
- `risk`: `low`, `medium`, or `high`.
- `owner`: the optional coordinator or `subagent:<id>`.
- `status`: `pending`, `in_progress`, `complete`, `blocked`, or `deferred`.
- `evidence` and `artifacts`: the proof attached to the node.

Mark execution work with:

```sh
node ~/.codex/skills/ho-build/scripts/prd_state_harness.js mark-node \
  --id N1 \
  --status complete \
  --evidence "<command/test/file/screenshot evidence>"
```

Assign ownership with:

```sh
node ~/.codex/skills/ho-build/scripts/prd_state_harness.js assign-node \
  --id N1 \
  --owner subagent:<id>
```

Assignment never implies completion.

## Implementation Loop

For each ready execution node:

1. Re-read the relevant files.
2. Make the smallest change that satisfies the mapped requirements and acceptance criteria.
3. Record material decisions in `context-notes.md`.
4. Run the smallest relevant verification while source is changing.
5. Record node and acceptance evidence through the harness.

```sh
node ~/.codex/skills/ho-build/scripts/prd_state_harness.js mark-node \
  --id N1 \
  --status complete \
  --evidence "<file/test/runtime evidence>"

node ~/.codex/skills/ho-build/scripts/prd_state_harness.js mark \
  --kind ac \
  --id AC1 \
  --status met \
  --evidence "<evidence>"
```

Repeated same-status updates may use comma-separated IDs.

```sh
node ~/.codex/skills/ho-build/scripts/prd_state_harness.js mark-node \
  --id N1,N2 \
  --status complete \
  --evidence "<shared evidence>"

node ~/.codex/skills/ho-build/scripts/prd_state_harness.js mark \
  --kind ac \
  --id AC1,AC2 \
  --status met \
  --evidence "<shared evidence>"
```

Do not manually close a PRD task just because one node is done.
Task completion rolls up from execution nodes, mapped acceptance criteria, and mapped verification items.

## Ready And Parallel Guidance

The harness recommends ready nodes but does not start work or spawn subagents.
Execution is sequential by default.
Parallel ready groups are computed only when `agents/config.json` sets `execution.parallel: true`, normally configured through `$ho-setup`.
With the default off, `ready` returns `readyParallelGroups: []` and the coordinator works one node at a time.

When parallel execution is enabled, a node can appear in a parallel group only when:

- all dependencies are complete.
- `parallelSafe` is true.
- risk is `low` or `medium`.
- write scopes are disjoint.
- the agent's semantic task assessment is not `high` risk.

The coordinator decides whether parallel work is useful and remains responsible for final edits, reconciliation, and verification.

## Subagent Coordination

Parallelize only when work is both safe and useful.

- Run `ready` before assigning work.
- Give each worker a bounded node with exact file ownership or a read-only scope.
- Tell workers they are not alone in the codebase and must not revert other changes.
- Reviewer and verifier sidecars are read-only and must not run `mark`, `requirements-review-record`, `review-record`, `finalize`, or Goal tools.
- Only the coordinator mutates harness state, applies final edits, resolves conflicts, reruns verification, and records final outcomes.
- If no subagent facility is available, use safe shell parallelism for independent reads and checks.

The final adversarial reviewer has additional ownership and freshness rules in `reviews-and-finalization.md`.

## Roll-Up Rules

Node completion is local while PRD Task completion is a roll-up.
A task can roll up to `complete` only when:

- every mapped execution node is complete.
- mapped acceptance criteria are met.
- every mapped required verification item passes.
- mapped optional verification items pass or are explicitly skipped or blocked with evidence.

Do not manually mark a PRD task complete because a single node completed.
Manual task marks are reserved for blocked, deferred, or manual-correction cases with evidence.

`blocked` and `skipped` never count as completion for required verification.
They can justify a blocked final outcome but must not produce a complete receipt.
Verification items are required by default unless the PRD contract marks `Required For Done` as `no` or `no/blockable`.

## Soft-Gate Deviations

Record a deviation when execution order, write scope, task shape, or verifier substitution differs from the plan.
Capable agents may use a better local path when it preserves the PRD contract, but the change must remain auditable.

Explicit deviation records are required for:

- executing nodes outside ready guidance.
- touching files outside the declared write scope.
- replacing a planned verification command with an equivalent command.
- adding verification or release-hygiene work that maps to existing PRD scope.

The final reviewer decides whether each deviation is acceptable.
Unrecorded deviations are PRD drift.
