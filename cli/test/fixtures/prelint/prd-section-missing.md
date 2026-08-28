---
topic: "fixture"
status: "ready"
human_approval: "approved"
review_profile: "standard"
---

# PRD: fixture

## 1. Summary

A widget that renders and persists.

## 2. Problem, Goal, And Users

Users need a widget.

## 3. Scope And Non-Goals

In scope: the widget.

## 4. Pre-Work And Required Decisions

None required.

## 5. Major Technical Structure Changes

No major technical structure change expected.

## 6. Requirements

- R1. the widget renders and persists its state

## 7. Acceptance Criteria

| ID | Criterion | Judgment | Evidence Declaration |
| --- | --- | --- | --- |
| AC1 | the widget renders | machine | - |
| AC2 | the widget persists its state | machine | - |

## 8. PRD-Level Tasks

- T1. build the widget. Covers R1, AC1, AC2.

## 9. Verification Contract

### 9.1 Test Mode Contract

| Mode | Required For Done | Covers | Human Decision |
| --- | --- | --- | --- |
| automated behavior | yes | core behavior | none |

### 9.2 Required Agent Verification

| ID | Mode | Covers | Pass Intent | Required For Done | Can Be Blocked |
| --- | --- | --- | --- | --- | --- |
| V1 | automated behavior | R1, AC1, AC2 | behavior covered by automated test | yes | no |

## 10. Risks And Open Decisions

None.

## 12. Implementation Result Report Contract

Report status and evidence.
