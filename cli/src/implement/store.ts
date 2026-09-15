import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  IMPLEMENT_ACTIVE_SCHEMA,
  IMPLEMENT_SCHEMA,
  RETIRED_IMPLEMENT_SUPPORT_COMMIT,
  retiredImplementSupportCommit,
  type ImplementActivePointer,
  type ImplementState,
  type DirtyAttribution,
  type SourceEntry,
  type SourceSnapshot,
} from "./types";
import { ISSUED_COMMANDS } from "./verbs";
import { ACTIVE_POINTER_REL, activePointerReadPath, activePointerWriteRel, implementStatePathFor } from "../runs/paths";
import { currentSessionId } from "../runs/session";
import { siblingWorktrees } from "./worktree";

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

export function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function writeJsonAtomic(file: string, value: unknown): void {
  writeTextAtomic(file, jsonText(value));
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

/** Current-schema namespace candidates for an explicit --slug selection. */
function runCandidates(projectRoot: string): string[] {
  const slugs = new Set<string>();
  for (const namespace of [path.join("agents", "runs")]) {
    const dir = path.join(projectRoot, namespace);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, "state.json"))) slugs.add(entry.name);
    }
  }
  return [...slugs].sort();
}

/**
 * `--slug` names a run, not a tree. A run isolated into a worktree keeps its
 * record in the tree that started it, and a supervisor asking from another
 * worktree of the same repository used to be told the record did not exist:
 * on 2026-09-10 the Observer waited in the original checkout for a record
 * that lived in the Implementor's worktree, never woke, and was found hours
 * later by the daemon's stall detection. When the record is not in this
 * tree, the repository's other worktrees are searched: exactly one match
 * resolves, more than one is an ambiguity a person must name, and none
 * leaves the local "not found". state.json stays the only authority - this
 * is navigation to it, and every mutation still checks ownership.
 */
function recordPathForSlug(projectRoot: string, slug: string): string {
  const local = statePathFor(projectRoot, slug);
  if (fs.existsSync(local)) return local;
  const found = siblingWorktrees(projectRoot).map((tree) => statePathFor(tree, slug)).filter((candidate) => fs.existsSync(candidate));
  if (found.length === 1) return found[0]!;
  if (found.length > 1) {
    throw new Error(`implement run ${slug} is recorded in more than one worktree of this repository (${found.join(", ")}); run the command from the tree that owns it`);
  }
  return local;
}

export function resolveStatePath(projectRoot: string, options: { slug?: string; state?: string } = {}): string {
  if (options.state !== undefined) return normalizeProjectPath(projectRoot, options.state).absolute;
  if (options.slug !== undefined) return recordPathForSlug(projectRoot, options.slug);
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

function assertIsoTimestamp(value: unknown, label: string): asserts value is string {
  assertString(value, label);
  if (!Number.isFinite(Date.parse(value))) throw new Error(`malformed implement state: ${label} must be an ISO timestamp`);
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`malformed implement state: ${label} must be a SHA-256 hex digest`);
  }
}

