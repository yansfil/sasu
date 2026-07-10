---
name: fulfill
description: |
  Project-local PRD implementation orchestrator. Use when the user invokes
  "$fulfill" (legacy alias "prd-implement"), asks to execute or implement an approved PRD, or wants
  the agent to turn PRD-level tasks into an execution plan, TaskGraph, concrete
  verification plan, artifact-backed evidence, goal/progress tracking,
  main-agent-owned fidelity checks, profile-aware review gates, and strict
  completion receipt.
---

# fulfill

Artifacts live under the visible `agents/` namespace (`agents/implement/**`,
`.prd-implement-active.json`); a legacy `.hoyeon/implement/**` tree from older
runs stays readable as a fallback.

Use this skill to implement an approved PRD end to end.

This is the execution counterpart to `promise`. It turns a human-reviewed PRD into
implementation state, execution nodes, verification evidence, profile-aware
reviews, and a receipt. Completion accounting is strict; execution details can be
derived flexibly when they preserve the PRD contract.

Match the user's language by default.

## Inputs

Prefer an explicit PRD path:

```text
agents/prd/<topic-slug>/prd.md
```

If none is provided, inspect `agents/prd/` for the matching or most recent PRD.

The current PRD structure should include:

- `## 4. Pre-Work And Required Decisions`
- `## 5. Major Technical Structure Changes`
- `## 7. Acceptance Criteria`
- `## 8. PRD-Level Tasks`
- `## 9. Verification Contract`
- `## 10. Risks And Open Decisions`
- `## 11. Implementation Guardrails`
- `## 12. Implementation Result Report Contract`

Current PRDs ship as a single `prd.md`; PRD-side quality is an inline
self-check plus the Harness Readiness Gate.
Legacy PRDs may carry side audit files
(`intent-scope-audit.md`, `verification-contract-audit.md`); read them when
they exist.

If required pre-work, approval, credentials, migration windows, production data,
or product decisions are unresolved, stop and ask.

"Non-trivial" throughout this skill means any of: 3 or more PRD-level tasks,
DB schema or migration changes, auth/security surfaces, payments or billing,
external services or credentials, production data, or scope that spans more
than one working session. Everything else is trivial.

For execution graph details, read `references/execution-graph.md` when
implementing a PRD, modifying this skill, or diagnosing TaskGraph behavior.

## Output Artifacts

Harness-managed state and derived views:

```text
agents/implement/<topic-slug>/checklist.md
agents/implement/<topic-slug>/verification-plan.json
agents/implement/<topic-slug>/verification-plan.md
agents/implement/<topic-slug>/execution-plan.json
agents/implement/<topic-slug>/execution-plan.md
agents/implement/<topic-slug>/taskgraph.json
agents/implement/<topic-slug>/taskgraph.md
agents/implement/<topic-slug>/state.json
agents/implement/<topic-slug>/ledger.jsonl
agents/implement/<topic-slug>/verification.md
agents/implement/<topic-slug>/artifacts/manifest.jsonl
agents/implement/<topic-slug>/receipt.json
agents/implement/<topic-slug>/implementation-result.md
agents/implement/.prd-implement-active.json
agents/implement/.prd-implement-sessions/<encoded-session-id>.json
```

Agent-created run notes, review reports, and evidence artifacts:

```text
agents/implement/<topic-slug>/context-notes.md
agents/implement/<topic-slug>/artifacts/logs/*.log
agents/implement/<topic-slug>/artifacts/screenshots/*
agents/implement/<topic-slug>/artifacts/browser/*
agents/implement/<topic-slug>/artifacts/api/*
agents/implement/<topic-slug>/artifacts/db/*
agents/implement/<topic-slug>/review/requirements-fidelity-review.md
agents/implement/<topic-slug>/review/final-review.md
```

## Required Flow

