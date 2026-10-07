# Deterministic verification and evidence

The implementor collects actual screenshots, recordings, API traces, database observations, logs, and other evidence needed for the changed product flow.
One coherent observation may support several requirements.

Register material evidence with:

```sh
sasu implement artifact --kind screenshot --path docs/screenshots/search.png \
  --description '<collector, method, time, actual target/build, observed flow, limitations>'
```

Evidence records preserve file bytes, collection time, method, target, and environment.
Registration proves identity and provenance, not semantic sufficiency.
The human reviewer and advisory subagents judge whether it supports the PRD.

The canonical `source_intake` must be an existing file inside the project before `start` or `amend` seals it.
If the conversation supplied the requirements, use the intake snapshot saved by `gen-prd`.

To exercise the sealed suites before recording verification, run:

```sh
sasu implement verify --preview
```

Preview uses the real verification executor, environment, timeout, exclusions and execution lease.
It reports all required command outputs and failures without creating a verification attempt, evidence registration or report.
Suite commands still perform their normal work, so inspect source changes they produce.
Preview is never a delivery verdict.
Delivery is blocked while either preview or verification holds the execution lease.
Normal preview completion restores the prior state bytes when no independent command changed the record.
Recovery after an abrupt preview owner exit preserves the record's content, timestamps and history, but may normalize JSON whitespace and line endings.

If a generated command log was lost, recover its registration explicitly:

```sh
sasu implement artifact --recover agents/runs/<slug>/artifacts/logs/<missing-log> --reason '<why the log is missing>'
```

Recovery invalidates the current report and keeps the old path, hash, observation time and execution attempts as history.
It does not recreate old output or turn an earlier result into a current pass.
Run full verification again to collect fresh execution evidence.
Existing changed logs must be inspected and restored; missing runtime observations must be recollected and registered.

Run:

```sh
sasu implement verify
```

The CLI executes every active sealed suite command on one measured source tree.
It records real exit codes and logs, rejects commands that mutate the judged tree, validates registered evidence bytes, and checks that source and inputs stayed unchanged through the run.
A required command that did not run is never reported as successful.
An empty required suite is reported as unconfigured, not as executed tests.

The command writes:

```text
agents/runs/<slug>/verification-report.json
agents/runs/<slug>/verification-report.md
```

The report names the PRD hash, base SHA, head SHA, source fingerprint, commands, results, evidence, errors, and generation time.
Commit current source and evidence changes before verification.
Delivery rejects a report whose head differs from the current Git HEAD or whose complete JSON body no longer matches the hash stored in state.
It is current only while those inputs still match.
A source, PRD, suite, or evidence change makes it stale and requires a new run.

Agent review may start on any committed head before the full verification; it receives the current verification verdict, and delivery still requires a current PASS.
It runs through the current runtime's native subagent facility and stays outside Sasu CLI state.
A reviewer timeout or interruption is `REVIEW_UNAVAILABLE`, not a failed suite or product verdict.

Use synthetic or non-production data for writing scenarios.
Do not put secrets or production personal content in fixtures, logs, reports, or review prompts.
A fixture or stub result does not claim a live integration succeeded.