function assertStringArray(value: unknown, label: string, nonEmpty = false): asserts value is string[] {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0) || !value.every((entry) => typeof entry === "string" && entry !== "")) {
    throw new Error(`malformed implement state: ${label} must be ${nonEmpty ? "a non-empty" : "a"} string array`);
  }
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

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`malformed implement state: ${label} must be an array`);
  return value;
}
function enumValue(value: unknown, allowed: string[], label: string): void {
  if (!allowed.includes(String(value))) throw new Error(`malformed implement state: ${label} must be one of ${allowed.join(", ")}`);
}
function positiveInteger(value: unknown, label: string, minimum = 1): void {
  if (!Number.isInteger(value) || Number(value) < minimum) throw new Error(`malformed implement state: ${label} must be an integer >= ${minimum}`);
}
function ledger(value: unknown, label: string): Record<string, unknown>[] {
  let prior = 0;
  return array(value, label).map((entry, index) => {
    assertRecord(entry, `${label}[${index}]`);
    positiveInteger(entry["id"], `${label}[${index}].id`, prior + 1);
    prior = Number(entry["id"]);
    assertIsoTimestamp(entry["at"], `${label}[${index}].at`);
    return entry;
  });
}
export function parseImplementState(text: string): ImplementState {
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch (error) { throw new Error(`malformed implement state JSON: ${error instanceof Error ? error.message : String(error)}`); }
  assertRecord(parsed, "root");
  if (parsed["schema"] !== IMPLEMENT_SCHEMA) {
    throw new Error(`unsupported implement state schema ${String(parsed["schema"] ?? "missing")}; only ${IMPLEMENT_SCHEMA} is accepted. Retired contracts were last supported by ${retiredImplementSupportCommit(parsed["schema"])}; start a new run, no migration is available`);
  }
  for (const field of ["rows", "activeCheck", "qaBriefs", "trails", "designComments", "tasks", "checks", "findings", "riskFindings", "budgetGrants", "completion"]) {
    if (field in parsed) throw new Error(`retired implement state field: ${field}; start a new run under the stateless verification contract`);
  }
  const candidate = parsed as unknown as ImplementState;
  enumValue(candidate.status, ["active", "retired"], "status");
  for (const field of ["topicSlug", "projectRoot", "runDir", "prdPath"] as const) assertString(candidate[field], field);
  assertIsoTimestamp(candidate.createdAt, "createdAt");
  assertIsoTimestamp(candidate.updatedAt, "updatedAt");
  if (candidate.worktree !== null && candidate.worktree !== undefined) {
    assertRecord(candidate.worktree, "worktree");
    assertString(candidate.worktree["path"], "worktree.path");
    assertString(candidate.worktree["branch"], "worktree.branch");
  }
  assertRecord(candidate.prd, "prd");
  assertSha256(candidate.prd.sha256, "prd.sha256");
  assertString(candidate.prd.snapshotPath, "prd.snapshotPath");
  assertRecord(candidate.prd.approval, "prd.approval");
  enumValue(candidate.prd.approval.source, ["frontmatter", "conversation"], "prd.approval.source");
  assertString(candidate.prd.approval.evidence, "prd.approval.evidence");
  enumValue(candidate.prd.reviewProfile, ["trivial", "standard", "high-risk"], "prd.reviewProfile");
  if (typeof candidate.prd.reviewRationale !== "string" || typeof candidate.prd.sourceIntake !== "string") throw new Error("malformed implement state: PRD review metadata must be strings");

  for (const [label, snapshot] of [["initialSource", candidate.initialSource]] as const) {
    assertRecord(snapshot, label);
    assertNullableString(snapshot.head, `${label}.head`);
    assertSha256(snapshot.digest, `${label}.digest`);
    assertSourceEntries(snapshot.entries, `${label}.entries`);
  }
  assertRecord(candidate.baselineAttribution, "baselineAttribution");
  enumValue(candidate.baselineAttribution.disposition, ["clean", "pre-existing", "run-owned", "mixed"], "baselineAttribution.disposition");
  assertSha256(candidate.baselineAttribution.baselineDigest, "baselineAttribution.baselineDigest");
  assertNullableString(candidate.baselineAttribution.head, "baselineAttribution.head");
  for (const entry of array(candidate.baselineAttribution.paths, "baselineAttribution.paths")) {
    assertRecord(entry, "baselineAttribution.paths[]");
    assertString(entry["path"], "baselineAttribution.paths[].path");
    enumValue(entry["disposition"], ["pre-existing", "run-owned"], "baselineAttribution.paths[].disposition");
  }

  const requirementIds = new Set<string>();
  for (const entry of array(candidate.requirements, "requirements")) {
    assertRecord(entry, "requirements[]");
    assertString(entry["id"], "requirements[].id");
    if (!/^B[1-9]\d*$/.test(entry["id"]) || requirementIds.has(entry["id"])) throw new Error("malformed implement state: invalid or duplicate requirement id");
    requirementIds.add(entry["id"]);
    assertString(entry["behavior"], "requirements[].behavior");
    assertStringArray(entry["decisionIds"], "requirements[].decisionIds");
  }
  if (requirementIds.size === 0) throw new Error("malformed implement state: requirements must not be empty");

  for (const field of ["artifacts", "verificationAttempts", "deviations", "events", "verbs", "amendments", "evidenceReplacements", "escalations"] as const) array(candidate[field], field);
  for (const artifact of candidate.artifacts) {
    assertRecord(artifact, "artifacts[]");
    for (const field of ["kind", "path", "description", "provenance"] as const) assertString(artifact[field], `artifacts[].${field}`);
    assertSha256(artifact.sha256, "artifacts[].sha256");
    positiveInteger(artifact.bytes, "artifacts[].bytes");
    assertIsoTimestamp(artifact.registeredAt, "artifacts[].registeredAt");
    assertIsoTimestamp(artifact.observedAt, "artifacts[].observedAt");
  }
  ledger(candidate.events, "events");
  for (const event of candidate.events) enumValue(event.kind, ["amendment", "escalate", "artifact", "verify"], "events[].kind");
  ledger(candidate.verbs, "verbs");
  for (const verb of candidate.verbs) enumValue(verb.verb, ISSUED_COMMANDS, "verbs[].verb");
  ledger(candidate.amendments, "amendments");
  ledger(candidate.evidenceReplacements, "evidenceReplacements");

  assertRecord(candidate.suite, "suite");
  assertIsoTimestamp(candidate.suite.sealedAt, "suite.sealedAt");
  const suiteIds = new Set<string>();
  for (const item of array(candidate.suite.commands, "suite.commands")) {
    assertRecord(item, "suite.commands[]");
    assertString(item["id"], "suite.commands[].id");
    if (suiteIds.has(item["id"])) throw new Error("malformed implement state: duplicate suite command id");
    suiteIds.add(item["id"]);
    assertString(item["command"], "suite.commands[].command");
    assertString(item["cwd"], "suite.commands[].cwd");
    assertStringArray(item["argv"], "suite.commands[].argv", true);
  }
  for (const item of array(candidate.suite.exclusions, "suite.exclusions")) {
    assertRecord(item, "suite.exclusions[]");
    if (!suiteIds.has(String(item["commandId"]))) throw new Error("malformed implement state: suite exclusion names unknown command");
  }
  for (const item of array(candidate.suite.results, "suite.results")) {
    assertRecord(item, "suite.results[]");
    if (!suiteIds.has(String(item["commandId"]))) throw new Error("malformed implement state: suite result names unknown command");
    assertString(item["attemptId"], "suite.results[].attemptId");
    enumValue(item["status"], ["GREEN", "RED"], "suite.results[].status");
    if (!Number.isInteger(item["exitCode"]) || typeof item["mutatedTree"] !== "boolean") throw new Error("malformed implement state: invalid suite execution result");
  }

  const attemptIds = new Set<string>();
  for (const attempt of candidate.verificationAttempts) {
    assertRecord(attempt, "verificationAttempts[]");
    for (const retired of ["reviewContext", "reviewPolicySha256", "inputManifest", "roundContext", "reviews", "risk", "reviewScope"]) {
      if (retired in attempt) throw new Error(`retired verification field: ${retired}`);
    }
    assertString(attempt.id, "verificationAttempts[].id");
    if (attemptIds.has(attempt.id)) throw new Error("malformed implement state: duplicate verification attempt id");
    attemptIds.add(attempt.id);
    for (const field of ["inputFingerprint", "sourceFingerprint", "prdSha256"] as const) assertSha256(attempt[field], `verificationAttempts[].${field}`);
    assertRecord(attempt.intentInput, "verificationAttempts[].intentInput");
    assertSha256(attempt.intentInput.contentSha256, "verificationAttempts[].intentInput.contentSha256");
    assertIsoTimestamp(attempt.startedAt, "verificationAttempts[].startedAt");
    assertIsoTimestamp(attempt.finishedAt, "verificationAttempts[].finishedAt");
    positiveInteger(attempt.durationMs, "verificationAttempts[].durationMs", 0);
    enumValue(attempt.phase, ["preflight", "mechanical", "evidence", "complete"], "verificationAttempts[].phase");
    enumValue(attempt.verdict, ["NOT_RUN", "PASS", "FAIL", "ERROR", "STALE"], "verificationAttempts[].verdict");
    assertRecord(attempt.prelint, "verificationAttempts[].prelint");
    array(attempt.mechanical, "verificationAttempts[].mechanical");
    if (attempt.verdict === "PASS" && (attempt.error !== null || attempt.mechanical.some((run) => run.status !== "PASS"))) throw new Error("malformed implement state: verification PASS contradicts its deterministic result");
  }
  if (candidate.activeVerification !== undefined) {
    const active = candidate.activeVerification;
    assertRecord(active, "activeVerification");
    for (const field of ["token", "attemptId", "hostname"] as const) assertString(active[field], `activeVerification.${field}`);
    for (const field of ["inputFingerprint", "prdSha256"] as const) assertSha256(active[field], `activeVerification.${field}`);
    positiveInteger(active.pid, "activeVerification.pid");
    positiveInteger(active.pendingSpawns, "activeVerification.pendingSpawns", 0);
    array(active.executionPids, "activeVerification.executionPids").forEach((pid) => positiveInteger(pid, "activeVerification.executionPids[]"));
    assertIsoTimestamp(active.startedAt, "activeVerification.startedAt");
    if (!attemptIds.has(active.attemptId) || candidate.status !== "active") throw new Error("malformed implement state: active verification identity is invalid");
  }
  if (candidate.retirement === undefined) throw new Error("malformed implement state: retirement must be null or an object");
  if (candidate.retirement !== null) assertRecord(candidate.retirement, "retirement");
  if (candidate.verificationReport === undefined) throw new Error("malformed implement state: verificationReport must be null or an object");
  if (candidate.verificationReport !== null) {
    assertRecord(candidate.verificationReport, "verificationReport");
    if (candidate.verificationReport.schema !== "sasu.verification-report.v1") throw new Error("malformed implement state: unknown verification report schema");
    for (const field of ["inputFingerprint", "prdSha256", "sourceFingerprint", "reportSha256"] as const) assertSha256(candidate.verificationReport[field], `verificationReport.${field}`);
    for (const field of ["generatedAt", "jsonPath", "markdownPath"] as const) assertString(candidate.verificationReport[field], `verificationReport.${field}`);
    assertIsoTimestamp(candidate.verificationReport.generatedAt, "verificationReport.generatedAt");
    enumValue(candidate.verificationReport.status, ["PASS", "FAIL", "ERROR"], "verificationReport.status");
    assertNullableString(candidate.verificationReport.baseSha, "verificationReport.baseSha");
    assertNullableString(candidate.verificationReport.headSha, "verificationReport.headSha");
  }
  return candidate;
}

