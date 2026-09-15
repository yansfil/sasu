# Worktrees and delivery

Read this reference when a run uses a worktree or the approved delivery mode is `pr`.

## Trees

`sasu implement start` may return an isolated worktree.
Make product changes and run verification there.
The record tree retains `state.json`, the approved PRD snapshot, registered evidence metadata, verification reports, and delivery logs under `agents/**`.
Use the explicit `--state` path when crossing between them.

## Delivery boundary

Delivery starts after the current deterministic verification report is PASS.
No finalize command or receipt is required.
`$ship` validates report freshness, the exact committed head, delivery path boundaries, base freshness, learned rules, CI, mergeability, and explicit merge approval.

Local delivery:

```sh
node ~/.codex/skills/ship/scripts/prd_ship.js local --state agents/runs/<slug>/state.json
```

PR delivery:

```sh
node ~/.codex/skills/ship/scripts/prd_ship.js preflight --state agents/runs/<slug>/state.json
node ~/.codex/skills/ship/scripts/prd_ship.js body --state agents/runs/<slug>/state.json
node ~/.codex/skills/ship/scripts/prd_ship.js ship --state agents/runs/<slug>/state.json --title '<title>'
```

The Claude installation substitutes its own skill root.

The PR body carries the deterministic report, visible agent review notes, Fix now dispositions, Follow-up improvements, actual evidence, and human review focus.
A reviewer process does not grant or remove delivery eligibility.
A source fix after review changes the head, so rerun deterministic verification and fresh native reviews before updating the PR.

Use reviewer-visible screenshot URLs or committed stable paths.
Do not use a local absolute path as the only PR evidence.

Merge remains a separate human-authorized action.
The delivery script pins the PR head and requires CI and repository merge conditions to pass.
