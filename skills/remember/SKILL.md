---
name: remember
description: |
  Land a lesson as an enforcement asset so the same mistake cannot repeat.
  Use when the user invokes "$remember", says "remember this", "learn from
  this", "don't do that again", "배워둬", "기억해둬", "같은 실수 하지마",
  when a finalize receipt suggests lessons from recorded deviations, or when
  a painful debugging/rework session just ended and its cause is nameable.
---

# remember

The sasu guy is never told the same thing twice.
This skill turns a lesson into a landed asset: a documented fact, a machine-checked invariant, or a regression test.
A lesson that only becomes prose is not learned; it must end up somewhere that a machine or a future session is forced to encounter.

Match the user's language by default.

## The Landing Model

Every lesson gets classified twice, then landed:

| Kind | What it is | Landing | Enforced by |
| --- | --- | --- | --- |
| fact | something agents must know (build quirks, gotchas, commands) | body in `docs/**`, one index line in AGENTS.md | auto-loaded context |
| invariant | "when X changes, Y must hold" | `agents/rules/invariants/<ID>.md` via `rules add` | `ship` pre-push gate + implement plan injection |
| regression | "a test would have caught this" | a real test in the project's own suite | the project's CI / verification plan |

| Route | Where it goes |
| --- | --- |
| project | the target project, per the table above |
| user | the user's shared reference files (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`), only with explicit confirmation |
| harness | a proposed diff to the engineering-harness repo (SKILL.md or scripts); never applied without confirmation |

## Inputs

- An explicit lesson from the user in conversation.
- `rememberSuggestions` from a `finalize` receipt, and the `deviations` array in the latest run's `state.json`.
- A just-finished incident: name the cause before it evaporates.

## Mandatory Confirmation Gate

Before any mutation:

1. Inspect existing rules and target files read-only.
2. Present the lesson, kind, route, exact target paths, proposed content or diff, and expected checks or side effects.
3. Ask the user to approve those exact changes.

Treat invoking `$remember`, saying "remember this", or describing the lesson as a request to prepare the proposal, not as permission to write.
Only explicit confirmation given after the preview authorizes mutation.
If the target paths or proposed content change, preview again and re-confirm.

## Procedure

1. State the lesson in one sentence and classify it (kind + route). If it cannot be stated as a checkable condition or a fact, it is not a lesson yet; sharpen it with the user.
2. Check for duplicates before landing anything:

```sh
sasu rules relevant --query "<keywords>"
```

Also skim `agents/rules/INDEX.md`. If an existing rule covers it, update that rule instead of adding a twin (the CLI rejects exact duplicates anyway).

3. Present the mandatory confirmation preview and stop.
   Do not create a draft, edit a landing, run `seed-agents-md`, register a rule, or create pending debt before the user explicitly approves the shown changes.
4. After confirmation, make sure the structure exists (first use in a project):

```sh
sasu setup seed-agents-md
```

If CLAUDE.md exists as a regular file, the command refuses: show the user its content, get confirmation, then rerun with `--adopt-claude-md` (content becomes AGENTS.md verbatim; CLAUDE.md becomes a symlink).

5. Land by kind:

**invariant** - write a draft file and register it through the CLI (never hand-edit `INDEX.md` or the invariants directory):

```markdown
---
id: INV-<short-name>
kind: invariant
status: active
evidence:
  - agents/runs/<run>/state.json#D3
trigger:
  paths:
    - "src/payments/**"
check:
  type: command
  run: pnpm test --filter payments
---

One paragraph: what must hold and why (cite the incident).
```

```sh
sasu rules add --file <draft.md>
```

`check.type` is `command`, `grep` (pattern + files + present/absent), or `manual` (requires an exact `confirm` sentence; surfaces as a delivery warning, never a silent skip).
The CLI rejects rules without evidence, without a trigger, or without a workable check: an unverifiable good intention is not an invariant, downgrade it to a fact or drop it.

**fact** - write the body where the project's docs already live (follow existing structure; default `docs/`), add one line to AGENTS.md outside the seeded marker block (keep the index lean, roughly 30 lines; details belong in docs), then register the landing:

```sh
sasu rules add --kind fact --id FACT-<name> --summary "<one line>" --evidence "<run or incident ref>" --landing docs/<page>.md
```

**regression** - write the test now, in the project's own test suite, and register it with `--kind regression --landing <test file>`. Only when writing it now is genuinely impossible, park it:

```sh
sasu rules add --kind regression --id REG-<name> --summary "<one line>" --evidence "<ref>" --pending
```

Pending lessons are visible debt: `ship` warns on every ship and `doctor` reports them until they land.

6. Respect the approved route and scope.
   For the `user` route, the approval preview must include the exact line(s) for the shared reference file.
   For the `harness` route, the approval preview must include the exact diff against the engineering-harness repo.
   Approval for one route or scope never authorizes another.

## What Happens After Landing

You do not need to re-teach landed lessons; the harness carries them:

- `ship` matches every changed file against invariant triggers and fails closed on a failing check (`--skip-rules --reason` is the only way past, and it lands in the ship log).
- implement's execution planning (run automatically at `init`, rerun by `plan-execution`) injects invariants whose triggers overlap the run's write scopes as verification items, so the receipt depends on them.
- `sasu-setup doctor` rot-checks the ledger: missing landings, dead triggers, and pending debt.

## Hard Stops

- Never create, edit, register, or apply anything before explicit confirmation given after the proposed changes are shown.
- Never treat `$remember` invocation or the user's lesson description itself as approval.
- If the actual landing differs from the approved preview, stop and re-confirm.
- Never write to the user's home-directory files without explicit confirmation in this conversation.
- Never apply harness-repo changes without showing the diff and getting confirmation.
- Never register an invariant whose check you did not actually run once yourself.
- Never bypass `rules add` by editing `agents/rules/**` directly.

## Report

After landing, report: the lesson in one sentence, kind + route, the landed path(s), the evidence reference, and (for invariants) proof that the check runs (command output or `rules check --all` result).
