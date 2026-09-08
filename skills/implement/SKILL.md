---
name: implement
description: |
  Project-local approved-PRD implementation executor and Observer entrypoint.
  Use when the user invokes "$implement", explicitly asks to execute an approved
  PRD through the receipt-backed workflow, or wants the complete PRD implemented,
  independently reviewed, and finalized with current evidence.
  Do not use for ordinary implementation requests that have no approved PRD.
---

# implement

Implement the complete approved PRD and finish with an honest current receipt.
Match the user's language.
Before any repository write or mutating command, resolve the structural session role using the Observer reference below.
In Herdr, the user-facing session observes and one marked Implementor executes; `$please` keeps specification in the main session until the PRD is ready.
The benchmark coordinator is the explicit in-session Implementor when its contract requires that arrangement.

```text
approved PRD -> autonomous implementation and actual QA
  -> verify: required suites + one independent full-contract review
  -> fix concrete findings and verify again within the recorded bound
  -> finalize: current complete, complete-pending-human, or blocked receipt
  -> authorized local or PR delivery
```

`state.json` is the only machine record.
`receipt.json` and `implementation-result.md` are derived outputs.
Every requirement remains in the sealed PRD and independent review input.
No requirement has its own lifecycle, mandatory evidence file, judge call, or PASS object.
Do not replace removed CLI bookkeeping with Markdown checkboxes or a coverage ledger.

## Reference Routing

Read each directly linked reference completely when its condition applies.

| Reference | Read when |
| --- | --- |
| [`references/observer-and-herdr.md`](references/observer-and-herdr.md) | Before a direct Herdr invocation, when dispatched after `$please` PRD readiness, or when an Implementor blocks or needs recovery. |
| [`references/execution-planning.md`](references/execution-planning.md) | Before implementation or when execution order is unclear. |
| [`references/verification-and-evidence.md`](references/verification-and-evidence.md) | Before collecting or registering actual evidence and before verify. |
| [`references/verification-environments.md`](references/verification-environments.md) | When a browser, mobile, TUI, or native desktop flow needs observation. |
| [`references/reviews-and-finalization.md`](references/reviews-and-finalization.md) | Before verify, finalize, human confirmation, or a blocked handoff. |
| [`references/worktrees-and-delivery.md`](references/worktrees-and-delivery.md) | When delivery is `pr`, a worktree is configured, or post-receipt delivery is requested. |

## Core Invariants

- Never implement a pending PRD without explicit human approval or the user's verbatim conversational approval.
- Read the full Goal, Non-goals, Decisions, Behaviors, Technical structure, and Risks.
  Preserve all requirements and decision provenance without inventing scope.
- The CLI executes the sealed required suites before independent review, records actual execution, validates evidence integrity, and pins the current inputs.
- The independent reviewer compares the complete contract with implementation, permitted surrounding source, actual test results, shared observations, and prior findings.
  A high-risk run retains a distinct safety review with the same fixed inputs.
- The implementor may collect and register its own QA evidence with honest provenance.
  The independent review decides whether those observations are sufficient.
- `sasu implement finalize` never runs tests, judges, capture tools, or external commands.
- `state.json` is the completion authority; receipt files are its portable derived result.
  Never hand-edit the state, hashes, execution history, review findings, or counters.
- The whole verify execution holds one lease through suite execution, judge completion, and state persistence.
  Other domain mutations are refused while it is live; status and event waiting remain available.
- A first failed verify leaves the run active with the failed attempt and open findings.
  Fix the actual cause; do not replace state to reset the budget.
- Only the person's own words resolve a human confirmation, and an open explicit rejection makes delivery ineligible.
- Commit, push, PR creation, CI, and merge are post-receipt delivery outcomes.

## 1. Confirm Readiness And Start

Read the complete PRD, relevant project instructions, likely source files, and `git status --short`.
Confirm `status: ready` and `human_approval: approved`, or preserve existing conversational approval exactly.
Read prerequisite decisions and risks before acting; pending deployment, payment, access, destructive action, or unresolved product policy cannot become an after-the-fact confirmation.

```sh
sasu implement start --prd agents/prd/<topic-slug>/prd.md
```

When approval is in conversation:

```sh
sasu implement start --prd agents/prd/<topic-slug>/prd.md \
  --allow-unapproved-prd '<verbatim user approval>'
```

Start seals the full PRD, static behavior references, source baseline, ownership, and required suite list from `agents/config.json` or repository detection.
A missing suite is reported as no required tests, never as tests all passed.
The three-column Behaviors table contains `#`, `사용자가 관찰하는 행동`, and `결정`.
Retired document and state formats fail with the expected contract and last supported commit; rewrite and approve a new document rather than migrating old results.

