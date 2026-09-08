# sasu

<p align="center"><img src="assets/mascot.png" width="260" alt="sasu mascot"/></p>

**Your agent codes. Sasu reviews.**

sasu (사수) is the Korean word for the senior developer who sits next to you, asks what you actually meant, and looks over every line before it ships.
This harness gives your coding agent that senior.

The idea is simple but strict:

1. **Interview the tacit knowledge out of your head.** What you meant, not just what you typed.
2. **Pin it down in a PRD.** A human decision contract, not a vibe.
3. **Review the complete result.** Required test execution, actual observations, independent contract review, and current receipts establish what is complete and what remains uncertain.

It is agent-agnostic by design - one source of skills and one CLI drive every runtime the same way.
Codex and Claude Code ship today; any agent that can read a skill and run a command can work under the same 사수.

What the harness believes, and the lens every change to it is held against: [PRINCIPLES.md](PRINCIPLES.md).

```text
conversation
  └─ interview-me    interview until the requirements stop being vague
      └─ gen-prd    write the PRD as a human decision contract
          └─ implement    implement the full contract, observe actual behavior, review, and finalize
              └─ ship    branch, PR body, push, CI watch, gated merge
                              └─ recorded delivery result

quick = small conversation-to-change work with one compact contract and routine judge path
please = the whole PRD chain in one invocation, stopping only for terminal or risky work
remember = lessons land as enforcement, not notes
```

## The Sasu Skills

| Skill | What it owns |
| --- | --- |
| `interview-me` | Pre-PRD interview: decision-driven Q&A, targeted UX scenario coverage, risk escalation, and one normalized PRD-ready `qa-log.md` |
| `gen-prd` | The PRD as a complete-product contract: scope, non-goals, semantic review profile, decision provenance, complete observable behaviors, and explicit `human_approval` |
| `implement` | Autonomous approved-PRD implementation, shared actual evidence, full-contract review, and a state-derived receipt |
| `benchmark-implement` | Fixed-PRD harness benchmark: isolated implementation, fresh session analysis, deterministic process reports, and baseline comparison |
| `ship` | GitHub PR delivery: staging allowlist, generated evidence sections, CI watch, head-pinned merge, and a recorded delivery result |
| `sasu-setup` | Pipeline configuration: delivery mode, worktree sync, gitignore policy, and a `doctor` that diagnoses the whole setup |
| `quick` | Fast path for small work: compact conversation contract, mechanical checks, routine Luna judgment, and a pinned receipt |
| `please` | All-in-one runner: conversation to PRD, implementation, verified receipt, and conditional PR delivery with no stage-approval round-trips |
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
| Hooks | `~/.codex/hooks.json` (`UserPromptSubmit`) | `~/.claude/settings.json` (`UserPromptSubmit`) |

During development, stage this checkout's runtime-transformed skill files in each validation project's local skill surface and put a project-local shim for this checkout's built CLI first on PATH.
Do not replace global CLI, user configuration, or installed skills for a candidate test.
Use `transformContractFile(runtime, relativePath, text, { skillsRoot: absoluteStagedSkillsPath })` when staging runtime-specific content; it binds sibling skill paths to the actual local skill root.
The coordinator verifies actual fresh-session loading for both runtimes before global rollout.

The mechanics that make one source possible:

- **One public CLI.**
  Implement lifecycle behavior is exposed only through `sasu implement ...`.
  The old JavaScript dispatcher is a tombstone that returns removed-entrypoint guidance.
- **Install-time substitution instead of forked docs.**
  The Claude copies of `SKILL.md` and `references/*.md` are generated, so a skill edit in this repository lands in both runtimes on the next install.
- **Idempotent hook retirement.**
  The installer removes legacy implement hooks without touching unrelated entries, and refuses to overwrite a foreign skill directory.

## Optional Git Hooks

Two standalone hooks in `scripts/hooks/` protect the working tree while an agent drives it.
They are optional and independent of the skills: install them once and every repository on the machine gets them.

