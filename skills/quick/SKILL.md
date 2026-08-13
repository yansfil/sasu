---
name: quick
description: |
  Session-context quick pipeline: contract, implement, verified receipt.
  Use when the user invokes "$quick", asks to implement something small from
  the current conversation without the PRD pipeline, or wants the minimal
  path that still ends in a machine-checked verification PASS. The spec is
  the conversation compressed into acceptance criteria; verification is the
  full `sasu gate verify` command (mechanical checks plus an independent diff judge).
  Do not use when a PRD exists or the user asks for the PRD pipeline.
---

# quick

Run a small implementation from the current conversation to a verified receipt with the minimum ceremony that still proves the result.

What this path keeps from the PRD pipeline: acceptance criteria pinned by content hash, mechanical checks before the judge, an independent judge verdict over the diff and declared runtime evidence, a retry budget, user-only override, and a pin on the exact diff that was judged so a PASS is invalidated when the code changes afterwards.

What it drops: the interview, the 12-section PRD, gap-audit/spec gates, the implement state harness, profile reviews, and ship delivery.

The cost of that trade: the acceptance criteria are the whole spec, judged in one call over the whole diff. When the work needs many criteria over a large diff, verification density drops; the PRD pipeline judges each acceptance criterion at its semantic scope and runs a separate fidelity lane. There is no hard cap - the user's invocation of `$quick` is the only switch - but say so in the final report when the contract grew past a handful of criteria.

The judge stays a single tool-less call no matter how much evidence a run carries. Evidence is material the harness pushes into that one call, never something the judge goes and fetches.

## Preflight

- Derive a kebab-case `<slug>` from the topic.
- Record the base ref: `git rev-parse HEAD`. In a repo with no commits yet, make an initial commit first; the verify diff needs a base.

## Stage 1: Contract

Write `agents/quick/<slug>/contract.md`:

```markdown
---
topic: <slug>
status: active
---

## Goal

<one paragraph: what the user asked for, in this conversation's terms>

## Non-goals

<optional: what is deliberately out>

## Checks

- `<a command that must pass for the whole run, e.g. a smoke test>`

## Acceptance Criteria

- AC1. <a statement the diff judge can check against the code change>
- AC2. <a statement a command can prove>
  - check: `<command that passes only when AC2 holds>`
- AC3. <a statement proven by a runtime artifact>
  - evidence: agents/quick/<slug>/evidence/response.json
- AC4. <a statement proven by something visible>
  - capture: `<command that writes the artifact>` -> agents/quick/<slug>/evidence/screen.png
- AC5. <a statement only a person can settle>
  - human: <what to check and why no command can>
```

Rules:

- Every criterion must be verifiable from the diff or from declared evidence. "Works well" is not a criterion; "`sasu gate verify --contract` extracts ACs from a contract document" is.
- Do not spend a criterion on "tests/lint/build pass": the mechanical stage already gates on those and the judge would only restate it secondhand.
- Capture the conversation's decisions as criteria or non-goals; an assumption the user never saw goes in the report, not silently into code.

### The evidence lane

The judge sees the diff, plus whatever the harness collected for it. It never goes and fetches anything - it has no tools. So a criterion whose proof is a runtime fact has to declare where that proof comes from, and the harness produces it.

Four tiers, most trustworthy first. **Always use the highest tier a criterion can reach**; drop a tier only when the one above is genuinely impossible:

1. **`check: \`<cmd>\`` under a criterion** - a command that passes only when that criterion holds (`curl -sf localhost:3000/health`, a targeted test). The harness runs it on its own clock and shows the judge the command, its exit code, and its output, labelled with the criterion it proves. Reach for this first, always. A bullet under `## Checks` is the same mechanism scoped to the whole run: it gates the gate, but it proves no particular criterion, so prefer the criterion-scoped form when a command maps to one.
2. **`evidence: <path>`** - a text artifact (log, API response, DB dump) inlined into the judge prompt and hash-pinned. Cap is 64KB per file; over that, turn it into a tier-1 command. Weaker than tier 1 because you could have written the file by hand.

3. **`capture: \`<cmd>\` -> <path>`** - for what has to be *seen*. Declare the command, not the image: the harness runs it on its own clock, so the artifact is fresh by construction, then attaches it to the judge. An image you produced yourself is not accepted - the judge cannot tell a current screenshot from last week's. Both halves are required: the command in backticks, then ` -> ` and the exact path that command writes, so the harness knows what to look for.
4. **`human: <why>`** - proof no command can reproduce (a comparison against a design mock, real-device behavior). Never judged; comes back as a `requiresHuman` finding and the run ends by handing it to the user.

Constraints worth knowing before you write the contract:

- Image attachment is a backend capability. Codex supports it directly; Claude can inspect an allowlisted image only in an isolated-read judgment. If a configured routine primary cannot see the image, the criterion falls to the human lane while the capture still runs and is hash-pinned. Configure `judge.profiles.routine.primary` as Codex when a run leans on visual criteria.
- An image only reaches the judge through `capture:`. The same file declared with `evidence:` goes to the human lane instead, because nothing proves when it was made.
- Evidence paths must be relative to the project root (an absolute path is refused even when it points inside), and must resolve to an ordinary file whose content lives in the tree - symlinks out of the tree and hard links are refused at read time. Keep artifacts under `agents/quick/<slug>/evidence/`.
- Inline evidence must be text. Binary content is refused - use a capture for something visual, or a check command for what the binary proves.
- A criterion cannot carry both `human:` and machine evidence; the contract lint refuses it at $0. Split it in two if a person owns half the proof.
- **Never write a taste criterion.** "The spacing is balanced", "the design looks clean" - the judge confirms propositions ("the toggle renders", "the response is 200"), not quality. Visual quality goes in the final report as a human-review item, not into an AC.
- Every evidence file and capture artifact is hashed into the verdict, exactly like the contract itself. Changing one afterwards re-opens the gate.
- Identical commands run once no matter how many places declare them, and every declaring criterion still gets the result. Naming a configured `verify.commands` entry as a criterion's `check:` is fine when that command really is the criterion's proof; a bare `## Checks` restatement of it is just noise.

