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

Agent review begins only after deterministic PASS.
It runs through the current runtime's native subagent facility and stays outside Sasu CLI state.
A reviewer timeout or interruption is `REVIEW_UNAVAILABLE`, not a failed suite or product verdict.

Use synthetic or non-production data for writing scenarios.
Do not put secrets or production personal content in fixtures, logs, reports, or review prompts.
A fixture or stub result does not claim a live integration succeeded.
