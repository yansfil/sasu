import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  IMPLEMENT_ACTIVE_SCHEMA,
  IMPLEMENT_SCHEMA,
  type AmendmentRecord,
  type ImplementActivePointer,
  type ImplementState,
  type DirtyAttribution,
  type SourceEntry,
  type SourceSnapshot,
  type IssuedCommand,
} from "./types";
import { ISSUED_COMMANDS } from "./verbs";
import { mechanicalOutcome } from "./verdict";
import { ACTIVE_POINTER_REL, activePointerReadPath, activePointerWriteRel, implementStatePathFor } from "../runs/paths";
import { tryAcquireLock } from "../runs/lock";
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

function assertInputManifest(value: unknown, label: string): void {
  assertRecord(value, label);
  assertSourceEntries(value["source"], `${label}.source`);
  if (!Array.isArray(value["evidence"])) throw new Error(`malformed implement state: ${label}.evidence must be an array`);
  for (const [index, entry] of value["evidence"].entries()) {
    assertRecord(entry, `${label}.evidence[${index}]`);
    if (entry["rowId"] !== undefined) assertString(entry["rowId"], `${label}.evidence[${index}].rowId`);
    assertString(entry["path"], `${label}.evidence[${index}].path`);
    assertString(entry["sha256"], `${label}.evidence[${index}].sha256`);
  }
  assertRecord(value["checkLedger"], `${label}.checkLedger`);
  assertSha256(value["checkLedger"]["sha256"], `${label}.checkLedger.sha256`);
  if (!Array.isArray(value["checkLedger"]["rows"])) {
    throw new Error(`malformed implement state: ${label}.checkLedger.rows must be an array`);
  }
  for (const [index, row] of value["checkLedger"]["rows"].entries()) {
    assertRecord(row, `${label}.checkLedger.rows[${index}]`);
    for (const field of ["rowId", "payload", "status"] as const) assertString(row[field], `${label}.checkLedger.rows[${index}].${field}`);
    if (!CHECK_KINDS.has(String(row["kind"]))) throw new Error(`malformed implement state: ${label}.checkLedger.rows[${index}].kind is invalid`);
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
    if (entry["rowId"] !== undefined) assertString(entry["rowId"], `${label}.newEvidence[${index}].rowId`);
    assertString(entry["path"], `${label}.newEvidence[${index}].path`);
    assertString(entry["sha256"], `${label}.newEvidence[${index}].sha256`);
  }
}

/**
 * An amendment that rewrote a row voids the proof filed against the old
 * text (amend.ts), so its attempts stop counting from the amendment's
 * timestamp - the same boundary a park's resume draws. The reader used to
 * know only the resume boundary, so `amend` on a green row wrote status
 * "pending" over a green attempt the reader still counted, and the file it
 * left was one no later command could open. Found by the write-time parse
 * the day it landed (2026-09-03).
 */
function latestInvalidationByRow(amendments: AmendmentRecord[]): Map<string, string> {
  const boundary = new Map<string, string>();
  for (const amendment of amendments) {
    for (const rowId of amendment.invalidatedRows) {
      const held = boundary.get(rowId);
      if (held === undefined || held < amendment.at) boundary.set(rowId, amendment.at);
    }
  }
  return boundary;
}

const CHECK_KINDS = new Set(["check", "judge", "human"]);
const ROW_STATUSES = new Set(["pending", "green", "fail", "parked", "OPEN", "PASS", "FAIL"]);

