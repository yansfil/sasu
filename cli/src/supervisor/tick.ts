import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getAgent, promptAgent, type AgentLookup, type HerdrEnvironment, type PromptOutcome } from "../implement/herdr";
import { decideRun, episodeKey, judgeObserver, type Candidate, type Decision } from "./decide";
import { readRun, type ReadRun } from "./facts";
import { MISSING_TICKS_BEFORE_CLEANUP, readIndex, reconcileEnrollmentAuthority, recipientAuthorityKey, updateIndex, type EnrollmentAuthority, type IndexEntry, type SupervisorIndex, type WakeRecord } from "./index";
import { renderWake, type WakeLine } from "./wake";

export interface TickHerdr {
  probe(hostScope?: string, timeoutMs?: number): { available: boolean; detail: string | null };
  getAgent(target: string, hostScope?: string, timeoutMs?: number): AgentLookup;
  promptAgent(input: { target: string; text: string; expectedInputGuard: string | null }, hostScope?: string, timeoutMs?: number): PromptOutcome;
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
    probe: (hostScope, timeoutMs) => {
      const listing = getAgent("__sasu_probe__", scopedEnvironment(environment, hostScope), timeoutMs);
      return listing.kind === "unavailable" ? { available: false, detail: listing.detail } : { available: true, detail: null };
    },
    getAgent: (target, hostScope, timeoutMs) => getAgent(target, scopedEnvironment(environment, hostScope), timeoutMs),
    promptAgent: (input, hostScope, timeoutMs) => promptAgent(input, scopedEnvironment(environment, hostScope), timeoutMs),
  };
}

export interface TickOptions {
  indexFile: string;
  herdr: TickHerdr;
  now?: () => number;
  /** Monotonic elapsed clock; tests inject it with their external-call delays. */
  monotonicNow?: () => number;
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
export const MAX_HERDR_CALLS_PER_TICK = 128;
export const MAX_RUNS_PER_TICK = 20;
export const TICK_DEADLINE_MS = 25_000;
export const TICK_DECISION_BUDGET_MS = 10_000;
export const TICK_COMPLETION_RESERVE_MS = 1_000;

class TickLimitReached extends Error {}

function processStartDescription(pid: number): string | null {
  for (const binary of ["/bin/ps", "/usr/bin/ps"]) {
    const observed = spawnSync(binary, ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
      // Scheduled and manual ticks can inherit different locale and timezone
      // settings. The round-two review observed one live PID change identity
      // across those callers, so process identity must be canonical here.
      env: { ...process.env, LANG: "C", LC_ALL: "C", TZ: "UTC" },
    });
    const started = observed.status === 0 ? observed.stdout.trim().replace(/\s+/g, " ") : "";
    if (started !== "") return started;
  }
  return null;
}

function legacyProcessStartEpochMs(pid: number): number {
  const description = processStartDescription(pid);
  if (description === null) return Number.NaN;
  // processStartDescription deliberately asks ps for UTC text. Date.parse
  // otherwise interprets that timezone-less legacy format in the caller's
  // timezone and can both steal live leases and preserve reused PIDs.
  return Date.parse(`${description} UTC`);
}

/**
 * Identify one OS process incarnation, not merely its reusable numeric PID.
 * The round-two review reproduced a prior-boot lease blocking every tick for
 * 24 hours after that PID belonged to an unrelated process.
 */
export function processIncarnation(pid: number): string | null {
  if (!Number.isInteger(pid) || pid < 1) return null;
  if (process.platform === "linux") {
    try {
      const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const closing = stat.lastIndexOf(")");
      const fields = closing === -1 ? [] : stat.slice(closing + 1).trim().split(/\s+/);
      const startTicks = fields[19];
      if (boot !== "" && startTicks !== undefined) return `linux:proc:${boot}:${startTicks}`;
    } catch {}
    // A ps fallback uses a different identity scheme. Treat a temporarily
    // unreadable procfs identity as unknown so a live owner fails closed.
    return null;
  }
  const started = processStartDescription(pid);
  return started === null ? null : `${process.platform}:ps-utc:${started}`;
}

