import fs from "node:fs";
import path from "node:path";
import { executeUnit } from "./runner";
import { nowIso, sha256 } from "./store";
import { mechanicalOutcome } from "./verdict";
import type { BehaviorRow, CheckAttempt, ImplementState } from "./types";

const { commandCompositionDefect } = require("../../lib/prd_parser.js") as { commandCompositionDefect(command: string): string | null };

export const IMPLEMENT_CHECK_TIMEOUT_MS = 10 * 60 * 1000;
const ALLOWED_EXECUTABLES = new Set([
  "bash", "bun", "bundle", "cargo", "deno", "go", "just", "make", "node", "npm", "npx",
  "pnpm", "pytest", "python", "python3", "ruby", "sh", "swift", "swiftc", "xcodebuild", "yarn",
]);

function commandExecutable(command: string): string {
  return command.trim().split(/\s+/, 1)[0] ?? "";
}

/**
 * Shared by `check:` cells and the sealed suite list so both sides of the
 * single runner tokenize a command the same way. Two tokenizers would mean
 * two `(cwd, command)` identities and the results could disagree (R1).
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
  if (escaped || quote !== null) throw new Error("check: command has an unterminated quote or escape");
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
      throw new Error(`check: command option has an ambiguous attached path; pass the project-relative path separately or with '=': ${value}`);
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
    throw new Error(`check: command path cannot be resolved safely: ${value} (${error instanceof Error ? error.message : String(error)})`);
  }
  const relative = path.relative(realRoot, realAncestor);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`check: command path resolves outside the working tree: ${value}`);
  }
}

/**
 * The shape a `check:` command may take, checked against the tree it will
 * run in. The PRD seals the string; this is the harness refusing to execute
 * what it should not: shell composition (the rule the cell and the config
 * share), absolute or traversing paths, an executable outside the runner
 * allowlist, inline code, or an npx that fetches. The cell has no cwd of
 * its own - every row's command runs at the judged tree's root (R3).
 */
export function validateCheckCommand(projectRoot: string, command: string): { command: string; argv: string[] } {
  const trimmed = command.trim();
  if (trimmed === "") throw new Error("check: command must be non-empty");
  if (trimmed.length > 2_000) throw new Error("check: command exceeds the 2000 character limit");
  if (/[\r\n\0]/.test(trimmed)) throw new Error("check: command must be a single line");
  const composition = commandCompositionDefect(trimmed);
  if (composition !== null) throw new Error(`check: command ${composition}`);
  if (/(?:^|[=\s])(?:~\/|\/)/.test(trimmed) || /(?:^|[\/=\s])\.\.(?:[\/\s]|$)/.test(trimmed)) {
    throw new Error("check: command paths must be project-relative and may not traverse outside the working tree");
  }
  const argv = parseCommandArgv(trimmed);
  const executable = argv[0] ?? commandExecutable(trimmed);
  if (!ALLOWED_EXECUTABLES.has(executable) && !executable.startsWith("./")) {
    throw new Error(`check: command executable is outside the allowed runner forms: ${executable}`);
  }
  const realProjectRoot = fs.realpathSync(projectRoot);
  for (const argument of argv) assertProjectPath(realProjectRoot, ".", argument);
  const inlineCode = (
    (["bash", "sh"].includes(executable) && (usesInterpreterFlag(argv, "-c") || usesInterpreterFlag(argv, "--command")))
    || (["node", "bun"].includes(executable) && ["-e", "--eval", "-p", "--print", "--input-type"].some((flag) => usesInterpreterFlag(argv, flag)))
    || (["python", "python3", "ruby"].includes(executable) && (usesInterpreterFlag(argv, "-c") || usesInterpreterFlag(argv, "-e")))
    || (executable === "deno" && argv[1] === "eval")
  );
  if (inlineCode) throw new Error("check: command may not execute inline code; name a project-confined script or declared suite instead");
  if (executable === "npx" && !argv.includes("--no-install")) {
    throw new Error("npx check: commands require --no-install so verification cannot fetch and execute a package");
  }
  return { command: trimmed, argv };
}

/**
 * Readiness, start, and amendments share the executor's command policy.
 * Files and output directories may be created by the implementation later;
 * validating the nearest existing ancestor proves only confinement, never
 * that a future test exists or passes. Runtime repeats the same validation.
 */
