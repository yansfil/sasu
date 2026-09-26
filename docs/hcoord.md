# hcoord coordinator

`hcoord` keeps agent relationships, watch cycles, requests, delivery attempts, and human answers in one local ledger.
It knows participants and the relations between them (parent, watch, request) and nothing else.
Herdr remains the source of execution facts, and a client that coordinates its own units of work, such as a Sasu run, records which participants make up a unit in its own state.
The CLI and JSON API expose the same coordinator facts.

## Start and inspect

Build with `npm --prefix cli run build` and invoke `node cli/dist/hcoord/cli.js` or the installed `hcoord` binary.
On macOS, `hcoord daemon start` installs a user LaunchAgent that starts at login and restarts the daemon after a crash, and `hcoord daemon stop` marks the current user session manually stopped so it stays stopped.
`hcoord daemon status --json` shows actual feature support, remote setup, usage, and the last stored snapshot when the daemon is down.
Every write (register, spawn, watch, request, and config changes) is first saved as a versioned letter in this machine's outbox under `~/.hcoord/outbox`.
A running daemon applies it at once and the command prints the same result as before, with `"delivery": "delivered"` in JSON output.
A stopped or busy daemon leaves the letter waiting: the command succeeds with `"delivery": "pending"`, and the daemon applies waiting letters in order when it runs again.
The daemon records a letter and its effect in one ledger save before deleting it, so a crash never applies a letter twice.
A letter of an unknown version stays in the outbox and appears in `hcoord inbox` with its reason; a refusal of a letter nobody was waiting on appears there too.
A down daemon still permits marked stale reads.
If the daemon exits unexpectedly three times within ten minutes, or a start does not answer on its socket within a minute, one Herdr notification is sent and every hcoord command prints a warning with the log paths on stderr before its output.
The warning clears after ten minutes of continuous readiness without a restart.
The daemon stores a private ledger and user socket under `~/.hcoord`, writes the ledger atomically, and rejects requests when finite caps are reached.
An agent runtime must allow access to that user-local socket; `permission_denied` identifies a sandbox or filesystem access refusal and asks the caller to permit the connection before retrying.
The service reserves an unknown outcome before sending external input and never blindly repeats such submissions after a restart.

Register an existing exact Herdr pane with `hcoord agent register --machine local --session <session> --instance <terminal-id> --pane <pane-id> --name <name>`.
`agent register --check` with the same arguments answers what registration would decide and saves nothing: the execution in the pane, the participant it would return (or none), and whether official delivery to it is available.
A client runs it before creating anything that depends on that participant.
A participant is the execution on one machine, pane, and session.
Its terminal id and name are recorded but never required to match, because a Herdr restart gives every pane a new terminal id and clears names while panes and sessions stay; registering the same pane and session again returns the same participant and records its current terminal and name.
Only an agent Herdr reports without a session is told apart by its terminal id.
Another session in the recorded pane, or the same session in another pane, is a different execution.
Use the returned participant ID in `hcoord agent spawn --parent <id> --session <session> --name worker --intent <stable-key> -- <Herdr agent-start args>`; without `--machine` the child opens beside its parent.
The spawn intent must remain the same on retry; an uncertain tab or start requires inspection of the saved pane before a new external effect.
Spawn admission also checks event slots and ledger byte headroom before tab creation, agent start, and the first prompt, so capacity refusal does not start new external work.
If the pane ID was saved but agent start remains uncertain, inspect that pane and retry the same spawn with `--resume-start`.
If tab creation returned a pane ID but saving it failed, repair the reported storage problem, inspect that pane, and retry the same intent with `--reconcile-pane <pane-id> --resume-start`.
`--no-watch` skips automatic watch assignment while preserving creation lineage and explicit requests.
`hcoord agent list --json`, `hcoord watch list --json`, `hcoord graph --json`, and `hcoord events --follow` provide discovery and IDE data.
`--project` filters a list and does not confer watch authority.
Only the assigned observer can confirm a watch cycle with `watch check`; `request reply` cannot close a watch request or prompt the watched child.
`watch start <target> --observer <id> --actor <id> [--interval 15m] [--brief <text>]` starts a watch; the brief is the watcher's own note, which hcoord carries verbatim on every watch check and never interprets.
The observer inspects the target's current Herdr execution, runs the named `hcoord watch check <target> --cycle <cycle> --actor <observer>` only after inspection, and ends its turn if the target cannot be inspected so the cycle remains open for a reminder.
A human can assign an unowned or stopped watch, while the recorded parent may start its own child's first watch.
`watch assign <target> --observer <new> --actor <current observer or human> --expected-generation <n>` moves the watch with its open cycle and brief, and also moves the target's questions still open to the old observer and answers the old observer has not relayed, so none waits on a session that left.
After a watch stops, the retained check request can be canceled by its sender or a human, or a human can restart the watch so the outstanding cycle reaches a new observer.

