import fs from "node:fs";
import path from "node:path";
import { executeUnit } from "./runner";
import { captureSourceSnapshot, nowIso, sha256 } from "./store";
import { mechanicalOutcome } from "./verdict";
import type {
  AcceptanceCriterionItem,
  CheckAttempt,
  CheckBinding,
  CheckDecisionPoint,
  CheckTreeFingerprint,
  ImplementState,
} from "./types";

export const IMPLEMENT_CHECK_TIMEOUT_MS = 10 * 60 * 1000;
const SAME_CLASS_DECISION_THRESHOLD = 3;
const FAILURE_BACKSTOP_THRESHOLD = 5;
const ALLOWED_EXECUTABLES = new Set([
  "bash", "bun", "bundle", "cargo", "deno", "go", "just", "make", "node", "npm", "npx",
  "pnpm", "pytest", "python", "python3", "ruby", "sh", "swift", "swiftc", "xcodebuild", "yarn",
]);

function commandExecutable(command: string): string {
  return command.trim().split(/\s+/, 1)[0] ?? "";
}

/**
 * Shared by check bindings and the sealed suite list so both sides of the
 * single runner tokenize a command the same way. Two tokenizers would mean
 * two `(cwd, command)` identities and the dedup would silently miss (R1).
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
  if (escaped || quote !== null) throw new Error("check binding has an unterminated quote or escape");
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
      throw new Error(`check binding option has an ambiguous attached path; pass the project-relative path separately or with '=': ${value}`);
    } else return;
  }
  if (candidate === "" || (!candidate.includes("/") && !candidate.includes("\\") && !candidate.startsWith("."))) return;
  const absolute = path.resolve(projectRoot, cwd, candidate);
  const realRoot = fs.realpathSync(projectRoot);
  let existingAncestor = absolute;
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    existingAncestor = parent;
  }
  const realAncestor = fs.realpathSync(existingAncestor);
  const relative = path.relative(realRoot, realAncestor);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`check binding path resolves outside the working tree: ${value}`);
  }
}

export function validateCheckBinding(
  projectRoot: string,
  command: string,
  cwd = ".",
): { command: string; argv: string[]; cwd: string; classification: "asset" | "labor" } {
  const trimmed = command.trim();
  if (trimmed === "") throw new Error("check binding command must be non-empty");
  if (trimmed.length > 2_000) throw new Error("check binding command exceeds the 2000 character limit");
  // Implement bindings are written by an agent rather than sealed in the PRD.
  // Keep the accepted shape to one command address: no shell composition,
  // redirection, substitution, absolute path, or parent traversal.
  if (/[\r\n\0]/.test(trimmed) || /(?:;|\|\||&&|(?<!\|)\|(?!\|)|[<>]|`|\$\(|&)/.test(trimmed)) {
    throw new Error("check binding must be one command without shell composition, redirection, substitution, or background execution");
  }
  if (/(?:^|[=\s])(?:~\/|\/)/.test(trimmed) || /(?:^|[\/=\s])\.\.(?:[\/\s]|$)/.test(trimmed)) {
    throw new Error("check binding paths must be project-relative and may not traverse outside the working tree");
  }
  const argv = parseCommandArgv(trimmed);
  const executable = argv[0] ?? commandExecutable(trimmed);
  if (!ALLOWED_EXECUTABLES.has(executable) && !executable.startsWith("./")) {
    throw new Error(`check binding executable is outside the allowed runner forms: ${executable}`);
  }
  const absoluteCwd = path.resolve(projectRoot, cwd);
  if (!fs.existsSync(absoluteCwd)) throw new Error(`check binding cwd does not exist: ${cwd}`);
  const realProjectRoot = fs.realpathSync(projectRoot);
  const realCwd = fs.realpathSync(absoluteCwd);
  const relativeCwd = path.relative(realProjectRoot, realCwd).split(path.sep).join("/") || ".";
  if (relativeCwd === ".." || relativeCwd.startsWith("../") || path.isAbsolute(relativeCwd)) {
    throw new Error(`check binding cwd escapes the working tree: ${cwd}`);
  }
  for (const argument of argv) assertProjectPath(realProjectRoot, relativeCwd, argument);
  const inlineCode = (
    (["bash", "sh"].includes(executable) && (usesInterpreterFlag(argv, "-c") || usesInterpreterFlag(argv, "--command")))
    || (["node", "bun"].includes(executable) && ["-e", "--eval", "-p", "--print", "--input-type"].some((flag) => usesInterpreterFlag(argv, flag)))
    || (["python", "python3", "ruby"].includes(executable) && (usesInterpreterFlag(argv, "-c") || usesInterpreterFlag(argv, "-e")))
    || (executable === "deno" && argv[1] === "eval")
  );
  if (inlineCode) throw new Error("check binding may not execute inline code; bind a project-confined script or declared suite instead");
  if (executable === "npx" && !argv.includes("--no-install")) {
    throw new Error("npx check bindings require --no-install so verification cannot fetch and execute a package");
  }
  return { command: trimmed, argv, cwd: relativeCwd, classification: classifyBinding(trimmed, argv, relativeCwd) };
}

/**
 * Asset or labor, decided from the command's address alone (AC11, R4).
 *
 * The question this answers is what a run LEFT BEHIND. A check that points at
 * a file in the product tree is an asset: the run added a durable test that
 * guards the criterion after the run is over. A check that points into the
 * bookkeeping namespace, or at no file at all, is labor: it proved something
 * once and guards nothing afterwards.
 *
 * This is a receipt measurement and never a gate. Nothing refuses because a
 * run's ratio looks wrong - the number exists so a ratio can be OBSERVED
 * before anyone sets a threshold from it (D-24, PRD 3장 non-goals).
 *
 * ASSUMPTION, not a user decision (PRD 4.3 "에이전트 가정", 10장). Treating a
 * command with no path argument as labor is the harness's own judgement. It
 * misfiles a path-less command that really does check product output - `npm
 * test` is scored as labor even though it runs the project's suite. The
 * revisit trigger is written into the PRD: an actual run where that
 * misfiling mattered. Until such a case is observed, this stays as it is
 * rather than growing a smarter heuristic nobody has measured.
 */
