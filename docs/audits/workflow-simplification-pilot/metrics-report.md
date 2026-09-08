# Workflow pilot metrics - interim snapshot

Initial snapshot time: 2026-09-08 16:07 KST.
Comparison snapshot time: 2026-09-08 17:59:29 KST.

This report uses assistant and tool event envelopes only.
It excludes Codex reasoning records and Claude thinking blocks.

## Provenance and ownership

- All three staged manifests point to clean candidate `c96a6621d655d984df4322fb12aa0236a6856f93`.
- The transformed `gen-prd` and `implement` entrypoint bytes match each manifest's expected SHA-256.
- At launch, the pinned `sasu` wrapper SHA-256 was `8799eb08c27b1fab9bd71c0b783625c2a68b77d556b9c3ce3505f0a68f935727` and it executed `/Users/hoyeonlee/projects/sasu.worktrees/workflow-simplification/cli/dist/cli.js`.
- At `16:52:14 KST`, the coordinator atomically changed the temporary wrapper from c96 to f696367, as recorded in `/tmp/sasu-workflow-coordinator/pilot-shim-cutover.json`.
  Both agents' corrected verification commands are also independently observable as the explicit absolute f696367 CLI path; Claude already used that path and Codex had no active lease at cutover.
- Both implementations observed `sasu --contract-version` as `0.9.0`.
- Codex native session `01a07fc4-fbd3-7102-ae9b-5982ced4a94b` owns its Sasu state exactly.
- Claude native session `bfd43801-cdd0-4d88-b3c8-c773c2d93a89` owns its Sasu state exactly.
- The original pilot launch and project-local skills remain pinned to clean candidate `c96a662`; later corrected CLI use is recorded separately and does not rewrite that provenance.
- The correction is commit `f6963672454207cbce08908cc33eaf6e74d866c7`, whose Git tree is `453c9e86609e9e1a4d9f05209b81e4325de50bcd` and whose parent is `c96a662`.
- Codex remains `active` after six valid FAIL attempts and has no receipt. Its current preserved source is commit `c3dd486948fc4a2655eacfcc212c43ec57c90683`, tree `7ba8fcf3c153155584da19fefd9db6db649b0f92`.
- Claude completed after three preserved c96 ERROR attempts, one corrected FAIL, and one corrected PASS. Its receipt-backed source is commit `6a258f845c58c1a7ba93ac7bb27a09eb16667cfc`, tree `b7d918f8e1ad01e253dfa38cb040dbb516d9b780`.

## Local skill loading

- PRD Codex native instructions registered `r9/gen-prd/SKILL.md`, where `r9` resolves to the fixture's project-local `.agents/skills`; its observable tool calls read the project-local skill.
- Implement Codex native instructions registered `r9/implement/SKILL.md` as well as the same-name global `r0` entry; its observable tool calls read `.agents/skills/implement/SKILL.md` and project-local references before `sasu implement start`.
- Claude native init listed `implement` in both `skills` and `slash_commands`, and observable tool calls read the fixture's `.claude/skills/implement` references.
- The Claude launch used `-p --dangerously-skip-permissions --setting-sources project,local --output-format stream-json --verbose --session-id bfd43801-cdd0-4d88-b3c8-c773c2d93a89`.
- The staging manifests preserve two intentional installed foreign Herdr skill dependencies for each runtime: `~/.agents/skills/herdr/SKILL.md` and `~/.claude/skills/herdr/SKILL.md`.
  They are allowlisted non-owned dependencies, not a staging defect; staged entrypoint/source parity remains exact.
- The same Claude UUID's native interactive transcript is now included from `~/.claude/projects/-private-tmp-sasu-workflow-pilots-claude/bfd43801-cdd0-4d88-b3c8-c773c2d93a89.jsonl`, starting only at the interactive resume boundary `16:29:55 KST` to avoid double-counting the earlier print streams.
- That transcript directly observes the corrected absolute CLI contract check, external QA artifact registration, and the corrected `implement verify` launch at `16:49:37 KST`.

## Timing at this snapshot

- PRD native task began at 15:39:54 KST and first completed at 15:49:35, an observed 9m41s.
  A correction turn completed at 15:54:04, making the full two-turn observed span 14m10s.
- Codex implementation prompt began at 15:55:24 KST.
  `sasu implement start` completed at 15:57:00.
  First observable implementation mutation began at 16:00:46 and a focused check was observed at 16:06:15.
