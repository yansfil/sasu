---
name: ship
description: |
  Deliver an implementation with a current deterministic verification report locally or through a GitHub pull request.
  Use when the user invokes "$ship" or asks to commit, open or update a PR, watch CI, or merge approved work.
  Do not use before `sasu implement verify` has produced a current PASS report.
---

# ship

Deliver only the current Git head described by `verification-report.json`.
The report proves deterministic checks and evidence identity.
Native-agent reviews supply visible advice for the PR and do not grant delivery eligibility.

## Inputs

Prefer an explicit state path:

```text
agents/runs/<topic-slug>/state.json
```

Required files:

```text
agents/runs/<topic-slug>/state.json
agents/runs/<topic-slug>/verification-report.json
agents/runs/<topic-slug>/verification-report.md
```

The run may keep product code in an isolated worktree while records stay in the record tree.
The script resolves that boundary from `state.json`.

## Flow

```text
current deterministic PASS
  -> inspect native-agent Fix now and Follow-up findings
  -> fix and commit valid current-scope bugs, then rerun verify/review if source changed
  -> preflight and generate PR body
  -> include tests, evidence, review availability, dispositions and follow-ups
  -> validate the committed implementation path boundary
  -> push the verified head, open or update PR, watch CI
  -> merge only with explicit user approval and the reviewed head pinned
```

## Guardrails

The script blocks when:

- the state or verification-report schema is retired or malformed;
- deterministic verification is not PASS or is stale for the current source, PRD, suite, or evidence;
- the report HEAD differs from the current Git HEAD or Git-visible changes remain uncommitted;
- the branch is behind the configured base without an explicit approved exception;
- the verified commit includes paths outside the delivery allowlist;
- the PR body still contains placeholders, template comments, or agent attribution, or lacks the folded verification record;
- required learned-rule checks fail;
- merge lacks explicit user approval, current head identity, mergeability, or passing CI.

Reviewer timeout or unavailability is not a deterministic failure.
Write `REVIEW_UNAVAILABLE` and its cause in the PR body so the human reviewer can decide.
For high-risk work, repository review rules and explicit human approval require the independent specialist review.

## Commands

```sh
node ~/.codex/skills/ship/scripts/prd_ship.js preflight --state agents/runs/<topic-slug>/state.json
node ~/.codex/skills/ship/scripts/prd_ship.js body --state agents/runs/<topic-slug>/state.json
node ~/.codex/skills/ship/scripts/prd_ship.js screenshots --state agents/runs/<topic-slug>/state.json --file <image> --caption "<one line>" [--file ... --caption ...] [--assets-repo <owner/name>]
node ~/.codex/skills/ship/scripts/prd_ship.js local --state agents/runs/<topic-slug>/state.json
node ~/.codex/skills/ship/scripts/prd_ship.js ship --state agents/runs/<topic-slug>/state.json --title "<title>"
node ~/.codex/skills/ship/scripts/prd_ship.js watch-ci --state agents/runs/<topic-slug>/state.json [--timeout <seconds>]
node ~/.codex/skills/ship/scripts/prd_ship.js merge --state agents/runs/<topic-slug>/state.json --approval "<verbatim-user-approval>" [--method squash|merge|rebase]
node ~/.codex/skills/ship/scripts/prd_ship.js status --state agents/runs/<topic-slug>/state.json
```

The Claude installation substitutes its own skill root.

`body` creates `agents/runs/<topic-slug>/delivery/pr-body.md`.
When the repository keeps a pull request template (`.github/pull_request_template.md` and the other places GitHub looks), the draft is that template with a `Related:` line above `Summary` and a folded `Verification record` block at the end; otherwise it is the house shape below.
Fill every `AGENT-FILL` marker and delete every template comment, working from the deterministic report, actual evidence, and visible reviewer responses; keep the folded record.
It refuses to overwrite existing prose without `--force`.

`screenshots` uploads two or three cropped images to the public assets repository (`--assets-repo`, or `delivery.assetsRepo` in `agents/config.json`) under `<repository>/<topic-slug>/<head-sha7>/`, then writes `![caption](url)` lines under `Summary` in the body draft.
A path that already exists is left alone, so rerunning it for the same head is free, and nothing in that repository is ever deleted.
Crop every image to the product surface it shows: the repository is public, and a whole-screen capture carries the user name, host name, or another project.

`local` validates freshness and records the already committed, verified implementation head.
It does not push or create a PR.
Running it again for the same clean recorded head is idempotent.

`ship` validates freshness, pushes the already committed verified head, creates or updates the PR, and watches CI unless `--no-watch` is supplied.
Exit code 2 means CI failed.
Exit code 3 means CI is still pending at the timeout.

`merge` is separately authorized.
Pass the user's merge instruction verbatim through `--approval`.
The command checks the local head, PR head, base freshness, mergeability, CI, and learned rules before using GitHub's head-pinned merge.

## PR Body

The body is written in the order a reviewer reads, and the prose above the fold stays under about 40 lines with one fact per bullet:

1. `Related:` - the issues it closes, the PRs it depends on or follows, the PRD path; one line above `Summary`, deleted when empty.
2. `Summary` - 3-5 bullets on the problem and what changed, followed by 2-3 inline screenshots with one caption each whenever anything a user sees changed; `screenshots` uploads and places them.
3. `Review` - what needs a human's judgment, which files to watch and why (the risk named in a word or two), and specific questions.
4. `Evidence` - what was confirmed, how many, under which conditions and by what method; what was not confirmed and why; large generated diffs named in one line.
5. `Breaking change` - only when something breaks, with what the operator must do.
6. A one-line `AI tooling` review input, never an attribution.
7. `<details><summary>Verification record</summary>` - PRD and its hash, base and head, verification time and status, report paths, suites with exit codes, one line per native reviewer (head reviewed, Fix now findings and their disposition, Follow-up improvements, or `REVIEW_UNAVAILABLE` with its cause), registered evidence, changed-path count. `body` generates everything here except the reviewer lines. SHAs, hashes and fingerprints appear only in this block.

A repository template decides the section names; the house shape above is what `body` writes when there is none.

Do not claim an unavailable review passed.
Do not hide CI failure behind successful PR creation.
Do not expand product scope merely to clear an advisory.

For screenshots, use `screenshots` (the assets repository) or GitHub user attachments, and crop out a workstation's user or host name.
Do not use `/Users/...`, `file://...`, or an unpushed run artifact as the only evidence.

## CI Failure

When CI fails:

1. inspect the actual failing check;
2. fix the cause in the same branch when it belongs to the current scope;
3. run the nearest focused check;
4. rerun `sasu implement verify` because the head changed;
5. request fresh native reviews for the new head;
6. update the PR body and ship again.

Outside-scope cleanup or product expansion goes under Follow-up improvements.
