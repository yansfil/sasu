---
topic: "ho-build Review Policy v2"
status: "ready"
human_approval: "pending"
source_intake: "current conversation"
source_clarity: "none"
created_at: "2026-07-14"
updated_at: "2026-07-14"
---

# PRD: ho-build Review Policy v2

## 1. Summary

Replace `ho-build`'s keyword-only risk classification and duplicated standard review path with a versioned, profile-aware review policy that preserves strict evidence and fidelity guarantees while removing unnecessary process.
The completed workflow must keep `trivial`, `standard`, and `high-risk` as policy profiles rather than lifecycle states, omit review nodes that are not required, preserve full dual review for genuinely high-risk work, and make normal work finish through one independent semantic review.
This is a production-quality workflow change, not an experimental shortcut, and it must remain backward-compatible with active legacy runs.

Approval checklist:

- Approve the three-profile review matrix and the removal of the second mandatory review from new `standard` runs in Sections 3 and 6.
- Approve sentence-level, negation-aware sensitive-operation classification instead of raw risk keyword matching in Sections 5 and 6.
- Approve `reviewProfile.policyVersion: 2` as compatibility metadata without adding a lifecycle state or changing the persisted state schema in Sections 5 and 6.
- Approve UI and UX judgment as a conditional fidelity-review overlay rather than a new gate in Sections 6 and 9.
- Approve local-only delivery with no commit, push, PR, deployment, external provider call, production data access, or billing action in this run.

## 2. Problem, Goal, And Users

The current automatic classifier promotes any PRD containing words such as `database`, `auth`, `security`, `external`, or `production` to `high-risk`, even when those words occur in a negated non-goal or documentation-only statement.
The recently completed progressive-disclosure PRD was classified `high-risk` because it explicitly said that database and external-system behavior would not change.
The current gate helper also requires both requirements fidelity and final adversarial review for every `standard` run, so a nominally thin final review still incurs another sequential sidecar, report, freshness boundary, and TaskGraph node.
Historical runs show that strict requirements fidelity can catch real semantic and evidence gaps, while repeated final review often rechecks already valid mechanical state.

The goal is to preserve the parts that protect product intent and proof while making the default path adaptive in practice.
The primary users are agents implementing approved PRDs, maintainers of the engineering harness, and humans reviewing implementation receipts.

## 3. Scope And Non-Goals

In scope:

- Replace raw whole-document risk keyword matching with structured, sentence-level risk signals that distinguish actual sensitive mutations from negation, non-goals, documentation, tests, and meta-workflow discussion.
- Preserve explicit CLI and project-config review profile overrides with their existing precedence.
- Add a version marker inside `reviewProfile` so new runs use policy v2 while states without the marker retain legacy v1 gate behavior.
- Make new `trivial` runs require mechanical verification, a compact main-agent fidelity review, and a receipt without a final adversarial review.
- Make new `standard` runs require mechanical verification, one fresh independent combined fidelity review, and a receipt without a second final adversarial review.
- Keep new `high-risk` runs on the full main-agent fidelity review followed by an independent adversarial final review.
- Materialize the `REVIEW` TaskGraph and checklist node only when the effective policy requires it.
- Make hooks, status text, next-item guidance, generated prompts, reports, and receipts agree with the effective review policy.
- Keep harness-owned mechanical validation separate from reviewer-owned semantic, UX, risk, and overclaim judgment.
- Add regression coverage for classification, compatibility, gate routing, TaskGraph shape, prompt ownership, stale review behavior, installation, and skill discovery.
- Forward-test the installed skill against isolated standard and high-risk fixture PRDs with fresh agents.

Non-goals:

- No new lifecycle status, review profile name, harness command, review report file, reviewer queue, worker state, resource lock, or orchestration service.
- No weakening of PRD snapshot validation, execution-plan completion, required `V#` status, artifact registration, hash integrity, evidence kind, worktree snapshot, or stale-review invalidation.
- No prompt-only removal of deterministic completion gates.
- No conversion of `ho-build` into an autonomous scheduler that mutates harness state from subagents.
- No parallel execution by default and no parallelization of a review that semantically depends on a previous frozen review.
- No UI implementation work.
- No redesign of `ho-interview`, `ho-scope`, `ho-spec`, `please`, `ho-ship`, or the completed progressive-disclosure structure.
- No telemetry schema, background monitoring process, or future-run performance gate in this implementation.
- No cleanup, reversal, or unrelated formatting of existing uncommitted rename, interview, specification, installer, documentation, or test changes.
- No commit, push, pull request, CI run, release, or deployment.

