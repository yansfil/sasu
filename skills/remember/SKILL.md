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

The checkshirt guy is never told the same thing twice.
This skill turns a lesson into a landed asset: a documented fact, a machine-checked invariant, or a regression test.
A lesson that only becomes prose is not learned; it must end up somewhere that a machine or a future session is forced to encounter.

Match the user's language by default.

## The Landing Model

Every lesson gets classified twice, then landed:

| Kind | What it is | Landing | Enforced by |
| --- | --- | --- | --- |
| fact | something agents must know (build quirks, gotchas, commands) | body in `docs/**`, one index line in AGENTS.md | auto-loaded context |
| invariant | "when X changes, Y must hold" | `agents/rules/invariants/<ID>.md` via `rules add` | `ho-ship` pre-push gate + ho-build plan injection |
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

## Procedure

1. State the lesson in one sentence and classify it (kind + route). If it cannot be stated as a checkable condition or a fact, it is not a lesson yet; sharpen it with the user.
2. Check for duplicates before landing anything:

```sh
node ~/.codex/skills/ho-build/scripts/prd_state_harness.js rules relevant --query "<keywords>"
```

Also skim `agents/rules/INDEX.md`. If an existing rule covers it, update that rule instead of adding a twin (the CLI rejects exact duplicates anyway).

3. Make sure the structure exists (first use in a project):

```sh
node ~/.codex/skills/ho-build/scripts/prd_state_harness.js seed-agents-md
```

If CLAUDE.md exists as a regular file, the command refuses: show the user its content, get confirmation, then rerun with `--adopt-claude-md` (content becomes AGENTS.md verbatim; CLAUDE.md becomes a symlink).

4. Land by kind:

**invariant** - write a draft file and register it through the CLI (never hand-edit `INDEX.md` or the invariants directory):

```markdown
---
id: INV-<short-name>
kind: invariant
status: active
evidence:
  - agents/implement/<run>/state.json#D3
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
node ~/.codex/skills/ho-build/scripts/prd_state_harness.js rules add --file <draft.md>
```

`check.type` is `command`, `grep` (pattern + files + present/absent), or `manual` (requires an exact `confirm` sentence; surfaces as a delivery warning, never a silent skip).
The CLI rejects rules without evidence, without a trigger, or without a workable check: an unverifiable good intention is not an invariant, downgrade it to a fact or drop it.

**fact** - write the body where the project's docs already live (follow existing structure; default `docs/`), add one line to AGENTS.md outside the seeded marker block (keep the index lean, roughly 30 lines; details belong in docs), then register the landing:

```sh
node ~/.codex/skills/ho-build/scripts/prd_state_harness.js rules add --kind fact --id FACT-<name> --summary "<one line>" --evidence "<run or incident ref>" --landing docs/<page>.md
```

**regression** - write the test now, in the project's own test suite, and register it with `--kind regression --landing <test file>`. Only when writing it now is genuinely impossible, park it:

```sh
node ~/.codex/skills/ho-build/scripts/prd_state_harness.js rules add --kind regression --id REG-<name> --summary "<one line>" --evidence "<ref>" --pending
```

Pending lessons are visible debt: `ho-ship` warns on every ship and `doctor` reports them until they land.

5. For `user` route: propose the exact line(s) for the shared reference file and ask before writing.
   For `harness` route: prepare the diff against the engineering-harness repo and present it; apply only on confirmation.

## What Happens After Landing

You do not need to re-teach landed lessons; the harness carries them:

- `ho-ship` matches every changed file against invariant triggers and fails closed on a failing check (`--skip-rules --reason` is the only way past, and it lands in the ship log).
- `ho-build plan-execution` injects invariants whose triggers overlap the run's write scopes as verification items, so the receipt depends on them.
- `ho-setup doctor` rot-checks the ledger: missing landings, dead triggers, and pending debt.

## Hard Stops

- Never write to the user's home-directory files without explicit confirmation in this conversation.
- Never apply harness-repo changes without showing the diff and getting confirmation.
- Never register an invariant whose check you did not actually run once yourself.
- Never bypass `rules add` by editing `agents/rules/**` directly.

## Report

After landing, report: the lesson in one sentence, kind + route, the landed path(s), the evidence reference, and (for invariants) proof that the check runs (command output or `rules check --all` result).
