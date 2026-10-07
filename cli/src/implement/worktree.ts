import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import { loadConfig } from "../config";

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
  const listed = git(root, ["worktree", "list", "--porcelain", "-z"]);
  if (listed.status !== 0) return [];
  const self = fs.realpathSync(root);
  return listed.stdout.split("\0")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
    .filter((tree) => fs.existsSync(tree))
    .map((tree) => fs.realpathSync(tree))
    .filter((tree) => tree !== self);
}

export type CurrentGit = { available: false; reason: string } | {
  available: true; headSha: string; branch: string; baseRef: string; baseTipSha: string; baseSha: string;
};

function requiredGit(root: string, args: string[], label: string): string {
  const result = git(root, args);
  if (result.error !== undefined || result.status !== 0 || result.stdout.trim() === "") {
    throw new Error(`${label}: ${(result.stderr || result.error?.message || "Git returned no result").trim()}`);
  }
  return result.stdout.trim();
}

/** Live Git identity is an input, never a cached start-time authority. */
export function currentGit(root: string): CurrentGit {
  const inside = git(root, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.error !== undefined || inside.status !== 0 || inside.stdout.trim() !== "true") {
    if (fs.existsSync(`${root}/.git`)) throw new Error(`cannot inspect record checkout Git identity: ${inside.stderr || inside.error?.message}`);
    return { available: false, reason: "checkout is not a Git worktree" };
  }
  const head = git(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (head.status !== 0) return { available: false, reason: "Git HEAD has no commit" };
  const branchRef = requiredGit(root, ["symbolic-ref", "--quiet", "HEAD"], "Git HEAD is detached; attach the record checkout to its intended branch");
  if (!branchRef.startsWith("refs/heads/")) throw new Error("Git HEAD does not name an attached local branch");
  const branch = branchRef.slice("refs/heads/".length);
  const baseBranch = loadConfig(root).delivery.baseBranch;
  if (git(root, ["check-ref-format", `refs/heads/${baseBranch}`]).status !== 0) throw new Error(`invalid delivery.baseBranch: ${baseBranch}`);
  const remotes = git(root, ["remote"]);
  if (remotes.error !== undefined || remotes.status !== 0) throw new Error(`cannot inspect configured Git remotes: ${remotes.stderr}`);
  const baseRef = remotes.stdout.split("\n").includes("origin") ? `refs/remotes/origin/${baseBranch}` : `refs/heads/${baseBranch}`;
  const baseTipSha = requiredGit(root, ["rev-parse", "--verify", `${baseRef}^{commit}`], `delivery base ref is missing (${baseRef}); restore or fetch it before verifying`);
  const bases = requiredGit(root, ["merge-base", "--all", head.stdout.trim(), baseTipSha], "cannot resolve delivery merge-base").split("\n");
  if (bases.length !== 1) throw new Error("delivery merge-base is ambiguous; resolve the branch history before verifying");
  return { available: true, headSha: head.stdout.trim(), branch, baseRef, baseTipSha, baseSha: bases[0]! };
}
