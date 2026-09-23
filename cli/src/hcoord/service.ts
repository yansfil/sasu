import path from "node:path";
import { DEFAULTS, event, HcoordError, id, MAX_AGENTS, MAX_BODY_BYTES, MAX_REQUESTS, MAX_SPAWN_INTENTS, type Delivery, type Ledger, type Participant, type Request, type Watch } from "./model";

type Args = Record<string, unknown>;
export interface Outcome { value: unknown; changed: boolean }
const required = (args: Args, key: string): string => {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") throw new HcoordError("invalid_argument", `${key} is required`);
  return value;
};
const optional = (args: Args, key: string): string | null => {
  const value = args[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new HcoordError("invalid_argument", `${key} must be text`);
  return value;
};
const body = (args: Args, key = "body"): string => {
  const value = required(args, key);
  if (Buffer.byteLength(value) > MAX_BODY_BYTES) throw new HcoordError("capacity", `${key} exceeds ${MAX_BODY_BYTES} bytes`);
  return value;
};
const person = (state: Ledger, agentId: string): Participant => {
  const agent = state.participants[agentId];
  if (!agent) throw new HcoordError("not_found", `participant ${agentId} is not registered`);
  return agent;
};
const request = (state: Ledger, requestId: string): Request => {
  const found = state.requests[requestId];
  if (!found) throw new HcoordError("not_found", `request ${requestId} does not exist`);
  return found;
};
const authority = (actor: string, allowed: Array<string | null>): void => {
  if (actor !== "human" && !allowed.includes(actor)) throw new HcoordError("forbidden", "current observer, sender, or human authority is required");
};
const integerMs = (args: Args, key: string): number => {
  const value = args[key];
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 1000 || number > 365 * 24 * 60 * 60_000) throw new HcoordError("invalid_argument", `${key} must be 1 second to 365 days`);
  return number;
};
const timed = (at: string, ms: number): string => new Date(Date.parse(at) + ms).toISOString();
const pendingRelay = (item: Request): boolean => item.status === "answered" && item.intermediary !== null && item.relayBody === null;
const terminalRequest = (item: Request): boolean => item.status === "canceled" || (item.status === "answered" && !pendingRelay(item))
  || (!item.requiresReply && item.deliveries.length > 0 && item.deliveries.every((delivery) => delivery.status === "accepted" || delivery.status === "acknowledged"));
const queueDelivery = (item: Request, recipient: string, at: string): Delivery => {
  const delivery: Delivery = { id: id("d"), requestId: item.id, recipient, status: "pending", reason: null, reservedAt: at, attemptedAt: null, acceptedAt: null, acknowledgedAt: null, runtimeCode: null };
  item.deliveries.push(delivery);
  return delivery;
};

