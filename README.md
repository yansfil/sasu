# sasu

<p align="center"><img src="assets/mascot.png" width="260" alt="sasu mascot"/></p>

**Your agent codes. Sasu reviews.**

sasu (사수) is the Korean word for the senior developer who sits next to you, asks what you actually meant, and looks over every line before it ships.
This harness gives your coding agent that senior.

The idea is simple but strict:

1. **Interview the tacit knowledge out of your head.** What you meant, not just what you typed.
2. **Pin it down in a PRD.** A human decision contract, not a vibe.
3. **Verify everything.** "Done" is a provable state backed by evidence and receipts, never a claim.

It is agent-agnostic by design - one source of skills and one CLI drive every runtime the same way.
Codex and Claude Code ship today; any agent that can read a skill and run a command can work under the same 사수.

What the harness believes, and the lens every change to it is held against: [PRINCIPLES.md](PRINCIPLES.md).

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

## The Sasu Skills

| Skill | What it owns |
| --- | --- |
| `interview-me` | Pre-PRD interview: decision-driven Q&A, targeted UX scenario coverage, risk escalation, and one normalized PRD-ready `qa-log.md` |
| `gen-prd` | The PRD as a complete-product contract: scope, non-goals, semantic review profile, decision traceability, verification, and explicit `human_approval` |
| `implement` | Approved-PRD implementation with task closure, registered evidence, one unified verify, and a state-derived receipt |
| `benchmark-implement` | Fixed-PRD harness benchmark: implement delegation, fresh session analysis, deterministic process reports, and baseline comparison |
| `ship` | GitHub PR delivery: staging allowlist, generated evidence sections, CI watch, head-pinned merge, and a recorded delivery result |
| `ho-setup` | Pipeline configuration: delivery mode, worktree sync, gitignore policy, and a `doctor` that diagnoses the whole setup |
| `please` | All-in-one runner: conversation to PR with no approval round-trips, recording the invocation itself as the approval deviation |
| `remember` | Learning that enforces: lessons land as docs-backed facts, machine-checked invariants (`agents/rules/**`), or regression tests, never as prose-only notes |

Run artifacts live under the visible `agents/` namespace in the target project (`agents/interview/**`, `agents/prd/**`, `agents/runs/**`, `agents/benchmarks/**`, `agents/config.json`), which is the only namespace the harness reads or writes.

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
| `scripts/` | Symlinked to this repository | Symlinked to this repository |
| `references/` | Symlinked to this repository | Copied with the same substitutions as `SKILL.md` |
| Hooks | No implement lifecycle hooks | No implement lifecycle hooks |

The mechanics that make one source possible:

- **One public CLI.**
  Implement lifecycle behavior is exposed only through `sasu implement ...`.
  The old JavaScript dispatcher is a tombstone that returns migration guidance.
- **Install-time substitution instead of forked docs.**
  The Claude copies of `SKILL.md` and `references/*.md` are generated, so a skill edit in this repository lands in both runtimes on the next install.
- **Idempotent hook retirement.**
  The installer removes legacy implement hooks without touching unrelated entries, and refuses to overwrite a foreign skill directory.

## The Sasu CLI

`cli/` builds the `sasu` binary: the single CLI that owns the pipeline's deterministic logic and its LLM judgment gates.
Skills stay thin orchestration prompts; the CLI owns state, gates, verification, and receipts.
The installer builds it and writes a shim onto the pnpm bin path, so the binary always matches the installed skills (same-repo versioning, no skew).

```text
sasu interview init       create the interview qa-log skeleton for a topic
sasu interview log        record one answered interview turn (raw capture, counters, cursor)
sasu interview decision   upsert a Decision Register row with enum validation
sasu interview checkpoint  flip needs_normalization and record a normalization checkpoint
sasu interview coherence  advisory mid-interview judge: resolved-decision contradiction + goal drift (never blocks)
sasu interview status     interview state resync: counts, open P0/P1 nodes, checkpoint due, drift
sasu gate gap-audit   interview closure judge: material-gap findings list (empty = PASS)
sasu gate spec        PRD judge: fidelity to the qa-log + testability + verification completeness
sasu gate verify      standalone PRD prelint + mechanical checks, then a diff-vs-AC judge
sasu implement start  initialize one approved-PRD implementation state
sasu implement task   close one implementation obligation without implying verification
sasu implement artifact  register already-created runtime evidence with hashes
sasu implement verify run mechanical proof, then parallel AC and fidelity judges
sasu implement finalize  create receipt and result from a fresh PASS without rerunning proof
sasu gate status      gate verdicts, attempts, freshness, judge usage for a topic
sasu gate override    user-only escape hatch; records a deviation with the user's reason
sasu doctor           judge backends, verify commands, contract version
```

