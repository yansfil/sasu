---
name: quick
description: |
  Session-context quick pipeline: contract, implement, verified receipt.
  Use when the user invokes "$quick", asks to implement something small from
  the current conversation without the PRD pipeline, or wants the minimal
  path that still ends in a machine-checked verification PASS. The spec is
  the conversation compressed into acceptance criteria; verification is the
  full `sasu verify` gate (mechanical checks plus an independent diff judge)
  and the Stop hook blocks completion until it passes fresh.
  Do not use when a PRD exists or the user asks for the PRD pipeline.
---

# quick

Run a small implementation from the current conversation to a verified receipt with the minimum ceremony that still proves the result.

What this path keeps from the PRD pipeline: acceptance criteria pinned by content hash, mechanical checks before the judge, an independent judge verdict over the diff and any harness-collected runtime evidence, a retry budget, user-only override, a tree fingerprint that invalidates a PASS when code changes afterwards, and a Stop hook that blocks "done" without all of the above.

What it drops: the interview, the 12-section PRD, gap-audit/spec gates, the implement state harness, profile reviews, and ship delivery.

The cost of that trade: the acceptance criteria are the whole spec, judged in one call over the whole diff. When the work needs many criteria over a large diff, verification density drops; the PRD pipeline checks each verification row separately and reviews twice. There is no hard cap - the user's invocation of `$quick` is the only switch - but say so in the final report when the contract grew past a handful of criteria.

The judge stays a single tool-less call no matter how much evidence a run carries. Evidence is material the harness pushes into that one call, never something the judge goes and fetches.

## Preflight

- If `agents/implement/.prd-implement-active.json` marks an implement run for this session, stop and ask: one completion guard per session.
- If `agents/quick/.quick-active.json` exists for another topic, resume or ask; never silently discard it.
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

- `<a command the harness runs to prove a criterion>`

## Acceptance Criteria

- AC1. <a statement the diff judge can check against the code change>
- AC2. <a statement proven by a runtime artifact>
  - evidence: agents/quick/<slug>/evidence/response.json
- AC3. <a statement proven by something visible>
  - capture: `<command that writes the artifact>` -> agents/quick/<slug>/evidence/screen.png
- AC4. <a statement only a person can settle>
  - human: <what to check and why no command can>
```

Rules:

- Every criterion must be verifiable from the diff or from declared evidence. "Works well" is not a criterion; "`sasu verify --contract` extracts ACs from a contract document" is.
- Do not spend a criterion on "tests/lint/build pass": the mechanical stage already gates on those and the judge would only restate it secondhand.
- Capture the conversation's decisions as criteria or non-goals; an assumption the user never saw goes in the report, not silently into code.

### The evidence lane

The judge sees the diff, plus whatever the harness collected for it. It never goes and fetches anything - it has no tools. So a criterion whose proof is a runtime fact has to declare where that proof comes from, and the harness produces it.

Four tiers, most trustworthy first. **Always use the highest tier a criterion can reach**; drop a tier only when the one above is genuinely impossible:

1. **`## Checks` command** - a command that passes only when the criterion holds (`curl -sf localhost:3000/health`, a targeted test). The harness runs it; no LLM judgment, no submission bias, no way to fake it. Reach for this first, always.
2. **`evidence: <path>`** - a text artifact (log, API response, DB dump) inlined into the judge prompt and hash-pinned. Cap is 64KB per file; over that, turn it into a tier-1 command. Weaker than tier 1 because you could have written the file by hand.
3. **`capture: \`<cmd>\` -> <path>`** - for what has to be *seen*. Declare the command, not the image: the harness runs it on its own clock, so the artifact is fresh by construction, then attaches it to the judge. An image you produced yourself is not accepted - the judge cannot tell a current screenshot from last week's.
4. **`human: <why>`** - proof no command can reproduce (a comparison against a design mock, real-device behavior). Never judged; comes back as a `requiresHuman` finding and the run ends by handing it to the user, which the Stop hook already allows.