## 4. Pre-Work And Required Decisions

### 4.1 Pre-Work Before Implementation

None required.
The repository, current dirty-worktree baseline, installed skills, harness scripts, and complete local test suite are available.

### 4.2 Human Decisions Before PRD Approval

The exact `$please do that` invocation authorizes the one-shot local implementation path while leaving `human_approval` pending and recording the invocation as the Stage 2 approval deviation.
No external, destructive, production, billing, credential, or irreversible action is required.

### 4.3 Decision Traceability For Fidelity Review

- Accepted: keep strict requirements fidelity because it protects original intent and per-`V#` evidence quality.
  Represented by R5, R6, AC6, AC7, T3, and the non-goals.
- Accepted: remove the second mandatory review from normal `standard` work instead of making two overlapping reviews run in parallel.
  Represented by R3, R4, AC3, AC4, T2, and T3.
- Accepted: preserve full dual review for actual DB migration, auth or security behavior, payments, credentials, production data, live providers, deploy, rollback, and equivalent sensitive changes.
  Represented by R1, R3, AC1, AC5, T1, and T2.
- Accepted: use structured positive-operation signals and ignore negated or meta mentions rather than trusting raw keyword presence.
  Represented by R1, AC1, AC2, and T1.
- Accepted: add no new lifecycle state, user-facing phase, command, or report file.
  Represented by R2, R4, R8, AC4, AC8, and the non-goals.
- Accepted: keep implementation and independent verification parallelizable only through existing ready-node guidance and coordinator ownership.
  Represented by R7, AC9, T3, and the non-goals.
- Accepted: treat UI and UX review as conditional semantic guidance derived from existing browser/runtime verification, not a new state or gate.
  Represented by R6, AC7, T3, and V4.
- Rejected: rely on a short prompt alone and remove deterministic artifact, freshness, or receipt enforcement.
  Represented by the non-goals, R5, AC6, and Guardrails G2-G3.
- Rejected: add more profile names or a separate `completion-review` artifact.
  Represented by R3, R4, AC3, AC4, and Guardrail G4.
- Deferred: evaluate median review-tail time over the next five real `standard` runs using existing ledger timestamps.
  Represented as a follow-up metric in Section 10 and is not required for this receipt.
- Assumption: local delivery is correct because no `agents/config.json` exists and the conversation did not authorize repository publication.
  Represented by the Summary checklist, non-goals, and Guardrail G8.

## 5. Major Technical Structure Changes

The persisted state schema remains `hoyeon.prd-implement.state.v1`.
New runs add `policyVersion: 2` and structured signal evidence inside the existing `reviewProfile` object.
States without `reviewProfile.policyVersion` are interpreted as legacy policy v1 and keep the existing final-review requirement for `standard`.

Automatic profile classification changes from whole-document keyword presence to sentence-level risk evidence.
High-risk classification requires a sensitive surface and an affirmative in-scope mutation or live operation, while negated, non-goal, documentation-only, test-only, and meta-workflow sentences are excluded from automatic escalation.

TaskGraph generation becomes policy-aware.
Policy v2 `trivial` and `standard` graphs connect `REQ_FIDELITY_REVIEW` directly to `FINALIZE`, while `high-risk` and legacy v1 `standard` graphs retain `REQ_FIDELITY_REVIEW -> REVIEW -> FINALIZE`.

The existing requirements-fidelity report remains the single report used by new `standard` runs.
Its generated prompt becomes profile-aware so a fresh read-only reviewer performs the combined semantic review for `standard`, while `trivial` remains main-agent owned and `high-risk` retains the existing two-stage ownership split.

No application, API, database, infrastructure, provider, or production architecture changes are expected.

## 6. Requirements

