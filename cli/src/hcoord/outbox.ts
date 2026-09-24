import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HcoordError, LETTER_SCHEMA, MAX_MESSAGE_BYTES, MAX_OUTBOX_LETTERS, REMOTE_PROTOCOL, type Letter } from "./model";
import { dataDir } from "./store";

/**
 * The per-machine outbox holds only letters an agent sent and the daemon has
 * not yet recorded. It is never a copy of the conversation: the daemon deletes
 * a letter after the ledger save that records it (PRD D-10).
 */
export function outboxDir(home = os.homedir()): string { return path.join(dataDir(home), "outbox"); }

const letterFile = /^(\d{15})-([0-9a-f-]{36})\.json$/;

export function writeLetter(operation: string, args: Record<string, unknown>, home = os.homedir()): Letter {
  const dir = outboxDir(home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dataDir(home), 0o700);
  fs.chmodSync(dir, 0o700);
  if (fs.readdirSync(dir).filter((name) => letterFile.test(name)).length >= MAX_OUTBOX_LETTERS) {
    throw new HcoordError("capacity", `outbox holds ${MAX_OUTBOX_LETTERS} uncollected letters; start the coordinator or restore its connection before sending more`);
  }
  const created = new Date();
  const letter: Letter = { schema: LETTER_SCHEMA, id: crypto.randomUUID(), operation, args, createdAt: created.toISOString(), writer: { host: os.hostname(), protocol: REMOTE_PROTOCOL } };
  const bytes = Buffer.from(`${JSON.stringify(letter)}\n`);
  if (bytes.length > MAX_MESSAGE_BYTES) throw new HcoordError("capacity", `letter exceeds ${MAX_MESSAGE_BYTES} bytes; shorten context or native arguments before retrying`);
  const name = `${String(created.getTime()).padStart(15, "0")}-${letter.id}.json`;
  const temporary = path.join(dir, `.${letter.id}.tmp`);
  const handle = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(handle, bytes); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
  try { fs.renameSync(temporary, path.join(dir, name)); }
  catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
  const directory = fs.openSync(dir, "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  return letter;
}

/** A letter as found on disk. An unreadable file keeps its ID so the refusal is recorded once. */
export type Found = { id: string; createdMs: number; letter: Letter } | { id: string; createdMs: number; letter: null; reason: string };

export function parseLetter(id: string, createdMs: number, text: string): Found {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { id, createdMs, letter: null, reason: "letter is not valid JSON" }; }
  const value = parsed as Partial<Letter> | null;
  if (value === null || typeof value !== "object" || typeof value.schema !== "string") return { id, createdMs, letter: null, reason: "letter has no schema" };
  if (value.schema !== LETTER_SCHEMA) return { id, createdMs, letter: null, reason: `letter schema ${value.schema} is unsupported; this coordinator reads ${LETTER_SCHEMA}` };
  if (value.id !== id || typeof value.operation !== "string" || value.args === null || typeof value.args !== "object" || Array.isArray(value.args) || typeof value.createdAt !== "string" || typeof value.writer?.host !== "string" || typeof value.writer?.protocol !== "number") {
    return { id, createdMs, letter: null, reason: "letter structure is invalid" };
  }
  return { id, createdMs, letter: value as Letter };
}

/** Letters in creation order, oldest first, at most `limit`. */
export function readOutbox(limit: number, home = os.homedir()): Found[] {
  const dir = outboxDir(home);
  if (!fs.existsSync(dir)) return [];
  const found: Found[] = [];
  for (const name of fs.readdirSync(dir).filter((entry) => letterFile.test(entry)).sort().slice(0, limit)) {
    const match = letterFile.exec(name)!;
    let text: string;
    try { text = fs.readFileSync(path.join(dir, name), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    found.push(parseLetter(match[2]!, Number(match[1]), text));
  }
  return found;
}

export function outboxCount(home = os.homedir()): number {
  const dir = outboxDir(home);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((entry) => letterFile.test(entry)).length : 0;
}

/** Removes recorded letters; an already missing file is the converged state. */
export function removeLetters(ids: string[], home = os.homedir()): number {
  const dir = outboxDir(home);
  if (!fs.existsSync(dir)) return 0;
  const wanted = new Set(ids);
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    const match = letterFile.exec(name);
    if (!match || !wanted.has(match[2]!)) continue;
    fs.rmSync(path.join(dir, name), { force: true });
    removed += 1;
  }
  return removed;
}
