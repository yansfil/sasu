#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import { loadConfig } from "./config";
import { runDoctor } from "./doctor";
import {
  readGateStatus,
  runGapAudit,
  runOverride,
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

const USAGE = `sasu - harness CLI: judge gates, verification, doctor

Usage:
  sasu --contract-version
  sasu gate gap-audit --slug <topic> --qa-log <path> [--json]
  sasu gate spec      --slug <topic> --prd <path> --qa-log <path> [--json]
  sasu gate status    --slug <topic> [--json]
  sasu gate override  --slug <topic> --gate <gap-audit|spec|verify> --reason "<why>" [--json]
  sasu verify         --slug <topic> (--prd <path> | --contract <path>) [--base <git-ref>] [--diff-file <path>] [--skip-mechanical] [--allow-open-tasks] [--json]
  sasu interview init       --slug <topic> --topic "<title>" --where <greenfield|brownfield|docs-only|unknown> --packs "<csv>" [--understanding "<lines>"] [--json]
  sasu interview log        --slug <topic> --label "<short>" --asked "<question>" --answer "<raw answer>" [--route <fact|user-decision|mixed|research>] [--recommended "<text>"] [--decision-ids "D-01,D-02"] [--notes "<text>"] [--next-question "<text>"] [--json]
  sasu interview decision   --slug <topic> --id D-01 [--kind <fact|decision|assumption>] [--area "<area>"] [--text "<decision>"] [--priority <P0|P1|P2>] [--source "<owner>"] [--status <open|resolved|deferred|blocking|rejected>] [--mapping "<prd mapping>"] [--json]
  sasu interview checkpoint --slug <topic> --normalized "Q1,Q2" [--register-changes "<text>"] [--reopened "<text>"] [--gap "<text>"] [--json]
  sasu interview coherence  --slug <topic> [--min-decisions <n>] [--json]
  sasu interview status     --slug <topic> [--json]
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

Gates are hard blocks: agents must never run 'gate override' on a user's behalf.
Judgment runs as one-shot headless calls (claude -p / codex exec); this CLI never
executes implementation work.`;

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
  const meta = `attempts ${view.attempts}/${view.budget}${view.budgetExhausted ? " - RETRY BUDGET EXHAUSTED: the autonomous fix loop stops here; report the findings to the user (a user-instructed re-run may continue)" : ""}`;
  process.stdout.write(`${head} | ${meta}\n`);
  for (const input of view.staleInputs) {
    process.stdout.write(`  stale: ${input.path} ${input.reason} after this gate passed - re-run the gate on the current document\n`);
  }
  for (const finding of view.findings) {
    const human = finding.requiresHuman ? " [needs human decision]" : "";
    process.stdout.write(`  - ${finding.severity} ${finding.area}: ${finding.missing}${human}\n`);
    if (finding.recommendation) process.stdout.write(`    fix: ${finding.recommendation}\n`);
  }
}

function printPrelint(prelint: NonNullable<GateCommandResult["prelint"]>): void {
  // Non-blocking advisories print on both the ok and FAIL paths: they never
  // gate, but the author has to see them (e.g. shell operators in a Check
  // oracle command are NOT interpreted).
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
      process.stdout.write(`[judge error: ${result.error.code}] ${result.error.message}\n`);
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

  if (command === "verify") {
    const config = loadConfig(projectRoot);
    const topic = requireFlag(args, "slug");
    const result = await runVerifyGate(projectRoot, config, topic, {
      prdPath: typeof args.flags.get("prd") === "string" ? (args.flags.get("prd") as string) : undefined,
      contractPath: typeof args.flags.get("contract") === "string" ? (args.flags.get("contract") as string) : undefined,
      diffFile: typeof args.flags.get("diff-file") === "string" ? (args.flags.get("diff-file") as string) : undefined,
      baseRef: typeof args.flags.get("base") === "string" ? (args.flags.get("base") as string) : undefined,
      skipMechanical: args.flags.get("skip-mechanical") === true,
      allowOpenTasks: args.flags.get("allow-open-tasks") === true,
    });
    emitGateResult(result, asJson);
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

  if (command === "gate") {
    const config = loadConfig(projectRoot);
    if (subcommand === "gap-audit") {
      const result = await runGapAudit(projectRoot, config, requireFlag(args, "slug"), requireFlag(args, "qa-log"));
      emitGateResult(result, asJson);
    }
    if (subcommand === "spec") {
      const result = await runSpecGate(
        projectRoot,
        config,
        requireFlag(args, "slug"),
        requireFlag(args, "prd"),
        requireFlag(args, "qa-log"),
      );
      emitGateResult(result, asJson);
    }
    if (subcommand === "status") {
      const status = readGateStatus(projectRoot, config, requireFlag(args, "slug"));
      if (asJson) {
        process.stdout.write(`${JSON.stringify({ contractVersion: contractVersion(), ...status }, null, 2)}\n`);
      } else {
        printStatusView(status["gap-audit"]);
        printStatusView(status.spec);
        printStatusView(status.verify);
        process.stdout.write(`judge calls recorded: ${status.judgeCallCount}\n`);
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
