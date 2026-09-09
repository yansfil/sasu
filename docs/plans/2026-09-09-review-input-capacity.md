# Complete review input capacity and deterministic failures

Status: proposed; diagnosis and read-only replay complete, implementation and live review unrun.

## Incident and verified boundary

The requested session `01a08578-1fb7-70f2-955e-b342f881e2ec` is the delegated Implementor for `vibecoding-class` topic `level-test-audience-results-ranking`.
Its handoff names the `implement` pipeline and preserves the original autonomous invocation; the session itself does not invoke `please` again.
The authoritative attempt is `e6dae1e0-a02e-4da8-89bc-0fea13bdfcf3`, recorded on 2026-09-09 from 10:04:11.958Z to 10:04:27.621Z.
Required checks passed: admin 1,653 ms, build 5,349 ms, and typecheck 787 ms.
Fidelity, Code, and high-risk review all returned `ERROR`, with no semantic result, because the local adapter rejected their input before starting the substantive review.
The exact error is `prompt exceeds codex argv budget (400k chars); reduce gate input`, classified as `judge-invalid-output` with reason `input-too-large`.
Each role records two rejected attempts; these are local rejections, not six completed model reviews.
The runner can execute an `OK` backend preflight before discovering the oversized substantive input.
Images prevent a fallback to a backend without attachments, preserving the evidence boundary.

The current run remains `active`, with one verification attempt, no active verification lease, no completion, and no receipt.
A later checkpoint commit `2b3bcbd` contains the product changes; this is distinct from successful post-receipt local delivery.
The source fingerprint still matches the failed attempt: `3123e8295ecf28d5cd5ebe8ff181961f06631bd197d97434b907fe952ffedee1`.
All 52 entries across its source and evidence manifests matched their recorded file hashes during this investigation.
No product source, run state, approval, budget, or verification result was changed.

## Reproduction and measurements

Read-only reconstruction used the installed `cli/dist` renderer, the pinned PRD, recorded review context and logs, and the matching source files.
Calling the real adapter's admission boundary with the reconstructed oversized input twice produced the identical error without launching a model or mutating the run.
Temporary reconstruction artifacts are at `/tmp/review-input-audit-zyM9kP/`; they are diagnostic artifacts, not completion evidence.

| Role | JavaScript string length | UTF-8 bytes |
| --- | ---: | ---: |
| Fidelity | 448,688 | 531,545 |
| Code | 448,838 | 531,695 |
| Risk | 443,803 | 526,660 |

The source catalog contains 1,080 paths and consumes 66,337 characters before its heading.
It is repeated inside the 1,125-entry valid-evidence reference list.
The complete diff is 95,408 characters, current source bodies are 95,738 characters before formatting, and raw additional text evidence totals 58,691 characters.
The current renderer independently bounds some sections at 120,000 characters but does not bound the assembled envelope.
It also repeats canonical Decisions and quotation sources; those repetitions are smaller and must retain their authority semantics when normalized.

| Fidelity rendering experiment | Characters | Meaning |
| --- | ---: | --- |
| Current | 448,688 | Rejects before review |
| Remove the second catalog-sized reference enumeration | 384,071 | Size-only experiment; catalog remains available |
| Also reference complete current bodies through the existing allowlist | 285,880 | Size-only experiment; no source bytes deleted |

These experiments establish removable presentation cost, not equivalent review quality or successful live execution.
The 400,000-character threshold is a harness guard, not an observed provider context-window rejection or an actual operating-system `E2BIG` result.
The host reports `ARG_MAX=1048576`; the renderer's character count is not an argument-byte measurement.
The installed CLI is 0.153.4 and its help advertises stdin input; the adapter's stdin-hang comment cites 0.144.1.
Neither reliable stdin execution nor a safe replacement argv limit was established in this investigation.

## Proposed implementation