/**
 * What `state.json` held when this state object was read from it.
 *
 * RF1 (2026-08-29 risk lane): persistState was an unlocked
 * load-modify-atomic-rename, and event ids are derived from the caller's
 * in-memory snapshot. Two commands that loaded the same state - the intended
 * supervisor/implementor concurrency - could both mint the same next id, and
 * the second rename silently discarded the first's event, verb, artifact, or
 * transition. The run's sole evidence record could therefore end up complete
 * on its face and missing what actually happened.
 *
 * The repair is the smallest one that makes the silent discard impossible:
 * remember the bytes the writer's decisions were made against, and refuse the
 * rename if the file no longer holds them. No lock file, no daemon, no wait
 * loop - D-45's "no new concurrency mechanism" stands, re-read by the user as
 * approving this check ("사수 권고대로 가자", 2026-08-30): the device count
 * stays at zero and only the quiet overwrite is removed. A refused writer
 * reloads and re-applies; a lost write cannot be reloaded.
 *
 * Derived report files are written after the state compare-and-swap so a
 * stale writer cannot publish a report for state it failed to persist.
 *
 * Keyed by the state object so the baseline cannot be serialized into the
 * record - the check is about the file, and state.json stays the only record.
 */
const stateBaseline = new WeakMap<ImplementState, { statePath: string; digest: string }>();