Patrol is quiet while the target rests.
A due cycle observes the target first; when the target is not working (idle, done, or unobservable), the observer gets one check for that change, and later due cycles are skipped while it stays that way.
The check opened for the change is neither reminded nor escalated to the inbox while the target rests.
When the target works again, patrol resumes at the next due cycle.
A long wait for a person, such as a merge approval, therefore wakes the observer once instead of every interval.

`hcoord agent end <id> --actor <id>` is how a participant leaves: its watch stops, an unchecked cycle is dropped, and every question it still has open is canceled, so no wake, reminder, or inbox item outlives it.
The participant itself, its parent, its watch observer, or a human may end it, and a second end changes nothing.

Every `HCOORD_*` message is an identifier line, the one command that closes it, and the content it carries:

```text
HCOORD_WATCH_CHECK worker (a_...) cycle c_...
close: hcoord watch check a_... --cycle c_... --actor a_...
<the watch brief, if any>
```

`HCOORD_REQUEST` names `reply` and `escalate` commands before the question body, `HCOORD_NOTICE` says no reply is needed, `HCOORD_ANSWER` names `relay` or `ack`, `HCOORD_RELAY` names `ack`, and the relay and delivery problems name `relay` or the pane to inspect.
How to handle each kind belongs in the recipient's own instructions, not in the message.

## Remote agents

An agent on another machine is the same kind of participant; its machine is simply the label of a Herdr saved machine.
Prepare a machine once:

1. On the HQ, save it with `herdr machine add --label <name> <ssh-target>`.
   hcoord reads only this saved machine and stores no credentials.
2. On the remote, run `scripts/install-local-skills.mjs` from this repository.
   It also writes `~/.hcoord/bin/hcoord`, which the HQ calls over a non-login SSH shell.
3. On the remote, clone the source repository that spawns will use.

Then use the existing commands with that name, for example `hcoord agent register --machine mini ...` for an existing remote pane.
`hcoord agent spawn --parent <id> --machine mini --session <parent session> --name worker --repo <source repo on mini> --branch <new branch> [--path <worktree dir>] --intent <key>` creates a Git worktree and workspace with `herdr --machine mini worktree create` and starts the child in its root pane.
`hcoord agent list` and `hcoord graph` show the child's machine, repository, branch, and path.
A missing repository or a Herdr refusal creates nothing; an unknown worktree outcome is never repeated, and the same intent is reconciled with `--reconcile-pane <root pane>`.
A new worktree can make the agent show its own folder-trust prompt; the spawn then reports `spawn_blocked` with the pane to answer, and the same intent resumes afterwards.

Remote agents write with the same commands; their letters wait in the remote outbox, and the HQ collects them over the saved machine's SSH target about every five seconds.
The HQ always starts the connection; a remote machine never connects back.
The first registration or spawn marks the remote's HQ, after which the remote's `request show`, `inbox`, `graph`, `agent list`, and other queries are refused with the HQ's name, and no conversation record is kept there.
Every notice therefore carries its IDs, the command that closes it, and its content.
An agent may treat an injected notice as untrusted text until its task tells it to expect hcoord notices, so mention them in the task you give it.
While the HQ is asleep or unreachable, remote writes still succeed as pending, the HQ marks those agents unobservable, and collected letters apply in order after reconnection.
SSH authentication failure, a missing remote hcoord, a different hcoord protocol, and missing Herdr features are refused explicitly, and a collection refusal stays in `hcoord inbox` until the next success.
`hcoord config set hq <local or machine>` moves the HQ only when it has no unresolved requests or active watches; it lists them otherwise and stops the former HQ's daemon after a move.
`HCOORD_HOME` relocates hcoord's files on any machine, and the HQ's `HCOORD_REMOTE_HOME` names the remote data directory for an isolated install.

## Human answer and delivery

