import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getAgent, type HerdrEnvironment } from "../implement/herdr";
import { recordEvent } from "../implement/events";
import { HideCallFailed, checkObserver, handoverRun, observerParticipantName, showParticipant, type WatchView } from "../implement/hide";
import { loadState, nowIso, persistState, resolveStatePath } from "../implement/store";
import type { ImplementCommandResult, ImplementState, ObserverIdentity } from "../implement/types";
import { currentHerdrRole } from "../runs/session";
import { captureRegistrationGeneration, readIndex, reconcileRegistrationAuthority, recipientAuthorityKey } from "./index";
import { indexPath } from "./paths";

export interface SupervisorArgs { positional: string[]; flags: Map<string, string | true>; values?: Map<string, string[]> }
function flag(args: SupervisorArgs, name: string): string | undefined { const value = args.flags.get(name); return typeof value === "string" ? value : undefined; }
function result(action: string, ok: boolean, message: string, detail?: Record<string, unknown>, summary?: string[]): ImplementCommandResult {
  return { ok, action: `supervisor:${action}`, exitCode: ok ? 0 : 1, message, ...(detail !== undefined ? { detail } : {}), ...(summary !== undefined ? { summary } : {}) };
}
export function currentObserverIdentity(env: NodeJS.ProcessEnv = process.env, herdr: HerdrEnvironment = {}): { identity: ObserverIdentity | null; problem: string | null } {
  const paneId = env["HERDR_PANE_ID"]?.trim() ?? "";
  if (env["HERDR_ENV"] !== "1" || paneId === "") return { identity: null, problem: "not in a Herdr pane (HERDR_ENV and HERDR_PANE_ID are required to record the Observer's identity)" };
  const looked = getAgent(paneId, herdr);
  if (looked.kind !== "found") return { identity: null, problem: `herdr cannot identify the agent in this pane ${paneId}: ${looked.detail}` };
  const agent = looked.agent;
  if (agent.sessionId === null || agent.terminalId === null) return { identity: null, problem: `herdr reports no session UUID or terminal id for pane ${paneId}; the Observer cannot be recorded, so delivery could never be verified` };
  return { identity: { runtime: agent.kind, sessionId: agent.sessionId, terminalId: agent.terminalId, paneId, hostScope: env["HERDR_SOCKET_PATH"]?.trim() || "default", recordedAt: nowIso() }, problem: null };
}

function sameObserverAuthority(left: ObserverIdentity, right: ObserverIdentity): boolean {
  return recipientAuthorityKey(left) === recipientAuthorityKey(right);
}

export function supervisorStatusView(env: NodeJS.ProcessEnv, _herdr: HerdrEnvironment = {}): { ok: boolean; lines: string[]; detail: Record<string, unknown> } {
  const file = indexPath(env);
  const problems: string[] = [];
  let entries: ReturnType<typeof readIndex>["entries"] = [];
  try { entries = readIndex(file).entries; } catch (error) { problems.push(error instanceof Error ? error.message : String(error)); }
  const runs = entries.map((entry) => {
    const base = { slug: path.basename(path.dirname(entry.statePath)), statePath: entry.statePath, runInstanceId: entry.runInstanceId, observer: null as string | null, implementor: null as string | null, watch: null as WatchView | null, active: true, problem: null as string | null };
    try {
      const raw = JSON.parse(fs.readFileSync(entry.statePath, "utf8")) as { projectRoot?: unknown };
      if (typeof raw.projectRoot !== "string") throw new Error("run has no projectRoot");
      const state = loadState(raw.projectRoot, { state: entry.statePath }).state;
      const current = state.pendingDispatch ?? state.supervision ?? null;
      if (state.status !== "active" || current?.runInstanceId !== entry.runInstanceId) return { ...base, active: false };
      const recorded = state.supervision?.hide;
      if (recorded === undefined) return { ...base, slug: state.topicSlug, problem: "registration incomplete; recover dispatch --resume-handoff from the recorded Observer" };
      return { ...base, slug: state.topicSlug, observer: recorded.observer, implementor: recorded.implementor, watch: showParticipant(recorded.implementor, env).value.watch };
    } catch (error) { return { ...base, problem: error instanceof Error ? error.message : String(error) }; }
  }).filter((run) => run.active);
  for (const run of runs) if (run.problem !== null) problems.push(`${run.slug}: ${run.problem}`);
  return { ok: problems.length === 0, detail: { indexPath: file, healthProblems: problems, runs }, lines: [
    "Supervision: Hide delivery and inactivity watches",
    `Registered runs: ${runs.length}`,
    ...runs.map((run) => `  ${run.slug} ${run.runInstanceId}: Observer ${run.observer ?? "unrecorded"}; implementor ${run.implementor ?? "unrecorded"}; ${run.problem !== null ? run.problem : run.watch === null ? "no active watch" : `watch ${run.watch.id} generation ${run.watch.generation}; warnings ${run.watch.warning_count}`}`),
    ...problems.map((problem) => `ATTENTION: ${problem}`),
  ] };
}

