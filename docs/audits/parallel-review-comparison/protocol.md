# Unified versus parallel review experiment

Status: approved comparison, implementation and live measurements pending.
Baseline source: `3f549dcfff71fe1f7fa974a383f6e8a055ce8463`.
Candidate branch: `experiment/parallel-review`.
This experiment does not change the installed workflow or authorize a production rollout.

## Question

Does replacing one comprehensive reviewer with concurrent Fidelity and Code review improve defect detection or completion time enough to justify the extra model execution?
The comparison must include repair and receipt creation, not just a successful review call.

## Shared workflow

```text
User <-> Observer
             |
        Implementor
        implement, focused QA, repair
             |
        sasu implement verify
             |
        same sealed required suites
             |
       +-----+-------------------------+
       | baseline                     | candidate
       |                              |
       comprehensive review           Fidelity + Code review
       |                              | run concurrently
       +-----+-------------------------+
             |
        one findings/history loop
             |
        current PASS -> finalize -> receipt
```

The Observer owns user conversation, delegation, liveness and exception recovery.
The Implementor owns implementation, actual QA, fixes, verification and completion.
The CLI remains the sole state writer and invokes independent read-only reviewers.
Neither reviewer writes product code or executes the product.
The Observer does not repeat the Implementor's tests or become an additional code reviewer.
Native benchmark sessions retain the benchmark skill's in-session execution exception in both arms.

## Candidate boundary

- Fidelity checks the entire approved contract, canonical user intent and observable behavior, including omissions and explicit human authority.
- Code review checks concrete implementation defects, integration and failure paths, and consequential maintainability problems in the supplied source context.
- Cosmetic preferences and speculative improvements do not become blocking repair requests.
- Both receive the same complete contract and pinned source/evidence access; emphasis differs, evidence authority does not.
- The two roles replace the existing general comprehensive review; there is no third general judge.
- Existing high-risk review policy stays separate and unchanged; the first paired case is routine risk.
- One user-facing `verify`, one source identity and execution lease, one attempt budget and one findings history remain.
- There are no per-requirement lifecycle commands, PASS objects, mandatory evidence files or new project settings.
- A partial failure remains explicit; one successful reviewer cannot conceal the other's error or missing result.
- Record each review's actual result, timing, backend/model, retries and trace without attributing two executions to one fictional call.
- Preserve the current strict source/reference and human-quote boundaries, bounded closure and current-source completion checks.
- Reuse existing finding validation and reconciliation where possible; do not add a third generative merger or collapse distinct defects merely because they cite the same requirement.

## Measurements

First freeze quality cases before the candidate's live calls.
Reuse existing complete, middle omission, final omission, unwired entrypoint, storage failure and authorized-assumptions cases and their exact external blocker expectations.
Retain actual image coverage separately from source-only fixtures.
If a code-review-specific case is needed, declare its concrete counterexample and expected result before either arm sees it.
Do not feed fixture truth to the reviewer or use an oracle failure to seek a different verdict through retries.

Run both arms with the same `gpt-5.6-luna` / `xhigh` target and `fallback: null` to isolate review decomposition.
Preserve all failures and distinguish protocol retries from product repair rounds.
Use the same allowed files and actual suite results for each quality pair.
Report missed defects, unrelated blockers, duplicated findings, review wall time and actual execution counts.
Content review executions, backend preflight executions and internal tool turns are different counts.
Do not claim total token cost from accepted-result usage alone.

Then run fresh product implementations from the same blank starter, approved behavior text, suite bytes, executor runtime/model and preparation protocol.
Both product arms use the current PRD shape; this is not another old-schema versus new-schema comparison.
Keep the PRD topic identical to its parent directory so prepared run coordinates and the native reporter agree.
Use Codex Sol medium for both implementation sessions.
Alternate or state execution order, and report the limitations of a small single paired sample.
Measure handoff-to-receipt, preparation, initial implementation, suites, review, repair/recovery, and PASS-to-receipt separately.
Fresh independent session evaluation runs after receipt and is excluded from implementation time.
An error or bound-exhausted run remains an outcome; never reset its state or budget to manufacture completion.

## Decision

Two reviewers are a hypothesis, not an assumed upgrade.
Retain the unified default unless measurements justify the extra execution and candidate complexity.
A candidate recommendation requires same-source checks, honest native reports, the raw run records and a concrete explanation of what the second role caught or improved.
The existing product pilot failures and old comparison records remain historical evidence and are not rewritten by this experiment.
