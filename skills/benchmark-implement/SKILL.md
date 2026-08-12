---
name: benchmark-implement
description: |
  Run an approved PRD through the existing receipt-backed implement workflow, analyze its runtime session with a fresh independent evaluator, emit a deterministic process report, and compare it with an earlier run.
  Use when the user invokes "$benchmark-implement", asks to benchmark the implement skill or harness, rerun a fixed PRD after harness changes, analyze implementation-session efficiency, or compare baseline and candidate harness behavior.
---

# benchmark-implement

Benchmark the harness process, not the subjective quality of the implemented product.
Keep this skill as a thin wrapper around `$implement`: it prepares one isolated run, delegates implementation, gathers that run's records, requests one independent session evaluation, and builds `report.json`.

## Read Before Running

Read:

- [`references/contracts.md`](references/contracts.md) before creating or changing a benchmark case, generating a report, or comparing runs.
- [`references/evaluator-rubric.md`](references/evaluator-rubric.md) before launching the evaluator or accepting `qualitative.json`.
- `~/.codex/skills/implement/SKILL.md` completely before starting the implementation run, then follow every implement reference that applies.

The Claude install substitutes the corresponding `~/.claude/skills/` path and `/implement` invocation.

## Artifacts

Keep fixed inputs outside the harness bookkeeping namespace:

```text
benchmarks/<case-id>/prd.md
benchmarks/<case-id>/benchmark.json
```

Keep every run result under `agents/**`, which is excluded from judged implementation diffs:

```text
agents/benchmarks/<case-id>/<run-id>/qualitative.json
agents/benchmarks/<case-id>/<run-id>/report.json
agents/benchmarks/<case-id>/<run-id>/run.json
agents/benchmarks/<case-id>/<baseline>-vs-<candidate>.json
```

Do not copy the full transcript into the report.
Store its path and hash, and cite stable session event identifiers in qualitative evidence.

## Required Flow

```text
prepare a fresh worktree and reserve a run ID
  -> delegate the approved PRD to $implement
  -> wait for receipt.json, including honest partial or blocked receipts
  -> locate the raw runtime transcript
  -> fresh read-only evaluator produces qualitative.json
  -> deterministic reporter produces report.json
  -> optional deterministic baseline comparison
```

### 1. Validate The Case

Require `benchmark.json` using `sasu.benchmark-case.v2`.
Require an approved PRD, expected terminal statuses, required and forbidden stages, `falseCompleteAllowed: false`, and the fixed evaluator models.
Require `environment.mode: "fresh-worktree"`, an explicit base ref, and at least one product path that must be absent at that ref.

Use these evaluator defaults unless the user explicitly changes the benchmark contract:

- Claude Code: `opus`
- Codex: `gpt-5.6-sol`

Record the actual executor runtime and model separately from the evaluator.
Never silently replace an unavailable requested evaluator model.

### 2. Prepare The Run

Use the same PRD, benchmark contract, starting commit, initial worktree state, executor runtime, and executor model when the intent is a causal before-and-after comparison.
Every invocation that asks to run the benchmark must begin with:

```sh
node ~/.codex/skills/benchmark-implement/scripts/benchmark_report.js prepare-run \
  --case benchmarks/<case-id>/benchmark.json
```

Use only the returned worktree, PRD path, run directory, gates path, result directory, and run ID for the remainder of that invocation.
The command atomically reserves the next run ID, creates a detached disposable worktree from the contract's base ref, proves the declared product path and the implement run namespaces are absent, copies the fixed case inputs, and writes `run.json` with the initial snapshot.
If preparation fails, stop and report the recorded `prepare-failed` result.
Never fall back to the caller's worktree, an existing `agents/implement/**` directory, or an earlier report.
Existing reports may be read only when the user explicitly asks to analyze or compare existing runs.

When coordinates differ, still emit both reports but let `comparison.json` mark them non-comparable.
Do not explain away that result in prose.

### 3. Run Implement

Change into the prepared worktree and invoke `$implement` with the prepared PRD path.
Let that skill own init, task execution, verification, review, finalization, and its receipt.
Do not reproduce or bypass implement commands in this skill.
Treat `complete`, `partial`, and `blocked` receipts as analyzable outcomes.
Do not call a partial or blocked run successful unless its case contract expected that terminal state.

The implementation clock ends at receipt creation.
Evaluation time starts afterward and must not be added to implementation wall-clock time.

### 4. Analyze The Session Independently

Locate the transcript after the receipt exists:

```sh
node ~/.codex/skills/benchmark-implement/scripts/benchmark_report.js locate-session \
  --runtime <claude-code|codex> \
  --session-id <session-id>
```

Choose the evaluator from the implementation run's executor runtime, not from whichever runtime is coordinating the later analysis.
Launch exactly one fresh read-only evaluator:

- In Codex, spawn with `fork_turns: "none"` and model `gpt-5.6-sol`.
- In Claude Code, launch a fresh subagent with model `opus` and no inherited conversation summary.

When a Codex coordinator analyzes a Claude Code run, it must still obtain an Opus evaluation or mark evaluation unavailable, and vice versa.

Give it only:

- the benchmark contract and evaluator rubric;
- the raw session transcript;
- that run's `receipt.json`, `state.json`, and `gates.json`;
- paths needed to verify cited events.

Do not give it baseline scores, candidate expectations, prior conclusions, suspected bugs, or product-quality opinions.
Ask it to return only `sasu.benchmark-qualitative.v1` JSON.
Measure the evaluator wall clock separately.
The coordinator adds that measured duration, validates the response, and writes it as `qualitative.json`; the evaluator stays read-only.

If the transcript or requested model is unavailable, record `coverage: "unavailable"`, null scores, and the concrete reason.
Do not substitute a weaker evaluator or infer unseen session behavior.

### 5. Generate The Report

After saving the evaluation, run:

```sh
node ~/.codex/skills/benchmark-implement/scripts/benchmark_report.js report \
  --case benchmarks/<case-id>/benchmark.json \
  --run-id <case-id>-run-N \
  --run-dir <prepared-worktree>/agents/implement/<topic> \
  --runtime <claude-code|codex> \
  --model <actual-executor-model> \
  --session-id <session-id> \
  --session <transcript.jsonl> \
  --qualitative agents/benchmarks/<case-id>/<run-id>/qualitative.json
```

The reporter first proves that the receipt belongs to the prepared worktree and initial snapshot.
It then calculates statuses, stages, timing, retry counts, repeated identical-diff judgments, hashes, and comparability coordinates.
The evaluator judges only process behavior such as flow adherence, recovery, review efficiency, evidence honesty, and session efficiency.

Do not score UI taste, entertainment value, code elegance, visual polish, or general product quality.
Contract satisfaction remains a harness fact, not an evaluator taste score.

### 6. Compare Runs

Compare schema-valid reports only; `outcome.validRun` may be false and remains part of the comparison:

```sh
node ~/.codex/skills/benchmark-implement/scripts/benchmark_report.js compare \
  --baseline agents/benchmarks/<case-id>/<baseline>/report.json \
  --candidate agents/benchmarks/<case-id>/<candidate>/report.json
```

Read the comparison as a delta sheet, not proof that every negative duration is an improvement.
A faster run that missed required stages remains invalid.

## Completion Contract

Report the following to the user:

- actual terminal state and whether it matched the case;
- report path and, when requested, comparison path;
- comparability failures;
- important process findings with evidence;
- unavailable session or evaluator coverage;
- implementation time and evaluation time as separate values when both are known.

Never claim the benchmark passed solely because `report.json` was written.
