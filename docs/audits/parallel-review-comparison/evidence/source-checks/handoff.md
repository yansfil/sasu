# Parallel review candidate handoff

Status: ready for the coordinator's frozen paired experiments.
Source ownership is released at the commit below; no further edits or live calls are running.

## Identity

- Worktree: `/Users/hoyeonlee/projects/sasu.worktrees/parallel-review-comparison`
- Branch: `experiment/parallel-review`
- Commit: `6b88d83ce325a2a871af69d4e32cdf737c6dc229`
- Tree: `9dcc328bbde0a9ee588539ef14b61d3f69b6a08f`
- Baseline: `3f549dcfff71fe1f7fa974a383f6e8a055ce8463`
- Protocol parent: `ea3131017f9a9582e6901aec52205a3108c8b6e1`
- Worktree clean after commit.
- Change size: 37 files, 805 insertions, 201 deletions.
- Source and generated dist hashes: [candidate-manifest.json](candidate-manifest.json).

## Implemented boundary

A real `sasu implement verify` now launches `implement:fidelity` and `implement:code` concurrently in place of `implement:review`.
Both receive the identical complete approved contract, intent, current shared source/evidence allowlist, strict reference and exact human-source vocabulary, suite facts, and pinned prior finding ledger.
Only their responsibility introduction differs.
Both use the existing routine profile; production model defaults and fallback routing were not changed.
The distinct high-risk check remains separate.

There is one lease, one attempt, one repair budget, one shared finding history and one current-input completion decision.
Each actual role result, error, invocation ID, timing and backend trace is persisted separately as it settles.
The owner waits for all executions even if a persistence operation fails.
Interruption recovery retains already settled findings before closing an unfinished attempt.
Existing refusal-only CAS merging and process-group cleanup remain in place.

Prior issues close only when both roles explicitly resolve them.
An error, missing result or disputed disposition retains the issue.
New findings deduplicate only on exact substantive content identity, including kind, references, evidence, action and human authority fields.
Distinct defects sharing a B reference stay separate.
Human authority cannot be resolved by reviewer agreement.

The reporter enumerates both role records, separate invocation counts and actual backend content attempts.
A preflight-only record retains its trace with zero content attempts.
A partial execution contributes to observed stages but cannot satisfy completion.
Review rounds remain verification attempts, independent of role invocation count.
The ship consumer requires both completed review records and retains current CLI eligibility/freshness checks.

## Net concepts

- Removed: the routine comprehensive execution and singular `attempt.review` / `receipt.review` fields.
- Added: the two internal role records and deterministic shared-ledger reconciliation.
- Added: isolated `sasu.implement.state.v9.parallel-review` and `sasu.implement.receipt.v5.parallel-review` identities.
- No public selector, config flag, command, user workflow stage, model merger, per-requirement result/proof object, or migration reader was added.
- Observer and Implementor responsibilities are unchanged.
- No deviation from the approved experiment boundary is known.
  The experimental schema suffix deliberately prevents baseline and candidate run adoption.

## Same-source checks

All final checks below used the committed source.
The owned previous `cli/dist` was moved aside before the final build so retired generated files could not survive.

| Command | Result | Log |
| --- | --- | --- |
| `npm --prefix cli run build` | PASS | [build-final.log](build-final.log) |
| `node --test tests/*.test.mjs` | 100 passed, 0 failed/skipped | [root-final.log](root-final.log) |
| `npm --prefix cli test` | 453 passed, 0 failed/skipped | [unit-final.log](unit-final.log) |
| `npm --prefix cli run test:e2e` | 125 passed, 0 failed/skipped | [e2e-final.log](e2e-final.log) |
| `npm --prefix cli run typecheck` | PASS | [typecheck-final.log](typecheck-final.log) |
| `git diff --cached --check` before commit | PASS | command transcript |

Focused checks included paired execution overlap, shared full inputs, one actual suite run per attempt, stable finding identity, distinct same-reference defects, disputed closure, sibling failure, human prerequisite authority, interrupted partial results and missing-review receipt refusal.
The focused recovery/store run passed 18 tests.
These fixtures prove lifecycle and wiring behavior; their reviewer answers are stubs and are not live omission-detection evidence.

## Preserved failures and environment notes

The first combined focused run passed 83 of 84 tests and failed a stale reporter fixture delta expectation.
The actual comparison was 7 minus 10 calls, so the expected delta was corrected to -3.
The failure remains in [focused.log](focused.log); the corrected reporter/ship focus passed 19 tests in `/tmp/parallel-review-consumers-built.log`.
The final root suite also includes that regression.

