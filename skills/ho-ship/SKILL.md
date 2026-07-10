---
name: ho-ship
description: |
  Publish a completed `ho-build` run through GitHub PR delivery. Use when
  the user invokes "$ho-ship" or when
  the user asks to ship, open a PR, push a completed PRD implementation, watch
  CI, use PR delivery mode, or continue after `ho-build` receipt until a
  pull request exists and required checks pass.
---

# ho-ship

Artifact paths keep the legacy `prd-ship` naming (`delivery/ship-log.jsonl`, `prd_ship.js`).

Use this skill after `ho-build` has produced a complete receipt and the
delivery target is a GitHub pull request.

This skill is a delivery gate, not an implementation gate. Do not weaken or
replace `ho-build` receipt checks. If the implementation receipt is
missing, partial, blocked, stale, or contradicted by current repo state, return
to `ho-build` first.

Match the user's language by default.

## Inputs

Prefer an explicit state path:

```text
agents/implement/<topic-slug>/state.json
```

If no path is provided, read:

```text
agents/implement/.prd-implement-active.json
```

Required files:

```text
agents/implement/<topic-slug>/state.json
agents/implement/<topic-slug>/receipt.json
agents/implement/<topic-slug>/implementation-result.md
```

Optional project config:

```json
{
  "delivery": {
    "mode": "pr",
    "branchPrefix": "prd",
    "baseBranch": "main",
    "prTemplate": ".github/pull_request_template.md",
    "staging": {
      "include": [],
      "exclude": []
    },
    "ci": {
      "watch": true,
      "maxFixAttempts": 2
    }
  },
  "worktree": {
    "enabled": true,
    "root": "../<repo>.worktrees",
    "link": [".env", ".env.local"],
    "copy": [".dev.vars"],
    "setup": ["pnpm install"]
  }
}
```

`worktree.enabled` is opt-in. Do not create worktrees merely because delivery
mode is `pr`.

`delivery.staging.include` and `delivery.staging.exclude` are optional repo
relative path prefixes.
They augment the default delivery allowlist.
The default allowlist includes the PRD directory, the current implementation
run directory, the project `agents/config.json` when recorded in state, and
execution-plan write scopes.

## Required Flow

```text
complete ho-build receipt
  -> delivery preflight (receipt, mode, freshness, base freshness, staging plan, body status)
  -> rebase onto origin base when preflight reports the branch behind
  -> body: generate the PR body draft
  -> agent writes the prose sections of the draft
  -> ship: validate gates, commit, push, create or update PR, watch CI
  -> if CI fails, fix through the implementation workflow, refresh reviews, re-ship
  -> report PR URL and CI state
```

## Guardrails Versus Agent Judgment

The script owns mechanical guardrails.
The agent owns everything that needs judgment.
Do not move judgment into the script, and do not bypass guardrails with ad-hoc git/gh commands.

Script-enforced guardrails (fail closed):

- receipt must be `complete`.
- delivery mode must be `pr`.
- reviews and receipt must be fresh against the current worktree (`prd_state_harness.js verify-delivery`).
- the branch must not be behind `origin/<base>`; `preflight` fetches and reports
  `baseFreshness`, and `ship` refuses a stale base (`--allow-stale-base --reason` to override).
  When behind, rebase onto the origin base, resolve conflicts, rerun the relevant
  verification, and only then ship; discovering the conflict after PR creation
  wastes a full CI round.
- staging is restricted to the delivery allowlist; unrelated changes fail the run.
- the PR body must have no remaining `AGENT-FILL` placeholders and no AI agent attribution.

Agent-owned judgment:

- the PR title and every prose section of the body (Summary, Result, Human Review Focus, Risks).
- diagnosing CI failures and choosing the fix strategy.
- deciding when to stop retrying and hand off to the user.
- deciding whether an override is justified, with the user's explicit approval.

Every guardrail has an explicit override flag that requires `--reason` and is recorded in
`delivery/ship-log.jsonl`.
Use an override only with the user's explicit approval, and quote that approval in the reason.

## Commands

```sh
node ~/.codex/skills/ho-ship/scripts/prd_ship.js preflight --state agents/implement/<topic-slug>/state.json
node ~/.codex/skills/ho-ship/scripts/prd_ship.js body --state agents/implement/<topic-slug>/state.json
node ~/.codex/skills/ho-ship/scripts/prd_ship.js ship --state agents/implement/<topic-slug>/state.json --title "<PR title>"
node ~/.codex/skills/ho-ship/scripts/prd_ship.js watch-ci --state agents/implement/<topic-slug>/state.json [--timeout <seconds>]
node ~/.codex/skills/ho-ship/scripts/prd_ship.js status --state agents/implement/<topic-slug>/state.json
```

