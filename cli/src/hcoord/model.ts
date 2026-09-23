export const SCHEMA = "hcoord.ledger.v1" as const;
export const API_VERSION = 1;
export const MAX_AGENTS = 2048;
export const MAX_REQUESTS = 10000;
export const MAX_EVENTS = 20000;
export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_LEDGER_BYTES = 64 * 1024 * 1024;
export const MAX_CONNECTIONS = 64;
export const MAX_SPAWN_INTENTS = 4096;
export const DEFAULTS = { watchMs: 5 * 60_000, remindMs: 15 * 60_000, escalateMs: 30 * 60_000, retentionMs: 30 * 24 * 60 * 60_000 };

export type RequestStatus = "open" | "answered" | "canceled";
export type DeliveryStatus = "pending" | "deferred" | "accepted" | "acknowledged" | "unknown" | "failed";
export interface Participant {
  id: string; machine: string; hostScope: string; session: string; instance: string; name: string; project: string | null;
  parent: string | null; pane: string | null; runtime: "working" | "idle" | "done" | "unknown";
  connection: "connected" | "unavailable" | "unverified"; observedAt: string;
}
export interface Watch {
  target: string; observer: string | null; generation: number; status: "active" | "stopped";
  intervalMs: number; dueAt: string; cycle: string | null; checkedAt: string | null;
  startedAt: string; stoppedAt: string | null; observation: string | null;
}
export interface Delivery {
  id: string; requestId: string; recipient: string; status: DeliveryStatus; reason: string | null;
  reservedAt: string; attemptedAt: string | null; acceptedAt: string | null; acknowledgedAt: string | null;
  runtimeCode: string | null;
}
export interface Request {
  id: string; intent: string; from: string; to: string; intermediary: string | null;
  body: string; context: string | null; status: RequestStatus; requiresReply: boolean; waiting: boolean;
  createdAt: string; answeredAt: string | null; answer: string | null; respondent: string | null;
  recordedBy: string | null; canceledAt: string | null; lateAnswers: Array<{ at: string; body: string; respondent: string; recordedBy: string }>;
  relayBody: string | null; relayAt: string | null; escalatedAt: string | null; remindedAt: string | null;
  relayRemindedAt?: string | null; relayEscalatedAt?: string | null;
  deliveries: Delivery[];
}
export interface Event { seq: number; at: string; type: string; subjectId: string; correlationId: string | null; detail: Record<string, string | number | boolean | null> }
export interface SpawnIntent { key: string; parent: string; machine: string; hostScope: string; session: string; name: string; kind: string; nativeArgs: string[]; noWatch: boolean; status: "reserved" | "unknown" | "complete"; pane: string | null; participant: string | null; reason: string | null; at: string }
export interface Ledger {
  schema: typeof SCHEMA; seq: number; updatedAt: string; config: typeof DEFAULTS;
  participants: Record<string, Participant>; watches: Record<string, Watch>; requests: Record<string, Request>;
  spawnIntents: Record<string, SpawnIntent>; sasuRuns: Record<string, { observer: string; implementor: string; project: string; registeredAt: string }>; events: Event[]; prunedBefore: string | null;
}
export function emptyLedger(now: string): Ledger {
  return { schema: SCHEMA, seq: 0, updatedAt: now, config: { ...DEFAULTS }, participants: {}, watches: {}, requests: {}, spawnIntents: {}, sasuRuns: {}, events: [], prunedBefore: null };
}
export class HcoordError extends Error {
  constructor(readonly code: string, message: string, readonly detail?: Record<string, unknown>) { super(message); this.name = "HcoordError"; }
}
export function id(prefix: string): string { return `${prefix}_${require("node:crypto").randomUUID()}`; }
export function event(state: Ledger, at: string, type: string, subjectId: string, correlationId: string | null = null, detail: Event["detail"] = {}): void {
  if (state.events.length >= MAX_EVENTS) throw new HcoordError("capacity", `event history reached ${MAX_EVENTS}; resolve retention or export before adding work`);
  state.seq += 1;
  state.events.push({ seq: state.seq, at, type, subjectId, correlationId, detail });
  state.updatedAt = at;
}
