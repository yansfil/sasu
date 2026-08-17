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

/**
 * Create the run's isolated judged tree: a git worktree on a fresh branch at
 * the record tree's HEAD, prepared with the configured secrets sync. The
 * branch name matches ship's default (`prd/<slug>`) so PR delivery picks it
 * up without configuration. Provisioning is all-or-nothing: a failed setup
 * command removes the worktree and branch again so a re-run of `implement
 * start` does not trip over half-provisioned debris (assume every operation
 * runs twice); the setup log survives under the run's log directory.
 */
export function provisionWorktree(
  recordRoot: string,
  slug: string,
  runDirAbsolute: string,
  config: WorktreeConfig,
  commandTimeoutMs: number,
): WorktreeProvision {
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
  const cleanup = (): void => {
    git(recordRoot, ["worktree", "remove", "--force", worktreePath]);
    git(recordRoot, ["branch", "-D", branch]);
  };
  const logLines: string[] = [];
  try {
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
    return { path: worktreePath, branch };
  } catch (error) {
    cleanup();
    throw error;
  } finally {
    if (logLines.length > 0) {
      const logDir = path.join(runDirAbsolute, "artifacts", "logs");
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(path.join(logDir, "worktree-setup.log"), `${logLines.join("\n")}\n`);
    }
  }
}
