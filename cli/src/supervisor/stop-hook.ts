import fs from "node:fs";
import { parseImplementState } from "../implement/store";
import { currentHerdrRole, currentSessionId } from "../runs/session";
import { readIndex } from "./index";
import { installLaunchAgent, kickstart, launchAgentStatus, type LaunchAgentSpec, type LaunchdEnvironment } from "./launchd";
import { indexPath } from "./paths";

/**
 * The Observer Stop hook confirms a handover; it does not supervise (D-10).
 *
 * Stop runs only on a normal turn end, never on a crash or an interrupt, so
 * nothing here may be load-bearing: the tick has been watching since
 * dispatch (B1) and keeps watching whatever this hook does. What the hook
 * adds is immediacy - when the Observer that owns a supervised run ends its
 * turn, launchd is asked to run a tick now instead of at the next interval -
 * and a sanity check that the LaunchAgent is actually loaded. It never
 * returns `block` and always exits 0 (B13).
 */
export interface StopPayload { session_id?: unknown; hook_event_name?: unknown }

export type StopOutcome =
  | { action: "noop"; reason: string }
  | { action: "confirmed"; runs: string[]; launchAgent: "loaded" | "bootstrapped" | "missing" | "failed"; kicked: boolean; detail: string | null };

export interface StopDependencies {
  env?: NodeJS.ProcessEnv;
  launchd?: LaunchdEnvironment;
  /** The spec a missing-but-installable agent would be bootstrapped from; null when the hook may not install. */
  spec?: LaunchAgentSpec | null;
}

export function handleStop(payload: StopPayload, dependencies: StopDependencies = {}): StopOutcome {
  const env = dependencies.env ?? process.env;
  if (currentHerdrRole(env) === "implementor") return { action: "noop", reason: "implementor marker present; the implementor's turn end is not a handover" };
  if (env["HERDR_ENV"] !== "1") return { action: "noop", reason: "not a Herdr session; inline runs are not supervised" };
  const session = typeof payload.session_id === "string" ? currentSessionId({ CLAUDE_SESSION_ID: payload.session_id }) : null;
  if (session === null) return { action: "noop", reason: "no session_id on stdin" };
  let index;
  try { index = readIndex(indexPath(env)); } catch (error) { return { action: "noop", reason: `supervisor index unreadable: ${error instanceof Error ? error.message : String(error)}` }; }
  const runs: string[] = [];
  for (const entry of index.entries) {
    try {
      const state = parseImplementState(fs.readFileSync(entry.statePath, "utf8"));
      if (state.supervision?.observer.sessionId === session) runs.push(state.topicSlug);
    } catch {
      // An unreadable run is the tick's to report; the hook only matches identities.
    }
  }
  if (runs.length === 0) return { action: "noop", reason: "this session is not the recorded Observer of any indexed run" };
  const launchd = dependencies.launchd ?? { env };
  const status = launchAgentStatus(launchd);
  if (status.loaded === true) {
    const kick = kickstart(launchd);
    return { action: "confirmed", runs, launchAgent: "loaded", kicked: kick.ok, detail: kick.detail };
  }
  if (!status.installed || dependencies.spec === null || dependencies.spec === undefined) {
    return { action: "confirmed", runs, launchAgent: "missing", kicked: false, detail: `LaunchAgent not ${status.installed ? "loaded" : "installed"} at ${status.plistPath}; run the harness installer, the tick is not running` };
  }
  const installed = installLaunchAgent(dependencies.spec, launchd);
  if (installed.problem !== null) return { action: "confirmed", runs, launchAgent: "failed", kicked: false, detail: installed.problem };
  const kick = kickstart(launchd);
  return { action: "confirmed", runs, launchAgent: "bootstrapped", kicked: kick.ok, detail: kick.detail };
}