- R1. Automatic review-profile classification must produce auditable sentence-level signals and must classify affirmative sensitive mutations as `high-risk` without escalating negated, non-goal, documentation-only, test-only, or meta-workflow mentions.
- R2. CLI `--review-profile` must continue to override project config, project config must continue to override auto classification, and each result must retain an explicit source and human-readable reason.
- R3. The effective policy matrix must be `trivial = compact main fidelity only`, `standard v2 = one independent combined fidelity review`, and `high-risk = main fidelity plus independent final review`.
- R4. New policy behavior must use the existing profile names, commands, lifecycle statuses, review file paths, receipt schema, and requirements-fidelity record rather than introducing another process layer.
- R5. Required verification, artifact validation, PRD snapshot checks, TaskGraph coverage, execution completion, freshness, worktree snapshot, and receipt authority must remain deterministic and unchanged in strength.
- R6. The standard combined reviewer must focus on original intent, accepted and rejected decisions, AC and `V#` meaning, registered artifact proof, user-visible behavior, UI and UX evidence when applicable, deviations, and overclaiming, while avoiding full test reruns or complete hash recomputation unless evidence is inconsistent or suspicious.
- R7. Existing parallel-ready-node behavior and coordinator-only state mutation must remain unchanged, and review ordering must preserve frozen-evidence and independence requirements.
- R8. Legacy states without `policyVersion` must remain resumable and must retain the review gate that was in force when they were initialized.
- R9. Checklist, TaskGraph, status, next-item guidance, Stop and Goal guards, generated prompts, rendered implementation result, and receipt must consistently describe the effective policy.
- R10. The repository skill source, installed Codex skill, reference documentation, automated tests, and fresh-agent forward tests must agree on policy v2 behavior.

## 7. Acceptance Criteria

- AC1. A non-trivial PRD containing `No database, auth, security, production data, or external provider changes` is auto-classified `standard`, and the classification reason contains no false sensitive mutation signal.
- AC2. Documentation-only auth or security work is not auto-classified `high-risk`, while an actual production DB migration, credential rotation, auth behavior change, payment change, live provider call, deploy, or rollback fixture is auto-classified `high-risk` with the matching source sentence recorded.
- AC3. A new policy v2 `standard` run can finalize after a passing requirements-fidelity review with `finalReview: null`, and its receipt records review profile policy version 2.
- AC4. A new policy v2 `standard` or `trivial` TaskGraph contains no `REVIEW` node and connects requirements fidelity directly to finalization without adding any replacement node or report.
- AC5. A new `high-risk` run cannot finalize without a fresh passing final adversarial review and retains the existing two-stage graph and prompt sequence.
- AC6. The harness still rejects missing or failed required verification, missing or invalid artifacts, hash drift, unregistered evidence, stale fidelity, stale final review when required, PRD drift, execution gaps, and incomplete acceptance criteria.
- AC7. For a browser/runtime or otherwise user-visible standard run, the combined fidelity prompt requires judgment of the registered UX evidence, primary flows and relevant states, responsive or accessibility evidence when contracted, copy and hierarchy where applicable, and remaining human taste without creating a separate UX gate.
- AC8. A legacy `standard` state with no policy version still requires the existing final review, preserves its TaskGraph shape, and remains finalizable through the old path.
- AC9. Existing parallel-ready-node tests, session binding, worktree behavior, delivery boundaries, rule injection, and Goal completion guards continue to pass unchanged.
- AC10. The complete Node suite, skill validation, local installer, installed real-file check, reference resolution, and Codex prompt discovery pass on frozen final content.
- AC11. Fresh-agent dry runs against isolated standard and high-risk fixture PRDs report the correct profile, required review sequence, and absence or presence of the `REVIEW` node without receiving the intended verdict in their prompt.
- AC12. The implementation changes only the review-policy source, profile-aware documentation, directly related tests and goldens, and the new PRD while preserving all pre-existing unrelated worktree changes.

## 8. PRD-Level Tasks

