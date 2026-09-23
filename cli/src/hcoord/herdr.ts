import os from "node:os";
import path from "node:path";
import { getAgent, guardedPromptSupport, promptAgent, runHerdrCommand } from "../implement/herdr";
import { HcoordError, validateSpawnSpec, type Delivery, type Participant, type Request, type SpawnIntent } from "./model";

function scopeEnv(hostScope: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (hostScope === "default") delete env["HERDR_SOCKET_PATH"];
  else env["HERDR_SOCKET_PATH"] = hostScope;
  return env;
}

export function validateLocalBinding(machine: string, session: string, instance: string, pane: string | null, hostScope = "default", expectedName?: string): { pane: string; runtime: Participant["runtime"] } {
  if (machine !== "local" && machine !== os.hostname()) throw new HcoordError("unsupported_remote", "remote Herdr host and coordinator SSH bridge have not been verified");
  if (pane === null) throw new HcoordError("invalid_argument", "local registration requires an exact --pane execution target");
  const found = getAgent(pane, { env: scopeEnv(hostScope) }, 2000);
  if (found.kind !== "found") throw new HcoordError("runtime_unavailable", `Herdr did not confirm the specified pane: ${found.detail}`);
  if (found.agent.sessionId !== session || found.agent.terminalId !== instance || found.agent.paneId !== pane) throw new HcoordError("identity_conflict", "pane execution identity changed; select its current session and instance", { current: { pane: found.agent.paneId, session: found.agent.sessionId, instance: found.agent.terminalId } });
  if (expectedName !== undefined && found.agent.name !== expectedName) throw new HcoordError("identity_conflict", "pane agent name differs from the requested registration", { current: { pane, name: found.agent.name } });
  return { pane, runtime: found.agent.status === "blocked" ? "unknown" : found.agent.status };
}

type LocalBinding = Pick<Participant, "machine" | "hostScope" | "session" | "instance" | "pane">;
export function inspectParticipant(participant: LocalBinding): { runtime: Participant["runtime"]; connection: Participant["connection"]; reason: string; guard: string | null } {
  if (participant.machine !== "local" && participant.machine !== os.hostname()) return { runtime: "unknown", connection: "unverified", reason: "remote Herdr routing is not verified", guard: null };
  if (participant.pane === null) return { runtime: "unknown", connection: "unverified", reason: "participant has no exact pane binding", guard: null };
  const found = getAgent(participant.pane, { env: scopeEnv(participant.hostScope) }, 1000);
  if (found.kind !== "found") return { runtime: "unknown", connection: "unavailable", reason: found.detail, guard: null };
  const agent = found.agent;
  if (agent.sessionId !== participant.session || agent.terminalId !== participant.instance || agent.paneId !== participant.pane) return { runtime: "unknown", connection: "unavailable", reason: "execution identity changed", guard: null };
  return { runtime: agent.status === "blocked" ? "unknown" : agent.status, connection: "connected", reason: "exact Herdr execution observed", guard: agent.inputGuard };
}

export function inspectDelivery(recipient: Participant): { ready: boolean; reason: string; guard: string | null; runtime: Participant["runtime"]; connection: Participant["connection"] } {
  const observed = inspectParticipant(recipient);
  const { runtime, connection, guard } = observed;
  if (connection !== "connected") return { ready: false, ...observed };
  if (runtime !== "idle" && runtime !== "done") return { ready: false, reason: `recipient is ${runtime}; safe submission deferred`, guard: null, runtime, connection };
  if (guard === null) return { ready: false, reason: "Herdr input guard is absent; unguarded prompt is forbidden", guard: null, runtime, connection };
  const support = guardedPromptSupport({ run: (args) => runHerdrCommand(args, 2000, scopeEnv(recipient.hostScope)) });
  if (support.supported !== true) return { ready: false, reason: support.supported === false ? "Herdr guarded prompt command is unsupported" : "Herdr guarded prompt capability could not be confirmed", guard: null, runtime, connection: "connected" };
  return { ready: true, reason: "guarded input available", guard, runtime, connection };
}

