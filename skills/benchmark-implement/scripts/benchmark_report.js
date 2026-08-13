#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CASE_SCHEMA = "sasu.benchmark-case.v2";
const RUN_SCHEMA = "sasu.benchmark-run.v1";
const QUALITATIVE_SCHEMA = "sasu.benchmark-qualitative.v1";
const REPORT_SCHEMA = "sasu.benchmark-report.v1";
const COMPARISON_SCHEMA = "sasu.benchmark-comparison.v1";
const TERMINAL_STATUSES = new Set(["complete", "partial", "blocked"]);
const STAGES = new Set([
  "init",
  "implementation",
  "verification",
  "verify-gate",
  "requirements-fidelity",
  "final-adversarial-review",
  "finalize",
]);
const DIMENSIONS = [
  "flowAdherence",
  "recoveryDiscipline",
  "reviewEfficiency",
  "evidenceHonesty",
  "sessionEfficiency",
];

function fail(message) {
  process.stderr.write(`benchmark-report: ${message}\n`);
  process.exitCode = 1;
  return null;
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const name = token.slice(2);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${name}`);
    if (Object.prototype.hasOwnProperty.call(options, name)) throw new Error(`Duplicate option: --${name}`);
    options[name] = value;
    index += 1;
  }
  return options;
}

function requireOption(options, name) {
  const value = options[name];
  if (!value) throw new Error(`Missing required option --${name}`);
  return value;
}

function readJson(file, label) {
  if (!fs.existsSync(file)) throw new Error(`${label} not found: ${file}`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON (${file}): ${error.message}`);
  }
}

function sha256Buffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256File(file) {
  return sha256Buffer(fs.readFileSync(file));
}

function listFiles(target) {
  if (!fs.existsSync(target)) return [];
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  const files = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

function hashPaths(root, targets) {
  const hash = crypto.createHash("sha256");
  for (const target of targets.flatMap(listFiles).sort()) {
    hash.update(path.relative(root, target));
    hash.update("\0");
    hash.update(fs.readFileSync(target));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(temporary, body);
  fs.renameSync(temporary, file);
}

function toProjectPath(projectRoot, file) {
  const relative = path.relative(projectRoot, file);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : file;
}

function validateStringArray(value, field, { nonempty = false } = {}) {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim())) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
  if (nonempty && value.length === 0) throw new Error(`${field} must not be empty`);
  return [...new Set(value)];
}

function validateRelativePath(value, field) {
  if (typeof value !== "string" || !value.trim() || path.isAbsolute(value)) {
    throw new Error(`${field} must be a non-empty relative path`);
  }
  const normalized = path.normalize(value.trim());
  if (normalized === "." || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`${field} must stay inside the project`);
  }
  if (normalized.split(path.sep).includes(".git")) {
    throw new Error(`${field} must not target .git`);
  }
  return normalized;
}

function validateCase(contract) {
  if (contract.schema !== CASE_SCHEMA) throw new Error(`case.schema must be ${CASE_SCHEMA}`);
  if (typeof contract.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(contract.id)) {
    throw new Error("case.id must use lowercase letters, digits, and hyphens");
  }
  if (typeof contract.prd !== "string" || !contract.prd.trim()) throw new Error("case.prd is required");
  if (!contract.environment || typeof contract.environment !== "object") {
    throw new Error("case.environment is required");
  }
  if (contract.environment.mode !== "fresh-worktree") {
    throw new Error("environment.mode must be fresh-worktree");
  }
  if (typeof contract.environment.baseRef !== "string" || !contract.environment.baseRef.trim()) {
    throw new Error("environment.baseRef is required");
  }
  const mustBeAbsent = validateStringArray(
    contract.environment.mustBeAbsent,
    "environment.mustBeAbsent",
    { nonempty: true },
  );
  mustBeAbsent.forEach((value, index) => validateRelativePath(value, `environment.mustBeAbsent[${index}]`));
  if (!contract.expected || typeof contract.expected !== "object") throw new Error("case.expected is required");
  const terminalStatuses = validateStringArray(
    contract.expected.terminalStatuses,
    "expected.terminalStatuses",
    { nonempty: true },
  );
  const requiredStages = validateStringArray(contract.expected.requiredStages || [], "expected.requiredStages");
  const forbiddenStages = validateStringArray(contract.expected.forbiddenStages || [], "expected.forbiddenStages");
  for (const status of terminalStatuses) {
    if (!TERMINAL_STATUSES.has(status)) throw new Error(`unknown expected terminal status: ${status}`);
  }
  for (const stage of [...requiredStages, ...forbiddenStages]) {
    if (!STAGES.has(stage)) throw new Error(`unknown expected stage: ${stage}`);
  }
  if (contract.expected.maxVerifyAttempts !== undefined
      && (!Number.isInteger(contract.expected.maxVerifyAttempts) || contract.expected.maxVerifyAttempts < 0)) {
    throw new Error("expected.maxVerifyAttempts must be a non-negative integer");
  }
  if (contract.expected.falseCompleteAllowed !== false) {
    throw new Error("expected.falseCompleteAllowed must be false");
  }
  if (!contract.evaluation || typeof contract.evaluation !== "object") {
    throw new Error("evaluation is required");
  }
  if (contract.evaluation.required !== true) {
    throw new Error("evaluation.required must be true");
  }
  if (!["complete", "partial", "unavailable"].includes(contract.evaluation.requiredCoverage)) {
    throw new Error("evaluation.requiredCoverage must be complete, partial, or unavailable");
  }
  for (const field of ["claudeCode", "codex"]) {
    if (typeof contract.evaluation.models?.[field] !== "string" || !contract.evaluation.models[field].trim()) {
      throw new Error(`evaluation.models.${field} is required`);
    }
  }
  return contract;
}

function runGit(root, args, label) {
  const result = childProcess.spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "unknown git error").trim();
    throw new Error(`${label} failed: ${detail}`);
  }
  return result.stdout.trim();
}

