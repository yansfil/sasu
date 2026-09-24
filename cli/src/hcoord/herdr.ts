import os from "node:os";
import path from "node:path";
import { CODEX_INITIALIZATION_PROMPT, getAgent, initializedCodex, prepareCodexFirstTurn, promptAgent, runHerdrCommand, startAgentWhenPaneReady } from "../implement/herdr";
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

type LocalBinding = Pick<Participant, "machine" | "hostScope" | "session" | "instance" | "pane"> & { name?: string };
type ParticipantInspection = { runtime: Participant["runtime"]; connection: Participant["connection"]; reason: string; interactiveReady: boolean | null };
export const OFFICIAL_PROMPT_BOUNDARY = {
  transport: "Herdr 0.9.1 agent.prompt",
  preflight: "exact pane, session, terminal, lifecycle and interactive readiness",
  atomicInputProtection: false,
  limitation: "Herdr 0.9.1 does not atomically bind prompt submission to the preflight identity or protect human typing between inspection and submission",
} as const;

export function inspectParticipant(participant: LocalBinding): ParticipantInspection {
  if (participant.machine !== "local" && participant.machine !== os.hostname()) return { runtime: "unknown", connection: "unverified", reason: "remote Herdr routing is not verified", interactiveReady: null };
  if (participant.pane === null) return { runtime: "unknown", connection: "unverified", reason: "participant has no exact pane binding", interactiveReady: null };
  const found = getAgent(participant.pane, { env: scopeEnv(participant.hostScope) }, 1000);
  if (found.kind !== "found") return { runtime: "unknown", connection: "unavailable", reason: found.detail, interactiveReady: null };
  const agent = found.agent;
  if (agent.sessionId !== participant.session || agent.terminalId !== participant.instance || agent.paneId !== participant.pane || (participant.name !== undefined && agent.name !== participant.name)) return { runtime: "unknown", connection: "unavailable", reason: "execution identity changed", interactiveReady: null };
  return { runtime: agent.status === "blocked" ? "unknown" : agent.status, connection: "connected", reason: agent.status === "blocked" ? "recipient is blocked" : "exact Herdr execution observed", interactiveReady: agent.interactiveReady };
}

export function inspectDelivery(recipient: Participant): { ready: boolean; reason: string; runtime: Participant["runtime"]; connection: Participant["connection"] } {
  const observed = inspectParticipant(recipient);
  const { runtime, connection } = observed;
  if (connection !== "connected") return { ready: false, ...observed };
  if (runtime !== "idle" && runtime !== "done") return { ready: false, reason: observed.reason === "recipient is blocked" ? observed.reason : `recipient is ${runtime}; submission deferred`, runtime, connection };
  if (observed.interactiveReady !== true) return { ready: false, reason: "Herdr has not confirmed interactive readiness; submission deferred", runtime, connection };
  return { ready: true, reason: "exact idle or done execution is interactive-ready", runtime, connection };
}

export function officialDeliveryAvailable(participant: LocalBinding): { ready: boolean; reason: string } {
  const observed = inspectParticipant(participant);
  if (observed.connection !== "connected") return { ready: false, reason: observed.reason };
  const support = officialPromptSupport(participant.hostScope);
  return support.ready ? { ready: true, reason: "exact Observer binding and official agent.prompt API confirmed; delivery remains non-atomic" } : support;
}

export function officialPromptSupport(hostScope?: string): { ready: boolean; reason: string } {
  const help = runHerdrCommand(["agent", "prompt", "--help"], 2000, hostScope === undefined ? process.env : scopeEnv(hostScope));
  if (help.status !== 0 || !/herdr agent prompt <TARGET> <TEXT>/.test(`${help.stdout}${help.stderr}`)) return { ready: false, reason: "official Herdr agent.prompt API could not be confirmed" };
  return { ready: true, reason: "official Herdr agent.prompt API confirmed; delivery remains non-atomic" };
}