| Hook | Event | What it does |
| --- | --- | --- |
| `git-checkpoint.sh` | `Stop` | Commits the working tree at the end of every turn, so no agent turn can silently lose work. A run of turns collapses into one commit: when `HEAD` is itself an unpushed checkpoint it is amended rather than stacked on, and the amended-away version stays in the reflog. The message names the top-level paths touched and the add/edit/delete counts (`checkpoint: herdr-core, macos (2 edited, 1 new)`) - the hook cannot know what the turn meant, so a meaningful subject only comes from the agent committing its own work. Secret-looking files (`.env`, `*.pem`, `*id_rsa*`, `*.key`, `credentials.json`, ...) and files over 10MB are unstaged first. Skips pushed checkpoints, detached HEAD, empty repositories, and in-progress rebase/merge/cherry-pick. Always exits 0. |
| `worktree-create.sh` | `WorktreeCreate` (Claude Code only) | Replaces default worktree creation: checkpoints a dirty tree first so uncommitted WIP follows the worktree, branches from `HEAD` (not the default branch), creates the worktree under `<repo>/.claude/worktrees/<name>`, and runs `<repo>/.claude/worktree-bootstrap.sh` if it exists (env symlinks, dependency install). A failing bootstrap rolls the worktree and branch back. |

Both write to `${SASU_HOOK_LOG:-~/.sasu/hooks.log}`.

Turn checkpointing off per repository with `touch .git/no-checkpoint`, or per invocation with `AGENT_CHECKPOINT=0`.
Undo the last `N` checkpoints with `git reset --soft HEAD~N`.

### Install

```sh
node scripts/hooks/install.mjs              # register in both runtimes
node scripts/hooks/install.mjs --uninstall  # remove
```

It is idempotent, preserves foreign hook entries, and is deliberately separate
from the skill installer: these hooks are an opt-in machine-wide policy, not
part of the skill contract, so `install-local-skills.mjs` never touches them.

| | Codex (`~/.codex/hooks.json`) | Claude Code (`~/.claude/settings.json`) |
| --- | --- | --- |
| `Stop` | `git-checkpoint.sh` | `git-checkpoint.sh` |
| `WorktreeCreate` | not supported by the runtime | `worktree-create.sh` |

Confirm with a throwaway repository:

```sh
cd "$(mktemp -d)" && git init -q . && echo a > a && git add -A && git commit -qm init
echo b > b && ~/projects/sasu/scripts/hooks/git-checkpoint.sh && git log --oneline
```

## The Sasu CLI

`cli/` builds the `sasu` binary: the single CLI that owns the pipeline's deterministic logic and its LLM judgment gates.
Skills stay thin orchestration prompts; the CLI owns state, gates, verification, and receipts.
The installer builds it and writes a shim onto the pnpm bin path, so the binary always matches the installed skills (same-repo versioning, no skew).

```text
sasu interview init       create the qa-log, bind its transcript, and optionally persist a question limit
sasu interview sync       batch-import completed assistant-text -> human-answer turns from JSONL
sasu interview decision   upsert a Decision Register row with enum validation
sasu interview checkpoint  atomically normalize the pending batch and record its checkpoint
sasu interview coherence  advisory mid-interview judge: resolved-decision contradiction + goal drift (never blocks)
sasu interview status     persisted state view: synced counts, open P0/P1 nodes, checkpoint due, drift
sasu gate gap-audit   interview closure judge: material-gap findings list (empty = PASS)
sasu gate spec        PRD judge: source fidelity, clear observable requirements, scope and decisions
sasu gate verify      --contract quick path: required checks and one comprehensive contract review
sasu implement intake inspect dirty judged paths and return the one Spec Owner disposition question
sasu implement start  initialize one approved-PRD state with explicit dirty-source attribution
sasu implement artifact  register shared actual observations with hashes and provenance
sasu implement verify execute required suites and parallel Fidelity and Code reviews on fixed inputs
sasu implement amend  human-authorized contract or required-suite amendment
sasu implement confirm record the person's response to an actual confirmation ID
sasu implement retire release an unfinished run's occupancy when no verify lease is live
sasu implement finalize  create receipt and result from a fresh PASS without rerunning proof
sasu gate status      gate verdicts, attempts, freshness, judge usage for a topic
sasu gate override    user-only escape hatch; records a deviation with the user's reason
sasu doctor           judge backends, verify commands, run/worktree integrity, installed skill freshness, contract version
```