```text
goal tracking opened
  -> PRD Verification Contract
  -> fulfill Verification Planner
  -> Execution Plan
  -> TaskGraph
  -> main-agent coverage check
  -> ready node implementation
  -> verify-run / record-artifact
  -> requirements fidelity review
  -> blocked/partial handoff when completion is impossible
  -> final adversarial review when required by review profile
  -> runtime cleanup
  -> receipt
  -> PR delivery handoff when delivery mode is pr
```

## 1. Confirm Readiness

Before editing code:

1. Read the PRD and status.
2. Confirm the PRD is human-approved: frontmatter `human_approval: "approved"`.
   The implementing agent must never set this value itself. If it is missing or
   `pending`, stop and ask the user to review and approve the PRD. If the user
   gives explicit approval in conversation instead of editing the file, update
   the frontmatter to `approved` quoting that approval in the commit/notes, or
   pass the verbatim approval to `init --allow-unapproved-prd` so the harness
   records it as a deviation. `init` fails without one of these.
3. Confirm blocking pre-work and human decisions are resolved.
4. Treat Major Technical Structure Changes as the approved structure lock.
5. For legacy PRDs with side audit files, read them; unresolved audit
   failures block implementation until the PRD is fixed or the user
   explicitly accepts the risk.
6. Read Implementation Guardrails and Risks.
7. Read `agents/config.json` when it exists.
   `node ~/.codex/skills/fulfill/scripts/prd_state_harness.js doctor`
   reports the effective delivery config and environment readiness; run it when
   delivery mode, worktree sync, or PR/CI readiness is in question.
8. Inspect `git status --short`.
9. Read actual files likely to be touched before editing. For large files
   (roughly 1000+ lines), locate the relevant functions or sections with `rg`
   first and read only those ranges; reading whole large files repeatedly
   bloats context, forces compaction, and triggers costly re-reads later.

If `agents/config.json` or the user's request sets delivery mode to `pr`, treat
PR delivery as part of the user-facing workflow.
The implementation receipt still proves implementation completion, but the
thread is not done until `deliver` opens or updates the PR and required CI
passes or is explicitly reported as blocked.

Pause for approval before material structure deviations, unmapped scope,
production data, credentials, destructive DB changes, billing, or irreversible
deploy actions.

## 2. Start Goal Tracking

Mirror progress into the runtime's goal/progress surface. The tracker is
lifecycle and progress control, not an independent completion proof.
The authoritative implementation proof is `receipt.json` produced by
`finalize`; tracker completion only mirrors a successful receipt and any
required PR delivery handoff.

With Codex goal tools:

1. Call `get_goal`.
2. If no active goal exists, call `create_goal` with an objective like:
   `Implement <prd-path> end to end through PRD receipt`.
3. If the active goal is the same PRD implementation, continue it.
4. If the active goal is unrelated, ask before replacing or mixing goals.
5. `update_plan` may mirror progress, but it is not a substitute for Goal
   state.
6. Do not call `update_goal complete` until `finalize --status complete`
   succeeds and the completion checks in `Finalize` are all true.
7. For blocked or partial handoff, do not call `update_goal complete`. Call
   `update_goal blocked` only when the goal tool's blocked-status contract is
   satisfied; otherwise leave the Goal active and report the blocked/partial
   receipt state.

In Claude Code, use the task list (TaskCreate/TaskUpdate) as the progress
mirror under the same rules: do not mark the run's final task complete before
the receipt exists and, when delivery mode is `pr`, before the PR delivery
handoff is complete or explicitly blocked.

If no goal or task tracking tools are available in the current surface, record
that limitation in `context-notes.md` or the final report instead of silently
acting as if the tracker exists.

## 3. Activate State Harness

From the target repository root:

```sh
node ~/.codex/skills/fulfill/scripts/prd_state_harness.js init --prd <prd-path> --session-id "${CODEX_SESSION_ID:-${CODEX_THREAD_ID:-${CLAUDE_SESSION_ID}}}"
node ~/.codex/skills/fulfill/scripts/prd_state_harness.js status
```

