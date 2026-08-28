# Execution Planning

Read this reference before implementation, while closing tasks, or when execution order is unclear.

## Contract Ownership

- The PRD owns requirements, acceptance criteria, technical structure, risks, and verification intent.
- `state.json` owns task progress, AC Check bindings and attempts, registered evidence, verification attempts, and completion.
- The implementation result owns the actual file and module boundaries selected within the approved structure.

## Coverage Check

Before editing, confirm that every PRD task maps to at least one requirement and that each requirement reaches an acceptance criterion and verification row.
Stop on a material gap instead of inventing behavior.

## Execution Order

The PRD's task dependencies own the order.
A task without a `Depends on:` clause depends on the previous task; `Depends on: none` or an explicit list overrides that default.
The CLI enforces the declaration: closing a task whose dependencies are open is rejected, and every close response reports the remaining tasks with which are `ready`.

Work the ready set in the order your own judgment prefers — risk first is usually right.
Tasks that are simultaneously ready may be implemented concurrently through worker subagents when the briefing cost is worth it; write scopes that overlap are a reason to keep them sequential or to keep the shared file's wiring in the orchestrator's own hands.

When fanning out:

- Brief each worker directly with the mapped requirement, acceptance criteria, and file scope; contracts left only in documents do not reach a spawned worker.
- Workers return changed files, focused check results, and evidence text. They never run `sasu` commands.
- This session reviews each worker result against the actual diff and closes the task itself. `state.json` has exactly one writer.
- A failed or suspect worker result leaves the task open; re-run it or implement it directly. Nothing is recorded as complete without reviewed evidence.

For each task:

1. Read the mapped contract.
2. Inspect the current implementation boundary.
3. Make the smallest complete change.
4. Bind and run each mapped machine AC Check to green, or record a human-approved park when work must continue without that proof.
5. Close the task; optional evidence is context, not completion authority.

```sh
sasu implement check --ac AC1 --bind 'npm test'
sasu implement check --ac AC1
sasu implement task --id T1 --status complete
```

Task completion does not mark acceptance criteria or verification PASS.
The unified verify command owns those decisions after all tasks close.

## Deviations

Pause before a material technical-structure deviation.
Do not silently add scope, compatibility layers, services, schemas, external calls, or hidden flows.

If a bounded implementation detail differs while preserving the approved structure, include it in the task evidence and final deviation report.

## Completion

An implementation task is ready to close when its code obligation is complete and every mapped machine AC is green or human-approved parked.
Judged-only or AC-less tasks add no mechanical close condition.
The run is not complete until unified verify passes and finalize writes the receipt.
