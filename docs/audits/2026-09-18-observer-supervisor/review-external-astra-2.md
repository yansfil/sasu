## Verdict
Do not merge yet. The delta fixes most original
failure cases, and all 91 tests I ran passed.
However, overlapping ticks can still duplicate
delivery and defeat the new retry limit, partial
dispatch has unrecoverable states, revision
pruning can break concurrent readers, and
terminal cleanup can discard a notification
without attempting delivery. The proposed
contract amendments are directionally reasonable,
but they are not all “wording-only”: they change
recovery and notification guarantees. The final
native reviews did not catch the counterexamples
below.
## Item status
“Closed” refers to the original finding, not an
assertion that the entire surrounding subsystem
is defect-free.
Item
1. Independent wake episodes
Status
Partially closed
Evidence with file:line
cli/src/supervisor/index.ts:30; tick.ts:310;
regression at cli/test/unit/supervisor-
tick.test.mjs:367
Remaining gap
Sequential escalation → patrol → settlement now
works. An older overlapping tick can overwrite
a newer acknowledgement. New finding 1.
─────────────────────────────────────────────────
Item
2. Lost concurrent index writes
Status
Partially closed
Evidence with file:line
cli/src/supervisor/
index.ts:179, :197, :204, :216
Remaining gap
Atomic linked revisions fix the original
compare/rename lost update. Operation IDs and
ambiguity handling are substantive
improvements. Concurrent revision pruning
introduces a reader failure. New finding 3.
─────────────────────────────────────────────────
Item
3. Stale tick versus replacement enrollment
Status
Closed
Evidence with file:line
cli/src/supervisor/index.ts:232;
tick.ts:100, :337
Remaining gap
Updates and removals use the exact enrollment
identity. Both original reenrollment
reproductions passed. This does not protect
competing ticks within one enrollment.
─────────────────────────────────────────────────
Item
4. Cached Observer lookup
Status
Closed, within the stated non-atomic model
Evidence with file:line
cli/src/supervisor/tick.ts:251, :273, :304
Remaining gap
Uncached lookup and subsequent enrollment
validation suppress the tested replacements. A
final check-to-submit window remains; see
below.
─────────────────────────────────────────────────
Item
5. Ambiguous digest routing
Status
Closed
Evidence with file:line
cli/src/supervisor/wake.ts:30; cli/src/
implement/commands.ts:1300
Remaining gap
Wake commands identify the absolute state path,
instance and recipient. Digest checks reject
wrong instances and recipients; same-slug
cross-repository coverage is meaningful.
─────────────────────────────────────────────────
Item
6. Implementor identity
Status
Closed
Evidence with file:line
cli/src/supervisor/decide.ts:85; cli/src/
implement/herdr.ts:535; commands.ts:620;
store.ts:303
Remaining gap
Session, terminal, pane and scoped runtime
identity are now recorded and checked; missing
legacy identity fails closed. Session/terminal/
name replacement reproductions passed.
─────────────────────────────────────────────────
Item
7. Rejected versus uncertain delivery
Status
Partially closed
Evidence with file:line
cli/src/implement/herdr.ts:740, :783; cli/src/
supervisor/tick.ts:215, :315
Remaining gap
Pre-start rejection classification and
sequential retry limits work. Concurrent ticks
can reset the persisted attempt count and
submit beyond the limit. New finding 1.
─────────────────────────────────────────────────
Item
8. Dispatch ordering and recovery
Status
Partially closed
Evidence with file:line
cli/src/implement/commands.ts:558, :581, :630;
cli/src/supervisor/commands.ts:149
Remaining gap
Durable phases and final authority validation
substantially improve initial, escalation and
resumed handoffs. Recovery still dead-ends
before supervision exists, or after a started
child disappears. New finding 2.
─────────────────────────────────────────────────
Item
9. Honest health
Status
Closed for the original finding
Evidence with file:line
cli/src/supervisor/commands.ts:87
Remaining gap
Tick age, runtime availability, routing,
parsing and wake failures affect caller-visible
health. Terminal removal can subsequently hide
an undelivered notification among historical
removals.
─────────────────────────────────────────────────
Item
10. Resource bounds
Status
Partially closed
Evidence with file:line
cli/src/supervisor/index.ts:49, :193;
facts.ts:17; tick.ts:57, :115, :151
Remaining gap
Normal index, revision, state-input, log-event
and wake sizes are capped. Crash-orphaned
temporary files have no cleanup bound. There is
no practical total tick deadline or probe
budget; the 50-run limit bounds one prompt, not
the tick.
─────────────────────────────────────────────────
Item
11. LaunchAgent replacement retry
Status
Closed for failed unload
Evidence with file:line
cli/src/supervisor/launchd.ts:133
Remaining gap
Failed bootout preserves the previous plist, so
retry detects the change correctly. This is not
rollback on every failure: successful unload
followed by failed write/bootstrap can still
leave the service stopped.
─────────────────────────────────────────────────
Item
12. Preserve foreign hook commands
Status
Closed
Evidence with file:line
cli/lib/hooks.js:23, :55, :84
Remaining gap
Reconciliation filters nested owned commands
and preserves foreign commands and matcher
metadata. The mixed-matcher test checks the
resulting configuration.
## New findings
1. [P1] Concurrent ticks invalidate
acknowledgement and delivery-budget
guarantees.
Locations: cli/src/supervisor/tick.ts:273,
cli/src/supervisor/tick.ts:308, cli/src/
supervisor/tick.ts:340.
The final reread validates enrollment and
Observer identity, but does not reconcile
current acknowledgements or pending attempts.
Persistence applies values calculated from the
tick’s older snapshot.
Reproduced with the actual index/tick code and
an in-memory filesystem:
- Tick A submits an uncertain wake and pauses
before persistence.
- Two other ticks reach the two-attempt
limit.
- A resumes and writes attempts: 1.
- Another tick submits again: four uncertain
submissions despite a two-attempt limit.
A second reproduction let a newer tick
acknowledge blocked episode 2, then allowed
the older tick to overwrite it with 1. The
next tick sent episode 2 again: three
submissions for two episodes.
Smallest fix: enforce one delivery executor
across scheduled and manually requested ticks,
with manual requests routed through that
executor. If concurrent executors remain
supported, attempts must be atomically
reserved before submission and completion
updates must be conditional on that
reservation. Another reread alone is
insufficient. This is engineering principle
11, retries must converge without repeating
external effects.
2. [P1] The new partial-dispatch state machine
has recovery dead ends.
Locations: cli/src/implement/commands.ts:584,
cli/src/implement/commands.ts:620, cli/src/
implement/commands.ts:640, cli/src/supervisor/
commands.ts:149.
Two cases remain:
- Initial dispatch stops in planned or
prepared, before a supervision record
exists, and its Observer disappears. A
replacement cannot resume because the UUID
differs. Human-approved handover also
refuses because supervision is absent.
- Dispatch reaches started, then the recorded
child disappears. Resume refuses the
missing identity; ordinary dispatch refuses
the pending record. There is no supported
cancellation/reconciliation path for that
partial dispatch.
The in-memory command reproductions returned
these refusals without clearing the pending
record.
Smallest fix: allow explicit human-approved
transfer of pending-dispatch authority from
its first durable phase, and provide a CLI
recovery operation for a positively absent
child. Recovery should idempotently restore
navigation and enrollment prerequisites before
any handoff. Do not require manual JSON edits
or silently adopt a replacement. This
implements principle 10, failures need an
actionable outcome.
3. [P2] Revision pruning races with readers and
can abort an otherwise valid tick.
Locations: cli/src/supervisor/index.ts:137,
cli/src/supervisor/index.ts:164.
readSource() selects the newest filename, then
separately stats and reads it. Another writer
can advance and prune that selected revision
meanwhile.
I paused a reader after selection and advanced
five writes. It threw ENOENT for revision 1
although the current index remained valid. If
this happens during final persistence after a
prompt, the submission is left unacknowledged
and can repeat.
Smallest fix: open and read the selected
immutable revision through one descriptor,
with bounded fresh-head retry when opening a
concurrently pruned revision returns ENOENT.
Add a reader-versus-pruner regression, not
just competing-writer tests.
4. [P2] Terminal cleanup counts normal Observer
busyness as failed notification.
Locations: cli/src/supervisor/tick.ts:140,
cli/src/supervisor/tick.ts:207, cli/src/
supervisor/tick.ts:264.
A retired run whose Observer remains working
is removed after three observations. My
reproduction produced deferred, deferred,
removed, with zero prompts.
This contradicts B8’s deferred delivery and is
stronger than the proposed wording that
notification is “attempted for three ticks.”
Smallest fix: do not consume a failed-delivery
budget for ordinary working/blocked deferral.
If abandonment while busy is intentional,
obtain explicit approval for that separate
policy and expose an undelivered-terminal
outcome prominently.
## Contract wording
1. D-05/D-09: approve the architectural
direction, but describe a real contract
change.
A fresh process every 30 seconds cannot
provide useful cross-tick process-memory
backoff. Durable, bounded scheduler metadata
is appropriate. It remains distinct from run
authority, and the tick still does not write
state.json.
However, acknowledgements, uncertain-delivery
attempts, enrollment generations, failure
counters and revision-operation history
constitute a small persistent scheduler.
Calling this a path-only index or wholly
stateless recovery is inaccurate. Restart
reconstructs decisions from that metadata;
losing it changes behavior. A crash after
submission but before persistence can repeat
input. B3’s “only one tick of delay is lost”
also needs qualification.
2. B15: approve retired as the actual lifecycle,
but reject the proposed retry wording as
sufficient.
Removing obsolete schema states is sound.
Bounded unsuccessful terminal notification can
also be a reasonable product decision. The
code currently bounds observations without
successful delivery, including normal
busyness, rather than notification attempts.
That difference needs resolution, not a
wording amendment presented as behavior-
neutral.
3. D-04: approve the staged ordering, after
closing recovery gaps.
Persisting intent before pane creation, the
prepared pane before child start, and exact
child identity before executable handoff is a
practical contract. It acknowledges which
identities only become available after
creation/start.
--resume-handoff is a sensible recovery
interface, but the contract must cover every
durable phase and absent-child outcome. It
should also disclose that explicitly retrying
an uncertain handoff may repeat executable
work; this is more consequential than
repeating an identity-note wake.
The PR body’s statement that all three are
“wording-only human decisions” is too strong.
## Follow-up improvements
1. Keep launchd, but simplify delivery ownership
before making this universal.
A periodic process remains a reasonable
alternative to a resident daemon. The
difficult part is now persistent delivery
coordination, not timer management. The Stop
hook’s kickstart is compatible with launchd
ownership; independently invoked ticks
undermine that ownership. Fixing this
centrally is preferable to adding more
compensating counters.
2. State the remaining security guarantee
narrowly.
The fresh Observer lookup at tick.ts:251 is
followed by index/state reads and payload
construction before submission at :304.
Replacement remains possible during that
interval. Receiver-side guarded submission is
the only way to make the identity check and
submission atomic.
Exact digest targeting substantially limits a
misdelivered wake: a normal wrong recipient is
refused by the CLI. It does not prove that an
arbitrary receiving model takes zero other
actions. Full initial/resumed handoff packets
do not have the identity-note-only mitigation.
The Security review is right to retain this
risk.
3. Bound elapsed work and memory, not just record
counts.
All runs are evaluated before bundles are
sent. Many slow socket lookups can delay
healthy runs far beyond 30 seconds. Up to
1,024 parsed states are retained, each
admitted up to 8 MiB. Add a practical tick
budget, fair continuation policy, and crash-
orphan cleanup. This follows principle 15, cap
every growing resource.
4. Document stall/patrol limitations explicitly.
Herdr’s measured activity token describes
lifecycle changes, not continuous tool
progress. A working agent without run events
can therefore produce a false stall. Sleep or
a forward wall-clock jump makes thresholds
immediately due; backward jumps delay them.
Skipping missed patrol buckets is reasonable,
but “Observer last looked” currently means
accepted wake submission, not confirmed digest
inspection.
5. Treat recorded paths and routing fields as
trusted authority inputs.
The tick still does not execute repository Git
content. Argv arrays and quoted digest
arguments avoid shell interpolation. However,
recorded hostScope now selects the socket used
by unattended Herdr calls, and recorded
strings reach model-visible wake text.
Structural string validation is not an
authorization or prompt-injection boundary.
Pin executable paths or use a controlled PATH
instead of inheriting the installer’s entire
PATH. Strengthen nested index validation.
Prepared-pane cleanup also deserves an
incarnation/ownership check:
closePreparedSpawn() currently proves shell
emptiness, not that today’s shell is the
originally created terminal.
6. Preserve honest operational evidence.
Final-head live bootstrap, Stop-hook and real
dispatch/recovery flows remain unrun. The PR
now says so correctly. Earlier smoke evidence
is useful, but does not validate the new
recovery protocol. Hook reconciliation is
improved; basename-substring ownership and
whole-file settings rewrites remain future
hardening opportunities.
## What was checked
Read fully: the c15c6f9..3c88f6f delta, all
supervisor source modules, cli/lib/hooks.js, the
supervisor unit/e2e tests and their fake-runtime
helpers, the preserved external review, PR
disposition/contract text, and the approved PRD
from the main checkout. I also reread the audit
README, live-smoke report and Herdr measurements.
Read changed sections and relevant surrounding
code: cli/src/implement/
{commands,herdr,dispatch,store,types}.ts, cli/
src/cli.ts, dispatch/escalation tests and the
other changed tests. Unrelated portions of these
larger files were not rereviewed in full.
Historical native reports were inspected as
historical evidence; their PASS conclusions were
not treated as proof for this head.
Commands and results:
- Confirmed head 3c88f6f, merge-base 46c9f85, and
clean worktree.
- git diff --check c15c6f9..3c88f6f: passed.
- ./cli/node_modules/.bin/tsc -p cli/
tsconfig.json --noEmit: passed.
- In-memory TypeScript emission comparison: 54
generated files matched existing dist; zero
diagnostics. No build files were written.
- node --test cli/test/unit/supervisor-*.test.mjs
cli/test/e2e/supervisor.test.mjs: 72 passed, 0
failed, 0 skipped.
- Focused D-04|B2|mixed matchers tests across
dispatch, escalation, Herdr and hooks: 19
passed, 0 failed.
- Full repository suites were not rerun.
Original reproductions rerun: items 1, 2, 3, 6
and 7 passed their original sequential/
interleaving cases. Additional in-memory probes
exposed acknowledgement regression, retry-budget
reset, revision-reader pruning failure, partial-
dispatch recovery refusals, and terminal removal
without submission. These exercised actual
compiled modules with injected filesystem/runtime
boundaries; they were not live-runtime
reproductions.
Regression-test spot checks:
- Item 1: supervisor-tick.test.mjs:367 asserts
escalation, patrol, settlement, subsequent
silence and exactly three prompts. It would
catch the original episode interference.
- Item 2: supervisor-index.test.mjs:52
interleaves enrollment at the commit boundary
and asserts both entries survive. It targets
the original lost-update window.
- Item 4: supervisor-tick.test.mjs:87 replaces
the Observer between lookups and asserts zero
prompts plus stale routing. It catches cached
targeting.
- Item 7: supervisor-herdr.test.mjs:57 checks
definite pre-start rejection; supervisor-
tick.test.mjs:349 counts submissions across
uncertain/rejected outcomes. These are
meaningful. The adjacent test at :336 only
asserts repeated "failed" outcomes and would
not alone prove that retries stop. None covers
overlapping ticks.
No source edits, commits, real installer/service
operations, or Herdr pane input were performed.
