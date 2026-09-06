---
name: gen-prd
description: |
  Project-local PRD writer. Use when the user invokes "$gen-prd", asks for a PRD,
  product requirements document, implementation-ready requirements, or wants to
  turn intake/clarify output into a human-reviewable contract of about 100
  lines: a goal, non-goals, a Decisions table, a Behaviors table whose rows the
  harness executes, judges, or hands to the user, a short technical structure,
  and risks.
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
Decisions and their provenance live in the Decisions table inside `prd.md`;
quality checks are inline self-checks plus the mechanical Harness Readiness
Gate, and the implementation-side fidelity review re-verifies intent at the
end.

Use short kebab-case topic slugs. If the source intake topic exists, reuse the
same slug.

## Required Structure

`prd.md` is about 100 lines: frontmatter plus exactly these six sections, in
this order, with these titles.

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

## Goal

## Non-goals

## Decisions

| D-n | 결정 | 근거 |
| --- | --- | --- |

## Behaviors

| # | 사용자가 관찰하는 행동 | 검사 방법 | 결정 |
| --- | --- | --- | --- |

## Technical structure

## Risks
```

There is no requirements list, acceptance-criteria table, task list,
verification matrix, scenario section, pre-work checklist, guardrails section,
or report contract. One Behaviors row carries what those used to say three
times over: the behavior the user observes, how it is proved, and the decision
it rests on. `sasu prd readiness` refuses a PRD that is missing one of the six
sections (`prd-section-missing`) and a PRD in the retired five-axis shape is
refused by `implement start` outright.

## Section Intent

### Human Approval Contract

`status` and `human_approval` are different gates:

- `status: ready` means the agent-side quality gates and audits passed.
  Flip it with `sasu prd ready --prd <path>` - the CLI refuses while the
  readiness gate has blocking gaps, so never edit the line by hand.
- `human_approval: "approved"` means the user actually reviewed the PRD and
  approved it. The PRD-writing agent always writes `pending` and never sets
  `approved` on its own. After the user explicitly approves, record it with
  `sasu prd approve --prd <path> --evidence "<the user's verbatim approval>"` -
  the CLI requires the quote and refuses a non-ready PRD, so never edit the
  line by hand.
- `implement` refuses to initialize against a PRD whose `human_approval` is
  not `approved`, so a PRD that skips human review cannot be executed silently.

To make the human review fast, end `## Goal` with a short `Approval checklist`
bullet list: the 3 to 7 concrete things the user is approving (scope boundary,
structure changes, which rows are `human:`, delivery mode, any risky decision),
each pointing at its row or section.

### Delivery Contract

If the user asks for PR automation, CI completion, worktree execution, or a ship-to-PR workflow, preserve that as a delivery decision in the PRD.
Do not treat PR delivery as an implementation detail that can be decided later.

Represent delivery mode in the existing sections instead of adding a new one:

- Add an Approval checklist item for `delivery mode: local | pr`.
- Add a Decisions row for the accepted delivery choice and the rejected alternatives.
- Add a Behaviors row only for implementation work that must be complete before the receipt, such as release notes or PR-ready evidence.
- Keep branch creation, push, PR URL, CI verdict, and merge result out of the Behaviors table because `$ship` records them after the implementation receipt.

When the repository has `agents/config.json`, read it before drafting and reflect relevant defaults in the PRD.
The config is not a substitute for human approval when delivery can create branches, commits, pull requests, deployments, external calls, or CI spend.

### Goal

One paragraph: who the user is, what changes for them, and why now. The
sentence that states the goal is one the user can confirm verbatim, so write it
plainly. End with the Approval checklist.

### Non-goals

Bullets of behavior deliberately left out, each with its user consequence and
the condition under which it would be revisited.

Write the PRD for a coherent, production-quality product rather than an intentionally reduced MVP.
Do not omit behavior merely because this is the first implementation or because a smaller scope is faster.
Cover the complete primary user journey and every relevant loading, empty, error, permission, partial-success, recovery, responsive, accessibility, performance, security, operation, and support boundary - each as a Behaviors row, not as a checklist.
Any deliberate omission must be a visible non-goal with its consequence and revisit condition.
If the source request truly asks for a prototype or experiment, preserve that explicit decision instead of silently upgrading it into a production launch.

Project-specific constraints on the implementation (what must not change, what
must not be introduced) are non-goals or Behaviors rows. Repository-wide
constants (no agent names in commits, no compatibility paths, and the like)
live once in the repository's `AGENTS.md`, never in a PRD.

#### Semantic Review Profile

