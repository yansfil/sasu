---
name: ho-setup
description: |
  Project-local PRD pipeline configuration. Use when the user invokes
  "$ho-setup", asks to enable or change PR delivery mode, configure
  worktree/secrets sync for implement, configure the agents/ namespace
  gitignore policy, inspect the current PRD pipeline settings, or diagnose why
  implement/ship delivery is not working.
---

# ho-setup

Use this skill to inspect or configure how the PRD pipeline
(`implement` and `ship`) behaves in the current repository.

This skill owns project setup files only:

- `agents/config.json`
- `.gitignore` entries that control which `agents/` artifacts are tracked

It never touches PRDs, implementation state, or delivery branches.
Match the user's language by default.

## Inspect First

Always start with the doctor:

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js doctor
```

It reports the effective delivery config (config file plus defaults), unknown or
misspelled config keys, git/origin/gh readiness, worktree sync source problems,
PR template resolution, ship availability, hook registration, checkshirt gate
CLI readiness (binary contract version, judge backends, verify commands), and
any active run with its ship-pending state.

If the user only asked "what is the current setting", report the doctor output
and stop.

## Configure

When the user wants to change settings, interview briefly with defaults, write
`agents/config.json`, and keep `.gitignore` aligned.

On first setup in a project, also seed the agent-facing structure notes before
the config interview:

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js seed-agents-md
```

This writes (or updates, marker-based and idempotent) a Harness Namespace
section in AGENTS.md explaining `agents/prd`, `agents/rules`,
`agents/implement`, the gitignore policy, and how to consult learned rules,
and it creates the `CLAUDE.md -> AGENTS.md` symlink.
If CLAUDE.md already exists as a regular file, the command refuses; show the
user the content, get confirmation, and rerun with `--adopt-claude-md`.

Then interview:

1. Delivery mode: `local` (default) or `pr`.
   Remind the user that `pr` means implement runs end into `ship`
   (branch, PR, CI) automatically after the receipt, and that per-PRD approval
   still happens in the PRD Summary checklist.
2. When mode is `pr`: base branch (default `main`) and branch prefix
   (default `gen-prd`).
3. Worktree isolation: `worktree.enabled` (default false).
   When enabled, ask which gitignored local files the app needs:
   - `link`: read-only shared files (`.env`, certs).
   - `copy`: files the app writes to (`.dev.vars`, local DBs).
   - `setup`: install commands to run once in the new worktree
     (for example `pnpm install`).
   Warn that dev servers in two checkouts share ports and linked local DBs.
4. CI: `ci.maxFixAttempts` (default 2), `ci.timeoutSeconds` (default 240).
5. `agents/` tracking policy:
   - Everything under `agents/` is committed and reviewable by default:
     `agents/prd/**`, `agents/rules/**`, `agents/config.json`.
   - Only runtime state is ignored: `agents/implement/**` and `agents/gates/**`.
6. Checkshirt judge gates (optional; defaults work without config):
   - `judge.backend`: `auto` (default; prefers claude, falls back to codex),
     `claude`, or `codex`. Judging with a different vendor than the
     implementing runtime is recommended for reviewer independence but not
     enforced in v1.
   - `judge.tierModels`: per-backend model per tier. Defaults:
     claude frugal=`claude-haiku-4-5` (gap-audit/spec), standard=`claude-sonnet-5`
     (semantic verify), frontier=`claude-opus-4-8`; codex uses the user's own
     CLI default model unless configured.
   - `judge.retryBudget`: autonomous fix-and-regate attempts per gate
     (default 2).
   - `verify.commands`: mechanical verify commands (`test`, `lint`,
     `typecheck`, `build`). Declared commands win; otherwise checkshirt
     detects from manifests and suggests pinning here.

Recommended `.gitignore` block (one line):

```gitignore
# PRD pipeline runtime state
agents/implement/
agents/gates/
```

Projects that still have a legacy `.hoyeon` tree keep their old ignore rules
untouched; the legacy tree is a read-only fallback and new runs write under
`agents/`. Do not add contradictory duplicates for either namespace.

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
  },
  "judge": {
    "backend": "auto",
    "retryBudget": 2,
    "tierModels": {
      "claude": { "frugal": "claude-haiku-4-5", "standard": "claude-sonnet-5", "frontier": "claude-opus-4-8" }
    }
  },
  "verify": {
    "commands": { "test": "pnpm test", "lint": "pnpm lint" }
  }
}
```

Preserve unrelated keys that already exist in the file.
Commit the config change like normal project work.

## Validate

After writing setup files, rerun `doctor` and resolve every `error` before
finishing. Resolve gitignore warnings unless the user explicitly wants a
different tracking policy. Report remaining `warn` items to the user with a
one-line judgment each (fix now, fix later, or intentional).

## Hard Stops

- Do not flip an in-flight run's delivery mode by editing state.json; config
  changes apply from the next `init`.
- Do not enable `pr` mode when the user has not confirmed the repository may
  receive automated pushes and PRs.