export function classifyBinding(command: string, argv: string[], cwd: string): "asset" | "labor" {
  // The bookkeeping namespace, whether entered through the cwd or named in an
  // argument. Broader than AC11's `agents/runs/**` on purpose: every path
  // under `agents/` is bookkeeping, so a check aimed at any of it guards no
  // product behaviour (AGENTS.md Namespaces).
  if (cwd === "agents" || cwd.startsWith("agents/")) return "labor";
  if (/(?:^|\s)(?:\.\/)?agents\//.test(command)) return "labor";
  // A path argument is what makes a check a durable address. `--flag=path`
  // counts; a bare word that happens to be an npm script does not.
  const namesAPath = argv.slice(1).some((token) => token.replace(/^[^=]*=/, "").includes("/"));
  return namesAPath ? "asset" : "labor";
}

function resolveDecisionPoints(criterion: AcceptanceCriterionItem, resolution: "green" | "parked" | "rebound", at: string): void {
  for (const point of criterion.check.decisionPoints) {
    if (point.resolvedAt !== null) continue;
    point.resolvedAt = at;
    point.resolution = resolution;
  }
}

export function bindCriterionCheck(
  criterion: AcceptanceCriterionItem,
  input: { command: string; argv: string[]; cwd: string; classification: "asset" | "labor"; reason: string | null },
): CheckBinding {
  if (criterion.judgment === "judged" || criterion.judgment === null) {
    throw new Error(`${criterion.id} is ${criterion.judgment ?? "untagged"}; only machine criteria accept a Check binding`);
  }
  // A parked criterion has an open park record, and binding sets status back
  // to "pending". Without this guard that combination is unrepresentable but
  // reachable: parseImplementState refuses a status that contradicts park
  // history, so one --bind on a parked criterion bricked the run for every
  // later command with no recovery path. Reported by a peer review of main.
  if (criterion.check.status === "parked") {
    throw new Error(`${criterion.id} is parked; run \`sasu implement resume --ac ${criterion.id}\` before binding a new Check`);
  }
  const isRebind = criterion.check.bindings.length > 0;
  if (isRebind && (input.reason === null || input.reason.trim() === "")) {
    throw new Error(`rebind for ${criterion.id} requires --reason <why the checker changed>`);
  }
  const at = nowIso();
  const binding: CheckBinding = {
    id: `B${criterion.check.bindings.length + 1}`,
    command: input.command,
    argv: input.argv,
    cwd: input.cwd,
    classification: input.classification,
    boundAt: at,
    reason: isRebind ? input.reason!.trim() : null,
  };
  criterion.check.bindings.push(binding);
  criterion.check.status = "pending";
  criterion.check.consecutiveFailures = 0;
  if (isRebind) resolveDecisionPoints(criterion, "rebound", at);
  return binding;
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

function openDecisionPoint(
  criterion: AcceptanceCriterionItem,
  kind: CheckDecisionPoint["kind"],
  attempt: CheckAttempt,
  message: string,
): void {
  if (criterion.check.decisionPoints.some((point) => point.kind === kind && point.resolvedAt === null)) return;
  criterion.check.decisionPoints.push({
    id: `DP${criterion.check.decisionPoints.length + 1}`,
    kind,
    openedAt: attempt.finishedAt,
    attemptId: attempt.id,
    message,
    resolvedAt: null,
    resolution: null,
  });
}

function updateFailureDecisions(criterion: AcceptanceCriterionItem, attempt: CheckAttempt): void {
  const recent = criterion.check.attempts.slice(-SAME_CLASS_DECISION_THRESHOLD);
  if (recent.length === SAME_CLASS_DECISION_THRESHOLD
    && recent.every((entry) => entry.outcome === "failed"
      && entry.bindingId === attempt.bindingId
      && entry.failureClass === attempt.failureClass)) {
    openDecisionPoint(criterion, "same-class", attempt, `${criterion.id} has ${SAME_CLASS_DECISION_THRESHOLD} consecutive failures in the same output class`);
  }
  if (criterion.check.consecutiveFailures >= FAILURE_BACKSTOP_THRESHOLD) {
    openDecisionPoint(criterion, "five-failures", attempt, `${criterion.id} has ${FAILURE_BACKSTOP_THRESHOLD} consecutive failures regardless of class`);
  }
  const previous = criterion.check.attempts.at(-2);
  if (previous?.outcome === "failed"
    && previous.tree.product === attempt.tree.product
    && previous.tree.bookkeeping !== attempt.tree.bookkeeping) {
    openDecisionPoint(criterion, "tools-only", attempt, `${criterion.id} changed only agents/** bookkeeping between consecutive failures`);
  }
}

export function runCriterionCheck(
  state: ImplementState,
  workRoot: string,
  criterion: AcceptanceCriterionItem,
  humanWindow: string | null,
): CheckAttempt {
  if (criterion.judgment === "judged" || criterion.judgment === null) {
    throw new Error(`${criterion.id} is ${criterion.judgment ?? "untagged"}; it has no mechanical Check`);
  }
  if (criterion.check.status === "parked") throw new Error(`${criterion.id} is parked; run \`sasu implement resume --ac ${criterion.id}\` before checking it`);
  const binding = criterion.check.bindings.at(-1);
  if (binding === undefined) throw new Error(`${criterion.id} has no Check binding; bind it before execution`);
  const validated = validateCheckBinding(workRoot, binding.command, binding.cwd);
  if (validated.cwd !== binding.cwd
    || validated.classification !== binding.classification
    || JSON.stringify(validated.argv) !== JSON.stringify(binding.argv)) {
    throw new Error(`${criterion.id} Check binding no longer matches its validated command; rebind it with an explicit reason`);
  }
  const approval = humanWindow?.trim() ?? "";
  if (criterion.judgment === "machine+gate:human") {
    if (approval === "") throw new Error(`${criterion.id} requires --human-window <verbatim human approval> for this one execution`);
    if (criterion.check.attempts.some((entry) => entry.humanWindow?.evidence === approval)) {
      throw new Error(`${criterion.id} human-window approval was already consumed; obtain a new verbatim approval`);
    }
  } else if (approval !== "") {
    throw new Error(`--human-window is valid only for machine+gate:human criteria`);
  }
  const started = Date.now();
  const startedAt = nowIso();
  // Single-criterion checks and the verify batch go through the SAME executor
  // (runner.executeUnit). Two executors for one command string is exactly the
  // split R1 closes; keeping this call here and the batch call in verify is
  // fine, running them through different machinery is not.
  const { execution: executed, mutatedTree, tree } = executeUnit(
    state,
    workRoot,
    { argv: validated.argv, cwd: validated.cwd },
    IMPLEMENT_CHECK_TIMEOUT_MS,
  );
  const finishedAt = nowIso();
  const fingerprints = fingerprintCheckOutput(
    executed.stdout,
    `${executed.stderr}${executed.timedOut ? `\n[sasu] command timed out after ${IMPLEMENT_CHECK_TIMEOUT_MS}ms` : ""}`,
  );
  // A single check used to ignore `mutatedTree` and leave the frozen-tree
  // rule to verify. That exemption cannot survive a reader that re-derives
  // every verdict from the persisted inputs: nothing on the record says which
  // policy produced it, so the reader would have to accept two verdicts for
  // one set of inputs - two definitions again. One executor, one policy: a
  // check that rewrites the tree it is proving learns so now, not at verify.
  const outcome = mechanicalOutcome({ exitCode: executed.exitCode, timedOut: executed.timedOut, signal: executed.signal, mutatedTree });
  const attempt: CheckAttempt = {
    id: `A${criterion.check.attempts.length + 1}`,
    bindingId: binding.id,
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
    humanWindow: criterion.judgment === "machine+gate:human"
      ? { evidence: approval, recordedAt: startedAt, criterionId: criterion.id }
      : null,
  };
  criterion.check.attempts.push(attempt);
  if (outcome === "green") {
    criterion.check.status = "green";
    criterion.check.consecutiveFailures = 0;
    resolveDecisionPoints(criterion, "green", finishedAt);
  } else {
    criterion.check.status = "pending";
    criterion.check.consecutiveFailures += 1;
    updateFailureDecisions(criterion, attempt);
  }
  return attempt;
}

export function parkCriterion(
  criterion: AcceptanceCriterionItem,
  input: { approval: string; reason: string; evidence: string | null; parkedBy?: "human" | "observer" },
): void {
  if (criterion.check.status === "parked") throw new Error(`${criterion.id} is already parked`);
  const parkedBy = input.parkedBy ?? "human";
  if (input.reason.trim() === "") throw new Error(`park for ${criterion.id} requires --reason <why>`);
  if (parkedBy === "observer") {
    // The supervisor may set aside a criterion the HARNESS has already
    // flagged as stuck; it may not be the one who decides it is stuck. A
    // posted decision point is that flag, and it is machine-owned - which is
    // what keeps this from becoming a way to park anything inconvenient.
    if (!criterion.check.decisionPoints.some((point) => point.resolvedAt === null)) {
      throw new Error(`${criterion.id} has no open decision point; the supervisor may only park a criterion the harness has already flagged. Let the check run until it posts one, or park with verbatim human approval.`);
    }
    if (input.approval.trim() !== "") {
      throw new Error(`--approval belongs to a human park; an observer park is authorised by the open decision point, not by a quote it is repeating`);
    }
  } else if (input.approval.trim() === "") {
    throw new Error(`park for ${criterion.id} requires --approval <verbatim human approval>`);
  }
  const at = nowIso();
  criterion.check.parks.push({
    parkedAt: at,
    parkedBy,
    approval: input.approval.trim(),
    reason: input.reason.trim(),
    evidence: input.evidence?.trim() || null,
    resumedAt: null,
  });
  criterion.check.status = "parked";
  resolveDecisionPoints(criterion, "parked", at);
}

export function resumeCriterion(criterion: AcceptanceCriterionItem): void {
  if (criterion.check.status !== "parked") throw new Error(`${criterion.id} is not parked and cannot be resumed`);
  const park = criterion.check.parks.at(-1);
  if (park === undefined || park.resumedAt !== null) throw new Error(`${criterion.id} park history is malformed`);
  park.resumedAt = nowIso();
  criterion.check.status = "pending";
  criterion.check.consecutiveFailures = 0;
}

export function criterionCheckIsGreen(criterion: AcceptanceCriterionItem): boolean {
  if (criterion.check.status !== "green" || criterion.check.parks.some((park) => park.resumedAt === null)) return false;
  const binding = criterion.check.bindings.at(-1);
  if (binding === undefined) return false;
  const attempt = criterion.check.attempts.slice().reverse().find((entry) => entry.bindingId === binding.id);
  if (attempt === undefined
    || attempt.outcome !== "green"
    || attempt.exitCode !== 0
    || attempt.timedOut
    || attempt.signal !== null) return false;
  const latestResume = criterion.check.parks.map((park) => park.resumedAt).filter((at): at is string => at !== null).at(-1);
  return latestResume === undefined || latestResume <= attempt.finishedAt;
}

export function checkLedgerPayload(state: ImplementState): {
  sha256: string;
  bindings: Array<{ criterionId: string; bindingId: string; command: string; argv: string[]; cwd: string; classification: "asset" | "labor" }>;
} {
  // INPUTS only. `attempts` and `decisionPoints` are the record of past runs -
  // outputs - and hashing them makes the fingerprint move every time anything
  // executes. That defeats the convergence bound outright: an unchanged repeat
  // could never be recognised as unchanged, so a no-judge round would always
  // look like progress and never be charged (PRINCIPLES 13). `status` stays,
  // because a criterion going pending -> green is a real change of input to
  // the next verdict, while a failing check re-running identically is not.
  const ledger = state.acceptanceCriteria.map((criterion) => ({
    criterionId: criterion.id,
    judgment: criterion.judgment,
    evidenceDeclaration: criterion.evidenceDeclaration,
    status: criterion.check.status,
    bindings: criterion.check.bindings,
    parks: criterion.check.parks,
  }));
  const bindings = state.acceptanceCriteria.flatMap((criterion) => criterion.check.bindings.map((binding) => ({
    criterionId: criterion.id,
    bindingId: binding.id,
    command: binding.command,
    argv: binding.argv,
    cwd: binding.cwd,
    classification: binding.classification,
  })));
  return { sha256: sha256(JSON.stringify(ledger)), bindings };
}

export function checkLedgerForCriterion(criterion: AcceptanceCriterionItem): string {
  return JSON.stringify({
    judgment: criterion.judgment,
    evidenceDeclaration: criterion.evidenceDeclaration,
    status: criterion.check.status,
    bindings: criterion.check.bindings,
    attempts: criterion.check.attempts,
    decisionPoints: criterion.check.decisionPoints,
    parks: criterion.check.parks,
  }, null, 2);
}
