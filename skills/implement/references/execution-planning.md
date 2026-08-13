# Execution Planning

Read this reference before implementation, while closing tasks, or when execution order is unclear.

## Contract Ownership

- The PRD owns requirements, acceptance criteria, technical structure, risks, and verification intent.
- `state.json` owns task progress, registered evidence, verification attempts, and completion.
- The implementation result owns the actual file and module boundaries selected within the approved structure.

## Coverage Check

Before editing, confirm that every PRD task maps to at least one requirement and that each requirement reaches an acceptance criterion and verification row.
Stop on a material gap instead of inventing behavior.

## Execution Order

Work sequentially by default.
This skill does not configure task parallelism, write scopes, ready groups, or subagent scheduling.

For each task:

1. Read the mapped contract.
2. Inspect the current implementation boundary.
3. Make the smallest complete change.
4. Run a focused development check when useful.
5. Close the task with concrete evidence.

```sh
sasu implement task --id T1 --status complete --evidence '<files and focused result>'
```

Task completion does not mark acceptance criteria or verification PASS.
The unified verify command owns those decisions after all tasks close.

## Deviations

Pause before a material technical-structure deviation.
Do not silently add scope, compatibility layers, services, schemas, external calls, or hidden flows.

If a bounded implementation detail differs while preserving the approved structure, include it in the task evidence and final deviation report.

## Completion

An implementation task is ready to close when its code obligation is complete and its evidence names the files and focused result.
The run is not complete until unified verify passes and finalize writes the receipt.
