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
export function observerParticipantName(herdrName: string | null | undefined, sessionId: string): string {
  return herdrName?.trim() || `observer-${sessionId.slice(0, 8)}`;
}
export interface Execution { name: string; paneId: string; sessionId: string; terminalId: string; hostScope: string }
export interface ObserverRegistration { identity: ObserverIdentity; name: string }
/** No machine: Hide registers the caller's own, which its pane capability names, so a device pane registers as that device. */
const executionArgs = (execution: Execution): string[] => ["--host-scope", execution.hostScope, "--session", execution.sessionId, "--instance", execution.terminalId, "--name", execution.name, "--pane", execution.paneId];
const observerExecution = (observer: ObserverRegistration): Execution => ({ name: observer.name, paneId: observer.identity.paneId, sessionId: observer.identity.sessionId, terminalId: observer.identity.terminalId, hostScope: observer.identity.hostScope });

/**
 * The Observer pane's live Hide registration, whatever its name and parent.
 * A lead that spawns the Observer registers it under the lead, and Hide
 * refuses to register that identity again with another parent or name
 * (registration_conflict) while only the lead may name the lead as parent
 * (parent_authority_required): both Observers spawned on 2026-10-07 were
 * refused at dispatch, and ending the registration to get past it cut the
 * lead's lineage and watch (sasu#19). Hide keys a live registration on the
 * pane and native session, so those and the host scope find it.
 */
function liveObserverId(identity: ObserverIdentity, env: NodeJS.ProcessEnv): string | null {
  const listed = call<unknown>(["agent", "list"], "agent", env);
  if (!record(listed) || !Array.isArray(listed.items)) throw new HideCallFailed("hide returned an unusable participant list; observe it again before changing the run", "invalid_response");
  const live = listed.items.map(participantView).filter((participant) => participant.registered !== false && participant.runtime !== "ended"
    && participant.pane === identity.paneId && participant.session === identity.sessionId && participant.hostScope === identity.hostScope);
  if (live.length > 1) throw new HideCallFailed(`hide lists ${live.length} live registrations for the Observer pane ${identity.paneId}; end the stale one before dispatching`, "invalid_response");
  return live[0]?.id ?? null;
}

/** Adopts the pane's live registration, so a lead's lineage and watch survive; registers only an unregistered pane. */
function registerObserver(observer: ObserverRegistration, env: NodeJS.ProcessEnv): string {
  return liveObserverId(observer.identity, env) ?? registrationId(call<unknown>(["agent", "register", ...executionArgs(observerExecution(observer))], "agent", env));
}

export function checkObserver(observer: ObserverRegistration, env: NodeJS.ProcessEnv = process.env): void {
  if (liveObserverId(observer.identity, env) !== null) return;
  const checked = call<unknown>(["agent", "register", "--check", ...executionArgs(observerExecution(observer))], "agent", env);
  if (!record(checked) || typeof checked.registered !== "boolean" || checked.name !== observer.name || checked.pane !== observer.identity.paneId) throw new HideCallFailed("hide returned an unusable registration check; retry from the actual Observer pane", "invalid_response");
}
export interface RunSupervision { project: string }

/** Runs in the actual Observer pane. Every step converges after a partial refusal. */
export function registerRun(run: RunSupervision, observer: ObserverRegistration, implementor: Execution, env: NodeJS.ProcessEnv = process.env): NonNullable<SupervisionRecord["hide"]> {
  const observerId = registerObserver(observer, env);
  const implementorId = registrationId(call<unknown>(["agent", "register", ...executionArgs(implementor), "--parent", observerId, "--project", run.project], "agent", env));
  const watch = watchView(call<unknown>(["watch", "start", implementorId, "--observer", observerId, "--actor", observerId], "delivery", env));
  return { observer: observerId, implementor: implementorId, watchId: watch.id, registeredAt: new Date().toISOString() };
}

/** Assign before Sasu changes its Observer. A completed report never arms a new watch. */
export function handoverRun(implementorId: string, observer: ObserverRegistration, approval: string, env: NodeJS.ProcessEnv = process.env): { observer: string; watch: WatchView | null } {
  const observerId = registerObserver(observer, env);
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
interface Letter { id: string; intent: string; state: string; hook_confirmed?: boolean | null }
/** Stable intent survives retry; acknowledgement alone does not prove intake. */
export function sendRunNotice(run: string, participants: { observer: string; implementor: string }, kind: RunNoticeKind, body: string): SentNotice {
  const intent = `sasu:${run}:${kind}:${crypto.createHash("sha256").update(body).digest("hex").slice(0, 16)}`;
  const sent = call<Letter>(["request", "send", participants.observer, "--kind", kind === "plan" ? "request" : kind, "--intent", intent, "--body", body], "delivery");
  if (!record(sent) || !textField(sent.id) || sent.intent !== intent || !["pending", "delivered", "acknowledged", "cancelled", "expired", "undelivered"].includes(sent.state)
    || !(sent.hook_confirmed === undefined || sent.hook_confirmed === null || typeof sent.hook_confirmed === "boolean")) throw new HideCallFailed("hide returned an unusable letter; inspect the request and retry the same intent", "invalid_response");
  // Legacy Delivered records imply intake; legacy Acknowledged records cannot.
  const confirmed = sent.hook_confirmed === true || ((sent.hook_confirmed === undefined || sent.hook_confirmed === null) && sent.state === "delivered");
  return { requestId: sent.id, intent, delivery: confirmed ? "delivered" : "pending", letter: sent.id };
}
