import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** This registry discovers runs for status and retirement; it schedules nothing. */
export const INDEX_SCHEMA = "sasu.supervisor.index.v2.hide" as const;
export interface RegistrationAuthority { runInstanceId: string; recipientAuthorityKey: string }
export interface IndexEntry { statePath: string; runInstanceId: string; registrationId: string; recipientAuthorityKey: string | null; addedAt: string }
export interface SupervisorIndex { schema: typeof INDEX_SCHEMA; entries: IndexEntry[]; appliedWrites: string[] }
export const MAX_INDEX_ENTRIES = 1024;
export const MAX_INDEX_BYTES = 8 * 1024 * 1024;
export const APPLIED_WRITES_CAP = 1024;
const RETAINED_REVISIONS = 4;
const REVISION_PREFIX = ".revision-";
const READ_RETRIES = 4;
export function emptyIndex(): SupervisorIndex { return { schema: INDEX_SCHEMA, entries: [], appliedWrites: [] }; }
export function recipientAuthorityKey(identity: { runtime: string; sessionId: string; terminalId: string; paneId: string; hostScope: string }): string {
  return crypto.createHash("sha256").update([identity.runtime, identity.sessionId, identity.terminalId, identity.paneId, identity.hostScope].join("\0")).digest("hex");
}
function assertIndex(value: unknown, file: string): SupervisorIndex {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`run registry is not an object: ${file}`);
  const candidate = value as Record<string, unknown>;
  if (candidate["schema"] !== INDEX_SCHEMA) throw new Error(`unsupported run registry schema ${String(candidate["schema"] ?? "missing")} in ${file}; finish every v1 run with the previous CLI built from fbdf62913b4fbe5fde1ebce26c3e290c8eac0e92 and pass the Hide transition preflight, then the operator must move index.json and index.json.revision-* to a backup folder before the first v12 dispatch, even when the old index is empty; no automatic import or move is supported`);
  if (!Array.isArray(candidate["entries"]) || candidate["entries"].length > MAX_INDEX_ENTRIES) throw new Error(`run registry entries missing or above cap: ${file}`);
  const entries = candidate["entries"].map((entry): IndexEntry => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`invalid run registry entry: ${file}`);
    const record = entry as Record<string, unknown>;
    for (const field of ["statePath", "runInstanceId", "registrationId", "addedAt"] as const) if (typeof record[field] !== "string" || record[field] === "") throw new Error(`run registry entry has no ${field}: ${file}`);
    if (!path.isAbsolute(String(record["statePath"])) || String(record["statePath"]).length > 4096 || String(record["runInstanceId"]).length > 256 || !Number.isFinite(Date.parse(String(record["addedAt"])))) throw new Error(`invalid run registry identity: ${file}`);
    if (record["recipientAuthorityKey"] !== null && (typeof record["recipientAuthorityKey"] !== "string" || !/^[0-9a-f]{64}$/.test(record["recipientAuthorityKey"]))) throw new Error(`invalid run registry recipient: ${file}`);
    return { statePath: String(record["statePath"]), runInstanceId: String(record["runInstanceId"]), registrationId: String(record["registrationId"]), recipientAuthorityKey: record["recipientAuthorityKey"] as string | null, addedAt: String(record["addedAt"]) };
  });
  const writes = candidate["appliedWrites"];
  if (!Array.isArray(writes) || writes.length > APPLIED_WRITES_CAP || writes.some((item) => typeof item !== "string" || item === "" || item.length > 128)) throw new Error(`invalid run registry write history: ${file}`);
  return { schema: INDEX_SCHEMA, entries, appliedWrites: writes };
}
export function captureRegistrationGeneration(file: string, statePath: string): string | null {
  return readIndex(file).entries.find((entry) => entry.statePath === statePath)?.registrationId ?? null;
}
function sameRegistrationAuthority(left: RegistrationAuthority | null, right: RegistrationAuthority | null): boolean {
  return left === null || right === null ? left === right : left.runInstanceId === right.runInstanceId && left.recipientAuthorityKey === right.recipientAuthorityKey;
}
function registrationMatchesAuthority(index: SupervisorIndex, statePath: string, desired: RegistrationAuthority | null): boolean {
  const current = index.entries.find((entry) => entry.statePath === statePath);
  return desired === null ? current === undefined : current?.runInstanceId === desired.runInstanceId && current.recipientAuthorityKey === desired.recipientAuthorityKey;
}
export function forgetRegisteredRun(file: string, statePath: string, runInstanceId: string): SupervisorIndex {
  return updateIndex(file, (index) => { index.entries = index.entries.filter((entry) => entry.statePath !== statePath || entry.runInstanceId !== runInstanceId); });
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
    if (size > MAX_INDEX_BYTES) throw new Error(`run registry is ${size} bytes, above the ${MAX_INDEX_BYTES} byte cap: ${sourceFile}`);
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
  throw new Error(`run registry head kept changing while it was opened: ${file}; retry the operation`);
}

