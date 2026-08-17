/**
 * Which agent session is issuing this command. One resolver, one key list:
 * the 2026-08-12 pokemon-rpg-run-1 incident began because `init` carried its
 * own inline copy of this list that omitted CLAUDE_CODE_SESSION_ID, so the
 * run started unowned and a bystander session's first bare write claimed it.
 * tests/helpers/session_env.mjs and skills/ship/scripts/prd_ship.js mirror
 * this list for spawn hygiene and standalone installs; change all together.
 */
export const SESSION_ID_ENV_KEYS = [
  "CODEX_SESSION_ID",
  "CODEX_THREAD_ID",
  "CLAUDE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ID",
] as const;

/**
 * Sanitized so the id can double as a pointer filename; every comparison and
 * record uses the sanitized form so identity and storage never diverge.
 */
export function currentSessionId(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const key of SESSION_ID_ENV_KEYS) {
    const value = env[key]?.trim() ?? "";
    if (value !== "") return value.replace(/[^A-Za-z0-9._-]/g, "-");
  }
  return null;
}
