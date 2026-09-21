# Execution Planning

## Contents

- [Plan Before The First Write](#plan-before-the-first-write)
- [Intermediate Commits](#intermediate-commits)
- [Verification](#verification)

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

Write it to `agents/runs/<slug>/plan.md`, print it as ordinary text, and register it:

```sh
sasu implement plan --path agents/runs/<slug>/plan.md
```

Then continue in the same turn.
The command records one `plan` event; under Herdr the supervisor tick wakes the Observer once for it within a tick interval, whatever runtime the Implementor is.
The plan is run bookkeeping: not verify input and not a gate the Observer approves.
A rewritten plan is registered again and wakes the Observer again; a run that never registers one is not a signal of anything.
The shape:

```text
READ:      <files opened, existing pattern or helper to reuse>
SLICES:    1. <behaviors> - <what> - risk: <why first> - files: <paths> - check: <command or observation>
           2. <behaviors> - depends on 1 - ...
           3. <behaviors> - independent, parallelizable - ...
UNKNOWNS:  <structure the PRD names that the code does not have, or an open decision>
```

An `UNKNOWNS` line that changes the approved structure is an `OBSERVER_BLOCK` before the first write, not an assumption to build on.
When the plan turns out wrong mid-run, rewrite the file and say so in one line, register it again, and continue; nothing checks conformance to it.

### Example

A PRD with five Behaviors rows:

```text
B1 a comment posted on an article appears in its list at once
B2 the article's author receives a notification
B3 opening the notification lands on that comment
B4 a comment on my own article sends me nothing
B5 deleting a comment removes its notification
```

Sliced by layer, nothing is observable until the fourth step and the check for each is "the table exists" or "it builds":

```text
1. comments table   2. notifications table   3. both APIs   4. comment box UI   5. bell UI
```

Sliced by behavior, every step leaves something a person can try, and each is one commit:

```text
SLICES:    1. B1     - comments schema + POST + list render - risk: this data shape is the base of everything else - files: db/…, api/comments.ts, ui/CommentBox.tsx - check: post a comment in the browser and see it
           2. B2, B4 - notifications schema + trigger on comment creation + self-exclusion rule - depends on 1 - risk: trigger inside or outside the transaction - check: comment on another author's article, bell shows 1; on my own, 0
           3. B3     - notification deep link to the comment - depends on 2 - independent of 4 - check: click scrolls to the comment
           4. B5     - delete cascade - depends on 2 - independent of 3 - check: bell shows 0 after delete
```

B2 and B4 share a slice because B4 is one line inside B2's trigger and is not a working state on its own.
The notifications table is used by B2, B3, and B5, and it is created by the first slice that needs it, not by a slice of its own.

### Work that is not a Behaviors row

The rows are the unit of observation; some work has no row and still has a place.

- Shared shape: a type, a table, or a module boundary several slices depend on is built by the first slice that needs it.
  When that shape is expensive to reverse, name it in the plan under that slice so the choice is deliberate, not a side effect of getting slice 1 to pass.
- Preparatory refactoring: when the existing code makes the first slice tangled, a slice `0.` may reshape it first.
  It changes no behavior, its check is the existing suite staying green, and it is its own commit, so the diff that adds behavior stays readable.
- Structure the PRD names without a row, such as a migration or a config key, belongs to the first slice that needs it.
- A pure structure slice, with no row and no runnable surface, is allowed only when it has a real check of its own: a command that can be run, a test that can be red.
  "The table exists" and "it builds" are not checks.
- Work in no row and no structure section, such as an abstraction for later or an unrelated cleanup, is not planned; it goes to Follow-up improvements.

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