function stateFileDigest(statePath: string): string | null {
  if (!fs.existsSync(statePath)) return null;
  return sha256(fs.readFileSync(statePath));
}

export function loadState(projectRoot: string, options: { slug?: string; state?: string } = {}): { statePath: string; state: ImplementState } {
  const statePath = resolveStatePath(projectRoot, options);
  if (!fs.existsSync(statePath)) throw new Error(`implement state not found: ${path.relative(projectRoot, statePath)}`);
  const text = fs.readFileSync(statePath, "utf8");
  const state = parseImplementState(text);
  stateBaseline.set(state, { statePath, digest: sha256(text) });
  return { statePath, state };
}

export class StateConflictError extends Error {}

export interface StateWriteOptions { verificationToken?: string; refusalOnly?: boolean }

function assertVerificationHistory(held: ImplementState, next: ImplementState): void {
  // Execution history is factual and append-only. A new source gets a new
  // attempt; it never rewrites the command results recorded for an old one.
  if (next.verificationAttempts.length < held.verificationAttempts.length) throw new Error("verification history is append-only; attempts cannot be removed");
  if (held.activeVerification !== undefined && next.verificationAttempts.length !== held.verificationAttempts.length) throw new Error("verification history cannot append an attempt while its execution lease is active");
  for (const [index, previous] of held.verificationAttempts.entries()) {
    const current = next.verificationAttempts[index]!;
    if (previous.id !== current.id) throw new Error("verification history is append-only; attempts cannot be reordered or replaced");
    for (const field of ["id", "inputFingerprint", "sourceFingerprint", "prdSha256", "intentInput", "startedAt"] as const) {
      if (JSON.stringify(previous[field]) !== JSON.stringify(current[field])) throw new Error(`verification attempt ${previous.id} pinned ${field} is immutable`);
    }
    if (held.activeVerification?.attemptId !== previous.id && JSON.stringify(previous) !== JSON.stringify(current)) throw new Error(`verification attempt ${previous.id} completed record is immutable; append a correction attempt`);
  }
}