Assign `review_profile` by reading the complete intent, product surface, technical structure, data effects, and delivery plan.
The agent owns this semantic judgment; the harness validates the declared enum and defaults missing declarations to `standard`.
Write one concrete sentence in `review_rationale` explaining the dominant reason.

- Use `trivial` only for bounded documentation, copy, tests, or internal maintenance with no changed user-visible behavior, runtime contract, access boundary, persistent data effect, external side effect, or delivery risk.
- Use `standard` for normal product and engineering changes, including small user-facing UI or UX changes.
- Use `high-risk` for production-data mutation or migration, auth or access changes, security-sensitive behavior, credentials or PII, payments or billing, irreversible or costly external actions, destructive infrastructure, or production rollout and rollback risk.

Never lower the profile to save time.
When uncertain between adjacent profiles, choose the higher one and let a reviewer narrow the concern in its findings rather than weakening the gate.

### Decisions

One row per decision the implementation rests on, `| D-n | 결정 | 근거 |`:

- `D-n` numbers the row; Behaviors rows cite these ids, and
  `prd-dangling-decision-id` blocks a citation with no row.
- `결정` is the decision as a sentence: what was chosen and, when an option
  was rejected or deferred, that it was.
- `근거` names the source: the qa-log turn (`Q3`) or the user's own words
  quoted. `prd-cited-question-unanswered` blocks a `Qn` citation whose turn
  has no answer from the user. An agent-owned assumption says so
  (`가정: ...`) and never masquerades as a user decision.

Carry every material Decision Register entry from the qa-log, every user
decision that shapes scope, UX, data, architecture, verification, delivery, or
non-goals, every accepted proposal, and every rejected or deferred option.
Treat a short affirmative response as acceptance of a recommendation only when its referent is unambiguous in the source conversation or qa-log.
Silence, lack of objection, a topic change, or continued participation is not approval.
If that distinction would materially change scope or behavior, ask one contract-breaking question instead of inventing consent.

This table is what the fidelity judge compares the implementation against at
the end of `implement`, and for a conversation-only PRD it is the only record
of the conversation the harness can read. Preserve the essential user decision
text here rather than relying on chat history.

### Behaviors

One row per behavior the user observes, `| # | 사용자가 관찰하는 행동 | 검사 방법 | 결정 |`:

- `#` is `B<n>`, numbered in reading order. Rows are the unit of progress:
  `implement` reports, parks, amends, and closes rows, and the receipt is this
  table with a result column.
- `사용자가 관찰하는 행동` states one observable outcome in product terms -
  a state, a message, a bound, a refusal. Failure and recovery paths are
  their own rows, not clauses of the happy path. Never write the proof
  procedure as the behavior (`tests pass`, `a screenshot is registered`) and
  never put a command or path in this cell; `prd-behavior-row` blocks a
  method that leaks into it.
- `검사 방법` starts with exactly one of three prefixes and names how the
  harness settles the row:
  - `check: \`<command>\`` - a deterministic command the harness runs on the
    judged tree from its root; exit 0 is green, anything else is fail. One
    argv, no `&&`, `|`, `;`, redirection, or substitution - the same rule
    `verify.commands` obeys. The command is visible here so the human and the
    spec judge see it before it is trusted.
  - `judge: <evidence shape>` - a read-only acceptance judge decides from the
    diff and registered evidence; say what evidence must exist (a capture, a
    transcript, a before/after pair), not a future file path.
  - `human: <what the user confirms>` - only the person can settle it (taste,
    copy, a live account, a physical device). The row stays OPEN through
    `finalize`, the run closes `complete-pending-human`, and the user closes
    it later with `sasu implement confirm`. A row the agent could have checked
    or a judge could have judged is not a `human:` row.
- `결정` cites the Decisions rows the behavior rests on (`D-01, D-03`) or
  `-`.

Keep every row small enough to be proved in one sitting: a row is one thing the
user observes. Ask a contract-breaking question only when the choice between
`check:`, `judge:`, and `human:` would materially change required human
involvement or evidence.

Bias the `check:` rows toward regression protection that earns its keep:
pure logic and data transformation, API and service boundaries, component
behavior, then a browser or runtime smoke for a critical flow. Do not write
`check:` rows that only lock implementation details, duplicate framework
behavior, snapshot brittle output, depend on production data, or slow the suite
without covering a realistic regression. When the repository has no test
infrastructure, add it only when at least one row justifies it.

Live external, API, or DB proof needs an approved non-production and
side-effect boundary stated in Risks, or it is a `human:` row.

### Technical structure

