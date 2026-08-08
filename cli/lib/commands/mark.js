"use strict";

const path = require("path");
const childProcess = require("child_process");

const { parseArgs, parseIdList, nowIso, cwd, resolveProjectPath, safeTimestamp, formatCommandArgs, commandArgsForCompare, writeMarkdown } = require("../util");
const { recordDeviation, markCompletionReviewsStale, findTrackedItem, countState } = require("../state_data");
const { commandsMatchContract } = require("../inference");
const { reverifyFingerprint } = require("../git");
const { readyExecutionPlan, plannedCommandForVerification, nextBrief } = require("../planning");
const { collectArtifacts, inspectArtifact } = require("../artifacts");
const { assertAllowedStatus } = require("../reviews");
const { attachArtifact, loadState, syncActive, persistState } = require("../state_store");

function cmdMark(options) {
  const kind = options.kind;
  const ids = parseIdList(options.id, value => value.toUpperCase());
  const status = String(options.status || "");
  const evidence = String(options.evidence || "").trim();
  const acIds = options.ac ? parseIdList(options.ac, value => value.toUpperCase()) : [];
  if (!["task", "ac", "verification"].includes(kind)) throw new Error("--kind must be task, ac, or verification");
  if (!ids.length) throw new Error("--id is required");
  if (!status) throw new Error("--status is required");
  if (!evidence) throw new Error("--evidence is required");
  if (acIds.length && kind !== "task") throw new Error("--ac is only valid with --kind task");
  if (acIds.length && status !== "complete") throw new Error("--ac requires --status complete; acceptance criteria are only co-marked with a completed task");

  const { statePath, state } = loadState(options);
  const list = kind === "task" ? state.tasks : kind === "ac" ? state.acceptanceCriteria : state.verification;
  assertAllowedStatus(kind, status);
  const marked = [];
  for (const id of ids) {
    const item = list.find(entry => String(entry.id).toUpperCase() === id);
    if (!item) throw new Error(`${kind} ${id} not found`);
    let deviationEntry = null;
    // Completing a task whose declared dependencies are still open is an
    // audit-worthy deviation in any mode: the plan's dependsOn contract is the
    // thing being bypassed. Harmless reorders of independent tasks stay silent.
    if (kind === "task" && status === "complete") {
      const ready = readyExecutionPlan(state);
      const blocker = ready.blocked.find(entry => entry.id === item.id);
      if (blocker) {
        const planSentinelsOnly = (blocker.waitingFor || []).every(waitId => ["VP0", "EP0"].includes(waitId));
        deviationEntry = recordDeviation(state, "ready_order", item.id, planSentinelsOnly
          ? "Task completed while the verification/execution plan still had blocking gaps"
          : "Task completed while its declared dependencies were still open", {
          waitingFor: blocker.waitingFor,
          readySequential: ready.readySequential,
        });
      }
    }
    item.status = status;
    item.evidence.push({ ts: nowIso(), text: evidence });
    marked.push(deviationEntry ? { kind, id, status, deviation: deviationEntry } : { kind, id, status });
  }
  for (const acId of acIds) {
    const item = state.acceptanceCriteria.find(entry => String(entry.id).toUpperCase() === acId);
    if (!item) throw new Error(`ac ${acId} not found`);
    item.status = "met";
    if (!item.evidence) item.evidence = [];
    item.evidence.push({ ts: nowIso(), text: evidence });
    marked.push({ kind: "ac", id: acId, status: "met" });
  }
  markCompletionReviewsStale(state, `${kind} ${ids.join(", ")} marked after review`);
  state.updatedAt = nowIso();
  persistState(statePath, state);
  syncActive(statePath, state);
  process.stdout.write(JSON.stringify({
    ok: true,
    marked,
    counts: countState(state),
    next: nextBrief(state),
  }, null, 2) + "\n");
}

