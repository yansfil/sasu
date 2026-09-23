import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import { API_VERSION, HcoordError, MAX_CONNECTIONS, type Ledger } from "./model";
import { event } from "./model";
import { execute } from "./service";
import { createSpawnPane, discoverLocalAgents, inspectDelivery, inspectSpawnedAgent, parentPlacement, startSpawnedAgent, submitGuarded, validateLocalBinding } from "./herdr";
import type { SpawnIntent } from "./model";
import { dataDir, ledgerPath, loadLedger, saveLedger, socketPath, stopMarkerPath } from "./store";
import { notifyHuman } from "./platform";

export interface WireRequest { version: number; operation: string; args: Record<string, unknown> }
export interface WireResult { ok: boolean; value?: unknown; error?: { code: string; message: string; detail?: Record<string, unknown> }; observedAt: string }
const MAX_MESSAGE_BYTES = 1024 * 1024;
const mutation = (operation: string): boolean => !["status", "agent.list", "agent.show", "watch.list", "request.show", "inbox", "graph", "events"].includes(operation);

export async function callDaemon(operation: string, args: Record<string, unknown> = {}, home = os.homedir()): Promise<WireResult> {
  if (process.platform === "win32") throw new HcoordError("unsupported_platform", "Windows named-pipe ACL support is unverified; no local daemon connection was attempted");
  return await new Promise<WireResult>((resolve, reject) => {
    const socket = net.createConnection(socketPath(home));
    let text = "";
    const timeoutMs = operation === "agent.spawn" ? 30_000 : 10_000;
    const timer = setTimeout(() => { socket.destroy(); reject(new HcoordError("timeout", `coordinator did not answer within ${timeoutMs / 1000} seconds`)); }, timeoutMs);
    const finish = (error?: Error, value?: WireResult): void => { clearTimeout(timer); socket.destroy(); if (error) reject(error); else resolve(value!); };
    socket.on("connect", () => socket.write(`${JSON.stringify({ version: API_VERSION, operation, args })}\n`));
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES) return finish(new HcoordError("capacity", "coordinator response exceeded message limit"));
      const newline = text.indexOf("\n");
      if (newline === -1) return;
      try { finish(undefined, JSON.parse(text.slice(0, newline)) as WireResult); }
      catch { finish(new HcoordError("protocol", "coordinator returned invalid JSON")); }
    });
    socket.on("error", (error: NodeJS.ErrnoException) => { clearTimeout(timer); reject(new HcoordError(error.code === "ENOENT" || error.code === "ECONNREFUSED" ? "daemon_down" : "transport", error.code === "ENOENT" || error.code === "ECONNREFUSED" ? "coordinator daemon is not running; start it with hcoord daemon start" : "coordinator transport failed")); });
  });
}

export function staleRead(operation: string, args: Record<string, unknown> = {}, home = os.homedir()): WireResult {
  if (mutation(operation)) throw new HcoordError("daemon_down", "coordinator daemon is not running; start it with hcoord daemon start");
  const saved = fs.existsSync(ledgerPath(home));
  const state = loadLedger(home);
  const observedAt = new Date().toISOString();
  const outcome = execute(state, operation, args, observedAt);
  const data = operation === "agent.list" ? { items: (outcome.value as Array<Record<string, unknown>>).map((item) => ({ registered: true, ...item })), partialFailures: ["daemon stopped; Herdr discovery unavailable"], observedAt: state.updatedAt } : outcome.value;
  return { ok: true, value: { data, stale: true, lastObservedAt: saved ? state.updatedAt : null, warning: saved ? "daemon stopped: automatic watch, reminders, and delivery are inactive" : "daemon stopped and no saved observation exists" }, observedAt };
}

