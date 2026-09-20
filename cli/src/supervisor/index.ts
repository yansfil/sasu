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
  lastWake: WakeRecord | null;
  /** One bounded current episode per reason. */
  acknowledgements: Partial<Record<WakeReason, string>>;
  lastAcknowledgedAt: string | null;
  /** Unknown delivery is retried a bounded number of times, never treated as accepted. */
  pendingWake: { episode: string; attempts: number; at: string } | null;
  lastFailure: { at: string; detail: string } | null;
  lastObservation: { at: string; observer: string; implementor: string; guardedPrompt: boolean } | null;
}

export interface SupervisorIndex {
  schema: typeof INDEX_SCHEMA;
  lastTickAt: string | null;
  lastHerdr: { available: boolean; detail: string | null } | null;
  entries: IndexEntry[];
  removed: Array<{ at: string; statePath: string; cause: string }>;
}

export const REMOVED_HISTORY_CAP = 50;
export const MISSING_TICKS_BEFORE_CLEANUP = 3;
export const MAX_INDEX_ENTRIES = 1024;
export const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const RETAINED_REVISIONS = 4;
const REVISION_PREFIX = ".revision-";

export function emptyIndex(): SupervisorIndex {
  return { schema: INDEX_SCHEMA, lastTickAt: null, lastHerdr: null, entries: [], removed: [] };
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
      pendingWake = { episode: pending["episode"], attempts: Number(pending["attempts"]), at: pending["at"] };
    }
    return {
      statePath: record["statePath"], runInstanceId: record["runInstanceId"], enrollmentId,
      recoveryOwner: record["recoveryOwner"], addedAt: typeof record["addedAt"] === "string" ? record["addedAt"] : "1970-01-01T00:00:00.000Z",
      missingTicks: record["missingTicks"] as number, lastWake: (record["lastWake"] ?? null) as WakeRecord | null,
      acknowledgements, lastAcknowledgedAt: optionalTimestamp(record["lastAcknowledgedAt"], "lastAcknowledgedAt", file), pendingWake,
      lastFailure: (record["lastFailure"] ?? null) as IndexEntry["lastFailure"], lastObservation: (record["lastObservation"] ?? null) as IndexEntry["lastObservation"],
    };
  });
  return {
    schema: INDEX_SCHEMA,
    lastTickAt: optionalTimestamp(candidate["lastTickAt"], "lastTickAt", file),
    lastHerdr: candidate["lastHerdr"] !== null && typeof candidate["lastHerdr"] === "object" ? candidate["lastHerdr"] as SupervisorIndex["lastHerdr"] : null,
    entries,
    removed: Array.isArray(candidate["removed"]) ? candidate["removed"] as SupervisorIndex["removed"] : [],
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

function readSource(file: string): { revision: number; source: string | null; sourceFile: string } {
  const found = revisions(file);
  if (found.length > 0) {
    const revision = found.at(-1)!;
    const sourceFile = revisionFile(file, revision);
    const size = fs.statSync(sourceFile).size;
    if (size > MAX_INDEX_BYTES) throw new Error(`supervisor index is ${size} bytes, above the ${MAX_INDEX_BYTES} byte cap: ${sourceFile}`);
    return { revision, source: fs.readFileSync(sourceFile, "utf8"), sourceFile };
  }
  if (!fs.existsSync(file)) return { revision: 0, source: null, sourceFile: file };
  const size = fs.statSync(file).size;
  if (size > MAX_INDEX_BYTES) throw new Error(`supervisor index is ${size} bytes, above the ${MAX_INDEX_BYTES} byte cap: ${file}`);
  return { revision: 0, source: fs.readFileSync(file, "utf8"), sourceFile: file };
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

/**
 * Atomic optimistic update without a lock file. Writers compete to create the
 * same immutable next revision with link(2). Exactly one succeeds; losers
 * re-read and re-apply their mutation. This closes the old compare-then-rename
 * window where both writers could compare equal and the later rename won.
 */
export function updateIndex(file: string, mutate: (index: SupervisorIndex) => void, attempts = 8, beforeCommit?: () => void): SupervisorIndex {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const before = readSource(file);
    const index = parseSource(before.source, before.sourceFile);
    mutate(index);
    if (index.entries.length > MAX_INDEX_ENTRIES) throw new Error(`supervisor index entry cap ${MAX_INDEX_ENTRIES} exceeded; nothing was written`);
    if (index.removed.length > REMOVED_HISTORY_CAP) index.removed = index.removed.slice(-REMOVED_HISTORY_CAP);
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
      // A writer can sleep long enough for its comparison revision and next
      // slot to be pruned, then successfully recreate that old slot. It has
      // not joined the current chain in that case. Re-read after link and
      // re-apply the same intent unless this write is still the head.
      if (readSource(file).revision !== committedRevision) {
        try { fs.unlinkSync(revisionFile(file, committedRevision)); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        continue;
      }
      pruneRevisions(file);
      return index;
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
      addedAt: entry.at, missingTicks: 0, lastWake: null, acknowledgements: {}, lastAcknowledgedAt: null, pendingWake: null,
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
