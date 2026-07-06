---
name: prd
description: |
  Project-local PRD writer. Use when the user invokes "$prd", asks for a PRD,
  product requirements document, implementation-ready requirements, or wants to
  turn intake/clarify output into a human-reviewable requirements contract with
  major technical structure changes, PRD-level tasks, a compact verification
  contract, required test modes, human verification, risks, guardrails, and an
  implementation result report contract.
---

# prd

Use this skill to write an implementation-ready PRD from intake output or the
current conversation.

The PRD is a human decision contract and an implementation handoff. Do not
implement code while using this skill.

Match the user's language by default.

## Default Inputs

Prefer an explicit context path. The default pre-PRD handoff is:

```text
.hoyeon/intake/<topic-slug>/prd-handoff.md
```

Legacy clarify summaries are still accepted:

```text
.hoyeon/clarify/<topic-slug>/clarity-summary.md
```

If no context path is provided, inspect `.hoyeon/intake/` first for the matching
or most recent topic, then `.hoyeon/clarify/`. If no handoff exists and major
ambiguity remains, ask one blocking question or recommend `$intake`.

## Output Contract

Create:

```text
.hoyeon/prd/<topic-slug>/prd.md
```

For non-trivial PRD work, also keep:

```text
.hoyeon/prd/<topic-slug>/context-notes.md
.hoyeon/prd/<topic-slug>/intent-scope-audit.md
.hoyeon/prd/<topic-slug>/verification-contract-audit.md
```

"Non-trivial" means any of: 3 or more PRD-level tasks, DB schema or migration
changes, auth/security surfaces, payments or billing, external services or
credentials, production data, or scope that spans more than one working
session. Everything else is trivial.

Use short kebab-case topic slugs. If the source intake topic exists, reuse the
same slug.

## Required Structure

`prd.md` must include these sections:

```markdown
---
topic: "<topic>"
status: "draft | ready"
human_approval: "pending | approved"
source_intake: ".hoyeon/intake/<topic-slug>/prd-handoff.md | current conversation"
source_clarity: ".hoyeon/clarify/<topic-slug>/clarity-summary.md | none"
created_at: "YYYY-MM-DD"
updated_at: "YYYY-MM-DD"
---

# PRD: <topic>

## 1. Summary

## 2. Problem, Goal, And Users

## 3. Scope And Non-Goals

## 4. Pre-Work And Required Decisions

### 4.1 Pre-Work Before Implementation

### 4.2 Human Decisions Before PRD Approval

### 4.3 Decision Traceability For Fidelity Review

## 5. Major Technical Structure Changes

## 6. Requirements

## 7. Acceptance Criteria

## 8. PRD-Level Tasks

## 9. Verification Contract

### 9.1 Test Mode Contract

### 9.2 Required Agent Verification

### 9.3 Human Verification

## 10. Risks And Open Decisions

## 11. Implementation Guardrails

## 12. Implementation Result Report Contract
```

Do not include `Post-Work` as a default top-level section. Put launch notes,
follow-ups, monitoring, or operational checks inside Risks, Guardrails, or the
Result Report Contract when they matter.

## Section Intent

### Human Approval Contract

`status` and `human_approval` are different gates:

- `status: ready` means the agent-side quality gates and audits passed.
- `human_approval: "approved"` means the user actually reviewed the PRD and
  approved it. The PRD-writing agent always writes `pending` and never sets
  `approved` on its own. Set `approved` only after the user explicitly approves,
  and quote or reference that approval when updating it.
- `prd-implement` refuses to initialize against a PRD whose `human_approval` is
  not `approved`, so a PRD that skips human review cannot be executed silently.

To make the human review fast, end the `## 1. Summary` section with a short
`Approval checklist` bullet list: the 3 to 7 concrete things the user is
approving (scope boundary, structure changes, verification modes, any risky
decision), each pointing to its section.

### Delivery Contract

If the user asks for PR automation, CI completion, worktree execution, or a
ship-to-PR workflow, preserve that as a delivery decision in the PRD.
Do not treat PR delivery as an implementation detail that can be decided later.