Bind the harness to the current agent session at initialization. In Codex,
prefer `CODEX_SESSION_ID`, then `CODEX_THREAD_ID`. In Claude Code, the literal
`${CLAUDE_SESSION_ID}` above is substituted with the real session id when the
skill loads. If no session id is available, run `init --prd <prd-path>` and
rely on the first Stop/PreToolUse hook payload to bind `activeSessionId`. Do
not intentionally share one active state across unrelated agent sessions.

When delivery mode should be PR-based, pass it explicitly or rely on
`agents/config.json`:

```sh
node ~/.codex/skills/fulfill/scripts/prd_state_harness.js init \
  --prd <prd-path> \
  --delivery pr \
  --session-id "${CODEX_SESSION_ID:-${CODEX_THREAD_ID:-${CLAUDE_SESSION_ID}}}"
```

The harness assigns a review profile at init:

- `trivial`: small low-risk work. Required verification, artifact validation,
  requirements fidelity review, and receipt are required. Mandatory final
  adversarial review is skipped.
- `standard`: normal product or code work. Required verification, requirements
  fidelity review, a thin final gate, and receipt are required.
- `high-risk`: DB/schema/migrations, auth/security, payments/billing,
  credentials, production data, external/live providers, deploy/rollback, or
  similar risk. Full requirements fidelity review and full adversarial review
  are required.

Override only when the risk classification is wrong:

```sh
node ~/.codex/skills/fulfill/scripts/prd_state_harness.js init \
  --prd <prd-path> \
  --review-profile trivial|standard|high-risk
```

If `agents/config.json` contains `worktree.enabled: true`, `init` may prepare a
PR branch worktree, sync configured local files, run configured setup commands,
and initialize state in that worktree.
Continue implementation from the emitted worktree path.
Do not assume `.env`, local certs, local databases, or `node_modules` follow a
new git worktree unless the config explicitly links, copies, or installs them.

In worktree mode the session working directory usually stays at the main
checkout, so relative paths are a trap:

- Every file edit or file creation (`apply_patch` and equivalents) must use the
  absolute worktree path. Never pass a relative path to an editing tool, even
  when shell commands in the same turn use an explicit worktree workdir.
- Before writing run reports or reviews, confirm the target directory with the
  absolute path emitted by the harness prompt or `status`.
- After `init` prepares a worktree, every subsequent command should run with
  `workdir` set to the emitted worktree path or should pass an absolute
  `--state` path.
- If a file lands in the wrong checkout, move the existing file with `mv` (or
  `git mv`) to the correct absolute path. Do not delete it and re-author the
  content; regenerating a long file wastes minutes and risks content drift.

`init` refuses to overwrite an existing `state.json` without `--force`.
If the worktree already holds implementation state, `init` from the main checkout resumes that
run instead of resetting it; pass `--force` only when the user wants a clean restart.
In worktree mode, `init` also writes active pointers and session-scoped active
files at the main checkout root so statusline and hooks can find the run from
either checkout.
The latest legacy pointer is informational; session-scoped files are the
authority when a hook payload includes a session id.
Do not run two active PRD implementations from one checkout unless each has a
distinct session id and all commands use the correct worktree or explicit
`--state`.

The harness extracts PRD-level tasks, acceptance criteria, verification items,
test modes, and structure locks into durable state. It supports:

- current PRDs: `PRD-Level Tasks`, `Verification Contract`, `Test Mode Contract`,
  `Required Agent Verification`.

## 4. Plan Verification Before Implementation

```sh
node ~/.codex/skills/fulfill/scripts/prd_state_harness.js plan-verification
```

The planner binds the PRD verification contract to repo reality.

- Full matrices with `Method`/`Artifact` use those concrete fields directly.
- Lean matrices with `Pass Intent` derive commands, tools, targets, and
  artifact kinds from the Test Mode Contract plus repo signals.
- It classifies checks as command, automated, browser, server, API, DB, or
  manual-agent.
- It creates AC coverage and blocking gaps for missing coverage, missing
  commands, missing artifact strategy, missing browser startup, or unsafe
  external proof.

