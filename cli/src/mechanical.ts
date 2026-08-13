import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { SasuConfig } from "./config";

/**
 * `check` and `capture` are the quick path's contract-declared commands: a
 * check proves a criterion by running (evidence tier 1), a capture produces a
 * fresh artifact for the judge (tier 3). Both run on the harness clock in the
 * mechanical stage, which is what makes their result unforgeable.
 */
export type ProjectMechanicalKind = "test" | "lint" | "build" | "typecheck";
export type MechanicalKind = ProjectMechanicalKind | "check" | "capture";

export interface ResolvedCommand {
  kind: MechanicalKind;
  command: string;
  cwd?: string;
  source: "config" | "detected" | "contract";
  /**
   * Criteria this command proves, for contract-declared checks and captures.
   * A list because two criteria may declare the same command: it runs once,
   * but its result is evidence for both of them.
   */
  criterionIds?: string[];
}

export interface MechanicalRun {
  kind: MechanicalKind;
  command: string;
  cwd?: string;
  source: "config" | "detected" | "contract";
  criterionIds?: string[];
  exitCode: number;
  ok: boolean;
  tail: string;
}

export interface MechanicalResult {
  ok: boolean;
  runs: MechanicalRun[];
  resolved: ResolvedCommand[];
  configSuggestion: Record<string, string> | null;
}

/**
 * Resolve mechanical verify commands (D-08): explicit config wins, then root
 * manifest detection.
 */
export function resolveMechanicalCommands(
  projectRoot: string,
  config: SasuConfig,
): {
  resolved: ResolvedCommand[];
  configSuggestion: Record<string, string> | null;
} {
  const declared = config.verify.commands;
  const resolved: ResolvedCommand[] = [];
  const kinds: ProjectMechanicalKind[] = ["test", "lint", "typecheck", "build"];
  const declaredKinds = kinds.filter((k) => typeof declared[k] === "string" && declared[k]!.trim() !== "");
  if (declaredKinds.length > 0) {
    for (const kind of declaredKinds) {
      resolved.push({ kind, command: declared[kind]!, source: "config" });
    }
    return { resolved, configSuggestion: null };
  }
  const detected = detectFromManifests(projectRoot);
  const suggestion: Record<string, string> = {};
  for (const cmd of detected) suggestion[cmd.kind] = cmd.command;
  return { resolved: detected, configSuggestion: detected.length > 0 ? suggestion : null };
}

function detectFromManifests(projectRoot: string): ResolvedCommand[] {
  const commands: ResolvedCommand[] = [];
  const pkgPath = path.join(projectRoot, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
      const scripts = pkg.scripts ?? {};
      const runner = fs.existsSync(path.join(projectRoot, "pnpm-lock.yaml")) ? "pnpm" : "npm";
      for (const kind of ["test", "lint", "typecheck", "build"] as ProjectMechanicalKind[]) {
        if (scripts[kind]) commands.push({ kind, command: `${runner} run ${kind}`, source: "detected" });
      }
    } catch {
      // Unparseable package.json: fall through to other manifests.
    }
  }
  if (commands.length === 0 && fs.existsSync(path.join(projectRoot, "pyproject.toml"))) {
    commands.push({ kind: "test", command: "pytest", source: "detected" });
  }
  if (commands.length === 0 && fs.existsSync(path.join(projectRoot, "Cargo.toml"))) {
    commands.push({ kind: "test", command: "cargo test", source: "detected" });
    commands.push({ kind: "build", command: "cargo build", source: "detected" });
  }
  if (commands.length === 0 && fs.existsSync(path.join(projectRoot, "go.mod"))) {
    commands.push({ kind: "test", command: "go test ./...", source: "detected" });
  }
  return commands;
}

/**
 * @param extra contract-declared commands (quick path) appended after the
 * project's own checks: a broken build should surface before a capture script
 * fails for the same reason.
 */
