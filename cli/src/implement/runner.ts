import fs from "node:fs";
import path from "node:path";
import { executeMechanicalArgv, type MechanicalExecution } from "../mechanical";
import { captureSourceSnapshot, sha256 } from "./store";
import type { CheckTreeFingerprint, ImplementState } from "./types";

/**
 * One command, executed once, scored for everything that asked for it.
 *
 * Before this existed the harness had two executors for the same strings: AC
 * Check bindings went through `executeMechanicalArgv` with no shell and a
 * scrubbed environment, while the V-derived suite went through `spawnSync(...,
 * { shell: true, env: process.env })`. The same `(cwd, command)` could
 * therefore run twice, under different semantics, and disagree - which is the
 * defect R1 closes. There is now one executor and one execution per unit.
 */
export interface RunUnit {
  /** `${cwd}\0${command}` - the identity the union is deduplicated on. */
  key: string;
  command: string;
  argv: string[];
  cwd: string;
  /** Criteria whose current Check binding is this command. */
  criterionIds: string[];
  /** Sealed suite command ids that are this command. */
  suiteCommandIds: string[];
  /** Verification rows this command proves, from the sealed suite entry. */
  verificationIds: string[];
}

export interface RunUnitResult {
  unit: RunUnit;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number;
  timedOut: boolean;
  signal: NodeJS.Signals | null;
  /** True when the command rewrote judged source; treated as a failure. */
  mutatedTree: boolean;
  green: boolean;
  stdout: string;
  stderr: string;
  tree: CheckTreeFingerprint;
}

function unitKey(cwd: string, command: string): string {
  return `${cwd}\0${command}`;
}

/**
 * The union of AC Check bindings and the sealed suite list, deduplicated by
 * `(cwd, command)` so a command named by both sides runs once and is scored
 * for both (AC1).
 *
 * Two exclusions, both deliberate:
 *   - parked criteria, which are by definition not being proved right now;
 *   - `machine+gate:human` criteria, whose every execution must consume a
 *     fresh verbatim human approval. Verify has no approval to spend, so
 *     folding them in would either run them without their gate or invent an
 *     approval. They stay on `sasu implement check --human-window`.
 * A suite entry sharing a command with an excluded criterion still runs - it
 * is in the union on its own account.
 */
export function planRunUnits(state: ImplementState): RunUnit[] {
  const byKey = new Map<string, RunUnit>();
  const take = (cwd: string, command: string, argv: string[]): RunUnit => {
    const key = unitKey(cwd, command);
    let unit = byKey.get(key);
    if (unit === undefined) {
      unit = { key, command, argv, cwd, criterionIds: [], suiteCommandIds: [], verificationIds: [] };
      byKey.set(key, unit);
    }
    return unit;
  };
  for (const criterion of state.acceptanceCriteria) {
    if (criterion.judgment !== "machine") continue;
    if (criterion.check.status === "parked") continue;
    const binding = criterion.check.bindings.at(-1);
    if (binding === undefined) continue;
    const unit = take(binding.cwd, binding.command, binding.argv);
    if (!unit.criterionIds.includes(criterion.id)) unit.criterionIds.push(criterion.id);
  }
  const excluded = new Set(state.suite.exclusions.map((entry) => entry.commandId));
  for (const command of state.suite.commands) {
    if (excluded.has(command.id)) continue;
    const unit = take(command.cwd, command.command, command.argv);
    if (!unit.suiteCommandIds.includes(command.id)) unit.suiteCommandIds.push(command.id);
    for (const verificationId of command.verificationIds) {
      if (!unit.verificationIds.includes(verificationId)) unit.verificationIds.push(verificationId);
    }
  }
  return [...byKey.values()];
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
 * The scrubbed environment every mechanical command runs under.
 *
 * Check bindings are agent-authored, so they get neither a shell nor the
 * agent process's credential-bearing environment. The suite used to get both;
 * unifying on the stricter side is the whole point of one runner.
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

export function executeUnit(
  state: ImplementState,
  workRoot: string,
  unit: Pick<RunUnit, "argv" | "cwd">,
  timeoutMs: number,
): { execution: MechanicalExecution; mutatedTree: boolean; tree: CheckTreeFingerprint } {
  const before = captureSourceSnapshot(workRoot).digest;
  const execution = executeMechanicalArgv(workRoot, unit.argv, unit.cwd, timeoutMs, runtimeEnv(state));
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
 * Run every unit once, on one frozen tree (AC2).
 *
 * "Frozen" is enforced by measurement, not by locking the filesystem: the
 * product digest is taken before the batch and again after, and a batch whose
 * tree moved is reported as invalid rather than scored. Each result also
 * carries the fingerprint it was earned on, so a pass always names its tree
 * (AGENTS.md Review Guide 10).
 *
 * Unlike the old suite loop this does NOT stop at the first failure. Stopping
 * early is what made the score unreadable: with one runner the run must be
 * able to say "AC 24/26, suites 3/3", and it cannot count what it declined to
 * execute (R4).
 */
export function runBatch(
  state: ImplementState,
  workRoot: string,
  units: RunUnit[],
  timeoutMs: number,
  onResult?: (result: RunUnitResult) => void,
): BatchOutcome {
  const before = captureSourceSnapshot(workRoot).digest;
  const results: RunUnitResult[] = [];
  for (const unit of units) {
    const started = Date.now();
    const startedAt = new Date().toISOString();
    const { execution, mutatedTree, tree } = executeUnit(state, workRoot, unit, timeoutMs);
    const green = !execution.timedOut && execution.signal === null && execution.exitCode === 0 && !mutatedTree;
    const result: RunUnitResult = {
      unit,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      exitCode: execution.exitCode,
      timedOut: execution.timedOut,
      signal: execution.signal,
      mutatedTree,
      green,
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