- Claude process began at 15:55:24 KST.
  `sasu implement start` completed at 15:55:52.
  First observable implementation mutation began at 15:57:57, focused checks began at 16:00:53, and standalone browser QA began at 16:05:52.
- The Codex and Claude observable implementation spans overlapped for 3m19s through this snapshot.
  Claude focused checks also overlapped most of the then-observed Codex implementation span.
- These are event-span measurements, not sums of exclusive labor time.
  Editing, checks, and QA interleave, and tool execution duration alone understates time spent producing changes.

## Routing deviation

Claude did perform live browser QA against its local app on port 42832 and recorded screenshots and browser interactions.
It launched a standalone Chromux profile/session (`link-pocket-qa` / `lp`) instead of attaching the requested Herdr Browser surface.
This is real browser evidence with a routing deviation, not absence of browser evidence and not evidence of a Sasu CLI defect.
Print mode has no live prompt injection channel, so this run should remain uninterrupted.
The required independent Herdr Browser QA remains a later validation step.

No runtime or speedup comparison between these two implementation agents is valid from this unmatched pair.

## Before and after: structural diet

The earlier audit covers 16 substantive runs across both runtimes during seven days, with 292 Behavior/AC rows, 1,307 row-check attempts, and 65 unified verify attempts.
Those verify intervals total 351.3 run-minutes after taking the interval union within each run.
The 1,307 row checks consumed 106.2 resource-minutes, but this overlaps unified verify work and cannot be added to 351.3 minutes.

The `c96a662` candidate removes six public implement subcommands from the earlier 19-command surface: `check`, `park`, `resume`, `qa-brief`, `trail`, and `design`.
The remaining 13 are `intake`, `start`, `confirm`, `amend`, `dispatch`, `escalate`, `await`, `artifact`, `status`, `risk`, `verify`, `retire`, and `finalize`.
It deletes the production modules `check-activity.ts`, `checks.ts`, `qa.ts`, and `score.ts`.

The old v8 state stored, for every row, a check contract, status, attempt ledger, failure streak, park records, verdict, human closure, and rejection history.
It also stored `qaBriefs`, `trails`, and `designComments`; the Sticky Notes example has 10 QA briefs and 10 trails.
The v9 pilot state keeps 34 immutable requirement statements per run as `id`, `behavior`, and `decisionIds` only.
Execution results live once under the sealed suite and verification attempt; the review is whole-contract and returns exceptions, with risk retained as a separate responsibility.
Neither pilot has a row-check attempt or per-row completion ledger because those state responsibilities and commands no longer exist.

Relative to proposal base `488d3cc`, candidate `c96a662` changes CLI production under `cli/src` and `cli/lib` by +2,197/-7,615 lines, net -5,418.
Across production source plus skills and scripts the net is -6,536; tests net -8,523; Markdown net -719.
Those three groups together net -15,373 lines.
The entire tracked diff is +6,155/-21,112, net -14,957 across 135 files, but that wider number includes examples and the Excalidraw source and is not a production-code measure.

The pilots originally executed and staged clean committed candidate `c96a6621d655d984df4322fb12aa0236a6856f93`.
The earlier `effb77d1e711ee960ee94f860ea3645f785c16e6` value was an intermediate Git tree, not a commit; it remains historical and was never a pilot pin.
The final correction is the distinct commit `f6963672454207cbce08908cc33eaf6e74d866c7` with Git tree `453c9e86609e9e1a4d9f05209b81e4325de50bcd`.
Relative to `c96a662`, it adds +64/-37 CLI production lines, net +27, and +284/-19 test lines, net +265; the complete correction is +348/-56, net +292.
Relative to proposal base `488d3cc`, final correction changes CLI production by +2,222/-7,613, net -5,391.
Production plus skills/scripts is net -6,509, tests net -8,258, and Markdown net -719, together net -15,486; the complete tracked diff is +6,442/-21,107, net -14,665.

The correction's independent full smoke passed clean build and no-emit checks, 98 root tests, 447 unit tests, and 120 end-to-end tests with zero failures.
Its Codex backend cases produced seven accepted reviews from eight actual invocations; the extra invocation was correctly refused for a non-read `printf` command and retried, with no schema errors.
Its Claude backend cases produced six accepted reviews from six invocations with no retries or schema errors.
Both backends returned no findings for the complete case, exact defects for omission, unwired, and storage-failure variants, and no invented blocking gate; Claude emitted one advisory for the authorized-assumptions case.
All recorded backend cases used their named primary model and the smoke recorded no fallback use.