function requireInside(root, target, label) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must be inside the project root`);
  }
  return relative;
}

function prdTopic(prdPath) {
  const text = fs.readFileSync(prdPath, "utf8");
  const match = text.match(/^topic:\s*["']?([a-z0-9][a-z0-9-]*)["']?\s*$/m);
  if (!match) throw new Error(`benchmark PRD needs a lowercase topic in frontmatter: ${prdPath}`);
  return match[1];
}

function reserveRun(projectRoot, caseId) {
  const caseResults = path.join(projectRoot, "agents", "benchmarks", caseId);
  fs.mkdirSync(caseResults, { recursive: true });
  for (let number = 1; number < 10000; number += 1) {
    const runId = `${caseId}-run-${number}`;
    const resultDir = path.join(caseResults, runId);
    try {
      fs.mkdirSync(resultDir);
      return { runId, resultDir };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  throw new Error(`could not reserve a fresh run id for ${caseId}`);
}

function harnessRoot() {
  return path.resolve(path.dirname(fs.realpathSync(__filename)), "../../..");
}

function validateBenchmarkPrd(projectRoot, prdPath, prdRelative) {
  const parserPath = path.join(harnessRoot(), "cli", "lib", "prd_parser.js");
  const cliPath = path.join(harnessRoot(), "cli", "dist", "cli.js");
  if (!fs.existsSync(cliPath)) {
    throw new Error(`benchmark harness CLI is not built: ${cliPath}`);
  }
  const { frontmatter } = require(parserPath).stripFrontmatter(fs.readFileSync(prdPath, "utf8"));
  if (frontmatter.status !== "ready") {
    throw new Error(`benchmark PRD status must be ready, got ${frontmatter.status || "missing"}`);
  }
  if (frontmatter.human_approval !== "approved") {
    throw new Error(`benchmark PRD human_approval must be approved, got ${frontmatter.human_approval || "missing"}`);
  }

  const readiness = childProcess.spawnSync(
    process.execPath,
    [cliPath, "prd", "readiness", "--prd", prdRelative, "--json"],
    { cwd: projectRoot, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
  );
  let output = null;
  try {
    output = JSON.parse(readiness.stdout || "null");
  } catch {
    // The raw command output below is the useful failure when the CLI did not
    // honor its JSON contract.
  }
  if (readiness.status !== 0 || output?.ok !== true) {
    const detail = output?.message || readiness.stderr.trim() || readiness.stdout.trim() || "unknown readiness failure";
    throw new Error(`benchmark PRD readiness failed: ${detail}`);
  }
  return output.detail;
}

function canonicalPath(value) {
  const resolved = path.resolve(value);
  return fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
}

function captureWorktreeSnapshot(worktreePath, runDirRelative) {
  const previousCwd = process.cwd();
  const gitModule = path.join(harnessRoot(), "cli", "lib", "git.js");
  const utilModule = path.join(harnessRoot(), "cli", "lib", "util.js");
  try {
    process.chdir(worktreePath);
    delete require.cache[require.resolve(gitModule)];
    delete require.cache[require.resolve(utilModule)];
    const { worktreeSnapshot } = require(gitModule);
    return worktreeSnapshot({ projectRoot: worktreePath, runDir: runDirRelative });
  } finally {
    process.chdir(previousCwd);
  }
}

function commandPrepareRun(options) {
  const projectRoot = path.resolve(options["project-root"] || process.cwd());
  const gitRoot = path.resolve(runGit(projectRoot, ["rev-parse", "--show-toplevel"], "project discovery"));
  if (gitRoot !== projectRoot) throw new Error(`--project-root must be the Git worktree root: ${gitRoot}`);

  const casePath = path.resolve(projectRoot, requireOption(options, "case"));
  const caseRelative = requireInside(projectRoot, casePath, "benchmark case");
  const contract = validateCase(readJson(casePath, "benchmark case"));
  const prdPath = path.resolve(path.dirname(casePath), contract.prd);
  const prdRelative = requireInside(projectRoot, prdPath, "benchmark PRD");
  if (!fs.existsSync(prdPath)) throw new Error(`benchmark PRD not found: ${prdPath}`);
  const prdReadiness = validateBenchmarkPrd(projectRoot, prdPath, prdRelative);
  const topic = prdTopic(prdPath);
  const headSha = runGit(
    projectRoot,
    ["rev-parse", "--verify", `${contract.environment.baseRef}^{commit}`],
    "benchmark base ref resolution",
  );
  const { runId, resultDir } = reserveRun(projectRoot, contract.id);
  const runRecordPath = path.join(resultDir, "run.json");
  const createdAt = new Date().toISOString();
  const baseRecord = {
    schema: RUN_SCHEMA,
    id: runId,
    caseId: contract.id,
    status: "preparing",
    createdAt,
    casePath: caseRelative,
    caseHash: sha256File(casePath),
    prdPath: prdRelative,
    prdHash: sha256File(prdPath),
    prdReadiness,
    environment: {
      mode: contract.environment.mode,
      baseRef: contract.environment.baseRef,
      headSha,
      mustBeAbsent: contract.environment.mustBeAbsent,
    },
  };
  writeJsonAtomic(runRecordPath, baseRecord);

  let container = null;
  let worktreePath = null;
  try {
    container = fs.mkdtempSync(path.join(os.tmpdir(), `sasu-benchmark-${contract.id}-`));
    worktreePath = path.join(container, "worktree");
    runGit(projectRoot, ["worktree", "add", "--detach", worktreePath, headSha], "fresh worktree creation");

    const requiredAbsent = [
      ...contract.environment.mustBeAbsent,
      path.join("agents", "runs", topic),
      // Legacy namespaces: a base ref carrying an old-layout run is not fresh.
      path.join("agents", "implement", topic),
      path.join("agents", "gates", topic),
    ].map((value, index) => validateRelativePath(value, `fresh environment path[${index}]`));
    for (const relative of new Set(requiredAbsent)) {
      if (fs.existsSync(path.join(worktreePath, relative))) {
        throw new Error(`fresh environment contract failed; path exists at base ref: ${relative}`);
      }
    }

    for (const [source, relative] of [[casePath, caseRelative], [prdPath, prdRelative]]) {
      const destination = path.join(worktreePath, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
    }

    const runDirRelative = path.join("agents", "runs", topic);
    const gatesRelative = path.join("agents", "runs", topic, "gates", "gates.json");
    const initialWorktreeSnapshot = captureWorktreeSnapshot(worktreePath, runDirRelative);
    if (!initialWorktreeSnapshot) throw new Error("could not capture the fresh worktree snapshot");

    const record = {
      ...baseRecord,
      status: "prepared",
      preparedAt: new Date().toISOString(),
      worktreePath,
      preparedCasePath: path.join(worktreePath, caseRelative),
      preparedPrdPath: path.join(worktreePath, prdRelative),
      runDir: path.join(worktreePath, runDirRelative),
      gatesPath: path.join(worktreePath, gatesRelative),
      initialWorktreeSnapshot,
    };
    writeJsonAtomic(runRecordPath, record);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      runId,
      resultDir: toProjectPath(projectRoot, resultDir),
      worktree: worktreePath,
      prd: record.preparedPrdPath,
      runDir: record.runDir,
      gates: record.gatesPath,
      prdReadiness,
    })}\n`);
  } catch (error) {
    writeJsonAtomic(runRecordPath, {
      ...baseRecord,
      status: "prepare-failed",
      failedAt: new Date().toISOString(),
      error: error.message,
      worktreePath,
    });
    if (worktreePath && fs.existsSync(worktreePath)) {
      childProcess.spawnSync("git", ["-C", projectRoot, "worktree", "remove", "--force", worktreePath], {
        encoding: "utf8",
      });
    }
    if (container && fs.existsSync(container)) fs.rmSync(container, { recursive: true, force: true });
    throw error;
  }
}

