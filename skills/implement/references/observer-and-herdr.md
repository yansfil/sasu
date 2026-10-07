# Observer and runtime delegation

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
hide agent spawn --parent here --name <name> --intent <run-intent> \
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

## Advisor

For an implementation blocker, the Observer runs `sasu implement escalate --state <state> --intent <diagnosis-key> --reason <observed-problem>`.
Execute its printed `hide agent spawn --parent here` command.
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