## Current pilot verification cost

Every completed pilot attempt's required mechanical suite passed with exit code 0.
The recorded FAIL verdicts came from whole-contract review findings, while ERROR denotes interrupted ownership or invalid judge output; suite pass counts must not be presented as complete run passes.

At the extraction snapshot at 17:59:29 KST, Codex had six completed Sasu verify attempts, all valid FAIL verdicts.
The first four used the original c96 CLI; the fifth and sixth used the corrected f696367 CLI.
The first attempt spent 5.916 seconds in the single required suite and 253.100 seconds in one Codex Luna whole-contract review.
It returned three concrete findings: focus/live-region behavior, long-tag overflow at 360px, and missing runner-lifecycle evidence in the review allowlist.
The next attempt reran the suite in 6.362 seconds and spent 292.090 seconds in one whole-contract review, for 299.428 seconds total.
It resolved the long-tag and runner-evidence findings while retaining the failed-focus-path defect and finding an empty-state count omission.
The third attempt spent 5.592 seconds in the suite and 152.080 seconds in review.
It resolved the focus and empty-count findings and found two further product issues: a loading state that normally had no paint opportunity and a newly inserted live region whose initial text was not reliably announced.
The fourth attempt spent 7.115 seconds in the suite and 293.720 seconds in review.
It resolved those two issues and found two new product defects: load retry did not announce loading or successful completion, and undo persistence failure had no visible error for sighted users.
Across these four attempts, harness wall intervals total 1,019.313 seconds, including 24.985 seconds of required-suite execution and 990.990 seconds of whole-contract review.
These were convergent product corrections, although the fourth verdict shows that the current Codex product is not complete.
After addressing the fourth attempt's two open findings, Codex started a fifth verify at 16:54:02 through the corrected absolute f696367 CLI.
It passed the suite in 8.595 seconds and returned FAIL after 254.166 seconds of review, finding that initial load was still not announced and Retry replaced the focused control without restoring focus.
Those findings were repaired before the correction budget was extended.
The sixth and explicitly authorized final verify began at 17:32:30, passed the suite in 9.215 seconds, and returned FAIL after 500.264 seconds of review.
It resolved the prior two findings and found one remaining focus defect spanning successful Delete, Undo, and confirmed Reset paths.
Across all six Codex attempts, harness wall intervals total 1,793.242 seconds, required-suite execution totals 42.795 seconds, and completed whole-contract review totals 1,745.420 seconds.
Commit `c3dd486` was created after the sixth review to preserve the same `src/main.ts` bytes that review inspected; it did not repair F11.
The bounded follow-up diagnosis narrowed some of the review's successful-transition wording as overbroad, but confirmed a maintainable Reset failure-path focus defect.
F11 therefore remains open, and there is no subsequent verification or receipt.

Claude had three Sasu verify attempts on unchanged `c96a662` inputs.
The first ran the suite successfully in 23.761 seconds, then the original print process exited while review was in the background; the recovered state records `verification-interrupted` after 414.566 seconds.
The second ran the suite again in 54.371 seconds and spent 327.693 seconds across two Codex Luna calls.
Both judge calls returned the same invalid contract output: `human-confirmation source D-01 does not contain its exact approval/confirmation quote`.
The attempt ended ERROR after 383.420 seconds.
The third ran the suite a third time in 53.646 seconds and entered review.
The coordinator sent SIGINT to its owned native PID at 16:29:12 KST to stop repeating the confirmed unchanged-input contract error.
The native stream mechanically labels the stopped tool as user-rejected, but this was coordinator interruption, not a user cancellation.
Its state was later recovered as `verification-interrupted`; the 1,541.644-second attempt interval includes the deliberate hold and correction wait, so it is orchestration walltime rather than judge compute time.
The fourth Claude attempt began at 16:49:37 using the corrected absolute f696367 CLI, passed the suite in 23.547 seconds, and completed valid FAIL at 16:54:42 after 280.602 seconds of review.
That review consumed 108,524 input and 14,683 output tokens and returned two concrete product defects: duplicate stored `item.order` values were accepted, and successful delete explicitly moved focus to undo feedback contrary to the PRD.
Claude repaired those defects, ran three focused-check tool calls for 43.042 seconds of observed command time, and started a fifth corrected verify at 16:56:54.
The fifth attempt passed the suite in 23.017 seconds and the whole-contract review in 83.109 seconds, resolving both prior findings with a PASS.
Finalize completed at 16:58:45 and emitted a v5 receipt; local delivery produced commit `6a258f8` on the same completed source.
Across all five Claude attempt intervals, walltime totals 2,751.940 seconds, including two interruption/recovery spans that are not active judge compute.
Required-suite execution totals 178.342 seconds.
The three attempts with recorded completed judge durations total 691.404 seconds; aborted judge work in the two interrupted attempts is not available as completed compute and must not be inferred from their larger wall intervals.

