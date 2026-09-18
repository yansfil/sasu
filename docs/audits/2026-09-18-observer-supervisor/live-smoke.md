# Live smoke of the supervisor wake path

Run on 2026-09-18 between 06:25Z and 06:37Z by the Implementor session (pane w8H:p1) under the Observer's in-contract decision and the user's verbatim authorization "ㅇㅇ 라이브 스모크 진행해줘 (sonnet5 로해 띄우게되는 애들은)".
It observes for real the one claim the fake-herdr suite could not: a hand-run tick wakes the recorded Observer pane through the installed herdr, and sends nothing to a replaced session.

## Setup

- herdr 0.9.1 at `~/.local/bin/herdr`, the real server on `~/.config/herdr/herdr.sock`.
- sasu: this branch's `cli/dist` (source of commit 1903c61 plus the decide.ts hint fix below) through a wrapper `bin/sasu` placed first on PATH for every command and every test pane.
- Isolated HOME `<scratchpad>/live-smoke/home`, so the index lived at `<home>/.sasu/supervisor/index.json`; the real `~/.sasu`, `~/Library/LaunchAgents`, `~/.claude/settings.json` and the Codex hooks were never touched (`live-smoke/32-real-domain-after-smoke.txt`).
- One workspace `w8J` created for the test (`01-workspace-create.json`), closed afterwards (`31-teardown-workspace-close.json`); no pre-existing pane received any input.
- Every agent started for the test ran `claude --model claude-sonnet-5`: `smoke-observer` in w8J:p1 (`02-observer-start.json`; the folder-trust prompt was answered with `send-keys Down Enter`, `04-trust-keys.json`), `smoke-impl` in w8J:p2 through `sasu implement dispatch --model claude-sonnet-5` (`07-dispatch.json`), `smoke-stranger` in w8J:p3 (`13-S3-stranger-start.json`), and a replacement `smoke-observer` in w8J:p1 (`21-S2-replacement-start.json`).
- Scratch project: a git repository with a one-behavior PRD (`agents/prd/smoke/prd.md`), started with `sasu implement start --prd agents/prd/smoke/prd.md --dirty-attribution run-owned` as the test observer's session (`06-start.json`), then dispatched with the packet in `00-implementor-handoff.txt`.
- The test observer was primed once to run the `inspect:` line of any `SASU_WAKE` message and nothing else (`05-observer-prime.json`); the stranger got the same priming (`14-S3-stranger-prime.json`); the replacement observer was not primed at all.

## Scenarios

| Scenario | Command | Observed | Verdict |
| --- | --- | --- | --- |
| S4 idle no-wake | `sasu supervisor tick` at 06:28:23Z with the implementor `working` 12 s after dispatch | `1 run(s), 0 wake(s) sent`, action `none`, candidates `[]` (`08-S4-tick-working.json`) | pass |
| S1 wake reaches the right pane | `sasu supervisor tick` at 06:30:44Z with the implementor `done` for 131 s | action `sent`, `accepted via session-match (submitted)`, due `[settled]` (`09-S1-tick.json`); the wake text was visible in w8J:p1 619 ms after the tick started (`09-S1-timing.txt`); the pane shows the identity note only, and the Sonnet observer ran `sasu implement status --slug smoke --digest` and received the digest (`10-S1-observer-pane.txt`) | pass |
| S1b same episode once | `sasu supervisor tick` at 06:31:25Z | candidates `[settled]`, due `[]`, action `none`; the pane holds one `SASU_WAKE` (`11-S1b-tick-again.json`) | pass |
| S3 wrong-session harmlessness (B10) | the S1 wake text sent verbatim by hand to the stranger pane w8J:p3 (`15-S3-wake-text-sent.txt`, `16-S3-stranger-prompt.json`) | the stranger ran the digest command and got exit 2 `digest refused: run 'smoke' is observed by session 47b6846e..., and this session is dc948c94...; nothing was changed`; no other action, working tree unchanged (`17-S3-stranger-pane.txt`) | pass |
| S2a pane emptied | the original observer left with `/exit` (`18-S2-exit-observer.json`, `19-S2-after-exit-get.json` shows `agent_not_found`); `sasu supervisor tick` at 06:32:33Z | 0 sent; `lastObservation.observer` = `observer-gone: no agent in the Observer's recorded pane w8J:p1` (`20-S2a-tick-absent.json`) | pass |
| S2b replaced session gets nothing | a fresh Sonnet 5 `smoke-observer` in the same pane and terminal (session 9ad8d598...); the implementor nudged once so a new settled episode was due (`22-S2-impl-nudge.json`); `sasu supervisor tick` at 06:34:32Z | action `deferred`, `observer-gone: pane w8J:p1 now holds session 9ad8d598..., not the recorded Observer 47b6846e...; no input is sent to the replacement`; the replacement pane holds zero `SASU_WAKE` lines (`23-S2b-tick-replaced.json`, `25-S2b-replacement-pane.txt`); `sasu supervisor status` shows the run `[stale]` with that observer line (`24-S2b-status.json`) | pass, with one defect (below) |
| S2b rerun after the fix | `sasu supervisor tick` and `status` at 06:35:53Z on the rebuilt dist | the same deferral now ends with "wakes stay withheld until a person runs `sasu supervisor handover --slug <slug> --approval "<words>"` from the pane that should observe"; still zero wake lines in the pane (`26-S2b-rerun-tick.json`, `27-S2b-rerun-status.json`) | pass |
| S5 explicit handover resumes wakes (B18) | `sasu supervisor handover --slug smoke --approval "<the user's words>"` as the replacement session, then `sasu supervisor tick` at 06:36:08Z | handover accepted (`28-S5-handover.json`); action `sent` to the replacement, visible in the pane 812 ms after the tick (`29-S5-*`); the unprimed Sonnet observer ran the digest on its own and summarized it as expected completion with nothing to act on (`30-S5-replacement-pane-after-wake.txt`) | pass |

## Defect found and fixed

The S2b `sasu supervisor status` line named the replacement session and said no input is sent, but did not say what a person does next; only the terminal-id branch of `judgeObserver` mentioned `sasu supervisor handover`.
B18 makes the explicit handover the only way out, so every observer-gone verdict now ends with that instruction (`cli/src/supervisor/decide.ts`, asserted in `cli/test/unit/supervisor-decide.test.mjs`), and S2b was rerun on the rebuilt build.

## Observations outside the scenarios

- Round trip from `tick` start to wake text visible in the pane: 619 ms (S1) and 812 ms (S5), measured by polling `herdr agent read` every 500 ms, so the true latency is below each figure.
- `herdr agent prompt --wait --until idle` timed out on a Claude Code pane whose turn ended in status `done`; the tick's deferral rule treats `done` as deliverable, which S1 confirms.
- After each digest the Claude Code input box showed unsubmitted suggestion text (`stop`, `run verify`); it is the UI's prompt suggestion, not input, and nothing was submitted.
- The implementor first wrote `notes.txt` beside the scratchpad instead of the project and corrected itself before committing; unrelated to the supervisor.
- `herdr agent list` before and after the test differed only in the user's own panes (one Codex pane in w76 gone, one Claude pane in w60 new); nothing under w8J remains.

## Still unrun

- A real `launchctl bootstrap` of `com.sasu.supervisor` into `gui/501`; every tick here was run by hand.
- The guarded prompt path; herdr 0.9.1 offers no `input_guard`, so every wake used session-match.
- The Stop hook against a live pane; it was exercised only by the isolated e2e suite.
