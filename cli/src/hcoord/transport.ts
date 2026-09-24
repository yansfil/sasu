import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import { API_VERSION, HcoordError, MAX_CONNECTIONS, MAX_EVENTS, MAX_MESSAGE_BYTES, MAX_QUEUE, own, put, type Ledger } from "./model";
import { event } from "./model";
import { activeWatchCycleForRequest, execute } from "./service";
import { confirmSpawnPane, createSpawnPane, discoverLocalAgents, officialDeliveryAvailable, OFFICIAL_PROMPT_BOUNDARY, inspectDelivery, inspectParticipant, inspectSpawnedAgent, parentPlacement, startSpawnedAgent, submitOfficial, validateLocalBinding } from "./herdr";
import type { SpawnIntent } from "./model";
import { dataDir, ledgerPath, loadLedger, saveLedger, socketPath, stopMarkerPath } from "./store";
import { notifyHuman } from "./platform";

export interface WireRequest { version: number; operation: string; args: Record<string, unknown> }
export interface WireResult { ok: boolean; value?: unknown; error?: { code: string; message: string; detail?: Record<string, unknown> }; observedAt: string }
const mutation = (operation: string): boolean => !["status", "agent.list", "agent.show", "watch.list", "request.show", "inbox", "graph", "events"].includes(operation);

