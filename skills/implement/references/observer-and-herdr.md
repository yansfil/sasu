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
The Implementor owns implementation repository writes, focused checks, evidence registration, deterministic verification, native review disposition, fixes, and conditional delivery from a ready PRD.
It never authors or repairs the qa-log or PRD.
While the implementation phase is active, only the Implementor may mutate implementation files after dispatch; the CLI alone writes Sasu run state.
All sealed PRD changes require human authorization, recorded by `sasu implement amend --issuer human --approval '<verbatim user approval>' --reason '<why and what changed>'`.
Existing authorization that covers the change is sufficient; the Implementor does not edit the PRD or qa-log on its own.
The Observer may read repository state, `sasu gate status`, `sasu implement status`, verification reports and the Implementor transcript.
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

The Observer starts the run first, from the record tree, and dispatches second:

```sh
sasu implement intake
sasu implement start --prd <ready-prd-path> [--dirty-attribution <pre-existing|run-owned>]
```

`start` provisions the run's worktree when the configuration isolates runs, records the run in this tree, and names the dispatch verb as the next step.
It runs here rather than in the Implementor's pane because the pane is placed by what `start` decided: a run isolated into a worktree gets a Herdr workspace of its own on that worktree, and an in-place run gets a new tab in the Observer's workspace.
Neither is a split of the Observer's pane.
Hide lists a pane under the Herdr workspace that owns it, so an Implementor split beside the Observer was listed under the root checkout however far away its worktree was, and it sat in the operator's own layout (2026-09-18).

Choose a unique agent name that describes the mode and topic and remains within Herdr's name limit.
Build the complete Handoff Packet below and send it on stdin to the harness's own dispatch verb:

```sh
sasu implement dispatch --name <unique-agent-name> --prd <ready-prd-path> \
  [--kind <agent>] [--model <agent-model>] [--effort <reasoning-effort>] [--env KEY=VALUE ...] --json <<'SASU_HANDOFF'
ROLE: Implementor. Confirm the marker with `test "$SASU_HERDR_ROLE" = implementor` and never dispatch recursively.
PIPELINE: implement via ~/.codex/skills/implement/SKILL.md
ORIGINAL INVOCATION: <verbatim user message>
GOAL AND CONTEXT: <implementation goal and operational facts not represented in the PRD>
AUTHORITY: <autonomous defaults and hard stops>
SOURCE: <cwd and ready PRD path>
DIRTY ATTRIBUTION: <pre-existing|run-owned, when `sasu implement intake` asked>
RETURN CONTRACT: plan.md printed before the first source write; then status, paths, assumptions, verdicts, timing, unresolved items
SASU_HANDOFF
```

This is the only dispatch path.
It exists because the previous one did not: this section used to print a raw `herdr agent new ... --env ... --prompt ...` command, and herdr has never had either flag, so every dispatch was hand-typed prose checked by nobody and it drifted until a live run could not dispatch at all (2026-09-07).
Dispatch reaches herdr only through the harness's three-hole adapter (`spawn`, `read`, `alive`); nothing else in the harness may call herdr, and the Herdr skill does not authorize substituting raw `herdr workspace create`, `herdr tab create`, `herdr pane split`, `herdr pane run`, or `herdr agent start` here.

The verb refuses before it creates anything, in this order: a pane already marked `SASU_HERDR_ROLE=implementor`, no started run for this session (pass `--slug` for a run another session started), a PRD that is not the one the run started from or is missing or not yet `status: ready`, an implementor herdr still lists for this run, a missing worktree, an in-place run with no `HERDR_WORKSPACE_ID` to open a tab in, a missing `--name`, and an empty handoff packet.
The marker refusal is the recursion guard and it is structural - it reads the environment of the dispatching process, so an Implementor cannot dispatch by declaring a different `--issuer`.
When `HERDR_PANE_ID` is unset the dispatch cannot tell which agent kind it is dispatching from, so `spawn` reports itself closed and `sasu implement status` says so while pane diagnosis and liveness stay open.

