# Benchmark Contracts

## Case Contract

Place one `benchmark.json` next to the fixed PRD.
Paths in the contract are relative to the case file.

```json
{
  "schema": "sasu.benchmark-case.v4",
  "id": "pokemon-rpg",
  "prd": "prd.md",
  "environment": {
    "mode": "fresh-worktree",
    "baseRef": "c8c3dc9b6590b7e0e007666ce82bc25b6e1a8e1d",
    "mustBeAbsent": ["pokemon-rpg"]
  },
  "expected": {
    "terminalStatuses": ["complete"],
    "requiredStages": [
      "start",
      "verification",
      "mechanical",
      "review",
      "finalize"
    ],
    "forbiddenStages": ["risk"],
    "maxVerifyAttempts": 3,
    "falseCompleteAllowed": false
  },
  "evaluation": {
    "required": true,
    "requiredCoverage": "complete",
    "models": {
      "claudeCode": "opus",
      "codex": "gpt-5.6-sol"
    }
  }
}
```

`baseRef` identifies the clean repository state from which every run starts.
`mustBeAbsent` names product paths that make a greenfield case invalid if they already exist at that ref.
Preparation validates the fixed PRD against the current harness before reserving a run: its frontmatter must be `status: ready` and `human_approval: approved`, and `sasu prd readiness` must pass.
The runner also requires the PRD topic's implement and gate directories to be absent.
Preparation writes `sasu.benchmark-run.v2` to the reserved result directory before implementation starts.
That record binds the run ID, worktree, copied case inputs, base commit, and `initialSource` (`head`, `digest`, and `entries`) from the current source snapshot.
The report uses `run.startingTree.headSha` and `sourceFingerprint`; comparison checks complete starting source identity rather than only dirty-status shape.
The deterministic reporter rejects receipts that do not match the binding.

Allowed stage names are `start`, `verification`, `mechanical`, `review`, `risk`, and `finalize`.
In this candidate, `review` comprises separate concurrent Fidelity and Code records in `reviews.fidelity` and `reviews.code`; both use the same routine profile.
The candidate consumes `sasu.implement.state.v9.parallel-review` and `sasu.implement.receipt.v5.parallel-review` without an old-state reader.
`terminalStatuses` may contain `complete`, `complete-pending-human`, or `blocked` according to the scenario.
A declared-blocker case should expect `blocked`; treating only completion as success rewards dishonest claims.
Only these current schemas are readable; old case/report/comparison formats fail explicitly without normalization or migration.
The retired per-AC trap/twin, sealing, and park-order detector contracts are removed.

## Qualitative Contract

The independent evaluator returns `sasu.benchmark-qualitative.v1`.
Every non-null score needs at least one stable evidence reference.

```json
{
  "schema": "sasu.benchmark-qualitative.v1",
  "evaluator": {
    "runtime": "codex",
    "model": "gpt-5.6-sol"
  },
  "evaluationTiming": {
    "durationSeconds": 42.3,
    "basis": "Fresh evaluator process wall clock measured by the coordinator."
  },
  "sessionAnalysis": {
    "coverage": "complete",
    "reason": "Full transcript and receipt-backed artifacts were available.",
    "avoidableReviewCalls": 0,
    "unchangedCommandReruns": 1,
    "unexpectedUserStops": 0,
    "redundantStatusPolls": 0
  },
  "dimensions": {
    "flowAdherence": {
      "score": 4,
      "reason": "The run followed the required stage order.",
      "evidence": ["session:uuid-1", "receipt:/status"]
    },
    "recoveryDiscipline": {
      "score": 3,
      "reason": "One failed check led to a scoped fix and rerun.",
      "evidence": ["session:uuid-2", "gates:/gates/verify/history/0"]
    },
    "reviewEfficiency": {
      "score": 4,
      "reason": "Only the profile-required Fidelity and Code reviews ran.",
      "evidence": ["receipt:/reviews/fidelity", "receipt:/reviews/code", "state:/attempts"]
    },
    "evidenceHonesty": {
      "score": 4,
      "reason": "The blocked result exposed its unrun review.",
      "evidence": ["receipt:/status", "receipt:/mechanical"]
    },
    "sessionEfficiency": {
      "score": 3,
      "reason": "One unchanged command rerun added no new information.",
      "evidence": ["session:uuid-3", "session:uuid-4"]
    }
  },
  "findings": [
    {
      "severity": "P2",
      "message": "One command was repeated without an intervening relevant change.",
      "evidence": ["session:uuid-3", "session:uuid-4"]
    }
  ]
}
```

Use null for an unobservable score and explain why in `reason`.
Do not add a `productQuality` field.

`redundantStatusPolls` counts `status` calls whose answer the previous command's response already carried.
A poll that follows a state change the response did not report is not redundant; count meaning, not command names.

## Report Contract

The deterministic reporter owns `sasu.benchmark-report.v2` and `sasu.benchmark-comparison.v2`.
Do not hand-edit either file.

`report.json` separates:

- `outcome`: expected terminal state and hard validity checks;
- `flow`: observed, missing, and forbidden stages;
- `timing`: receipt-backed implementation durations plus separately measured evaluator duration;
- `efficiency`: measured retry and review facts plus evaluator classifications;
- `honesty`: false-complete, stale-input, and override facts;
- `qualitative`: evidence-backed process scores and findings;
- `sources`: hashes of every source used.

Implementation timing and post-receipt evaluation timing stay separate inside `timing`.
Actual execution metrics distinguish `wallClockSeconds`, `verificationUnionSeconds` from `verificationSumSeconds`, `commandUnionSeconds` from `verificationCommandSeconds`, and `judgeUnionSeconds` from `judgeSeconds`.
`verificationCommandRuns`, `judgeCalls`, and `judgeInvocations` count actual executions, not synthetic per-requirement outcomes.
Count Fidelity and Code as separate content review executions; concurrent overlap does not turn them into one provider call.
Preserve each role's failures and findings so duplicate or unrelated findings can be evaluated.
Efficiency records `reviewInvocations`, `riskInvocations`, `repeatedIdenticalInputReviews`, `executionErrorsByStage`, `escalationAttempts`, `diagnosedRecoveries`, and `registeredObservations`.
Registered observations count artifacts, not separate QA executions.
`answeringUsage` contains only provider-reported answering-attempt tokens and `reportedInvocations`; `usageScope` identifies missing/retry usage rather than estimating it.
The report uses current receipt/state facts, actual call/execution records, open issues, source identity, and human delivery conditions.
The process score is present only when all five rubric dimensions are scored.
It is not a product-quality score.

## Comparability

`comparison.json` is strictly comparable only when these coordinates match:

- benchmark case hash;
- PRD hash;
- starting HEAD;
- starting source fingerprint;
- executor runtime;
- executor model.

The reporter still emits deltas when coordinates differ, but marks the comparison non-comparable and lists every reason.
