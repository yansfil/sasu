# Round 4 follow-up improvements

These items are useful improvements from the fourth external review but are outside the approved before-merge changes.

- Restrict low-level enrollment mutation exports so production callers can only use the generation-aware reconciliation boundary.
- Add an independently controlled wall-clock jump regression to complement the monotonic deadline tests.
- Document the operator recovery path for legacy recipient-less enrollments that deliberately fail closed after an upgrade.
- Separate historical delivery incidents from current supervisor health in operator-visible status.
- Retain explicit two-store recovery wording because run state and supervisor index commits converge through retry rather than transactional atomicity.
