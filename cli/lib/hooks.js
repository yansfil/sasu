"use strict";

const fs = require("fs");
const path = require("path");

const { SCHEMA, DEFAULT_HOOK_TIMEOUT_MS, QUICK_ACTIVE_PATH, displayPath, harnessCommand, shipScriptPath, nowIso, cwd, resolveProjectPath, toProjectRelative, readJson, writeJson, appendJsonl } = require("./util");
const { hashGateInput } = require("./gate_freshness");
const { quickTreeFingerprint } = require("./git");
const { verificationPlanSummary, executionPlanSummary, countState, effectiveReviewPolicy } = require("./state_data");
const { readyExecutionPlan, nextItem, plannedCommandForVerification } = require("./planning");
const { collectArtifacts } = require("./artifacts");
const { completionViolations } = require("./reviews");
const { sameSessionId, sessionIdFromHookPayload, readActive, syncActive } = require("./state_store");
const { normalizeCommandForCompare } = require("./inference");

// Keep in sync with JUDGE_SUBPROCESS_ENV in cli/src/judge/backends.ts.
const JUDGE_SUBPROCESS_ENV = "SASU_JUDGE_SUBPROCESS";

function cmdHook(kind) {
  if (kind !== "stop" && kind !== "pretool-use" && kind !== "posttool-use") return;
  // A judge call is a real CLI session running in this project, so the user's
  // hooks fire inside it. Answering there is never right: the directive
  // derails the judge's reply and its session id would claim state belonging
  // to the agent that asked for the judgment.
  if (process.env[JUDGE_SUBPROCESS_ENV] === "1") return;
  const started = Date.now();
  readStdinJson(DEFAULT_HOOK_TIMEOUT_MS, payload => {
    try {
      const output = kind === "pretool-use"
        ? runPreToolUseHook(payload)
        : kind === "posttool-use"
          ? runPostToolUseHook(payload)
          : runStopHook(payload, started);
      if (output) process.stdout.write(output);
    } catch {
      // Hooks must fail open. The skill and finalizer remain the source of enforcement.
    }
  });
}

function readStdinJson(timeoutMs, callback) {
  let raw = "";
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    if (!raw.trim()) return callback(null);
    try {
      callback(JSON.parse(raw));
    } catch {
      callback(null);
    }
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { raw += chunk; });
  process.stdin.on("end", finish);
  process.stdin.on("error", finish);
  setTimeout(finish, timeoutMs).unref();
}

function deliveryShipPending(statePath, state) {
  if (state.status !== "complete") return false;
  if (!state.delivery || state.delivery.mode !== "pr") return false;
  if (!state.finalReceipt || state.finalReceipt.status !== "complete") return false;
  const logPath = path.join(path.dirname(statePath), "delivery", "ship-log.jsonl");
  if (!fs.existsSync(logPath)) return true;
  const lines = fs.readFileSync(logPath, "utf8").trim().split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const entry = JSON.parse(lines[index]);
      if (entry.event === "ship" && entry.pr) {
        return !["pass", "no-checks"].includes(String(entry.ciVerdict || ""));
      }
    } catch {
      // ignore malformed lines
    }
  }
  return true;
}

function renderShipHandoffDirective(statePath, state, hookCwd) {
  const shipCommand = `node ${displayPath(shipScriptPath())}`;
  return JSON.stringify({
    decision: "block",
    reason: `<prd-ship-handoff-guard>
Implementation receipt is complete, but delivery mode is 'pr' and no pull request has been shipped.

PRD: \`${state.prdPath}\`
State: \`${toProjectRelative(statePath, hookCwd)}\`

The thread is not done until the ship skill opens the PR and required CI passes or the delivery is explicitly reported as blocked. Run:

  ${shipCommand} body --state ${toProjectRelative(statePath, hookCwd)}
  (fill the AGENT-FILL prose sections from implementation-result.md)
  ${shipCommand} ship --state ${toProjectRelative(statePath, hookCwd)} --title "<PR title>"

If delivery is genuinely blocked, report the blocker explicitly to the user instead of stopping silently.
</prd-ship-handoff-guard>`,
  });
}

