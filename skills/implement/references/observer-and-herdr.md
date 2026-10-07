# Observer And Herdr Execution

## Contents

- [Role Boundary](#role-boundary)
- [Resolve The Current Role](#resolve-the-current-role)
- [Dispatch One Implementor](#dispatch-one-implementor)
- [Handoff Packet](#handoff-packet)
- [Hide Supervision](#hide-supervision)
- [Handling A Letter](#handling-a-letter)
- [Looking And Acting](#looking-and-acting)
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
All sealed PRD changes require human authorization, recorded by `sasu implement amend --approval '<verbatim user approval>' --reason '<why and what changed>'`.
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
RETURN CONTRACT: `sasu implement plan` before the first source write; then status, paths, assumptions, verdicts, timing, unresolved items
SASU_HANDOFF
```

This is the only dispatch path.
It exists because the previous one did not: this section used to print a raw `herdr agent new ... --env ... --prompt ...` command, and herdr has never had either flag, so every dispatch was hand-typed prose checked by nobody and it drifted until a live run could not dispatch at all (2026-09-07).
Dispatch reaches herdr only through the harness's three-hole adapter (`spawn`, `read`, `alive`); nothing else in the harness may call herdr, and the Herdr skill does not authorize substituting raw `herdr workspace create`, `herdr tab create`, `herdr pane split`, `herdr pane run`, or `herdr agent start` here.

The verb refuses before it creates anything, in this order: a pane already marked `SASU_HERDR_ROLE=implementor`, no started run for this session (pass `--slug` for a run another session started), a PRD that is not the one the run started from or is missing or not yet `status: ready`, an implementor herdr still lists for this run, a missing worktree, an in-place run with no `HERDR_WORKSPACE_ID` to open a tab in, a missing `--name`, and an empty handoff packet.
The marker refusal is the recursion guard and it is structural - it reads the environment of the dispatching process, so an Implementor cannot dispatch by declaring a different `--issuer`.
When `HERDR_PANE_ID` is unset the dispatch cannot tell which agent kind it is dispatching from, so `spawn` reports itself closed and `sasu implement status` says so while pane diagnosis and liveness stay open.

On success it prints the new pane, workspace and tab ids, the agent name, kind, cwd, slug, and PRD as JSON, and records the dispatch in `state.json` (`dispatches`, and a `dispatch` event).
The run is then the Implementor's: dispatch releases the Observer's ownership so the Implementor's first write claims it, and only a pane carrying the marker may make that claim - any other session needs `--adopt`, exactly as a takeover does; the flag records the takeover in `state.json`.
The Implementor does not run `sasu implement start`; a session-less bookmark in the tree it works in makes its bare `sasu implement ...` commands resolve the run, and `sasu implement status` shows the current implementor under `implementor`.
The kind defaults to the agent occupying the dispatching pane unless `--kind` says otherwise.
`--model` and `--effort` are forwarded as the started agent's own native arguments: `--model`/`--effort` for Claude, `--model` and `-c model_reasoning_effort="<level>"` for Codex.
The new pane's shell starts from the login environment, not the Observer's, so the dispatch always passes the Observer's own `PATH` to the new pane (a locally built `sasu` or a shim ahead of the login PATH stays visible to the Implementor) and forwards each `--env KEY=VALUE` on top of it; an explicit `--env PATH=...` replaces the inherited one, and `SASU_HERDR_ROLE` is refused because the marker is the dispatch's own to set.
The new pane's shell takes a few seconds to print its first prompt, and herdr refuses `agent start` with `agent_pane_busy` until it has seen one; the adapter retries exactly that refusal once a second for up to 30 seconds and reports any other failure at once, so the wait is the harness's, never this skill's.

After the agent starts, dispatch records its native identity and registers the Observer and child with Hide.
Hide owns the four lineage tokens (`parent_pane`, `parent_machine`, `child_session`, `parent_session`) and writes them outside its runtime lock.
Sasu does not publish pane metadata or maintain a second lineage writer.
A registration or watch refusal after start preserves the recorded pane and dispatch phase; the next action repairs that same dispatch.

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
- `RETURN CONTRACT`: the execution plan registered with `sasu implement plan` before the first source write (`execution-planning.md`), then final status, paths, assumptions, verification verdicts, timing, and unresolved items.

Do not replace the PRD with a vague summary such as "implement what we discussed".
The ready PRD is the canonical implementation contract; accepted and rejected product decisions belong there rather than in a second handoff narrative.
The Implementor cannot read the Observer's chat history.
The handoff must state a routing contract that forbids the Implementor from invoking `AskUserQuestion`, `request_user_input`, or any interactive question UI.
The Implementor has no direct user channel: it runs `sasu implement block` with the missing decision and ends its turn, so the Observer can decide or ask the user.
Dispatch appends a fixed Hide mailbox paragraph to the packet.
It identifies plan, block and report letters as this run's coordination context, explains reply handling, and tells the Implementor to run `sasu implement report` before its final report.
A letter does not authorize changes to the approved contract by itself.

Dispatch does not focus the new pane.
It records this pane's native session, terminal and pane as the run's Observer, mints the run instance id carried as `SASU_RUN_INSTANCE_ID`, then registers both participants and starts the Hide watch.
From that moment Hide watches inactivity; the Observer arms no second loop and may end its turn.
Do not run a background command to wait on the run: a finished background command does not create an agent turn by itself.

## Hide Supervision

Every dispatched run uses the current `hide` executable and running daemon.
Sasu neither selects a backend nor installs a resident supervisor.
A missing executable, unavailable daemon or changed native identity returns a failure and next action before dispatch creates anything.
Hide knows native participants and their parent, watch and request relations; which participants belong to a run stays in Sasu's `state.json`.
The `supervision.hide` record holds the Observer and Implementor participant IDs, watch ID and registration time.

Dispatch first looks up the Observer pane's live Hide registration with `hide agent list`, matched on pane, native session and host scope.
An Observer a lead started with `hide agent spawn --parent` is already registered under that lead, and Hide refuses to register it again without that parent; Sasu uses that registration as the Observer, so the lead's lineage and watch stay intact.
Only a pane with no live registration is preflighted with `hide agent register --check` and later registered without a parent.
The caller's actual pane and native session must match the registration and be eligible for delivery.
An unnamed Observer is given a registration name derived from its session; its pane is not renamed.
After the Implementor starts, dispatch records its exact identity first, then registers the Observer when it is unregistered, the implementor as its child, and an inactivity watch.
A refusal after start leaves the pane and partial dispatch visible; fix the reported cause and run `sasu implement dispatch --resume-handoff` with the original packet on stdin.
The same dispatch resumes its recorded creation steps and hands off once rather than spawning another pane.

Hide watches inactivity rather than a configured patrol interval.
Twenty minutes without activity produces the first watch warning; an unchanged episode gets at most one further warning 60 minutes later.
Activity resets the episode.
If the first warning remains unconfirmed for 60 minutes, Hide may notify the operator through its existing channels.
Commits and Sasu drift facts remain inspectable through the digest; they do not imply an automatic wake.

| Letter | Sent when | Observer action |
| --- | --- | --- |
| Ordinary request with `SASU_PLAN` | `sasu implement plan` | Read the plan, reply with confirmation or a specific disagreement; the Implementor continues |
| Block with `SASU_BLOCK` | `sasu implement block` | Resolve an in-contract decision or ask the user, then reply |
| Report with `SASU_REPORT` | `sasu implement report` | Read current status and verification; the notice alone completes nothing |
| Watch warning | Hide observes inactivity | Read the digest and pane, then resolve the cause or record the receipt |

Plan, block and report retain a stable intent for the same content; retrying after an interrupted send returns the same letter.
A pending send is not delivery.
Prompt-hook intake outputs the context and confirms it; an interrupted intake may repeat the same ID.
A confirmed report delivered to its parent ends the implementor's watch without waiting for parent acknowledgement.
Only an explicit `hide watch start` arms another watch after completion.

The Observer answers from its own native pane:

```sh
hide request reply <letter-id> --intent <stable-response-intent> --body '<answer>'
```

For a human decision, ask the user in chat and preserve their words in that reply.
The actual sender remains the Observer; do not claim another sender or request an unavailable human relay.
A required PRD change still needs the existing amendment procedure and human authority below.

A gone Implementor is diagnosed from native pane state and the run record.
Dispatch one replacement with `--adopt`, as in [Recovery And Completion](#recovery-and-completion).
The replacement joins the same run as a child of the recorded Observer after authorized `hide agent end` retires the old participant.
Automatic reset must run from the actual current recorded Observer, whose native identity Hide can attest.
Watch assignment does not change the child's original registered parent: only that original parent or the actual target can end the old registration.
The actual Implementor may end its own registration from its native pane.
Sasu sends `agent end` without `--actor`; Hide authorizes the positively identified target or original parent as caller.
A current Observer who lacks that ending authority receives a refusal rather than a new replacement pane.
A changed Observer uses `sasu supervisor handover --slug <slug> --approval '<verbatim user approval>'` from the new native pane.
Sasu registers it, reads the existing watch's generation and assigns that watch with the explicit approval and current caller identity.
An active watch is assigned before Sasu updates its recorded Observer.
If `hide agent show` positively reports no active watch, the approved handover updates the Observer without restarting the watch.
Transport failures or malformed replies refuse the handover and preserve the recorded Observer; they never prove that a watch ended.
A stale generation, absent approval or wrong caller leaves Sasu's Observer authority unchanged.
Existing letters remain addressed to their original native recipient; watch assignment does not transfer them.

`sasu implement retire` and completed delivery end the implementor registration through Hide.
A repeated end converges on the ended record.
Current old-format run records are rejected explicitly; no participant or ledger migration is performed.
`sasu supervisor status` inspects registered runs, and `sasu implement status --digest` supplies their current progress and drift facts.
There is no supervisor install, timer or Stop hook.

## Handling A Letter

The hook envelope is `Hide letter <id> from <name> (<native kind>) [<letter kind>]`.
It identifies the sender and kind and includes the retained letter ID.
Read `sasu implement status --slug <slug> --digest` first.
The digest reports deterministic facts since dispatch: elapsed time, native lifecycle and last activity, commits and changed paths, churn, delivery-boundary drift, verify attempts and uncommitted changes.
It gives no semantic completion judgment.
Then read `herdr agent read <implementor-name> --source recent-unwrapped --lines 120` for diagnosis only.
The execution plan is the Implementor's declared structure and order, so it exposes a wrong structural reading before verification.

For a plan request, read the recorded plan and close the request with a confirmation reply.
State a specific disagreement in that reply when the structure differs from the PRD or an in-contract choice needs direction.
For a block, apply [Looking And Acting](#looking-and-acting).
For a report, inspect current deterministic verification and native review rather than treating delivery as completion.
For a watch warning, inspect native lifecycle before deciding whether the implementor has stalled or departed.

## Looking And Acting

When inspecting a run, compare its progress and drift facts with the approved structure and execution plan.
Hide's warnings and letters are cues to inspect; they do not evaluate commits or create a Sasu progress timer.
The Observer never edits implementation files; its moves are one line of direction, `sasu implement escalate`, or stop.
Beyond one line of direction it acts on `blocked`, an idle or done agent without a current deterministic report, `unknown` or exited runtime state, a scope or authority violation, an explicit user change, and drift.

A current drift fact needs a concrete move rather than an unsupported "fine".
Choose one:

- One line of direction, when the cause is plain from the digest and the pane tail.
- `sasu implement escalate --reason "<the drift fact>"` without `--agent`, then forward the suggested next step from the diagnosis it writes (`agents/runs/<slug>/artifacts/solver/diagnosis-<n>.md`) to the Implementor as the direction.
  The recorded Observer escalates on its own identity: the run stays the Implementor's and nobody passes `--adopt`.

If the same inspected drift fact persists after one line of direction, diagnose it through `sasu implement escalate` rather than repeating the direction.
The budget of three escalations per run stands and is the cap; once it is spent, surface the persisting drift to the user instead of looping (Sasu 13).

Before waiting for an answer, the Implementor sends `sasu implement block` with the kind, question, recommendation, reversibility and scope impact and ends its turn.
It does not open an interactive user question UI or start a second coordinator.

The Observer resolves a block without asking the user when the answer is already in the handoff, follows an established repository convention, or is an in-scope reversible default that does not weaken an acceptance criterion.
For `$please`, this includes reversible product, copy, and implementation choices that can be listed for final review.
Send an in-contract decision back to the same Implementor and require it to record the assumption in the final report, never by editing the sealed PRD.
For a required contract change, preserve existing applicable human authority and send the proposed amendment to the same Implementor through the coordinator.
A live verify execution lease refuses all domain mutations, including amendment, retirement, escalation, adoption, other domain mutations.
Wait for completion or verified process-group cleanup; a settled pane or lost target alone is not proof that its children have stopped.

If the block changes scope, an acceptance criterion, major structure, or product behavior, the Observer must not authorize divergence or edit the sealed PRD while implementation continues.
Ask the user for the explicit change required by the gate-reopen contract only when the existing human authorization does not cover it.
Only after receiving it may the main session pause implementation, return to the Spec Owner phase, reopen and reseal the affected gate with the user's words as evidence, and resume the same Implementor or a replacement from the updated ready PRD.

Receiving approval does not finish the Observer's work: it owns applying that decision to the contract and handing it back to the Implementor.
Match the user's answer to the exact pending decision and preserve the verbatim approval in the existing amendment evidence; it does not authorize unrelated changes.
Coordinate a safe implementation boundary and wait for any live verification lease to clear before reopening the gate or amending the sealed PRD.
Then complete the required gate and `amend` steps, send the canonical updated ready PRD and changed decision references to the same Implementor, and confirm it has received them before dependent implementation, review, or delivery resumes.
Until that handoff is complete, report the decision as approved but not yet applied, not as awaiting another user answer or already implemented.
Do not ask again for the same already authorized decision merely because the contract update is pending.

Ask the user only when no defensible reversible default exists or the choice needs new authority: credentials, billing or external spend, production data, destructive or irreversible action, auth or security policy, an external-service commitment, an expensive persistent data shape, unauthorized delivery, or a conflict that requires dropping an approved requirement.
Never use an Observer decision to lower verification or override a Sasu gate.

## Recovery And Completion

Do not send a blind "continue" to a stopped agent.
Inspect the lifecycle state, recent output, and Sasu status first.

- On a soft `blocked` state, resolve it under the policy above and resume the same Implementor.
- On idle or done without a current deterministic report, ask the Implementor for its exact stage and next action, then continue if no hard stop exists.
- On `unknown`, inspect the pane process and Sasu state before deciding that the agent died.
- If the Implementor died, dispatch one replacement with the same verb: it refuses while herdr still lists the first Implementor, and otherwise opens the replacement in a new pane, and hand off the original invocation, current diff, ready PRD, and Sasu status.
  The run is owned by the dead Implementor's session, so the Observer passes `--adopt` to take it over; the takeover is recorded with the previous owner.
- An automatic reset diagnosis may succeed while replacement is refused.
  `reset_not_started` means no replacement was started: inspect its stated next action and old-child ending authority, then retry from the actual recorded Observer.
  A partial replacement retains its exact phase and requires `dispatch --resume-handoff`; never present it as a fabricated successful replacement.
- Allow one autonomous resolution for the same blocker signature.
  If that blocker repeats, stop the automatic loop and surface the failed approach and recommended replan to the user.

Completion is the pipeline's own authority and nothing else's: a `done` or settled screen is a cue to look, never evidence that work finished.
For implementation, require a current PASS from `sasu implement status`, `verification-report.json`, `verification-report.md`, and visible native-agent review notes or an explicit `REVIEW_UNAVAILABLE`.
The Observer reports the Implementor pane ID, final status, autonomous decisions, user-review items, verification result, and measured PRD and implementation timing.
