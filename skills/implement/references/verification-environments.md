# Verification Environments

Read this reference when binding a browser/runtime, mobile, TUI, desktop, or other interactive-surface V row to concrete commands.

The harness never knows which driver you chose.
Every environment below reduces to the same oracle grammar: a command the harness runs, an exit code, and captured artifact files.
Pick the driver, wrap it in a command, register the artifacts - the verify pipeline is identical from there.

## Binding Table

| Surface | Default driver | Shape of the binding |
| --- | --- | --- |
| Web UI | playwright (devDependency) | Script launches the app and browser itself, drives the flow, exits nonzero on failure; screenshots become `capture` artifacts. |
| Terminal CLI | plain command execution | Exit codes and output assertions; no driver needed. |
| Terminal TUI | tmux scripting | `tmux send-keys` for input, `capture-pane` output saved to a file as evidence; the script creates and kills its own session. |
| Electron app | playwright's Electron driver | Same shape as Web UI; no separate tool. |
| Mobile app | maestro YAML flows | `maestro test flow.yaml` against a simulator/emulator the script boots; YAML flows live in the repo as test assets. |
| Native desktop app | none scriptable - last resort below | Prefer extracting logic behind a testable boundary; a computer-use agent is evidence collection for human review, never a `check` oracle. Pin which build the capture came from - see Which Build Am I Looking At. |

Rules that hold across every row:

- Prefer the driver the project already uses.
  A repo with cypress binds cypress, not playwright; the table is the default for projects with nothing.
- Self-contained only.
  The script launches and tears down everything it needs (server, browser, simulator, tmux session).
  Never bind chromux or any shared daemon into a committed check: killed runs leak sessions and concurrent runs race (2026-08-11: ~180 orphaned headless tabs wedged CDP and failed innocent checks).
- A "zero-dependency" product guardrail covers runtime dependencies, not test tooling; a playwright devDependency does not violate it.
- Nondeterministic drivers (computer-use, screen-reading agents) cannot be `check` oracles.
  Their output may be registered as evidence for a human-verification row, nothing stronger.

## Which Build Am I Looking At

A desktop app has no URL, so a capture carries no proof of which binary produced it.
Two failure modes, both observed on 2026-08-17 (herdr-pet):

- A stale installed bundle (`/Applications/<App>.app`) running next to a dev build.
  Tray actions, window state, and show/hide cross-talk between the instances, and every source fix looks like it never applied.
  That session burned three rounds on "the pet is not visible" and "a big window opens instead of the pet"; neither was a code bug.
- Code existence reported as render evidence.
  "The menu bar icon exists in the code" is not a capture of the icon on screen.

So for any desktop V row whose evidence is a capture:

- Assert a single running instance before capturing (`pgrep -fl <executable>` must return one line), and kill the rest.
- Capture against the build the acceptance criterion is about.
  If the criterion is about the shipped app, build and replace the installed bundle first; a dev-build capture does not close it.
- Record which build the artifact came from in the artifact description, not just what it shows.

## Reaching The Evidence State

Choosing the right mode is half the binding; the other half is getting the product into the state the evidence requires.
A real run (2026-08-12, pokemon-rpg benchmark) failed exactly here: the AC required screenshots of nine screens, three were only reachable after deep game progression, no declared way to reach that state existed, and hours of playwright auto-driving ended in an honest partial.

Before binding a scenario or runtime V row, answer "how does the verifier reach this state?" with one of:

- a seed script or fixture the repo ships (preferred; if missing, it is implementation work for a task, not an excuse).
- a test-only entry point (route, flag, savefile) that jumps to the state, kept out of production paths.
- an existing fast path through the product itself.

If none exists and none can be built in scope, say so at binding time and route the row to human verification or blocked - do not burn the retry budget driving toward an unreachable state.
The PRD's Risks section and the row's cited Decisions say how the product reaches that state; read them before driving the row.

## Multi-Actor Scenarios

A scenario whose card names several actors binds as one script with one context per actor - two playwright `browserContext`s with separate auth, interleaved steps, assertions on what each actor observes.
The harness has no session or actor concept, and none is needed: the actor model lives entirely inside the test file.
Seed both actors' accounts through the same Reach mechanism as any other state.
