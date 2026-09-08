#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import { loadConfig } from "./config";
import { runDoctor } from "./doctor";
import {
  readGateStatus,
  runAnswer,
  runDelegate,
  runDelegateClear,
  runGapAudit,
  runOverride,
  runReopen,
  runSpecGate,
  runVerifyGate,
  type GateCommandResult,
} from "./gates/commands";
import type { GateId, GateStatusView } from "./gates/store";
import {
  readInterviewStatus,
  runInterviewCheckpoint,
  runInterviewDecision,
  runInterviewInit,
  runInterviewSync,
  type InterviewResult,
} from "./interview/commands";
import { runInterviewCoherence, type CoherenceResult } from "./interview/coherence";
import { contractVersion } from "./version";
import { runImplementCommand, type ImplementArgs } from "./implement/commands";
import { runPrdCommand } from "./prd/commands";
import { runPrinciplesCommand } from "./principles/commands";
import { runRulesCommand, runSetupCommand } from "./support/commands";
import { ensureSetup } from "./support/ensure-setup";
import { currentHerdrRole, HERDR_ROLE_ENV_KEY } from "./runs/session";

const USAGE = `sasu - harness CLI: judge gates, verification, doctor

Usage:
  sasu --contract-version
  sasu gate gap-audit --slug <topic> --qa-log <path> [--grant-budget "<verbatim user approval>"] [--assume-human-findings "<verbatim delegated invocation>"] [--json]
  sasu gate spec      --slug <topic> --prd <path> --qa-log <path> [--grant-budget "<verbatim user approval>"] [--assume-human-findings "<verbatim delegated invocation>"] [--json]
  sasu gate status    --slug <topic> [--json]
  sasu gate delegate  --slug <topic> --evidence "<verbatim delegating user message>" [--json]
  sasu gate reopen    --slug <topic> --gate <gap-audit|spec> --evidence "<verbatim user change request>" [--json]
  sasu gate answer    --slug <topic> --gate <gap-audit|spec> --evidence "<verbatim user answer to the NEEDS_HUMAN bundle>" [--json]
  sasu gate override  --slug <topic> --gate <gap-audit|spec|verify> --reason "<why>" [--json]
  sasu gate verify    --slug <topic> --contract <path> [--base <git-ref>] [--json]
  sasu implement intake   [--json]
  sasu implement start    --prd <path> [--allow-unapproved-prd "<verbatim approval>"] [--dirty-attribution <pre-existing|run-owned|JSON-path-map>] [--json]
  sasu implement confirm  --issuer human --id <confirmation-id> --evidence "<the user's own words>" [--reject] [--json]
    (records a human response and refreshes a closed run's receipt; explicit rejection blocks delivery.)
  sasu implement amend    --issuer human --reason "<why>" --approval "<verbatim human approval>" [--exclude-suite "<S1,...>"] [--json]
    (archives and re-seals the edited PRD, refreshes metadata, and invalidates full-review freshness.)
  sasu implement dispatch --name <unique-agent-name> --prd <path> [--kind <agent>] [--model <model>] [--effort <level>] [--json]
    (starts exactly one marked implementor beside this pane with the handoff packet on stdin; recursive dispatch is refused.)
  sasu implement escalate --reason "<what the implementor is stuck on>" [--target <finding-or-issue-ref>] [--agent <herdr-agent>] [--json]
    (bounded read-only diagnosis and context recovery; unavailable while a verify execution lease is live.)
  sasu implement await    [--since <event-id>] [--pid <implementor-pid> | --agent <herdr-agent>] [--notify-after <epoch-ms>] [--json]
  sasu implement artifact (--kind <screenshot|image|browser|api|db|log|file> --path <path> --description "<observation>" | --manifest <json-file>) [--source "<collector and method>"] [--collected-at <ISO-time>] [--target "<observed target>"] [--environment "<environment>"] [--refs "<B1,B2,...>"] [--json]
  sasu implement status   [--slug <topic> | --state <path>] [--json]
  sasu implement risk     --accept --id <RF#> --evidence "<verbatim user approval>" [--slug <topic> | --state <path>] [--json]
  sasu implement risk     --non-convergent --issuer human --id <RF#> --approval "<verbatim user approval>" --reason "<why no round can fix it>" [--json]
  sasu implement verify   [--slug <topic> | --state <path>] [--grant-budget "<verbatim user approval>"] [--json]
  sasu implement retire   [--slug <topic> | --state <path>] [--adopt "<verbatim user approval>"] [--json]
  sasu implement finalize [--slug <topic> | --state <path>] [--status <complete|blocked>] [--json]
    (state-changing commands accept --issuer <implementor|observer|human>, default implementor; issuer is an audited declaration, not authentication.
     Mutating another session's run requires --adopt "<verbatim user approval>"; all domain mutations are refused during a live verify lease.)
  sasu prd readiness       --prd <path> [--json]
  sasu prd ready           --prd <path> [--json]   (flips status to ready; refused while readiness has blocking gaps)
  sasu prd approve         --prd <path> --evidence "<verbatim user approval>" [--json]   (records human approval; requires status ready)
  sasu principles list     [--domain <name>] [--json]
  sasu rules <add|check|relevant> [...]
  sasu setup seed-agents-md [--project-root <path>] [--adopt-claude-md]
  sasu interview init       --slug <topic> --topic "<title>" --where <greenfield|brownfield|docs-only|unknown> --packs "<csv>" [--understanding "<lines>"] [--question-limit <n>] [--transcript <session.jsonl>] [--json]
  sasu interview sync       --slug <topic> [--transcript <session.jsonl>] [--json]
  sasu interview decision   --slug <topic> --id D-01 [--kind <fact|decision|assumption>] [--area "<area>"] [--text "<decision>"] [--priority <P0|P1|P2>] [--source "<owner>"] [--status <open|resolved|deferred|blocking|rejected>] [--mapping "<prd mapping>"] [--anchor <Q#|none>] [--transcript <session.jsonl>] [--json]
  sasu interview checkpoint --slug <topic> --normalized <pending|"Q1,Q2"> [--register-changes "<text>"] [--reopened "<text>"] [--gap "<text>"] [--json]
  sasu interview coherence  --slug <topic> [--min-decisions <n>] [--json]
  sasu interview status     --slug <topic> [--json]
  sasu doctor [--json]

Interview commands own the qa-log's mechanical bookkeeping (transcript source
bindings, counters, Raw Q&A imports, Decision Register upserts, and
needs_normalization flips). Ordinary turns stay in the live conversation;
interview sync batches completed assistant-text -> human-answer pairs from
the current Claude or Codex JSONL. Semantic normalization stays with the agent.

interview decision reports [drift] interview-decision-cadence once more than
three separate conversation turns have each triggered a decision write since
the last checkpoint - the per-turn write pattern the latency contract forbids.
A whole batch of upserts made at one checkpoint counts as the single turn it
happens on, so a legitimate batch never trips it.

interview decision anchors every resolved, user-sourced decision (Kind
decision, Status resolved, Source containing user/사용자) to a Raw Q&A turn's
decision_ids automatically: the default target is the most recently synced Q
turn, --anchor Q<n> names a different turn, and --anchor none records the
Decision Register row without anchoring it. A non-existent --anchor target is
rejected before anything is written. Decisions that are not user-sourced never
get an anchor, with or without --anchor.

interview coherence is an advisory mid-interview judge: an independent check that
the RESOLVED decisions cohere and stay on the stated goal (contradiction and
drift only, never incompleteness). It never touches gate state or the retry
budget; its findings are next-question candidates. gap-audit remains the
closure gate.

--json prints a structured result on every command: a top-level contractVersion,
and (on gate/verify) a 'prelint' key separate from judge findings. Exit codes are
identical in both modes (0 pass, 1 block/fail, 2 usage error).

Gates run a deterministic document prelint before the judge: a structural defect
blocks at $0 with [prelint] findings - no judge call, no retry-budget attempt.

Gap-audit and spec keep an open findings set, not a round budget. A rerun
judges only the findings still open (plus new ones in a lane whose Decision
Register rows changed), so the set can only shrink: BLOCK means an
agent-fixable finding is open (fix it, re-run), NEEDS_HUMAN means every open
finding needs a human decision (hand the bundle to the user, record their
words with 'gate answer', which seals PASS without another judge call), and
PASS seals the cycle. A sealed input change stops at $0 until the user
explicitly opens a new cycle with 'gate reopen'. --grant-budget only retries a
judge backend that failed three times in a row with the same structured cause
and no verdict. Verify keeps its separately configured fix retry budget.

Gates are hard blocks: agents must never run 'gate override' on a user's behalf.
--assume-human-findings exists for delegated runs only (the user invoked $please
or equivalently handed the whole pipeline over): it converts non-P0 human-consent
findings into a recorded, veto-able assumption ledger instead of a block, quoting
the user's delegating message verbatim. P0 findings still block. Passing it
without such a delegating user message is inventing consent.
'gate delegate' records that same delegation ONCE as immutable run state:
every later gap-audit/spec run on the slug then applies it automatically, so a
delegated run cannot lose or replace the user's invocation. A repeated
per-call --assume-human-findings value must exactly match the stored record.
Judgment runs as one-shot calls - a CLI session (claude -p / codex exec) or a
Messages-API request (backend 'api', judge.profiles.*.baseUrl to point it at a
compatible origin instead of api.anthropic.com); this CLI never executes
implementation work. Each gate's lanes spend a budget measured for
that gate, not the profile's: gap-audit and spec at high, verify at medium
(gap-audit and spec are open searches where budget buys coverage; verify is a
bounded full-contract comparison where it does not). 'judge.laneEffort'
pins one budget across all three - measure with cli/scripts/effort_sweep.mjs
before setting it, never guess.`;

