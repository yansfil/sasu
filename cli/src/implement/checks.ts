import fs from "node:fs";
import path from "node:path";
import { executeMechanicalArgv } from "../mechanical";
import { captureSourceSnapshot, nowIso, sha256 } from "./store";
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
  const classification = relativeCwd === "agents" || relativeCwd.startsWith("agents/") || /(?:^|\s)(?:\.\/)?agents\//.test(trimmed)
    ? "labor"
    : "asset";
  return { command: trimmed, argv, cwd: relativeCwd, classification };
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

function checkTreeFingerprint(state: ImplementState, workRoot: string): CheckTreeFingerprint {
  const product = captureSourceSnapshot(workRoot).digest;
  const agentsRoot = path.join(workRoot, "agents");
  const runRelativeToAgents = path.relative(agentsRoot, path.join(state.projectRoot, state.runDir)).split(path.sep).join("/");
  const bookkeeping = directoryDigest(agentsRoot, runRelativeToAgents);
  return { product, bookkeeping, all: sha256(JSON.stringify({ product, bookkeeping })) };
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
  const runtimeRoot = path.join(state.projectRoot, state.runDir, "check-runtime");
  const runtimeHome = path.join(runtimeRoot, "home");
  const runtimeTmp = path.join(runtimeRoot, "tmp");
  const runtimeCache = path.join(runtimeRoot, "cache");
  fs.mkdirSync(runtimeHome, { recursive: true });
  fs.mkdirSync(runtimeTmp, { recursive: true });
  fs.mkdirSync(runtimeCache, { recursive: true });
  const checkEnv: NodeJS.ProcessEnv = {
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
  const executed = executeMechanicalArgv(workRoot, validated.argv, validated.cwd, IMPLEMENT_CHECK_TIMEOUT_MS, checkEnv);
  const finishedAt = nowIso();
  const fingerprints = fingerprintCheckOutput(
    executed.stdout,
    `${executed.stderr}${executed.timedOut ? `\n[sasu] command timed out after ${IMPLEMENT_CHECK_TIMEOUT_MS}ms` : ""}`,
  );
  const green = !executed.timedOut && executed.signal === null && executed.exitCode === 0;
  const attempt: CheckAttempt = {
    id: `A${criterion.check.attempts.length + 1}`,
    bindingId: binding.id,
    startedAt,
    finishedAt,
    durationMs: Date.now() - started,
    exitCode: executed.exitCode,
    timedOut: executed.timedOut,
    signal: executed.signal,
    outcome: green ? "green" : "failed",
    outputFingerprint: fingerprints.outputFingerprint,
    failureClass: green ? null : fingerprints.failureClass,
    tree: checkTreeFingerprint(state, workRoot),
    humanWindow: criterion.judgment === "machine+gate:human"
      ? { evidence: approval, recordedAt: startedAt, criterionId: criterion.id }
      : null,
  };
  criterion.check.attempts.push(attempt);
  if (green) {
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
  input: { approval: string; reason: string; evidence: string | null },
): void {
  if (criterion.check.status === "parked") throw new Error(`${criterion.id} is already parked`);
  if (input.approval.trim() === "") throw new Error(`park for ${criterion.id} requires --approval <verbatim human approval>`);
  if (input.reason.trim() === "") throw new Error(`park for ${criterion.id} requires --reason <why>`);
  const at = nowIso();
  criterion.check.parks.push({
    parkedAt: at,
    parkedBy: "human",
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
  const ledger = state.acceptanceCriteria.map((criterion) => ({
    criterionId: criterion.id,
    judgment: criterion.judgment,
    evidenceDeclaration: criterion.evidenceDeclaration,
    status: criterion.check.status,
    bindings: criterion.check.bindings,
    attempts: criterion.check.attempts,
    decisionPoints: criterion.check.decisionPoints,
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