function assertCheckAttempt(attempt: unknown, attemptLabel: string, attemptIndex: number): void {
  assertRecord(attempt, attemptLabel);
  if (attempt["id"] !== `A${attemptIndex + 1}`) throw new Error(`malformed implement state: ${attemptLabel}.id must be A${attemptIndex + 1}`);
  assertIsoTimestamp(attempt["startedAt"], `${attemptLabel}.startedAt`);
  assertIsoTimestamp(attempt["finishedAt"], `${attemptLabel}.finishedAt`);
  if (!Number.isInteger(attempt["durationMs"]) || Number(attempt["durationMs"]) < 0) {
    throw new Error(`malformed implement state: ${attemptLabel}.durationMs must be a non-negative integer`);
  }
  if (!Number.isInteger(attempt["exitCode"])) throw new Error(`malformed implement state: ${attemptLabel}.exitCode must be an integer`);
  if (typeof attempt["timedOut"] !== "boolean") throw new Error(`malformed implement state: ${attemptLabel}.timedOut must be boolean`);
  if (attempt["signal"] !== null && (typeof attempt["signal"] !== "string" || !/^SIG[A-Z0-9]+$/.test(attempt["signal"]))) {
    throw new Error(`malformed implement state: ${attemptLabel}.signal is invalid`);
  }
  if (typeof attempt["mutatedTree"] !== "boolean") throw new Error(`malformed implement state: ${attemptLabel}.mutatedTree must be boolean`);
  if (attempt["outcome"] !== "green" && attempt["outcome"] !== "failed" && attempt["outcome"] !== "tree-moved") {
    throw new Error(`malformed implement state: ${attemptLabel}.outcome is invalid`);
  }
  const expectedOutcome = mechanicalOutcome({
    exitCode: attempt["exitCode"] as number,
    timedOut: attempt["timedOut"] as boolean,
    signal: attempt["signal"] as string | null,
    mutatedTree: attempt["mutatedTree"] as boolean,
  });
  if (attempt["outcome"] !== expectedOutcome) {
    throw new Error(`malformed implement state: ${attemptLabel}.outcome ${String(attempt["outcome"])} contradicts the recorded process result (expected ${expectedOutcome})`);
  }
  assertSha256(attempt["outputFingerprint"], `${attemptLabel}.outputFingerprint`);
  if (expectedOutcome === "failed") {
    assertSha256(attempt["failureClass"], `${attemptLabel}.failureClass`);
  } else if (attempt["failureClass"] !== null) {
    throw new Error(`malformed implement state: ${attemptLabel}.failureClass must be null for ${expectedOutcome}`);
  }
  assertRecord(attempt["tree"], `${attemptLabel}.tree`);
  for (const field of ["all", "product", "bookkeeping"] as const) assertSha256(attempt["tree"][field], `${attemptLabel}.tree.${field}`);
}

/**
 * The Behaviors rows, with every status re-derived from the ledger it
 * summarises: a `check:` row's status from its attempts and parks, a
 * `human:` row's from its confirmation. A stored status the ledger
 * contradicts is refused, so no writer can promote a row by editing one
 * word (AGENTS.md 10).
 */
