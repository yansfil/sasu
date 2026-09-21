# Execution Planning

Read the complete PRD and its decision sources before implementing.
The PRD owns requirements and approved structure; `state.json` owns execution history, evidence identity, run authority, and the current deterministic report identity.
Requirement IDs are references, not a task ledger.

## Plan Before The First Write

The Implementor writes one plan before it changes any source.
It exists because an Implementor that starts editing straight from the PRD discovers the codebase, the wrong order, and structural surprises after half the work is already written, and the Observer has nothing to read until verify runs.
The plan is written inside the approved `Technical structure`; it never redesigns that boundary.

1. Read the code the PRD's structure section points at: the existing patterns, the helpers that already do part of the job, and the test conventions.
2. Draw the dependency graph: what has to exist before what.
3. Slice vertically by observable behavior, not by layer.
   One slice covers one to three Behaviors rows, leaves the product working, and becomes one intermediate commit.
4. Order the slices by dependency, riskiest first, so the likely failure happens while there is the least to undo.
5. Give each slice its likely files and the check that shows it works.
   Do not restate acceptance criteria; the Behaviors rows already carry them.

Write it to `agents/runs/<slug>/plan.md` and print it as ordinary text, then continue in the same turn.
It is run bookkeeping: not CLI state, not verify input, and not a gate the Observer approves.
The shape:

```text
READ:      <files opened, existing pattern or helper to reuse>
SLICES:    1. <behaviors> - <what> - risk: <why first> - files: <paths> - check: <command or observation>
           2. <behaviors> - depends on 1 - ...
           3. <behaviors> - independent, parallelizable - ...
UNKNOWNS:  <structure the PRD names that the code does not have, or an open decision>
```

An `UNKNOWNS` line that changes the approved structure is an `OBSERVER_BLOCK` before the first write, not an assumption to build on.
When the plan turns out wrong mid-run, rewrite the file and say so in one line; nothing checks conformance to it.

Use focused tests where a plausible regression justifies their cost.
The final sealed project suites remain mandatory and are executed by verify.
For actual interaction behavior, reach a representative running state and inspect the result.
Do not substitute code existence or a build for observation.

Independent work may run concurrently when ownership is explicit.
Brief workers with the relevant behaviors, decisions, source boundaries, and expected return evidence.
Workers return their own changed paths, actual checks, and evidence provenance.
The Implementor coordinates run commands, preserves peer edits, and evaluates each result in the integrated product.
The CLI alone writes `state.json`.

## Intermediate Commits

Commit a coherent completed change unit locally while implementing, after the relevant checks required by the project.
Stage only your own changes; when workers share a tree, coordinate their returned paths before committing.
Use a descriptive subject, such as `Preserve retry state after a failed request`, and explain important intent or tradeoffs in the body when useful.
Report actual checks honestly; unrun checks remain unrun.
Git supplies the file list and diff, so do not maintain a second commit or task ledger.
There is no required commit per requirement and no whole verify run per commit unless project instructions require it.

The PostToolUse reminder measures current run changes against HEAD, combining staged, unstaged, and nonignored untracked regular files.
At 10 files or 500 added-plus-deleted lines, consider whether a coherent unit is ready to commit.
If it is still incomplete, continue to a sensible boundary without asking the user for permission.
The reminder does not stage, commit, push, block, or establish completion.
It checks at most once per 30 seconds after eligible tools, does not repeat an unchanged state, and spaces changed-state reminders by at least 10 minutes until a new commit resets the interval.
Run bookkeeping under `agents/**` is excluded.

## Verification

Do not create a requirement PASS checklist, flow-ID table, or coverage graph; `plan.md` declares order and boundaries and never records proof.
The independent review reads the full contract and shared actual evidence regardless of how implementation was divided.

Report material contract changes to the coordinator before editing the sealed PRD.
A human-authorized amendment preserves previous snapshots and approval evidence while invalidating deterministic verification freshness.
A bounded implementation choice within the approved structure may proceed under existing authority and be reported as an assumption or deviation.

When implementation and observations are coherent, register useful evidence at run level and execute verify.
A failed attempt leaves the run active for a concrete fix.
Delivery readiness comes from the current deterministic report, visible review notes, GitHub CI, and human review.
