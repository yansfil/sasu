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
 *
 * Every argv below was measured against herdr 0.8.2 on 2026-09-07, after all
 * three holes were found dead against a herdr that was answering normally.
 * See AGENT_LIST_ARGV for the single flag that caused it.
 */
export type HerdrHole = "spawn" | "read" | "alive";

/**
 * The pane this process occupies. A dispatch splits it so the implementor
 * lands beside the supervisor that asked for it, which makes it the spawn
 * hole's own precondition and nothing else's: a missing value closes `spawn`
 * alone and leaves pane diagnosis and liveness open.
 */
const PANE_ID_ENV_KEY = "HERDR_PANE_ID";

/**
 * The structural Implementor marker, injected when the pane is created.
 *
 * It cannot move into the handoff text. An unmarked pane routes as a
 * supervisor and may dispatch recursively, and a marker that lives only in a
 * prompt is a request for discipline rather than a guard (AGENTS.md Review
 * Guide 7). This is what forces the split-then-start dispatch below.
 */
const ROLE_ENV_MARKER = "SASU_HERDR_ROLE=implementor";

/**
 * One argv for listing agents, shared by the capability probe and the
 * liveness hole.
 *
 * Both used to spell it themselves and both spelled it `agent list --json`,
 * which herdr 0.8.2 rejects with exit 2: `agent list` already prints JSON and
 * defines no `--json` flag (measured 2026-09-07). Because the probe is what
 * every hole consults first, that one wrong flag reported spawn, read AND
 * alive unavailable in a session where herdr was answering fine - the whole
 * adapter was dead and its unit tests, which mock `run`, could not see it.
 * One constant so the two callers cannot drift apart again.
 */
const AGENT_LIST_ARGV = ["agent", "list"];

/**
 * The herdr this adapter's argv was measured against. Reported only when herdr
 * rejects a call, so the failure can name what moved instead of leaving a
 * reader to diff two CLIs by hand.
 */
const ADAPTER_TARGET = { version: "0.8.2", protocol: "21" };

/**
 * herdr's own signal that it did not understand the call.
 *
 * This distinction is the guard. The probe used to call every non-zero exit
 * "present but not answering", so when `agent list --json` was rejected -
 * herdr answering perfectly, this adapter's flag wrong - the harness blamed
 * herdr, `sasu implement status` repeated the blame, and nobody suspected the
 * adapter. An adapter has to be able to say "I am the one who is out of date"
 * (2026-09-07). Measured: argv rejection exits 2 with a `usage:` line, a
 * working call exits 0, and neither is how an absent server fails.
 */
function isArgvRejection(probe: { status: number | null; stdout: string; stderr: string }): boolean {
  if (probe.status !== 2) return false;
  return /(^|\n)\s*usage:/i.test(`${probe.stderr}${probe.stdout}`);
}

/**
 * Read the installed herdr's version and protocol. Called only on the
 * rejection path: the happy path must not pay two extra subprocesses for a
 * string nobody reads.
 */
function installedHerdr(run: NonNullable<HerdrEnvironment["run"]>): string {
  const version = run(["--version"]).stdout.trim();
  const protocol = /protocol:\s*(\S+)/.exec(run(["api", "schema"]).stdout)?.[1] ?? "an unreported protocol";
  return `${version === "" ? "an unreported version" : version}, protocol ${protocol}`;
}

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
  const probe = run([...AGENT_LIST_ARGV]);
  if (probe.status !== 0) {
    const call = `herdr ${AGENT_LIST_ARGV.join(" ")}`;
    const reason = isArgvRejection(probe)
      ? `herdr rejected this adapter's own call (\`${call}\` exited 2 with a usage line), so the herdr contract moved and THIS ADAPTER is out of date, not herdr: cli/src/implement/herdr.ts was measured against herdr ${ADAPTER_TARGET.version} protocol ${ADAPTER_TARGET.protocol} and the installed herdr reports ${installedHerdr(run)}. Re-measure its argv against \`herdr <subcommand> --help\`; the unit suite's contract test makes the same comparison`
      : `herdr is present but not answering (\`${call}\` exited ${probe.status ?? "without status"}); the supervisor keeps its event wake-up and verb channel, and loses pane diagnosis`;
    return { available: false, holes: { spawn: false, read: false, alive: false }, reason };
  }
  if (paneId(env) === "") {
    return {
      available: false,
      holes: { spawn: false, read: true, alive: true },
      reason: `herdr is answering but ${PANE_ID_ENV_KEY} is unset, so a dispatch has no pane to split; pane diagnosis and liveness still work, and starting a replacement is the supervisor's to perform by hand`,
    };
  }
  return { available: true, holes: { spawn: true, read: true, alive: true }, reason: null };
}

