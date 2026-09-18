# Herdr 0.9.1 measurements behind the supervisor adapter

Measured on 2026-09-18 against the installed `herdr 0.9.1` (`~/.local/bin/herdr`) from the Implementor's own pane.
No prompt was sent to any live pane; the prompt measurement used an unknown option so the server refused before input.

## `herdr agent get <pane|name>`

Response shape on a hit:

```json
{"result":{"type":"agent_info","agent":{"agent":"<name>","agent_session":{"value":"<uuid>"},"agent_status":"working","pane_id":"w8D:p1","terminal_id":"term_...","revision":1,"state_change_seq":12,"tokens":{"activity":"<epoch ms string>"}}}}
```

- A missing target exits 1 with stderr JSON `{"error":{"code":"agent_not_found",...}}`.
  The adapter maps that to `absent`, a positive answer; any other failure is `unavailable` and proves nothing.
- `agent_session.value` equals the pane's `CLAUDE_CODE_SESSION_ID`.
- `tokens.activity` did not move during five minutes of continuous tool use; it records the last lifecycle change, not the last output.
  The settled rule therefore reads it as "time in the current status", which is what the two-tick level form needs.
- A herdr server restart keeps pane ids and session UUIDs but rotates `terminal_id` (the Observer's went `term_65baf4475e57467` to `term_65bba8f3ff55f24`).
  Under D-06 that reads as observer-gone until `sasu supervisor handover` re-records the Observer.

## `herdr agent prompt`

- `--expected-input-guard <x>` is unknown to 0.9.1: exit 2, stderr `unknown option: --expected-input-guard`, nothing submitted.
  The adapter reports `guarded_prompt_unsupported` and never falls back to an unguarded send.
- `agent get` carries no `input_guard` field in 0.9.1, so every wake takes the session-match path today; the guarded path is exercised by the fake.
- `herdr agent prompt --help` on 2026-09-18 lists only `--wait` and `--until`.

## Pane environment

`HERDR_ENV=1`, `HERDR_PANE_ID`, `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, `HERDR_SOCKET_PATH`, `HERDR_BIN_PATH`.
`herdr` is not on launchd's default PATH, so the LaunchAgent plist carries the installing shell's PATH.