export async function callDaemon(operation: string, args: Record<string, unknown> = {}, home = os.homedir()): Promise<WireResult> {
  if (process.platform === "win32") throw new HcoordError("unsupported_platform", "Windows named-pipe ACL support is unverified; no local daemon connection was attempted");
  const request = `${JSON.stringify({ version: API_VERSION, operation, args })}\n`;
  if (Buffer.byteLength(request) > MAX_MESSAGE_BYTES) throw new HcoordError("capacity", `request exceeds ${MAX_MESSAGE_BYTES} bytes; shorten context or native arguments before retrying`);
  return await new Promise<WireResult>((resolve, reject) => {
    const socket = net.createConnection(socketPath(home));
    let text = "";
    const timeoutMs = operation === "agent.spawn" ? 75_000 : 10_000;
    const timer = setTimeout(() => { socket.destroy(); reject(new HcoordError("timeout", `coordinator did not answer within ${timeoutMs / 1000} seconds`)); }, timeoutMs);
    const finish = (error?: Error, value?: WireResult): void => { clearTimeout(timer); socket.destroy(); if (error) reject(error); else resolve(value!); };
    socket.on("connect", () => socket.write(request));
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
  const data = operation === "agent.list" ? { items: (outcome.value as Array<Record<string, unknown>>).map((item) => ({ registered: true, ...item })), partialFailures: ["daemon stopped; Herdr discovery unavailable"], observedAt: state.updatedAt }
    : operation === "status" ? { ...(outcome.value as object), deliverySafety: OFFICIAL_PROMPT_BOUNDARY } : outcome.value;
  return { ok: true, value: { data, stale: true, lastObservedAt: saved ? state.updatedAt : null, warning: saved ? "daemon stopped: automatic watch, reminders, and delivery are inactive" : "daemon stopped and no saved observation exists" }, observedAt };
}

export async function runDaemon(home = os.homedir()): Promise<void> {
  if (process.platform === "win32") throw new HcoordError("unsupported_platform", "Windows local IPC needs a verified user-restricted named pipe adapter");
  if (fs.existsSync(stopMarkerPath(home))) throw new HcoordError("manual_stop", "daemon was manually stopped; use hcoord daemon start to resume");
  fs.mkdirSync(dataDir(home), { recursive: true, mode: 0o700 });
  fs.chmodSync(dataDir(home), 0o700);
  let ledger = loadLedger(home);
  const socketFile = socketPath(home);
  const lockFile = `${socketFile}.lock`;
  let lockOwned = false, socketOwned = false;
  const acquireLock = (): void => {
    try { fs.writeFileSync(lockFile, `${process.pid}\n`, { flag: "wx", mode: 0o600 }); lockOwned = true; return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const recovery = `${lockFile}.recovery`;
    const owner = `${recovery}/owner`;
    const alive = (pid: number): boolean => {
      if (!Number.isSafeInteger(pid) || pid <= 0) return false;
      try { process.kill(pid, 0); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
    };
    let recoveryOwned = false;
    for (let attempt = 0; attempt < 3 && !recoveryOwned; attempt += 1) {
      try { fs.mkdirSync(recovery, { mode: 0o700 }); recoveryOwned = true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let ownerPid: number | null = null;
        try { ownerPid = Number(fs.readFileSync(owner, "utf8").trim()); }
        catch (readError) { if ((readError as NodeJS.ErrnoException).code !== "ENOENT") throw readError; }
        if (ownerPid !== null ? alive(ownerPid) : Date.now() - fs.statSync(recovery).mtimeMs < 10_000) throw new HcoordError("startup_in_progress", "another daemon is starting or recovering; retry after it finishes");
        try { if (ownerPid !== null) fs.unlinkSync(owner); fs.rmdirSync(recovery); }
        catch (cleanupError) { if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError; }
      }
    }
    if (!recoveryOwned) throw new HcoordError("startup_in_progress", "another daemon is recovering; retry after it finishes");
    try {
      fs.writeFileSync(owner, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      const pid = Number(fs.readFileSync(lockFile, "utf8").trim());
      if (alive(pid)) throw new HcoordError("already_running", "coordinator daemon is running or starting");
      fs.unlinkSync(lockFile);
      fs.writeFileSync(lockFile, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      lockOwned = true;
    } finally { if (fs.existsSync(owner)) fs.unlinkSync(owner); fs.rmdirSync(recovery); }
  };
  acquireLock();
  try {
  if (fs.existsSync(socketFile)) {
    try { await callDaemon("status", {}, home); throw new HcoordError("already_running", "coordinator daemon is already running"); }
    catch (error) { if (!(error instanceof HcoordError) || error.code !== "daemon_down") throw error; }
    fs.unlinkSync(socketFile);
  }
  let connections = 0;
  let queuedOperations = 0;
  let processing = Promise.resolve();
  let tickPending = false;
  let closing = false;
  let lastRetentionAt = 0;
  const commit = (operation: string, args: Record<string, unknown>, at: string): unknown => {
    const next = structuredClone(ledger);
    const outcome = execute(next, operation, args, at);
    if (outcome.changed) { saveLedger(next, home); ledger = next; }
    return outcome.value;
  };
  const spawnAgent = (args: Record<string, unknown>, at: string): unknown => {
    let intent = commit("agent.spawn.reserve", args, at) as SpawnIntent;
    const reconcilePane = args["reconcilePane"];
    if (reconcilePane !== null && reconcilePane !== undefined && (typeof reconcilePane !== "string" || reconcilePane.trim() === "")) throw new HcoordError("invalid_argument", "--reconcile-pane requires an exact pane ID");
    if (intent.pane !== null && reconcilePane !== null && reconcilePane !== undefined && reconcilePane !== intent.pane) throw new HcoordError("identity_conflict", "the spawn intent already owns a different pane", { intent: intent.key, pane: intent.pane });
    if (intent.status === "complete") return { intent, participant: ledger.participants[intent.participant!], watch: ledger.watches[intent.participant!] ?? null };
    let createdNow = false;
    if (intent.pane === null) {
      const parent = ledger.participants[intent.parent]!;
      if (intent.status !== "reserved") {
        if (typeof reconcilePane !== "string" || reconcilePane.trim() === "") throw new HcoordError("spawn_uncertain", "tab creation outcome is unknown; inspect the original tab and retry this intent with --reconcile-pane <exact-pane-id>", { intent: intent.key, pane: null, unfinishedStep: "record_pane" });
        // Older persisted intents lack placement, so retain their parent placement check.
        confirmSpawnPane({ ...intent, pane: reconcilePane }, intent.placement ?? parentPlacement(parent));
        const found = inspectSpawnedAgent({ ...intent, pane: reconcilePane });
        if (found === null && args["resumeStart"] !== true) throw new HcoordError("spawn_uncertain", "pane is confirmed but has no agent; retry with --reconcile-pane and --resume-start after inspecting it", { intent: intent.key, pane: reconcilePane, unfinishedStep: "agent_start" });
        intent = commit("agent.spawn.pane", { intent: intent.key, pane: reconcilePane }, new Date().toISOString()) as SpawnIntent;
      } else {
        if (reconcilePane !== null && reconcilePane !== undefined) throw new HcoordError("invalid_argument", "a new spawn intent cannot reconcile an existing pane");
        const placement = parentPlacement(parent);
        intent = commit("agent.spawn.unknown", { intent: intent.key, reason: "tab creation reserved; outcome pending", ...placement }, at) as SpawnIntent;
        let pane: string;
        try { pane = createSpawnPane(intent, placement); }
        catch (error) { throw new HcoordError("spawn_uncertain", "tab creation outcome is unknown; inspect the original intent before reconciling a pane", { intent: intent.key, pane: null, unfinishedStep: "record_pane", code: error instanceof HcoordError ? error.code : "runtime_failed" }); }
        try { intent = commit("agent.spawn.pane", { intent: intent.key, pane }, new Date().toISOString()) as SpawnIntent; }
        catch (error) { throw new HcoordError("spawn_uncertain", "tab was created but pane recording failed; inspect the saved pane and repair storage before reconciling this intent", { intent: intent.key, pane, unfinishedStep: "record_pane", code: error instanceof HcoordError ? error.code : "storage_failed" }); }
        createdNow = true;
      }
    }
    let identity = inspectSpawnedAgent(intent);
    if (identity === null) {
      if (!createdNow && args["resumeStart"] !== true) throw new HcoordError("spawn_uncertain", "saved pane has no confirmed agent; inspect it and retry this intent with --resume-start", { intent: intent.key, pane: intent.pane, unfinishedStep: "agent_start" });
      if (!createdNow) confirmSpawnPane(intent, intent.placement ?? parentPlacement(ledger.participants[intent.parent]!));
      if (ledger.events.length >= MAX_EVENTS) throw new HcoordError("capacity", "event history has no room to record the resumed agent; resolve retention before starting it", { intent: intent.key, pane: intent.pane });
      startSpawnedAgent(intent);
      identity = inspectSpawnedAgent(intent);
      if (identity === null) throw new HcoordError("spawn_uncertain", "agent start returned but execution identity is unavailable", { intent: intent.key, pane: intent.pane });
    }
    try { return commit("agent.spawn.complete", { intent: intent.key, runtimeSession: identity.session, instance: identity.instance, runtime: identity.runtime, project: ledger.participants[intent.parent]?.project }, new Date().toISOString()); }
    catch (error) { throw new HcoordError("spawn_uncertain", "agent exists but registration failed; inspect the saved pane and retry this intent after repairing storage", { intent: intent.key, pane: intent.pane, unfinishedStep: "register_agent", code: error instanceof HcoordError ? error.code : "storage_failed" }); }
  };
  const registerSasuRun = (args: Record<string, unknown>, at: string): unknown => {
    const run = String(args["run"] ?? ""), project = String(args["project"] ?? "");
    if (run === "" || project === "") throw new HcoordError("invalid_argument", "run and project are required");
    const observerBinding = validateLocalBinding("local", String(args["observerSession"] ?? ""), String(args["observerInstance"] ?? ""), String(args["observerPane"] ?? ""), String(args["observerHostScope"] ?? "default"), String(args["observerName"] ?? ""));
    const implementorBinding = validateLocalBinding("local", String(args["implementorSession"] ?? ""), String(args["implementorInstance"] ?? ""), String(args["implementorPane"] ?? ""), String(args["implementorHostScope"] ?? "default"), String(args["implementorName"] ?? ""));
    const observerCapability = officialDeliveryAvailable({ machine: "local", hostScope: String(args["observerHostScope"] ?? "default"), session: String(args["observerSession"] ?? ""), instance: String(args["observerInstance"] ?? ""), pane: String(args["observerPane"] ?? ""), name: String(args["observerName"] ?? "") });
    if (!observerCapability.ready) throw new HcoordError("unsupported_runtime", `Sasu Observer wake cannot use official delivery: ${observerCapability.reason}`);
    const next = structuredClone(ledger);
    const observer = execute(next, "agent.register", { machine: "local", hostScope: args["observerHostScope"], session: args["observerSession"], instance: args["observerInstance"], name: args["observerName"], pane: args["observerPane"], project, runtime: observerBinding.runtime }, at).value as { id: string };
    const implementor = execute(next, "agent.register", { machine: "local", hostScope: args["implementorHostScope"], session: args["implementorSession"], instance: args["implementorInstance"], name: args["implementorName"], pane: args["implementorPane"], project, parent: observer.id, runtime: implementorBinding.runtime }, at).value as { id: string };
    const prior = own(next.sasuRuns, run);
    if (prior && (prior.observer !== observer.id || prior.implementor !== implementor.id || prior.project !== project)) throw new HcoordError("intent_conflict", "Sasu run is already bound to another execution", { run });
    const current = next.watches[implementor.id];
    if (current?.status === "active" && current.observer !== observer.id) throw new HcoordError("conflict", "Sasu implementor has another active observer");
    const watch = current?.status === "active" ? current : execute(next, "watch.start", { target: implementor.id, observer: observer.id, actor: "human" }, at).value;
    if (!prior) put(next.sasuRuns, run, { observer: observer.id, implementor: implementor.id, project, registeredAt: at });
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
        if (item.status === "answered" && (delivery.phase ?? "request") === "request") {
          const next = structuredClone(ledger);
          const current = next.requests[item.id]!.deliveries.find((entry) => entry.id === delivery.id)!;
          current.status = "superseded";
          current.reason = "original request was answered before submission";
          saveLedger(next, home); ledger = next;
          continue;
        }
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
        const recipient = own(ledger.participants, delivery.recipient);
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
        const target = own(next.participants, delivery.recipient)!;
        const inspection = inspectDelivery(recipient);
        current.attemptedAt = at;
        target.runtime = inspection.runtime;
        target.connection = inspection.connection;
        target.observedAt = at;
        if (!inspection.ready) {
          current.status = "deferred";
          current.reason = inspection.reason;
          saveLedger(next, home); ledger = next;
          continue;
        }
        // Persist uncertainty before the external effect. A crash or timeout never causes a blind resend.
        current.status = "unknown";
        current.reason = "official prompt submission reserved; outcome not yet confirmed";
        saveLedger(next, home); ledger = next;
        // The disk reservation is required for retry safety. Reobserve directly
        // afterward so known identity, lifecycle and readiness changes defer.
        // Official 0.9.1 still cannot make this check atomic with agent.prompt.
        const finalInspection = inspectDelivery(recipient);
        if (!finalInspection.ready) {
          const deferred = structuredClone(ledger);
          const record = deferred.requests[item.id]!.deliveries.find((entry) => entry.id === delivery.id)!;
          record.status = "deferred";
          record.reason = finalInspection.reason;
          saveLedger(deferred, home); ledger = deferred;
          continue;
        }
        const outcome = submitOfficial(item, delivery, recipient, activeWatchCycleForRequest(ledger, item));
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
    socket.setTimeout(80_000, () => socket.destroy());
    let input = "";
    let received = false;
    socket.on("close", () => { connections -= 1; });
    socket.on("data", (chunk: Buffer) => {
      if (received) return;
      input += chunk.toString("utf8");
      if (Buffer.byteLength(input) > MAX_MESSAGE_BYTES) { received = true; socket.end(`${JSON.stringify({ ok: false, error: { code: "capacity", message: `request exceeds ${MAX_MESSAGE_BYTES} bytes; shorten context or native arguments before retrying` }, observedAt: new Date().toISOString() })}\n`); return; }
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      if (input.slice(newline + 1).trim() !== "") { socket.end(`${JSON.stringify({ ok: false, error: { code: "protocol", message: "one request per connection is allowed" }, observedAt: new Date().toISOString() })}\n`); return; }
      received = true;
      socket.pause();
      if (queuedOperations >= MAX_QUEUE) { socket.end(`${JSON.stringify({ ok: false, error: { code: "capacity", message: `queued operation limit ${MAX_QUEUE} reached` }, observedAt: new Date().toISOString() })}\n`); return; }
      queuedOperations += 1;
      const line = input.slice(0, newline);
      input = "";
      processing = processing.then(async () => {
        const at = new Date().toISOString();
        let result: WireResult;
        try {
          if (closing) throw new HcoordError("manual_stop", "daemon is stopping; restart it before submitting more work");
          const decoded = JSON.parse(line) as WireRequest;
          if (decoded.version !== API_VERSION) throw new HcoordError("version_mismatch", `API version ${decoded.version} is unsupported; expected ${API_VERSION}`);
          if (typeof decoded.operation !== "string" || !decoded.args || typeof decoded.args !== "object" || Array.isArray(decoded.args)) throw new HcoordError("protocol", "operation and object args are required");
          if (decoded.operation === "daemon.stop") {
            fs.writeFileSync(stopMarkerPath(home), `${at}\n`, { mode: 0o600 });
            result = { ok: true, value: { stopped: true }, observedAt: at };
            closing = true;
          } else {
            if (decoded.operation.startsWith("agent.spawn.") || decoded.operation === "tick" || decoded.operation === "agent.observe") throw new HcoordError("forbidden", "operation is daemon-internal");
            if (decoded.operation === "agent.register") {
              const binding = validateLocalBinding(String(decoded.args["machine"] ?? ""), String(decoded.args["session"] ?? ""), String(decoded.args["instance"] ?? ""), typeof decoded.args["pane"] === "string" ? decoded.args["pane"] : null, String(decoded.args["hostScope"] ?? "default"), String(decoded.args["name"] ?? ""));
              decoded.args["runtime"] = binding.runtime;
            }
            let value = decoded.operation === "agent.spawn" ? spawnAgent(decoded.args, at) : decoded.operation === "sasu.register" ? registerSasuRun(decoded.args, at) : commit(decoded.operation, decoded.args, at);
            if (decoded.operation === "status") {
              value = { ...(value as object), deliverySafety: OFFICIAL_PROMPT_BOUNDARY, usage: { ledgerBytes: fs.existsSync(ledgerPath(home)) ? fs.statSync(ledgerPath(home)).size : 0,
                connections, queuedOperations, queuedDeliveries: Object.values(ledger.requests).reduce((sum, item) => sum + item.deliveries.filter((delivery) => delivery.status === "pending" || delivery.status === "deferred").length, 0),
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
          const reason = error instanceof HcoordError ? error : error instanceof SyntaxError ? new HcoordError("protocol", "request JSON is invalid") : new HcoordError("internal", "coordinator operation failed; inspect daemon stderr");
          if (!(error instanceof HcoordError)) process.stderr.write(`${JSON.stringify({ event: "hcoord.operation_failed", at, code: error instanceof SyntaxError ? "invalid_json" : "internal" })}\n`);
          result = { ok: false, error: { code: reason.code, message: reason.message, ...(reason.detail ? { detail: reason.detail } : {}) }, observedAt: at };
        }
        socket.end(`${JSON.stringify(result)}\n`);
        if (closing) server.close();
      }).catch(() => {
        process.stderr.write(`${JSON.stringify({ event: "hcoord.operation_failed", at: new Date().toISOString(), code: "internal" })}\n`);
        if (!socket.destroyed) socket.end(`${JSON.stringify({ ok: false, error: { code: "internal", message: "coordinator operation failed; inspect daemon log" }, observedAt: new Date().toISOString() })}\n`);
      }).finally(() => { queuedOperations -= 1; });
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketFile, () => { server.off("error", reject); resolve(); }); });
    socketOwned = true;
    fs.chmodSync(socketFile, 0o600);
    const onSignal = (): void => { if (!closing) { closing = true; server.close(); } };
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
    const timer = setInterval(() => {
      if (tickPending || closing) return;
      tickPending = true;
      processing = processing.then(() => {
        if (closing) return;
        const at = new Date().toISOString();
        const next: Ledger = structuredClone(ledger);
        const due = Object.values(next.watches).filter((watch) => watch.status === "active" && Date.parse(watch.dueAt) <= Date.parse(at)).sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt)).slice(0, 4);
        const observedTargets: string[] = [];
        for (const watch of due) {
          const participant = own(next.participants, watch.target);
          if (!participant) throw new HcoordError("corrupt_ledger", "active watch target is missing");
          const observed = inspectParticipant(participant);
          execute(next, "agent.observe", { id: participant.id, runtime: observed.runtime, connection: observed.connection, reason: observed.reason }, at);
          observedTargets.push(participant.id);
        }
        const oldestUnwatched = Object.values(next.participants).filter((person) => person.runtime !== "done" && next.watches[person.id]?.status !== "active" && Date.parse(at) - Date.parse(person.observedAt) >= 300_000).sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt))[0];
        if (oldestUnwatched) {
          const observed = inspectParticipant(oldestUnwatched);
          execute(next, "agent.observe", { id: oldestUnwatched.id, runtime: observed.runtime, connection: observed.connection, reason: observed.reason }, at);
        }
        const runRetention = Date.parse(at) - lastRetentionAt >= 3_600_000;
        const outcome = execute(next, "tick", { observedTargets, runRetention }, at);
        if (outcome.changed || observedTargets.length > 0 || oldestUnwatched) { saveLedger(next, home); ledger = next; }
        if (runRetention) lastRetentionAt = Date.parse(at);
        processOutbox();
      }).catch((error) => { process.stderr.write(`${JSON.stringify({ event: "hcoord.tick_failed", at: new Date().toISOString(), code: error instanceof HcoordError ? error.code : "internal" })}\n`); }).finally(() => { tickPending = false; });
    }, 1000);
    await new Promise<void>((resolve) => server.once("close", resolve));
    clearInterval(timer);
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    await processing;
  } finally { try { if (socketOwned && fs.existsSync(socketFile)) fs.unlinkSync(socketFile); } catch { /* report only through original error */ } }
  } finally { try { if (lockOwned && fs.existsSync(lockFile)) fs.unlinkSync(lockFile); } catch { /* report only through original error */ } }
}
