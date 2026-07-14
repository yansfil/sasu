# checkshirt

<p align="center"><img src="assets/mascot.svg" width="220" alt="checkshirt-boy mascot"/></p>

**One PRD pipeline, two runtimes, one checkshirt.**
A personal engineering workflow harness that turns a conversation into a shipped pull request, with the same skills, the same state machine, and the same completion guarantees whether the agent is Codex or Claude Code.

The concept: you are working with one very senior developer in a plaid shirt.
He scopes before he specs, he specs before he builds, he does not say "done" without evidence, and he never has to be told the same thing twice.

```text
conversation
  └─ ho-scope    interview until the requirements stop being vague
      └─ ho-spec    write the PRD as a human decision contract
          └─ ho-build    implement against a verification plan, with receipts
              └─ ho-ship    branch, PR body, push, CI watch, gated merge
                              └─ recorded delivery result

please = the whole chain in one invocation, stopping only for risky work
remember = lessons land as enforcement, not notes
```

## The Checkshirt Skills

| Skill | What it owns |
| --- | --- |
| `ho-scope` | Pre-PRD interview: axis-driven Q&A, risk escalation, misunderstanding checks, a closure matrix, and a PRD handoff artifact |
| `ho-spec` | The PRD as a contract: scope, non-goals, decision traceability, a verification contract, and an explicit `human_approval` gate |
| `ho-build` | Harness-driven implementation: TaskGraph, artifact-backed evidence, fidelity and adversarial reviews, and a strict completion receipt |
| `ho-ship` | GitHub PR delivery: staging allowlist, generated evidence sections, CI watch, head-pinned merge, and a recorded delivery result |
| `ho-setup` | Pipeline configuration: delivery mode, worktree sync, gitignore policy, and a `doctor` that diagnoses the whole setup |
| `please` | All-in-one runner: conversation to PR with no approval round-trips, recording the invocation itself as the approval deviation |
| `remember` | Learning that enforces: lessons land as docs-backed facts, machine-checked invariants (`agents/rules/**`), or regression tests, never as prose-only notes |

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
| Invocation | `$ho-scope`, `$ho-spec`, ... | `/ho-scope`, `/ho-spec`, ... |
| `SKILL.md` | Copied verbatim | Copied with path and invocation substitution (`~/.codex/skills/` becomes `~/.claude/skills/`, `$ho-build` becomes `/ho-build`) |
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

## Completion Is Enforced, Not Promised

The harness treats "done" as a provable state, and the enforcement works identically in both runtimes:

- **Stop-hook continuation loop.**
  While a PRD run is active, ending the turn re-injects the current state and the next required item.
  The loop only releases when the receipt exists or a concrete blocker is recorded.
- **Evidence or it did not happen.**
  Required verification items need registered artifacts of the right kind per mode (command logs, screenshots, API/DB probes).
  Self-authored summaries never count as evidence, and artifact hashes plus git snapshots make stale reviews detectable.
- **Two-stage review.**
  A strict requirements fidelity review compares implementation evidence against the user's original intent, then a profile-aware adversarial review audits that proof.
  Any source change after a passing review marks it stale.
- **Fail-closed delivery.**
  `ho-build` rejects PRDs that circularly require PR, CI, or merge evidence before the implementation receipt.
  `ho-ship` refuses stale receipts, stale bases, out-of-allowlist staging, leftover placeholders, and agent attribution.
  Its explicit merge command rechecks CI and mergeability and pins the reviewed PR head with `--match-head-commit` before recording the merge commit.
  Every override needs a `--reason` and lands in the ship log.
- **Learned invariants gate delivery.**
  Lessons registered through `rules add` carry trigger globs and an executable check; `ho-ship` matches every changed file against the triggers and fails closed on a failing check, `plan-execution` injects scope-matched invariants as verification items, and `doctor` rot-checks the ledger.
  Evidence-free or unverifiable rules are rejected at registration, so the rulebook cannot decay into wishes.
- **Premature-completion guards.**
  Codex gets a `PreToolUse` guard that blocks `update_goal complete` before the receipt; Claude Code has no goal tool, so the Stop hook carries the guarantee alone.

## Verify

```sh
node --test tests/*.test.mjs
node ~/.codex/skills/ho-build/scripts/prd_state_harness.js doctor
```

Optional state-schema typecheck (no npm dependency; uses the JSDoc typedefs in `scripts/lib/types.js`):

```sh
npx -p typescript tsc --noEmit --allowJs --target es2022 --module commonjs --skipLibCheck \
  skills/ho-build/scripts/lib/state_data.js skills/ho-build/scripts/lib/types.js
```

`doctor` reports the effective delivery config, environment readiness, and hook registration for both runtimes.
After changing installed skills, confirm visibility:

- Codex: `codex debug prompt-input`
- Claude Code: start a new session and check that `/ho-scope`, `/ho-spec`, `/ho-build`, `/ho-ship`, `/ho-setup`, and `/please` appear in the skill list

## Repository Layout

```text
skills/
  ho-scope/  SKILL.md
  ho-spec/   SKILL.md
  ho-build/  SKILL.md, scripts/prd_state_harness.js (CLI entry), scripts/lib/ (layered modules), references/
  ho-setup/  SKILL.md
  ho-ship/   SKILL.md, scripts/prd_ship.js
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
