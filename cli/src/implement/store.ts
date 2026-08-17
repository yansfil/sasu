import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  IMPLEMENT_ACTIVE_SCHEMA,
  IMPLEMENT_SCHEMA,
  type ImplementActivePointer,
  type ImplementState,
  type SourceEntry,
  type SourceSnapshot,
} from "./types";
import { ACTIVE_POINTER_REL, activePointerReadPath, activePointerWriteRel, implementStatePathFor } from "../runs/paths";
import { currentSessionId } from "../runs/session";

export const ACTIVE_POINTER = ACTIVE_POINTER_REL;

export function nowIso(): string {
  return new Date().toISOString();
}

export function sha256(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function normalizeProjectPath(projectRoot: string, input: string): { absolute: string; relative: string } {
  const absolute = path.resolve(projectRoot, input);
  const relative = path.relative(projectRoot, absolute).split(path.sep).join("/");
  if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error(`path escapes project root: ${input}`);
  }
  return { absolute, relative: relative || "." };
}

export function writeJsonAtomic(file: string, value: unknown): void {
  writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeTextAtomic(file: string, value: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, value);
  fs.renameSync(temporary, file);
}

export function statePathFor(projectRoot: string, slug: string): string {
  return implementStatePathFor(projectRoot, slug);
}

export function writeActivePointer(projectRoot: string, state: ImplementState, sessionId: string | null = currentSessionId()): void {
  const statePathRel = path.relative(projectRoot, statePathFor(projectRoot, state.topicSlug)).split(path.sep).join("/");
  const pointer: ImplementActivePointer = {
    schema: IMPLEMENT_ACTIVE_SCHEMA,
    statePath: statePathRel,
    topicSlug: state.topicSlug,
    updatedAt: nowIso(),
  };
  writeJsonAtomic(path.join(projectRoot, activePointerWriteRel(sessionId)), pointer);
  // A worktree run gets a second bookmark inside its judged tree, carrying an
  // explicit record-tree root: bare commands typed from either tree then
  // resolve the same record. Bookmarks are navigation, not authority, so the
  // duplicate is harmless; ownership lives in state.json alone.
  const worktreePath = state.worktree?.path;
  if (worktreePath !== undefined && fs.existsSync(worktreePath)) {
    writeJsonAtomic(path.join(worktreePath, activePointerWriteRel(sessionId)), { ...pointer, projectRoot });
  }
}

/** Slugs with a recorded run, unified or legacy - the `--slug` menu for a session with no pointer. */
function runCandidates(projectRoot: string): string[] {
  const slugs = new Set<string>();
  for (const namespace of [path.join("agents", "runs"), path.join("agents", "implement")]) {
    const dir = path.join(projectRoot, namespace);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, "state.json"))) slugs.add(entry.name);
    }
  }
  return [...slugs].sort();
}

export function resolveStatePath(projectRoot: string, options: { slug?: string; state?: string } = {}): string {
  if (options.state !== undefined) return normalizeProjectPath(projectRoot, options.state).absolute;
  if (options.slug !== undefined) return statePathFor(projectRoot, options.slug);
  const pointerPath = activePointerReadPath(projectRoot, currentSessionId());
  if (!fs.existsSync(pointerPath)) {
    const candidates = runCandidates(projectRoot);
    const menu = candidates.length === 0 ? "" : ` (existing runs: ${candidates.join(", ")})`;
    throw new Error(`no active implement run for this session; pass --slug <topic>${menu} or start one with \`sasu implement start --prd <path>\``);
  }
  const parsed = JSON.parse(fs.readFileSync(pointerPath, "utf8")) as Partial<ImplementActivePointer>;
  if (parsed.schema !== IMPLEMENT_ACTIVE_SCHEMA || typeof parsed.statePath !== "string") {
    throw new Error(`unsupported active pointer schema in ${ACTIVE_POINTER}; start a new run with \`sasu implement start --prd <path>\``);
  }
  // A redirect bookmark (inside a run's worktree) names its record tree.
  const recordRoot = typeof parsed.projectRoot === "string" && parsed.projectRoot !== "" ? parsed.projectRoot : projectRoot;
  return normalizeProjectPath(recordRoot, parsed.statePath).absolute;
}

