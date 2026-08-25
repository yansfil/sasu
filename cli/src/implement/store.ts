import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  IMPLEMENT_ACTIVE_SCHEMA,
  IMPLEMENT_SCHEMA,
  type ImplementActivePointer,
  type ImplementState,
  type DirtyAttribution,
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

function assertNullableString(value: unknown, label: string): void {
  if (value !== null) assertString(value, label);
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`malformed implement state: ${label} must be an object`);
  }
}

function assertSourceEntries(value: unknown, label: string): void {
  if (!Array.isArray(value)) throw new Error(`malformed implement state: ${label} must be an array`);
  for (const [index, entry] of value.entries()) {
    assertRecord(entry, `${label}[${index}]`);
    assertString(entry["path"], `${label}[${index}].path`);
    assertString(entry["state"], `${label}[${index}].state`);
    assertNullableString(entry["sha256"], `${label}[${index}].sha256`);
  }
}

function assertInputManifest(value: unknown, label: string): void {
  assertRecord(value, label);
  assertSourceEntries(value["source"], `${label}.source`);
  if (!Array.isArray(value["evidence"])) throw new Error(`malformed implement state: ${label}.evidence must be an array`);
  for (const [index, entry] of value["evidence"].entries()) {
    assertRecord(entry, `${label}.evidence[${index}]`);
    assertString(entry["verificationId"], `${label}.evidence[${index}].verificationId`);
    assertString(entry["path"], `${label}.evidence[${index}].path`);
    assertString(entry["sha256"], `${label}.evidence[${index}].sha256`);
  }
}

function assertRoundContext(value: unknown, label: string): void {
  assertRecord(value, label);
  assertNullableString(value["priorAttemptId"], `${label}.priorAttemptId`);
  if (!Array.isArray(value["changedPaths"]) || !value["changedPaths"].every((entry) => typeof entry === "string")) {
    throw new Error(`malformed implement state: ${label}.changedPaths must be a string array`);
  }
  if (!Array.isArray(value["newEvidence"])) throw new Error(`malformed implement state: ${label}.newEvidence must be an array`);
  for (const [index, entry] of value["newEvidence"].entries()) {
    assertRecord(entry, `${label}.newEvidence[${index}]`);
    assertString(entry["verificationId"], `${label}.newEvidence[${index}].verificationId`);
    assertString(entry["path"], `${label}.newEvidence[${index}].path`);
    assertString(entry["sha256"], `${label}.newEvidence[${index}].sha256`);
  }
}

function assertRoundContexts(value: unknown, label: string): void {
  assertRecord(value, label);
  assertRecord(value["acceptance"], `${label}.acceptance`);
  for (const [criterionId, context] of Object.entries(value["acceptance"])) {
    assertRoundContext(context, `${label}.acceptance.${criterionId}`);
  }
  assertRoundContext(value["fidelity"], `${label}.fidelity`);
  if (value["risk"] !== null) assertRoundContext(value["risk"], `${label}.risk`);
}