If start reports dirty judged paths, use the authorized attribution: `--dirty-attribution pre-existing`, `--dirty-attribution run-owned`, or the exact path-complete JSON map provided in its refusal.
Preserve unrelated changes.
For a handoff with `DIRTY ATTRIBUTION`, pass the supplied value exactly; do not repeat the ownership interview in the Implementor pane.
Read `workingRoot` from the response and implement in that directory.

```sh
sasu implement status
```

Status reports current source identity, required suites, review state, open findings, human responses, delivery eligibility, and the next action.
Do not create a Codex Goal unless the user explicitly requested goal tracking.

## 2. Implement And Observe

Choose a plan suited to the work, grouping changes by coherent product flow and risk boundary.
Requirements are references for understanding scope, not mandatory execution units.
Use focused tests while editing and observe actual product behavior where it matters.
For screens, drive the real flow and inspect the result; a build or function definition does not establish a working interaction.

Delegate independent work when useful with explicit non-overlapping file ownership and the relevant requirements and decisions in each brief.
Workers return changes, observed checks, and evidence provenance; the Implementor coordinates run commands.
The CLI alone writes `state.json`.
Do not add a required task document, flow-ID scheme, or requirement-by-requirement checklist.

Collect final screenshots, recordings, API traces, database observations, or logs when the implementation is coherent.
One flow may support several requirements.
Register material actual evidence once at run level:

```sh
sasu implement artifact --kind screenshot --path docs/screenshots/example.png \
  --description '<observed flow and limitations>' --source '<collector and method>' \
  --collected-at '<ISO capture time>' --target '<actual build or URL>' --environment '<environment>'
```

For several files, use `artifact --manifest <path>` with a JSON array of objects containing `kind`, `path`, and `description`, plus optional `source`, `collectedAt`, `target`, `environment`, and `requirementRefs` (an array of Bn strings).
`--refs B1,B2` adds optional explanatory requirement references; it is never a coverage requirement.
Registration pins file identity and preserves provenance.
Missing or modified registered files fail integrity checks.
A source hash cannot establish that an external service, ignored fixture, database, or installed app is unchanged; explain the validity of earlier observations or recapture affected behavior.
No artifact is required merely because a keyword occurs in the PRD.
The source catalog lists paths, not file contents or read permission.
When surrounding source is needed, one current shared `file` artifact may support many Bn references without a per-Bn mapping.

## 3. Apply Authorized Contract Changes

The Implementor reports proposed requirement, decision, scope, profile, or source-intake changes to the user-facing coordinator.
Only human-authorized amendments change the sealed contract:

```sh
sasu implement amend --issuer human --approval '<verbatim user approval>' --reason '<what changed and why>'
```

Existing approval that covers the change is sufficient; do not ask the same permission again.
Amend archives the superseded PRD, refreshes the snapshot and mirrored metadata, and invalidates the whole review's freshness.
`--exclude-suite <S#,...>` is the only way to exclude a sealed suite; it preserves the command, its last result, and approval history.
Changing config after start cannot quietly weaken required verification.
Human confirmations whose source changes retain their closure or replacement history.
Wait for a live verify lease to settle before any amendment or other mutation.

## 4. Verify The Whole Result

Freeze implementation and registered evidence, then run:

```sh
sasu implement verify
```

The CLI records one attempt with fixed inputs:

1. Validate the run, ownership, current contract/source, and registered evidence.
2. Execute the sealed required suites once per identical command, cwd, and execution configuration.
3. Independently review the complete contract against actual code, permitted surrounding source, test results, shared QA evidence, and prior findings.
4. For high-risk work, additionally review distinct data-loss, permission, destructive-action, and delivery-safety questions using the same fixed inputs.
5. Persist actual calls, execution results, errors and their stages, finding history, timing, and current-input identity.

The routine path uses one comprehensive review, regardless of the number of requirements.
Its result records defects, optional advisories, and genuine human confirmations with concrete contract and evidence references.
The harness validates structure and references; requirement satisfaction is independent semantic judgment, not a mechanical guarantee of zero omissions.
A claimed PASS cannot override an accompanying open defect.

Fix concrete defects and supply missing observations, then explicitly verify again.
Prior open findings require an explicit resolved or unresolved disposition; omission from a later list never closes them.
A real newly discovered omission in an unchanged file still counts when grounded in the approved contract and actual counterevidence.
Do not launch extra adversarial review loops over the same contract.

The harness bounds correction rounds and separates backend failures from implementation defects.
Open high-risk blockers keep the run incomplete even when routine review passes.
Blocked closure requires an exhausted correction budget, three consecutive identical pre-judge failures on the same inputs, a bounded judge backend error loop, or recorded human risk non-convergence when those risks are the only remaining blockers.
While the run is still active, use `verify --grant-budget '<verbatim user approval>'` only after the user authorized continued verification.
Otherwise, close an eligible terminal failure honestly with `sasu implement finalize --status blocked`.
Never discard state or invent a new run to reset the same failed effort.