/**
 * Quick-path Stop guard: while `agents/quick/.quick-active.json` marks an
 * unfinished quick run, the turn may not end without a live verify PASS
 * (fresh contract hash AND unchanged tree fingerprint) plus the finalize
 * steps (receipt, contract status flip, marker removal).
 *
 * Two outcomes end the autonomous fix loop rather than driving another verify:
 * a finding marked requiresHuman, and an exhausted retry budget. Both still
 * demand the finalization steps, because a run handed to a person needs its
 * receipt and its open items just as much as a passing one does - and a
 * marker left behind becomes the next session's phantom active run.
 * Everything else about a non-PASS verify blocks with the exact command to
 * run. Same philosophy as the implement Stop guard: fail open on any read
 * error - the skill remains the source of enforcement.
 */
function quickStopDirective(hookCwd, sessionId) {
  const markerPath = path.join(hookCwd, QUICK_ACTIVE_PATH);
  if (!fs.existsSync(markerPath)) return "";
  const marker = readJson(markerPath);
  if (!marker || typeof marker.slug !== "string" || typeof marker.contractPath !== "string") return "";
  const foreignOwner = marker.activeSessionId && !sameSessionId(marker.activeSessionId, sessionId);
  if (!marker.activeSessionId) {
    marker.activeSessionId = sessionId;
    writeJson(markerPath, marker);
  }

  const verifyCommand = `sasu verify --slug ${marker.slug} --contract ${marker.contractPath}${marker.baseRef ? ` --base ${marker.baseRef}` : ""} --json`;
  const block = reason => JSON.stringify({ decision: "block", reason: `<quick-verify-guard>\n${reason}\n</quick-verify-guard>` });

  // A marker claimed by another session used to silently allow the stop, which
  // meant a stray hook firing in this directory could disarm the guard for the
  // session actually doing the work. Say so instead of going quiet.
  if (foreignOwner) {
    return block(`A quick run ('${marker.slug}') is active in this directory but is owned by another session (${marker.activeSessionId}).\n\nIf that run is yours, adopt it by clearing "activeSessionId" in \`${QUICK_ACTIVE_PATH}\` and finish it normally. If it is genuinely abandoned, say so to the user and let them decide - do not start a second quick run alongside it.`);
  }
  const gatesPath = path.join(hookCwd, "agents", "gates", marker.slug, "gates.json");
  const gates = fs.existsSync(gatesPath) ? readJson(gatesPath) : null;
  const record = gates && gates.gates ? gates.gates.verify : null;

  if (!record || record.verdict === null) {
    return block(`Quick run '${marker.slug}' is active but its verify gate has not run.\n\nContract: \`${marker.contractPath}\`\n\nThe turn is not done until verification passes. Run:\n\n  ${verifyCommand}`);
  }

  // The guard checks the finalize steps it can see rather than trusting a
  // deleted marker as proof of a finished run, and retires the marker itself
  // once they are done - so "delete the file" is never the way out.
  const finalizeDirective = (opening, closing) => {
    const receiptRel = path.join(path.dirname(marker.contractPath), "receipt.md");
    const remaining = [];
    if (!fs.existsSync(path.join(hookCwd, receiptRel))) {
      remaining.push(`Write \`${receiptRel}\` from the verify --json output (embed the per-AC verdicts, check results, evidence artifacts, and mechanical runs verbatim; do not restate them by hand).`);
    }
    if (!/^status:\s*complete\s*$/m.test(readTextOrEmpty(path.join(hookCwd, marker.contractPath)))) {
      remaining.push(`Set \`status: complete\` in \`${marker.contractPath}\` frontmatter.`);
    }
    if (remaining.length === 0) {
      fs.rmSync(markerPath, { force: true });
      return "";
    }
    const steps = remaining.map((step, index) => `${index + 1}. ${step}`).join("\n");
    return block(`Quick run '${marker.slug}' ${opening.trimEnd()}\n\nFinish the run before stopping:\n\n${steps}\n\n${closing}`);
  };

  const passDirective = () => finalizeDirective("has a live verify PASS.", "Then report the result to the user. The guard retires the run marker itself once these are done.");

  if (record.overridden) return passDirective();

  if (record.verdict === "PASS") {
    const staleReasons = [];
    for (const input of record.inputs || []) {
      const hash = hashGateInput(path.join(hookCwd, input.path), input.kind);
      if (hash === null) staleReasons.push(`${input.kind === "evidence" ? "evidence" : "input"} ${input.path} is missing`);
      else if (hash !== input.sha256) staleReasons.push(`${input.kind === "evidence" ? "evidence" : "input"} ${input.path} changed after the pass`);
    }
    const saved = record.treeFingerprint;
    if (saved && saved.statusHash) {
      let current = null;
      try {
        current = quickTreeFingerprint(hookCwd);
      } catch {
        current = null;
      }
      if (current && (current.statusHash !== saved.statusHash || current.headSha !== saved.headSha)) {
        staleReasons.push("the working tree changed after the pass (code edited since verification)");
      }
    }
    if (staleReasons.length) {
      return block(`Quick run '${marker.slug}' has a verify PASS that is no longer live:\n\n${staleReasons.map(item => `- ${item}`).join("\n")}\n\nRe-run verification on the current state:\n\n  ${verifyCommand}`);
    }
    return passDirective();
  }

  // BLOCKED / FAIL / ERROR: keep fixing inside the retry budget; a
  // human-decision finding or an exhausted budget ends the autonomous loop.
  const findings = Array.isArray(record.findings) ? record.findings : [];
  const humanFindings = findings.filter(item => item && item.requiresHuman);
  const budget = quickRetryBudget(hookCwd);
  const budgetExhausted = typeof record.attempts === "number" && record.attempts >= budget;
  if (humanFindings.length || budgetExhausted) {
    // Ending the fix loop is not the same as ending the run: the user still
    // needs the receipt and the open items, and a marker left behind becomes
    // the next session's phantom active run. Verification staleness matters
    // here too, because the artifacts are exactly what the person will read.
    const evidenceDrift = [];
    for (const input of record.inputs || []) {
      const hash = hashGateInput(path.join(hookCwd, input.path), input.kind);
      if (hash === null) evidenceDrift.push(`${input.path} is missing`);
      else if (hash !== input.sha256) evidenceDrift.push(`${input.path} changed after the verdict`);
    }
    if (evidenceDrift.length) {
      return block(`Quick run '${marker.slug}' ended its fix loop, but its recorded evidence no longer matches what is on disk:\n\n${evidenceDrift.map(item => `- ${item}`).join("\n")}\n\nRe-run verification so the handoff carries real artifacts:\n\n  ${verifyCommand}`);
    }
    const why = humanFindings.length
      ? `needs human verification and cannot reach PASS on its own:\n\n${humanFindings.map(item => `- ${item.missing}`).join("\n")}`
      : `exhausted its ${budget}-attempt verify budget.`;
    return finalizeDirective(
      why,
      "Then report to the user: what passed, what is still open, and exactly what you need them to confirm. Do not call the run Done - name the open items. The guard retires the run marker itself once these are done.",
    );
  }
  const findingLines = findings
    .slice(0, 6)
    .map(item => `- ${item.severity} ${item.area}: ${item.missing}`)
    .join("\n");
  return block(`Quick run '${marker.slug}' verify gate is ${record.verdict} (attempt ${record.attempts}/${budget}).\n${findingLines ? `\nFindings:\n${findingLines}\n` : ""}\nFix the findings and re-run:\n\n  ${verifyCommand}\n\nNever run 'sasu gate override' yourself; if a finding needs a human decision, report it to the user instead.`);
}

