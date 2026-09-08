# Verification Environments

Choose the project's existing driver for actual product observations and repeatable tests.
The harness records suites and shared evidence; it does not prescribe one driver or separate evidence per requirement.

| Surface | Useful driver | Actual boundary to observe |
| --- | --- | --- |
| Web UI | Existing browser test framework; Playwright when none is established | Start the app and browser, drive the full user flow, inspect states and errors. |
| Terminal CLI | Command execution | Exit status, observable output, and persisted effects. |
| Terminal TUI | An owned terminal session | Send input and capture actual rendered terminal output. |
| Electron | Existing Electron driver | Drive the real application and record which build ran. |
| Mobile | Existing simulator/device driver | Exercise the target platform and record device/build identity. |
| Native desktop | Available native automation and screenshots | Inspect the actual running application and its build/instance identity. |

Manual browser QA uses the current project/browser tooling, including chromux when available.
Committed repeatable tests create and tear down their own server, browser, simulator, or terminal sessions.
Never put chromux or a shared daemon inside automated test commands: killed runs leaked roughly 180 headless tabs in the 2026-08-11 incident and concurrent invocations raced.
A zero-dependency product constraint covers runtime dependencies, not necessary test tooling.
Nondeterministic computer-use observations are evidence with a stated collector and method, not deterministic test results.
The independent reviewer assesses their sufficiency without automatically handing unreadable evidence to the human.

## Which Build Was Observed

Before desktop observation, establish exactly one running target instance and distinguish installed bundle from dev build.
Do not kill, replace, or mutate another session's app without coordination.
A stale installed app next to a dev instance can make valid fixes appear absent; source code that declares an icon is not evidence that it renders.
Capture the actual app and record the binary/build, target environment, collection time, and limitations.
A dev screenshot cannot establish installed-bundle behavior when that is the requirement.

## Reach The Relevant State

Before driving a long scenario, identify how to reach its required state: a disposable seed/fixture, a test-only entry point excluded from production, or the actual product's existing fast path.
A 2026-08-12 benchmark spent hours driving toward late game screens without a reachable fixture and ended incomplete.
If the required state cannot be reached within the approved scope, report the missing observation as a blocker; do not invent a passing result or silently reclassify it as later human judgment.

For multi-actor behavior, use separate contexts or sessions inside the existing test/observation method and inspect each actor's outcome.
The actor model belongs in the test or actual flow, not in a new harness ledger.
