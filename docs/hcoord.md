# Sasu on hcoord

`hcoord` is a component of the hide app, which installs it at `~/.local/bin/hcoord`.
Its commands, ledger, daemon, remote agents and platform support are documented with hide, not here.
Sasu ships no copy: it calls whichever `hcoord` is on PATH, and a missing one fails with `hcoord is not on PATH; open the hide app, which installs it at ~/.local/bin/hcoord` rather than falling back to anything.
A second copy would be a second coordinator with its own ledger.

hcoord knows participants and the relations between them (parent, watch, request) and nothing about Sasu.
Sasu knows nothing about hcoord's files either: it never reads the ledger and never names the data folder.
Which participants make up a run is written only in the run's `state.json`.

## What Sasu calls

Sasu uses only generic commands, always with `--json`:

| When | Command |
| --- | --- |
| Before dispatch creates anything | `agent register --check` for the Observer |
| Dispatch | `agent register` for the Observer, then for the implementor with `--parent` and `--project`, then `agent show` and `watch start` with the patrol interval and a brief |
| A replacement implementor | `agent end` for the gone one |
| `plan`, `block`, `report` | `request send` with a fixed intent, `--notify-only` or `--waiting` |
| Approved Observer handover | `agent register --check`, `agent register`, `agent show`, then `watch assign` (or `watch start` when the watch stopped) |
| Retire and a completed delivery | `agent end` for the implementor |
| Status and digest | `agent show` and `agent list` |
| `sasu supervisor use hcoord` | `status`, which must answer from a running daemon |
| `sasu supervisor migrate-hcoord` | `agent list`, matched by pane and session |

The answers Sasu reads are `value.id` of a registration, `value.watch` of a participant (`status`, `observer`, `generation`, `intervalMs`, `cycle`, `checkedAt`, `quietSince`), `registered` on `agent list` items, `delivery` and `value.letter` of a write, the `stale` marker of a read while the daemon is down, and `error.code` with `error.message`.
`agent list` has no filter by execution, so Sasu matches participants to an execution itself, with the same rule hcoord uses: the pane and session decide, and the terminal only for an agent that reports no session.

## Notices

Every `HCOORD_*` message is typed into a pane by the coordinator on behalf of a run's Observer.
Dispatch appends a fixed paragraph to the implementor's packet that says so, because an agent that received them without that forewarning treated them as an injection.
How to handle each kind belongs in [the Observer reference](../skills/implement/references/observer-and-herdr.md#hcoord-supervision).