- T1. Implement auditable, negation-aware review risk classification and versioned policy metadata with legacy compatibility. Covers R1, R2, R8, AC1, AC2, and AC8.
- T2. Make completion gates, TaskGraph shape, status rendering, hooks, next-item routing, receipts, and legacy behavior follow the effective review policy. Covers R3, R4, R5, R8, R9, AC3, AC4, AC5, AC6, AC8, and AC9.
- T3. Make review prompts and skill references express the profile-specific ownership, semantic and UX review depth, mechanical-validation boundary, and safe subagent coordination rules. Covers R3, R4, R6, R7, R9, AC5, AC7, and AC9.
- T4. Add focused classification, gate, graph, compatibility, prompt, freshness, and golden regression coverage while preserving the complete existing suite. Covers R1, R2, R3, R4, R5, R6, R7, R8, R9, AC1, AC2, AC3, AC4, AC5, AC6, AC7, AC8, AC9, AC10, and AC12.
- T5. Validate and install the final skill, verify discovery and file layout, then forward-test isolated standard and high-risk fixtures with fresh agents. Covers R10, AC10, AC11, and AC12.

## 9. Verification Contract

This workflow change is proven through deterministic harness tests, complete repository regressions, installed-skill validation, and independent forward tests against isolated fixtures.
There is no application UI, live provider, database, production data, or deployment surface in this run.

### 9.1 Test Mode Contract

| Mode | Required For Done | Covers | Human Decision |
| --- | --- | --- | --- |
| build/static | yes | JavaScript syntax, skill metadata, document structure, and diff hygiene | none |
| automated behavior | yes | classifier, policy routing, legacy compatibility, graph, hooks, prompts, freshness, and complete regressions | none |
| local runtime | yes | installed real-file skill, references, and Codex discovery | none |
| manual-agent | yes | fresh-context standard and high-risk policy behavior | none |

### 9.2 Required Agent Verification

| ID | Mode | Covers | Method | Artifact | Pass Criteria | Environment | Required For Done | Can Be Blocked | Safe Probe | Live Proof | Side Effect | Sensitive Data Policy |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| V1 | build/static | R4, R5, R9, R10, AC6, AC10, AC12 | `node --check skills/ho-build/scripts/prd_state_harness.js && python /Users/hoyeonlee/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/ho-build && git diff --check` | command-log | JavaScript parses, skill structure validates, and the final diff has no whitespace errors | local shell | yes | no | read-only local validation | command log | none | no secrets |
| V2 | automated behavior | R1, R2, R3, R4, R5, R6, R7, R8, R9, AC1, AC2, AC3, AC4, AC5, AC6, AC7, AC8, AC9, AC10, AC12 | `node --test tests/*.test.mjs` | command-log | every focused and repository-wide Node test passes with zero failures | local shell | yes | no | temporary fixture repositories only | command log | temporary files under test-controlled directories | no secrets |
| V3 | local runtime | R10, AC10 | `node scripts/install-local-skills.mjs && test -f "$HOME/.codex/skills/ho-build/SKILL.md" && test ! -L "$HOME/.codex/skills/ho-build/SKILL.md" && test -f "$HOME/.codex/skills/ho-build/references/reviews-and-finalization.md" && codex debug prompt-input '$ho-build' > /tmp/ho-build-review-policy-v2-prompt.txt && rg 'ho-build' /tmp/ho-build-review-policy-v2-prompt.txt` | command-log | installer exits 0, installed entrypoint is a real file, the review reference resolves, and Codex discovery contains `ho-build` | local shell and user skill directory | yes | no | local installation only | command log | replaces installed local skill files and auxiliary links owned by this repository and writes one temporary prompt file | do not print credentials or unrelated prompt content |
| V4 | manual-agent | R3, R6, R7, R9, R10, AC3, AC4, AC5, AC7, AC8, AC11 | fresh read-only agents run `$ho-build` against isolated standard and high-risk fixture PRDs and return raw status and review-routing observations | file | the standard fixture reports one combined fidelity path with no required `REVIEW` node, the high-risk fixture reports dual review with `REVIEW`, and neither agent modifies repository source or receives the intended verdict in its task prompt | isolated temporary repositories and fresh agent context | yes | no | local fixture initialization and read-only observation only | raw agent output files | temporary harness artifacts only | no secrets or user data |

