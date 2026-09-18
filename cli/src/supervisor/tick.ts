import fs from "node:fs";
import path from "node:path";
import { getAgent, promptAgent, type AgentLookup, type HerdrEnvironment, type PromptOutcome } from "../implement/herdr";
import { decideRun, episodeKey, type Decision, type Candidate } from "./decide";
import { readRun, type ReadRun } from "./facts";
import { MISSING_TICKS_BEFORE_CLEANUP, readIndex, updateIndex, type IndexEntry, type SupervisorIndex, type WakeRecord } from "./index";
import { renderWake, type WakeLine } from "./wake";

/**
 * The herdr surface the tick uses, injected so the unit suite runs it
 * against scripted answers and never against a live pane (B20). The default
 * is the adapter in cli/src/implement/herdr.ts, the only file that may
 * spawn herdr.
 */
export interface TickHerdr {
  /** Whether the server answers at all; when it does not, no `agent get` is attempted this tick. */
  probe(): { available: boolean; detail: string | null };
  getAgent(target: string): AgentLookup;
  promptAgent(input: { target: string; text: string; expectedInputGuard: string | null }): PromptOutcome;
}

export function herdrForTick(environment: HerdrEnvironment = {}): TickHerdr {
  return {
    probe: () => {
      // `agent get` on a name nobody has answers `absent` from a live server
      // and `unavailable` from a dead one; one call decides both.
      const listing = getAgent("__sasu_probe__", environment);
      return listing.kind === "unavailable" ? { available: false, detail: listing.detail } : { available: true, detail: null };
    },
    getAgent: (target) => getAgent(target, environment),
    promptAgent: (input) => promptAgent(input, environment),
  };
}

export interface TickOptions {
  indexFile: string;
  herdr: TickHerdr;
  now?: () => number;
  /** Structured event sink; the default appends JSON lines to the tick log. */
  log?: (event: Record<string, unknown>) => void;
}

export interface RunTickResult {
  statePath: string;
  slug: string | null;
  decision: Decision | null;
  /** What happened to the wake this tick: sent (with outcome), deferred, nothing due, or failed. */
  action: "sent" | "deferred" | "none" | "failed" | "removed";
  detail: string;
}

export interface TickResult {
  at: string;
  herdr: { available: boolean; detail: string | null };
  runs: RunTickResult[];
}

/** Log lines are capped by rotation, not by hope: one rename at the cap keeps two files at most (engineering 15). */
export const LOG_CAP_BYTES = 1024 * 1024;

export function appendLog(file: string, event: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (fs.existsSync(file) && fs.statSync(file).size >= LOG_CAP_BYTES) fs.renameSync(file, `${file}.1`);
  } catch {
    // A rotation race with another writer loses nothing but the rotation.
  }
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
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
    if (run.supervision.runInstanceId !== entry.runInstanceId) {
      return { entry, run: null, problem: `run instance ${run.supervision.runInstanceId} in state.json is not the indexed ${entry.runInstanceId}; a re-dispatch re-enrolls the path`, missing: false };
    }
    return { entry, run, problem: null, missing: false };
  } catch (error) {
    return { entry, run: null, problem: error instanceof Error ? error.message : String(error), missing: false };
  }
}

/**
 * One tick: read the index, judge every run in isolation, bundle the due
 * wakes per Observer, send each bundle once, record what was sent. The
 * index is rewritten after the sends so a kill before the write costs one
 * duplicate wake at most (D-09), never a lost run.
 */