export async function runDaemon(home = os.homedir()): Promise<void> {
  if (process.platform === "win32") throw new HcoordError("unsupported_platform", "Windows local IPC needs a verified user-restricted named pipe adapter");
  if (fs.existsSync(stopMarkerPath(home))) throw new HcoordError("manual_stop", "daemon was manually stopped; use hcoord daemon start to resume");
  fs.mkdirSync(dataDir(home), { recursive: true, mode: 0o700 });
  fs.chmodSync(dataDir(home), 0o700);
  let ledger = loadLedger(home);
  const socketFile = socketPath(home);
  if (fs.existsSync(socketFile)) {
    try { await callDaemon("status", {}, home); throw new HcoordError("already_running", "coordinator daemon is already running"); }
    catch (error) { if (!(error instanceof HcoordError) || error.code !== "daemon_down") throw error; }
    fs.unlinkSync(socketFile);
  }
  let connections = 0;
  let processing = Promise.resolve();
  let tickPending = false;
  let closing = false;
  const commit = (operation: string, args: Record<string, unknown>, at: string): unknown => {
    const next = structuredClone(ledger);
    const outcome = execute(next, operation, args, at);
    if (outcome.changed) { saveLedger(next, home); ledger = next; }
    return outcome.value;
  };
  const spawnAgent = (args: Record<string, unknown>, at: string): unknown => {
    let intent = commit("agent.spawn.reserve", args, at) as SpawnIntent;
    if (intent.status === "complete") return { intent, participant: ledger.participants[intent.participant!], watch: ledger.watches[intent.participant!] ?? null };
    let createdNow = false;
    if (intent.pane === null) {
      if (intent.status !== "reserved") throw new HcoordError("spawn_uncertain", "tab creation outcome is unknown; no duplicate tab was created", { intent: intent.key, pane: null });
      const parent = ledger.participants[intent.parent]!;
      const placement = parentPlacement(parent);
      intent = commit("agent.spawn.unknown", { intent: intent.key, reason: "tab creation reserved; outcome pending" }, at) as SpawnIntent;
      const pane = createSpawnPane(intent, placement);
      intent = commit("agent.spawn.pane", { intent: intent.key, pane }, new Date().toISOString()) as SpawnIntent;
      createdNow = true;
    }
    let identity = inspectSpawnedAgent(intent);
    if (identity === null) {
      if (!createdNow) throw new HcoordError("spawn_uncertain", "saved pane has no confirmed agent; inspect it before resuming agent start", { intent: intent.key, pane: intent.pane });
      startSpawnedAgent(intent);
      identity = inspectSpawnedAgent(intent);
      if (identity === null) throw new HcoordError("spawn_uncertain", "agent start returned but execution identity is unavailable", { intent: intent.key, pane: intent.pane });
    }
    return commit("agent.spawn.complete", { intent: intent.key, runtimeSession: identity.session, instance: identity.instance, runtime: identity.runtime, project: ledger.participants[intent.parent]?.project }, new Date().toISOString());
  };
  const registerSasuRun = (args: Record<string, unknown>, at: string): unknown => {
    const run = String(args["run"] ?? ""), project = String(args["project"] ?? "");
    if (run === "" || project === "") throw new HcoordError("invalid_argument", "run and project are required");
    const observerBinding = validateLocalBinding("local", String(args["observerSession"] ?? ""), String(args["observerInstance"] ?? ""), String(args["observerPane"] ?? ""), String(args["observerHostScope"] ?? "default"));
    const implementorBinding = validateLocalBinding("local", String(args["implementorSession"] ?? ""), String(args["implementorInstance"] ?? ""), String(args["implementorPane"] ?? ""), String(args["implementorHostScope"] ?? "default"));
    const next = structuredClone(ledger);
    const observer = execute(next, "agent.register", { machine: "local", hostScope: args["observerHostScope"], session: args["observerSession"], instance: args["observerInstance"], name: args["observerName"], pane: args["observerPane"], project, runtime: observerBinding.runtime }, at).value as { id: string };
    const implementor = execute(next, "agent.register", { machine: "local", hostScope: args["implementorHostScope"], session: args["implementorSession"], instance: args["implementorInstance"], name: args["implementorName"], pane: args["implementorPane"], project, parent: observer.id, runtime: implementorBinding.runtime }, at).value as { id: string };
    const prior = next.sasuRuns[run];
    if (prior && (prior.observer !== observer.id || prior.implementor !== implementor.id || prior.project !== project)) throw new HcoordError("intent_conflict", "Sasu run is already bound to another execution", { run });
    const current = next.watches[implementor.id];
    if (current?.status === "active" && current.observer !== observer.id) throw new HcoordError("conflict", "Sasu implementor has another active observer");
    const watch = current?.status === "active" ? current : execute(next, "watch.start", { target: implementor.id, observer: observer.id, actor: "human" }, at).value;
    if (!prior) next.sasuRuns[run] = { observer: observer.id, implementor: implementor.id, project, registeredAt: at };
    saveLedger(next, home); ledger = next;
    return { run, observer, implementor, watch, owner: "hcoord" };
  };
  const processOutbox = (): void => {
    let examined = 0;
    for (const item of Object.values(ledger.requests)) {
      if (item.status === "canceled") continue;
      for (const delivery of item.deliveries) {
        if (examined >= 1) return;
        if (delivery.status !== "pending" && delivery.status !== "deferred") continue;
        if (delivery.attemptedAt !== null && Date.now() - Date.parse(delivery.attemptedAt) < 5000) continue;
        examined += 1;
        if (delivery.recipient === "human") {
          const next = structuredClone(ledger);
          const current = next.requests[item.id]!.deliveries.find((entry) => entry.id === delivery.id)!;
          current.attemptedAt = new Date().toISOString();
          current.status = "unknown";
          current.reason = "notification reserved; result not confirmed";
          saveLedger(next, home); ledger = next;
          const result = notifyHuman(item.id);
          const finished = structuredClone(ledger);
          const recorded = finished.requests[item.id]!.deliveries.find((entry) => entry.id === delivery.id)!;
          recorded.status = result.ok ? "accepted" : "failed";
          recorded.runtimeCode = result.code;
          recorded.reason = result.ok ? "Herdr notification accepted; human reading is unconfirmed" : "notification failed; open hcoord inbox to act";
          if (result.ok) recorded.acceptedAt = new Date().toISOString();
          event(finished, new Date().toISOString(), result.ok ? "notification.accepted" : "notification.failed", item.id, item.intent, { deliveryId: delivery.id, code: result.code });
          saveLedger(finished, home); ledger = finished;
          continue;
        }
        const recipient = ledger.participants[delivery.recipient];
        if (!recipient) {
          const next = structuredClone(ledger);
          const current = next.requests[item.id]!.deliveries.find((entry) => entry.id === delivery.id)!;
          current.status = "failed"; current.reason = "recipient is no longer registered; inspect the request in the CLI inbox"; current.attemptedAt = new Date().toISOString();
          event(next, current.attemptedAt, "delivery.failed", item.id, item.intent, { deliveryId: delivery.id, code: "recipient_missing" });
          saveLedger(next, home); ledger = next;
          continue;
        }
        const at = new Date().toISOString();
        const next = structuredClone(ledger);
        const current = next.requests[item.id]!.deliveries.find((entry) => entry.id === delivery.id)!;
        const target = next.participants[delivery.recipient]!;
        const inspection = inspectDelivery(recipient);
        current.attemptedAt = at;
        target.runtime = inspection.runtime;
        target.connection = inspection.connection;
        target.observedAt = at;
        if (!inspection.ready || inspection.guard === null) {
          current.status = "deferred";
          current.reason = inspection.reason;
          saveLedger(next, home); ledger = next;
          continue;
        }
        // Persist uncertainty before the external effect. A crash or timeout never causes a blind resend.
        current.status = "unknown";
        current.reason = "guarded submission reserved; outcome not yet confirmed";
        saveLedger(next, home); ledger = next;
        const outcome = submitGuarded(item, delivery, recipient, inspection.guard);
        const finished = structuredClone(ledger);
        const recorded = finished.requests[item.id]!.deliveries.find((entry) => entry.id === delivery.id)!;
        recorded.status = outcome.status;
        recorded.reason = outcome.reason;
        recorded.runtimeCode = outcome.code;
        if (outcome.status === "accepted") recorded.acceptedAt = new Date().toISOString();
        event(finished, new Date().toISOString(), `delivery.${outcome.status}`, item.id, item.intent, { deliveryId: delivery.id, code: outcome.code });
        saveLedger(finished, home); ledger = finished;
      }
    }
  };
  const server = net.createServer((socket) => {
    connections += 1;
    if (connections > MAX_CONNECTIONS) { socket.end(`${JSON.stringify({ ok: false, error: { code: "capacity", message: `connection limit ${MAX_CONNECTIONS} reached` }, observedAt: new Date().toISOString() })}\n`); connections -= 1; return; }
    socket.setTimeout(35_000, () => socket.destroy());
    let input = "";
    socket.on("close", () => { connections -= 1; });
    socket.on("data", (chunk: Buffer) => {
      input += chunk.toString("utf8");
      if (Buffer.byteLength(input) > MAX_MESSAGE_BYTES) { socket.destroy(); return; }
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const line = input.slice(0, newline);
      input = "";
      processing = processing.then(async () => {
        const at = new Date().toISOString();
        let result: WireResult;
        try {
          const decoded = JSON.parse(line) as WireRequest;
          if (decoded.version !== API_VERSION) throw new HcoordError("version_mismatch", `API version ${decoded.version} is unsupported; expected ${API_VERSION}`);
          if (typeof decoded.operation !== "string" || !decoded.args || typeof decoded.args !== "object" || Array.isArray(decoded.args)) throw new HcoordError("protocol", "operation and object args are required");
          if (decoded.operation === "daemon.stop") {
            fs.writeFileSync(stopMarkerPath(home), `${at}\n`, { mode: 0o600 });
            result = { ok: true, value: { stopped: true }, observedAt: at };
            closing = true;
          } else {
            if (decoded.operation.startsWith("agent.spawn.") || decoded.operation === "tick") throw new HcoordError("forbidden", "operation is daemon-internal");
            if (decoded.operation === "agent.register") {
              const binding = validateLocalBinding(String(decoded.args["machine"] ?? ""), String(decoded.args["session"] ?? ""), String(decoded.args["instance"] ?? ""), typeof decoded.args["pane"] === "string" ? decoded.args["pane"] : null, String(decoded.args["hostScope"] ?? "default"));
              decoded.args["runtime"] = binding.runtime;
            }
            let value = decoded.operation === "agent.spawn" ? spawnAgent(decoded.args, at) : decoded.operation === "sasu.register" ? registerSasuRun(decoded.args, at) : commit(decoded.operation, decoded.args, at);
            if (decoded.operation === "status") {
              value = { ...(value as object), usage: { ledgerBytes: fs.existsSync(ledgerPath(home)) ? fs.statSync(ledgerPath(home)).size : 0,
                connections, queuedDeliveries: Object.values(ledger.requests).reduce((sum, item) => sum + item.deliveries.filter((delivery) => delivery.status === "pending" || delivery.status === "deferred").length, 0),
                uncertainSpawns: Object.values(ledger.spawnIntents).filter((intent) => intent.status === "unknown").length } };
            }
            if (decoded.operation === "agent.list") {
              const registered = value as Array<Record<string, unknown>>;
              const scopes = [...new Set(["default", ...Object.values(ledger.participants).map((entry) => entry.hostScope)])];
              const discovered = scopes.slice(0, 4).map((scope) => discoverLocalAgents(Object.values(ledger.participants), typeof decoded.args["project"] === "string" ? decoded.args["project"] : null, scope));
              value = { items: [...registered.map((entry) => ({ registered: true, ...entry })), ...discovered.flatMap((entry) => entry.items)], partialFailures: [...discovered.flatMap((entry) => entry.partialFailures), ...(scopes.length > 4 ? [`discovery skipped ${scopes.length - 4} socket scopes; registered participants remain visible`] : [])], observedAt: at };
            }
            result = { ok: true, value, observedAt: at };
          }
        } catch (error) {
          const reason = error instanceof HcoordError ? error : new HcoordError("internal", "coordinator operation failed; inspect daemon stderr");
          if (!(error instanceof HcoordError)) process.stderr.write(`${JSON.stringify({ event: "hcoord.operation_failed", at, error: String(error) })}\n`);
          result = { ok: false, error: { code: reason.code, message: reason.message, ...(reason.detail ? { detail: reason.detail } : {}) }, observedAt: at };
        }
        socket.end(`${JSON.stringify(result)}\n`);
        if (closing) server.close();
      });
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketFile, () => { server.off("error", reject); resolve(); }); });
    fs.chmodSync(socketFile, 0o600);
    const onSignal = (): void => { if (!closing) { closing = true; server.close(); } };
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
    const timer = setInterval(() => {
      if (tickPending) return;
      tickPending = true;
      processing = processing.then(() => { const at = new Date().toISOString(); const next: Ledger = structuredClone(ledger); const outcome = execute(next, "tick", {}, at); if (outcome.changed) { saveLedger(next, home); ledger = next; } processOutbox(); }).catch((error) => { process.stderr.write(`${JSON.stringify({ event: "hcoord.tick_failed", at: new Date().toISOString(), error: String(error) })}\n`); }).finally(() => { tickPending = false; });
    }, 1000);
    await new Promise<void>((resolve) => server.once("close", resolve));
    clearInterval(timer);
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    await processing;
  } finally { try { if (fs.existsSync(socketFile)) fs.unlinkSync(socketFile); } catch { /* report only through original error */ } }
}