function validateQualitative(evaluation) {
  if (evaluation.schema !== QUALITATIVE_SCHEMA) {
    throw new Error(`qualitative.schema must be ${QUALITATIVE_SCHEMA}`);
  }
  if (!evaluation.evaluator || typeof evaluation.evaluator !== "object") {
    throw new Error("qualitative.evaluator is required");
  }
  for (const field of ["runtime", "model"]) {
    if (typeof evaluation.evaluator[field] !== "string" || !evaluation.evaluator[field].trim()) {
      throw new Error(`qualitative.evaluator.${field} is required`);
    }
  }
  if (!new Set(["claude-code", "codex"]).has(evaluation.evaluator.runtime)) {
    throw new Error("qualitative.evaluator.runtime must be claude-code or codex");
  }
  if (!evaluation.evaluationTiming || typeof evaluation.evaluationTiming !== "object") {
    throw new Error("qualitative.evaluationTiming is required");
  }
  if (typeof evaluation.evaluationTiming.durationSeconds !== "number"
      || !Number.isFinite(evaluation.evaluationTiming.durationSeconds)
      || evaluation.evaluationTiming.durationSeconds < 0) {
    throw new Error("qualitative.evaluationTiming.durationSeconds must be a non-negative number");
  }
  if (typeof evaluation.evaluationTiming.basis !== "string" || !evaluation.evaluationTiming.basis.trim()) {
    throw new Error("qualitative.evaluationTiming.basis is required");
  }
  if (!evaluation.sessionAnalysis || typeof evaluation.sessionAnalysis !== "object") {
    throw new Error("qualitative.sessionAnalysis is required");
  }
  if (!["complete", "partial", "unavailable"].includes(evaluation.sessionAnalysis.coverage)) {
    throw new Error("qualitative.sessionAnalysis.coverage must be complete, partial, or unavailable");
  }
  for (const field of ["avoidableReviewCalls", "unchangedCommandReruns", "unexpectedUserStops"]) {
    const value = evaluation.sessionAnalysis[field];
    if (value !== null && value !== undefined && (!Number.isInteger(value) || value < 0)) {
      throw new Error(`qualitative.sessionAnalysis.${field} must be a non-negative integer or null`);
    }
  }
  if (!evaluation.dimensions || typeof evaluation.dimensions !== "object") {
    throw new Error("qualitative.dimensions is required");
  }
  for (const name of DIMENSIONS) {
    const dimension = evaluation.dimensions[name];
    if (!dimension || typeof dimension !== "object") throw new Error(`qualitative.dimensions.${name} is required`);
    if (dimension.score !== null && (!Number.isInteger(dimension.score) || dimension.score < 0 || dimension.score > 4)) {
      throw new Error(`qualitative.dimensions.${name}.score must be an integer from 0 to 4 or null`);
    }
    if (typeof dimension.reason !== "string" || !dimension.reason.trim()) {
      throw new Error(`qualitative.dimensions.${name}.reason is required`);
    }
    validateStringArray(dimension.evidence || [], `qualitative.dimensions.${name}.evidence`);
    if (dimension.score !== null && dimension.evidence.length === 0) {
      throw new Error(`qualitative.dimensions.${name} needs evidence when scored`);
    }
  }
  if (!Array.isArray(evaluation.findings)) throw new Error("qualitative.findings must be an array");
  for (const [index, finding] of evaluation.findings.entries()) {
    if (!finding || !["P0", "P1", "P2"].includes(finding.severity)) {
      throw new Error(`qualitative.findings[${index}].severity must be P0, P1, or P2`);
    }
    if (typeof finding.message !== "string" || !finding.message.trim()) {
      throw new Error(`qualitative.findings[${index}].message is required`);
    }
    validateStringArray(finding.evidence || [], `qualitative.findings[${index}].evidence`, { nonempty: true });
  }
  if (Object.prototype.hasOwnProperty.call(evaluation, "productQuality")) {
    throw new Error("qualitative.productQuality is outside this benchmark's scope");
  }
  return evaluation;
}

