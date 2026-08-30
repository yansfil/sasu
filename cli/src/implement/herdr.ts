import { spawnSync } from "node:child_process";

/**
 * The entire surface the harness is allowed to touch herdr through.
 *
 * Three holes, no more: start an implementor, read what its pane says, ask
 * whether it is still alive. Everything else the old observer did - routing
 * contracts, PRD gate checks, dispatch, and a 250ms wait loop - is now either
 * a CLI command or gone, because wake-up is owned by the harness's own event
 * log rather than by terminal text (D-16, D-19).
 *
 * herdr is a convenience, never a contract: the harness must work in a bare
 * terminal, under launchd, and in CI. So every hole reports itself
 * unavailable rather than throwing, and the run degrades to "no pane
 * diagnosis" instead of stopping (R9).
 */
export type HerdrHole = "spawn" | "read" | "alive";

export interface HerdrCapabilities {
  available: boolean;
  /** Per-hole availability, so status can name what specifically is missing. */
  holes: Record<HerdrHole, boolean>;
  /** Why the unavailable holes are unavailable, in one human-readable line. */
  reason: string | null;
}

export interface HerdrEnvironment {
  env?: NodeJS.ProcessEnv;
  run?: (args: string[], cwd?: string) => { status: number | null; stdout: string; stderr: string };
}

function defaultRun(args: string[], cwd?: string): { status: number | null; stdout: string; stderr: string } {
  const executed = spawnSync("herdr", args, { cwd, encoding: "utf8", shell: false, timeout: 15_000 });
  if (executed.error !== undefined) return { status: null, stdout: "", stderr: String(executed.error) };
  return { status: executed.status, stdout: executed.stdout ?? "", stderr: executed.stderr ?? "" };
}

export function herdrCapabilities(environment: HerdrEnvironment = {}): HerdrCapabilities {
  const env = environment.env ?? process.env;
  const run = environment.run ?? defaultRun;
  if (env["HERDR_ENV"] !== "1") {
    return {
      available: false,
      holes: { spawn: false, read: false, alive: false },
      reason: "not running under herdr (HERDR_ENV is not 1); the supervisor keeps its event wake-up and verb channel, and loses pane diagnosis",
    };
  }
  const probe = run(["agent", "list", "--json"]);
  if (probe.status !== 0) {
    return {
      available: false,
      holes: { spawn: false, read: false, alive: false },
      reason: `herdr is present but not answering (\`herdr agent list\` exited ${probe.status ?? "without status"}); the supervisor keeps its event wake-up and verb channel, and loses pane diagnosis`,
    };
  }
  return { available: true, holes: { spawn: true, read: true, alive: true }, reason: null };
}

export interface HoleResult<T> {
  ok: boolean;
  value: T | null;
  /** Set when the hole was unavailable or the call failed. */
  problem: string | null;
}

function parseJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed === "") return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** Hole 1: start an implementor agent. */
export function spawnImplementor(
  input: { name: string; cwd: string; prompt: string },
  environment: HerdrEnvironment = {},
): HoleResult<unknown> {
  const capabilities = herdrCapabilities(environment);
  if (!capabilities.holes.spawn) return { ok: false, value: null, problem: `spawn unavailable: ${capabilities.reason}` };
  const run = environment.run ?? defaultRun;
  const executed = run(["agent", "new", input.name, "--cwd", input.cwd, "--prompt", input.prompt], input.cwd);
  if (executed.status !== 0) {
    // The prompt carries the whole handoff in one argv entry, and a failing
    // wrapper may echo argv. Never retain output for this call: it would
    // write the operator's verbatim context into the supervisor's log.
    return { ok: false, value: null, problem: `herdr agent new ${input.name} <redacted prompt> failed (${executed.status ?? "no status"})` };
  }
  return { ok: true, value: parseJson(executed.stdout), problem: null };
}

/** Hole 2: read an agent's recent output, for diagnosis only. */
export function readPane(
  input: { name: string; lines?: number },
  environment: HerdrEnvironment = {},
): HoleResult<string> {
  const capabilities = herdrCapabilities(environment);
  if (!capabilities.holes.read) return { ok: false, value: null, problem: `read unavailable: ${capabilities.reason}` };
  const run = environment.run ?? defaultRun;
  const executed = run(["agent", "read", input.name, "--source", "recent-unwrapped", "--lines", String(input.lines ?? 120)]);
  if (executed.status !== 0) {
    return { ok: false, value: null, problem: `herdr agent read ${input.name} failed (${executed.status ?? "no status"}): ${(executed.stderr || executed.stdout).trim()}` };
  }
  return { ok: true, value: executed.stdout, problem: null };
}

/** Hole 3: is this agent still running? */
export function isAgentAlive(
  input: { name: string },
  environment: HerdrEnvironment = {},
): HoleResult<boolean> {
  const capabilities = herdrCapabilities(environment);
  if (!capabilities.holes.alive) return { ok: false, value: null, problem: `alive unavailable: ${capabilities.reason}` };
  const run = environment.run ?? defaultRun;
  const executed = run(["agent", "list", "--json"]);
  if (executed.status !== 0) {
    return { ok: false, value: null, problem: `herdr agent list failed (${executed.status ?? "no status"})` };
  }
  const parsed = parseJson(executed.stdout) as { result?: { agents?: Array<{ name?: string; status?: string }> } } | null;
  const agents = parsed?.result?.agents ?? [];
  const found = agents.find((entry) => entry.name === input.name);
  return { ok: true, value: found !== undefined && found.status !== "exited", problem: null };
}
