## Verdict

Do not merge. The executor, reservation, revision-reader and
terminal-notification fixes address the reproduced failures, and all
116 focused tests passed. However, two counterexamples remain:
handover can overwrite a newer dispatch’s enrollment, leaving the
current run unwatched; and successful but slow Herdr lookups can
exhaust every tick before delivery, indefinitely. The implementation
is converging toward a bounded persistent scheduler, but “all
closed,” one-tick recovery and guaranteed wrong-recipient
harmlessness still overstate the evidence.

## Item status

“Closed” below refers to the specific reported failure, not an
exactly-once delivery guarantee.

 Item                     New 1: delivery executor
 Status                   Closed
 Evidence with file:line  cli/src/supervisor/tick.ts:610 claims one
                          executor; :468 reserves before
                          submission; :566 conditionally completes
                          the matching operation. Overlap
                          reproductions now produce two bounded
                          uncertain submissions, and two accepted
                          submissions for two episodes.
 Remaining gap            A live but stuck executor continues to
                          exclude others. This is deliberately safer
                          than stealing ownership.
─────────────────────────────────────────────────────────────────────
 Item                     New 2: pending dispatch / absent child
 Status                   Closed
 Evidence with file:line  cli/src/supervisor/commands.ts:154 accepts
                          pending-only handover. cli/src/implement/
                          commands.ts:664 handles
                          reconciliation; :678 handles positively
                          absent children; :698 handles planned
                          recovery; :754 repairs resume
                          prerequisites. Both original recovery
                          reproductions succeeded.
 Remaining gap            The new handover path remains vulnerable to
                          the separate enrollment race under Partial
                          8.
─────────────────────────────────────────────────────────────────────
 Item                     New 3: revision read
 Status                   Closed
 Evidence with file:line  cli/src/supervisor/index.ts:170 reads
                          through one descriptor; :181 retries a
                          freshly selected head after ENOENT; :217
                          cleans dead-owner temporary files. The
                          reader survived five intervening writes and
                          pruning.
 Remaining gap            Temporary-file cleanup is opportunistic and
                          uses PID existence, not incarnation.
─────────────────────────────────────────────────────────────────────
 Item                     New 4: terminal notification
 Status                   Closed
 Evidence with file:line  cli/src/supervisor/tick.ts:414 and :532
                          defer busy Observers; :594 counts definite
                          rejection. cli/src/supervisor/
                          commands.ts:98 exposes abandoned terminal
                          notifications. Repeated busy ticks consumed
                          no budget; subsequent idle delivery
                          happened once.
 Remaining gap            Historical undelivered-terminal records
                          have no explicit acknowledgement/resolution
                          operation.
─────────────────────────────────────────────────────────────────────
 Item                     Partial 1: episode acknowledgements /
                          pending delivery
 Status                   Closed
 Evidence with file:line  cli/src/supervisor/tick.ts:468, :566, :574
                          bind reservation and acknowledgement
                          updates to the current operation. The
                          older-completion acknowledgement regression
                          no longer reproduced.
 Remaining gap            Crash ambiguity remains bounded, rather
                          than eliminated.
─────────────────────────────────────────────────────────────────────
 Item                     Partial 2: immutable revisions / replay
 Status                   Closed
 Evidence with file:line  cli/src/supervisor/index.ts:181, :240
                          combine fresh-head reading with immutable
                          publication and operation recognition.
                          Reader-pruner and post-publication
                          regressions pass.
 Remaining gap            Ambiguity beyond retained operation history
                          still fails closed. That is an acceptable
                          explicit limit.
─────────────────────────────────────────────────────────────────────
 Item                     Partial 7: definite versus uncertain
                          delivery
 Status                   Closed
 Evidence with file:line  cli/src/supervisor/tick.ts:492, :557, :578
                          restore an unsubmitted reservation, retain
                          uncertain attempts, and distinguish
                          definite rejection.
 Remaining gap            A process crash after reservation but
                          before submission is indistinguishable from
                          possible submission. Repeated crashes can
                          exhaust the budget without delivering
                          anything. B3 must acknowledge this.
─────────────────────────────────────────────────────────────────────
 Item                     Partial 8: staged dispatch / generation
                          binding
 Status                   Partially closed
 Evidence with file:line  cli/src/implement/commands.ts:599, :625
                          correctly bind generation before authority
                          and reconcile afterwards. But cli/src/
                          supervisor/commands.ts:173 still persists
                          state followed by unconditional enrollment
                          at :175.
 Remaining gap            Confirmed handover race replaces the
                          current enrollment with an obsolete
                          instance. Finding 1 below.
─────────────────────────────────────────────────────────────────────
 Item                     Partial 10: resource bounds / progress
 Status                   Partially closed
 Evidence with file:line  cli/src/supervisor/index.ts:55 bounds
                          records and history; cli/src/supervisor/
                          tick.ts:184, :195 introduce deadlines and
                          fair selection.
 Remaining gap            The deadline neither bounds an in-progress
                          adapter call nor guarantees eventual
                          delivery. Finding 2 below.