function cmdAssign(options) {
  const id = String(options.id || "").toUpperCase();
  const owner = String(options.owner || "").trim();
  if (!id) throw new Error("--id is required");
  if (!owner) throw new Error("--owner is required");
  const { statePath, state } = loadState(options);
  const task = (state.tasks || []).find(entry => String(entry.id).toUpperCase() === id);
  if (!task) throw new Error(`Task ${id} not found`);
  task.owner = owner;
  markCompletionReviewsStale(state, `Task ${id} assignment changed after review`);
  state.updatedAt = nowIso();
  persistState(statePath, state);
  syncActive(statePath, state);
  process.stdout.write(JSON.stringify({
    ok: true,
    assigned: { id, owner },
    next: nextBrief(state),
  }, null, 2) + "\n");
}

function cmdRecordArtifact(options) {
  const id = String(options.id || "").toUpperCase();
  const kind = String(options.kind || "");
  const artifactPath = String(options.path || "");
  const description = String(options.description || "").trim();
  if (!id) throw new Error("--id is required");
  if (!kind) throw new Error("--kind is required");
  if (!artifactPath) throw new Error("--path is required");
  if (!description) throw new Error("--description is required");

  const { statePath, state } = loadState(options);
  const match = findTrackedItem(state, id);
  if (!match) throw new Error(`Tracked item ${id} not found`);
    const artifact = attachArtifact(statePath, state, match, kind, artifactPath, description);
    markCompletionReviewsStale(state, `Artifact was recorded for ${match.kind} ${match.item.id} after review`);
    state.updatedAt = nowIso();
  persistState(statePath, state);
  syncActive(statePath, state);
  process.stdout.write(JSON.stringify({
    ok: true,
    attachedTo: { kind: match.kind, id: match.item.id },
    artifact,
    counts: countState(state),
    next: nextBrief(state),
  }, null, 2) + "\n");
}

function cmdRefreshArtifacts(options) {
  const filterId = options.id ? String(options.id).toUpperCase() : null;
  const { statePath, state } = loadState(options);
  const projectRoot = state.projectRoot || cwd();
  const refreshed = [];
  const missing = [];
  let unchanged = 0;
  let matched = 0;

  for (const entry of collectArtifacts(state)) {
    if (filterId && String(entry.ownerId).toUpperCase() !== filterId) continue;
    matched += 1;
    const artifact = entry.artifact || {};
    if (!artifact.path) continue;
    const abs = resolveProjectPath(artifact.path, projectRoot);
    let info;
    try {
      info = inspectArtifact(abs, artifact.kind || "file");
    } catch (error) {
      missing.push({ owner: entry.ownerId, path: artifact.path, error: error.message });
      continue;
    }
    if (artifact.sha256 === info.sha256 && artifact.bytes === info.bytes) {
      unchanged += 1;
      continue;
    }
    const previousSha = artifact.sha256 || null;
    artifact.bytes = info.bytes;
    artifact.sha256 = info.sha256;
    artifact.mimeHint = info.mimeHint;
    if (info.width) artifact.width = info.width;
    if (info.height) artifact.height = info.height;
    artifact.refreshedAt = nowIso();
    const owner = findTrackedItem(state, entry.ownerId);
    if (owner && owner.item) {
      if (!owner.item.evidence) owner.item.evidence = [];
      owner.item.evidence.push({
        ts: nowIso(),
        text: `Artifact refreshed after in-place overwrite: ${artifact.kind} ${artifact.path} (${String(previousSha).slice(0, 12)} -> ${info.sha256.slice(0, 12)})`,
      });
    }
    refreshed.push({
      owner: entry.ownerId,
      path: artifact.path,
      previousSha256: previousSha,
      sha256: info.sha256,
    });
  }

  if (filterId && !matched) throw new Error(`Tracked item ${filterId} not found or has no artifacts`);

  if (refreshed.length) {
    markCompletionReviewsStale(state, "Registered artifacts were refreshed after review");
    state.updatedAt = nowIso();
    persistState(statePath, state);
    syncActive(statePath, state);
  }

  process.stdout.write(JSON.stringify({
    ok: missing.length === 0,
    refreshedCount: refreshed.length,
    unchangedCount: unchanged,
    refreshed,
    missing,
    note: refreshed.length
      ? "Completion reviews were marked stale; rerun requirements fidelity review and final review before finalize."
      : "No registered artifact hashes changed.",
  }, null, 2) + "\n");
  if (missing.length) process.exitCode = 2;
}