Constraints worth knowing before you write the contract:

- Image attachment is a backend capability. `codex` supports it; `claude` does not (its headless mode has no local-image flag, and the judge is deliberately tool-less). On a claude backend a `capture:` criterion falls to tier 4 automatically - the capture still runs and is hash-pinned, but a person reviews it. Set `judge.backend` to `codex` in `agents/config.json` when a run leans on visual criteria.
- Evidence paths must be project-relative and inside the tree. Keep them under `agents/quick/<slug>/evidence/`.
- **Never write a taste criterion.** "The spacing is balanced", "the design looks clean" - the judge confirms propositions ("the toggle renders", "the response is 200"), not quality. Visual quality goes in the final report as a human-review item, not into an AC.
- Every evidence file and capture artifact is hashed into the PASS pin, exactly like the contract itself. Changing one after a pass re-opens the gate.
- Write `agents/quick/.quick-active.json`:

```json
{ "slug": "<slug>", "contractPath": "agents/quick/<slug>/contract.md", "baseRef": "<sha>", "startedAt": "<iso>" }
```

From this point the Stop hook blocks turn completion until the verify gate passes fresh and finalization is done. On its first firing the hook claims the run by rewriting the marker with an `activeSessionId`; leave that field alone.

- Summarize the contract in chat (goal, ACs, assumptions). Informational, not an approval request; continue immediately - the user can interrupt.

## Stage 2: Implement

Implement directly in the conversation. No task plan, no state harness. Keep the contract honest: if scope genuinely changes mid-run, update the contract first (the judge verdict is pinned to its hash, so an edited contract correctly re-opens the gate).

## Stage 3: Verify

```sh
sasu verify --slug <slug> --contract agents/quick/<slug>/contract.md --base <baseRef> --json
```

- Mechanical commands come from `agents/config.json` `verify.commands` or manifest detection, then the contract's own `## Checks` and `capture:` commands. When the CLI suggests pinning detected commands, relay the suggestion once in the final report.
- On BLOCK/FAIL: fix and re-run, within the judge retry budget (default 3). Prelint findings are free to fix and re-run.
- An `evidence` finding means a declared artifact is missing, empty, or oversized - fix the declaration or the command that produces it. This blocks before the judge call, so the loop is free.
- A `human-verification` finding is not a failure to fix: check it yourself, then report it to the user as the open item. The gate stays non-PASS by design, and the Stop hook lets that run end.
- Never run `sasu gate override`; it is user-only.
- Stop and hand to the user when a finding is marked `requiresHuman` or the budget is exhausted - the Stop hook allows those stops by design.
- A PASS is pinned to the contract hash and the tree fingerprint. Editing the contract or the code after a PASS re-opens the gate; re-run verify on the current state instead of arguing with the hook.

## Stage 4: Finalize

Only after a live PASS:

1. Write `agents/quick/<slug>/receipt.md`: goal, one-line outcome, then the verify `--json` per-AC verdicts, mechanical runs, and evidence artifacts (path + hash) embedded verbatim - never restate verification results by hand (derived bookkeeping is how ledgers rot).
2. Flip the contract frontmatter to `status: complete` (freshness hashing ignores frontmatter, so this does not stale the PASS).
3. Delete `agents/quick/.quick-active.json`.
4. Report: what changed, AC verdicts, assumptions made, anything deferred, and an explicit human-review section for every `human:` criterion plus any visual or taste judgment the judge did not make. Do not commit or push unless the conversation agreed to it.

## Stops

Never stop for stage transitions. Stop and ask only when:

- a contract-breaking ambiguity has no defensible assumption.
- a verify finding is marked `requiresHuman`, or the retry budget is exhausted.
- the work touches an implement-pipeline hard stop (real-data migrations, auth/security decisions, payments, production data, credentials, destructive actions, external spend).