Represent delivery mode in the existing sections instead of adding a new
top-level section:

- Add a Summary approval checklist item for `delivery mode: local | pr`.
- Add a Human Decision when the user must approve PR creation, CI watching,
  branch naming, or worktree setup.
- Add Decision Traceability bullets for accepted delivery choices and rejected
  alternatives.
- Add a PRD-level release or delivery hygiene task when PR delivery is part of
  done.
- Add Verification Contract rows for PR body, pushed branch, PR URL, and CI
  only when the PRD itself requires delivery proof.
- Add the delivery result to the Implementation Result Report Contract.

When the repository has `.hoyeon/config.json`, read it before drafting and
reflect relevant defaults in the PRD.
The config is not a substitute for human approval when delivery can create
branches, commits, pull requests, deployments, external calls, or CI spend.

### 1. Summary

Shortly state what will change and why. End with the `Approval checklist`
described above.

### 2. Problem, Goal, And Users

Put product reason near the top. A reviewer should understand the user and goal
before reading technical or verification details.

### 3. Scope And Non-Goals

Define included and excluded behavior. This is a primary human review surface.

### 4. Pre-Work And Required Decisions

Separate actions from approvals.

`Pre-Work Before Implementation` is action-oriented:

- API keys, credentials, test accounts, billing, permissions.
- source files, design assets, copy, seed data.
- migration windows, backups, account setup.

`Human Decisions Before PRD Approval` is decision-oriented:

- approve scope and non-goals.
- approve major technical structure changes.
- approve storage/API/external-service choices.
- approve required-for-done verification modes.
- approve delivery mode and PR/CI automation when requested.
- approve live/external proof and sensitive-data handling.

If none are needed, write `None required` with a short reason.

`Decision Traceability For Fidelity Review` is the handoff surface for the
strict intent-review subagent that runs at the end of `prd-implement`.

Include compact bullets for:

- user decisions that materially shape scope, UX, data, architecture,
  verification, delivery, live proof, or non-goals.
- initial proposals or options the user accepted.
- proposals, options, or behaviors the user rejected or explicitly deferred.
- where each decision is represented: `R#`, `AC#`, `T#`, `V#`, non-goal,
  human verification, risk, or guardrail.

If the PRD is based only on the current conversation and no separate intake file
exists, preserve the essential user decision text here rather than relying on
chat history. If no decisions beyond approval are needed, write `None beyond
scope approval` with a short reason.

### 5. Major Technical Structure Changes

This is high-level technical review, not implementation detail.

Include:

- new API/service boundaries.
- DB/schema/migration/storage changes.
- infra/deploy/job/queue changes.
- auth/payment/email/external-service/production-data boundaries.
- major architecture or data-flow changes.

Exclude:

- component names, hooks, helper functions, test file names.
- write scopes, owners, low-level dependencies, ready-node scheduling.

If no structural change is expected, say `No major technical structure change
expected`.

### 6-8. Requirements, Acceptance Criteria, PRD-Level Tasks

Requirements and ACs must be testable. Tasks are PRD-level obligations, not
executor nodes.

Task rules:

- Every task traces to at least one requirement unless it is pure verification
  or release hygiene.
- Tasks must not add hidden scope beyond approved requirements.
- Do not include write scopes, owners, parallel safety, low-level dependencies,
  or subagent scheduling. `prd-implement` derives those.
- If implementation later needs an unmapped task or material structure change,
  the agent must ask for approval before continuing.

Use IDs in the text:

```markdown
- R1. ...
- AC1. ...
- T1. ... Covers R1, AC1.
```

#### Test Coverage Bias

For implementation work, default to adding or updating automated regression tests for every newly introduced or materially changed behavior.

Automated regression coverage is required by default for changed behavior.
If the PRD omits automated tests for an in-scope behavior, it must explain why that behavior is better proven by browser/runtime, live API, DB probe, or human verification.
Do not weaken this default just because adding tests is inconvenient.

Prefer high-signal tests in this order:

