# sasu Principles

What this harness believes, and the lens every design proposal, diff review,
and refactor gets held against. Distilled from recurring review sessions with
the owner; `AGENTS.md` carries the short form for agents working in this
repository.

The harness exists to make "done" a provable state. The standing risk is that
the proof machinery grows heavier than the work it proves. One sentence anchors
every review:

> Verification is the senior sitting next to the implementation. It must be
> clean, intuitive, mistake-free, and efficient (깔끔하게 · 직관적으로 ·
> 실수없이 · 효율적으로) - and it must never become a second implementation
> that outweighs the first.

Items 1 and 2 are read together: every requirement remains in scope while evidence and review avoid redundant procedure.
The approved 2026-09-08 workflow plan explicitly changes the earlier per-AC proof and per-AC judge policies in items 1 and 6.
See [the approved direction](docs/plans/2026-09-08-workflow-simplification.md); this is a policy change, not a reinterpretation.
The subsequent approved production change uses parallel Fidelity and Code reviews with CLI-validated grouped assessment records.
It changes the routine review and record shape without restoring per-AC execution, separate evidence obligations, or requirement lifecycles.
The user-approved [2026-09-09 source exploration change](docs/plans/2026-09-09-review-input-capacity.md) explicitly replaces preselected-file-only review with autonomous discovery in a fixed product source copy.
Reviewers choose the related files they inspect; the harness owns the copied boundary and input integrity.

## 1. Preserve every requirement and review the complete contract

Every requirement remains in the approved PRD and the independent review input.
Use sufficient actual code, test results, and product observations to judge the entire intended result.
A build or function definition alone does not establish working user behavior.
An absent observation stays unverified until evidence supports it.

There is no requirement-by-requirement proof record, lifecycle, mandatory separate evidence, PASS array, or judge call.
One coherent observation can support multiple requirements.
Independent Fidelity and Code reviews receive the same complete original inputs without the current peer verdict.
Fidelity accounts for every Bn exactly once in grouped assessments with concrete rationale and actual evidence references.
Code records its own substantive implementation and error-path grounds without a duplicate all-Bn accounting form.
Satisfied assessments require actual inspected source, execution logs, or artifacts; PRD-only citations and file names are insufficient.
Reviewers read the complete contract, start from the changes, and search the fixed product source copy for relevant callers, dependencies, and omitted behavior.
The initial prompt points to complete documents and evidence instead of repeating the source tree and file catalog inline.
Pending-human assessments preserve permitted after-the-fact judgment only through corresponding validated post-completion human findings, without asserting satisfaction or waiving prerequisites.
The CLI guarantees structural coverage, execution facts, evidence integrity, current-input identity, ownership, authority, and an honest record.
Whether the implementation satisfies the contract is semantic judgment by the independent reviewers, not a mechanical guarantee of correct conclusions or zero omissions.
Evaluate that judgment by planting realistic omissions and observing whether the review finds them.

## 2. Verification must not outweigh implementation

Measure actual suite and review calls, elapsed execution, overlap, and orchestration relative to implementation.
Distinguish sums of concurrent intervals from wall-clock union time and report unavailable timing honestly.
Cut repeated bookkeeping, duplicate review responsibilities, and redundant observations while preserving the full requirement set and sufficient actual evidence.
Do not calculate savings from work that was never repeated, such as finalize executing tests.

## 3. Fix the one cause, not the N symptoms

Before accepting a fix list, ask whether the entries are one disease. A list of
five plausible patches to five sites is usually a missing single concept, and
patch-by-patch does not hold in this codebase - the freshness deadlock proved
it, where a fix applied to one fingerprint never propagated to its two
siblings. Prefer the change that makes the failure class structurally
impossible over the change that handles today's instance. When a proposal is
"근본적으로 해결되는가?", the honest answer is often no; say so and re-derive.

## 4. Every stage must earn its place, and every addition names its deletion

For each gate, review, or pass, name the failure it uniquely catches.
Fidelity owns complete intent and observable behavior fulfillment; Code owns concrete implementation, integration, error-path defects, and consequential design problems.
These roles replace the comprehensive review without adding a third general judge, a user command, or an extra agent workflow step.
Grouped assessment validation replaces unaccounted review summaries, not implementation or actual evidence.
The distinct high-risk check retains its safety question rather than repeating either routine role.
Default posture toward the review stack is suspicion of weight: when in doubt,
put it on a diet.

Additions are budgeted the same way. A proposal that adds a concept, a flag, a
command, or an escape hatch states what leaves with it, and shows the net
account: lines, concepts, commands, escape hatches. A system that only ever
grows is the failure mode this item exists to prevent, so "what drops out if we
do this?" is a required answer, not a nice-to-have. The vouched-tree work is
the shape to aim for: five freshness concepts collapsed to one, net LOC
negative, one command and two escape hatches removed.

## 5. Parallel by default

Independent checks fan out to subagents or lanes; a sequential chain must be
justified by a real data dependency. When adding a stage, first ask what it
can run concurrently with.

Two different things hide under "make it faster", and only one of them is
free.
Running independent work concurrently skips nothing, so it assumes nothing
about what the skipped work would have returned; the only cost is
coordination.
Skipping work a previous run already did is a different trade: it assumes the
verdict is a pure function of the inputs you compared.
In this harness that assumption is usually false - mechanical checks, oracles,
captures, and agentic lanes all read state the tree fingerprint cannot see
(2026-08-11: a rerun short-circuit trapped a run twice, once on a capture and
once on a required command, whose FAIL came from a gitignored service that had
since been fixed).
Fan out freely; before skipping, prove purity.

