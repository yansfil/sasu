• ## Verdict
Do not merge. A short, launchd-
managed tick is a reasonable
replacement for the one-shot
waiter, and the separation between
deterministic observation and
Observer judgment is sound.
However, this implementation can
silently lose enrollments, suppress
necessary wakes, repeatedly wake an
unchanged run, and inspect or
prompt using stale identities.
Several of these failures were
reproduced with read-only, in-
memory probes. The current tests
and live smoke establish useful
happy-path behavior, but do not
support the stronger recovery and
isolation guarantees claimed.
## Fix now
1. [P1] Wake deduplication causes
both perpetual wakes and
permanently suppressed patrols.
cli/src/supervisor/
decide.ts:96,126,143; cli/src/
supervisor/tick.ts:188
Every historical escalation
remains a candidate, while
lastWake remembers only the
reasons sent most recently.
Reproduced sequence: escalation
wakes once; a working
Implementor receives no patrol
even after 30 minutes; when it
settles, subsequent ticks
alternate settled → escalate →
settled → escalate indefinitely.
Each wake forgets the other
answered reason.
Smallest fix: retain bounded,
per-reason episode
acknowledgments for the current
enrollment, and determine patrol
eligibility after filtering
answered reasons. Add a sequence
test covering escalation,
resumed work, patrol, and
settlement.
2. [P1] The index update is not an
atomic compare-and-swap.
cli/src/supervisor/index.ts:121–
126
Two writers can both validate
the same old bytes, then
independently rename their
replacements. The later rename
discards the earlier enrollment.
I reproduced an enrollment of /b
disappearing when it landed
after another writer’s
comparison. The existing
concurrency test interleaves
before the comparison, so it
misses this window.
Smallest fix: replace the shared
read-modify-write operation with
a genuinely serialized or
transactional update mechanism.
Under the no-lock-file
constraint, independently keyed
enrollment records are an
alternative. Another pre-rename
comparison does not solve this.
3. [P1] An old tick overwrites a
new enrollment or handover.
cli/src/supervisor/tick.ts:190–
206
Updates and removals are keyed
only by statePath. If dispatch
or handover re-enrolls that path
during a tick, the old tick
applies its previous Observer’s
wake acknowledgment to the new
entry. A pending removal can
also delete the replacement
entry. In-memory reproduction
attached the old blocked:1
acknowledgment to instance new;
an old terminal decision removed
the replacement entirely.
Smallest fix: condition updates
and removals on the exact
enrollment observed, including
run instance and Observer
identity/enrollment revision.
runInstanceId alone is
insufficient because handover
preserves it.
4. [P1] Observer identity is not
checked immediately before
transmission.
cli/src/supervisor/tick.ts:107–
116,145,179–186
The tick caches identity while
scanning runs, then sends only
after all scans finish. Other
lookups can each consume 15
seconds. An Observer can be
replaced during that interval
and the unguarded prompt still
goes to its pane. The final
observer.kind !== "match" check
merely rechecks the cached
verdict.
Smallest fix: perform an
uncached identity and readiness
lookup immediately before each
bundle is sent, validating the
current enrollment too. Use the
newly returned guard when
available. This narrows the
unguarded race; only receiver-
side guarded submission can
close it.
5. [P1] The wake’s digest command
does not identify the run it
names.
cli/src/supervisor/wake.ts:24;
cli/src/implement/
commands.ts:1110–1118
The message contains an instance
ID, but its executable
instruction contains only
--slug. Two repositories or
worktrees with the same slug
produce identical inspection
commands. The Observer can
inspect its local run instead of
the notified run. A wrong-
session recipient that owns
another local run with that slug
can also pass the ownership
check, contradicting the blanket
refusal claim.
Smallest fix: provide an exact,
safely quoted record locator and
require the expected run-
instance and Observer UUID
during digest resolution. Test
one Observer watching same-slug
runs in different repositories
and a wrong recipient owning a
same-slug run.
6. [P1] Implementor identity does
not implement D-06.
cli/src/supervisor/decide.ts:85–
92; cli/src/implement/
types.ts:282; cli/src/implement/
commands.ts:720,748
Only pane and optional name are
checked. An unnamed replacement,
or one reusing the dispatched
name, is treated as the original
Implementor regardless of
session UUID or terminal ID. I
reproduced a different session
and terminal being classified as
present/working. Additionally,
escalation mints its replacement
instance ID after spawning,
without passing it into the
replacement environment.
Smallest fix: capture and
compare the Implementor’s
session and terminal identity,
and mint/pass the instance ID on
every spawn path. Require that
ID when claiming a supervised
run; the current carried !== ""
condition allows missing IDs to
bypass the check.
7. [P1] A definitively unsent wake
can become permanently
acknowledged.
cli/src/implement/herdr.ts:115–
118,669–672; cli/src/supervisor/
decide.ts:96–98; cli/src/
supervisor/tick.ts:195–196
All spawn errors become status:
null, then unknown. Reproduced
ENOENT becomes
herdr_prompt_timeout, even
though no process submitted
anything. An unknown result
suppresses that episode
indefinitely; for a terminal run
it removes the entry. A real
timeout before submission has
the same lost-wake outcome.
Smallest fix: preserve
structured process-error
information and classify
definite pre-submission failures
as retryable failures. Give
genuinely uncertain delivery an
explicit recovery policy instead
of treating it as
acknowledgment. Do not label it
sent or remove terminal
enrollment on that basis.
8. [P1] The child receives work
before durable supervision
exists.
cli/src/implement/
commands.ts:572–609
dispatchImplementor starts the
agent and submits its handoff
before recordDispatch and
enrollment. Killing the parent
in that gap leaves an active
Implementor absent from the
index, so no future tick
discovers it. A fast child can
also encounter the previous
ownership record. The catch
message cannot help after
process death and its suggestion
to “record it by hand”
contradicts CLI-only state
ownership.
Smallest fix: separate pane
preparation from work
submission. Persist identity,
ownership/navigation, and
enrollment before handing over
executable work; provide a CLI
recovery path for partial
dispatch.
9. [P2] Health reporting can call a
nonfunctioning supervisor
healthy.
cli/src/supervisor/
commands.ts:81,92–98
ok ignores tick age, Herdr
availability, observer
disappearance, parsing failures,
and rejected wakes. A loaded
label with yesterday’s last tick
qualifies as healthy. status
also returns success regardless
of view.ok. This recreates the
silent-unwatched problem at the
diagnostic surface.
Smallest fix: derive health from
recent successful observation
and unresolved routing failures,
expose it consistently to status
and doctor, and distinguish
historical failures from current
failures. Apply engineering
principle 10, “Route every
failure to an outcome its caller
can act on.”
10. [P2] The permanent scheduler
has unbounded output and work.
cli/src/supervisor/
launchd.ts:57–60; cli/src/
supervisor/tick.ts:62–69; cli/
src/supervisor/index.ts:119
launchd.log receives CLI output
every tick and has no rotation.
Only removal history is capped;
active, corrupt, and
indefinitely undeliverable
entries can accumulate without
limit. Rotation failures for the
other logs are swallowed and
appending continues.
Smallest fix: bound every log
sink, enrollment count, input
size, and tick workload; report
limit/rotation failures
explicitly. This is required by
engineering principle 15, “Cap
every resource that grows with
use.”
11. [P2] A failed LaunchAgent
update does not converge on
retry.
cli/src/supervisor/
launchd.ts:127–144
The new plist is written before
unloading the old definition. If
bootout fails, the next install
sees matching disk bytes and a
loaded label, then reports
convergence without replacing
the old loaded definition.
Smallest fix: unload before
replacing the persisted
definition, or restore the
previous bytes on failure and
verify the loaded definition on
retry. Add a failed-update-then-
retry test.
12. [P2] Hook removal can delete
foreign hooks.
cli/lib/hooks.js:16–18,73–78
Ownership of one nested hook
marks the entire matcher as
owned. A matcher containing both
supervisor_stop.mjs and a
foreign command is deleted
wholesale during uninstall;
reconciliation has the same
behavior. Tests cover foreign
hooks in separate matchers only.
Smallest fix: filter owned
commands within each matcher,
preserving foreign commands,
matcher metadata, and order.
Remove the matcher only when it
becomes empty.
## Architecture concerns
1. Keep the periodic process, but
describe its state honestly.
StartInterval avoids maintaining
another resident daemon and fits
this workload. Nevertheless,
lastWake.episode, lastWake.at,
missingTicks, and enrollment
membership are behavioral state,
not merely diagnostic facts.
Losing the index loses all
discovery; corrupting it stops
all runs; an incorrect
acknowledgment changes future
decisions. “Restart equals
recovery” holds only with a
valid, complete index and
correct acknowledgment
semantics. Explicitly document
this small persistent scheduler
state and its repair model.
Durable suppression is a
defensible deviation from D-09’s
impossible inter-tick process
memory, but requires a contract
correction.
2. launchd single-instance
protection has a narrower scope
than claimed.
It covers the managed label, not
manually invoked sasu supervisor
tick processes. Two manual
ticks, or a manual tick
alongside launchd, can both send
before either records its wake.
The ordinary Stop hook only
requests launchd execution and
does not write run state, which
is good. Its bootstrap path can
still race installation or
another bootstrap attempt. Route
operational “tick now” requests
through the managed scheduler,
and make lifecycle
reconciliation retry-safe.
3. Identity is an observation, not
an atomic delivery guarantee.
Session UUID plus terminal ID is
a useful fail-closed check
within the correct Herdr server.
It does not close get-then-
prompt TOCTOU. hostScope is
stored but never used for
routing or validation; the
LaunchAgent receives only HOME
and PATH. Reject unsupported
server scopes or route lookups
and prompts through the recorded
socket. Terminal rotation on
server restart deliberately
suspends every affected run;
explicit handover is reasonable
for safety, but needs prominent
degraded-health reporting. The
live stranger test proves one
primed session obeyed the digest
refusal, not universal “zero
actions” by arbitrary
recipients.
4. Timing guarantees need to
account for sleep, clock
changes, and slow subprocesses.
The installed launchd.plist(5)
documentation says StartInterval
firings are missed while asleep
or while the job is already
running. The implementation’s
wall-clock subtraction counts
sleep as silence, permits
forward jumps to trigger early
wakes, and lets backward jumps
postpone wakes. A lifecycle-age
threshold is also different from
observing two consecutive ticks.
Define these semantics
explicitly and test them. Bound
total tick duration and ensure
child termination is effective:
Node documents that spawnSync
can remain blocked after timeout
if the child handles SIGTERM
without exiting. Node child-
process documentation
5. The trust boundary includes
writable run metadata and
executable resolution.
The tick itself does not execute
Git commands or repository
scripts, and argv arrays avoid
shell interpolation in its Herdr
calls. Those are useful
boundaries. However, writable
state controls target fields and
text inserted into a model-
facing prompt; string validation
does not constrain UUIDs, pane
IDs, slugs, newlines, or
lengths. The digest additionally
reads Git subjects and
filesystem content. Treat these
as data, validate identifiers,
quote inspection arguments, and
bound reads. Persisting the
installer’s entire PATH also
grants every included executable
location continuing influence
over unattended execution. Pin
required executable paths and a
controlled environment before
making this universal.
6. Several contract differences
need explicit resolution.
D-04’s pre-child recording and
D-06’s Implementor identity
checks are missing, as detailed
above. B15 names completion and
blocked terminal states, while
the current schema supports only
active and retired; retired
entries also remain indefinitely
when their Observer cannot
receive the terminal wake.
Define cleanup using the
repository’s current lifecycle
without resurrecting completion
machinery. Moving Git collection
out of ticks and into digest is
a sensible simplification.
Restricting digest to the
Observer and withholding wakes
after terminal rotation are also
reasonable, with the limitations
above. The unrun real-launchd
and live Stop-hook checks remain
deployment evidence gaps, not
verified deviations.
## Follow-up improvements
- Strengthen sequence and
concurrency tests. The decision
tests have useful threshold
coverage, but omit interacting
reasons. The index test cannot
catch a write after its final
comparison. The kill test uses
random timing, does not assert
its advertised upper bound on
duplicates, and can miss the
temporary-file window. Use
deterministic barriers and assert
eventual delivery, preserved
enrollment, and absence of wrong-
session input.
- Correct digest terminology and
scope. digest.ts:81 measures net
diff, not cumulative churn; add-
then-revert work disappears.
verifyFacts includes attempts
preceding redispatch. “Observer
last looked” actually means last
accepted/unknown submission.
Rename these facts or implement
the promised measurements.
- Finish schema validation.
assertIndex casts lastWake,
lastObservation, lastFailure, and
removal records without
validating their fields.
Malformed metadata can break
status/doctor while superficially
passing index validation. Report
the precise malformed entry.
- Handle abandoned temporary files.
A kill between writeFileSync and
renameSync leaves .tmp files; the
current assertion that kills
leave none is unsupported by the
implementation.
- Remove obsolete remnants.
DEFAULT_PATROL_INTERVAL_MS is
imported but unused in
implementation commands.
eventsSince has lost its
production consumer with waiter
removal and is now retained only
by a test.
- Before default rollout, obtain
actual lifecycle evidence. Verify
fresh installation, periodic
execution, failed update
recovery, sleep/resume, and both
runtime Stop hooks in an
explicitly authorized disposable
environment. In particular,
verify creation of the log parent
directory before launchd opens
its output paths.
## What was checked
- Revision: HEAD is
c15c6f96c3817f983df7bcef584ba67b0
206a1d1; merge-base with main is
46c9f85f81125032d93fa1c0e572711eb
d2cd3d1. Working tree remained
clean.
- Read in full: repository
AGENTS.md; all 16 PRD Decisions
and 20 Behaviors; every cli/src/
supervisor/*.ts file; changed
implementation/CLI/store/type/
adapter hunks; hook library and
Stop script; installer diff;
changed workflow documentation;
all five supervisor unit-test
files, supervisor e2e file, and
its new helpers; deleted waiter
implementation/tests; audit
README, live-smoke report, Herdr
measurements, and all committed
review reports.
- PRD location: absent from this
worktree. Read the main checkout
copy and verified it matches the
sealed run copy and recorded SHA-
256 6c563f91…637f3c.
- Skimmed: historical suite logs,
remaining installer/dispatch test
context, recorded PR body, and
raw smoke artifacts.
Independently verified all 61
audit checksums.
- Executed: node --test cli/test/
unit/supervisor-decide.test.mjs
cli/test/unit/supervisor-
herdr.test.mjs: 26 passed. These
include read-only Herdr version/
help/unowned-target queries.
- Executed: tsc -p tsconfig.json
--noEmit from cli/: passed. An
in-memory compiler emission
matched all 54 existing build
outputs, without writing them. An
initial custom compiler
invocation from the repository
root had type-resolution errors;
the correctly rooted checks
passed.
- Reproduced in memory: escalation/
patrol suppression, alternating
duplicate wakes, replacement
Implementor acceptance, ENOENT
misclassification, lost
concurrent enrollment, and stale
tick updates/removals affecting
replacement enrollment.
- Not executed: installers, launchd
operations, live prompts,
mutation tests, or the complete
repository/e2e suites. No files
were edited or committed, and no
input was sent to any Herdr pane.
