# Engineering Harness

Personal engineering workflow harness for Codex.

This repository owns the local PRD workflow skills.
Skill names use the butler set; directories keep the legacy names.

- `listen` (directory `intake`) - pre-PRD requirements interview
- `promise` (directory `prd`) - PRD as a human decision contract
- `fulfill` (directory `prd-implement`) - harness-driven implementation
- `deliver` (directory `prd-ship`) - GitHub PR delivery
- `pantry` (directory `prd-setup`) - pipeline configuration
- `please` (directory `please`) - all-in-one runner: conversation to promise to fulfill to deliver, no approval round-trips, stops only for risky work

The installed Codex skill directories under `~/.codex/skills` are generated from this repository.
`SKILL.md` is copied as a real file because current Codex skill loading can omit symlinked `SKILL.md` files.
Auxiliary files and directories such as `scripts`, `references`, and `agents` are symlinked back to this repository.

## Install Locally

```sh
node scripts/install-local-skills.mjs
```

After changing installed skills, verify skill visibility with:

```sh
codex debug prompt-input
```

