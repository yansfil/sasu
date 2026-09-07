---
name: implement
description: |
  Project-local approved-PRD implementation executor and Observer entrypoint.
  Use when the user invokes "$implement", explicitly asks to execute an approved
  PRD through the receipt-backed workflow, or wants the PRD's Behaviors rows
  implemented and proven through one unified verification command.
  Do not use for ordinary implementation requests that have no approved PRD.
---

# implement

Use this skill to implement an approved PRD end to end.
Match the user's language by default.

Before any repository write or mutating `sasu` command, resolve the session role.
When a direct invocation runs in Herdr, or when this skill is dispatched after `$please` seals its PRD, read `references/observer-and-herdr.md` completely and apply it.
For `$please`, the user-facing main session owns specification through PRD readiness, then becomes the Observer; the marked Implementor executes sections 1 through 7 below from that ready PRD.
For direct `$implement`, the user-facing Observer dispatches immediately because the approved PRD already exists.
The `benchmark-implement` coordinator remains an explicit in-session Implementor as required by that benchmark.

The public closing flow is intentionally small:

```text
implement a Behaviors row
  -> check --row for a check: row (or record a human-approved park)
  -> register evidence for a judge: row
  -> sasu implement verify
  -> sasu implement finalize   (human: rows may still be OPEN)
  -> sasu implement confirm    (the user, later)
```

`state.json` is the only machine record.
`receipt.json` and `implementation-result.md` are derived outputs.

## Reference Routing

Read each directly linked reference completely when its condition applies.

| Reference | Read when |
| --- | --- |
| [`references/observer-and-herdr.md`](references/observer-and-herdr.md) | Before a direct Herdr invocation, when dispatched after `$please` PRD readiness, or when an Implementor blocks or needs recovery. |
| [`references/execution-planning.md`](references/execution-planning.md) | Before implementation, while working rows, or when execution order is unclear. |
| [`references/verification-and-evidence.md`](references/verification-and-evidence.md) | Before capturing or registering final runtime evidence and before unified verify. |
| [`references/verification-environments.md`](references/verification-environments.md) | When a browser/runtime, mobile, TUI, or desktop row needs a concrete driver. |
| [`references/reviews-and-finalization.md`](references/reviews-and-finalization.md) | Before unified verify, finalize, or a blocked handoff. |
| [`references/worktrees-and-delivery.md`](references/worktrees-and-delivery.md) | When delivery is `pr`, a worktree is configured, or post-receipt delivery is requested. |

## Core Invariants

- Never implement a pending PRD without explicit human approval or the user's verbatim conversational approval.
- Treat the PRD's Technical structure section as the approved structure boundary.
- Do not add unmapped scope, services, schemas, external calls, destructive actions, or compatibility paths.
- Verification proof is never reduced to save ceremony.
- The CLI executes deterministic verification before any LLM judge.
- Acceptance and fidelity are separate LLM calls and neither consumes the other's result.
- Required verification must be a current PASS whose attempt pins the current source and registered artifact hashes.
- `sasu implement finalize` never runs tests, judges, capture tools, or external commands.
- `state.json` is the completion authority; the receipt is its portable derived proof.
- The marked Implementor is the only implementation and `state.json` writer; the Observer stays read-only after dispatch, and both sessions treat the qa-log and PRD body as sealed inputs.
- Row statuses, attempts, fingerprints, and counters are harness-owned facts.
  Never supply or synthesize them as agent evidence.
- A parked row may let work continue, but it is skipped explicitly by verify and always blocks a complete finalize until resumed and proved.
- A `human:` row is never closed by an agent. It stays OPEN through finalize and only `sasu implement confirm --issuer human` closes it.
- Commit, push, PR creation, CI, and merge are post-receipt delivery outcomes.
  Local mode uses the post-receipt local delivery command for one semantic local commit;
  PR mode uses `$ship` for commit, push, PR creation, and CI.

## 1. Confirm Readiness

Before editing:

1. Read the complete PRD.
2. Confirm `status: ready`.
3. Confirm `human_approval: "approved"` or preserve the user's exact `$implement ...` instruction as conversational approval.
4. Read the Decisions table, the Technical structure, and Risks; anything the Risks section says only the user can provide is a hard stop until it is provided.
5. Inspect `git status --short` and preserve unrelated changes.
6. Read likely implementation files before editing.

Stop for unresolved product decisions, credentials, production data, billing, destructive migrations, irreversible deployment, or a material structure deviation.

## 2. Start The Run

Do not create a Codex Goal unless the user explicitly requested goal tracking.

Start the machine record from the repository root:

```sh
sasu implement start --prd agents/prd/<topic-slug>/prd.md
```

When approval exists only in conversation, record it verbatim:

```sh
sasu implement start \
  --prd agents/prd/<topic-slug>/prd.md \
  --allow-unapproved-prd '<verbatim user approval>'
```

Start seals the PRD snapshot, one row per Behaviors table row, and the suite
list (`verify.commands` from `agents/config.json`, else the commands detected
from the repository). A PRD in the retired five-axis shape is refused with the
last commit that could read it; rewrite it in the six-section shape instead of
adapting the harness.

If the judged tree has uncommitted source changes, start refuses and lists every affected path instead of guessing who owns the bytes.
Re-run with `--dirty-attribution pre-existing` when those paths must be part of the baseline and excluded from this run's diff, or with `--dirty-attribution run-owned` when this run owns them and they must be judged.
When ownership is mixed, pass one JSON object on the same flag that maps every listed path exactly to `pre-existing` or `run-owned`; use the refusal message's path-complete example rather than adding or omitting paths.
The choice and resulting baseline are recorded in `state.json`.
Do not pick a disposition without grounding it in the handoff and repository state.
For a `$please` handoff, the specification-owning session must already have run `sasu implement intake` and either made the tree clean after the user's `먼저 커밋하고 시작` choice or supplied `DIRTY ATTRIBUTION: pre-existing|run-owned` in the `sasu implement dispatch` handoff packet.
Pass that supplied value to `sasu implement start` exactly and never ask the ownership question from the Implementor pane.

Read `workingRoot` from the start response.
When the harness isolated the run into a worktree, implement in that directory; the worktrees reference above covers the details.

Inspect current state with:

```sh
sasu implement status
```

It lists every row with its status: `pending`, `green`, `fail`, or `parked`
for a `check:` row, `pending`, `PASS`, or `FAIL` for a `judge:` row, `OPEN` or
`PASS` for a `human:` row.

Old implement state schemas are intentionally unsupported.
Start a new run instead of migrating or adapting them.
The run's exact approved PRD is pinned at the `prdSnapshotPath` reported by status.
If the source PRD drifts, restore its exact pinned bytes or retire the run and start the newly approved contract under a new slug.

## 3. Implement Rows

The Behaviors row is the unit of progress. How the rows are split into work is
the implementor's own call and the harness does not read it; rows may be
implemented in any order, including concurrently through worker subagents.
When fanning out, the Implementor session remains the execution coordinator: brief each worker with the row's behavior, its cited decisions, and file scope directly; workers return changed files, focused check results, and evidence text.
Workers never run `sasu` commands.
The Implementor reviews each result and runs the row's check itself, staying the only writer of `state.json`.

For each row:

1. Re-read the behavior and the Decisions rows it cites.
2. Make the smallest complete change.
3. Settle the row by its method cell.

A `check:` row runs the command sealed in its cell, from the judged tree's root, and records the exit code:

```sh
sasu implement check --row B1        # exit 0 -> green, anything else -> fail
```

The command is the PRD's, not yours. If it is wrong, the cell is amended
(section 3a), never worked around. A `judge:` or `human:` row refuses `check`
and names its own channel.

A `judge:` row is settled by unified verify from the diff and the evidence you
register against it (section 4).

A `human:` row is settled by the user after the run closes (section 6). Do not
try to close it; do not write its evidence.

After repeated failures, inspect `sasu implement status`.
Fix the cause and check again, or use the only deferral path, a human-approved park:

```sh
sasu implement park \
  --row B1 \
  --approval '<verbatim human approval>' \
  --reason '<why proof is deferred>' \
  --evidence '<optional incident or trace link>'

sasu implement resume --row B1
```

Resume returns the row to pending with a zeroed consecutive-failure counter.
A parked row cannot be checked until it is resumed.

### 3a. When The Row Is Wrong

Correcting the question paper is `amend`, and who may issue it depends on
which cell changed. The harness compares the cells; the issuer declares the
role.

- Only a `검사 방법` cell changed (the command, the evidence shape): the
  observer may amend, and only that row loses its proof.
- A behavior cell changed, a row was added or removed, or Non-goals or the
  Decisions table moved: the human amends, with their words as the approval.
- The implementor is refused either way; it does not rewrite the question it
  is being marked on. Emit `OBSERVER_BLOCK` with the row and the proposed cell.

```sh
sasu implement amend --issuer observer --approval '<why the cell was wrong>' --reason '<what changed>'
sasu implement amend --issuer human --approval '<verbatim user approval>' --reason '<what changed>'
```

