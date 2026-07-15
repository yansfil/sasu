---
topic: "ho-build progressive disclosure"
status: "ready"
human_approval: "pending"
source_intake: "current conversation"
source_clarity: "none"
created_at: "2026-07-14"
updated_at: "2026-07-14"
---

# PRD: ho-build Progressive Disclosure

## 1. Summary

Refactor the oversized `skills/ho-build/SKILL.md` into a compact orchestration entrypoint and a small set of directly linked, conditionally loaded reference documents.
The refactor must preserve the current implementation workflow, state harness contract, verification gates, review requirements, delivery behavior, and safety stops.
This run changes instruction organization only and does not introduce new TaskGraph states, parallel scheduling behavior, or harness logic.

Approval checklist:

- Approve the behavior-preserving scope and explicit non-goals in Section 3.
- Approve the four-reference progressive-disclosure structure in Section 5.
- Approve the line-budget and instruction-preservation requirements in Sections 6 and 7.
- Approve the build/static and automated behavior verification modes in Section 9.
- Approve local-only delivery with no commit, push, or PR in this run.

## 2. Problem, Goal, And Users

The current `ho-build` entrypoint is 757 lines and mixes core routing, state lifecycle, verification mechanics, execution graph details, review report schemas, worktree safety, and delivery handoff rules in one always-loaded document.
That size makes the skill harder to scan and increases the chance that an agent loses the important routing and stop conditions among phase-specific detail.

The goal is to make the first read materially smaller while keeping every operational contract discoverable at the point it is needed.
The primary users are agents executing approved PRDs and maintainers changing or debugging the `ho-build` workflow.

## 3. Scope And Non-Goals

In scope:

- Reduce `skills/ho-build/SKILL.md` below 500 lines, targeting roughly 300 to 400 lines without weakening the core workflow.
- Keep core purpose, readiness checks, lifecycle ordering, primary commands, completion authority, hard stops, and reference-routing rules in `SKILL.md`.
- Organize detailed instructions into at most four direct files under `skills/ho-build/references/`.
- Expand and reorganize the existing execution graph reference and add focused references for verification/evidence, reviews/finalization, and worktrees/delivery.
- Add regression checks that protect the new document structure and keep the existing harness and installer suites passing.
- Reinstall the local skills and verify that Codex can see the updated `ho-build` skill and its reference files.

Non-goals:

- No changes to TaskGraph generation, node schemas, state files, ledger events, receipt semantics, or harness commands.
- No new parallel-execution, worker-state, resource-lock, reviewer-node, or verification-node behavior.
- No split or redesign of `ho-spec`, `ho-interview`, `ho-scope`, `please`, or other skills in this run.
- No product UI or UX work.
- No commit, push, pull request, CI automation, or release delivery.
- No cleanup or modification of unrelated existing worktree changes.

## 4. Pre-Work And Required Decisions

### 4.1 Pre-Work Before Implementation

None required.
The repository, installed skills, validation scripts, and test suite are available locally.

### 4.2 Human Decisions Before PRD Approval

The `$please` invocation authorizes the one-shot local implementation path while leaving PRD frontmatter approval as `pending` and recording the invocation as the Stage 2 approval deviation.
No additional decision is required because the refactor is reversible, local-only, and does not change runtime behavior or external systems.

### 4.3 Decision Traceability For Fidelity Review

- Accepted: split the oversized `ho-build` skill into progressive-disclosure references now.
  Represented by R1-R5, AC1-AC5, and T1-T3.
- Accepted: preserve the current process rather than adding more states or phases.
  Represented by R3, R6, AC3, AC6, and the non-goals.
- Accepted: detailed verification and review guidance should remain available, but agents should load it only when the corresponding phase requires it.
  Represented by R2, R4, AC2, AC4, and T1-T2.
- Deferred: TaskGraph parallelism improvements, subagent scheduling changes, verifier decomposition, resource locks, and new graph node types.
  Represented by the non-goals and Guardrails G2-G3.
- Deferred: splitting `ho-spec` or `ho-interview` in the same run.
  Represented by the non-goals and Guardrail G4.
