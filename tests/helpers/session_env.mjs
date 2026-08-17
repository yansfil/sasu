// Session-identity hygiene for tests that spawn the harness.
//
// The harness resolves "which session am I?" from the environment
// (cli/src/runs/session.ts SESSION_ID_ENV_KEYS), so a spawn that inherits the
// developer's shell runs as the developer's session. That made suite results
// depend on who ran them: a run bound to "session-a" was mutated without
// refusal by whatever ambient identity happened to be exported, and the
// ownership guard was never actually exercised. Measured 2026-08-12 - 33 tests
// flipped from pass to fail the moment ownership stopped being derived from
// the last writer, because they had been passing on the ambient id.
//
// This list must stay identical to SESSION_ID_ENV_KEYS. Two test files already
// hand-rolled their own copy and both omitted CLAUDE_CODE_SESSION_ID, the one
// Claude Code actually sets - which is why this lives in one place now.
export const SESSION_ENV_KEYS = [
  "CODEX_SESSION_ID",
  "CODEX_THREAD_ID",
  "CLAUDE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ID",
];

/** A copy of `env` with every session-identity variable removed. */
export function stripSessionEnv(env = process.env) {
  const out = { ...env };
  for (const key of SESSION_ENV_KEYS) delete out[key];
  return out;
}

/** A session-stripped environment that declares exactly `sessionId`, or none. */
export function sessionEnv(sessionId = null) {
  const env = stripSessionEnv();
  if (sessionId) env.CLAUDE_CODE_SESSION_ID = sessionId;
  return env;
}
