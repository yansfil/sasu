---
name: prd-setup
description: |
  Project-local PRD pipeline configuration. Use when the user invokes
  "$prd-setup", asks to enable or change PR delivery mode, configure
  worktree/secrets sync for prd-implement, inspect the current PRD pipeline
  settings, or diagnose why prd-implement/prd-ship delivery is not working.
---

# prd-setup

Use this skill to inspect or configure how the PRD pipeline
(`prd-implement` and `prd-ship`) behaves in the current repository.

This skill owns exactly one file: `.hoyeon/config.json`.
It never touches PRDs, implementation state, or delivery branches.
Match the user's language by default.

## Inspect First

Always start with the doctor:

```sh
node ~/.codex/skills/prd-implement/scripts/prd_state_harness.js doctor
```

It reports the effective delivery config (config file plus defaults), unknown or
misspelled config keys, git/origin/gh readiness, worktree sync source problems,
PR template resolution, prd-ship availability, hook registration, and any
active run with its ship-pending state.

If the user only asked "what is the current setting", report the doctor output
and stop.

## Configure

When the user wants to change settings, interview briefly with defaults and
write `.hoyeon/config.json`:

1. Delivery mode: `local` (default) or `pr`.
   Remind the user that `pr` means prd-implement runs end into `prd-ship`
   (branch, PR, CI) automatically after the receipt, and that per-PRD approval
   still happens in the PRD Summary checklist.
2. When mode is `pr`: base branch (default `main`) and branch prefix
   (default `prd`).
3. Worktree isolation: `worktree.enabled` (default false).
   When enabled, ask which gitignored local files the app needs:
   - `link`: read-only shared files (`.env`, certs).
   - `copy`: files the app writes to (`.dev.vars`, local DBs).
   - `setup`: install commands to run once in the new worktree
     (for example `pnpm install`).
   Warn that dev servers in two checkouts share ports and linked local DBs.
4. CI: `ci.maxFixAttempts` (default 2), `ci.timeoutSeconds` (default 240).

Reference shape:

```json
{
  "delivery": {
    "mode": "pr",
    "baseBranch": "main",
    "branchPrefix": "prd",
    "staging": { "include": [], "exclude": [] },
    "ci": { "watch": true, "maxFixAttempts": 2, "timeoutSeconds": 240 }
  },
  "worktree": {
    "enabled": true,
    "link": [".env"],
    "copy": [],
    "setup": ["pnpm install"]
  }
}
```

Preserve unrelated keys that already exist in the file.
Commit the config change like normal project work.

## Validate

After writing the file, rerun `doctor` and resolve every `error` before
finishing. Report remaining `warn` items to the user with a one-line judgment
each (fix now, fix later, or intentional).

## Hard Stops

- Do not flip an in-flight run's delivery mode by editing state.json; config
  changes apply from the next `init`.
- Do not enable `pr` mode when the user has not confirmed the repository may
  receive automated pushes and PRs.
