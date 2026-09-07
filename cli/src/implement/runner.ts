import fs from "node:fs";
import path from "node:path";
import { executeMechanicalArgv, type MechanicalExecution } from "../mechanical";
import { captureSourceSnapshot, sha256 } from "./store";
import type { CheckTreeFingerprint, ImplementState } from "./types";
import { mechanicalOutcome, type MechanicalOutcome } from "./verdict";

/**
 * One command, executed once. The suite batch and the single-row check go
 * through this executor alone: two executors for one command string ran the
 * same `(cwd, command)` under different semantics and disagreed, which is
 * the defect the gate-loop PRD's R1 closed. The verify batch now carries
 * only the sealed suite; `check:` rows run one at a time through
 * `sasu implement check --row` and are settled from their own ledger.
 */
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
  tree: CheckTreeFingerprint;
}

/** The active sealed suite as run units, in sealed order. */
export function planRunUnits(state: ImplementState): RunUnit[] {
  const excluded = new Set(state.suite.exclusions.map((entry) => entry.commandId));
  return state.suite.commands
    .filter((command) => !excluded.has(command.id))
    .map((command) => ({ command: command.command, argv: command.argv, cwd: command.cwd, suiteCommandId: command.id }));
}

function directoryDigest(root: string, skipRelative: string): string {
  if (!fs.existsSync(root)) return sha256("[]");
  const entries: Array<[string, string]> = [];
  const visit = (absolute: string, relative: string): void => {
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (child === skipRelative || child.startsWith(`${skipRelative}/`)) continue;
      if (entry.isDirectory()) visit(path.join(absolute, entry.name), child);
      else if (entry.isFile()) entries.push([child, sha256(fs.readFileSync(path.join(absolute, entry.name)))]);
    }
  };
  visit(root, "");
  entries.sort(([left], [right]) => left.localeCompare(right));
  return sha256(JSON.stringify(entries));
}

export function treeFingerprint(state: ImplementState, workRoot: string): CheckTreeFingerprint {
  const product = captureSourceSnapshot(workRoot).digest;
  const agentsRoot = path.join(workRoot, "agents");
  const runRelativeToAgents = path.relative(agentsRoot, path.join(state.projectRoot, state.runDir)).split(path.sep).join("/");
  const bookkeeping = directoryDigest(agentsRoot, runRelativeToAgents);
  return { product, bookkeeping, all: sha256(JSON.stringify({ product, bookkeeping })) };
}

/**
 * The scrubbed environment every mechanical command runs under: no shell
 * and none of the agent process's credential-bearing environment. The suite
 * used to get both; unifying on the stricter side is the point of one runner.
 */
export function runtimeEnv(state: ImplementState): NodeJS.ProcessEnv {
  const runtimeRoot = path.join(state.projectRoot, state.runDir, "check-runtime");
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
): Promise<{ execution: MechanicalExecution; mutatedTree: boolean; tree: CheckTreeFingerprint }> {
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
): Promise<BatchOutcome> {
  const before = captureSourceSnapshot(workRoot).digest;
  const results: RunUnitResult[] = [];
  for (const unit of units) {
    const started = Date.now();
    const startedAt = new Date().toISOString();
    const { execution, mutatedTree, tree } = await executeUnit(state, workRoot, unit, timeoutMs);
    const result: RunUnitResult = {
      unit,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      exitCode: execution.exitCode,
      timedOut: execution.timedOut,
      signal: execution.signal,
      mutatedTree,
      outcome: mechanicalOutcome({ exitCode: execution.exitCode, timedOut: execution.timedOut, signal: execution.signal, mutatedTree }),
      stdout: execution.stdout,
      stderr: `${execution.stderr}${execution.timedOut ? `\n[sasu] command timed out after ${timeoutMs}ms` : ""}${mutatedTree ? "\n[sasu] command changed judged source files and was rejected" : ""}`,
      tree,
    };
    results.push(result);
    onResult?.(result);
  }
  const after = captureSourceSnapshot(workRoot).digest;
  return { results, treeMoved: before === after ? null : { before, after } };
}
