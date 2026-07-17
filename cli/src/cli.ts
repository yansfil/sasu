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
import { contractVersion } from "./version";

const USAGE = `checkshirt - harness CLI: judge gates, verification, doctor

Usage:
  checkshirt --contract-version
  checkshirt gate gap-audit --slug <topic> --qa-log <path> [--json]
  checkshirt gate spec      --slug <topic> --prd <path> --qa-log <path> [--json]
  checkshirt gate status    --slug <topic> [--json]
  checkshirt gate override  --slug <topic> --gate <gap-audit|spec|verify> --reason "<why>" [--json]
  checkshirt verify         --slug <topic> --prd <path> [--base <git-ref>] [--diff-file <path>] [--skip-mechanical] [--json]
  checkshirt doctor [--json]

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
  process.stderr.write(`checkshirt: ${message}\n`);
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
      diffFile: typeof args.flags.get("diff-file") === "string" ? (args.flags.get("diff-file") as string) : undefined,
      baseRef: typeof args.flags.get("base") === "string" ? (args.flags.get("base") as string) : undefined,
      skipMechanical: args.flags.get("skip-mechanical") === true,
    });
    emitGateResult(result, asJson);
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
  process.stderr.write(`checkshirt: ${message}\n`);
  process.exit(1);
});
