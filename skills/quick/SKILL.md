---
name: quick
description: |
  Session-context quick pipeline: compact contract, implement, verified receipt.
  Use when the user invokes "$quick", asks to implement something small from
  the current conversation without the PRD pipeline, or wants the shortest
  path with required checks and an independent whole-contract review.
  Do not use when a PRD exists or the user asks for the PRD pipeline.
---

# quick

Implement a bounded conversation contract and finish with the actual CLI review result.
Keep this path independent from the PRD/implement lifecycle: no interview, spec gate, implement state, or confirm command is required.
Requirements keep their `AC1` references, while checks, evidence, and human input belong to the whole run.
The ordinary path uses one comprehensive independent review without per-AC success results or mandatory per-AC evidence.

## Authority And Preflight

The `$quick` invocation delegates reversible in-scope choices to the implementor as recorded assumptions.
Use conversation and project conventions to resolve routine details.
Preserve all requirements, and distinguish assumptions from actual approval.
Only unresolved expensive choices or new authority for credentials, payment, production data, destructive effects, security policy, or irreversible actions require a user decision.
Existing authorization continues to apply.

Record the current base ref with `git rev-parse HEAD` and preserve unrelated dirty changes.
For a repository without a commit, create the authorized initial baseline before verification.
Read project instructions and run `sasu principles list --json`.
Read applicable declared domain documents in full; an empty domain list is normal, but an unreadable declared source is a reported error.
Translate applicable product behavior into the compact contract and retain actual implementation constraints without inventing a separate proof ledger.

## 1. Compact Contract

Write `agents/quick/<slug>/contract.md` from the conversation before editing product code:

```markdown
---
topic: <slug>
status: active
---

## Goal

<the requested outcome>

## Non-goals

<optional scope boundaries>

## Checks

- `<required command for the whole run>`

## Acceptance Criteria

- AC1. Saving a note adds it to the list.
- AC2. Searching filters saved notes and exposes an empty-result state.
- AC3. A storage failure preserves the text and reports the failure.

## Evidence

- agents/quick/<slug>/evidence/session.log
- capture: `<command writing a screenshot>` -> agents/quick/<slug>/evidence/search.png

## Human Review

<optional genuine human judgment and its existing source>
```

`Evidence` and `Human Review` are optional: omit them when unnecessary, including empty tables for document-only work.
`Checks` is the run-level command list, and configured project commands remain required.
Plain evidence paths (or `evidence: <path>`) register observations; capture declarations execute a command and collect its file.
Keep paths relative to the project and preserve collection context and limitations in the observation itself.
Old indented method fields under an AC are rejected as a retired contract rather than silently ignored.

Every AC is an observable requirement; do not add one merely to restate that build/lint/tests must pass.
Preserve material decisions, rejected options, non-goals, and assumptions.
Do not make a requirement PASS table, assign evidence to every AC, or force the compact contract into a PRD.
Summarize the contract and assumptions in conversation, then continue under existing authorization.

## 2. Implement And Observe

Implement the coherent scope and choose focused checks appropriate to plausible regressions.
Drive actual UI and runtime behavior where needed.
One observation may support many ACs, and the reviewer receives the full contract regardless of evidence type or human judgment.
A real environment, device, or service that was not observed remains unverified.
When scope changes under existing authority, update the compact contract before claiming a result; its hash participates in freshness.

Use owned, self-contained browser/server lifecycles for repeatable automated tests.
Manual QA may use the available browser tools, including chromux, with fresh screenshots and cleanup of resources this run created.
For native apps, verify the actual instance and build being observed.

## 3. Verify

```sh
sasu gate verify --slug <slug> --contract agents/quick/<slug>/contract.md --base <baseRef> --json
```

The gate executes configured/detected required commands, contract Checks, and captures, checks evidence integrity, and independently reviews the complete compact contract against current implementation and shared actual results.
Evidence paths must resolve to ordinary files inside the project; missing, empty, invalid, oversized, or escaped evidence blocks review explicitly.
A backend that cannot inspect required images must use an existing capable route or report inability; it cannot remove the requirement or silently convert it to later human approval.

The JSON carries the whole `review`, actual `mechanical.runs`, run-level `checks`, evidence paths/hashes/provenance, pinned `inputs`, errors, and `status.findings`.
Quote those results rather than authoring your own derived success ledger.
The judge receives previous findings so they cannot vanish merely by omission.
It records actual defects, optional advisories, and human judgments; the gate derives the outcome from these issues rather than a bare PASS string.

Bookkeeping under `agents/**` stays outside product diff and source freshness.
Explicitly declared contracts and artifacts still participate in pinned inputs.
A current review belongs to the exact source, contract, evidence, and execution inputs it evaluated.
Committing unchanged reviewed content does not itself change that content identity.
A source hash alone does not establish that a database, ignored file, external service, or new capture is unchanged.

On a failed result, fix concrete defects or missing observations and verify again within the existing retry bound.
Prelint failures are distinct from executed judge calls.
Respect exhaustion and identical-input refusals without bypasses; report actual external changes when determining whether a new attempt can add information.
Do not run extra independent adversarial loops.
Never execute the user-only `gate override` on the user's behalf; an explicit user override is a deviation, not verification PASS.

## 4. Close With The Actual Result

Write `agents/quick/<slug>/receipt.md` with the goal, implemented outcome, and complete CLI JSON embedded verbatim.
Describe actual tests and observations, review findings, assumptions, open human judgments, and unavailable work around that record without rewriting its verdicts.
A current PASS permits `status: complete`; a failure, exhausted correction, or unresolved human judgment closes as `status: blocked` with the actual `NEEDS_HUMAN` or failure result.
Quick does not import implement's pending-human confirmation state machine.

Report what changed, what actually ran, what the full-contract review found, assumptions, remaining limitations, and the receipt path.
If a person must still decide, say plainly that the run did not reach full completion.
Complete already authorized commits or delivery; do not add new external effects without authority.
Never stop merely at a stage boundary or leave a settled failed run without its honest handoff record.