On success it prints the new pane, workspace and tab ids, the agent name, kind, cwd, slug, and PRD as JSON, and records the dispatch in `state.json` (`dispatches`, and a `dispatch` event).
The run is then the Implementor's: dispatch releases the Observer's ownership so the Implementor's first write claims it, and only a pane carrying the marker may make that claim - any other session needs `--adopt "<the user's verbatim words>"`, exactly as a takeover does.
The Implementor does not run `sasu implement start`; a session-less bookmark in the tree it works in makes its bare `sasu implement ...` commands resolve the run, and `sasu implement status` shows the current implementor under `implementor`.
The kind defaults to the agent occupying the dispatching pane, so a Claude supervisor dispatches Claude unless `--kind` says otherwise.
`--model` and `--effort` are forwarded as the started agent's own native arguments: `--model`/`--effort` for Claude, `--model` and `-c model_reasoning_effort="<level>"` for Codex.
The new pane's shell starts from the login environment, not the Observer's, so the dispatch always passes the Observer's own `PATH` to the new pane (a locally built `sasu` or a shim ahead of the login PATH stays visible to the Implementor) and forwards each `--env KEY=VALUE` on top of it; an explicit `--env PATH=...` replaces the inherited one, and `SASU_HERDR_ROLE` is refused because the marker is the dispatch's own to set.
The new pane's shell takes a few seconds to print its first prompt, and herdr refuses `agent start` with `agent_pane_busy` until it has seen one; the adapter retries exactly that refusal once a second for up to 30 seconds and reports any other failure at once, so the wait is the harness's, never this skill's.

Lineage is declared, not recorded by herdr: after the agent starts, the dispatch writes the pane token `parent_pane=<dispatching pane id>` on the new pane (`herdr pane report-metadata --source sasu`), which hide reads to draw the Implementor beneath the Observer.
herdr's stable release has no lineage of its own, and the fork's `agent new --from-pane` cannot carry the role marker, so the token is the one mechanism that works on both.
The dispatch result says `parentLineage: reported`, or names the refusal, in which case the row shows as a root and nothing else is affected.

One cost is real and is not a bug to re-report:

- Dirty-tree attribution is settled before dispatch, by the Observer.
  For `$please`, the Spec Owner runs `sasu implement intake` before the first gate; when it reports dirty judged paths it asks its returned question once, resolves `commit-first` by committing before `start`, and otherwise passes the selected `pre-existing|run-owned` value to `sasu implement start --dirty-attribution`.
  The packet's DIRTY ATTRIBUTION line records what was chosen so the Implementor never asks again.

Call the verb once per dispatch; a second call is refused while herdr still lists the first Implementor, and opens a replacement pane only once it is gone.
If the agent fails to start, the empty workspace or tab the dispatch created is closed and the exact failure is reported.
A pane whose agent did start is never closed automatically - leave it visible for inspection - and a handoff that fails to submit leaves the Implementor running with no packet, which the failure line says in those words.
If dispatch fails in a Herdr-managed session, keep the sealed PRD, remain the user-facing session, and surface the failure.
Never fall back to mutating implementation state or implementing inline from an unmarked Herdr pane.

## Handoff Packet

Send one lossless handoff through the dispatch helper's stdin.
The packet must contain:

- `ROLE`: Implementor, with instructions to confirm the marker with `test "$SASU_HERDR_ROLE" = implementor` and never dispatch recursively.
- `PIPELINE`: `implement`, plus the exact skill path to read. Never dispatch `please`; its specification phase stays in the main session.
- `ORIGINAL INVOCATION`: the user's delegating message verbatim.
- `GOAL AND CONTEXT`: the implementation goal and operational facts that are not represented in the ready PRD.
- `AUTHORITY`: reversible in-scope defaults are autonomous; hard-stop classes remain blocked.
- `SOURCE`: repository cwd and the ready PRD path.
- `DIRTY ATTRIBUTION`: injected by the helper when the Spec Owner selected `pre-existing` or `run-owned`; absent only after intake reported clean or `commit-first` was resolved into a clean tree.
- `RETURN CONTRACT`: the execution plan printed before the first source write (`execution-planning.md`), then final status, paths, assumptions, verification verdicts, timing, and unresolved items.

Do not replace the PRD with a vague summary such as "implement what we discussed".
The ready PRD is the canonical implementation contract; accepted and rejected product decisions belong there rather than in a second handoff narrative.
The Implementor cannot read the Observer's chat history.
The handoff must state a routing contract that forbids the Implementor from invoking `AskUserQuestion`, `request_user_input`, or any interactive question UI.
The Implementor has no direct user channel: when blocked, it emits `OBSERVER_BLOCK` as final text and ends the turn so the Observer can decide or escalate.

Dispatch does not focus the new pane.
It records this pane's session UUID, terminal and pane as the run's Observer, mints a run instance id the new pane carries as `SASU_RUN_INSTANCE_ID`, and enrolls the run's `state.json` with the supervisor tick.
From that moment the run is watched; the Observer arms nothing and simply ends its turn.
Do not run a background command to wait on the run: a finished background command does not create an agent turn by itself, and the one-shot waiter this replaced left runs silently unwatched whenever the re-arm was forgotten (2026-09-18).

## The Supervisor Tick

One user LaunchAgent runs `sasu supervisor tick` every 30 seconds for every run on the machine.
It is level-triggered: each tick re-reads the index of watched `state.json` paths, each run's record, and herdr's `agent get` for the Implementor and the Observer, and reaches its verdict from those facts alone.
It writes no run state and holds no cursor, so a tick killed at any point, or a machine rebooted, reaches the same verdict on the next tick; the only cost is one interval of delay.

