# Execution Graph Reference

`prd-implement` keeps the PRD clean and derives executor state during
implementation.

## Artifact Roles

- PRD: product requirements, acceptance criteria, PRD-level tasks, major
  technical structure changes, verification contract, test mode contract, human
  review needs, and implementation guardrails.
- `verification-plan.json/md`: repo-specific proof plan derived from the PRD
  Verification Contract. Structured matrices provide concrete
  method/artifact fields directly; lean contracts with `Pass Intent` are expanded
  through the Test Mode Contract and repo signals.
- `execution-plan.json/md`: implementation work units derived from PRD Tasks.
- `taskgraph.json/md`: machine-checkable graph tying verification plan,
  execution nodes, task rollups, acceptance criteria, verification,
  requirements fidelity review, final review, and receipt together.
- `ledger.jsonl` and `artifacts/manifest.jsonl`: evidence trail.
- `state.deviations`: recorded soft-gate deviations such as equivalent verifier
  substitutions, out-of-order node execution, or scope changes that the final
  reviewer must explicitly accept.

Do not add executor-only fields to the PRD: `writeScope`, `parallelSafe`,
`risk`, low-level `dependsOn`, owner, worker assignment, ready-node state, or
subagent scheduling.

## Required Flow

```text
Codex Goal opened
  -> init
  -> plan-verification
  -> plan-execution
  -> ready
  -> main-agent coverage check
  -> mark-node / assign-node
  -> AC + verification evidence
  -> task roll-up
  -> requirements fidelity review
  -> final adversarial review
  -> runtime cleanup
  -> finalize receipt
```

`plan-execution` creates one or more execution nodes for each PRD-level task.
The default conservative decomposition is one node per task. The coordinator may
perform narrower work inside that node, but added scope still needs PRD
traceability.

## Execution Node Rules

Each execution node has:

- `sourceTask`: PRD-level task ID.
- `dependsOn`: execution node IDs that must complete first.
- `writeScope`: inferred files, routes, modules, or artifact areas.
- `covers`: mapped requirements, acceptance criteria, and verification IDs.
- `parallelSafe`: false when uncertain.
- `risk`: `low`, `medium`, or `high`.
- `owner`: optional coordinator or `subagent:<id>`.
- `status`: `pending`, `in_progress`, `complete`, `blocked`, or `deferred`.
- `evidence` and `artifacts`.

Mark execution work with:

```sh
node ~/.codex/skills/prd-implement/scripts/prd_state_harness.js mark-node \
  --id N1 \
  --status complete \
  --evidence "<command/test/file/screenshot evidence>"
```

Assign ownership with:

```sh
node ~/.codex/skills/prd-implement/scripts/prd_state_harness.js assign-node \
  --id N1 \
  --owner subagent:<id>
```

Assignment never implies completion.

## Roll-Up Rules

Node completion is local. PRD Task completion is a roll-up.

A task can roll up to `complete` only when:

- every mapped execution node is complete
- mapped acceptance criteria are met
- every mapped required verification item passes
- mapped optional verification items either pass or are explicitly skipped or
  blocked with evidence

Do not manually mark a PRD task complete just because one node completed.
Manual task marks are reserved for blocked/deferred/manual correction cases
with evidence.

`blocked` and `skipped` never count as completion for required verification.
They can justify a blocked final outcome, but they must not produce a complete
receipt. Verification items are required by default unless the PRD Verification
Contract marks `Required For Done` as `no` or `no/blockable`.

## Ready And Parallel Guidance

The harness recommends ready nodes. It does not start work or spawn subagents.

Execution is sequential by default. Parallel ready groups are computed and shown
only when `.hoyeon/config.json` sets `execution.parallel: true` (configured via
`$prd-setup`). With the default off, `ready` returns `readyParallelGroups: []`
and the coordinator works one node at a time.

Use:

```sh
node ~/.codex/skills/prd-implement/scripts/prd_state_harness.js ready
```

When `execution.parallel` is enabled, a node can appear in a parallel group only
when:

- all dependencies are complete
- `parallelSafe` is true
- risk is `low` or `medium`
- write scopes are disjoint
- the task is not DB/auth/security/config/migration/production-data sensitive

The coordinator decides whether to spawn subagents and remains responsible for
final edits and verification.

When multi-agent tools are available, `prd-implement` requires an independent
read-only sidecar only for the final adversarial review. The harness does not
spawn this reviewer. The coordinator starts it with the default subagent, not a
`hoyeon-*` role unless the user explicitly requests that role, and records its
findings before state-changing final review commands.
The final sidecar audits the requirements fidelity review as the primary
semantic proof owner.
It should reopen full V-by-V artifact reasoning only when that review is
missing, generic, inconsistent with state, or suspicious.

## Completion Gate

`finalize --status complete` and the PreToolUse hook must reject completion
when any of these are true:

- receipt missing
- Codex Goal is missing when goal tools were available
- execution plan missing or has open nodes
- PRD tasks, acceptance criteria, or verification items are open
- verification plan has blocking gaps
- taskgraph is missing execution nodes or gates
- requirements fidelity review is missing, not pass, or stale
- final review is missing or not pass
- requirements fidelity review or final review is stale because source,
  evidence, artifacts, plans, or deviations changed after it
- required artifacts are missing, empty, invalid, or hash-mismatched
- artifact files exist under `artifacts/` but are not registered in state or
  `artifacts/manifest.jsonl`
- required verification items are blocked, skipped, failed, pending, or missing
  artifact-backed evidence
- runtime processes started only for verification are still running without an
  explicit left-running exception

The receipt is the only completion proof.
Codex Goal state is lifecycle control when available; a missing or incomplete
Goal is a process violation, not a second proof artifact.

## Soft Gate Deviations

Do not block capable agents from using a better local path when they preserve
the PRD contract. Instead, require explicit deviation records for:

- executing nodes outside ready guidance
- touching files outside the inferred write scope
- replacing a planned verification command with an equivalent command
- adding verification or release-hygiene work that maps to existing PRD scope

The final reviewer decides whether each deviation is acceptable. Unrecorded
deviations are PRD drift.
