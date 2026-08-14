# Benchmark Contracts

## Case Contract

Place one `benchmark.json` next to the fixed PRD.
Paths in the contract are relative to the case file.

```json
{
  "schema": "sasu.benchmark-case.v2",
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
      "init",
      "implementation",
      "verification",
      "verify-gate",
      "requirements-fidelity",
      "finalize"
    ],
    "forbiddenStages": ["final-adversarial-review"],
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
Preparation writes `sasu.benchmark-run.v1` to the reserved result directory before implementation starts.
That record binds the run ID, worktree, copied case inputs, base commit, and initial worktree snapshot.
The deterministic reporter rejects receipts that do not match the binding.

Allowed stage names are:

- `init`
- `implementation`
- `verification`
- `verify-gate`
- `requirements-fidelity`
- `final-adversarial-review`
- `finalize`

`terminalStatuses` may contain `complete`, `partial`, or `blocked` according to the scenario.
A declared-blocker case should expect `blocked`; treating only complete as success would reward dishonest completion.

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
      "reason": "Only the profile-required review ran.",
      "evidence": ["receipt:/reviewPolicy", "receipt:/reviewRounds"]
    },
    "evidenceHonesty": {
      "score": 4,
      "reason": "The partial result exposed its open verification.",
      "evidence": ["receipt:/status", "receipt:/counts"]
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

The deterministic reporter owns `sasu.benchmark-report.v1` and `sasu.benchmark-comparison.v1`.
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
The process score is present only when all five rubric dimensions are scored.
It is not a product-quality score.

## Comparability

`comparison.json` is strictly comparable only when these coordinates match:

- benchmark case hash;
- PRD hash;
- starting HEAD;
- starting worktree status hash;
- executor runtime;
- executor model.

The reporter still emits deltas when coordinates differ, but marks the comparison non-comparable and lists every reason.
