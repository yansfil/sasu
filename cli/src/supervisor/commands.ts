import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getAgent, guardedPromptSupport, type HerdrEnvironment } from "../implement/herdr";
import { recordEvent } from "../implement/events";
import { HCOORD_CLI, HcoordCallFailed, handoverRun, listParticipants, observerParticipantName, participantsOf, showParticipant, type ParticipantView, type WatchView } from "../implement/hcoord";
import { loadState, nowIso, persistState, resolveStatePath } from "../implement/store";
import type { ImplementCommandResult, ImplementState, ObserverIdentity } from "../implement/types";
import { currentHerdrRole } from "../runs/session";
import { captureEnrollmentGeneration, readIndex, reconcileEnrollmentAuthority, recipientAuthorityKey, recordCoordinatedRun, type CoordinatedRun, type EnrollmentAuthority, type SupervisorIndex } from "./index";
import { installLaunchAgent, launchAgentStatus, uninstallLaunchAgent, type LaunchAgentSpec } from "./launchd";
import { hcoordSelected, hcoordSwitchPath, indexPath, launchdLogPath, legacyRetiredPath, tickLogPath, TICK_INTERVAL_MS } from "./paths";
import { herdrForTick, rotateLog, runTick } from "./tick";

const { HARNESS_HOOK_MARKERS, removeHooks, runtimeHookFiles } = require("../../lib/hooks.js") as {
  HARNESS_HOOK_MARKERS: string[];
  removeHooks(file: string, markers: string[]): { file: string; changed: boolean };
  runtimeHookFiles(home: string): { codex: string; claude: string };
};

export interface SupervisorArgs {
  positional: string[];
  flags: Map<string, string | true>;
  /** Every value of a repeated flag, in order. */
  values?: Map<string, string[]>;
}