export function validateContractCheckCommands(
  projectRoot: string,
  rows: ReadonlyArray<Pick<BehaviorRow, "id" | "check">>,
): void {
  const errors: string[] = [];
  for (const row of rows) {
    if (row.check.kind !== "check") continue;
    try {
      validateCheckCommand(projectRoot, row.check.command);
    } catch (error) {
      errors.push(`${row.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (errors.length > 0) throw new Error(`Check commands violate execution policy:\n${errors.join("\n")}`);
}

function normalizeOutput(text: string): string {
  return text
    .replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][0-9:.+-]+Z?\b/gi, "<timestamp>")
    .replace(/\b(?:0x)?[0-9a-f]{12,}\b/gi, "<hex>")
    .replace(/(?:file:\/\/)?\/(?:[^\s:'\"]+\/)*[^\s:'\"]+/g, "<path>")
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|seconds?|minutes?|mins?)\b/gi, "<duration>")
    .replace(/\b\d+(?:\.\d+)?\b/g, "<n>")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

export function fingerprintCheckOutput(stdout: string, stderr: string): { outputFingerprint: string; failureClass: string } {
  const normalized = normalizeOutput(`${stdout}\n${stderr}`);
  const lines = normalized.split("\n").filter(Boolean);
  const signal = lines.filter((line) => /(?:error|fail|panic|exception|assert|expected|actual|timeout|timed out)/i.test(line));
  const signature = (signal.length > 0 ? signal : lines).slice(-8).join("\n") || "<empty-output>";
  return {
    outputFingerprint: sha256(normalized),
    failureClass: sha256(signature),
  };
}

/** The refusal for a row that is not settled by a command (R3, AC3). */
export function assertCheckRow(row: BehaviorRow): asserts row is BehaviorRow & { check: { kind: "check"; command: string; argv: string[] } } {
  if (row.check.kind === "judge") throw new Error(`${row.id}는 judge: 행이라 verify가 판정한다; \`sasu implement verify\`로 넘어가라`);
  if (row.check.kind === "human") throw new Error(`${row.id}는 human: 행이라 사용자가 confirm으로 닫는다; \`sasu implement confirm --row ${row.id} --evidence "<사용자 말>"\``);
}

/**
 * Run one `check:` row's command on the judged tree and record the attempt.
 * Exit 0 on an unmoved tree is green; anything else is fail (R3). The
 * command is re-validated against the tree it runs in every time, so a cell
 * that was fine at start cannot be turned into an escape by a file that
 * appeared since.
 */
export async function runRowCheck(state: ImplementState, workRoot: string, row: BehaviorRow, onSpawn?: (pid: number) => void): Promise<CheckAttempt> {
  assertCheckRow(row);
  if (row.status === "parked") throw new Error(`${row.id} is parked; run \`sasu implement resume --row ${row.id}\` before checking it`);
  const validated = validateCheckCommand(workRoot, row.check.command);
  if (JSON.stringify(validated.argv) !== JSON.stringify(row.check.argv)) {
    throw new Error(`${row.id} check: command no longer tokenizes to what was sealed at start; amend the row before checking it`);
  }
  const started = Date.now();
  const startedAt = nowIso();
  // Single-row checks and the verify suite batch go through the SAME
  // executor (runner.executeUnit). Two executors for one command string is
  // exactly the split R1 of the gate-loop PRD closed.
  const { execution: executed, mutatedTree, tree } = await executeUnit(
    state,
    workRoot,
    { argv: validated.argv, cwd: "." },
    IMPLEMENT_CHECK_TIMEOUT_MS,
    onSpawn,
  );
  const finishedAt = nowIso();
  const fingerprints = fingerprintCheckOutput(
    executed.stdout,
    `${executed.stderr}${executed.timedOut ? `\n[sasu] command timed out after ${IMPLEMENT_CHECK_TIMEOUT_MS}ms` : ""}`,
  );
  // A check that rewrites the tree it is proving has moved the goalposts
  // mid-measurement; one executor, one policy, so it learns so now rather
  // than at verify.
  const outcome = mechanicalOutcome({ exitCode: executed.exitCode, timedOut: executed.timedOut, signal: executed.signal, mutatedTree });
  const attempt: CheckAttempt = {
    id: `A${row.attempts.length + 1}`,
    startedAt,
    finishedAt,
    durationMs: Date.now() - started,
    exitCode: executed.exitCode,
    timedOut: executed.timedOut,
    signal: executed.signal,
    mutatedTree,
    outcome,
    outputFingerprint: fingerprints.outputFingerprint,
    failureClass: outcome === "failed" ? fingerprints.failureClass : null,
    tree,
  };
  row.attempts.push(attempt);
  if (outcome === "green") {
    row.status = "green";
    row.consecutiveFailures = 0;
  } else {
    row.status = "fail";
    row.consecutiveFailures += 1;
  }
  return attempt;
}

export function parkRow(row: BehaviorRow, input: { approval: string; reason: string; evidence: string | null }): void {
  assertCheckRow(row);
  if (row.status === "parked") throw new Error(`${row.id} is already parked`);
  if (input.reason.trim() === "") throw new Error(`park for ${row.id} requires --reason <why>`);
  if (input.approval.trim() === "") throw new Error(`park for ${row.id} requires --approval <verbatim human approval>`);
  row.parks.push({
    parkedAt: nowIso(),
    approval: input.approval.trim(),
    reason: input.reason.trim(),
    evidence: input.evidence?.trim() || null,
    resumedAt: null,
  });
  row.status = "parked";
}

export function resumeRow(row: BehaviorRow): void {
  if (row.status !== "parked") throw new Error(`${row.id} is not parked and cannot be resumed`);
  const park = row.parks.at(-1);
  if (park === undefined || park.resumedAt !== null) throw new Error(`${row.id} park history is malformed`);
  park.resumedAt = nowIso();
  row.status = "pending";
  row.consecutiveFailures = 0;
}

/** The latest attempt that counts: after the last resume, on the current cells. */
export function latestCountedAttempt(row: BehaviorRow): CheckAttempt | null {
  const attempt = row.attempts.at(-1);
  if (attempt === undefined) return null;
  const latestResume = row.parks.map((park) => park.resumedAt).filter((at): at is string => at !== null).at(-1);
  return latestResume === undefined || latestResume <= attempt.finishedAt ? attempt : null;
}

/**
 * A `check:` row is proved when its status is green AND the attempt the
 * status rests on is a real exit 0: no timeout, no signal, no moved tree.
 */
export function rowCheckIsGreen(row: BehaviorRow): boolean {
  if (row.check.kind !== "check" || row.status !== "green") return false;
  const attempt = latestCountedAttempt(row);
  return attempt !== null && attempt.outcome === "green" && attempt.exitCode === 0 && !attempt.timedOut && attempt.signal === null;
}

export function checkLedgerPayload(state: ImplementState): {
  sha256: string;
  rows: Array<{ rowId: string; kind: BehaviorRow["check"]["kind"]; payload: string; status: BehaviorRow["status"] }>;
} {
  // INPUTS only. Attempts, judge verdicts and confirmations are the record
  // of past outputs, and hashing them makes the fingerprint move every time
  // anything executes - which defeats the convergence bound outright: an
  // unchanged repeat could never be recognised as unchanged (PRINCIPLES 13).
  // A check: row's status stays, because pending -> green is a real change
  // of input to the next verdict, while a failing check re-running
  // identically is not.
  const rows = state.rows.map((row) => ({
    rowId: row.id,
    kind: row.check.kind,
    payload: rowCheckPayload(row),
    status: row.status,
  }));
  const ledger = rows.map((row, index) => ({
    ...row,
    status: row.kind === "check" ? row.status : null,
    parks: state.rows[index]!.parks,
  }));
  return { sha256: sha256(JSON.stringify(ledger)), rows };
}

export function rowCheckPayload(row: BehaviorRow): string {
  switch (row.check.kind) {
    case "check": return row.check.command;
    case "judge": return row.check.evidence;
    case "human": return row.check.confirmation;
  }
}

export function checkLedgerForRow(row: BehaviorRow): string {
  return JSON.stringify({
    check: row.check,
    status: row.status,
    attempts: row.attempts,
    parks: row.parks,
    verdict: row.verdict,
  }, null, 2);
}