export interface SupervisorCommandHooks { afterHandoverPersist?: () => void; herdr?: HerdrEnvironment }
function handover(projectRoot: string, args: SupervisorArgs, env: NodeJS.ProcessEnv, hooks: SupervisorCommandHooks): ImplementCommandResult {
  if (currentHerdrRole(env) === "implementor") throw new Error("a marked implementor pane cannot become the Observer");
  const approval = flag(args, "approval")?.trim() ?? "";
  if (approval === "" || Buffer.byteLength(approval) > 256 || /[\x00-\x1f\x7f]/.test(approval)) throw new Error("handover requires nonempty --approval text, at most 256 bytes without control characters");
  const statePath = resolveStatePath(projectRoot, { ...(flag(args, "slug") === undefined ? {} : { slug: flag(args, "slug") }), ...(flag(args, "state") === undefined ? {} : { state: flag(args, "state") }) });
  const registry = indexPath(env);
  const expectedRegistrationId = captureRegistrationGeneration(registry, statePath);
  const expectedStateBytes = fs.readFileSync(statePath, "utf8");
  const { state } = loadState(projectRoot, { state: statePath });
  const supervision = state.supervision ?? null;
  const pending = state.pendingDispatch ?? null;
  if (supervision === null && pending === null) throw new Error(`run ${state.topicSlug} was never dispatched under Herdr`);
  if (state.status !== "active") throw new Error(`run ${state.topicSlug} is ${state.status}; a finished run is not handed over`);
  if (state.activeVerification !== undefined) throw new Error(`verification still active: ${state.activeVerification.attemptId}; handover changed nothing`);
  const native = currentObserverIdentity(env, hooks.herdr ?? { env });
  if (native.identity === null) throw new Error(native.problem ?? "cannot read this pane's identity");
  const observer = native.identity;
  const looked = getAgent(observer.paneId, hooks.herdr ?? { env });
  if (looked.kind !== "found" || looked.agent.sessionId !== observer.sessionId || looked.agent.terminalId !== observer.terminalId) throw new Error("new Observer native identity changed; handover changed nothing");
  const registration = { identity: observer, name: observerParticipantName(looked.agent.name, observer.sessionId) };
  let coordinated: { observer: string; watch: WatchView | null } | null = null;
  if (supervision !== null) {
    if (supervision.hide === undefined) throw new Error(`run ${state.topicSlug} has incomplete Hide registration; the current Observer must first recover dispatch --resume-handoff`);
    try { coordinated = handoverRun(supervision.hide.implementor, registration, approval, env); }
    catch (error) { if (error instanceof HideCallFailed) throw new Error(`${error.message}; the handover was not recorded`); throw error; }
  } else {
    try { checkObserver(registration, env); }
    catch (error) { if (error instanceof HideCallFailed) throw new Error(`${error.message}; planned recovery handover was not recorded`); throw error; }
  }
  const at = nowIso();
  const transfer = { at, from: supervision?.observer ?? pending!.observer, to: observer, approval };
  if (supervision !== null) {
    supervision.handovers = [...supervision.handovers, transfer]; supervision.observer = observer;
    supervision.hide = { ...supervision.hide!, observer: coordinated!.observer };
  }
  if (pending !== null) { pending.handovers = [...(pending.handovers ?? []), transfer]; pending.observer = observer; }
  recordEvent(state, { kind: "handover", actor: "human", subject: null, summary: `Observer handed over to session ${observer.sessionId} in ${observer.paneId}`, at });
  if (fs.readFileSync(statePath, "utf8") !== expectedStateBytes) throw new Error("run changed during Hide handover; Sasu state was not overwritten; inspect the current run and retry the same approved handover");
  persistState(statePath, state);
  hooks.afterHandoverPersist?.();
  reconcileRegistrationAuthority(registry, { statePath, expectedRegistrationId, readAuthority: () => {
    const current = loadState(projectRoot, { state: statePath }).state;
    const active = current.pendingDispatch ?? current.supervision ?? null;
    return current.status !== "active" || active === null ? null : { runInstanceId: active.runInstanceId, recipientAuthorityKey: recipientAuthorityKey(active.observer) };
  }, at, cause: "approved Observer handover" });
  const current = loadState(projectRoot, { state: statePath }).state;
  const recordedObserver = (current.pendingDispatch ?? current.supervision)?.observer;
  if (recordedObserver === undefined || !sameObserverAuthority(recordedObserver, observer)) throw new Error("handover authority changed after persistence; retry against the current run");
  const watchState = coordinated === null ? "partial dispatch recovery authority transferred" : coordinated.watch === null ? "no active Hide watch; the completed watch was not restarted" : `Hide watch ${coordinated.watch.id} assigned before Sasu state changed`;
  return result("handover", true, `${state.topicSlug}: ${watchState}`, { observer, hide: coordinated, pendingPhase: current.pendingDispatch?.phase ?? null });
}
export async function runSupervisorCommand(projectRoot: string, args: SupervisorArgs, env: NodeJS.ProcessEnv = process.env, hooks: SupervisorCommandHooks = {}): Promise<ImplementCommandResult> {
  const subcommand = args.positional[1];
  try {
    if (subcommand === "status") { const view = supervisorStatusView(env); return result("status", view.ok, view.ok ? "registered runs are readable" : "registered runs need attention", view.detail, view.lines); }
    if (subcommand === "handover") return handover(projectRoot, args, env, hooks);
    return { ok: false, action: `supervisor:${subcommand ?? "unknown"}`, exitCode: 2, message: "unknown supervisor subcommand; use status or handover" };
  } catch (error) { return { ok: false, action: `supervisor:${subcommand ?? "unknown"}`, exitCode: 2, message: error instanceof Error ? error.message : String(error) }; }
}
export function newRunInstanceId(): string { return crypto.randomUUID(); }
