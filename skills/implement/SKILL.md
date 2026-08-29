---
name: implement
description: |
  Project-local approved-PRD implementation executor and Observer entrypoint.
  Use when the user invokes "$implement", explicitly asks to execute an approved
  PRD through the receipt-backed workflow, or wants PRD tasks implemented and
  proven through one unified verification command.
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
bind Check to each machine AC
  -> run Check to green (or record a human-approved park)
  -> implementation complete and task close
  -> final evidence registered
  -> sasu implement verify
  -> sasu implement finalize
```

`state.json` is the only machine record.
`receipt.json` and `implementation-result.md` are derived outputs.

## Reference Routing

Read each directly linked reference completely when its condition applies.

| Reference | Read when |
| --- | --- |
| [`references/observer-and-herdr.md`](references/observer-and-herdr.md) | Before a direct Herdr invocation, when dispatched after `$please` PRD readiness, or when an Implementor blocks or needs recovery. |
| [`references/execution-planning.md`](references/execution-planning.md) | Before implementation, while closing tasks, or when execution order is unclear. |
| [`references/verification-and-evidence.md`](references/verification-and-evidence.md) | Before capturing or registering final runtime evidence and before unified verify. |
| [`references/verification-environments.md`](references/verification-environments.md) | When binding a browser/runtime, mobile, TUI, or desktop V row to a concrete driver. |
| [`references/reviews-and-finalization.md`](references/reviews-and-finalization.md) | Before unified verify, finalize, or a blocked handoff. |
| [`references/worktrees-and-delivery.md`](references/worktrees-and-delivery.md) | When delivery is `pr`, a worktree is configured, or post-receipt delivery is requested. |

## Core Invariants

- Never implement a pending PRD without explicit human approval or the user's verbatim conversational approval.
- Treat Major Technical Structure Changes as the approved structure boundary.
- Do not add unmapped scope, services, schemas, external calls, destructive actions, or compatibility paths.
- Verification proof is never reduced to save ceremony.
- The CLI executes deterministic verification before any LLM judge.
- Acceptance and fidelity are separate LLM calls and neither consumes the other's result.
- Required verification must be a current PASS whose attempt pins the current source and registered artifact hashes.
- `sasu implement finalize` never runs tests, judges, capture tools, or external commands.
- `state.json` is the completion authority; the receipt is its portable derived proof.
- The marked Implementor is the only implementation and `state.json` writer; the Observer stays read-only after dispatch, and both sessions treat the qa-log and PRD body as sealed inputs.
- Check results, fingerprints, counters, decision points, and approval windows are harness-owned facts.
  Never supply or synthesize them as agent evidence.
- A parked AC may unlock task work, but it is skipped explicitly by verify and always blocks a complete finalize until resumed and proved.
- Commit, push, PR creation, CI, and merge are post-receipt delivery outcomes.

## 1. Confirm Readiness

Before editing:

1. Read the complete PRD.
2. Confirm `status: ready`.
3. Confirm `human_approval: "approved"` or preserve the user's exact `$implement ...` instruction as conversational approval.
4. Resolve all pre-work and human decisions in section 4.
5. Read the structure lock, risks, and guardrails.
6. Inspect `git status --short` and preserve unrelated changes.
7. Read likely implementation files before editing.

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

If the judged tree has uncommitted source changes, start refuses and lists every affected path instead of guessing who owns the bytes.
Re-run with `--dirty-attribution pre-existing` when those paths must be part of the baseline and excluded from this run's diff, or with `--dirty-attribution run-owned` when this run owns them and they must be judged.
When ownership is mixed, pass one JSON object on the same flag that maps every listed path exactly to `pre-existing` or `run-owned`; use the refusal message's path-complete example rather than adding or omitting paths.
The choice and resulting baseline are recorded in `state.json`.
Do not pick a disposition without grounding it in the handoff and repository state.
For a `$please` handoff, the specification-owning session must already have run `sasu implement intake` and either made the tree clean after the user's `먼저 커밋하고 시작` choice or supplied `DIRTY ATTRIBUTION: pre-existing|run-owned` through the dispatch helper.
Pass that supplied value to `sasu implement start` exactly and never ask the ownership question from the Implementor pane.

Read `workingRoot` from the start response.
When the harness isolated the run into a worktree, implement the tasks in that directory; the worktrees reference above covers the details.

Inspect current state with:

```sh
sasu implement status
```

Old implement state schemas are intentionally unsupported.
Start a new run instead of migrating or adapting them.
The run's exact approved PRD is pinned at the `prdSnapshotPath` reported by status.
If the source PRD drifts, restore its exact pinned bytes or retire the run and start the newly approved contract under a new slug.

## 3. Implement Tasks

Execution order comes from the PRD's task dependencies.
A task without a `Depends on:` clause depends on the previous task, so a plain task list runs sequentially; explicit `Depends on:` declarations (approved with the PRD) are the only thing that unlocks out-of-chain order.
The CLI rejects closing a task before its dependencies are complete, and each close response lists the remaining tasks with which are `ready`.

Tasks whose dependencies are all complete may be implemented in any order, including concurrently through worker subagents.
When fanning out, the Implementor session remains the execution coordinator: brief each worker with the mapped requirement, acceptance criteria, and file scope directly; workers return changed files, focused check results, and evidence text.
Workers never run `sasu` commands.
The Implementor reviews each result and closes the task itself, staying the only writer of `state.json`.

For each task:

1. Re-read the mapped requirement and acceptance criteria.
2. Make the smallest complete change.
3. For each mapped `machine` or `machine+gate:human` AC, bind its focused Check once, run it, and use the state-owned green result as close authority.
4. Close the task.
   Optional `--evidence` records useful implementation context; it never substitutes for a missing or failing Check.

```sh
sasu implement check --ac AC1 --bind 'npm test' --cwd .
sasu implement check --ac AC1
```

The binding must be one fail-closed, project-confined command form.
Product suite addresses are recorded as `asset`; `agents/**` bookkeeping addresses are recorded as `labor`.
Replacing a binding requires a reason, preserves the full history, invalidates an earlier green, and resets the consecutive-failure counter:

```sh
sasu implement check \
  --ac AC1 \
  --bind 'node scripts/check-draft.mjs' \
  --reason 'the original checker exercised the wrong entrypoint'
```

For `machine+gate:human`, every execution needs a fresh approval quote.
The quote is consumed by that one attempt whether the command passes or fails:

```sh
sasu implement check --ac AC3 --human-window '<verbatim approval for this run>'
```

After repeated failures, inspect `sasu implement status`.
It surfaces same-class, five-failure, and tools-only decision points without stopping independent ready tasks.
Resolve the cause and rebind/check, or use the only Bundle-A deferral path, a human-approved park:

```sh
sasu implement park \
  --ac AC1 \
  --approval '<verbatim human approval>' \
  --reason '<why proof is deferred>' \
  --evidence '<optional incident or trace link>'

sasu implement resume --ac AC1
```

Resume returns the AC to pending with a zeroed consecutive-failure counter.
It does not reopen an already closed task.
A parked criterion cannot be checked until it is resumed.

```sh
sasu implement task \
  --id T1 \
  --status complete
```

Closing a task means only that its implementation obligation is complete.
It does not mark acceptance criteria or verification as passed.

## 4. Register Final Runtime Evidence

The agent or an appropriate tool creates screenshots, API traces, DB captures, or other runtime evidence.
The CLI never creates those artifacts.

Register final evidence after the implementation is coherent and before unified verify:

```sh
sasu implement artifact \
  --id V3 \
  --kind screenshot \
  --path docs/screenshots/example.png \
  --description '<what this proves>'
```

Evidence intended for a `judged` AC must also be bound to that semantic unit.
`--ac` and the existing V-lane `--id` may be used separately or together:

```sh
sasu implement artifact \
  --id V3 \
  --ac AC2 \
  --kind log \
  --path docs/evidence/recovery-run.log \
  --description 'expired-link failure and successful retry transcript'
```

Registration pins the file hash and records when the agent supplied it in `state.json`.
The hash proves file identity; judges receive the registration time and decide whether an agent-supplied claim still reflects later source changes.

Development-time screenshots and logs may remain temporary when they are not final evidence.

## 5. Unified Verify

After every task is closed and final evidence is registered, freeze implementation content and run:

```sh
sasu implement verify
```

The CLI owns this order:

1. Validate PRD, state, tasks, and artifact identity.
2. Run deterministic prelint and mechanical commands.
3. Stop before LLM calls when mechanical proof fails.
4. Run the acceptance judge and fidelity judge concurrently as separate calls.
5. On `high-risk`, run one final risk review after both base lanes finish and fold its successful output into the risk ledger.
6. Record the input fingerprint, lane-local verdicts, ledger findings, errors, and timing in `state.json`.

Acceptance judge responsibility:

- Decide whether code and registered evidence satisfy every acceptance criterion.
- Receive the relevant mechanical output and text artifact bytes directly from the harness.
- Inspect only the exact run-owned changed files and visual artifacts placed in the disposable evidence workspace; execution, writes, broad file discovery, history inspection, and web access remain disabled.
- Cite concrete changed files, mechanical output, or registered artifacts actually used.
- Receive the harness-owned Check ledger hash and complete binding history for its AC.
  A parked AC is omitted and recorded in the attempt's `skippedAcceptanceCriteria`; a `judged` AC with no AC-bound artifact fails deterministically before a provider call.

Fidelity judge responsibility:

- Decide whether the original goal, accepted decisions, constraints, rejected choices, non-goals, deviations, and completion claims preserve intent.
- Use a fixed rubric with context selected from the current PRD source situation.
- Do not repeat per-verification artifact sufficiency or code correctness judgment.

Risk reviewer responsibility on `high-risk`:

- Inspect residual ship-safety risks after acceptance and fidelity finish.
- Record findings in the `state.json` risk ledger without voting on the unified verdict.
- Keep unresolved findings open, mark delta-proven resolutions fixed, and leave explicit user acceptance to `sasu implement risk --accept --id <RF#> --evidence "<verbatim user approval>"`.
- Leave the ledger unchanged when the risk call errors.

For a conversation-only PRD, Decision Traceability is the canonical intent source because the CLI cannot read chat history.
For a qa-log PRD, full qa-log is used unless a fresh spec gate already settled the qa-log to PRD leg.

Do not automatically retry a generative judge.
A new explicit verify command creates a new attempt.
The CLI bounds the autonomous loop with `judge.retryBudget`: non-PASS attempts spend the fix budget, acceptance/fidelity ERROR attempts use a separate consecutive-error gauge, prelint corrections are free, and PASS resets both gauges.
When verify reports `budgetExhausted` or `judgeErrorLoop`, stop rather than running another attempt.
The only two exits are `sasu implement finalize --status blocked` and, when the user explicitly approves more verification, `sasu implement verify --grant-budget "<the user's words verbatim>"`.
Never archive or replace `state.json` to mint a fresh run; the grant keeps the whole history in one record.

## 6. Finalize

Finalize only after unified verify returns a fresh PASS:

```sh
sasu implement finalize
```

Finalize reads state and hashes only.
It rejects open tasks, unmet acceptance criteria, non-PASS verification, stale judged source, missing or changed artifact bytes, open blocking risk findings, unanswered design comments, and malformed state.
It also rejects every parked AC even when verify honestly skipped it and the other lanes passed.
It does not run tests, judges, browser tools, capture tools, or other subprocesses.

Running finalize twice with the same input returns the same completed result without creating another verification attempt.

Do not report Done until:

- `receipt.json` exists.
- `implementation-result.md` exists.
- `sasu implement status` reports complete.
- required verification is fresh PASS.

## 7. Blocked Handoff

If required proof cannot pass, do not finalize and do not claim completion.
When an Observer owns the user-facing session, emit the `OBSERVER_BLOCK` packet defined in `references/observer-and-herdr.md` before waiting.
Report:

- the failed stage.
- the observable error and recovery.
- which tasks, ACs, or verification items remain open.
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
  start ── seals PRD snapshot ──────────►
        └─ seals the suite list         │
                                        ├─ check --bind / check   ─┐
  await ◄──── event ────────────────────┤                          │ per AC
        │                               ├─ artifact                │
        ├─ park / resume ──────────────►│  (or qa-brief ► trail    │
        ├─ resequence ─────────────────►│   when a person drives)  │
        ├─ design --raise ─────────────►│                         ─┘
        ├─ escalate ► solver ──────────►│  (diagnosis only, ≤3)
        │                               └─ task --status complete
        │                                       │
  human ├─ amend (question was wrong) ──────────┤
        └─ risk --non-convergent ───────────────┤
                                                ▼
                                        verify ── one runner, frozen tree
                                                ├─ AC ledger  ─┐ two
                                                └─ suite axis ─┘ axes
                                                       │
                                        finalize ── receipt + report
                                                    (runs nothing)
```

Nothing above waits on a timer. `await` blocks on the event log and returns on
a new event, a stall, or the implementor's death.

## One Run, Start To Finish

A four-criterion run where one criterion is parked and one is driven by a
person. Every line is a real command; nothing is elided.

```sh
# The supervisor opens the run. The PRD snapshot and the suite list seal here.
sasu implement start --prd agents/prd/checkout-retry/prd.md

# AC1, AC2, AC4 are machine criteria: bind a command, then run it.
sasu implement check --ac AC1 --bind 'npm test' --cwd .
sasu implement check --ac AC1                      # -> green

# AC2 cannot be proved on this runner. Five failures open a decision point,
# and the supervisor parks it on that - not on its own opinion.
sasu implement check --ac AC2 --bind 'npm run e2e:ios' --cwd .
sasu implement check --ac AC2                      # -> red, x5
sasu implement park --issuer observer --ac AC2 --reason 'no iOS runner here'

# AC3 is judged and shown on a screen, so a person drives it. The implementor
# may not register its own drive.
sasu implement qa-brief --ac AC3                   # -> brief AC3-B1-9f2c...
sasu implement artifact --ac AC3 --kind screenshot --path shots/retry.png   --description 'the retry banner after a failed charge'
sasu implement trail --ac AC3 --brief AC3-B1-9f2c1e --steps S1,S2,S3   --driver human --artifacts shots/retry.png

# AC4's PRD row turns out to be wrong. Only a human may correct the question,
# and only AC4 loses its green.
sasu implement amend --issuer human   --approval '맞다 AC4 문장이 틀렸다, 고치고 가자'   --reason 'the row asked for a retry count the product never had'
sasu implement check --ac AC4 --bind 'npm test' --cwd . --reason 're-proved after amendment'
sasu implement check --ac AC4                      # -> green

sasu implement task --id T1 --status complete
sasu implement task --id T2 --status complete

# One runner, frozen tree, each command once. Then the receipt.
sasu implement verify
sasu implement resume --ac AC2                     # AC2 must still be proved
sasu implement check --ac AC2                      # -> green on a runner that has iOS
sasu implement verify
sasu implement finalize
# receipt: AC: 4/4 PASS | suite: 2/2 GREEN
```

The parked criterion is why the first `finalize` would have been refused:
a park defers proof, it never replaces it.

## Command Contract

Every `sasu implement` command and the flags it accepts.
A test compares this table against `sasu --help` in both directions and against the CLI's own command registry, so a command that appears in one place and not the others fails the harness rather than misleading a reader.
Global flags omitted from the table because every command takes them: `--json`, `--slug`, `--state`, `--adopt`, `--issuer`.

| Command | Required | Optional | Issuer |
| --- | --- | --- | --- |
| `intake` | - | - | anyone |
| `start` | `--prd` | `--allow-unapproved-prd`, `--dirty-attribution` | anyone |
| `check` | `--ac` | `--bind`, `--cwd`, `--reason`, `--human-window`, `--bookkeeping` | implementor, human |
| `park` | `--ac`, `--approval`, `--reason` | `--evidence` | implementor, observer, human |
| `resume` | `--ac` | - | implementor, observer, human |
| `resequence` | `--order` | `--reason` | observer, human |
| `amend` | `--approval`, `--reason` | `--exclude-suite` | human |
| `qa-brief` | `--ac` | - | implementor, observer, human |
| `trail` | `--ac`, `--brief`, `--steps`, `--driver` | `--artifacts` | implementor, observer, human |
| `escalate` | `--reason` | `--target`, `--agent` | observer, human |
| `await` | - | `--since`, `--pid`, `--agent` | anyone |
| `task` | `--id` | `--status`, `--evidence` | implementor, human |
| `artifact` | `--kind`, `--path`, `--description` | `--id`, `--ac` | implementor, human |
| `status` | - | - | anyone |
| `design` | `--id`, `--accept` | - | implementor, human |
| `design --raise` | `--area`, `--path`, `--text`, `--suggestion` | - | observer, human |
| `risk` | `--accept`, `--id`, `--evidence` | - | implementor, human |
| `risk --non-convergent` | `--id`, `--approval`, `--reason` | - | human |
| `verify` | - | `--grant-budget` | implementor, human |
| `retire` | - | - | anyone |
| `finalize` | - | `--status` | implementor, human |

Three of these carry a rule the flag name does not carry on its own:

- `check --bookkeeping <agents/... path>` declares a file under `agents/**` that this criterion's work will change, and it must be issued **before** the work.
  The baseline is taken when the target is declared, so a declaration made after the edit records the finished state and the close refuses with "unchanged since it was declared".
  Closing the task then requires both that the content moved from that baseline and that a registered artifact vouches for the current bytes.
  This exists because `agents/**` is excluded from every judged diff, so nothing there can be proved the way product changes are.
- `risk --non-convergent` declares one open finding structurally unfixable.
  The finding stays open and `finalize --status complete` stays refused; what it opens is `--status blocked` without first spending judge rounds whose outcome is already known.
- `amend --exclude-suite <S#>` drops a command from the sealed suite list.
  The command and its last result stay in the ledger as history and simply stop being scored; the sealed list minus its exclusions is the scoring authority.

## Hard Stops

Stop and ask when:

- approval or required pre-work is unresolved.
- the requested fix changes the approved structure or product behavior.
- credentials, billing, production data, destructive changes, or irreversible deployment are required.
- a required verification failure needs a product decision.
- delivery would push or open a PR without authorization.

## Final Report

Follow the PRD's Implementation Result Report Contract.

At minimum report:

- Status: Done, Partially Done, or Blocked.
- Public command and user-visible behavior changes.
- Actual module boundaries and removed legacy paths.
- Task and acceptance-criterion status.
- Verification evidence by mode.
- Acceptance and fidelity voting results plus optional risk invocation, lane-local verdict, timing, and final ledger dispositions.
- Evidence that mechanical failure made zero judge calls.
- Evidence that finalize made zero execution calls.
- Completion fingerprint and receipt path.
- Deviations and remaining risks.
