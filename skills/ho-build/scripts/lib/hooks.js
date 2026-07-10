"use strict";

const fs = require("fs");
const path = require("path");

const { SCHEMA, DEFAULT_HOOK_TIMEOUT_MS, displayPath, harnessCommand, shipScriptPath, nowIso, cwd, resolveProjectPath, toProjectRelative, readJson, writeJson } = require("./util");
const { verificationPlanSummary, executionPlanSummary, countState, finalReviewRequiredForState } = require("./state_data");
const { taskGraphSummary, readyExecutionPlan, nextItem } = require("./planning");
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
  if (!state.activeSessionId) {
    state.activeSessionId = sessionId;
    state.updatedAt = nowIso();
    writeJson(statePath, state);
    syncActive(statePath, state);
  }
  const counts = countState(state);
  const next = nextItem(state);
  if (!next && state.finalReceipt) return "";
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
  const finalReviewRequired = finalReviewRequiredForState(state);
  const finalReviewRequirement = finalReviewRequired
    ? "record a passing final review"
    : "confirm the trivial review profile does not require final adversarial review";
  return JSON.stringify({
    decision: "block",
    reason: `<prd-implement-goal-guard>
Blocked premature update_goal complete.

PRD: \`${state.prdPath}\`
State: \`${toProjectRelative(statePath, hookCwd)}\`
	Open tracked items: ${counts.totalOpen}
	Required verification not passed: ${counts.requiredVerificationNotPassed}
	Verification plan: ${verificationPlanSummary(state).status} (${verificationPlanSummary(state).blockingGapCount} blocking gaps)
	Execution plan: ${executionPlanSummary(state).status} (${executionPlanSummary(state).openNodeCount} open nodes, ${executionPlanSummary(state).blockingGapCount} blocking gaps)
	Requirements fidelity review: ${state.requirementsFidelityReview ? state.requirementsFidelityReview.status : "pending"}
	Final review: ${state.finalReview ? state.finalReview.status : finalReviewRequired ? "pending" : "skipped by trivial profile"}
	Receipt: ${state.finalReceipt ? "present" : "missing"}

	Run \`${harnessCommand()} status\`, close all execution nodes and PRD items with artifact-backed evidence, record a passing requirements fidelity review, ${finalReviewRequirement}, then finalize before marking the goal complete.
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
  const finalReviewRequired = finalReviewRequiredForState(state);
  const finalReviewStatus = state.finalReview ? state.finalReview.status : finalReviewRequired ? "pending" : "skipped by trivial profile";
  const verificationPlan = verificationPlanSummary(state);
  const executionPlan = executionPlanSummary(state);
  const ready = readyExecutionPlan(state);
  const taskGraph = taskGraphSummary(state);
  const finalGateViolations = next ? [] : completionViolations(context.stateAbsPath, state, { includeFinalReview: true });
  const nextLine = next
    ? `${next.kind.toUpperCase()} ${next.item.id}: ${next.item.title}`
    : requirementsReviewStatus !== "pass"
      ? `REQUIREMENTS FIDELITY REVIEW: tracked items are closed; run strict intent review before ${finalReviewRequired ? "final adversarial review" : "finalize"}`
    : finalReviewRequired && finalReviewStatus !== "pass"
      ? "FINAL REVIEW: tracked items are closed; run adversarial review before finalizing"
      : finalReviewRequired
        ? "FINALIZE: final review passed; write receipt"
        : "FINALIZE: trivial profile gates passed; write receipt";
  const finalGateBlock = finalGateViolations.length
    ? `\n# Final gate gaps\n\n${finalGateViolations.map(item => `- ${item}`).join("\n")}\n`
    : "";
  const recentActivity = Array.isArray(context.recentLedger) && context.recentLedger.length
    ? context.recentLedger.join(" -> ")
    : "none";
  const proceduresBlock = context.verbose === false
    ? `# This turn

The phase has not changed since the last directive, so the full procedure is not repeated. Follow the step-by-step procedure already given for this phase (also in SKILL.md sections 6-12).

Drive the Next required item above to done, then record it with the matching harness command: \`mark-node\` for execution nodes, \`mark --kind ac\` for acceptance criteria, \`verify-run\` for command verification, \`record-artifact\` for browser/API/DB evidence, \`requirements-review-record\` / \`review-record\` for reviews, then \`finalize\`. Run \`status\` if you need the full graph again.`
    : `# Required procedure this turn

1. Mirror progress in the runtime's tracking surface when one is available: with Codex goal tools, call \`get_goal\` and \`create_goal\` for this PRD implementation (\`update_plan\` does not replace Goal state); in Claude Code, use the task list. The harness state, not the tracker, is the completion authority.
2. Treat the State block above and \`${context.statePath}\` as the source of truth. Read \`${state.runDir}/execution-plan.md\` and \`${state.runDir}/taskgraph.md\` only when planning changed, and consult \`${state.runDir}/ledger.jsonl\` only when the recent-activity summary above is not enough. Do not re-read unchanged plan views every turn.
3. If the next item is \`VERIFICATION_PLAN VP0\`, read \`${state.runDir}/verification-plan.md\`, fix the PRD verification contract or planner inputs, and rerun \`${HARNESS} plan-verification\` before implementation.
4. If the next item is \`EXECUTION_PLAN EP0\`, run \`${HARNESS} plan-execution\`, inspect \`ready\`, and use \`${state.runDir}/execution-plan.md\` as the work map.
5. After \`plan-execution\` and before material code edits, the main agent performs the coverage check. Inspect PRD/state/plan/taskgraph paths for intent, ambiguity, coverage, TaskGraph, and structure-lock drift; record material findings in \`${state.runDir}/context-notes.md\`.
6. Work sequentially on the next ready execution node. Parallel execution is opt-in via config (\`execution.parallel\`); only when the State block shows a Ready parallel groups line may the coordinator assign a safe disjoint group to subagents.
7. Use the PRD's Major Technical Structure Changes or documented structure lock. Stop for approval before material deviations.
8. Register artifacts immediately after producing them. Do not leave files under \`${state.runDir}/artifacts\` unregistered; record valid artifacts with \`record-artifact\` before using them as evidence.
9. After evidence exists, update state with:
   - \`${HARNESS} mark-node --id <Nn> --status complete --evidence "<command/test/file/screenshot evidence>"\`
   - \`${HARNESS} mark --kind ac --id <ACn> --status met --evidence "<evidence>"\`
   - \`${HARNESS} verify-run --id <Vn> -- <command>\`
   - \`${HARNESS} record-artifact --id <Vn> --kind screenshot|log|browser|api|db|file --path <artifact> --description "<what it proves>"\`
10. Let task status roll up from execution nodes, ACs, and verification. Use \`mark --kind task\` only for an explicit blocked/deferred/manual correction with evidence.
11. Do not mark the tracked goal or report the run complete until \`${state.runDir}/receipt.json\` exists, requirements fidelity review is pass, ${finalReviewRequired ? "final review is pass, " : ""}verification plan is ready, execution plan nodes are complete, every required verification item is pass, artifact validation has no violations, runtime processes started for verification are stopped or explicitly reported, and \`${HARNESS} status\` reports no open items or final gate violations.
    If delivery mode is \`pr\`, the receipt alone is not completion. Run the deliver skill and wait for PR creation plus required CI pass or an explicit delivery blocker.
12. When no open items remain, run the final AC + Verification sweep, then run the strict requirements fidelity review:
   - \`${HARNESS} requirements-review-prompt\`
   - The main agent writes this review by default. Do not spawn a requirements fidelity sidecar unless the user explicitly asks for one. It must compare original user intent, accepted decisions, rejected alternatives, PRD scope, ACs, verification evidence, and implementation result.
   - Write \`${state.runDir}/review/requirements-fidelity-review.md\`.
   - \`${HARNESS} requirements-review-record --status pass|fail --report ${state.runDir}/review/requirements-fidelity-review.md --summary "<requirements fidelity verdict>"\`
13. Before finalization${finalReviewRequired ? " or final adversarial review" : ""}, stop runtime servers, browser sessions, tunnels, or background processes started only for verification, unless explicitly left running and reported.
${finalReviewRequired ? `14. Only after \`requirements-review-record --status pass\`, run:
   - \`${HARNESS} review-prompt\`
   - Spawn a fresh independent adversarial reviewer sidecar with that prompt when multi-agent tools are available. This is the only required reviewer sidecar in the default workflow. Use a default read-only subagent; do not use \`hoyeon-*\` roles unless the user explicitly asked for one.
   - Write \`${state.runDir}/review/final-review.md\`.
   - \`${HARNESS} review-record --status pass|fail --report ${state.runDir}/review/final-review.md --summary "<review verdict>"\`
15. Only after \`review-record --status pass\`, finalize:
` : `14. This run uses the trivial review profile; final adversarial review is optional. After \`requirements-review-record --status pass\`, finalize:
`}
   - \`${HARNESS} finalize --status complete --summary "<short evidence-backed summary>"\`
   - If delivery mode is \`pr\`, immediately hand off to the deliver skill with \`${context.statePath}\`.
${finalReviewRequired ? "16" : "15"}. If completion is impossible and the next user-facing report will be blocked or partial, run the same requirements fidelity review first and record it before handoff:
   - \`${HARNESS} requirements-review-prompt\`
   - Write \`${state.runDir}/review/requirements-fidelity-review.md\` with \`Status: FAIL\` when intent/PRD/evidence do not fully align.
   - \`${HARNESS} requirements-review-record --status fail --report ${state.runDir}/review/requirements-fidelity-review.md --summary "<requirements fidelity blocker verdict>"\`
   - Then use \`finalize --status blocked\` or \`finalize --status partial\`; do not report \`Done\`.`;
  return `<prd-implement-continuation>

You are continuing an active PRD implementation. Do not ask whether to continue. The PRD and state files are the source of truth.

# State

- PRD: \`${state.prdPath}\`
- State JSON: \`${context.statePath}\`
- Run dir: \`${state.runDir}\`
- Delivery mode: ${(state.delivery && state.delivery.mode) || "local"}
- Verification plan: ${verificationPlan.status} (${verificationPlan.checkCount} checks, ${verificationPlan.blockingGapCount} blocking gaps)
- Execution plan: ${executionPlan.status} (${executionPlan.nodeCount} nodes, ${executionPlan.openNodeCount} open, ${executionPlan.blockingGapCount} blocking gaps)
- Task graph: ${taskGraph.status} (${taskGraph.nodeCount} nodes, ${taskGraph.edgeCount} edges, ${taskGraph.openNodeCount} open)
- Ready execution nodes: ${ready.readySequential.length ? ready.readySequential.join(", ") : "none"}${ready.parallelEnabled ? `\n- Ready parallel groups: ${ready.readyParallelGroups.length ? ready.readyParallelGroups.map(group => `[${group.join(", ")}]`).join(", ") : "none"}` : ""}
- Blocked execution nodes: ${ready.blocked.length ? ready.blocked.map(item => `${item.id} waits for ${item.waitingFor.join(", ")}`).join("; ") : "none"}
- Open execution nodes: ${counts.executionOpen}
	- Open tasks: ${counts.tasksOpen}
	- Open acceptance criteria: ${counts.acOpen}
	- Open verification items: ${counts.verificationOpen}
	- Required verification not passed: ${counts.requiredVerificationNotPassed}
	- Blocked items: execution ${counts.blocked.execution}, tasks ${counts.blocked.tasks}, AC ${counts.blocked.acceptanceCriteria}, verification ${counts.blocked.verification}
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
