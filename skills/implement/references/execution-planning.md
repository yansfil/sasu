# Execution Planning

Read the complete PRD and its decision sources before implementing.
The PRD owns requirements and approved structure; `state.json` owns actual executions, evidence identity, findings, authority, and completion.
Choose the work sequence yourself, grouping related files, product flows, and risk boundaries.
Requirement IDs are references, not a task ledger.

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

Do not create a required task file, requirement PASS checklist, flow-ID table, or coverage graph.
The independent review reads the full contract and shared actual evidence regardless of how implementation was divided.

Report material contract changes to the coordinator before editing the sealed PRD.
A human-authorized amendment preserves previous snapshots and approval evidence while invalidating the full review's freshness.
A bounded implementation choice within the approved structure may proceed under existing authority and be reported as an assumption or deviation.

When implementation and observations are coherent, register useful evidence at run level and execute verify.
A failed attempt leaves the run active for a concrete fix.
Completion comes only from current required suites, independent review, open-issue and authority rules, and finalize's receipt.
