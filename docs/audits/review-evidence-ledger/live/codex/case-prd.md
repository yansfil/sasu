---
topic: "implement fixture"
status: "ready"
human_approval: "approved"
review_profile: "standard"
review_rationale: "CLI regression fixture"
source_intake: "current conversation"
---

# PRD: implement fixture

## Goal
The public command preserves every requested value.

## Non-goals
No network service or second state store.

## Decisions
| D-n | 결정 | 근거 |
| --- | --- | --- |
| D-01 | Preserve every value in the approved request. | The user requested all values. |

## Behaviors
| # | 사용자가 관찰하는 행동 | 결정 |
| --- | --- | --- |
| B1 | The exported command(1) returns the number 1. | D-01 |
| B2 | The exported command(2) returns the number 2. | D-01 |
| B3 | The exported command(3) returns the number 3. | D-01 |
| B4 | The exported command(4) returns the number 4. | D-01 |
| B5 | The exported command(5) returns the number 5. | D-01 |
| B6 | The exported command(6) returns the number 6. | D-01 |
| B7 | The exported command(7) returns the number 7. | D-01 |
| B8 | The exported command(8) returns the number 8. | D-01 |
| B9 | The exported command(9) returns the number 9. | D-01 |
| B10 | The exported command(10) returns the number 10. | D-01 |
| B11 | The exported command(11) returns the number 11. | D-01 |
| B12 | The exported command(12) returns the number 12. | D-01 |
| B13 | The exported command(13) returns the number 13. | D-01 |
| B14 | The exported command(14) returns the number 14. | D-01 |
| B15 | The exported command(15) returns the number 15. | D-01 |
| B16 | The exported command(16) returns the number 16. | D-01 |
| B17 | The exported command(17) returns the number 17. | D-01 |
| B18 | The exported command(18) returns the number 18. | D-01 |
| B19 | The exported command(19) returns the number 19. | D-01 |
| B20 | The exported command(20) returns the number 20. | D-01 |
| B21 | The exported command(21) returns the number 21. | D-01 |
| B22 | The exported command(22) returns the number 22. | D-01 |
| B23 | The exported command(23) returns the number 23. | D-01 |
| B24 | The exported command(24) returns the number 24. | D-01 |
| B25 | The exported command(25) returns the number 25. | D-01 |
| B26 | The exported command(26) returns the number 26. | D-01 |
| B27 | The exported command(27) returns the number 27. | D-01 |
| B28 | The exported command(28) returns the number 28. | D-01 |
| B29 | The exported command(29) returns the number 29. | D-01 |
| B30 | The exported command(30) returns the number 30. | D-01 |

## Technical structure
The public API is command exported from src/public.mjs. The complete source can establish deterministic integer behavior.

## Risks
None.