function stageSet(state, receipt, gates) {
  const stages = new Set();
  if (state && state.createdAt) stages.add("init");
  if ((state.tasks || []).some(task => task.status !== "pending" || (task.evidence || []).length > 0)) {
    stages.add("implementation");
  }
  if ((receipt.phaseTimings?.measured?.verificationCommandRuns || 0) > 0
      || (state.verification || []).some(item => !["planned", "pending"].includes(item.status))
      || (state.verificationAttempts || []).length > 0) {
    stages.add("verification");
  }
  if (gates?.gates?.verify?.lastRunAt || (state.verificationAttempts || []).length > 0) stages.add("verify-gate");
  if (receipt.requirementsFidelityReview
      || (state.verificationAttempts || []).some(attempt => attempt.lanes?.fidelity)) stages.add("requirements-fidelity");
  if (receipt.finalReview) stages.add("final-adversarial-review");
  stages.add("finalize");
  return stages;
}

function repeatedFingerprintRuns(gates) {
  const seen = new Set();
  let repeats = 0;
  for (const entry of gates?.gates?.verify?.history || []) {
    const fingerprint = entry.judgedDiffSha256;
    if (!fingerprint) continue;
    if (seen.has(fingerprint)) repeats += 1;
    else seen.add(fingerprint);
  }
  return repeats;
}

function processScore(qualitative) {
  if (!qualitative) return { score: null, scoredDimensions: 0, totalDimensions: DIMENSIONS.length };
  const scores = DIMENSIONS.map(name => qualitative.dimensions[name].score).filter(score => score !== null);
  return {
    score: scores.length === DIMENSIONS.length
      ? Math.round((scores.reduce((sum, score) => sum + score, 0) / (DIMENSIONS.length * 4)) * 1000) / 10
      : null,
    scoredDimensions: scores.length,
    totalDimensions: DIMENSIONS.length,
  };
}

function modernTiming(state, receipt) {
  if (receipt.phaseTimings) return receipt.phaseTimings;
  const attempts = state.verificationAttempts || [];
  const mechanical = attempts.flatMap(attempt => attempt.mechanical || []);
  const judges = attempts.flatMap(attempt => Object.values(attempt.lanes || {}).flatMap(lane => [
    ...(lane?.judge ? [lane.judge] : []),
    ...((lane?.result?.criteria || []).flatMap(criterion => criterion.judge ? [criterion.judge] : [])),
  ]));
  const wallClockSeconds = state.createdAt && receipt.completedAt
    ? Math.max(0, (Date.parse(receipt.completedAt) - Date.parse(state.createdAt)) / 1000)
    : null;
  const verificationCommandSeconds = mechanical.reduce((sum, run) => sum + (Number(run.durationMs) || 0), 0) / 1000;
  const judgeSeconds = judges.reduce((sum, judge) => sum + (Number(judge.durationMs) || 0), 0) / 1000;
  return {
    wallClockSeconds,
    taskEvidenceBoundary: {},
    measured: {
      verificationCommandSeconds,
      verificationCommandRuns: mechanical.length,
      judgeSeconds,
      judgeCalls: judges.reduce((sum, judge) => sum + (Number(judge.attempts) || 1), 0),
      verifyGateAttempts: attempts.length,
    },
    unattributedSeconds: wallClockSeconds === null ? null : Math.max(0, wallClockSeconds - verificationCommandSeconds - judgeSeconds),
    milestones: {
      initAt: state.createdAt || null,
      finalizedAt: receipt.completedAt || null,
    },
  };
}

function expectedEvaluatorModel(contract, runtime) {
  if (runtime === "claude-code") return contract.evaluation?.models?.claudeCode || null;
  if (runtime === "codex") return contract.evaluation?.models?.codex || null;
  return null;
}

function bareSessionId(value) {
  return typeof value === "string" ? value.replace(/^(?:claude|codex|opencode):/, "") : null;
}

function inspectSessionTranscript(file, receiptAt) {
  const ids = new Set();
  const evidenceIds = new Set();
  const timestamps = [];
  const implementationLines = [];
  const receiptMilliseconds = Date.parse(receiptAt);
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  for (const [index, line] of lines.entries()) {
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new Error(`session transcript has invalid JSON on line ${index + 1}: ${error.message}`);
    }
    const eventIds = [
      event.sessionId,
      event.type === "session_meta" ? event.payload?.id : null,
      event.type === "session_meta" ? event.payload?.session_id : null,
    ].map(bareSessionId).filter(Boolean);
    const eventEvidenceIds = [
      event.uuid,
      event.id,
      event.payload?.turn_id,
      event.type === "session_meta" ? null : event.payload?.id,
    ].filter(value => typeof value === "string" && value.trim());
    const eventTimestamps = [];
    for (const timestamp of [event.timestamp, event.snapshot?.timestamp, event.payload?.timestamp]) {
      const milliseconds = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
      if (!Number.isNaN(milliseconds)) {
        timestamps.push(milliseconds);
        eventTimestamps.push(milliseconds);
      }
    }
    if (eventTimestamps.some(milliseconds => milliseconds <= receiptMilliseconds)) {
      implementationLines.push(line);
      for (const id of eventIds) ids.add(id);
      for (const id of eventEvidenceIds) evidenceIds.add(id);
      evidenceIds.add(`line:${implementationLines.length}`);
    }
  }
  return {
    eventCount: implementationLines.length,
    sessionIds: [...ids].sort(),
    evidenceIds,
    startedAt: implementationLines.length
      ? new Date(Math.min(...timestamps.filter(milliseconds => milliseconds <= receiptMilliseconds))).toISOString()
      : null,
    endedAt: implementationLines.length
      ? new Date(Math.max(...timestamps.filter(milliseconds => milliseconds <= receiptMilliseconds))).toISOString()
      : null,
    observedThroughReceipt: timestamps.some(milliseconds => milliseconds >= receiptMilliseconds),
    implementationWindowHash: sha256Buffer(`${implementationLines.join("\n")}\n`),
  };
}

