# checkshirt

<p align="center"><img src="assets/mascot.svg" width="220" alt="checkshirt-boy mascot"/></p>

**One PRD pipeline, two runtimes, one checkshirt.**
A personal engineering workflow harness that turns a conversation into a shipped pull request, with the same skills, the same state machine, and the same completion guarantees whether the agent is Codex or Claude Code.

The concept: you are working with one very senior developer in a plaid shirt.
He scopes before he specs, he specs before he builds, he does not say "done" without evidence, and he never has to be told the same thing twice.

```text
conversation
  └─ interview-me    interview until the requirements stop being vague
      └─ gen-prd    write the PRD as a human decision contract
          └─ implement    implement against a verification plan, with receipts
              └─ ship    branch, PR body, push, CI watch, gated merge
                              └─ recorded delivery result

please = the whole chain in one invocation, stopping only for risky work
remember = lessons land as enforcement, not notes
```

## The Checkshirt Skills

| Skill | What it owns |
| --- | --- |
| `interview-me` | Pre-PRD interview: decision-driven Q&A, targeted UX scenario coverage, risk escalation, and one normalized PRD-ready `qa-log.md` |
| `gen-prd` | The PRD as a complete-product contract: scope, non-goals, semantic review profile, decision traceability, verification, and explicit `human_approval` |
| `implement` | Agent-planned, harness-checked implementation: TaskGraph, explicit parallel scopes, artifact-backed evidence, profile-aware reviews, and a strict receipt |
| `ship` | GitHub PR delivery: staging allowlist, generated evidence sections, CI watch, head-pinned merge, and a recorded delivery result |
| `ho-setup` | Pipeline configuration: delivery mode, worktree sync, gitignore policy, and a `doctor` that diagnoses the whole setup |
| `please` | All-in-one runner: conversation to PR with no approval round-trips, recording the invocation itself as the approval deviation |
| `remember` | Learning that enforces: lessons land as docs-backed facts, machine-checked invariants (`agents/rules/**`), or regression tests, never as prose-only notes |
| `ho-interview`, `ho-scope`, `ho-spec`, `ho-build`, `ho-ship` | Explicit compatibility aliases for existing prompts and automation |

Run artifacts live under the visible `agents/` namespace in the target project (`agents/intake/**`, `agents/prd/**`, `agents/implement/**`, `agents/config.json`); a legacy `.hoyeon/` tree from older runs stays readable as a fallback, and new runs always write under `agents/`.

## Dual Runtime, One Source

Every skill and script in this repository serves both runtimes.
There are no forked copies to keep in sync.

```sh
node scripts/install-local-skills.mjs
```

| | Codex | Claude Code |
| --- | --- | --- |
| Install root | `~/.codex/skills/<name>/` | `~/.claude/skills/<name>/` |
| Invocation | `$interview-me`, `$gen-prd`, ... | `/interview-me`, `/gen-prd`, ... |
| `SKILL.md` | Copied verbatim | Copied with path and invocation substitution (`~/.codex/skills/` becomes `~/.claude/skills/`, `$implement` becomes `/implement`) |
| `scripts/`, `references/` | Symlinked to this repository | Symlinked to this repository |
| Hooks | `Stop` + `SubagentStop` + `PreToolUse` in `~/.codex/hooks.json` | `Stop` in `~/.claude/settings.json` |

The mechanics that make one source possible:

- **Self-locating scripts.**
  `prd_state_harness.js` and `prd_ship.js` resolve their own install location and their sibling scripts from the invoked path, with a realpath fallback through the symlink.
  Every command the hooks re-inject therefore matches the runtime that is actually running.
- **Runtime-neutral session identity.**
  Session ids are canonicalized bare: `codex:`, `claude:`, and `opencode:` prefixes are stripped for storage and comparison, and legacy prefixed state files keep matching.
  Init binds from `CODEX_SESSION_ID`, `CODEX_THREAD_ID`, or `CLAUDE_SESSION_ID`, and otherwise the first hook payload claims the run.
- **Install-time substitution instead of forked docs.**
  The Claude copies of `SKILL.md` are generated, so a skill edit in this repository lands in both runtimes on the next install.
