import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  IMPLEMENT_ACTIVE_SCHEMA,
  IMPLEMENT_SCHEMA,
  type ImplementActivePointer,
  type ImplementState,
  type SourceEntry,
  type SourceSnapshot,
} from "./types";

export const ACTIVE_POINTER = path.join("agents", "implement", ".prd-implement-active.json");

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
  return path.join(projectRoot, "agents", "implement", slug, "state.json");
}

export function writeActivePointer(projectRoot: string, state: ImplementState): void {
  const pointer: ImplementActivePointer = {
    schema: IMPLEMENT_ACTIVE_SCHEMA,
    statePath: path.relative(projectRoot, statePathFor(projectRoot, state.topicSlug)).split(path.sep).join("/"),
    topicSlug: state.topicSlug,
    updatedAt: nowIso(),
  };
  writeJsonAtomic(path.join(projectRoot, ACTIVE_POINTER), pointer);
}

export function resolveStatePath(projectRoot: string, options: { slug?: string; state?: string } = {}): string {
  if (options.state !== undefined) return normalizeProjectPath(projectRoot, options.state).absolute;
  if (options.slug !== undefined) return statePathFor(projectRoot, options.slug);
  const pointerPath = path.join(projectRoot, ACTIVE_POINTER);
  if (!fs.existsSync(pointerPath)) {
    throw new Error("no active implement run; pass --slug <topic> or start one with `sasu implement start --prd <path>`");
  }
  const parsed = JSON.parse(fs.readFileSync(pointerPath, "utf8")) as Partial<ImplementActivePointer>;
  if (parsed.schema !== IMPLEMENT_ACTIVE_SCHEMA || typeof parsed.statePath !== "string") {
    throw new Error(`unsupported active pointer schema in ${ACTIVE_POINTER}; start a new run with \`sasu implement start --prd <path>\``);
  }
  return normalizeProjectPath(projectRoot, parsed.statePath).absolute;
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
