import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const INDEX_SCHEMA = "sasu.supervisor.index.v1" as const;
export type WakeReason = "settled" | "blocked" | "escalate" | "stall" | "implementor-gone" | "terminal" | "patrol";

export interface WakeRecord {
  at: string;
  reasons: WakeReason[];
  episode: string;
  outcome: "accepted" | "rejected" | "unknown";
  path: "session-match" | "guarded";
  code: string;
}

export type RecoveryOwner = "supervisor" | "task-factory";

export interface IndexEntry {
  statePath: string;
  runInstanceId: string;
  /** Changes on every enrollment, even when the state path is reused. */
  enrollmentId: string;
  recoveryOwner: RecoveryOwner;
  addedAt: string;
  missingTicks: number;
  /** Consecutive ticks where a terminal run could not notify its Observer. */
  terminalFailureTicks: number;
  lastWake: WakeRecord | null;
  /** One bounded current episode per reason. */
  acknowledgements: Partial<Record<WakeReason, string>>;
  lastAcknowledgedAt: string | null;
  /** Unknown delivery is retried a bounded number of times, never treated as accepted. */
  pendingWake: { episode: string; attempts: number; at: string; operationId: string | null; status: "reserved" | "unknown" } | null;
  lastFailure: { at: string; detail: string } | null;
  lastObservation: { at: string; observer: string; implementor: string; guardedPrompt: boolean } | null;
}

export interface SupervisorIndex {
  schema: typeof INDEX_SCHEMA;
  lastTickAt: string | null;
  lastHerdr: { available: boolean; detail: string | null } | null;
  entries: IndexEntry[];
  removed: Array<{ at: string; statePath: string; cause: string }>;
  /** Terminal notifications abandoned only after bounded definite failures. */
  undeliveredTerminal: Array<{ at: string; statePath: string; runInstanceId: string; enrollmentId: string; failures: number; detail: string }>;
  /** One durable executor lease serializes scheduled and manually requested ticks. */
  tickExecutor: { operationId: string; pid: number; processIncarnation: string | null; startedAt: string; expiresAt: string } | null;
  /** Bounded operation ids make a linked write recognizable under a newer head. */
  appliedWrites: string[];
}

export const REMOVED_HISTORY_CAP = 50;
export const UNDELIVERED_TERMINAL_CAP = 50;
export const MISSING_TICKS_BEFORE_CLEANUP = 3;
export const MAX_INDEX_ENTRIES = 1024;
export const MAX_INDEX_BYTES = 8 * 1024 * 1024;
export const APPLIED_WRITES_CAP = 1024;
const RETAINED_REVISIONS = 4;
const REVISION_PREFIX = ".revision-";
const READ_RETRIES = 4;

export function emptyIndex(): SupervisorIndex {
  return { schema: INDEX_SCHEMA, lastTickAt: null, lastHerdr: null, entries: [], removed: [], undeliveredTerminal: [], tickExecutor: null, appliedWrites: [] };
}

const legacyEnrollmentId = (entry: Record<string, unknown>): string =>
  `legacy-${crypto.createHash("sha256").update(`${String(entry["statePath"])}\0${String(entry["runInstanceId"])}\0${String(entry["addedAt"] ?? "")}`).digest("hex").slice(0, 24)}`;

function optionalTimestamp(value: unknown, label: string, file: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`supervisor index ${label} is not a timestamp: ${file}`);
  return value;
}