- **Idempotent hook registration.**
  The installer merges harness hooks into existing hook files without touching unrelated entries, and refuses to overwrite a foreign skill directory.

## The Checkshirt CLI

`cli/` builds the `checkshirt` binary: the single CLI that owns the pipeline's deterministic logic and its LLM judgment gates.
Skills stay thin orchestration prompts; the CLI owns state, gates, verification, and receipts.
The installer builds it and writes a shim onto the pnpm bin path, so the binary always matches the installed skills (same-repo versioning, no skew).

```text
checkshirt intake init      create the interview qa-log skeleton for a topic
checkshirt intake log       record one answered interview turn (raw capture, counters, cursor)
checkshirt intake decision  upsert a Decision Register row with enum validation
checkshirt intake checkpoint  flip needs_normalization and record a normalization checkpoint
checkshirt intake status    interview state resync: counts, open P0/P1 nodes, checkpoint due, drift
checkshirt gate gap-audit   interview closure judge: material-gap findings list (empty = PASS)
checkshirt gate spec        PRD judge: fidelity to the qa-log + testability + verification completeness
checkshirt verify           PRD prelint + mechanical checks ($0) first, then an independent diff-vs-AC judge
checkshirt gate status      gate verdicts, attempts, freshness, judge usage for a topic
checkshirt gate override    user-only escape hatch; records a deviation with the user's reason
checkshirt doctor           judge backends, verify commands, contract version
```

The intake commands exist for interview latency: the agent owns question judgment while the CLI owns every mechanical qa-log mutation, so a full interview turn costs one short chained command instead of a hand-written multi-hunk markdown edit.
Every mutating intake command re-runs the structural qa-log prelint (closure-only rules excluded) and reports drift immediately instead of at the gate.

Every command accepts `--json` for structured output: a top-level `contractVersion` (schema-change detection for programmatic consumers), the gate verdict/attempt state, and on gate/verify a `prelint` key kept separate from judge findings.
Exit codes are identical in both modes (0 pass, 1 block/fail, 2 usage error).

Before any judge call, gates run a deterministic document prelint at $0: the qa-log (required sections, Decision Register integrity, dangling `decision_ids`, frontmatter enums, open P0/P1 nodes) at the gap-audit entrance, and the PRD (required sections 1-12, frontmatter enums, dangling Covers references, uncovered ACs, 9.2/9.1 mode conformance) at the spec and verify entrances.
A prelint failure hard-blocks with rule IDs and line numbers but never calls the judge and never consumes a retry-budget attempt, so structural defects are fixed for free and judge findings stay purely semantic.
The rule set targets zero false positives; ID numbering gaps (R1, R2, R4) are deliberately not checked.

Judgment runs as one-shot headless calls (`claude -p` / `codex exec`) with tools disabled, schema validation, one retry, and fail-closed errors.
The gap-list gates fan out into lane-parallel narrow judges (gap-audit: 4 document-area lanes; spec: 3 review-axis lanes) whose findings the CLI merges mechanically - union, normalized dedupe, any blocking finding blocks - so the wall-clock cost is one narrow judge, not one exhaustive sweep; set `judge.fanout: false` to restore the single-judge path.
Codex judges run with best-effort isolation (empty ephemeral work root, user config ignored, no-tools instruction) because codex CLI cannot disable its shell; reviewer isolation is strongest on the claude backend, which runs with all tools removed.
Gates are hard blocks: an agent can fix findings and re-gate within a retry budget, but only the user can override, and every judgment and override lands in `agents/gates/<topic>/` for the receipt.
A PASS is pinned to the content hash of its input documents; editing the qa-log or PRD afterwards turns the gate `STALE` in `gate status` until it is re-run, so a gate can never keep vouching for a document it has not seen.
The CLI never executes implementation work: coding stays in the host agent session.
`cli/lib` also hosts the absorbed implement state library (`prd_state_harness.js` in the skill directory is a thin entrypoint into it).

## Completion Is Enforced, Not Promised

The harness treats "done" as a provable state, and the enforcement works identically in both runtimes:

- **Stop-hook continuation loop.**
  While a PRD run is active, ending the turn re-injects the current state and the next required item.
  The loop only releases when the receipt exists or a concrete blocker is recorded.
