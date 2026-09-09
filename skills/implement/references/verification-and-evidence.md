# Verification And Evidence

The implementor or an appropriate tool collects actual screenshots, recordings, API traces, database observations, and logs.
`sasu implement artifact` registers existing files at run level; verify produces the required suite logs itself.
One coherent flow may support multiple requirements without separate registrations for each requirement.

```sh
sasu implement artifact --kind screenshot --path docs/screenshots/search.png \
  --description '<collector, collection method and time, actual target/build, observed flow, limitations>'
```

Keep observations honest: record who collected them, when, how, against which environment and target, and what was not checked.
Evidence under `agents/**` may be explicitly registered, while bookkeeping and completion claims never become product source or product proof.
The CLI pins registered bytes and rejects missing, empty, invalid, or changed files.
It does not infer sufficiency from keywords in the PRD or require an artifact for every requirement.
The independent review decides whether the actual implementation and observations support the complete contract.
Fidelity's grouped assessments account for every Bn, but one shared source file or observation may support many requirements without separate execution or artifact obligations.
Code records its own substantive evidence grounds without another all-Bn accounting form.
Satisfied assessments must cite actual inspected source, execution logs, or artifacts; PRD-only references and file names do not establish implementation satisfaction.
Structural coverage and valid references make the grounds inspectable, not mechanically correct.

Capture final material evidence after implementation is coherent.
Earlier observations retain their original time and target.
A matching source hash does not prove that a database, ignored file, external service, or installed bundle is unchanged.
Explain why earlier observations still apply or recapture affected flows.
Re-registering a file does not manufacture a new observation.

Verify runs required suites sealed at start and deduplicates identical command/cwd/execution settings only within that attempt.
Every new verification attempt executes its required suites; there is no cross-attempt test cache.
A suite failure prevents review and records the actual failed phase and output.
An empty required suite is reported as no tests configured, never as successful execution.
Suite exclusions require human authorization and preserve their prior results.

After mechanical success, independent Fidelity and Code reviews run concurrently with the same entire sealed PRD and decision/intent sources, owned change, fixed product source copy, suite execution facts, registered observations, and prior findings.
They use the same routine model profile and preserve separate actual results and call records within one verification attempt and lease.
Neither receives the current peer verdict.
Settled judgments and their input identity remain unchanged in state history when a later attempt records a correction.
A distinct high-risk check uses the same fixed inputs when the profile requires it.
The reviewer may cite any concrete approved requirement and actual counterevidence, including newly discovered omissions in unchanged files.
Both roles must disposition every prior open issue; it closes only when both resolve it with evidence.
A partial failure remains visible and cannot become a complete review.

The judge discovers and searches source only inside its disposable fixed review workspace.
The product copy contains the same content-hashed Git-visible regular-file set used for source freshness: tracked files and nonignored untracked files, excluding root `agents/**` bookkeeping and symlinks.
Registered actual evidence is copied separately with its pinned identity and provenance.
The initial prompt points to complete `agents/review-input/contract.md`, `context.md`, `changes.diff`, and `evidence.md` documents instead of repeating source bodies and file catalogs.
Every reviewer reads the entire contract, then follows relevant callers, dependencies, and error paths through read-only file discovery and search.
Ordinary unchanged source needs no manual artifact registration.
A file name alone is not evidence that its behavior was inspected.
Native restrictions enforce the product/evidence read boundary before access.
Codex uses the absolute fixed root plus its `:minimal` OS/runtime substrate, disables network access, and rejects unsupported permission configuration with `--strict-config`.
The runtime allowance lets the engine run; it is not extra source or evidence to inspect.
Claude read-enabled fallback uses `--restricted` inside its disposable copy.
The recorded command trace is additionally audited against copied paths and permitted reads/searches; the trace alone cannot attest to a tool-selected working directory.
Product reads from the live worktree or other host locations, project execution, writes, network access, and repository history remain forbidden.
If required evidence is absent from the copy, the reviewer names the unmet contract, missing evidence, and specific question in an insufficient-evidence finding.
Missing context remains unverified and never permits access outside the copied boundary.
Registered source evidence must still match the current product bytes, including when record and implementation roots differ.
An incapable image backend must use an existing capable route or report an error; unreadable evidence cannot silently downgrade a requirement to later human confirmation.

Use synthetic or non-production data and an explicitly disposable database for writing scenarios.
Never include secrets or production personal content in fixtures or logs.
A live backend failure is an observable blocker, and fixture/stub success is not live end-to-end validation.
