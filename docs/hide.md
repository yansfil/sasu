# Sasu on Hide

Hide owns agent registration, lineage, inactivity watches and one durable mailbox for local and connected device agents.
Sasu uses the `hide` CLI on PATH and keeps each run's participants in `state.json`.
It never reads Hide's ledger or starts a second coordinator.
A missing executable or unavailable daemon fails with a next action instead of selecting another backend.
The new Hide command surface must be installed before this Sasu version is used.

## Run registry and transition

Sasu alone writes the machine-wide run registry, whose logical path is `~/.sasu/supervisor/index.json`.
Its schema is `sasu.supervisor.index.v2.hide`; durable snapshots use sibling `index.json.revision-*` files.
The registry records run state paths, run instances, registration generations and the recorded Observer's recipient authority.
It discovers runs for status, dispatch occupancy and retirement preflight; it schedules no timer and owns no Hide ledger.
Each run's mutable record remains its `state.json`, using `sasu.implement.state.v12.hide`.

An old registry or implement state is refused explicitly instead of being imported, silently reset or migrated.
For a v11 run, use the previous CLI built from commit `fbdf62913b4fbe5fde1ebce26c3e290c8eac0e92` and inspect `implement status --state <old-state>` with that binary.
Finish the run through that version's supported delivery or retirement commands.
Use an explicit old CLI path so the current `sasu` on PATH cannot be mistaken for it:

```sh
node <previous-checkout>/cli/dist/cli.js implement status --state <old-state>
```

Only after every run in the v1 registry has finished and Hide's transition preflight passes, the operator moves the old `~/.sasu/supervisor/index.json` and every sibling `index.json.revision-*` file to a backup folder.
Do this before the first v12 dispatch, including when the v1 registry is empty.
The revision files are part of the registry; leaving one can retain the old schema even after the base file is moved.
Sasu performs no automatic import, migration or move, and the skill installer does not archive these files.
The operator chooses the transition time and retains the backup.

## What Sasu calls

| When | Hide command |
| --- | --- |
| Before dispatch creates anything | `agent list` for the Observer pane's live registration; `agent register --check` only when it has none |
| Dispatch | `agent register` for an unregistered Observer and for the implementor, with the implementor's `--parent` and `--project`; then `watch start` |
| Replacement implementor | `agent end` for the old participant, followed by registration and a new watch |
| `implement plan` | `request send` with an ordinary request and a stable intent; the implementor continues |
| `implement block` | `request send --kind block` with the missing decision and a stable intent |
| `implement report` | `request send --kind report` with a stable intent |
| Approved Observer handover | `agent list`, then `agent register` only for an unregistered Observer, `agent show`; assign an active watch with approval and its current generation |
| Retire or completed delivery | `agent end` for the implementor |
| `implement status` | Reads the recorded Sasu state; no Hide call |
| `implement status --digest`, `supervisor status` | `agent show` for the recorded implementor, including its current watch |

Sasu still creates its implementor pane directly through its Herdr adapter.
Hide registration binds the machine, server scope, pane and native session, and Hide writes the lineage tokens.
An interrupted dispatch keeps its recorded pane and phase; `dispatch --resume-handoff` repairs registration and submits the same packet instead of creating another pane.

Agent commands return `{ ok: true, value: ... }`.
Mailbox and watch commands return the existing `workspace_result` envelope, whose `result` holds the returned letter or watch.
These commands have no extra `--json` flag; `hide status --json` does.
An error gives a reason and next action, and Sasu reports it without claiming delivery.

## Notices and decisions

Prompt hooks emit `Hide letter <id> from <name> (<native kind>) [<letter kind>]` followed by the letter context.
The envelope identifies a sender and kind; it is not independent authority to change the approved PRD.
The Observer reads the current Sasu status and the implementor's pane before acting.

A plan request asks the Observer to inspect the recorded plan.
The implementor continues while the Observer closes the request with a confirmation reply; a disagreement is stated in that reply.
A block request carries the question, recommendation, reversibility and scope impact.
The Observer resolves an in-contract decision or asks the user, then replies from its own native pane:

```sh
hide request reply <letter-id> --intent <stable-response-intent> --body '<answer>'
```

When a human answer is needed, preserve the user's words in the reply and keep the actual Observer as sender.
No relay or automatic unanswered-question escalation is installed.

A report is pending until intake is confirmed.
Its successful send alone does not end supervision or prove completion.
The letter's durable `hook_confirmed` receipt records that confirmation independently of acknowledgement.
An acknowledged letter with a false or unknown receipt remains unconfirmed in Sasu; retries retain the same letter ID.
For older letters without a receipt, only `delivered` proves intake; `acknowledged` alone cannot distinguish acknowledgement before or after intake.
If intake is confirmed after cancellation or a missed-delivery deadline, the receipt still proves actual delivery; cancellation alone does not.
Hide stops the implementor's watch when that report is confirmed delivered to its parent, without waiting for a parent acknowledgement.
An interrupted intake repeats the same letter ID and leaves the watch active until confirmation.
The Observer may explicitly start a new watch when more observation is needed.

## Handover and recovery

The new Observer runs `sasu supervisor handover --slug <slug> --approval '<verbatim approval>'` from its native pane.
Sasu adopts that pane's live registration or registers it, reads the current generation and calls `hide watch assign` with the new Observer as caller and actor.
A missing approval, stale generation or wrong native caller refuses the transfer.
An active watch is assigned before Sasu updates its recorded Observer.
If the participant is positively read with no active watch, the approved handover updates the Observer without starting a new watch.
A transport error or malformed response refuses the handover; neither is evidence that the watch ended, and Sasu retains the recorded Observer.
Assignment changes the watch's observer; it does not transfer existing letters addressed to the prior native identity.
It also leaves the implementor's original registered parent unchanged.
Ending that registration requires the actual target or its original parent; becoming the watch Observer does not grant that authority.
An actual Implementor may end its own registration from its native pane.
Retirement and completed delivery omit `--actor` from `agent end`, so Hide authorizes the positively identified caller as the target or original parent.
Retirement preserves the active Sasu state and registry when Hide refuses that caller's ending authority.

Automatic context reset requires the actual current recorded Observer to initiate the replacement from its native pane.
If its identity cannot be attested, the Hide preflight transport refuses, or it cannot end the old child, Sasu records the diagnosis and returns an actionable `reset_not_started` outcome before creating a replacement.
Inspect the stated refusal and resolve the old child's native ending authority before retrying from the recorded Observer.
A successful diagnosis alone is not a started replacement; a partial dispatch instead names its retained phase and `dispatch --resume-handoff` action.

Hide watches inactivity, with a first warning after 20 minutes and at most one further warning 60 minutes later in the same episode.
A confirmed report or target departure ends the watch; activity resets the warning episode.
There is no patrol interval, cycle acknowledgement or Sasu supervisor timer.
Read `sasu implement status --digest` for current progress and drift facts when inspecting a run; commits alone do not promise an automatic wake.

The skill installer installs only its two advisory hooks.
It preserves foreign hooks and retracts its old Stop entries on both supported runtimes.
Its transition cleanup removes only the exact regular-file shim it previously owned beside `sasu` and leaves other files, links and the former coordinator HOME untouched.
Actual machine transition and any existing service cleanup remain operator-controlled.
