import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { WorktreeConfig } from "../config";

export interface WorktreeProvision {
  path: string;
  branch: string;
}

function git(recordRoot: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync("git", args, { cwd: recordRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 60_000 });
}

export function worktreeRootFor(recordRoot: string, config: WorktreeConfig): string {
  return path.resolve(recordRoot, config.root ?? path.join("..", `${path.basename(recordRoot)}.worktrees`));
}

function carryDirtySource(recordRoot: string, worktreePath: string, relativePaths: string[]): string[] {
  const carried: string[] = [];
  for (const relative of relativePaths) {
    if (path.isAbsolute(relative) || relative === "" || relative.split(/[\\/]/).includes("..")) {
      throw new Error(`dirty source path must stay inside the record tree: ${relative}`);
    }
    const source = path.resolve(recordRoot, relative);
    const target = path.resolve(worktreePath, relative);
    if (!source.startsWith(`${path.resolve(recordRoot)}${path.sep}`)
      || !target.startsWith(`${path.resolve(worktreePath)}${path.sep}`)) {
      throw new Error(`dirty source path escaped its tree: ${relative}`);
    }
    fs.rmSync(target, { recursive: true, force: true });
    if (fs.existsSync(source)) {
      const stat = fs.lstatSync(source);
      if (!stat.isFile()) {
        throw new Error(`dirty source carry supports regular files only: ${relative}`);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      fs.chmodSync(target, stat.mode);
      carried.push(`carried dirty source: ${relative}`);
    } else {
      carried.push(`carried dirty deletion: ${relative}`);
    }
  }
  return carried;
}

/**
 * Create the run's isolated judged tree: a git worktree on a fresh branch at
 * the record tree's HEAD, prepared with the configured secrets sync. The
 * branch name matches ship's default (`prd/<slug>`) so PR delivery picks it
 * up without configuration. Provisioning and run initialization are
 * all-or-nothing until state.json is recorded: a failed setup or initializer
 * removes the worktree and branch again so a re-run of `implement start` does
 * not trip over half-provisioned debris (assume every operation runs twice);
 * the setup log survives under the run's log directory.
 */
export function provisionWorktree<T>(
  recordRoot: string,
  slug: string,
  runDirAbsolute: string,
  config: WorktreeConfig,
  commandTimeoutMs: number,
  dirtySourcePaths: string[],
  initializePrepared: (provision: WorktreeProvision) => T,
): T {
  const branch = `prd/${slug}`;
  const worktreePath = path.join(worktreeRootFor(recordRoot, config), slug);
  if (fs.existsSync(worktreePath)) {
    throw new Error(`worktree path already exists: ${worktreePath}; remove it (git worktree remove) or choose a new slug`);
  }
  if (git(recordRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0) {
    throw new Error(`branch ${branch} already exists; delete it or choose a new slug`);
  }
  const added = git(recordRoot, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
  if (added.error !== undefined || added.status !== 0) {
    throw new Error(`git worktree add failed: ${(added.stderr || added.error?.message || "unknown error").trim()}`);
  }
  const cleanup = (): Error[] => {
    const problems: Error[] = [];
    for (const [label, args] of [
      ["worktree remove", ["worktree", "remove", "--force", worktreePath]],
      ["branch delete", ["branch", "-D", branch]],
    ] as const) {
      const result = git(recordRoot, [...args]);
      if (result.error !== undefined || result.status !== 0) {
        const detail = (result.stderr || result.error?.message || `exit ${result.status ?? "spawn-error"}`).trim();
        problems.push(new Error(`${label} failed: ${detail}`));
      }
    }
    return problems;
  };
  const logLines: string[] = [];
  let logWritten = false;
  const writeSetupLog = (): void => {
    if (logLines.length === 0 || logWritten) return;
    const logDir = path.join(runDirAbsolute, "artifacts", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, "worktree-setup.log"), `${logLines.join("\n")}\n`);
    logWritten = true;
  };
  try {
    // A worktree starts at committed HEAD, but the run contract may declare
    // current uncommitted source as pre-existing or run-owned. Carry those
    // exact judged paths before setup so dependencies and generated output see
    // the same source the operator assigned. The callback re-scans the
    // prepared tree and binds every resulting dirty path into state.json.
    logLines.push(...carryDirtySource(recordRoot, worktreePath, dirtySourcePaths));
    for (const relative of config.link) {
      const source = path.join(recordRoot, relative);
      if (!fs.existsSync(source)) {
        logLines.push(`link skipped (missing in record tree): ${relative}`);
        continue;
      }
      const target = path.join(worktreePath, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(source, target);
      logLines.push(`linked: ${relative}`);
    }
    for (const relative of config.copy) {
      const source = path.join(recordRoot, relative);
      if (!fs.existsSync(source)) {
        logLines.push(`copy skipped (missing in record tree): ${relative}`);
        continue;
      }
      const target = path.join(worktreePath, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(source, target, { recursive: true });
      logLines.push(`copied: ${relative}`);
    }
    for (const command of config.setup) {
      const run = spawnSync(command, {
        cwd: worktreePath,
        shell: true,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        timeout: commandTimeoutMs,
      });
      logLines.push(`setup: ${command}`, `exit: ${run.status ?? "spawn-error"}`, run.stdout ?? "", run.stderr ?? "");
      if (run.error !== undefined || run.status !== 0) {
        throw new Error(`worktree setup command failed (exit ${run.status ?? "spawn-error"}): ${command}`);
      }
    }
    const provision = { path: worktreePath, branch };
    // The setup log must be durable before state initialization begins. A
    // fallible finally block after the callback could otherwise delete a
    // worktree whose state was already recorded.
    writeSetupLog();
    return initializePrepared(provision);
  } catch (error) {
    const primary = error instanceof Error ? error : new Error(String(error));
    const cleanupProblems = cleanup();
    let logProblem: Error | null = null;
    try {
      writeSetupLog();
    } catch (logError) {
      logProblem = logError instanceof Error ? logError : new Error(String(logError));
    }
    if (cleanupProblems.length > 0 || logProblem !== null) {
      const cleanupDetail = cleanupProblems.map((problem) => problem.message).join("; ");
      const logDetail = logProblem === null ? "" : `setup log write failed: ${logProblem.message}`;
      const secondary = [cleanupDetail, logDetail].filter(Boolean).join("; ");
      throw new AggregateError(
        [primary, ...cleanupProblems, ...(logProblem === null ? [] : [logProblem])],
        `worktree provisioning failed: ${primary.message}; cleanup was incomplete: ${secondary}`,
      );
    }
    throw error;
  }
}
