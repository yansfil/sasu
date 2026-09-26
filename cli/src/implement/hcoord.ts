import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { ObserverIdentity, SupervisionRecord } from "./types";

/**
 * Sasu's side of hcoord supervision. hcoord knows participants and the
 * relations between them (parent, watch, request) and nothing about Sasu
 * (D-19), so Sasu calls only its generic commands, through this build's
 * hcoord CLI, and records which participants make up a run in state.json.
 * The coordinator stays the only writer of its ledger and Sasu the only
 * writer of state.json (PRD D-02); Sasu never reads the ledger file.
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

function refused(argv: string[], wire: Wire): HcoordCallFailed {
  return new HcoordCallFailed(`hcoord ${argv.slice(0, 2).join(" ")} refused: ${wire.error?.code ?? "error"}: ${wire.error?.message ?? "no message"}`, wire.error?.code ?? null);
}

/**
 * A write whose result Sasu needs now. A letter the coordinator has not
 * applied yet carries no result; it stays in the outbox and is applied later,
 * and the caller's retry then finds what it created.
 */
function applied<T>(argv: string[]): T {
  const wire = call(argv);
  if (!wire.ok) throw refused(argv, wire);
  if (wire.delivery === "pending") {
    const pending = wire.value as { letter?: string; reason?: string };
    throw new HcoordCallFailed(`hcoord ${argv.slice(0, 2).join(" ")} is waiting as letter ${pending.letter ?? "unknown"}: ${pending.reason ?? "the coordinator has not applied it"}`, "pending");
  }
  return wire.value as T;
}

/** A read that tolerates a stopped daemon: the saved ledger answers, marked stale. */
function read<T>(argv: string[]): { value: T; stale: boolean } {
  const wire = call(argv);
  if (!wire.ok) throw refused(argv, wire);
  const got = wire.value as { data?: unknown; stale?: boolean } | unknown;
  if (got !== null && typeof got === "object" && (got as { stale?: boolean }).stale === true) return { value: (got as { data: T }).data, stale: true };
  return { value: got as T, stale: false };
}

export interface WatchView { target: string; observer: string | null; generation: number; status: "active" | "stopped"; intervalMs: number; dueAt: string; cycle: string | null; checkedAt: string | null; brief?: string | null; quietSince?: string | null }
export interface ParticipantView { id: string; name: string; pane: string | null; session: string; parent: string | null; runtime: string; connection: string; registered?: boolean; watch: WatchView | null }

export function showParticipant(id: string): { value: ParticipantView; stale: boolean } { return read<ParticipantView>(["agent", "show", id]); }

/** Registered participants from `hcoord agent list`; Herdr discoveries are left out. */
export function listParticipants(): { value: ParticipantView[]; stale: boolean } {
  const listed = read<{ items: ParticipantView[] }>(["agent", "list"]);
  return { value: listed.value.items.filter((item) => item.registered === true), stale: listed.stale };
}

/**
 * The name hcoord records for an Observer: Herdr's agent name when the pane
 * has one. Hand-started Observers have none (7 of 7 live, 2026-09-26), and
 * since D-18 hcoord never matches names, so an unnamed one is recorded as
 * observer-<session prefix>. That stays the same across every run the
 * Observer dispatches and every Herdr restart, and differs per session; a
 * run slug would rename the one shared participant at each dispatch.
 */
export function observerParticipantName(herdrName: string | null | undefined, sessionId: string): string {
  const name = herdrName?.trim() ?? "";
  return name !== "" ? name : `observer-${sessionId.slice(0, 8)}`;
}

/** One execution as hcoord registers it. */
export interface Execution { name: string; paneId: string; sessionId: string; terminalId: string; hostScope: string }
export interface ObserverRegistration { identity: ObserverIdentity; name: string }

const executionArgs = (execution: Execution): string[] => ["--machine", "local", "--host-scope", execution.hostScope, "--session", execution.sessionId, "--instance", execution.terminalId, "--name", execution.name, "--pane", execution.paneId];
export const observerExecution = (observer: ObserverRegistration): Execution => ({ name: observer.name, paneId: observer.identity.paneId, sessionId: observer.identity.sessionId, terminalId: observer.identity.terminalId, hostScope: observer.identity.hostScope });

/**
 * `agent register --check` for the Observer before any pane exists (PRD B3):
 * the daemon answers, the Observer's execution is the one in its pane, and it
 * takes official delivery. Nothing is saved.
 */
export function checkObserver(observer: ObserverRegistration): void {
  applied(["agent", "register", "--check", ...executionArgs(observerExecution(observer))]);
}

/**
 * The patrol note hcoord carries verbatim on every watch check (D-21): read
 * the digest, and close the run once it is delivered; otherwise close the
 * cycle with the command hcoord puts above it. It also shows the recovery
 * owner in hcoord's own watch record (PRD B16).
 */