export function persistState(statePath: string, state: ImplementState, options: StateWriteOptions = {}): void {
  const baseline = stateBaseline.get(state);
  const onDisk = stateFileDigest(statePath);
  if (baseline !== undefined && baseline.statePath === statePath) {
    if (onDisk !== baseline.digest) {
      throw new StateConflictError(
        "implement state changed on disk since this command read it, so writing now would discard the other write."
          + " Nothing was written. Re-run the command: it will reload the current record and re-apply against it."
          + ` (${path.basename(statePath)})`,
      );
    }
  } else if (onDisk !== null) {
    // A state object this process built rather than loaded (only `start`
    // does) must never land on top of an existing record; `start` already
    // refuses an existing slug, so reaching here means the file appeared
    // underneath it.
    throw new Error(
      `implement state appeared at ${path.basename(statePath)} while this run was being created; nothing was written.`,
    );
  }
  if (onDisk !== null) {
    const held = parseImplementState(fs.readFileSync(statePath, "utf8"));
    const lease = held.activeVerification;
    if (lease !== undefined && options.verificationToken !== lease.token) {
      // Compare the whole domain state, not a list of commands. A new mutation
      // cannot bypass the lease by missing a dispatcher-specific guard.
      const withoutRefusals = (value: ImplementState): string => JSON.stringify({ ...value, updatedAt: "", verbs: [] });
      const priorVerbs = state.verbs.slice(0, held.verbs.length);
      const appended = state.verbs.slice(held.verbs.length);
      const safeRefusal = options.refusalOnly === true
        && withoutRefusals(state) === withoutRefusals(held)
        && JSON.stringify(priorVerbs) === JSON.stringify(held.verbs)
        && appended.length > 0 && appended.every((verb) => verb.outcome === "rejected");
      if (!safeRefusal) throw new Error(`verification still active: ${lease.attemptId}; other domain mutations are refused until its execution lease closes`);
    }
    assertVerificationHistory(held, state);
  }
  state.updatedAt = nowIso();
  // Serialized once and written, so the baseline is the exact bytes on disk
  // rather than a second serialization that could drift from them.
  const text = `${JSON.stringify(state, null, 2)}\n`;
  // The reader runs over the exact bytes before they land. A writer and the
  // reader disagreeing about one field has bricked a run three times (verb
  // vocabulary, observer park approval, attempt outcome); refusing here
  // leaves nothing on disk and names the field, instead of leaving a file
  // every later command refuses to open.
  try {
    parseImplementState(text);
  } catch (error) {
    throw new Error(`refusing to write implement state that its own reader rejects; nothing was written: ${error instanceof Error ? error.message : String(error)}`);
  }
  writeTextAtomic(statePath, text);
  // The bytes just written are the new baseline: several commands persist
  // twice (ownership adoption, then the command's own change), and the second
  // write is not a conflict with the first.
  stateBaseline.set(state, { statePath, digest: sha256(text) });
  writeActivePointer(state.projectRoot, state);
}

function assertVerificationPublicationCurrent(statePath: string, state: ImplementState, token: string): void {
  const baseline = stateBaseline.get(state);
  const onDisk = stateFileDigest(statePath);
  if (baseline === undefined || baseline.statePath !== statePath || onDisk !== baseline.digest) {
    throw new StateConflictError(
      "implement state changed before verification report publication. Nothing was published; retry against the current record.",
    );
  }
  const held = parseImplementState(fs.readFileSync(statePath, "utf8"));
  if (held.activeVerification?.token !== token) {
    throw new Error("verification execution lease was replaced or cleared before report publication");
  }
}

