# Worktrees and delivery

Read this reference when a run uses a worktree or the approved delivery mode is `pr`.

## Trees

Choose the product checkout before sealing the contract.
Hide owns creating or reusing the branch and worktree.
`sasu implement start` seals the current checkout and its required suite working directories.
The generated spawn command passes that existing branch and path to Hide.
Records remain under the selected checkout's `agents/**` namespace.
Use the explicit `--state` path in the handoff when invoking commands from another checkout.

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
A source fix after review changes the head, so request the follow-up review with the prior context and rerun deterministic verification before updating the PR.

Use reviewer-visible screenshot URLs or committed stable paths.
Do not use a local absolute path as the only PR evidence.

Merge remains a separate human-authorized action.
The delivery script pins the PR head and requires CI and repository merge conditions to pass.