function assertRows(value: unknown, label: string, invalidatedAt: Map<string, string>): void {
  if (!Array.isArray(value)) throw new Error(`malformed implement state: ${label} must be an array`);
  if (value.length === 0) throw new Error(`malformed implement state: ${label} must hold at least one Behaviors row`);
  const rowIds = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const rowLabel = `${label}[${index}]`;
    assertRecord(entry, rowLabel);
    assertString(entry["id"], `${rowLabel}.id`);
    if (!/^B[1-9]\d*$/.test(entry["id"])) throw new Error(`malformed implement state: ${rowLabel}.id must match B<n>`);
    if (rowIds.has(entry["id"])) throw new Error(`malformed implement state: duplicate row ${entry["id"]}`);
    rowIds.add(entry["id"]);
    assertString(entry["behavior"], `${rowLabel}.behavior`);
    assertRecord(entry["check"], `${rowLabel}.check`);
    const kind = String(entry["check"]["kind"]);
    if (!CHECK_KINDS.has(kind)) throw new Error(`malformed implement state: ${rowLabel}.check.kind must be check, judge, or human`);
    if (kind === "check") {
      assertString(entry["check"]["command"], `${rowLabel}.check.command`);
      assertStringArray(entry["check"]["argv"], `${rowLabel}.check.argv`, true);
    } else if (kind === "judge") {
      assertString(entry["check"]["evidence"], `${rowLabel}.check.evidence`);
    } else {
      assertString(entry["check"]["confirmation"], `${rowLabel}.check.confirmation`);
    }
    assertStringArray(entry["decisionIds"], `${rowLabel}.decisionIds`);
    if (!ROW_STATUSES.has(String(entry["status"]))) throw new Error(`malformed implement state: ${rowLabel}.status is invalid`);
    for (const field of ["attempts", "parks", "rejections"] as const) {
      if (!Array.isArray(entry[field])) throw new Error(`malformed implement state: ${rowLabel}.${field} must be an array`);
    }
    if (!Number.isInteger(entry["consecutiveFailures"]) || Number(entry["consecutiveFailures"]) < 0) {
      throw new Error(`malformed implement state: ${rowLabel}.consecutiveFailures must be a non-negative integer`);
    }
    const attempts = entry["attempts"] as unknown[];
    const parks = entry["parks"] as unknown[];
    if (kind !== "check" && (attempts.length > 0 || parks.length > 0)) {
      throw new Error(`malformed implement state: ${rowLabel} is a ${kind}: row and cannot carry attempts or parks`);
    }
    for (const [attemptIndex, attempt] of attempts.entries()) assertCheckAttempt(attempt, `${rowLabel}.attempts[${attemptIndex}]`, attemptIndex);

    let activePark = false;
    let latestResume: string | null = null;
    for (const [parkIndex, park] of parks.entries()) {
      const parkLabel = `${rowLabel}.parks[${parkIndex}]`;
      assertRecord(park, parkLabel);
      assertIsoTimestamp(park["parkedAt"], `${parkLabel}.parkedAt`);
      // Every park quotes the human approval that authorised it; a park
      // without one is the refusal park.ts makes, and storing it would
      // launder that refusal into the record.
      assertString(park["approval"], `${parkLabel}.approval`);
      if ((park["approval"] as string).trim() === "") throw new Error(`malformed implement state: ${parkLabel}.approval must quote the human approval`);
      assertString(park["reason"], `${parkLabel}.reason`);
      assertNullableString(park["evidence"], `${parkLabel}.evidence`);
      if (park["resumedAt"] === null) {
        if (parkIndex !== parks.length - 1) throw new Error(`malformed implement state: only the latest park may be active`);
        activePark = true;
      } else {
        assertIsoTimestamp(park["resumedAt"], `${parkLabel}.resumedAt`);
        latestResume = park["resumedAt"] as string;
      }
    }

    if (entry["verdict"] !== null) {
      if (kind !== "judge") throw new Error(`malformed implement state: ${rowLabel}.verdict is valid only for a judge: row`);
      assertRecord(entry["verdict"], `${rowLabel}.verdict`);
      assertString(entry["verdict"]["attemptId"], `${rowLabel}.verdict.attemptId`);
      if (entry["verdict"]["verdict"] !== "PASS" && entry["verdict"]["verdict"] !== "FAIL") throw new Error(`malformed implement state: ${rowLabel}.verdict.verdict must be PASS or FAIL`);
      assertString(entry["verdict"]["reason"], `${rowLabel}.verdict.reason`);
    }
    if (entry["human"] !== null) {
      if (kind !== "human") throw new Error(`malformed implement state: ${rowLabel}.human is valid only for a human: row`);
      assertRecord(entry["human"], `${rowLabel}.human`);
      assertIsoTimestamp(entry["human"]["confirmedAt"], `${rowLabel}.human.confirmedAt`);
      assertString(entry["human"]["evidence"], `${rowLabel}.human.evidence`);
    }
    for (const [rejectionIndex, rejection] of (entry["rejections"] as unknown[]).entries()) {
      const rejectionLabel = `${rowLabel}.rejections[${rejectionIndex}]`;
      if (kind !== "human") throw new Error(`malformed implement state: ${rejectionLabel} is valid only for a human: row`);
      assertRecord(rejection, rejectionLabel);
      assertIsoTimestamp(rejection["at"], `${rejectionLabel}.at`);
      assertString(rejection["evidence"], `${rejectionLabel}.evidence`);
    }

    let derivedStatus: string;
    let derivedFailures = 0;
    if (kind === "check") {
      const invalidation = invalidatedAt.get(entry["id"] as string) ?? null;
      const boundary = [latestResume, invalidation].filter((at): at is string => at !== null).sort().at(-1) ?? null;
      const counted = (attempts as Array<Record<string, unknown>>).filter((attempt) => boundary === null || (attempt["finishedAt"] as string) >= boundary);
      const latest = counted.at(-1);
      derivedStatus = activePark ? "parked" : latest === undefined ? "pending" : latest["outcome"] === "green" ? "green" : "fail";
      for (const attempt of counted.slice().reverse()) {
        if (attempt["outcome"] === "green") break;
        derivedFailures += 1;
      }
    } else if (kind === "judge") {
      derivedStatus = entry["verdict"] === null ? "pending" : ((entry["verdict"] as Record<string, unknown>)["verdict"] as string);
    } else {
      derivedStatus = entry["human"] === null ? "OPEN" : "PASS";
    }
    if (entry["status"] !== derivedStatus) {
      throw new Error(`malformed implement state: ${rowLabel}.status ${String(entry["status"])} contradicts the harness-owned ledger (expected ${derivedStatus})`);
    }
    if (entry["consecutiveFailures"] !== derivedFailures) {
      throw new Error(`malformed implement state: ${rowLabel}.consecutiveFailures contradicts the harness-owned attempt ledger (expected ${derivedFailures})`);
    }
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
  if (value["design"] !== undefined && value["design"] !== null) assertRoundContext(value["design"], `${label}.design`);
}

