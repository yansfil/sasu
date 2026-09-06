# Execution Planning

Read this reference before implementation, while working rows, or when execution order is unclear.

## Contract Ownership

- The PRD owns the goal, non-goals, the Decisions table, the Behaviors rows, the technical structure, and risks.
- `state.json` owns each row's status and attempts, registered evidence, verification attempts, and completion.
- The implementation result owns the actual file and module boundaries selected within the approved structure.

## Coverage Check

Before editing, read every Behaviors row with the Decisions rows it cites and confirm the technical structure admits an implementation of each.
Stop on a material gap instead of inventing behavior.

## Execution Order

The harness reads no task list and no dependency graph; how the rows are split into work, and in what order, is this session's own plan.
Work the rows in the order your own judgment prefers - risk first is usually right - and keep rows that touch the same files together.

Rows may be implemented concurrently through worker subagents when the briefing cost is worth it; overlapping write scopes are a reason to keep them sequential or to keep the shared file's wiring in the orchestrator's own hands.

When fanning out:

- Brief each worker directly with the row's behavior, the Decisions rows it cites, and the file scope; contracts left only in documents do not reach a spawned worker.
- Workers return changed files, focused check results, and evidence text. They never run `sasu` commands.
- This session reviews each worker result against the actual diff and runs the row's check itself. `state.json` has exactly one writer.
- A failed or suspect worker result leaves the row open; re-run it or implement it directly. Nothing is recorded as green without a harness attempt.

For each row:

1. Read the behavior and its cited decisions.
2. Inspect the current implementation boundary.
3. Make the smallest complete change.
4. Settle the row by its method: run the sealed command for a `check:` row, register evidence for a `judge:` row, leave a `human:` row OPEN.

```sh
sasu implement check --row B1
sasu implement artifact --row B2 --kind screenshot --path shots/b2.png --description '<what this proves>'
```

A green `check:` row means only that its command exited 0 on the current tree.
Unified verify owns the `judge:` rows and the suite after every `check:` row is green or parked.

## Deviations

Pause before a material technical-structure deviation.
Do not silently add scope, compatibility layers, services, schemas, external calls, or hidden flows.

If a bounded implementation detail differs while preserving the approved structure, record it in the final deviation report.

## Completion

The run is ready for verify when every `check:` row is green or human-approved parked and every `judge:` row has its evidence registered.
The run is not complete until unified verify passes and finalize writes the receipt; `human:` rows may still be OPEN at that point and are the user's to close.