If `verification-plan.md` reports blocking gaps, do not implement. Fix the PRD
contract, supply missing repo context, or ask for the missing decision; then
rerun `plan-verification`.

## 5. Plan Execution And TaskGraph

```sh
node ~/.codex/skills/fulfill/scripts/prd_state_harness.js plan-execution
node ~/.codex/skills/fulfill/scripts/prd_state_harness.js ready
```

`plan-execution` maps every PRD-level task to execution nodes, inferred write
scopes, dependencies, risk, parallel safety, owner, evidence expectations, and
traceability (`T# -> N# -> AC# -> V#`). The PRD stays clean; executor details
live in implementation artifacts.

Inspect `taskgraph.md` or `status` after planning. The TaskGraph must account
for verification planning, execution planning, execution nodes, PRD task
rollups, acceptance criteria, verification items, requirements fidelity review,
final review, and receipt. `ready` only identifies runnable execution nodes; it
does not prove final eligibility.

Work the next ready node. The harness recommends ready and parallel groups, but
does not spawn subagents. The coordinator assigns and reconciles work.

## 6. Implementation Loop

For each ready execution node:

1. Re-read relevant files.
2. Make the smallest change that satisfies mapped requirements and ACs.
3. Record material decisions in `context-notes.md`.
4. Run the smallest relevant verification.
5. Record evidence:

```sh
node ~/.codex/skills/fulfill/scripts/prd_state_harness.js mark-node \
  --id N1 \
  --status complete \
  --evidence "<file/test/runtime evidence>"

node ~/.codex/skills/fulfill/scripts/prd_state_harness.js mark \
  --kind ac \
  --id AC1 \
  --status met \
  --evidence "<evidence>"
```

For repeated same-status updates, comma-separated ids are allowed:

```sh
node ~/.codex/skills/fulfill/scripts/prd_state_harness.js mark-node \
  --id N1,N2 \
  --status complete \
  --evidence "<shared evidence>"

node ~/.codex/skills/fulfill/scripts/prd_state_harness.js mark \
  --kind ac \
  --id AC1,AC2 \
  --status met \
  --evidence "<shared evidence>"
```

Do not manually close PRD tasks just because a node is done. Task completion
rolls up from execution nodes, mapped ACs, and mapped verification items.

Record deviations when execution order, write scope, task shape, or verifier
substitution differs from the plan. Deviations are allowed only when they
preserve PRD coverage and the final review accepts them.

## 7. Verification Loop

Use the generated verification plan as the concrete proof plan.

For shell-verifiable checks:

```sh
node ~/.codex/skills/fulfill/scripts/prd_state_harness.js verify-run \
  --id V1 \
  -- <exact command>
```

When a PRD or planner produced a concrete command, `verify-run` must run that
command exactly. If an equivalent command is necessary, use:

```sh
node ~/.codex/skills/fulfill/scripts/prd_state_harness.js verify-run \
  --id V1 \
  --deviation "<why equivalent coverage is preserved>" \
  -- <replacement command>
```

For browser/API/DB/runtime evidence:

```sh
node ~/.codex/skills/fulfill/scripts/prd_state_harness.js record-artifact \
  --id V3 \
  --kind screenshot \
  --path <path-to-png-or-jpg> \
  --description "<what this proves>"
```

Use `chromux` for browser QA by default when available. Register screenshots,
console/network logs, API logs, DB logs, and server logs. A required
verification item is not complete without artifact-backed evidence and `pass`
status.

Evidence must be captured from the actual run, and the harness enforces
per-mode artifact kinds for required verification:

- browser/runtime checks need a `screenshot`, `image`, or `browser` artifact.
- build/static and automated checks need a `command-log` (use `verify-run`).
- API checks need `api` or `command-log`; DB checks need `db` or `command-log`.
- Self-authored markdown summaries never count as evidence, and files inside
  the run directory can only be registered if they live under `artifacts/`.
  Harness state files (`state.json`, plans, reviews) are rejected outright.