export function guardedDeliveryAvailable(participant: LocalBinding): { ready: boolean; reason: string } {
  const observed = inspectParticipant(participant);
  if (observed.connection !== "connected") return { ready: false, reason: observed.reason };
  if (observed.guard === null) return { ready: false, reason: "exact Observer has no Herdr input guard" };
  const support = guardedPromptSupport({ run: (args) => runHerdrCommand(args, 2000, scopeEnv(participant.hostScope)) });
  return support.supported === true ? { ready: true, reason: "guarded delivery available" } : { ready: false, reason: "Herdr guarded prompt command is unsupported or unconfirmed" };
}

export function messageForDelivery(item: Request, delivery: Delivery): string {
  if (delivery.phase === "watch_check") return `HCOORD_WATCH_CHECK\nrequest: ${item.id}\nThe watch cycle still needs confirmation after handover. Inspect the target, then run hcoord watch check ${item.from} --cycle ${item.intent.split(":").at(-1)} --actor ${delivery.recipient}`;
  if (delivery.phase === "relay_problem") return `HCOORD_RELAY_PROBLEM\nrequest: ${item.id}\nThe recorded answer still needs relay. Inspect hcoord request show ${item.id}, then relay within its scope.`;
  if (delivery.phase === "delivery_problem") return `HCOORD_DELIVERY_PROBLEM\nrequest: ${item.id}\nInspect the recorded answer and unresolved child delivery with hcoord request show ${item.id}`;
  if (delivery.phase === "relay") return `HCOORD_RELAY\nrequest: ${item.id}\n${item.relayBody}\nAcknowledge with hcoord request ack ${item.id} --actor ${delivery.recipient} --delivery ${delivery.id}`;
  if (delivery.phase === "answer") return `HCOORD_ANSWER\nrequest: ${item.id}\nanswer: ${item.answer}\n${item.intermediary === delivery.recipient ? `Relay within the answer's scope with hcoord request relay ${item.id} --body <text> --actor ${delivery.recipient}` : `Acknowledge with hcoord request ack ${item.id} --actor ${delivery.recipient} --delivery ${delivery.id}`}`;
  return `HCOORD_REQUEST\nrequest: ${item.id}\n${item.body}\nInspect with hcoord request show ${item.id}`;
}

export function submitGuarded(item: Request, delivery: Delivery, recipient: Participant, guard: string): { status: Delivery["status"]; code: string; reason: string } {
  if (recipient.pane === null) throw new HcoordError("invalid_state", "recipient pane missing at submission");
  const result = promptAgent({ target: recipient.pane, text: messageForDelivery(item, delivery), expectedInputGuard: guard }, { env: scopeEnv(recipient.hostScope) }, 2000);
  if (result.path !== "guarded") throw new HcoordError("unsafe_delivery", "Herdr adapter returned an unguarded path; no success recorded");
  return { status: result.outcome === "accepted" ? "accepted" : result.outcome === "rejected" ? "deferred" : "unknown", code: result.code, reason: result.detail };
}

const herdrJson = (text: string): Record<string, unknown> => {
  try { const parsed = JSON.parse(text) as Record<string, unknown>; if (parsed && typeof parsed === "object") return parsed; }
  catch { /* structural failure below */ }
  throw new HcoordError("runtime_unavailable", "Herdr returned invalid JSON; spawn state remains uncertain");
};

export function parentPlacement(parent: Participant): { workspace: string; cwd: string } {
  if (parent.machine !== "local" && parent.machine !== os.hostname()) throw new HcoordError("unsupported_remote", "remote Herdr spawn is not verified");
  if (parent.pane === null) throw new HcoordError("identity_conflict", "parent has no exact pane binding");
  validateLocalBinding(parent.machine, parent.session, parent.instance, parent.pane, parent.hostScope);
  const result = runHerdrCommand(["pane", "get", parent.pane], 2000, scopeEnv(parent.hostScope));
  if (result.status !== 0) throw new HcoordError("runtime_unavailable", "Herdr could not inspect the parent pane");
  const data = herdrJson(result.stdout);
  const pane = (data["result"] as Record<string, unknown> | undefined)?.["pane"] as Record<string, unknown> | undefined;
  if (typeof pane?.["workspace_id"] !== "string" || typeof pane?.["cwd"] !== "string") throw new HcoordError("runtime_unavailable", "Herdr parent pane has no workspace or cwd");
  return { workspace: pane["workspace_id"], cwd: pane["cwd"] };
}

