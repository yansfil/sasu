---
name: challenge
description: |
  Red-team a conclusion that is already on the table: take the dissenting
  opinion seriously, investigate it on its own terms, then rule on it.
  Use when the user invokes "$challenge", types the "!rv" trigger, says
  "반박해봐", "이거 아니라는데", "다시 검증해봐", "red team this",
  "challenge this", "steelman the objection", or when a decision is about to
  be acted on and someone has pushed back on it.
  Do not use to review an unreviewed diff - that is what the gates are for.
---

# challenge

A conclusion that has only ever been defended by the one who reached it has not been tested.
This skill takes an objection to a standing conclusion, gives it the strongest possible case, and then rules.

The output is a verdict, not a longer argument: **upheld**, **revised**, or **overturned** - plus an honest list of what stayed unresolved.

Match the user's language by default.

## Why This Is Not A Loop

`PRINCIPLES.md` item 13 records what happens when an adversarial stage is re-run on the agent's own judgment: five rounds, 92 minutes, the last two returning only LOW items, on a run whose verify gate never once failed.
A fresh adversarial reviewer has no fixed point - handed anything, it produces findings.

So this skill is bounded by construction, and the bounds are not negotiable by the agent running it:

| Bound | Value | Why |
| --- | --- | --- |
| round cap | 2 | hard ceiling; a request for more is clamped and the clamp is stated |
| delta contract | round 2 sees only what round 1 left open | no re-litigating settled claims |
| re-round trigger | new **evidence**, never new opinion | an opinion round has no fixed point |
| unresolved handling | recorded as an open finding | more honest than a round that pretends to close it (item 10) |

If round 1 resolves every claim, there is no round 2. Stopping early is the expected outcome, not a shortcut.

## Inputs

- **The standing conclusion.** What was decided, and the reasoning that got there. If it is only in conversation, write it down first - an unstated claim cannot be refuted.
- **The objection.** What came in against it, verbatim. Preserve the dissenter's own words; paraphrasing it into your frame is how an objection gets quietly defeated before it is examined.
- **The stakes.** What becomes wrong if the objection is right. This sets how hard to dig.

## Procedure

### 1. Decompose into falsifiable claims

Split the objection into claims that could each be shown true or false by evidence.
A claim that no evidence could settle is not a claim - route it to the unresolved list immediately and say why.

For each claim, name **what evidence would settle it**: a file, a command's exit code, a benchmark, a spec line, an upstream doc, a measured number.
Write this before dispatching anything. A subagent sent out without a stated evidence target comes back with prose.

### 2. Fan out, blind

Dispatch in a single parallel batch (item 5 - parallel by default):

- **One prosecutor per claim.** Its brief is the claim and the evidence target. It is told to prove the claim. **It is not told your conclusion, and not told that a defense agent exists.** A prosecutor that knows the verdict it is contradicting argues against a person instead of investigating a question.
- **One defender, once.** Its brief is the standing conclusion and the evidence that supports it. It is told to hold the position with evidence, not rhetoric.

Every agent returns the same shape: claim, verdict (`supported` / `refuted` / `undetermined`), and the evidence, cited concretely - `file:line`, a command and its output, a URL, a measured number. **An agent's own assertion is not evidence** (item 1). A report with no citation is scored `undetermined` regardless of how confident it reads.

### 3. Adjudicate

You do this yourself; you do not delegate the verdict.

Compare the evidence, not the confidence. For each claim:

- `supported` with real evidence → the objection wins this claim.
- `refuted` with real evidence → the conclusion holds on this claim.
- Both sides cite evidence and it conflicts → **re-derive it yourself** before ruling (item 9). Conflicting evidence is the one case worth spending your own turn on.
- `undetermined` → goes to the unresolved list. It does not silently become "fine".

Then rule on the whole:

| Verdict | Meaning |
| --- | --- |
| upheld | every material claim refuted with evidence; conclusion stands unchanged |
| revised | some claims survived; the conclusion changes in a named way |
| overturned | a load-bearing claim survived; the conclusion does not survive it |

### 4. Round 2, only on a delta

Run a second round **only if** round 1 produced new evidence that opens a claim nobody had stated at the start.
The second round's brief is exactly that delta - the open claims and nothing else.

Do not run round 2 because the result feels uncomfortable, because the defender was unconvincing, or because more scrutiny is generally good. Those are the reasons behind the 92-minute incident.

After round 2, you stop. Whatever is still open is reported open.

## Output

Report in conversation. Persist a file only if the user asks, or if the conclusion is one an implementation will be built on.

```
VERDICT: upheld | revised | overturned

Claims
  <claim>  supported|refuted  <the evidence, cited>
  ...

What changes
  <nothing, or the specific revision>

Open
  <claim>  <why it could not be settled, and what would settle it>
  (none)
```

Rules for this report:

- Cite evidence inline. A verdict line with no citation next to it is not reportable.
- State the round count and whether the cap was hit.
- If the objection turned out to be right, say so plainly and lead with it. The point of the skill is to be able to lose.
- Never report "no issues found" as a synonym for "found nothing to cite". Say which claims went uninvestigated and why.

## Failure Modes

| Symptom | What is actually wrong |
| --- | --- |
| every claim comes back `refuted` | prosecutors were told the conclusion; re-dispatch blind |
| findings are style/severity noise | the objection was never decomposed into falsifiable claims |
| round 3 feels necessary | the delta contract was skipped in round 2; report open instead |
| verdict reads as a summary of both sides | you delegated the adjudication; rule, or say you cannot |
| the report is longer than the original decision | verification outweighed implementation (item 2); cut the ceremony, keep the citations |