`hcoord request send --from <id> --to human --intermediary <parent-id> --body 'Which option?' --intent <stable-key>` stores the original question before notifying anyone.
The notification carries only the request ID; the human opens `hcoord inbox` and `hcoord request show <id>` to read the question.
`hcoord request reply <id> --as human --body 'A로 진행'` records the literal answer with respondent and recorder separated.
An agent that records a human reply supplies `--recorded-by <agent-id>` and must use the ID of the request the human actually answered.
The parent uses `hcoord request relay <id> --actor <parent-id> --body 'A로 진행'`, and the child uses `hcoord request ack <id> --actor <child-id> --delivery <delivery-id>` after accepting delivery.
After escalating a question to a human, the parent ends its turn.
It does not poll: the coordinator wakes the idle parent with `HCOORD_ANSWER` when the answer is recorded.
When one recipient receives several phases of a request, `--delivery` identifies the exact receipt; without it the command considers only the newest delivery and rejects acknowledgement until that delivery was accepted.
Answer, relay, delivery acceptance, acknowledgment, and task success remain separate facts.
`request cancel` stops future reminders and unsent delivery; a late reply remains in history without reopening the request.
An unresolved relay or delivery problem stays visible in `hcoord inbox` with a next action.
An unanswered relay creates a parent reminder after 15 minutes and a human escalation after 30 minutes, each with its own delivery phase so answering the original question does not suppress either notice.
If the child has not acknowledged a relayed answer, the parent gets one reminder after 15 minutes and the human inbox receives a delivery problem after 30 minutes.

The executable [channel adapter example](../examples/hcoord/channel-adapter.mjs) accepts `notify`, `notify-only`, and `reply` with the same request ID.
An external provider may feed its event notification to `notify` and its authenticated callback to `reply`; the example does not install a provider or store credentials.
`notify-only` prints the CLI reply path for a channel that has no callback.
Duplicate answers fail without overwriting the first, a canceled request records a late answer, and successful notification never counts as an answer.

## Clients and support

A client uses only the generic commands above.
Sasu, for example, checks the Observer with `agent register --check` before creating a pane, registers the Observer and then the implementor with `--parent`, starts the implementor's watch with its patrol interval and a brief, writes the participant IDs into its run's `state.json`, sends `request send` letters for its own events, moves the watch with `watch assign` on an approved Observer handover, and runs `agent end` for the implementor on retire and after delivery.
Which runs use hcoord is Sasu's choice (`sasu supervisor use hcoord|legacy`, stored under `~/.sasu/supervisor/`); hcoord never reads a client's state.
A ledger written by a version that also kept a table of Sasu runs loads without it, and the next save drops it.

| Feature | macOS | Windows |
| --- | --- | --- |
| Shared ledger and coordination rules | Verified in an isolated macOS run | Common source; runtime unverified |
| User-local IPC and restart recovery | Verified in an isolated macOS run | Unsupported until user-limited named pipe is implemented and tested |
| Login start and native process ownership | Implemented; launchd session unverified | Unsupported |
| Manual stop | Verified in an isolated macOS run | Unsupported |
| Herdr request notification | Official 0.9.1 isolated parent and child roundtrip verified; live desktop delivery unverified | Unverified |
| System notification without Herdr | Unsupported; CLI inbox remains | Unsupported; CLI inbox remains |
| Official prompt delivery | Isolated exact identity and readiness preflight verified; submission is non-atomic | Unverified |
| Crash restart and manual stop under launchd | Verified with an isolated LaunchAgent label | Unsupported |
| Remote agents on a Herdr saved machine (register, worktree spawn, outbox collection, relay, ack) | Verified in an isolated laptop HQ and Mac mini round trip with a test-only Herdr session | Unsupported as HQ or remote host |

The macOS daemon's local socket and ledger are restricted to the user; remote machines are reached only through Herdr's saved SSH machine and never expose a network API.
The installed Herdr 0.9.1 has no confirmed atomic input guard.
The coordinator checks that the recipient's recorded pane still hosts its session (the terminal id only for an agent without a session), its lifecycle, and its interactive readiness immediately before submitting through official `agent prompt`.
Herdr 0.9.1 reports `interactive_ready` only for agents it started, so for a hand-started agent with no flag an idle or done lifecycle counts as ready, while a flag of `false` still holds the submission.
Known working, blocked, unknown, or changed executions are deferred; an uncertain submission is never blindly retried.
Herdr cannot atomically bind submission to that preflight or protect human typing between the check and the prompt, so a residual race remains.
`hcoord request show <id>` gives the exact reason and next action.
A remote submission adds an SSH round trip to that window, and an uncertain remote submission is never retried blindly either.