It wakes the recorded Observer for exactly these reasons:

| Reason | Fact behind it |
| --- | --- |
| `settled` | the Implementor has been idle or done for at least one tick interval; the wake says it may be transient |
| `blocked` | herdr reports the Implementor blocked |
| `escalate` | an `escalate` event was recorded |
| `stall` | no `state.json` event AND no herdr lifecycle activity for 10 minutes; a working Implementor is activity |
| `implementor-gone` | the Implementor's pane is empty or holds another agent |
| `terminal` | the run was retired; it leaves the index after this wake |
| `patrol` | the Implementor is working and the Observer has not looked for the run's patrol interval (default 15 minutes, `dispatch --patrol <minutes>`) |

Artifact, verify, dispatch and amendment events do not wake; they only reset the stall clock.
Each condition is answered once per episode; a working Observer is not interrupted and receives the same condition on the next tick it is idle; several runs watched by one Observer arrive in one wake.

Before every wake the tick compares `agent get` on the recorded Observer pane with the recorded session UUID and terminal.
A different session in the same pane, with the same name and cwd, receives nothing: the run shows `observer-gone` in `sasu supervisor status` until a person hands it over with `sasu supervisor handover --slug <slug> --approval "<verbatim user words>"` from the new Observer's pane.
A herdr server restart rotates terminal ids and reads the same way; the handover is the recovery there too.
`sasu supervisor status` and `status --digest` name each run's recovery owner (`supervisor` or `task-factory`, set by `dispatch --recovery-owner`).
The owner says which loop may replace a vanished Observer; the supervisor never replaces one and wakes only the recorded Observer either way.
When herdr returns an `input_guard` for the Observer the wake is sent with `--expected-input-guard`, and a guard the server then refuses is a routing failure, never a plain resend.

## Handling A Wake

The wake is an identity note, not an instruction:

```text
SASU_WAKE
observer: <this session's UUID>
run: <slug> instance <run instance id>
reason: <reasons>
  <reason>: <fact>
inspect: sasu implement status --slug <slug> --digest
```

Read the digest first.
It reports deterministic facts since dispatch - elapsed time, the Implementor's herdr state and last activity, commits and recent subjects, changed files and lines, per-file churn, paths outside the delivery boundary, verify attempts and repeatedly failing suites, uncommitted changes and their age - and no judgment.
It answers only the recorded Observer session; another session that receives a stray wake is refused and nothing changes.
Then read the pane tail with `herdr agent read <implementor-name> --source recent-unwrapped --lines 120`, for diagnosis only.
On the first `patrol` wake also read `agents/runs/<slug>/plan.md`: it is the Implementor's declared order and slice boundaries, the one place a wrong reading of the structure or a missing existing helper is visible before the code shows it.
From those two, choose one of three: it is fine and the turn ends; one line of direction to the Implementor; or stop.
Use Sasu state, not transcript keywords, as the source of truth.

The Observer's Stop hook confirms the handover when a turn ends normally: it exits 0 in every case, never blocks a stop, and only asks launchd for an immediate tick when this session is the recorded Observer of an indexed run.
It is not what watches the run; the tick has been watching since dispatch.

## Exception-Only Intervention

The normal path is silent.
The Observer intervenes only on `blocked`, an idle or done agent without a current deterministic report, `unknown` or exited runtime state, a scope or authority violation, or an explicit user change.

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
A live verify execution lease refuses all domain mutations, including amendment, retirement, escalation, adoption, other domain mutations.
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
- On idle or done without a current deterministic report, ask the Implementor for its exact stage and next action, then continue if no hard stop exists.
- On `unknown`, inspect the pane process and Sasu state before deciding that the agent died.
- If the Implementor died, dispatch one replacement with the same verb: it refuses while herdr still lists the first Implementor, and otherwise opens the replacement in a new pane, and hand off the original invocation, current diff, ready PRD, and Sasu status.
  The run is owned by the dead Implementor's session, so the Observer passes `--adopt` with the original user's `$please` or `$implement` invocation, the only takeover evidence available for the same task; never compose adoption evidence.
- Allow one autonomous resolution for the same blocker signature.
  If that blocker repeats, stop the automatic loop and surface the failed approach and recommended replan to the user.

Completion is the pipeline's own authority and nothing else's: a `done` or settled screen is a cue to look, never evidence that work finished.
For implementation, require a current PASS from `sasu implement status`, `verification-report.json`, `verification-report.md`, and visible native-agent review notes or an explicit `REVIEW_UNAVAILABLE`.
The Observer reports the Implementor pane ID, final status, autonomous decisions, user-review items, verification result, and measured PRD and implementation timing.
