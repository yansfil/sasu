import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/** Hide owns native identities and relationships. These views are never run state. */
export class HideCallFailed extends Error {
  constructor(message: string, readonly code: string | null) { super(message); this.name = "HideCallFailed"; }
}

export const HIDE_MISSING = "hide is not on PATH; open Hide and use its installed hide CLI, then retry";

export function runHide(argv: string[], env: NodeJS.ProcessEnv = process.env, timeout = 30_000): { stdout: string; stderr: string; status: number | null } {
  // An inherited pane credential can expire while the native session remains
  // current (hide#709). Each public call bootstraps its own short-lived authority.
  const childEnv = { ...env };
  delete childEnv["HIDE_CAP_REF"];
  const run = spawnSync("hide", argv, { encoding: "utf8", timeout, maxBuffer: 1024 * 1024, env: childEnv, shell: false });
  if (run.error) {
    const code = (run.error as NodeJS.ErrnoException).code ?? "execution_failed";
    if (code === "ENOENT") throw new HideCallFailed(HIDE_MISSING, "not_installed");
    throw new HideCallFailed(`hide ${argv.slice(0, 2).join(" ")} could not finish (${code}); check Hide and retry from the current agent pane`, code);
  }
  return { stdout: run.stdout ?? "", stderr: run.stderr ?? "", status: run.status };
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const textField = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function call(argv: string[], env: NodeJS.ProcessEnv): unknown {
  const run = runHide(argv, env);
  let wire: unknown;
  try { wire = JSON.parse(run.stdout); } catch { /* Refuse an unsupported public response below. */ }
  if (!record(wire)) throw new HideCallFailed("hide did not answer with a JSON object; check the installed Hide CLI and retry", "invalid_response");
  if (wire.ok !== true || run.status !== 0) {
    const code = textField(wire.reason) ? wire.reason : record(wire.error) && textField(wire.error.code) ? wire.error.code : "command_failed";
    throw new HideCallFailed(`hide ${argv.slice(0, 2).join(" ")} refused (${code}); check Hide and retry from the current agent pane`, code);
  }
  if (!("value" in wire)) throw new HideCallFailed("hide returned no value; check the installed Hide CLI and retry", "invalid_response");
  return wire.value;
}

/** Only the public fields needed to decide run roles cross this boundary. */
export interface ParticipantView {
  id: string;
  name: string;
  machine: string;
  hostScope: string;
  pane: string;
  parent: string | null;
  project: string | null;
  runtime: "running" | "ended";
  registered: boolean;
}

function participantView(value: unknown): ParticipantView {
  if (!record(value) || !["id", "name", "machine", "hostScope", "pane"].every((key) => textField(value[key]))
    || !(value.parent === null || textField(value.parent)) || !(value.project === null || textField(value.project))
    || !["running", "ended"].includes(String(value.runtime)) || typeof value.registered !== "boolean") {
    throw new HideCallFailed("hide returned an unusable participant; inspect Hide registrations before retrying", "invalid_response");
  }
  const { id, name, machine, hostScope, pane, parent, project, runtime, registered } = value;
  return { id, name, machine, hostScope, pane, parent, project, runtime, registered } as ParticipantView;
}

export function listParticipants(env: NodeJS.ProcessEnv = process.env): ParticipantView[] {
  const value = call(["agent", "list"], env);
  if (!record(value) || !Array.isArray(value.items)) throw new HideCallFailed("hide returned an unusable agent list; check the installed Hide CLI and retry", "invalid_response");
  return value.items.map(participantView);
}

function live(participant: ParticipantView): boolean { return participant.registered && participant.runtime === "running"; }
function sameProject(participant: ParticipantView, projectRoot: string): boolean {
  if (participant.project === null) return false;
  if (path.resolve(participant.project) === path.resolve(projectRoot)) return true;
  try { return fs.realpathSync(participant.project) === fs.realpathSync(projectRoot); }
  catch { throw new HideCallFailed("the run child's checkout identity cannot be resolved; restore its checkout before retrying", "project_identity_required"); }
}

function currentParticipant(env: NodeJS.ProcessEnv): ParticipantView {
  // The public caller endpoint owns identity resolution and works without a
  // renderer. Sasu consumes its answer, never selects a caller from the list.
  const caller = participantView(call(["agent", "show", "here"], env));
  if (!live(caller)) throw new HideCallFailed("the current Hide registration is not live; inspect Hide registrations before retrying", "caller_identity_required");
  return caller;
}

function rejectRunChild(caller: ParticipantView, names: string[], projectRoot: string): void {
  if (!names.includes(caller.name) || !sameProject(caller, projectRoot)) return;
  if (caller.parent === null) throw new HideCallFailed("the named run child has no Hide parent; repair its lineage before retrying", "parent_identity_required");
  throw new HideCallFailed("this pane is a run child in Hide; its Observer must run this command", "observer_required");
}

/** Standalone gates work without Hide; a managed caller must have live context. */
export function assertNotImplementor(runs: Array<{ implementorName?: string; projectRoot: string }>, env: NodeJS.ProcessEnv = process.env): void {
  if (env["HERDR_ENV"] !== "1" && !env["HERDR_PANE_ID"]?.trim()) return;
  const caller = currentParticipant(env);
  for (const run of runs) {
    if (run.implementorName !== undefined) rejectRunChild(caller, [run.implementorName], run.projectRoot);
  }
}

/** A lead may parent the Observer. Only this run's child relationship matters. */
export function assertObserverForRun(input: { implementorName?: string; projectRoot: string }, env: NodeJS.ProcessEnv = process.env): void {
  const caller = currentParticipant(env);
  if (input.implementorName === undefined) return;
  rejectRunChild(caller, [input.implementorName], input.projectRoot);
  const participants = listParticipants(env);
  // Names and filesystem paths only identify a child within the caller's
  // attested device and host. Never resolve another device's path locally.
  const children = participants.filter((participant) => live(participant)
    && participant.machine === caller.machine && participant.hostScope === caller.hostScope
    && participant.name === input.implementorName && sameProject(participant, input.projectRoot));
  if (children.length > 1) throw new HideCallFailed("the run child is ambiguous in Hide; inspect registrations before retrying", "parent_identity_required");
  if (children.length === 1 && children[0]!.parent !== caller.id) throw new HideCallFailed("Hide names another parent for this run child; retry from its Observer pane", "observer_required");
}