Amend re-seals the PRD snapshot, archives the superseded text, and invalidates
only the rows whose cells changed; a parked row whose cell changed is unparked.

## 4. Register Final Runtime Evidence

The agent or an appropriate tool creates screenshots, API traces, DB captures, or other runtime evidence.
The CLI never creates those artifacts.

Register final evidence for each `judge:` row after the implementation is coherent and before unified verify:

```sh
sasu implement artifact \
  --row B2 \
  --kind screenshot \
  --path docs/screenshots/example.png \
  --description '<what this proves>'
```

A `judge:` row with no registered artifact fails the acceptance lane before a judge is called.
Registration pins the file hash and records when the agent supplied it in `state.json`.
The hash proves file identity; judges receive the registration time and decide whether an agent-supplied claim still reflects later source changes.

When a `judge:` row is proved by driving a screen, the drive is scripted and registered rather than described: `sasu implement qa-brief --row B2` derives a numbered script from the sealed row, and `sasu implement trail --row B2 --brief <briefId> --steps S1,S2 --driver <human|observer|qa-agent>` registers the drive against it.
The implementor may not drive the row it built.

Development-time screenshots and logs may remain temporary when they are not final evidence.

## 5. Unified Verify

After every `check:` row is green (or parked) and every `judge:` row has its evidence, freeze implementation content and run:

```sh
sasu implement verify
```

Verify refuses at zero cost while a `check:` row is not green on the current tree or the run-owned change set is empty.
The CLI owns this order:

1. Validate PRD, state, rows, and artifact identity.
2. Run the sealed suite once on one frozen tree; a red suite command fails the attempt before any judge is called.
3. Run the acceptance judge and fidelity judge concurrently as separate calls.
4. On `high-risk`, run one final risk review after both base lanes finish and fold its successful output into the risk ledger.
5. Record the input fingerprint, lane-local verdicts, ledger findings, errors, and timing in `state.json`.

Acceptance judge responsibility:

- Judge only `judge:` rows, one row per call, from the run-owned changed files and the evidence registered against that row.
- Receive the harness-owned row ledger: every row's sealed cell and, for `check:` rows, the exit-code result the harness recorded itself. `check:` rows are facts in that ledger, never items to re-judge.
- Inspect only the exact run-owned changed files and visual artifacts placed in the disposable evidence workspace; execution, writes, broad file discovery, history inspection, and web access remain disabled.
- Cite concrete changed files, mechanical output, or registered artifacts actually used.
- A parked row is omitted and recorded in the attempt's `parkedRows`.

Fidelity judge responsibility:

- Decide whether the goal, the Decisions table, the non-goals, deviations, and completion claims preserve intent.
- Use a fixed rubric; for a conversation-only PRD the Decisions table is the canonical intent source, for a qa-log PRD the full qa-log is unless a fresh spec gate already settled the qa-log to PRD leg.
- Do not repeat per-row artifact sufficiency or code correctness judgment.

Risk reviewer responsibility on `high-risk`:

- Inspect residual ship-safety risks after acceptance and fidelity finish.
- Record findings in the `state.json` risk ledger without voting on the unified verdict.
- Keep unresolved findings open, mark delta-proven resolutions fixed, and leave explicit user acceptance to `sasu implement risk --accept --id <RF#> --evidence "<verbatim user approval>"`.
- Leave the ledger unchanged when the risk call errors.

Do not automatically retry a generative judge.
A new explicit verify command creates a new attempt.
The CLI bounds the autonomous loop with `judge.retryBudget`: non-PASS attempts spend the fix budget, acceptance/fidelity ERROR attempts use a separate consecutive-error gauge, prelint corrections are free, and PASS resets both gauges.
When verify reports `budgetExhausted` or `judgeErrorLoop`, stop rather than running another attempt.
The only two exits are `sasu implement finalize --status blocked` and, when the user explicitly approves more verification, `sasu implement verify --grant-budget "<the user's words verbatim>"`.
Never archive or replace `state.json` to mint a fresh run; the grant keeps the whole history in one record.

## 6. Finalize And Confirm

Finalize only after unified verify returns a fresh PASS:

```sh
sasu implement finalize
```

Finalize reads state and hashes only.
It rejects a `check:` row that is not green, a `judge:` row that is not PASS, a parked row, non-PASS verification, stale judged source, missing or changed artifact bytes, open blocking risk findings, unanswered design comments, and malformed state.
It does not reject an OPEN `human:` row: the run closes `complete-pending-human`, the receipt carries the Behaviors table with a result per row and a score that counts machine and judge rows apart from human rows (`기계·판사 N/M PASS | human K OPEN`), and delivery may proceed.
It does not run tests, judges, browser tools, capture tools, or other subprocesses.
Running finalize twice with the same input returns the same completed result without creating another verification attempt.

