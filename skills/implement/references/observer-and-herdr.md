# Observer and runtime delegation

## Contents

- [Roles](#roles)
- [One flow](#one-flow)
- [Dispatch](#dispatch)
- [Plans, blocks and reports](#plans-blocks-and-reports)
- [Observation and recovery](#observation-and-recovery)
- [Periodic review](#periodic-review)
- [Advisor](#advisor)
- [Completion](#completion)

## Roles

The user-facing session remains the Spec Owner through interview and PRD approval, then becomes the Observer.
One Implementor owns the approved source changes.
A review worker is a native runtime subagent and supplies advisory review, not another implementation owner.
Hide registration and its parent relationship identify the live Observer and child.
An Observer may itself be a child of a lead; having a parent alone does not make it an Implementor.
Sasu stores no terminal, session, registration or watch identity.

## One flow

```text
approved PRD in chosen checkout
  -> Observer: sasu implement start
  -> Observer: sasu implement dispatch, then run its printed hide agent spawn command
  -> Implementor: code, observe, commit, native review, deterministic verify
  -> Implementor: hide request send parent --kind report
  -> Observer: hide inbox, inspect evidence, deliver under existing approval
```

Choose the implementation checkout before sealing the PRD.
Hide owns worktree and pane creation; Sasu seals the chosen checkout and its suites.
Use explicit state paths from the handoff when multiple runs exist.
Outside a managed runtime, implement in the current session and report that runtime delegation was unavailable.

## Dispatch

The Observer runs `sasu implement start --prd <approved-prd>` and resolves any dirty-source attribution first.
Then run `sasu implement dispatch --state <state> --name <unique-name> --kind <runtime>` with the task context on stdin.
Read the returned handoff file and execute the returned command directly.
It has this shape:

```sh
hide agent spawn --parent here --review-policy observer-30m --name <name> --intent <run-intent> \
  --kind <runtime> --repo <repository> --branch <current-branch> --path <checkout> \
  -- <native runtime options> 'Read the handoff at <absolute-path> and execute it.'
```

The native first prompt stays short; the handoff file contains the approved context, fixed role boundaries, verification and delivery instructions.
The default effort is high unless the user supplies another supported value.
Same intent and same arguments mean the same child.
When startup returns `native_identity_unavailable`, inspect the current child, resolve its reported startup condition, then retry that exact spawn.
Do not change the intent to escape a pending start.
Do not recreate identities, write lineage tokens, inject role environment markers, or maintain a parallel participant registry.

## Plans, blocks and reports

Use Hide directly:

```sh
hide inbox
hide request send <observer> --intent <plan-key> --body '<plan and current evidence>'
hide request send <observer> --intent <question-key> --kind block --body '<question, recommendation, reversibility, scope impact>'
hide request reply <letter> --intent <reply-key> --body '<decision>'
hide request send <observer> --intent <report-key> --kind report --body '<result, verification, reviews and remaining limits>'
```

A plan request does not block implementation.
A blocked Implementor ends its turn after sending the question.
The Observer resolves in-scope questions using the approved contract and established project conventions.
Scope, product policy, irreversible changes and missing authority go to the user with concrete options and a recommendation.
A reply answers the question; acknowledgement alone does not.
Letters are the sender's messages, not new authority over the approved PRD.
A report requests inspection and does not prove completion.

## Observation and recovery

Use `hide agent list`, `hide agent show <id>` and `hide watch list` for current runtime facts.
Use `sasu implement status --state <state>` for current contract and deterministic verification facts.
When terminal output is needed, `herdr agent read <agent> --source recent-unwrapped --lines 120` is a diagnostic read.
Hide owns inactivity alerts, watch assignment, delivery confirmation and child departure.
A terminal handoff or session compaction requires no Sasu adoption because Sasu does not store those identities.

## Periodic review

Sasu Implementor dispatch requests Hide's `observer-30m` policy alongside the existing inactivity watch.
The first review is due 30 minutes after the watch starts; child input, output, commits, tests and progress letters do not postpone it.
Hide sends the designated Observer a review letter and wake through its existing delivery path, with at most one outstanding request, persisted across restart.
Use the complete approved PRD and execution plan as the baseline, reusing unchanged context and the last actual review.
Inspect new changes, results and failures first; read the full baseline only when missing or changed.
Keep the periodic inspection proportional to new work rather than adding another full verification or review stage.
Consider actual completed results, remaining work and verification history, while preserving the final independent full-contract reviews.
Assess these questions together, without a per-requirement ledger:

- Does the result follow the contract and plan, and what is actually complete?
- How much time is implementation, build/CI waiting or rework, and what evidence explains the duration?
- Does each task serve the request or a necessary prerequisite, and could a smaller solution meet it without unrelated refactoring or abstraction?
- Are repeated fixes or full-suite runs supported by new evidence, or should the next action reproduce and diagnose the failure?

Reply to that review letter with an explicit assessment:

```sh
hide request reply <review-letter> --review <assessment> --intent <stable-review-key> \
  --body '<one-line grounds; concrete next direction when needed>'
```

Choose `scope-appropriate`, `delay-justified`, `reduce-scope` or `diagnosis-needed`.
Give the grounds for that conclusion; when intervention is needed, name the scope to reduce and one concrete next action.
Preserve mandatory verification and necessary regression fixes, and send new product decisions or missing authority to the user.
Only the designated Observer's accepted explicit review completes the request and starts the next 30-minute cycle.
Receipt, ack, an ordinary reply or a progress letter cannot complete it.
Confirmed report delivery, target departure or explicit watch stop end periodic scheduling with the existing watch.
Inactivity warnings and block forwarding remain intact.
Timing and delivery stay in Hide; semantic assessment stays with the Observer.

## Advisor

For an implementation blocker, the Observer runs `sasu implement escalate --state <state> --intent <diagnosis-key> --reason <observed-problem>`.
Execute its printed `hide agent spawn --parent here` command.
Advisor commands do not opt into the periodic review policy.
The advisor reads the sealed contract, current evidence and blocker, then sends a report letter to its parent.
It must not edit implementation, silently reset the Implementor, or claim a diagnosis is a successful fix.
A repeated intent returns the same request; changed request content requires a distinct intent.
At most three distinct advisor requests are allowed per run.
After that, surface the failed approaches and a recommended decision to the user.

## Completion

Inspect the final committed head, current deterministic PASS report, evidence and visible review advice.
Deliver only under the user's existing local or PR authorization.
A green test run is not proof of an unobserved UI or external runtime behavior.
Report unavailable review and unrun checks explicitly.
