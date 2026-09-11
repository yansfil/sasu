import { spawn, spawnSync } from "node:child_process";

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
 * One argv for listing agents, shared by diagnostics, kind detection and
 * the liveness hole.
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
  /** Wall clock and blocking sleep; injected by tests, so a 30 s wait costs a test nothing. */
  clock?: HerdrClock;
}

export interface HerdrClock {
  now(): number;
  sleep(ms: number): void;
}

function defaultRun(args: string[], cwd?: string): { status: number | null; stdout: string; stderr: string } {
  const executed = spawnSync("herdr", args, { cwd, encoding: "utf8", shell: false, timeout: 15_000 });
  if (executed.error !== undefined) return { status: null, stdout: "", stderr: String(executed.error) };
  return { status: executed.status, stdout: executed.stdout ?? "", stderr: executed.stderr ?? "" };
}

const defaultClock: HerdrClock = {
  now: () => Date.now(),
  // The adapter is synchronous end to end (spawnSync), so the wait between
  // two start attempts is a blocking sleep, the same idiom gates/store.ts
  // uses for its lock backoff.
  sleep: (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); },
};

/** The structured code herdr prints on stderr when it refuses a call, or null when it printed none. */
function herdrErrorCode(stderr: string): string | null {
  const parsed = parseJson(stderr) as { error?: { code?: unknown } } | null;
  return typeof parsed?.error?.code === "string" ? parsed.error.code : null;
}

/**
 * How long a dispatch keeps retrying `agent start` on `agent_pane_busy`.
 *
 * A split pane's zsh takes a few seconds to read its profile and print a
 * prompt, and herdr accepts a pane as an agent target only once it has seen
 * that interactive prompt. Measured 2026-09-10 (herdr 0.8.2): that moment
 * comes several seconds after `pane process-info` first reports a bare shell,
 * so a start issued straight after the split was refused twice in a row with
 * `agent_pane_busy: agent target pane is not an available shell`, and the
 * dispatch closed an empty pane that would have been ready moments later.
 * herdr's own acceptance is the only reliable readiness signal, so exactly
 * that refusal is retried once a second for up to 30 s; any other failure
 * surfaces at once. Task Factory's dispatcher started its pilot Observer the
 * same day with this shape and never missed.
 */
const AGENT_START_BUSY_RETRY_MS = 1_000;
const AGENT_START_BUSY_TIMEOUT_MS = 30_000;

export function environmentCapabilities(environment: HerdrEnvironment): HerdrCapabilities {
  const env = environment.env ?? process.env;
  if (env["HERDR_ENV"] !== "1") {
    return {
      available: false,
      holes: { spawn: false, read: false, alive: false },
      reason: "not running under herdr (HERDR_ENV is not 1); the supervisor keeps its event wake-up and verb channel, and loses pane diagnosis",
    };
  }
  if (paneId(env) === "") {
    return {
      available: false,
      holes: { spawn: false, read: true, alive: true },
      reason: `herdr is configured but ${PANE_ID_ENV_KEY} is unset, so a dispatch has no pane to split; pane diagnosis and liveness still work, and starting a replacement is the supervisor's to perform by hand`,
    };
  }
  return { available: true, holes: { spawn: true, read: true, alive: true }, reason: null };
}