export function createSpawnPane(record: SpawnIntent, placement: { workspace: string; cwd: string }): string {
  const result = runHerdrCommand(["tab", "create", "--workspace", placement.workspace, "--cwd", placement.cwd, "--label", record.name, "--no-focus"], 5000, scopeEnv(record.hostScope));
  if (result.status !== 0) throw new HcoordError("spawn_uncertain", "Herdr did not confirm tab creation; do not repeat this intent without inspecting the original result");
  const data = herdrJson(result.stdout);
  const created = data["result"] as Record<string, unknown> | undefined;
  const pane = created?.["root_pane"] as Record<string, unknown> | undefined;
  if (typeof pane?.["pane_id"] !== "string") throw new HcoordError("spawn_uncertain", "Herdr returned no pane ID after tab creation; do not create another tab");
  return pane["pane_id"];
}

export function inspectSpawnedAgent(record: SpawnIntent): { session: string; instance: string; runtime: Participant["runtime"] } | null {
  if (record.pane === null) return null;
  const found = getAgent(record.pane, { env: scopeEnv(record.hostScope) }, 2000);
  if (found.kind === "absent") return null;
  if (found.kind !== "found") throw new HcoordError("spawn_uncertain", "Herdr cannot inspect the spawned pane; retain its ID and retry after reconnection", { pane: record.pane });
  if (found.agent.name !== record.name) throw new HcoordError("identity_conflict", "spawn pane hosts a different agent; no new agent was started", { pane: record.pane, currentName: found.agent.name });
  if (found.agent.sessionId === null || found.agent.terminalId === null) throw new HcoordError("spawn_uncertain", "spawned agent has no stable execution identity yet", { pane: record.pane });
  return { session: found.agent.sessionId, instance: found.agent.terminalId, runtime: found.agent.status === "blocked" ? "unknown" : found.agent.status };
}

export function startSpawnedAgent(record: SpawnIntent): void {
  if (record.pane === null) throw new HcoordError("invalid_state", "spawn intent has no pane");
  validateSpawnSpec(record.name, record.kind);
  const result = runHerdrCommand(["agent", "start", record.name, "--kind", record.kind, "--pane", record.pane, "--timeout", "10000", ...(record.nativeArgs.length ? ["--", ...record.nativeArgs] : [])], 12_000, scopeEnv(record.hostScope));
  if (result.status !== 0) throw new HcoordError("spawn_uncertain", "Herdr did not confirm agent start; inspect the saved pane before retry", { pane: record.pane });
}

export function discoverLocalAgents(registered: Participant[], project: string | null, hostScope = "default"): { items: Array<Record<string, unknown>>; partialFailures: string[] } {
  const result = runHerdrCommand(["agent", "list"], 500, scopeEnv(hostScope));
  if (result.status !== 0) return { items: [], partialFailures: ["local Herdr agent discovery is unavailable"] };
  try {
    const parsed = herdrJson(result.stdout);
    const raw = (parsed["result"] as Record<string, unknown> | undefined)?.["agents"];
    if (!Array.isArray(raw)) throw new Error("missing agents");
    const items: Array<Record<string, unknown>> = [];
    for (const candidate of raw.slice(0, 2048)) {
      if (!candidate || typeof candidate !== "object") continue;
      const agent = candidate as Record<string, unknown>;
      const pane = agent["pane_id"], cwd = agent["cwd"];
      const session = (agent["agent_session"] as Record<string, unknown> | undefined)?.["value"];
      const instance = agent["terminal_id"];
      if (typeof pane !== "string" || typeof session !== "string" || typeof instance !== "string") continue;
      if (project !== null && (typeof cwd !== "string" || path.resolve(cwd) !== path.resolve(project))) continue;
      if (registered.some((p) => p.hostScope === hostScope && p.pane === pane && p.session === session && p.instance === instance)) continue;
      items.push({ id: `discovered:${hostScope}:${session}:${instance}`, registered: false, watch: null, machine: "local", hostScope, session, instance, pane, name: agent["name"] ?? null, project: cwd ?? null, runtime: agent["agent_status"] ?? "unknown", connection: "connected", observedAt: new Date().toISOString() });
    }
    return { items, partialFailures: [] };
  } catch { return { items: [], partialFailures: ["local Herdr agent list returned an invalid response"] }; }
}
