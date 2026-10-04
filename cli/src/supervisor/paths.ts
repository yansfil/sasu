import os from "node:os";
import path from "node:path";

/** Stable machine-wide registry location also inspected by Hide retirement. */
export function supervisorHome(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env["HOME"]?.trim() || os.homedir(), ".sasu", "supervisor");
}
export function indexPath(env: NodeJS.ProcessEnv = process.env): string { return path.join(supervisorHome(env), "index.json"); }
export const RUN_INSTANCE_ENV_KEY = "SASU_RUN_INSTANCE_ID";
