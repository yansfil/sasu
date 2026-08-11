# Worktrees And Delivery

Read this reference when `agents/config.json` exists, delivery mode is `pr`, a worktree is enabled, initialization resumes existing state, or session binding and active pointers need diagnosis.

## Contents

- [Configuration And Doctor](#configuration-and-doctor)
- [Session-Bound Initialization](#session-bound-initialization)
- [PR Delivery Initialization](#pr-delivery-initialization)
- [Receipt And Delivery Separation](#receipt-and-delivery-separation)
- [Worktree Preparation](#worktree-preparation)
- [Absolute-Path Safety](#absolute-path-safety)
- [Resume And Active Pointers](#resume-and-active-pointers)
- [Post-Receipt PR Handoff](#post-receipt-pr-handoff)

## Configuration And Doctor

Read `agents/config.json` before initialization when it exists.
Configuration may set delivery mode, branch naming, CI behavior, worktree preparation, local-file sync, setup commands, and parallel execution.

Run doctor when delivery, worktree sync, or PR and CI readiness is in question:

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js doctor
```

`doctor` reports the effective delivery configuration and environment readiness.
Configuration does not replace explicit approval for production data, credentials, irreversible operations, billing, or destructive changes.

## Session-Bound Initialization

Bind the harness to the current agent session at initialization.
In Codex, prefer `CODEX_SESSION_ID`, then `CODEX_THREAD_ID`.
In Claude Code, use the real `CLAUDE_SESSION_ID` substituted when the skill loads.

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js init \
  --prd <prd-path> \
  --session-id "${CODEX_SESSION_ID:-${CODEX_THREAD_ID:-${CLAUDE_SESSION_ID}}}"
```

If no session ID is available, initialize without `--session-id` and let the first Stop or PreToolUse hook payload bind `activeSessionId`.
Do not intentionally share one active state across unrelated agent sessions.

The `$please` path passes the exact user invocation through `--allow-unapproved-prd` as its approval deviation.
Normal `$implement` execution still requires approved PRD frontmatter or an explicit verbatim approval deviation.

## PR Delivery Initialization

When delivery mode is PR-based, pass it explicitly or rely on `agents/config.json`.

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js init \
  --prd <prd-path> \
  --delivery pr \
  --session-id "${CODEX_SESSION_ID:-${CODEX_THREAD_ID:-${CLAUDE_SESSION_ID}}}"
```

Do not enable PR delivery without configuration-based standing consent or an explicit conversation agreement.
PR delivery creates external repository state and is not inferred from a generic implementation request.

## Receipt And Delivery Separation

The implementation receipt must not depend on outcomes that only `$ship` can produce.
PR creation, PR URL, CI verdicts, merge status, and merge commit are post-receipt delivery evidence.
Do not put those outcomes in PRD tasks, acceptance criteria, or verification marked `Required For Done: yes`.
`init --delivery pr` rejects this circular contract before creating state or a worktree.

The receipt proves implementation completion.
When delivery mode is `pr`, the user-facing thread and tracked Goal remain open until `$ship` opens or updates the PR and required CI passes or delivery is explicitly reported as blocked.

## Worktree Preparation

When `agents/config.json` sets `worktree.enabled: true`, `init` may:

- create a new PR branch from the configured `delivery.baseBranch` and prepare its worktree.
- sync configured local files.
- run configured setup commands.
- copy the PRD and initialize implementation state in the worktree.

Continue all implementation from the emitted worktree path.
If the source checkout is dirty, `init` warns that uncommitted changes are not copied into the new worktree.
Commit, stash, or deliberately reapply only the required changes instead of assuming they followed the branch.
Do not assume `.env`, local certificates, local databases, or `node_modules` follow a new git worktree unless configuration explicitly links, copies, or installs them.

## Absolute-Path Safety

The agent session usually remains rooted in the main checkout even after a worktree is prepared, so relative write paths are unsafe.

- Every file edit and file creation must use the absolute worktree path.
- Never pass a relative path to `apply_patch` or another editing tool in worktree mode.
- Set `workdir` to the emitted worktree path for every subsequent command or pass an absolute `--state` path.
- Confirm the absolute target directory before writing run reports or reviews.
- If a file lands in the wrong checkout, move the existing file with `mv` or `git mv` to the correct absolute path.
- Do not delete and re-author a misplaced long file because regeneration wastes time and risks content drift.

## Resume And Active Pointers

`init` refuses to overwrite an existing `state.json` without `--force`.
When the worktree already contains implementation state, initialization from the main checkout resumes that run instead of resetting it.
Use `--force` only when the user explicitly requested a clean restart.

In worktree mode, initialization also writes active pointers and session-scoped files at the main checkout root so status lines and hooks can find the run from either checkout.
The latest legacy pointer is informational.
Session-scoped files are authoritative when a hook payload includes a session ID.

The harness stamps the pointer with its writing session and refuses cross-session pointer access; pin `--state` only when running multiple runs from one session (the refusal message lists the candidate state paths).
When diagnosing a mismatch, inspect `status`, the emitted `statePath`, `activeSessionId`, and the pointer's `owner` stamp before changing anything.

## Post-Receipt PR Handoff

After `finalize --status complete`, inspect `state.json` or `receipt.json` delivery mode.
When it is `pr`, run `$ship` and keep the tracked Goal open.

If the user approved merge, let `$ship merge` perform final freshness, CI, PR-head, and mergeability checks.
Record the PR URL, CI verdict, and merge commit as post-receipt delivery evidence rather than writing them back into the implementation receipt.

If CI requires a source fix, return to the `implement` workflow.
Refresh stale reviews, any runtime evidence the fix invalidates, and the receipt before shipping or merging again; the new `finalize` re-runs required command-backed verification on the fixed tree.
After PR creation, `$ship` cleans the matching active pointer and session-scoped active files.

For local-only runs or manual cleanup, use:

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js cleanup-active \
  --state agents/implement/<topic-slug>/state.json
```

Do not commit, push, or open a PR during local delivery unless the conversation separately authorized it.
