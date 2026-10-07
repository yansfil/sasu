/**
 * Native session keys select the interview transcript only.
 * Implementation records and run navigation never depend on them.
 * tests/helpers/session_env.mjs mirrors the keys for test spawn hygiene.
 */
export const SESSION_ID_ENV_KEYS = [
  "CODEX_SESSION_ID",
  "CODEX_THREAD_ID",
  "CLAUDE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ID",
] as const;

/**
 * Keep transcript session matching consistent across native runtime key names.
 */
export function currentSessionId(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const key of SESSION_ID_ENV_KEYS) {
    const value = env[key]?.trim() ?? "";
    if (value !== "") return value.replace(/[^A-Za-z0-9._-]/g, "-");
  }
  return null;
}