The interview commands exist for interview latency: the agent owns question judgment while the CLI owns every mechanical qa-log mutation.
Ordinary Q&A performs no file write; `interview sync` imports completed turns in one batch at checkpoints, resume, and closure.
When `interview init --question-limit <n>` records an explicit user budget, the cursor derives reached and exceeded state without rejecting later captured evidence; the interviewer stops asking and reviews whether an extra exchange was a correction or closure response.
Every mutating interview command re-runs the structural qa-log prelint (closure-only rules excluded) and reports drift immediately instead of at the gate.
`interview coherence` is an on-demand independent check for a concrete contradiction or goal-drift suspicion - it reads only the decisions (not the conversation) and stays advisory: it never touches gate state or the retry budget.
It judges only coherence, never completeness (that is the gap-audit closure gate), and uses the project-configured `routine` judge profile.

Every command accepts `--json` for structured output: a top-level `contractVersion` (schema-change detection for programmatic consumers), the gate verdict/attempt state, and on gate/verify a `prelint` key kept separate from judge findings.
Exit codes are identical in both modes (0 pass, 1 block/fail, 2 usage error).

Before document review, deterministic prelint checks qa-log structure and decision provenance, or the PRD's six sections, frontmatter, three-column Behaviors, unique Bn references, and valid cited decisions.
Quick contracts retain Acceptance Criteria and run-level Checks, with optional Evidence and Human Review.
The qa-log prelint also rejects resolved P0/P1 assumptions, while the gap-audit judge checks that resolved policies do not claim broader user consent than their cited Raw Q&A answers support.
A finding that requires explicit human agreement remains blocking on re-runs, and a missing or outdated gate-input contract makes older PASS records stale until revalidated.
A prelint failure hard-blocks with rule IDs and line numbers but never calls the judge and never consumes a retry-budget attempt, so structural defects are fixed for free and judge findings stay purely semantic.
Reference numbering gaps are not missing requirements by themselves; duplicate or dangling references are structural errors.

Judgment runs as one-shot headless calls (`claude -p` / `codex exec`) with schema validation, one retry, and fail-closed errors.
The gap-list gates fan out into lane-parallel narrow judges (gap-audit: 4 document-area lanes; spec: 2 review-axis lanes) whose findings the CLI merges mechanically - union, normalized dedupe, any blocking finding blocks - so the wall-clock cost is one narrow judge, not one exhaustive sweep; set `judge.fanout: false` to restore the single-judge path.
Routine judgment defaults to Codex `gpt-5.6-luna` at `xhigh`, with Claude Sonnet 5 at `xhigh` as the fallback.
High-risk review defaults to Codex `gpt-5.6-sol` at `xhigh`, with Claude Opus 5 at `xhigh` fallback.
The workflow refactor preserves these code defaults; model changes need their own measurement.
Prompt-only Codex calls run in an empty ephemeral work root with user config and project rules disabled.
When a judge needs source evidence, the harness copies only the exact allowlisted files into a disposable working directory.
Codex's read-only sandbox blocks writes but does not provide an OS-hard boundary against every host read.
The prompt limits reads to the copied working set, and the CLI audits Codex's JSON command trace: only bounded `sed` or `rg` reads naming allowlisted paths are accepted, while any other command invalidates the verdict.
Accepted command traces are recorded with the judge call so later review can answer what the judge inspected.
Claude fallback sessions grant only `Read` and `Grep` for the same prompt-level allowlist.
Gates are hard blocks, and every judgment, reopen, and override lands in `agents/runs/<topic>/gates/` for the receipt.
Gap-audit and spec keep an open findings set: a rerun judges only the findings still open, by id, and may add one only in a lane whose Decision Register rows changed, so the set can only shrink; a BLOCK means an agent-fixable finding is open, NEEDS_HUMAN hands every remaining question to the user as one bundle that `sasu gate answer` seals on their words, and a PASS seals the cycle so warnings cannot start another loop.
Only an explicit user-evidenced `sasu gate reopen` starts another PRD review cycle; `--grant-budget` is reserved for retrying a repaired judge backend that failed without returning a verdict.
Implementation correction is bounded by the existing configured budget, while backend failures and pre-review input errors remain separately recorded.
Open blocking high-risk findings keep the run incomplete even when routine review passes.
Prior issues require explicit dispositions, and a concrete contract omission discovered in an unchanged file still counts.
A PASS is pinned to the content hash of its input documents; editing the qa-log or PRD afterwards turns the gate `STALE` in `gate status` and requires restoring the sealed input or an explicit reopen, so a gate can never silently re-judge changed requirements.
The CLI never executes implementation work: coding stays in the host agent session.
`cli/src/implement` owns implement state, evidence registration, verification, and finalization.

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