`body` writes a draft to `agents/implement/<topic-slug>/delivery/pr-body.md`.
The draft contains deterministic evidence sections generated from state (acceptance, verification,
reviews, staging, changed paths) plus `AGENT-FILL` placeholders for the prose sections.
Fill every placeholder with prose grounded in `implementation-result.md` and the recorded reviews,
following the repository PR template rules, then run `ship`.
`body` refuses to overwrite an existing body file without `--force`, so agent-written prose is not
silently discarded.

`ship` validates all guardrails, stages allowlisted changes, commits, pushes, creates the PR, or
updates the body of an existing PR, then watches CI with a bounded timeout.
Exit codes: `0` shipped and CI passed (or no checks), `2` CI failed, `3` CI still pending at the
timeout (rerun `watch-ci`), `1` a guardrail refused the run.

Use `--no-gpg-sign` only when the local git signing configuration blocks the
delivery commit in a non-interactive session.

`ship` stages only changes allowed by the completed implementation state:

```text
PRD directory
agents/config.json when recorded in state
agents/implement/<topic-slug>/ except artifacts/
execution-plan write scopes
delivery.staging.include entries
```

It always excludes volatile implementation pointers and registered artifact
directories unless explicitly overridden by an approved include path.
Review `preflight` and `git status --short` before running `ship`.
If unrelated user changes are present, `ship` must fail instead of staging them.
Commit only the current PRD implementation, skill updates, or delivery artifacts
that belong in the PR.

## CI Failure Loop

`watch-ci` polls checks with a bounded timeout instead of blocking forever.
Exit `3` means checks are still pending: rerun `watch-ci` (raise `--timeout` if the pipeline is
known to be slow) instead of assuming failure.

When checks fail (exit `2`):

1. Read the failing check log with `gh run view --log` or the provider's native
   output.
2. Diagnose and fix the underlying issue in the same branch or worktree.
3. Run the closest local verification first.
4. Source fixes make the recorded reviews stale.
   Rerun the affected verification, requirements fidelity review, final review, and
   `finalize` through the ho-build harness before shipping again.
   `ship` re-checks freshness and will refuse a stale re-ship.
5. Rerun `ship` to commit, push, and refresh the PR body if the fix changed anything the body
   describes.
6. Repeat up to the configured `delivery.ci.maxFixAttempts`, unless the user
   explicitly asks to continue.

Do not hide CI failures behind a successful PR creation. The delivery result is
not complete until required checks pass or the handoff explicitly says CI is
blocked.

## PR Body Rules

The PR body must be project work, not agent work.

The script generates the evidence sections; the agent writes the prose.
Never accept a body that still contains `AGENT-FILL` placeholders, and never pad the prose with
claims the recorded evidence does not back.

Include:

- PRD path.
- implementation receipt path and status.
- user-visible or developer-visible changes.
- verification evidence grouped by mode.
- requirements fidelity and final review verdicts.
- deviations or remaining human review.

For visual PRs, include reviewer-visible screenshots in `Screenshots / Demo`.
Prefer inline Markdown images, not only text links.
Use one of these forms:

- Best: `![Alt](https://github.com/user-attachments/assets/<id>)` after pasting or uploading images to the PR body.
- Good for committed screenshots: `![Alt](https://github.com/<owner>/<repo>/blob/<commit-or-branch>/<path>.png?raw=true)`.

For private repositories, do not use `raw.githubusercontent.com` image URLs in
the PR body.
They often render as 404 for reviewers because they are unauthenticated.
Do not paste GitHub API `download_url` values either; they can contain
temporary tokens that expire or leak credential-bearing URLs.
If inline rendering is not possible, use commit-pinned `blob/<sha>/<path>` links
and explicitly say that they are screenshot links.
After opening or updating the PR, inspect the `Screenshots / Demo` section and
confirm key images render inline.

Never add AI agent, model, vendor, or tool attribution.
The script rejects common attribution patterns, but that check is a backstop, not the rule.

## Final Report

Report:

- PR URL.
- branch and base branch.
- commit hash or existing pushed commits.
- CI verdict and checked workflow names.
- receipt path.
- any remaining human review or merge blockers.
