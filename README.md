# Engineering Harness

Personal engineering workflow harness for Codex and Claude Code.

This repository owns the local PRD workflow skills.
Skill names use the butler set; repository directories keep the legacy names.

- `listen` (directory `intake`) - pre-PRD requirements interview
- `promise` (directory `prd`) - PRD as a human decision contract
- `fulfill` (directory `prd-implement`) - harness-driven implementation
- `deliver` (directory `prd-ship`) - GitHub PR delivery
- `pantry` (directory `prd-setup`) - pipeline configuration
- `please` (directory `please`) - all-in-one runner: conversation to promise to fulfill to deliver, no approval round-trips, stops only for risky work

## Install Locally

```sh
node scripts/install-local-skills.mjs
```

One command installs both runtimes:

- **Codex** (`~/.codex/skills/<legacy-dir>/`): `SKILL.md` is copied verbatim as a real file
  (current Codex skill loading can omit symlinked `SKILL.md` files).
  Codex resolves the skill name from frontmatter, so `$listen` works with legacy directories.
- **Claude Code** (`~/.claude/skills/<butler-name>/`): the `/command` name comes from the
  directory, so skills install under butler names (`/listen`, `/promise`, ...).
  `SKILL.md` is copied with path and invocation substitutions
  (`~/.codex/skills/prd-implement/` becomes `~/.claude/skills/fulfill/`, `$fulfill` becomes `/fulfill`).

Auxiliary files and directories such as `scripts` and `references` are symlinked back to this
repository in both installs, so one implementation serves both runtimes.
The `prd_state_harness.js` and `prd_ship.js` scripts locate themselves and their sibling scripts
from the invoked path, so emitted commands always match the current install.

The installer also registers the harness hooks idempotently:

- Codex: `Stop` and `PreToolUse` in `~/.codex/hooks.json`
  (the `PreToolUse` guard blocks premature `update_goal complete`).
- Claude Code: `Stop` in `~/.claude/settings.json`
  (Claude Code has no `update_goal` tool; the Stop hook is the only guard).

## Verify

```sh
node --test tests/*.test.mjs
node ~/.codex/skills/prd-implement/scripts/prd_state_harness.js doctor
```

`doctor` reports hook registration for both runtimes.
After changing installed skills, verify skill visibility:

- Codex: `codex debug prompt-input`
- Claude Code: start a new session and check that `/listen`, `/promise`, `/fulfill`,
  `/deliver`, `/pantry`, and `/please` appear in the skill list