## One Contract, Shared Evidence, One Current Result

A PRD retains six sections: Goal, Non-goals, Decisions, Behaviors, Technical structure, and Risks.
The Behaviors table has three columns:

| # | 사용자가 관찰하는 행동 | 결정 |
| --- | --- | --- |
| B1 | Saving a note adds it to the list and reopening it preserves the content. | D-01 |
| B2 | Search filters notes and exposes an empty-result state with a way to clear the search. | D-02 |
| B3 | Storage failure reports the error and preserves the draft. | D-03 |

The implementor can observe save, reopen, search, and empty results in one actual flow, then inject a storage failure separately.
It registers useful shared observations and runs verify, which executes the sealed required suites and sends every requirement and decision to independent Fidelity and Code reviewers concurrently.
Both use the same fixed original inputs and routine model profile, without receiving the current peer verdict.
Fidelity checks complete intent and observable behavior fulfillment; Code checks concrete implementation, integration, error paths, and consequential design problems.
Both record their evidence grounds and concrete findings, such as an unwired save button or missing failure handling; cosmetic preferences remain advisory.
A high-risk run additionally checks distinct data-loss, permission, or destructive-action concerns using the same fixed inputs.
There is no per-requirement PASS array, mandatory separate evidence, progress lifecycle, or replacement Markdown checklist.

Fidelity records every Bn exactly once across grouped `assessments`, each with requirement references, a `satisfied`, `unresolved`, or `pending-human` conclusion, a short concrete rationale, and evidence references.
Code records its own substantive grounds without repeating an all-Bn accounting form.
One complete source file, test result, or observation can support many requirements; a satisfied assessment cannot cite only PRD text or source-catalog metadata.
Pending-human assessments require corresponding validated after-the-fact human confirmations and do not assert satisfaction or waive prerequisite authority.
The CLI refuses missing or duplicate Fidelity coverage, unknown references, empty grounds, invalid evidence, and unresolved coverage.
This establishes inspectable structural coverage alongside actual required-suite execution, evidence integrity, current-input identity, ownership, human authority, concurrency safety, and honest state-derived receipts.
The reviewers still decide whether the implementation and observations satisfy the full contract.
Valid coverage records do not prove the conclusions correct or guarantee that a model detects every omission; real planted-omission evaluations measure that quality separately from fixture and schema tests.

Each actual role result, timing, and provider trace remains separate in the existing `verificationAttempts[].reviews` history.
CLI mutations cannot rewrite or delete settled judgments; corrections append a new attempt with its own source, PRD, and input identity.
One shared finding history preserves prior issues until both roles resolve them with evidence, and distinct defects remain distinct even when they cite the same Bn.

