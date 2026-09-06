---
topic: "gate-loop-ac13"
status: "ready"
human_approval: "approved"
review_profile: "standard"
---

# PRD: gate-loop-ac13

## Goal

A task list that renders, persists, and purges deleted tasks after a retention period.

## Non-goals

- No sharing between users.
- No telemetry.

## Decisions

| D-n | 결정 | 근거 |
| --- | --- | --- |
| D-01 | only a single local user; no sharing | the user answered so in the interview |
| D-02 | deleted tasks are kept for 30 days and then purged | the register marks the retention decision resolved |
| D-03 | tasks persist to local storage as JSON | repo: src/store.js already does this |
| D-04 | no telemetry is collected | the user refused telemetry outright |

## Behaviors

| # | 사용자가 관찰하는 행동 | 검사 방법 | 결정 |
| --- | --- | --- | --- |
| B1 | the widget renders the task list | check: `node --test test/render.test.mjs` | D-01 |
| B2 | the widget persists its tasks across a reload | check: `node --test test/persist.test.mjs` | D-03 |
| B3 | a task deleted 30 days ago is purged and a task deleted 29 days ago is not | check: `node --test test/retention.test.mjs` | D-02 |
| B4 | no request leaves the machine while the widget is used | judge: the diff adds no network call and the registered request log for B4 is empty | D-04 |

## Technical structure

One widget module, a storage adapter over local storage, and a retention sweep that runs on load.

## Risks

None.
