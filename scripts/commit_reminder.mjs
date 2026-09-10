#!/usr/bin/env node

// Advisory only: the CLI remains the sole writer of run state and completion.
// User-selected thresholds replace a repeated prose reminder, not a proof stage.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const CHECK_INTERVAL = 30_000;
const NOTICE_INTERVAL = 10 * 60_000;
const MAX_BYTES = 8 * 1024 * 1024;
const TOOLS = new Set(["Write", "Edit", "MultiEdit", "Bash", "apply_patch", "exec_command", "write_stdin", "shell", "shell_command"]);
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function read(file, limit = MAX_BYTES) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > limit) throw new Error("unavailable regular file");
  return fs.readFileSync(file);
}

function git(root, args, deadline, { binary = false, diff = false, missing = false } = {}) {
  const timeout = Math.min(1_000, deadline - Date.now());
  if (timeout < 1) throw new Error("check deadline");
  const result = spawnSync("git", ["--no-optional-locks", ...args], {
    cwd: root, encoding: binary ? undefined : "utf8", timeout, maxBuffer: MAX_BYTES,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
  if (!result.error && missing && result.status === 1) return null;
  if (result.error || (result.status !== 0 && !(diff && result.status === 1))) throw new Error("git unavailable");
  return result.stdout;
}

function projectRoot(cwd) {
  let root = fs.realpathSync(cwd);
  while (!fs.existsSync(path.join(root, "agents")) && !fs.existsSync(path.join(root, ".git"))) {
    const parent = path.dirname(root);
    if (parent === root) throw new Error("no project");
    root = parent;
  }
  return root;
}

function sourcePath(root, relative) {
  if (!relative || relative.split("/")[0] === "agents" || path.isAbsolute(relative)) return null;
  const absolute = path.resolve(root, relative);
  if (!absolute.startsWith(`${root}${path.sep}`)) return null;
  // A regular leaf underneath a symlink is still outside the fixed source tree.
  let parent = path.dirname(absolute);
  while (parent !== root) {
    if (fs.existsSync(parent) && fs.realpathSync(parent) !== parent) return null;
    parent = path.dirname(parent);
  }
  return absolute;
}

async function main() {
  const payload = JSON.parse(readStdin());
  if (payload?.hook_event_name !== "PostToolUse" || !TOOLS.has(payload.tool_name)
    || typeof payload.cwd !== "string" || typeof payload.session_id !== "string") return;
  const [{ parseImplementState, requireWorkRoot }, { activePointerReadPath }, { currentSessionId, currentHerdrRole }, { IMPLEMENT_ACTIVE_SCHEMA }] = await Promise.all([
    import("../cli/dist/implement/store.js"), import("../cli/dist/runs/paths.js"),
    import("../cli/dist/runs/session.js"), import("../cli/dist/implement/types.js"),
  ]);
  const session = currentSessionId({ CODEX_SESSION_ID: payload.session_id });
  const environmentSession = currentSessionId();
  if (!session || (environmentSession && session !== environmentSession)) return;
  if ((process.env.HERDR_PANE_ID || process.env.HERDR_ENV === "1") && currentHerdrRole() !== "implementor") return;
  const root = projectRoot(payload.cwd);
  const pointer = JSON.parse(read(activePointerReadPath(root, session), 64 * 1024));
  if (pointer.schema !== IMPLEMENT_ACTIVE_SCHEMA || typeof pointer.statePath !== "string") return;
  const recordRoot = fs.realpathSync(pointer.projectRoot ?? root);
  const statePath = path.resolve(recordRoot, pointer.statePath);
  if (!statePath.startsWith(path.join(recordRoot, "agents", "runs") + path.sep)) return;
  const stateBytes = read(statePath);
  const state = parseImplementState(stateBytes.toString());
  if (state.status !== "active" || state.ownerSessionId !== session || state.activeVerification) return;
  const workRoot = fs.realpathSync(requireWorkRoot(state));
  // `implement start` already isolates a second active run from an occupied
  // tree. Reuse that invariant and current owner/worktree identity; rescanning
  // lifetime run history here would make advice slower as a project matures.
  if (workRoot !== root || fs.realpathSync(state.projectRoot) !== recordRoot) return;
  const runDir = path.dirname(statePath);
  if (fs.realpathSync(runDir) !== runDir || path.resolve(recordRoot, state.runDir) !== runDir) return;

  const cachePath = path.join(runDir, "commit-reminder.json");
  let cache = {};
  try { cache = JSON.parse(read(cachePath, 512 * 1024)); } catch { /* An absent advisory cache is normal. */ }
  const now = Date.now();
  if (cache.session === session && Number.isFinite(cache.checkedAt) && now - cache.checkedAt < CHECK_INTERVAL) return;
  // One cache lock prevents simultaneous PostToolUse completions duplicating a
  // reminder. A crashed hook can only delay advice, never a workflow command.
  const lock = `${cachePath}.lock`;
  try { fs.mkdirSync(lock); } catch {
    if (!fs.lstatSync(lock).isDirectory() || now - fs.lstatSync(lock).mtimeMs < CHECK_INTERVAL) return;
    fs.rmdirSync(lock);
    fs.mkdirSync(lock);
  }
  try {
    try { cache = JSON.parse(read(cachePath, 512 * 1024)); } catch { cache = {}; }
    if (cache.session === session && Number.isFinite(cache.checkedAt) && now - cache.checkedAt < CHECK_INTERVAL) return;
    if (cache.session !== session) cache = {};
    const save = () => {
      const temp = `${cachePath}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(cache), { flag: "wx" });
      fs.renameSync(temp, cachePath);
    };
    cache = { ...cache, session, checkedAt: now };
    save();
    const deadline = now + 4_000;
    const attribution = new Map();
    for (const entry of state.baselineAttribution.paths) {
      if (attribution.has(entry.path)) return;
      attribution.set(entry.path, entry.disposition);
    }
    const owned = (relative) => attribution.get(relative) !== "pre-existing";
    const head = git(root, ["rev-parse", "--verify", "--quiet", "HEAD"], deadline, { missing: true })?.trim() ?? null;
    if (head === null) {
      // A symbolic HEAD whose branch does not exist is an unborn repository.
      // Other lookup failures stay unavailable instead of becoming an empty base.
      if (git(root, ["rev-parse", "--is-inside-work-tree"], deadline).trim() !== "true") return;
      const branch = git(root, ["symbolic-ref", "--quiet", "HEAD"], deadline).trim();
      if (git(root, ["show-ref", "--verify", "--quiet", branch], deadline, { missing: true }) !== null) return;
    }
    if (cache.head !== head) cache = { session, checkedAt: now, head, notified: [] };
    const headFiles = new Map();
    for (const row of (head === null ? "" : git(root, ["ls-tree", "-r", "-z", "HEAD"], deadline)).split("\0").filter(Boolean)) {
      const match = /^(\d+) \S+ ([a-f0-9]+)\t([\s\S]+)$/.exec(row);
      if (!match) return;
      headFiles.set(match[3], { regular: match[1] === "100644" || match[1] === "100755", object: match[2] });
    }
    const changes = new Map();
    const stats = head === null ? "" : git(root, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--numstat", "-z", "HEAD", "--"], deadline);
    for (const row of stats.split("\0").filter(Boolean)) {
      const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(row);
      if (!match) return;
      const [, added, deleted, relative] = match;
      if (owned(relative)) changes.set(relative, added === "-" ? 0 : Number(added) + Number(deleted));
    }
    const untracked = git(root, ["ls-files", ...(head === null ? ["--cached"] : []), "--others", "--exclude-standard", "-z"], deadline).split("\0").filter(Boolean);
    const recreated = new Set();
    for (const relative of untracked) {
      if (headFiles.has(relative)) recreated.add(relative);
      if (owned(relative)) changes.set(relative, null);
    }
    if (changes.size > 1_000) return;
    const content = [];
    let lines = 0, bytes = 0;
    for (const [relative, delta] of [...changes].sort(([a], [b]) => a.localeCompare(b))) {
      if (Date.now() > deadline) return;
      const absolute = sourcePath(root, relative);
      if (!absolute) continue;
      let data;
      try { data = read(absolute); } catch (error) {
        if (error.code !== "ENOENT" || delta === null) continue;
      }
      if (!data && !headFiles.get(relative)?.regular) continue;
      bytes += data?.length ?? 0;
      if (bytes > 32 * 1024 * 1024) return;
      const fileHash = data ? hash(data) : null;
      let changedLines = delta;
      if (recreated.has(relative)) {
        const before = git(root, ["cat-file", "blob", headFiles.get(relative).object], deadline, { binary: true });
        if (before.equals(data)) continue;
        const scratch = fs.mkdtempSync(path.join(runDir, "commit-reminder-diff-"));
        try {
          const old = path.join(scratch, "before"), current = path.join(scratch, "after");
          fs.writeFileSync(old, before); fs.writeFileSync(current, data);
          const stats = git(root, ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--numstat", "--", old, current], deadline, { diff: true });
          const match = /^(\d+|-)\t(\d+|-)\t/.exec(stats);
          if (!match) return;
          changedLines = match[1] === "-" ? 0 : Number(match[1]) + Number(match[2]);
        } finally { fs.rmSync(scratch, { recursive: true }); }
      }
      if (changedLines === null) lines += data.includes(0) ? 0 : data.length === 0 ? 0 : data.toString().split("\n").length - (data.at(-1) === 10 ? 1 : 0);
      else lines += changedLines;
      content.push([relative, fileHash ?? "deleted"]);
    }
    const digest = hash(JSON.stringify(content));
    if (content.length < 10 && lines < 500) { save(); return; }
    if (cache.notified?.length >= 4_096 || cache.notified?.includes(digest)
      || (cache.notifiedAt && now - cache.notifiedAt < NOTICE_INTERVAL)) { save(); return; }
    // Recheck authority after Git reads: a lease, adoption, or close that began
    // during the check must not receive an implementation reminder.
    if (!read(statePath).equals(stateBytes)) return;
    cache.notified = [...(cache.notified ?? []), digest];
    cache.notifiedAt = now;
    save();
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: `This active implementation run has ${content.length} attributable uncommitted files and ${lines} added/deleted lines. Consider a coherent local commit of your own finished changes. If you are still integrating, continue working. This is a reminder only: do not commit automatically, include foreign or pre-existing changes, push, or claim completion. Keep the required verification and receipt workflow.`,
    } })}\n`);
  } finally { fs.rmdirSync(lock); }
}

function readStdin() {
  // Hook payloads can contain large tool output. Bound input before parsing it.
  const chunks = []; let size = 0;
  const buffer = Buffer.alloc(64 * 1024);
  for (;;) {
    const count = fs.readSync(0, buffer, 0, buffer.length, null);
    if (!count) break;
    size += count;
    if (size > MAX_BYTES) throw new Error("oversized hook payload");
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  return Buffer.concat(chunks).toString();
}

// Unsupported input or unavailable state is explicitly a quiet, exit-zero
// outcome for this optional advisory hook, never an implementation failure.
main().catch(() => {});