## New findings

1. P1: Handover still bypasses generation-aware enrollment
   reconciliation.
   At cli/src/supervisor/commands.ts:173, handover commits state,
   then enrolls its captured instance unconditionally. cli/src/
   supervisor/index.ts:303 replaces any enrollment for that path.

   Reproduction: pause handover after state persistence; let
   authorized recovery clear the pending dispatch and a new dispatch
   commit and enroll; resume handover. Actual compiled modules
   returned:

   {"ok":true,"runInState":"new-dispatch","indexRuns":["old-
   pending"]}

   The next tick reports an instance mismatch. It cannot discover the
   missing current enrollment, so the new run remains unwatched. The
   ordinary-supervision form predates this delta; the new pending-
   handover path exposes the same unresolved failure class.

   Smallest fix: route handover through the shared generation-aware
   reconciliation protocol, capturing enrollment generation before
   its authority snapshot and checking fresh committed authority
   afterwards. Return success only for the resulting current
   authority. Add a barrier regression between handover persistence
   and enrollment. This is engineering principle 13, fix the class of
   failure, rather than protecting only the recovery helpers.

2. P2: The new deadline can permanently starve a deliverable wake and
   is not a total runtime bound.
   cli/src/supervisor/tick.ts:184 checks elapsed time only before
   calls. A ready run performs initial Implementor and Observer
   lookups, another Observer lookup at :408, and the final lookup
   at :525, before submission at :556.

   With every lookup succeeding in 6.5 seconds, four consecutive
   simulated ticks each took 26 seconds, deferred delivery, and made
   zero submissions. The reservation was rolled back each time, so
   every subsequent tick repeated the same unsuccessful sequence.
   These calls are comfortably below the adapter’s existing 15-second
   timeout.

   With six-second calls, the first tick submitted successfully but
   took 30 seconds, exceeding the advertised 25-second deadline.

   Smallest coherent fix: budget observation and delivery as one
   admitted unit, retaining the final identity check while removing
   redundant work where possible. Propagate the remaining monotonic
   deadline into adapter calls. Ensure an admitted unit can either
   finish within its declared bounds or produce an actionable
   failure, rather than endlessly promise progress next tick. Add the
   single-run slow-success case; fair rotation alone cannot fix it.
   This concerns principles 11, retries converge, and 15, cap every
   resource.

## Convergence

The commit count alone is not evidence of a failing design. Most
added state is required by the stronger guarantees requested in the
reviews. But this is now a persistent scheduler with a short-lived
executor, not merely a stateless tick over a path list.

Counting named schema additions since c15c6f9, with nested fields
counted separately:

 Area        Scheduler entry
 Additions   6 members: enrollmentId, terminalFailureTicks,
             acknowledgements, lastAcknowledgedAt, pendingWake,
             lastProcessedAt
 Assessment  Load-bearing for stale-writer rejection, notification
             budgets, deduplication, patrol timing, uncertain
             delivery and fairness.
─────────────────────────────────────────────────────────────────────
 Area        Scheduler root
 Additions   3 members: appliedWrites, tickExecutor,
             undeliveredTerminal
 Assessment  Load-bearing for publication recognition, serialized
             effects and visible abandoned notifications.
─────────────────────────────────────────────────────────────────────
 Area        Nested scheduler records
 Additions   5 pending-attempt fields, 5 executor fields, 6 terminal-
             outcome fields; acknowledgement map has at most seven
             reason keys
 Assessment  Mostly necessary protocol or diagnostic data.
             tickExecutor.expiresAt does not govern recovery and is
             misleading as an expiry promise.
─────────────────────────────────────────────────────────────────────
 Area        Run state
 Additions   1 new container, pendingDispatch, with 13 immediate
             fields, including its three-phase discriminator
 Assessment  Staged intent and identity survive interruption. Several
             fields mirror eventual supervision, increasing
             consistency obligations.
─────────────────────────────────────────────────────────────────────
 Area        Prepared dispatch
 Additions   9 nested fields
 Assessment  paneId, cwd and hostScope drive current cleanup
             decisions. The other six provide provenance/validation;
             they are not all operationally necessary.
─────────────────────────────────────────────────────────────────────
 Area        Existing Implementor identity
 Additions   4 additional fields: session, terminal, host scope and
             recording time
 Assessment  The first three enforce identity. Recording time
             supplies provenance.

Using protocol families rather than counting every conditional, I
count eight added control paths: revision publication/replay; reader/
pruner recovery; executor acquisition/recovery/release; delivery
reservation/completion/rollback; fair bounded scheduling; staged
dispatch and phase recovery; cross-record prerequisite
reconciliation; terminal-failure archival.

These are mostly load-bearing. The remaining weakness is that their
invariants are distributed across callers. Handover demonstrates why
adding another correct helper is insufficient unless every authority-
changing path uses it.

The architecture remains reasonable for launchd: a resident daemon
would not remove crash ambiguity or the two-record consistency
problem. The simplification still needed is one enrollment
reconciliation boundary, not another durable ledger. The tick
continues to leave state.json untouched, and the added decisions
remain deterministic rather than semantic review.

## Contract wording

Amendment 1 is directionally correct, not merely rationalization. D-
04’s staged dispatch, D-05’s persistent scheduler record, D-09’s
serialized reservations and B15’s budget-free busy deferral describe
necessary behavior more honestly than the original wording.

However, B3 remains too strong:

- “At most one tick interval” does not account for bounded batches,
  busy Observers, backlogs or repeated delivery uncertainty.

- A crash after reservation but before submission can spend
  uncertainty budget without an actual submission.

- Restart reconstructs the scheduler’s recorded state; it does not
  guarantee successful delivery on the next tick.

State those limits explicitly. Also distinguish D-03’s rejection of a
resident generation-lease design from the executor ownership record
now required by D-09.

Amendment 2 is appropriate and is now complete. I checked the current
PRD and amendment records: amendment 2 is recorded, and the current
PRD SHA-256 matches the sealed value, 51b5352d…eb245. Its Technical
structure sentence correctly acknowledges durable executor ownership
and process-incarnation checks. The PR body’s older request to fix
that sentence is now stale.

The remaining lookup-to-input window is real. The last lookup at
tick.ts:525, local authority checks, and promptAgent at :556 are
separate operations. A session can change after the lookup. Herdr’s
guarded-input facility can close its own submission race when
supported; repeated local checks cannot make an unguarded submission
atomic.

The Security disclosure and PR discussion are honest about this
limitation. The PRD’s claim that an identity note guarantees zero
actions in a wrong session is not. The owner-checked digest limits
access through that command; it cannot guarantee what an agent does
after receiving text. Revise that claim to a mitigation with residual
risk. Executable dispatch packets also deserve separate treatment
from advisory wake notes.

## Follow-up improvements

- Clarify executor recovery. expiresAt is not consulted when the
  exact owner remains alive. Remove or relabel it, and expose a
  stuck-owner diagnosis. Do not restore unsafe time-based lease
  stealing.

- Separate historical incidents from current health. Every retained
  undelivered-terminal record currently contributes to unhealthy
  status. Provide an explicit resolution mechanism while preserving
  the incident record.

- Finish storage-bound accounting. Normal revision retention and byte
  caps are substantial improvements. Crash temporary-file cleanup
  remains dependent on a later successful write and PID absence; a
  reused live PID can retain an orphan.

- Use monotonic time for execution budgets. Wall-clock jumps should
  not change the amount of work a tick may perform. Document machine-
  sleep effects separately from process runtime.

- Keep the trust boundary explicit. No new shell-argument injection
  was found in this delta. However, writable run state remains
  routing authority, and the installation-time executable/PATH trust
  assumptions remain. These changes do not create isolation from a
  malicious same-user process.

- Correct remaining documentation drift. The Technical structure
  still says the tick reads worktree Git facts, although those facts
  belong to digest collection. Preserve the accurate distinction
  between native reviews on e3e07f1, the subsequent fix, and final-
  head testing.

## What was checked

Source and records

- Reviewed the complete 16-file 3c88f6f..284e977 delta, including all
  changed tests.

- Read current supervisor tick and index implementations in full;
  examined supervisor command/LaunchAgent changes and the surrounding
  delivery, status and handover paths.

- The independent dispatch review covered the changed implementation
  command/store/type code and recovery, authority, navigation and
  cleanup paths.

- Read the preserved round-two report, follow-up disposition, current
  PRD, relevant amendment/seal records and PR body.

- Larger unchanged implementation modules were inspected selectively.
  This was not a fresh full review of every file since 46c9f85.

- Confirmed exact HEAD 284e977, merge-base 46c9f85, and a clean
  worktree.

Commands and results

 Check                              Result
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 git diff --check                   Passed
 3c88f6f..284e977
─────────────────────────────────  ──────────────────────────────────
 ./cli/node_modules/.bin/tsc -p     Passed
 cli/tsconfig.json --noEmit
─────────────────────────────────  ──────────────────────────────────
 Read-only in-memory TypeScript     54 generated files matched; zero
 emit comparison against cli/       diagnostics using the correct
 dist                               CLI working directory
─────────────────────────────────  ──────────────────────────────────
 node --test cli/test/unit/         95 passed, 0 failed, 0 skipped
 supervisor-*.test.mjs cli/test/
 e2e/supervisor.test.mjs
─────────────────────────────────  ──────────────────────────────────
 node --test cli/test/e2e/          21 passed, 0 failed, 0 skipped
 implement-dispatch.test.mjs

The full repository suite and live installed-runtime smoke were not
rerun. No installer, real launchd mutation or Herdr pane input was
performed.

Reproductions

Actual compiled modules were exercised with injected in-memory
filesystem/runtime boundaries, not live panes:

- Concurrent uncertain delivery: bounded to two submissions.
- Older completion overwriting a newer episode acknowledgement: no
  longer reproduced.

- Reader overtaken by revision pruning: recovered.
- Retired run with repeatedly busy Observer: zero budget consumed,
  then one idle delivery.
