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
| Native desktop app | none scriptable - last resort below | Prefer extracting logic behind a testable boundary; a computer-use agent is evidence collection for human review, never a `check` oracle. |

Rules that hold across every row:

- Prefer the driver the project already uses.
  A repo with cypress binds cypress, not playwright; the table is the default for projects with nothing.
- Self-contained only.
  The script launches and tears down everything it needs (server, browser, simulator, tmux session).
  Never bind chromux or any shared daemon into a committed check: killed runs leak sessions and concurrent runs race (2026-08-11: ~180 orphaned headless tabs wedged CDP and failed innocent checks).
- A "zero-dependency" product guardrail covers runtime dependencies, not test tooling; a playwright devDependency does not violate it.
- Nondeterministic drivers (computer-use, screen-reading agents) cannot be `check` oracles.
  Their output may be registered as evidence for a human-verification row, nothing stronger.

## Reaching The Evidence State

Choosing the right mode is half the binding; the other half is getting the product into the state the evidence requires.
A real run (2026-08-12, pokemon-rpg benchmark) failed exactly here: the AC required screenshots of nine screens, three were only reachable after deep game progression, no declared way to reach that state existed, and hours of playwright auto-driving ended in an honest partial.

Before binding a scenario or runtime V row, answer "how does the verifier reach this state?" with one of:

- a seed script or fixture the repo ships (preferred; if missing, it is implementation work for a task, not an excuse).
- a test-only entry point (route, flag, savefile) that jumps to the state, kept out of production paths.
- an existing fast path through the product itself.

If none exists and none can be built in scope, say so at binding time and route the row to human verification or blocked - do not burn the retry budget driving toward an unreachable state.
PRD scenario cards (`SC#`) carry a `Reach:` line for exactly this; read it before binding the row that covers the card.

## Multi-Actor Scenarios

A scenario whose card names several actors binds as one script with one context per actor - two playwright `browserContext`s with separate auth, interleaved steps, assertions on what each actor observes.
The harness has no session or actor concept, and none is needed: the actor model lives entirely inside the test file.
Seed both actors' accounts through the same Reach mechanism as any other state.
