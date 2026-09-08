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

| # | 사용자가 관찰하는 행동 | 결정 |
| --- | --- | --- |
| B1 | the widget renders | - |
| B2 | the widget persists its state across reload | D-01 |
| B3 | the persisted state feels right to the user | D-01 |

## Technical structure

One widget module plus a storage adapter.

## Risks

None.
