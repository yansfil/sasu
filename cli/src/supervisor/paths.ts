import os from "node:os";
import path from "node:path";

/**
 * Where the supervisor keeps its one durable file and its logs.
 *
 * Under the user's home rather than any project: the tick watches runs
 * across every repository on the machine, and a per-project location would
 * need a second index of projects. `~/.sasu` is already the harness's
 * machine-wide directory (the checkpoint hook logs there). Tests point
 * `HOME` at a temporary directory, which moves everything here at once.
 */
export function supervisorHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env["HOME"]?.trim() || os.homedir();
  return path.join(home, ".sasu", "supervisor");
}

export function indexPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(supervisorHome(env), "index.json");
}

/** Structured tick and hook events; never prompt bodies or transcripts (D-14). */
export function tickLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(supervisorHome(env), "tick.log");
}

export function hookLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(supervisorHome(env), "stop-hook.log");
}

/** launchd's own stdout/stderr capture for the tick program. */
export function launchdLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(supervisorHome(env), "launchd.log");
}

/**
 * One label per user account: launchd keeps a single instance per label,
 * which is the "exactly one supervisor" guarantee D-03 leans on instead of
 * a lease.
 */
export const LAUNCHD_LABEL = "com.sasu.supervisor";

export function launchAgentPlistPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env["HOME"]?.trim() || os.homedir();
  return path.join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

/**
 * Seconds between ticks. The PRD allows 20-30; the top of the range is
 * chosen because each tick costs one `agent get` per Observer and per
 * Implementor plus a state.json read per run, and the only latency it adds
 * is at most one interval before a wake (B3). Retune from a real run's
 * measurement, not from here.
 */
export const TICK_INTERVAL_SECONDS = 30;
export const TICK_INTERVAL_MS = TICK_INTERVAL_SECONDS * 1000;

/** The variable a dispatched pane carries so its first claim binds to exactly this dispatch (D-04). */
export const RUN_INSTANCE_ENV_KEY = "SASU_RUN_INSTANCE_ID";