const ISSUER_LABELS = new Set(["implementor", "observer", "human"]);

/**
 * v7's six append-only ledgers. Validated as required fields rather than
 * normalized-if-missing (the way riskFindings was in v5): a v7 state that
 * lacks its sealed suite list cannot be told apart from one whose suite was
 * genuinely empty, and completion authority must never guess (PRINCIPLES 10).
 */
function assertSupervisionLedgers(candidate: Partial<ImplementState>): void {
  if (!Array.isArray(candidate.events)) throw new Error("malformed implement state: events must be an array");
  let previousEventId = 0;
  for (const [index, entry] of candidate.events.entries()) {
    assertRecord(entry, `events[${index}]`);
    const id = entry["id"];
    if (typeof id !== "number" || !Number.isInteger(id) || id <= previousEventId) {
      throw new Error(`malformed implement state: events[${index}].id must be an integer greater than the previous event id`);
    }
    previousEventId = id;
    assertString(entry["at"], `events[${index}].at`);
    assertString(entry["kind"], `events[${index}].kind`);
    if (!ISSUER_LABELS.has(String(entry["actor"]))) {
      throw new Error(`malformed implement state: events[${index}].actor must be implementor, observer, or human`);
    }
    assertNullableString(entry["subject"], `events[${index}].subject`);
    assertString(entry["summary"], `events[${index}].summary`);
  }

  if (candidate.evidenceReplacements === undefined) candidate.evidenceReplacements = [];
  if (!Array.isArray(candidate.evidenceReplacements)) {
    throw new Error("malformed implement state: evidenceReplacements must be an array");
  }
  let lastReplacementId = 0;
  for (const [index, entry] of candidate.evidenceReplacements.entries()) {
    const label = `evidenceReplacements[${index}]`;
    assertRecord(entry, label);
    // Append-only and monotonic, like every other ledger the record keeps: a
    // renumbered resubmission history could hide a discarded capture.
    if (typeof entry["id"] !== "number" || entry["id"] <= lastReplacementId) {
      throw new Error(`malformed implement state: ${label}.id must be monotonically increasing`);
    }
    lastReplacementId = entry["id"] as number;
    assertIsoTimestamp(entry["at"], `${label}.at`);
    assertString(entry["rowId"], `${label}.rowId`);
    if (entry["kind"] !== "artifact" && entry["kind"] !== "trail") {
      throw new Error(`malformed implement state: ${label}.kind must be artifact or trail`);
    }
    assertString(entry["previous"], `${label}.previous`);
    assertString(entry["next"], `${label}.next`);
    if (entry["priorDisposition"] !== "preserved" && entry["priorDisposition"] !== "invalidated") {
      throw new Error(`malformed implement state: ${label}.priorDisposition must be preserved or invalidated`);
    }
  }

  if (!Array.isArray(candidate.verbs)) throw new Error("malformed implement state: verbs must be an array");
  for (const [index, entry] of candidate.verbs.entries()) {
    assertRecord(entry, `verbs[${index}]`);
    if (!ISSUED_COMMANDS.includes(String(entry["verb"]) as IssuedCommand)) {
      throw new Error(`malformed implement state: verbs[${index}].verb must be one of ${ISSUED_COMMANDS.join(", ")}`);
    }
    if (!ISSUER_LABELS.has(String(entry["issuer"]))) {
      throw new Error(`malformed implement state: verbs[${index}].issuer must be implementor, observer, or human`);
    }
    const outcome = entry["outcome"];
    if (outcome !== "accepted" && outcome !== "rejected") {
      throw new Error(`malformed implement state: verbs[${index}].outcome must be accepted or rejected`);
    }
    // The rejection detail is the record of WHICH of the three checks refused
    // (R7). An accepted verb carrying one, or a rejected verb missing one,
    // would make the ledger unable to answer that question honestly.
    if (outcome === "rejected") {
      assertRecord(entry["rejection"], `verbs[${index}].rejection`);
      if (!["arguments", "authority", "transition"].includes(String((entry["rejection"] as Record<string, unknown>)["check"]))) {
        throw new Error(`malformed implement state: verbs[${index}].rejection.check must be arguments, authority, or transition`);
      }
    } else if (entry["rejection"] !== null) {
      throw new Error(`malformed implement state: verbs[${index}].rejection must be null when outcome is accepted`);
    }
  }

  if (!Array.isArray(candidate.amendments)) throw new Error("malformed implement state: amendments must be an array");
  for (const [index, entry] of candidate.amendments.entries()) {
    assertRecord(entry, `amendments[${index}]`);
    // The authority split is the whole point of R6 (prd-template): an
    // observer may repair a check cell, never a behavior. A record claiming
    // an observer behaviors amendment is one the gate could not have written.
    if (entry["scope"] !== "check-cells" && entry["scope"] !== "behaviors") {
      throw new Error(`malformed implement state: amendments[${index}].scope must be check-cells or behaviors`);
    }
    if (entry["issuer"] !== "human" && !(entry["issuer"] === "observer" && entry["scope"] === "check-cells")) {
      throw new Error(`malformed implement state: amendments[${index}].issuer must be human, or observer for a check-cells amendment`);
    }
    assertString(entry["approval"], `amendments[${index}].approval`);
    assertString(entry["reason"], `amendments[${index}].reason`);
    assertString(entry["prdSha256"], `amendments[${index}].prdSha256`);
    assertString(entry["snapshotPath"], `amendments[${index}].snapshotPath`);
    // The archive path is what makes "this amendment replaced that text"
    // checkable rather than asserted; a record without it cannot be audited.
    assertString(entry["previousSnapshotPath"], `amendments[${index}].previousSnapshotPath`);
    for (const field of ["invalidatedRows", "addedRows", "unparkedRows"]) {
      if (!Array.isArray(entry[field])) {
        throw new Error(`malformed implement state: amendments[${index}].${field} must be an array`);
      }
    }
  }

  assertRecord(candidate.suite, "suite");
  assertString(candidate.suite["sealedAt"], "suite.sealedAt");
  const suiteCommands = candidate.suite["commands"];
  if (!Array.isArray(suiteCommands)) throw new Error("malformed implement state: suite.commands must be an array");
  const suiteIds = new Set<string>();
  for (const [index, entry] of suiteCommands.entries()) {
    assertRecord(entry, `suite.commands[${index}]`);
    assertString(entry["id"], `suite.commands[${index}].id`);
    if (suiteIds.has(entry["id"] as string)) {
      throw new Error(`malformed implement state: duplicate suite command id ${String(entry["id"])}`);
    }
    suiteIds.add(entry["id"] as string);
    assertString(entry["command"], `suite.commands[${index}].command`);
    assertString(entry["cwd"], `suite.commands[${index}].cwd`);
    if (!Array.isArray(entry["argv"])) throw new Error(`malformed implement state: suite.commands[${index}].argv must be an array`);
  }
  for (const field of ["exclusions", "results"]) {
    if (!Array.isArray(candidate.suite[field])) {
      throw new Error(`malformed implement state: suite.${field} must be an array`);
    }
  }
  for (const [index, entry] of (candidate.suite["exclusions"] as unknown[]).entries()) {
    assertRecord(entry, `suite.exclusions[${index}]`);
    assertString(entry["commandId"], `suite.exclusions[${index}].commandId`);
    // An exclusion without a verbatim human approval is the exact thing AC6
    // refuses. Storing one would launder a refused action into the record.
    assertString(entry["approval"], `suite.exclusions[${index}].approval`);
    assertString(entry["reason"], `suite.exclusions[${index}].reason`);
  }
  for (const [index, entry] of (candidate.suite["results"] as unknown[]).entries()) {
    assertRecord(entry, `suite.results[${index}]`);
    assertString(entry["commandId"], `suite.results[${index}].commandId`);
    assertString(entry["attemptId"], `suite.results[${index}].attemptId`);
    if (!Number.isInteger(entry["exitCode"])) throw new Error(`malformed implement state: suite.results[${index}].exitCode must be an integer`);
    if (typeof entry["mutatedTree"] !== "boolean") throw new Error(`malformed implement state: suite.results[${index}].mutatedTree must be boolean`);
    if (entry["status"] !== "GREEN" && entry["status"] !== "RED") {
      throw new Error(`malformed implement state: suite.results[${index}].status must be GREEN or RED`);
    }
    // The suite row records no timeout or signal. That is safe because the
    // executor never pairs either with exit 0: a timeout records 124 and a
    // signal death records 1 (mechanical.ts executeMechanicalArgv), so the
    // exit code alone carries the process verdict here.
    const expectedStatus = mechanicalOutcome({ exitCode: entry["exitCode"] as number, timedOut: false, signal: null, mutatedTree: entry["mutatedTree"] as boolean }) === "green" ? "GREEN" : "RED";
    if (entry["status"] !== expectedStatus) {
      throw new Error(`malformed implement state: suite.results[${index}].status ${String(entry["status"])} contradicts the recorded process result (expected ${expectedStatus})`);
    }
  }

  if (!Array.isArray(candidate.qaBriefs)) throw new Error("malformed implement state: qaBriefs must be an array");
  const briefIds = new Set<string>();
  for (const [index, entry] of candidate.qaBriefs.entries()) {
    assertRecord(entry, `qaBriefs[${index}]`);
    assertString(entry["briefId"], `qaBriefs[${index}].briefId`);
    // Reissuing for the same criterion must mint a distinct id, or a trail
    // echoing a stale brief could not be told from a current one (AC30).
    if (briefIds.has(entry["briefId"] as string)) {
      throw new Error(`malformed implement state: duplicate qa brief id ${String(entry["briefId"])}`);
    }
    briefIds.add(entry["briefId"] as string);
    assertString(entry["rowId"], `qaBriefs[${index}].rowId`);
    assertString(entry["prdSha256"], `qaBriefs[${index}].prdSha256`);
    const steps = entry["steps"];
    if (!Array.isArray(steps)) throw new Error(`malformed implement state: qaBriefs[${index}].steps must be an array`);
    for (const [stepIndex, step] of steps.entries()) {
      assertRecord(step, `qaBriefs[${index}].steps[${stepIndex}]`);
      assertString(step["id"], `qaBriefs[${index}].steps[${stepIndex}].id`);
      assertString(step["text"], `qaBriefs[${index}].steps[${stepIndex}].text`);
    }
  }

  if (!Array.isArray(candidate.trails)) throw new Error("malformed implement state: trails must be an array");
  for (const [index, entry] of candidate.trails.entries()) {
    assertRecord(entry, `trails[${index}]`);
    assertString(entry["rowId"], `trails[${index}].rowId`);
    assertString(entry["briefId"], `trails[${index}].briefId`);
    // The implementor and the solver are absent from this set on purpose:
    // a row proven by driving must not be driven by the agent whose
    // work it judges (AC32). The check is of the declaration, not identity.
    if (!["human", "observer", "qa-agent"].includes(String(entry["driverRole"]))) {
      throw new Error(`malformed implement state: trails[${index}].driverRole must be human, observer, or qa-agent`);
    }
    if (!Array.isArray(entry["coveredStepIds"])) {
      throw new Error(`malformed implement state: trails[${index}].coveredStepIds must be an array`);
    }
    if (entry["status"] !== "accepted" && entry["status"] !== "superseded") {
      throw new Error(`malformed implement state: trails[${index}].status must be accepted or superseded`);
    }
  }

  if (!Array.isArray(candidate.escalations)) throw new Error("malformed implement state: escalations must be an array");
  for (const [index, entry] of candidate.escalations.entries()) {
    assertRecord(entry, `escalations[${index}]`);
    assertString(entry["reason"], `escalations[${index}].reason`);
    const outcome = entry["outcome"];
    if (outcome !== "diagnosed" && outcome !== "summon-failed") {
      throw new Error(`malformed implement state: escalations[${index}].outcome must be diagnosed or summon-failed`);
    }
    // A failed summon has no diagnosis and no handoff; a successful one has
    // both. Recording a handoff for a failed summon would claim a
    // replacement was briefed when none was (AC35, AC41).
    if (outcome === "summon-failed") {
      if (entry["handoff"] !== null) {
        throw new Error(`malformed implement state: escalations[${index}].handoff must be null when the summon failed`);
      }
      assertString(entry["error"], `escalations[${index}].error`);
    } else {
      assertRecord(entry["handoff"], `escalations[${index}].handoff`);
      assertString(entry["diagnosis"], `escalations[${index}].diagnosis`);
    }
  }
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
  if (candidate.status !== "active" && candidate.status !== "complete-pending-human" && candidate.status !== "complete" && candidate.status !== "blocked" && candidate.status !== "retired") {
    throw new Error(`malformed implement state: status must be active, complete-pending-human, complete, blocked, or retired, got ${String(candidate.status ?? "missing")}`);
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

  if (!Array.isArray(candidate.deviations)) throw new Error("malformed implement state: deviations must be an array");
  // The supervision ledgers are validated first because the row ledger's
  // derivation reads the amendment history.
  assertSupervisionLedgers(candidate);
  assertRows(candidate.rows, "rows", latestInvalidationByRow(candidate.amendments as AmendmentRecord[]));
  // A closed run's status is a function of its rows: `complete` means every
  // row is proved, `complete-pending-human` means only human: rows are left
  // OPEN (R8). The reader re-derives it so `confirm` cannot be skipped.
  if (candidate.status === "complete" || candidate.status === "complete-pending-human") {
    const rows = candidate.rows as Array<{ status: string; check: { kind: string } }>;
    const open = rows.filter((row) => row.status === "OPEN").length;
    const unproved = rows.filter((row) => row.status !== "OPEN" && row.status !== "green" && row.status !== "PASS").length;
    if (unproved > 0) throw new Error(`malformed implement state: status ${candidate.status} with ${unproved} unproved check:/judge: row(s)`);
    const expected = open > 0 ? "complete-pending-human" : "complete";
    if (candidate.status !== expected) throw new Error(`malformed implement state: status ${candidate.status} contradicts ${open} OPEN human: row(s) (expected ${expected})`);
  }
  if (!Array.isArray(candidate.artifacts) || !Array.isArray(candidate.verificationAttempts)) {
    throw new Error("malformed implement state: artifacts and verificationAttempts must be arrays");
  }
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
    if (entry["nonConvergence"] !== undefined) {
      const label = `riskFindings[${index}].nonConvergence`;
      assertRecord(entry["nonConvergence"], label);
      for (const field of ["at", "approval", "reason"] as const) {
        assertString(entry["nonConvergence"][field], `${label}.${field}`);
      }
      // The declaration is human-only by authority; a state claiming any
      // other declarer is a record the gate could not have produced.
      if (entry["nonConvergence"]["declaredBy"] !== "human") {
        throw new Error(`malformed implement state: ${label}.declaredBy must be human`);
      }
      if (typeof entry["nonConvergence"]["roundsUnchanged"] !== "number") {
        throw new Error(`malformed implement state: ${label}.roundsUnchanged must be a number`);
      }
    }
  }
  for (const [index, attempt] of candidate.verificationAttempts.entries()) {
    assertRecord(attempt, `verificationAttempts[${index}]`);
    assertString(attempt["id"], `verificationAttempts[${index}].id`);
    assertInputManifest(attempt["inputManifest"], `verificationAttempts[${index}].inputManifest`);
    assertRoundContexts(attempt["roundContexts"], `verificationAttempts[${index}].roundContexts`);
    if (!Array.isArray(attempt["parkedRows"])) {
      throw new Error(`malformed implement state: verificationAttempts[${index}].parkedRows must be an array`);
    }
    for (const [skipIndex, skipped] of attempt["parkedRows"].entries()) {
      assertRecord(skipped, `verificationAttempts[${index}].parkedRows[${skipIndex}]`);
      assertString(skipped["id"], `verificationAttempts[${index}].parkedRows[${skipIndex}].id`);
      assertString(skipped["reason"], `verificationAttempts[${index}].parkedRows[${skipIndex}].reason`);
    }
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

export function persistState(statePath: string, state: ImplementState): void {
  const baseline = stateBaseline.get(state);
  const onDisk = stateFileDigest(statePath);
  if (baseline !== undefined && baseline.statePath === statePath) {
    if (onDisk !== baseline.digest) {
      throw new Error(
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

/**
 * Close a run record: persist the state, then write the files derived from
 * it, as one exclusive step.
 *
 * Order and exclusion both matter. State first, because `persistState` is the
 * compare-and-swap: a receipt written before it could survive a rejected state
 * write and contradict the record. Exclusive, because two closers that both
 * persist in sequence could still interleave their derived writes - the
 * earlier closer resuming after the later one and stamping an older receipt
 * over the newer state (risk finding RF1 on the prd-template run,
 * 2026-09-06). A closer that finds the lock held is refused with nothing
 * written; a closer that loaded a state the lock holder has since replaced is
 * refused by the compare-and-swap. Either way the receipt on disk is a
 * projection of the state on disk.
 */
export function persistClose(statePath: string, state: ImplementState, derived: Array<{ file: string; text: string }>): void {
  const lockPath = path.join(state.projectRoot, state.runDir, ".close.lock");
  const release = tryAcquireLock(lockPath, { recoverDeadOwner: true, topic: state.topicSlug });
  if (release === null) {
    throw new Error(`another finalize or confirm is writing this run's record (${path.relative(state.projectRoot, lockPath)}); nothing was written. Re-run the command.`);
  }
  try {
    persistState(statePath, state);
    for (const entry of derived) writeTextAtomic(entry.file, entry.text);
  } finally {
    release();
  }
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
 * Semantic freshness belongs to the judges; the attempt-level source pin still
 * blocks finalize after any later source edit.
 */
export function artifactIntegrityProblems(projectRoot: string, state: ImplementState): string[] {
  const problems: string[] = [];
  for (const artifact of state.artifacts) {
    const target = artifact.rowId ?? "run";
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