export function parseImplementState(text: string): ImplementState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
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
  if (candidate.status !== "active" && candidate.status !== "complete" && candidate.status !== "blocked" && candidate.status !== "retired") {
    throw new Error(`malformed implement state: status must be active, complete, blocked, or retired, got ${String(candidate.status ?? "missing")}`);
  }
  assertString(candidate.topicSlug, "topicSlug");
  assertString(candidate.projectRoot, "projectRoot");
  assertString(candidate.runDir, "runDir");
  assertString(candidate.prdPath, "prdPath");
  if (candidate.worktree !== null) {
    if (candidate.worktree === undefined || typeof candidate.worktree !== "object") {
      throw new Error("malformed implement state: worktree must be null or an object");
    }
    assertString(candidate.worktree.path, "worktree.path");
    assertString(candidate.worktree.branch, "worktree.branch");
  }

  assertRecord(candidate.prd, "prd");
  assertString(candidate.prd["sha256"], "prd.sha256");
  assertString(candidate.prd["snapshotPath"], "prd.snapshotPath");
  if (candidate.prd["reviewProfile"] !== "trivial" && candidate.prd["reviewProfile"] !== "standard" && candidate.prd["reviewProfile"] !== "high-risk") {
    throw new Error("malformed implement state: prd.reviewProfile must be trivial, standard, or high-risk");
  }

  assertRecord(candidate.initialSource, "initialSource");
  assertNullableString(candidate.initialSource["head"], "initialSource.head");
  assertString(candidate.initialSource["digest"], "initialSource.digest");
  assertSourceEntries(candidate.initialSource["entries"], "initialSource.entries");

  assertRecord(candidate.baselineAttribution, "baselineAttribution");
  if (candidate.baselineAttribution["disposition"] !== "clean"
    && candidate.baselineAttribution["disposition"] !== "pre-existing"
    && candidate.baselineAttribution["disposition"] !== "run-owned"
    && candidate.baselineAttribution["disposition"] !== "mixed") {
    throw new Error("malformed implement state: baselineAttribution.disposition must be clean, pre-existing, run-owned, or mixed");
  }
  assertString(candidate.baselineAttribution["baselineDigest"], "baselineAttribution.baselineDigest");
  assertNullableString(candidate.baselineAttribution["head"], "baselineAttribution.head");
  const attributionPaths = candidate.baselineAttribution["paths"];
  if (!Array.isArray(attributionPaths)) throw new Error("malformed implement state: baselineAttribution.paths must be an array");
  for (const [index, entry] of attributionPaths.entries()) {
    assertRecord(entry, `baselineAttribution.paths[${index}]`);
    assertString(entry["path"], `baselineAttribution.paths[${index}].path`);
    if (entry["disposition"] !== "pre-existing" && entry["disposition"] !== "run-owned") {
      throw new Error(`malformed implement state: baselineAttribution.paths[${index}].disposition must be pre-existing or run-owned`);
    }
  }

  if (!Array.isArray(candidate.tasks) || !Array.isArray(candidate.requirements)
    || !Array.isArray(candidate.acceptanceCriteria) || !Array.isArray(candidate.verification)
    || !Array.isArray(candidate.deviations)) {
    throw new Error("malformed implement state: tasks, requirements, acceptanceCriteria, verification, and deviations must be arrays");
  }
  if (!Array.isArray(candidate.artifacts) || !Array.isArray(candidate.verificationAttempts)) {
    throw new Error("malformed implement state: artifacts and verificationAttempts must be arrays");
  }
  // riskFindings was added without a schema bump. Early v5 runs therefore
  // load as an empty ledger; every subsequent persist writes the field.
  if (candidate.riskFindings === undefined) candidate.riskFindings = [];
  if (!Array.isArray(candidate.riskFindings)) {
    throw new Error("malformed implement state: riskFindings must be an array");
  }
  const riskFindingIds = new Set<string>();
  for (const [index, entry] of candidate.riskFindings.entries()) {
    assertRecord(entry, `riskFindings[${index}]`);
    assertString(entry["id"], `riskFindings[${index}].id`);
    if (!/^RF[1-9]\d*$/.test(entry["id"])) {
      throw new Error(`malformed implement state: riskFindings[${index}].id must match RF<n>`);
    }
    if (riskFindingIds.has(entry["id"])) {
      throw new Error(`malformed implement state: duplicate risk finding id ${entry["id"]}`);
    }
    riskFindingIds.add(entry["id"]);
    if (entry["severity"] !== "blocking" && entry["severity"] !== "advisory") {
      throw new Error(`malformed implement state: riskFindings[${index}].severity must be blocking or advisory`);
    }
    assertString(entry["text"], `riskFindings[${index}].text`);
    assertString(entry["originAttemptId"], `riskFindings[${index}].originAttemptId`);
    if (entry["status"] !== "open" && entry["status"] !== "fixed" && entry["status"] !== "accepted") {
      throw new Error(`malformed implement state: riskFindings[${index}].status must be open, fixed, or accepted`);
    }
    if (entry["resolution"] !== undefined) {
      assertRecord(entry["resolution"], `riskFindings[${index}].resolution`);
      assertString(entry["resolution"]["at"], `riskFindings[${index}].resolution.at`);
      assertString(entry["resolution"]["evidence"], `riskFindings[${index}].resolution.evidence`);
    }
  }
  for (const [index, attempt] of candidate.verificationAttempts.entries()) {
    assertRecord(attempt, `verificationAttempts[${index}]`);
    assertString(attempt["id"], `verificationAttempts[${index}].id`);
    assertInputManifest(attempt["inputManifest"], `verificationAttempts[${index}].inputManifest`);
    assertRoundContexts(attempt["roundContexts"], `verificationAttempts[${index}].roundContexts`);
  }

  if (candidate.retirement === undefined) throw new Error("malformed implement state: retirement must be null or an object");
  if (candidate.retirement !== null) {
    assertRecord(candidate.retirement, "retirement");
    assertString(candidate.retirement["retiredAt"], "retirement.retiredAt");
    assertNullableString(candidate.retirement["retiredBySessionId"], "retirement.retiredBySessionId");
  }
  if (candidate.completion === undefined) throw new Error("malformed implement state: completion must be null or an object");
  if (candidate.completion !== null) {
    assertRecord(candidate.completion, "completion");
    assertString(candidate.completion["fingerprint"], "completion.fingerprint");
    assertString(candidate.completion["completedAt"], "completion.completedAt");
    assertString(candidate.completion["receiptPath"], "completion.receiptPath");
    assertString(candidate.completion["implementationResultPath"], "completion.implementationResultPath");
  }
  return candidate as ImplementState;
}

export function loadState(projectRoot: string, options: { slug?: string; state?: string } = {}): { statePath: string; state: ImplementState } {
  const statePath = resolveStatePath(projectRoot, options);
  if (!fs.existsSync(statePath)) throw new Error(`implement state not found: ${path.relative(projectRoot, statePath)}`);
  return { statePath, state: parseImplementState(fs.readFileSync(statePath, "utf8")) };
}

export function persistState(statePath: string, state: ImplementState): void {
  state.updatedAt = nowIso();
  writeJsonAtomic(statePath, state);
  writeActivePointer(state.projectRoot, state);
}