export function execute(state: Ledger, operation: string, args: Args, at: string): Outcome {
  if (operation === "status") return { changed: false, value: {
    schema: state.schema, at, lastUpdatedAt: state.updatedAt, eventCursor: state.seq, counts: {
      agents: Object.keys(state.participants).length, watches: Object.values(state.watches).filter((w) => w.status === "active").length,
      requests: Object.values(state.requests).filter((r) => !terminalRequest(r)).length, events: state.events.length, sasuRuns: Object.keys(state.sasuRuns).length,
    }, caps: { agents: MAX_AGENTS, requests: MAX_REQUESTS, spawnIntents: MAX_SPAWN_INTENTS, events: 20000, ledgerBytes: 64 * 1024 * 1024, connections: 64 }, config: state.config,
  } };
  if (operation === "config.set") {
    const key = required(args, "key") as keyof typeof DEFAULTS;
    if (!(key in DEFAULTS)) throw new HcoordError("invalid_argument", `unknown policy ${key}`);
    const value = integerMs(args, "value");
    state.config[key] = value;
    event(state, at, "config.changed", key, null, { value });
    return { changed: true, value: { ...state.config } };
  }
  if (operation === "agent.register") {
    const machine = required(args, "machine"), hostScope = required(args, "hostScope"), session = required(args, "session"), instance = required(args, "instance"), name = required(args, "name");
    const matches = Object.values(state.participants).filter((p) => p.machine === machine && p.hostScope === hostScope && p.session === session && p.instance === instance);
    if (matches.length) {
      const existing = matches[0]!;
      if (existing.name !== name || existing.pane !== optional(args, "pane") || existing.parent !== optional(args, "parent")) throw new HcoordError("identity_conflict", "runtime identity already has a different name, pane, or parent; inspect the exact binding before changing it", { candidates: matches });
      return { changed: false, value: existing };
    }
    const namesakes = Object.values(state.participants).filter((p) => p.machine === machine && p.hostScope === hostScope && p.session === session && p.name === name);
    if (namesakes.length) throw new HcoordError("identity_conflict", "name belongs to a different execution instance", { candidates: namesakes });
    if (Object.keys(state.participants).length >= MAX_AGENTS) throw new HcoordError("capacity", `participant limit ${MAX_AGENTS} reached`);
    const parent = optional(args, "parent");
    if (parent !== null) person(state, parent);
    const participant: Participant = { id: id("a"), machine, hostScope, session, instance, name, project: optional(args, "project") === null ? null : path.resolve(optional(args, "project")!), parent,
      pane: optional(args, "pane"), runtime: (args["runtime"] as Participant["runtime"]) ?? "unknown", connection: "connected", observedAt: at };
    state.participants[participant.id] = participant;
    event(state, at, "agent.registered", participant.id, null, { machine, session, instance, parent });
    return { changed: true, value: participant };
  }
  if (operation === "agent.spawn.reserve") {
    const key = required(args, "intent"), parent = person(state, required(args, "parent"));
    const machine = required(args, "machine"), session = required(args, "session"), name = required(args, "name"), kind = required(args, "kind");
    const nativeArgs = args["nativeArgs"];
    if (!Array.isArray(nativeArgs) || nativeArgs.some((value) => typeof value !== "string")) throw new HcoordError("invalid_argument", "nativeArgs must be a string array");
    if (parent.machine !== machine || parent.session !== session) throw new HcoordError("identity_conflict", "parent is not bound to the selected machine and session");
    const prior = state.spawnIntents[key];
    if (prior) {
      if (prior.parent !== parent.id || prior.machine !== machine || prior.session !== session || prior.name !== name || prior.kind !== kind || prior.noWatch !== (args["noWatch"] === true) || JSON.stringify(prior.nativeArgs) !== JSON.stringify(nativeArgs)) throw new HcoordError("intent_conflict", "spawn intent key already belongs to another operation", { participant: prior.participant, pane: prior.pane });
      return { changed: false, value: prior };
    }
    if (Object.keys(state.participants).length >= MAX_AGENTS) throw new HcoordError("capacity", `participant limit ${MAX_AGENTS} reached`);
    if (Object.keys(state.spawnIntents).length >= MAX_SPAWN_INTENTS) throw new HcoordError("capacity", `spawn intent limit ${MAX_SPAWN_INTENTS} reached; uncertain outcomes remain inspectable`);
    const record = { key, parent: parent.id, machine, hostScope: parent.hostScope, session, name, kind, nativeArgs, noWatch: args["noWatch"] === true, status: "reserved" as const, pane: null, participant: null, reason: null, at };
    state.spawnIntents[key] = record;
    event(state, at, "agent.spawn_reserved", parent.id, key);
    return { changed: true, value: record };
  }
  if (operation === "agent.spawn.pane") {
    const record = state.spawnIntents[required(args, "intent")];
    if (!record) throw new HcoordError("not_found", "spawn intent does not exist");
    const pane = required(args, "pane");
    if (record.pane !== null && record.pane !== pane) throw new HcoordError("conflict", "spawn intent already owns another pane");
    record.pane = pane;
    record.status = "unknown";
    event(state, at, "agent.spawn_pane", pane, record.key);
    return { changed: true, value: record };
  }
  if (operation === "agent.spawn.unknown") {
    const record = state.spawnIntents[required(args, "intent")];
    if (!record || record.status === "complete") throw new HcoordError("conflict", "spawn intent is not reservable");
    record.status = "unknown"; record.reason = required(args, "reason");
    event(state, at, "agent.spawn_uncertain", record.parent, record.key, { pane: record.pane });
    return { changed: true, value: record };
  }
  if (operation === "agent.spawn.complete") {
    const record = state.spawnIntents[required(args, "intent")];
    if (!record || record.pane === null) throw new HcoordError("not_found", "spawn pane is not recorded");
    if (record.status === "complete") return { changed: false, value: { intent: record, participant: state.participants[record.participant!] } };
    const runtimeSession = required(args, "runtimeSession"), instance = required(args, "instance");
    const matches = Object.values(state.participants).filter((p) => p.machine === record.machine && p.hostScope === record.hostScope && p.session === runtimeSession && p.instance === instance);
    if (matches.length) throw new HcoordError("identity_conflict", "spawned execution is already registered elsewhere", { candidates: matches });
    const runtime = required(args, "runtime") as Participant["runtime"];
    if (!["working", "idle", "done", "unknown"].includes(runtime)) throw new HcoordError("invalid_argument", "spawn runtime observation is invalid");
    const participant: Participant = { id: id("a"), machine: record.machine, hostScope: record.hostScope, session: runtimeSession, instance, name: record.name, project: optional(args, "project"), parent: record.parent, pane: record.pane, runtime, connection: "connected", observedAt: at };
    state.participants[participant.id] = participant;
    if (!record.noWatch) {
      const watch: Watch = { target: participant.id, observer: record.parent, generation: 1, status: "active", intervalMs: state.config.watchMs, dueAt: timed(at, state.config.watchMs), cycle: null, checkedAt: null, startedAt: at, stoppedAt: null, observation: null };
      state.watches[participant.id] = watch;
    }
    record.status = "complete"; record.participant = participant.id;
    event(state, at, "agent.spawn_complete", participant.id, record.key, { parent: record.parent, watch: !record.noWatch });
    return { changed: true, value: { intent: record, participant, watch: state.watches[participant.id] ?? null } };
  }
  if (operation === "agent.observe") {
    const participant = person(state, required(args, "id"));
    const runtime = required(args, "runtime");
    const connection = required(args, "connection");
    if (!["working", "idle", "done", "unknown"].includes(runtime) || !["connected", "unavailable", "unverified"].includes(connection)) throw new HcoordError("invalid_argument", "invalid runtime observation");
    participant.runtime = runtime as Participant["runtime"];
    participant.connection = connection as Participant["connection"];
    participant.observedAt = at;
    const watch = state.watches[participant.id];
    if (watch?.status === "active") watch.observation = `${runtime}/${connection} at ${at}`;
    return { changed: true, value: participant };
  }
  if (operation === "agent.list") {
    const project = optional(args, "project");
    return { changed: false, value: Object.values(state.participants).filter((p) => project === null || p.project === path.resolve(project)).map((p) => ({ ...p, watch: state.watches[p.id] ?? null, openRequests: Object.values(state.requests).filter((r) => r.status === "open" && (r.from === p.id || r.to === p.id)).length })) };
  }
  if (operation === "agent.show") {
    const participant = person(state, required(args, "id"));
    return { changed: false, value: { ...participant, watch: state.watches[participant.id] ?? null, requests: Object.values(state.requests).filter((r) => r.from === participant.id || r.to === participant.id).map((r) => ({ id: r.id, status: r.status })) } };
  }
  if (operation === "watch.start" || operation === "watch.assign") {
    const target = person(state, required(args, "target"));
    const observer = person(state, required(args, "observer"));
    if (target.id === observer.id) throw new HcoordError("invalid_argument", "a participant cannot watch itself");
    const previous = state.watches[target.id];
    const actor = required(args, "actor");
    if (previous?.status === "active") authority(actor, [previous.observer]);
    else if (operation === "watch.assign" && actor !== "human") throw new HcoordError("forbidden", "a missing observer can be assigned only by a human");
    const expected = optional(args, "expectedGeneration");
    if (operation === "watch.assign" && expected === null) throw new HcoordError("invalid_argument", "watch assignment requires the generation currently shown by watch list");
    if (expected !== null && Number(expected) !== (previous?.generation ?? 0)) throw new HcoordError("conflict", "watch generation changed; inspect current observer before retry", { current: previous });
    const intervalMs = args["intervalMs"] === undefined ? previous?.intervalMs ?? state.config.watchMs : integerMs(args, "intervalMs");
    const watch: Watch = { target: target.id, observer: observer.id, generation: (previous?.generation ?? 0) + 1, status: "active", intervalMs, dueAt: timed(at, intervalMs), cycle: null, checkedAt: null, startedAt: at, stoppedAt: null, observation: null };
    state.watches[target.id] = watch;
    event(state, at, previous ? "watch.assigned" : "watch.started", target.id, null, { observer: observer.id, generation: watch.generation });
    return { changed: true, value: watch };
  }
  if (operation === "watch.stop") {
    const target = required(args, "target"), actor = required(args, "actor");
    const watch = state.watches[target];
    if (!watch || watch.status === "stopped") throw new HcoordError("not_found", "active watch does not exist");
    authority(actor, [watch.observer]);
    watch.status = "stopped"; watch.stoppedAt = at;
    event(state, at, "watch.stopped", target, null, { generation: watch.generation });
    return { changed: true, value: watch };
  }
  if (operation === "watch.check") {
    const target = required(args, "target"), actor = required(args, "actor"), cycle = required(args, "cycle");
    const watch = state.watches[target];
    if (!watch || watch.status !== "active") throw new HcoordError("not_found", "active watch does not exist");
    authority(actor, [watch.observer]);
    if (watch.cycle !== cycle) throw new HcoordError("conflict", "cycle is not the current unchecked cycle", { currentCycle: watch.cycle });
    watch.checkedAt = at; watch.cycle = null; watch.dueAt = timed(at, watch.intervalMs);
    const checkRequest = Object.values(state.requests).find((item) => item.intent === `watch:${target}:${watch.generation}:${cycle}`);
    if (checkRequest?.status === "open") { checkRequest.status = "answered"; checkRequest.answeredAt = at; checkRequest.answer = "cycle checked"; checkRequest.respondent = actor; checkRequest.recordedBy = actor; }
    event(state, at, "watch.checked", target, cycle, { observer: watch.observer });
    return { changed: true, value: watch };
  }
  if (operation === "watch.list") return { changed: false, value: Object.values(state.watches) };
  if (operation === "request.send") {
    const from = required(args, "from"), to = required(args, "to"), intent = required(args, "intent");
    person(state, from);
    if (to !== "human") person(state, to);
    const content = body(args);
    const prior = Object.values(state.requests).find((r) => r.from === from && r.intent === intent);
    if (prior) {
      if (prior.to !== to || prior.body !== content) throw new HcoordError("intent_conflict", "intent key already belongs to a different request", { requestId: prior.id });
      return { changed: false, value: prior };
    }
    if (Object.keys(state.requests).length >= MAX_REQUESTS) throw new HcoordError("capacity", `request limit ${MAX_REQUESTS} reached; existing requests remain intact`);
    const item: Request = { id: id("r"), intent, from, to, intermediary: optional(args, "intermediary"), body: content, context: optional(args, "context"), status: "open",
      requiresReply: args["notifyOnly"] !== true, waiting: args["waiting"] === true, createdAt: at, answeredAt: null, answer: null, respondent: null, recordedBy: null,
      canceledAt: null, lateAnswers: [], relayBody: null, relayAt: null, escalatedAt: null, remindedAt: null, relayRemindedAt: null, relayEscalatedAt: null, deliveries: [] };
    if (item.intermediary !== null) person(state, item.intermediary);
    queueDelivery(item, to, at);
    state.requests[item.id] = item;
    event(state, at, "request.created", item.id, intent, { from, to, waiting: item.waiting, requiresReply: item.requiresReply });
    return { changed: true, value: item };
  }
  if (operation === "request.show") {
    const item = request(state, required(args, "id"));
    const uncertain = item.deliveries.filter((delivery) => delivery.status === "unknown");
    const deferred = item.deliveries.filter((delivery) => delivery.status === "deferred" || delivery.status === "failed");
    const nextAction = item.status === "canceled" ? "inspect late answers; cancellation does not undo accepted delivery"
      : pendingRelay(item) ? "intermediary must inspect the original answer and relay it; inspect blocked delivery first"
      : uncertain.length ? "inspect unknown submission before attempting another external effect"
      : deferred.length ? "inspect delivery reason and recipient identity"
      : item.status === "open" && item.requiresReply ? "assigned recipient may reply or sender may cancel/escalate"
      : "inspect delivery and acknowledgement separately from work result";
    return { changed: false, value: { ...item, nextAction } };
  }
  if (operation === "request.reply") {
    const item = request(state, required(args, "id")), answer = body(args), respondent = required(args, "respondent"), recordedBy = required(args, "recordedBy");
    if (respondent !== "human") person(state, respondent);
    if (recordedBy !== "human") person(state, recordedBy);
    if (respondent !== item.to && !(respondent === "human" && item.escalatedAt !== null)) throw new HcoordError("forbidden", "reply must name the assigned recipient or an escalated human");
    if (item.status === "answered") throw new HcoordError("conflict", "request already answered; original answer remains unchanged", { requestId: item.id });
    if (item.status === "canceled") {
      item.lateAnswers.push({ at, body: answer, respondent, recordedBy });
      event(state, at, "request.late_reply", item.id, item.intent, { respondent, recordedBy });
      return { changed: true, value: item };
    }
    item.status = "answered"; item.answeredAt = at; item.answer = answer; item.respondent = respondent; item.recordedBy = recordedBy;
    if (respondent === "human" && item.to !== "human" && item.intermediary === null) item.intermediary = item.to;
    for (const delivery of item.deliveries) if (delivery.recipient === "human" && (delivery.status === "pending" || delivery.status === "deferred")) { delivery.status = "failed"; delivery.reason = "request answered before notification"; }
    if (item.intermediary !== null) queueDelivery(item, item.intermediary, at);
    event(state, at, "request.answered", item.id, item.intent, { respondent, recordedBy });
    return { changed: true, value: item };
  }
  if (operation === "request.relay") {
    const item = request(state, required(args, "id")), actor = required(args, "actor"), relay = body(args);
    authority(actor, [item.intermediary]);
    if (item.status !== "answered") throw new HcoordError("conflict", "only an answered request may be relayed");
    if (item.intermediary === null) throw new HcoordError("conflict", "request has no intermediary to relay its answer");
    if (item.relayBody !== null) {
      if (item.relayBody !== relay) throw new HcoordError("conflict", "a different relay is already recorded");
      return { changed: false, value: item };
    }
    item.relayBody = relay; item.relayAt = at;
    queueDelivery(item, item.from, at);
    event(state, at, "request.relayed", item.id, item.intent, { by: actor });
    return { changed: true, value: item };
  }
  if (operation === "request.cancel") {
    const item = request(state, required(args, "id"));
    authority(required(args, "actor"), [item.from]);
    if (item.status === "canceled") return { changed: false, value: item };
    if (item.status === "answered") throw new HcoordError("conflict", "answered request cannot be canceled");
    item.status = "canceled"; item.canceledAt = at;
    for (const delivery of item.deliveries) if (delivery.status === "pending" || delivery.status === "deferred") { delivery.status = "failed"; delivery.reason = "request canceled before submission"; }
    event(state, at, "request.canceled", item.id, item.intent);
    return { changed: true, value: item };
  }
  if (operation === "request.escalate") {
    const item = request(state, required(args, "id"));
    authority(required(args, "actor"), [item.from, item.to, item.intermediary]);
    if (item.status !== "open") throw new HcoordError("conflict", "only an open request may be escalated");
    if (item.escalatedAt !== null) return { changed: false, value: item };
    item.escalatedAt = at;
    queueDelivery(item, "human", at);
    event(state, at, "request.escalated", item.id, item.intent);
    return { changed: true, value: item };
  }
  if (operation === "request.ack") {
    const item = request(state, required(args, "id"));
    const actor = required(args, "actor");
    const acknowledged = [...item.deliveries].reverse().find((delivery) => delivery.status === "acknowledged" && delivery.recipient === actor);
    if (acknowledged) return { changed: false, value: item };
    const delivery = [...item.deliveries].reverse().find((d) => d.status === "accepted" && d.recipient === actor);
    if (!delivery) throw new HcoordError("conflict", "there is no accepted delivery to acknowledge");
    delivery.status = "acknowledged"; delivery.acknowledgedAt = at;
    event(state, at, "delivery.acknowledged", item.id, item.intent, { deliveryId: delivery.id });
    return { changed: true, value: item };
  }
  if (operation === "inbox") {
    const items: Array<Record<string, unknown>> = [];
    for (const item of Object.values(state.requests)) {
      if ((item.status === "open" && (item.to === "human" || item.escalatedAt !== null)) || pendingRelay(item)) items.push({ kind: pendingRelay(item) ? "relay_problem" : "question", requestId: item.id, createdAt: item.createdAt, from: item.from, to: item.to, status: item.status, nextAction: pendingRelay(item) ? "inspect parent delivery and relay the recorded answer" : "reply or cancel this request" });
      if (item.status !== "canceled" && !pendingRelay(item) && item.deliveries.some((delivery) => delivery.status === "unknown" || delivery.status === "failed" || delivery.status === "deferred")) items.push({ kind: "delivery_problem", requestId: item.id, createdAt: item.createdAt, nextAction: "inspect delivery history and recipient identity" });
    }
    for (const watch of Object.values(state.watches)) if (watch.status === "active" && (watch.observer === null || state.participants[watch.observer]?.connection === "unavailable")) items.push({ kind: "watch_unassigned", target: watch.target, observer: watch.observer, nextAction: "inspect current observer and assign explicitly" });
    return { changed: false, value: items };
  }
  if (operation === "graph") return { changed: false, value: { participants: Object.values(state.participants), creation: Object.values(state.participants).filter((p) => p.parent).map((p) => ({ parent: p.parent, child: p.id })), watch: Object.values(state.watches), prunedBefore: state.prunedBefore } };
  if (operation === "events") {
    const cursor = args["cursor"] === undefined ? 0 : Number(args["cursor"]);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new HcoordError("invalid_argument", "cursor must be a nonnegative integer");
    if ((state.events.length && cursor < state.events[0]!.seq - 1) || (!state.events.length && state.prunedBefore !== null && cursor < state.seq)) throw new HcoordError("cursor_expired", "event cursor expired; reread status and graph");
    const entries = state.events.filter((e) => e.seq > cursor).slice(0, 256);
    const nextCursor = entries.at(-1)?.seq ?? state.seq;
    return { changed: false, value: { events: entries, cursor: nextCursor, hasMore: nextCursor < state.seq, observedAt: at } };
  }
  if (operation === "tick") {
    let cycles = 0, reminders = 0, escalations = 0;
    let changed = false;
    const before = Date.parse(at) - state.config.retentionMs;
    for (const [key, item] of Object.entries(state.requests)) {
      if (terminalRequest(item) && Date.parse(item.answeredAt ?? item.canceledAt ?? item.createdAt) < before) { delete state.requests[key]; state.prunedBefore = at; changed = true; }
    }
    for (const [key, watch] of Object.entries(state.watches)) if (watch.status === "stopped" && watch.stoppedAt !== null && Date.parse(watch.stoppedAt) < before && !Object.values(state.requests).some((r) => r.from === key || r.to === key)) { delete state.watches[key]; state.prunedBefore = at; changed = true; }
    const retained = state.events.filter((entry) => Date.parse(entry.at) >= before);
    if (retained.length !== state.events.length) { state.events = retained; state.prunedBefore = at; changed = true; }
    for (const watch of Object.values(state.watches)) {
      if (watch.status !== "active" || Date.parse(watch.dueAt) > Date.parse(at)) continue;
      changed = true;
      if (watch.cycle === null) {
        watch.cycle = id("c"); cycles += 1;
        if (watch.observer !== null) {
          const item: Request = { id: id("r"), intent: `watch:${watch.target}:${watch.generation}:${watch.cycle}`, from: watch.target, to: watch.observer, intermediary: null, body: `Check participant ${watch.target} for cycle ${watch.cycle}`, context: watch.observation, status: "open", requiresReply: true, waiting: false, createdAt: at, answeredAt: null, answer: null, respondent: null, recordedBy: null, canceledAt: null, lateAnswers: [], relayBody: null, relayAt: null, escalatedAt: null, remindedAt: null, deliveries: [] };
          if (Object.keys(state.requests).length >= MAX_REQUESTS) throw new HcoordError("capacity", `request limit ${MAX_REQUESTS} reached; watch cycle was not saved`);
          queueDelivery(item, watch.observer, at);
          state.requests[item.id] = item;
          event(state, at, "watch.cycle", watch.target, watch.cycle, { requestId: item.id });
        }
      } else {
        const checkRequest = Object.values(state.requests).find((item) => item.intent === `watch:${watch.target}:${watch.generation}:${watch.cycle}`);
        if (checkRequest?.status === "open") checkRequest.context = watch.observation;
      }
      watch.dueAt = timed(at, watch.intervalMs);
    }
    for (const item of Object.values(state.requests)) {
      if (pendingRelay(item) && item.answeredAt !== null) {
        const age = Date.parse(at) - Date.parse(item.answeredAt);
        if (age >= state.config.escalateMs && !item.relayEscalatedAt) {
          if (!item.relayRemindedAt) { item.relayRemindedAt = at; event(state, at, "request.relay_reminder_coalesced", item.id, item.intent); }
          item.relayEscalatedAt = at; escalations += 1; changed = true;
          queueDelivery(item, "human", at);
          event(state, at, "request.relay_escalated", item.id, item.intent);
        } else if (age >= state.config.remindMs && !item.relayRemindedAt) {
          item.relayRemindedAt = at; reminders += 1; changed = true;
          if (item.intermediary !== null && !item.deliveries.some((delivery) => delivery.recipient === item.intermediary && (delivery.status === "pending" || delivery.status === "deferred" || delivery.status === "unknown"))) queueDelivery(item, item.intermediary, at);
          event(state, at, "request.relay_reminded", item.id, item.intent);
        }
      }
      if (item.status !== "open" || !item.requiresReply) continue;
      const age = Date.parse(at) - Date.parse(item.createdAt);
      if (age >= state.config.escalateMs && item.escalatedAt === null) {
        if (item.remindedAt === null) { item.remindedAt = at; event(state, at, "request.reminder_coalesced", item.id, item.intent); }
        item.escalatedAt = at; escalations += 1; changed = true; queueDelivery(item, "human", at); event(state, at, "request.escalated", item.id, item.intent);
      } else if (age >= state.config.remindMs && item.remindedAt === null) { item.remindedAt = at; reminders += 1; changed = true; if (!item.deliveries.some((d) => d.status === "pending" || d.status === "deferred" || d.status === "unknown")) queueDelivery(item, item.to, at); event(state, at, "request.reminded", item.id, item.intent); }
    }
    return { changed, value: { cycles, reminders, escalations, at } };
  }
  throw new HcoordError("unknown_operation", `unsupported operation ${operation}`);
}
