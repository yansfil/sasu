---
name: implement
description: |
  Project-local approved-PRD implementation executor and Observer entrypoint.
  Use when the user invokes "$implement", explicitly asks to execute an approved
  PRD, or wants the complete PRD implemented, verified, reviewed, and delivered.
  Do not use for ordinary implementation requests that have no approved PRD.
---

# implement

Implement the complete approved PRD, prove the current Git state with deterministic checks, and ask visible native subagents for advisory review.
Match the user's language.

```text
approved PRD -> implement, focused checks, and real-behavior observation -> commit
  -> native Fidelity and Code subagents in parallel on the committed head, verification verdict disclosed
  -> fix current-scope bugs -> commit -> focused checks -> follow-up review with the prior context
  -> sasu implement verify on the final committed candidate: required suites + source/evidence integrity
       PASS: ship when the last reviewed head is the report head and evidence is unchanged; otherwise one follow-up review
       FAIL: reproduce the failed command, fix, commit, verify again
  -> local delivery or GitHub PR with CI and human review
```

An integration-risk change may run an earlier full verify; the execution plan names when.

`state.json` stores the sealed contract and suite, evidence registrations, advisor request budget, and the current deterministic report identity.
Hide owns live identities, parent relationships, watches and letters.
Sasu never copies native session or terminal identities into the run record.
`verification-report.json` and `verification-report.md` describe the current verified input.
They are fresh derived results, not completion tokens.
Agent reviews are ordinary Markdown advice and never become CLI state or delivery authority.

## Reference Routing

Read each linked reference completely when its condition applies.

| Reference | Read when |
| --- | --- |
| [`references/observer-and-herdr.md`](references/observer-and-herdr.md) | Before direct execution or supervision in Herdr. |
| [`references/execution-planning.md`](references/execution-planning.md) | Before implementation planning or when requirements overlap learned rules. |
| [`references/verification-and-evidence.md`](references/verification-and-evidence.md) | Before running checks or collecting runtime evidence. |
| [`references/verification-environments.md`](references/verification-environments.md) | Before browser, native, mobile, terminal, or other runtime observation. |
| [`references/reviews-and-finalization.md`](references/reviews-and-finalization.md) | Before native agent review, fixing review findings, or preparing the final report. |
| [`references/worktrees-and-delivery.md`](references/worktrees-and-delivery.md) | When a worktree or PR delivery is involved. |

## Role And Ownership

Resolve the live Hide parent relationship before any repository write.
The user-facing session is the Observer and its delegated Implementor owns source changes.
The Implementor never dispatches another Implementor recursively.
Native review subagents are review workers inside the current runtime, not additional Implementors and not hidden CLI judges.

Run `sasu implement intake` before start when dirty source may already exist.
Use the user's chosen complete attribution when `start` reports dirty paths.
Do not touch unrelated user or sibling changes.

## Start And Implement

```sh
sasu implement start --prd <approved-prd-path>
```

Under Hide the Observer seals the run with `start`, asks `dispatch` for the handoff command, then runs the returned `hide agent spawn --parent here` command directly.
The Implementor reads the sealed run using the explicit state path in its handoff.
Retry the same spawn intent after an interrupted response; Hide owns child reuse and startup recovery.
Outside a managed runtime, the implementing session runs `start` in the selected checkout and continues there.
Read the complete approved PRD and its decisions before editing.
Write the execution plan from `references/execution-planning.md` before the first source change.
Implement every required behavior and perform actual browser, native, API, database, CLI, or document observation appropriate to the product.
Register material evidence with `sasu implement artifact`.

Concrete bugs found while implementing or reviewing may be fixed in the same change when they affect the approved behavior, touched flow, necessary error path, or regression coverage.
Do not silently add product behavior, change authorization or data policy, broaden destructive effects, or make unrelated refactors.
Those become a human decision or a Follow-up improvement.

Commit coherent work during long implementations.
Commit before every review request: reviews are requested only on committed heads, and the reviewed SHA goes into the review handoff.
The final candidate is committed before its full verification, so the report binds the exact Git HEAD that delivery will use.

## Native Agent Review

Request the first review once the implementation is committed and its focused checks and observations have run; a full deterministic PASS is not a precondition for review, only for delivery.
Give reviewers the reviewed SHA, the focused checks actually run, and the current verification verdict from `sasu implement status` (`NOT_RUN`, `STALE`, `FAIL`, or `PASS`), stated honestly.
The first review covers the complete contract; behavior no check or observation has reached stays unverified and is never inferred from code existence.
For a follow-up review, also hand off the actual previously reviewed HEAD, findings, coverage, dispositions, intervening diff, and approved contract or evidence changes.
Reviewers check closure and impact first while remaining responsible for the complete contract; a prior verification result alone is not prior review coverage.
Use the runtime's native subagent facility directly: the Agent tool in Claude Code, `spawn_agent` in Codex.
Never use a Sasu judge command, a hidden background model process, or a Herdr pane; `herdr agent start` creates a peer agent, not a subagent, and its output never returns to the Implementor as a review.
Sasu imposes no reviewer turn limit.
Use the `reviews-and-finalization.md` reference above for reviewer scope and disposition rules.