Register artifacts immediately after producing them. Do not leave files under
`artifacts/` unregistered. If an artifact file exists before it is registered,
run `record-artifact` before using it as evidence for a node, AC, review, or
final report. Before final review, run `status` and resolve all artifact
violations by registering valid artifacts or removing only artifacts created by
the current implementation run.

If a re-run overwrites already-registered artifact files in place (benchmark
JSON, receipts, screenshots at fixed paths), do not edit `state.json` by hand
and do not write ad-hoc scripts. Run:

```sh
node ~/.codex/skills/fulfill/scripts/prd_state_harness.js refresh-artifacts [--id V3]
```

It re-hashes the registered artifacts, records the refresh in the ledger, and
marks completion reviews stale so they are re-run before finalize.

Blocked or skipped required verification cannot produce a complete receipt.

## 8. Subagents And Reviews

Parallelize only when safe and useful.

- Run `ready` first.
- Assign bounded nodes with exact file ownership or read-only scope.
- Tell workers they are not alone in the codebase and must not revert others'
  edits.
- Reviewer/verifier subagents are read-only and must not run `mark`,
  `requirements-review-record`, `review-record`, `finalize`, or Goal tools.
- The coordinator applies edits, resolves conflicts, reruns verification, and
  records final state.

If no subagent facility is available, use safe shell parallelism for reads and
independent checks.

Review ownership rules:

- The main agent performs the post-`plan-execution` coverage check by default.
  Check PRD intent sources, verification coverage, execution plan, TaskGraph,
  ambiguity, structure-lock drift, and unmapped scope. Record material findings
  in `context-notes.md`, and stop on material blockers.
- The main agent performs requirements fidelity review by default. Do not spawn
  a sidecar for this review unless the user explicitly asks for one.
- The final adversarial review is mandatory for `standard` and `high-risk`
  profiles when multi-agent tools are available.
  It is optional for `trivial`.
- Use a default independent subagent for the final sidecar (in Codex, omit
  `agent_type`; in Claude Code, use the default general-purpose subagent).
  Do not choose `hoyeon-*` roles unless the user explicitly asks for that
  specific role.
- Give the reviewer a fresh context when the tool supports it (Codex:
  `fork_context: false`). Pass raw artifact paths and generated review
  prompts, not the coordinator's conclusions.
- Sidecars must not edit files, run `mark`, run `requirements-review-record`,
  run `review-record`, run `finalize`, or update Goal state.
- If multi-agent tools are unavailable for the final adversarial review, write
  `Subagent unavailable: <reason>` in the final review report and perform the
  same review manually. Do not silently skip the final review.

## 9. Acceptance Sweep

Before final review, sweep every AC:

- Status: `Met`, `Not Met`, or `Blocked`.
- Evidence: command, test, screenshot, DOM result, API response, DB query, or
  file reference.
- Related task IDs.

Keep working if any required AC is not met and no concrete blocker exists.

## 10. Requirements Fidelity Review

Before final adversarial review, generate a strict intent-review prompt:

```sh
node ~/.codex/skills/fulfill/scripts/prd_state_harness.js requirements-review-prompt
```

The main agent writes this review by default. Do not spawn a sidecar for
requirements fidelity unless the user explicitly asks for one. This is not a
code-quality review. It must compare the original user intent, accepted
decisions, rejected alternatives, PRD scope, acceptance criteria, verification
evidence, and implementation result. It must be strict and should fail on any
material semantic drift, missing user-visible behavior, diluted AC, hidden
scope, unapproved decision reversal, weak evidence for the user's actual goal,
or overclaimed `Done` status.

The reviewer must check:

- original intake/clarify/current-conversation sources named by PRD
  frontmatter or PRD sections were read when available.
- every user decision and accepted initial proposal is represented in PRD
  scope, non-goals, requirements, ACs, verification, or human verification.
- rejected options, non-goals, and guardrails stayed rejected.
- implementation evidence proves the user intent behind each AC, not only a
  shallow proxy condition.
