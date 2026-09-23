#!/usr/bin/env node

// Save dirty repository state outside branch history when an agent turn stops.
//
// Optional environment contract:
// - AGENT_CHECKPOINT=0 disables the hook for the current process.
// - SASU_HOOK_LOG overrides the bounded JSONL log path.
//
// The hook always exits zero so recovery trouble cannot block a session.
// Failures are returned as a visible system message and recorded without file
// names or contents. The real Git index, HEAD and working tree are never used
// as write targets.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ZERO_OID = "0".repeat(40);
const MAX_CHANGED_PATHS = 10_000;
const MAX_PATHSPEC_BYTES = 8 * 1024 * 1024;
const MAX_CAPTURED_FILE_BYTES = 10 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_LOG_BYTES = 1024 * 1024;
const DEFAULT_LOG = path.join(os.homedir(), ".sasu", "hooks.jsonl");

class CheckpointError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function readPayload() {
  if (process.stdin.isTTY) return {};
  try {
    const value = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function runGit(cwd, args, { env = process.env, input, allowFailure = false } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    env: { ...env, GIT_TERMINAL_PROMPT: "0" },
    input,
    encoding: null,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
  if (result.error) throw new CheckpointError("git-unavailable", "Git could not be started");
  if (!allowFailure && result.status !== 0) {
    throw new CheckpointError("git-command-failed", `Git command failed: ${args[0]}`);
  }
  return result;
}

function outputText(result) {
  return Buffer.from(result.stdout || "").toString("utf8").trim();
}

function resolveGitPath(root, value) {
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

function subjectId(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function splitNull(buffer) {
  return Buffer.from(buffer || "")
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function isSecretLike(relativePath) {
  const normalized = relativePath.replaceAll(path.sep, "/");
  const base = path.posix.basename(normalized);
  if (/\.(?:example|sample|template)$/i.test(base)) return false;
  if (base === ".env" || base.startsWith(".env.") || base === ".npmrc") return true;
  if (/id_(?:rsa|ed25519|ecdsa)/i.test(base)) return true;
  if (/\.(?:pem|key|p12|pfx|keystore|jks)$/i.test(base)) return true;
  return base.endsWith("credentials.json") || base === "auth.json";
}

function classifyPaths(root, paths) {
  const included = [];
  let excludedSecrets = 0;
  let excludedLargeFiles = 0;
  for (const relativePath of paths) {
    if (isSecretLike(relativePath)) {
      excludedSecrets += 1;
      continue;
    }
    try {
      const stat = fs.lstatSync(path.join(root, relativePath));
      if (stat.isFile() && stat.size > MAX_CAPTURED_FILE_BYTES) {
        excludedLargeFiles += 1;
        continue;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    included.push(relativePath);
  }
  return { included, excludedSecrets, excludedLargeFiles };
}

function currentRef(root, ref) {
  const result = runGit(root, ["rev-parse", "--verify", "-q", ref], { allowFailure: true });
  return result.status === 0 ? outputText(result) : null;
}

function treeFor(root, revision) {
  const result = runGit(root, ["rev-parse", "--verify", `${revision}^{tree}`], { allowFailure: true });
  return result.status === 0 ? outputText(result) : null;
}

function parentFor(root, revision) {
  const result = runGit(root, ["rev-parse", "--verify", `${revision}^`], { allowFailure: true });
  return result.status === 0 ? outputText(result) : null;
}

function updateRef(root, ref, next, previous) {
  const args = next
    ? ["update-ref", ref, next, previous || ZERO_OID]
    : ["update-ref", "-d", ref, previous];
  const result = runGit(root, args, { allowFailure: true });
  return result.status === 0;
}

function changedPaths(root) {
  const tracked = splitNull(runGit(root, ["diff", "--name-only", "-z", "HEAD", "--"]).stdout);
  const untracked = splitNull(runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]).stdout);
  const paths = [...new Set([...tracked, ...untracked])];
  const bytes = paths.reduce((total, entry) => total + Buffer.byteLength(entry) + 1, 0);
  if (paths.length > MAX_CHANGED_PATHS || bytes > MAX_PATHSPEC_BYTES) {
    throw new CheckpointError("changed-set-too-large", "The changed path set exceeds the recovery snapshot limit");
  }
  return paths;
}

function checkpoint(cwd) {
  const probe = runGit(cwd, ["rev-parse", "--show-toplevel"], { allowFailure: true });
  if (probe.status !== 0) return null;
  const root = outputText(probe);
  const gitDir = resolveGitPath(root, outputText(runGit(root, ["rev-parse", "--absolute-git-dir"])));
  const commonDir = resolveGitPath(root, outputText(runGit(root, ["rev-parse", "--git-common-dir"])));
  if (fs.existsSync(path.join(gitDir, "no-checkpoint"))) return null;
  const worktreeId = subjectId(gitDir);
  const repositoryId = subjectId(commonDir);
  const ref = `refs/sasu/checkpoints/${worktreeId}`;
  const context = { repositoryId, worktreeId, ref };

  try {
    const headProbe = runGit(root, ["rev-parse", "--verify", "-q", "HEAD"], { allowFailure: true });
    if (headProbe.status !== 0) throw new CheckpointError("no-head", "The repository has no initial commit");
    const head = outputText(headProbe);

    for (const marker of ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "BISECT_LOG", "REVERT_HEAD"]) {
      const markerPath = resolveGitPath(root, outputText(runGit(root, ["rev-parse", "--git-path", marker])));
      if (fs.existsSync(markerPath)) {
        return { event: "recovery-checkpoint.skipped", ...context, reason: "git-operation-in-progress", marker };
      }
    }
    const paths = changedPaths(root);
    const classified = classifyPaths(root, paths);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-checkpoint-"));
    try {
      const tempIndex = path.join(tempDir, "index");
      const tempEnv = {
        ...process.env,
        GIT_INDEX_FILE: tempIndex,
        GIT_LITERAL_PATHSPECS: "1",
        GIT_OPTIONAL_LOCKS: "0",
      };
      runGit(root, ["read-tree", "HEAD"], { env: tempEnv });
      if (classified.included.length > 0) {
        const pathspec = Buffer.from(`${classified.included.join("\0")}\0`);
        runGit(root, ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], { env: tempEnv, input: pathspec });
      }
      const tree = outputText(runGit(root, ["write-tree"], { env: tempEnv }));
      const headTree = treeFor(root, head);
      const previous = currentRef(root, ref);

      if (tree === headTree) {
        if (!previous) {
          if (paths.length === 0) return null;
          return {
            event: "recovery-checkpoint.skipped",
            ...context,
            head,
            reason: "no-eligible-paths",
            changedPaths: paths.length,
            excludedSecrets: classified.excludedSecrets,
            excludedLargeFiles: classified.excludedLargeFiles,
          };
        }
        if (!updateRef(root, ref, null, previous) && currentRef(root, ref)) {
          throw new CheckpointError("ref-race", "The recovery reference changed while it was being cleared");
        }
        return {
          event: "recovery-checkpoint.cleared",
          ...context,
          head,
          changedPaths: paths.length,
          excludedSecrets: classified.excludedSecrets,
          excludedLargeFiles: classified.excludedLargeFiles,
        };
      }

      if (previous && treeFor(root, previous) === tree && parentFor(root, previous) === head) return null;
      const identityEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: "Sasu recovery checkpoint",
        GIT_AUTHOR_EMAIL: "checkpoint@local",
        GIT_COMMITTER_NAME: "Sasu recovery checkpoint",
        GIT_COMMITTER_EMAIL: "checkpoint@local",
      };
      const commit = outputText(runGit(root, ["commit-tree", tree, "-p", head], {
        env: identityEnv,
        input: Buffer.from(`Hidden recovery checkpoint ${worktreeId}\n`),
      }));
      if (!updateRef(root, ref, commit, previous)) {
        const converged = currentRef(root, ref);
        if (!converged || treeFor(root, converged) !== tree || parentFor(root, converged) !== head) {
          throw new CheckpointError("ref-race", "The recovery reference changed while it was being saved");
        }
      }
      return {
        event: "recovery-checkpoint.saved",
        ...context,
        head,
        tree,
        changedPaths: paths.length,
        capturedPaths: classified.included.length,
        excludedSecrets: classified.excludedSecrets,
        excludedLargeFiles: classified.excludedLargeFiles,
      };
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  } catch (error) {
    error.checkpointContext = context;
    throw error;
  }
}

function appendLog(event) {
  const file = process.env.SASU_HOOK_LOG || DEFAULT_LOG;
  const line = `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`;
  if (Buffer.byteLength(line) > MAX_LOG_BYTES) {
    throw new CheckpointError("log-event-too-large", "A recovery log event exceeds its size limit");
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let size = 0;
  try { size = fs.statSync(file).size; } catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (size + Buffer.byteLength(line) > MAX_LOG_BYTES) {
    const rotated = `${file}.1`;
    fs.rmSync(rotated, { force: true });
    if (size > 0 && size <= MAX_LOG_BYTES) fs.renameSync(file, rotated);
    else if (size > MAX_LOG_BYTES) fs.rmSync(file, { force: true });
  }
  fs.appendFileSync(file, line, { mode: 0o600 });
}

function visibleWarning(message) {
  process.stdout.write(`${JSON.stringify({ systemMessage: message })}\n`);
}

function main() {
  if (process.env.AGENT_CHECKPOINT === "0") return;
  const payload = readPayload();
  const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
  const attemptId = crypto.randomUUID();
  try {
    const event = checkpoint(cwd);
    if (!event) return;
    try {
      appendLog({ attemptId, ...event });
    } catch {
      visibleWarning("The recovery snapshot completed, but its bounded log could not be written.");
    }
  } catch (error) {
    const code = error instanceof CheckpointError ? error.code : "unexpected-error";
    try { appendLog({ event: "recovery-checkpoint.failed", attemptId, ...error?.checkpointContext, code }); } catch {}
    visibleWarning("The recovery snapshot failed. Your Git HEAD, index, and working files were left unchanged. See the Sasu hook log for details.");
  }
}

try {
  main();
} finally {
  process.exitCode = 0;
}
