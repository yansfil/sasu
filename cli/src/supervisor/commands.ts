import crypto from "node:crypto";
import path from "node:path";
import { getAgent, guardedPromptSupport, type HerdrEnvironment } from "../implement/herdr";
import { recordEvent } from "../implement/events";
import { loadState, nowIso, persistState } from "../implement/store";
import type { ImplementCommandResult, ObserverIdentity } from "../implement/types";
import { currentHerdrRole } from "../runs/session";
import { readIndex, enrollRun, type SupervisorIndex } from "./index";
import { installLaunchAgent, launchAgentStatus, uninstallLaunchAgent, type LaunchAgentSpec } from "./launchd";
import { indexPath, tickLogPath } from "./paths";
import { herdrForTick, runTick } from "./tick";

const { HARNESS_HOOK_MARKERS, removeHooks, runtimeHookFiles } = require("../../lib/hooks.js") as {
  HARNESS_HOOK_MARKERS: string[];
  removeHooks(file: string, markers: string[]): { file: string; changed: boolean };
  runtimeHookFiles(home: string): { codex: string; claude: string };
};

export interface SupervisorArgs {
  positional: string[];
  flags: Map<string, string | true>;
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

function tick(env: NodeJS.ProcessEnv): ImplementCommandResult {
  const outcome = runTick({ indexFile: indexPath(env), herdr: herdrForTick() });
  const sent = outcome.runs.filter((run) => run.action === "sent").length;
  return result("tick", true, `tick at ${outcome.at}: ${outcome.runs.length} run(s), ${sent} wake(s) sent${outcome.herdr.available ? "" : "; herdr unavailable, state.json judgment only"}`, { ...outcome, runs: outcome.runs.map((run) => ({ statePath: run.statePath, slug: run.slug, action: run.action, detail: run.detail, due: run.decision?.due.map((entry) => entry.reason) ?? [], candidates: run.decision?.candidates.map((entry) => entry.reason) ?? [] })) });
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
  const runs = (index?.entries ?? []).map((entry) => ({
    slug: slugOf(entry.statePath),
    statePath: entry.statePath,
    runInstanceId: entry.runInstanceId,
    addedAt: entry.addedAt,
    missingTicks: entry.missingTicks,
    lastWake: entry.lastWake,
    lastFailure: entry.lastFailure,
    lastObservation: entry.lastObservation,
    wakePath: entry.lastObservation === null ? "unobserved" : entry.lastObservation.guardedPrompt ? "guarded" : "session-match",
    stale: entry.missingTicks > 0 || (entry.lastObservation !== null && (/^observer-gone/.test(entry.lastObservation.observer) || /^implementor-gone/.test(entry.lastObservation.implementor))),
  }));
  const lines = [
    `LaunchAgent: ${agent.installed ? "installed" : "NOT installed"} at ${agent.plistPath}; ${agent.loaded === true ? "loaded" : agent.loaded === false ? "NOT loaded" : "load state unknown"}${agent.detail === null ? "" : ` (${agent.detail})`}`,
    `Last tick: ${index?.lastTickAt ?? "never"}${index?.lastHerdr === null || index?.lastHerdr === undefined ? "" : `; herdr ${index.lastHerdr.available ? "available" : `unavailable: ${index.lastHerdr.detail}`}`}`,
    `Guarded prompt: ${guarded.supported === true ? "supported by the installed herdr" : guarded.supported === false ? "not offered by the installed herdr (session-match path in use)" : `unknown: ${guarded.detail}`}`,
    ...(indexProblem === null ? [] : [`Index: ${indexProblem}`]),
    `Runs: ${runs.length}`,
    ...runs.map((run) => `  ${run.slug} ${run.runInstanceId}${run.stale ? " [stale]" : ""}: observer ${run.lastObservation?.observer ?? "unobserved"}; implementor ${run.lastObservation?.implementor ?? "unobserved"}; last wake ${run.lastWake === null ? "none" : `${run.lastWake.reasons.join("+")} at ${run.lastWake.at} ${run.lastWake.outcome} via ${run.lastWake.path}`}; last failure ${run.lastFailure === null ? "none" : `${run.lastFailure.at} ${run.lastFailure.detail}`}`),
    ...(index?.removed.slice(-5).map((removal) => `  removed ${slugOf(removal.statePath)} at ${removal.at}: ${removal.cause}`) ?? []),
  ];
  const ok = indexProblem === null && (runs.length === 0 || (agent.installed && agent.loaded === true));
  return { ok, lines, detail: { launchAgent: agent, lastTickAt: index?.lastTickAt ?? null, lastHerdr: index?.lastHerdr ?? null, guardedPrompt: guarded, indexPath: file, indexProblem, runs, removed: index?.removed ?? [], tickLog: tickLogPath(env) } };
}

function status(env: NodeJS.ProcessEnv): ImplementCommandResult {
  const view = supervisorStatusView(env);
  return result("status", true, view.ok ? "supervisor is healthy" : "supervisor needs attention", view.detail, view.lines);
}

function install(env: NodeJS.ProcessEnv): ImplementCommandResult {
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

/**
 * Explicit handover of a run to the Observer session in this pane (B18).
 * Verbatim user approval, the same evidence every takeover in the harness
 * records; refused from a marked implementor pane, refused while a verify
 * lease is live (persistState), and refused when herdr cannot name this
 * pane's session - an unverifiable Observer would never receive a wake.
 */
function handover(projectRoot: string, args: SupervisorArgs, env: NodeJS.ProcessEnv): ImplementCommandResult {
  if (currentHerdrRole(env) === "implementor") throw new Error("a marked implementor pane cannot become the Observer");
  const approval = flag(args, "approval")?.trim() ?? "";
  if (approval === "") throw new Error("handover requires --approval \"<the user's verbatim words>\"");
  const slug = flag(args, "slug");
  const statePathFlag = flag(args, "state");
  const { statePath, state } = loadState(projectRoot, { ...(slug !== undefined ? { slug } : {}), ...(statePathFlag !== undefined ? { state: statePathFlag } : {}) });
  const supervision = state.supervision ?? null;
  if (supervision === null) throw new Error(`run ${state.topicSlug} has no supervision record; it was never dispatched under Herdr`);
  if (state.status !== "active") throw new Error(`run ${state.topicSlug} is ${state.status}; a finished run is not handed over`);
  const observer = currentObserverIdentity(env);
  if (observer.identity === null) throw new Error(observer.problem ?? "cannot read this pane's identity");
  const at = nowIso();
  supervision.handovers = [...supervision.handovers, { at, from: supervision.observer, to: observer.identity, approval }];
  supervision.observer = observer.identity;
  recordEvent(state, { kind: "handover", actor: "human", subject: null, summary: `Observer handed over to session ${observer.identity.sessionId} in ${observer.identity.paneId}`, at });
  persistState(statePath, state);
  enrollRun(indexPath(env), { statePath, runInstanceId: supervision.runInstanceId, at });
  return result("handover", true, `run ${state.topicSlug} is now observed by session ${observer.identity.sessionId} in pane ${observer.identity.paneId}; wakes resume on the next tick`, { observer: observer.identity, handovers: supervision.handovers.length });
}

export async function runSupervisorCommand(projectRoot: string, args: SupervisorArgs, env: NodeJS.ProcessEnv = process.env): Promise<ImplementCommandResult> {
  const subcommand = args.positional[1];
  try {
    if (subcommand === "tick") return tick(env);
    if (subcommand === "status") return status(env);
    if (subcommand === "install") return install(env);
    if (subcommand === "uninstall") return uninstall(env);
    if (subcommand === "handover") return handover(projectRoot, args, env);
    return { ok: false, action: `supervisor:${subcommand ?? "unknown"}`, exitCode: 2, message: "unknown supervisor subcommand; use tick, status, install, uninstall, or handover" };
  } catch (error) {
    return { ok: false, action: `supervisor:${subcommand ?? "unknown"}`, exitCode: 2, message: error instanceof Error ? error.message : String(error) };
  }
}

/** A random, unguessable run instance id for a dispatch (D-04). */
export function newRunInstanceId(): string {
  return crypto.randomUUID();
}

