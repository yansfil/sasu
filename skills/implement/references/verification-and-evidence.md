# Verification And Evidence

Read this reference before capturing or registering final runtime evidence and before unified verify.

## Evidence Ownership

- The agent or a suitable tool creates screenshots, recordings, API traces, DB captures, and runtime logs.
- `sasu implement artifact` validates and registers an existing file.
- `sasu implement verify` creates mechanical command logs itself.
- `state.json` records artifact hashes and registration times, attempt-level source fingerprints, metadata, and verification attempts.

## Final Evidence Timing

Capture final runtime evidence after implementation is coherent.
Temporary evidence created while debugging need not become final registered evidence.

Register final evidence immediately after capture:

```sh
sasu implement artifact \
  --row B2 \
  --kind screenshot \
  --path docs/screenshots/example.png \
  --description '<what this proves>'
```

`--row` binds the evidence to the `judge:` row it proves; a `judge:` row with no registered artifact fails the acceptance lane before any judge is called.

The file must exist, be non-empty, stay inside the repository, and match its declared kind.
Image evidence must contain valid PNG or JPEG bytes.

## Artifact Identity And Freshness Judgment

Artifact registration pins the file hash and records `registeredAt`.
Missing or changed bytes fail the harness's identity check.
The harness does not infer semantic freshness from the whole source tree.
Judges see when bare evidence was agent-registered, treat it as the implementer's claim rather than a harness observation, and explain why older evidence remains valid when they rely on it after source changes.

Re-registering identical bytes preserves the original `registeredAt`; only changed bytes create a new registration time.
Do not edit `state.json` to refresh a hash or timestamp.

## Mechanical Verification

Unified verify runs the suite sealed at start (`verify.commands` from `agents/config.json`, else the commands detected from the repository) once, on one frozen tree, through the same executor `check --row` uses.
`check:` rows are not re-run: their exit-code results are read from the row ledger and carried into the receipt as recorded.

The mechanical stage runs before any LLM call.
A red suite command, a `check:` row that is not green on the current tree, a timeout, malformed state, an invalid artifact, or a source mutation fails closed and makes zero judge calls.

## Judge Verification

After mechanical PASS:

- the acceptance judge checks code and evidence against each `judge:` row.
- the fidelity judge checks intent preservation with a fixed rubric and dynamic source context.
- a high-risk run adds one final risk review after the two base lanes finish; it updates the risk ledger and does not vote on their unified verdict.

From the second judged round onward, acceptance and fidelity receive their prior lane result, exact changed paths, and newly registered evidence.
Risk receives the open ledger findings plus that same delta context, and every prior open risk finding must be dispositioned as resolved or unresolved.
A prior PASS can become FAIL, and a new blocking finding can appear, only when the judge points to one exact changed path or new evidence item from that round.
This is an evidence-pointer requirement, not a ban on genuine defects.
The validator rejects invented or missing pointers through the normal invalid-output retry ladder.

A successful risk result appends new findings, keeps unresolved findings open, and marks resolved findings fixed.
A risk ERROR is recorded on the attempt without changing the ledger or the unified verdict.

For each `judge:` row, the harness places the row ledger (every row's sealed cell, and for `check:` rows the recorded exit code), the failing suite output, the text artifact content registered against the row, and the Decisions rows it cites directly in the prompt.
It lists run-owned changed files and visual artifacts as an exact read allowlist instead of copying every changed file into every prompt.
The default Codex judge gets a disposable workspace containing only those copied allowlisted files.
Its read-only sandbox blocks writes but is not an OS-hard host-read boundary, so the CLI audits its JSON command trace and invalidates any command beyond bounded `sed` or `rg` reads of an allowlisted path.
Accepted commands are recorded on the judge call for later review.
It may not list directories, search broadly, inspect history or environment variables, access the network, or execute project code.
The Claude fallback can use only Read/Grep against the same prompt-level allowlist.
The implementing agent does not maintain a second manual file-to-row ledger.

The acceptance and fidelity calls are independent and concurrent.
Neither can overwrite the other's failure.

## Safety

Use only synthetic or non-production data for tests and live judge smoke runs.
Never put secrets, personal data, or production source in fixtures.
Database-writing proof requires an explicitly disposable database.

The live judge check is required for completion.
If the local judge binary, authentication, or provider is unavailable, record the observable blocker and do not claim Done.
