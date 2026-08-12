"use strict";

const path = require("path");
const childProcess = require("child_process");

const fs = require("fs");

const { parseArgs, parseIdList, nowIso, cwd, safeTimestamp, formatCommandArgs, commandArgsForCompare, writeMarkdown } = require("../util");
const { recordDeviation, findVerificationCommandDeviation, markCompletionReviewsStale, findTrackedItem, countState, autoCloseAcceptanceCriteria } = require("../state_data");
const { preWorkItems, pendingPreWork, preWorkStatusDefect } = require("../prd_parser");
const { commandsMatchContract } = require("../inference");
const { vouchedTreeFingerprintForState, vouchedFingerprintsMatch, stripFingerprintEntries, summarizeFingerprintDiff } = require("../git");
const { readyExecutionPlan, plannedBindingForVerification, buildVerificationPlan, nextBrief } = require("../planning");
const { assertAllowedStatus } = require("../reviews");
const { attachArtifact, loadState, syncActive, persistState } = require("../state_store");

function cmdMark(options) {
  const kind = options.kind;
  const ids = parseIdList(options.id, value => value.toUpperCase());
  const status = String(options.status || "");
  const evidence = String(options.evidence || "").trim();
  const acIds = options.ac ? parseIdList(options.ac, value => value.toUpperCase()) : [];
  if (!["task", "ac", "verification", "prework"].includes(kind)) throw new Error("--kind must be task, ac, verification, or prework");
  if (!ids.length) throw new Error("--id is required");
  if (!status) throw new Error("--status is required");
  if (!evidence) throw new Error("--evidence is required");
  if (acIds.length && kind !== "task") throw new Error("--ac is only valid with --kind task");
  if (acIds.length && status !== "complete") throw new Error("--ac requires --status complete; acceptance criteria are only co-marked with a completed task");

  const { statePath, state } = loadState(options);
  // `prework` rides the existing mark machinery on purpose: disposing a §4
  // item is the same act as closing any other tracked row (id, status,
  // evidence), and a fifth command for it would be pure ceremony
  // (PRINCIPLES.md item 4). preWorkItems also migrates pre-2026-08-11
  // `{resolved}` records in place, so an in-flight run is markable.
  const list = kind === "task" ? state.tasks
    : kind === "ac" ? state.acceptanceCriteria
      : kind === "prework" ? preWorkItems(state)
        : state.verification;
  if (kind === "prework") {
    const defect = preWorkStatusDefect(status);
    if (defect) throw new Error(defect);
  } else {
    assertAllowedStatus(kind, status);
  }
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
  // A verification pass may settle the whole coverage of pending ACs; derive
  // those closes instead of waiting for a manual sweep mark.
  const autoMet = autoCloseAcceptanceCriteria(state);
  // A pre-work disposition says who deals with a prerequisite; it changes
  // nothing a review judged, so it must not invalidate a passed review. PRD
  // edits that add or reword §4 items go through reconcile, which owns that
  // staleness (PRINCIPLES.md item 13: no needless re-review round).
  if (kind !== "prework") markCompletionReviewsStale(state, `${kind} ${ids.join(", ")} marked after review`);
  state.updatedAt = nowIso();
  persistState(statePath, state);
  syncActive(statePath, state);
  const stillPending = pendingPreWork(state);
  process.stdout.write(JSON.stringify({
    ok: true,
    marked,
    autoMetAcceptanceCriteria: autoMet,
    counts: countState(state),
    ...(stillPending.length ? { preWorkPending: stillPending.map(item => `${item.id} (${item.section}): ${item.text}`) } : {}),
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
    const projectRoot = state.projectRoot || cwd();
    const commandCwd = normalizeVerificationCwd(options.cwd || ".", projectRoot);
    const commandCwdAbs = path.resolve(projectRoot, commandCwd);
    const commandText = formatCommandArgs(commandArgs);
    const commandCompareText = commandArgsForCompare(commandArgs);
    const plannedBinding = plannedBindingForVerification(state, id);
    if (!plannedBinding) throw new Error(`Verification ${id} has no verification-plan check; run plan-verification first`);
    const plannedCommand = plannedBinding.command;
    const plannedCwd = plannedBinding.cwd || ".";
    const deviation = String(options.deviation || "").trim();
    let deviationEntry = null;
    if (!plannedCommand) {
      plannedBinding.check.command = commandText;
      plannedBinding.check.cwd = commandCwd;
      plannedBinding.check.bindingSource = "verify-run";
      plannedBinding.check.status = "planned";
      state.verificationPlan = buildVerificationPlan(state, statePath);
    } else if (!commandsMatchContract(commandCompareText, plannedCommand) || commandCwd !== plannedCwd) {
      // An identical (expected, actual) mismatch already justified on record
      // means the intentional-equivalent fact exists; demanding --deviation
      // again would only make the agent retype the same reason on every
      // re-run. Reuse the recorded justification (recordDeviation keeps the
      // original entry and bumps occurrences). Genuinely new mismatches still
      // require an explicit reason.
      const existing = findVerificationCommandDeviation(state, id, plannedCommand, commandText, plannedCwd, commandCwd);
      if (!deviation && !existing) {
        throw new Error(`Verification ${id} binding differs from the implementation plan. Expected: cwd=${plannedCwd} ${plannedCommand}. Actual: cwd=${commandCwd} ${commandText}. Re-run with --deviation <reason> if this is an intentional equivalent verifier.`);
      }
      deviationEntry = recordDeviation(state, "verification_command", id, deviation || existing.summary, {
        expectedCommand: plannedCommand,
        actualCommand: commandText,
        expectedCwd: plannedCwd,
        actualCwd: commandCwd,
      });
    }
    // Workspace digest guard (ouroboros parallel_executor import): fingerprint
    // the tree before and after the verification command so a command that
    // edits code to make itself pass cannot record that pass - reward hacking
    // via the verifier itself. A contract-declared side effect opts out, with
    // the skip on the record; harness bookkeeping (runDir, gates, quick) is
    // excluded from the fingerprint, so the harness's own log write cannot
    // trip the guard. The whole curated repository is vouched so an executor
    // write scope can never hide a verifier mutation.
    const declaredSideEffect = match.item.matrix && typeof match.item.matrix.sideEffect === "string"
      ? match.item.matrix.sideEffect.trim()
      : "";
    const sideEffectDeclared = Boolean(declaredSideEffect) && !/^(none|없음|-|n\/a)$/i.test(declaredSideEffect);
    // includeEntries: the per-path pairs are computed inside the fingerprint
    // either way (only their hash was kept), so retaining them is free - and
    // they let a violation name WHICH paths moved instead of a bare boolean.
    // Entries are stripped before anything is persisted.
    const preFingerprint = sideEffectDeclared ? null : vouchedTreeFingerprintForState(state, { includeEntries: true });
    const startedAt = nowIso();
  const result = childProcess.spawnSync(commandArgs[0], commandArgs.slice(1), {
    cwd: commandCwdAbs,
    shell: false,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  const finishedAt = nowIso();
  const postFingerprint = sideEffectDeclared ? null : vouchedTreeFingerprintForState(state, { includeEntries: true });
  const digestDiff = preFingerprint && postFingerprint && !vouchedFingerprintsMatch(preFingerprint, postFingerprint)
    ? summarizeFingerprintDiff(preFingerprint, postFingerprint)
    : null;
  const digestGuard = sideEffectDeclared
    ? { skipped: `declared side effect: ${declaredSideEffect}` }
    : {
      violated: Boolean(preFingerprint && postFingerprint
        && !vouchedFingerprintsMatch(preFingerprint, postFingerprint)),
      before: stripFingerprintEntries(preFingerprint),
      after: stripFingerprintEntries(postFingerprint),
      ...(digestDiff ? { changedPaths: digestDiff.paths } : {}),
    };
  const exitCode = typeof result.status === "number" ? result.status : 1;
  // A pass earned by mutating the workspace is not a pass: the guard demotes
  // the outcome to fail so no evidence, artifact, or auto-met AC rests on it.
  const digestViolation = Boolean(digestGuard.violated) && exitCode === 0;
  const passed = exitCode === 0 && !digestViolation;
  const signal = result.signal || null;
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const errorMessage = result.error && result.error.message ? result.error.message : "";
  const logRel = path.join(state.runDir, "artifacts", "logs", `${id}-${safeTimestamp()}.log`);
  const logAbs = path.join(state.projectRoot || cwd(), logRel);
  writeMarkdown(logAbs, [
    `command: ${commandText}`,
    `cwd: ${commandCwd}`,
    `startedAt: ${startedAt}`,
    `finishedAt: ${finishedAt}`,
    `exitCode: ${exitCode}`,
    signal ? `signal: ${signal}` : "",
    errorMessage ? `error: ${errorMessage}` : "",
    digestGuard.skipped ? `digestGuard: skipped (${digestGuard.skipped})` : `digestGuard: ${digestViolation ? `VIOLATED - workspace changed during the verification command (${digestDiff ? digestDiff.text : "changed paths unavailable"})` : "clean"}`,
    "",
    "--- stdout ---",
    stdout,
    "",
    "--- stderr ---",
    stderr,
  ].filter(line => line !== "").join("\n"));

  const description = `verify-run ${passed ? "passed" : "failed"}: ${commandText}`;
    const artifact = attachArtifact(statePath, state, match, "command-log", logAbs, description, {
      command: commandText,
      cwd: commandCwd,
      contractCommand: plannedCommand || null,
      contractCwd: plannedCommand ? plannedCwd : null,
      deviationId: deviationEntry ? deviationEntry.id : null,
      exitCode,
      startedAt,
      finishedAt,
      digestGuard,
      // The tree this result was earned on; finalize skips its reverification
      // when the fingerprint still matches (see vouchedTreeFingerprint).
      treeFingerprint: passed ? stripFingerprintEntries(postFingerprint) || vouchedTreeFingerprintForState(state) : null,
    });
  match.item.status = passed ? "pass" : "fail";
  match.item.evidence.push({
    ts: nowIso(),
    text: digestViolation
      ? `Command exited 0 but MUTATED the workspace during verification (digest guard: ${digestDiff ? digestDiff.text : "changed paths unavailable"}): ${commandText}. Recorded as fail; a verifier must not change the code it judges. Declare the side effect in the PRD matrix if it is intentional. Log: ${artifact.path}`
      : `Command ${passed ? "passed" : "failed"} with exit code ${exitCode}: ${commandText}. Log: ${artifact.path}`,
  });
    const autoMet = autoCloseAcceptanceCriteria(state);
    markCompletionReviewsStale(state, `Verification ${id} was run after review`);
    state.updatedAt = nowIso();
  persistState(statePath, state);
  syncActive(statePath, state);
  process.stdout.write(JSON.stringify({
    ok: passed,
    id,
    status: match.item.status,
    command: commandText,
    cwd: commandCwd,
    exitCode,
    digestGuard,
    logPath: artifact.path,
    autoMetAcceptanceCriteria: autoMet,
    counts: countState(state),
    next: nextBrief(state),
  }, null, 2) + "\n");
  if (!passed) process.exitCode = 2;
}

function normalizeVerificationCwd(value, projectRoot) {
  const raw = String(value || ".").trim() || ".";
  if (path.isAbsolute(raw)) throw new Error("--cwd must be repository-relative");
  const absolute = path.resolve(projectRoot, raw);
  const relative = path.relative(projectRoot, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("--cwd must stay inside the project root");
  }
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
    throw new Error(`--cwd directory does not exist: ${raw}`);
  }
  return relative ? relative.split(path.sep).join("/") : ".";
}

module.exports = {
  cmdMark,
  cmdAssign,
  cmdRecordArtifact,
  cmdVerifyRun,
};
