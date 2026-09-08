import fs from "node:fs";
import path from "node:path";
import { executeMechanicalArgv, type MechanicalExecution } from "../mechanical";
import { captureSourceSnapshot } from "./store";
import type { ExecutionTreeFingerprint, ImplementState } from "./types";
import { mechanicalOutcome, type MechanicalOutcome } from "./verdict";

/** The sealed suite is the sole command ledger for implement verification. */
const { commandCompositionDefect } = require("../../lib/prd_parser.js") as { commandCompositionDefect(command: string): string | null };

export const IMPLEMENT_SUITE_TIMEOUT_MS = 10 * 60 * 1000;
const ALLOWED_EXECUTABLES = new Set([
  "bash", "bun", "bundle", "cargo", "deno", "go", "just", "make", "node", "npm", "npx",
  "pnpm", "pytest", "python", "python3", "ruby", "sh", "swift", "swiftc", "xcodebuild", "yarn",
]);

function commandExecutable(command: string): string {
  return command.trim().split(/\s+/, 1)[0] ?? "";
}

/**
 * Tokenize sealed suite commands without invoking a shell.
 */
export function parseCommandArgv(command: string): string[] {
  const argv: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;
  for (const char of command) {
    if (escaped) {
      token += char;
      escaped = false;
      started = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote !== null) {
      if (char === quote) quote = null;
      else token += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        argv.push(token);
        token = "";
        started = false;
      }
      continue;
    }
    token += char;
    started = true;
  }
  if (escaped || quote !== null) throw new Error("suite: command has an unterminated quote or escape");
  if (started) argv.push(token);
  return argv;
}

function usesInterpreterFlag(argv: string[], flag: string): boolean {
  return argv.slice(1).some((entry) => {
    if (flag.startsWith("--")) return entry === flag || entry.startsWith(`${flag}=`);
    if (!/^-[^-]$/.test(flag) || !/^-[^-]/.test(entry)) return entry === flag;
    // Short options may be clustered or carry an attached payload (`-lc`,
    // `-eCODE`). A dangerous interpreter flag is dangerous in either shape.
    return entry.slice(1).split("=", 1)[0]!.includes(flag.slice(1));
  });
}

function assertProjectPath(projectRoot: string, cwd: string, value: string): void {
  let candidate = value;
  if (value.startsWith("-")) {
    const equals = value.indexOf("=");
    if (equals >= 0) candidate = value.slice(equals + 1);
    else if (/[\\/]/.test(value)) {
      // Without the executable's option schema `-rpath/file` is ambiguous:
      // fail closed and require the auditable `-r path/file` or `--x=path`
      // form instead of guessing where a flag cluster ends and a path begins.
      throw new Error(`suite: command option has an ambiguous attached path; pass the project-relative path separately or with '=': ${value}`);
    } else return;
  }
  if (candidate === "") return;
  const absolute = path.resolve(projectRoot, cwd, candidate);
  const realRoot = fs.realpathSync(projectRoot);
  let existingAncestor = absolute;
  // A missing future test/output is valid, but a dangling symlink is not a
  // missing directory: existsSync would skip it and overlook its escape.
  for (;;) {
    try {
      if (fs.lstatSync(existingAncestor, { throwIfNoEntry: false }) !== undefined) break;
    } catch (error) {
      // An existing file followed by a future child also needs its realpath
      // checked; stat reports ENOTDIR before it exposes a symlinked file.
      if ((error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
    }
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    existingAncestor = parent;
  }
  let realAncestor: string;
  try {
    realAncestor = fs.realpathSync(existingAncestor);
  } catch (error) {
    throw new Error(`suite: command path cannot be resolved safely: ${value} (${error instanceof Error ? error.message : String(error)})`);
  }
  const relative = path.relative(realRoot, realAncestor);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`suite: command path resolves outside the working tree: ${value}`);
  }
}

/**
 * The shape a `suite:` command may take, checked against the tree it will
 * run in. The PRD seals the string; this is the harness refusing to execute
 * what it should not: shell composition (the rule the cell and the config
 * share), absolute or traversing paths, an executable outside the runner
 * allowlist, inline code, or an npx that fetches. The cell has no cwd of
 * its own; the caller supplies the sealed execution directory.
 */
