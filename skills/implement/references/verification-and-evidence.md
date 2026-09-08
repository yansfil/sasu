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
Satisfied assessments must cite actual supplied source, execution logs, or artifacts; PRD-only references and catalog metadata do not establish implementation satisfaction.
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

After mechanical success, independent Fidelity and Code reviews run concurrently with the same entire sealed PRD and decision/intent sources, owned change, permitted surrounding source, suite execution facts, registered observations, and prior findings.
They use the same routine model profile and preserve separate actual results and call records within one verification attempt and lease.
Neither receives the current peer verdict.
Settled judgments and their input identity remain unchanged in state history when a later attempt records a correction.
A distinct high-risk check uses the same fixed inputs when the profile requires it.
The reviewer may cite any concrete approved requirement and actual counterevidence, including newly discovered omissions in unchanged files.
Both roles must disposition every prior open issue; it closes only when both resolve it with evidence.
A partial failure remains visible and cannot become a complete review.

The judge may read only allowlisted evidence and source in its disposable read-only workspace.
Its recorded command trace is audited; broad reads, process execution, writes, network access, and repository history invalidate the verdict.
The source catalog lists known paths, not file contents or additional read permission.
If a necessary router, caller, or other surrounding file is inaccessible, the reviewer names the unmet contract, inaccessible path, and specific question in an insufficient-evidence finding.
Register that current surrounding source once as a shared `file` artifact when appropriate; it can support many Bn references without separate evidence or a per-Bn mapping.
Its registered bytes must match the current product source, including when the record root and implementation worktree differ.
Missing surrounding context is an explicit inability-to-verify finding, never permission to broaden access silently.
An incapable image backend must use an existing capable route or report an error; unreadable evidence cannot silently downgrade a requirement to later human confirmation.

Use synthetic or non-production data and an explicitly disposable database for writing scenarios.
Never include secrets or production personal content in fixtures or logs.
A live backend failure is an observable blocker, and fixture/stub success is not live end-to-end validation.
