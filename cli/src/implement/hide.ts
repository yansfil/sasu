import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import type { ObserverIdentity, SupervisionRecord } from "./types";

/** Hide owns identities, watches and letters; Sasu owns its run record. */
export class HideCallFailed extends Error {
  constructor(message: string, readonly code: string | null) { super(message); this.name = "HideCallFailed"; }
}

export const HIDE_MISSING = "hide is not on PATH; open Hide and use its installed hide CLI, then retry";

export function runHide(argv: string[], env: NodeJS.ProcessEnv = process.env, timeout = 30_000): { stdout: string; stderr: string; status: number | null } {
  const run = spawnSync("hide", argv, { encoding: "utf8", timeout, env, shell: false });
  if ((run.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") throw new HideCallFailed(HIDE_MISSING, "not_installed");
  return { stdout: run.stdout ?? "", stderr: run.stderr ?? "", status: run.status };
}

/** Agent commands and delivery commands deliberately have different public envelopes. */
function call<T>(argv: string[], envelope: "agent" | "delivery", env: NodeJS.ProcessEnv = process.env): T {
  const run = runHide(argv, env);
  let wire: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(run.stdout);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    wire = parsed as Record<string, unknown>;
  } catch {
    throw new HideCallFailed(`hide ${argv.slice(0, 2).join(" ")} did not answer with JSON (exit ${run.status ?? "none"}): ${(run.stderr || run.stdout).trim().slice(0, 300)}`, null);
  }
  if (wire["ok"] !== true || run.status !== 0) {
    const error = wire["error"] as { code?: string; message?: string } | undefined;
    const code = typeof wire["reason"] === "string" ? wire["reason"] : error?.code ?? null;
    const reason = error?.message && code && error.message !== code ? `${code}: ${error.message}` : error?.message ?? code ?? "command failed";
    const next = typeof wire["next_action"] === "string" ? `; ${wire["next_action"]}` : "";
    throw new HideCallFailed(`hide ${argv.slice(0, 2).join(" ")} refused: ${reason}${next}`, code);
  }
  if (envelope === "delivery" && wire["type"] !== "workspace_result") throw new HideCallFailed("hide returned an unsupported delivery envelope", "invalid_response");
  const key = envelope === "agent" ? "value" : "result";
  if (!(key in wire)) throw new HideCallFailed(`hide returned no ${key}`, "invalid_response");
  return wire[key] as T;
}

export interface NativeActor { pane_id: string; name: string; kind: string; device_id: string; session: string | null }
export interface WatchView {
  id: string; parent: NativeActor; target: NativeActor; generation: number;
  last_activity_at_unix_ms: number; first_warning_at_unix_ms: number | null;
  warning_count: number; activity_failures: number; last_status: string;
  status_changed_at_unix_ms: number; last_state_change_seq: number | null;
}
export interface ParticipantView { id: string; name: string; machine: string; hostScope: string; pane: string | null; session: string; instance: string; parent: string | null; runtime: string; connection: string; registered?: boolean; watch: WatchView | null }

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const textField = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
function actor(value: unknown): value is NativeActor {
  return record(value) && ["pane_id", "name", "kind", "device_id"].every((key) => textField(value[key])) && (value.session === null || textField(value.session));
}
function watchView(value: unknown): WatchView {
  if (!record(value) || !textField(value.id) || !actor(value.parent) || !actor(value.target)
    || !["generation", "last_activity_at_unix_ms", "warning_count", "activity_failures", "status_changed_at_unix_ms"].every((key) => integer(value[key]))
    || !(value.first_warning_at_unix_ms === null || integer(value.first_warning_at_unix_ms))
    || !(value.last_state_change_seq === null || integer(value.last_state_change_seq)) || !textField(value.last_status)) {
    throw new HideCallFailed("hide returned an unusable watch; observe it again before changing the run", "invalid_response");
  }
  return value as unknown as WatchView;
}
function participantView(value: unknown): ParticipantView {
  if (!record(value) || !["id", "name", "machine", "hostScope", "session", "instance", "runtime", "connection"].every((key) => textField(value[key]))
    || !(value.pane === null || textField(value.pane)) || !(value.parent === null || textField(value.parent))
    || !(value.registered === undefined || typeof value.registered === "boolean") || !("watch" in value)) {
    throw new HideCallFailed("hide returned an unusable participant; observe it again before changing the run", "invalid_response");
  }
  if (value.watch !== null) watchView(value.watch);
  return value as unknown as ParticipantView;
}
function registrationId(value: unknown): string {
  if (!record(value) || !textField(value.id)) throw new HideCallFailed("hide returned no registered participant identity", "invalid_response");
  return value.id;
}
export function showParticipant(id: string, env: NodeJS.ProcessEnv = process.env): { value: ParticipantView; stale: false } { return { value: participantView(call<unknown>(["agent", "show", id], "agent", env)), stale: false }; }
export function listParticipants(): { value: ParticipantView[]; stale: false } {
  const value = call<{ items: ParticipantView[] }>(["agent", "list"], "agent");
  if (!Array.isArray(value.items)) throw new HideCallFailed("hide agent list returned no items", "invalid_response");
  return { value: value.items.map(participantView).filter((item) => item.registered === true), stale: false };
}

export interface ExecutionBinding { machine: string; hostScope: string; pane: string | null; session: string | null; instance: string | null }
export function sameExecution(recorded: ExecutionBinding, observed: ExecutionBinding): boolean {
  if (recorded.machine !== observed.machine || recorded.hostScope !== observed.hostScope || recorded.pane === null || observed.pane !== recorded.pane) return false;
  if (recorded.session !== null && observed.session !== null) return observed.session === recorded.session;
  return recorded.instance !== null && observed.instance === recorded.instance;
}
export function participantsOf(participants: ParticipantView[], identity: Pick<ObserverIdentity, "paneId" | "sessionId" | "terminalId" | "hostScope">): ParticipantView[] {
  return participants.filter((participant) => sameExecution(participant, { machine: "local", hostScope: identity.hostScope, pane: identity.paneId, session: identity.sessionId, instance: identity.terminalId }));
}
export function observerParticipantName(herdrName: string | null | undefined, sessionId: string): string {
  return herdrName?.trim() || `observer-${sessionId.slice(0, 8)}`;
}
export interface Execution { name: string; paneId: string; sessionId: string; terminalId: string; hostScope: string }
export interface ObserverRegistration { identity: ObserverIdentity; name: string }
const executionArgs = (execution: Execution): string[] => ["--machine", "local", "--host-scope", execution.hostScope, "--session", execution.sessionId, "--instance", execution.terminalId, "--name", execution.name, "--pane", execution.paneId];
const observerExecution = (observer: ObserverRegistration): Execution => ({ name: observer.name, paneId: observer.identity.paneId, sessionId: observer.identity.sessionId, terminalId: observer.identity.terminalId, hostScope: observer.identity.hostScope });

export function checkObserver(observer: ObserverRegistration, env: NodeJS.ProcessEnv = process.env): void {
  const checked = call<unknown>(["agent", "register", "--check", ...executionArgs(observerExecution(observer))], "agent", env);
  if (!record(checked) || typeof checked.registered !== "boolean" || checked.name !== observer.name || checked.pane !== observer.identity.paneId) throw new HideCallFailed("hide returned an unusable registration check; retry from the actual Observer pane", "invalid_response");
}
export interface RunSupervision { project: string }

/** Runs in the actual Observer pane. Every step converges after a partial refusal. */
export function registerRun(run: RunSupervision, observer: ObserverRegistration, implementor: Execution, env: NodeJS.ProcessEnv = process.env): NonNullable<SupervisionRecord["hide"]> {
  const observerId = registrationId(call<unknown>(["agent", "register", ...executionArgs(observerExecution(observer))], "agent", env));
  const implementorId = registrationId(call<unknown>(["agent", "register", ...executionArgs(implementor), "--parent", observerId, "--project", run.project], "agent", env));
  const watch = watchView(call<unknown>(["watch", "start", implementorId, "--observer", observerId, "--actor", observerId], "delivery", env));
  return { observer: observerId, implementor: implementorId, watchId: watch.id, registeredAt: new Date().toISOString() };
}

/** Assign before Sasu changes its Observer. A completed report never arms a new watch. */
export function handoverRun(implementorId: string, observer: ObserverRegistration, approval: string, env: NodeJS.ProcessEnv = process.env): { observer: string; watch: WatchView | null } {
  checkObserver(observer, env);
  const observerId = registrationId(call<unknown>(["agent", "register", ...executionArgs(observerExecution(observer))], "agent", env));
  const current = showParticipant(implementorId, env).value.watch;
  if (current === null) return { observer: observerId, watch: null };
  if (current.parent.pane_id === observer.identity.paneId && current.parent.session === observer.identity.sessionId) return { observer: observerId, watch: current };
  const watch = watchView(call<unknown>(["watch", "assign", current.id, "--observer", observerId, "--actor", observerId, "--expected-generation", String(current.generation), "--approval", approval], "delivery", env));
  return { observer: observerId, watch };
}
export function endParticipant(implementorId: string, actor?: string): { delivery: "delivered" } {
  call(["agent", "end", implementorId, ...(actor === undefined ? [] : ["--actor", actor])], "agent");
  return { delivery: "delivered" };
}

export type RunNoticeKind = "plan" | "block" | "report";
export interface SentNotice { requestId: string; intent: string; delivery: "delivered" | "pending"; letter: string }
interface Letter { id: string; intent: string; state: string }
/** Stable intent survives a Sasu retry. Pending remains unconfirmed delivery. */
export function sendRunNotice(run: string, participants: { observer: string; implementor: string }, kind: RunNoticeKind, body: string): SentNotice {
  const intent = `sasu:${run}:${kind}:${crypto.createHash("sha256").update(body).digest("hex").slice(0, 16)}`;
  const sent = call<Letter>(["request", "send", participants.observer, "--kind", kind === "plan" ? "request" : kind, "--intent", intent, "--body", body], "delivery");
  if (typeof sent.id !== "string" || sent.intent !== intent || !["pending", "delivered", "acknowledged"].includes(sent.state)) throw new HideCallFailed("hide returned an unusable letter; inspect the request and retry the same intent", "invalid_response");
  return { requestId: sent.id, intent, delivery: sent.state === "pending" ? "pending" : "delivered", letter: sent.id };
}
