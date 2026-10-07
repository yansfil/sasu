---
name: sasu-setup
description: |
  Project-local PRD pipeline configuration. Use when the user invokes
  "$sasu-setup", asks to enable or change PR delivery mode, configure
  checkout preparation for implement, configure the agents/ namespace
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
misspelled config keys, git/origin/gh readiness, checkout preparation problems,
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
   Local means a current deterministic PASS report ends with one semantic local commit and no
   push, PR, or CI side effect.
   Remind the user that `pr` means implement runs end into `ship`
   (branch, PR, CI) automatically after verification, and that per-PRD approval
   still happens in the PRD Summary checklist.
2. When mode is `pr`: `delivery.baseBranch` (default `main`).
   Prepare the intended branch before sealing the run.
   Verification and delivery use the checkout containing the run record and its current attached branch.
   The baseline is the current merge-base with `origin/<delivery.baseBranch>` when origin is configured, otherwise the local configured base branch.
3. Checkout preparation: use Hide to create or reuse the intended branch and checkout before sealing the run.
   Prepare required local configuration and dependencies there under the existing project policy.
   The retired `worktree.enabled`, `worktree.root`, `worktree.link`, `worktree.copy` and `worktree.setup` keys no longer provision anything.
   Remove configured provisioning from `agents/config.json`; nonempty old configuration is refused rather than silently skipped.
4. CI: `delivery.ci.timeoutSeconds` (default 240).
5. `agents/` tracking policy:
   - Human-approved assets are committed and reviewable: `agents/prd/**`,
     `agents/rules/**`, `agents/config.json`.
   - Generated run state is ignored: `agents/runs/**` (one run dir per slug
     holding gate verdicts and implement state) and `agents/quick/**` (a quick
     path's generated contract, verification report, verify result and evidence blobs),
     plus the legacy `agents/implement/**` and `agents/gates/**` in projects
     that still carry old-layout runs.
   - Any sasu command auto-provisions both runtime roots into
     `.git/info/exclude`; a committed `.gitignore` line is the project's
     decision and is what a team shares.
6. Required suites and document judges (defaults work without config):
   - `judge.profiles.routine`: primary and fallback target for interview coherence, gap-audit and spec.
     The default is Codex `gpt-5.6-luna` high, then Claude Sonnet 5 high.
   - Each target has `backend`, `model`, and `effort`; `fallback: null` explicitly disables fallback for that profile.
     Remove unused `judge.profiles.high-risk` and `judge.retryBudget` settings from project config.
     Implementation review uses native subagents, and `implement verify` runs deterministic checks without a model.
   - `judge.timeoutMs`: wall-clock cap for one judge call (default 900000 = 15 minutes).
     The primary and fallback each get the full timeout, so a call that times out on both can take twice this long.
   - `judge.laneEffort`: overrides the gap-audit and spec reasoning effort (`low` to `max`).
     The default `null` uses each gate's measured effort.
   - `judge.readMaxRounds`: read rounds a non-exploring agentic judge may spend before its reply is discarded (default 29).
     It does not limit native implementation reviewers.
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
   skills translate matching rules into product requirements, constraints, and decisions before drafting. Declining the question writes no key and changes
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
    "staging": { "include": [], "exclude": [] },
    "ci": { "timeoutSeconds": 240 }
  },
  "judge": {
    "fanout": true,
    "profiles": {
      "routine": {
        "primary": { "backend": "codex", "model": "gpt-5.6-luna", "effort": "high" },
        "fallback": { "backend": "claude", "model": "claude-sonnet-5", "effort": "high" }
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

- Do not edit `state.json` to change delivery policy.
  Approved changes belong in `agents/config.json` in the checkout containing the run record.
  Delivery reads the current config on each invocation.
  Rerun verification before delivery when its inputs change.
- Do not enable `pr` mode when the user has not confirmed the repository may
  receive automated pushes and PRs.