High-level structure the reviewer approves, not implementation detail: new
service or API boundaries, schema, migration, storage, infrastructure, job or
queue changes, auth, payment, email, external-service, or production-data
boundaries, major architecture or data-flow changes. Exclude component names,
helpers, test file names, write scopes, and scheduling. If nothing structural
changes, say so in one line. `implement` treats this section as the approved
structure boundary.

### Risks

Bullets for what could go wrong and what bounds it, open decisions with who
owns them, and the safety boundary for any live proof. Work only the user can
do before implementation (credentials, accounts, purchases, owner-identity
steps) is one line here; the harness does not read it, so state it plainly and
ask for it once. If nothing is needed from the user, say so.

### Inline Self-Check Before Ready

Mechanical checks belong to the Harness Readiness Gate below; do not re-derive
what it already checks. The semantic self-check is this single inline pass,
with no audit file and no auditor subagent; the sasu Spec Gate and the
implementation-side fidelity review independently re-verify the same intent.

After drafting and before marking the PRD `ready`, verify inline:

- Losslessness: every material answer, accepted recommendation, objection,
  constraint, rejected option, non-goal, and assumption from the complete
  source is a Decisions row, a Behaviors row, a non-goal, a risk, or an
  explicit context-only disposition, with meaning and provenance preserved and
  without treating silence as consent. Every qa-log UX Scenario Card became
  Behaviors rows (primary, failure, recovery) or an explicit non-goal - never
  silently dropped.
- Intent: every user decision and accepted proposal is represented; rejected
  and deferred options stayed rejected; the PRD does not quietly expand beyond
  its sources.
- Rows: each behavior is one observable outcome; each `check:` command is one
  argv that proves the row rather than a proxy; each `judge:` cell names an
  evidence shape; each `human:` row is something only the person can settle;
  every cited `D-n` exists.
- Product completeness: the rows cover the coherent intended journey and the
  relevant quality boundaries, and every omission is a non-goal rather than an
  implicit MVP cut.
- Review profile: `review_profile` and `review_rationale` reflect a semantic reading of actual effects rather than keyword matching or PRD size.

If a check fails, revise the PRD and re-check.
Do not write the self-check to a file; state in the final report that it passed.

### Harness Readiness Gate

After the self-check passes, run the mechanical precheck from the target
repository root before marking the PRD `ready`:

```sh
sasu prd readiness --prd agents/prd/<topic-slug>/prd.md
```

This is stateless: it parses the PRD exactly the way `implement` will and
writes nothing. It reports the row count, how many rows are `check:`,
`judge:`, and `human:`, and the Decisions count, so the approval review can see
the planned proof mix. Exit code 2 means the contract is not harness-readable:
a missing section, a row whose method cell has no prefix or an empty payload, a
`check:` command with shell composition, a method in the behavior cell, a
duplicate or non-`B<n>` row id, or a `D-n` citation with no row.
Fix the PRD and rerun until `blockingGaps` is empty.

Open decisions must be explicit. Blocking decisions prevent `ready` status.
Classify remaining items as blocking, deferred, or human taste/approval.

### Spec Gate (sasu)

After the Harness Readiness Gate passes and before marking the PRD `ready`,
run the independent spec gate when the PRD has an interview qa-log source:

```sh
sasu gate spec --slug <topic-slug> --prd agents/prd/<topic-slug>/prd.md --qa-log agents/interview/<topic-slug>/qa-log.md
```

An independent judge checks fidelity (every material Decision Register entry
represented in the Decisions table without distortion) and testability (every
Behaviors row observable with no vague qualifiers, every `check:` command a
real proof of its row, every `human:` row genuinely human-only); the
deterministic prelint already reports structural defects at $0.

- The gate keeps an open findings set, not a round budget. Every judged run
  ends in one of three states:
  - `BLOCK`: at least one open finding is agent-fixable.
    Fix every such finding in the PRD, then re-run; the rerun judges only the
    findings still open (by their `F<n>` id) and may add a finding only when
    the qa-log's Decision Register rows changed, so the set can only shrink.
  - `NEEDS_HUMAN`: every open finding needs a human decision.
    Ask the user the whole bundle in one message, apply their decisions to the
    PRD (and the qa-log Decision Register when a decision is new), then record
    their words with
    `sasu gate answer --slug <topic-slug> --gate spec --evidence "<the user's words>"`.
    That seals PASS without another judge call.
  - `PASS`: the cycle is sealed.
- A finding marked `needs human decision` goes to the user; do not resolve it
  by editing the PRD toward your own guess.
