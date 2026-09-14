# Impact-scoped re-review and same-input lane repair

Status: implemented on branch `incremental-review`; deterministic regression and live before/after measurement recorded below.
Issue: [yansfil/sasu#3](https://github.com/yansfil/sasu/issues/3).

## Approved change in direction

The user approved replacing whole re-review on every correction with impact-based re-review, whole review where the impact is broad, and preservation of a settled independent review when only its peer failed on the same input ("2번 작업도 마찬가지로 issue로 뽑고 sasu쪽에 pane 만들어 fable5.1로 ㅇㅇ 그래서 그 이슈진행하게 해").
Whole-contract tracking, independence, fixed inputs, immutable settled judgments, the lease, bounded convergence and the error/defect distinction are unchanged.
No override, project knob, suite cache or test-skipping switch is added.

## Measured motivation

The herdr `guarded-agent-prompt` run (`agents/runs/guarded-agent-prompt/state.json`, 2,478 product files, 10 requirements) recorded seven attempts.
Attempt `75ed15ab` settled Fidelity as a valid FAIL in 451 s (28 reads, 485,953 chars) and lost Code to a Claude turn cap after 763 s; the attempt was ERROR and both results were discarded for the next round.
Attempt `289fc0fc`, after a two-file fix, reviewed everything again: 513 s, Fidelity 63 reads and 228,754 chars, Code 31 reads and 425,684 chars.
Its round context said "changed paths since the prior attempt: none" because the prior attempt had been interrupted before review; the two changed files were not named.

## The three rounds

```mermaid
flowchart LR
    V[verify] --> S[sealed suite executes, every attempt]
    S --> P{harness plans the review}
    P -->|first submission, or contract / intent / suite / amendment / policy changed| F[full: every lane, whole contract]
    P -->|unchanged contract; an anchor settled every lane| C[focused: every lane, delta + anchor grounds; carried only on unchanged evidence]
    P -->|same review input; previous attempt lost a lane to a backend error| R[repair: lost lanes rerun; settled lanes reused with carriedFrom]
    F --> L[one attempt, one lease, one ledger]
    C --> L
    R --> L
```

Example.
A run with B1..B3 passes its first verify (full).
The implementor changes `implementation.txt` and verifies again: the round is focused, anchored on attempt 1; Fidelity is shown its own attempt-1 grounds, marked "cites changed evidence; re-review" for the group citing `implementation.txt` and "cited evidence unchanged; may be carried" for the group citing `helper.txt`; it re-reviews B3 and carries B1 and B2; Code re-reviews the change and its callers.
Status says `Review scope: focused (reference attempt 1)` and `Requirement grounds: 1 reviewed in this attempt, 2 carried from <attempt 1>`.
If Code had failed with a backend error on that round, the next verify on the unchanged input would be a repair: the suite runs again, only Code is invoked, Fidelity's settled record is reused under `carriedFrom`, and Code sees the findings ledger exactly as Fidelity saw it.

## Implementation

`cli/src/implement/review-scope.ts` plans each attempt from the record: `planReview` returns the mode, the reason, the reference attempt, the ledger the reviewers are shown and the round context.
The anchor of a focused round is the last attempt that settled every required lane without error; the delta and every carried ground are checked against it, so changes across intervening partial attempts count as changed.
A repair requires the previous attempt to have errored inside review with at least one settled lane, an equal `inputFingerprint`, an equal review policy, no accepted domain command since, and pinned repair records; the freshly prepared review context must then reproduce the previous attempt's `identity` or every lane runs.
Attempts pin `contractFingerprint` (the input identity without source and evidence) and `reviewPolicySha256` (CLI contract version, judge routing, review profile); the review context pins `scope`, `identity` and `ledgerSnapshot`; lanes reused on a repair carry `carriedFrom`; the attempt records `reviewScope`.
`validateImplementationReviewResult` accepts `basis: carried` only in a focused round, only for a satisfied ground the same role settled at the anchor, on evidence cited there and unchanged since, never for a requirement an open blocking finding names, and never in a round the reviewer declared widened.
`reconcileAttemptLedger` rebuilds a repair round's ledger from the pinned snapshot with the reused role first, so its finding ids survive and nothing is entered twice.
The prompt adds `REVIEW SCOPE` instructions and the role's own anchor grounds; the peer's grounds are never shown.
Status, the verify result and the receipt report the mode, the reason and `requirementGrounds`.
Records made before this change have no scope fields and are read as full reviews; they cannot anchor a focused round or a repair, so an active run continues with full rounds until it produces a settled attempt under the new CLI.

What leaves: the whole re-review of an unchanged contract on every correction, and the discard of a valid settled lane when its peer fails.
What is added: one planning module, six optional record fields, one optional assessment field and one optional result field; no command, flag or configuration key.

## Acceptance

- Deterministic (`cli/test/e2e/implement-incremental-review.test.mjs`, unit suites for review-scope, review-contract, convergence, store): first round full; focused round shows anchor grounds and records carried grounds and requirement grounds; carried on changed evidence, reopened requirement or outside a focused round refused; amended contract widens to full; repair reruns only the lost lane, reuses the peer byte for byte, hides the peer's finding from the rerun role, keeps finding ids, executes the suite again, counts one correction round; a moved input refuses repair and both roles run.
- Live (`docs/audits/2026-09-14-incremental-review/`): the same fixture, contract and routine judge profile through the main build and this branch, one round sequence each.

## Live measurement

See the audit directory for the protocol, raw records and the comparison table.