interface Args {
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token.startsWith("--")) {
      const name = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(name, next);
        i += 1;
      } else {
        flags.set(name, true);
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

function requireFlag(args: Args, name: string): string {
  const value = args.flags.get(name);
  if (typeof value !== "string" || value.trim() === "") {
    fail(`missing required --${name} <value>`);
  }
  return value;
}

function fail(message: string): never {
  process.stderr.write(`sasu: ${message}\n`);
  process.exit(2);
}

function findProjectRoot(): string {
  let dir = process.cwd();
  while (true) {
    if (fs.existsSync(path.join(dir, "agents")) || fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

function printStatusView(view: GateStatusView): void {
  const head = `[gate:${view.gate}] ${view.effective}${view.overridden ? " (overridden by user)" : ""}`;
  // A judge-error loop prints the honest 0/N, so the numbers alone read as "two
  // attempts left" while every one of them is a broken backend call. The flag has
  // to say so here, or `sasu gate status` is the one surface that hides the
  // terminal cause the receipt and the Stop hook both report.
  const terminal = view.effective === "NEEDS_HUMAN"
    ? ` - NEEDS HUMAN: every open finding needs a human decision; ask the user the ${view.findings.length} question(s) below as one bundle, then record their words with: sasu gate answer --slug ${view.topic} --gate ${view.gate} --evidence "<the user's words>"`
    : view.reopenRequired
      ? ` - REOPEN REQUIRED: this sealed review's input changed; restore it or record the user's change request with gate reopen`
    : view.budgetExhausted
    ? " - RETRY BUDGET EXHAUSTED: the autonomous fix loop stops here; report the findings to the user (only their verbatim approval, recorded via --grant-budget, reopens the budget)"
    : view.judgeErrorLoop
      ? ` - JUDGE ERROR LOOP: ${view.consecutiveErrors}/${view.judgeErrorThreshold} consecutive judge failures with cause ${view.judgeErrorCause ?? "unknown"} and no verdict, so nothing was judged and the fix budget is unspent; repair the judge, then a user-granted --grant-budget re-run may continue, or close the run out blocked`
      : view.cycleExhausted
        ? ` - CYCLE CAP REACHED: ${view.roundsSinceGrant}/${view.cycleCap} judged non-PASS rounds since the last grant; the fix loop is not converging - report the findings to the user (their verbatim approval via --grant-budget reopens it)`
        : "";
  const grants = view.grants > 0 ? ` | grants ${view.grants}` : "";
  // Assumed human findings must stay loud on every status read: a PASS earned
  // by delegation is honest only while the substitution is visible (item 10).
  const assumed = view.assumedHumanFindings > 0
    ? ` | ASSUMED HUMAN DECISIONS: ${view.assumedHumanFindings} finding(s) converted to recorded assumptions under the delegated invocation - the user may veto (see the gate record's humanAssumptions)`
    : "";
  const review = view.reviewCycle === null
    ? `attempts ${view.attempts}/${view.budget}`
    : `review cycle ${view.reviewCycle} | open findings ${view.findings.length}${view.sealed ? " | sealed" : ""}`;
  const active = view.inFlight ? " | IN FLIGHT" : "";
  const meta = `${review}${grants}${assumed}${active}${terminal}`;
  process.stdout.write(`${head} | ${meta}\n`);
  for (const input of view.staleInputs) {
    process.stdout.write(`  stale: ${input.path} ${input.reason} after this gate passed - restore it or explicitly reopen the review cycle\n`);
  }
  for (const finding of view.findings) {
    const human = finding.requiresHuman ? " [needs human decision]" : "";
    const id = finding.id !== undefined ? `${finding.id} ` : "";
    process.stdout.write(`  - ${id}${finding.severity} ${finding.area}: ${finding.missing}${human}\n`);
    if (finding.recommendation) process.stdout.write(`    fix: ${finding.recommendation}\n`);
  }
  for (const finding of view.warnings) {
    const id = finding.id !== undefined ? `${finding.id} ` : "";
    process.stdout.write(`  warning: ${id}${finding.severity} ${finding.area}: ${finding.missing}\n`);
  }
}

function printPrelint(prelint: NonNullable<GateCommandResult["prelint"]>): void {
  // Non-blocking advisories print on both the ok and FAIL paths: they never
  // gate, but the author still has to see them.
  for (const advisory of prelint.warnings ?? []) {
    const where = advisory.line !== null ? ` line ${advisory.line}` : "";
    process.stdout.write(`[prelint] warning ${advisory.rule}${where}: ${advisory.missing}\n`);
    process.stdout.write(`  fix: ${advisory.recommendation}\n`);
  }
  if (prelint.ok) {
    process.stdout.write(`[prelint] ok\n`);
    return;
  }
  process.stdout.write(
    `[prelint] FAIL (${prelint.doc}) - deterministic lint blocked the gate before the judge (no tokens spent, no attempt consumed; fix and re-run freely)\n`,
  );
  for (const finding of prelint.findings) {
    const where = finding.line !== null ? ` line ${finding.line}` : "";
    process.stdout.write(`[prelint] ${finding.rule}${where}: ${finding.missing}\n`);
    process.stdout.write(`  fix: ${finding.recommendation}\n`);
  }
}

function emitGateResult(result: GateCommandResult, asJson: boolean): never {
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ contractVersion: contractVersion(), ...result }, null, 2)}\n`);
  } else {
    if (result.prelint) printPrelint(result.prelint);
    if (result.mechanical) {
      for (const run of result.mechanical.runs) {
        process.stdout.write(`[mechanical:${run.kind}] ${run.ok ? "ok" : `FAIL (exit ${run.exitCode})`} ${run.command}\n`);
        if (!run.ok) process.stdout.write(`${run.tail}\n`);
      }
      if (result.mechanical.configSuggestion) {
        process.stdout.write(
          `note: verify commands were auto-detected; pin them in agents/config.json under verify.commands: ${JSON.stringify(result.mechanical.configSuggestion)}\n`,
        );
      }
    }
    if (result.review) {
      process.stdout.write(`[review] ${result.review.summary}\n`);
      for (const finding of result.review.findings) {
        process.stdout.write(`[review:${finding.kind}] ${finding.problem} - ${finding.nextAction}\n`);
      }
    }
    if (result.error) {
      const structuralRefusal = new Set(["gate-in-flight", "reopen-required"]);
      const label = structuralRefusal.has(result.error.code) ? "gate refusal" : "judge error";
      process.stdout.write(`[${label}: ${result.error.code}] ${result.error.message}\n`);
      process.stdout.write(`recovery: ${result.error.recovery}\n`);
    }
    printStatusView(result.status);
  }
  process.exit(result.ok ? 0 : 1);
}

function emitInterviewResult(result: InterviewResult, asJson: boolean): never {
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ contractVersion: contractVersion(), ...result }, null, 2)}\n`);
  } else {
    const c = result.cursor;
    const summary: Record<InterviewResult["action"], () => string> = {
      init: () => `created ${result.qaLog}`,
      sync: () => `synced ${(result.detail.imported as string[]).join(", ") || "no new turns"} (${String(result.detail.alreadyImported)} already present)`,
      decision: () => `register ${String(result.detail.id)} ${result.detail.created ? "created" : "updated"}`,
      checkpoint: () => `checkpoint ${String(result.detail.checkpoint)} recorded (normalized: ${(result.detail.normalized as string[]).join(", ") || "none"})`,
      status: () => `qa-log: ${result.qaLog}`,
    };
    process.stdout.write(`[interview:${result.action}] ${summary[result.action]()}\n`);
    const questionBudget = c.questionLimit === null
      ? String(c.questionCount)
      : `${c.questionCount}/${c.questionLimit}${c.questionBudgetExceeded ? " (LIMIT EXCEEDED)" : c.questionBudgetReached ? " (LIMIT REACHED)" : ""}`;
    process.stdout.write(
      `  questions: ${questionBudget} | outstanding normalization: ${c.outstandingNormalization.join(", ") || "none"} | next checkpoint: ${c.nextCheckpointAt}${c.checkpointDue ? " (DUE - run interview checkpoint after normalizing)" : ""} | next decision id: ${c.nextDecisionId}\n`,
    );
    if (result.action === "status") {
      const open = result.detail.openMaterial as { id: string; area: string; priority: string; status: string }[];
      process.stdout.write(
        `  register: ${String(result.detail.registerCount)} rows | open P0/P1: ${open.map((row) => `${row.id} (${row.priority} ${row.area}, ${row.status})`).join(", ") || "none"}\n`,
      );
    }
    for (const finding of result.drift) {
      const where = finding.line !== null ? ` line ${finding.line}` : "";
      process.stdout.write(`  [drift] ${finding.rule}${where}: ${finding.missing}\n    fix: ${finding.recommendation}\n`);
    }
  }
  process.exit(result.ok ? 0 : 1);
}

