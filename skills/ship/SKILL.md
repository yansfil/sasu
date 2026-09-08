---
name: ship
description: |
  Deliver a completed `implement` receipt locally or through GitHub PR delivery.
  Use when the user invokes "$ship" or explicitly asks to create a local
  implementation commit, open or update a PR, push a completed PRD
  implementation, watch CI, or merge an approved green PR through the recorded
  delivery workflow.
  Do not use before a complete `implement` receipt exists.
---

# ship

Artifact paths keep the legacy `prd-ship` naming (`delivery/ship-log.jsonl`, `prd_ship.js`).

Use this skill after `implement` has produced a complete receipt.
`local` records the implementation as a semantic local commit without external
delivery, while `ship` handles the separate GitHub pull request path.

This skill is a delivery gate, not an implementation gate. Do not weaken or
replace `implement` receipt checks. If the implementation receipt is
missing, partial, blocked, stale, or contradicted by current repo state, return
to `implement` first.

Match the user's language by default.

## Inputs

Prefer an explicit state path:

```text
agents/runs/<topic-slug>/state.json
```

If no path is provided, read:

```text
agents/runs/.prd-implement-active.json
```

Required files:

```text
agents/runs/<topic-slug>/state.json
agents/runs/<topic-slug>/receipt.json
agents/runs/<topic-slug>/implementation-result.md
```

Optional project config:

```json
{
  "delivery": {
    "mode": "pr",
    "branchPrefix": "prd",
    "baseBranch": "main",
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

Worktrees are created by the harness at `sasu implement start` (always when
`worktree.enabled` is true, and automatically when the target tree already
hosts an active in-place run). Do not create worktrees yourself, and do not
create one merely because delivery mode is `pr`. A worktree run's records
(state, receipt) live in the record tree's `agents/`; its code lives on the
run branch in the worktree, which is where ship stages and commits.

`delivery.staging.include` and `delivery.staging.exclude` are optional repo
relative path prefixes.
They augment the default delivery allowlist.
The default allowlist includes the PRD directory, the current implementation
run directory, the project `agents/config.json` when recorded in state, and
recorded run-owned source files.

## Required Flow

```text
complete implement receipt
  -> local: validate freshness and rules, commit the allowlisted implementation,
     record the local delivery result, stop
  OR
  -> PR preflight (receipt, mode, freshness, base freshness, staging plan, body status)
  -> rebase onto origin base when preflight reports the branch behind
  -> body: generate the PR body draft
  -> agent writes the prose sections of the draft
  -> ship: validate gates, commit, push, create or update PR, watch CI
  -> if CI fails, fix through the implementation workflow, refresh reviews, re-ship
  -> report PR URL and CI state
  -> when the user explicitly approved merge: merge with the reviewed head pinned
  -> record PR URL, CI verdict, implementation head, and merge commit