function storedProcessIncarnation(value: string | null): { kind: "legacy" } | { kind: "exact"; value: string } {
  if (value === null) return { kind: "legacy" };
  if (value.startsWith("linux:proc:") || value.startsWith(`${process.platform}:ps-utc:`)) return { kind: "exact", value };
  const priorLinuxProc = /^linux:([0-9a-f-]{16,}):(\d+)$/i.exec(value);
  if (priorLinuxProc !== null) return { kind: "exact", value: `linux:proc:${priorLinuxProc[1]}:${priorLinuxProc[2]}` };
  // Earlier builds stored timezone-dependent ps text without a scheme.
  // Its bytes cannot prove identity, but the process start can still prove
  // positive PID reuse relative to the durable lease.
  if (value.startsWith(`${process.platform}:`)) return { kind: "legacy" };
  return { kind: "exact", value };
}

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

function enrollmentAuthority(run: ReadRun): EnrollmentAuthority {
  const active = run.state.pendingDispatch ?? run.state.supervision ?? run.supervision;
  return {
    runInstanceId: active.runInstanceId,
    recoveryOwner: active.recoveryOwner,
    recipientAuthorityKey: recipientAuthorityKey(active.observer),
  };
}

function executeTick(options: TickOptions, executorOperationId: string, tickNow: number, tickStartedMonotonic: number): TickResult {
  const monotonicNow = options.monotonicNow ?? options.now ?? (() => performance.now());
  const at = new Date(tickNow).toISOString();
  const log = options.log ?? ((event) => appendLog(path.join(path.dirname(options.indexFile), "tick.log"), event));
  const index = readIndex(options.indexFile);
  let herdrCalls = 0;
  const checkedCall = <T>(label: string, call: (remainingMs: number) => T): T => {
    if (herdrCalls >= MAX_HERDR_CALLS_PER_TICK) throw new TickLimitReached(`tick herdr call budget ${MAX_HERDR_CALLS_PER_TICK} exhausted; remaining runs are deferred to the next tick`);
    const remainingMs = Math.floor(TICK_DEADLINE_MS - TICK_COMPLETION_RESERVE_MS - (monotonicNow() - tickStartedMonotonic));
    if (remainingMs <= 0) throw new TickLimitReached(`tick deadline ${TICK_DEADLINE_MS}ms exhausted before ${label}; the run records this bounded failure for operator inspection`);
    herdrCalls += 1;
    return call(remainingMs);
  };
  // The round-two 64-run reproduction spent the whole external-call budget
  // scanning, then repeated the same prefix forever without one delivery.
  // Oldest-processed-first and the later decision budget give every enrollment
  // fair continuation. The 20-entry cap also bounds local state reads and
  // result persistence independently of the 128-call external cap.
  const priority = (entry: IndexEntry): number => Date.parse(entry.lastProcessedAt ?? entry.addedAt);
  const scheduledEntries = [...index.entries]
    .sort((a, b) => priority(a) - priority(b))
    .slice(0, MAX_RUNS_PER_TICK);
  const scheduled = new Set(scheduledEntries.map(entryKey));
  const results: RunTickResult[] = index.entries
    .filter((entry) => !scheduled.has(entryKey(entry)))
    .map((entry) => ({ statePath: entry.statePath, slug: null, decision: null, action: "deferred", detail: `per-tick work cap ${MAX_RUNS_PER_TICK} reached; this older-unprocessed enrollment is first on a later tick` }));
  const updates = new Map<string, (entry: IndexEntry) => void>();
  const removals: Array<{ statePath: string; enrollmentId: string; cause: string; outcome?: "undelivered-terminal" }> = [];
  let herdr = index.lastHerdr ?? { available: true, detail: null };
  const herdrUnavailableDetails = new Set<string>();
  let limitDetail: string | null = null;

  const addUpdate = (entry: IndexEntry, mutate: (held: IndexEntry) => void): void => {
    const key = entryKey(entry);
    const previous = updates.get(key);
    updates.set(key, (held) => { previous?.(held); mutate(held); });
  };

  const recordLimit = (entries: IndexEntry[], detail: string): void => {
    const recorded = new Set(results.map((entry) => entry.statePath));
    for (const entry of entries) {
      addUpdate(entry, (held) => { held.lastFailure = { at, detail }; });
      if (!recorded.has(entry.statePath)) {
        results.push({ statePath: entry.statePath, slug: null, decision: null, action: "deferred", detail });
        recorded.add(entry.statePath);
      }
    }
  };

  const finish = (): TickResult => {
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
    log({ event: "supervisor.tick", at, herdrAvailable: herdr.available, runs: results.length, sent: results.filter((entry) => entry.action === "sent").length, deferred: results.filter((entry) => entry.action === "deferred").length, failed: results.filter((entry) => entry.action === "failed").length, removed: removals.length, limit: limitDetail });
    return { at, herdr, runs: results, executor: "ran" };
  };

  if (scheduledEntries.length === 0) {
    try {
      herdr = checkedCall("herdr availability probe", (remainingMs) => options.herdr.probe(undefined, remainingMs));
    } catch (error) {
      if (!(error instanceof TickLimitReached)) throw error;
      limitDetail = error.message;
      return finish();
    }
  }

  const lookups = new Map<string, AgentLookup>();
  const lookup = (target: string, hostScope: string): AgentLookup => {
    const key = `${hostScope}\0${target}`;
    const cached = lookups.get(key);
    if (cached !== undefined) return cached;
    const answer = checkedCall(`agent lookup ${target}`, (remainingMs) => options.herdr.getAgent(target, hostScope, remainingMs));
    if (answer.kind === "unavailable") herdrUnavailableDetails.add(answer.detail);
    herdr = herdrUnavailableDetails.size === 0
      ? { available: true, detail: null }
      : { available: false, detail: [...herdrUnavailableDetails].join("; ") };
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
  for (let scheduledIndex = 0; scheduledIndex < scheduledEntries.length; scheduledIndex += 1) {
    const entry = scheduledEntries[scheduledIndex]!;
    // The 20-run reproduction spent its full 25 seconds scanning and reached
    // zero submissions on every retry. Stop discovery after 10 seconds so
    // the already judged intents retain time for identity checks and input.
    if (scheduledIndex > 0 && monotonicNow() - tickStartedMonotonic >= TICK_DECISION_BUDGET_MS) {
      recordLimit(scheduledEntries.slice(scheduledIndex), `tick decision budget ${TICK_DECISION_BUDGET_MS}ms reached; remaining runs are deferred to the next tick`);
      break;
    }
    // lastFailure is also used to explain entries that were never reached.
    // A separate scheduler timestamp prevents those deferrals from tying
    // with processed entries and restoring the same slow prefix forever.
    addUpdate(entry, (held) => { held.lastProcessedAt = at; });
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
    if (run.state.pendingDispatch?.coordinationOwner === "hcoord" || run.supervision.coordinationOwner === "hcoord") {
      removals.push({ statePath: entry.statePath, enrollmentId: entry.enrollmentId, cause: "hcoord owns this run; legacy enrollment retired without a wake" });
      results.push({ statePath: entry.statePath, slug: run.facts.slug, decision: null, action: "removed", detail: "hcoord owns this run; legacy enrollment retired without a wake" });
      continue;
    }
    const authority = enrollmentAuthority(run);
    if (entry.recipientAuthorityKey === null) {
      // A pre-recipient-key record may already have spent an uncertainty
      // budget against an unrecorded Observer. Resetting it automatically can
      // repeat that external effect. Fail closed until an approved handover or
      // the owning recovery flow binds a fresh recipient generation.
      const detail = "legacy enrollment has no recipient binding; delivery is stopped until approved Observer handover or the owning recovery flow reconciles it";
      addUpdate(entry, (held) => { held.lastFailure = { at, detail }; });
      results.push({ statePath: entry.statePath, slug: run.facts.slug, decision: null, action: "failed", detail });
      log({ event: "supervisor.run.failed", statePath: entry.statePath, enrollmentId: entry.enrollmentId, slug: run.facts.slug, detail, at });
      continue;
    }
    if (entry.runInstanceId !== authority.runInstanceId
      || entry.recoveryOwner !== authority.recoveryOwner
      || entry.recipientAuthorityKey !== authority.recipientAuthorityKey) {
      try {
        reconcileEnrollmentAuthority(options.indexFile, {
          statePath: entry.statePath,
          expectedEnrollmentId: entry.enrollmentId,
          readAuthority: () => enrollmentAuthority(readRun(entry.statePath)),
          at,
          cause: "tick reconciled enrollment to current dispatch and Observer authority before delivery",
        });
        const detail = "enrollment authority changed or lacked a recipient binding; reconciled current authority and deferred delivery to the next tick";
        results.push({ statePath: entry.statePath, slug: run.facts.slug, decision: null, action: "deferred", detail });
        log({ event: "supervisor.enrollment.reconciled", statePath: entry.statePath, enrollmentId: entry.enrollmentId, slug: run.facts.slug, at });
      } catch (error) {
        const detail = `enrollment authority reconciliation failed before delivery: ${error instanceof Error ? error.message : String(error)}`;
        addUpdate(entry, (held) => { held.lastFailure = { at, detail }; });
        results.push({ statePath: entry.statePath, slug: run.facts.slug, decision: null, action: "failed", detail });
        log({ event: "supervisor.run.failed", statePath: entry.statePath, enrollmentId: entry.enrollmentId, slug: run.facts.slug, detail, at });
      }
      continue;
    }
    let decision: Decision;
    try {
      const implementorScope = run.supervision.implementor.hostScope;
      decision = decideRun(run.facts, {
        implementor: lookup(run.supervision.implementor.paneId, implementorScope),
        observer: lookup(run.supervision.observer.paneId, run.supervision.observer.hostScope),
      }, entry, tickNow);
    } catch (error) {
      if (error instanceof TickLimitReached) {
        limitDetail = error.message;
        recordLimit(scheduledEntries.slice(scheduledIndex), limitDetail);
        break;
      }
      const detail = error instanceof Error ? error.message : String(error);
      addUpdate(entry, (held) => { held.missingTicks = 0; held.lastFailure = { at, detail }; });
      results.push({ statePath: entry.statePath, slug: run.facts.slug, decision: null, action: "failed", detail });
      log({ event: "supervisor.run.failed", statePath: entry.statePath, enrollmentId: entry.enrollmentId, slug: run.facts.slug, detail, at });
      continue;
    }
    judged.push({ loaded, run, decision });
  }
  if (limitDetail !== null) {
    recordLimit(judged.map((item) => item.loaded.entry), limitDetail);
    return finish();
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
    // The decision already admitted only a deliverable Observer. Re-reading
    // state here, then performing one final uncached identity lookup after the
    // durable reservation, preserves the safety boundary without spending a
    // redundant external call (round-three 30-second single-run incident).
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
    let priorPending = new Map<string, IndexEntry["pendingWake"]>();
    const reservationHead = updateIndex(options.indexFile, (fresh) => {
      priorPending = new Map<string, IndexEntry["pendingWake"]>();
      if (fresh.tickExecutor?.operationId !== executorOperationId) return;
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
      }
    });
    let reservedItems = cappedItems.filter(({ item }) => {
      const held = reservationHead.entries.find((entry) => entry.statePath === item.loaded.entry.statePath && entry.enrollmentId === item.loaded.entry.enrollmentId);
      return reservationHead.tickExecutor?.operationId === executorOperationId && held?.pendingWake?.operationId === deliveryOperationId;
    });
    for (const { item } of cappedItems.filter((candidate) => !reservedItems.includes(candidate))) {
      results.push({ statePath: item.loaded.entry.statePath, slug: item.run.facts.slug, decision: item.decision, action: "deferred", detail: "delivery episode was acknowledged, exhausted or reserved before submission; stale wake discarded" });
    }
    if (reservedItems.length === 0) continue;

    const releaseReservations = (releasing: typeof reservedItems): void => {
      updateIndex(options.indexFile, (fresh) => {
        for (const { item } of releasing) {
          const held = fresh.entries.find((entry) => entry.statePath === item.loaded.entry.statePath && entry.enrollmentId === item.loaded.entry.enrollmentId);
          if (held?.pendingWake?.operationId === deliveryOperationId) held.pendingWake = priorPending.get(entryKey(held)) ?? null;
        }
      });
    };
    const stillAuthorized = (candidate: typeof reservedItems[number], heldIndex: SupervisorIndex): boolean => {
      if (heldIndex.tickExecutor?.operationId !== executorOperationId) return false;
      const held = heldIndex.entries.find((entry) => entry.statePath === candidate.item.loaded.entry.statePath && entry.enrollmentId === candidate.item.loaded.entry.enrollmentId);
      if (held?.pendingWake?.operationId !== deliveryOperationId) return false;
      try {
        const latest = readRun(candidate.item.loaded.entry.statePath);
        return latest.supervision.runInstanceId === held.runInstanceId && sameObserver(latest.supervision.observer, candidate.run.supervision.observer);
      } catch { return false; }
    };

    let authorityHead = readIndex(options.indexFile);
    let executableItems = reservedItems.filter((candidate) => stillAuthorized(candidate, authorityHead));
    const invalidBeforeLookup = reservedItems.filter((candidate) => !executableItems.includes(candidate));
    if (invalidBeforeLookup.length > 0) {
      releaseReservations(invalidBeforeLookup);
      for (const { item } of invalidBeforeLookup) results.push({ statePath: item.loaded.entry.statePath, slug: item.run.facts.slug, decision: item.decision, action: "deferred", detail: "reservation, enrollment, executor or Observer changed before final delivery lookup; stale wake discarded" });
    }
    if (executableItems.length === 0) continue;

    // Reservation persistence can lose a CAS or be followed immediately by
    // handover. It is not executable authority until the committed operation,
    // enrollment, current state and actual Observer all agree again.
    const executableObserver = executableItems[0]!.run.supervision.observer;
    let executableVerdict: ReturnType<typeof judgeObserver>;
    try {
      executableVerdict = judgeObserver(executableObserver, checkedCall(`final Observer lookup ${executableObserver.paneId}`, (remainingMs) => options.herdr.getAgent(executableObserver.paneId, executableObserver.hostScope, remainingMs)));
    } catch (error) {
      releaseReservations(executableItems);
      if (!(error instanceof TickLimitReached)) throw error;
      limitDetail = error.message;
      break;
    }
    if (executableVerdict.kind !== "match" || executableVerdict.status === "working" || executableVerdict.status === "blocked") {
      releaseReservations(executableItems);
      const detail = executableVerdict.kind !== "match" ? `${executableVerdict.kind}: ${executableVerdict.detail}` : `observer is ${executableVerdict.status}; delivery deferred`;
      for (const { item } of executableItems) {
        addUpdate(item.loaded.entry, (held) => {
          held.lastObservation = {
            at,
            observer: executableVerdict.kind === "match" ? `match (${executableVerdict.status})` : `${executableVerdict.kind}: ${executableVerdict.detail}`,
            implementor: held.lastObservation?.implementor ?? "unobserved",
            guardedPrompt: executableVerdict.kind === "match" && executableVerdict.inputGuard !== null,
          };
          if (executableVerdict.kind !== "match") held.lastFailure = { at, detail: executableVerdict.detail };
        });
        const removed = item.decision.terminal && executableVerdict.kind === "observer-gone"
          ? recordTerminalFailure(item, detail, item.loaded.entry.terminalFailureTicks)
          : false;
        results.push({ statePath: item.loaded.entry.statePath, slug: item.run.facts.slug, decision: item.decision, action: removed ? "undelivered-terminal" : "deferred", detail });
      }
      continue;
    }

    authorityHead = readIndex(options.indexFile);
    const beforePrompt = executableItems.filter((candidate) => stillAuthorized(candidate, authorityHead));
    const invalidAfterLookup = executableItems.filter((candidate) => !beforePrompt.includes(candidate));
    if (invalidAfterLookup.length > 0) {
      releaseReservations(invalidAfterLookup);
      for (const { item } of invalidAfterLookup) results.push({ statePath: item.loaded.entry.statePath, slug: item.run.facts.slug, decision: item.decision, action: "deferred", detail: "reservation, enrollment, executor or Observer changed during the final identity lookup; stale wake discarded" });
    }
    reservedItems = beforePrompt;
    if (reservedItems.length === 0) continue;
    lines = reservedItems.map(({ item, run }) => ({ slug: run.facts.slug, statePath: item.loaded.entry.statePath, runInstanceId: run.supervision.runInstanceId, observerSessionId: run.supervision.observer.sessionId, reasons: item.decision.due }));
    let outcome: PromptOutcome;
    try {
      outcome = checkedCall(`wake submission ${executableObserver.paneId}`, (remainingMs) => options.herdr.promptAgent({ target: executableObserver.paneId, text: renderWake(executableObserver.sessionId, lines), expectedInputGuard: executableVerdict.inputGuard }, executableObserver.hostScope, remainingMs));
    } catch (error) {
      // No prompt call began when checkedCall raises its cap/deadline. Restore
      // the exact prior attempt record so a provably absent effect costs no
      // uncertainty budget.
      releaseReservations(reservedItems);
      if (!(error instanceof TickLimitReached)) throw error;
      limitDetail = error.message;
      break;
    }
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
    log({ event: "supervisor.wake.attempted", operationId: deliveryOperationId, observer: executableObserver.sessionId, pane: executableObserver.paneId, hostScope: executableObserver.hostScope, runs: lines.map((line) => ({ statePath: line.statePath, slug: line.slug, instance: line.runInstanceId, reasons: line.reasons.map((entry) => entry.reason) })), outcome: outcome.outcome, path: outcome.path, code: outcome.code, at });
  }

  if (limitDetail !== null) {
    const recorded = new Set(results.map((entry) => entry.statePath));
    recordLimit(judged.filter((item) => !recorded.has(item.loaded.entry.statePath)).map((item) => item.loaded.entry), limitDetail);
  }
  return finish();
}