- Only a new explicit user change request may open another cycle:
  `sasu gate reopen --slug <topic-slug> --gate spec --evidence "<the user's words>"`.
  `--grant-budget` does not change the open set; it is only for a bounded
  judge backend error streak after the backend is repaired.
- If the judge backend is unavailable, the gate fails closed; report the cause
  and recovery, and treat the PRD as not `ready` until the user decides.
- Never run `sasu gate override` yourself; it is user-only, and the
  recorded deviation must carry the user's own reason.
- The PASS is pinned to the PRD body and the qa-log's Decision Register
  decision cells and seals the review cycle
  (frontmatter is exempt, so flipping `status`/`human_approval` after the gate
  is fine): any PRD body edit or qa-log decision change afterwards makes
  `sasu gate status` report `STALE`; the CLI refuses automatic re-judgment
  until the input is restored or the user explicitly authorizes `gate reopen`.
  The gate records each run in the qa-log's `## Audit History` itself.
- PASS may retain P2 advisory notes.
  Do not edit the PRD and invalidate the seal merely to remove those notes.
- When no intake qa-log exists (conversation-only PRD), record that the spec
  gate was skipped for lack of a source document.

### Principles Intake

Declared principles are contract input, not ambient advice. Before drafting,
query the project's declared principle repositories:

```sh
sasu principles list --json
```

An empty `domains` list means the project declares no principles: skip this
intake silently and write nothing about it. A command failure (a declared
repository that cannot be read) is reported in the final report, never
silently skipped.

For each returned domain whose trigger matches the work this PRD covers, read
the domain's document in full - a matching domain applies as a whole, never as
a keyword-filtered subset. Then translate:

- A rule whose compliance is observable in the product becomes (or sharpens) a
  Behaviors row: an observable proposition, never the rule's abstract wording.
- A rule that constrains the implementation without an observable outcome is a
  non-goal, with its source named (`design/principles.md rule 1`).
- Record the intake as a Decisions row: which documents were read, at which
  source commit, and any applicable rule deliberately not translated, with the
  reason.

Project-local instructions and rules override declared principles; when one
wins, name the principle it overrides.

## Workflow

1. Locate the intake qa-log or infer the topic from the request.
2. Read source artifacts and directly relevant project docs.
   Read `agents/config.json` when it exists or when the user asks for PR
   delivery, worktrees, or CI automation.
   Run `sasu principles list --json` and perform the Principles Intake above
   for every domain whose trigger matches this PRD's work.
3. Fan out pre-writing research, then draft alone. Before drafting, list the
   independent factual questions the PRD depends on - current code structure,
   existing schema or auth reality, whether a library supports what a row
   assumes - and dispatch parallel read-only research subagents for them;
   questions with real data dependencies stay sequential or are answered
   inline. The main session reads the results and keeps sole authorship of the
   PRD: research parallelizes, the pen does not, because the document's value
   is one coherent Decisions-to-Behaviors graph.
4. Draft `prd.md` with the six sections, `human_approval: "pending"`, and a
   semantic review profile with rationale. Turn every qa-log UX Scenario Card
   into Behaviors rows for its primary, failure, and recovery paths.
5. Ask only contract-breaking questions; do not rerun intake inside PRD.
6. Run the Inline Self-Check Before Ready and fix failures.
7. Run the Harness Readiness Gate (`sasu prd readiness --prd`) and fix any
   blocking gaps.
8. Run the sasu Spec Gate and fix findings until it passes or a
   human-decision finding stops the loop. When the `sasu` binary or its judge
   backend is unavailable, record that limitation in the final report and
   proceed on the Harness Readiness Gate plus the inline self-check alone;
   that recorded limitation (or the documented no-qa-log skip) is the
   "skip/fallback" step 9 refers to.
9. Mark `status: ready` only when blocking decisions are resolved, the inline
   self-check passes, the Harness Readiness Gate reports zero blocking
   gaps, and the Spec Gate passes (or its skip/fallback is recorded).
10. Ask the user to review the PRD using the Approval checklist. Set
   `human_approval: "approved"` only after their explicit approval; otherwise
   leave it `pending` and say implementation is blocked on their review.

## Final Report

After writing the PRD, report concisely:

- PRD path.
- inline self-check, Harness Readiness Gate, and Spec Gate results, with the
  row counts by `check:` / `judge:` / `human:`.
- source intake or clarify path.
- status and `human_approval` state, with the Approval checklist items the
  user needs to review before `implement` can run.
- remaining blocking questions, if any.
- summary of goal, non-goals, decisions, the Behaviors rows, technical
  structure, delivery mode when relevant, and risks.