From this point, run the explicit verify command and do not claim completion until its current-tree verdict is PASS.

Then summarize the contract in chat (goal, ACs, assumptions). Informational, not an approval request; continue immediately - the user can interrupt.

## Stage 2: Implement

Implement directly in the conversation. No task plan, no state harness. Keep the contract honest: if scope genuinely changes mid-run, update the contract first (the judge verdict is pinned to its hash, so an edited contract correctly re-opens the gate).

## Stage 3: Verify

```sh
sasu gate verify --slug <slug> --contract agents/quick/<slug>/contract.md --base <baseRef> --json
```

The JSON carries everything the receipt needs, on every settled path: `criteria` (per-AC judge verdicts; empty when no judge ran), `judgedCriteriaIds` (the criteria sent to the judge), `judgedVerdict` (its verdict before the human lane was folded in; absent when no judge ran), `checks` (criterion-scoped command results), `mechanical.runs`, `evidence` (artifact paths with hashes, including artifacts no judge could read), `inputs` (everything pinned), and `status.findings`.

The judge sees the diff against your base ref, including files the run created. It does not see gitignored files - if something only exists there, prove it with a check command instead. The whole `agents/` namespace is excluded from the diff, so your contract prose never crowds out the code and writing the receipt never stales a PASS (the contract is still pinned by content hash, so editing it does re-open the gate). Dependency lockfiles are excluded too, for the same window-budget reason.

A failing project check stops the run, but criterion-scoped `check:` commands still execute, so a blocked receipt can still say which criteria were already satisfied. `mechanical.resolved` lists every command the run planned, which is where a genuinely skipped one shows up.

- Mechanical commands come from `agents/config.json` `verify.commands` or manifest detection, then the contract's own `## Checks` and `capture:` commands. When the CLI suggests pinning detected commands, relay the suggestion once in the final report.
- On BLOCK/FAIL: fix and re-run, within the judge retry budget (default 3). The budget is N chances to fix and re-verify, not N identical retries: re-running with nothing changed is refused at $0 and spends no attempt, so the fix has to be real. Prelint findings never consume an attempt; every other blocked run does, including a mechanical or evidence failure that costs no judge call. Three typo'd evidence paths exhaust the budget just as three failing test runs would. The CLI reports exhaustion or unchanged-tree refusal explicitly; either ends the fix loop and moves the run to the handoff close. A refusal means the identical question is settled, never that nothing is left to try - it names the base the verdict was judged against, and a verdict earned against the wrong `--base` is one corrected re-run from a different answer.
- An `evidence` finding means a declared artifact is missing, empty, binary, oversized, or resolves outside the project - fix the declaration or the command that produces it. It blocks before the judge call, so it costs nothing but the attempt.
- A `human-verification` finding is not a failure to fix: check it yourself, then carry it into the receipt and the report as an open item. The gate stays non-PASS by design, and the run closes through the handoff path below.
- Never run `sasu gate override`; it is user-only.
- A verdict is pinned to the contract hash, every evidence artifact's hash, and the sha256 of the diff the judge was shown. Changing the code under judgment re-opens the gate; so does editing a pinned document. Re-run verify on the current state. Committing the exact work that passed does NOT re-open it - the pin is content-based, not commit-based.

## Stage 4: Finalize

A quick run closes in one of two ways. Both write the same three artifacts; only the report differs.

**Closing on a live PASS** - every criterion was judged and passed.

**Closing on a handoff** - the fix loop ended without a PASS because a finding needs a person (`requiresHuman`), the retry budget is exhausted, or a re-run is refused on the unchanged tree (budget left but unspendable, so the gate is terminal now). This is a legitimate ending, not an abandoned run: a contract with any `human:` criterion can never reach PASS by construction, and it still has to be closed out properly.

In both cases:

1. Write `agents/quick/<slug>/receipt.md`: goal, one-line outcome, then the verify `--json` per-AC verdicts, check results, mechanical runs, and evidence artifacts (path + hash) embedded verbatim - never restate verification results by hand (derived bookkeeping is how ledgers rot). On a handoff, add an "Open items" section listing every unsettled criterion and what a person must check. When no judge ran (an all-human contract), `criteria` is empty and the receipt rests on `status.findings`, `checks`, and `evidence` instead.
2. Flip the contract frontmatter to `status: complete` - or `status: blocked` on a budget-exhausted or rerun-refused handoff with no `human:` criteria, because that run failed verification and the record must say so (freshness hashing ignores frontmatter, so this does not stale the verdict).
3. Report: what changed, AC verdicts, assumptions made, anything deferred, and an explicit human-review section for every `human:` criterion plus any visual or taste judgment the judge did not make. On a handoff, say plainly that the run did not reach a full PASS and name what is open - never call it Done. Do not commit or push unless the conversation agreed to it.

## Stops

Never stop for stage transitions, and never stop before Stage 4 has run. Stop and ask only when:

- a contract-breaking ambiguity has no defensible assumption.
- a verify finding is marked `requiresHuman`, the retry budget is exhausted, or a re-run is refused on the unchanged tree - after closing the run through the handoff path.
- the work touches an implement-pipeline hard stop (real-data migrations, auth/security decisions, payments, production data, credentials, destructive actions, external spend).