```

## Guardrails Versus Agent Judgment

The script owns mechanical guardrails.
The agent owns everything that needs judgment.
Do not move judgment into the script, and do not bypass guardrails with ad-hoc git/gh commands.

Script-enforced guardrails (fail closed):

- receipt schema must be `sasu.implement.receipt.v6` and state schema `sasu.implement.state.v10` before any result is consumed; retired formats fail explicitly with the last supported commit.
- receipt must be `complete` or `complete-pending-human` and currently delivery-eligible.
  Permitted pending human confirmation travels in the PR body; an open explicit rejection blocks delivery.
- `local` accepts only local mode; it never pushes, invokes GitHub, creates a PR,
  watches CI, or merges.
- `ship` and `merge` accept only `pr` mode unless their documented explicit
  mode override is supplied.
- the implement receipt must match the fresh PASS reported by `sasu implement status` for the current worktree.
  Both settled role results and their valid assessment grounds must be present; missing or unresolved Fidelity coverage cannot be delivered as complete.
- for PR delivery, the branch must not be behind `origin/<base>`; `preflight` fetches and reports
  `baseFreshness`, and `ship` refuses a stale base (`--allow-stale-base --reason` to override).
  When behind, rebase onto the origin base, resolve conflicts, rerun the relevant
  verification, and only then ship; discovering the conflict after PR creation
  wastes a full CI round.
- staging is restricted to the delivery allowlist; unrelated changes fail the run.
- the PR body must have no remaining `AGENT-FILL` placeholders and no AI agent attribution.
- `merge` has no stale-state or stale-base override.
  It requires verbatim user approval, a complete fresh receipt, fresh reviews,
  a branch current with `origin/<base>`, an open non-draft mergeable PR, passing
  CI, and a PR head exactly matching the reviewed local HEAD.
  The GitHub merge is pinned with `--match-head-commit` so a concurrent push
  cannot change what gets merged.

Agent-owned judgment:

- the PR title and every prose section of the body (Summary, Result, Human Review Focus, Risks).
- diagnosing CI failures and choosing the fix strategy.
- deciding when to stop retrying and hand off to the user.
- deciding whether an override is justified, with the user's explicit approval.

Every supported pre-merge override requires `--reason` and is recorded in
`delivery/ship-log.jsonl`.
Use an override only with the user's explicit approval, and quote that approval in the reason.
The final `merge` gate is intentionally stricter and has no freshness, base, CI,
or head override.

## Commands

```sh
node ~/.codex/skills/ship/scripts/prd_ship.js preflight --state agents/runs/<topic-slug>/state.json
node ~/.codex/skills/ship/scripts/prd_ship.js body --state agents/runs/<topic-slug>/state.json
node ~/.codex/skills/ship/scripts/prd_ship.js local --state agents/runs/<topic-slug>/state.json
node ~/.codex/skills/ship/scripts/prd_ship.js ship --state agents/runs/<topic-slug>/state.json --title "<PR title>"
node ~/.codex/skills/ship/scripts/prd_ship.js watch-ci --state agents/runs/<topic-slug>/state.json [--timeout <seconds>]
node ~/.codex/skills/ship/scripts/prd_ship.js merge --state agents/runs/<topic-slug>/state.json --approval "<verbatim user approval>" [--method squash|merge|rebase]
node ~/.codex/skills/ship/scripts/prd_ship.js status --state agents/runs/<topic-slug>/state.json
```

`body` writes a draft to `agents/runs/<topic-slug>/delivery/pr-body.md`.
The draft contains deterministic evidence sections derived from the current receipt (actual tests, shared QA observations, separate Fidelity and Code review results, open issues and human responses, staging, changed paths) plus `AGENT-FILL` placeholders for the prose sections.
Fill every placeholder with prose grounded in `implementation-result.md` and the recorded reviews,
following the repository PR template rules, then run `ship`.
The receipt retains grouped assessment grounds; summarize their actual support and limitations without turning them into a per-requirement proof table or claiming mechanical certainty.
`body` refuses to overwrite an existing body file without `--force`, so agent-written prose is not
silently discarded.

`local` validates the complete receipt against a fresh implementation PASS and the learned rules,
stages only the delivery allowlist, creates one semantic commit (default message
`Implement <topic-slug>`), and records
`agents/runs/<topic-slug>/delivery/delivery-result.json` plus a `local` event in
`delivery/ship-log.jsonl`.
It does not call `gh`, push, create a PR, watch CI, or merge.
Running it again for the same receipt and HEAD returns the recorded result without a second commit.
If the Stop hook has already saved the same unpushed run as a `checkpoint:` commit, local delivery
promotes that commit's message only after it proves the recorded baseline, allowlist, and remote
reachability conditions.

`ship` validates all guardrails, stages allowlisted changes, commits, pushes, creates the PR, or
updates the body of an existing PR, then watches CI with a bounded timeout.
Exit codes: `0` shipped and CI passed (or no checks), `2` CI failed, `3` CI still pending at the
timeout (rerun `watch-ci`), `1` a guardrail refused the run.

`merge` is a separate, explicitly approved action.
Pass the user's merge instruction verbatim through `--approval`.
When implementation was finalized in local delivery mode and the user approves PR delivery later, also pass `--override-mode --reason "<verbatim user approval>"`.
This mode override records new delivery authorization only and does not bypass freshness, base, CI, mergeability, or reviewed-head checks.
The command revalidates implementation freshness after the delivery commit,
proves the local and remote PR heads are identical, checks CI and GitHub
mergeability, then writes
`agents/runs/<topic-slug>/delivery/delivery-result.json` and a `merge`
event in `delivery/ship-log.jsonl`.
Use this command instead of raw `gh pr merge` for PRD delivery.
If it refuses because source or evidence changed, return to `implement`; do not
bypass it with a direct GitHub command.

Use `--no-gpg-sign` only when the local git signing configuration blocks the
delivery commit in a non-interactive session.

`local` and `ship` stage only changes allowed by the completed implementation state:

```text
PRD directory
agents/config.json when recorded in state
agents/runs/<topic-slug>/ except artifacts/ and gates/
recorded run-owned source files
delivery.staging.include entries
```

It always excludes volatile implementation pointers and registered artifact
directories unless explicitly overridden by an approved include path.
Review the delivery command output and `git status --short` before running `local` or `ship`.
If unrelated user changes are present, `local` and `ship` must fail instead of staging them.
Commit only the current PRD implementation, skill updates, or delivery artifacts
that belong in the PR.

Completed-result freshness and explicit human rejection have no delivery bypass.
Only the existing approved base/mode/rules exceptions remain, with their recorded reasons.

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
   A closed run is not reopened: start an authorized new run for the source fix, execute its required suites and both full-contract reviews, and finalize a current receipt before shipping again.
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
- actual required tests and shared QA observations, including limitations.
- independent Fidelity and Code review results, their actual assessment grounds and limitations, and any distinct high-risk result.
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
- merge commit and delivery-result path when merge was approved and completed.
- any remaining human review or merge blockers.