A whole-verify execution lease pins inputs from required-suite execution through judge completion and CAS persistence.
While it is live, other domain mutations including amend, retire, risk, confirm, ownership changes, and escalation are refused.
Read-only status and event waiting continue.
Interrupted owners release the lease only after child process-group cleanup is established.

A first failed verify keeps the run active with its attempt and open findings.
Repair and explicitly verify again within the recorded correction bound.
At a terminal failure, `finalize --status blocked` can write an honest receipt even when no judge returned successfully, naming the failed phase and unrun stages.
Finalize itself runs no tests or judges and persists state before generating the receipt.

`complete` means current required suites, review, open-issue, and authority rules are satisfied.
`complete-pending-human` allows only previously permitted after-the-fact human judgment.
An explicit open rejection makes delivery ineligible; responses remain in history and only the person's own words can resolve them.
Source fixes after closure use a new run.

Ship consumes the current v6 receipt derived from v10 state, and refuses incomplete review accounting, stale results, open rejections, blocked runs, stale bases, out-of-allowlist staging, leftover placeholders, or prohibited attribution.
It preserves learned rules, CI checks, explicit merge approval, and the reviewed PR-head pin.
Required delivery rules do not create a second implementation completion engine.

## Contract Transition

CLI contract `0.10.0` reads `sasu.implement.state.v10`, `sasu.implement.receipt.v6`, and the current document shapes.
The last unified v9/v5 support commit is `3f549dcfff71fe1f7fa974a383f6e8a055ce8463`.
The last experimental parallel v9/v5 support commit is `2b1f638dd587261be7e7b0e600db16657421971d`.
Pre-refactor runs require `488d3cc`.
Finish or retire an older run with its supporting pinned version before transitioning both runtimes; retired shapes fail explicitly in the production reader.
Old results are historical artifacts, never normalized into new successful reviews.
There are no legacy namespace readers or migration shims.
The retired dispatcher tombstone and old hook markers remain only to explain unsupported entrypoints and safely retract prior installation traces.
Install CLI, skill sources, references, scripts, and schemas together; rollback them together if needed.

## Verify

```sh
npm --prefix cli run build
node --test tests/*.test.mjs
npm --prefix cli test
npm --prefix cli run test:e2e
sasu doctor
```

Before final checks, remove generated `cli/dist` only in the owned implementation worktree so retired JS cannot survive a build.
Use `tsc --noEmit` promptly for coupled source/caller changes, then build before tests because tests import dist.
Full regression success does not establish live backend or product/browser QA; report those separately.
`doctor` reports effective judge profiles, required commands, namespaces, run integrity, installed skill freshness, and CLI contract version.
After changing installed skills, confirm visibility:

- Codex: `codex debug prompt-input`
- Claude Code: start a new session and check that `/interview-me`, `/gen-prd`, `/implement`, `/benchmark-implement`, `/ship`, `/sasu-setup`, and `/please` appear in the skill list

## Repository Layout

```text
skills/
  interview-me/  SKILL.md
  gen-prd/   SKILL.md
  implement/  SKILL.md, removed-entrypoint tombstone, references/
  benchmark-implement/  SKILL.md, deterministic reporter, evaluator rubric
  ship/   SKILL.md, scripts/prd_ship.js
  sasu-setup/  SKILL.md
  please/    SKILL.md
  remember/  SKILL.md
scripts/
  install-local-skills.mjs   dual-runtime installer + legacy hook retirement
  challenge_trigger.mjs      UserPromptSubmit hook: !rv routing + round budget
  hooks/install.mjs          opt-in installer for the two git-safety hooks
  hooks/git-checkpoint.sh    optional Stop hook: turn-end checkpoint commit
  hooks/worktree-create.sh   optional WorktreeCreate hook: checkpoint + bootstrap
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

Run artifacts live in the target project, not here: PRDs under `agents/prd/**` (committed), run state and evidence under `agents/runs/**` (one `agents/runs/<slug>/` per run holding gate judgment artifacts under `gates/` beside implement state, gitignored via `agents/runs/`, enforced by `doctor`; historical legacy layouts remain ignored but are not read by the current engine).