export function validateSuiteCommand(projectRoot: string, command: string): { command: string; argv: string[] } {
  const trimmed = command.trim();
  if (trimmed === "") throw new Error("suite: command must be non-empty");
  if (trimmed.length > 2_000) throw new Error("suite: command exceeds the 2000 character limit");
  if (/[\r\n\0]/.test(trimmed)) throw new Error("suite: command must be a single line");
  const composition = commandCompositionDefect(trimmed);
  if (composition !== null) throw new Error(`suite: command ${composition}`);
  if (/(?:^|[=\s])(?:~\/|\/)/.test(trimmed) || /(?:^|[\/=\s])\.\.(?:[\/\s]|$)/.test(trimmed)) {
    throw new Error("suite: command paths must be project-relative and may not traverse outside the working tree");
  }
  const argv = parseCommandArgv(trimmed);
  const executable = argv[0] ?? commandExecutable(trimmed);
  if (!ALLOWED_EXECUTABLES.has(executable) && !executable.startsWith("./")) {
    throw new Error(`suite: command executable is outside the allowed runner forms: ${executable}`);
  }
  const realProjectRoot = fs.realpathSync(projectRoot);
  for (const argument of argv) assertProjectPath(realProjectRoot, ".", argument);
  const inlineCode = (
    (["bash", "sh"].includes(executable) && (usesInterpreterFlag(argv, "-c") || usesInterpreterFlag(argv, "--command")))
    || (["node", "bun"].includes(executable) && ["-e", "--eval", "-p", "--print", "--input-type"].some((flag) => usesInterpreterFlag(argv, flag)))
    || (["python", "python3", "ruby"].includes(executable) && (usesInterpreterFlag(argv, "-c") || usesInterpreterFlag(argv, "-e")))
    || (executable === "deno" && argv[1] === "eval")
  );
  if (inlineCode) throw new Error("suite: command may not execute inline code; name a project-confined script or declared suite instead");
  if (executable === "npx" && !argv.includes("--no-install")) {
    throw new Error("npx suite: commands require --no-install so verification cannot fetch and execute a package");
  }
  return { command: trimmed, argv };
}


export interface RunUnit {
  command: string;
  argv: string[];
  cwd: string;
  /** Sealed suite command id this unit is. */
  suiteCommandId: string;
}

export interface RunUnitResult {
  unit: RunUnit;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number;
  timedOut: boolean;
  signal: NodeJS.Signals | null;
  /** True when the command rewrote judged source; scored as "tree-moved". */
  mutatedTree: boolean;
  outcome: MechanicalOutcome;
  stdout: string;
  stderr: string;
  tree: ExecutionTreeFingerprint;
}

/** The active sealed suite as run units, in sealed order. */
export function planRunUnits(state: ImplementState): RunUnit[] {
  const excluded = new Set(state.suite.exclusions.map((entry) => entry.commandId));
  return state.suite.commands
    .filter((command) => !excluded.has(command.id))
    .map((command) => ({ command: command.command, argv: command.argv, cwd: command.cwd, suiteCommandId: command.id }));
}

export function treeFingerprint(_state: ImplementState, workRoot: string): ExecutionTreeFingerprint {
  // Run bookkeeping is never a verification input, even as a diagnostic
  // digest: it changes whenever the CLI records its own execution progress.
  return { product: captureSourceSnapshot(workRoot).digest };
}

/**
 * The scrubbed environment every mechanical command runs under: no shell
 * and none of the agent process's credential-bearing environment. The suite
 * used to get both; unifying on the stricter side is the point of one runner.
 */
