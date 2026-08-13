# Worktrees And Delivery

Read this reference when delivery is `pr`, a worktree is configured, or post-receipt delivery is requested.

## Boundary

Implementation completion and PR delivery are separate outcomes.
`sasu implement finalize` creates the implementation receipt before commit, push, PR creation, CI observation, or merge.

## Local Delivery

The default delivery mode is local.
Do not commit, push, or open a PR unless the user or repository configuration asks for it.

## PR Delivery

When PR delivery is authorized:

1. Complete the implementation receipt in the intended checkout or configured worktree.
2. Follow the repository PR template.
3. Stage only implementation-owned changes and preserve unrelated dirty files.
4. Use `$ship` for commit, push, PR creation, and CI handoff.

PR creation and CI are never required to prove implementation completion.

## Existing Runs

The new implement state schema does not migrate old runs.
Start a new run in the intended checkout.
Do not add compatibility adapters or copy old completion verdicts into the new state.

## Attribution

Do not add agent, model, vendor, or tool attribution to branches, commits, PR text, release notes, or generated handoff content.