export function runTick(options: TickOptions): TickResult {
  const now = options.now ?? (() => Date.now());
  const at = new Date(now()).toISOString();
  const log = options.log ?? ((event) => appendLog(path.join(path.dirname(options.indexFile), "tick.log"), event));
  const index = readIndex(options.indexFile);
  const herdr = index.entries.length === 0 ? { available: true, detail: null } : options.herdr.probe();
  const results: RunTickResult[] = [];
  const updates = new Map<string, (entry: IndexEntry) => void>();
  const removals: Array<{ statePath: string; cause: string }> = [];

  // Lookups are cached per pane per tick: an Observer watching several runs
  // is asked once, and every run sees the same answer.
  const lookups = new Map<string, AgentLookup>();
  const lookup = (target: string): AgentLookup => {
    if (!herdr.available) return { kind: "unavailable", detail: `herdr is not answering: ${herdr.detail ?? "no detail"}` };
    const cached = lookups.get(target);
    if (cached !== undefined) return cached;
    const answer = options.herdr.getAgent(target);
    lookups.set(target, answer);
    return answer;
  };

  interface Judged { loaded: Loaded; run: ReadRun; decision: Decision }
  const judged: Judged[] = [];
  for (const entry of index.entries) {
    const loaded = loadEntry(entry);
    if (loaded.missing) {
      const count = entry.missingTicks + 1;
      if (count >= MISSING_TICKS_BEFORE_CLEANUP) {
        const cause = `state.json missing for ${count} consecutive ticks`;
        removals.push({ statePath: entry.statePath, cause });
        results.push({ statePath: entry.statePath, slug: null, decision: null, action: "removed", detail: cause });
        log({ event: "supervisor.run.removed", statePath: entry.statePath, cause, at });
      } else {
        updates.set(entry.statePath, (held) => { held.missingTicks = count; held.lastFailure = { at, detail: loaded.problem! }; });
        results.push({ statePath: entry.statePath, slug: null, decision: null, action: "failed", detail: loaded.problem! });
      }
      continue;
    }
    if (loaded.run === null) {
      updates.set(entry.statePath, (held) => { held.missingTicks = 0; held.lastFailure = { at, detail: loaded.problem! }; });
      results.push({ statePath: entry.statePath, slug: null, decision: null, action: "failed", detail: loaded.problem! });
      log({ event: "supervisor.run.failed", statePath: entry.statePath, detail: loaded.problem, at });
      continue;
    }
    const run = loaded.run;
    let decision: Decision;
    try {
      decision = decideRun(run.facts, { implementor: lookup(run.supervision.implementor.paneId), observer: lookup(run.supervision.observer.paneId) }, entry.lastWake, now());
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      updates.set(entry.statePath, (held) => { held.missingTicks = 0; held.lastFailure = { at, detail }; });
      results.push({ statePath: entry.statePath, slug: run.facts.slug, decision: null, action: "failed", detail });
      log({ event: "supervisor.run.failed", statePath: entry.statePath, slug: run.facts.slug, detail, at });
      continue;
    }
    judged.push({ loaded, run, decision });
  }

  // Bundle per Observer session: one prompt carries every due run (D-09).
  const bundles = new Map<string, Judged[]>();
  for (const item of judged) {
    const { decision } = item;
    const observation = { at, observer: decision.observer.kind === "match" ? `match (${decision.observer.status})` : `${decision.observer.kind}: ${decision.observer.detail}`, implementor: decision.implementor.kind === "present" ? `present (${decision.implementor.status})` : `${decision.implementor.kind}: ${decision.implementor.detail}`, guardedPrompt: decision.observer.kind === "match" && decision.observer.inputGuard !== null };
    const failure = decision.observer.kind === "match" ? null : { at, detail: decision.observer.detail };
    updates.set(item.loaded.entry.statePath, (held) => { held.missingTicks = 0; held.lastObservation = observation; if (failure !== null) held.lastFailure = failure; });
    if (decision.due.length === 0) {
      results.push({ statePath: item.loaded.entry.statePath, slug: item.run.facts.slug, decision, action: decision.terminal ? "removed" : "none", detail: decision.terminal ? "terminal run already woken; leaving the index" : "nothing due" });
      if (decision.terminal) removals.push({ statePath: item.loaded.entry.statePath, cause: `run ${item.run.facts.status}; terminal wake already delivered` });
      continue;
    }
    if (decision.deferral !== null) {
      results.push({ statePath: item.loaded.entry.statePath, slug: item.run.facts.slug, decision, action: "deferred", detail: decision.deferral });
      log({ event: "supervisor.wake.deferred", slug: item.run.facts.slug, reasons: decision.due.map((entry) => entry.reason), detail: decision.deferral, at });
      continue;
    }
    const key = item.run.supervision.observer.sessionId;
    bundles.set(key, [...(bundles.get(key) ?? []), item]);
  }

  for (const [observerSessionId, items] of bundles) {
    const first = items[0]!;
    const observer = first.decision.observer;
    // Unreachable under decide.ts, which defers every non-match before the
    // item can be bundled; kept because sending to a non-match is the one
    // failure this whole module exists to prevent, so the last line before
    // the prompt re-states the invariant instead of trusting the caller.
    if (observer.kind !== "match") continue;
    const lines: WakeLine[] = items.map((item) => ({ slug: item.run.facts.slug, runInstanceId: item.run.supervision.runInstanceId, reasons: item.decision.due }));
    const outcome = options.herdr.promptAgent({ target: first.run.supervision.observer.paneId, text: renderWake(observerSessionId, lines), expectedInputGuard: observer.inputGuard });
    for (const item of items) {
      const record: WakeRecord = { at, reasons: item.decision.due.map((entry: Candidate) => entry.reason), episode: episodeKey(item.decision.due), outcome: outcome.outcome, path: outcome.path, code: outcome.code };
      const previous = updates.get(item.loaded.entry.statePath);
      updates.set(item.loaded.entry.statePath, (held) => {
        previous?.(held);
        held.lastWake = record;
        if (outcome.outcome === "rejected") held.lastFailure = { at, detail: `wake rejected (${outcome.code}): ${outcome.detail}` };
      });
      results.push({ statePath: item.loaded.entry.statePath, slug: item.run.facts.slug, decision: item.decision, action: outcome.outcome === "rejected" ? "failed" : "sent", detail: `${outcome.outcome} via ${outcome.path} (${outcome.code})` });
      if (item.decision.terminal && outcome.outcome !== "rejected") removals.push({ statePath: item.loaded.entry.statePath, cause: `run ${item.run.facts.status}; terminal wake ${outcome.outcome}` });
    }
    log({ event: "supervisor.wake.sent", observer: observerSessionId, pane: first.run.supervision.observer.paneId, runs: lines.map((line) => ({ slug: line.slug, instance: line.runInstanceId, reasons: line.reasons.map((entry) => entry.reason) })), outcome: outcome.outcome, path: outcome.path, code: outcome.code, at });
  }

  updateIndex(options.indexFile, (fresh: SupervisorIndex) => {
    fresh.lastTickAt = at;
    fresh.lastHerdr = herdr;
    for (const entry of fresh.entries) updates.get(entry.statePath)?.(entry);
    const gone = new Set(removals.map((removal) => removal.statePath));
    fresh.entries = fresh.entries.filter((entry) => !gone.has(entry.statePath));
    for (const removal of removals) fresh.removed.push({ at, ...removal });
  });
  log({ event: "supervisor.tick", at, herdrAvailable: herdr.available, runs: results.length, sent: results.filter((entry) => entry.action === "sent").length, deferred: results.filter((entry) => entry.action === "deferred").length, failed: results.filter((entry) => entry.action === "failed").length, removed: removals.length });
  return { at, herdr, runs: results };
}
