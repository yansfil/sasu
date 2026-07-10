# Execution Plan: standard-regression

- PRD: agents/prd/standard-regression/prd.md
- Status: ready
- Generated: <TS>
- Nodes: 1
- Blocking gaps: 0
- Warnings: 1

## Ready Guidance

- Ready sequential: none
- Ready parallel groups: none

## Nodes

### N1. Run the local command verification. Covers R1, AC1.

- Status: complete
- Source task: T1
- Owner: unassigned
- Depends on: none
- Write scope: unknown
- Parallel safe: no
- Risk: low
- Covers: R: R1; AC: AC1; V: V1
- Evidence:
  - <TS>: Test nodes completed.

## Rollups

- T1: nodes N1; AC AC1; Verification V1

## Trace Matrix

- T1: N N1; R R1; AC AC1; required V V1; optional V none

## Gaps

- warning: missing_write_scope T1 - Write scope could not be inferred; node is not parallel-safe until the coordinator narrows scope
