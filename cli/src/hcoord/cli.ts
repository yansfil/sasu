#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import { HcoordError } from "./model";
import { platformSupport, startDaemon } from "./platform";
import { callDaemon, runDaemon, staleRead, type WireResult } from "./transport";
import { dataDir, legacyRetiredPath, sasuEnabledPath, stopMarkerPath } from "./store";

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
  if (topic === "agent" && action === "spawn") return { operation: "agent.spawn", data: { parent: needed(args, "parent"), machine: needed(args, "machine"), session: needed(args, "session"), name: needed(args, "name"), kind: flag(args, "kind") ?? "codex", intent: needed(args, "intent"), noWatch: args.flags.has("no-watch"), nativeArgs: args.tail } };
  if (topic === "agent" && action === "observe") return { operation: "agent.observe", data: { id: target, runtime: needed(args, "runtime"), connection: needed(args, "connection") } };
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
  if (topic === "request" && action === "ack") return { operation: "request.ack", data: { id: target, actor: needed(args, "actor") } };
  if (topic === "request" && action === "cancel") return { operation: "request.cancel", data: { id: target, actor: needed(args, "actor") } };
  if (topic === "request" && action === "escalate") return { operation: "request.escalate", data: { id: target, actor: needed(args, "actor") } };
  if (topic === "inbox") return { operation: "inbox", data: {} };
  if (topic === "graph") return { operation: "graph", data: {} };
  if (topic === "events") return { operation: "events", data: { cursor: flag(args, "cursor") ?? "0" } };
  if (topic === "sasu" && action === "register") return { operation: "sasu.register", data: { run: needed(args, "run"), project: needed(args, "project"), observerName: needed(args, "observer-name"), observerPane: needed(args, "observer-pane"), observerSession: needed(args, "observer-session"), observerInstance: needed(args, "observer-instance"), observerHostScope: flag(args, "observer-host-scope") ?? "default", implementorName: needed(args, "implementor-name"), implementorPane: needed(args, "implementor-pane"), implementorSession: needed(args, "implementor-session"), implementorInstance: needed(args, "implementor-instance"), implementorHostScope: flag(args, "implementor-host-scope") ?? "default" } };
  throw new HcoordError("invalid_argument", "usage: hcoord status | agent register/list/show | watch start/check/assign/stop/list | request send/show/reply/relay/ack/cancel/escalate | inbox | graph | events | daemon start/stop/status");
}

function print(result: WireResult, json: boolean): void {
  if (json) { process.stdout.write(`${JSON.stringify(result)}\n`); return; }
  if (!result.ok) { process.stderr.write(`hcoord: ${result.error?.code}: ${result.error?.message}\n`); return; }
  const data = result.value;
  if (Array.isArray(data)) {
    if (data.length === 0) process.stdout.write("No items.\n");
    else for (const item of data) process.stdout.write(`${JSON.stringify(item)}\n`);
  } else process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

export async function main(argv: string[]): Promise<number> {
  const args = parse(argv), json = args.flags.has("json");
  try {
    if (args.words[0] === "sasu" && args.words[1] === "enable") {
      const status = await callDaemon("status");
      if (!status.ok) { print(status, json); return 1; }
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
      if (action === "run") { await runDaemon(); return 0; }
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
    let result: WireResult;
    try { result = await callDaemon(operation, data); }
    catch (error) { if (!(error instanceof HcoordError) || error.code !== "daemon_down") throw error; result = staleRead(operation, data); }
    print(result, json);
    return result.ok ? 0 : 1;
  } catch (error) {
    const reason = error instanceof HcoordError ? error : new HcoordError("internal", "command failed; inspect stderr");
    if (!(error instanceof HcoordError)) process.stderr.write(`${String(error)}\n`);
    print({ ok: false, error: { code: reason.code, message: reason.message, ...(reason.detail ? { detail: reason.detail } : {}) }, observedAt: new Date().toISOString() }, json);
    return reason.code === "invalid_argument" ? 2 : 1;
  }
}

if (require.main === module) void main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