Do not report Done until:

- `receipt.json` exists.
- `implementation-result.md` exists.
- `sasu implement status` reports `complete` or `complete-pending-human`.
- required verification is fresh PASS.

Then complete the authorized delivery outcome:

- local mode: run `node ~/.codex/skills/ship/scripts/prd_ship.js local --state <state.json>`.
- PR mode: hand off to `$ship` for preflight, body, commit, push, PR, and CI. OPEN `human:` rows travel in the PR body and never block merge.

The user closes each `human:` row when they have looked, in their own words:

```sh
sasu implement confirm --issuer human --row B3 --evidence '<the user's own words>'
sasu implement confirm --issuer human --row B3 --reject --evidence '<what they found wrong>'
```

Confirm rewrites the receipt in place; when the last OPEN row closes the receipt becomes `complete`.
A rejection keeps the row OPEN with the user's words beside it; the fix is a new run, because a closed run never reopens.
`confirm` from an implementor or observer is refused on authority.

## 7. Blocked Handoff

If required proof cannot pass, do not finalize and do not claim completion.
When an Observer owns the user-facing session, emit the `OBSERVER_BLOCK` packet defined in `references/observer-and-herdr.md` before waiting.
Report:

- the failed stage.
- the observable error and recovery.
- which rows remain open, and their statuses.
- whether the verify attempt is stale or artifact identity failed.
- whether the judge provider is unavailable.

Do not use overrides on the user's behalf.

## The Whole Flow

Two actors, one record. The supervisor plans and judges; the implementor
builds and is the only writer of implementation results. Everything either one
does goes through the CLI, which is the only thing that writes `state.json`.

```text
  supervisor (observer)                 implementor
  ---------------------                 -----------
  start ── seals PRD rows ──────────────►
        └─ seals the suite list         │
                                        ├─ check --row (check: rows)  ─┐
  await ◄──── event ────────────────────┤                              │ per row
        │                               ├─ artifact --row (judge: rows)│
        ├─ park / resume ──────────────►│  (or qa-brief ► trail        │
        ├─ amend (check cell only) ────►│   when a person drives)     ─┘
        ├─ design --raise ─────────────►│
        ├─ escalate ► solver ──────────►│  (diagnosis only, ≤3)
        │                               │
  human ├─ amend (behavior changed) ────┤
        └─ risk --non-convergent ───────┤
                                        ▼
                                        verify ── one runner, frozen tree
                                                ├─ judge: rows ─┐ + check:
                                                └─ suite axis  ─┘   ledger
                                                       │
                                        finalize ── receipt + report
                                                    (runs nothing;
                                                     human: rows stay OPEN)
                                                       │
  human ── confirm --row ──────────────────────────────┘
```

Nothing above waits on a timer. `await` blocks on the event log and returns on
a new event, a stall, or the implementor's death.

## One Run, Start To Finish

A four-row run: two `check:` rows, one `judge:` row driven by a person, one
`human:` row. Every line is a real command; nothing is elided.

```sh
# The supervisor opens the run. The PRD rows and the suite list seal here.
sasu implement start --prd agents/prd/checkout-retry/prd.md

# B1 is `check: npm test`. Implement, then run the sealed command.
sasu implement check --row B1                      # -> green

# B2 is `check: npm run e2e:ios` and cannot be proved on this runner.
sasu implement check --row B2                      # -> fail, x5
sasu implement park --row B2 --approval 'iOS는 나중에 봐도 돼' --reason 'no iOS runner here'

# B3 is a judge: row shown on a screen, so a person drives it. The implementor
# may not register its own drive.
sasu implement qa-brief --row B3                   # -> brief B3-Q1-9f2c1e
sasu implement artifact --row B3 --kind screenshot --path shots/retry.png   --description 'the retry banner after a failed charge'
sasu implement trail --row B3 --brief B3-Q1-9f2c1e --steps S1,S2,S3   --driver human --artifacts shots/retry.png

# B1's command turns out to name the wrong script. The check cell is the only
# thing that changes, so the observer amends it and only B1 loses its green.
sasu implement amend --issuer observer   --approval 'the cell named the unit suite; the row needs the integration suite'   --reason 'check: cell of B1'
sasu implement check --row B1                      # -> green again

# One runner, frozen tree, each command once. Then the receipt.
sasu implement resume --row B2                     # B2 must still be proved
sasu implement check --row B2                      # -> green on a runner that has iOS
sasu implement verify
sasu implement finalize
# receipt: complete-pending-human
#          기계·판사: 3/3 PASS | human: 1 OPEN, 0 confirmed | suite: 2/2 GREEN

# Later, the user looks at B4 and says so.
sasu implement confirm --issuer human --row B4 --evidence '재시도 배너 문구 괜찮다'
# receipt: complete
```

