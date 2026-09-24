import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptyLedger, HcoordError, MAX_LEDGER_BYTES, SCHEMA, type Ledger } from "./model";

/** HCOORD_HOME relocates every hcoord file, so an isolated install never touches ~/.hcoord. */
export function dataDir(home = os.homedir()): string {
  const override = process.env["HCOORD_HOME"];
  return override !== undefined && override !== "" ? path.resolve(override) : path.join(home, ".hcoord");
}
export function ledgerPath(home = os.homedir()): string { return path.join(dataDir(home), "ledger.json"); }
export function socketPath(home = os.homedir()): string {
  if (process.platform === "win32") return `\\\\.\\pipe\\hcoord-${os.userInfo().username}`;
  return path.join(dataDir(home), "api.sock");
}
export function stopMarkerPath(home = os.homedir()): string { return path.join(dataDir(home), "manual-stop"); }
export function sasuEnabledPath(home = os.homedir()): string { return path.join(dataDir(home), "sasu-enabled"); }
export function legacyRetiredPath(home = os.homedir()): string { return path.join(dataDir(home), "legacy-supervisor-retired"); }

export function loadLedger(home = os.homedir()): Ledger {
  const file = ledgerPath(home);
  if (!fs.existsSync(file)) return emptyLedger(new Date().toISOString());
  const stat = fs.statSync(file);
  if (stat.size > MAX_LEDGER_BYTES) throw new HcoordError("capacity", `ledger exceeds ${MAX_LEDGER_BYTES} bytes; existing requests remain intact`);
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    if (error instanceof SyntaxError) throw new HcoordError("corrupt_ledger", "ledger JSON is invalid; no data was changed");
    throw error;
  }
  if (parsed === null || typeof parsed !== "object" || (parsed as Ledger).schema !== SCHEMA) throw new HcoordError("version_mismatch", `unsupported ledger schema; expected ${SCHEMA}`);
  const ledger = parsed as Ledger;
  const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!Number.isSafeInteger(ledger.seq) || !Array.isArray(ledger.events) || !record(ledger.config) ||
      !record(ledger.requests) || !record(ledger.participants) || !record(ledger.watches) ||
      !record(ledger.spawnIntents) || (ledger.letters !== undefined && !record(ledger.letters)) || (ledger.sasuRuns !== undefined && !record(ledger.sasuRuns)) ||
      (ledger.watchHistory !== undefined && !Array.isArray(ledger.watchHistory)) ||
      Object.values(ledger.requests).some((request) => !record(request) || !Array.isArray(request.deliveries) || !Array.isArray(request.lateAnswers)) ||
      Object.values(ledger.watches).some((watch) => !record(watch) || typeof watch.target !== "string" || typeof watch.generation !== "number")) {
    throw new HcoordError("corrupt_ledger", "ledger structure is invalid; no data was changed");
  }
  ledger.watchHistory ??= [];
  ledger.sasuRuns ??= {};
  ledger.letters ??= {};
  return ledger;
}

export function saveLedger(state: Ledger, home = os.homedir()): void {
  const dir = dataDir(home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const bytes = Buffer.from(`${JSON.stringify(state)}\n`);
  if (bytes.length > MAX_LEDGER_BYTES) throw new HcoordError("capacity", `ledger would exceed ${MAX_LEDGER_BYTES} bytes; existing requests remain intact`);
  const temporary = path.join(dir, `.ledger-${process.pid}-${require("node:crypto").randomUUID()}.tmp`);
  const handle = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(handle, bytes);
    fs.fsyncSync(handle);
  } finally { fs.closeSync(handle); }
  try {
    fs.renameSync(temporary, ledgerPath(home));
    const directory = fs.openSync(dir, "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } catch (error) { try { fs.unlinkSync(temporary); } catch { /* rename may have completed */ } throw error; }
}
