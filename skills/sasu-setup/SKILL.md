---
name: sasu-setup
description: |
  Project-local PRD pipeline configuration. Use when the user invokes
  "$sasu-setup", asks to enable or change PR delivery mode, configure
  worktree/secrets sync for implement, configure the agents/ namespace
  gitignore policy, inspect the current PRD pipeline settings, or diagnose why
  implement/ship delivery is not working.
---

# sasu-setup

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
sasu doctor
```

It reports the effective delivery config (config file plus defaults), unknown or
misspelled config keys, git/origin/gh readiness, worktree sync source problems,
ship availability, hook registration, sasu gate
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
sasu setup seed-agents-md
```

This writes (or updates, marker-based and idempotent) a Harness Namespace
section in AGENTS.md explaining `agents/prd`, `agents/rules`,
`agents/runs`, the gitignore policy, and how to consult learned rules,
and it creates the `CLAUDE.md -> AGENTS.md` symlink.
If CLAUDE.md already exists as a regular file, the command refuses; show the
user the content, get confirmation, and rerun with `--adopt-claude-md`.

Then interview:

1. Delivery mode: `local` (default) or `pr`.
   Local means a complete receipt ends with one semantic local commit and no
   push, PR, or CI side effect.
   Remind the user that `pr` means implement runs end into `ship`
   (branch, PR, CI) automatically after the receipt, and that per-PRD approval
   still happens in the PRD Summary checklist.
2. When mode is `pr`: base branch and branch prefix (default `gen-prd`).
   Always write `baseBranch` explicitly: when it is omitted, the harness
   defaults to whatever branch is current at `implement init` time, not
   `main`, so a run started from a feature branch would open its PR against
   that feature branch.
3. Worktree isolation: `worktree.enabled` (default false).
   The harness always isolates a run whose target tree already hosts an
   active in-place run; `enabled: true` additionally isolates every run from
   the start (the human keeps using the main checkout while runs work in
   worktrees). Either way ask which gitignored local files the app needs:
   - `link`: read-only shared files (`.env`, certs).
   - `copy`: files the app writes to (`.dev.vars`, local DBs).
   - `setup`: install commands to run once in the new worktree
     (for example `pnpm install`).
   Warn that dev servers in two checkouts share ports and linked local DBs.
4. CI: `ci.maxFixAttempts` (default 2), `ci.timeoutSeconds` (default 240).
5. `agents/` tracking policy:
   - Human-approved assets are committed and reviewable: `agents/prd/**`,
     `agents/rules/**`, `agents/config.json`.
   - Generated run state is ignored: `agents/runs/**` (one run dir per slug
     holding gate verdicts and implement state) and `agents/quick/**` (a quick
     lane's generated contract, receipt, verify verdict and evidence blobs),
     plus the legacy `agents/implement/**` and `agents/gates/**` in projects
     that still carry old-layout runs.
   - Any sasu command auto-provisions both runtime roots into
     `.git/info/exclude`; a committed `.gitignore` line is the project's
     decision and is what a team shares.
6. Sasu judge gates (optional; defaults work without config):
   - `judge.profiles.routine`: primary and fallback target for interview,
     document-gate, acceptance, fidelity, and normal semantic judgment.
     The default is Codex `gpt-5.6-luna` max, then Claude Sonnet 5 xhigh.
   - `judge.profiles.high-risk`: primary and fallback target for the final
     high-risk lane.
     The default is Codex `gpt-5.6-luna` max, then Claude Opus 5 xhigh.
     Both primaries run the same model at the same ceiling; the profiles
     differ by fallback.
   - Each target has `backend`, `model`, and `effort`; `fallback: null`
     explicitly disables fallback for that profile.
   - `judge.retryBudget`: autonomous fix-and-regate attempts per gate
     (default 3; advisory for autonomous loops - a user-instructed re-run is
     never locked).
   - `judge.fanout`: lane-parallel judging for gap-audit (4 document-area
     lanes) and spec (2 review-axis lanes), merged mechanically by the CLI
     (default `true`; set `false` to restore the single exhaustive judge).
   - Evidence access is not configurable.
     Prompt-only Codex calls use an empty ephemeral work root.
     File-reading Codex calls see only exact allowlisted files copied into a
     disposable read-only workspace, while Claude fallback grants Read/Grep.
   - `verify.commands`: mechanical verify commands (`test`, `lint`,
     `typecheck`, `build`). Declared commands win; otherwise sasu
     detects from manifests and suggests pinning here. Each entry is one
     command run as argv without a shell, so `a && b` is refused at load;
     use one runner invocation (for example one `node --test` with several
     globs) instead of shell composition.
   - `verify.commandTimeoutMs`: per-command timeout for mechanical verify
     runs (default 600000 = 10 minutes); a hung suite fails closed at the
     timeout instead of hanging the gate.
7. Principles: `principles` (default `[]`). Paths to principle repositories
   whose ROOT.md domain table names the rule documents (`~` expands). When
   declared, `sasu principles list` serves the domains and the gen-prd/quick
   skills translate matching rules into PRD guardrails and acceptance
   criteria before drafting. Declining the question writes no key and changes
   nothing; verify with `sasu principles list` after declaring.

Recommended `.gitignore` block:

```gitignore
# PRD pipeline runtime state
agents/runs/
agents/quick/
agents/interview/*/.cadence.json
```

The qa-log itself stays tracked; `.cadence.json` beside it is per-machine
decision-write cadence bookkeeping and never belongs in review.

Projects that still carry legacy-layout runs also keep the old lines
(`agents/implement/`, `agents/gates/`) until those runs are gone.

`agents/` is the only harness namespace. Do not add contradictory duplicate
ignore rules for it.

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
    "retryBudget": 5,
    "fanout": true,
    "profiles": {
      "routine": {
        "primary": { "backend": "codex", "model": "gpt-5.6-luna", "effort": "max" },
        "fallback": { "backend": "claude", "model": "claude-sonnet-5", "effort": "xhigh" }
      },
      "high-risk": {
        "primary": { "backend": "codex", "model": "gpt-5.6-luna", "effort": "max" },
        "fallback": { "backend": "claude", "model": "claude-opus-5", "effort": "xhigh" }
      }
    }
  },
  "verify": {
    "commands": { "test": "pnpm test", "lint": "pnpm lint" },
    "commandTimeoutMs": 600000
  },
  "principles": ["~/projects/oh-my-principle"]
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