- Assumption: four direct references are enough to separate concerns without creating a reference maze.
  Represented by R2 and AC2.
- Assumption: delivery is local because no `agents/config.json` exists and the conversation did not authorize a PR.
  Represented by the Summary checklist, non-goals, and T4.

## 5. Major Technical Structure Changes

No application, API, database, infrastructure, or runtime architecture changes are expected.

The skill documentation structure changes to this direct one-level layout:

```text
skills/ho-build/
├── SKILL.md
├── references/
│   ├── execution-graph.md
│   ├── verification-and-evidence.md
│   ├── reviews-and-finalization.md
│   └── worktrees-and-delivery.md
└── scripts/
```

`SKILL.md` remains the sole entrypoint and tells the agent exactly which reference to read for each phase or condition.
References must not create a second level of required reference chasing.

## 6. Requirements

- R1. `skills/ho-build/SKILL.md` must remain a complete orchestration entrypoint and stay below 500 physical lines, with a target range of 300 to 400 lines.
- R2. The detailed contract must be organized into no more than four directly linked reference files with explicit read conditions and no required nested references.
- R3. Every material directive in the pre-refactor `ho-build/SKILL.md` and `references/execution-graph.md` must remain represented in the new entrypoint or exactly one appropriate reference without semantic weakening.
- R4. Any reference longer than 100 lines must include a concise table of contents near its top, and duplicated normative guidance between the entrypoint and references must be minimized.
- R5. Automated regression tests must guard the line budget, reference existence, direct routing, long-reference table of contents, and essential core invariants.
- R6. The refactor must not change harness source behavior, installer semantics, generated implementation artifacts, delivery defaults, or unrelated dirty files.
- R7. The installed Codex skill must use a real `SKILL.md` file, expose all new references, and remain visible through `codex debug prompt-input`.

## 7. Acceptance Criteria

- AC1. `skills/ho-build/SKILL.md` has fewer than 500 physical lines and keeps the purpose, approval rule, strict receipt authority, coordinator ownership, required flow, hard stops, and final report contract in the entrypoint.
- AC2. The entrypoint directly links exactly the four approved reference files and states when each one must be read.
- AC3. A semantic comparison against the committed pre-refactor documents finds no dropped or weakened readiness, state, verification, artifact, subagent, review, worktree, delivery, finalization, or safety rule.
- AC4. Every reference over 100 lines has a table of contents, and normative material is located in one primary document rather than copied across multiple documents.
- AC5. A dedicated structure regression test and the complete existing Node test suite pass without changing harness behavior or existing expected outputs.
- AC6. Only in-scope `ho-build` documentation and the dedicated regression test are newly changed by this run; pre-existing unrelated changes remain intact.
- AC7. Local installation succeeds, installed `ho-build/SKILL.md` is not a symlink, all four installed references resolve, and `codex debug prompt-input '$ho-build'` lists the skill.

## 8. PRD-Level Tasks

- T1. Design the one-level reference routing and move execution, verification, review, finalization, worktree, and delivery detail into the approved reference files.
  Covers R2, R3, R4, AC2, AC3, and AC4.
- T2. Rewrite `skills/ho-build/SKILL.md` as the compact entrypoint while preserving all lifecycle, safety, and completion invariants.
  Covers R1, R2, R3, R4, AC1, AC2, AC3, and AC4.
- T3. Add a focused document-structure regression test and run the full existing test suite to prove harness and installer behavior remain stable.
  Covers R5, R6, AC5, and AC6.
- T4. Install the updated local skills and verify the real-file entrypoint, installed references, and Codex skill visibility.
  Covers R7 and AC7.

## 9. Verification Contract

Documentation structure is protected by automated structural assertions and the existing harness and installer regressions.
Semantic instruction preservation is better proven by the required requirements-fidelity review comparing the committed source text, the PRD decisions, and the resulting documents than by brittle phrase snapshots.

### 9.1 Test Mode Contract

| Mode | Required For Done | Covers | Human Decision |
| --- | --- | --- | --- |
| build/static | yes | skill metadata validity and document structure | none |
| automated behavior | yes | structure regression, harness regression, and installer behavior | none |
| local runtime | yes | installed file layout and Codex skill discovery | none |