const SNAPSHOT_EXCLUDES = new Set([".git", "node_modules", "dist", "coverage", ".next", ".turbo"]);

function repositoryHead(projectRoot: string): string | null {
  // `git rev-parse` covers both a normal checkout (.git directory) and a
  // linked worktree (.git file). Reading .git/HEAD directly made every
  // isolated run look non-git and erased the committed baseline provenance.
  const resolved = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 15_000,
  });
  if (resolved.error !== undefined || resolved.status !== 0) return null;
  return resolved.stdout.trim() || null;
}

function isGitWorkTree(projectRoot: string): boolean {
  const resolved = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 15_000,
  });
  return resolved.status === 0 && resolved.stdout.trim() === "true";
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
 * The baseline a run's "run-owned changes" are diffed against. A declared
 * run-owned dirty tree resolves those paths against committed HEAD: otherwise
 * a restarted run snapshots the finished tree and every judge sees "No
 * run-owned source changes" (2026-08-13 creator-assist: four restarted runs).
 * A dirty path declared pre-existing deliberately keeps its working bytes in
 * the baseline, while a run-owned path resolves against HEAD. This per-path
 * split represents mixed-ownership trees without adding another CLI handle.
 * Only dirty paths need attribution; clean files already match HEAD byte-for-byte.
 * Without git (or when git fails) the working tree is the only baseline there
 * is, which restores the old behavior for non-repository projects.
 */
export function dirtySourcePaths(projectRoot: string): string[] {
  // An unborn repository has no HEAD but still has meaningful staged and
  // untracked ownership. Treating HEAD absence as "not git" absorbed every
  // pre-first-commit file into a false clean baseline.
  if (!isGitWorkTree(projectRoot)) return [];
  const status = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (status.error !== undefined || status.status !== 0) {
    throw new Error(`git status failed while resolving dirty source attribution: ${(status.stderr || status.error?.message || "unknown error").trim()}`);
  }
  const dirty = new Set<string>();
  const tokens = status.stdout.split("\0").filter((token) => token !== "");
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const relative = token.slice(3);
    if (relative !== "" && !snapshotExcluded(relative)) dirty.add(relative);
    // Renames and copies carry the origin as the next NUL token. Either index
    // position may carry R/C depending on whether the index or worktree owns it.
    if (/[RC]/.test(token.slice(0, 2))) {
      index += 1;
      const origin = tokens[index];
      if (origin !== undefined && !snapshotExcluded(origin)) dirty.add(origin);
    }
  }
  return [...dirty].sort();
}

export function captureBaselineSnapshot(
  projectRoot: string,
  attributions: Array<{ path: string; disposition: DirtyAttribution }>,
): SourceSnapshot {
  const working = captureSourceSnapshot(projectRoot);
  // `implement start` already presented this exact path set for ownership.
  // Re-scan only to prove the set stayed stable while the working snapshot was
  // captured; never let the second scan silently choose a different baseline.
  const expectedDirty = [...new Set(attributions.map((entry) => entry.path))].sort();
  if (expectedDirty.length !== attributions.length) {
    throw new Error("dirty source attribution contains a duplicate path");
  }
  const dispositionByPath = new Map(attributions.map((entry) => [entry.path, entry.disposition]));
  const observedDirty = dirtySourcePaths(projectRoot);
  if (JSON.stringify(observedDirty) !== JSON.stringify(expectedDirty)) {
    const expected = new Set(expectedDirty);
    const observed = new Set(observedDirty);
    const added = observedDirty.filter((entry) => !expected.has(entry));
    const removed = expectedDirty.filter((entry) => !observed.has(entry));
    const changes = [
      ...(added.length > 0 ? [`added: ${added.join(", ")}`] : []),
      ...(removed.length > 0 ? [`removed: ${removed.join(", ")}`] : []),
    ].join("; ");
    throw new Error(
      `dirty source paths changed while binding baseline attribution (${changes}); `
      + "re-run `sasu implement start` against a stable tree so every path receives an explicit disposition",
    );
  }
  if (!isGitWorkTree(projectRoot)) return working;
  const entries = new Map(working.entries.map((entry) => [entry.path, entry]));
  for (const relative of expectedDirty) {
    if (dispositionByPath.get(relative) === "pre-existing") continue;
    if (snapshotExcluded(relative)) continue;
    if (working.head === null) {
      // No committed tree exists, so every dirty judged path is run-owned and
      // absent from the baseline. This is the unborn equivalent of a failed
      // `git show HEAD:path` below.
      entries.delete(relative);
      continue;
    }
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

/**
 * Artifact integrity is file identity only. In the 2026-08-25 creator-studio
 * run, coupling every artifact to the whole judged tree staled 28 records at
 * once and let an unchanged 06:14 log be re-dated after 06:37 code changes.
 * Semantic freshness belongs to the judges; the attempt-level source pin still
 * blocks finalize after any later source edit.
 */
export function artifactIntegrityProblems(projectRoot: string, state: ImplementState): string[] {
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
  }
  return problems;
}
