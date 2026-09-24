#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import { officialPromptSupport } from "./herdr";
import { HcoordError, LETTER_OPERATIONS, LETTER_SCHEMA, MAX_OUTBOX_LETTERS, REMOTE_PROTOCOL } from "./model";
import { outboxCount, readOutboxRaw, removeLetters, writeLetter } from "./outbox";
import { readHq, writeHq } from "./remote";
import { openWork } from "./service";
import { platformSupport, startDaemon } from "./platform";
import { callDaemon, lastDaemonContact, runDaemon, staleRead, type WireResult } from "./transport";
import { readAlert, reconcileAlert, warningLine } from "./health";
import { notifyText } from "./platform";
import { dataDir, legacyRetiredPath, loadLedger, sasuEnabledPath, stopMarkerPath } from "./store";

interface Parsed { words: string[]; flags: Map<string, string | true>; tail: string[] }
function parse(argv: string[]): Parsed {
  const divider = argv.indexOf("--");
  const before = divider < 0 ? argv : argv.slice(0, divider);
  const tail = divider < 0 ? [] : argv.slice(divider + 1);
  const words: string[] = [], flags = new Map<string, string | true>();
  for (let index = 0; index < before.length; index += 1) {
    const token = before[index]!;
    if (!token.startsWith("--")) { words.push(token); continue; }
    const key = token.slice(2), following = before[index + 1];
    if (following === undefined || following.startsWith("--")) flags.set(key, true);
    else { flags.set(key, following); index += 1; }
  }
  return { words, flags, tail };
}
const flag = (args: Parsed, name: string): string | undefined => { const value = args.flags.get(name); return typeof value === "string" ? value : undefined; };
const needed = (args: Parsed, name: string): string => { const value = flag(args, name); if (value === undefined || value.trim() === "") throw new HcoordError("invalid_argument", `--${name} is required`); return value; };
const duration = (value: string): number => {
  const match = /^(\d+)(s|m|h|d)$/.exec(value);
  if (!match) throw new HcoordError("invalid_argument", "duration must use s, m, h, or d, for example 5m");
  return Number(match[1]) * ({ s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as Record<string, number>)[match[2]!]!;
};
function route(args: Parsed): { operation: string; data: Record<string, unknown> } {
  const [topic, action, target] = args.words;
  if (topic === "status") return { operation: "status", data: {} };
  if (topic === "config" && action === "show") return { operation: "status", data: {} };
  if (topic === "config" && action === "set") return { operation: "config.set", data: { key: needed(args, "key"), value: duration(needed(args, "value")) } };
  if (topic === "agent" && action === "register") return { operation: "agent.register", data: { machine: needed(args, "machine"), hostScope: flag(args, "host-scope") ?? process.env["HERDR_SOCKET_PATH"] ?? "default", session: needed(args, "session"), instance: needed(args, "instance"), name: needed(args, "name"), project: flag(args, "project"), parent: flag(args, "parent"), pane: flag(args, "pane") } };
  if (topic === "agent" && action === "spawn") return { operation: "agent.spawn", data: { parent: needed(args, "parent"), machine: needed(args, "machine"), session: needed(args, "session"), name: needed(args, "name"), kind: flag(args, "kind") ?? "codex", intent: needed(args, "intent"), noWatch: args.flags.has("no-watch"), reconcilePane: flag(args, "reconcile-pane"), resumeStart: args.flags.has("resume-start"), nativeArgs: args.tail } };
  if (topic === "agent" && action === "list") return { operation: "agent.list", data: { project: flag(args, "project") } };
  if (topic === "agent" && action === "show") return { operation: "agent.show", data: { id: target } };
  if (topic === "watch" && action === "start") return { operation: "watch.start", data: { target, observer: needed(args, "observer"), actor: flag(args, "actor") ?? needed(args, "observer"), intervalMs: flag(args, "interval") ? duration(needed(args, "interval")) : undefined } };
  if (topic === "watch" && action === "assign") return { operation: "watch.assign", data: { target, observer: needed(args, "observer"), actor: needed(args, "actor"), expectedGeneration: flag(args, "expected-generation") } };
  if (topic === "watch" && action === "stop") return { operation: "watch.stop", data: { target, actor: needed(args, "actor") } };
  if (topic === "watch" && action === "check") return { operation: "watch.check", data: { target, cycle: needed(args, "cycle"), actor: needed(args, "actor") } };
  if (topic === "watch" && action === "list") return { operation: "watch.list", data: {} };
  if (topic === "request" && action === "send") return { operation: "request.send", data: { from: needed(args, "from"), to: needed(args, "to"), body: needed(args, "body"), intent: needed(args, "intent"), intermediary: flag(args, "intermediary"), context: flag(args, "context"), waiting: args.flags.has("waiting"), notifyOnly: args.flags.has("notify-only") } };
  if (topic === "request" && action === "show") return { operation: "request.show", data: { id: target } };
  if (topic === "request" && action === "reply") return { operation: "request.reply", data: { id: target, body: needed(args, "body"), respondent: needed(args, "as"), recordedBy: flag(args, "recorded-by") ?? needed(args, "as") } };
  if (topic === "request" && action === "relay") return { operation: "request.relay", data: { id: target, body: needed(args, "body"), actor: needed(args, "actor") } };
  if (topic === "request" && action === "ack") return { operation: "request.ack", data: { id: target, actor: needed(args, "actor"), delivery: flag(args, "delivery") } };
  if (topic === "request" && action === "cancel") return { operation: "request.cancel", data: { id: target, actor: needed(args, "actor") } };
  if (topic === "request" && action === "escalate") return { operation: "request.escalate", data: { id: target, actor: needed(args, "actor") } };
  if (topic === "inbox") return { operation: "inbox", data: {} };
  if (topic === "graph") return { operation: "graph", data: {} };
  if (topic === "events") return { operation: "events", data: { cursor: flag(args, "cursor") ?? "0" } };
  if (topic === "sasu" && action === "register") return { operation: "sasu.register", data: { run: needed(args, "run"), project: needed(args, "project"), observerName: needed(args, "observer-name"), observerPane: needed(args, "observer-pane"), observerSession: needed(args, "observer-session"), observerInstance: needed(args, "observer-instance"), observerHostScope: flag(args, "observer-host-scope") ?? "default", implementorName: needed(args, "implementor-name"), implementorPane: needed(args, "implementor-pane"), implementorSession: needed(args, "implementor-session"), implementorInstance: needed(args, "implementor-instance"), implementorHostScope: flag(args, "implementor-host-scope") ?? "default" } };
  throw new HcoordError("invalid_argument", "usage: hcoord status | agent register/list/show | watch start/check/assign/stop/list | request send/show/reply/relay/ack/cancel/escalate | inbox | graph | events | daemon start/stop/status");
}

/**
 * An unstable daemon is reported above every command's output, on stderr so
 * JSON stdout stays parseable (PRD B14). A command that reached or failed to
 * reach the daemon re-evaluates the alert; any other command shows the
 * current one.
 */
let warned = false;
function warnIfUnstable(): void {
  if (warned) return;
  warned = true;
  try {
    const home = os.homedir();
    const alert = lastDaemonContact === null ? readAlert(home) : reconcileAlert(home, Date.now(), lastDaemonContact === "answered", notifyText);
    if (alert) process.stderr.write(`${warningLine(alert, home)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ event: "hcoord.health_unreadable", at: new Date().toISOString(), code: (error as NodeJS.ErrnoException).code ?? "internal" })}\n`);
  }
}

function print(result: WireResult, json: boolean): void {
  warnIfUnstable();
  if (json) { process.stdout.write(`${JSON.stringify(result)}\n`); return; }
  if (!result.ok) { process.stderr.write(`hcoord: ${result.error?.code}: ${result.error?.message}\n`); return; }
  if (result.delivery === "pending") { const value = result.value as { letter: string; reason: string }; process.stdout.write(`pending: letter ${value.letter} waits for the coordinator; ${value.reason}\n`); return; }
  const data = result.value;
  if (Array.isArray(data)) {
    if (data.length === 0) process.stdout.write("No items.\n");
    else for (const item of data) process.stdout.write(`${JSON.stringify(item)}\n`);
  } else process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Every write is saved in this machine's outbox before anything else, so a
 * stopped or busy coordinator delays it instead of losing it (PRD B6, B12).
 * A running local coordinator applies it at once and returns the same result
 * a direct call returned before letters existed (PRD B1).
 */
async function sendLetter(operation: string, data: Record<string, unknown>): Promise<WireResult> {
  const letter = writeLetter(operation, data);
  const pending = (reason: string): WireResult => ({ ok: true, delivery: "pending", value: { letter: letter.id, operation, reason }, observedAt: new Date().toISOString() });
  try {
    return await callDaemon("outbox.collect", { letter: letter.id }, undefined, operation === "agent.spawn" ? 240_000 : 30_000);
  } catch (error) {
    if (!(error instanceof HcoordError)) throw error;
    if (error.code === "daemon_down") return pending("the coordinator daemon is not running; it applies this letter after hcoord daemon start");
    if (error.code === "timeout") return pending("the coordinator did not answer in time; it applies this letter in order, so do not resend it");
    if (error.code === "permission_denied" || error.code === "transport") return pending(`${error.message}; the running coordinator still collects this letter from the outbox`);
    throw error;
  }
}

const ok = (value: unknown): WireResult => ({ ok: true, value, observedAt: new Date().toISOString() });

/** This machine still coordinates work, so it cannot become another HQ's remote (PRD D-15). */
async function refuseWhileCoordinating(action: string): Promise<void> {
  const work = openWork(loadLedger());
  if (work.requests.length || work.watches.length) {
    throw new HcoordError("hq_busy", `${action} is refused while this HQ has ${work.requests.length} unresolved request(s) and ${work.watches.length} active watch(es); finish, cancel, or stop them first`, work);
  }
}

/**
 * The HQ reaches a remote only through these subcommands over the saved
 * machine's SSH target. They touch only the outbox and the HQ marker; the
 * remote keeps no conversation record (PRD D-10).
 */
async function remoteSide(args: Parsed): Promise<WireResult> {
  const action = args.words[1];
  const base = { protocol: REMOTE_PROTOCOL, letterSchema: LETTER_SCHEMA, host: os.hostname() };
  if (action === "hello") {
    const hq = needed(args, "hq"), current = readHq();
    if (current !== "local" && current !== hq) throw new HcoordError("hq_conflict", `this machine reports to HQ ${current}; run hcoord config set hq local here before ${hq} can use it`);
    if (current === "local") {
      let running = false;
      try { running = (await callDaemon("status")).ok; } catch (error) { if (!(error instanceof HcoordError) || error.code !== "daemon_down") throw error; }
      if (running) throw new HcoordError("hq_conflict", `this machine runs its own coordinator daemon; stop it or move its HQ before ${hq} can use it`);
      await refuseWhileCoordinating(`joining HQ ${hq}`);
      writeHq(hq);
    }
    return ok({ ...base, hq, outbox: outboxCount() });
  }
  if (action === "take") {
    const limit = Math.min(Number(flag(args, "limit") ?? "64"), MAX_OUTBOX_LETTERS);
    return ok({ ...base, letters: readOutboxRaw(Number.isSafeInteger(limit) && limit > 0 ? limit : 64, undefined, 4 * 1024 * 1024) });
  }
  if (action === "drop") return ok({ ...base, removed: removeLetters(args.words.slice(2)) });
  throw new HcoordError("invalid_argument", "remote subcommands are hello, take, and drop");
}

/** `hcoord config set hq <local|machine>` (PRD B17). */
async function setHq(value: string | undefined): Promise<WireResult> {
  if (value === undefined || value.trim() === "") throw new HcoordError("invalid_argument", "usage: hcoord config set hq <local|machine name>");
  const current = readHq();
  if (value === current) return ok({ hq: current, changed: false });
  const waiting = outboxCount();
  if (current !== "local" && waiting > 0) throw new HcoordError("hq_busy", `${waiting} letter(s) still wait for HQ ${current}; let it collect them before moving`, { letters: waiting });
  if (current === "local") {
    await refuseWhileCoordinating(`moving the HQ to ${value}`);
    try {
      const stopped = await callDaemon("daemon.stop");
      if (stopped.ok) fs.writeFileSync(stopMarkerPath(), `${new Date().toISOString()}\n`, { mode: 0o600 });
    } catch (error) { if (!(error instanceof HcoordError) || error.code !== "daemon_down") throw error; }
  }
  writeHq(value);
  return ok({ hq: value, changed: true, previous: current });
}

export async function main(argv: string[]): Promise<number> {
  const args = parse(argv), json = args.flags.has("json");
  try {
    if (args.words[0] === "remote") { const result = await remoteSide(args); process.stdout.write(`${JSON.stringify(result)}\n`); return 0; }
    if (args.words[0] === "config" && args.words[1] === "set" && args.words[2] === "hq") { const result = await setHq(args.words[3]); print(result, json); return 0; }
    const hq = readHq();
    if (hq !== "local") {
      const { operation, data } = args.words[0] === "daemon" || args.words[0] === "sasu" ? { operation: `${args.words[0]}.${args.words[1]}`, data: {} } : route(args);
      if (!LETTER_OPERATIONS.has(operation)) throw new HcoordError("hq_only", `${operation} runs only at the coordinator HQ (${hq}); this machine keeps no conversation record`, { hq });
      const letter = writeLetter(operation, data);
      print({ ok: true, delivery: "pending", value: { letter: letter.id, operation, reason: `HQ ${hq} collects it over its saved SSH machine`, hq }, observedAt: new Date().toISOString() }, json);
      return 0;
    }
    if (args.words[0] === "sasu" && args.words[1] === "enable") {
      const status = await callDaemon("status");
      if (!status.ok) { print(status, json); return 1; }
      const capability = officialPromptSupport();
      if (!capability.ready) throw new HcoordError("unsupported_runtime", `Herdr agent delivery is unsupported or unconfirmed: ${capability.reason}; Sasu transition remains disabled`);
      fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
      fs.writeFileSync(sasuEnabledPath(), `${new Date().toISOString()}\n`, { mode: 0o600 });
      print({ ok: true, value: { enabled: true, newRunsOnly: true, existingRuns: "legacy supervisor retains ownership" }, observedAt: new Date().toISOString() }, json);
      return 0;
    }
    if (args.words[0] === "sasu" && args.words[1] === "status") {
      const enabled = fs.existsSync(sasuEnabledPath());
      print({ ok: true, value: { enabled, transition: "new runs only", legacySupervisorRetired: fs.existsSync(legacyRetiredPath()), existingRuns: "legacy supervisor until explicitly retired after its final run" }, observedAt: new Date().toISOString() }, json);
      return 0;
    }
    if (args.words[0] === "daemon") {
      const action = args.words[1];
      if (action === "run") {
        if (await runDaemon() === "manual_stop") print({ ok: true, value: { running: false, manualStop: true, next: "hcoord daemon start clears the manual stop" }, observedAt: new Date().toISOString() }, json);
        return 0;
      }
      if (action === "start") { const value = startDaemon(); print({ ok: true, value, observedAt: new Date().toISOString() }, json); return 0; }
      if (action === "stop") {
        const result = await callDaemon("daemon.stop");
        print(result, json);
        if (result.ok) {
          fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
          fs.writeFileSync(stopMarkerPath(), `${new Date().toISOString()}\n`, { mode: 0o600 });
        }
        return result.ok ? 0 : 1;
      }
      if (action === "status") {
        let result: WireResult;
        try { result = await callDaemon("status"); }
        catch (error) { if (!(error instanceof HcoordError) || error.code !== "daemon_down") throw error; result = staleRead("status"); }
        result.value = { ...(result.value as object), platform: platformSupport() };
        print(result, json);
        return 0;
      }
      throw new HcoordError("invalid_argument", "use daemon run, start, stop, or status");
    }
    const { operation, data } = route(args);
    if (args.words[0] === "events" && args.flags.has("follow")) {
      let cursor = Number(data["cursor"]);
      while (true) {
        const result = await callDaemon("events", { cursor });
        if (!result.ok) { print(result, json); return 1; }
        const stream = result.value as { events: unknown[]; cursor: number; hasMore: boolean };
        for (const entry of stream.events) process.stdout.write(`${JSON.stringify(entry)}\n`);
        cursor = stream.cursor;
        if (!stream.hasMore) await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    if (LETTER_OPERATIONS.has(operation)) {
      const result = await sendLetter(operation, data);
      print(result, json);
      return result.ok ? 0 : 1;
    }
    let result: WireResult;
    try { result = await callDaemon(operation, data); }
    catch (error) { if (!(error instanceof HcoordError) || error.code !== "daemon_down") throw error; result = staleRead(operation, data); }
    print(result, json);
    return result.ok ? 0 : 1;
  } catch (error) {
    const reason = error instanceof HcoordError ? error : new HcoordError("internal", "command failed; inspect stderr");
    if (!(error instanceof HcoordError)) process.stderr.write(`${JSON.stringify({ event: "hcoord.command_failed", at: new Date().toISOString(), code: "internal" })}\n`);
    print({ ok: false, error: { code: reason.code, message: reason.message, ...(reason.detail ? { detail: reason.detail } : {}) }, observedAt: new Date().toISOString() }, json);
    return reason.code === "invalid_argument" ? 2 : 1;
  }
}

if (require.main === module) void main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