/**
 * Publish files derived from state without exposing an unlocked half-close.
 *
 * Ordinary callers persist state first, so a failed state comparison cannot
 * leave an authoritative derived file behind. Verification is the one inverse
 * case: its on-disk lease is the guard that makes a published report
 * non-authoritative until the final state write removes that lease. The report
 * renames therefore finish while the lease is still visible, and the tokened
 * state write releases it last. If that write races a recorded refusal, the
 * lease remains and the caller retries from current state.
 */
export function persistClose(
  statePath: string,
  state: ImplementState,
  derived: Array<{ file: string; text: string }>,
  options: StateWriteOptions = {},
): void {
  const staged = derived.map((entry) => {
    fs.mkdirSync(path.dirname(entry.file), { recursive: true });
    const temporary = `${entry.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, entry.text);
    return { file: entry.file, temporary };
  });
  if (options.verificationToken !== undefined) {
    try {
      assertVerificationPublicationCurrent(statePath, state, options.verificationToken);
      for (const entry of staged) fs.renameSync(entry.temporary, entry.file);
      persistState(statePath, state, options);
    } catch (error) {
      for (const entry of staged) fs.rmSync(entry.temporary, { force: true });
      throw error;
    }
    return;
  }
  try {
    persistState(statePath, state, options);
  } catch (error) {
    for (const entry of staged) fs.rmSync(entry.temporary, { force: true });
    throw error;
  }
  for (const entry of staged) fs.renameSync(entry.temporary, entry.file);
}

/**
 * Non-git fallback only. Inside a repository the judged source set is what
 * git lists (see sourceFiles), which is also what the gate's judged diff reads
 * in lib/git.js; a second hand-maintained definition of "judged" is what let
 * a Rust target/ tree be hashed and scored as source (2026-09-02 herdr-ide:
 * 3.9 GB across 14,900 files read four times per unit, and every build
 * flagged as a moved tree).
 */
const NON_GIT_SNAPSHOT_EXCLUDES = new Set([".git", "node_modules", "dist", "coverage", ".next", ".turbo"]);

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

/**
 * Judged source is what git sees: tracked files plus untracked files the
 * ignore rules do not exclude, minus the harness's own agents/ namespace. A
 * tracked file stays judged even if a later ignore rule matches it. Symlinks,
 * submodule entries, and index entries deleted from the working tree are
 * skipped, matching the readdir walk's regular-file semantics.
 */
function sourceFiles(projectRoot: string): string[] {
  if (isGitWorkTree(projectRoot)) {
    const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd: projectRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (listed.error !== undefined || listed.status !== 0) {
      throw new Error(`git ls-files failed while listing judged source: ${(listed.stderr || listed.error?.message || "unknown error").trim()}`);
    }
    const files = new Set<string>();
    for (const relative of listed.stdout.split("\0")) {
      if (relative === "" || snapshotExcluded(relative)) continue;
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(path.join(projectRoot, relative));
      } catch {
        continue;
      }
      if (stat.isFile()) files.add(relative);
    }
    return [...files].sort();
  }
  const files: string[] = [];
  const visit = (absoluteDir: string, relativeDir: string): void => {
    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const relative = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (NON_GIT_SNAPSHOT_EXCLUDES.has(entry.name) || snapshotExcluded(relative)) continue;
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

/** The harness's own namespace is bookkeeping, never a verification input. */
function snapshotExcluded(relative: string): boolean {
  return relative.split("/")[0] === "agents";
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
 * Semantic sufficiency belongs to native review; the attempt-level source pin
 * keeps delivery from reusing a report after a later source edit.
 */
export function artifactIntegrityProblems(projectRoot: string, state: ImplementState): string[] {
  const problems: string[] = [];
  for (const artifact of state.artifacts) {
    const target = "run";
    let absolute: string;
    try {
      absolute = normalizeProjectPath(projectRoot, artifact.path).absolute;
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    if (!fs.existsSync(absolute)) {
      problems.push(`${target}: artifact missing: ${artifact.path}`);
      continue;
    }
    const resolved = fs.realpathSync(absolute);
    const relative = path.relative(fs.realpathSync(projectRoot), resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      problems.push(`${target}: artifact escapes project root through a symlink: ${artifact.path}`);
      continue;
    }
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size <= 0) {
      problems.push(`${target}: artifact is empty or not a file: ${artifact.path}`);
      continue;
    }
    const actual = sha256(fs.readFileSync(absolute));
    if (actual !== artifact.sha256) problems.push(`${target}: artifact hash changed: ${artifact.path}`);
  }
  return problems;
}
