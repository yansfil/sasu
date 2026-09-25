import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { ObserverIdentity, SupervisionRecord } from "./types";

/**
 * Sasu's side of hcoord supervision. Sasu reaches the coordinator only by
 * running this build's hcoord CLI, so the coordinator stays the only writer
 * of its ledger and Sasu the only writer of state.json (PRD D-02). Every
 * participant ID is read from the coordinator's run binding at the moment it
 * is needed rather than trusted from state.json, because a handover changes
 * the binding and state.json only mirrors it for display.
 */

export class HcoordCallFailed extends Error {
  constructor(message: string, readonly code: string | null) { super(message); this.name = "HcoordCallFailed"; }
}

interface Wire { ok: boolean; value?: unknown; error?: { code?: string; message?: string }; delivery?: "delivered" | "pending" }

/** The hcoord CLI of this build, beside this module's own dist directory. */
export const HCOORD_CLI = path.resolve(__dirname, "..", "hcoord", "cli.js");

function call(argv: string[]): Wire {
  const run = spawnSync(process.execPath, [HCOORD_CLI, ...argv, "--json"], { encoding: "utf8", timeout: 30_000 });
  let parsed: Wire | null = null;
  try { parsed = JSON.parse(run.stdout) as Wire; } catch { parsed = null; }
  if (parsed === null) throw new HcoordCallFailed(`hcoord ${argv.slice(0, 2).join(" ")} did not answer with JSON (exit ${run.status ?? "none"}): ${(run.stderr || run.stdout).trim().slice(0, 300)}`, null);
  return parsed;
}

function value<T>(argv: string[]): T {
  const wire = call(argv);
  if (!wire.ok) throw new HcoordCallFailed(`hcoord ${argv.slice(0, 2).join(" ")} refused: ${wire.error?.code ?? "error"}: ${wire.error?.message ?? "no message"}`, wire.error?.code ?? null);
  return wire.value as T;
}

export interface SasuRunView {
  run: string; slug: string | null; statePath: string | null; project: string; recoveryOwner: "supervisor" | "task-factory" | null;
  registeredAt: string; replaces: string | null; endedAt: string | null; endReason: string | null;
  observer: { id: string; name: string; pane: string | null } | null;
  implementor: { id: string; name: string; pane: string | null } | null;
  watch: { observer: string | null; generation: number; status: string; intervalMs: number; dueAt: string; openCycle: string | null; lastCheckedAt: string | null } | null;
}

/** A read that tolerates a stopped daemon: the saved ledger answers, marked stale. */
function read<T>(argv: string[]): { value: T; stale: boolean } {
  const got = value<unknown>(argv) as { data?: unknown; stale?: boolean } | unknown;
  if (got !== null && typeof got === "object" && (got as { stale?: boolean }).stale === true) return { value: (got as { data: T }).data, stale: true };
  return { value: got as T, stale: false };
}

export function showRun(run: string): { value: SasuRunView; stale: boolean } { return read<SasuRunView>(["sasu", "show", "--run", run]); }
export function listRuns(): { value: SasuRunView[]; stale: boolean } { return read<SasuRunView[]>(["sasu", "list"]); }

export interface ObserverRegistration { identity: ObserverIdentity; name: string }
export interface RunRegistration { run: string; project: string; slug: string; statePath: string; patrolIntervalMs: number; recoveryOwner: "supervisor" | "task-factory"; replaces: string | null }

const observerArgs = (observer: ObserverRegistration): string[] => ["--observer-name", observer.name, "--observer-pane", observer.identity.paneId, "--observer-session", observer.identity.sessionId, "--observer-instance", observer.identity.terminalId, "--observer-host-scope", observer.identity.hostScope];
const runArgs = (run: RunRegistration): string[] => ["--run", run.run, "--project", run.project, "--slug", run.slug, "--state", run.statePath, "--interval", `${Math.round(run.patrolIntervalMs / 1000)}s`, "--recovery-owner", run.recoveryOwner, ...(run.replaces === null ? [] : ["--replaces", run.replaces])];