## 5. Finalize And Confirm

After current required suites and review satisfy the completion rules:

```sh
sasu implement finalize
```

Finalize reads state and hashes and refuses stale inputs, evidence corruption, unresolved defects, blocking risk, or unmet prerequisite authority.
Successful finalization writes a v5 receipt and implementation result from v9 state.
Repeated finalize with unchanged inputs is idempotent.
A permitted after-the-fact human confirmation may leave `complete-pending-human`; that status does not excuse an explicit open rejection.

Do not report Done before the current status, receipt, and implementation result agree on a complete result.
Report actual tests and observations, the full-contract review, unresolved items, and limitations without a requirement PASS table or a “100% execution verified” claim.

Only the human closes or rejects a real confirmation item:

```sh
sasu implement confirm --issuer human --id <confirmation-id> --evidence "<the user's own words>"
sasu implement confirm --issuer human --id <confirmation-id> --reject --evidence '<what the user found wrong>'
```

Confirm preserves response history and regenerates the receipt from current source identity.
A rejection remains open and blocks delivery until the person explicitly withdraws it and approves that same result.
Source fixes after closure require a new run; closed runs do not reopen.
Already delivered results are not automatically reverted by a later rejection.

## 6. Blocked Handoff And Delivery

An attempted verify alone does not permit blocked closure; the first failed verify leaves the run active for repair.
Once a recorded terminal condition applies, `finalize --status blocked` closes the run even if no judge result succeeded.
The closed run cannot resume; any authorized budget extension must be recorded while it is still active, before finalizing.
Report the failed phase, actual executions and unrun stages, open findings, evidence or freshness error, and recovery.
Use `retire` for a cancelled or incorrectly started run before verification.
When an Observer owns the user channel, emit its `OBSERVER_BLOCK` packet rather than opening an interactive question UI in the Implementor pane.
Do not use user-only overrides.

After a delivery-eligible receipt, complete the existing authorization:

- Local delivery: `node ~/.codex/skills/ship/scripts/prd_ship.js local --state <state.json>`.
- PR delivery: use `$ship` for scoped staging, commit, push, PR, CI, and the existing merge boundary.

## Command Contract

Every `sasu implement` command and accepted flags appear here.
A contract test compares this table with help and the runtime authority registry in both directions.
Global flags omitted from the table: `--json`, `--slug`, `--state`, `--adopt`, `--issuer`.
Issuer labels declare responsibility and preserve audit history; they are not authentication.

| Command | Required | Optional | Issuer |
| --- | --- | --- | --- |
| `intake` | - | - | anyone |
| `start` | `--prd` | `--allow-unapproved-prd`, `--dirty-attribution` | anyone |
| `confirm` | `--id`, `--evidence` | `--reject` | human |
| `amend` | `--reason`, `--approval` | `--exclude-suite` | human |
| `dispatch` | `--name`, `--prd` | `--kind`, `--model`, `--effort` | anyone |
| `escalate` | `--reason` | `--target`, `--agent` | observer, human |
| `await` | - | `--since`, `--pid`, `--agent`, `--notify-after` (automatic re-arm value) | anyone |
| `artifact` | `--kind`, `--path`, `--description` (or `--manifest`) | `--source`, `--collected-at`, `--target`, `--environment`, `--refs` | implementor, human |
| `status` | - | - | anyone |
| `risk` | `--accept`, `--id`, `--evidence` | - | implementor, human |
| `risk --non-convergent` | `--id`, `--approval`, `--reason` | - | human |
| `verify` | - | `--grant-budget` | implementor, human |
| `retire` | - | - | implementor, human |
| `finalize` | - | `--status` | implementor, human |

Dispatch reads the complete handoff on stdin and refuses a pane already marked `SASU_HERDR_ROLE=implementor`.
A mutation of another session's run requires existing verbatim adoption authority.
A live verify lease refuses all other domain mutations, including adoption, retirement, escalation, risk decisions, and human confirmation.
`risk --non-convergent` records a person's declaration that an open risk cannot converge; it enables honest blocked closure, never complete delivery.

## Hard Stops

Surface a missing prerequisite or a material contract change to the coordinator.
Use the authority already granted in the conversation; only new authority or unresolved product policy needs a new decision.
Do not proceed through credentials, billing, production data, destructive operations, or irreversible delivery beyond that authorization.

## Final Report

Report the implemented outcome and full PRD link, actual tests and QA observations, independent review result, current-input identity, and receipt path.
State the receipt status, delivery eligibility, open findings and human judgments, deviations, autonomous assumptions, timing when measured, and remaining risks.
Separate implementation completion from local commit or PR delivery and from checks that were skipped, failed, or unavailable.
