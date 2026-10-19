# Sasu and Hide

Sasu owns the approved contract, sealed suites, collected evidence and deterministic verdict.
Hide owns agent startup, worktrees, parent relationships, watches and letters.

```text
Observer seals contract -> Sasu prints handoff -> Observer runs hide agent spawn
  -> Implementor commits and verifies -> Hide report letter -> Observer reviews and delivers
```

## Start and communicate

Choose the product checkout and approve the PRD before `sasu implement start`.
`start` seals the current checkout and its required suites.
`dispatch` prints the complete `hide agent spawn --parent here --review-policy observer-30m` command and writes the handoff file.
The Observer executes that command directly; the first native prompt references the file.
Retry the same command and intent after an interrupted response to recover the same child.
Sasu does not inspect startup-screen text, create panes, register participants, or run a second supervisor.

Use `hide inbox`, `hide request send`, and `hide request reply` directly.
Use a request letter for plans, a block letter for a missing decision, and a report letter for results.
Hide owns delivery confirmation and inactivity watches.
A confirmed letter is not a verification verdict.

## Periodic Observer review

The Implementor's watch requests its first review after 30 minutes, independently of child input, output, commits, tests and progress letters.
Hide delivers it to the designated Observer through the existing inbox and wake path, keeps at most one outstanding request and persists it across restart.
The Observer uses the complete PRD and execution plan as its baseline, reusing unchanged context and the last actual review.
Inspect new changes, results and failures first; read the full baseline only when it is missing or changed.
Keep this periodic inspection proportional to the new work, including completed results, remaining work and actual verification history.
It adds no full-suite or independent review stage, and final independent full-contract reviews remain required.
Separate implementation time from build/CI waiting and rework before judging duration.
Check whether each task serves the contract or a necessary prerequisite, whether a smaller solution meets it, and whether unrelated scope, refactoring or abstraction has accumulated.
Repeated fixes or full-suite runs need new evidence; reproduce and diagnose a failure before repeating the same approach.
Keep mandatory verification and necessary regression fixes.

Complete the specific review letter explicitly:

```sh
hide request reply <review-letter> --review <assessment> --intent <stable-key> \
  --body '<one-line grounds; concrete next direction when needed>'
```

Choose `scope-appropriate`, `delay-justified`, `reduce-scope` or `diagnosis-needed`.
The designated Observer supplies the conclusion and grounds, including one concrete next action and the scope to reduce when intervention is needed.
New product decisions or missing authority go to the user.
Inbox receipt, ack, an ordinary reply and a progress letter do not complete a periodic review or start the next cycle.
The explicit accepted review starts the next 30 minutes; report confirmation, target departure and explicit watch stop end the existing watch and periodic scheduling together.
Inactivity alerts and block forwarding remain active, and advisors and other delegations do not opt into this policy.
Sasu keeps no periodic scheduler, semantic verdict or live runtime identity.

## Identity and authority

Sasu does not persist session IDs, terminal IDs, participant IDs or watch IDs.
Run-owned launch requests record intent and requested arguments so retries converge.
New Implementor reservations include the periodic review policy; older reservations without it replay their original arguments and retain the existing watch behavior.
Role restrictions consult the live Hide registration and the run child's parent relationship.
An Observer spawned by a lead remains the run child's parent.
Terminal handoff and compaction change no Sasu ownership record.
A verification lease still protects deterministic state from simultaneous mutations.

## Advisor

`escalate --intent <key> --reason <problem>` reserves an advisor request and prints its spawn command.
The Observer runs it, and the advisor returns a Hide report letter.
Retrying the same intent does not consume another request.
After three distinct advisor requests, the next decision belongs to a human.
No hidden solver process or automatic context reset remains.

## Transition and tests

Finish old runs with their matching CLI before updating the installation.
The new schema rejects old identity-bearing records; no silent migration changes an active run.
The installer does not install, query or modify a coordination daemon or LaunchAgent.
No test addresses the operator's running installation.
Boundary tests use a private fake CLI, while native tests name an explicit candidate and own their HOME, state directory, server and child processes.
