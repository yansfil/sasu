# sasu

<p align="center"><img src="assets/mascot.png" width="260" alt="sasu mascot"/></p>

**Your agent codes. Sasu keeps the proof simple and current.**

Sasu is a shared workflow and CLI for turning a conversation into an approved PRD, implementing it, checking the current Git state, and delivering a reviewable pull request.
The Korean word 사수 means the senior developer sitting next to you.

The current implementation flow is deliberately small:

```text
conversation
  -> interview-me: resolve missing decisions
  -> gen-prd: write the approved product contract
  -> implement: build and observe the real behavior
     -> commit the current implementation head
     -> sasu implement verify: deterministic checks and current report
     -> native review subagents: visible advisory review
  -> ship: record local delivery or push a pull request, CI, and approved merge
```

Sasu code blocks only on facts it can reproduce: PRD validity, source and evidence freshness, required command results, and delivery integrity.
Fidelity, Code, and Security review run through each runtime's native subagent facility.
Those reviews return `Fix now`, `Follow-up improvements`, and `What was checked` as ordinary Markdown.
GitHub CI and people remain the final delivery authority.

Read [PRINCIPLES.md](PRINCIPLES.md) for the project rules and [the approved stateless verification plan](docs/plans/2026-09-15-stateless-verification.md) for the architecture decision.

## Skills

| Skill | Responsibility |
| --- | --- |
| `interview-me` | Resolve product decisions and create one normalized `qa-log.md`. |
| `gen-prd` | Write the complete approved PRD with decisions and observable behaviors. |
| `implement` | Implement the PRD, observe real behavior, run deterministic verification, and request visible native review. |
| `ship` | Validate the current report and committed head, create a pull request, watch CI, and perform an explicitly approved merge. |
| `sasu-setup` | Configure delivery mode, worktrees, ignored run state, and doctor checks. |
| `quick` | Implement a small conversation-scoped change with repository checks and native review. |
| `please` | Run the full conversation-to-delivery pipeline with only necessary human decisions. |
| `remember` | Turn a reusable lesson into documentation, a machine rule, or a regression test. |
| `challenge` | Run a bounded adversarial challenge of an existing conclusion. |

Run artifacts live under the target project's `agents/**` namespace.
`state.json` stores run ownership, the sealed PRD and suite, evidence registrations, actual verification attempts, and the current report identity.
`verification-report.json` and `verification-report.md` are derived snapshots of the current input.
There is no completion receipt or semantic reviewer state machine.

## Install For Codex And Claude Code

```sh
node scripts/install-local-skills.mjs
```

One repository source serves both runtimes.
Codex receives real `SKILL.md` files under `~/.codex/skills/`.
Claude Code receives corresponding skills under `~/.claude/skills/` with invocation and path substitutions.
Auxiliary scripts stay linked to this checkout so fixes update both runtimes together.

After installation, start a fresh session and confirm that the nine skills above appear.
For Codex, `codex debug prompt-input` can verify that the installed `SKILL.md` files are visible.

## CLI

Build the local CLI:

```sh
npm --prefix cli install
npm --prefix cli run build
node cli/dist/cli.js --help
```

The implementation path uses these main commands:

```text
sasu implement intake
sasu implement start --prd <approved-prd>
sasu implement artifact --kind <kind> --path <path> --description <description>
sasu implement status
sasu implement verify
sasu implement amend --issuer human --approval <evidence> --reason <reason>
sasu implement retire
```

`verify` performs PRD prelint, runs the sealed required suites, checks source and evidence identity, and replaces the current verification report.
It does not start models, impose reviewer turn limits, parse reviewer output, or decide whether a pull request may merge.
Any source or material evidence change makes the report stale until verification runs again.

Retired receipt, finalize, confirm, and implementation-risk commands fail explicitly.
Old state and report shapes are rejected rather than silently migrated.

## Delivery

The ship workflow validates:

- the current `sasu.verification-report.v1` status and input identity;
- exact Git head and a clean Git-visible worktree;
- base branch freshness;
- prohibited placeholders or agent attribution;
- GitHub CI, pull request head, and mergeability;
- explicit user approval before merge.

The pull request includes actual command results, runtime evidence, review availability, Fix now dispositions, Follow-up improvements, and specific human review focus.
Reviewer unavailability stays visible and does not rewrite a deterministic PASS as a product failure.

## Development

Repository instructions in [AGENTS.md](AGENTS.md) require the following final order for changes under `cli/`:

```sh
npm --prefix cli run build
node --test tests/*.test.mjs
npm --prefix cli test
npm --prefix cli run test:e2e
```

Run the TypeScript checker promptly after coupled changes:

```sh
./cli/node_modules/.bin/tsc -p cli/tsconfig.json --noEmit
```

Do not edit generated `cli/dist` by hand.
Do not add `agents/**` bookkeeping to product diffs or freshness inputs.
Commit coherent work units with product-focused messages and no agent attribution.

## Optional Hooks

The skill installer registers two advisory runtime hooks:

- `challenge_trigger.mjs` routes the `!rv` token to the bounded challenge workflow;
- `commit_reminder.mjs` reminds a long-running implementor when a coherent intermediate commit may be due.

Neither hook stages files, commits, blocks a turn, or changes verification state.

Standalone Git checkpoint hooks remain opt-in:

```sh
node scripts/hooks/install.mjs
node scripts/hooks/install.mjs --uninstall
```

## License

See [LICENSE](LICENSE).