function flag(args: SupervisorArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function result(action: string, ok: boolean, message: string, detail?: Record<string, unknown>, summary?: string[]): ImplementCommandResult {
  return { ok, action: `supervisor:${action}`, exitCode: ok ? 0 : 1, message, ...(detail !== undefined ? { detail } : {}), ...(summary !== undefined ? { summary } : {}) };
}

/** The LaunchAgent for THIS build: the node that runs it and this checkout's cli.js. */
export function launchAgentSpec(env: NodeJS.ProcessEnv = process.env): LaunchAgentSpec {
  return { node: process.execPath, cli: path.resolve(__dirname, "..", "cli.js"), home: env["HOME"]?.trim() || require("node:os").homedir(), path: env["PATH"] ?? "" };
}

/**
 * The Observer's own identity, read from herdr for the pane this process
 * occupies. Dispatch and handover both record it; the tick later compares
 * `agent get` against it before every wake (D-06).
 */
export function currentObserverIdentity(env: NodeJS.ProcessEnv = process.env, herdr: HerdrEnvironment = {}): { identity: ObserverIdentity | null; problem: string | null } {
  const paneId = env["HERDR_PANE_ID"]?.trim() ?? "";
  if (env["HERDR_ENV"] !== "1" || paneId === "") return { identity: null, problem: "not in a Herdr pane (HERDR_ENV and HERDR_PANE_ID are required to record the Observer's identity)" };
  const looked = getAgent(paneId, herdr);
  if (looked.kind !== "found") return { identity: null, problem: `herdr cannot identify the agent in this pane ${paneId}: ${looked.detail}` };
  const agent = looked.agent;
  if (agent.sessionId === null || agent.terminalId === null) return { identity: null, problem: `herdr reports no session UUID or terminal id for pane ${paneId}; the Observer cannot be recorded, so a wake could never be verified` };
  return { identity: { runtime: agent.kind, sessionId: agent.sessionId, terminalId: agent.terminalId, paneId, hostScope: env["HERDR_SOCKET_PATH"]?.trim() || "default", recordedAt: nowIso() }, problem: null };
}

function sameObserverAuthority(left: ObserverIdentity, right: ObserverIdentity): boolean {
  return left.runtime === right.runtime
    && left.sessionId === right.sessionId
    && left.terminalId === right.terminalId
    && left.paneId === right.paneId
    && left.hostScope === right.hostScope;
}

function tick(env: NodeJS.ProcessEnv): ImplementCommandResult {
  rotateLog(launchdLogPath(env));
  const outcome = runTick({ indexFile: indexPath(env), herdr: herdrForTick() });
  if (outcome.executor === "already-running") return result("tick", true, `tick already running for ${indexPath(env)}; this request did not execute in parallel`, { ...outcome });
  const sent = outcome.runs.filter((run) => run.action === "sent").length;
  const failed = outcome.runs.filter((run) => run.action === "failed" || run.action === "undelivered-terminal").length;
  const ok = outcome.herdr.available && failed === 0;
  return result("tick", ok, `tick at ${outcome.at}: ${outcome.runs.length} run(s), ${sent} wake(s) sent, ${failed} failure(s)${outcome.herdr.available ? "" : "; herdr unavailable, state.json judgment only"}`, { ...outcome, runs: outcome.runs.map((run) => ({ statePath: run.statePath, slug: run.slug, action: run.action, detail: run.detail, due: run.decision?.due.map((entry) => entry.reason) ?? [], candidates: run.decision?.candidates.map((entry) => entry.reason) ?? [] })) });
}

function slugOf(statePath: string): string {
  return path.basename(path.dirname(statePath));
}

export function supervisorStatusView(env: NodeJS.ProcessEnv, herdr: HerdrEnvironment = {}, launchd: Parameters<typeof launchAgentStatus>[0] = { env }): { ok: boolean; lines: string[]; detail: Record<string, unknown> } {
  const file = indexPath(env);
  let index: SupervisorIndex | null = null;
  let indexProblem: string | null = null;
  try { index = readIndex(file); } catch (error) { indexProblem = error instanceof Error ? error.message : String(error); }
  const agent = launchAgentStatus(launchd);
  const guarded = guardedPromptSupport(herdr);
  const now = Date.now();
  const runs = (index?.entries ?? []).map((entry) => ({
    slug: slugOf(entry.statePath),
    statePath: entry.statePath,
    runInstanceId: entry.runInstanceId,
    recoveryOwner: entry.recoveryOwner,
    addedAt: entry.addedAt,
    missingTicks: entry.missingTicks,
    lastWake: entry.lastWake,
    lastFailure: entry.lastFailure,
    lastObservation: entry.lastObservation,
    wakePath: entry.lastObservation === null ? "unobserved" : entry.lastObservation.guardedPrompt ? "guarded" : "session-match",
    stale: entry.missingTicks > 0 || (entry.lastObservation !== null && (/^observer-gone/.test(entry.lastObservation.observer) || /^implementor-gone/.test(entry.lastObservation.implementor) || /^unobservable/.test(entry.lastObservation.observer) || /^unobservable/.test(entry.lastObservation.implementor))),
  }));
  // hcoord runs are listed in the index apart from the tick's entries (B1),
  // with their participants read from each run's own state.json (B18).
  const coordinated = (index?.coordinated ?? []).map(coordinatedRunView).filter((run) => run.active);
  const coordinatedStale = coordinated.some((run) => run.stale);
  const tickAgeMs = index?.lastTickAt === null || index?.lastTickAt === undefined ? null : now - Date.parse(index.lastTickAt);
  const healthProblems = [
    ...(indexProblem === null ? [] : [indexProblem]),
    ...(runs.length > 0 && !agent.installed ? ["LaunchAgent is not installed"] : []),
    ...(runs.length > 0 && agent.loaded !== true ? ["LaunchAgent is not loaded"] : []),
    ...(runs.length > 0 && tickAgeMs === null ? ["no tick has completed"] : []),
    ...(tickAgeMs !== null && tickAgeMs > TICK_INTERVAL_MS * 3 ? [`last tick is ${Math.round(tickAgeMs / 1000)} seconds old`] : []),
    ...(index?.lastHerdr?.available === false ? [`last tick could not observe herdr: ${index.lastHerdr.detail ?? "no detail"}`] : []),
    ...runs.filter((run) => run.stale).map((run) => `${run.slug} routing is stale`),
    ...runs.filter((run) => run.lastFailure !== null).map((run) => `${run.slug} current failure: ${run.lastFailure!.detail}`),
    ...(index?.undeliveredTerminal.map((record) => `undelivered-terminal ${slugOf(record.statePath)}: ${record.detail}`) ?? []),
    ...coordinated.filter((run) => run.problem !== null).map((run) => `${run.slug} hcoord record unreadable: ${run.problem}`),
    ...(coordinatedStale ? [`hcoord daemon is stopped while ${coordinated.length} hcoord run(s) are active; start it with hcoord daemon start`] : []),
  ];
  const lines = [
    `LaunchAgent: ${agent.installed ? "installed" : "NOT installed"} at ${agent.plistPath}; ${agent.loaded === true ? "loaded" : agent.loaded === false ? "NOT loaded" : "load state unknown"}${agent.detail === null ? "" : ` (${agent.detail})`}`,
    `Last tick: ${index?.lastTickAt ?? "never"}${index?.lastHerdr === null || index?.lastHerdr === undefined ? "" : `; herdr ${index.lastHerdr.available ? "available" : `unavailable: ${index.lastHerdr.detail}`}`}`,
    `Guarded prompt: ${guarded.supported === true ? "supported by the installed herdr" : guarded.supported === false ? "not offered by the installed herdr (session-match path in use)" : `unknown: ${guarded.detail}`}`,
    `Health: ${healthProblems.length === 0 ? "healthy" : `ATTENTION - ${healthProblems.join("; ")}`}`,
    ...(indexProblem === null ? [] : [`Index: ${indexProblem}`]),
    `Runs: ${runs.length}`,
    ...runs.map((run) => `  ${run.slug} ${run.runInstanceId}${run.stale ? " [stale]" : ""}: recovery owner ${run.recoveryOwner}; observer ${run.lastObservation?.observer ?? "unobserved"}; implementor ${run.lastObservation?.implementor ?? "unobserved"}; last wake ${run.lastWake === null ? "none" : `${run.lastWake.reasons.join("+")} at ${run.lastWake.at} ${run.lastWake.outcome} via ${run.lastWake.path}`}; last failure ${run.lastFailure === null ? "none" : `${run.lastFailure.at} ${run.lastFailure.detail}`}`),
    ...(index?.removed.slice(-5).map((removal) => `  removed ${slugOf(removal.statePath)} at ${removal.at}: ${removal.cause}`) ?? []),
    `New dispatches: ${hcoordSelected(env) ? "hcoord" : "legacy supervisor"} (sasu supervisor use hcoord|legacy)`,
    `hcoord runs: ${coordinated.length}${coordinatedStale ? " (daemon stopped; saved record)" : ""}`,
    ...coordinated.map((run) => `  ${run.slug} ${run.runInstanceId}: hcoord owns this run; Observer ${run.observer ?? "unrecorded"}; implementor ${run.implementorName ?? "unknown"} (${run.implementor ?? "unrecorded"}); watch ${run.watch?.status ?? "none"} every ${run.watch === null ? "unknown" : `${Math.round(run.watch.intervalMs / 60_000)} min`}; open cycle ${run.watch?.cycle ?? "none"}; last closed ${run.watch?.checkedAt ?? "never"}${run.watch?.quietSince ? `; quiet since ${run.watch.quietSince}` : ""}; recovery owner ${run.recoveryOwner}${run.problem === null ? "" : `; ${run.problem}`}`),
    `Undelivered terminal: ${index?.undeliveredTerminal.length ?? 0}`,
    ...(index?.undeliveredTerminal.slice(-5).map((record) => `  ATTENTION ${slugOf(record.statePath)} ${record.runInstanceId} at ${record.at}: ${record.detail}`) ?? []),
  ];
  const ok = healthProblems.length === 0;
  return { ok, lines, detail: { newDispatches: hcoordSelected(env) ? "hcoord" : "legacy", hcoordRuns: coordinated, launchAgent: agent, lastTickAt: index?.lastTickAt ?? null, lastTickAgeMs: tickAgeMs, lastHerdr: index?.lastHerdr ?? null, guardedPrompt: guarded, indexPath: file, indexProblem, healthProblems, runs, removed: index?.removed ?? [], undeliveredTerminal: index?.undeliveredTerminal ?? [], tickExecutor: index?.tickExecutor ?? null, tickLog: tickLogPath(env) } };
}

interface CoordinatedRunView { slug: string; statePath: string; runInstanceId: string; active: boolean; observer: string | null; implementor: string | null; implementorName: string | null; recoveryOwner: string; watch: WatchView | null; stale: boolean; problem: string | null }

/**
 * One listed hcoord run as `status` shows it: its participants from its own
 * state.json, and the implementor's watch from hcoord by that ID. A retired
 * or redispatched run is left out rather than shown as current.
 */
function coordinatedRunView(entry: CoordinatedRun): CoordinatedRunView {
  const base = { slug: slugOf(entry.statePath), statePath: entry.statePath, runInstanceId: entry.runInstanceId, observer: null, implementor: null, implementorName: null, recoveryOwner: "unrecorded", watch: null, stale: false };
  let state: ImplementState;
  try { state = JSON.parse(fs.readFileSync(entry.statePath, "utf8")) as ImplementState; }
  catch (error) { return { ...base, active: true, problem: `state.json unreadable: ${error instanceof Error ? error.message : String(error)}` }; }
  const supervision = state.supervision ?? null;
  const active = state.status === "active" && supervision?.runInstanceId === entry.runInstanceId && supervision.coordinationOwner === "hcoord";
  const recorded = supervision?.hcoord;
  const known = { ...base, slug: state.topicSlug ?? base.slug, active, recoveryOwner: supervision?.recoveryOwner ?? "unrecorded" };
  if (recorded === undefined) return { ...known, problem: "no hcoord participants recorded; sasu supervisor migrate-hcoord rebuilds them" };
  try {
    const shown = showParticipant(recorded.implementor);
    return { ...known, observer: recorded.observer, implementor: recorded.implementor, implementorName: shown.value.name, watch: shown.value.watch, stale: shown.stale, problem: null };
  } catch (error) {
    if (!(error instanceof HcoordCallFailed)) throw error;
    return { ...known, observer: recorded.observer, implementor: recorded.implementor, problem: error.message };
  }
}

function status(env: NodeJS.ProcessEnv): ImplementCommandResult {
  const view = supervisorStatusView(env);
  return result("status", view.ok, view.ok ? "supervisor is healthy" : "supervisor needs attention", view.detail, view.lines);
}

function install(env: NodeJS.ProcessEnv): ImplementCommandResult {
  if (fs.existsSync(legacyRetiredPath(env))) return result("install", false, "legacy supervisor was retired after its final indexed run; hcoord owns new dispatches");
  const spec = launchAgentSpec(env);
  const installed = installLaunchAgent(spec, { env });
  const ok = installed.problem === null;
  return result("install", ok, ok ? `LaunchAgent ${installed.plist} and loaded (${installed.launchctl.length === 0 ? "already converged" : installed.launchctl.join("; ")})` : `LaunchAgent ${installed.plist} but not loaded: ${installed.problem}`, { ...installed, spec });
}

function uninstall(env: NodeJS.ProcessEnv): ImplementCommandResult {
  const removed = uninstallLaunchAgent({ env });
  const home = env["HOME"]?.trim() || require("node:os").homedir();
  const files = runtimeHookFiles(home);
  const marker = HARNESS_HOOK_MARKERS.filter((entry) => entry === "supervisor_stop.mjs");
  const hooks = { codex: removeHooks(files.codex, marker), claude: removeHooks(files.claude, marker) };
  const ok = removed.problem === null;
  return result("uninstall", ok, ok ? `LaunchAgent ${removed.plist}; Stop hook ${hooks.claude.changed || hooks.codex.changed ? "removed" : "was not registered"}` : `LaunchAgent not removed: ${removed.problem}`, { launchAgent: removed, hooks });
}

function retireLegacy(env: NodeJS.ProcessEnv): ImplementCommandResult {
  if (!hcoordSelected(env)) return result("retire-legacy", false, "new dispatches still use the legacy supervisor; run sasu supervisor use hcoord first");
  const index = readIndex(indexPath(env));
  if (index.entries.length > 0 || index.tickExecutor !== null) return result("retire-legacy", false, "legacy supervisor still owns indexed runs or a tick is active", { indexedRuns: index.entries.map((entry) => entry.statePath), tickActive: index.tickExecutor !== null });
  const removed = uninstall(env);
  if (!removed.ok) return result("retire-legacy", false, removed.message, removed.detail);
  fs.mkdirSync(path.dirname(legacyRetiredPath(env)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(legacyRetiredPath(env), `${new Date().toISOString()}\n`, { mode: 0o600 });
  return result("retire-legacy", true, "legacy supervisor and Stop hook retired after the final indexed run; future installs retain this retirement", { indexedRuns: 0, marker: legacyRetiredPath(env) });
}

/**
 * `sasu supervisor use hcoord|legacy`: who supervises new dispatches, for the
 * whole machine (D-08). Runs already dispatched keep their owner. hcoord is
 * selected only while its daemon answers, so the switch never points new
 * runs at a coordinator that cannot wake anyone.
 */
function use(args: SupervisorArgs, env: NodeJS.ProcessEnv): ImplementCommandResult {
  const choice = args.positional[2];
  const file = hcoordSwitchPath(env);
  if (choice === "legacy") {
    if (fs.existsSync(legacyRetiredPath(env))) return result("use", false, "the legacy supervisor was retired after its final run; new dispatches stay with hcoord");
    fs.rmSync(file, { force: true });
    return result("use", true, "new dispatches use the legacy supervisor; runs already dispatched keep their owner", { newDispatches: "legacy" });
  }
  if (choice !== "hcoord") return { ok: false, action: "supervisor:use", exitCode: 2, message: "usage: sasu supervisor use hcoord|legacy" };
  const probe = require("node:child_process").spawnSync(process.execPath, [HCOORD_CLI, "status", "--json"], { encoding: "utf8", timeout: 15_000, env }) as { stdout: string; stderr: string; status: number | null };
  let answered: { ok?: boolean; value?: { stale?: boolean } } | null = null;
  try { answered = JSON.parse(probe.stdout); } catch { answered = null; }
  if (answered?.ok !== true || answered.value?.stale === true) return result("use", false, `the hcoord daemon is not answering, so new dispatches stay with the legacy supervisor; start it with hcoord daemon start (${(probe.stderr || probe.stdout).trim().slice(0, 200) || "no output"})`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${new Date().toISOString()}\n`, { mode: 0o600 });
  return result("use", true, "new dispatches use hcoord; runs already dispatched keep their owner", { newDispatches: "hcoord", switch: file });
}

/**
 * One-time move of runs registered through the retired Sasu-specific hcoord
 * commands (PRD B27): each hcoord run's Observer and implementor are found in
 * `hcoord agent list` by the pane and session state.json records, and their
 * participant IDs are written to that state.json. The hcoord ledger file is
 * never read. A run without a match is reported with its reason and left as
 * it was.
 */
function migrateHcoord(projectRoot: string, args: SupervisorArgs, env: NodeJS.ProcessEnv): ImplementCommandResult {
  const named = args.values?.get("state") ?? [];
  const statePaths = named.length > 0 ? named.map((file) => path.resolve(projectRoot, file)) : discoverStatePaths(projectRoot);
  let participants: ReturnType<typeof listParticipants>;
  try { participants = listParticipants(); }
  catch (error) { if (error instanceof HcoordCallFailed) return result("migrate-hcoord", false, `hcoord agent list failed: ${error.message}; nothing was changed`); throw error; }
  // Several records of one execution are one participant to hcoord (D-18);
  // the one the run's relations point at is kept, else the latest.
  const find = (identity: Pick<ObserverIdentity, "paneId" | "sessionId" | "terminalId" | "hostScope">, prefer: (participant: ParticipantView) => boolean): ParticipantView | string => {
    const matches = participantsOf(participants.value, identity);
    if (matches.length === 0) return `no registered participant in pane ${identity.paneId} with session ${identity.sessionId}`;
    return matches.find(prefer) ?? matches.at(-1)!;
  };
  const runs = statePaths.map((statePath) => {
    const slug = slugOf(statePath);
    let loaded: { state: ImplementState };
    try { loaded = loadState(projectRoot, { state: statePath }); }
    catch (error) { return { slug, statePath, outcome: "unmatched", reason: `state.json unreadable: ${error instanceof Error ? error.message : String(error)}` }; }
    const state = loaded.state;
    const supervision = state.supervision ?? null;
    if (supervision === null || supervision.coordinationOwner !== "hcoord") return { slug: state.topicSlug, statePath, outcome: "skipped", reason: "not an hcoord run" };
    if (state.status !== "active") return { slug: state.topicSlug, statePath, outcome: "skipped", reason: `run is ${state.status}` };
    const implementor = find(supervision.implementor, (participant) => participant.watch?.status === "active");
    const watchedBy = typeof implementor === "string" || implementor.watch?.status !== "active" ? null : implementor.watch.observer;
    const observer = find(supervision.observer, (participant) => participant.id === watchedBy);
    if (typeof observer === "string" || typeof implementor === "string") return { slug: state.topicSlug, statePath, outcome: "unmatched", reason: [typeof observer === "string" ? `Observer: ${observer}` : null, typeof implementor === "string" ? `implementor: ${implementor}` : null].filter(Boolean).join("; ") };
    // The watch was handed to another Observer outside Sasu; state.json still names the old one.
    const watcher = watchedBy === null || watchedBy === observer.id ? undefined : participants.value.find((participant) => participant.id === watchedBy);
    const note = watcher === undefined ? undefined : `the implementor's watch is observed by ${watcher.name} (${watcher.id}) in pane ${watcher.pane ?? "unknown"}, not the recorded Observer; run sasu supervisor handover --slug ${state.topicSlug} --approval "<verbatim user approval>" from that pane to record it`;
    const intervalMs = implementor.watch?.intervalMs ?? supervision.patrolIntervalMs;
    const before = supervision.hcoord ?? null;
    if (before !== null && before.observer === observer.id && before.implementor === implementor.id) {
      recordCoordinatedRun(indexPath(env), { statePath: path.resolve(statePath), runInstanceId: supervision.runInstanceId, addedAt: nowIso() });
      return { slug: state.topicSlug, statePath, outcome: "unchanged", observer: observer.id, implementor: implementor.id, ...(note === undefined ? {} : { note }) };
    }
    supervision.hcoord = { observer: observer.id, implementor: implementor.id, intervalMs, recoveryOwner: supervision.recoveryOwner, registeredAt: nowIso() };
    persistState(statePath, state);
    recordCoordinatedRun(indexPath(env), { statePath: path.resolve(statePath), runInstanceId: supervision.runInstanceId, addedAt: nowIso() });
    return { slug: state.topicSlug, statePath, outcome: "recorded", observer: observer.id, implementor: implementor.id, watch: implementor.watch?.status ?? "none", ...(note === undefined ? {} : { note }) };
  });
  const unmatched = runs.filter((run) => run.outcome === "unmatched");
  const lines = runs.map((run) => `  ${run.slug}: ${run.outcome}${"reason" in run ? ` - ${run.reason}` : ` (Observer ${run.observer}, implementor ${run.implementor})${"note" in run && run.note !== undefined ? `; ${run.note}` : ""}`}`);
  return result("migrate-hcoord", unmatched.length === 0, `${runs.filter((run) => run.outcome === "recorded").length} run(s) recorded, ${unmatched.length} unmatched, of ${runs.length} examined${participants.stale ? "; hcoord daemon stopped, saved record used" : ""}`, { runs }, lines);
}

/** Every run's state.json under this project's agents/runs. */
function discoverStatePaths(projectRoot: string): string[] {
  const runsDir = path.join(projectRoot, "agents", "runs");
  if (!fs.existsSync(runsDir)) return [];
  return fs.readdirSync(runsDir).map((slug) => path.join(runsDir, slug, "state.json")).filter((file) => fs.existsSync(file));
}

/**
 * Explicit handover of a run to the Observer session in this pane (B18).
 * Verbatim user approval, the same evidence every takeover in the harness
 * records; refused from a marked implementor pane, refused while a verify
 * lease is live (persistState), and refused when herdr cannot name this
 * pane's session - an unverifiable Observer would never receive a wake.
 */
export interface SupervisorCommandHooks {
  /** Deterministic concurrency boundary after handover authority is durable. */
  afterHandoverPersist?: () => void;
  herdr?: HerdrEnvironment;
}

function handover(projectRoot: string, args: SupervisorArgs, env: NodeJS.ProcessEnv, hooks: SupervisorCommandHooks = {}): ImplementCommandResult {
  if (currentHerdrRole(env) === "implementor") throw new Error("a marked implementor pane cannot become the Observer");
  const approval = flag(args, "approval")?.trim() ?? "";
  if (approval === "") throw new Error("handover requires --approval \"<the user's verbatim words>\"");
  const slug = flag(args, "slug");
  const statePathFlag = flag(args, "state");
  const stateOptions = { ...(slug !== undefined ? { slug } : {}), ...(statePathFlag !== undefined ? { state: statePathFlag } : {}) };
  const statePath = resolveStatePath(projectRoot, stateOptions);
  const supervisorIndex = indexPath(env);
  // Capture the scheduler generation before the authority snapshot. A newer
  // dispatch that lands after this point must remain authoritative.
  const expectedEnrollmentId = captureEnrollmentGeneration(supervisorIndex, statePath);
  const { state } = loadState(projectRoot, { state: statePath });
  const supervision = state.supervision ?? null;
  const pending = state.pendingDispatch ?? null;
  if (supervision === null && pending === null) throw new Error(`run ${state.topicSlug} has no supervision or pending dispatch record; it was never dispatched under Herdr`);
  if (state.status !== "active") throw new Error(`run ${state.topicSlug} is ${state.status}; a finished run is not handed over`);
  const observer = currentObserverIdentity(env, hooks.herdr ?? { env });
  if (observer.identity === null) throw new Error(observer.problem ?? "cannot read this pane's identity");
  // An hcoord run's watch moves first: the coordinator validates the new
  // Observer's exact execution, and until it accepts, the old Observer's
  // place receives nothing and the Sasu record still names it (B15). A
  // repeat after a later failure finds the watch already moved.
  const coordinated = supervision?.coordinationOwner === "hcoord" ? handoverCoordination(state.topicSlug, supervision, observer.identity, hooks.herdr ?? { env }) : null;
  const at = nowIso();
  const from = supervision?.observer ?? pending!.observer;
  const transfer = { at, from, to: observer.identity, approval };
  if (supervision !== null) {
    supervision.handovers = [...supervision.handovers, transfer];
    supervision.observer = observer.identity;
    if (coordinated !== null && supervision.hcoord !== undefined) supervision.hcoord = { ...supervision.hcoord, observer: coordinated.observer };
  }
  // A partial handoff is recovered by the Observer, not by the Implementor.
  // Move that recovery authority with the explicit human-approved handover so
  // an interrupted dispatch cannot become permanently wedged (2026-09-20).
  if (pending !== null) {
    pending.handovers = [...(pending.handovers ?? []), transfer];
    pending.observer = observer.identity;
  }
  recordEvent(state, { kind: "handover", actor: "human", subject: null, summary: `Observer handed over to session ${observer.identity.sessionId} in ${observer.identity.paneId}`, at });
  persistState(statePath, state);
  hooks.afterHandoverPersist?.();
  const authorityOf = (current: ImplementState): EnrollmentAuthority | null => {
    const active = current.pendingDispatch ?? current.supervision ?? null;
    return active === null ? null : { runInstanceId: active.runInstanceId, recoveryOwner: active.recoveryOwner, recipientAuthorityKey: recipientAuthorityKey(active.observer) };
  };
  reconcileEnrollmentAuthority(supervisorIndex, {
    statePath,
    expectedEnrollmentId,
    readAuthority: () => authorityOf(loadState(projectRoot, { state: statePath }).state),
    at,
    cause: `handover to Observer ${observer.identity.sessionId} reconciled current dispatch authority`,
  });
  const current = loadState(projectRoot, { state: statePath }).state;
  const currentRecord = current.pendingDispatch ?? current.supervision ?? null;
  const currentObserver = currentRecord?.observer ?? null;
  if (currentObserver === null || !sameObserverAuthority(currentObserver, observer.identity)) {
    throw new Error("handover authority changed after persistence; the current enrollment was reconciled but this handover is no longer authoritative");
  }
  return result("handover", true, `run ${current.topicSlug} is now observed by session ${observer.identity.sessionId} in pane ${observer.identity.paneId}; ${coordinated === null ? "wakes and partial recovery resume on the next action" : `hcoord now sends its watch cycles and notices to participant ${coordinated.observer}`}`, { observer: observer.identity, handovers: current.pendingDispatch?.handovers?.length ?? current.supervision?.handovers.length ?? 0, pendingPhase: current.pendingDispatch?.phase ?? null, hcoord: coordinated });
}

function handoverCoordination(slug: string, supervision: NonNullable<ImplementState["supervision"]>, identity: ObserverIdentity, herdr: HerdrEnvironment): { observer: string; watch: WatchView } {
  const recorded = supervision.hcoord;
  if (recorded === undefined) throw new Error(`run ${slug} records no hcoord participants; run sasu supervisor migrate-hcoord first. Nothing was changed`);
  const looked = getAgent(identity.paneId, herdr);
  if (looked.kind !== "found") throw new Error(`herdr cannot read the new Observer pane ${identity.paneId}: ${looked.detail}. Nothing was changed`);
  try { return handoverRun(recorded.implementor, { identity, name: observerParticipantName(looked.agent.name, identity.sessionId) }, { slug, patrolIntervalMs: supervision.patrolIntervalMs, recoveryOwner: supervision.recoveryOwner }); }
  catch (error) {
    if (error instanceof HcoordCallFailed) throw new Error(`${error.message}; the handover was not recorded and the old Observer remains recorded`);
    throw error;
  }
}

export async function runSupervisorCommand(projectRoot: string, args: SupervisorArgs, env: NodeJS.ProcessEnv = process.env, hooks: SupervisorCommandHooks = {}): Promise<ImplementCommandResult> {
  const subcommand = args.positional[1];
  try {
    if (subcommand === "tick") return tick(env);
    if (subcommand === "status") return status(env);
    if (subcommand === "install") return install(env);
    if (subcommand === "uninstall") return uninstall(env);
    if (subcommand === "retire-legacy") return retireLegacy(env);
    if (subcommand === "handover") return handover(projectRoot, args, env, hooks);
    if (subcommand === "use") return use(args, env);
    if (subcommand === "migrate-hcoord") return migrateHcoord(projectRoot, args, env);
    return { ok: false, action: `supervisor:${subcommand ?? "unknown"}`, exitCode: 2, message: "unknown supervisor subcommand; use tick, status, install, uninstall, retire-legacy, handover, use, or migrate-hcoord" };
  } catch (error) {
    return { ok: false, action: `supervisor:${subcommand ?? "unknown"}`, exitCode: 2, message: error instanceof Error ? error.message : String(error) };
  }
}

/** A random, unguessable run instance id for a dispatch (D-04). */
export function newRunInstanceId(): string {
  return crypto.randomUUID();
}
