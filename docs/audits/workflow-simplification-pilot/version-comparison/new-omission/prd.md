---
topic: "matched task-list library"
status: "ready"
human_approval: "approved"
human_approval_note: "2026-09-08 user authorized a simple old-versus-new test, including simulation."
review_profile: "standard"
review_rationale: "Small deterministic non-UI library comparison"
source_intake: "current conversation"
---

# PRD: Matched task-list library

## Goal

Provide six deterministic task-list library behaviors with one meaningful test suite.

## Non-goals

No UI, network, persistence, deployment, human confirmation, or implementation-agent speed measurement.

## Decisions

| D-n | 결정 | 근거 |
| --- | --- | --- |
| D-01 | Use a dependency-free Node library and one fixed suite; keep product bytes identical across harness versions. | This isolates workflow mechanics while preserving an independently reviewable planted omission. |

## Behaviors

| # | 사용자가 관찰하는 행동 | 결정 |
| --- | --- | --- |
| B1 | Adding a task trims its title and assigns the next stable numeric id. | D-01 |
| B2 | Adding a blank title throws and leaves the supplied list unchanged. | D-01 |
| B3 | Toggling a known id changes only that task's completed state. | D-01 |
| B4 | Removing a known id returns a list without that task and preserves the others. | D-01 |
| B5 | Taking a snapshot returns defensive task copies that callers cannot use to mutate the source list. | D-01 |
| B6 | The summary uses singular '1 item' for one task and plural '<n> items' for every other count. | D-01 |

## Technical structure

The implementation is src/task-list.mjs and the required suite is node --test test/task-list.test.mjs.

## Risks

This scripted replay measures harness process cost, not independent implementation speed.
