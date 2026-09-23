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
approved PRD -> implement and observe the real behavior
  -> sasu implement verify: required suites + source/evidence integrity
  -> native Fidelity and Code subagents in parallel
  -> fix current-scope bugs; list later improvements
  -> rerun verify and review when source changes
  -> local delivery or GitHub PR with CI and human review
```

`state.json` stores run ownership, the sealed contract and suite, evidence registrations, and the current deterministic report identity.
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

Resolve the structural Herdr role before any repository write.
The user-facing session is the Observer and one marked Implementor owns source changes.
The Implementor never dispatches another Implementor recursively.
Native review subagents are review workers inside the current runtime, not additional Implementors and not hidden CLI judges.

Run `sasu implement intake` before start when dirty source may already exist.
Use the user's chosen complete attribution when `start` reports dirty paths.
Do not touch unrelated user or sibling changes.

## Start And Implement

```sh
sasu implement start --prd <approved-prd-path>
```

Under Herdr the Observer runs `start` before it dispatches, and the Implementor's pane opens in the tree the run edits: the Implementor never runs `start` itself, and its bare `sasu implement ...` commands already resolve the run.
Outside Herdr the session that will implement runs `start` and works in the returned worktree when one is created.
Read the complete approved PRD and its decisions before editing.
Write the execution plan from `references/execution-planning.md` before the first source change.
Implement every required behavior and perform actual browser, native, API, database, CLI, or document observation appropriate to the product.
Register material evidence with `sasu implement artifact`.

Concrete bugs found while implementing or reviewing may be fixed in the same change when they affect the approved behavior, touched flow, necessary error path, or regression coverage.
Do not silently add product behavior, change authorization or data policy, broaden destructive effects, or make unrelated refactors.
Those become a human decision or a Follow-up improvement.

Commit coherent work during long implementations.
Commit the final source and evidence changes before deterministic verification so the report can bind the exact Git HEAD that reviewers and delivery will use.

## Deterministic Verification

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
Fix deterministic failures and rerun it.
Any source or evidence change makes the earlier report stale.

## Native Agent Review

After deterministic verification, follow the CLI's `Next action:` response as the workflow continuation.
On PASS it names the native review roles, parallel execution, response sections, failure recording, and rerun condition for the exact verified head.
For a re-review, also hand off the actual previously reviewed HEAD, findings, coverage, dispositions, intervening diff, and approved contract or evidence changes.
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
2. rerun `sasu implement verify`;
3. run fresh native reviews for the new head with the previous review context and fix evidence;
4. replace the earlier PR summary with the current result.

There is no correction budget or PASS-seeking loop.
One review set is requested for each head the implementor presents as current.

## Delivery

After the current deterministic report is PASS, use `$ship` for the already authorized local or PR delivery.
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

## Commands And Authority

| Command | Required | Authority |
| --- | --- | --- |
| `intake` | none | any role, read-only |
| `start` | `--prd` | Observer under Herdr; the implementing session outside Herdr |
| `dispatch` | `--name`, `--prd` | Observer only by structural Herdr rule; after `start`; records the Observer and enrolls the run with the supervisor tick |
| `status` | optional `--state` or `--slug` | any role, read-only |
| `artifact` | kind, path, description | implementor, human |
| `plan` | `--path` | implementor, human; records the execution plan, wakes the Observer once under Herdr |
| `amend` | human approval and reason | human |
| `escalate` | reason | observer, human |
| `retire` | active run | implementor, human |
| `verify` | current run | implementor, human |

`finalize`, `confirm`, implementation `risk`, and the one-shot `await` waiter are retired.
Reviewer judgment is no longer encoded as CLI state.
Under Herdr the supervisor tick (`sasu supervisor tick`, run by a user LaunchAgent) wakes the recorded Observer; `sasu supervisor status`, `handover`, `install` and `uninstall` are its operator surface.

## Final Report

Report the implemented outcome, current verification-report paths and status, actual tests and observations, native review availability, Fix now dispositions, Follow-up improvements, PR or local delivery result, CI state, and remaining human review.
Never call an unavailable review PASS.
Never call a stale report current.
