## Verdict

Merge with changes. The handover race
is closed, recipient generations now
track Observer authority, and the
original slow-call starvation
reproduction reaches delivery or a
visible bounded failure. All 124
independently rerun tests passed.
However, the claimed total deadline
remains conditional on the subprocess
obeying SIGTERM, and several contract
sentences still promise more than the
implementation delivers. I found no
further confirmed enrollment race in
this delta.

- Before merge: harden subprocess
  timeout termination; correct B3/B8
  timing guarantees and the Technical
  structure Git-facts sentence, then
  reseal and refresh verification.

- Can follow: restrict low-level
  enrollment exports, improve
  historical-incident resolution, and
  strengthen timeout/clock regression
  coverage.

## Item status

 Item
  Finding 1: handover overwrites newer
  enrollment
 Status
  Closed
 Evidence and remaining gap
  supervisor/commands.ts:170 captures
  generation before authority; :199
  reconciles current authority; :206
  checks the resulting recipient. The
  original compiled-module reproduction
  now leaves both state and index on
  new-dispatch.
───────────────────────────────────────
 Item
  Finding 2: slow calls starve
  delivery / exceed deadline
 Status
  Partially closed
 Evidence and remaining gap
  supervisor/tick.ts:196 calculates
  remaining monotonic time; implement/
  herdr.ts:116 passes it to spawnSync.
  Six-second calls now finish in 24
  seconds. At 6.5 seconds, submission
  is attempted twice, times out, and
  becomes a visible exhausted-
  uncertainty failure. The remaining
  subprocess termination gap is below.
───────────────────────────────────────
 Item
  Shared authority boundary
 Status
  Closed for production authority
  changes
 Evidence and remaining gap
  Production callers use
  reconcileEnrollmentAuthority() at
  index.ts:362, through implement/
  commands.ts:620, :648, supervisor/
  commands.ts:199, and supervisor/
  tick.ts:347. Tick cleanup still
  removes entries directly at
  tick.ts:245, conditionally on
  enrollment generation.
───────────────────────────────────────
 Item
  Recipient-generation binding
 Status
  Closed for the reviewed failures
 Evidence and remaining gap
  index.ts:74 hashes runtime/session/
  terminal/pane/host identity; :429
  treats recipient or recovery-owner
  changes as a new generation. Same-
  recipient retries preserve
  generation. Old acknowledgements and
  uncertain attempts cannot consume the
  replacement’s budget.
───────────────────────────────────────
 Item
  Regression-test effectiveness
 Status
  Substantially adequate
 Evidence and remaining gap
  Handover tests assert newer-instance
  preservation, structured refusal and
  interrupted retry behavior. Slow-call
  tests assert submission, elapsed time
  and eventual exhausted-budget
  failure. The adapter test checks
  timeout propagation, but not actual
  child termination.
───────────────────────────────────────
 Item
  Amendment 3 and documentation
 Status
  Partially closed
 Evidence and remaining gap
  The sealed hash matches 32a683cd…
  92a0c. D-03/D-09 and D-07/B10 are
  materially more accurate. B3 needs a
  conditional scheduling bound; B8 and
  the Git-facts sentence remain
  inconsistent.

The shared boundary is not literally
the only enrollment mutation function:
exported enrollRun(), unenrollRun() and
reconcileRunEnrollment() remain. The
first two have no production callers;
the third is called through the shared
boundary. This is complete production
adoption, but API visibility does not
enforce it.

## New findings

1. P2: The remaining subprocess timeout
   is cooperative, so it does not
   establish the claimed total bound.

   At cli/src/implement/herdr.ts:116,
   spawnSync receives the remaining
   timeout but uses its default
   termination signal, SIGTERM. A child
   that handles or ignores that signal
   can keep the synchronous call
   blocked.

   I exercised the actual compiled
   adapter, substituting only the
   launched executable with a short-
   lived child that ignores SIGTERM. A
   100 ms requested timeout returned
   after approximately 480 ms, when the
   child exited voluntarily. No real
   Herdr command was invoked.

   Thus the change does more than gate
   calls before they start: it installs
   an in-progress timeout. But that
   timeout currently requests
   termination rather than ensuring it.
   An indefinitely stuck child also
   keeps the executor owner alive,
   excluding subsequent ticks.

   Smallest fix: use non-cooperative
   termination for these deadline-bound
   CLI subprocesses, such as
   killSignal: "SIGKILL", while
   retaining unknown for a timed-out
   prompt. Add a real-child regression
   that ignores SIGTERM and verifies
   bounded termination. Describe the
   25-second value as the execution/
   admission budget, with ordinary
   local cleanup and scheduling
   overhead, rather than an absolute
   wall-clock guarantee.

   This is the remaining part of
   Finding 2, not a new scheduler-state
   requirement. It concerns engineering
   principles 14, own what you start,
   and 15, cap every resource.

