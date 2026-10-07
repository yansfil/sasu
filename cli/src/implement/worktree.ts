import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";

function git(recordRoot: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync("git", args, { cwd: recordRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 60_000 });
}
/**
 * Every other worktree of the repository that contains `root`, as real
 * paths; none when `root` is not inside a git tree. macOS hands out
 * `/var/folders/...` while git reports `/private/var/...`, so both sides
 * are resolved before the tree itself is excluded.
 */
export function siblingWorktrees(root: string): string[] {
  const listed = git(root, ["worktree", "list", "--porcelain"]);
  if (listed.status !== 0) return [];
  const self = fs.realpathSync(root);
  return listed.stdout.split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
    .filter((tree) => fs.existsSync(tree))
    .map((tree) => fs.realpathSync(tree))
    .filter((tree) => tree !== self);
}
