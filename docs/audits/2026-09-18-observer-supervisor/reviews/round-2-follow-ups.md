# Round 2 Native Review Follow-ups

## Disposition

The Fidelity, Code, and Security review set inspected committed head `e3e07f1b616ccee4d4d77611c12648af02e78ebd`.

Fidelity and Security reported no Fix now item.

Code reproduced one Fix now failure where an immutable enrollment revision committed before pruning raised an error, leaving the index on a replacement instance while durable run state retained the prior instance.

Commit `999ff46` adds the red-first regression and reconciles the index from current durable authority before the pre-start dispatch failure returns.

Per the Observer's principle 13 decision, the native review stage was not repeated for the resulting head.

The complete ordered suite passed after that fix.

## Follow-up Improvements

- Human contract clarity: Technical structure still says there is no lease or PID-reuse check, while amended D-09 and the implementation use a bounded durable executor lease with exact process-incarnation recovery.
- Delivery boundary: an installation without receiver-side guarded submission retains a final lookup-to-input race, so the identity note remains non-executable and the residual risk stays disclosed.
- Defensive hardening: redact any packet text echoed by transport diagnostics, bound handoff stdin, and consider private permissions plus no-follow reads for supervisor files.
- Portability evidence: process-incarnation fallback was simulated for Linux but not run on a native Linux host.
- Live evidence: the final delta was not exercised against the real user-domain service, current-head Stop hook, or pre-existing panes because the approved verification boundary forbids those effects.
- Test harness cleanup: keep temporary-directory and asynchronous cleanup ownership explicit if the affected fixtures are refactored.

## Principle Mapping

- Principle 10 is satisfied by returning a caller-visible reconciliation failure with a concrete dispatch retry when even the recovery write cannot complete.
- Principle 11 is satisfied by reconciling an uncertain post-commit enrollment from current durable authority instead of repeating or abandoning the external effect.
- Principle 13 is satisfied by ending native review after the one authorized head review set and recording unresolved advice as follow-up work.
