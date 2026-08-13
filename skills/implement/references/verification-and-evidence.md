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
- a high-risk run adds one final risk judge after the two base lanes finish.

The acceptance and fidelity calls are independent and concurrent.
Neither can overwrite the other's failure.

## Safety

Use only synthetic or non-production data for tests and live judge smoke runs.
Never put secrets, personal data, or production source in fixtures.
Database-writing proof requires an explicitly disposable database.

The live judge check is required for completion.
If the local judge binary, authentication, or provider is unavailable, record the observable blocker and do not claim Done.
