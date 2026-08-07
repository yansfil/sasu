import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { SasuConfig } from "./config";

export type MechanicalKind = "test" | "lint" | "build" | "typecheck";

export interface ResolvedCommand {
  kind: MechanicalKind;
  command: string;
  source: "config" | "detected";
}

export interface MechanicalRun {
  kind: MechanicalKind;
  command: string;
  source: "config" | "detected";
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
 * Resolve mechanical verify commands (D-08): agents/config.json declarations
 * win; otherwise detect from project manifests and suggest recording the
 * detection back into config.
 */
export function resolveMechanicalCommands(projectRoot: string, config: SasuConfig): {
  resolved: ResolvedCommand[];
  configSuggestion: Record<string, string> | null;
} {
  const declared = config.verify.commands;
  const resolved: ResolvedCommand[] = [];
  const kinds: MechanicalKind[] = ["test", "lint", "typecheck", "build"];
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
      for (const kind of ["test", "lint", "typecheck", "build"] as MechanicalKind[]) {
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

export function runMechanical(projectRoot: string, config: SasuConfig): MechanicalResult {
  const { resolved, configSuggestion } = resolveMechanicalCommands(projectRoot, config);
  const runs: MechanicalRun[] = [];
  let ok = true;
  for (const cmd of resolved) {
    const result = spawnSync(cmd.command, {
      cwd: projectRoot,
      shell: true,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      // A hung suite must fail closed instead of hanging the gate forever
      // (PRD judge-fanout R8); configurable via verify.commandTimeoutMs.
      timeout: config.verify.commandTimeoutMs,
      env: process.env,
    });
    const timedOut =
      (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || result.signal === "SIGTERM";
    const exitCode = result.status ?? 1;
    const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    const tailLines = combined.split("\n").slice(-30);
    if (timedOut) tailLines.push(`[sasu] command timed out after ${config.verify.commandTimeoutMs}ms (verify.commandTimeoutMs)`);
    runs.push({
      kind: cmd.kind,
      command: cmd.command,
      source: cmd.source,
      exitCode: timedOut ? 124 : exitCode,
      ok: !timedOut && exitCode === 0,
      tail: tailLines.join("\n"),
    });
    if (!runs[runs.length - 1]!.ok) {
      ok = false;
      break; // Fail fast: later stages cost more, and semantic must not run anyway.
    }
  }
  return { ok, runs, resolved, configSuggestion };
}
