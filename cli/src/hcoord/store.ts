import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptyLedger, HcoordError, MAX_LEDGER_BYTES, SCHEMA, type Ledger } from "./model";

export function dataDir(home = os.homedir()): string { return path.join(home, ".hcoord"); }
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
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (parsed === null || typeof parsed !== "object" || (parsed as Ledger).schema !== SCHEMA) throw new HcoordError("version_mismatch", `unsupported ledger schema; expected ${SCHEMA}`);
  const ledger = parsed as Ledger;
  if (!Number.isSafeInteger(ledger.seq) || !Array.isArray(ledger.events) || typeof ledger.requests !== "object" || typeof ledger.participants !== "object" || typeof ledger.watches !== "object") throw new HcoordError("corrupt_ledger", "ledger structure is invalid; no data was changed");
  ledger.sasuRuns ??= {};
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