function paneId(env: NodeJS.ProcessEnv): string {
  return env[PANE_ID_ENV_KEY]?.trim() ?? "";
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

/**
 * One agent as herdr 0.8.2 reports it.
 *
 * `name` appears only on agents started under a name, and the status field is
 * spelled `agent_status` - not `status`, which this adapter used to read and
 * therefore always found undefined.
 */
interface AgentEntry {
  name?: string;
  agent?: string;
  agent_status?: string;
  pane_id?: string;
}

function listAgents(run: NonNullable<HerdrEnvironment["run"]>): { agents: AgentEntry[]; problem: string | null } {
  const executed = run([...AGENT_LIST_ARGV]);
  if (executed.status !== 0) {
    return { agents: [], problem: `herdr ${AGENT_LIST_ARGV.join(" ")} failed (${executed.status ?? "no status"})` };
  }
  const parsed = parseJson(executed.stdout) as { result?: { agents?: AgentEntry[] } } | null;
  return { agents: parsed?.result?.agents ?? [], problem: null };
}

/**
 * Native launch arguments for the agent kind being started.
 *
 * herdr passes everything after `--` straight to the agent executable, so the
 * translation is per-CLI and measured rather than guessed (2026-09-07):
 * `claude --model <m> --effort <level>`, `codex --model <m> -c
 * model_reasoning_effort="<level>"`.
 */
function nativeAgentArgs(kind: string, model?: string, effort?: string): string[] {
  const args: string[] = [];
  if (model !== undefined && model !== "") args.push("--model", model);
  if (effort !== undefined && effort !== "") {
    if (kind === "codex") args.push("--config", `model_reasoning_effort="${effort}"`);
    else args.push("--effort", effort);
  }
  return args.length === 0 ? [] : ["--", ...args];
}

export interface SpawnRequest {
  name: string;
  cwd: string;
  prompt: string;
  /** Defaults to the kind of the agent occupying the dispatching pane. */
  kind?: string;
  model?: string;
  effort?: string;
}

export interface SpawnResult {
  paneId: string;
  name: string;
  kind: string;
}

/**
 * Hole 1: start an implementor agent beside the supervisor.
 *
 * Three calls, because herdr 0.8.2 splits the two things a dispatch needs
 * across two commands (measured 2026-09-07): `agent new` is atomic and can
 * record parent lineage with `--from-pane`, but defines no `--env`; only
 * `pane split` can set an environment variable on the launched shell. The
 * role marker is a correctness guard and lineage is an audit convenience, so
 * the marker wins and the implementor is created by split-then-start. The
 * cost is real and known: the dispatched agent does not appear under its
 * supervisor in herdr's agent tree.
 *
 * The pane is created first and the agent started second, so a failure after
 * the split would strand an empty pane. It is closed on that path rather than
 * left behind; a pane whose agent did start is never closed automatically,
 * because the supervisor needs to look at it.
 */
export function spawnImplementor(
  input: SpawnRequest,
  environment: HerdrEnvironment = {},
): HoleResult<SpawnResult> {
  const capabilities = herdrCapabilities(environment);
  if (!capabilities.holes.spawn) return { ok: false, value: null, problem: `spawn unavailable: ${capabilities.reason}` };
  const run = environment.run ?? defaultRun;
  const dispatcher = paneId(environment.env ?? process.env);

  // The kind is the dispatching pane's own agent unless overridden: a
  // supervisor dispatches its own kind by default, and herdr requires --kind
  // on both `agent new` and `agent start`, so there is no "detect it for me".
  let kind = input.kind ?? "";
  if (kind === "") {
    const listed = listAgents(run);
    if (listed.problem !== null) return { ok: false, value: null, problem: listed.problem };
    kind = listed.agents.find((entry) => entry.pane_id === dispatcher)?.agent ?? "";
    if (kind === "") {
      return { ok: false, value: null, problem: `cannot detect the agent kind of the dispatching pane ${dispatcher}; pass an explicit kind` };
    }
  }

  const split = run(["pane", "split", "--pane", dispatcher, "--direction", "right", "--cwd", input.cwd, "--env", ROLE_ENV_MARKER, "--no-focus"], input.cwd);
  if (split.status !== 0) {
    return { ok: false, value: null, problem: `herdr pane split from ${dispatcher} failed (${split.status ?? "no status"}): ${(split.stderr || split.stdout).trim()}` };
  }
  const created = (parseJson(split.stdout) as { result?: { pane?: { pane_id?: string } } } | null)?.result?.pane?.pane_id ?? "";
  if (created === "") {
    return { ok: false, value: null, problem: "herdr pane split reported no pane id; refusing to start an implementor into an unknown pane" };
  }

  const started = run(["agent", "start", input.name, "--kind", kind, "--pane", created, ...nativeAgentArgs(kind, input.model, input.effort)], input.cwd);
  if (started.status !== 0) {
    const closed = run(["pane", "close", created]);
    const cleanup = closed.status === 0 ? "the empty pane was closed" : `the empty pane ${created} could not be closed (${closed.status ?? "no status"}) and is still open`;
    return { ok: false, value: null, problem: `herdr agent start ${input.name} --kind ${kind} in ${created} failed (${started.status ?? "no status"}): ${(started.stderr || started.stdout).trim()}; ${cleanup}` };
  }

  const prompted = run(["agent", "prompt", input.name, input.prompt], input.cwd);
  if (prompted.status !== 0) {
    // The prompt carries the whole handoff in one argv entry, and a failing
    // wrapper may echo argv. Never retain output for this call: it would
    // write the operator's verbatim context into the supervisor's log. The
    // started pane stays open - the agent is alive and the supervisor can
    // hand it the packet itself.
    return { ok: false, value: null, problem: `herdr agent prompt ${input.name} <redacted prompt> failed (${prompted.status ?? "no status"}); the implementor is running in ${created} with no handoff` };
  }
  return { ok: true, value: { paneId: created, name: input.name, kind }, problem: null };
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

/**
 * Hole 3: is this agent still running?
 *
 * Presence in the list is the whole answer. herdr 0.8.2's AgentStatus enum is
 * idle | working | blocked | done | unknown - none of which means dead, and a
 * dead agent simply leaves the list (measured 2026-09-07). This used to test
 * `status !== "exited"` against a field that is spelled `agent_status` and a
 * value that never occurs, so every listed agent and every typo answered
 * "alive".
 */
export function isAgentAlive(
  input: { name: string },
  environment: HerdrEnvironment = {},
): HoleResult<boolean> {
  const capabilities = herdrCapabilities(environment);
  if (!capabilities.holes.alive) return { ok: false, value: null, problem: `alive unavailable: ${capabilities.reason}` };
  const listed = listAgents(environment.run ?? defaultRun);
  if (listed.problem !== null) return { ok: false, value: null, problem: listed.problem };
  return { ok: true, value: listed.agents.some((entry) => entry.name === input.name), problem: null };
}