- every required `V#` has a Verification Intent Checklist entry mapping Pass
  Intent to concrete registered artifacts, and each mapped `R#`/`AC#` is
  actually proven by those artifacts.
- remaining human judgment is not reported as complete.

The report must include a `Verification Intent Checklist` section. For every
required `V#`, list the PRD Pass Intent or derived pass criteria, covered
`R#`/`AC#`, registered artifact paths inspected, a `PASS`/`FAIL` judgment, and
any gap. A passing review must fail if a required `V#` is missing, has no
registered artifact path, or the artifact does not actually prove the covered
requirement or acceptance criterion.

Write:

```text
agents/implement/<topic-slug>/review/requirements-fidelity-review.md
```

Then record:

```sh
node ~/.codex/skills/fulfill/scripts/prd_state_harness.js requirements-review-record \
  --status pass \
  --report agents/implement/<topic-slug>/review/requirements-fidelity-review.md \
  --summary "<requirements fidelity verdict>"
```

If the requirements fidelity review fails, fix findings or mark the
implementation `Blocked`/`Partially Done` with evidence. Do not proceed to final
adversarial review or complete receipt until this review passes.

If completion is impossible or the user asks for a blocked/partial handoff, run
the same requirements fidelity review before writing the handoff. A blocked or
partial handoff may record `Status: FAIL`, but it must still prove that a
review compared original user intent, decisions, PRD scope, ACs, verification
evidence, and implementation result. The handoff must reflect that verdict and
must not soften it into `Done`.

Any implementation, evidence, verification, plan, artifact, or deviation change
after a passing requirements fidelity review makes that review stale and it must
be rerun. The recorded report must contain a standalone `Status: PASS` line for
`requirements-review-record --status pass`; a mismatched or missing status line
is rejected. The harness also stores a git worktree snapshot, excluding the
current implementation artifact directory, so source changes after review make
the review stale.

## 11. Final Adversarial Review

Generate a reviewer prompt:

```sh
node ~/.codex/skills/fulfill/scripts/prd_state_harness.js review-prompt
```

Before this review, stop runtime servers, browser sessions, tunnels, or
background processes that were started only for verification, unless there is an
explicit reason to leave them running. Record the shutdown evidence or the
intentional left-running exception.

Use a fresh independent read-only verifier/reviewer sidecar when multi-agent
tools are available and the review profile requires final review.
For `trivial` runs, final adversarial review is optional; the receipt can be
written after required verification, artifact validation, and requirements
fidelity review pass.
For `standard` runs, keep the final review thin: audit freshness, state
consistency, artifact validity, deviations, and overclaiming; reopen full
V-by-V proof only when the requirements fidelity review is weak, generic,
inconsistent, or suspicious.
For `high-risk` runs, perform the full adversarial review.
Use a default subagent, not a `hoyeon-*` role, unless the user explicitly asks
for that role. It must check:

- requirements fidelity review exists, passed, is fresh, and its findings are
  resolved or reflected in the final verdict.
- requirements fidelity review is the primary semantic artifact proof.
  The final reviewer audits that proof and calls out disagreement, omission, or
  weak reasoning instead of repeating the whole `Verification Intent Checklist`
  from scratch.
- PRD stayed clean: no write scopes, owners, parallel safety, low-level
  dependencies, or ready-node scheduling.
- execution plan maps every PRD task to nodes.
- TaskGraph accounts for execution nodes, task rollups, ACs, verification,
  requirements fidelity review, final review, and receipt.
- every AC is met with evidence.
- every required verification item passed with registered artifacts.
- artifact validity problems that the harness can see are absent, including
  missing files, empty files, invalid screenshots, unregistered artifacts, hash
  drift, stale reviews, and wrong evidence kinds.
- `Artifact Audit` is a thin cross-check: summarize valid evidence classes,
  spot-check risky or user-critical artifacts, and list weak or missing proof.
  Do not duplicate every `V#` proof when the requirements fidelity review
  already did that work and the final reviewer agrees.
