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
`dispatch` prints the complete `hide agent spawn --parent here` command and writes the handoff file.
The Observer executes that command directly; the first native prompt references the file.
Retry the same command and intent after an interrupted response to recover the same child.
Sasu does not inspect startup-screen text, create panes, register participants, or run a second supervisor.

Use `hide inbox`, `hide request send`, and `hide request reply` directly.
Use a request letter for plans, a block letter for a missing decision, and a report letter for results.
Hide owns delivery confirmation and inactivity watches.
A confirmed letter is not a verification verdict.

## Identity and authority

Sasu does not persist session IDs, terminal IDs, participant IDs or watch IDs.
Run-owned launch requests record intent and requested arguments so retries converge.
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