## Review Disposition

Assess every Fix now item yourself before changing code.
Fix valid findings that stay inside the current scope.
Record rejected or unresolved findings with a short reason so the PR shows the judgment.
Place useful nonessential work under Follow-up improvements.

When a fix changes source or material evidence:

1. commit the coherent fix;
2. run the focused check for it, then request the follow-up review on that commit with the previous review context and fix evidence;
3. run the full `sasu implement verify` on the final committed candidate;
4. replace the earlier PR summary with the current result.

There is no correction budget or PASS-seeking loop.
One review set is requested for each head the implementor presents as current.

## Deterministic Verification

Run the full verification on the final committed candidate.
Run it earlier only when the execution plan names an integration boundary whose first connection needs it, or when project instructions require it.

```sh
sasu implement verify
```

This command:

- checks the sealed PRD and current source identity;
- runs every sealed required suite;
- records the real command, exit code, duration, and log;
- verifies registered evidence bytes and source stability;
- writes the current `verification-report.json` and `verification-report.md`.

It does not start reviewers, parse model output, count turns, retry a model, maintain findings, or decide whether a PR may merge.
Any source or evidence change makes the earlier report stale.

After deterministic verification, follow the CLI's `Next action:` response as the workflow continuation.
On PASS it states the follow-up condition: when the last reviewed HEAD equals the report head and the registered evidence set is unchanged since that review, continue to ship; otherwise request one short follow-up review of the diff with the prior context.
On FAIL or ERROR it names the failed required commands, or the error that stopped the run: reproduce only that failure in isolation, fix, commit, and run the full verify again.
It also states when consecutive FAIL attempts ran on identical input; a rerun without a change is a diagnostic reproduction, not a fix.

## Blocks And The Completion Notice

`sasu implement status` reports the current contract, suites, evidence and verification.
Inspect runtime liveness with `hide agent list` and `hide agent show <id>`.
Send an execution plan with `hide request send <observer> --intent <stable-key> --body <plan>` and continue working while the Observer reviews it.
A blocked Implementor sends `hide request send <observer> --kind block --intent <stable-key> --body <question, recommendation, reversibility and scope impact>` and ends its turn.
The Observer reads `hide inbox` and answers with `hide request reply <id> --intent <reply-key> --body <answer>`.
Right before its final report, the Implementor sends `hide request send <observer> --kind report --intent <stable-key> --body <current verification and review result>`.
A report letter requests inspection; it is not a completion verdict.
Hide owns notification delivery and watch completion.

## Delivery

After the current deterministic report is PASS and its follow-up condition is settled, use `$ship` for the already authorized local or PR delivery.
The PR body includes:

- current PRD, base, head, tests, and evidence;
- review availability;
- Fix now items and their disposition;
- Follow-up improvements;
- remaining human review focus;
- screenshots or other reviewer-visible evidence when applicable.

GitHub Actions reruns repository checks from the pushed head.
Human review and repository merge rules are the final authority.
High-risk changes require the repository's independent specialist review and explicit human merge approval.

## Commands

| Command | Required | Notes |
| --- | --- | --- |
| `intake` | none | read-only |
| `start` | `--prd` | Observer under Herdr; the implementing session outside Herdr |
| `dispatch` | current run and initial context | prints a complete spawn command and a handoff file; Observer executes the command directly |
| `status` | optional `--state` or `--slug` | read-only contract and verification facts |
| `artifact` | kind, path, description | registers runtime evidence |
| `amend` | `--approval`, `--reason` | re-seals the PRD with human approval; invalidates the report |
| `escalate` | `--reason` and stable `--intent` | reserves one of three advisor requests and prints its spawn command; the advisor returns a Hide letter |
| `retire` | active run | ends the contract run; runtime cleanup remains with Hide |
| `verify` | current run | runs the sealed suite and writes the report |

Mutating commands take an optional `--issuer implementor|observer|human` audit label; it grants no authority.
Role restrictions use current Hide registration and its parent relationship.
Changing a native terminal or session during handoff or compaction does not transfer Sasu ownership because Sasu stores neither identity.
The verification lease still excludes concurrent run mutations.

Use Hide directly for spawning, watches, inbox intake, replies and reports.
The former session adoption, pending dispatch recovery, supervisor registry and handover machinery is removed.
Old run schemas require their matching CLI; finish old runs before installing this version.
After three distinct advisor requests, ask a human for a decision and report the attempted approaches.
Retrying one advisor intent does not consume another request.

## Final Report

Report the implemented outcome, current verification-report paths and status, actual tests and observations, native review availability, Fix now dispositions, Follow-up improvements, PR or local delivery result, CI state, and remaining human review.
Never call an unavailable review PASS.
Never call a stale report current.