The parked row is why `finalize` before the resume would have been refused:
a park defers proof, it never replaces it. The OPEN human row is not a
refusal: only the person can close it, and the run does not pretend otherwise.

## Command Contract

Every `sasu implement` command and the flags it accepts.
A test compares this table against `sasu --help` in both directions and against the CLI's own command registry, so a command that appears in one place and not the others fails the harness rather than misleading a reader.
Global flags omitted from the table because every command takes them: `--json`, `--slug`, `--state`, `--adopt`, `--issuer`.

| Command | Required | Optional | Issuer |
| --- | --- | --- | --- |
| `intake` | - | - | anyone |
| `start` | `--prd` | `--allow-unapproved-prd`, `--dirty-attribution` | anyone |
| `check` | `--row` | - | implementor, human |
| `park` | `--row`, `--approval`, `--reason` | `--evidence` | implementor, observer, human |
| `resume` | `--row` | - | implementor, observer, human |
| `confirm` | `--row`, `--evidence` | `--reject` | human |
| `amend` | `--approval`, `--reason` | `--exclude-suite` | observer, human |
| `qa-brief` | `--row` | - | implementor, observer, human |
| `trail` | `--row`, `--brief`, `--steps`, `--driver` | `--artifacts` | implementor, observer, human |
| `dispatch` | `--name`, `--prd` | `--kind`, `--model`, `--effort` | anyone |
| `escalate` | `--reason` | `--target`, `--agent` | observer, human |
| `await` | - | `--since`, `--pid`, `--agent` | anyone |
| `artifact` | `--kind`, `--path`, `--description` | `--row` | implementor, human |
| `status` | - | - | anyone |
| `design` | `--id`, `--accept` | - | implementor, human |
| `design --raise` | `--area`, `--path`, `--text`, `--suggestion` | - | observer, human |
| `risk` | `--accept`, `--id`, `--evidence` | - | implementor, human |
| `risk --non-convergent` | `--id`, `--approval`, `--reason` | - | human |
| `verify` | - | `--grant-budget` | implementor, human |
| `retire` | - | - | anyone |
| `finalize` | - | `--status` | implementor, human |

Four of these carry a rule the flag name does not carry on its own:

- `dispatch` reads the handoff packet on stdin and is documented as `anyone` because the gate restricts nothing, but it refuses to run from a pane already marked `SASU_HERDR_ROLE=implementor`. That marker is set on the pane at creation, so an implementor cannot dispatch another implementor by declaring a different `--issuer`.

- `amend` admits observer and human, and the diff decides which one may issue it: a change confined to `검사 방법` cells is the observer's; a changed behavior cell, an added or removed row, or a moved Non-goals or Decisions section is the human's. The implementor is refused before the diff is read.
- `risk --non-convergent` declares one open finding structurally unfixable.
  The finding stays open and `finalize --status complete` stays refused; what it opens is `--status blocked` without first spending judge rounds whose outcome is already known.
- `amend --exclude-suite <S#>` drops a command from the sealed suite list.
  The command and its last result stay in the ledger as history and simply stop being scored; the sealed list minus its exclusions is the scoring authority.

## Hard Stops

Stop and ask when:

- approval is unresolved or the Risks section names something only the user can provide.
- the requested fix changes the approved structure or product behavior.
- credentials, billing, production data, destructive changes, or irreversible deployment are required.
- a required verification failure needs a product decision.
- delivery would push or open a PR without authorization.

## Final Report

The receipt's Behaviors table is the report of record; the final message
summarizes it rather than restating the PRD.

At minimum report:

- Status: Done, Partially Done, or Blocked, and the receipt status (`complete`, `complete-pending-human`, `blocked`).
- Public command and user-visible behavior changes.
- Actual module boundaries and removed legacy paths.
- Every row with its result, and the OPEN `human:` rows the user still has to confirm.
- Acceptance and fidelity results plus optional risk invocation, lane-local verdict, timing, and final ledger dispositions.
- Evidence that a red suite made zero judge calls.
- Evidence that finalize made zero execution calls.
- Completion fingerprint and receipt path.
- Deviations, autonomous assumptions, and remaining risks.
