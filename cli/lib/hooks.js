"use strict";

const fs = require("fs");
const path = require("path");

const { SCHEMA, DEFAULT_HOOK_TIMEOUT_MS, displayPath, harnessCommand, shipScriptPath, nowIso, cwd, resolveProjectPath, toProjectRelative, readJson, writeJson } = require("./util");
const { verificationPlanSummary, executionPlanSummary, countState, effectiveReviewPolicy } = require("./state_data");
const { readyExecutionPlan, nextItem } = require("./planning");
const { collectArtifacts } = require("./artifacts");
const { completionViolations } = require("./reviews");
const { sameSessionId, sessionIdFromHookPayload, readActive, syncActive } = require("./state_store");

function cmdHook(kind) {
  if (kind !== "stop" && kind !== "subagent-stop" && kind !== "pretool-use") return;
  const started = Date.now();
  readStdinJson(DEFAULT_HOOK_TIMEOUT_MS, payload => {
    try {
      const output = kind === "pretool-use"
        ? runPreToolUseHook(payload)
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

The thread is not done until the deliver skill opens the PR and required CI passes or the delivery is explicitly reported as blocked. Run:

  ${shipCommand} body --state ${toProjectRelative(statePath, hookCwd)}
  (fill the AGENT-FILL prose sections from implementation-result.md)
  ${shipCommand} ship --state ${toProjectRelative(statePath, hookCwd)} --title "<PR title>"

If delivery is genuinely blocked, report the blocker explicitly to the user instead of stopping silently.
</prd-ship-handoff-guard>`,
  });
}

function runStopHook(payload, started) {
  if (!payload || typeof payload !== "object") return "";
	  const event = payload.hook_event_name;
	  if (event !== "Stop" && event !== "SubagentStop") return "";
  if (event === "SubagentStop") return "";
	  if (payload.stop_hook_active === true) return "";
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
    recentLedger: recentLedgerEvents(path.dirname(statePath)),
    elapsedMs: Date.now() - started,
  });
  return JSON.stringify({ decision: "block", reason: directive });
}

function directivePhase(next) {
  return next ? next.kind : "finalize";
}

function recentLedgerEvents(runDirAbs, limit = 3) {
  try {
    const file = path.join(runDirAbs, "ledger.jsonl");
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean);
    return lines.slice(-limit).map(line => {
      try {
        const entry = JSON.parse(line);
        const idPart = entry.id ? ` ${entry.id}` : Array.isArray(entry.ids) ? ` ${entry.ids.join(",")}` : "";
        return `${entry.event || "event"}${idPart}`;
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
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
  const recentActivity = Array.isArray(context.recentLedger) && context.recentLedger.length
    ? context.recentLedger.join(" -> ")
    : "none";
  const proceduresBlock = context.verbose === false
    ? `# This turn

The phase has not changed since the last directive, so the full procedure is not repeated. Follow the step-by-step procedure already given for this phase (also in SKILL.md sections 5-7).

Drive the Next required item above to done, then record it with the matching harness command: \`mark --kind task\` for tasks, \`mark --kind ac\` for acceptance criteria, \`verify-run\` for command verification, \`record-artifact\` for browser/API/DB evidence, \`requirements-review-record\` / \`review-record\` for reviews, then \`finalize\`. Batch marks: \`--id\` accepts comma lists and \`mark --kind task --ac AC1,AC2\` closes a task plus its proven ACs in one call; every mark already returns counts and the next item, so do not poll \`status\` between marks.`
    : `# Required procedure this turn

1. The State block above and \`${context.statePath}\` are the source of truth. Mirror progress in the runtime task surface at phase boundaries only; the harness, not the tracker, is the completion authority. Do not re-read unchanged plan files each turn.
2. If the next item is \`VERIFICATION_PLAN VP0\`: read \`${state.runDir}/verification-plan.md\`, fix the PRD verification contract or planner inputs, and rerun \`${HARNESS} plan-verification\` before implementation.
3. If the next item is \`EXECUTION_PLAN EP0\`: run \`${HARNESS} plan-execution\`, inspect \`ready\`, then do the one-time coverage check (intent, ambiguity, coverage, structure-lock drift) and record material findings in \`${state.runDir}/context-notes.md\` before editing code.
4. Otherwise drive the next item to done (SKILL.md sections 5-6 hold the details), stop for approval before material structure deviations, register artifacts immediately, then record with:
   - \`${HARNESS} mark --kind task --id <Tn[,Tn...]> --status complete [--ac <ACn,...>] --evidence "<evidence>"\`
   - \`${HARNESS} mark --kind ac --id <ACn[,ACn...]> --status met --evidence "<evidence>"\`
   - \`${HARNESS} verify-run --id <Vn> -- <command>\` and \`${HARNESS} record-artifact --id <Vn> --kind <kind> --path <artifact> --description "<what it proves>"\`
   Batch with comma lists and \`--ac\`; marks return counts and the next item, so do not poll \`status\`. A task closes only when you mark it with evidence that its mapped ACs and verification are satisfied. If status reports a PRD snapshot violation, run \`${HARNESS} reconcile\`, never \`init --force\`.
5. When no open items remain: sweep every AC, stop verification-only runtime processes, then run the requirements fidelity review for profile ${reviewPolicy.profile}: \`${HARNESS} requirements-review-prompt\`, ${reviewPolicy.fidelityOwner === "independent"
    ? "have one fresh independent read-only sidecar write the report from the raw prompt (fresh manual pass if sidecars are unavailable, stating that fallback)"
    : "write the report as the main agent after reading the complete canonical qa-log or conversation source"}, save \`${state.runDir}/review/requirements-fidelity-review.md\`, and record it with \`${HARNESS} requirements-review-record --status pass|fail --report <path> --summary "<verdict>"\`. Sidecars never mutate harness state; the coordinator records.
${finalReviewRequired ? `6. Only after fidelity passes: \`${HARNESS} review-prompt\`, have a fresh independent read-only sidecar write \`${state.runDir}/review/final-review.md\`, then \`${HARNESS} review-record --status pass|fail --report <path> --summary "<verdict>"\`.
7. Only after the final review passes` : `6. This profile requires no final adversarial review. After fidelity passes`}: \`${HARNESS} finalize --status complete --summary "<evidence-backed summary>"\`. Do not report the run complete before \`${state.runDir}/receipt.json\` exists and \`status\` shows no open items or violations. If delivery mode is \`pr\`, the receipt alone is not completion: hand off to the deliver skill with \`${context.statePath}\`.
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
- Recent activity: ${recentActivity}
- Next required item: ${nextLine}
${finalGateBlock}

${proceduresBlock}

# Completion rule

The turn may end only after one tracked item is marked with evidence, artifact-backed verification is recorded, a concrete blocker is marked, or the final receipt is written.
If delivery mode is \`pr\`, a final completion answer also requires the deliver (prd-ship) PR URL and CI verdict.
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
  recentLedgerEvents,
  runPreToolUseHook,
  isUpdateGoalCompleteAttempt,
  renderContinuationDirective,
};
