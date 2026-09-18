import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * The supervisor's only durable state: which state.json files to watch,
 * plus the per-run facts D-14 asks status to show (the last wake and the
 * last routing failure). Nothing here is a decision: every wake is
 * recomputed from state.json, git and herdr on each tick, and a lost or
 * stale index costs at most one duplicate wake, which D-09 accepts. There
 * is no enrollment state machine, no event cursor and no wake intent (D-05).
 */
export const INDEX_SCHEMA = "sasu.supervisor.index.v1" as const;

export type WakeReason = "settled" | "blocked" | "escalate" | "stall" | "implementor-gone" | "terminal" | "patrol";

export interface WakeRecord {
  at: string;
  reasons: WakeReason[];
  /** Identifies the episode the wake answered, so the same episode is not re-woken (see decide.ts). */
  episode: string;
  outcome: "accepted" | "rejected" | "unknown";
  path: "session-match" | "guarded";
  code: string;
}

export type RecoveryOwner = "supervisor" | "task-factory";

export interface IndexEntry {
  /** Absolute path of the run's state.json in its record tree. */
  statePath: string;
  runInstanceId: string;
  /**
   * Which control loop may replace a vanished Observer (D-15). The supervisor
   * never replaces one either way; the field is here so status shows which
   * loop a human should look at, not to change the tick's behavior.
   */
  recoveryOwner: RecoveryOwner;
  addedAt: string;
  /** Consecutive ticks the file was missing; reset to 0 when it is read. */
  missingTicks: number;
  lastWake: WakeRecord | null;
  /** The last per-run failure of the tick: a parse error, a herdr lookup failure, a rejected wake. */
  lastFailure: { at: string; detail: string } | null;
  /** What the last tick concluded about the run's two sessions, for status; null before the first tick. */
  lastObservation: { at: string; observer: string; implementor: string; guardedPrompt: boolean } | null;
}

export interface SupervisorIndex {
  schema: typeof INDEX_SCHEMA;
  lastTickAt: string | null;
  /** Herdr's answer on the last tick, so status can say whether observation was possible. */
  lastHerdr: { available: boolean; detail: string | null } | null;
  entries: IndexEntry[];
  /** Entries the tick removed with their cause; capped so the index cannot grow with history (engineering 15). */
  removed: Array<{ at: string; statePath: string; cause: string }>;
}

/** How many entries `removed` keeps; older removals fall off the front. */
export const REMOVED_HISTORY_CAP = 50;

/** Consecutive ticks a state.json may be missing before its entry is dropped (B15). */
export const MISSING_TICKS_BEFORE_CLEANUP = 3;

export function emptyIndex(): SupervisorIndex {
  return { schema: INDEX_SCHEMA, lastTickAt: null, lastHerdr: null, entries: [], removed: [] };
}

function assertIndex(value: unknown, file: string): SupervisorIndex {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`supervisor index is not an object: ${file}`);
  const candidate = value as Record<string, unknown>;
  if (candidate["schema"] !== INDEX_SCHEMA) throw new Error(`unsupported supervisor index schema ${String(candidate["schema"] ?? "missing")} in ${file}; expected ${INDEX_SCHEMA}`);
  if (!Array.isArray(candidate["entries"])) throw new Error(`supervisor index has no entries array: ${file}`);
  for (const entry of candidate["entries"] as unknown[]) {
    if (entry === null || typeof entry !== "object") throw new Error(`supervisor index entry is not an object: ${file}`);
    const record = entry as Record<string, unknown>;
    if (typeof record["statePath"] !== "string" || !path.isAbsolute(record["statePath"])) throw new Error(`supervisor index entry has no absolute statePath: ${file}`);
    if (typeof record["runInstanceId"] !== "string" || record["runInstanceId"] === "") throw new Error(`supervisor index entry ${record["statePath"]} has no runInstanceId: ${file}`);
    if (!Number.isInteger(record["missingTicks"]) || (record["missingTicks"] as number) < 0) throw new Error(`supervisor index entry ${record["statePath"]} has an invalid missingTicks: ${file}`);
    if (record["recoveryOwner"] !== "supervisor" && record["recoveryOwner"] !== "task-factory") throw new Error(`supervisor index entry ${record["statePath"]} has no recoveryOwner: ${file}`);
  }
  return {
    schema: INDEX_SCHEMA,
    lastTickAt: typeof candidate["lastTickAt"] === "string" ? candidate["lastTickAt"] : null,
    lastHerdr: candidate["lastHerdr"] !== null && typeof candidate["lastHerdr"] === "object" ? candidate["lastHerdr"] as SupervisorIndex["lastHerdr"] : null,
    entries: candidate["entries"] as IndexEntry[],
    removed: Array.isArray(candidate["removed"]) ? candidate["removed"] as SupervisorIndex["removed"] : [],
  };
}

/**
 * Read the index. A missing file is an empty index; a malformed one is an
 * error, because a supervisor that silently started over would drop every
 * watched run without anyone being told (engineering 4). Doctor and status
 * surface the error; the fix is a human's.
 */
export function readIndex(file: string): SupervisorIndex {
  if (!fs.existsSync(file)) return emptyIndex();
  const text = fs.readFileSync(file, "utf8");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (error) { throw new Error(`malformed supervisor index JSON in ${file}: ${error instanceof Error ? error.message : String(error)}`); }
  return assertIndex(parsed, file);
}

const digest = (text: string): string => crypto.createHash("sha256").update(text).digest("hex");

/**
 * Read-modify-write with the same compare-and-swap the run record uses: the
 * bytes read are the baseline, the rename is refused when the file moved,
 * and the caller's mutation is re-applied against the fresh read. Two
 * writers exist by design - the tick, and any Observer's `dispatch` - and
 * neither may lose the other's entry. No lock file (D-45).
 */
export function updateIndex(file: string, mutate: (index: SupervisorIndex) => void, attempts = 5): SupervisorIndex {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    const index = before === null ? emptyIndex() : assertIndex(JSON.parse(before), file);
    mutate(index);
    if (index.removed.length > REMOVED_HISTORY_CAP) index.removed = index.removed.slice(-REMOVED_HISTORY_CAP);
    const text = `${JSON.stringify(index, null, 2)}\n`;
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    if ((current === null ? null : digest(current)) !== (before === null ? null : digest(before))) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, text);
    fs.renameSync(temporary, file);
    return index;
  }
  throw new Error(`supervisor index at ${file} kept changing underneath this writer; nothing was written after ${attempts} attempts`);
}

/** Add or replace the entry for a state path; a re-dispatch of the same run gets its new instance id and a fresh slate. */
export function enrollRun(file: string, entry: { statePath: string; runInstanceId: string; recoveryOwner: RecoveryOwner; at: string }): SupervisorIndex {
  return updateIndex(file, (index) => {
    index.entries = index.entries.filter((existing) => existing.statePath !== entry.statePath);
    index.entries.push({ statePath: entry.statePath, runInstanceId: entry.runInstanceId, recoveryOwner: entry.recoveryOwner, addedAt: entry.at, missingTicks: 0, lastWake: null, lastFailure: null, lastObservation: null });
  });
}
