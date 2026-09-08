# Full implementation process extraction

This directory contains read-only analysis tooling for the sequential old and new implementation runs.
It does not run Sasu, invoke a judge, inspect model reasoning, or alter a run.

`inputs.final.json` contains the root-provided final paths and session IDs for this pair.
Keep `handoffAt` absent when the transcript's first native user message is the actual implementation handoff, or set it explicitly to the coordinator-recorded handoff timestamp.

Run:

```sh
node /tmp/sasu-full-implementation-comparison/analysis/extract-process.mjs \
  --config /tmp/sasu-full-implementation-comparison/analysis/inputs.final.json \
  --out /tmp/sasu-full-implementation-comparison/analysis/process-metrics.json
```

The extractor reports request-to-receipt and run-to-receipt clocks, phase interval unions, resource sums, executor and judge token usage, and every observed nonzero command or verification result.
Required-suite and judge intervals come from CLI state rather than the enclosing `verify` tool call, avoiding nested-duration double counting.
Any remaining time inside the handoff-to-receipt window is reported as unattributed instead of assigned from model reasoning.
Completed native turn gaps are retained so preparation correction and resubmission time remain visible.
Exact local skill reads and pinned CLI use are checked from observed tool inputs rather than skill discovery metadata.
If `prepare-run` predicted a different state path from the actual CLI topic path, supply both `predictedStatePath` and `statePath`; the discrepancy is preserved rather than rewritten.

Raw old v1 and new v2 benchmark reports would stay embedded separately and would not be declared schema-compatible.
For this pair, both native reporter attempts exited 1 because the prepared run directory differed from the actual CLI run directory; those attempts and hashes are embedded instead.
The comparison anchor is the exact six Behavior texts, shared product base commit and tree, identical starter hashes, and observed runtime model and effort.

After extraction, render the concise process-only report with:

```sh
node /tmp/sasu-full-implementation-comparison/analysis/render-summary.mjs \
  /tmp/sasu-full-implementation-comparison/analysis/process-metrics.json \
  /tmp/sasu-full-implementation-comparison/analysis/report.md
```
