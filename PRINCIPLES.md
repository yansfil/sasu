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
> 실수없이 · 효율적으로) — and it must never become a second implementation
> that outweighs the first.

Items 1 and 2 are a pair, and they are read together or not at all. Ceremony
gets cut; proof never does.

## 1. Prove every AC with the tools you actually have

Verification must be tight (촘촘하게). Every acceptance criterion carries an
observable fact that the harness itself can see — not the agent's report that
it implemented something. "I made the change" is not evidence; an exit code, a
captured response, a rendered screen, a queried row is.

So use the full instrument set before falling back to reading a diff: a
mechanical command's exit code, a declared AC oracle, a runtime capture
(browser, API, DB), a registered artifact, an agentic judge with read-only
repository access when the proof lives outside the diff. Judging a criterion
from the diff alone is the weakest available instrument, not the default one.
Reach for the strongest instrument the criterion admits, and reach hard — the
work of finding a way to observe the fact is the job, not an optional extra.

Two consequences:

- If no instrument can observe an AC, that is usually a defect in the AC, not
  a licence to pass it. Rewrite it so something can be observed. If it still
  cannot be, record it as unproven — see item 10; skipped means skipped.
- Cost is never grounds for deleting a proof. The only grounds are the ones in
  item 4: a stage that catches nothing another stage does not already catch.
  "This is slow" argues for making the proof cheaper or concurrent, never for
  not having it.

## 2. Verification must not outweigh implementation

Watch the ratio of verify/review/orchestration wall-clock to actual
implementation time. A stage that dominates the run is a bottleneck to fix,
not a cost of correctness. Measure before optimizing — phase timings exist so
that "it feels slow" becomes a number.

What gets cut here is ceremony: bookkeeping, restated structure, prose
validated for shape, a review re-reading what a settled gate already judged.
Never the proof of item 1.

## 3. Fix the one cause, not the N symptoms

Before accepting a fix list, ask whether the entries are one disease. A list of
five plausible patches to five sites is usually a missing single concept, and
patch-by-patch does not hold in this codebase — the freshness deadlock proved
it, where a fix applied to one fingerprint never propagated to its two
siblings. Prefer the change that makes the failure class structurally
impossible over the change that handles today's instance. When a proposal is
"근본적으로 해결되는가?", the honest answer is often no; say so and re-derive.

## 4. Every stage must earn its place, and every addition names its deletion

For each gate, review, or pass, name the failure it uniquely catches. Two
stages that catch the same failure get merged or one gets deleted (fidelity
vs final review is the canonical example — final review became a delta pass).
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
once on a `check:` command, whose FAIL came from a gitignored service that had
since been fixed).
Fan out freely; before skipping, prove purity.

## 6. Verify at the semantic unit, not the text unit

Judging happens per acceptance criterion, and each judge's input is scoped to
what that criterion needs. Handing every lane the entire diff is a smell;
mechanically slicing text is not semantic verification. Prefer designs where
the AC, its evidence, and its slice of the change travel together.

## 7. The harness absorbs complexity — never the workflow user, never a doc

A fix that makes the PRD author or the implementing agent configure something
new (per-AC diff files, extra knobs, manual bookkeeping) is the wrong fix,
even if it works. The harness infers, records, and carries the burden. If a
proposal complicates the contract the human or agent writes, look again.

The same rule applies to enforcement. A rule that lives only as skill-document
prose is a request for discipline, not a guard: it is skipped under context
pressure and cannot be tested. Whatever the harness can decide in code — an
ordering constraint, a scope check, a required input, a refusal — belongs in
code, and the doc shrinks to one line. Move the natural-language rules down
into code in ROI order (the ones that burn the most time or admit the worst
failure first), not all at once.

Pushing a rule into code is not the same as pushing a *judgment* into code,
and the line between them has one test: does the harness execute or compare
the value?
`Scope:` globs slice a diff, `Check:` commands run, `Covers:` references are
matched - the value is machine input, so asking the document to declare it is
honest work.
A value the harness only reads in order to decide who to talk to is not: that
belongs to the agent, which reads natural language for a living.
The failure this prevents is the harness pattern-matching prose for meaning.
A keyword regex over Korean pre-work bullets missed every human-only item in a
real PRD whose author had stated the property plainly one line above, and the
empty result actively overrode what the agent already knew, because the agent
had written that PRD seven minutes earlier (2026-08-11, the second recurrence
of the same stall the checklist was built to prevent).
Extract the structure mechanically, force the disposition mechanically, and
leave the meaning to the agent.

## 8. The whole flow must stay explainable

The end-to-end workflow must be drawable as one simple diagram and walkable
with a small concrete example (three tasks, a few verifications). If
explaining a stage honestly takes a wall of text, the structure — not the
explanation — is the bug.

## 9. Measure it; re-verify before relying on it

Constraints and workarounds recorded in the past ("`--tools ""` stops the
judge from wandering") get retested before a new design leans on them. When a
decision rests on measurement, record the measured data in a why-comment next
to the code, in this codebase's style.

This extends to the harness's own new work: a change is believed after a real
run exercises it end to end, not after its unit tests pass. Running live
pipelines and analyzing the resulting session transcripts — where time went,
where the agent wandered, what it worked around — is the harness's regression
test, and its findings outrank any reasoning about how it ought to behave.

## 10. Records stay honest and singular

Receipts, docs, and provenance never overclaim: skipped means skipped, and a
pass names the tree it was earned on. `state.json` is the only record — no
derived views or ledgers that can drift from it.

## 11. General, not overfit

The harness must hold across many project shapes and case sizes (large diffs,
many ACs, quick sessions), not just the case that motivated the change. A fix
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
agent-OS projects solve it before inventing — and import the idea, not the
machinery.

## 13. Never loop on a stage that cannot converge

A test suite converges: fix it, it goes green, it is done.
A fresh adversarial reviewer does not - handed any codebase it will produce
findings, so "re-run it whenever anything changed" has no fixed point.
Pairing a generative stage with whole-run invalidation builds a loop whose
only brake is the agent deciding to stop.
In an audited run, five adversarial review rounds spanned 92 minutes (08:27 to
09:59), the last two returning only LOW items, on a run whose verify gate never
once returned a criterion FAIL in ten attempts and whose entire measured judge
spend was 5.5 minutes (2026-08-11).
Each round was a sidecar the agent summoned on its own judgment: nothing in
`state.json` or the receipt records that a round happened, so the loop the
harness cannot see is also the loop it cannot bound.
Wall-clock alone would have overstated this by 85 minutes of user absence -
re-derive a duration from what actually ran before resting a rule on it
(item 9).

A stage that cannot converge on its own needs a bound the harness owns: a
delta contract so round N+1 sees only what changed since round N, a severity
floor so advisory findings are recorded as follow-ups instead of re-triggering
the chain, or an explicit round cap.
Recording an open LOW finding in the receipt is more honest than a fifth round
that pretends to close it (item 10).
