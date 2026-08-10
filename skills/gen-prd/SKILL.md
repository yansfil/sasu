---
name: gen-prd
description: |
  Project-local PRD writer. Use when the user invokes "$gen-prd", asks for a PRD,
  product requirements document, implementation-ready requirements, or wants to
  turn intake/clarify output into a human-reviewable requirements contract with
  major technical structure changes, PRD-level tasks, a compact verification
  contract, required test modes, human verification, risks, guardrails, and an
  implementation result report contract.
---

# gen-prd

PRDs live under the visible `agents/` namespace (`agents/prd/**`), which is the
only namespace the pipeline reads or writes.

Use this skill to write an implementation-ready PRD from intake output or the
current conversation.

The PRD is a human decision contract and an implementation handoff. Do not
implement code while using this skill.

Match the user's language by default.

## Default Inputs

Prefer an explicit context path, passed directly or as `--context <path>` (the form `$interview-me` suggests at handoff). The canonical interview source is:

```text
agents/interview/<topic-slug>/qa-log.md
```

If no context path is provided, inspect `agents/interview/` first for the matching
or most recent qa-log (then the legacy `agents/intake/` path for interviews
started before the rename). If no complete interview source
exists and major ambiguity remains, ask one blocking question or recommend
`$interview-me`.

When qa-log.md is the source, read the complete file.
Treat its Current Understanding as a navigation aid, not a substitute for the Decision Register, material Raw Q&A (Decision Packet content lives in each entry's `immediate_notes`), UX Scenario Cards, objections, evidence, and audit findings.
The qa-log is the canonical interview source even when a shorter summary exists elsewhere.

## Output Contract

Create exactly one file:

```text
agents/prd/<topic-slug>/prd.md
```

Do not write side files (context notes, audit reports).
Decisions and traceability live inside `prd.md` (Decision Traceability);
quality checks are inline self-checks plus the mechanical Harness Readiness
Gate, and the implementation-side fidelity review re-verifies intent at the
end.

Use short kebab-case topic slugs. If the source intake topic exists, reuse the
same slug.

## Required Structure

`prd.md` must include these sections:

```markdown
---
topic: "<topic>"
status: "draft | ready"
human_approval: "pending | approved"
review_profile: "trivial | standard | high-risk"
review_rationale: "<one-sentence semantic risk rationale>"
source_intake: "agents/interview/<topic-slug>/qa-log.md | current conversation"
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
- `implement` refuses to initialize against a PRD whose `human_approval` is
  not `approved`, so a PRD that skips human review cannot be executed silently.

To make the human review fast, end the `## 1. Summary` section with a short
`Approval checklist` bullet list: the 3 to 7 concrete things the user is
approving (scope boundary, structure changes, verification modes, any risky
decision), each pointing to its section.

### Delivery Contract

If the user asks for PR automation, CI completion, worktree execution, or a ship-to-PR workflow, preserve that as a delivery decision in the PRD.
Do not treat PR delivery as an implementation detail that can be decided later.

Represent delivery mode in the existing sections instead of adding a new top-level section:

- Add a Summary approval checklist item for `delivery mode: local | pr`.
- Add a Human Decision when the user must approve PR creation, CI watching, branch naming, or worktree setup.
- Add Decision Traceability bullets for accepted delivery choices and rejected alternatives.
- Add a PRD-level release-hygiene task only for implementation work that must be complete before the receipt, such as release notes or PR-ready evidence.
- Keep branch creation, push, PR URL, CI verdict, and merge result out of PRD tasks, acceptance criteria, and required verification because `$ship` records them after the implementation receipt.
- Add the delivery result to the Implementation Result Report Contract.

When the repository has `agents/config.json`, read it before drafting and reflect relevant defaults in the PRD.
The config is not a substitute for human approval when delivery can create branches, commits, pull requests, deployments, external calls, or CI spend.

### 1. Summary

Shortly state what will change and why. End with the `Approval checklist`
described above.

### 2. Problem, Goal, And Users

Put product reason near the top. A reviewer should understand the user and goal
before reading technical or verification details.

### 3. Scope And Non-Goals

Define included and excluded behavior. This is a primary human review surface.

#### Product Completeness Contract

Write the PRD for a coherent, production-quality product rather than an intentionally reduced MVP.
Do not omit behavior merely because this is the first implementation or because a smaller scope is faster.
Cover the complete primary user journey and every relevant loading, empty, error, permission, partial-success, recovery, responsive, accessibility, performance, security, operation, and support boundary.
Apply only the quality boundaries relevant to the product instead of adding generic checklist requirements.
Any deliberate omission must be a visible non-goal or deferred decision with its user consequence, rationale, and revisit condition.
If the source request truly asks for a prototype or experiment, preserve that explicit decision instead of silently upgrading it into a production launch.

#### Semantic Review Profile

Assign `review_profile` by reading the complete intent, product surface, technical structure, data effects, and delivery plan.
The agent owns this semantic judgment; the harness validates the declared enum and defaults missing declarations to `standard`.
Write one concrete sentence in `review_rationale` explaining the dominant reason.

- Use `trivial` only for bounded documentation, copy, tests, or internal maintenance with no changed user-visible behavior, runtime contract, access boundary, persistent data effect, external side effect, or delivery risk.
- Use `standard` for normal product and engineering changes, including small user-facing UI or UX changes.
- Use `high-risk` for production-data mutation or migration, auth or access changes, security-sensitive behavior, credentials or PII, payments or billing, irreversible or costly external actions, destructive infrastructure, or production rollout and rollback risk.

Never lower the profile to save time.
When uncertain between adjacent profiles, choose the higher one and let a reviewer narrow the concern in its findings rather than weakening the gate.

### 4. Pre-Work And Required Decisions

Separate actions from approvals.

`Pre-Work Before Implementation` lists only work the agent genuinely cannot do
itself: account ownership, purchases, credential issuance, permission grants,
physical actions, or provider-side steps that require the user's identity.
If the agent can do it (creating files, seed data, config, research, scaffolding,
free-tier signup the user already approved), it is a PRD task or just gets done;
never pre-work. Every pre-work item must say why it is human-only.

Typical human-only items:

- API keys, credentials, test accounts, billing, permissions.
- source files, design assets, copy, or data only the user possesses.
- migration windows, backups, account setup requiring owner identity.

`Human Decisions Before PRD Approval` is decision-oriented:

- approve scope and non-goals.
- approve major technical structure changes.
- approve storage/API/external-service choices.
- approve required-for-done verification modes.
- approve delivery mode and PR/CI automation when requested.
- approve live/external proof and sensitive-data handling.

If none are needed, write `None required` with a short reason.

`Decision Traceability For Fidelity Review` is the review surface for the
strict intent-review subagent that runs at the end of `implement`.

Include compact bullets for:

- every material Decision Register entry from qa-log.md, with its D# when available and a visible PRD disposition.
- user decisions that materially shape scope, UX, data, architecture,
  verification, delivery, live proof, or non-goals.
- initial proposals or options the user accepted.
- proposals, options, or behaviors the user rejected or explicitly deferred.
- agent-owned assumptions, which must remain labeled as assumptions rather than being upgraded into user decisions.
- where each decision is represented: `R#`, `AC#`, `T#`, `V#`, non-goal,
  human verification, risk, guardrail, deferred decision, or context-only fact.

Treat a short affirmative response as acceptance of a recommendation only when its referent is unambiguous in the source conversation or qa-log.
Silence, lack of objection, a topic change, or continued participation is not approval.
If that distinction would materially change scope or behavior, ask one contract-breaking question instead of inventing consent.

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
  or subagent scheduling. `implement` derives those.
- If implementation later needs an unmapped task or material structure change,
  the agent must ask for approval before continuing.

Use IDs in the text:

```markdown
- R1. ...
- AC1. ...
- T1. ... Covers R1, AC1.
```

#### AC Machine Oracles (Check / Artifact tails)

Whenever an acceptance criterion can be confirmed by a command or a file's
existence, declare that oracle on the bullet itself so the harness settles the
AC mechanically (`oracle-run` / the verify gate) instead of a judge or a manual
mark — declared at PRD time, executed on the harness clock, immune to
implementer submission bias:

```markdown
- AC2. The health endpoint answers. Check: `curl -sf localhost:3000/health` -> "status":"ok"
- AC3. The coverage report is generated. Artifact: coverage/index.html
```

`Check:` is a backticked command at the end of the bullet, optionally followed
by `-> <expected stdout substring>` (exit 0 alone proves it when the arrow is
omitted; backtick-wrap the expectation if it ends in a period). `Artifact:` is
a project-relative path whose existence proves the AC. An oracle-backed AC
needs no 9.2 V-row coverage — the oracle is its verification. Malformed tails
fail the $0 prelint, and oracle commands must not modify the workspace (the
digest guard records a mutation as a failure).

Check commands are tokenized and executed **without a shell**: operators like
`|`, `&&`, `;`, `>` are passed to the program as literal arguments, never
interpreted (prelint warns when it sees them) — wrap the command in
`bash -c "..."` when shell semantics are intended. The same declared oracle
runs in two places (the harness `oracle-run` sweep and the verify gate's
oracle stage), so the command must be repeatable/idempotent. A trivially
constant command (`true`, `exit 0`, a bare `echo`) proves nothing and draws a
prelint warning.

#### Task Scope Globs

When a task's change surface is known at PRD time, declare it as a `Scope:`
tail of repo-relative globs — the verify gate then scopes each judge lane's
diff to the paths the covering tasks declared (input selection by the vetted
document, not the implementer). When **every** task declares a Scope, changed
files outside all declared scopes surface as a warning; with a partial
declaration the warning stays off, because a file outside the declared globs
may simply belong to a Scope-less task:

```markdown
- T1. Build the widget renderer. Covers R1, AC1. Scope: src/widget/**, src/render.ts
```

Scoping only narrows a lane when every task covering that lane's ACs declares
a Scope, so leave it off global-invariant work rather than guessing.

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

The PRD defines verification intent and done requirements. `implement`
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

Use a lean verification matrix when the repository's `package.json` has a canonically named script the planner can derive commands from (`verify`, `check`, `build`, `typecheck`, `lint`, `test`, `test:unit`, `test:integration`, `test:e2e`).
Outside that case (Python/Go/Rust repos, non-canonical script names, no `package.json`), write the Method-bearing matrix below instead; the lean form would fail the Harness Readiness Gate with `command-missing`.
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

The Method-bearing matrix is the current form whenever exact commands are
known or the lean form cannot derive them; always include `Mode`:

```markdown
| ID | Mode | Covers | Method | Artifact | Pass Criteria | Environment | Required For Done | Can Be Blocked | Safe Probe | Live Proof | Side Effect | Sensitive Data Policy |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| V1 | build/static | R1, AC1 | `pnpm build` | command-log | exits 0 | local shell | yes | no | none | command log | none | no secrets |
```

Rules:

- A `Method` command must be runnable exactly as written, because `implement`
  takes it from the backticks and runs it from the repository root. Two shapes
  read fine to a human but diverge from what actually runs, and the gate's PRD
  prelint rejects both:
  - a directory parked outside the command. Write
    `bash -c "cd cli && npm test"`, not `` `npm test` `` followed by `(cli/)`.
  - a command whose first word is not a runner the planner knows
    (`pnpm`/`npm`/`node`/`bash`/`python`/`go`/`cargo`/... - see
    `cli/lib/runners.js`). Wrap anything else, including bare `grep` and
    project binaries: `bash -c "grep -q foo README.md"`.
  Prose Method cells for `manual-agent` and human-decision rows are unaffected;
  the rules apply only to rows whose `Artifact` is a command log.
- `Required For Done` is `yes` by default.
- The Test Mode Contract sets the mode-level default. Verification rows should
  repeat `Required For Done`; if omitted, `implement` inherits the mode
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

### Inline Self-Check Before Ready

Quality checking splits by what can verify it:

- Mechanical checks belong to the Harness Readiness Gate below. Do not spend
  agent effort re-deriving what the script already checks (requirement and AC
  coverage mapping, dangling AC references, missing commands, missing
  artifact strategy; browser-startup and external-proof concerns surface as
  warnings).
- Semantic checks are this single inline self-check. No separate audit file,
  no auditor subagent, no separate quality checklist; the sasu Spec Gate
  and the implementation-side requirements fidelity review independently
  re-verify the same intent against evidence.

After drafting and before marking the PRD `ready`, verify inline:

- Losslessness: every material answer, accepted recommendation, objection,
  constraint, rejected option, non-goal, and assumption from the complete
  source is accounted for in a requirement, acceptance criterion, task,
  verification item, human verification item, risk, guardrail, deferred
  decision, or explicit context-only disposition, with meaning and provenance
  preserved and without treating silence as consent.
- Intent: every user decision and accepted proposal is represented in scope,
  non-goals, `R#`, `AC#`, `T#`, `V#`, or human verification; rejected and
  deferred options stayed rejected; the PRD does not quietly expand beyond
  its sources.
- Pass intent: each required `V#` states a pass intent whose success is
  observable by an artifact or tool, and it actually proves the covered
  requirement rather than a proxy condition.
- Regression bias: every changed behavior has automated regression coverage
  or an explicit reason why another mode is the better proof.
- Product completeness: the PRD covers the coherent intended journey and relevant quality boundaries, and every omission is an explicit product decision rather than an implicit MVP cut.
- Verification semantics: the Test Mode Contract covers the proof classes the
  product actually needs (build/static, automated behavior, browser/runtime
  when user-facing, API/DB/external when relevant), and required-for-done and
  blockable semantics are explicit.
- Review profile: `review_profile` and `review_rationale` reflect a semantic reading of actual effects rather than keyword matching or PRD size.

If a check fails, revise the PRD and re-check.
Do not write the self-check to a file; state in the final report that it passed.

### Harness Readiness Gate

After the self-check passes, run the mechanical precheck from the target
repository root before marking the PRD `ready`:

```sh
node ~/.codex/skills/implement/scripts/prd_state_harness.js plan-verification --prd agents/prd/<topic-slug>/prd.md
```

This is stateless: it parses the PRD exactly the way `implement` will,
derives the verification plan against real repo signals, and writes nothing.
Exit code 2 means the verification contract is not harness-readable: an
uncovered requirement or AC, a dangling AC reference, or a check without a
concrete command, coverage mapping, or artifact strategy. Browser-startup and
external-proof concerns are warnings, not blockers. Fix the PRD and rerun
until `blockingGaps` is empty; resolve or consciously accept warnings. Skipping this gate pushes the same failures
into `implement`, where they cost a re-init and a re-plan instead of a
one-second check.

Open decisions must be explicit. Blocking decisions prevent `ready` status.
Classify remaining items as blocking, deferred, or human taste/approval.

### Spec Gate (sasu)

After the Harness Readiness Gate passes and before marking the PRD `ready`,
run the independent spec gate when the PRD has an interview qa-log source:

```sh
sasu gate spec --slug <topic-slug> --prd agents/prd/<topic-slug>/prd.md --qa-log agents/interview/<topic-slug>/qa-log.md
```

An independent judge checks fidelity (every material Decision Register entry
represented without distortion) and testability plus verification intent
(acceptance criteria observable with no vague qualifiers, observable pass
intents, genuine human-verification/non-goal dispositions); the deterministic
prelint already reports uncovered ACs and dangling Covers references at $0.

- The gate is a hard block: exit 1 means the PRD is not `ready`. Fix the PRD
  per finding and re-run.
- A finding marked `needs human decision` goes to the user; do not resolve it
  by editing the PRD toward your own guess.
- When the retry budget is exhausted, stop revising and hand the findings to
  the user.
- If the judge backend is unavailable, the gate fails closed; report the cause
  and recovery, and treat the PRD as not `ready` until the user decides.
- Never run `sasu gate override` yourself; it is user-only, and the
  recorded deviation must carry the user's own reason.
- The PASS is pinned to the content hash of the PRD and qa-log bodies
  (frontmatter is exempt, so flipping `status`/`human_approval` after the gate
  is fine): any body edit afterwards makes `sasu gate status` report
  `STALE`, and a stale spec gate must be re-run before implementation.
- When no intake qa-log exists (conversation-only PRD), record that the spec
  gate was skipped for lack of a source document.

### 11. Implementation Guardrails

State what `implement` must not do without asking:

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

1. Locate the intake qa-log or infer the topic from the request.
2. Read source artifacts and directly relevant project docs.
   Read `agents/config.json` when it exists or when the user asks for PR
   delivery, worktrees, or CI automation.
3. Draft `prd.md` with every required section, `human_approval: "pending"`, and a semantic review profile with rationale.
4. Ask only contract-breaking questions; do not rerun intake inside PRD.
5. Derive PRD-level tasks from requirements and acceptance criteria.
6. Add the Test Mode Contract and Required Agent Verification matrix.
7. Run the Inline Self-Check Before Ready (losslessness, intent, pass intent,
   regression bias, product completeness, verification semantics, and review
   profile) and fix failures.
8. Run the Harness Readiness Gate (`plan-verification --prd`) and fix any
   blocking gaps.
9. Run the sasu Spec Gate and fix findings until it passes or a
   human-decision finding stops the loop. When the `sasu` binary or its judge
   backend is unavailable, record that limitation in the final report and
   proceed on the Harness Readiness Gate plus the inline self-check alone;
   that recorded limitation (or the documented no-qa-log skip) is the
   "skip/fallback" step 10 refers to.
10. Mark `status: ready` only when blocking decisions are resolved, the inline
   self-check passes, the Harness Readiness Gate reports zero blocking
   gaps, and the Spec Gate passes (or its skip/fallback is recorded).
11. Ask the user to review the PRD using the Approval checklist. Set
   `human_approval: "approved"` only after their explicit approval; otherwise
   leave it `pending` and say implementation is blocked on their review.

## Final Report

After writing the PRD, report concisely:

- PRD path.
- inline self-check, Harness Readiness Gate, and Spec Gate results.
- source intake or clarify path.
- status and `human_approval` state, with the Approval checklist items the
  user needs to review before `implement` can run.
- remaining blocking questions, if any.
- summary of scope, technical structure, required decisions, verification
  modes, delivery mode when relevant, PRD-level tasks, human verification,
  decision traceability, and result report contract.