/**
 * The tree whose bytes are judged: the run's worktree when isolated, else
 * the record tree. Fails loudly when the worktree is gone - a silently
 * substituted record tree would judge the wrong bytes and stale every proof.
 */
export function requireWorkRoot(state: ImplementState): string {
  const worktree = state.worktree ?? null;
  if (worktree === null) return state.projectRoot;
  if (!fs.existsSync(worktree.path)) {
    throw new Error(
      `worktree missing: ${worktree.path}. Recreate it with \`git worktree add ${worktree.path} ${worktree.branch}\` ` +
        "(uncommitted work in the removed worktree is lost) and continue, or close the run honestly",
    );
  }
  return worktree.path;
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`malformed implement state: ${label} must be a non-empty string`);
}

export function loadState(projectRoot: string, options: { slug?: string; state?: string } = {}): { statePath: string; state: ImplementState } {
  const statePath = resolveStatePath(projectRoot, options);
  if (!fs.existsSync(statePath)) throw new Error(`implement state not found: ${path.relative(projectRoot, statePath)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch (error) {
    throw new Error(`malformed implement state JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== "object") throw new Error("malformed implement state: root must be an object");
  const candidate = parsed as Partial<ImplementState> & { schema?: unknown };
  if (candidate.schema !== IMPLEMENT_SCHEMA) {
    throw new Error(
      `unsupported implement state schema ${String(candidate.schema ?? "missing")}; this version accepts only ${IMPLEMENT_SCHEMA}. Start a new run with \`sasu implement start --prd <path>\``,
    );
  }
  assertString(candidate.topicSlug, "topicSlug");
  assertString(candidate.projectRoot, "projectRoot");
  assertString(candidate.prdPath, "prdPath");
  if (!Array.isArray(candidate.tasks) || !Array.isArray(candidate.acceptanceCriteria) || !Array.isArray(candidate.verification)) {
    throw new Error("malformed implement state: tasks, acceptanceCriteria, and verification must be arrays");
  }
  if (!Array.isArray(candidate.artifacts) || !Array.isArray(candidate.verificationAttempts)) {
    throw new Error("malformed implement state: artifacts and verificationAttempts must be arrays");
  }
  return { statePath, state: candidate as ImplementState };
}

export function persistState(statePath: string, state: ImplementState): void {
  state.updatedAt = nowIso();
  writeJsonAtomic(statePath, state);
  writeActivePointer(state.projectRoot, state);
}

const SNAPSHOT_EXCLUDES = new Set([".git", "node_modules", "dist", "coverage", ".next", ".turbo"]);

function repositoryHead(projectRoot: string): string | null {
  const dotGit = path.join(projectRoot, ".git");
  try {
    const stat = fs.statSync(dotGit);
    if (!stat.isDirectory()) return null;
    const rawHead = fs.readFileSync(path.join(dotGit, "HEAD"), "utf8").trim();
    if (!rawHead.startsWith("ref: ")) return rawHead || null;
    const ref = rawHead.slice(5);
    return fs.readFileSync(path.join(dotGit, ref), "utf8").trim() || null;
  } catch {
    return null;
  }
}

function sourceFiles(projectRoot: string): string[] {
  const files: string[] = [];
  const visit = (absoluteDir: string, relativeDir: string): void => {
    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const relative = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SNAPSHOT_EXCLUDES.has(entry.name) || (relativeDir === "" && entry.name === "agents")) continue;
        visit(path.join(absoluteDir, entry.name), relative);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  };
  visit(projectRoot, "");
  return files.sort();
}

export function captureSourceSnapshot(projectRoot: string): SourceSnapshot {
  const head = repositoryHead(projectRoot);
  const entries: SourceEntry[] = sourceFiles(projectRoot).map((relative) => ({
    path: relative,
    state: "present",
    sha256: sha256(fs.readFileSync(path.join(projectRoot, relative))),
  }));
  // A commit of unchanged bytes must not stale proof. HEAD remains useful
  // provenance, while the freshness digest names the judged content only.
  return { head, entries, digest: sha256(JSON.stringify({ entries })) };
}