export function runtimeEnv(state: ImplementState): NodeJS.ProcessEnv {
  const runtimeRoot = path.join(state.projectRoot, state.runDir, "suite-runtime");
  const runtimeHome = path.join(runtimeRoot, "home");
  const runtimeTmp = path.join(runtimeRoot, "tmp");
  const runtimeCache = path.join(runtimeRoot, "cache");
  fs.mkdirSync(runtimeHome, { recursive: true });
  fs.mkdirSync(runtimeTmp, { recursive: true });
  fs.mkdirSync(runtimeCache, { recursive: true });
  return {
    PATH: process.env.PATH ?? "",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    CI: "1",
    NO_COLOR: "1",
    HOME: runtimeHome,
    TMPDIR: runtimeTmp,
    TMP: runtimeTmp,
    TEMP: runtimeTmp,
    XDG_CACHE_HOME: runtimeCache,
    npm_config_cache: path.join(runtimeCache, "npm"),
    ...(process.platform === "win32" && process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
  };
}

export async function executeUnit(
  state: ImplementState,
  workRoot: string,
  unit: Pick<RunUnit, "argv" | "cwd">,
  timeoutMs: number,
  onSpawn?: (pid: number) => void,
): Promise<{ execution: MechanicalExecution; mutatedTree: boolean; tree: ExecutionTreeFingerprint }> {
  const before = captureSourceSnapshot(workRoot).digest;
  const execution = await executeMechanicalArgv(workRoot, unit.argv, unit.cwd, timeoutMs, runtimeEnv(state), onSpawn);
  const tree = treeFingerprint(state, workRoot);
  // A command that rewrites the tree it is being judged on has moved the
  // goalposts mid-measurement: its own exit code no longer describes the tree
  // anyone else will see. The suite path has rejected this since before the
  // unification; folding the suite into the check executor would have dropped
  // the guard, and a proof is never what gets cut (AGENTS.md Review Guide 1).
  return { execution, mutatedTree: before !== tree.product, tree };
}

export interface BatchOutcome {
  results: RunUnitResult[];
  /**
   * Non-null when the product tree moved while the batch was running, which
   * invalidates every result in it: they were not all earned on one tree.
   */
  treeMoved: { before: string; after: string } | null;
}

/**
 * Run every unit once, on one frozen tree.
 *
 * "Frozen" is enforced by measurement, not by locking the filesystem: the
 * product digest is taken before the batch and again after, and a batch whose
 * tree moved is reported as invalid rather than scored. Each result also
 * carries the fingerprint it was earned on, so a pass always names its tree
 * (AGENTS.md Review Guide 10).
 *
 * Unlike the old suite loop this does NOT stop at the first failure. Stopping
 * early is what made the score unreadable: the run must be able to say
 * "suite 3/3", and it cannot count what it declined to execute.
 */
export async function runBatch(
  state: ImplementState,
  workRoot: string,
  units: RunUnit[],
  timeoutMs: number,
  onResult?: (result: RunUnitResult) => void,
  execution?: { prepare(): void; spawned(pid: number): void; settled(): void },
): Promise<BatchOutcome> {
  const before = captureSourceSnapshot(workRoot).digest;
  const results: RunUnitResult[] = [];
  for (const unit of units) {
    const started = Date.now();
    const startedAt = new Date().toISOString();
    execution?.prepare();
    let measured: Awaited<ReturnType<typeof executeUnit>>;
    try { measured = await executeUnit(state, workRoot, unit, timeoutMs, execution?.spawned); }
    finally { execution?.settled(); }
    const { execution: executed, mutatedTree, tree } = measured;
    const result: RunUnitResult = {
      unit,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      exitCode: executed.exitCode,
      timedOut: executed.timedOut,
      signal: executed.signal,
      mutatedTree,
      outcome: mechanicalOutcome({ exitCode: executed.exitCode, timedOut: executed.timedOut, signal: executed.signal, mutatedTree }),
      stdout: executed.stdout,
      stderr: `${executed.stderr}${executed.timedOut ? `\n[sasu] command timed out after ${timeoutMs}ms` : ""}${mutatedTree ? "\n[sasu] command changed judged source files and was rejected" : ""}`,
      tree,
    };
    results.push(result);
    onResult?.(result);
  }
  const after = captureSourceSnapshot(workRoot).digest;
  return { results, treeMoved: before === after ? null : { before, after } };
}
