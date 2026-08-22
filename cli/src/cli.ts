#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import { loadConfig } from "./config";
import { runDoctor } from "./doctor";
import { runAudit } from "./audit/runs";
import {
  readGateStatus,
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
  runInterviewLog,
  type InterviewResult,
} from "./interview/commands";
import { runInterviewCoherence, type CoherenceResult } from "./interview/coherence";
import { contractVersion } from "./version";
import { runImplementCommand, type ImplementArgs } from "./implement/commands";
import { runPrdCommand } from "./prd/commands";
import { runPrinciplesCommand } from "./principles/commands";
import { runRulesCommand, runSetupCommand } from "./support/commands";
import { ensureSetup } from "./support/ensure-setup";

const USAGE = `sasu - harness CLI: judge gates, verification, doctor

Usage:
  sasu --contract-version
  sasu gate gap-audit --slug <topic> --qa-log <path> [--grant-budget "<verbatim user approval>"] [--assume-human-findings "<verbatim delegated invocation>"] [--json]
  sasu gate spec      --slug <topic> --prd <path> --qa-log <path> [--grant-budget "<verbatim user approval>"] [--assume-human-findings "<verbatim delegated invocation>"] [--json]
  sasu gate status    --slug <topic> [--json]
  sasu gate delegate  --slug <topic> --evidence "<verbatim delegating user message>" [--json]
  sasu gate reopen    --slug <topic> --gate <gap-audit|spec> --evidence "<verbatim user change request>" [--json]
  sasu gate override  --slug <topic> --gate <gap-audit|spec|verify> --reason "<why>" [--json]
  sasu gate verify    --slug <topic> (--prd <path> | --contract <path>) [--base <git-ref>] [--skip-mechanical] [--allow-open-tasks] [--json]
  sasu implement start    --prd <path> [--allow-unapproved-prd "<verbatim approval>"] [--json]
  sasu implement task     --id <Tn> [--status <complete|pending|blocked>] --evidence "<proof>" [--json]
  sasu implement artifact --id <Vn> --kind <screenshot|image|browser|api|db|log|file> --path <path> --description "<proof>" [--json]
  sasu implement status   [--slug <topic> | --state <path>] [--json]
  sasu implement design   --id <D#> --accept "<why the comment is being left alone>" [--slug <topic> | --state <path>] [--json]
  sasu implement verify   [--slug <topic> | --state <path>] [--grant-budget "<verbatim user approval>"] [--json]
  sasu implement finalize [--slug <topic> | --state <path>] [--status <complete|blocked>] [--json]
    (mutating implement commands on a run owned by another session require --adopt "<verbatim user approval>")
  sasu prd readiness       --prd <path> [--json]
  sasu principles list     [--domain <name>] [--json]
  sasu rules <add|check|relevant> [...]
  sasu setup seed-agents-md [--project-root <path>] [--adopt-claude-md]
  sasu interview init       --slug <topic> --topic "<title>" --where <greenfield|brownfield|docs-only|unknown> --packs "<csv>" [--understanding "<lines>"] [--json]
  sasu interview log        --slug <topic> --label "<short>" --asked "<question>" --answer "<raw answer>" [--route <fact|user-decision|mixed|research>] [--recommended "<text>"] [--decision-ids "D-01,D-02"] [--notes "<text>"] [--next-question "<text>"] [--json]
  sasu interview decision   --slug <topic> --id D-01 [--kind <fact|decision|assumption>] [--area "<area>"] [--text "<decision>"] [--priority <P0|P1|P2>] [--source "<owner>"] [--status <open|resolved|deferred|blocking|rejected>] [--mapping "<prd mapping>"] [--json]
  sasu interview checkpoint --slug <topic> --normalized "Q1,Q2" [--register-changes "<text>"] [--reopened "<text>"] [--gap "<text>"] [--json]
  sasu interview coherence  --slug <topic> [--min-decisions <n>] [--json]
  sasu interview status     --slug <topic> [--json]
  sasu audit runs [--project-root <path>] [--include-seen] [--json]
  sasu doctor [--json]

Interview commands own the qa-log's mechanical bookkeeping (counters, cursor,
Raw Q&A appends, Decision Register upserts, needs_normalization flips) so the
interviewing agent records a full turn with one short command. Question choice
and semantic normalization prose stay with the agent. Register a decision row
before referencing it from interview log (chain: decision && log).

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

Gap-audit and spec each get one exhaustive verdict. A BLOCK permits exactly one
closure verdict after the document is fixed. PASS seals that cycle; a sealed
input change or a second BLOCK stops at $0 until the user explicitly opens a
new cycle with 'gate reopen'. --grant-budget only retries a judge backend that
failed without returning a verdict. Verify keeps its configured retry budget.

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
Judgment runs as one-shot headless calls (claude -p / codex exec); this CLI never
executes implementation work.

'audit runs' is the L1 run auditor: a read-only sweep of every recorded run's
gate state against the behavior the skills promise, built to be driven
periodically by an agent loop. It always reports every judged gate's timeline
(rounds, wall-clock duration) unconditionally - exit 0 means no KNOWN bad
pattern tripped, not that every run was fast, and a slow-gate-timeline finding
flags any gate whose duration is 3x+ its own gate type's median in this scan.
Each finding names the PRINCIPLES item it leans
on and whether it is a mechanical-fix candidate, a design question, or
informational. A fingerprint ledger (agents/runs/.audit/ledger.json) reports
each structural finding once and then only tracks it, so the loop converges;
--include-seen re-prints tracked ones. Exit 1 when NEW findings exist, else 0.`;

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
  const terminal = view.closureExhausted
    ? ` - CLOSURE EXHAUSTED: cycle ${view.reviewCycle} remains blocked after its one closure verdict; report the findings and require an explicit gate reopen`
    : view.reopenRequired
      ? ` - REOPEN REQUIRED: this sealed review's input changed; restore it or record the user's change request with gate reopen`
    : view.budgetExhausted
    ? " - RETRY BUDGET EXHAUSTED: the autonomous fix loop stops here; report the findings to the user (only their verbatim approval, recorded via --grant-budget, reopens the budget)"
    : view.judgeErrorLoop
      ? ` - JUDGE ERROR LOOP: ${view.consecutiveErrors} consecutive judge failures with no verdict, so nothing was judged and the fix budget is unspent; repair the judge, then a user-granted --grant-budget re-run may continue, or close the run out blocked`
      : view.cycleExhausted
        ? ` - CYCLE CAP REACHED: ${view.roundsSinceGrant}/${view.cycleCap} judged non-PASS rounds since the last grant; the fix loop is not converging - report the findings to the user (their verbatim approval via --grant-budget reopens it)`
        : "";
  const grants = view.grants > 0 ? ` | grants ${view.grants}` : "";
  // Assumed human findings must stay loud on every status read: a PASS earned
  // by delegation is honest only while the substitution is visible (item 10).
  const assumed = view.assumedHumanFindings > 0
    ? ` | ASSUMED HUMAN DECISIONS: ${view.assumedHumanFindings} finding(s) converted to recorded assumptions under the delegated invocation - the user may veto (see the gate record's humanAssumptions)`
    : "";
  const review = view.reviewPhase === null
    ? `attempts ${view.attempts}/${view.budget}`
    : `review cycle ${view.reviewCycle} | ${view.reviewPhase} | semantic rounds ${view.reviewRound}/2`;
  const active = view.inFlight ? " | IN FLIGHT" : "";
  const meta = `${review}${grants}${assumed}${active}${terminal}`;
  process.stdout.write(`${head} | ${meta}\n`);
  for (const input of view.staleInputs) {
    process.stdout.write(`  stale: ${input.path} ${input.reason} after this gate passed - restore it or explicitly reopen the review cycle\n`);
  }
  for (const finding of view.findings) {
    const human = finding.requiresHuman ? " [needs human decision]" : "";
    process.stdout.write(`  - ${finding.severity} ${finding.area}: ${finding.missing}${human}\n`);
    if (finding.recommendation) process.stdout.write(`    fix: ${finding.recommendation}\n`);
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
    if (result.criteria) {
      for (const criterion of result.criteria) {
        process.stdout.write(`[semantic] ${criterion.id} ${criterion.verdict} - ${criterion.reason}\n`);
      }
    }
    if (result.error) {
      const structuralRefusal = new Set(["gate-in-flight", "reopen-required", "closure-exhausted"]);
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
      log: () => `logged ${String(result.detail.logged)} (decision_ids: ${(result.detail.decisionIds as string[]).join(", ") || "none"})`,
      decision: () => `register ${String(result.detail.id)} ${result.detail.created ? "created" : "updated"}`,
      checkpoint: () => `checkpoint ${String(result.detail.checkpoint)} recorded (normalized: ${(result.detail.normalized as string[]).join(", ") || "none"})`,
      status: () => `qa-log: ${result.qaLog}`,
    };
    process.stdout.write(`[interview:${result.action}] ${summary[result.action]()}\n`);
    process.stdout.write(
      `  questions: ${c.questionCount} | outstanding normalization: ${c.outstandingNormalization.join(", ") || "none"} | next checkpoint: ${c.nextCheckpointAt}${c.checkpointDue ? " (DUE - run interview checkpoint after normalizing)" : ""} | next decision id: ${c.nextDecisionId}\n`,
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
  process.exit(0);
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
      if (implementResult.detail !== undefined) process.stdout.write(`${JSON.stringify(implementResult.detail, null, 2)}\n`);
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
      interviewResult = runInterviewInit(projectRoot, {
        slug,
        topic: requireFlag(args, "topic"),
        where: requireFlag(args, "where"),
        packs: requireFlag(args, "packs"),
        understanding: (optional("understanding") ?? "").split("\n").filter((line) => line.trim() !== ""),
      });
    } else if (subcommand === "log") {
      interviewResult = runInterviewLog(projectRoot, {
        slug,
        label: requireFlag(args, "label"),
        asked: requireFlag(args, "asked"),
        answer: requireFlag(args, "answer"),
        route: optional("route") ?? "user-decision",
        recommended: optional("recommended") ?? "",
        decisionIds: csv(optional("decision-ids")),
        notes: optional("notes") ?? "",
        nextQuestion: optional("next-question"),
      });
    } else if (subcommand === "decision") {
      interviewResult = runInterviewDecision(projectRoot, {
        slug,
        id: requireFlag(args, "id"),
        kind: optional("kind"),
        area: optional("area"),
        text: optional("text"),
        priority: optional("priority"),
        source: optional("source"),
        status: optional("status"),
        mapping: optional("mapping"),
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

  if (command === "audit") {
    if (subcommand !== "runs") fail(`unknown audit subcommand: ${subcommand ?? "(none)"}\n\n${USAGE}`);
    const config = loadConfig(projectRoot);
    const rootFlag = args.flags.get("project-root");
    const root = typeof rootFlag === "string" ? path.resolve(rootFlag) : projectRoot;
    const result = runAudit(root, config, { includeSeen: args.flags.get("include-seen") === true });
    if (asJson) {
      process.stdout.write(`${JSON.stringify({ contractVersion: contractVersion(), ...result }, null, 2)}\n`);
    } else {
      process.stdout.write(`audited ${result.scannedSlugs.length} run(s) in ${root}\n`);
      for (const f of result.findings) {
        const badge = f.classification === "mechanical-fix-candidate" ? "FIX?" : f.classification === "design-question" ? "ASK" : "info";
        process.stdout.write(`[${badge}] ${f.fingerprint}${f.seen ? " (seen)" : ""} - ${f.summary} (PRINCIPLES ${f.principles.join(",")})\n`);
      }
      process.stdout.write(`${result.newFindings} new finding(s); ledger: ${path.relative(root, result.ledgerPath)}\n`);
      // Timelines print unconditionally: exit 0 means no KNOWN bad pattern
      // tripped, not that every run was fast - a single-round PASS with a
      // 20-minute wall clock trips no round-count rule.
      if (result.timelines.length > 0) {
        process.stdout.write(`timelines:\n`);
        for (const t of result.timelines) {
          const firstPass = t.firstPassAt === null ? "no PASS" : `first PASS ${t.firstPassDurationMinutes}min`;
          const judge = t.judgeCriticalPathMinutes === null ? "judge n/a" : `judge critical path ${t.judgeCriticalPathMinutes}min`;
          process.stdout.write(`  ${t.slug}:${t.gate} ${t.verdict ?? "?"} ${t.rounds}rd recorded span ${t.durationMinutes}min | ${firstPass} | ${judge} (${t.startedAt} -> ${t.endedAt})\n`);
        }
      }
    }
    process.exit(result.newFindings > 0 ? 1 : 0);
  }

  if (command === "gate") {
    const config = loadConfig(projectRoot);
    if (subcommand === "verify") {
      const topic = requireFlag(args, "slug");
      const result = await runVerifyGate(projectRoot, config, topic, {
        prdPath: typeof args.flags.get("prd") === "string" ? (args.flags.get("prd") as string) : undefined,
        contractPath: typeof args.flags.get("contract") === "string" ? (args.flags.get("contract") as string) : undefined,
        baseRef: typeof args.flags.get("base") === "string" ? (args.flags.get("base") as string) : undefined,
        skipMechanical: args.flags.get("skip-mechanical") === true,
        allowOpenTasks: args.flags.get("allow-open-tasks") === true,
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