The initial `npm ci` installation exposed an existing lockfile-layout problem: a Node type dependency pointed at a missing `undici-types` directory.
Initial noEmit reported Response type member errors before source validation could complete.
No dependency, lockfile or API source was changed for that condition.
The owned failed install was preserved at `npm-ci-node_modules` under this log directory, then the committed pnpm lockfile was installed with `pnpm --dir cli install --frozen-lockfile --ignore-scripts`.
Subsequent noEmit and final checks passed.
The install output is [pnpm-install.log](pnpm-install.log).
An optional Perl-based hash command hit the host locale error; the manifest hashes were then computed successfully with Python.

Worker logs remain at `/tmp/parallel-review-consumers-before.log`, `/tmp/parallel-review-consumers-focused.log`, `/tmp/parallel-review-consumers-built.log`, `/tmp/parallel-review-consumer-stage-footprint.log`, and `/tmp/sasu-parallel-review-e2e-focus.log`.
No failed run or source/pilot budget was reset.

## Full production and consumer file catalog

- `cli/src/implement/commands.ts`
- `cli/src/implement/convergence.ts`
- `cli/src/implement/prompts.ts`
- `cli/src/implement/store.ts`
- `cli/src/implement/types.ts`
- `cli/src/implement/verification-activity.ts`
- `skills/benchmark-implement/SKILL.md`
- `skills/benchmark-implement/references/contracts.md`
- `skills/benchmark-implement/references/evaluator-rubric.md`
- `skills/benchmark-implement/scripts/benchmark_report.js`
- `skills/implement/SKILL.md`
- `skills/implement/agents/openai.yaml`
- `skills/implement/references/reviews-and-finalization.md`
- `skills/implement/references/verification-and-evidence.md`
- `skills/please/SKILL.md`
- `skills/ship/SKILL.md`
- `skills/ship/scripts/prd_ship.js`

## Full corresponding test and fixture catalog

- `cli/test/e2e/implement-calibrated.test.mjs`
- `cli/test/e2e/implement-defects.test.mjs`
- `cli/test/e2e/implement-envelope.test.mjs`
- `cli/test/e2e/implement-parallel-review.test.mjs`
- `cli/test/e2e/implement.test.mjs`
- `cli/test/helpers/implement-fixture.mjs`
- `cli/test/helpers/implement-live-review.mjs`
- `cli/test/helpers/implement-state.mjs`
- `cli/test/smoke/implement-acceptance-agentic.test.mjs`
- `cli/test/smoke/implement-acceptance-codex-agentic.test.mjs`
- `cli/test/unit/doctor-integrity.test.mjs`
- `cli/test/unit/implement-convergence.test.mjs`
- `cli/test/unit/implement-envelope.test.mjs`
- `cli/test/unit/implement-prompts.test.mjs`
- `cli/test/unit/implement-runner.test.mjs`
- `cli/test/unit/implement-store.test.mjs`
- `cli/test/unit/implement-verification-activity.test.mjs`
- `tests/benchmark_report.test.mjs`
- `tests/prd_ship.test.mjs`
- `tests/sasu_gate_wiring.test.mjs`

## Invocation and remaining experiment work

```sh
node /Users/hoyeonlee/projects/sasu.worktrees/parallel-review-comparison/cli/dist/cli.js --contract-version
# 0.9.0
node /Users/hoyeonlee/projects/sasu.worktrees/parallel-review-comparison/cli/dist/cli.js implement verify
```

Run the candidate command from its fresh isolated target, using that target's candidate-local skill/ship/reporter staging.
The candidate accepts only new experimental-schema states; it cannot adopt baseline runs.
The coordinator separately pins the project configuration hash because `agents/config.json` is outside source fingerprints.

No paid/live candidate smoke or product benchmark was launched.
The existing smoke helper now runs both roles with the same material and preserves each record; planted fixture generation and blocker expectations were retained.
Actual omission detection, unrelated blockers, semantic duplicate frequency, repair-to-receipt behavior, and time/resource tradeoffs remain to be measured on the frozen paired roster.
Exact deduplication intentionally leaves differently worded reports of one underlying issue separate, so those duplicates remain observable.
Conservative two-role closure may consume more bounded repair rounds; that is an experiment outcome to measure, not a waived gate.

General production README/policy documents remain the unified baseline; only candidate-facing source skill/contract consumers changed.
The coordinator-owned protocol and experiment inputs were not edited.
Main, installed global runtime/skills, previous worktrees and prior pilot states were not changed.
No push, merge, deployment or global install was performed.