export function patrolBrief(slug: string, recoveryOwner: "supervisor" | "task-factory"): string {
  return [
    `sasu implement status --slug ${slug} --digest (recovery owner ${recoveryOwner})`,
    `  -> verify PASS and PR merged: sasu implement retire --slug ${slug}`,
    "  -> otherwise: close this cycle",
  ].join("\n");
}

export interface RunSupervision { slug: string; project: string; patrolIntervalMs: number; recoveryOwner: "supervisor" | "task-factory"; replacedImplementor: string | null }

/**
 * Registers a dispatched run with generic commands (D-19): the Observer, the
 * implementor as its child, and the implementor's watch. Every step converges
 * on a retry: registration returns the recorded participant for the same
 * execution, and an active watch by the same Observer is kept. A replacement
 * ends the gone implementor, so it is never watched again (PRD B14).
 */
export function registerRun(run: RunSupervision, observer: ObserverRegistration, implementor: Execution): NonNullable<SupervisionRecord["hcoord"]> {
  const observerId = applied<{ id: string }>(["agent", "register", ...executionArgs(observerExecution(observer))]).id;
  const implementorId = applied<{ id: string }>(["agent", "register", ...executionArgs(implementor), "--parent", observerId, "--project", run.project]).id;
  const current = showParticipant(implementorId).value.watch;
  if (current?.status === "active" && current.observer !== observerId) throw new HcoordCallFailed(`hcoord already watches implementor ${implementorId} for observer ${current.observer}; nothing was changed`, "conflict");
  const watch = current?.status === "active" ? current
    : applied<WatchView>(["watch", "start", implementorId, "--observer", observerId, "--actor", current === null ? observerId : "human", "--interval", `${Math.round(run.patrolIntervalMs / 1000)}s`, "--brief", patrolBrief(run.slug, run.recoveryOwner)]);
  if (run.replacedImplementor !== null && run.replacedImplementor !== implementorId) endParticipant(run.replacedImplementor, observerId);
  return { observer: observerId, implementor: implementorId, intervalMs: watch.intervalMs, recoveryOwner: run.recoveryOwner, registeredAt: new Date().toISOString() };
}

/**
 * Moves the implementor's watch to a new Observer (PRD B15): the new
 * Observer is checked and registered, then `watch assign` moves the watch
 * with its open cycle, the questions the implementor asked the old Observer,
 * and answers the old Observer has not relayed. A repeat finds it moved.
 */
export function handoverRun(implementorId: string, observer: ObserverRegistration, run: { slug: string; patrolIntervalMs: number; recoveryOwner: "supervisor" | "task-factory" }): { observer: string; watch: WatchView } {
  checkObserver(observer);
  const observerId = applied<{ id: string }>(["agent", "register", ...executionArgs(observerExecution(observer))]).id;
  const current = showParticipant(implementorId).value.watch;
  if (current !== null && current.status === "active" && current.observer === observerId) return { observer: observerId, watch: current };
  const watch = current === null
    ? applied<WatchView>(["watch", "start", implementorId, "--observer", observerId, "--actor", "human", "--interval", `${Math.round(run.patrolIntervalMs / 1000)}s`, "--brief", patrolBrief(run.slug, run.recoveryOwner)])
    : applied<WatchView>(["watch", "assign", implementorId, "--observer", observerId, "--actor", "human", "--expected-generation", String(current.generation)]);
  return { observer: observerId, watch };
}

/**
 * `agent end` for the implementor (D-20): its watch stops and its open
 * questions are canceled. A stopped daemon keeps the letter and applies it on
 * its next start; ending again changes nothing, so a rerun is the retry.
 */
export function endParticipant(implementorId: string, actor: string): { delivery: "delivered" | "pending" } {
  const argv = ["agent", "end", implementorId, "--actor", actor];
  const wire = call(argv);
  if (!wire.ok) throw refused(argv, wire);
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
export function sendRunNotice(run: string, participants: { observer: string; implementor: string }, kind: RunNoticeKind, body: string): SentNotice {
  const intent = `sasu:${run}:${kind}:${crypto.createHash("sha256").update(body).digest("hex").slice(0, 16)}`;
  const argv = ["request", "send", "--from", participants.implementor, "--to", participants.observer, "--intent", intent, "--body", body, ...(kind === "block" ? ["--waiting"] : ["--notify-only"])];
  const wire = call(argv);
  if (!wire.ok) throw new HcoordCallFailed(`hcoord refused the ${kind} notice: ${wire.error?.code ?? "error"}: ${wire.error?.message ?? "no message"}`, wire.error?.code ?? null);
  const sent = wire.value as { id?: string; letter?: string };
  return wire.delivery === "pending"
    ? { requestId: null, intent, delivery: "pending", letter: sent.letter ?? null }
    : { requestId: sent.id ?? null, intent, delivery: "delivered", letter: null };
}