The interview commands exist for interview latency: the agent owns question judgment while the CLI owns every mechanical qa-log mutation, so a full interview turn costs one short chained command instead of a hand-written multi-hunk markdown edit.
Every mutating interview command re-runs the structural qa-log prelint (closure-only rules excluded) and reports drift immediately instead of at the gate.
`interview coherence` adds an independent mid-interview check that the resolved decisions cohere and stay on the stated goal - it reads only the decisions (not the conversation), so it catches direction drift the interviewing agent is biased not to see, and stays advisory: it never touches gate state or the retry budget and its findings are next-question candidates.
It judges only coherence, never completeness (that is the gap-audit closure gate), and uses the project-configured `routine` judge profile.

Every command accepts `--json` for structured output: a top-level `contractVersion` (schema-change detection for programmatic consumers), the gate verdict/attempt state, and on gate/verify a `prelint` key kept separate from judge findings.
Exit codes are identical in both modes (0 pass, 1 block/fail, 2 usage error).

Before any judge call, gates run a deterministic document prelint at $0: the qa-log (required sections, Decision Register integrity, dangling `decision_ids`, frontmatter enums, open P0/P1 nodes) at the gap-audit entrance, and the PRD (required sections 1-12, frontmatter enums, dangling Covers references, uncovered ACs, 9.2/9.1 mode conformance) at the spec and verify entrances.
The qa-log prelint also rejects resolved P0/P1 assumptions, while the gap-audit judge checks that resolved policies do not claim broader user consent than their cited Raw Q&A answers support.
A finding that requires explicit human agreement remains blocking on re-runs, and a missing or outdated gate-input contract makes older PASS records stale until revalidated.
A prelint failure hard-blocks with rule IDs and line numbers but never calls the judge and never consumes a retry-budget attempt, so structural defects are fixed for free and judge findings stay purely semantic.
The rule set targets zero false positives; ID numbering gaps (R1, R2, R4) are deliberately not checked.

Judgment runs as one-shot headless calls (`claude -p` / `codex exec`) with schema validation, one retry, and fail-closed errors.
The gap-list gates fan out into lane-parallel narrow judges (gap-audit: 4 document-area lanes; spec: 2 review-axis lanes) whose findings the CLI merges mechanically - union, normalized dedupe, any blocking finding blocks - so the wall-clock cost is one narrow judge, not one exhaustive sweep; set `judge.fanout: false` to restore the single-judge path.
Routine judgment defaults to Codex `gpt-5.6-luna` at `xhigh`, with Claude Sonnet 5 at `xhigh` as the fallback.
High-risk review defaults to Codex `gpt-5.6-sol` at `xhigh`, with Claude Opus 5 at `xhigh` as the fallback.
Prompt-only Codex calls run in an empty ephemeral work root with user config and project rules disabled.
When a judge needs source evidence, the harness copies only the exact allowlisted files into a disposable working directory.
Codex's read-only sandbox blocks writes but does not provide an OS-hard boundary against every host read.
The prompt limits reads to the copied working set, and the CLI audits Codex's JSON command trace: only bounded `sed` or `rg` reads naming allowlisted paths are accepted, while any other command invalidates the verdict.
Accepted command traces are recorded with the judge call so later review can answer what the judge inspected.
Claude fallback sessions grant only `Read` and `Grep` for the same prompt-level allowlist.
Gates are hard blocks: an agent can fix findings and re-gate within a retry budget, but only the user can override, and every judgment and override lands in `agents/runs/<topic>/gates/` for the receipt.
A PASS is pinned to the content hash of its input documents; editing the qa-log or PRD afterwards turns the gate `STALE` in `gate status` until it is re-run, so a gate can never keep vouching for a document it has not seen.
The CLI never executes implementation work: coding stays in the host agent session.
`cli/src/implement` owns implement state, evidence registration, unified verification, and finalization.