/**
 * Everything registration checks before an implementor exists (PRD B3): the
 * daemon answers, the Observer's exact named execution takes official
 * delivery, and registering it would not conflict. A refusal here happens
 * before any pane is created.
 */
export function preflightRun(run: RunRegistration, observer: ObserverRegistration): void {
  value(["sasu", "preflight", ...runArgs(run), ...observerArgs(observer)]);
}

export function registerRun(run: RunRegistration, observer: ObserverRegistration, implementor: { paneId: string; name: string; sessionId: string; terminalId: string; hostScope: string }): NonNullable<SupervisionRecord["hcoord"]> {
  const registered = value<{ observer: { id: string }; implementor: { id: string }; watch: { intervalMs: number } }>(["sasu", "register", ...runArgs(run), ...observerArgs(observer),
    "--implementor-name", implementor.name, "--implementor-pane", implementor.paneId, "--implementor-session", implementor.sessionId, "--implementor-instance", implementor.terminalId, "--implementor-host-scope", implementor.hostScope]);
  return { run: run.run, observer: registered.observer.id, implementor: registered.implementor.id, intervalMs: registered.watch.intervalMs, recoveryOwner: run.recoveryOwner, registeredAt: new Date().toISOString() };
}

export function handoverRun(run: string, observer: ObserverRegistration): SasuRunView {
  return value<SasuRunView>(["sasu", "handover", "--run", run, ...observerArgs(observer)]);
}

/** Ends the run's watch. A stopped daemon keeps the letter and applies it on its next start. */
export function endRun(run: string, reason: string): { delivery: "delivered" | "pending" } {
  const wire = call(["sasu", "end", "--run", run, "--reason", reason]);
  if (!wire.ok) throw new HcoordCallFailed(`hcoord sasu end refused: ${wire.error?.code ?? "error"}: ${wire.error?.message ?? "no message"}`, wire.error?.code ?? null);
  return { delivery: wire.delivery ?? "delivered" };
}

export type RunNoticeKind = "plan" | "block" | "report";

export interface SentNotice { requestId: string | null; intent: string; delivery: "delivered" | "pending"; letter: string | null }

/**
 * One Sasu event sent to the run's Observer (PRD B12). The intent is fixed by
 * the run, the event kind and the exact body, so running the command again
 * for the same event finds the same request instead of sending a second one.
 * plan and report ask for nothing; block waits for an answer.
 */
export function sendRunNotice(run: string, kind: RunNoticeKind, body: string): SentNotice {
  const shown = showRun(run).value;
  if (shown.endedAt !== null) throw new HcoordCallFailed(`hcoord supervision of run ${run} ended at ${shown.endedAt} (${shown.endReason ?? "no reason"}); nothing was sent`, "ended");
  if (shown.observer === null || shown.implementor === null) throw new HcoordCallFailed(`hcoord run ${run} has no registered Observer or implementor; nothing was sent`, "not_found");
  const intent = `sasu:${run}:${kind}:${crypto.createHash("sha256").update(body).digest("hex").slice(0, 16)}`;
  const wire = call(["request", "send", "--from", shown.implementor.id, "--to", shown.observer.id, "--intent", intent, "--body", body, ...(kind === "block" ? ["--waiting"] : ["--notify-only"])]);
  if (!wire.ok) throw new HcoordCallFailed(`hcoord refused the ${kind} notice: ${wire.error?.code ?? "error"}: ${wire.error?.message ?? "no message"}`, wire.error?.code ?? null);
  const sent = wire.value as { id?: string; letter?: string };
  return wire.delivery === "pending"
    ? { requestId: null, intent, delivery: "pending", letter: sent.letter ?? null }
    : { requestId: sent.id ?? null, intent, delivery: "delivered", letter: null };
}