function parseSource(source: string | null, file: string): SupervisorIndex {
  if (source === null) return emptyIndex();
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch (error) { throw new Error(`malformed run registry JSON in ${file}: ${error instanceof Error ? error.message : String(error)}`); }
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
    if (index.entries.length > MAX_INDEX_ENTRIES) throw new Error(`run registry entry cap ${MAX_INDEX_ENTRIES} exceeded; nothing was written`);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const serialized = `${JSON.stringify(index, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_INDEX_BYTES) throw new Error(`run registry byte cap ${MAX_INDEX_BYTES} exceeded; nothing was written`);
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, serialized, { mode: 0o600 });
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
          throw new Error(`run registry write crossed its ${APPLIED_WRITES_CAP}-revision operation history before confirmation; refusing to replay an ambiguous successful write`);
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
  throw new Error(`run registry at ${file} kept changing underneath this writer; nothing was written after ${attempts} attempts`);
}


export function reconcileRegistrationAuthority(file: string, input: {
  statePath: string;
  readAuthority: () => RegistrationAuthority | null;
  expectedRegistrationId?: string | null;
  at: string;
  cause: string;
  afterAuthoritySnapshot?: () => void;
  attempts?: number;
}): { index: SupervisorIndex; authority: RegistrationAuthority | null } {
  let expectedRegistrationId = input.expectedRegistrationId === undefined
    ? captureRegistrationGeneration(file, input.statePath)
    : input.expectedRegistrationId;
  const attempts = input.attempts ?? 4;
  let boundaryCalled = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const before = input.readAuthority();
    if (!boundaryCalled) {
      boundaryCalled = true;
      input.afterAuthoritySnapshot?.();
    }
    const reconciled = reconcileRunRegistration(file, {
      statePath: input.statePath,
      desired: before,
      expectedRegistrationId,
      at: input.at,
      cause: input.cause,
    });
    const after = input.readAuthority();
    if (sameRegistrationAuthority(before, after) && registrationMatchesAuthority(reconciled, input.statePath, after)) {
      return { index: reconciled, authority: after };
    }
    expectedRegistrationId = captureRegistrationGeneration(file, input.statePath);
  }
  throw new Error(`supervisor registration authority kept changing for ${input.statePath}; retry against the current run`);
}


export function reconcileRunRegistration(file: string, input: {
  statePath: string;
  desired: { runInstanceId: string; recipientAuthorityKey?: string | null } | null;
  /** Registration generation observed before the caller began prerequisite writes. */
  expectedRegistrationId?: string | null;
  at: string;
  cause: string;
}): SupervisorIndex {
  const registrationId = crypto.randomUUID();
  return updateIndex(file, (index) => {
    const existing = index.entries.find((entry) => entry.statePath === input.statePath);
    const currentRegistrationId = existing?.registrationId ?? null;
    const desiredRecipientKey = input.desired?.recipientAuthorityKey ?? null;
    const wouldReplaceGeneration = input.desired === null
      || existing?.runInstanceId !== input.desired.runInstanceId
      || existing?.recipientAuthorityKey !== desiredRecipientKey;
    // A replacement dispatch persists state before enrolling. If it lands
    // while an older recovery is repairing navigation, the older intent no
    // longer owns the registration generation and must not undo the new run.
    if (wouldReplaceGeneration && input.expectedRegistrationId !== undefined && currentRegistrationId !== input.expectedRegistrationId) return;
    if (input.desired === null) {
      if (existing === undefined) return;
      index.entries = index.entries.filter((entry) => entry.statePath !== input.statePath);
      return;
    }
    if (existing?.runInstanceId === input.desired.runInstanceId
      && existing.recipientAuthorityKey === desiredRecipientKey) return;
    if (existing === undefined && index.entries.length >= MAX_INDEX_ENTRIES) {
      throw new Error(`run registry entry cap ${MAX_INDEX_ENTRIES} reached; retire or remove a watched run before reconciling recovery`);
    }
    index.entries = index.entries.filter((entry) => entry.statePath !== input.statePath);
    index.entries.push({
      statePath: input.statePath,
      runInstanceId: input.desired.runInstanceId,
      registrationId,
      recipientAuthorityKey: desiredRecipientKey,
      addedAt: input.at,
    });
  });
}

/** Register one durable run identity, without starting a scheduler or reading its state. */
export function recordRegisteredRun(file: string, entry: { statePath: string; runInstanceId: string; recipientAuthorityKey?: string | null; at: string }): SupervisorIndex {
  const registrationId = crypto.randomUUID();
  return updateIndex(file, (index) => {
    const others = index.entries.filter((item) => item.statePath !== entry.statePath);
    if (others.length >= MAX_INDEX_ENTRIES) throw new Error(`run registry entry cap ${MAX_INDEX_ENTRIES} reached`);
    index.entries = [...others, { statePath: entry.statePath, runInstanceId: entry.runInstanceId, registrationId, recipientAuthorityKey: entry.recipientAuthorityKey ?? null, addedAt: entry.at }];
  });
}
