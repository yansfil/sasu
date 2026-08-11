"use strict";

const path = require("path");
const childProcess = require("child_process");

const fs = require("fs");

const { parseArgs, parseIdList, nowIso, cwd, resolveProjectPath, safeTimestamp, formatCommandArgs, commandArgsForCompare, writeMarkdown } = require("../util");
const { recordDeviation, findVerificationCommandDeviation, markCompletionReviewsStale, findTrackedItem, countState, autoCloseAcceptanceCriteria } = require("../state_data");
const { commandsMatchContract, shellLikeTokens } = require("../inference");
const { vouchedTreeFingerprintForState, vouchedFingerprintsMatch, stripFingerprintEntries, summarizeFingerprintDiff } = require("../git");
const { DB_TOUCH_PATTERN, readyExecutionPlan, plannedCommandForVerification, nextBrief } = require("../planning");
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
    // Oracle exclusivity: an AC with a declared machine oracle can only reach
    // `met` through the oracle's own observation. A manual met silently
    // overrode an oracle-recorded not_met (and the sweep then never
    // re-observed the overridden oracle), which is exactly the submission
    // bias the oracle grammar exists to remove. not_met/blocked stay allowed
    // as manual judgments - closing an AC pessimistically is never a bypass.
    if (kind === "ac" && item.oracle && status === "met") {
      throw new Error(`ac ${id} declares a machine oracle (Check:/Artifact: tail); the harness settles it mechanically - run oracle-run --id ${id} instead of marking it met by hand (manual not_met/blocked judgments stay allowed)`);
    }
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
    // Same oracle-exclusivity rule as the direct `mark --kind ac met` path:
    // the task co-mark must not become the side door to a manual met.
    if (item.oracle) {
      throw new Error(`ac ${acId} declares a machine oracle (Check:/Artifact: tail); drop it from --ac and run oracle-run --id ${acId} so the harness observes the pass`);
    }
    item.status = "met";
    if (!item.evidence) item.evidence = [];
    item.evidence.push({ ts: nowIso(), text: evidence });
    marked.push({ kind: "ac", id: acId, status: "met" });
  }
  // A verification pass may settle the whole coverage of pending ACs; derive
  // those closes instead of waiting for a manual sweep mark.
  const autoMet = autoCloseAcceptanceCriteria(state);
  markCompletionReviewsStale(state, `${kind} ${ids.join(", ")} marked after review`);
  state.updatedAt = nowIso();
  persistState(statePath, state);
  syncActive(statePath, state);
  process.stdout.write(JSON.stringify({
    ok: true,
    marked,
    autoMetAcceptanceCriteria: autoMet,
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
      // An identical (expected, actual) mismatch already justified on record
      // means the intentional-equivalent fact exists; demanding --deviation
      // again would only make the agent retype the same reason on every
      // re-run. Reuse the recorded justification (recordDeviation keeps the
      // original entry and bumps occurrences). Genuinely new mismatches still
      // require an explicit reason.
      const existing = findVerificationCommandDeviation(state, id, plannedCommand, commandText);
      if (!deviation && !existing) {
        throw new Error(`Verification ${id} command differs from PRD contract. Expected: ${plannedCommand}. Actual: ${commandText}. Re-run with --deviation <reason> if this is an intentional equivalent verifier.`);
      }
      deviationEntry = recordDeviation(state, "verification_command", id, deviation || existing.summary, {
        expectedCommand: plannedCommand,
        actualCommand: commandText,
      });
    }
    // Workspace digest guard (ouroboros parallel_executor import): fingerprint
    // the tree before and after the verification command so a command that
    // edits code to make itself pass cannot record that pass - reward hacking
    // via the verifier itself. A contract-declared side effect opts out, with
    // the skip on the record; harness bookkeeping (runDir, gates, quick) is
    // excluded from the fingerprint, so the harness's own log write cannot
    // trip the guard. When the run declares Scope globs the guard only sees
    // in-scope mutations - an accepted tradeoff: reward hacking edits the
    // code under test, which is in scope by definition, while whole-repo
    // fingerprints were falsely tripped by unrelated concurrent sessions in a
    // shared checkout (observed live).
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
    cwd: state.projectRoot || cwd(),
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
    `cwd: ${state.projectRoot || cwd()}`,
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
      contractCommand: plannedCommand || null,
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
    exitCode,
    digestGuard,
    logPath: artifact.path,
    autoMetAcceptanceCriteria: autoMet,
    counts: countState(state),
    next: nextBrief(state),
  }, null, 2) + "\n");
  if (!passed) process.exitCode = 2;
}

