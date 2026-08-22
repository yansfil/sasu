# Observer And Herdr Execution

## Contents

- [Role Boundary](#role-boundary)
- [Resolve The Current Role](#resolve-the-current-role)
- [Dispatch One Implementor](#dispatch-one-implementor)
- [Handoff Packet](#handoff-packet)
- [Exception-Only Intervention](#exception-only-intervention)
- [Recovery And Completion](#recovery-and-completion)

## Role Boundary

The user-facing main session is the Observer.
The fresh Herdr agent is the Implementor.
The Sasu harness remains the independent verification authority.

The Observer owns conversation continuity, delegation, liveness, exception triage, recovery, and the final user-facing report.
The Implementor owns PRD authoring when applicable, repository writes, task closure, evidence registration, verification, fixes, finalization, and conditional delivery.
Only the Implementor may mutate project files or Sasu run state after dispatch.
The Observer may read repository state, `sasu gate status`, `sasu implement status`, receipts, and the Implementor transcript.
It must not become a second implementor or repeat verification.

## Resolve The Current Role

Read the runtime's Herdr skill completely before issuing a Herdr control command.
Claude Code uses `~/.claude/skills/herdr/SKILL.md`; Codex uses `~/.agents/skills/herdr/SKILL.md` when that is the installed location.

Resolve the role with the deterministic helper:

```sh
node ~/.codex/skills/implement/scripts/herdr_observer.js role
```

The helper treats the Herdr pane environment value `SASU_HERDR_ROLE=implementor` as the structural Implementor marker.
The marker is injected atomically when the child pane is created, before its shell or agent can start.
Never infer the role from pane titles, agent names, or transcript phrases.

Apply this routing before any project write or mutating `sasu` command:

- A delegated Implementor marker means execute the requested pipeline in the current pane and never dispatch another Implementor.
- A direct user invocation in a Herdr pane without that marker means remain the Observer and dispatch exactly one Implementor.
- A nested `implement` stage inside an already delegated `$please` run stays in the same Implementor pane.
- A `benchmark-implement` coordinator stays the Implementor because that benchmark explicitly requires in-session execution.
- Outside Herdr, execute in the current session and report once that Observer isolation was unavailable.

## Dispatch One Implementor

Choose a unique agent name that describes the mode and topic and remains within Herdr's name limit.
Build the complete Handoff Packet below, then submit it on stdin to the deterministic helper:

```sh
node ~/.codex/skills/implement/scripts/herdr_observer.js dispatch \
  --name <unique-name> \
  --cwd "$PWD" <<'SASU_HANDOFF'
ROLE: Implementor. Confirm the marker with the role helper and never dispatch recursively.
PIPELINE: <please or implement, plus exact skill path>
ORIGINAL INVOCATION: <verbatim user message>
GOAL AND CONTEXT: <lossless task context>
AUTHORITY: <autonomous defaults and hard stops>
SOURCE: <cwd and approved PRD path when applicable>
RETURN CONTRACT: <status, paths, assumptions, verdicts, timing, unresolved items>
SASU_HANDOFF
```

This helper is the code-owned dispatch boundary.
The generic Herdr skill explains the CLI but does not authorize substituting raw `herdr pane split`, `herdr pane run`, or `herdr agent start` commands here.
The helper structurally refuses dispatch from an already marked Implementor pane.
It refuses an empty handoff before creating anything.
It creates a right-side sibling with the same cwd and `--no-focus`, injects `SASU_HERDR_ROLE=implementor` in the pane creation call, starts the same detected agent kind unless `--kind` overrides it, submits the handoff through `herdr agent prompt`, and returns the new pane ID and agent name as JSON.
Call the helper once per dispatch.
It owns the bounded same-pane retry while a newly created shell becomes ready; rerunning the whole dispatch command would allocate duplicate panes.
If pane creation succeeds but agent startup fails, it reports the exact failure and closes only the empty pane it created.
Do not close a successfully started Implementor pane automatically; leave it visible for inspection.
If dispatch fails in a Herdr-managed session, remain the Observer and surface the failure.
Never fall back to writing the PRD, mutating Sasu state, or implementing inline from an unmarked Herdr pane.

## Handoff Packet

Send one lossless handoff through the dispatch helper's stdin.
The packet must contain:

- `ROLE`: Implementor, with instructions to confirm the `SASU_HERDR_ROLE=implementor` marker through the role helper and never dispatch recursively.
- `PIPELINE`: `please` or `implement`, plus the exact skill path to read.
- `ORIGINAL INVOCATION`: the user's delegating message verbatim.
- `GOAL AND CONTEXT`: the task, accepted and rejected decisions, constraints, non-goals, and relevant conversation facts.
- `AUTHORITY`: reversible in-scope defaults are autonomous; hard-stop classes remain blocked.
- `SOURCE`: repository cwd and, for `implement`, the approved PRD path.
- `RETURN CONTRACT`: final status, paths, assumptions, verification verdicts, timing, and unresolved items.

Do not replace the conversation with a vague summary such as "implement what we discussed".
The Implementor cannot read the Observer's chat history.
The dispatch helper appends a runtime routing contract that forbids the Implementor from invoking `AskUserQuestion`, `request_user_input`, or any interactive question UI.
The Implementor has no direct user channel: when blocked, it emits `OBSERVER_BLOCK` as final text and ends the turn so the Observer can decide or escalate.

The helper submits the packet without focusing the new pane.
The Observer then starts the helper's one lifecycle monitor in the foreground or as one persistent background task:

```sh
node ~/.codex/skills/implement/scripts/herdr_observer.js wait --name <implementor-name>
```

This replaces raw `herdr agent get`, `herdr agent wait`, `herdr agent list --json`, transcript-keyword polling, and home-grown shell loops.
When it settles, inspect `herdr agent read <implementor-name> --source recent-unwrapped --lines 120` plus Sasu status and receipts.
Use lifecycle state and Sasu state, not transcript keywords, as the source of truth.

## Exception-Only Intervention

The normal path is silent.
The Observer intervenes only on `blocked`, an idle or done agent without the required receipt, `unknown` or exited runtime state, a scope or authority violation, or an explicit user change.

Before waiting for an answer, the Implementor must emit this packet as final text and end its turn instead of opening an interactive question UI:

```text
OBSERVER_BLOCK
kind: implementation | product | authority | runtime
question: <the missing decision or failure>
recommendation: <the preferred next action and why>
reversible: yes | no
scope_or_ac_impact: <none or exact impact>
external_effect: none | <exact effect>
```

The Observer resolves a block without asking the user when the answer is already in the handoff, follows an established repository convention, or is an in-scope reversible default that does not weaken an acceptance criterion.
For `$please`, this includes reversible product, copy, and implementation choices that can be listed for final review.
Send the decision back to the same Implementor and require it to record the assumption in PRD Decision Traceability or the final report as applicable.

Ask the user only when no defensible reversible default exists or the choice needs new authority: credentials, billing or external spend, production data, destructive or irreversible action, auth or security policy, an external-service commitment, an expensive persistent data shape, unauthorized delivery, or a conflict that requires dropping an approved requirement.
Never use an Observer decision to lower verification or override a Sasu gate.

## Recovery And Completion

Do not send a blind "continue" to a stopped agent.
Inspect the lifecycle state, recent output, and Sasu status first.

- On a soft `blocked` state, resolve it under the policy above and resume the same Implementor.
- On idle or done without a receipt, ask the Implementor for its exact stage and next action, then continue if no hard stop exists.
- On `unknown`, inspect the pane process and Sasu state before deciding that the agent died.
- If the Implementor died, start one replacement in a fresh marked pane and hand off the original invocation, current diff, PRD, and Sasu status.
  The original user's `$please` or `$implement` invocation is the only takeover evidence available for the same task; never compose adoption evidence.
- Allow one autonomous resolution for the same blocker signature.
  If that blocker repeats, stop the automatic loop and surface the failed approach and recommended replan to the user.

Completion requires both an agent `done` or settled state and the pipeline's own completion authority.
For implementation, require a complete `sasu implement status`, `receipt.json`, and `implementation-result.md`.
The Observer reports the Implementor pane ID, final status, autonomous decisions, user-review items, verification result, and measured PRD and implementation timing.