export function messageForDelivery(item: Request, delivery: Delivery, watchCycle: string | null): string {
  if (watchCycle !== null && (delivery.phase === "request" || delivery.phase === "watch_check" || delivery.phase === undefined)) {
    return `HCOORD_WATCH_CHECK\nrequest: ${item.id}\ntarget: ${item.from}\ncycle: ${watchCycle}\nRecorded observation: ${item.context ?? "none"}\nInspect the target's current exact Herdr execution before confirming this cycle. Then run hcoord watch check ${item.from} --cycle ${watchCycle} --actor ${delivery.recipient}. Do not use request reply for a watch cycle. If inspection is unavailable, leave the cycle unchecked and end this turn; hcoord will remind you.`;
  }
  if (delivery.phase === "relay_problem") return `HCOORD_RELAY_PROBLEM\nrequest: ${item.id}\nThe recorded answer still needs relay. Inspect hcoord request show ${item.id}, then relay within its scope.`;
  if (delivery.phase === "delivery_problem") return `HCOORD_DELIVERY_PROBLEM\nrequest: ${item.id}\nInspect the recorded answer and unresolved child delivery with hcoord request show ${item.id}`;
  if (delivery.phase === "relay") return `HCOORD_RELAY\nrequest: ${item.id}\n${item.relayBody}\nAcknowledge with hcoord request ack ${item.id} --actor ${delivery.recipient} --delivery ${delivery.id}`;
  if (delivery.phase === "answer") return `HCOORD_ANSWER\nrequest: ${item.id}\nanswer: ${item.answer}\n${item.intermediary === delivery.recipient ? `Relay within the answer's scope with hcoord request relay ${item.id} --body <text> --actor ${delivery.recipient}` : `Acknowledge with hcoord request ack ${item.id} --actor ${delivery.recipient} --delivery ${delivery.id}`}`;
  return `HCOORD_REQUEST\nrequest: ${item.id}\n${item.body}\nInspect with hcoord request show ${item.id}. If you can answer, use hcoord request reply ${item.id} --as ${delivery.recipient} --body <answer>. If a human must decide, use hcoord request escalate ${item.id} --actor ${delivery.recipient}, then end this turn. Do not poll: hcoord will wake you with HCOORD_ANSWER when the human reply is ready. Relay only the recorded answer.`;
}