- pure logic and data transformation tests.
- API/service boundary tests.
- component or hook behavior tests.
- browser/runtime smoke tests for critical user flows.
- external/live-provider safe probes only when approved and non-destructive.

Do not require tests that only lock implementation details, duplicate framework behavior, create brittle snapshots, depend on production data, or make the suite meaningfully slower without covering a real regression risk.
Low-risk copy-only, content-only, documentation-only, or one-off operational changes may use a non-automated verification mode only when the PRD explicitly states why automated regression coverage would not protect a meaningful future regression.

When the existing repo has weak or missing test infrastructure, include a PRD-level task to establish the smallest useful test harness needed for the changed behavior, then cover the new behavior with at least one regression test.

### 9. Verification Contract

The PRD defines verification intent and done requirements. `prd-implement`
turns this into concrete commands, browser flows, DB/API probes, artifact
paths, reruns, deviations, and receipts.

Keep the PRD compact. Do not force the PRD to list every exact file path or
command when the executor can derive it safely from repo reality.

#### 9.1 Test Mode Contract

This table is required. Keep it short, usually 3 to 6 rows.

```markdown
| Mode | Required For Done | Covers | Human Decision |
| --- | --- | --- | --- |
| build/static | yes | repo health | none |
| automated behavior | yes | core behavior and regressions | none |
| browser/runtime | yes | main user flow | final UX judgment |
| live external API | no/blockable | external integration | credentials/account required |
```

Modes should say which classes of proof count for done. They are not executor
commands.

`automated behavior` should be required-for-done by default for non-trivial code changes.
If a PRD marks automated behavior as optional, blocked, or not applicable, it must state the product or infrastructure reason.

#### 9.2 Required Agent Verification

Use a lean verification matrix by default.
`Mode` is required and must match one row from the Test Mode Contract.
Write this matrix under the `9.2 Required Agent Verification` subsection.
Do not put Test Mode Contract rows in this subsection.

```markdown
| ID | Mode | Covers | Pass Intent | Required For Done | Can Be Blocked |
| --- | --- | --- | --- | --- | --- |
| V1 | build/static | R1-R4, AC1 | repo build/static checks do not regress | yes | no |
| V2 | automated behavior | R2, AC2 | behavior is covered by automated test | yes | no |
| V3 | browser/runtime | R1-R4, AC1-AC4 | main flow works in browser runtime | yes | no |
```

Full legacy matrices are still valid for old PRDs. When writing a new PRD with
exact commands already known, still include `Mode`:

```markdown
| ID | Mode | Covers | Method | Artifact | Pass Criteria | Environment | Required For Done | Can Be Blocked | Safe Probe | Live Proof | Side Effect | Sensitive Data Policy |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| V1 | build/static | R1, AC1 | `pnpm build` | command-log | exits 0 | local shell | yes | no | none | command log | none | no secrets |
```

Rules:

- `Required For Done` is `yes` by default.
- The Test Mode Contract sets the mode-level default. Verification rows should
  repeat `Required For Done`; if omitted, `prd-implement` inherits the mode
  default.
- A blocked required check prevents a complete receipt.
- Optional or human-blockable checks must explicitly say `Required For Done:
  no` or inherit `no/blockable` from the matching Test Mode row.
- Every `R#` and `AC#` should map to automated behavior verification or a clearly justified non-automated mode.
- Automated verification rows should state the regression risk they protect, not just the command they run.
- Browser/UI work should include a browser/runtime mode unless impossible.
- Server/API/DB/external work should include the relevant mode and side-effect
  or sensitive-data policy when applicable.
- Live external/API proof needs a safe probe or an explicit human/account
  blocker.

For live/API/DB/external checks, add compact safety columns rather than
expanding the whole PRD into executor detail:

```markdown
| ID | Mode | Covers | Pass Intent | Required For Done | Can Be Blocked | Safe Probe | Side Effect | Sensitive Data Policy |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| V4 | live external API | R4, AC4 | external/API proof follows safe-probe policy | no | yes | validate sandbox credentials with non-mutating call | may create sandbox record only if approved | redact tokens and personal data |
```