### 9.3 Human Verification

None required for receipt.
The change has no user-facing visual surface, and semantic judgment is covered by requirements fidelity plus the profile-required independent review and fresh-agent forward tests.
The deferred five-run timing metric remains a later operational observation rather than a human approval gate.

## 10. Risks And Open Decisions

- Risk: negation handling can become a fragile pile of keywords and miss a real sensitive operation.
  Mitigation: keep explicit override precedence, require affirmative operation-plus-surface signals, record matched sentences, test English and Korean negation and meta examples, and default uncertain non-trivial work to `standard` rather than `trivial`.
- Risk: changing final-review requirements can silently weaken active runs.
  Mitigation: version the policy inside `reviewProfile` and interpret missing versions as legacy v1.
- Risk: omitting an optional TaskGraph node can break validators, renderers, hooks, goldens, or receipt summaries that assumed it always existed.
  Mitigation: make all consumers depend on the same effective-policy helper and add end-to-end graph and finalization tests for every profile and legacy state.
- Risk: standard review can become a shallow self-check if independence is only instructional.
  Mitigation: generated prompt and skill rules require a fresh read-only reviewer when subagents are available, raw inputs rather than coordinator conclusions, and an explicit manual fallback when unavailable.
- Risk: reviewer prompts can still duplicate harness work.
  Mitigation: state that mechanical completion is enforced at record time and require complete recomputation only for inconsistencies, suspicion, or high-risk work.
- Risk: installed skill behavior can diverge from repository source.
  Mitigation: install from the repository and validate discovery on frozen final content.
- Open follow-up: after five real policy v2 `standard` receipts, calculate last-evidence-to-receipt median from existing ledger timestamps and target 2 to 4 minutes without adding telemetry schema in this run.

## 11. Implementation Guardrails

- G1. Do not change the state schema string, receipt schema, command names, lifecycle statuses, review file paths, or required artifact classes.
- G2. Do not weaken deterministic completion, evidence, hash, freshness, PRD snapshot, worktree snapshot, or session-binding checks.
- G3. Do not let a reviewer report substitute for a failed mechanical gate, and do not let mechanical validity substitute for semantic evidence judgment.
- G4. Do not add another review profile, review report, TaskGraph gate, lifecycle phase, or user-visible command.
- G5. Do not classify a genuinely sensitive change below `high-risk` merely to save time.
- G6. Do not let subagents mutate harness state, record reviews, finalize receipts, update Goal state, or overwrite unrelated work.
- G7. Do not alter existing parallel defaults, worktree configuration, delivery semantics, PRD parser contracts, or unrelated skills except for direct policy wording required for `ho-build` consistency.
- G8. Do not commit, push, open a pull request, trigger CI, deploy, or contact external systems in local delivery mode.
- G9. Preserve every pre-existing dirty file and distinguish baseline changes from this run in the final report.
- G10. Use `apply_patch` for source edits and never modify auto-generated or changelog files.

## 12. Implementation Result Report Contract

The implementation report must include:

- Status: `Done`, `Partially Done`, or `Blocked`.
- The PRD path and the recorded exact `$please do that` approval deviation.
- The final review policy matrix and the compatibility behavior for legacy states.
- The risk-classification model with representative positive, negated, documentation-only, and high-risk fixture outcomes.
- The effective TaskGraph and hook behavior for `trivial`, policy v2 `standard`, `high-risk`, and legacy `standard`.
- The files and major modules changed and confirmation that the approved technical structure was followed.
- T1-T5 and AC1-AC12 status.
- V1-V4 evidence paths and results by verification mode.
- Automated tests added or updated and the regression risk each protects.
- Fresh-agent forward-test observations without leaking the intended verdict into their prompts.
- Requirements-fidelity and final-review verdicts required by the current run's assigned profile.
- Confirmation that deterministic verification, artifact, freshness, receipt, parallel, worktree, session, delivery, and Goal guards remain intact.
- Existing baseline dirty files, this run's additional changes, deviations, remaining human review, not-done items, risks, and follow-up candidates.
- Delivery mode and confirmation that no commit, push, PR, CI, release, or deployment occurred.