function readTextOrEmpty(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function quickRetryBudget(hookCwd) {
  try {
    const config = readJson(path.join(hookCwd, "agents", "config.json"));
    const budget = config && config.judge ? config.judge.retryBudget : undefined;
    if (Number.isInteger(budget) && budget >= 0) return budget;
  } catch {
    // Missing or malformed config falls back to the CLI default below.
  }
  return 3;
}

function runStopHook(payload, started) {
  if (!payload || typeof payload !== "object") return "";
  const event = payload.hook_event_name;
  if (event !== "Stop") return "";
  if (payload.stop_hook_active === true) return "";
  const hookCwd = typeof payload.cwd === "string" ? payload.cwd : cwd();
  const sessionId = sessionIdFromHookPayload(payload);
  if (!sessionId) return "";
  // An implement run owns the session's Stop guard when one is active here;
  // the quick guard covers every path where no implement run claims the stop.
  const active = readActive(hookCwd, { sessionId });
  if (!active) return quickStopDirective(hookCwd, sessionId);
  const statePath = resolveProjectPath(active.active.statePath, hookCwd);
  if (!fs.existsSync(statePath)) return quickStopDirective(hookCwd, sessionId);
  const state = readJson(statePath);
  if (state.schema !== SCHEMA) return quickStopDirective(hookCwd, sessionId);
  if (state.activeSessionId && !sameSessionId(state.activeSessionId, sessionId)) return quickStopDirective(hookCwd, sessionId);
  if (state.status !== "active") {
    if (deliveryShipPending(statePath, state)) {
      return renderShipHandoffDirective(statePath, state, hookCwd);
    }
    return "";
  }
  // The user redirected the conversation; stay silent until the next harness
  // mutation clears the pause (see commands/lifecycle.js).
  if (state.paused) return "";
  // The receipt is the completion proof. Once it exists, the continuation loop
  // has nothing left to drive; only a pending PR handoff may still speak.
  if (state.finalReceipt) {
    return deliveryShipPending(statePath, state)
      ? renderShipHandoffDirective(statePath, state, hookCwd)
      : "";
  }
  if (!state.activeSessionId) {
    state.activeSessionId = sessionId;
    state.updatedAt = nowIso();
    writeJson(statePath, state);
    syncActive(statePath, state);
  }
  const counts = countState(state);
  const next = nextItem(state);
  // Re-inject the full step-by-step procedure only when the phase changes;
  // otherwise emit the compact State block so the loop does not burn ~1.7k
  // tokens repeating an unchanged procedure every turn.
  const phase = directivePhase(next);
  const verbose = state.lastStopPhase !== phase;
  if (verbose) {
    state.lastStopPhase = phase;
    state.updatedAt = nowIso();
    try {
      writeJson(statePath, state);
    } catch {
      // Non-fatal: persistence of the phase marker is best-effort. Worst case is
      // one extra verbose directive next turn.
    }
  }
  const directive = renderContinuationDirective({
    event,
    hookCwd,
    stateAbsPath: statePath,
    statePath: toProjectRelative(statePath, hookCwd),
    state,
    counts,
    next,
    verbose,
    elapsedMs: Date.now() - started,
  });
  return JSON.stringify({ decision: "block", reason: directive });
}

function directivePhase(next) {
  return next ? next.kind : "finalize";
}

function runPreToolUseHook(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (payload.hook_event_name !== "PreToolUse") return "";
  if (!isUpdateGoalCompleteAttempt(payload)) return "";
  const hookCwd = typeof payload.cwd === "string" ? payload.cwd : cwd();
  const sessionId = sessionIdFromHookPayload(payload);
  if (!sessionId) return "";
  const active = readActive(hookCwd, { sessionId });
  if (!active) return "";
  const statePath = resolveProjectPath(active.active.statePath, hookCwd);
  if (!fs.existsSync(statePath)) return "";
  const state = readJson(statePath);
  if (state.schema !== SCHEMA) return "";
  if (state.activeSessionId && !sameSessionId(state.activeSessionId, sessionId)) return "";
  if (state.status !== "active") {
    if (deliveryShipPending(statePath, state)) {
      return renderShipHandoffDirective(statePath, state, hookCwd);
    }
    return "";
  }
  if (!state.activeSessionId) {
    state.activeSessionId = sessionId;
    state.updatedAt = nowIso();
    writeJson(statePath, state);
    syncActive(statePath, state);
  }
  const counts = countState(state);
  const violations = completionViolations(statePath, state, { includeFinalReview: true });
  if (state.finalReceipt && counts.totalOpen === 0 && violations.length === 0) return "";
  const reviewPolicy = effectiveReviewPolicy(state);
  const finalReviewRequired = reviewPolicy.finalReviewRequired;
  const finalReviewRequirement = finalReviewRequired
    ? "record a passing final review"
    : "confirm the effective review policy does not require final adversarial review";
  return JSON.stringify({
    decision: "block",
    reason: `<prd-implement-goal-guard>
Blocked premature update_goal complete.

PRD: \`${state.prdPath}\`
State: \`${toProjectRelative(statePath, hookCwd)}\`
Open tracked items: ${counts.totalOpen}
Required verification not passed: ${counts.requiredVerificationNotPassed}
Verification plan: ${verificationPlanSummary(state).status} (${verificationPlanSummary(state).blockingGapCount} blocking gaps)
Execution plan: ${executionPlanSummary(state).status} (${executionPlanSummary(state).openTaskCount} open tasks, ${executionPlanSummary(state).blockingGapCount} blocking gaps)
Requirements fidelity review: ${state.requirementsFidelityReview ? state.requirementsFidelityReview.status : "pending"}
Final review: ${state.finalReview ? state.finalReview.status : finalReviewRequired ? "pending" : "not required by policy"}
Receipt: ${state.finalReceipt ? "present" : "missing"}

Run \`${harnessCommand()} status\`, close all tasks and PRD items with artifact-backed evidence, record a passing requirements fidelity review, ${finalReviewRequirement}, then finalize before marking the goal complete.
</prd-implement-goal-guard>`,
  });
}

/**
 * PostToolUse observer: the honest ledger for verification rehearsals.
 *
 * `verify-run` only ever records runs the agent chose to submit, and agents
 * submit when they expect green - six audited runs held 50 verification
 * executions with zero failures. The failures happen off the books, in plain
 * Bash calls of the same commands during development. This hook writes those
 * side-door runs to rehearsals.jsonl so a check's history shows whether it
 * ever went red before its official pass - a check that never failed anywhere
 * is indistinguishable from a check that guards nothing.
 *
 * Observer only: never blocks, never mutates state.json, fails open. Partial
 * coverage is fine (a rehearsal in an unmatched shape just goes unrecorded);
 * the goal is an honest sample, not a perimeter.
 */
function runPostToolUseHook(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (payload.hook_event_name !== "PostToolUse") return "";
  const toolName = String(payload.tool_name || payload.toolName || "");
  if (!/^(?:Bash|shell|local_shell)$/i.test(toolName)) return "";
  const input = payload.tool_input || payload.toolInput || {};
  const command = typeof input.command === "string" ? input.command : "";
  if (!command) return "";
  // The official channel: verify-run already records itself, with provenance.
  if (/prd_state_harness\.js|\bverify-run\b/.test(command)) return "";

  const hookCwd = typeof payload.cwd === "string" ? payload.cwd : cwd();
  const active = readActive(hookCwd, { sessionId: sessionIdFromHookPayload(payload) });
  if (!active) return "";
  const statePath = resolveProjectPath(active.active.statePath, hookCwd);
  if (!fs.existsSync(statePath)) return "";
  const state = readJson(statePath);
  if (state.schema !== SCHEMA || state.status !== "active") return "";

  const verificationId = matchRehearsalCommand(state, command);
  if (!verificationId) return "";
  appendJsonl(path.join(path.dirname(statePath), "rehearsals.jsonl"), {
    ts: nowIso(),
    verificationId,
    command,
    exitCode: rehearsalExitCode(payload),
    sessionId: sessionIdFromHookPayload(payload),
  });
  return "";
}

/**
 * Match a Bash command against the run's verification contract. A planned
 * command is either the resolved command itself or a prose Method cell around
 * a backticked command, so compare the raw text and every backtick span
 * (commandFromText's prose fallback truncates at periods - `process.exit(0)`
 * would lose its tail). A leading `cd <dir> &&` on either side is ignored:
 * scoping into a package dir is the dominant rehearsal shape and does not
 * change which check is being rehearsed.
 */
function matchRehearsalCommand(state, command) {
  const normalizedActual = normalizeRehearsalCommand(command);
  if (!normalizedActual) return null;
  for (const item of state.verification || []) {
    const contract = plannedCommandForVerification(state, item.id);
    if (!contract) continue;
    const candidates = [contract, ...[...String(contract).matchAll(/`([^`]+)`/g)].map(span => span[1])];
    for (const candidate of candidates) {
      const normalizedContract = normalizeRehearsalCommand(candidate);
      if (normalizedContract && normalizedContract === normalizedActual) return item.id;
    }
  }
  return null;
}

function normalizeRehearsalCommand(command) {
  return normalizeCommandForCompare(command).replace(/^cd\s+\S+\s*&&\s*/, "");
}

/** Exit code from a PostToolUse payload, tolerant of runtime shape drift. */
function rehearsalExitCode(payload) {
  const response = payload.tool_response || payload.toolResponse || payload.tool_result || {};
  for (const key of ["exit_code", "exitCode", "code", "returncode", "status"]) {
    const value = response && typeof response === "object" ? response[key] : undefined;
    if (typeof value === "number" && Number.isInteger(value)) return value;
  }
  if (response && typeof response === "object") {
    if (response.is_error === true || response.success === false) return 1;
    if (response.is_error === false || response.success === true) return 0;
  }
  return null;
}

function isUpdateGoalCompleteAttempt(payload) {
  const toolName = String(payload.tool_name || payload.toolName || payload.name || payload.tool || "");
  if (!/update_goal/i.test(toolName)) return false;
  const input = payload.tool_input || payload.toolInput || payload.input || payload.arguments || {};
  if (input && typeof input === "object" && input.status === "complete") return true;
  return /"status"\s*:\s*"complete"/.test(JSON.stringify(input));
}

function renderContinuationDirective(context) {
  const { state, counts, next } = context;
  const HARNESS = harnessCommand();
  const requirementsReviewStatus = state.requirementsFidelityReview ? state.requirementsFidelityReview.status : "pending";
  const reviewPolicy = effectiveReviewPolicy(state);
  const finalReviewRequired = reviewPolicy.finalReviewRequired;
  const finalReviewStatus = state.finalReview ? state.finalReview.status : finalReviewRequired ? "pending" : "not required by policy";
  const verificationPlan = verificationPlanSummary(state);
  const executionPlan = executionPlanSummary(state);
  const ready = readyExecutionPlan(state);
  const finalGateViolations = next ? [] : completionViolations(context.stateAbsPath, state, { includeFinalReview: true });
  const nextLine = next
    ? `${next.kind.toUpperCase()} ${next.item.id}: ${next.item.title}`
    : requirementsReviewStatus !== "pass"
      ? `REQUIREMENTS FIDELITY REVIEW: tracked items are closed; run strict intent review before ${finalReviewRequired ? "final adversarial review" : "finalize"}`
    : finalReviewRequired && finalReviewStatus !== "pass"
      ? "FINAL REVIEW: tracked items are closed; run adversarial review before finalizing"
      : finalReviewRequired
        ? "FINALIZE: final review passed; write receipt"
        : "FINALIZE: effective review-policy gates passed; write receipt";
  const finalGateBlock = finalGateViolations.length
    ? `\n# Final gate gaps\n\n${finalGateViolations.map(item => `- ${item}`).join("\n")}\n`
    : "";
  const proceduresBlock = context.verbose === false
    ? `# This turn

The phase has not changed since the last directive, so the full procedure is not repeated. Follow the step-by-step procedure already given for this phase (also in SKILL.md sections 5-7).

Drive the Next required item above to done, then record it with the matching harness command: \`mark --kind task\` for tasks, \`mark --kind ac\` for acceptance criteria, \`verify-run\` for command verification, \`record-artifact\` for browser/API/DB evidence, \`requirements-review-record\` / \`review-record\` for reviews, then \`finalize\`. Batch marks: \`--id\` accepts comma lists and \`mark --kind task --ac AC1,AC2\` closes a task plus its proven ACs in one call; every mark already returns counts and the next item, so do not poll \`status\` between marks.`
    : `# Required procedure this turn

1. The State block above and \`${context.statePath}\` are the source of truth. Mirror progress in the runtime task surface at phase boundaries only; the harness, not the tracker, is the completion authority. Do not re-read unchanged plan files each turn.
2. If the next item is \`VERIFICATION_PLAN VP0\`: inspect the blocking gaps in \`${HARNESS} status\`, fix the PRD verification contract or planner inputs, and rerun \`${HARNESS} plan-verification\` before implementation.
3. If the next item is \`EXECUTION_PLAN EP0\`: the auto-built execution plan has blocking gaps (unparsable PRD tasks or a dependency cycle); fix the PRD, run \`${HARNESS} reconcile\`, then \`${HARNESS} plan-execution\` until the gaps clear.
4. Otherwise drive the next item to done (SKILL.md sections 5-6 hold the details). Before the first code edit of the run, do the one-time coverage check (intent, ambiguity, coverage, structure-lock drift) and record material findings in \`${state.runDir}/context-notes.md\`. Stop for approval before material structure deviations, register artifacts immediately, then record with:
   - \`${HARNESS} mark --kind task --id <Tn[,Tn...]> --status complete [--ac <ACn,...>] --evidence "<evidence>"\`
   - \`${HARNESS} mark --kind ac --id <ACn[,ACn...]> --status met --evidence "<evidence>"\`
   - \`${HARNESS} verify-run --id <Vn> -- <command>\` and \`${HARNESS} record-artifact --id <Vn> --kind <kind> --path <artifact> --description "<what it proves>"\`
   - \`${HARNESS} oracle-run\` for ACs whose bullet declares a \`Check:\`/\`Artifact:\` oracle tail - the harness runs the declared check and settles met/not_met mechanically; never mark those by hand.
   Batch with comma lists and \`--ac\`; marks return counts and the next item, so do not poll \`status\`. A task closes only when you mark it with evidence that its mapped ACs and verification are satisfied. If status reports a PRD snapshot violation, run \`${HARNESS} reconcile\`, never \`init --force\`.
5. When no open items remain: sweep every AC (\`${HARNESS} oracle-run\` settles oracle-backed ones mechanically), stop verification-only runtime processes, then run the requirements fidelity review for profile ${reviewPolicy.profile}: \`${HARNESS} requirements-review-prompt\`, ${reviewPolicy.fidelityOwner === "independent"
    ? "have one fresh independent read-only sidecar write the report from the raw prompt (fresh manual pass if sidecars are unavailable, stating that fallback)"
    : "write the report as the main agent after reading the complete canonical qa-log or conversation source"}, save \`${state.runDir}/review/requirements-fidelity-review.md\`, and record it with \`${HARNESS} requirements-review-record --status pass|fail --report <path> --summary "<verdict>"\`. Sidecars never mutate harness state; the coordinator records.
${finalReviewRequired ? `6. Only after fidelity passes: \`${HARNESS} review-prompt\`, have a fresh independent read-only sidecar write \`${state.runDir}/review/final-review.md\`, then \`${HARNESS} review-record --status pass|fail --report <path> --summary "<verdict>"\`.
7. Only after the final review passes` : `6. This profile requires no final adversarial review. After fidelity passes`}: \`${HARNESS} finalize --status complete --summary "<evidence-backed summary>"\`. Do not report the run complete before \`${state.runDir}/receipt.json\` exists and \`status\` shows no open items or violations. If delivery mode is \`pr\`, the receipt alone is not completion: hand off to the ship skill with \`${context.statePath}\`.
${finalReviewRequired ? "8" : "7"}. If completion is impossible: record the fidelity review anyway (\`Status: FAIL\` is allowed), then \`finalize --status blocked\` or \`--status partial\`; never report \`Done\`.`;
  return `<prd-implement-continuation>

You are continuing an active PRD implementation. Do not ask whether to continue. The PRD and state files are the source of truth.
Exception: if the user's latest message redirects to unrelated work or explicitly asks to wrap up, run \`${HARNESS} pause --reason "<their words>"\`, then answer them; the loop stays silent until the next harness mutation resumes it.

# State

- PRD: \`${state.prdPath}\`
- State JSON: \`${context.statePath}\`
- Run dir: \`${state.runDir}\`
- Delivery mode: ${(state.delivery && state.delivery.mode) || "local"}
- Verification plan: ${verificationPlan.status} (${verificationPlan.checkCount} checks, ${verificationPlan.blockingGapCount} blocking gaps)
- Execution plan: ${executionPlan.status} (${executionPlan.taskCount} tasks, ${executionPlan.openTaskCount} open, ${executionPlan.blockingGapCount} blocking gaps)
- Ready tasks: ${ready.readySequential.length ? ready.readySequential.join(", ") : "none"}${ready.parallelEnabled ? `\n- Ready parallel groups: ${ready.readyParallelGroups.length ? ready.readyParallelGroups.map(group => `[${group.join(", ")}]`).join(", ") : "none"}` : ""}
- Blocked tasks: ${ready.blocked.length ? ready.blocked.map(item => `${item.id} waits for ${item.waitingFor.join(", ")}`).join("; ") : "none"}
- Open tasks: ${counts.tasksOpen}
- Open acceptance criteria: ${counts.acOpen}
- Open verification items: ${counts.verificationOpen}
- Required verification not passed: ${counts.requiredVerificationNotPassed}
- Blocked items: tasks ${counts.blocked.tasks}, AC ${counts.blocked.acceptanceCriteria}, verification ${counts.blocked.verification}
- Artifact count: ${collectArtifacts(state).length}
- Requirements fidelity review: ${requirementsReviewStatus}
- Final review: ${finalReviewStatus}
- Next required item: ${nextLine}
${finalGateBlock}

${proceduresBlock}

# Completion rule

The turn may end only after one tracked item is marked with evidence, artifact-backed verification is recorded, a concrete blocker is marked, or the final receipt is written.
If delivery mode is \`pr\`, a final completion answer also requires the ship PR URL and CI verdict.
Do not provide a final completion answer before the receipt exists.

</prd-implement-continuation>
`;
}

module.exports = {
  cmdHook,
  readStdinJson,
  deliveryShipPending,
  renderShipHandoffDirective,
  runStopHook,
  directivePhase,
  runPreToolUseHook,
  runPostToolUseHook,
  isUpdateGoalCompleteAttempt,
  renderContinuationDirective,
};