#### 9.3 Human Verification

Only include checks requiring human judgment:

- scope, structure, or live-proof approval.
- final copy, tone, visual taste, policy/product interpretation.
- account ownership, billing, production approval, stakeholder sign-off.

If none are needed, write `None required` with a short reason.

### Intent And Scope Audit

After drafting the PRD, run a read-only intent and scope audit before marking the PRD `ready`.
For non-trivial PRDs, write the audit to:

```text
.hoyeon/prd/<topic-slug>/intent-scope-audit.md
```

Required report format:

```markdown
# Intent And Scope Audit

Status: PASS | FAIL

## Sources Read

- <intake/clarify/current PRD paths and sections>

## Intent Coverage

- <user decision or source requirement>: represented by <scope/non-goal/R#/AC#/T#/V#/human verification> | gap: <none or issue>

## Scope Boundary Audit

- Included scope: <represented and bounded>
- Non-goals/rejected/deferred items: <preserved or gap>

## Findings

- <severity>: <finding>

## Verdict

PASS only if the PRD preserves the user's accepted decisions, rejected options, non-goals, and intended outcome before implementation begins.
```

If the audit is `FAIL`, revise the PRD and rerun the audit before marking the PRD `status: ready`.

### Verification Contract Auditor

For non-trivial PRDs, run a fresh independent read-only Verification Contract
Auditor after drafting the PRD when multi-agent tools are available.
Use a default subagent, not a `hoyeon-*` role, unless the user explicitly asks
for that role.
If subagents are not available, perform the same audit yourself and say so in
the report.
For trivial PRDs, perform the coverage and pass-intent check yourself and rely
on the Harness Readiness Gate for mechanical coverage instead of writing a
separate audit file.

The auditor does not write the PRD. It attacks the verification contract and
reports whether implementation completion would actually prove the user's
requirements.

Write the audit to:

```text
.hoyeon/prd/<topic-slug>/verification-contract-audit.md
```

Required report format:

```markdown
# Verification Contract Audit

Status: PASS | FAIL

## Sources Read

- <intake/clarify/current PRD paths and sections>

## Coverage Audit

- <R#/AC#/T#>: covered by <V# or human verification> | gap: <none or issue>

## Pass Intent Audit

- <V#>: pass intent is observable by <artifact/tool> | gap: <none or issue>

## Human Judgment Boundary

- <what remains human-only, blocked, or explicitly non-required>

## Findings

- <severity>: <finding>

## Verdict

PASS only if every in-scope AC has agent verification or a human-only reason,
every R# coverage path is traceable, every required V# has observable Pass
Intent and artifact expectations, and Required For Done / Can Be Blocked
semantics are not diluted.
PASS also requires every changed behavior to have automated regression coverage or a clear, explicit reason why another verification mode is the better proof.
```

If the audit is `FAIL`, revise the PRD verification contract and rerun the
audit before marking the PRD `status: ready`.

### Harness Readiness Gate

After the audits pass, run the mechanical precheck from the target repository
root before marking the PRD `ready`:

```sh
node ~/.codex/skills/prd-implement/scripts/prd_state_harness.js plan-verification --prd .hoyeon/prd/<topic-slug>/prd.md
```

This is stateless: it parses the PRD exactly the way `prd-implement` will,
derives the verification plan against real repo signals, and writes nothing.
Exit code 2 means the verification contract is not harness-readable (missing
commands or artifact strategy, uncovered ACs, missing browser startup, unsafe
external proof). Fix the PRD and rerun until `blockingGaps` is empty; resolve
or consciously accept warnings. Skipping this gate pushes the same failures
into `prd-implement`, where they cost a re-init and a re-plan instead of a
one-second check.

Open decisions must be explicit. Blocking decisions prevent `ready` status.
Classify remaining items as blocking, deferred, or human taste/approval.

### 11. Implementation Guardrails

State what `prd-implement` must not do without asking:

- do not expand scope.
- do not change major architecture.
- do not introduce unapproved services, schemas, jobs, or external calls.
- do not touch production data or secrets without approval.
- do not add hidden user flows.

### 12. Implementation Result Report Contract

Require the implementing agent to report:

- status: `Done`, `Partially Done`, or `Blocked`.
- user-visible changes.
- major changed routes/modules/APIs/data shapes.
- whether approved technical structure was followed.
- task completion status.
- R/AC/V coverage.
- verification evidence by mode.
- delivery evidence when PR delivery is required: branch, PR URL, CI status,
  and any retry or blocked state.
- automated tests added or updated, including the regression risk each protects.
- deviations.
- remaining human review.
- not-done items and follow-up candidates.

## Workflow

1. Locate the intake handoff or infer the topic from the request.
2. Read source artifacts and directly relevant project docs.
   Read `.hoyeon/config.json` when it exists or when the user asks for PR
   delivery, worktrees, or CI automation.
3. Create `context-notes.md` for non-trivial PRDs.
4. Draft `prd.md` with every required section and `human_approval: "pending"`.
5. Ask only contract-breaking questions; do not rerun intake inside PRD.
6. Derive PRD-level tasks from requirements and acceptance criteria.
7. Add the Test Mode Contract and Required Agent Verification matrix.
8. Run the Intent And Scope Audit and write `intent-scope-audit.md` for non-trivial PRDs.
9. For non-trivial PRDs, run the Verification Contract Auditor and write
   `verification-contract-audit.md`.
   For trivial PRDs, do the same checks inline before the Harness Readiness
   Gate without creating a separate audit file.
10. Check for unverifiable requirements, untraceable tasks, missing verification
   modes, missing human decisions, and hidden scope.
11. Run the Harness Readiness Gate (`plan-verification --prd`) and fix any
   blocking gaps.
12. Mark `status: ready` only when blocking decisions are resolved, required
   non-trivial audits are `PASS`, and the Harness Readiness Gate reports zero
   blocking gaps.
13. Ask the user to review the PRD using the Approval checklist. Set
   `human_approval: "approved"` only after their explicit approval; otherwise
   leave it `pending` and say implementation is blocked on their review.

## Quality Gate

Before finalizing:

- Every in-scope behavior has an acceptance criterion.
- Every acceptance criterion has agent verification or a human-only reason.
- Every requirement maps to an acceptance criterion, verification item, human-only reason, deferred decision, or non-goal.
- Test Mode Contract covers build/static, automated behavior, runtime/browser
  when user-facing, and API/DB/external modes when relevant.
- Changed behavior has automated regression coverage or a clear justified alternative verification mode.
- Required Agent Verification maps to `R#`, `AC#`, or `T#` IDs.
- Required-for-done and blockable semantics are explicit.
- Intent And Scope Audit exists for non-trivial PRDs and is `PASS`.
- Verification Contract Audit exists for non-trivial PRDs and is `PASS`.
- Harness Readiness Gate (`plan-verification --prd`) reports zero blocking gaps.
- Every required `V#` has observable Pass Intent and artifact expectations.
- Human verification is explicit, even when empty.
- Pre-work and human decisions are explicit, even when empty.
- Delivery mode is explicit when the user asks for PR, CI, branch, worktree, or
  ship automation.
- Decision traceability preserves accepted proposals, rejected options, and
  user decisions with mappings to PRD IDs or non-goals.
- Major Technical Structure Changes is reviewable and avoids executor detail.
- PRD-Level Tasks derive from requirements and acceptance criteria.
- Implementation Guardrails prevent hidden scope and unapproved structure drift.
- The PRD does not quietly expand beyond the intake handoff.

## Final Report

After writing the PRD, report concisely:

- PRD path.
- verification contract audit path and verdict.
- source intake or clarify path.
- status and `human_approval` state, with the Approval checklist items the
  user needs to review before `prd-implement` can run.
- remaining blocking questions, if any.
- summary of scope, technical structure, required decisions, verification
  modes, delivery mode when relevant, PRD-level tasks, human verification,
  decision traceability, and result report contract.