No additional confirmed Fix now was
found in recipient reconciliation. The
change adds one fixed-size durable
recipient key, removes the unused
expiresAt field, and introduces no new
unbounded collection. The hash is a
consistency key, not authentication
against a process capable of modifying
run state.

## Contract wording

Amendment 3 is a legitimate correction,
with two remaining qualifications. I
verified its amendment record and that
the current PRD bytes match the sealed
SHA-256:

32a683cd96534479a328cb2b468b3646845dc29
108d43b1c5a542a5a17f92a0c

- D-03 versus D-09: Correctly
  distinguishes a resident daemon from
  a durable executor ownership record.
  Removing the unused expiry field
  makes this distinction clearer.

- D-07/B10 and Risks: Now honestly
  describe the identity note as
  mitigation, distinguish executable
  dispatch packets, and disclaim
  control over a wrong recipient’s
  subsequent behavior.

- B3: Correctly discloses uncertainty
  consumed before submission and
  rejects next-tick delivery
  guarantees. However, its statement
  that recovery delay is bounded by
  tick interval, batch rotation and
  backlog still needs conditions: a
  deliverable Observer, responsive
  dependencies, available delivery
  budget and a runnable executor.
  Without those conditions, delivery
  may remain stopped pending
  intervention.

The unguarded lookup-to-input window
remains between cli/src/supervisor/
tick.ts:545 and :585. Recipient-
generation binding protects local
accounting and stale completions; it
does not make Herdr’s lookup and
submission atomic. The revised
disclosure is honest about that
distinction.

Two previously identified
inconsistencies remain:

1. B8, PRD line 64: Still promises
   delivery on the next tick after a
   working Observer. Change this to
   delivery on a subsequent eligible
   tick, subject to batching and
   delivery policy.

2. Technical structure, PRD line 82:
   Still says the tick collects Git
   log/diff/churn. Those facts belong
   to digest collection, not wake
   admission. The Goal sentence also
   repeats the Git-based tick
   description.

These are small contract corrections
that should land before merge.
Recording them as follow-ups does not
resolve the contradictory guarantees.

The round-three follow-up record (docs/
audits/2026-09-18-observer-supervisor/
reviews/round-3-follow-ups.md:3) and
current PR body accurately distinguish
the native review on 98a70a9 from fixes
and deterministic verification on
55be1ff.

## Follow-up improvements

- Restrict bypass APIs. Make
  unconditional enrollment fixture
  setup test-local, and hide the low-
  level reconciler where practical.
  Principle 13 is better enforced by a
  single accessible production boundary
  than caller discipline.

- Add a wall-clock-jump test.
  Production uses performance.now(),
  which is appropriate. Existing slow
  tests mostly inject one clock for
  both timestamps and elapsed time;
  independently moving them would
  verify the distinction.

- Document legacy migration
  operationally. Recipient-less records
  deliberately stop delivery until
  approved handover or owning recovery
  reconciles them. The fail-closed
  choice is defensible, but upgrades
  can pause previously watched runs.

- Keep historical incidents distinct
  from current health. The earlier
  undelivered-terminal resolution
  concern remains.

- Retain two-store recovery language.
  State and index updates are still
  separate commits. The shared boundary
  makes retries converge; it does not
  supply transactional atomicity or
  exactly-once delivery.

## What was checked

Read and inspected

- The complete 11-file 284e977..55be1ff
  delta, including changed tests, the
  committed round-three report and
  follow-up record.

- Current tick control flow, shared
  reconciliation implementation,
  handover flow, and relevant dispatch/
  recovery and Herdr adapter paths.

- Every enrollment writer under cli/src
  and scripts, using searches for
  enrollment helpers and direct entry
  replacement/insertion.

- Current PRD, amendment/seal records,
  PR body, exact-head verification
  report and its suite log.

- Larger unchanged modules were
  inspected selectively, not rereviewed
  in full.

Commands and results

 Check               Result
━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━
 HEAD / merge-       55be1ff437f79d6e9
 base / worktree     7594c0ccd7a2a72ff
                     b961c9 /
                     46c9f85 / clean
──────────────────  ───────────────────
 git diff --check    Passed
 284e977..55be1ff
──────────────────  ───────────────────
 ./cli/              Passed
 node_modules/.bi
 n/tsc -p cli/
 tsconfig.json
 --noEmit
──────────────────  ───────────────────
 Read-only in-       54 files matched
 memory              cli/dist; zero
 TypeScript emit     diagnostics
 comparison
──────────────────  ───────────────────
 node --test cli/    100 passed, 0
 test/unit/          failed, 0 skipped
 supervisor-*.tes
 t.mjs cli/test/
 e2e/
 supervisor.test.
 mjs
──────────────────  ───────────────────
 node --test cli/    24 passed, 0
 test/e2e/           failed, 0 skipped