- deviations are recorded and acceptable.
- implementation follows the PRD structure lock and guardrails.
- `implementation-result.md` and final user report match state.

Write:

```text
agents/implement/<topic-slug>/review/final-review.md
```

Then record:

```sh
node ~/.codex/skills/fulfill/scripts/prd_state_harness.js review-record \
  --status pass \
  --report agents/implement/<topic-slug>/review/final-review.md \
  --summary "<review verdict>"
```

If review fails, fix findings, rerun relevant verification, and record a new
passing review.

When final review is required, it must be independent in time and content, and
the harness enforces this:

- The reviewer runs only after `requirements-review-record` succeeded. The
  report file must be written after that record; a report authored earlier is
  rejected.
- The report must contain a `Fidelity Review Checked` section citing the
  recorded fidelity report path and its sha256 (read from `state.json` after
  recording), plus `Findings`, `Checklist Coverage`, `Artifact Audit`,
  `Deviation Audit`, and `Verdict` sections, and must reference every required
  `V#`.
- The report must contain a standalone `Status: PASS` line for
  `review-record --status pass`; a mismatched or missing status line is
  rejected.

The final review also stores a git worktree snapshot and becomes stale if source
changes after review.

## 12. Finalize

Only after all gates required by the review profile pass:

```sh
node ~/.codex/skills/fulfill/scripts/prd_state_harness.js finalize \
  --status complete \
  --summary "<evidence-backed summary>"
```

Do not report done and do not mark the tracked goal complete (`update_goal
complete` in Codex, the run's final task in Claude Code) until:

- `receipt.json` exists.
- `status` reports zero open tracked items.
- every required verification item is `pass` with artifact-backed evidence.
- verification and execution plans are ready.
- TaskGraph has no blocking gate violations.
- artifact validation reports no violations.
- requirements fidelity review status is `pass` and fresh.
- final review status is `pass` and fresh when the review profile requires it.
- runtime processes started for verification are stopped or explicitly reported
  as intentionally left running.

If `state.json` or `receipt.json` says `delivery.mode` is `pr`, do not mark
the tracked goal complete yet.
Run `$deliver` after `finalize --status complete` and keep the goal open until
the PR exists and required CI passes or the delivery handoff is explicitly
blocked.
After PR creation, `deliver` cleans the matching active pointer and
session-scoped active files.
For local-only runs or manual cleanup, use:

```sh
node ~/.codex/skills/fulfill/scripts/prd_state_harness.js cleanup-active \
  --state agents/implement/<topic-slug>/state.json
```

For a blocked or partial handoff, do not write the final report until:

- a requirements fidelity review report exists.
- its status is `PASS` or `FAIL`, matches the recorded status, and is fresh.
- every blocker or known not-done item cited in the handoff has evidence.
- the report status is `Blocked` or `Partially Done`, never `Done`.

Use:

```sh
node ~/.codex/skills/fulfill/scripts/prd_state_harness.js finalize \
  --status blocked \
  --summary "<evidence-backed blocker summary>"

node ~/.codex/skills/fulfill/scripts/prd_state_harness.js finalize \
  --status partial \
  --summary "<evidence-backed partial handoff summary>"
```

## Hard Stops

Stop and ask when:

- required pre-work is incomplete.
- PRD status is not `ready` and the user has not approved execution.
- work adds unmapped scope or changes approved structure.
- credentials, billing, production data, destructive DB changes, or irreversible
  deploy steps are required but not approved.
- verification failure requires a product or structure decision.

## Final Report

Use the PRD's Implementation Result Report Contract. At minimum report:

- Status: `Done`, `Partially Done`, or `Blocked`.
- user-visible changes.
- major technical changes and structure conformance.
- completed/deferred/added tasks.
- AC status.
- verification evidence by test mode.
- requirements fidelity review verdict.
- delivery mode and, when `pr`, the `deliver` status, PR URL, branch, and CI
  verdict.
- deviations.
- human review needed.
- not-done items, risks, and follow-ups.
