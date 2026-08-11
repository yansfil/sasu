# Reviews And Finalization

Read this reference before acceptance sweeping, generating either completion review, finalizing a receipt, or handing off a blocked or partial run.

## Contents

- [Review Profiles](#review-profiles)
- [User-Directed Review Override](#user-directed-review-override)
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
Review semantics depend on the profile alone.

| Profile | Requirements fidelity | Final adversarial review | Gate tail |
| --- | --- | --- | --- |
| `trivial` | Compact, main-agent owned | Not required | fidelity review, then finalize |
| `standard` | Full combined semantic review by one fresh independent reviewer | Not required | fidelity review, then finalize |
| `high-risk` | Full, main-agent owned | Full, fresh independent reviewer | fidelity review, then final review, then finalize |

Read the complete intent, user-visible behavior, data effects, technical structure, external side effects, and delivery plan before choosing the profile.
Use `trivial` only for bounded work with no changed user-visible behavior or runtime contract.
Use `standard` for normal product and engineering changes, including small UI and UX work.
Use `high-risk` for sensitive, destructive, irreversible, costly, or production-affecting work.
The PRD's `review_rationale` makes this semantic decision auditable without teaching the harness to parse natural language.
The PRD declaration, fixed project config, and explicit CLI value are safety floors.
The harness uses the strongest declared profile, so an operational override may raise review strength but cannot silently lower a stronger semantic judgment.
A missing declaration safely falls back to `standard` only when no other floor is supplied.

## User-Directed Review Override

The safety floors above bind agent-initiated choices; they are not a license to overrule the user.
When the user explicitly changes review scope mid-run, for example "리뷰 한번만 돌리고 마무리해" or "this needs the full high-risk review", record it instead of ignoring it or silently skipping gates:

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js review-policy \
  --profile trivial|standard|high-risk \
  --reason "<the user's verbatim instruction>"
```

The command records a `review_profile_override` deviation with the quoted instruction, updates the effective policy, and the receipt carries both.
Follow the resulting effective policy from that point.
Do not run `review-policy` on your own judgment; it exists only to carry an explicit user instruction.

Supply an explicit profile when the run needs a stronger floor than the PRD or project policy.

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js init \
  --prd <prd-path> \
  --review-profile trivial|standard|high-risk
```

Lowering a stronger PRD or project-policy floor requires correcting that source explicitly rather than bypassing it at runtime.

## Review Ownership

The main agent owns compact `trivial` fidelity and full `high-risk` fidelity.
A `standard` run uses one fresh independent read-only sidecar for its combined requirements fidelity review when multi-agent tools are available.
The required final adversarial review uses a fresh independent sidecar for `high-risk`.
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

## Acceptance Residue Check

Acceptance criteria close themselves: when every verification item covering a pending AC settles and at least one passes, the harness marks it met with derived evidence (`autoMetAcceptanceCriteria` in mark/verify-run output).
A manual `met`/`not_met`/`blocked` judgment is never overridden by the auto-close.

Before completion reviews, check only the residue - any AC still `pending` means one of:

- a covering verification has not run yet: run it.
- the AC's proof genuinely lives outside the verification contract: mark `met` manually with real evidence.
- the criterion is not satisfied or is stuck: mark `not_met` or `blocked` with the reason - these always remain manual judgments.

Keep working when a required acceptance criterion is not met and no concrete blocker exists.

## Requirements Fidelity Review

Generate the strict intent-review prompt:

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js requirements-review-prompt
```

The fidelity review and the sasu verify gate divide the semantic lane and may run concurrently once the acceptance sweep is done and the code is frozen.
The gate owns per-criterion code-vs-AC verdicts from the diff; the fidelity reviewer owns intent lineage, decision provenance, deviations, and whether registered evidence proves the intent - neither consumes the other's output.
Ownership and concurrency are different axes: on `standard`, launch the independent reviewer as a background sidecar and run `sasu verify` while it works; on `high-risk`, run `sasu verify` in the background and write the main-agent fidelity review while the gate runs (the independent final adversarial review is still spawned only after fidelity is recorded); on `trivial`, the main agent writes the compact review and gate concurrency is moot.
If the gate fails and the fix changes code, the fidelity review goes stale under the normal freshness rule and must re-run; accept that risk instead of serializing the two calls.

This review compares the canonical intent source (reading depth per the spec-gate rule below), accepted decisions, rejected alternatives, PRD scope, acceptance criteria, verification evidence, and implementation result.
It is not a general code-quality review.
Fail on material semantic drift, missing user-visible behavior, diluted acceptance criteria, hidden scope, unapproved decision reversal, weak evidence for the actual user goal, or an overclaimed `Done` status.

When the verification contract or artifacts contain a user-visible surface, treat UI and UX as a fidelity overlay rather than a separate gate.
Judge primary flows and relevant loading, empty, and error states.
Judge responsive behavior and accessibility when contracted, copy and hierarchy where applicable, and explicitly separate evidence-backed findings from remaining human taste.

The reviewer must check:

- original intake, clarify, or current-conversation sources named by PRD frontmatter or PRD sections were read when available.
- when the source is qa-log.md, reading depth follows the spec-gate record (the generated prompt states which case applies). Settled case - the spec gate verdict is PASS, not overridden, and every recorded input hash still matches the qa-log and PRD on disk: the qa-log→PRD leg is already judged, so the reviewer reads the PRD's Decision Traceability section plus the implementation and registered evidence instead of the full qa-log, falling back to reading the canonical qa-log in full if anything in the PRD's decision trace looks inconsistent or truncated, the spec record looks suspicious, or a decision's provenance is unclear. Unsettled case - the spec gate is absent, stale, failed, or overridden: read the complete qa-log (Current Understanding, Decision Register, material Raw Q&A with Decision Packet content in each entry's `immediate_notes`, UX Scenario Cards, objections, evidence, and audit findings) instead of relying on a summary or parsed sample. The layering principle is that each layer sees only what only it can see: in an audited run the fidelity reviewer re-read a 37k-char qa-log behind a fresh spec-gate PASS and found zero issues the gate had not already caught.
- every material answer, accepted recommendation, objection, constraint, rejected option, non-goal, and assumption has the same meaning and provenance across `qa-log -> PRD -> implementation` or an explicit approved disposition.
- silence, lack of objection, topic changes, and continued participation were not upgraded into user approval, while unambiguous affirmative responses to explicit recommendations were preserved as accepted recommendations.
- every user decision and accepted initial proposal is represented in scope, non-goals, requirements, acceptance criteria, verification, or human verification.
- rejected options, non-goals, and guardrails stayed rejected.
- implementation evidence proves the intent behind each acceptance criterion rather than only a shallow proxy.
- every required `V#` has a Verification Intent Checklist entry mapping Pass Intent to concrete registered artifacts.
- every mapped `R#` and `AC#` is actually proven by those artifacts.
- remaining human judgment is not reported as complete.
- every recorded deviation is judged acceptable or called out; on `trivial` and `standard` profiles the fidelity review is the only reviewer that ever sees deviations.

Write:

```text
agents/implement/<topic-slug>/review/requirements-fidelity-review.md
```

The report should follow the recommended skeleton the generated prompt emits: `Intent Sources Read`, `Decision Trace`, `Findings`, `Verification Intent Checklist`, `Coverage Judgment`, `Deviation Audit`, and `Verdict`.
Structure deviations (missing sections, bullet floors, label grammar, per-`V#` mentions, placeholders) are advisory: `requirements-review-record` reports them as `structureWarnings` and never rejects on them - only the standalone `Status` line (matching `--status`) and at least one finding on a `FAIL` report are enforced mechanically.
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

For `high-risk`, perform a delta review on top of the recorded gates, not a re-derivation.
The reviewer must check:

- the requirements fidelity report exists, passed, is fresh, and has no unresolved finding hidden from the final verdict; it is the primary semantic artifact proof, and its V-by-V reasoning is reopened only where missing, generic, inconsistent, or suspicious.
- harness-owned mechanical gates (artifact registration and hashes, required-verification status) are trusted unless a signal is inconsistent, missing, or suspicious.
- task status is a coordinator self-report with no mechanical precondition; completed tasks are spot-checked against their mapped acceptance criteria and the diff.
- risky or user-critical artifacts are spot-checked by opening them, without duplicating an already sound fidelity checklist.
- every deviation is recorded and acceptable, and unrecorded drift between the diff and the plan or structure lock is a finding.
- implementation follows the PRD structure lock and guardrails with no unmapped scope.
- nothing was recorded after the reviews, and `implementation-result.md`, state, and the planned final user report agree without overclaiming.

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

When a required final review fails, fix the findings, re-capture any runtime evidence the fix invalidates, rerun requirements fidelity, then record a new passing final review; `finalize` re-runs required command-backed verification on the final tree, so do not re-run passed command-backed items manually.

Required final reviews must be independent in both time and content.
The report file must be authored after `requirements-review-record` succeeds.
An earlier report is rejected.

The report should follow the recommended skeleton:

- `Fidelity Review Checked`, citing the recorded fidelity report path and status.
- `Findings`.
- `Artifact Audit`.
- `Deviation Audit`.
- `Verdict`.

Missing or empty skeleton sections are advisory: `review-record` reports them as `structureWarnings` without rejecting.
The report must contain a standalone `Status: PASS` line when recording `--status pass` (a `FAIL` recording must carry at least one finding); it does not re-list every required `V#` (the fidelity review owns that checklist).
The harness stores a git worktree snapshot and makes the review stale when source changes afterward.

## Complete Finalization

Only after every gate required by the assigned review profile passes, run:

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js finalize \
  --status complete \
  --summary "<evidence-backed summary>"
```

`finalize --status complete` ends with a harness-timed reverification: every required verification item whose evidence carries an executed command and whose contract declares no side effect is re-run on the final tree, and any nonzero exit rejects the receipt with a `Final reverification failed` violation and a log under the run's `reverify/` directory (receipt provenance, not registered agent evidence).
This is deliberate: verify-run passes are recorded on the agent's schedule, so the receipt re-earns them on the harness's schedule.
A pass earned on a worktree whose fingerprint (HEAD plus dirty-file hashes, harness bookkeeping excluded) still matches at finalize is skipped as `fresh pass` - the honest flow of running the final suite right before finalizing therefore costs nothing, and only passes the tree has drifted away from re-run.
The accepted blind spot of that skip is gitignored-only drift, which git status cannot see; any tracked or untracked change re-triggers the run.
Skipped items (non-shell evidence, declared side effects, fresh passes) are stamped into the receipt's `finalReverification` with their reason - do not try to route around the re-run; fix the failing check instead.

Do not report done and do not mark the tracked Goal complete until:

- `receipt.json` exists.
- `status` reports zero open tracked items.
- every required verification item is `pass` with artifact-backed evidence.
- every met acceptance criterion has at least one covering verification item in `pass` status.
- verification and execution plans are ready.
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

When the verify gate is BLOCKED with its retry budget exhausted and every tracked item is complete, the gate itself is the blocker: `finalize --status blocked` succeeds and the receipt stamps the gate snapshot (verdict, attempts, findings).

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

`finalize --status complete` rejects completion mechanically when any of these remain:

- the receipt is missing.
- the execution or verification plan is missing or has blocking gaps.
- PRD tasks, acceptance criteria, or verification items are open or lack evidence.
- a met acceptance criterion has no covering verification item in `pass` status.
- requirements fidelity is missing, failed, or stale.
- a required final review is missing, failed, or stale.
- source, evidence, artifacts, plans, or deviations changed after a passing review.
- required artifacts are missing, empty, invalid, unregistered, hash-mismatched, the wrong kind, or (for command/automated checks) missing verify-run execution metadata.
- required verification is blocked, skipped, failed, pending, or lacks artifact-backed evidence.
- the sasu verify gate ran and is BLOCKED, or its PASS went stale.

The agent additionally owns these completion duties, which the harness cannot check:

- create or complete the tracked Goal when Goal tools are available.
- stop verification-only runtime processes or record the explicit exception.
- run the verify gate (or record the `sasu` binary's unavailability in `context-notes.md`); a `NOT_RUN` gate is stamped into the receipt.
