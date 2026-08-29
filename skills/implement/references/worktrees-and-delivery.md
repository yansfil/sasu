# Worktrees And Delivery

Read this reference when delivery is `pr`, a run reports a worktree, or post-receipt delivery is requested.

## Worktree Isolation

The harness, not the agent, decides and creates worktrees at `sasu implement start`:

- One working tree hosts at most one active in-place run.
  A start in an occupied tree is automatically isolated into a fresh git worktree (branch `prd/<slug>` at HEAD), with the configured `worktree.link`/`copy`/`setup` preparation applied.
- `worktree.enabled: true` isolates every run from the start.
- The start response reports `workingRoot`.
  Edit files there; `sasu` commands work from either tree and always operate on the run's own trees.

Records never move: `state.json`, receipt, PRD, config, and rules stay in the record tree's `agents/` namespace.
The worktree holds only the judged source.
Do not remove a run's worktree before its branch is merged or shipped; uncommitted work there is not recoverable, while the run record survives regardless.
A local-delivery run ends with a recorded semantic commit on its current branch;
the finalize response names the branch or worktree and the follow-up delivery command.

## Boundary

Implementation completion and PR delivery are separate outcomes.
`sasu implement finalize` creates the implementation receipt before commit, push, PR creation, CI observation, or merge.

## Local Delivery

The default delivery mode is local.
After a complete receipt, run the local delivery command to validate freshness and
rules, commit the allowlisted implementation with a semantic project message, and
record `delivery/delivery-result.json`.
It never pushes, opens a PR, watches CI, or merges.
Running it again for the same receipt and HEAD is idempotent.

## PR Delivery

When PR delivery is authorized:

1. Complete the implementation receipt in the intended checkout or configured worktree.
2. Follow the repository PR template.
3. Stage only implementation-owned changes and preserve unrelated dirty files.
4. Use `$ship` for the PR delivery commit, push, PR creation, and CI handoff.

PR creation and CI are never required to prove implementation completion.

## Existing Runs

The new implement state schema does not migrate old runs.
Start a new run in the intended checkout.
Do not add compatibility adapters or copy old completion verdicts into the new state.
An active unfinished run that must be abandoned can release its occupancy with `sasu implement retire --slug <topic-slug>`.
Retiring a run owned by another session requires `--adopt '<verbatim user approval>'`, and the evidence is recorded with the transition.
Run `sasu doctor` to list active retire candidates and worktrees that remain after their run ended.

## Attribution

Do not add agent, model, vendor, or tool attribution to branches, commits, PR text, release notes, or generated handoff content.
