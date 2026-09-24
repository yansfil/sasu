# Observer drift advisor: a four-question plan and wakes on progress and drift

Status: implemented on 2026-09-25.
Source: the design decided with the user in `agents/runs/observer-drift-advisor-20260925/` of the record tree (run bookkeeping, not committed).
It follows the [verification convergence plan](2026-09-24-verification-convergence.md) and changes only the execution plan's content and what wakes the Observer.

## Problem

The Observer was woken by time and by exceptions, not by what the Implementor was doing.
Between the `plan` wake and a `settled`, `stall`, or `patrol` wake, an Implementor could rerun a failing input, commit run bookkeeping into the product diff, or leave changes uncommitted while it wandered, and nothing asked the Observer to look.
herdr-ide run `web-shell-pivot-s4` measured the cost on 2026-09-24: attempts 6-8 reran one `inputFingerprint` for about 6.7 minutes, every one failed, and no wake arrived.
The execution plan template asked for a shape (`READ`, `SLICES` with `files:`, `UNKNOWNS`) instead of the decisions its reader needs.
The user asked for an Observer that advises at once when the run is off the plan or tangled, and that calls for a diagnosis on its own, with some force.

## Design

### The plan answers four questions

The Implementor still writes `agents/runs/<slug>/plan.md` before the first source write and registers it with `sasu implement plan`.
Its format is free and nothing validates it; what changes is what it answers.

1. How I will build it: the PRD's structure mapped onto the real code, and the one or two decisions that are expensive to reverse.
2. Where it can go wrong: the risks that decide the order.
3. What I decide and go with: choices the PRD does not settle, each with its reason, which the Observer answers only when it disagrees.
4. Order and the check for each step: one commit per step, cut by observable behavior, each with what a person sees or which test turns green.

A structure that differs from the approved PRD is still an `OBSERVER_BLOCK` before the first write.

### Two new wake reasons, computed from facts

| Reason | Fact | Episode |
| --- | --- | --- |
| `commit` | commits exist since the dispatch head (`git rev-list --count`) | the current HEAD; several commits between two ticks are one wake |
| `drift` | `repeated-fail`: the last two or more verify attempts since dispatch are FAIL on one `inputFingerprint` | `repeated-fail:<latest attempt id>:<bucket>` |
| | `outside-boundary`: the digest's changed paths outside the delivery boundary | `outside-boundary:<sorted path hash>:<bucket>` |
| | `uncommitted-age`: uncommitted changes whose newest is 20 minutes old while herdr shows the Implementor working | `uncommitted-age:<newest change time>:<bucket>` |

The bucket counts whole 10-minute intervals since the fact began, so a persisting fact is raised again every 10 minutes until it clears.
Each onset comes from the fact itself: the latest attempt's finish, the moment the newest change turned 20 minutes old, and the oldest modification among the outside paths.
Several drift facts at once are one `drift` reason whose detail names each.
`drift` rides along with `settled`, `blocked`, `stall`, or a due `patrol` in the same wake, and an accepted `commit` wake counts as the Observer's look, so `patrol` stays the fallback when no commit arrives.
The tick reads the run's git tree with four bounded git calls (5 seconds per run in total); a tree it cannot read adds neither reason and shows as the run's current failure.
The repeated-input predicate is the one `verify` already uses for its "Repeated input" line, now shared from `cli/src/implement/verdict.ts`.

### What the Observer does

- `plan`: answer only a decision it disagrees with or a structure that differs from the PRD.
- `commit`: compare the commit subjects and changed paths with the plan's structure and order; one line of direction when a commit is off either.
- `drift`: "fine" is not an answer; one line of direction when the cause is plain, otherwise `sasu implement escalate` and the diagnosis's suggested next step forwarded as the direction.
  The second `drift` wake for the same fact kind on one run requires the escalation, and the budget of three escalations per run is the cap.

## Example

Replaying S4 under this change: attempt 7 finishes FAIL on the input attempt 6 failed on, and within one tick the Observer receives `drift: repeated-fail: 2 consecutive FAIL verify attempts on one verification input`.
It reads the digest, names the failing suite, and sends one line of direction: reproduce that one test in isolation before another full verify.
If attempt 8 runs on the same input anyway, it is a new `repeated-fail` fact on the same run, the second `drift` wake of that kind, so the Observer escalates and forwards the solver's suggested next step instead of a second line of its own.

## Deliberately not built

- No plan validator or conformance checker; the plan stays prose for people and agents.
- No model call in the tick; `escalate` stays the only place a diagnosis model runs, and only the Observer invokes it.
- No change to `escalate`, its solver, its budget, or the replacement path.
  Escalating therefore still needs `--adopt` from the Observer, and the Implementor takes the run back with `--adopt` on its next mutating command.
- No new state file, ledger, or tick memory; drift episodes live in the existing acknowledgements.
- No change to the stall threshold or the tick interval.

## Known limits

- The 10-minute re-raise rests on the S4 loop and the 20-minute uncommitted age is an unmeasured initial default; both live beside `STALL_THRESHOLD_MS` in `cli/src/implement/types.ts`.
- `repeated-fail` persists until the next verify attempt, so an Implementor that spends more than 10 minutes fixing after two identical FAILs is raised again and the Observer escalates.
- The `outside-boundary` onset is a file modification time: editing the oldest outside path restarts its interval, and a set made only of deletions measures from the dispatch.

## Principles

Sasu 2 and 7: the tick stays deterministic facts; judgment stays with the Observer and the solver.
Sasu 13: a drift wake asks for one move, never a loop; the escalation budget caps it.
Engineering 4: a persisting drift fact keeps raising instead of being silently acknowledged once, and an unreadable git tree is a reported failure, not an empty fact.
Engineering 13: the class fixed is "the Observer is woken by time, not by what the Implementor is doing".
