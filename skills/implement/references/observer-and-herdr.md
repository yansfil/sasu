# Observer And Herdr Execution

## Contents

- [Role Boundary](#role-boundary)
- [Resolve The Current Role](#resolve-the-current-role)
- [Dispatch One Implementor](#dispatch-one-implementor)
- [Handoff Packet](#handoff-packet)
- [Exception-Only Intervention](#exception-only-intervention)
- [Recovery And Completion](#recovery-and-completion)

## Role Boundary

For a direct `$implement` invocation, the user-facing main session is the Observer from entry.
For a direct `$please` invocation, the main session is the Spec Owner through qa-log closure and PRD readiness, then becomes the Observer only after it dispatches implementation.
The fresh Herdr agent is the Implementor.
The Sasu harness remains the independent verification authority.

The Spec Owner owns conversation continuity, qa-log closure when applicable, PRD authorship, PRD gates, and the pre-implementation summary.
The Observer owns conversation continuity, delegation, liveness, exception triage, recovery, and the final user-facing report.
The Implementor owns implementation repository writes, focused checks, evidence registration, verification, fixes, finalization, and conditional delivery from a ready PRD.
It never authors or repairs the qa-log or PRD.
While the implementation phase is active, only the Implementor may mutate implementation files after dispatch; the CLI alone writes Sasu run state.
All sealed PRD changes require human authorization, recorded by `sasu implement amend --issuer human --approval '<verbatim user approval>' --reason '<why and what changed>'`.
Existing authorization that covers the change is sufficient; the Implementor does not edit the PRD or qa-log on its own.
The Observer may read repository state, `sasu gate status`, `sasu implement status`, receipts, and the Implementor transcript.
It must not become a second implementor or repeat verification.

## Resolve The Current Role

Read the runtime's Herdr skill completely before issuing a Herdr control command.
Claude Code uses `~/.claude/skills/herdr/SKILL.md`; Codex uses `~/.agents/skills/herdr/SKILL.md` when that is the installed location.

Resolve the role from the pane environment:

```sh
test "$SASU_HERDR_ROLE" = implementor && echo implementor || echo observer
```

The routing treats the Herdr pane environment value `SASU_HERDR_ROLE=implementor` as the structural Implementor marker.
The marker is injected atomically when the child pane is created, before its shell or agent can start.
Never infer the role from pane titles, agent names, or transcript phrases.
For `$please`, the unmarked main pane's Spec Owner phase is determined by pipeline stage, not a second environment marker.

Apply this routing before any project write or mutating `sasu` command:

- A delegated Implementor marker means execute implementation and conditional delivery from the handed-off ready PRD in the current pane and never dispatch another Implementor.
- A direct `$please` invocation in an unmarked Herdr pane means remain the Spec Owner through PRD `ready`; do not dispatch during interview or PRD work.
- After `$please` reaches a ready PRD, or on a direct `$implement` invocation with an approved PRD, the unmarked main pane becomes the Observer and dispatches exactly one Implementor.
- A `benchmark-implement` coordinator stays the Implementor because that benchmark explicitly requires in-session execution.
- Outside Herdr, execute in the current session and report once that Observer isolation was unavailable.

## Dispatch One Implementor

Choose a unique agent name that describes the mode and topic and remains within Herdr's name limit.
Build the complete Handoff Packet below and send it on stdin to the harness's own dispatch verb:

```sh
sasu implement dispatch --name <unique-agent-name> --prd <ready-prd-path> \
  [--kind <agent>] [--model <agent-model>] [--effort <reasoning-effort>] --json <<'SASU_HANDOFF'
ROLE: Implementor. Confirm the marker with the role helper and never dispatch recursively.
PIPELINE: implement via ~/.codex/skills/implement/SKILL.md
ORIGINAL INVOCATION: <verbatim user message>
GOAL AND CONTEXT: <implementation goal and operational facts not represented in the PRD>
AUTHORITY: <autonomous defaults and hard stops>
SOURCE: <cwd and ready PRD path>
DIRTY ATTRIBUTION: <pre-existing|run-owned, when `sasu implement intake` asked>
RETURN CONTRACT: <status, paths, assumptions, verdicts, timing, unresolved items>
SASU_HANDOFF
```

This is the only dispatch path.
It exists because the previous one did not: this section used to print a raw `herdr agent new ... --env ... --prompt ...` command, and herdr has never had either flag, so every dispatch was hand-typed prose checked by nobody and it drifted until a live run could not dispatch at all (2026-09-07).
Dispatch reaches herdr only through the harness's three-hole adapter (`spawn`, `read`, `alive`); nothing else in the harness may call herdr, and the Herdr skill does not authorize substituting raw `herdr pane split`, `herdr pane run`, or `herdr agent start` here.

The verb refuses before it creates anything, in this order: a pane already marked `SASU_HERDR_ROLE=implementor`, a missing `--name`, an empty handoff packet, and a PRD that is missing or not yet `status: ready`.
The marker refusal is the recursion guard and it is structural - it reads the environment of the dispatching process, so an Implementor cannot dispatch by declaring a different `--issuer`.
When `HERDR_PANE_ID` is unset there is no pane to split, so `spawn` reports itself closed and `sasu implement status` says so while pane diagnosis and liveness stay open.

On success it prints the new pane id, agent name, kind, and PRD as JSON.
The kind defaults to the agent occupying the dispatching pane, so a Claude supervisor dispatches Claude unless `--kind` says otherwise.
`--model` and `--effort` are forwarded as the started agent's own native arguments: `--model`/`--effort` for Claude, `--model` and `-c model_reasoning_effort="<level>"` for Codex.
Waiting for the new shell to become interactive is herdr's own `agent start` timeout, not a loop of this skill's.

Two costs are real and are not bugs to re-report:

- The dispatched Implementor does not appear under its supervisor in Herdr's agent tree.
  herdr 0.8.2 can inject the role marker (`pane split --env`) or record parent lineage (`agent new --from-pane`) but not both in one call, and the marker wins because it is a correctness guard while lineage is an audit convenience.
- Dirty-tree attribution travels in the handoff packet, not in a flag.
  For `$please`, the Spec Owner runs `sasu implement intake` before the first gate; when it reports dirty judged paths it asks its returned question once, resolves `commit-first` by committing before dispatch, and otherwise writes the selected `pre-existing|run-owned` value into the packet's DIRTY ATTRIBUTION line.
  The Implementor passes that value to `sasu implement start` and never asks again.

Call the verb once per dispatch; rerunning it would allocate a second pane.
If the agent fails to start, the empty pane it created is closed and the exact failure is reported.
A pane whose agent did start is never closed automatically - leave it visible for inspection - and a handoff that fails to submit leaves the Implementor running with no packet, which the failure line says in those words.
If dispatch fails in a Herdr-managed session, keep the sealed PRD, remain the user-facing session, and surface the failure.
Never fall back to mutating implementation state or implementing inline from an unmarked Herdr pane.

## Handoff Packet

Send one lossless handoff through the dispatch helper's stdin.
The packet must contain:

- `ROLE`: Implementor, with instructions to confirm the `SASU_HERDR_ROLE=implementor` marker through the role helper and never dispatch recursively.
- `PIPELINE`: `implement`, plus the exact skill path to read. Never dispatch `please`; its specification phase stays in the main session.
- `ORIGINAL INVOCATION`: the user's delegating message verbatim.
- `GOAL AND CONTEXT`: the implementation goal and operational facts that are not represented in the ready PRD.
- `AUTHORITY`: reversible in-scope defaults are autonomous; hard-stop classes remain blocked.
- `SOURCE`: repository cwd and the ready PRD path.
- `DIRTY ATTRIBUTION`: injected by the helper when the Spec Owner selected `pre-existing` or `run-owned`; absent only after intake reported clean or `commit-first` was resolved into a clean tree.
- `RETURN CONTRACT`: final status, paths, assumptions, verification verdicts, timing, and unresolved items.

Do not replace the PRD with a vague summary such as "implement what we discussed".
The ready PRD is the canonical implementation contract; accepted and rejected product decisions belong there rather than in a second handoff narrative.
The Implementor cannot read the Observer's chat history.
The handoff must state a routing contract that forbids the Implementor from invoking `AskUserQuestion`, `request_user_input`, or any interactive question UI.
The Implementor has no direct user channel: when blocked, it emits `OBSERVER_BLOCK` as final text and ends the turn so the Observer can decide or escalate.

Dispatch does not focus the new pane.
The Observer then arms exactly one background waiter and lets go of the turn:

```sh
sasu implement await --since <last-event-id> [--pid <implementor-pid>]
```

Arm it as a background task, never in the foreground.
Under Claude Code that is the Bash tool's `run_in_background`; under Codex it is that runtime's own detached-command form.
A foreground wait holds the turn, so the user cannot reach the Observer for as long as the run lasts, which is the one thing the Observer exists to stay available for.
A background waiter outlives the turn and re-invokes the Observer when it exits.

The waiter is a one-shot, so the loop is arm, wake, judge, arm again.
Re-arm after every wake except `implementor-gone`, which means the watched target can no longer be followed - it may have died, but a moved pane or a changed identity reports identically, so inspect it before deciding on any recovery and never start a replacement on that signal alone.
`await` prints the next command with the cursor already advanced and the probe flag carried over; run that, rather than rebuilding it from memory.
Failing to re-arm does not raise an error: the implementor keeps working and nobody is watching.

It returns for exactly one reason - a new event, no progress past the
no-progress bound, or the watched target no longer being followable - and prints which.
Progress is decided by the event log alone, never by pane text: pane output is
not a semantic unit and cannot say what happened.
A named target is additionally watched by one bounded `herdr agent wait` child, which can only bring the stall forward once per silence interval and can never resolve a finding or declare progress.
After that early inspection is spent, no per-second target-loss detection remains until a new event; the wake says so in its own detail rather than leaving the gap unstated.
This replaces raw `herdr agent get`, hand-run `herdr agent wait`, `herdr agent list --json`, transcript-keyword polling, and home-grown shell loops.
On a stall wake, `herdr agent read <implementor-name> --source recent-unwrapped --lines 120` is a diagnosis tool only; when herdr is absent, `sasu implement status` names which of `spawn`, `read`, `alive` is unavailable and the run continues without pane diagnosis.
Use Sasu state, not transcript keywords, as the source of truth.

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
scope_or_requirement_impact: <none or exact impact>
external_effect: none | <exact effect>
```

The Observer resolves a block without asking the user when the answer is already in the handoff, follows an established repository convention, or is an in-scope reversible default that does not weaken an acceptance criterion.
For `$please`, this includes reversible product, copy, and implementation choices that can be listed for final review.
Send an in-contract decision back to the same Implementor and require it to record the assumption in the final report, never by editing the sealed PRD.
For a required contract change, preserve existing applicable human authority and send the proposed amendment to the same Implementor through the coordinator.
A live verify execution lease refuses all domain mutations, including amendment, retirement, escalation, adoption, risk decisions, and confirmation.
Wait for completion or verified process-group cleanup; a settled pane or lost target alone is not proof that its children have stopped.

If the block changes scope, an acceptance criterion, major structure, or product behavior, the Observer must not authorize divergence or edit the sealed PRD while implementation continues.
Ask the user for the explicit change required by the gate-reopen contract.
Only after receiving it may the main session pause implementation, return to the Spec Owner phase, reopen and reseal the affected gate with the user's words as evidence, and resume the same Implementor or a replacement from the updated ready PRD.

Ask the user only when no defensible reversible default exists or the choice needs new authority: credentials, billing or external spend, production data, destructive or irreversible action, auth or security policy, an external-service commitment, an expensive persistent data shape, unauthorized delivery, or a conflict that requires dropping an approved requirement.
Never use an Observer decision to lower verification or override a Sasu gate.

## Recovery And Completion

Do not send a blind "continue" to a stopped agent.
Inspect the lifecycle state, recent output, and Sasu status first.

- On a soft `blocked` state, resolve it under the policy above and resume the same Implementor.
- On idle or done without a receipt, ask the Implementor for its exact stage and next action, then continue if no hard stop exists.
- On `unknown`, inspect the pane process and Sasu state before deciding that the agent died.
- If the Implementor died, start one replacement in a fresh marked pane and hand off the original invocation, current diff, ready PRD, and Sasu status.
  The original user's `$please` or `$implement` invocation is the only takeover evidence available for the same task; never compose adoption evidence.
- Allow one autonomous resolution for the same blocker signature.
  If that blocker repeats, stop the automatic loop and surface the failed approach and recommended replan to the user.

Completion is the pipeline's own authority and nothing else's: a `done` or settled screen is a cue to look, never evidence that work finished.
For implementation, require a complete `sasu implement status`, `receipt.json`, and `implementation-result.md`.
The Observer reports the Implementor pane ID, final status, autonomous decisions, user-review items, verification result, and measured PRD and implementation timing.
