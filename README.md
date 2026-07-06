# Engineering Harness

Personal engineering workflow harness for Codex.

This repository owns the local PRD workflow skills:

- `intake`
- `prd`
- `prd-implement`
- `prd-setup`
- `prd-ship`

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