## 6. Observe flows and risk boundaries; review the whole contract

The natural unit of actual observation is a coherent product flow or risk boundary.
The natural unit of requirement judgment is the complete contract compared with implementation and shared evidence.
Requirement identifiers let findings and assessments point precisely to behavior or decisions; they do not become progress states or a coverage graph.
Grouping observations never permits grouping distinct requirements merely to reduce their count.
Every requirement still reaches both independent reviewers.
Grouped assessments may share evidence without merging or dropping the underlying requirements.

## 7. The harness absorbs complexity - never the workflow user, never a doc

The CLI enforces structure, complete Fidelity accounting, valid assessment grounds, execution facts, input identity, evidence integrity, ownership, human authority, concurrency, and bounded retries in code.
Missing or duplicate Bn coverage, unknown references, empty rationale, invalid evidence, and unresolved coverage cannot silently pass.
The reviewers decide meaning, contract satisfaction, and observation sufficiency.
A field belongs in a document only when the harness executes or compares it; do not pattern-match natural-language requirements into mandatory evidence kinds.

Do not replace deleted commands with a required Markdown PASS checklist, flow-ID table, user mode, or manual coverage ledger.
Reuse the existing command runner, snapshot, evidence registration, review sandbox, and receipt path.
Copy the existing content-hashed product source set rather than requiring the implementor to predict and register every related source file.
Keep product and evidence discovery inside the fixed copied tree; source access never grants writes, project execution, network, repository history, or access to the live worktree and other host data.
Enforce that read boundary through native restrictions as well as command auditing.
The minimal OS/runtime access needed to run the review engine is execution substrate, not additional review material.
Parallel Fidelity and Code reviews share one attempt, lease, correction budget, and issue history; the distinct high-risk check retains a unique safety question.
Review assessments live in the existing CLI-owned state history, not a second ledger or mandatory user document.

## 8. The whole flow must stay explainable

The end-to-end workflow must be drawable as one simple diagram and walkable
with a small concrete example (three tasks, a few verifications). If
explaining a stage honestly takes a wall of text, the structure - not the
explanation - is the bug.

## 9. Measure it; re-verify before relying on it

Constraints and workarounds recorded in the past ("`--tools ""` stops the
judge from wandering") get retested before a new design leans on them. When a
decision rests on measurement, record the measured data in a why-comment next
to the code, in this codebase's style.

This extends to the harness's own new work: a change is believed after a real
run exercises it end to end, not after its unit tests pass. Running live
pipelines and analyzing the resulting session transcripts - where time went,
where the agent wandered, what it worked around - is the harness's regression
test, and its findings outrank any reasoning about how it ought to behave.

## 10. Records stay honest and singular

`state.json` is the only completion authority; portable receipts and Markdown results derive from it.
A result names the current source and input identity on which it was earned.
Settled role judgments retain their attempt, source, PRD, and input identity in `verificationAttempts`.
Later corrections append a new attempt; CLI mutations cannot rewrite or delete settled historical judgments.
Unrun means unrun, unavailable means unverified, and an old PASS never becomes current merely because the agent says so.
No configured tests is reported separately from successful test execution.

A valid attempt records the phase where it stopped, including preflight or evidence errors before any judge call.
A first failure leaves the run active for repair; explicit finalization closes an honest blocked result when work cannot continue.
Blocked closure cannot require a successful judge result that the failed run never obtained.
Human responses retain their original words and history, and an open explicit rejection makes delivery ineligible even under complete-pending-human.

## 11. General, not overfit

The harness must hold across many project shapes and case sizes (large diffs,
many requirements, quick sessions), not just the case that motivated the change. A fix
tuned to one incident gets checked against the others before it lands.

Detection built from one sample is the sharpest form of this failure, because
it looks like a guard and behaves like a coin flip.
The pre-work checklist regex was written from bullets that literally read
"사람만 가능" and it recognized nothing else - not "소유자만 가능하다", not
"사람이 ... 바꾼다", not a section preamble stating the property for every
bullet at once.
When a mechanism keys on how one document happened to phrase something, widen
the sample before shipping it, or key on structure instead of phrasing.

## 12. Compare outward before inventing

When a design question is genuinely open, look at how peer harnesses and
agent-OS projects solve it before inventing - and import the idea, not the
machinery.

## 13. Never loop on a stage that cannot converge

A test suite converges; a fresh generative reviewer can always suggest another improvement.
Use concrete contract/counterevidence, persistent issue IDs and explicit dispositions, and the existing harness-owned correction bound to make the review process terminate honestly.
Optional advice beyond a satisfied contract stays advisory.

A real omission discovered later in an unchanged file still counts as a defect when it names approved contract content and actual counterevidence.
Changed-path-only validation cannot discard that omission merely to shrink the issue list.
A prior open issue does not disappear because a later review omitted it.
Both routine roles must explicitly resolve a prior issue with evidence before it closes; disagreement or a missing role result keeps it open.
Open blocking risk keeps the entire run incomplete and cannot reset the budget just because routine review passed.
Backend errors and pre-review input failures remain distinct from implementation correction rounds.

At the bound, preserve the failed attempt and open issues and close blocked, or continue only under recorded existing human authority.
Do not replace state, create a second review engine, or silently forgive unmet requirements to manufacture convergence.