// A hung oracle must fail its AC, not hang the sweep (same bound as finalize
// reverification).
const ORACLE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Mechanically settle acceptance criteria that declare an oracle tail
 * (`Check: \`cmd\` [-> substring]` / `Artifact: <path>`, parsed at init).
 * Scaled-down ouroboros AcceptanceCriterionSpec: the check was declared in the
 * vetted PRD and is executed here on the harness's clock, so met/not_met is
 * observed, never claimed. Runs during the AC sweep - default is every open
 * oracle-backed AC; --id narrows it.
 *
 * Check oracles get the same workspace digest guard as verify-run ("검증 명령
 * 자체가 코드를 고쳐 통과하는 reward hacking 차단"); artifact oracles only read
 * the filesystem, so there is nothing to guard.
 */
function cmdOracleRun(options) {
  const { statePath, state } = loadState(options);
  const requestedIds = options.id ? parseIdList(options.id, value => value.toUpperCase()) : null;
  const projectRoot = state.projectRoot || cwd();
  const candidates = (state.acceptanceCriteria || []).filter(ac => {
    if (!ac.oracle || typeof ac.oracle !== "object") return false;
    if (requestedIds) return requestedIds.includes(String(ac.id).toUpperCase());
    // not_met is in the default sweep on purpose: a failed oracle whose world
    // has since been fixed must be re-observable by the documented bare
    // `oracle-run` (pending-only made a not_met oracle unreachable - the sweep
    // returned {ok:true, ran:0} forever and the AC could never flip to met).
    return ac.status === "pending" || ac.status === "not_met";
  });
  if (requestedIds) {
    for (const id of requestedIds) {
      const item = (state.acceptanceCriteria || []).find(ac => String(ac.id).toUpperCase() === id);
      if (!item) throw new Error(`ac ${id} not found`);
      if (!item.oracle) throw new Error(`ac ${id} has no declared oracle (Check:/Artifact: tail); use mark or verify-run instead`);
    }
  }
  const results = [];
  const warnings = [];
  for (const ac of candidates) {
    const oracle = ac.oracle;
    if (oracle.kind === "artifact") {
      const abs = resolveProjectPath(oracle.path, projectRoot);
      const exists = fs.existsSync(abs);
      const met = exists;
      ac.status = met ? "met" : "not_met";
      // Structured observation record: completionViolations accepts a met
      // oracle AC only when the latest harness-recorded observation is a pass.
      // Status alone is not evidence - it can be reached by state drift or a
      // hand edit without the oracle ever running.
      ac.oracleObservation = { at: nowIso(), kind: "artifact", met, path: oracle.path };
      const evidenceText = met
        ? `Oracle artifact check passed: ${oracle.path} exists (harness-observed)`
        : `Oracle artifact check failed: ${oracle.path} does not exist`;
      ac.evidence.push({ ts: nowIso(), text: evidenceText });
      results.push({ id: ac.id, kind: "artifact", path: oracle.path, met, evidence: evidenceText });
      continue;
    }
    const command = oracle.command;
    if (DB_TOUCH_PATTERN.test(command)) {
      warnings.push(`${ac.id}: oracle command appears to touch a database (\`${command}\`). Confirm the connection target is a disposable local or branch database, never production data.`);
    }
    const tokens = shellLikeTokens(command);
    // Same digest guard and same scoped-mode tradeoff as verify-run above: an
    // out-of-scope mutation by the oracle goes unseen, in exchange for
    // immunity to unrelated concurrent sessions' writes. Entries ride along
    // (free, see verify-run) so a violation names the moved paths.
    const preFingerprint = vouchedTreeFingerprintForState(state, { includeEntries: true });
    const startedAt = nowIso();
    const spawned = childProcess.spawnSync(tokens[0], tokens.slice(1), {
      cwd: projectRoot,
      shell: false,
      encoding: "utf8",
      timeout: ORACLE_TIMEOUT_MS,
      maxBuffer: 20 * 1024 * 1024,
    });
    const postFingerprint = vouchedTreeFingerprintForState(state, { includeEntries: true });
    const digestViolation = Boolean(preFingerprint && postFingerprint
      && !vouchedFingerprintsMatch(preFingerprint, postFingerprint));
    const digestDiff = digestViolation ? summarizeFingerprintDiff(preFingerprint, postFingerprint) : null;
    const exitCode = typeof spawned.status === "number" ? spawned.status : 1;
    const stdout = spawned.stdout || "";
    const expectMatched = oracle.expect ? stdout.includes(oracle.expect) : true;
    const met = exitCode === 0 && expectMatched && !digestViolation;
    const logRel = path.join(state.runDir, "artifacts", "logs", `${ac.id}-oracle-${safeTimestamp()}.log`);
    const logAbs = path.join(projectRoot, logRel);
    writeMarkdown(logAbs, [
      `command: ${command}`,
      `oracle: AC ${ac.id}`,
      oracle.expect ? `expected stdout substring: ${oracle.expect}` : "",
      `startedAt: ${startedAt}`,
      `finishedAt: ${nowIso()}`,
      `exitCode: ${exitCode}`,
      `expectMatched: ${expectMatched}`,
      `digestGuard: ${digestViolation ? `VIOLATED - workspace changed during the oracle command (${digestDiff ? digestDiff.text : "changed paths unavailable"})` : "clean"}`,
      spawned.signal ? `signal: ${spawned.signal}` : "",
      "",
      "--- stdout ---",
      stdout,
      "",
      "--- stderr ---",
      spawned.stderr || "",
    ].filter(line => line !== "").join("\n"));
    const evidenceText = digestViolation && exitCode === 0
      ? `Oracle check MUTATED the workspace (digest guard: ${digestDiff ? digestDiff.text : "changed paths unavailable"}): \`${command}\` exited 0 but changed the tree; recorded not_met. Log: ${logRel}`
      : met
        ? `Oracle check passed: harness ran \`${command}\` (exit 0${oracle.expect ? `, output contained "${oracle.expect}"` : ""}). Log: ${logRel}`
        : `Oracle check failed: \`${command}\` exited ${exitCode}${oracle.expect && !expectMatched ? `; output did not contain "${oracle.expect}"` : ""}. Log: ${logRel}`;
    ac.status = met ? "met" : "not_met";
    // Same structured observation contract as the artifact branch: finalize's
    // completionViolations demands a harness-recorded passing observation for
    // every met oracle AC.
    ac.oracleObservation = { at: nowIso(), kind: "check", met, exitCode, logPath: logRel };
    attachArtifact(statePath, state, { kind: "ac", item: ac }, "command-log", logAbs, `oracle-run ${met ? "passed" : "failed"}: ${command}`, {
      command,
      exitCode,
      expected: oracle.expect || null,
      expectMatched,
      digestGuard: {
        violated: digestViolation,
        before: stripFingerprintEntries(preFingerprint),
        after: stripFingerprintEntries(postFingerprint),
        ...(digestDiff ? { changedPaths: digestDiff.paths } : {}),
      },
    });
    // Pushed after attachArtifact so the oracle verdict is the item's latest
    // evidence line, not the artifact bookkeeping note.
    ac.evidence.push({ ts: nowIso(), text: evidenceText });
    results.push({
      id: ac.id, kind: "check", command, exitCode, expectMatched, digestViolation,
      ...(digestDiff ? { changedPaths: digestDiff.paths } : {}),
      met, logPath: logRel,
    });
  }
  if (results.length) {
    markCompletionReviewsStale(state, `Oracle-backed acceptance criteria were re-settled (${results.map(item => item.id).join(", ")})`);
    state.updatedAt = nowIso();
    persistState(statePath, state);
    syncActive(statePath, state);
  }
  const failed = results.filter(item => !item.met);
  process.stdout.write(JSON.stringify({
    ok: failed.length === 0,
    ran: results.length,
    results,
    warnings,
    counts: countState(state),
    next: nextBrief(state),
  }, null, 2) + "\n");
  if (failed.length) process.exitCode = 2;
}

module.exports = {
  cmdMark,
  cmdAssign,
  cmdRecordArtifact,
  cmdVerifyRun,
  cmdOracleRun,
};