function assertIndex(value: unknown, file: string): SupervisorIndex {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`supervisor index is not an object: ${file}`);
  const candidate = value as Record<string, unknown>;
  if (candidate["schema"] !== INDEX_SCHEMA) throw new Error(`unsupported supervisor index schema ${String(candidate["schema"] ?? "missing")} in ${file}; expected ${INDEX_SCHEMA}`);
  if (!Array.isArray(candidate["entries"])) throw new Error(`supervisor index has no entries array: ${file}`);
  if (candidate["entries"].length > MAX_INDEX_ENTRIES) throw new Error(`supervisor index has ${candidate["entries"].length} entries, above the ${MAX_INDEX_ENTRIES} entry cap: ${file}`);
  const entries = (candidate["entries"] as unknown[]).map((entry): IndexEntry => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`supervisor index entry is not an object: ${file}`);
    const record = entry as Record<string, unknown>;
    if (typeof record["statePath"] !== "string" || !path.isAbsolute(record["statePath"]) || record["statePath"].length > 4096) throw new Error(`supervisor index entry has no valid absolute statePath: ${file}`);
    if (typeof record["runInstanceId"] !== "string" || record["runInstanceId"] === "" || record["runInstanceId"].length > 256) throw new Error(`supervisor index entry ${record["statePath"]} has no valid runInstanceId: ${file}`);
    if (!Number.isInteger(record["missingTicks"]) || (record["missingTicks"] as number) < 0) throw new Error(`supervisor index entry ${record["statePath"]} has an invalid missingTicks: ${file}`);
    if (record["recoveryOwner"] !== "supervisor" && record["recoveryOwner"] !== "task-factory") throw new Error(`supervisor index entry ${record["statePath"]} has no recoveryOwner: ${file}`);
    const enrollmentId = typeof record["enrollmentId"] === "string" && record["enrollmentId"] !== "" ? record["enrollmentId"] : legacyEnrollmentId(record);
    const acknowledgements = record["acknowledgements"] !== null && typeof record["acknowledgements"] === "object" && !Array.isArray(record["acknowledgements"])
      ? record["acknowledgements"] as Partial<Record<WakeReason, string>> : {};
    for (const [reason, episode] of Object.entries(acknowledgements)) {
      if (!(["settled", "blocked", "escalate", "stall", "implementor-gone", "terminal", "patrol"] as string[]).includes(reason) || typeof episode !== "string" || episode === "") throw new Error(`supervisor index entry ${record["statePath"]} has invalid acknowledgements: ${file}`);
    }
    let pendingWake: IndexEntry["pendingWake"] = null;
    if (record["pendingWake"] !== null && record["pendingWake"] !== undefined) {
      if (typeof record["pendingWake"] !== "object" || Array.isArray(record["pendingWake"])) throw new Error(`supervisor index entry ${record["statePath"]} has invalid pendingWake: ${file}`);
      const pending = record["pendingWake"] as Record<string, unknown>;
      if (typeof pending["episode"] !== "string" || !Number.isInteger(pending["attempts"]) || Number(pending["attempts"]) < 1 || typeof pending["at"] !== "string") throw new Error(`supervisor index entry ${record["statePath"]} has invalid pendingWake: ${file}`);
      const status = pending["status"] === undefined ? "unknown" : pending["status"];
      if (status !== "reserved" && status !== "unknown") throw new Error(`supervisor index entry ${record["statePath"]} has invalid pendingWake status: ${file}`);
      const operationId = pending["operationId"] === undefined || pending["operationId"] === null ? null : pending["operationId"];
      if (operationId !== null && (typeof operationId !== "string" || operationId === "" || operationId.length > 128)) throw new Error(`supervisor index entry ${record["statePath"]} has invalid pendingWake operationId: ${file}`);
      pendingWake = { episode: pending["episode"], attempts: Number(pending["attempts"]), at: pending["at"], operationId, status };
    }
    const terminalFailureTicks = record["terminalFailureTicks"] === undefined ? 0 : record["terminalFailureTicks"];
    if (!Number.isInteger(terminalFailureTicks) || Number(terminalFailureTicks) < 0) throw new Error(`supervisor index entry ${record["statePath"]} has invalid terminalFailureTicks: ${file}`);
    return {
      statePath: record["statePath"], runInstanceId: record["runInstanceId"], enrollmentId,
      recoveryOwner: record["recoveryOwner"], addedAt: typeof record["addedAt"] === "string" ? record["addedAt"] : "1970-01-01T00:00:00.000Z",
      missingTicks: record["missingTicks"] as number,
      terminalFailureTicks: Number(terminalFailureTicks),
      lastWake: (record["lastWake"] ?? null) as WakeRecord | null,
      acknowledgements, lastAcknowledgedAt: optionalTimestamp(record["lastAcknowledgedAt"], "lastAcknowledgedAt", file), pendingWake,
      lastFailure: (record["lastFailure"] ?? null) as IndexEntry["lastFailure"], lastObservation: (record["lastObservation"] ?? null) as IndexEntry["lastObservation"],
    };
  });
  const appliedWrites = candidate["appliedWrites"] === undefined ? [] : candidate["appliedWrites"];
  if (!Array.isArray(appliedWrites) || appliedWrites.length > APPLIED_WRITES_CAP || appliedWrites.some((entry) => typeof entry !== "string" || entry === "" || entry.length > 128)) {
    throw new Error(`supervisor index has invalid appliedWrites: ${file}`);
  }
  const tickExecutor = candidate["tickExecutor"] === undefined ? null : candidate["tickExecutor"];
  let parsedTickExecutor: SupervisorIndex["tickExecutor"] = null;
  if (tickExecutor !== null) {
    if (typeof tickExecutor !== "object" || Array.isArray(tickExecutor)) throw new Error(`supervisor index has invalid tickExecutor: ${file}`);
    const lease = tickExecutor as Record<string, unknown>;
    if (typeof lease["operationId"] !== "string" || !Number.isInteger(lease["pid"]) || Number(lease["pid"]) < 1 || optionalTimestamp(lease["startedAt"], "tickExecutor.startedAt", file) === null || optionalTimestamp(lease["expiresAt"], "tickExecutor.expiresAt", file) === null) throw new Error(`supervisor index has invalid tickExecutor: ${file}`);
    const processIncarnation = lease["processIncarnation"] === undefined || lease["processIncarnation"] === null ? null : lease["processIncarnation"];
    if (processIncarnation !== null && (typeof processIncarnation !== "string" || processIncarnation === "" || processIncarnation.length > 512)) throw new Error(`supervisor index has invalid tickExecutor processIncarnation: ${file}`);
    parsedTickExecutor = {
      operationId: lease["operationId"],
      pid: Number(lease["pid"]),
      processIncarnation,
      startedAt: String(lease["startedAt"]),
      expiresAt: String(lease["expiresAt"]),
    };
  }
  const undeliveredTerminal = candidate["undeliveredTerminal"] === undefined ? [] : candidate["undeliveredTerminal"];
  if (!Array.isArray(undeliveredTerminal) || undeliveredTerminal.length > UNDELIVERED_TERMINAL_CAP) throw new Error(`supervisor index has invalid undeliveredTerminal history: ${file}`);
  return {
    schema: INDEX_SCHEMA,
    lastTickAt: optionalTimestamp(candidate["lastTickAt"], "lastTickAt", file),
    lastHerdr: candidate["lastHerdr"] !== null && typeof candidate["lastHerdr"] === "object" ? candidate["lastHerdr"] as SupervisorIndex["lastHerdr"] : null,
    entries,
    removed: Array.isArray(candidate["removed"]) ? candidate["removed"] as SupervisorIndex["removed"] : [],
    undeliveredTerminal: undeliveredTerminal as SupervisorIndex["undeliveredTerminal"],
    tickExecutor: parsedTickExecutor,
    appliedWrites: appliedWrites as string[],
  };
}