Project-specific judge models and fallbacks are configured in `agents/config.json`.
Omitted fields inherit the defaults above.

```json
{
  "judge": {
    "profiles": {
      "routine": {
        "primary": { "backend": "codex", "model": "gpt-5.6-luna", "effort": "xhigh" },
        "fallback": { "backend": "claude", "model": "claude-sonnet-5", "effort": "xhigh" }
      },
      "high-risk": {
        "primary": { "backend": "codex", "model": "gpt-5.6-sol", "effort": "xhigh" },
        "fallback": { "backend": "claude", "model": "claude-opus-5", "effort": "xhigh" }
      }
    }
  }
}
```

The removed `judge.backend` and `judge.tierModels` keys fail explicitly so an obsolete project setting cannot be silently ignored.

## Completion Is Explicit And Provable

The CLI treats "done" as a provable state through one explicit path:

- **One closing flow.**
  Finish implementation, register final evidence, run `sasu implement verify`, then run `sasu implement finalize`.
  No lifecycle hook mutates or advances the run.
- **Evidence or it did not happen.**
  Required verification items need current-tree mechanical proof or a registered runtime artifact such as a screenshot, API response, DB probe, or log.
  Self-authored summaries never count as evidence, and artifact hashes plus git snapshots make stale reviews detectable.
- **Separate semantic lanes.**
  Mechanical proof runs first.
  AC and fidelity judges then run as independent concurrent calls, and only a high-risk profile adds a final risk judge.
  Any source or registered-artifact change makes the prior PASS stale.
- **Fail-closed delivery.**
  `ship` refuses stale receipts, stale bases, out-of-allowlist staging, leftover placeholders, and agent attribution.
  Its explicit merge command rechecks CI and mergeability and pins the reviewed PR head with `--match-head-commit` before recording the merge commit.
  Every override needs a `--reason` and lands in the ship log.
- **Learned invariants gate delivery.**
  Lessons registered through `rules add` carry trigger globs and an executable check; `ship` matches every changed file against the triggers and fails closed on a failing check.
  Evidence-free or unverifiable rules are rejected at registration, so the rulebook cannot decay into wishes.
## Verify

```sh
node --test tests/*.test.mjs
(cd cli && npm test)
(cd cli && npm run test:e2e)
(cd cli && npm run build)
sasu doctor
```

`doctor` reports the effective delivery config and environment readiness.
After changing installed skills, confirm visibility:

- Codex: `codex debug prompt-input`
- Claude Code: start a new session and check that `/interview-me`, `/gen-prd`, `/implement`, `/benchmark-implement`, `/ship`, `/ho-setup`, and `/please` appear in the skill list

## Repository Layout

```text
skills/
  interview-me/  SKILL.md
  gen-prd/   SKILL.md
  implement/  SKILL.md, removed-entrypoint tombstone, references/
  benchmark-implement/  SKILL.md, deterministic reporter, evaluator rubric
  ship/   SKILL.md, scripts/prd_ship.js
  ho-setup/  SKILL.md
  please/    SKILL.md
  remember/  SKILL.md
scripts/
  install-local-skills.mjs   dual-runtime installer + legacy hook retirement
tests/
  prd_parser_unit.test.mjs        direct unit tests for cli/lib/prd_parser.js
  rules_engine.test.mjs           rules add/check/relevant + seed-agents-md
  install_local_skills.test.mjs   dual-runtime installer + legacy hook retirement
  prd_ship.test.mjs               ship delivery gates
  sasu_gate_wiring.test.mjs / sasu_judge_timeout.test.mjs   sasu gate CLI wiring
  interview_me_docs.test.mjs / implement_skill_structure.test.mjs       skill-doc contracts
  golden/                         normalized golden files (regenerate: UPDATE_GOLDEN=1)
```

The public implement modules are layered as contract and prompts, state store, orchestration commands, then CLI dispatch.
Shared parser and gate utilities remain reusable internals and do not own implement completion state.

Run artifacts live in the target project, not here: PRDs under `agents/prd/**` (committed), run state and evidence under `agents/runs/**` (one `agents/runs/<slug>/` per run holding gate judgment artifacts under `gates/` beside implement state, gitignored via `agents/runs/`, enforced by `doctor`; runs recorded under the legacy `agents/implement/**` + `agents/gates/**` layout stay readable in place).