Across implementation and repair, observable focused checks consumed 67.373 seconds over 15 Codex tool calls and 89.629 seconds over eight Claude tool calls.
These are command runtimes during iterative authoring and repair, not completion gates and not totals for implementation thought or editing time.
The harness ran the same one-command suite once per verify attempt: six times for Codex and five times for Claude.
This split is the relevant distinction between agent-owned focused testing and harness-owned final verification.

## Error and recovery ledger

- Codex encountered three patch-application errors at 16:00:46, 16:06:15, and 16:08:29 KST, a TypeScript nullability failure at 16:09:15, a generated-script syntax error at 16:11:05, browser-test failures at 16:12:43 and 16:13:25, and four stale browser-element reference failures from 16:17:01 through 16:18:46.
  These are source/tool recovery inside implementation, before its first Sasu verify at 16:23:00.
- Claude's first full focused check ended with one searchbox-role failure at 16:05:25; its focused actions rerun finished at 16:05:47 after the fix.
  A browser JSON-wrapper read failed at 16:07:17 and was replaced with a raw CDP read by 16:07:29.
  Its first artifact manifest was rejected for escaping the project root at 16:10:00 and the in-project manifest was accepted at 16:10:05.
- Claude's original native process ran 15m20s and exited 0 at 16:10:44 while promising background completion.
  The same UUID resumed at 16:16:33, a 5m49s orchestration gap, and the interrupted attempt was sealed at 16:17:06.
  The next verify began 0.163 seconds later.
  After the invalid human-source contract ERROR at 16:23:30, the third verify began 11.820 seconds later.
  The resumed print process ran 12m40s before the coordinator interruption.
- The same Claude UUID was subsequently resumed interactively in owned pane `w72:p5` with project/local settings and held read-only until the corrected CLI became available.
  Its fixture-specific trust acceptance is an orchestration side effect tracked for cleanup, not implementation time.
- At 16:48 it checked the f696367 absolute CLI and source identity, copied byte-matched independent QA evidence into the run, registered it and `playwright.config.ts`, and started corrected verification at 16:49:37.
- The independent QA source aggregate applied to the pre-repair tree only. After Claude changed source to address the corrected review's findings, those captures became historical evidence and must not be represented as proving the new source without a fresh identity check and rerun.

## Human authorization wait

Codex's fifth verify ended at 16:58:25 and its repair turn settled at 17:03:17.
The user's additional-verify authorization arrived at 17:32:13, and the sixth verify began 17.425 seconds later.
The interval between the fifth and sixth verify starts was 34m04.592s; the explicit authorization wait from the settled repair turn was 28m55.596s.
That authorization interval is wall-clock wait, not implementation, suite, or judge compute.
A short unrelated fixture-fix turn occurred inside it and remains excluded from product compute claims.

## What is and is not comparable

The structural differences and line counts are directly comparable because they are source and schema facts.
The pilot also directly proves zero row-check commands, one sealed suite command per run, whole-contract review calls, and the actual elapsed attempts and errors above.

The seven-day audit is a mixed sample dominated by Herdr IDE work plus one native Sticky Notes app; this pilot is one web product implemented concurrently from the same 34-requirement PRD by two runtimes.
The old audit does not isolate implementation time, and its interval totals include different models, project sizes, failures, pauses, and revisions.
The Codex run remains active without a receipt, while the Claude run is complete with a current receipt and local commit.
Together they exposed a human-source admission defect in c96, real product defects through repeated whole-contract review, and orchestration recovery cost.
There is no matched old-version Link Pocket run, so no speedup percentage, verification ratio, or model ranking can be inferred.
The f696367 correction passed its independent contract smoke and enabled Claude's completed product receipt.
Codex preserves a later repaired commit but cannot supply a completion result without another authorized verification round.