export function submitOfficial(item: Request, delivery: Delivery, recipient: Participant, watchCycle: string | null): { status: Delivery["status"]; code: string; reason: string } {
  if (recipient.pane === null) throw new HcoordError("invalid_state", "recipient pane missing at submission");
  const result = promptAgent({ target: recipient.pane, text: messageForDelivery(item, delivery, watchCycle), expectedInputGuard: null }, { env: scopeEnv(recipient.hostScope) }, 2000);
  if (result.path !== "session-match") throw new HcoordError("runtime_unavailable", "Herdr adapter returned an unexpected prompt path; inspect the delivery outcome");
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
  if (pane?.["pane_id"] !== parent.pane || typeof pane?.["workspace_id"] !== "string" || typeof pane?.["cwd"] !== "string") throw new HcoordError("runtime_unavailable", "Herdr parent pane identity, workspace, or cwd is unconfirmed");
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

export function confirmSpawnPane(record: SpawnIntent, placement: { workspace: string; cwd: string }): void {
  if (record.pane === null) throw new HcoordError("spawn_uncertain", "the spawn intent has no pane ID to inspect");
  const result = runHerdrCommand(["pane", "get", record.pane], 2000, scopeEnv(record.hostScope));
  if (result.status !== 0) throw new HcoordError("spawn_uncertain", "the recorded pane is unavailable; inspect it before resuming", { pane: record.pane });
  const data = herdrJson(result.stdout);
  const pane = (data["result"] as Record<string, unknown> | undefined)?.["pane"] as Record<string, unknown> | undefined;
  if (pane?.["pane_id"] !== record.pane || pane?.["workspace_id"] !== placement.workspace || pane?.["cwd"] !== placement.cwd) {
    throw new HcoordError("identity_conflict", "the pane does not match the spawn intent's saved placement", { pane: record.pane });
  }
}

export type SpawnInspection = { state: "absent" } | { state: "initializing"; instance: string; interactiveReady: boolean | null; runtime: Participant["runtime"] } | { state: "ready"; session: string; instance: string; runtime: Participant["runtime"] };

export function inspectSpawnedAgent(record: SpawnIntent): SpawnInspection {
  if (record.pane === null) return { state: "absent" };
  const found = getAgent(record.pane, { env: scopeEnv(record.hostScope) }, 2000);
  if (found.kind === "absent") return { state: "absent" };
  if (found.kind !== "found") throw new HcoordError("spawn_uncertain", "Herdr cannot inspect the spawned pane; retain its ID and retry after reconnection", { intent: record.key, pane: record.pane, unfinishedStep: "inspect_agent" });
  if (found.agent.paneId !== record.pane || found.agent.name !== record.name || found.agent.kind !== record.kind) throw new HcoordError("identity_conflict", "spawn pane hosts a different execution; no binding was changed", { intent: record.key, pane: record.pane });
  if (found.agent.terminalId === null) throw new HcoordError("spawn_uncertain", "spawned agent has no terminal identity yet", { intent: record.key, pane: record.pane, unfinishedStep: "inspect_agent" });
  const runtime = found.agent.status === "blocked" ? "unknown" : found.agent.status;
  if (found.agent.sessionId === null) return { state: "initializing", instance: found.agent.terminalId, interactiveReady: found.agent.interactiveReady, runtime };
  return { state: "ready", session: found.agent.sessionId, instance: found.agent.terminalId, runtime };
}

/** The first Codex turn follows agent start, including an explicit task. */
function codexLaunchArgs(nativeArgs: string[]): { startArgs: string[]; prompt: string } {
  const valueFlags = new Set(["-c", "--config", "-i", "--image", "-m", "--model", "-p", "--profile", "-s", "--sandbox", "-C", "--cd", "--add-dir", "-a", "--ask-for-approval", "--remote", "--remote-auth-token-env", "--local-provider", "--enable", "--disable"]);
  for (let index = 0; index < nativeArgs.length; index += 1) {
    const arg = nativeArgs[index]!;
    if (arg === "--") {
      if (nativeArgs.length - index !== 2) throw new HcoordError("invalid_argument", "Codex accepts one task argument after --");
      return { startArgs: nativeArgs.slice(0, index), prompt: nativeArgs[index + 1]! };
    }
    if (valueFlags.has(arg)) { index += 1; continue; }
    if (arg.startsWith("-")) continue;
    if (index !== nativeArgs.length - 1) throw new HcoordError("invalid_argument", "Codex task must be the final native argument");
    return { startArgs: nativeArgs.slice(0, index), prompt: arg };
  }
  return { startArgs: nativeArgs, prompt: CODEX_INITIALIZATION_PROMPT };
}

export function startSpawnedAgent(record: SpawnIntent): void {
  if (record.pane === null) throw new HcoordError("invalid_state", "spawn intent has no pane");
  validateSpawnSpec(record.name, record.kind);
  const nativeArgs = record.kind === "codex" ? codexLaunchArgs(record.nativeArgs).startArgs : record.nativeArgs;
  const { result } = startAgentWhenPaneReady(["agent", "start", record.name, "--kind", record.kind, "--pane", record.pane, ...(nativeArgs.length ? ["--", ...nativeArgs] : [])], { env: scopeEnv(record.hostScope) });
  if (result.status !== 0) throw new HcoordError("spawn_uncertain", "Herdr did not confirm agent start; inspect the saved pane before retry", { intent: record.key, pane: record.pane, unfinishedStep: "agent_start" });
}

export function prepareSpawnInitialization(record: SpawnIntent, instance: string, advanceUpdate = true): void {
  if (record.pane === null || record.kind !== "codex") throw new HcoordError("invalid_state", "Codex initialization requires its saved pane");
  const observed = prepareCodexFirstTurn({ paneId: record.pane, name: record.name }, { env: scopeEnv(record.hostScope) }, advanceUpdate);
  if (observed.kind !== "found") throw new HcoordError("spawn_uncertain", `Codex first-turn preflight could not confirm its composer: ${observed.detail}`, { intent: record.key, pane: record.pane, unfinishedStep: "initialize_agent" });
  if (observed.agent.terminalId !== instance || observed.agent.sessionId !== null) throw new HcoordError("identity_conflict", "spawn execution changed before initialization submission", { intent: record.key, pane: record.pane });
}

export function submitSpawnInitialization(record: SpawnIntent, instance: string): { outcome: "accepted" | "rejected" | "unknown"; code: string } {
  if (record.pane === null || record.kind !== "codex") throw new HcoordError("invalid_state", "Codex initialization requires its saved pane");
  const observed = inspectSpawnedAgent(record);
  if (observed.state !== "initializing" || observed.instance !== instance) throw new HcoordError("identity_conflict", "spawn execution changed before initialization submission", { intent: record.key, pane: record.pane });
  if (observed.interactiveReady !== true || (observed.runtime !== "idle" && observed.runtime !== "done")) throw new HcoordError("spawn_uncertain", "spawned agent is not interactive-ready; inspect the saved pane before retry", { intent: record.key, pane: record.pane, unfinishedStep: "initialize_agent" });
  prepareSpawnInitialization(record, instance, false);
  const result = promptAgent({ target: record.pane, text: codexLaunchArgs(record.nativeArgs).prompt, expectedInputGuard: null }, { env: scopeEnv(record.hostScope) });
  return { outcome: result.outcome, code: result.code };
}

export function waitForSpawnInitialization(record: SpawnIntent): void {
  if (record.pane === null) throw new HcoordError("invalid_state", "spawn intent has no pane");
  const isInitialTurn = codexLaunchArgs(record.nativeArgs).prompt === CODEX_INITIALIZATION_PROMPT;
  const observed = initializedCodex({ paneId: record.pane, name: record.name }, { env: scopeEnv(record.hostScope) }, isInitialTurn);
  if (observed.kind !== "found" || observed.agent.sessionId === null || observed.agent.terminalId === null) {
    inspectSpawnedAgent(record);
    throw new HcoordError("spawn_uncertain", "Codex first turn did not confirm an execution identity; inspect the saved pane and retry this intent without resubmitting it", { intent: record.key, pane: record.pane, unfinishedStep: "initialize_agent" });
  }
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
