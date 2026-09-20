import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getAgent, promptAgent, type AgentLookup, type HerdrEnvironment, type PromptOutcome } from "../implement/herdr";
import { decideRun, episodeKey, judgeObserver, type Candidate, type Decision } from "./decide";
import { readRun, type ReadRun } from "./facts";
import { MISSING_TICKS_BEFORE_CLEANUP, readIndex, updateIndex, type IndexEntry, type SupervisorIndex, type WakeRecord } from "./index";
import { renderWake, type WakeLine } from "./wake";

export interface TickHerdr {
  probe(hostScope?: string): { available: boolean; detail: string | null };
  getAgent(target: string, hostScope?: string): AgentLookup;
  promptAgent(input: { target: string; text: string; expectedInputGuard: string | null }, hostScope?: string): PromptOutcome;
}

function scopedEnvironment(environment: HerdrEnvironment, hostScope?: string): HerdrEnvironment {
  if (environment.run !== undefined || hostScope === undefined) return environment;
  const env = { ...(environment.env ?? process.env) };
  if (hostScope === "default") delete env["HERDR_SOCKET_PATH"];
  else env["HERDR_SOCKET_PATH"] = hostScope;
  return { ...environment, env };
}

export function herdrForTick(environment: HerdrEnvironment = {}): TickHerdr {
  return {
    probe: (hostScope) => {
      const listing = getAgent("__sasu_probe__", scopedEnvironment(environment, hostScope));
      return listing.kind === "unavailable" ? { available: false, detail: listing.detail } : { available: true, detail: null };
    },
    getAgent: (target, hostScope) => getAgent(target, scopedEnvironment(environment, hostScope)),
    promptAgent: (input, hostScope) => promptAgent(input, scopedEnvironment(environment, hostScope)),
  };
}

export interface TickOptions {
  indexFile: string;
  herdr: TickHerdr;
  now?: () => number;
  log?: (event: Record<string, unknown>) => void;
  /** Test barrier at the exact boundary where a stale tick would persist. */
  beforePersist?: () => void;
}

export interface RunTickResult {
  statePath: string;
  slug: string | null;
  decision: Decision | null;
  action: "sent" | "deferred" | "none" | "failed" | "removed" | "undelivered-terminal";
  detail: string;
}

export interface TickResult {
  at: string;
  herdr: { available: boolean; detail: string | null };
  runs: RunTickResult[];
  executor: "ran" | "already-running";
}

export const LOG_CAP_BYTES = 1024 * 1024;
export const LOG_EVENT_CAP_BYTES = 256 * 1024;
export const MAX_WAKE_RUNS_PER_PROMPT = 50;
export const MAX_WAKE_BYTES = 128 * 1024;
export const MAX_UNKNOWN_WAKE_ATTEMPTS = 2;
export const TERMINAL_FAILURE_TICKS_BEFORE_CLEANUP = 3;
export const TICK_EXECUTOR_LEASE_MS = 5 * 60_000;
export const MAX_HERDR_CALLS_PER_TICK = 128;
export const TICK_DEADLINE_MS = 25_000;

export function rotateLog(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && fs.statSync(file).size >= LOG_CAP_BYTES) {
    const rotated = `${file}.1`;
    fs.rmSync(rotated, { force: true });
    fs.renameSync(file, rotated);
  }
}

export function appendLog(file: string, event: Record<string, unknown>): void {
  rotateLog(file);
  const serialized = `${JSON.stringify(event)}\n`;
  const line = Buffer.byteLength(serialized) <= LOG_EVENT_CAP_BYTES
    ? serialized
    : `${JSON.stringify({ event: "supervisor.log.truncated", originalEvent: event["event"] ?? null, originalBytes: Buffer.byteLength(serialized), at: event["at"] ?? new Date().toISOString() })}\n`;
  fs.appendFileSync(file, line);
}

interface Loaded {
  entry: IndexEntry;
  run: ReadRun | null;
  problem: string | null;
  missing: boolean;
}