function cmdVerifyRun(rawArgs) {
  const separatorIndex = rawArgs.indexOf("--");
  if (separatorIndex < 0) throw new Error("verify-run requires -- before the command");
  const options = parseArgs(rawArgs.slice(0, separatorIndex));
  const commandArgs = rawArgs.slice(separatorIndex + 1);
  const id = String(options.id || "").toUpperCase();
  if (!id) throw new Error("--id is required");
  if (!commandArgs.length) throw new Error("verification command is required after --");

    const { statePath, state } = loadState(options);
    const match = findTrackedItem(state, id, "verification");
    if (!match) throw new Error(`Verification ${id} not found`);
    const commandText = formatCommandArgs(commandArgs);
    const commandCompareText = commandArgsForCompare(commandArgs);
    const plannedCommand = plannedCommandForVerification(state, id);
    const deviation = String(options.deviation || "").trim();
    let deviationEntry = null;
    if (!commandsMatchContract(commandCompareText, plannedCommand)) {
      if (!deviation) {
        throw new Error(`Verification ${id} command differs from PRD contract. Expected: ${plannedCommand}. Actual: ${commandText}. Re-run with --deviation <reason> if this is an intentional equivalent verifier.`);
      }
      deviationEntry = recordDeviation(state, "verification_command", id, deviation, {
        expectedCommand: plannedCommand,
        actualCommand: commandText,
      });
    }
    const startedAt = nowIso();
  const result = childProcess.spawnSync(commandArgs[0], commandArgs.slice(1), {
    cwd: state.projectRoot || cwd(),
    shell: false,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  const finishedAt = nowIso();
  const exitCode = typeof result.status === "number" ? result.status : 1;
  const signal = result.signal || null;
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const errorMessage = result.error && result.error.message ? result.error.message : "";
  const logRel = path.join(state.runDir, "artifacts", "logs", `${id}-${safeTimestamp()}.log`);
  const logAbs = path.join(state.projectRoot || cwd(), logRel);
  writeMarkdown(logAbs, [
    `command: ${commandText}`,
    `cwd: ${state.projectRoot || cwd()}`,
    `startedAt: ${startedAt}`,
    `finishedAt: ${finishedAt}`,
    `exitCode: ${exitCode}`,
    signal ? `signal: ${signal}` : "",
    errorMessage ? `error: ${errorMessage}` : "",
    "",
    "--- stdout ---",
    stdout,
    "",
    "--- stderr ---",
    stderr,
  ].filter(line => line !== "").join("\n"));

  const description = `verify-run ${exitCode === 0 ? "passed" : "failed"}: ${commandText}`;
    const artifact = attachArtifact(statePath, state, match, "command-log", logAbs, description, {
      command: commandText,
      contractCommand: plannedCommand || null,
      deviationId: deviationEntry ? deviationEntry.id : null,
      exitCode,
      startedAt,
      finishedAt,
      // The tree this result was earned on; finalize skips its reverification
      // when the fingerprint still matches (see reverifyFingerprint).
      treeFingerprint: exitCode === 0 ? reverifyFingerprint(state) : null,
    });
  match.item.status = exitCode === 0 ? "pass" : "fail";
  match.item.evidence.push({
    ts: nowIso(),
    text: `Command ${exitCode === 0 ? "passed" : "failed"} with exit code ${exitCode}: ${commandText}. Log: ${artifact.path}`,
  });
    markCompletionReviewsStale(state, `Verification ${id} was run after review`);
    state.updatedAt = nowIso();
  persistState(statePath, state);
  syncActive(statePath, state);
  process.stdout.write(JSON.stringify({
    ok: exitCode === 0,
    id,
    status: match.item.status,
    command: commandText,
    exitCode,
    logPath: artifact.path,
    counts: countState(state),
    next: nextBrief(state),
  }, null, 2) + "\n");
  if (exitCode !== 0) process.exitCode = 2;
}

module.exports = {
  cmdMark,
  cmdAssign,
  cmdRecordArtifact,
  cmdRefreshArtifacts,
  cmdVerifyRun,
};
