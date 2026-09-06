---
topic: "fixture"
status: "ready"
human_approval: "approved"
review_profile: "standard"
---

# PRD: fixture

## Goal

A widget that renders and persists.

## Non-goals

- No theming.

## Decisions

| D-n | 결정 | 근거 |
| --- | --- | --- |
| D-01 | the widget persists to local storage | Q3: the user wants state to survive reload |

## Behaviors

| # | 사용자가 관찰하는 행동 | 검사 방법 | 결정 |
| --- | --- | --- | --- |
| B1 | check: `node --test test/widget.test.mjs` renders the widget | judge: the diff | - |
| B2 | the widget persists its state across reload | judge: a before/after screenshot pair registered for B2 | D-01 |
| B3 | the persisted state feels right to the user | human: the user reloads and says the widget kept their state | D-01 |

## Technical structure

One widget module plus a storage adapter.

## Risks

None.
