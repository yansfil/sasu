# Reviews And Finalization

Read this reference before acceptance sweeping, generating either completion review, finalizing a receipt, or handing off a blocked or partial run.

## Contents

- [Review Profiles](#review-profiles)
- [Review Ownership](#review-ownership)
- [Acceptance Sweep](#acceptance-sweep)
- [Requirements Fidelity Review](#requirements-fidelity-review)
- [Fidelity Review Recording And Freshness](#fidelity-review-recording-and-freshness)
- [Final Adversarial Review](#final-adversarial-review)
- [Final Review Recording And Freshness](#final-review-recording-and-freshness)
- [Complete Finalization](#complete-finalization)
- [Blocked Or Partial Finalization](#blocked-or-partial-finalization)
- [Completion Authority](#completion-authority)

## Review Profiles

The agent assigns a semantic review profile in PRD frontmatter, and the harness records it during `init`.
New runs store `reviewProfile.policyVersion: 2` without changing the state schema or adding a lifecycle state.
States without that field use legacy policy v1 so an active run keeps the gate it had when initialized.

| Effective policy | Requirements fidelity | Final adversarial review | TaskGraph tail |
| --- | --- | --- | --- |
| Policy v2 `trivial` | Compact, main-agent owned | Not required | `REQ_FIDELITY_REVIEW -> FINALIZE` |
| Policy v2 `standard` | Full combined semantic review by one fresh independent reviewer | Not required | `REQ_FIDELITY_REVIEW -> FINALIZE` |
| Policy v2 `high-risk` | Full, main-agent owned | Full, fresh independent reviewer | `REQ_FIDELITY_REVIEW -> REVIEW -> FINALIZE` |
| Legacy v1 `trivial` | Compact, main-agent owned | Not required, legacy skipped node retained | `REQ_FIDELITY_REVIEW -> REVIEW -> FINALIZE` |
| Legacy v1 `standard` | Full, main-agent owned | Thin, fresh independent reviewer | `REQ_FIDELITY_REVIEW -> REVIEW -> FINALIZE` |

Read the complete intent, user-visible behavior, data effects, technical structure, external side effects, and delivery plan before choosing the profile.
Use `trivial` only for bounded work with no changed user-visible behavior or runtime contract.
Use `standard` for normal product and engineering changes, including small UI and UX work.
Use `high-risk` for sensitive, destructive, irreversible, costly, or production-affecting work.
The PRD's `review_rationale` makes this semantic decision auditable without teaching the harness to parse natural language.
The PRD declaration, fixed project config, and explicit CLI value are safety floors.
The harness uses the strongest declared profile, so an operational override may raise review strength but cannot silently lower a stronger semantic judgment.
A missing declaration safely falls back to `standard` only when no other floor is supplied.

Supply an explicit profile when the run needs a stronger floor than the PRD or project policy.

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js init \
  --prd <prd-path> \
  --review-profile trivial|standard|high-risk
```

Lowering a stronger PRD or project-policy floor requires correcting that source explicitly rather than bypassing it at runtime.

## Review Ownership

The main agent owns compact `trivial` fidelity and full `high-risk` fidelity.
A policy v2 `standard` run uses one fresh independent read-only sidecar for its combined requirements fidelity review when multi-agent tools are available.
The required final adversarial review uses a fresh independent sidecar for policy v2 `high-risk` and legacy v1 `standard`.
Use a default independent subagent with fresh context for either independent role.
In Codex, omit `agent_type` and use `fork_context: false` when the tool supports that option.
In Claude Code, use the default general-purpose subagent.
Do not choose a `hoyeon-*` role unless the user explicitly requests that role.

Pass raw artifact paths and the generated review prompt rather than the coordinator's conclusions.
Reviewer sidecars are read-only and must not edit files, mutate harness state, call `mark`, call either review-record command, call `finalize`, or update Goal state.
The coordinator evaluates the findings and records the report.

If multi-agent tools are unavailable, write `Subagent unavailable: <reason>` in the applicable report and perform a fresh manual pass.
Never silently skip a required independent review.

Mechanical completion belongs to the harness.
Reviewers should trust passing tracked-state, artifact-registration, hash, freshness, and required-verification gates unless evidence is inconsistent, missing, or suspicious.
They should not spend the default path rerunning the complete test suite or recomputing every artifact hash.

## Acceptance Sweep

Before completion reviews, sweep every acceptance criterion.

- Set status to `Met`, `Not Met`, or `Blocked`.
- Attach command, test, screenshot, DOM result, API response, DB query, or file evidence.
- Include related task IDs.

Keep working when a required acceptance criterion is not met and no concrete blocker exists.

## Requirements Fidelity Review

Generate the strict intent-review prompt:

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js requirements-review-prompt
```

This review compares the complete canonical qa-log or conversation source, accepted decisions, rejected alternatives, PRD scope, acceptance criteria, verification evidence, and implementation result.
It is not a general code-quality review.
Fail on material semantic drift, missing user-visible behavior, diluted acceptance criteria, hidden scope, unapproved decision reversal, weak evidence for the actual user goal, or an overclaimed `Done` status.

When the verification contract or artifacts contain a user-visible surface, treat UI and UX as a fidelity overlay rather than a separate gate.
Judge primary flows and relevant loading, empty, and error states.
Judge responsive behavior and accessibility when contracted, copy and hierarchy where applicable, and explicitly separate evidence-backed findings from remaining human taste.

The reviewer must check:

- original intake, clarify, or current-conversation sources named by PRD frontmatter or PRD sections were read when available.
- when the source is qa-log.md, the complete Current Understanding, Decision Register, material Raw Q&A and Decision Packets, UX Scenario Cards, objections, evidence, and audit findings were read instead of relying on a summary or parsed sample.
- every material answer, accepted recommendation, objection, constraint, rejected option, non-goal, and assumption has the same meaning and provenance across `qa-log -> PRD -> implementation` or an explicit approved disposition.
- silence, lack of objection, topic changes, and continued participation were not upgraded into user approval, while unambiguous affirmative responses to explicit recommendations were preserved as accepted recommendations.
- every user decision and accepted initial proposal is represented in scope, non-goals, requirements, acceptance criteria, verification, or human verification.
- rejected options, non-goals, and guardrails stayed rejected.
- implementation evidence proves the intent behind each acceptance criterion rather than only a shallow proxy.
- every required `V#` has a Verification Intent Checklist entry mapping Pass Intent to concrete registered artifacts.
- every mapped `R#` and `AC#` is actually proven by those artifacts.
- remaining human judgment is not reported as complete.

Write:

```text
agents/implement/<topic-slug>/review/requirements-fidelity-review.md
```

The report must include a `Verification Intent Checklist` section.
For every required `V#`, list the PRD Pass Intent or derived pass criteria, covered `R#` and `AC#` IDs, registered artifact paths inspected, a `PASS` or `FAIL` judgment, and any gap.
A passing review must fail when a required `V#` is missing, lacks a registered artifact path, or has an artifact that does not prove its mapped requirement or acceptance criterion.

## Fidelity Review Recording And Freshness

Record a passing report with:

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js requirements-review-record \
  --status pass \
  --report agents/implement/<topic-slug>/review/requirements-fidelity-review.md \
  --summary "<requirements fidelity verdict>"
```

The report must contain a standalone `Status: PASS` line when recording `--status pass`.
A missing or mismatched status line is rejected.

When the fidelity review fails, fix its findings or mark the implementation `Blocked` or `Partially Done` with evidence.
Do not proceed to a final adversarial review or complete receipt until requirements fidelity passes.

Any implementation, evidence, verification, plan, artifact, or deviation change after a passing fidelity review makes it stale.
The harness also stores a git worktree snapshot that excludes the current implementation artifact directory, so source changes after review require a rerun.

For a blocked or partial handoff, still run and record requirements fidelity.
That report may contain `Status: FAIL`, but it must compare original intent, decisions, PRD scope, acceptance criteria, verification evidence, and implementation result.
The handoff must reflect the verdict and must not soften it into `Done`.

## Final Adversarial Review

Generate the reviewer prompt only after requirements fidelity has been recorded and the effective policy requires final review, or when a human explicitly requests an optional review:

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js review-prompt
```

Before this review, stop verification-only runtime servers, browser sessions, tunnels, and background processes unless there is an explicit reason to leave one running.
Record shutdown evidence or the intentional left-running exception.

For legacy v1 `standard`, keep the final review thin.
Audit freshness, state consistency, artifact validity, deviations, and overclaiming.
Reopen full item-by-item proof only when the fidelity review is weak, generic, inconsistent, or suspicious.

For `high-risk`, perform the full adversarial review.
The reviewer must check:

- the requirements fidelity report exists, passed, is fresh, and has no unresolved finding hidden from the final verdict.
- the fidelity report is the primary semantic artifact proof.
- disagreements, omissions, or weak reasoning are called out instead of silently repeating the same checklist.
- the PRD remained free of executor-only write scopes, owners, parallel safety, low-level dependencies, and ready-node scheduling.
- the execution plan maps every PRD task to nodes.
- the TaskGraph accounts for execution nodes, task rollups, acceptance criteria, verification, requirements fidelity review, the policy-required final review, and receipt.
- every acceptance criterion is met with evidence.
- every required verification item passed with registered artifacts.
- no missing, empty, invalid, unregistered, hash-drifted, stale, or wrong-kind artifact remains.
- `Artifact Audit` summarizes valid evidence classes, spot-checks risky or user-critical artifacts, and lists weak or missing proof without duplicating an already sound fidelity checklist.
- every deviation is recorded and acceptable.
- implementation follows the PRD structure lock and guardrails.
- `implementation-result.md`, state, and the planned final user report agree.

Write:

```text
agents/implement/<topic-slug>/review/final-review.md
```

## Final Review Recording And Freshness

Record a passing final review with:

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js review-record \
  --status pass \
  --report agents/implement/<topic-slug>/review/final-review.md \
  --summary "<review verdict>"
```

When a required final review fails, fix the findings, rerun affected verification and requirements fidelity, then record a new passing final review.

Required final reviews must be independent in both time and content.
The report file must be authored after `requirements-review-record` succeeds.
An earlier report is rejected.

The report must include these sections:

- `Fidelity Review Checked`, citing the recorded fidelity report path and its SHA-256 from `state.json`.
- `Findings`.
- `Checklist Coverage`.
- `Artifact Audit`.
- `Deviation Audit`.
- `Verdict`.

The report must reference every required `V#` and contain a standalone `Status: PASS` line when recording `--status pass`.
The harness stores a git worktree snapshot and makes the review stale when source changes afterward.

## Complete Finalization

Only after every gate required by the assigned review profile passes, run:

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js finalize \
  --status complete \
  --summary "<evidence-backed summary>"
```

Do not report done and do not mark the tracked Goal complete until:

- `receipt.json` exists.
- `status` reports zero open tracked items.
- every required verification item is `pass` with artifact-backed evidence.
- verification and execution plans are ready.
- the TaskGraph has no blocking gate violations.
- artifact validation has no violation.
- requirements fidelity status is `pass` and fresh.
- final review status is `pass` and fresh when the profile requires it.
- verification-only runtime processes are stopped or intentionally left running with an explicit report.

After the complete receipt, use the local cleanup or PR delivery handoff defined in `worktrees-and-delivery.md`.

The generated implementation result must use `Done`, `Partially Done`, or `Blocked` and must follow the PRD's Implementation Result Report Contract.
It includes the effective review policy, approval deviations, evidence and registered artifacts, initial-versus-final worktree scope, delivery boundaries, review verdicts, receipt, and coordinator context notes.
New runs capture `initialWorktreeSnapshot` at initialization so the final report can distinguish preserved dirty entries from changes added during the run.
Legacy runs without that snapshot must provide explicit baseline provenance in registered evidence and `context-notes.md` rather than claiming a clean baseline.

## Blocked Or Partial Finalization

Do not write a blocked or partial handoff until:

- a requirements fidelity report exists.
- its standalone `Status` is `PASS` or `FAIL`, matches the recorded status, and is fresh.
- every cited blocker or known not-done item has evidence.
- the report status is `Blocked` or `Partially Done`, never `Done`.

Use:

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js finalize \
  --status blocked \
  --summary "<evidence-backed blocker summary>"

node ~/.codex/skills/implement/scripts/prd_state_harness.js finalize \
  --status partial \
  --summary "<evidence-backed partial handoff summary>"
```

Do not mark the tracked Goal complete for blocked or partial outcomes.
Call `update_goal blocked` only when the Goal tool's own repeated-blocker contract is satisfied.
Otherwise leave the Goal active and report the receipt state honestly.

## Completion Authority

The receipt is the only authoritative implementation completion proof.
Goal state is lifecycle control and may mirror a successful receipt, but it is not a second proof artifact.

`finalize --status complete` and completion hooks must reject completion when any of these remain:

- the receipt is missing.
- a Goal is missing when Goal tools were available.
- the execution plan is missing or has open nodes.
- PRD tasks, acceptance criteria, or verification items are open.
- the verification plan has blocking gaps.
- the TaskGraph is missing execution nodes or gates.
- requirements fidelity is missing, failed, or stale.
- a required final review is missing, failed, or stale.
- source, evidence, artifacts, plans, or deviations changed after a passing review.
- required artifacts are missing, empty, invalid, unregistered, hash-mismatched, or the wrong kind.
- required verification is blocked, skipped, failed, pending, or lacks artifact-backed evidence.
- verification-only runtime processes are still running without an explicit exception.