/** Diagnostic probe only; no operation depends on another operation succeeding. */
export function herdrCapabilities(environment: HerdrEnvironment = {}): HerdrCapabilities {
  const base = environmentCapabilities(environment);
  if (!base.holes.read) return base;
  const run = environment.run ?? defaultRun;
  const probe = run([...AGENT_LIST_ARGV]);
  if (probe.status !== 0) {
    const call = `herdr ${AGENT_LIST_ARGV.join(" ")}`;
    const reason = isArgvRejection(probe)
      ? `herdr rejected this adapter's own call (\`${call}\` exited 2 with a usage line), so the herdr contract moved and THIS ADAPTER is out of date, not herdr: cli/src/implement/herdr.ts was measured against herdr ${ADAPTER_TARGET.version} protocol ${ADAPTER_TARGET.protocol} and the installed herdr reports ${installedHerdr(run)}. Re-measure its argv against \`herdr <subcommand> --help\`; the unit suite's contract test makes the same comparison`
      : `herdr is present but not answering (\`${call}\` exited ${probe.status ?? "without status"}); the supervisor keeps its event wake-up and verb channel, and loses agent-list liveness`;
    return { available: false, holes: { ...base.holes, alive: false }, reason: `agent listing unavailable: ${reason}; read and startup keep their own preconditions` };
  }
  const listed = parseJson(probe.stdout) as { result?: { agents?: unknown } } | null;
  if (!Array.isArray(listed?.result?.agents)) {
    return { available: false, holes: { ...base.holes, alive: false }, reason: "agent listing unavailable: invalid agent list; read and startup keep their own preconditions" };
  }
  return base;
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
  const agents = parsed?.result?.agents;
  if (!Array.isArray(agents) || agents.some((entry) => entry === null || typeof entry !== "object"
    || (entry.name !== undefined && typeof entry.name !== "string")
    || (entry.pane_id !== undefined && typeof entry.pane_id !== "string")
    || (entry.agent !== undefined && typeof entry.agent !== "string"))) {
    return { agents: [], problem: "herdr agent list returned an invalid agent list; liveness is unknown" };
  }
  return { agents, problem: null };
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
 * the split may leave either an empty shell or a blocked live agent. Only a
 * positively observed empty shell is closed automatically,
 * because the supervisor needs to look at it.
 */
export function spawnImplementor(
  input: SpawnRequest,
  environment: HerdrEnvironment = {},
): HoleResult<SpawnResult> {
  const capabilities = environmentCapabilities(environment);
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

  const startArgv = ["agent", "start", input.name, "--kind", kind, "--pane", created, ...nativeAgentArgs(kind, input.model, input.effort)];
  const clock = environment.clock ?? defaultClock;
  const firstStartAt = clock.now();
  let started = run(startArgv, input.cwd);
  let busyRetries = 0;
  while (started.status !== 0 && herdrErrorCode(started.stderr) === "agent_pane_busy"
    && clock.now() - firstStartAt < AGENT_START_BUSY_TIMEOUT_MS) {
    clock.sleep(AGENT_START_BUSY_RETRY_MS);
    busyRetries += 1;
    started = run(startArgv, input.cwd);
  }
  if (started.status !== 0) {
    // A nonzero startup may leave a live trust dialog (2026-09-07).
    // Only a positively observed shell-only foreground can be cleaned up;
    // an absent name alone does not prove the new pane is empty.
    const code = herdrErrorCode(started.stderr);
    const waited = code === "agent_pane_busy"
      ? `; the pane never became an available shell in ${Math.round((clock.now() - firstStartAt) / 1000)} s (${busyRetries} retries)`
      : "";
    let cleanup = `pane ${created} was retained for inspection; startup state is uncertain, and no handoff was sent`;
    if (code === "agent_not_ready") {
      cleanup = `agent ${input.name} is not ready; pane ${created} was retained for inspection, and no handoff was sent`;
    } else if (started.status !== null) {
      const observed = run(["pane", "process-info", "--pane", created]);
      const parsed = parseJson(observed.stdout) as { result?: { process_info?: {
        pane_id?: string; shell_pid?: number; foreground_process_group_id?: number;
        foreground_processes?: { pid?: number }[];
      } } } | null;
      const info = parsed?.result?.process_info;
      if (observed.status === 0 && info?.pane_id === created
        && Number.isInteger(info.shell_pid) && info.shell_pid! > 0
        && info.foreground_process_group_id === info.shell_pid
        && Array.isArray(info.foreground_processes) && info.foreground_processes.length === 1
        && info.foreground_processes[0]?.pid === info.shell_pid) {
        const closed = run(["pane", "close", created]);
        cleanup = closed.status === 0 ? "the empty pane was closed" : `the empty pane ${created} could not be closed (${closed.status ?? "no status"}) and is still open`;
      }
    }
    return { ok: false, value: null, problem: `herdr agent start ${input.name} --kind ${kind} in ${created} failed (${started.status ?? "no status"}): ${(started.stderr || started.stdout).trim()}${waited}; ${cleanup}` };
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
  const capabilities = environmentCapabilities(environment);
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
  const capabilities = environmentCapabilities(environment);
  if (!capabilities.holes.alive) return { ok: false, value: null, problem: `alive unavailable: ${capabilities.reason}` };
  const listed = listAgents(environment.run ?? defaultRun);
  if (listed.problem !== null) return { ok: false, value: null, problem: listed.problem };
  return { ok: true, value: listed.agents.some((entry) => entry.name === input.name), problem: null };
}


export interface AgentWaitObservation {
  kind: "settled" | "gone" | "unavailable";
  detail: string;
}

/** Only measured meanings cross this boundary; unknown contracts cannot prove loss. */
export function classifyAgentWait(status: number | null, stdout: string, stderr: string): AgentWaitObservation {
  if (status === 0) {
    const parsed = parseJson(stdout) as { result?: { type?: string; agent?: unknown } } | null;
    if (parsed?.result?.type === "agent_info" && parsed.result.agent !== null && typeof parsed.result.agent === "object") {
      return { kind: "settled", detail: "settled was observed, possibly transiently; inspect the target before drawing any conclusion" };
    }
  } else if (status === 1) {
    const parsed = parseJson(stderr) as { error?: { code?: string } } | null;
    const code = parsed?.error?.code;
    if (code === "agent_not_found" || code === "agent_not_running") {
      return { kind: "gone", detail: `watched target can no longer be followed (${code}); it may have moved or changed identity, so inspect before recovery; this does not prove process death` };
    }
    if (code === "timeout") return { kind: "unavailable", detail: "settled was not confirmed before timeout; this does not establish working status" };
    return { kind: "unavailable", detail: `observation unavailable (${code ?? "invalid error JSON"}); event and time monitoring continue` };
  }
  return { kind: "unavailable", detail: `observation unavailable (exit ${status ?? "unknown"}, invalid or unrecognized response); event and time monitoring continue` };
}

/**
 * One long child, bounded by the parent even during protocol negotiation.
 * The server's --timeout starts only after lookup (2026-09-07 investigation).
 * No terminal state authorizes a restart, escalation, or recovery here.
 */
export function waitForAgent(input: { name: string; timeoutMs: number; signal: AbortSignal }): Promise<AgentWaitObservation> {
  return new Promise((resolve) => {
    if (input.signal.aborted) { resolve({ kind: "unavailable", detail: "observation cancelled" }); return; }
    const child = spawn("herdr", ["agent", "wait", input.name, "--timeout", String(Math.max(1, Math.ceil(input.timeoutMs)))], { stdio: ["ignore", "pipe", "pipe"], shell: false });
    let stdout = "";
    let stderr = "";
    let finished = false;
    let stopping: string | null = null;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    // Unmeasured initial safety bounds, not tuning knobs. Revisit from real
    // runs' false wakes/misses and cancellation latency, not screen guesses.
    const killGraceMs = 1_000;
    const outputLimit = 64 * 1024;
    const finish = (observation: AgentWaitObservation): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      input.signal.removeEventListener("abort", abort);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(observation);
    };
    const stop = (detail: string): void => {
      if (finished || stopping !== null) return;
      stopping = detail;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
    };
    const abort = (): void => stop("observation cancelled after another wake or waiter failure");
    const timer = setTimeout(() => stop("observation unavailable: parent lifetime limit reached; settled was not confirmed"), Math.max(1, input.timeoutMs));
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > outputLimit) { stdout = stdout.slice(0, outputLimit); stop("observation unavailable: output limit exceeded"); }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > outputLimit) { stderr = stderr.slice(0, outputLimit); stop("observation unavailable: output limit exceeded"); }
    });
    const outcome = (code: number | null): AgentWaitObservation => stopping === null
      ? classifyAgentWait(code, stdout, stderr) : { kind: "unavailable", detail: stopping };
    child.once("error", (error) => finish({ kind: "unavailable", detail: `observation unavailable: ${error.message}` }));
    child.once("close", (code) => finish(outcome(code)));
    // A descendant retaining a pipe cannot retain the watcher after exit.
    child.once("exit", (code) => {
      drainTimer = setTimeout(() => finish(outcome(code)), killGraceMs);
    });
  });
}