function hasJsonPointer(value, pointer) {
  if (typeof pointer !== "string" || !pointer.startsWith("/")) return false;
  let current = value;
  for (const rawPart of pointer.slice(1).split("/")) {
    const part = rawPart.replace(/~1/g, "/").replace(/~0/g, "~");
    if (current === null || typeof current !== "object"
        || !Object.prototype.hasOwnProperty.call(current, part)) return false;
    current = current[part];
  }
  return true;
}

function validateEvidenceReferences(qualitative, transcript, receipt, state, gates) {
  if (!qualitative) return;
  const references = [
    ...DIMENSIONS.flatMap(name => qualitative.dimensions[name].evidence),
    ...qualitative.findings.flatMap(finding => finding.evidence),
  ];
  for (const reference of references) {
    const separator = reference.indexOf(":");
    const source = separator === -1 ? reference : reference.slice(0, separator);
    const locator = separator === -1 ? "" : reference.slice(separator + 1);
    let exists = false;
    if (source === "session") exists = Boolean(transcript?.evidenceIds.has(locator));
    else if (source === "receipt") exists = hasJsonPointer(receipt, locator);
    else if (source === "state") exists = hasJsonPointer(state, locator);
    else if (source === "gates") exists = gates !== null && hasJsonPointer(gates, locator);
    if (!exists) throw new Error(`qualitative evidence reference does not exist: ${reference}`);
  }
}

function coverageRank(value) {
  return { unavailable: 0, partial: 1, complete: 2 }[value] ?? -1;
}