export function runTick(options: TickOptions): TickResult {
  const now = options.now ?? (() => Date.now());
  const monotonicNow = options.monotonicNow ?? options.now ?? (() => performance.now());
  const started = now();
  const startedMonotonic = monotonicNow === now ? started : monotonicNow();
  const operationId = crypto.randomUUID();
  const currentProcessIncarnation = processIncarnation(process.pid);
  const claimed = updateIndex(options.indexFile, (index) => {
    const lease = index.tickExecutor;
    const storedIncarnation = storedProcessIncarnation(lease?.processIncarnation ?? null);
    let ownerAlive = false;
    if (lease !== null) {
      try { process.kill(lease.pid, 0); ownerAlive = true; } catch (error) { ownerAlive = (error as NodeJS.ErrnoException).code === "EPERM"; }
    }
    const observedIncarnation = lease !== null && ownerAlive && storedIncarnation.kind === "exact"
      ? processIncarnation(lease.pid)
      : null;
    const legacyProcessStartedAt = lease !== null && ownerAlive && storedIncarnation.kind === "legacy"
      ? legacyProcessStartEpochMs(lease.pid)
      : Number.NaN;
    // A paused owner may outlive the nominal deadline while still inside a
    // synchronous external call. Stealing from that exact process creates two
    // executors, while a reused PID from a dead process must not block restart.
    // Legacy leases retain exclusion when that PID predates the lease, but a
    // process started after the durable lease is positive PID-reuse evidence.
    // Unobservable incarnations fail closed until the PID is absent.
    const legacyOwnerCouldMatch = lease !== null && storedIncarnation.kind === "legacy"
      && (!Number.isFinite(legacyProcessStartedAt) || legacyProcessStartedAt <= Date.parse(lease.startedAt) + 1_000);
    const exactOwnerAlive = lease !== null && ownerAlive
      && (legacyOwnerCouldMatch || (storedIncarnation.kind === "exact" && (observedIncarnation === null || observedIncarnation === storedIncarnation.value)));
    if (exactOwnerAlive) return;
    index.tickExecutor = { operationId, pid: process.pid, processIncarnation: currentProcessIncarnation, startedAt: new Date(started).toISOString() };
  });
  // updateIndex may replay the callback after a lost revision race. Closure
  // flags described an abandoned attempt in the round-two reproduction; the
  // committed lease identity is the only ownership proof.
  if (claimed.tickExecutor?.operationId !== operationId) {
    const at = new Date(started).toISOString();
    const previous = claimed.lastHerdr ?? { available: true, detail: null };
    return { at, herdr: previous, runs: [], executor: "already-running" };
  }
  try {
    return executeTick(options, operationId, started, startedMonotonic);
  } finally {
    updateIndex(options.indexFile, (index) => {
      if (index.tickExecutor?.operationId === operationId) index.tickExecutor = null;
    });
  }
}