function revisionFile(file: string, revision: number): string {
  return `${file}${REVISION_PREFIX}${String(revision).padStart(12, "0")}`;
}

function revisions(file: string): number[] {
  const directory = path.dirname(file);
  if (!fs.existsSync(directory)) return [];
  const prefix = `${path.basename(file)}${REVISION_PREFIX}`;
  return fs.readdirSync(directory).flatMap((name) => {
    if (!name.startsWith(prefix)) return [];
    const suffix = name.slice(prefix.length);
    return /^\d{12}$/.test(suffix) ? [Number(suffix)] : [];
  }).sort((a, b) => a - b);
}

function readDescriptor(sourceFile: string): string {
  const descriptor = fs.openSync(sourceFile, "r");
  try {
    const size = fs.fstatSync(descriptor).size;
    if (size > MAX_INDEX_BYTES) throw new Error(`supervisor index is ${size} bytes, above the ${MAX_INDEX_BYTES} byte cap: ${sourceFile}`);
    return fs.readFileSync(descriptor, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function readSource(file: string): { revision: number; source: string | null; sourceFile: string } {
  for (let attempt = 0; attempt < READ_RETRIES; attempt += 1) {
    const found = revisions(file);
    const revision = found.at(-1) ?? 0;
    const sourceFile = revision === 0 ? file : revisionFile(file, revision);
    try {
      return { revision, source: readDescriptor(sourceFile), sourceFile };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (revision === 0 && revisions(file).length === 0) return { revision: 0, source: null, sourceFile: file };
    }
  }
  throw new Error(`supervisor index head kept changing while it was opened: ${file}; retry the operation`);
}

function parseSource(source: string | null, file: string): SupervisorIndex {
  if (source === null) return emptyIndex();
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch (error) { throw new Error(`malformed supervisor index JSON in ${file}: ${error instanceof Error ? error.message : String(error)}`); }
  return assertIndex(parsed, file);
}

export function readIndex(file: string): SupervisorIndex {
  const source = readSource(file);
  return parseSource(source.source, source.sourceFile);
}

function pruneRevisions(file: string): void {
  const found = revisions(file);
  for (const revision of found.slice(0, -RETAINED_REVISIONS)) {
    try { fs.unlinkSync(revisionFile(file, revision)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function cleanupTemporaryFiles(file: string): void {
  const directory = path.dirname(file);
  if (!fs.existsSync(directory)) return;
  const escaped = path.basename(file).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escaped}\\.(\\d+)\\.[0-9a-f-]+\\.tmp$`);
  for (const name of fs.readdirSync(directory)) {
    const matched = pattern.exec(name);
    if (matched === null) continue;
    let ownerAlive = false;
    try { process.kill(Number(matched[1]), 0); ownerAlive = true; } catch (error) { ownerAlive = (error as NodeJS.ErrnoException).code === "EPERM"; }
    if (ownerAlive) continue;
    try { fs.unlinkSync(path.join(directory, name)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/**
 * Atomic optimistic update without a lock file. Writers compete to create the
 * same immutable next revision with link(2). Exactly one succeeds; losers
 * re-read and re-apply their mutation. This closes the old compare-then-rename
 * window where both writers could compare equal and the later rename won.
 */
export function updateIndex(file: string, mutate: (index: SupervisorIndex) => void, attempts = 8, beforeCommit?: () => void, afterCommit?: () => void): SupervisorIndex {
  const operationId = crypto.randomUUID();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const before = readSource(file);
    const index = parseSource(before.source, before.sourceFile);
    mutate(index);
    if (!index.appliedWrites.includes(operationId)) index.appliedWrites.push(operationId);
    if (index.appliedWrites.length > APPLIED_WRITES_CAP) index.appliedWrites = index.appliedWrites.slice(-APPLIED_WRITES_CAP);
    if (index.entries.length > MAX_INDEX_ENTRIES) throw new Error(`supervisor index entry cap ${MAX_INDEX_ENTRIES} exceeded; nothing was written`);
    if (index.removed.length > REMOVED_HISTORY_CAP) index.removed = index.removed.slice(-REMOVED_HISTORY_CAP);
    if (index.undeliveredTerminal.length > UNDELIVERED_TERMINAL_CAP) index.undeliveredTerminal = index.undeliveredTerminal.slice(-UNDELIVERED_TERMINAL_CAP);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const serialized = `${JSON.stringify(index, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_INDEX_BYTES) throw new Error(`supervisor index byte cap ${MAX_INDEX_BYTES} exceeded; nothing was written`);
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, serialized);
    try {
      beforeCommit?.();
      const committedRevision = before.revision + 1;
      fs.linkSync(temporary, revisionFile(file, committedRevision));
      fs.unlinkSync(temporary);
      afterCommit?.();
      // A writer can sleep long enough for its comparison revision and next
      // slot to be pruned, then successfully recreate that old slot. It has
      // not joined the current chain in that case. Re-read after link and
      // re-apply the same intent unless this write is still the head.
      const headSource = readSource(file);
      const head = parseSource(headSource.source, headSource.sourceFile);
      if (!head.appliedWrites.includes(operationId)) {
        try { fs.unlinkSync(revisionFile(file, committedRevision)); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        // Every committed revision appends one operation id. Within the
        // bounded history, absence proves this was a stale link into a pruned
        // slot and replay is safe. At or beyond the retention horizon the
        // write may instead have committed and aged out while this process was
        // paused; replaying then can overwrite a newer enrollment. Fail closed
        // and let the caller retry the whole intent with current authority.
        if (headSource.revision - committedRevision >= APPLIED_WRITES_CAP) {
          throw new Error(`supervisor index write crossed its ${APPLIED_WRITES_CAP}-revision operation history before confirmation; refusing to replay an ambiguous successful write`);
        }
        continue;
      }
      pruneRevisions(file);
      cleanupTemporaryFiles(file);
      return head;
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch {}
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error(`supervisor index at ${file} kept changing underneath this writer; nothing was written after ${attempts} attempts`);
}

export function enrollRun(file: string, entry: { statePath: string; runInstanceId: string; recoveryOwner: RecoveryOwner; at: string }): SupervisorIndex {
  // Retries of this one enrollment preserve its identity. A competing
  // writer may advance the revision after our link, and replaying must not
  // create a second logical enrollment for the same intent.
  const enrollmentId = crypto.randomUUID();
  return updateIndex(file, (index) => {
    const replacing = index.entries.some((existing) => existing.statePath === entry.statePath);
    if (!replacing && index.entries.length >= MAX_INDEX_ENTRIES) throw new Error(`supervisor index entry cap ${MAX_INDEX_ENTRIES} reached; retire or remove a watched run before enrolling another`);
    index.entries = index.entries.filter((existing) => existing.statePath !== entry.statePath);
    index.entries.push({
      statePath: entry.statePath, runInstanceId: entry.runInstanceId, enrollmentId, recoveryOwner: entry.recoveryOwner,
      addedAt: entry.at, missingTicks: 0, terminalFailureTicks: 0, lastWake: null, acknowledgements: {}, lastAcknowledgedAt: null, pendingWake: null,
      lastFailure: null, lastObservation: null,
    });
  });
}

export function unenrollRun(file: string, entry: { statePath: string; runInstanceId: string; at: string; cause: string }): SupervisorIndex {
  return updateIndex(file, (index) => {
    const before = index.entries.length;
    index.entries = index.entries.filter((existing) => existing.statePath !== entry.statePath || existing.runInstanceId !== entry.runInstanceId);
    if (index.entries.length !== before) index.removed.push({ at: entry.at, statePath: entry.statePath, cause: entry.cause });
  });
}

/**
 * Bring one state path to the supervision identity that state.json currently
 * names without resetting a matching enrollment. Recovery can commit state
 * and index only as two ordered writes; the round-two recovery incident left
 * the newer Observer unenrolled when the stale writer changed the index
 * first. Reconciliation after the state CAS makes retries converge, while a
 * same-instance handover keeps its newer enrollment id and acknowledgements.
 */
export function reconcileRunEnrollment(file: string, input: {
  statePath: string;
  desired: { runInstanceId: string; recoveryOwner: RecoveryOwner } | null;
  /** Enrollment generation observed before the caller began prerequisite writes. */
  expectedEnrollmentId?: string | null;
  at: string;
  cause: string;
}): SupervisorIndex {
  const enrollmentId = crypto.randomUUID();
  return updateIndex(file, (index) => {
    const existing = index.entries.find((entry) => entry.statePath === input.statePath);
    const currentEnrollmentId = existing?.enrollmentId ?? null;
    const wouldReplaceGeneration = input.desired === null || existing?.runInstanceId !== input.desired.runInstanceId;
    // A replacement dispatch persists state before enrolling. If it lands
    // while an older recovery is repairing navigation, the older intent no
    // longer owns the enrollment generation and must not undo the new run.
    if (wouldReplaceGeneration && input.expectedEnrollmentId !== undefined && currentEnrollmentId !== input.expectedEnrollmentId) return;
    if (input.desired === null) {
      if (existing === undefined) return;
      index.entries = index.entries.filter((entry) => entry.statePath !== input.statePath);
      index.removed.push({ at: input.at, statePath: input.statePath, cause: input.cause });
      return;
    }
    if (existing?.runInstanceId === input.desired.runInstanceId) {
      existing.recoveryOwner = input.desired.recoveryOwner;
      return;
    }
    if (existing === undefined && index.entries.length >= MAX_INDEX_ENTRIES) {
      throw new Error(`supervisor index entry cap ${MAX_INDEX_ENTRIES} reached; retire or remove a watched run before reconciling recovery`);
    }
    index.entries = index.entries.filter((entry) => entry.statePath !== input.statePath);
    index.entries.push({
      statePath: input.statePath,
      runInstanceId: input.desired.runInstanceId,
      enrollmentId,
      recoveryOwner: input.desired.recoveryOwner,
      addedAt: input.at,
      missingTicks: 0,
      terminalFailureTicks: 0,
      lastWake: null,
      acknowledgements: {},
      lastAcknowledgedAt: null,
      pendingWake: null,
      lastFailure: null,
      lastObservation: null,
    });
  });
}