### 9.2 Required Agent Verification

| ID | Mode | Covers | Method | Artifact | Pass Criteria | Environment | Required For Done | Can Be Blocked | Safe Probe | Live Proof | Side Effect | Sensitive Data Policy |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| V1 | build/static | R1, R2, R3, R4, AC1, AC2, AC3, AC4 | `python /Users/hoyeonlee/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/ho-build` | command-log | skill metadata and required structure validate with exit code 0 | local shell | yes | no | read-only validation | command log | none | no secrets |
| V2 | automated behavior | R5, R6, AC5, AC6 | `node --test tests/*.test.mjs` | command-log | dedicated structure assertions and the complete Node suite pass with exit code 0 | local shell | yes | no | local test suite | command log | temporary test fixtures only | no secrets |
| V3 | local runtime | R7, AC7 | `node scripts/install-local-skills.mjs && test -f "$HOME/.codex/skills/ho-build/SKILL.md" && test ! -L "$HOME/.codex/skills/ho-build/SKILL.md" && test -f "$HOME/.codex/skills/ho-build/references/execution-graph.md" && test -f "$HOME/.codex/skills/ho-build/references/verification-and-evidence.md" && test -f "$HOME/.codex/skills/ho-build/references/reviews-and-finalization.md" && test -f "$HOME/.codex/skills/ho-build/references/worktrees-and-delivery.md" && codex debug prompt-input '$ho-build' | rg 'ho-build'` | command-log | installer exits 0, the entrypoint is a real file, all references resolve, and Codex prompt discovery contains `ho-build` | local shell and user skill directory | yes | no | local installation only | command log | updates installed local skill files and links auxiliary directories | do not print credentials or unrelated prompt content |

### 9.3 Human Verification

None required.
There is no user-facing UI or product behavior, and semantic preservation is covered by the strict requirements-fidelity review plus the independent final review required by the assigned review profile.

## 10. Risks And Open Decisions

- Risk: shrinking the entrypoint can accidentally hide a mandatory rule behind a reference that is not loaded at the right phase.
  Mitigation: explicit read conditions, essential invariant retention, structure tests, and semantic fidelity review.
- Risk: moving text can create contradictory duplicate guidance.
  Mitigation: each normative topic has one primary location and the final review audits duplication and routing.
- Risk: the installed skill can diverge from the repository source.
  Mitigation: run the installer and verify both the real entrypoint file and reference visibility.
- Deferred decision: whether `ho-spec` or `ho-interview` also need progressive-disclosure refactors will be evaluated separately after this run.
- Deferred decision: TaskGraph and subagent parallelism improvements remain a separate behavior-changing PRD.

## 11. Implementation Guardrails

- G1. Do not expand scope beyond the behavior-preserving `ho-build` instruction refactor and its focused regression test.
- G2. Do not modify harness JavaScript, state schemas, graph planning, hook behavior, receipt semantics, or generated artifact formats.
- G3. Do not introduce new process states, graph nodes, worker coordination mechanisms, or parallel-execution rules.
- G4. Do not edit other skill documents as part of this refactor.
- G5. Do not overwrite, revert, or reformat pre-existing unrelated worktree changes.
- G6. Do not weaken approval, safety, verification, evidence, review, delivery, or completion gates to meet the line budget.
- G7. Do not commit, push, open a pull request, or trigger CI in local delivery mode.

## 12. Implementation Result Report Contract

The implementation report must include:

- Status: `Done`, `Partially Done`, or `Blocked`.
- The PRD path and the recorded `$please` approval deviation.
- The final entrypoint line count and the resulting reference layout.
- A concise mapping of moved rule categories and confirmation that the approved technical structure was followed.
- T1-T4 and AC1-AC7 completion status.
- V1-V3 evidence paths and results by verification mode.
- The dedicated regression coverage added and the regression risks it protects.
- Requirements-fidelity and final-review verdicts.
- Confirmation that harness behavior and unrelated dirty files were not changed by this run.
- Any deviations, remaining human review, not-done items, risks, and follow-up candidates.
- Delivery mode and confirmation that no commit, push, or PR occurred.