export function runMechanical(
  projectRoot: string,
  config: SasuConfig,
  extra: ResolvedCommand[] = [],
  options: {
    skipProjectCommands?: boolean;
  } = {},
): MechanicalResult {
  const base = options.skipProjectCommands
    ? { resolved: [] as ResolvedCommand[], configSuggestion: null }
    : resolveMechanicalCommands(projectRoot, config);
  const configSuggestion = base.configSuggestion;
  // A contract that restates a configured command (the natural thing to write
  // when you want the check tier and `npm test` is the only command you have)
  // must not run the suite twice.
  // A command declared more than once runs once. Deduping must never drop a
  // criterion's proof, though: the surviving run inherits every criterion that
  // declared the command, and a capture outranks an identical check because it
  // also has to produce an artifact.
  const commandKey = (cmd: ResolvedCommand): string => `${cmd.cwd ?? "."}\0${cmd.command.trim()}`;
  const byCommand = new Map<string, ResolvedCommand>();
  const order: string[] = [];
  for (const cmd of [...base.resolved, ...extra]) {
    const key = commandKey(cmd);
    const existing = byCommand.get(key);
    if (!existing) {
      byCommand.set(key, { ...cmd, ...(cmd.criterionIds ? { criterionIds: [...cmd.criterionIds] } : {}) });
      order.push(key);
      continue;
    }
    const merged = new Set([...(existing.criterionIds ?? []), ...(cmd.criterionIds ?? [])]);
    byCommand.set(key, {
      ...(cmd.kind === "capture" ? cmd : existing),
      ...(merged.size > 0 ? { criterionIds: [...merged] } : {}),
    });
  }
  const resolved = order.map((key) => byCommand.get(key)!);
  const runs: MechanicalRun[] = [];
  let ok = true;
  for (const cmd of resolved) {
    const run = runOne(projectRoot, cmd, config);
    runs.push(run);
    if (!run.ok) {
      ok = false;
      // Fail fast on the project's own checks: later stages cost more and the
      // judge must not run anyway. Criterion-scoped commands are the exception
      // - they are a criterion's evidence, and skipping them would leave the
      // receipt for a failed run silent about which criteria were already
      // satisfied, which is exactly the report that most needs the detail.
      for (const next of resolved.slice(resolved.indexOf(cmd) + 1)) {
        if ((next.criterionIds ?? []).length > 0) runs.push(runOne(projectRoot, next, config));
      }
      break;
    }
  }
  return { ok, runs, resolved, configSuggestion };
}

function runOne(projectRoot: string, cmd: ResolvedCommand, config: SasuConfig): MechanicalRun {
  const commandCwd = path.resolve(projectRoot, cmd.cwd ?? ".");
  const relativeCwd = path.relative(projectRoot, commandCwd);
  if (relativeCwd === ".." || relativeCwd.startsWith(`..${path.sep}`) || path.isAbsolute(relativeCwd)) {
    return {
      kind: cmd.kind,
      command: cmd.command,
      cwd: cmd.cwd,
      source: cmd.source,
      ...(cmd.criterionIds !== undefined && cmd.criterionIds.length > 0 ? { criterionIds: cmd.criterionIds } : {}),
      exitCode: 1,
      ok: false,
      tail: `[sasu] command cwd escapes the project root: ${cmd.cwd}`,
    };
  }
  const result = spawnSync(cmd.command, {
    cwd: commandCwd,
    shell: true,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    // A hung suite must fail closed instead of hanging the gate forever
    // (PRD judge-fanout R8); configurable via verify.commandTimeoutMs.
    timeout: config.verify.commandTimeoutMs,
    env: process.env,
  });
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || result.signal === "SIGTERM";
  const exitCode = result.status ?? 1;
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  const tailLines = combined.split("\n").slice(-30);
  if (timedOut) tailLines.push(`[sasu] command timed out after ${config.verify.commandTimeoutMs}ms (verify.commandTimeoutMs)`);
  return {
    kind: cmd.kind,
    command: cmd.command,
    ...(cmd.cwd !== undefined ? { cwd: cmd.cwd } : {}),
    source: cmd.source,
    ...(cmd.criterionIds !== undefined && cmd.criterionIds.length > 0 ? { criterionIds: cmd.criterionIds } : {}),
    exitCode: timedOut ? 124 : exitCode,
    ok: !timedOut && exitCode === 0,
    tail: tailLines.join("\n"),
  };
}
