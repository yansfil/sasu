# Verification And Evidence

Read this reference before capturing or registering final runtime evidence and before unified verify.

## Evidence Ownership

- The agent or a suitable tool creates screenshots, recordings, API traces, DB captures, and runtime logs.
- `sasu implement artifact` validates and registers an existing file.
- `sasu implement verify` creates mechanical command logs itself.
- `state.json` records hashes, source fingerprints, metadata, and verification attempts.

## Final Evidence Timing

Capture final runtime evidence after implementation is coherent.
Temporary evidence created while debugging need not become final registered evidence.

Register final evidence immediately after capture:

```sh
sasu implement artifact \
  --id V3 \
  --kind screenshot \
  --path docs/screenshots/example.png \
  --description '<what this proves>'
```

The file must exist, be non-empty, stay inside the repository, and match its declared kind.
Image evidence must contain valid PNG or JPEG bytes.

## Freshness

Artifact registration pins both the artifact hash and current source fingerprint.
Changing either makes the artifact stale.
Recapture or re-register only the evidence invalidated by the source change.

Do not edit `state.json` to refresh a hash.

## Mechanical Verification

Unified verify discovers repository build and test scripts, groups identical `(cwd, argv)` bindings, and executes each group once.
One result may prove several verification IDs without running the command several times.

The mechanical stage runs before any LLM call.
A failure, timeout, malformed state, invalid artifact, or source mutation fails closed and makes zero judge calls.

## Judge Verification

After mechanical PASS:

- the acceptance judge checks code and evidence against acceptance criteria.
- the fidelity judge checks intent preservation with a fixed rubric and dynamic source context.
- a high-risk run adds one final risk review after the two base lanes finish; it updates the risk ledger and does not vote on their unified verdict.

From the second judged round onward, acceptance and fidelity receive their prior lane result, exact changed paths, and newly registered evidence.
Risk receives the open ledger findings plus that same delta context, and every prior open risk finding must be dispositioned as resolved or unresolved.
A prior PASS can become FAIL, and a new blocking finding can appear, only when the judge points to one exact changed path or new evidence item from that round.
This is an evidence-pointer requirement, not a ban on genuine defects.
The validator rejects invented or missing pointers through the normal invalid-output retry ladder.

A successful risk result appends new findings, keeps unresolved findings open, and marks resolved findings fixed.
A risk ERROR is recorded on the attempt without changing the ledger or the unified verdict.

For each acceptance criterion, the harness places the relevant mechanical output and text artifact content directly in the prompt.
It lists run-owned changed files and visual artifacts as an exact read allowlist instead of copying every changed file into every prompt.
The default Codex judge gets a disposable workspace containing only those copied allowlisted files.
Its read-only sandbox blocks writes but is not an OS-hard host-read boundary, so the CLI audits its JSON command trace and invalidates any command beyond bounded `sed` or `rg` reads of an allowlisted path.
Accepted commands are recorded on the judge call for later review.
It may not list directories, search broadly, inspect history or environment variables, access the network, or execute project code.
The Claude fallback can use only Read/Grep against the same prompt-level allowlist.
The implementing agent does not maintain a second manual file-to-criterion ledger.

The acceptance and fidelity calls are independent and concurrent.
Neither can overwrite the other's failure.

## Safety

Use only synthetic or non-production data for tests and live judge smoke runs.
Never put secrets, personal data, or production source in fixtures.
Database-writing proof requires an explicitly disposable database.

The live judge check is required for completion.
If the local judge binary, authentication, or provider is unavailable, record the observable blocker and do not claim Done.