function snapshotExcluded(relative: string): boolean {
  const segments = relative.split("/");
  if (segments[0] === "agents") return true;
  return segments.some((segment) => SNAPSHOT_EXCLUDES.has(segment));
}

/**
 * The baseline a run's "run-owned changes" are diffed against. The working
 * tree at `implement start` is wrong for that role: a run restarted after the
 * implementation was written snapshots the finished tree and every judge then
 * sees "No run-owned source changes" (2026-08-13 creator-assist: four
 * restarted runs, each burning its first verify round on judges failing the
 * empty diff). The committed HEAD content is the pinned pre-run state, so
 * work-in-progress stays attributed to the run across restarts. Only dirty
 * paths are resolved against HEAD; clean files already match it byte-for-byte.
 * Without git (or when git fails) the working tree is the only baseline there
 * is, which restores the old behavior for non-repository projects.
 */
export function captureBaselineSnapshot(projectRoot: string): SourceSnapshot {
  const working = captureSourceSnapshot(projectRoot);
  if (working.head === null) return working;
  const status = spawnSync("git", ["status", "--porcelain", "-z", "--untracked-files=all"], {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (status.error !== undefined || status.status !== 0) return working;
  const dirty = new Set<string>();
  const tokens = status.stdout.split("\0").filter((token) => token !== "");
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    dirty.add(token.slice(3));
    // Renames and copies carry the origin path as the next NUL-separated
    // token; both sides differ from HEAD.
    if (token[0] === "R" || token[0] === "C") {
      index += 1;
      const origin = tokens[index];
      if (origin !== undefined) dirty.add(origin);
    }
  }
  const entries = new Map(working.entries.map((entry) => [entry.path, entry]));
  for (const relative of dirty) {
    if (snapshotExcluded(relative)) continue;
    const show = spawnSync("git", ["show", `HEAD:${relative}`], {
      cwd: projectRoot,
      maxBuffer: 256 * 1024 * 1024,
    });
    if (show.error === undefined && show.status === 0) {
      entries.set(relative, { path: relative, state: "present", sha256: sha256(show.stdout) });
    } else {
      // Absent at HEAD: the file is run-owned work, not baseline content.
      entries.delete(relative);
    }
  }
  const sorted = [...entries.values()].sort((left, right) => left.path.localeCompare(right.path));
  return { head: working.head, entries: sorted, digest: sha256(JSON.stringify({ entries: sorted })) };
}

export function changedPathsSince(initial: SourceSnapshot, current: SourceSnapshot): string[] {
  const before = new Map(initial.entries.map((entry) => [entry.path, `${entry.state}\0${entry.sha256 ?? ""}`]));
  const after = new Map(current.entries.map((entry) => [entry.path, `${entry.state}\0${entry.sha256 ?? ""}`]));
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((entry) => before.get(entry) !== after.get(entry)).sort();
}

export function artifactIntegrityProblems(projectRoot: string, state: ImplementState, currentSource: SourceSnapshot): string[] {
  const problems: string[] = [];
  for (const artifact of state.artifacts) {
    let absolute: string;
    try {
      absolute = normalizeProjectPath(projectRoot, artifact.path).absolute;
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    if (!fs.existsSync(absolute)) {
      problems.push(`${artifact.verificationId}: artifact missing: ${artifact.path}`);
      continue;
    }
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size <= 0) {
      problems.push(`${artifact.verificationId}: artifact is empty or not a file: ${artifact.path}`);
      continue;
    }
    const actual = sha256(fs.readFileSync(absolute));
    if (actual !== artifact.sha256) problems.push(`${artifact.verificationId}: artifact hash changed: ${artifact.path}`);
    if (artifact.sourceFingerprint !== currentSource.digest) {
      problems.push(`${artifact.verificationId}: artifact is stale because the judged source changed: ${artifact.path}`);
    }
  }
  return problems;
}
