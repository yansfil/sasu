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
First read the code the PRD's structure section points at: the existing patterns, the helpers that already do part of the job, and the test conventions.

The plan answers four questions.
Its format is free and its length follows the work: a one-module task is ten lines, a boundary change is a page.
Nothing validates its shape, and nothing checks conformance to it later.

1. **How I will build it.**
   Map the PRD's `Technical structure` onto the real code: which modules or boundaries, what talks to what, what existing code is reused, and what is new.
   Name the one or two decisions that are expensive to reverse and why they go this way.
   A structure that differs from the approved PRD is a block before the first write (`sasu implement block` on an hcoord run, `OBSERVER_BLOCK` on a legacy one), not a note in the plan.
2. **Where it can go wrong.**
   Name the risks that decide the order.
   A plan with no risk is the PRD restated and reads as such.
3. **What I decide and go with.**
   List the product or implementation choices the PRD does not settle, each with its reason, under the heading "say now if you disagree" ("이견 있으면 지금").
   Do not wait for an answer: proceed, and the Observer answers at the `plan` wake only when it disagrees.
4. **Order and the check for each step.**
   A step is a work unit that becomes one commit, cut by observable behavior rather than by layer, ordered by dependency and risk, and labeled with the Behaviors rows it makes visible.
   Each step names what a person sees or which test turns green when it is done; "it builds" and "the table exists" are not checks.
   Say when the first full `sasu implement verify` runs: on the final committed candidate by default, earlier when a step first connects an integration boundary.

Write it to `agents/runs/<slug>/plan.md`, print it as ordinary text, and register it:

```sh
sasu implement plan --path agents/runs/<slug>/plan.md
```

Then continue in the same turn.
The command records one `plan` event and wakes the Observer once for it, whatever runtime the Implementor is: an hcoord run sends an `HCOORD_NOTICE` at once, and a legacy run's supervisor tick wakes it within a tick interval.
The plan is run bookkeeping: not verify input and not a gate the Observer approves.
When the plan turns out wrong mid-run, rewrite the file, say so in one line, register it again, and continue; the new registration wakes the Observer again.
A run that never registers one is not a signal of anything.

### Example

A PRD with five Behaviors rows:

```text
B1 a comment posted on an article appears in its list at once
B2 the article's author receives a notification
B3 opening the notification lands on that comment
B4 a comment on my own article sends me nothing
B5 deleting a comment removes its notification
```

The plan:

```text
# plan: comment notifications

How I will build it
- Comments and notifications are separate tables and modules; comments/ knows nothing about notifications.
  Saving a comment emits a "comment created" event on the existing events/emit bus; notifications/ subscribes and writes the notification.
  Reason: later notification kinds (likes, mentions) must not touch comments/.
- Notification creation runs outside the comment transaction: a failed notification never rolls back the comment.
- Reused: events/emit, the existing Bell component (only the count is wired). New: notifications table and module.
- Expensive to reverse: notifications carry target_type + target_id, not comment_id, so the next kind needs no migration.

Where it can go wrong
- The transaction boundary. Inside: a notification failure loses the comment. Outside: the comment lands and the notification may be missing; missing ones are logged.
- The "no notification on my own article" rule (B4) is one line inside the trigger and easy to forget; step 2's check pins it.

What I decide and go with (not in the PRD; say now if you disagree)
- Repeated comments by one person on one article each notify; no grouping.
- Deleting a comment removes its notification even when already read (B5).

Order and checks
0. none; the existing code needs no reshaping first.
1. Post a comment (B1): comments table + POST /comments + list under the article.
   Check: post one in the browser and see it appear without reload.
2. Notification appears (B2, B4): notifications table + subscriber + self-exclusion + bell count.
   Check: comment on another author's article, bell shows 1; on my own, 0. Two tests pin it.
3. Open a notification (B3), on 2, independent of 4: link on the notification scrolls to the comment.
   Check: click lands on the comment.
4. Delete a comment (B5), on 2, independent of 3: delete cascades by target_id.
   Check: bell 1 before delete, 0 after.
Full verify once after step 4 is committed. Step 2 first joins the two modules, so the existing suite runs once there.

Blocked on: nothing.
```

B2 and B4 share step 2 because B4 is one line inside B2's trigger and is not a working state on its own.
The notifications table serves B2, B3, and B5, and step 2 builds it because it is the first step that needs it.

### Work that is not a Behaviors row

The rows are the unit of observation; some work has no row and still has a place.

- Shared shape: a type, a table, or a module boundary several steps depend on is built by the first step that needs it.
  When that shape is expensive to reverse, name it under "How I will build it" so the choice is deliberate, not a side effect of getting step 1 to pass.
- Preparatory refactoring: when the existing code makes the first step tangled, a step `0.` may reshape it first.
  It changes no behavior, its check is the existing suite staying green, and it is its own commit, so the diff that adds behavior stays readable.
- Structure the PRD names without a row, such as a migration or a config key, belongs to the first step that needs it.
- A pure structure step, with no row and no runnable surface, is allowed only when it has a real check of its own: a command that can be run, a test that can be red.
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
