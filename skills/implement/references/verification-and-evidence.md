# Verification And Evidence

Read this reference before `plan-verification`, before running any required `V#`, while registering runtime evidence, or when an artifact is replaced or rejected.

## Contents

- [Verification Planning](#verification-planning)
- [Focused And Final Verification](#focused-and-final-verification)
- [Cost-Bearing Benchmarks](#cost-bearing-benchmarks)
- [Shell Verification](#shell-verification)
- [Database Safety](#database-safety)
- [Runtime Evidence](#runtime-evidence)
- [Required Artifact Classes](#required-artifact-classes)
- [Artifact Registration And Integrity](#artifact-registration-and-integrity)
- [Required Verification Semantics](#required-verification-semantics)

## Verification Planning

Run the planner before implementation:

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js plan-verification
```

The planner binds the PRD Verification Contract to repository reality.

- Full matrices with `Method` and `Artifact` use those concrete fields directly.
- Lean matrices with `Pass Intent` derive commands, tools, targets, and artifact kinds from the Test Mode Contract plus repository signals.
- Checks are classified as command, automated, browser, server, API, DB, or manual-agent.
- The planner creates acceptance-criterion coverage and blocking gaps for missing coverage, missing commands, missing artifact strategy, missing browser startup, or unsafe external proof.

Do not implement while the verification plan has blocking gaps (`plan-verification` output or `status` shows them).
Fix the PRD contract, supply missing repository context, or ask for the missing decision, then rerun `plan-verification`.

## Focused And Final Verification

Use the generated verification plan as the concrete proof plan.
Run the smallest focused probe while source is changing.
Reserve broad suites and cost-bearing benchmarks for a coherent milestone or the frozen final implementation content.

When the PRD or planner produced a concrete command, `verify-run` must execute that command exactly.
If an equivalent command is necessary, record why its coverage is equivalent through `--deviation`.

Every required verification item needs both `pass` status and artifact-backed evidence from the actual run.
A prose claim, file existence alone, or self-authored summary does not close a required check.

## Cost-Bearing Benchmarks

Before a cost-bearing agent or provider benchmark:

- required local static, unit, integration, and browser checks must already pass.
- the user-approved run budget and stop condition must be explicit.
- permission to exceed a budget must never be inferred.
- randomized tasks must use a recorded deterministic seed.
- the implementation HEAD and dirty-source snapshot must be stored with the evidence.

A fixed-coordinate replay against a randomized task is diagnostic evidence rather than a passing benchmark result.
Any source change after a cost-bearing run invalidates that run as final-HEAD proof.
Rerun the affected benchmark within the approved budget before completion reviews.
Batch small source fixes and run the broad suite once against frozen final content instead of repeatedly paying for the same check.

## Shell Verification

For shell-verifiable checks, use:

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js verify-run \
  --id V1 \
  -- <exact command>
```

For an equivalent replacement command, use:

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js verify-run \
  --id V1 \
  --deviation "<why equivalent coverage is preserved>" \
  -- <replacement command>
```

`verify-run` captures a command log, records the artifact with the executed command and exit code, and updates verification status.
Do not run a required command outside the harness and later substitute a prose result when `verify-run` can capture it directly.

Plain Bash runs of a contract command during development are fine and expected; a PostToolUse hook records them (with exit codes) to the run's `rehearsals.jsonl`, and `status` and the receipt surface per-verification rehearsal counts and failures.
This ledger is observational and never blocks: its purpose is an honest failure history, so a required check whose recorded history never once failed is visible for what it is.
Do not edit `rehearsals.jsonl` or cite it as passing evidence; only `verify-run` closes a verification item.

`verify-run` fingerprints the tree before and after the command (workspace digest guard): a command that exits 0 but mutates the workspace is recorded as a failure, because a verifier that edits the code it certifies is reward hacking, not proof.
A side effect declared in the 9.2 matrix's Side Effect column opts that verification out of the guard, with the skip on the record.
The same guard runs at finalize's reverification and on oracle commands.

## AC Oracles

Acceptance criteria whose PRD bullet declares a machine oracle tail (`Check: \`<command>\` [-> <expected stdout substring>]` or `Artifact: <path>`) are settled by the harness, never by hand:

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js oracle-run
```

runs every open oracle-backed AC (narrow with `--id AC2,AC3`; the default sweep covers `pending` and `not_met`, so a failed oracle is re-observed once the world is fixed), judges met/not_met from the exit code, output substring, or file existence, and records the evidence and command log automatically.
Do not `mark --kind ac` an oracle-backed AC; the harness rejects a manual `met` outright, and `finalize` accepts a met oracle-backed AC only when its latest harness-recorded oracle observation is a pass — status without that observation is a completion violation.
Oracle commands run in both the harness sweep (`oracle-run`) and the verify gate's oracle stage, so they must be repeatable/idempotent.
Check commands are tokenized and run without a shell in both executors: shell operators (`|`, `&&`, `;`, `>`, …) are literal arguments, not syntax — wrap the command in `bash -c "..."` when shell semantics are intended.

## Database Safety

Any verification, test, seed, or migration that writes to a database must target a disposable database: a local instance, an ephemeral container, or a provider branch (for example a Neon branch).
Before the first DB-touching run, resolve which connection string the command will actually use and confirm it is not production.
A production connection string in a test, seed, or migration path is a hard stop: pause the work and ask the user; do not proceed on an assumption that the data is disposable.
`plan-verification` flags likely DB-touching checks with a non-blocking `db-safety` warning gap; treat each flagged check as unconfirmed until the connection target has been verified once and noted in `context-notes.md`.
Deleting or mutating production rows to make a test pass is never acceptable evidence.

## Runtime Evidence

For browser, API, DB, or other runtime evidence, create the artifact from the real run and register it immediately.

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js record-artifact \
  --id V3 \
  --kind screenshot \
  --path <path-to-png-or-jpg> \
  --description "<what this proves>"
```

Use `chromux` for browser QA by default when it is available.
Register relevant screenshots, console logs, network logs, API logs, DB logs, and server logs.
Evidence must prove the PRD Pass Intent and mapped requirement rather than a shallow proxy.

## Required Artifact Classes

The harness enforces evidence classes by verification mode:

- Browser and runtime checks need a `screenshot`, `image`, or `browser` artifact.
- Build, static, and automated checks need a `command-log`, normally produced by `verify-run`.
- API checks need an `api` artifact or `command-log`.
- DB checks need a `db` artifact or `command-log`.
- Manual-agent checks still need an allowed concrete artifact when they are required for done.

Self-authored Markdown summaries never count as verification evidence.
Files inside the run directory can be registered only when they live under `artifacts/`.
Harness state and plan files, including `state.json`, verification plans, and review reports, are rejected as verification artifacts.

## Artifact Registration And Integrity

Register an artifact immediately after producing it.
Do not leave files under `artifacts/` unregistered.
If an artifact exists before registration, run `record-artifact` before using it as evidence for a task, acceptance criterion, review, or final report.

Before final review, run `status` and resolve every artifact violation.
Register valid evidence or remove only unregistered artifacts created by the current implementation run.
Never remove unrelated user artifacts to make the audit pass.

If a rerun overwrites an already registered file at the same path, do not edit `state.json` and do not write an ad hoc rehash script.
Re-run `record-artifact` for the same owner and path: it supersedes the old registration with the fresh hash and marks completion reviews stale.
Rerun stale reviews before finalization.

Artifact-backed review freshness also depends on the final source snapshot.
After a code edit, do not manually re-run already-passed command-backed verifications: `finalize` re-runs every required command-backed item on the final tree and skips fingerprint-fresh passes, on the harness's schedule, so a manual full-suite sweep only duplicates that audit.
The agent's staleness duty after such an edit covers exactly three things:

- the sasu verify gate PASS, which goes stale when its inputs change.
- the completion reviews (requirements fidelity, final adversarial), which go stale under the normal freshness rule.
- runtime-evidence artifacts (browser, API, DB captures), only when the change invalidates what a specific artifact proves - `finalize` cannot re-run non-command evidence and records those items as skipped, so a UI fix requires re-capturing the affected screenshot.

A runtime artifact the change does not invalidate stays valid; re-capture only what the edit actually broke.

## Required Verification Semantics

Required verification is closed only by a passing check with valid registered evidence.
Blocked, skipped, failed, pending, or evidence-free required verification prevents a complete receipt.
Optional checks may be skipped or blocked only when the PRD contract allows it and the status carries evidence.
A met acceptance criterion also needs at least one covering verification item in `pass` status; prose evidence alone cannot complete an AC whose entire coverage was skipped or blocked.

Before completion reviews, sweep every verification item and confirm:

- the executed command or probe matches the planned method or has a recorded equivalent-command deviation.
- the registered artifact exists, is non-empty, has the expected kind, and has no hash drift.
- the artifact proves the stated Pass Intent and every mapped `R#` and `AC#`.
- sensitive data, side effects, and live-provider constraints follow the PRD contract.
- no required check is merely inferred from another passing check.