1. Make complete-input rendering obey one aggregate budget in `cli/src/implement/prompts.ts`, wired through `commands.ts`.
   Keep the full PRD, complete contract scope, authority, execution facts, findings history, and evidence provenance available to every role.
   Render the catalog once and define valid evidence references as the union of the already supplied catalog, contract references, and readable paths; preserve the complete validator reference set.
   Spend the remaining inline budget on useful complete source and evidence bodies, referring overflow to existing exact, pinned, allowlisted files.
   Keep deleted diff hunks intact; any large-diff file representation must preserve the complete diff rather than substituting current files for deleted behavior.
   Keep images attached, and keep catalog metadata separate from permission to read file contents.
   Measure the final serialized envelope, adapter preamble, retry reserve, and UTF-8 transport bytes before admission; report section sizes and the failed limit without copying private source into errors.
2. Reject deterministic input admission failures before backend canaries and substantive calls in `cli/src/judge/backends.ts` and `runner.ts`.
   Use the existing structured `input-too-large` reason to skip the invalid-output correction retry for an unchanged oversized envelope.
   Record an input-preparation failure with zero substantive review executions and a concrete repair instruction; preserve any required suites already executed.
   Preserve the active run, existing attempt history, whole-verify lease cleanup, and convergence limits.
   Do not add a retry flag, a project input-size knob, a new review stage, or a per-requirement ledger.
3. Verify the complete path before adopting a different transport.
   Reuse the existing isolated evidence workspace and `runProcess` input support before adding a parallel mechanism.
   Run a bounded stdin spike on the installed CLI with EOF, images, output validation, timeout, process cleanup, and command auditing before deciding whether to replace positional prompt transport.
   A working stdin path removes argv pressure but does not remove context size, repeated information, or unnecessary review reads; retain aggregate input accounting either way.

This follows repository principles 1 and 2 together: preserve the whole contract while reducing verification overhead.
Principles 3 and 7 put input assembly and error disposition in the harness instead of asking the workflow user to trim the PRD.
Under principle 4, aggregate admission and single reference rendering replace scattered assumptions and duplicate lists; deterministic rejection replaces the futile retry.
Engineering principles 7 and 13 favor the existing evidence reader and a general input-capacity boundary over a case-specific threshold increase.

## Acceptance and measurement plan

- Add a synthetic CLI-level regression with a large unrelated path inventory, Korean text, all 23 behavior references, shared QA evidence, screenshots, and changed/deleted source.
- Assert every required contract and evidence byte remains available, deleted hunks survive, and catalog-only paths never become readable merely by appearing in a reference list.
- Cover the final transport-budget boundary on both sides, including adapter and retry overhead; oversized immutable input must not consume an invalid-output retry or backend preflight.
- Plant a missing behavior, a lost deletion hunk, and a dropped evidence file to prove that reduced presentation does not silently pass incomplete input.
- Retain lease, immutable history, peer-review isolation, image fallback, and command-audit protections in the existing verification suites.
- Before a commit touching `cli/`, clean generated `cli/dist` only in the owned implementation worktree, then run build, root tests, CLI tests, and CLI e2e in the repository-required order.
- Run the same complete actual case through live independent Fidelity, Code, and Risk review; compare input bytes, reads, retries, wall time, and semantic coverage, and inspect the transcript.
- Count model preflights separately from substantive reviews and local admission rejections; do not infer model executions from `attempts` alone.

The repository-wide suite requirement overrides engineering principle 12's low-impact testing default for this CLI change.
Unit or fixture success alone does not establish live completion, per repository principle 9.

## Recovery of the existing implementation

After the harness fix is verified and its installed entrypoint is confirmed, coordinate with the existing Implementor owner and recheck source, PRD, and evidence freshness.
Resume the existing active run through `verify`, retaining the failed attempt and all required checks; this investigation did not authorize a budget reset or manufacture a review result.
There is currently one failed verify attempt, so a budget extension should not be presumed necessary; check the live terminal-budget decision before using any human-only extension.
Finalize and local delivery follow only after current independent review succeeds or another genuinely terminal condition is recorded.
The checkpoint commit cannot substitute for that completion and delivery evidence.