function loadEntry(entry: IndexEntry): Loaded {
  if (!fs.existsSync(entry.statePath)) return { entry, run: null, problem: `state.json missing (${entry.missingTicks + 1} consecutive tick(s))`, missing: true };
  try {
    const run = readRun(entry.statePath);
    if (run.supervision.runInstanceId !== entry.runInstanceId) return { entry, run: null, problem: `run instance ${run.supervision.runInstanceId} in state.json is not the indexed ${entry.runInstanceId}; a re-dispatch re-enrolls the path`, missing: false };
    return { entry, run, problem: null, missing: false };
  } catch (error) {
    return { entry, run: null, problem: error instanceof Error ? error.message : String(error), missing: false };
  }
}

const entryKey = (entry: Pick<IndexEntry, "statePath" | "enrollmentId">): string => `${entry.statePath}\0${entry.enrollmentId}`;

function sameObserver(a: ReadRun["supervision"]["observer"], b: ReadRun["supervision"]["observer"]): boolean {
  return a.sessionId === b.sessionId && a.terminalId === b.terminalId && a.paneId === b.paneId && a.hostScope === b.hostScope;
}

function executeTick(options: TickOptions): TickResult {
  const now = options.now ?? (() => Date.now());
  const tickNow = now();
  const at = new Date(tickNow).toISOString();
  const log = options.log ?? ((event) => appendLog(path.join(path.dirname(options.indexFile), "tick.log"), event));
  const index = readIndex(options.indexFile);
  let herdrCalls = 0;
  const checkedCall = <T>(call: () => T): T => {
    if (herdrCalls >= MAX_HERDR_CALLS_PER_TICK) throw new Error(`tick herdr call budget ${MAX_HERDR_CALLS_PER_TICK} exhausted; remaining runs are deferred to the next tick`);
    if (now() - tickNow >= TICK_DEADLINE_MS) throw new Error(`tick deadline ${TICK_DEADLINE_MS}ms exhausted; remaining runs are deferred to the next tick`);
    herdrCalls += 1;
    return call();
  };
  const scopes = [...new Set(index.entries.map((entry) => {
    try { return readRun(entry.statePath).supervision.observer.hostScope; } catch { return "default"; }
  }))];
  const probes = scopes.length === 0 ? [{ available: true, detail: null }] : scopes.map((scope) => checkedCall(() => options.herdr.probe(scope)));
  const herdr = probes.every((probe) => probe.available)
    ? { available: true, detail: null }
    : { available: false, detail: probes.filter((probe) => !probe.available).map((probe) => probe.detail ?? "no detail").join("; ") };
  const results: RunTickResult[] = [];
  const updates = new Map<string, (entry: IndexEntry) => void>();
  const removals: Array<{ statePath: string; enrollmentId: string; cause: string; outcome?: "undelivered-terminal" }> = [];

  const addUpdate = (entry: IndexEntry, mutate: (held: IndexEntry) => void): void => {
    const key = entryKey(entry);
    const previous = updates.get(key);
    updates.set(key, (held) => { previous?.(held); mutate(held); });
  };

  const lookups = new Map<string, AgentLookup>();
  const lookup = (target: string, hostScope: string): AgentLookup => {
    const key = `${hostScope}\0${target}`;
    const cached = lookups.get(key);
    if (cached !== undefined) return cached;
    const answer = checkedCall(() => options.herdr.getAgent(target, hostScope));
    lookups.set(key, answer);
    return answer;
  };

  interface Judged { loaded: Loaded; run: ReadRun; decision: Decision }
  const recordTerminalFailure = (item: Judged, detail: string, prior: number): boolean => {
    const count = prior + 1;
    addUpdate(item.loaded.entry, (held) => {
      held.terminalFailureTicks = Math.max(held.terminalFailureTicks, count);
      held.lastFailure = { at, detail: `${detail}; terminal delivery failed ${count}/${TERMINAL_FAILURE_TICKS_BEFORE_CLEANUP} consecutive tick(s)` };
    });
    if (count < TERMINAL_FAILURE_TICKS_BEFORE_CLEANUP) return false;
    removals.push({ statePath: item.loaded.entry.statePath, enrollmentId: item.loaded.entry.enrollmentId, cause: `undelivered-terminal after ${count} definite delivery failures: ${detail}`, outcome: "undelivered-terminal" });
    return true;
  };
  const judged: Judged[] = [];
  for (const entry of index.entries) {
    const loaded = loadEntry(entry);
    if (loaded.missing) {
      const count = entry.missingTicks + 1;
      if (count >= MISSING_TICKS_BEFORE_CLEANUP) {
        const cause = `state.json missing for ${count} consecutive ticks`;
        removals.push({ statePath: entry.statePath, enrollmentId: entry.enrollmentId, cause });
        results.push({ statePath: entry.statePath, slug: null, decision: null, action: "removed", detail: cause });
        log({ event: "supervisor.run.removed", statePath: entry.statePath, enrollmentId: entry.enrollmentId, cause, at });
      } else {
        addUpdate(entry, (held) => { held.missingTicks = count; held.lastFailure = { at, detail: loaded.problem! }; });
        results.push({ statePath: entry.statePath, slug: null, decision: null, action: "failed", detail: loaded.problem! });
      }
      continue;
    }
    if (loaded.run === null) {
      addUpdate(entry, (held) => { held.missingTicks = 0; held.lastFailure = { at, detail: loaded.problem! }; });
      results.push({ statePath: entry.statePath, slug: null, decision: null, action: "failed", detail: loaded.problem! });
      log({ event: "supervisor.run.failed", statePath: entry.statePath, enrollmentId: entry.enrollmentId, detail: loaded.problem, at });
      continue;
    }
    const run = loaded.run;
    let decision: Decision;
    try {
      const implementorScope = run.supervision.implementor.hostScope;
      decision = decideRun(run.facts, {
        implementor: lookup(run.supervision.implementor.paneId, implementorScope),
        observer: lookup(run.supervision.observer.paneId, run.supervision.observer.hostScope),
      }, entry, tickNow);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      addUpdate(entry, (held) => { held.missingTicks = 0; held.lastFailure = { at, detail }; });
      results.push({ statePath: entry.statePath, slug: run.facts.slug, decision: null, action: "failed", detail });
      log({ event: "supervisor.run.failed", statePath: entry.statePath, enrollmentId: entry.enrollmentId, slug: run.facts.slug, detail, at });
      continue;
    }
    judged.push({ loaded, run, decision });
  }

  const bundles = new Map<string, Judged[]>();
  for (const item of judged) {
    const { decision } = item;
    const observation = { at, observer: decision.observer.kind === "match" ? `match (${decision.observer.status})` : `${decision.observer.kind}: ${decision.observer.detail}`, implementor: decision.implementor.kind === "present" ? `present (${decision.implementor.status})` : `${decision.implementor.kind}: ${decision.implementor.detail}`, guardedPrompt: decision.observer.kind === "match" && decision.observer.inputGuard !== null };
    addUpdate(item.loaded.entry, (held) => {
      held.missingTicks = 0;
      if (!decision.terminal) held.terminalFailureTicks = 0;
      held.lastObservation = observation;
      if (decision.observer.kind !== "match") held.lastFailure = { at, detail: decision.observer.detail };
      else if (decision.implementor.kind === "unobservable") held.lastFailure = { at, detail: decision.implementor.detail };
      else if (held.pendingWake === null) held.lastFailure = null;
    });
    if (decision.due.length === 0) {
      results.push({ statePath: item.loaded.entry.statePath, slug: item.run.facts.slug, decision, action: decision.terminal ? "removed" : "none", detail: decision.terminal ? "terminal run already acknowledged; leaving the index" : "nothing due" });
      if (decision.terminal) removals.push({ statePath: item.loaded.entry.statePath, enrollmentId: item.loaded.entry.enrollmentId, cause: `run ${item.run.facts.status}; terminal wake already delivered` });
      continue;
    }
    if (decision.deferral !== null) {
      const removed = decision.terminal && decision.observer.kind === "observer-gone"
        ? recordTerminalFailure(item, decision.deferral, item.loaded.entry.terminalFailureTicks)
        : false;
      results.push({ statePath: item.loaded.entry.statePath, slug: item.run.facts.slug, decision, action: removed ? "undelivered-terminal" : "deferred", detail: decision.deferral });
      log({ event: "supervisor.wake.deferred", slug: item.run.facts.slug, enrollmentId: item.loaded.entry.enrollmentId, reasons: decision.due.map((entry) => entry.reason), detail: decision.deferral, at });
      continue;
    }
    const episode = episodeKey(decision.due);
    if (item.loaded.entry.pendingWake?.episode === episode && item.loaded.entry.pendingWake.attempts >= MAX_UNKNOWN_WAKE_ATTEMPTS) {
      const detail = `wake delivery remains unknown after ${MAX_UNKNOWN_WAKE_ATTEMPTS} attempts; no further automatic input is sent for episode ${episode}`;
      addUpdate(item.loaded.entry, (held) => { held.lastFailure = { at, detail }; });
      results.push({ statePath: item.loaded.entry.statePath, slug: item.run.facts.slug, decision, action: "failed", detail });
      continue;
    }
    const observer = item.run.supervision.observer;
    const key = `${observer.hostScope}\0${observer.sessionId}\0${observer.paneId}`;
    bundles.set(key, [...(bundles.get(key) ?? []), item]);
  }

  for (const items of bundles.values()) {
    const first = items[0]!;
    const currentItems: Array<{ item: Judged; run: ReadRun }> = [];
    const freshIndex = readIndex(options.indexFile);
    for (const item of items) {
      const currentEntry = freshIndex.entries.find((entry) => entry.statePath === item.loaded.entry.statePath && entry.enrollmentId === item.loaded.entry.enrollmentId);
      if (currentEntry === undefined) {
        results.push({ statePath: item.loaded.entry.statePath, slug: item.run.facts.slug, decision: item.decision, action: "deferred", detail: "enrollment changed before transmission; stale wake discarded" });
        continue;
      }
      try {
        const currentRun = readRun(item.loaded.entry.statePath);
        if (currentRun.supervision.runInstanceId !== currentEntry.runInstanceId || !sameObserver(currentRun.supervision.observer, item.run.supervision.observer)) {
          results.push({ statePath: item.loaded.entry.statePath, slug: item.run.facts.slug, decision: item.decision, action: "deferred", detail: "run or Observer identity changed before transmission; stale wake discarded" });
          continue;
        }
        currentItems.push({ item, run: currentRun });
      } catch (error) {
        results.push({ statePath: item.loaded.entry.statePath, slug: item.run.facts.slug, decision: item.decision, action: "failed", detail: `fresh pre-send read failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    if (currentItems.length === 0) continue;
    const currentObserver = currentItems[0]!.run.supervision.observer;
    const freshVerdict = judgeObserver(currentObserver, checkedCall(() => options.herdr.getAgent(currentObserver.paneId, currentObserver.hostScope)));
    if (freshVerdict.kind !== "match" || freshVerdict.status === "working" || freshVerdict.status === "blocked") {
      const detail = freshVerdict.kind !== "match" ? `${freshVerdict.kind}: ${freshVerdict.detail}` : `observer is ${freshVerdict.status}; delivery deferred`;
      for (const { item } of currentItems) {
        addUpdate(item.loaded.entry, (held) => {
          held.lastObservation = {
            at,
            observer: freshVerdict.kind === "match" ? `match (${freshVerdict.status})` : `${freshVerdict.kind}: ${freshVerdict.detail}`,
            implementor: held.lastObservation?.implementor ?? "unobserved",
            guardedPrompt: freshVerdict.kind === "match" && freshVerdict.inputGuard !== null,
          };
          if (freshVerdict.kind !== "match") held.lastFailure = { at, detail: freshVerdict.detail };
        });
        const removed = item.decision.terminal && freshVerdict.kind === "observer-gone"
          ? recordTerminalFailure(item, detail, item.loaded.entry.terminalFailureTicks)
          : false;
        results.push({ statePath: item.loaded.entry.statePath, slug: item.run.facts.slug, decision: item.decision, action: removed ? "undelivered-terminal" : "deferred", detail });
      }
      continue;
    }
    // Agent lookup can block. Recheck enrollment and state after it returns,
    // so a handover or re-dispatch during that wait cannot inherit this wake.
    const finalIndex = readIndex(options.indexFile);
    const sendItems = currentItems.filter(({ item, run }) => {
      const entry = finalIndex.entries.find((candidate) => candidate.statePath === item.loaded.entry.statePath && candidate.enrollmentId === item.loaded.entry.enrollmentId);
      if (entry === undefined) return false;
      try {
        const latest = readRun(item.loaded.entry.statePath);
        return latest.supervision.runInstanceId === entry.runInstanceId && sameObserver(latest.supervision.observer, run.supervision.observer);
      } catch { return false; }
    });
    for (const { item } of currentItems.filter((candidate) => !sendItems.includes(candidate))) {
      results.push({ statePath: item.loaded.entry.statePath, slug: item.run.facts.slug, decision: item.decision, action: "deferred", detail: "enrollment or Observer changed during the final identity lookup; stale wake discarded" });
    }
    if (sendItems.length === 0) continue;
    const cappedItems: typeof sendItems = [];
    let lines: WakeLine[] = [];
    for (const candidate of sendItems) {
      const line: WakeLine = { slug: candidate.run.facts.slug, statePath: candidate.item.loaded.entry.statePath, runInstanceId: candidate.run.supervision.runInstanceId, observerSessionId: candidate.run.supervision.observer.sessionId, reasons: candidate.item.decision.due };
      const nextLines = [...lines, line];
      const bytes = Buffer.byteLength(renderWake(currentObserver.sessionId, nextLines));
      if (nextLines.length > MAX_WAKE_RUNS_PER_PROMPT || bytes > MAX_WAKE_BYTES) {
        const detail = lines.length === 0
          ? `single wake payload is ${bytes} bytes, above the ${MAX_WAKE_BYTES} byte cap`
          : `Observer bundle reached its ${MAX_WAKE_RUNS_PER_PROMPT} run or ${MAX_WAKE_BYTES} byte cap; deferred to the next tick`;
        if (lines.length === 0) addUpdate(candidate.item.loaded.entry, (held) => { held.lastFailure = { at, detail }; });
        results.push({ statePath: candidate.item.loaded.entry.statePath, slug: candidate.run.facts.slug, decision: candidate.item.decision, action: lines.length === 0 ? "failed" : "deferred", detail });
        continue;
      }
      cappedItems.push(candidate);
      lines = nextLines;
    }
    if (cappedItems.length === 0) continue;
    const deliveryOperationId = crypto.randomUUID();
    let reservedKeys = new Set<string>();
    let priorPending = new Map<string, IndexEntry["pendingWake"]>();
    updateIndex(options.indexFile, (fresh) => {
      reservedKeys = new Set<string>();
      priorPending = new Map<string, IndexEntry["pendingWake"]>();
      for (const { item } of cappedItems) {
        const held = fresh.entries.find((entry) => entry.statePath === item.loaded.entry.statePath && entry.enrollmentId === item.loaded.entry.enrollmentId);
        if (held === undefined) continue;
        if (item.decision.due.every((candidate) => held.acknowledgements[candidate.reason] === candidate.episode)) continue;
        const episode = episodeKey(item.decision.due);
        const prior = held.pendingWake?.episode === episode ? held.pendingWake : null;
        if ((prior?.attempts ?? 0) >= MAX_UNKNOWN_WAKE_ATTEMPTS) continue;
        const key = entryKey(held);
        priorPending.set(key, prior === null ? null : { ...prior });
        held.pendingWake = { episode, attempts: (prior?.attempts ?? 0) + 1, at, operationId: deliveryOperationId, status: "reserved" };
        reservedKeys.add(key);
      }
    });
    const reservedItems = cappedItems.filter(({ item }) => reservedKeys.has(entryKey(item.loaded.entry)));
    for (const { item } of cappedItems.filter(({ item }) => !reservedKeys.has(entryKey(item.loaded.entry)))) {
      results.push({ statePath: item.loaded.entry.statePath, slug: item.run.facts.slug, decision: item.decision, action: "deferred", detail: "delivery episode was acknowledged, exhausted or reserved before submission; stale wake discarded" });
    }
    if (reservedItems.length === 0) continue;
    lines = reservedItems.map(({ item, run }) => ({ slug: run.facts.slug, statePath: item.loaded.entry.statePath, runInstanceId: run.supervision.runInstanceId, observerSessionId: run.supervision.observer.sessionId, reasons: item.decision.due }));
    const outcome = checkedCall(() => options.herdr.promptAgent({ target: currentObserver.paneId, text: renderWake(currentObserver.sessionId, lines), expectedInputGuard: freshVerdict.inputGuard }, currentObserver.hostScope));
    updateIndex(options.indexFile, (fresh) => {
      for (const { item } of reservedItems) {
        const held = fresh.entries.find((entry) => entry.statePath === item.loaded.entry.statePath && entry.enrollmentId === item.loaded.entry.enrollmentId);
        const episode = episodeKey(item.decision.due);
        if (held === undefined || held.pendingWake?.operationId !== deliveryOperationId || held.pendingWake.episode !== episode) continue;
        const record: WakeRecord = { at, reasons: item.decision.due.map((entry: Candidate) => entry.reason), episode, outcome: outcome.outcome, path: outcome.path, code: outcome.code };
        held.lastWake = record;
        if (outcome.outcome === "accepted") {
          for (const candidate of item.decision.due) held.acknowledgements[candidate.reason] = candidate.episode;
          held.lastAcknowledgedAt = at;
          held.pendingWake = null;
          held.lastFailure = null;
        } else if (outcome.outcome === "unknown") {
          held.pendingWake = { ...held.pendingWake, operationId: null, status: "unknown" };
          held.lastFailure = { at, detail: `wake delivery unknown (${outcome.code}), attempt ${held.pendingWake.attempts}/${MAX_UNKNOWN_WAKE_ATTEMPTS}: ${outcome.detail}` };
        } else {
          held.pendingWake = priorPending.get(entryKey(held)) ?? null;
          held.lastFailure = { at, detail: `wake rejected (${outcome.code}): ${outcome.detail}` };
        }
      }
    });
    for (const { item } of reservedItems) {
      const episode = episodeKey(item.decision.due);
      addUpdate(item.loaded.entry, (held) => {
        if (outcome.outcome === "accepted") held.lastFailure = null;
        else if (outcome.outcome === "unknown") held.lastFailure = { at, detail: `wake delivery unknown (${outcome.code}): ${outcome.detail}` };
        else held.lastFailure = { at, detail: `wake rejected (${outcome.code}): ${outcome.detail}` };
      });
      const removed = item.decision.terminal && outcome.outcome === "rejected"
        ? recordTerminalFailure(item, `wake ${outcome.outcome} (${outcome.code}): ${outcome.detail}`, item.loaded.entry.terminalFailureTicks)
        : false;
      results.push({ statePath: item.loaded.entry.statePath, slug: item.run.facts.slug, decision: item.decision, action: outcome.outcome === "accepted" ? "sent" : removed ? "undelivered-terminal" : "failed", detail: `${item.decision.due.map((candidate) => candidate.reason).join("+")}: ${outcome.outcome} via ${outcome.path} (${outcome.code})` });
      if (item.decision.terminal && outcome.outcome === "accepted") removals.push({ statePath: item.loaded.entry.statePath, enrollmentId: item.loaded.entry.enrollmentId, cause: `run ${item.run.facts.status}; terminal wake accepted` });
    }
    log({ event: "supervisor.wake.attempted", operationId: deliveryOperationId, observer: currentObserver.sessionId, pane: currentObserver.paneId, hostScope: currentObserver.hostScope, runs: lines.map((line) => ({ statePath: line.statePath, slug: line.slug, instance: line.runInstanceId, reasons: line.reasons.map((entry) => entry.reason) })), outcome: outcome.outcome, path: outcome.path, code: outcome.code, at });
  }

  options.beforePersist?.();
  updateIndex(options.indexFile, (fresh: SupervisorIndex) => {
    fresh.lastTickAt = at;
    fresh.lastHerdr = herdr;
    for (const entry of fresh.entries) updates.get(entryKey(entry))?.(entry);
    const gone = new Set(removals.map((removal) => `${removal.statePath}\0${removal.enrollmentId}`));
    const actuallyRemoved = fresh.entries.filter((entry) => gone.has(entryKey(entry))).map((entry) => entryKey(entry));
    fresh.entries = fresh.entries.filter((entry) => !gone.has(entryKey(entry)));
    for (const removal of removals) {
      if (actuallyRemoved.includes(`${removal.statePath}\0${removal.enrollmentId}`)) {
        const { enrollmentId: _enrollmentId, outcome, ...record } = removal;
        if (!fresh.removed.some((existing) => existing.at === at && existing.statePath === record.statePath && existing.cause === record.cause)) fresh.removed.push({ at, ...record });
        if (outcome === "undelivered-terminal" && !fresh.undeliveredTerminal.some((existing) => existing.enrollmentId === removal.enrollmentId)) {
          const original = index.entries.find((entry) => entry.enrollmentId === removal.enrollmentId)!;
          fresh.undeliveredTerminal.push({ at, statePath: removal.statePath, runInstanceId: original.runInstanceId, enrollmentId: removal.enrollmentId, failures: TERMINAL_FAILURE_TICKS_BEFORE_CLEANUP, detail: removal.cause });
        }
      }
    }
  });
  log({ event: "supervisor.tick", at, herdrAvailable: herdr.available, runs: results.length, sent: results.filter((entry) => entry.action === "sent").length, deferred: results.filter((entry) => entry.action === "deferred").length, failed: results.filter((entry) => entry.action === "failed").length, removed: removals.length });
  return { at, herdr, runs: results, executor: "ran" };
}

export function runTick(options: TickOptions): TickResult {
  const now = options.now ?? (() => Date.now());
  const started = now();
  const operationId = crypto.randomUUID();
  let acquired = false;
  updateIndex(options.indexFile, (index) => {
    const lease = index.tickExecutor;
    let ownerAlive = false;
    if (lease !== null) {
      try { process.kill(lease.pid, 0); ownerAlive = true; } catch (error) { ownerAlive = (error as NodeJS.ErrnoException).code === "EPERM"; }
    }
    if (lease !== null && ownerAlive && Date.parse(lease.expiresAt) > started) return;
    index.tickExecutor = { operationId, pid: process.pid, startedAt: new Date(started).toISOString(), expiresAt: new Date(started + TICK_EXECUTOR_LEASE_MS).toISOString() };
    acquired = true;
  });
  if (!acquired) {
    const at = new Date(started).toISOString();
    const previous = readIndex(options.indexFile).lastHerdr ?? { available: true, detail: null };
    return { at, herdr: previous, runs: [], executor: "already-running" };
  }
  try {
    return executeTick(options);
  } finally {
    updateIndex(options.indexFile, (index) => {
      if (index.tickExecutor?.operationId === operationId) index.tickExecutor = null;
    });
  }
}