function emitCoherenceResult(result: CoherenceResult, asJson: boolean): never {
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ contractVersion: contractVersion(), ...result }, null, 2)}\n`);
    process.exit(result.ok ? 0 : 1);
  }
  if (result.skipped) {
    process.stdout.write(`[interview:coherence] skipped - ${result.reason}\n`);
    process.exit(0);
  }
  if (result.error) {
    process.stdout.write(`[interview:coherence] judge error: ${result.error.code} - ${result.error.message}\n`);
    process.stdout.write(`recovery: ${result.error.recovery}\n`);
    process.exit(1);
  }
  const timing = result.durationMs !== null ? ` in ${(result.durationMs / 1000).toFixed(1)}s` : "";
  const head = result.verdict === "PASS" ? "coherent" : "coherence concerns";
  process.stdout.write(
    `[interview:coherence] ${head} (${result.resolvedCount} resolved decisions judged${timing})\n`,
  );
  for (const finding of result.findings) {
    const human = finding.requiresHuman ? " [needs human decision]" : "";
    process.stdout.write(`  - ${finding.severity} ${finding.area}: ${finding.missing}${human}\n`);
    if (finding.recommendation) process.stdout.write(`    ask: ${finding.recommendation}\n`);
  }
  // Advisory: a successful run always exits 0. Findings are next-question
  // candidates, not a block.
  process.exit(0);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [command, subcommand] = args.positional;
  const asJson = args.flags.get("json") === true;
  const projectRoot = findProjectRoot();

  if (args.flags.get("contract-version") === true || command === "contract-version") {
    process.stdout.write(`${contractVersion()}\n`);
    process.exit(0);
  }
  if (command === undefined || args.flags.get("help") === true || command === "help") {
    process.stdout.write(`${USAGE}\n`);
    process.exit(command === undefined ? 2 : 0);
  }

  if (command === "doctor") {
    const report = runDoctor(projectRoot);
    if (asJson) {
      process.stdout.write(`${JSON.stringify({ contractVersion: contractVersion(), ...report }, null, 2)}\n`);
    } else {
      for (const section of report.sections) {
        process.stdout.write(`## ${section.section} ${section.ok ? "ok" : "ATTENTION"}\n`);
        for (const line of section.lines) process.stdout.write(`  ${line}\n`);
      }
    }
    process.exit(report.ok ? 0 : 1);
  }

  if (command === "principles") {
    const principlesResult = runPrinciplesCommand(projectRoot, subcommand, args.flags);
    if (asJson) {
      process.stdout.write(`${JSON.stringify({ contractVersion: contractVersion(), ...principlesResult }, null, 2)}\n`);
    } else {
      process.stdout.write(`[principles:${principlesResult.action}] ${principlesResult.ok ? "ok" : "FAIL"} - ${principlesResult.message}\n`);
      const detail = principlesResult.detail as
        | { domains?: Array<{ name: string; trigger: string; doc: string; rules: string[]; commit: string | null }>; errors?: Array<{ source: string; message: string }> }
        | undefined;
      for (const domain of detail?.domains ?? []) {
        process.stdout.write(`  ${domain.name}: read ${domain.doc} when ${domain.trigger}${domain.commit ? ` [${domain.commit.slice(0, 7)}]` : ""}\n`);
        for (const rule of domain.rules) process.stdout.write(`    - ${rule}\n`);
      }
      for (const failed of detail?.errors ?? []) {
        process.stdout.write(`  ! ${failed.source}: ${failed.message}\n`);
      }
    }
    process.exit(principlesResult.exitCode);
  }

  const implementorBlockedGates = new Set(["gap-audit", "spec", "delegate", "reopen", "answer", "override"]);
  if (command === "gate" && subcommand !== undefined && implementorBlockedGates.has(subcommand) && currentHerdrRole() === "implementor") {
    const message = `Implementor role cannot run specification-stage gate '${subcommand}'. This command belongs to the Spec Owner or Observer. Run it from an unmarked main session; no state was written.`;
    if (asJson) {
      process.stdout.write(`${JSON.stringify({
        contractVersion: contractVersion(),
        ok: false,
        action: `gate:${subcommand}`,
        error: { code: "implementor-spec-command-refused", message, roleMarker: `${HERDR_ROLE_ENV_KEY}=implementor` },
      }, null, 2)}\n`);
    } else {
      process.stderr.write(`sasu: ${message}\n`);
    }
    process.exit(1);
  }

  // Every skill funnels through this CLI, so one guard here auto-provisions
  // setup for implement/quick/please/interview without per-skill prose
  // (PRINCIPLES item 7). help/contract-version/doctor exited above: doctor
  // stays a pure diagnostic that reports rather than mutates.
  for (const notice of ensureSetup(projectRoot)) process.stderr.write(`sasu: ${notice}\n`);

  if (command === "implement") {
    const implementResult = await runImplementCommand(projectRoot, args as ImplementArgs);
    if (asJson) {
      process.stdout.write(`${JSON.stringify({ contractVersion: contractVersion(), ...implementResult }, null, 2)}\n`);
    } else {
      process.stdout.write(`[implement:${implementResult.action}] ${implementResult.ok ? "ok" : "FAIL"} - ${implementResult.message}\n`);
      // A command that wrote a summary has already said what a person needs;
      // appending the machine record on top is what buried it (AC47). The
      // full record stays one `--json` away.
      if (implementResult.summary !== undefined) {
        process.stdout.write(`${implementResult.summary.join("\n")}\n`);
      } else if (implementResult.detail !== undefined) {
        process.stdout.write(`${JSON.stringify(implementResult.detail, null, 2)}\n`);
      }
    }
    process.exit(implementResult.exitCode);
  }

  if (command === "prd") {
    const prdResult = runPrdCommand(projectRoot, subcommand, args.flags);
    if (asJson) {
      process.stdout.write(`${JSON.stringify({ contractVersion: contractVersion(), ...prdResult }, null, 2)}\n`);
    } else {
      process.stdout.write(`[prd:${prdResult.action}] ${prdResult.ok ? "ok" : "FAIL"} - ${prdResult.message}\n`);
      if (prdResult.detail !== undefined) process.stdout.write(`${JSON.stringify(prdResult.detail, null, 2)}\n`);
    }
    process.exit(prdResult.exitCode);
  }

  if (command === "verify") {
    fail("`sasu verify` was removed; use `sasu implement verify` for an implementation run or `sasu gate verify` for a standalone diff gate");
  }

  if (command === "rules") {
    runRulesCommand(args);
    return;
  }

  if (command === "setup") {
    runSetupCommand(args);
    return;
  }

  if (command === "interview") {
    const slug = requireFlag(args, "slug");
    const optional = (name: string): string | undefined =>
      typeof args.flags.get(name) === "string" ? (args.flags.get(name) as string) : undefined;
    const csv = (value: string | undefined): string[] =>
      (value ?? "")
        .split(",")
        .map((token) => token.trim())
        .filter((token) => token !== "" && token.toLowerCase() !== "none");
    if (subcommand === "coherence") {
      const minRaw = optional("min-decisions");
      const minDecisions = minRaw !== undefined ? Number(minRaw) : 3;
      if (!Number.isInteger(minDecisions) || minDecisions < 1) fail("--min-decisions must be a positive integer");
      const coherence = await runInterviewCoherence(projectRoot, loadConfig(projectRoot), { slug, minDecisions });
      emitCoherenceResult(coherence, asJson);
    }
    let interviewResult: InterviewResult;
    if (subcommand === "init") {
      const questionLimitRaw = optional("question-limit");
      const questionLimit = questionLimitRaw === undefined ? undefined : Number(questionLimitRaw);
      if (questionLimit !== undefined && (!Number.isInteger(questionLimit) || questionLimit < 1)) {
        fail("--question-limit must be a positive integer");
      }
      interviewResult = await runInterviewInit(projectRoot, {
        slug,
        topic: requireFlag(args, "topic"),
        where: requireFlag(args, "where"),
        packs: requireFlag(args, "packs"),
        understanding: (optional("understanding") ?? "").split("\n").filter((line) => line.trim() !== ""),
        questionLimit,
        transcriptPath: optional("transcript"),
      });
    } else if (subcommand === "sync") {
      interviewResult = await runInterviewSync(projectRoot, {
        slug,
        transcriptPath: optional("transcript"),
      });
    } else if (subcommand === "decision") {
      interviewResult = await runInterviewDecision(projectRoot, {
        slug,
        transcriptPath: optional("transcript"),
        id: requireFlag(args, "id"),
        kind: optional("kind"),
        area: optional("area"),
        text: optional("text"),
        priority: optional("priority"),
        source: optional("source"),
        status: optional("status"),
        mapping: optional("mapping"),
        anchor: optional("anchor"),
      });
    } else if (subcommand === "checkpoint") {
      interviewResult = runInterviewCheckpoint(projectRoot, {
        slug,
        normalized: csv(optional("normalized")),
        registerChanges: optional("register-changes") ?? "",
        reopened: optional("reopened") ?? "",
        gap: optional("gap") ?? "",
      });
    } else if (subcommand === "status") {
      interviewResult = readInterviewStatus(projectRoot, slug);
    } else {
      fail(`unknown interview subcommand: ${subcommand ?? "(none)"}\n\n${USAGE}`);
    }
    emitInterviewResult(interviewResult, asJson);
  }

  if (command === "gate") {
    const config = loadConfig(projectRoot);
    if (subcommand === "verify") {
      const topic = requireFlag(args, "slug");
      const retired = ["prd", "skip-mechanical", "allow-open-rows"].filter((name) => args.flags.has(name));
      if (retired.length > 0) {
        fail(`gate verify ${retired.map((name) => `--${name}`).join(" ")} was removed in contract 0.9.0; use implement verify for an approved PRD or gate verify --contract for quick work. Last supported commit: 488d3cc.`);
      }
      const result = await runVerifyGate(projectRoot, config, topic, {
        contractPath: requireFlag(args, "contract"),
        baseRef: typeof args.flags.get("base") === "string" ? (args.flags.get("base") as string) : undefined,
      });
      emitGateResult(result, asJson);
    }
    if (subcommand === "gap-audit") {
      const result = await runGapAudit(projectRoot, config, requireFlag(args, "slug"), requireFlag(args, "qa-log"), {
        grantBudgetEvidence: typeof args.flags.get("grant-budget") === "string" ? (args.flags.get("grant-budget") as string) : undefined,
        assumeHumanEvidence: typeof args.flags.get("assume-human-findings") === "string" ? (args.flags.get("assume-human-findings") as string) : undefined,
      });
      emitGateResult(result, asJson);
    }
    if (subcommand === "spec") {
      const result = await runSpecGate(
        projectRoot,
        config,
        requireFlag(args, "slug"),
        requireFlag(args, "prd"),
        requireFlag(args, "qa-log"),
        {
          grantBudgetEvidence: typeof args.flags.get("grant-budget") === "string" ? (args.flags.get("grant-budget") as string) : undefined,
          assumeHumanEvidence: typeof args.flags.get("assume-human-findings") === "string" ? (args.flags.get("assume-human-findings") as string) : undefined,
        },
      );
      emitGateResult(result, asJson);
    }
    if (subcommand === "status") {
      const status = readGateStatus(projectRoot, config, requireFlag(args, "slug"));
      if (asJson) {
        process.stdout.write(`${JSON.stringify({ contractVersion: contractVersion(), ...status }, null, 2)}\n`);
      } else {
        // A stored delegation changes how the next gate run disposes of
        // human findings, so status must say it before the per-gate lines.
        if (status.delegation) {
          process.stdout.write(`delegated run (recorded ${status.delegation.at}): "${status.delegation.evidence}"\n`);
        }
        printStatusView(status["gap-audit"]);
        printStatusView(status.spec);
        printStatusView(status.verify);
        process.stdout.write(`judge calls recorded: ${status.judgeCallCount}\n`);
      }
      process.exit(0);
    }
    if (subcommand === "delegate") {
      if (args.flags.get("clear") === true) {
        const cleared = runDelegateClear(projectRoot, requireFlag(args, "slug"));
        if (asJson) {
          process.stdout.write(`${JSON.stringify({ contractVersion: contractVersion(), ...cleared }, null, 2)}\n`);
        } else {
          process.stdout.write(cleared.cleared ? "delegation cleared. Later gate runs will block on human-consent findings again.\n" : "no stored delegation to clear.\n");
        }
        process.exit(0);
      }
      const delegation = runDelegate(projectRoot, requireFlag(args, "slug"), requireFlag(args, "evidence"));
      if (asJson) {
        process.stdout.write(`${JSON.stringify({ contractVersion: contractVersion(), delegation }, null, 2)}\n`);
      } else {
        process.stdout.write(
          `delegation recorded. Every gap-audit/spec run on this slug now converts non-P0 human-consent findings into recorded assumptions (P0 still blocks).\n`,
        );
      }
      process.exit(0);
    }
    if (subcommand === "reopen") {
      const gate = requireFlag(args, "gate");
      if (gate !== "gap-audit" && gate !== "spec") fail("--gate must be one of: gap-audit, spec");
      const view = runReopen(
        projectRoot,
        config,
        requireFlag(args, "slug"),
        gate as "gap-audit" | "spec",
        requireFlag(args, "evidence"),
      );
      if (asJson) {
        process.stdout.write(`${JSON.stringify({ contractVersion: contractVersion(), status: view }, null, 2)}\n`);
      } else {
        process.stdout.write(`${gate} review reopened with recorded user evidence.\n`);
        printStatusView(view);
      }
      process.exit(0);
    }
    if (subcommand === "answer") {
      const gate = requireFlag(args, "gate");
      if (gate !== "gap-audit" && gate !== "spec") fail("--gate must be one of: gap-audit, spec");
      const view = runAnswer(
        projectRoot,
        config,
        requireFlag(args, "slug"),
        gate as "gap-audit" | "spec",
        requireFlag(args, "evidence"),
      );
      if (asJson) {
        process.stdout.write(`${JSON.stringify({ contractVersion: contractVersion(), status: view }, null, 2)}\n`);
      } else {
        process.stdout.write(`${gate} human bundle answered with recorded user evidence; the gate is sealed PASS without another judge call.\n`);
        printStatusView(view);
      }
      process.exit(0);
    }
    if (subcommand === "override") {
      const gate = requireFlag(args, "gate");
      if (gate !== "gap-audit" && gate !== "spec" && gate !== "verify") {
        fail("--gate must be one of: gap-audit, spec, verify");
      }
      const view = runOverride(projectRoot, requireFlag(args, "slug"), gate as GateId, requireFlag(args, "reason"));
      if (asJson) {
        process.stdout.write(
          `${JSON.stringify({ contractVersion: contractVersion(), overridden: true, gate, status: view }, null, 2)}\n`,
        );
      } else {
        process.stdout.write(`override recorded as a deviation. gate ${gate} is now passable.\n`);
        printStatusView(view);
      }
      process.exit(0);
    }
    fail(`unknown gate subcommand: ${subcommand ?? "(none)"}\n\n${USAGE}`);
  }

  fail(`unknown command: ${command}\n\n${USAGE}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`sasu: ${message}\n`);
  process.exit(1);
});
