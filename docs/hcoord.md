# hcoord coordinator

`hcoord` keeps agent relationships, watch cycles, requests, delivery attempts, and human answers in one local ledger.
Herdr remains the source of execution facts, and Sasu remains the writer of implementation and verification state.
The CLI and JSON API expose the same coordinator facts.

## Start and inspect

Build with `npm --prefix cli run build` and invoke `node cli/dist/hcoord/cli.js` or the installed `hcoord` binary.
On macOS, `hcoord daemon start` installs a user LaunchAgent that starts at login, and `hcoord daemon stop` marks the current user session manually stopped.
`hcoord daemon status --json` shows actual feature support, usage, and the last stored snapshot when the daemon is down.
A down daemon permits marked stale reads and refuses mutations.
The daemon stores a private ledger and user socket under `~/.hcoord`, writes the ledger atomically, and rejects requests when finite caps are reached.
The service reserves an unknown outcome before sending external input and never blindly repeats such submissions after a restart.

Register an existing exact Herdr pane with `hcoord agent register --machine local --session <session> --instance <terminal-id> --pane <pane-id> --name <name>`.
Use the returned participant ID in `hcoord agent spawn --parent <id> --machine local --session <session> --name worker --intent <stable-key> -- <Herdr agent-start args>`.
The spawn intent must remain the same on retry; an uncertain tab or start requires inspection of the saved pane before a new external effect.
`--no-watch` skips automatic watch assignment while preserving creation lineage and explicit requests.
`hcoord agent list --json`, `hcoord watch list --json`, `hcoord graph --json`, and `hcoord events --follow` provide discovery and IDE data.
`--project` filters a list and does not confer watch authority.

## Human answer and delivery

`hcoord request send --from <id> --to human --intermediary <parent-id> --body 'Which option?' --intent <stable-key>` stores the original question before notifying anyone.
The notification carries only the request ID; the human opens `hcoord inbox` and `hcoord request show <id>` to read the question.
`hcoord request reply <id> --as human --body 'A로 진행'` records the literal answer with respondent and recorder separated.
An agent that records a human reply supplies `--recorded-by <agent-id>` and must use the ID of the request the human actually answered.
The parent uses `hcoord request relay <id> --actor <parent-id> --body 'A로 진행'`, and the child uses `hcoord request ack <id> --actor <child-id> --delivery <delivery-id>` after accepting delivery.
When one recipient receives several phases of a request, `--delivery` identifies the exact receipt; without it the command acknowledges the newest accepted delivery.
Answer, relay, delivery acceptance, acknowledgment, and task success remain separate facts.
`request cancel` stops future reminders and unsent delivery; a late reply remains in history without reopening the request.
An unresolved relay or delivery problem stays visible in `hcoord inbox` with a next action.
If the child has not acknowledged a relayed answer, the parent gets one reminder after 15 minutes and the human inbox receives a delivery problem after 30 minutes.

The executable [channel adapter example](../examples/hcoord/channel-adapter.mjs) accepts `notify`, `notify-only`, and `reply` with the same request ID.
An external provider may feed its event notification to `notify` and its authenticated callback to `reply`; the example does not install a provider or store credentials.
`notify-only` prints the CLI reply path for a channel that has no callback.
Duplicate answers fail without overwriting the first, a canceled request records a late answer, and successful notification never counts as an answer.

## Sasu transition and support

`hcoord sasu enable` opts new Sasu dispatches into coordinator registration only when the daemon is running and Herdr advertises guarded prompt support.
Each dispatch also checks the exact Observer's input guard before a child is created; an unavailable guard refuses the hcoord-owned run.
An existing run keeps its legacy supervisor owner; Sasu dispatch pins each new run's owner before creating the child and refuses fallback if the selected coordinator is unavailable.
This work does not enable the marker or touch the live supervisor automatically.
The legacy supervisor must remain installed while any legacy run is active.
After the final legacy run leaves the supervisor index, `sasu supervisor retire-legacy` checks that no indexed run or tick remains, uninstalls its LaunchAgent and Stop hook, and writes a marker that prevents the installer from restoring them.
Do not run that command while an older implementation run is still active.

| Feature | macOS | Windows |
| --- | --- | --- |
| Shared ledger and coordination rules | Verified in an isolated macOS run | Common source; runtime unverified |
| User-local IPC and restart recovery | Verified in an isolated macOS run | Unsupported until user-limited named pipe is implemented and tested |
| Login start and native process ownership | Implemented; launchd session unverified | Unsupported |
| Manual stop | Verified in an isolated macOS run | Unsupported |
| Herdr request notification | Fake Herdr verified; live desktop delivery unverified | Unsupported |
| System notification without Herdr | Unsupported; CLI inbox remains | Unsupported; CLI inbox remains |
| Guarded prompt delivery | Unsupported on installed Herdr 0.9.1; requests remain deferred | Unverified |
| Remote Herdr and SSH API bridge | Unsupported until both paths pass independent checks | Unsupported |

The macOS daemon's local socket and ledger are restricted to the user; remote hosts are refused instead of exposing an unauthenticated network API.
The installed Herdr 0.9.1 has no confirmed atomic input guard, so agent delivery is deferred and no ordinary prompt is substituted.
`hcoord request show <id>` gives the exact reason and next action.
Any future remote adapter must use the existing authenticated SSH path for coordinator API access and verify Herdr's remote target path separately.