function gitValue(root, args) {
  const result = childProcess.spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function harnessIdentity() {
  const scriptRealPath = fs.realpathSync(__filename);
  const root = harnessRoot();
  const targets = [
    path.join(root, "cli", "src"),
    path.join(root, "cli", "lib"),
    path.join(root, "skills", "implement"),
    path.join(root, "skills", "benchmark-implement"),
    path.join(root, "scripts", "install-local-skills.mjs"),
  ];
  return {
    commit: gitValue(root, ["rev-parse", "HEAD"]),
    fingerprint: hashPaths(root, targets),
    reporterHash: sha256File(scriptRealPath),
  };
}

function readPreparedRun(projectRoot, contract, casePath, prdPath, runId) {
  if (!new RegExp(`^${contract.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-run-[1-9][0-9]*$`).test(runId)) {
    throw new Error(`--run-id must use ${contract.id}-run-N`);
  }
  const recordPath = path.join(projectRoot, "agents", "benchmarks", contract.id, runId, "run.json");
  const record = readJson(recordPath, "prepared benchmark run");
  if (record.schema !== RUN_SCHEMA) throw new Error(`prepared run schema must be ${RUN_SCHEMA}`);
  if (record.id !== runId || record.caseId !== contract.id) {
    throw new Error("prepared run identity does not match the requested benchmark run");
  }
  if (!new Set(["prepared", "reported"]).has(record.status)) {
    throw new Error(`benchmark run is not prepared: ${record.status || "unknown"}`);
  }
  if (record.caseHash !== sha256File(casePath) || record.prdHash !== sha256File(prdPath)) {
    throw new Error("benchmark case or PRD changed after the fresh environment was prepared");
  }
  if (!record.worktreePath || !fs.existsSync(record.worktreePath)) {
    throw new Error(`prepared benchmark worktree is unavailable: ${record.worktreePath || "missing"}`);
  }
  if (!record.preparedCasePath || !fs.existsSync(record.preparedCasePath)
      || !record.preparedPrdPath || !fs.existsSync(record.preparedPrdPath)) {
    throw new Error("prepared benchmark inputs are unavailable");
  }
  if (sha256File(record.preparedCasePath) !== record.caseHash
      || sha256File(record.preparedPrdPath) !== record.prdHash) {
    throw new Error("prepared benchmark inputs changed after environment preparation");
  }
  return { record, recordPath };
}

function commandReport(options) {
  const projectRoot = path.resolve(options["project-root"] || process.cwd());
  const casePath = path.resolve(projectRoot, requireOption(options, "case"));
  const runtime = requireOption(options, "runtime");
  if (!new Set(["claude-code", "codex"]).has(runtime)) throw new Error("--runtime must be claude-code or codex");
  const sessionId = requireOption(options, "session-id");
  const runId = requireOption(options, "run-id");
  const contract = validateCase(readJson(casePath, "benchmark case"));
  const prdPath = path.resolve(path.dirname(casePath), contract.prd);
  if (!fs.existsSync(prdPath)) throw new Error(`benchmark PRD not found: ${prdPath}`);
  const prepared = readPreparedRun(projectRoot, contract, casePath, prdPath, runId);
  const runDir = path.resolve(projectRoot, requireOption(options, "run-dir"));
  if (canonicalPath(runDir) !== canonicalPath(prepared.record.runDir)) {
    throw new Error(`--run-dir does not match the prepared fresh environment: ${prepared.record.runDir}`);
  }
  const receiptPath = path.join(runDir, "receipt.json");
  const statePath = path.join(runDir, "state.json");
  const receipt = readJson(receiptPath, "implementation receipt");
  const state = readJson(statePath, "implementation state");
  if (!state.projectRoot || canonicalPath(state.projectRoot) !== canonicalPath(prepared.record.worktreePath)) {
    throw new Error("implementation state does not belong to the prepared fresh worktree");
  }
  const startingTree = receipt.initialWorktreeSnapshot || prepared.record.initialWorktreeSnapshot;
  if (receipt.initialWorktreeSnapshot) {
    if (receipt.initialWorktreeSnapshot.headSha !== prepared.record.initialWorktreeSnapshot?.headSha
        || receipt.initialWorktreeSnapshot.statusHash !== prepared.record.initialWorktreeSnapshot?.statusHash) {
      throw new Error("implementation did not start from the prepared worktree snapshot");
    }
  } else {
    const initialSource = state.initialSource;
    if (!initialSource || !Array.isArray(initialSource.entries)) {
      throw new Error("implementation receipt has no start snapshot or v3 initial source snapshot");
    }
    if (initialSource.head && initialSource.head !== prepared.record.initialWorktreeSnapshot?.headSha) {
      throw new Error("implementation v3 source snapshot does not match the prepared HEAD");
    }
    const initialEntries = new Map(initialSource.entries.map(entry => [entry.path, entry.sha256]));
    for (const entry of prepared.record.initialWorktreeSnapshot?.entries || []) {
      if (initialEntries.get(entry.path) !== entry.sha256) {
        throw new Error("implementation v3 source snapshot changed before start: " + entry.path);
      }
    }
    for (const forbidden of contract.environment?.mustBeAbsent || []) {
      if ([...initialEntries.keys()].some(entry => entry === forbidden || entry.startsWith(forbidden + "/"))) {
        throw new Error("implementation v3 source snapshot already contained forbidden product path: " + forbidden);
      }
    }
  }
  const gatesPath = options.gates
    ? path.resolve(projectRoot, options.gates)
    : path.resolve(prepared.record.gatesPath);
  const gates = fs.existsSync(gatesPath) ? readJson(gatesPath, "gate ledger") : null;
  const qualitativePath = options.qualitative ? path.resolve(projectRoot, options.qualitative) : null;
  const qualitative = qualitativePath ? validateQualitative(readJson(qualitativePath, "qualitative evaluation")) : null;
  const sessionPath = options.session ? path.resolve(options.session) : null;
  if (sessionPath && !fs.existsSync(sessionPath)) throw new Error(`session transcript not found: ${sessionPath}`);
  const stateSessionId = bareSessionId(state.activeSessionId || state.ownerSessionId);
  const requestedSessionId = bareSessionId(sessionId);
  if (stateSessionId && stateSessionId !== requestedSessionId) {
    throw new Error(`session id does not match implementation state: expected ${stateSessionId}, received ${requestedSessionId}`);
  }
  const timing = modernTiming(state, receipt);
  const runStartedAt = timing?.milestones?.initAt || state.createdAt || null;
  const receiptAt = timing?.milestones?.finalizedAt || receipt.completedAt || receipt.verifiedAt || null;
  if (!receiptAt || Number.isNaN(Date.parse(receiptAt))) {
    throw new Error("implementation receipt has no valid finalized timestamp; session coverage cannot be verified");
  }
  const transcript = sessionPath ? inspectSessionTranscript(sessionPath, receiptAt) : null;
  if (transcript && !transcript.sessionIds.includes(requestedSessionId)) {
    throw new Error(`session transcript does not contain the implementation session id ${requestedSessionId}`);
  }
  validateEvidenceReferences(qualitative, transcript, receipt, state, gates);
  const transcriptCoversInit = Boolean(transcript?.startedAt && runStartedAt
    && Date.parse(transcript.startedAt) <= Date.parse(runStartedAt));
  const transcriptCoversReceipt = transcript?.observedThroughReceipt === true;
  if (qualitative?.sessionAnalysis?.coverage === "complete"
      && (!transcript || !transcriptCoversInit || !transcriptCoversReceipt)) {
    throw new Error("qualitative evaluation claims complete session coverage, but the transcript does not cover init through receipt");
  }

  const stages = stageSet(state, receipt, gates);
  const requiredStages = validateStringArray(contract.expected.requiredStages || [], "expected.requiredStages");
  const forbiddenStages = validateStringArray(contract.expected.forbiddenStages || [], "expected.forbiddenStages");
  const requiredStagesMissing = requiredStages.filter(stage => !stages.has(stage));
  const forbiddenStagesRun = forbiddenStages.filter(stage => stages.has(stage));
  const terminalStatusMatched = contract.expected.terminalStatuses.includes(receipt.status);
  const verifyAttempts = timing?.measured?.verifyGateAttempts
    ?? gates?.gates?.verify?.totalAttempts
    ?? state.verificationAttempts?.length
    ?? null;
  const verifyAttemptsWithinLimit = contract.expected.maxVerifyAttempts === undefined
    || (verifyAttempts !== null && verifyAttempts <= contract.expected.maxVerifyAttempts);
  const openCount = receipt.counts?.totalOpen !== undefined
    ? Number(receipt.counts.totalOpen)
    : (receipt.status === "complete" && state.status === "complete"
        ? 0
        : (state.tasks || []).filter(task => task.status !== "complete").length
          + (state.acceptanceCriteria || []).filter(item => item.status !== "complete").length
          + (state.verification || []).filter(item => item.requiredForDone && item.status !== "PASS").length);
  const falseComplete = receipt.status === "complete" && (
    openCount > 0
    || Number(receipt.counts?.requiredVerificationNotPassed || 0) > 0
    || ["BLOCKED", "STALE"].includes(receipt.verifyGate?.effective)
    || state.status !== "complete"
    || state.verificationAttempts?.at(-1)?.verdict !== "PASS"
  );
  const evaluationRequired = contract.evaluation?.required === true;
  const evaluationAvailable = qualitative !== null && qualitative.sessionAnalysis.coverage !== "unavailable";
  const requiredCoverage = contract.evaluation?.requiredCoverage || (evaluationRequired ? "complete" : "unavailable");
  const evaluationCoverageMatched = qualitative !== null
    && coverageRank(qualitative.sessionAnalysis.coverage) >= coverageRank(requiredCoverage)
    && (requiredCoverage !== "complete" || (transcriptCoversInit && transcriptCoversReceipt));
  const expectedModel = expectedEvaluatorModel(contract, runtime);
  const expectedEvaluatorRuntime = runtime === "claude-code" ? "claude-code" : "codex";
  const evaluatorRuntimeMatched = !qualitative || qualitative.evaluator.runtime === expectedEvaluatorRuntime;
  const evaluatorModelMatched = !qualitative || !expectedModel || qualitative.evaluator.model === expectedModel;
  const expectationChecks = {
    terminalStatusMatched,
    requiredStagesPresent: requiredStagesMissing.length === 0,
    forbiddenStagesAbsent: forbiddenStagesRun.length === 0,
    verifyAttemptsWithinLimit,
    falseCompleteAbsent: !falseComplete,
    evaluationAvailable: !evaluationRequired || evaluationAvailable,
    evaluationCoverageMatched: !evaluationRequired || evaluationCoverageMatched,
    evaluatorRuntimeMatched,
    evaluatorModelMatched,
  };
  const harness = harnessIdentity();
  const score = processScore(qualitative);
  const report = {
    schema: REPORT_SCHEMA,
    case: {
      id: contract.id,
      casePath: toProjectPath(projectRoot, casePath),
      caseHash: sha256File(casePath),
      prdPath: toProjectPath(projectRoot, prdPath),
      prdHash: sha256File(prdPath),
    },
    run: {
      id: runId,
      executor: { runtime, model: options.model || null },
      session: {
        id: sessionId,
        transcriptPath: sessionPath ? toProjectPath(projectRoot, sessionPath) : null,
        transcriptHash: transcript?.implementationWindowHash ?? null,
        eventCount: transcript?.eventCount ?? null,
        startedAt: transcript?.startedAt ?? null,
        endedAt: transcript?.endedAt ?? null,
        coversInit: transcriptCoversInit,
        coversReceipt: transcriptCoversReceipt,
      },
      harness,
      startingTree: {
        headSha: startingTree?.headSha || null,
        statusHash: startingTree?.statusHash || null,
      },
      environment: {
        worktreePath: prepared.record.worktreePath,
        preparedAt: prepared.record.preparedAt,
        baseRef: prepared.record.environment.baseRef,
      },
      receiptPath: toProjectPath(projectRoot, receiptPath),
      receiptHash: sha256File(receiptPath),
    },
    outcome: {
      expectedTerminalStatuses: contract.expected.terminalStatuses,
      actualStatus: receipt.status,
      expectedStatusMatched: terminalStatusMatched,
      validRun: Object.values(expectationChecks).every(Boolean),
      expectationChecks,
      openTrackedItems: openCount,
    },
    flow: {
      observedStages: [...stages],
      requiredStagesMissing,
      forbiddenStagesRun,
    },
    timing: timing ? {
      wallClockSeconds: timing.wallClockSeconds ?? null,
      closingSeconds: timing.taskEvidenceBoundary?.afterSeconds ?? null,
      verificationCommandSeconds: timing.measured?.verificationCommandSeconds ?? null,
      verificationCommandRuns: timing.measured?.verificationCommandRuns ?? null,
      judgeSeconds: timing.measured?.judgeSeconds ?? null,
      judgeCalls: timing.measured?.judgeCalls ?? null,
      unattributedSeconds: timing.unattributedSeconds ?? null,
      evaluationSeconds: qualitative?.evaluationTiming?.durationSeconds ?? null,
      milestones: timing.milestones || {},
    } : null,
    efficiency: {
      verifyAttempts,
      verifyAttemptLimit: contract.expected.maxVerifyAttempts ?? null,
      repeatedIdenticalDiffJudgments: repeatedFingerprintRuns(gates),
      fidelityReviewRounds: receipt.reviewRounds?.fidelity?.rounds
        ?? (state.verificationAttempts || []).filter(attempt => attempt.lanes?.fidelity).length
        ?? null,
      finalReviewRounds: receipt.reviewRounds?.final?.rounds ?? 0,
      avoidableReviewCalls: qualitative?.sessionAnalysis?.avoidableReviewCalls ?? null,
      unchangedCommandReruns: qualitative?.sessionAnalysis?.unchangedCommandReruns ?? null,
      unexpectedUserStops: qualitative?.sessionAnalysis?.unexpectedUserStops ?? null,
    },
    honesty: {
      falseComplete,
      staleGateInputs: receipt.verifyGate?.staleInputs?.length ?? 0,
      gateOverrideUsed: receipt.verifyGate?.overridden === true,
      receiptStatus: receipt.status,
      gateEffectiveStatus: receipt.verifyGate?.effective ?? receipt.unifiedVerdict ?? "NOT_RUN",
    },
    qualitative: qualitative ? {
      status: qualitative.sessionAnalysis.coverage === "unavailable" ? "unavailable" : "available",
      evaluator: qualitative.evaluator,
      evaluationTiming: qualitative.evaluationTiming,
      evaluatorRuntimeMatched,
      evaluatorModelMatched,
      sessionAnalysis: qualitative.sessionAnalysis,
      dimensions: qualitative.dimensions,
      findings: qualitative.findings,
      processScore: score,
    } : {
      status: "unavailable",
      reason: "qualitative evaluation was not provided",
      evaluatorRuntimeMatched,
      evaluatorModelMatched,
      processScore: score,
    },
    sources: {
      state: { path: toProjectPath(projectRoot, statePath), hash: sha256File(statePath) },
      gates: fs.existsSync(gatesPath) ? { path: toProjectPath(projectRoot, gatesPath), hash: sha256File(gatesPath) } : null,
      qualitative: qualitativePath ? { path: toProjectPath(projectRoot, qualitativePath), hash: sha256File(qualitativePath) } : null,
    },
  };
  const output = path.resolve(projectRoot, options.output || path.join("agents", "benchmarks", contract.id, runId, "report.json"));
  writeJsonAtomic(output, report);
  if (prepared.record.status === "prepared") {
    writeJsonAtomic(prepared.recordPath, {
      ...prepared.record,
      status: "reported",
      reportedAt: new Date().toISOString(),
      reportPath: toProjectPath(projectRoot, output),
    });
  }
  process.stdout.write(`${JSON.stringify({ ok: true, output: toProjectPath(projectRoot, output), validRun: report.outcome.validRun })}\n`);
}

function comparableReasons(baseline, candidate) {
  const checks = [
    ["case hash", baseline.case.caseHash, candidate.case.caseHash],
    ["PRD hash", baseline.case.prdHash, candidate.case.prdHash],
    ["starting HEAD", baseline.run.startingTree?.headSha, candidate.run.startingTree?.headSha],
    ["starting worktree", baseline.run.startingTree?.statusHash, candidate.run.startingTree?.statusHash],
    ["executor runtime", baseline.run.executor?.runtime, candidate.run.executor?.runtime],
    ["executor model", baseline.run.executor?.model, candidate.run.executor?.model],
  ];
  return checks.flatMap(([label, before, after]) => {
    if (before === null || before === undefined || after === null || after === undefined) {
      return [`${label} unavailable`];
    }
    return before === after ? [] : [`${label} differs`];
  });
}

function numberDelta(before, after) {
  return typeof before === "number" && typeof after === "number"
    ? Math.round((after - before) * 10) / 10
    : null;
}

function commandCompare(options) {
  const projectRoot = path.resolve(options["project-root"] || process.cwd());
  const baselinePath = path.resolve(projectRoot, requireOption(options, "baseline"));
  const candidatePath = path.resolve(projectRoot, requireOption(options, "candidate"));
  const baseline = readJson(baselinePath, "baseline report");
  const candidate = readJson(candidatePath, "candidate report");
  if (baseline.schema !== REPORT_SCHEMA || candidate.schema !== REPORT_SCHEMA) {
    throw new Error(`both inputs must use ${REPORT_SCHEMA}`);
  }
  const reasons = comparableReasons(baseline, candidate);
  const comparison = {
    schema: COMPARISON_SCHEMA,
    caseId: candidate.case.id,
    baselineRunId: baseline.run.id,
    candidateRunId: candidate.run.id,
    strictlyComparable: reasons.length === 0,
    comparabilityReasons: reasons,
    outcome: {
      baselineValid: baseline.outcome.validRun,
      candidateValid: candidate.outcome.validRun,
      changed: baseline.outcome.validRun !== candidate.outcome.validRun,
    },
    harness: {
      baselineCommit: baseline.run.harness?.commit ?? null,
      candidateCommit: candidate.run.harness?.commit ?? null,
      baselineFingerprint: baseline.run.harness?.fingerprint ?? null,
      candidateFingerprint: candidate.run.harness?.fingerprint ?? null,
      changed: baseline.run.harness?.fingerprint !== candidate.run.harness?.fingerprint,
    },
    deltas: {
      wallClockSeconds: numberDelta(baseline.timing?.wallClockSeconds, candidate.timing?.wallClockSeconds),
      closingSeconds: numberDelta(baseline.timing?.closingSeconds, candidate.timing?.closingSeconds),
      verificationCommandSeconds: numberDelta(baseline.timing?.verificationCommandSeconds, candidate.timing?.verificationCommandSeconds),
      judgeSeconds: numberDelta(baseline.timing?.judgeSeconds, candidate.timing?.judgeSeconds),
      judgeCalls: numberDelta(baseline.timing?.judgeCalls, candidate.timing?.judgeCalls),
      verifyAttempts: numberDelta(baseline.efficiency?.verifyAttempts, candidate.efficiency?.verifyAttempts),
      processScore: numberDelta(
        baseline.qualitative?.processScore?.score,
        candidate.qualitative?.processScore?.score,
      ),
    },
    sources: {
      baseline: { path: toProjectPath(projectRoot, baselinePath), hash: sha256File(baselinePath) },
      candidate: { path: toProjectPath(projectRoot, candidatePath), hash: sha256File(candidatePath) },
    },
  };
  const output = path.resolve(projectRoot, options.output || path.join(
    "agents", "benchmarks", candidate.case.id, `${baseline.run.id}-vs-${candidate.run.id}.json`,
  ));
  writeJsonAtomic(output, comparison);
  process.stdout.write(`${JSON.stringify({ ok: true, output: toProjectPath(projectRoot, output), strictlyComparable: comparison.strictlyComparable })}\n`);
}

function sessionRoots(runtime) {
  if (runtime === "claude-code") return [path.join(os.homedir(), ".claude", "projects")];
  if (runtime === "codex") return [
    path.join(os.homedir(), ".codex", "sessions"),
    path.join(os.homedir(), ".codex", "archived_sessions"),
  ];
  throw new Error("--runtime must be claude-code or codex");
}

function commandLocateSession(options) {
  const runtime = requireOption(options, "runtime");
  const sessionId = requireOption(options, "session-id");
  const candidates = sessionRoots(runtime)
    .flatMap(listFiles)
    .filter(file => file.endsWith(".jsonl") && path.basename(file).includes(sessionId));
  const status = candidates.length === 1 ? "found" : candidates.length === 0 ? "missing" : "ambiguous";
  process.stdout.write(`${JSON.stringify({ status, runtime, sessionId, candidates })}\n`);
  if (status !== "found") process.exitCode = 1;
}

function usage() {
  process.stderr.write(
    "Usage:\n"
    + "  benchmark_report.js prepare-run --case <benchmark.json>\n"
    + "  benchmark_report.js locate-session --runtime <claude-code|codex> --session-id <id>\n"
    + "  benchmark_report.js report --case <benchmark.json> --run-id <case-run-N> --run-dir <prepared-worktree/agents/runs/slug> --runtime <runtime> --session-id <id> [--session <jsonl>] [--qualitative <json>] [--model <model>] [--output <json>]\n"
    + "  benchmark_report.js compare --baseline <report.json> --candidate <report.json> [--output <json>]\n",
  );
}

function main() {
  const command = process.argv[2];
  if (!command || ["-h", "--help", "help"].includes(command)) {
    usage();
    if (!command) process.exitCode = 2;
    return;
  }
  const options = parseOptions(process.argv.slice(3));
  if (command === "prepare-run") commandPrepareRun(options);
  else if (command === "report") commandReport(options);
  else if (command === "compare") commandCompare(options);
  else if (command === "locate-session") commandLocateSession(options);
  else throw new Error(`Unknown command: ${command}`);
}

try {
  main();
} catch (error) {
  fail(error.message);
}