- **Evidence or it did not happen.**
  Required verification items need registered artifacts of the right kind per mode (command logs, screenshots, API/DB probes).
  Self-authored summaries never count as evidence, and artifact hashes plus git snapshots make stale reviews detectable.
- **Profile-aware review.**
  Every run gets a requirements fidelity review, while only high-risk and compatible legacy runs require a second adversarial review.
  The agent declares semantic risk from full context, and the harness validates the profile instead of classifying natural language with keyword rules.
  PRD, project policy, and CLI profiles act as safety floors, so a runtime flag cannot silently lower a stronger judgment.
  Any source change after a passing review marks it stale.
- **Fail-closed delivery.**
  `implement` rejects PRDs that circularly require PR, CI, or merge evidence before the implementation receipt.
  `ship` refuses stale receipts, stale bases, out-of-allowlist staging, leftover placeholders, and agent attribution.
  Its explicit merge command rechecks CI and mergeability and pins the reviewed PR head with `--match-head-commit` before recording the merge commit.
  Every override needs a `--reason` and lands in the ship log.
- **Learned invariants gate delivery.**
  Lessons registered through `rules add` carry trigger globs and an executable check; `ship` matches every changed file against the triggers and fails closed on a failing check, `plan-execution` injects scope-matched invariants as verification items, and `doctor` rot-checks the ledger.
  Evidence-free or unverifiable rules are rejected at registration, so the rulebook cannot decay into wishes.
- **Premature-completion guards.**
  Codex gets a `PreToolUse` guard that blocks `update_goal complete` before the receipt; Claude Code has no goal tool, so the Stop hook carries the guarantee alone.

## Verify

```sh
node --test tests/*.test.mjs
node ~/.codex/skills/implement/scripts/prd_state_harness.js doctor
```

Optional state-schema typecheck (no npm dependency; uses the JSDoc typedefs in `scripts/lib/types.js`):

```sh
npx -p typescript tsc --noEmit --allowJs --target es2022 --module commonjs --skipLibCheck \
  skills/implement/scripts/lib/state_data.js skills/implement/scripts/lib/types.js
```

`doctor` reports the effective delivery config, environment readiness, and hook registration for both runtimes.
After changing installed skills, confirm visibility:

- Codex: `codex debug prompt-input`
- Claude Code: start a new session and check that `/interview-me`, `/gen-prd`, `/implement`, `/ship`, `/ho-setup`, and `/please` appear in the skill list

## Repository Layout

```text
skills/
  interview-me/  SKILL.md, scripts/validate_intake.mjs
  gen-prd/   SKILL.md
  implement/  SKILL.md, scripts/prd_state_harness.js (CLI entry), scripts/lib/ (layered modules), references/
  ship/   SKILL.md, scripts/prd_ship.js
  ho-interview/, ho-scope/, ho-spec/, ho-build/, ho-ship/  compatibility aliases
  ho-setup/  SKILL.md
  please/    SKILL.md
  remember/  SKILL.md
scripts/
  install-local-skills.mjs   dual-runtime installer + hook registration
tests/
  prd_state_harness.test.mjs
  prd_state_regression.test.mjs   full standard-profile flow + golden artifact snapshots
  prd_parser_unit.test.mjs        direct unit tests for scripts/lib/prd_parser.js
  rules_engine.test.mjs           rules add/check/relevant + seed-agents-md
  install_local_skills.test.mjs
  golden/                         normalized golden files (regenerate: UPDATE_GOLDEN=1)
```

`prd_state_harness.js` is a thin dispatcher over `scripts/lib/`:
`util` → `git` → `config` → `rules` → `state_data` → `prd_parser` → `inference` → `planning` → `artifacts` → `reviews` → `render` → `state_store` → `hooks` → `commands/*`.
Modules only require layers to their left, so the dependency graph stays acyclic.

Run artifacts live in the target project, not here: PRDs under `agents/prd/**` (committed), implementation state and evidence under `agents/implement/**` (gitignored by the one-line policy `agents/implement/`, enforced by `doctor`).
Legacy `.hoyeon/**` trees stay readable as a fallback for runs that started before the namespace migration.
