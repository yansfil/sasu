"use strict";

const fs = require("fs");
const path = require("path");

const { writeJson, writeMarkdown, NAMESPACE_ROOT } = require("./util");
const { isVerificationRequiredForDone, verificationIsClosedForAccounting, executionPlanSummary, reviewProfileName, finalReviewRequiredForState, effectiveReviewPolicy } = require("./state_data");
const { readyExecutionPlan, buildTraceMatrix, executionCoverageForTask } = require("./planning");
const { collectArtifacts } = require("./artifacts");
const { verifyGateStatus } = require("./reviews");
const { snapshotEntriesEqual } = require("./git");

function checkbox(done) {
  return done ? "[x]" : "[ ]";
}

function evidenceText(item) {
  if (!item.evidence || item.evidence.length === 0) return "";
  return item.evidence.map(entry => `    - ${entry.ts}: ${entry.text}`).join("\n");
}

function artifactText(item) {
  if (!item.artifacts || item.artifacts.length === 0) return "";
  return item.artifacts.map(artifact => `    - ${artifact.kind}: ${artifact.path} (${String(artifact.sha256 || "").slice(0, 12)})`).join("\n");
}

function renderExecutionPlan(state) {
  const plan = state.executionPlan;
  if (!plan) return "# Execution Plan\n\nStatus: missing\n";
  const ready = readyExecutionPlan(state);
  const lines = [
    `# Execution Plan: ${state.topicSlug}`,
    "",
    `- PRD: ${state.prdPath}`,
    `- Status: ${plan.status}`,
    `- Generated: ${plan.generatedAt}`,
    `- Tasks: ${(state.tasks || []).length}`,
    `- Task plan applied: ${plan.taskPlanApplied ? "yes" : "no"}`,
    `- Blocking gaps: ${(plan.gaps || []).filter(gap => gap.severity === "blocking").length}`,
    `- Warnings: ${(plan.gaps || []).filter(gap => gap.severity !== "blocking").length}`,
    "",
    "## Ready Guidance",
    "",
    `- Ready sequential: ${ready.readySequential.length ? ready.readySequential.join(", ") : "none"}`,
    `- Ready parallel groups: ${ready.readyParallelGroups.length ? ready.readyParallelGroups.map(group => `[${group.join(", ")}]`).join(", ") : "none"}`,
    "",
    "## Tasks",
    "",
  ];
  for (const task of state.tasks || []) {
    lines.push(`### ${task.id}. ${task.title}`);
    lines.push("");
    lines.push(`- Status: ${task.status}`);
    lines.push(`- Owner: ${task.owner || "unassigned"}`);
    lines.push(`- Depends on: ${(task.dependsOn || []).length ? task.dependsOn.join(", ") : "none"}`);
    lines.push(`- Write scope: ${(task.writeScope || []).length ? task.writeScope.join(", ") : "unknown"}`);
    lines.push(`- Parallel safe: ${task.parallelSafe ? "yes" : "no"}`);
    lines.push(`- Risk: ${task.risk}`);
    lines.push(`- Covers: ${formatCoverage(executionCoverageForTask(state, task))}`);
    if (task.evidence && task.evidence.length) {
      lines.push("- Evidence:");
      for (const entry of task.evidence) lines.push(`  - ${entry.ts}: ${entry.text}`);
    }
    if (task.artifacts && task.artifacts.length) {
      lines.push("- Artifacts:");
      for (const artifact of task.artifacts) lines.push(`  - ${artifact.kind}: ${artifact.path} (${String(artifact.sha256 || "").slice(0, 12)})`);
    }
    lines.push("");
  }
  lines.push("## Trace Matrix", "");
  for (const row of buildTraceMatrix(state)) {
    lines.push(`- ${row.taskId}: R ${row.requirements.length ? row.requirements.join(", ") : "none"}; AC ${row.acceptanceCriteria.length ? row.acceptanceCriteria.join(", ") : "none"}; required V ${row.requiredVerification.length ? row.requiredVerification.join(", ") : "none"}; optional V ${row.optionalVerification.length ? row.optionalVerification.join(", ") : "none"}`);
  }
  lines.push("", "## Gaps", "");
  if (!plan.gaps || plan.gaps.length === 0) {
    lines.push("- None");
  } else {
    for (const gap of plan.gaps) lines.push(`- ${gap.severity}: ${gap.code} ${gap.item} - ${gap.message}`);
  }
  return lines.join("\n");
}

function renderChecklist(state) {
  const lines = [`# PRD Implementation Checklist: ${state.topicSlug}`, "", `Source PRD: ${state.prdPath}`, ""];
  const reviewPolicy = effectiveReviewPolicy(state);
  lines.push("## Review Policy", "");
  lines.push(`- Profile: ${reviewPolicy.profile}`);
  lines.push(`- Requirements fidelity owner: ${reviewPolicy.fidelityOwner}`);
  lines.push(`- Final adversarial review required: ${reviewPolicy.finalReviewRequired ? "yes" : "no"}`, "");
  lines.push("## Tasks", "");
  if (!state.executionPlan) lines.push("- [ ] EP0. Run `plan-execution`", "");
  for (const task of state.tasks) {
    lines.push(`- ${checkbox(task.status === "complete")} ${task.id}. ${task.title}`);
    lines.push(`  - Status: ${task.status}`);
    if (task.owner) lines.push(`  - Owner: ${task.owner}`);
    if (task.dependsOn && task.dependsOn.length) lines.push(`  - Depends On: ${task.dependsOn.join(", ")}`);
    if (task.writeScope && task.writeScope.length) lines.push(`  - Write Scope: ${task.writeScope.join(", ")}`);
    if (typeof task.parallelSafe === "boolean") lines.push(`  - Parallel Safe: ${task.parallelSafe ? "yes" : "no"}`);
    if (task.risk) lines.push(`  - Risk: ${task.risk}`);
    if (task.requirements.length) lines.push(`  - Requirements: ${task.requirements.join(", ")}`);
    if (task.acceptanceCriteria.length) lines.push(`  - Acceptance Criteria: ${task.acceptanceCriteria.join(", ")}`);
    if (task.evidence.length) lines.push("  - Evidence:", evidenceText(task));
    if (task.artifacts && task.artifacts.length) lines.push("  - Artifacts:", artifactText(task));
  }
  lines.push("", "## Acceptance Criteria", "");
    for (const ac of state.acceptanceCriteria) {
      lines.push(`- ${checkbox(ac.status === "met")} ${ac.id}. ${ac.title}`);
    lines.push(`  - Status: ${ac.status}`);
    if (ac.requirements.length) lines.push(`  - Requirements: ${ac.requirements.join(", ")}`);
    if (ac.evidence.length) lines.push("  - Evidence:", evidenceText(ac));
    if (ac.artifacts && ac.artifacts.length) lines.push("  - Artifacts:", artifactText(ac));
  }
  lines.push("", "## Verification Evidence", "");
    for (const verification of state.verification) {
      lines.push(`- ${checkbox(verificationIsClosedForAccounting(verification))} ${verification.id}. ${verification.level}: ${verification.title}`);
      lines.push(`  - Status: ${verification.status}`);
      lines.push(`  - Required For Done: ${isVerificationRequiredForDone(verification) ? "yes" : "no"}`);
    if (verification.evidence.length) lines.push("  - Evidence:", evidenceText(verification));
    if (verification.artifacts && verification.artifacts.length) lines.push("  - Artifacts:", artifactText(verification));
  }
  lines.push("", "## Requirements Fidelity Review", "");
  lines.push(`- ${checkbox(Boolean(state.requirementsFidelityReview && state.requirementsFidelityReview.status === "pass"))} REQ_FIDELITY_REVIEW. Requirements fidelity review`);
  lines.push(`  - Status: ${state.requirementsFidelityReview ? state.requirementsFidelityReview.status : "pending"}`);
  if (state.requirementsFidelityReview) {
    lines.push(`  - Report: ${state.requirementsFidelityReview.reportPath}`);
    lines.push(`  - Summary: ${state.requirementsFidelityReview.summary}`);
  }
  if (finalReviewRequiredForState(state)) {
    lines.push("", "## Final Adversarial Review", "");
    lines.push(`- ${checkbox(Boolean(state.finalReview && state.finalReview.status === "pass"))} REVIEW. Final adversarial review`);
    lines.push(`  - Status: ${state.finalReview ? state.finalReview.status : "pending"}`);
    if (state.finalReview) {
      lines.push(`  - Report: ${state.finalReview.reportPath}`);
      lines.push(`  - Summary: ${state.finalReview.summary}`);
    }
  }
  return lines.join("\n");
}

function renderVerificationPlan(state) {
  const plan = state.verificationPlan;
  if (!plan) return "# Verification Plan\n\nStatus: missing\n";
  const lines = [
    `# Verification Plan: ${state.topicSlug}`,
    "",
    `- Status: ${plan.status}`,
    `- Generated: ${plan.generatedAt}`,
    `- PRD: ${plan.prdPath}`,
    "",
    "## Environment",
    "",
    `- Package manager: ${plan.environment.packageManager || "unknown"}`,
    `- Browser tool: ${plan.environment.browserTool}`,
    `- Server strategy: ${plan.environment.serverStrategy}`,
    `- Service strategy: ${plan.environment.serviceStrategy}`,
    `- DB strategy: ${plan.environment.dbStrategy}`,
    "",
    "## Test Mode Contract",
    "",
  ];
  if (state.testModeContract && state.testModeContract.length) {
    for (const mode of state.testModeContract) {
      lines.push(`- ${mode.mode}: required=${mode.requiredForDone ? "yes" : "no"}; blockable=${mode.canBeBlocked ? "yes" : "no"}; covers=${mode.covers || "unspecified"}; human=${mode.humanDecision || "none"}`);
    }
  } else {
    lines.push("- None parsed");
  }
  lines.push(
    "",
    "## Checks",
    "",
  );
  for (const check of plan.checks || []) {
    lines.push(`### ${check.id}. ${check.verificationId} - ${check.category}`);
    lines.push("");
    lines.push(`- Level: ${check.level}`);
    lines.push(`- Source: ${check.source}`);
    if (check.testMode) lines.push(`- Test mode: ${check.testMode}`);
    lines.push(`- Tool: ${check.tool}`);
    if (check.command) lines.push(`- Command: \`${check.command}\``);
    if (check.target) lines.push(`- Target: ${check.target}`);
      lines.push(`- Covers: ${formatCoverage(check.covers)}`);
      lines.push(`- Artifacts: ${check.artifactKinds.join(", ")}`);
      lines.push(`- Pass criteria: ${check.passCriteria}`);
      lines.push(`- Required for done: ${check.requiredForDone ? "yes" : "no"}`);
      lines.push(`- Can be blocked: ${check.canBeBlocked ? "yes" : "no"}`);
      if (check.contract) {
        lines.push(`- Contract method: ${check.contract.method || "missing"}`);
        lines.push(`- Contract artifact: ${check.contract.artifact || "missing"}`);
        if (check.contract.environment) lines.push(`- Contract environment: ${check.contract.environment}`);
        if (check.contract.safeProbe) lines.push(`- Safe probe: ${check.contract.safeProbe}`);
        if (check.contract.liveProof) lines.push(`- Live proof: ${check.contract.liveProof}`);
        if (check.contract.sideEffect) lines.push(`- Side effect: ${check.contract.sideEffect}`);
        if (check.contract.sensitiveDataPolicy) lines.push(`- Sensitive data policy: ${check.contract.sensitiveDataPolicy}`);
      }
    lines.push(`- Status: ${check.status}`);
    if (check.notes.length) {
      lines.push("- Notes:");
      for (const note of check.notes) lines.push(`  - ${note}`);
    }
    lines.push("");
  }
  lines.push("## Acceptance Coverage", "");
  for (const [id, entry] of Object.entries(plan.coverage || {})) {
    lines.push(`- ${id}: ${entry.status} (${entry.coveredBy.length ? entry.coveredBy.join(", ") : "no checks"}) - ${entry.title}`);
  }
  lines.push("", "## Gaps", "");
  if (!plan.gaps || plan.gaps.length === 0) {
    lines.push("- None");
  } else {
    for (const gap of plan.gaps) lines.push(`- ${gap.severity}: ${gap.code} ${gap.item} - ${gap.message}`);
  }
  return lines.join("\n");
}

function formatCoverage(covers) {
  covers = covers || {};
  const parts = [];
  if ((covers.requirements || []).length) parts.push(`R: ${covers.requirements.join(", ")}`);
  if ((covers.acceptanceCriteria || []).length) parts.push(`AC: ${covers.acceptanceCriteria.join(", ")}`);
  if ((covers.tasks || []).length) parts.push(`T: ${covers.tasks.join(", ")}`);
  if ((covers.verification || []).length) parts.push(`V: ${covers.verification.join(", ")}`);
  return parts.length ? parts.join("; ") : "unmapped";
}

function renderVerification(state) {
  const lines = [`# Verification`, "", `PRD: ${state.prdPath}`, ""];
  for (const item of state.verification) {
    lines.push(`## ${item.id}. ${item.level}`);
    lines.push("");
    lines.push(`- Status: ${item.status}`);
    if (item.source) lines.push(`- Source: ${item.source}`);
    lines.push(`- Check: ${item.text}`);
    if (item.evidence.length) {
      lines.push("- Evidence:");
      for (const entry of item.evidence) lines.push(`  - ${entry.ts}: ${entry.text}`);
    }
    if (item.artifacts && item.artifacts.length) {
      lines.push("- Artifacts:");
      for (const artifact of item.artifacts) lines.push(`  - ${artifact.kind}: ${artifact.path} (${String(artifact.sha256 || "").slice(0, 12)})`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function writeImplementationReport(statePath, state) {
  const statusLabel = state.status === "complete"
    ? "Done"
    : state.status === "partial"
      ? "Partially Done"
      : state.status === "blocked"
        ? "Blocked"
        : state.status;
  const policy = effectiveReviewPolicy(state);
  const profile = state.reviewProfile || { profile: reviewProfileName(state), source: "default", reason: "legacy default", signals: [] };
  const lines = [`# Implementation Result: ${state.topicSlug}`, "", `Status: ${statusLabel}`, "", `PRD: ${state.prdPath}`, `Receipt: ${state.runDir}/receipt.json`, ""];

  lines.push("## Approval And Deviations", "");
  const approvalDeviation = (state.deviations || []).find(item => item.type === "prd_approval_override");
  lines.push(`- Approval: ${approvalDeviation ? `verbatim conversational override \`${approvalDeviation.summary}\`` : "approved PRD frontmatter"}`);
  if ((state.deviations || []).length) {
    for (const deviation of state.deviations) lines.push(`- ${deviation.id}: ${deviation.type} - ${deviation.summary}`);
  } else {
    lines.push("- Recorded deviations: none");
  }

  lines.push("", "## Review Policy", "");
  lines.push(`- Effective profile: ${policy.profile}`);
  lines.push(`- Classification source: ${profile.source || "default"}`);
  lines.push(`- Classification reason: ${profile.reason || "none recorded"}`);
  lines.push(`- Requirements fidelity owner: ${policy.fidelityOwner}`);
  lines.push(`- Requirements fidelity depth: ${policy.fidelityDepth}`);
  lines.push(`- Final adversarial review required: ${policy.finalReviewRequired ? "yes" : "no"}`);
  const verifyGate = verifyGateStatus(state);
  lines.push(`- Verify gate: ${verifyGate.effective}${verifyGate.overridden ? " (user override)" : ""}`);
  if (Array.isArray(profile.signals) && profile.signals.length) {
    lines.push("- Classification signals:");
    for (const signal of profile.signals) lines.push(`  - ${signal}`);
  } else {
    lines.push("- Classification signals: none");
  }
  const executionPlan = executionPlanSummary(state);
  lines.push("", "## Execution Plan And Changed Modules", "");
  lines.push(`- Status: ${executionPlan.status}`);
  lines.push(`- Tasks: ${executionPlan.taskCount}`);
  lines.push(`- Open tasks: ${executionPlan.openTaskCount}`);
  lines.push(`- Artifact: ${state.runDir}/execution-plan.md`);
  lines.push("", "## Tasks", "");
  for (const task of state.tasks) {
    lines.push(`- ${task.id}: ${task.status} - ${task.title} (risk: ${task.risk || "unknown"}, parallelSafe: ${task.parallelSafe ? "yes" : "no"})`);
    if (Array.isArray(task.writeScope) && task.writeScope.length) lines.push(`  - Write scope: ${task.writeScope.join(", ")}`);
  }
  lines.push("", "## Acceptance Criteria", "");
  for (const ac of state.acceptanceCriteria) lines.push(`- ${ac.id}: ${ac.status} - ${ac.title}`);
  lines.push("", "## Verification Evidence And Regression Coverage", "");
  for (const item of state.verification) {
    lines.push(`- ${item.id}: ${item.status} - ${item.level}: ${item.title}`);
    if (item.evidence && item.evidence.length) lines.push(`  - Latest evidence: ${item.evidence[item.evidence.length - 1].text}`);
    if (item.artifacts && item.artifacts.length) lines.push(`  - Artifacts: ${item.artifacts.map(artifact => artifact.path).join(", ")}`);
  }
  lines.push("", "## Artifact Evidence", "");
  for (const entry of collectArtifacts(state)) {
    lines.push(`- ${entry.ownerKind} ${entry.ownerId}: ${entry.artifact.kind} - ${entry.artifact.path}`);
  }

  const initialSnapshot = state.initialWorktreeSnapshot || null;
  const finalSnapshot = state.finalReceipt && state.finalReceipt.worktreeSnapshot ? state.finalReceipt.worktreeSnapshot : null;
  lines.push("", "## Worktree Scope And Delivery", "");
  const deliveryMode = state.delivery && state.delivery.mode ? state.delivery.mode : "local";
  lines.push(`- Delivery mode: ${deliveryMode}`);
  lines.push(`- Branch: ${state.delivery && state.delivery.branch ? state.delivery.branch : "none"}`);
  lines.push(deliveryMode === "local"
    ? "- Local delivery result: implement performed no commit, push, PR, CI, release, or deployment action."
    : "- PR delivery result: commit, push, PR, and CI remain post-receipt ship outcomes and require separate delivery evidence.");
  if (initialSnapshot) {
    lines.push(`- Initial worktree snapshot: ${initialSnapshot.capturedAt}; ${initialSnapshot.entryCount} entries; status hash ${initialSnapshot.statusHash}.`);
  } else {
    lines.push("- Initial worktree snapshot: unavailable for this legacy run; see Coordinator Context Notes for recorded baseline provenance.");
  }
  if (finalSnapshot) lines.push(`- Final worktree snapshot: ${finalSnapshot.capturedAt}; ${finalSnapshot.entryCount} entries; status hash ${finalSnapshot.statusHash}.`);
  if (initialSnapshot && finalSnapshot) {
    const initialByPath = new Map((initialSnapshot.entries || []).map(entry => [entry.path, entry]));
    const finalByPath = new Map((finalSnapshot.entries || []).map(entry => [entry.path, entry]));
    const changedAfterInit = (finalSnapshot.entries || []).filter(entry => {
      const before = initialByPath.get(entry.path);
      return !before || !snapshotEntriesEqual(before, entry);
    });
    const removedAfterInit = (initialSnapshot.entries || []).filter(entry => !finalByPath.has(entry.path));
    const preservedBaseline = (initialSnapshot.entries || []).filter(entry => {
      const after = finalByPath.get(entry.path);
      return after && snapshotEntriesEqual(entry, after);
    });
    lines.push(`- Preserved initial dirty entries: ${preservedBaseline.length}.`);
    const changedPaths = [...new Set([...changedAfterInit, ...removedAfterInit].map(entry => entry.path))];
    lines.push(`- Added, changed, or removed after initialization: ${changedPaths.length ? changedPaths.join(", ") : "none"}.`);
  }

  const contextNotesPath = path.join(path.dirname(statePath), "context-notes.md");
  lines.push("", "## Coordinator Context Notes", "");
  if (fs.existsSync(contextNotesPath)) {
    const contextNotes = fs.readFileSync(contextNotesPath, "utf8").trim();
    for (const line of contextNotes.split(/\r?\n/)) {
      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      lines.push(heading ? `${"#".repeat(Math.min(6, heading[1].length + 2))} ${heading[2]}` : line);
    }
  } else {
    lines.push("No coordinator context notes were recorded.");
  }

  lines.push("", "## Requirements Fidelity Review", "");
  if (state.requirementsFidelityReview) {
    lines.push(`- Status: ${state.requirementsFidelityReview.status}`);
    lines.push(`- Report: ${state.requirementsFidelityReview.reportPath}`);
    lines.push(`- Summary: ${state.requirementsFidelityReview.summary}`);
  } else {
    lines.push("- Status: pending");
  }
  if (finalReviewRequiredForState(state)) {
    lines.push("", "## Final Adversarial Review", "");
    if (state.finalReview) {
      lines.push(`- Status: ${state.finalReview.status}`);
      lines.push(`- Report: ${state.finalReview.reportPath}`);
      lines.push(`- Summary: ${state.finalReview.summary}`);
    } else {
      lines.push("- Status: pending");
    }
  }
  lines.push("", "## Final Receipt", "", "```json", JSON.stringify(state.finalReceipt, null, 2), "```", "");
  writeMarkdown(path.join(path.dirname(statePath), "implementation-result.md"), lines.join("\n"));
}

function renderRequirementsReviewPrompt(context) {
  const { state, statePath, reportPath } = context;
  const intentTrace = state.intentTrace || {};
  const policy = effectiveReviewPolicy(state);
  const ownershipGuidance = policy.fidelityOwner === "independent"
    ? "Review policy: standard. You are the single fresh independent read-only semantic reviewer for this run. Base the verdict on the raw PRD, state, diff, ledger, and registered artifacts, not on a coordinator-provided conclusion. The coordinator alone records your report in harness state."
    : policy.profile === "trivial"
      ? "Review policy: trivial. This is a compact main-agent fidelity check. Cover the complete contract, but keep the report proportional to the small change surface."
      : "Review policy: high-risk. This is the main-agent full requirements fidelity stage. Reopen sensitive data, auth, security, billing, live-service, migration, deployment, and rollback proof before the independent final review.";
  const uxApplicable = hasUserVisibleReviewSurface(state);
  const uxGuidance = uxApplicable
    ? "UI and UX evidence is applicable. Judge the registered evidence for primary user flows and relevant loading, empty, and error states. Judge responsive behavior and accessibility when contracted, copy and visual hierarchy where applicable, and clearly separate evidence-backed findings from remaining human taste judgment. This is an overlay within fidelity review, not a separate gate."
    : "No explicit UI or UX surface was detected in the verification contract. Do not invent a separate UX gate, but assess user-visible quality if the diff or registered artifacts reveal such a surface.";
  const decisionLines = (intentTrace.decisions || [])
    .slice(0, 40)
    .map(item => `  - ${item.source} ${item.id} [${item.stance || "unspecified"}]: ${item.text}`)
    .join("\n") || "  - No structured decision trace items were captured; treat missing traceability as a finding unless the PRD explicitly says none were needed.";
  return `You are the requirements fidelity reviewer for a PRD implementation.

${ownershipGuidance}

${uxGuidance}

Your job is to verify that the implementation still satisfies the user's original intent, accepted decisions, rejected alternatives, and PRD contract. Be strict. Find semantic drift, missing user-visible behavior, diluted acceptance criteria, hidden scope, and "technically complete but not what the user asked for" failures.

Do not implement fixes. Do not mark anything complete. Review only.
Harness-owned mechanical gates already enforce tracked completion, required verification status, artifact registration, hash integrity, freshness, and receipt eligibility. Do not rerun the complete test suite or recompute every hash unless the recorded evidence is inconsistent, missing, or suspicious.

Source of truth:
- PRD: \`${state.prdPath}\`
- State JSON: \`${statePath}\`
- Checklist: \`${state.runDir}/checklist.md\`
- Context notes: \`${state.runDir}/context-notes.md\`
- Execution plan: \`${state.runDir}/execution-plan.json\` and \`${state.runDir}/execution-plan.md\`
- Verification plan: \`${state.runDir}/verification-plan.json\` and \`${state.runDir}/verification-plan.md\`
- Verification: \`${state.runDir}/verification.md\`
- Ledger: \`${state.runDir}/ledger.jsonl\`
- Artifact manifest: \`${state.runDir}/artifacts/manifest.jsonl\`
- Git diff/worktree: inspect current repository state
- Original intent sources: read the PRD frontmatter and sections for \`source_intake\`, \`source_clarity\`, Pre-Work, Human Decisions, Scope, Non-Goals, Requirements, Acceptance Criteria, Risks, Guardrails, and any referenced \`${NAMESPACE_ROOT}/interview/**\` files that exist (legacy \`${NAMESPACE_ROOT}/intake/**\` or \`${NAMESPACE_ROOT}/clarify/**\` paths may appear in older PRDs).
- When an intake source is \`qa-log.md\`, read the complete file, including Current Understanding, Decision Register, material Raw Q&A and Decision Packets, UX Scenario Cards, objections, evidence, and audit findings. Do not rely on a summary or parsed decision sample.
- Intent trace snapshot for navigation only: ${intentTrace.decisionCount || 0} decision/proposal item(s) captured at init (${intentTrace.prdDecisionCount || 0} from PRD, ${intentTrace.sourceDecisionCount || 0} from intake/clarity sources). This count is not semantic coverage proof.
${decisionLines}

Required checks:
1. Every material answer, explicit user decision, accepted recommendation, objection, constraint, rejected option, non-goal, and assumption from intake/clarify/current conversation has the same meaning and provenance in the PRD and implementation, or an explicit approved disposition.
2. Silence, lack of objection, a topic change, or continued participation was not treated as user approval. An unambiguous affirmative response to an explicit recommendation remains an accepted recommendation rather than an agent default.
3. Every accepted initial proposal is implemented and evidenced or explicitly deferred/non-goal with user approval, and every rejected option, non-goal, and guardrail stayed rejected.
4. PRD Requirements and ACs did not dilute the user's intended outcome into easier proxy checks.
5. User-visible flows, copy, data behavior, runtime behavior, and external/live proof expectations match the user's goal, not only the executor's tasks.
6. Each AC has evidence that proves the user intent behind the AC, not just a superficial DOM/file/test condition.
7. Every required Verification item has a Verification Intent Checklist entry that maps Pass Intent and covered R#/AC# to concrete registered artifact paths.
8. Any missing source artifact, ambiguous decision, or human taste judgment is called out as blocking unless the PRD explicitly made it non-required.
9. No hidden scope, architecture, storage, API, auth, billing, production-data, or external-service decision was added without approval.
10. The implementation result report does not overclaim Done when user intent is partially met, blocked, or still needs human judgment.

Write the report to:
\`${reportPath}\`

This is an absolute path inside the current run checkout. Write the file at exactly this absolute path; never use a relative path, because the editing tool may resolve it against a different checkout. If the report was accidentally created elsewhere, move the existing file with \`mv\` instead of re-authoring its content.

Keep the section headings and the Coverage Judgment label keys exactly as written below; they are machine-checked structural markers. Write all prose, findings, and values in the user's language.

Use this format:

# Requirements Fidelity Review

Status: PASS | FAIL

## Intent Sources Read

- <source path or PRD section>

## Decision Trace

- <user decision or proposal>: represented by <R/AC/T/V/non-goal/evidence> | gap: <none or issue>

Include at least ${Math.min(Math.max(1, intentTrace.decisionCount || 0), 3)} Decision Trace entr${Math.min(Math.max(1, intentTrace.decisionCount || 0), 3) === 1 ? "y" : "ies"} as bullets or a markdown table. Do not collapse accepted, rejected, deferred, or open decisions into a generic statement.

## Findings

- <severity>: <finding with source, PRD, implementation, evidence, or artifact reference>

## Verification Intent Checklist

- <V#>: Pass Intent: <PRD pass intent or derived pass criteria>; Covers: <R#/AC#>; Artifacts checked: <registered artifact paths>; Judgment: PASS|FAIL; Gap: <none or issue>

Include every required Verification item. A passing review must fail if a required V# is missing, has no registered artifact path, or the artifact does not actually prove the covered R#/AC#.

## Coverage Judgment

- Requirements:
- Acceptance Criteria:
- User-visible behavior:
- Non-goals and rejected options:
- Human verification:

## Verdict

PASS only if the complete canonical source, accepted decisions, rejected alternatives, assumptions, PRD scope, ACs, verification evidence, and implementation result all align. FAIL on any material semantic loss, changed provenance, invented consent, diluted AC, hidden scope, or overclaimed result.
`;
}

function hasUserVisibleReviewSurface(state) {
  const text = [
    ...(state.testModeContract || []).map(item => `${item.mode || ""} ${item.covers || ""} ${item.humanDecision || ""}`),
    ...(state.verification || []).map(item => `${item.text || ""} ${item.title || ""} ${item.matrix ? `${item.matrix.mode || ""} ${item.matrix.covers || ""} ${item.matrix.liveProof || ""}` : ""}`),
  ].join("\n");
  return /\b(browser|ui|ux|user-visible|responsive|accessibility|visual|mobile|desktop)\b|사용자 화면|접근성|반응형/iu.test(text);
}

function renderReviewPrompt(context) {
  const { state, statePath, reportPath } = context;
  const fidelity = state.requirementsFidelityReview || {};
  const profile = reviewProfileName(state);
  const profileGuidance = profile === "high-risk"
    ? "Review profile: high-risk. Run the full adversarial review and reopen any risky semantic, security, data, migration, external-service, or delivery proof."
    : profile === "standard"
      ? "Review profile: standard. Final adversarial review is not required for receipt. If a human explicitly requests this optional review, audit freshness, state consistency, artifact validity, deviations, and overclaiming without repeating the independent combined fidelity review."
      : "Review profile: trivial. Final adversarial review is optional for receipt; if requested, keep it to a short freshness, artifact, and overclaim check.";
  const fidelityLine = fidelity.reportSha256
    ? `Recorded fidelity review: status ${fidelity.status}, report \`${fidelity.reportPath}\`, sha256 \`${fidelity.reportSha256}\`, recorded at ${fidelity.recordedAt}.`
    : "No requirements fidelity review is recorded yet; a passing final review is impossible until one is recorded.";
  return `You are the adversarial final reviewer for a PRD implementation.

${profileGuidance}

Your job is to audit the recorded requirements fidelity review, then find missing work, weak evidence, fake verification, and PRD drift that survived that review.
Do not implement fixes. Do not mark anything complete. Review only.
Do not repeat the full V-by-V semantic artifact proof from scratch when the requirements fidelity review already contains it and you agree with it.
Instead, verify that the fidelity review is fresh, specific, and trustworthy, then focus on disagreement, omission, weak reasoning, risky artifacts, and final-report overclaiming.

You are running AFTER the requirements fidelity review was recorded. ${fidelityLine}
Read \`${statePath}\` yourself and confirm the recorded fidelity review status. Do not write the report from memory of earlier turns.

Source of truth:
- PRD: \`${state.prdPath}\`
- State JSON: \`${statePath}\`
- Checklist: \`${state.runDir}/checklist.md\`
- Execution plan: \`${state.runDir}/execution-plan.json\` and \`${state.runDir}/execution-plan.md\`
- Verification plan: \`${state.runDir}/verification-plan.json\` and \`${state.runDir}/verification-plan.md\`
- Verification: \`${state.runDir}/verification.md\`
- Ledger: \`${state.runDir}/ledger.jsonl\`
- Artifact manifest: \`${state.runDir}/artifacts/manifest.jsonl\`
- Requirements fidelity review: \`${state.runDir}/review/requirements-fidelity-review.md\`
- Git diff/worktree: inspect current repository state

Required checks (delta review, not a re-derivation):
1. Requirements fidelity review exists, passed, is fresh, and its findings are either resolved or explicitly reflected in the final verdict. It is the primary semantic artifact proof; reopen its V-by-V reasoning only where it is missing, generic, inconsistent with state, or suspicious.
2. Trust the harness's mechanical gates (artifact registration/hash/kind validity, required-verification pass status) unless a signal is inconsistent, missing, or suspicious; do not re-derive them item by item.
3. Task status is a coordinator self-report with no mechanical precondition: spot-check each completed task's evidence against its mapped acceptance criteria and diff instead of trusting the status alone.
4. Open and spot-check the underlying artifacts for risky, user-critical, or suspicious items instead of duplicating the fidelity checklist.
5. Audit every recorded deviation in \`state.deviations\` for acceptability, and treat unrecorded drift between the diff and the plan or structure lock as a finding.
6. The implementation follows the PRD's Major Technical Structure Changes or documented structure lock and adds no unmapped scope.
7. Nothing was recorded after the reviews (staleness), ready parallel groups (if used) had disjoint write scopes, and the final report does not overclaim beyond what a human could verify from the PRD, state, ledger, and artifacts.

Write the report to:
\`${reportPath}\`

This is an absolute path inside the current run checkout. Write the file at exactly this absolute path; never use a relative path, because the editing tool may resolve it against a different checkout. If the report was accidentally created elsewhere, move the existing file with \`mv\` instead of re-authoring its content.

Keep the section headings exactly as written below; they are machine-checked structural markers. Write all prose in the user's language.

Use this format:

# Final Adversarial Review

Status: PASS | FAIL

## Fidelity Review Checked

- Report: <recorded requirements fidelity review report path>
- Status: <recorded status>
- Recorded at: <recordedAt>
- Findings resolved or reflected: <how>

## Findings

- <severity>: <finding with file/artifact/state reference>

## Artifact Audit

- Harness-visible validity: <missing, empty, invalid, unregistered, hash drift, stale review, or wrong evidence kind findings, or none>
- Spot-checks performed: <risky or user-critical artifacts opened, or why the fidelity checklist was sufficient>
- Missing or weak artifacts: <only list semantic proof gaps or artifact concerns not already handled by the fidelity review>

## Deviation Audit

- Recorded deviations:
- Accepted deviations:
- Rejected deviations:

## Verdict

PASS only if all tracked work is complete, the requirements fidelity review is trustworthy, every required verification item has valid artifact-backed evidence, optional verification exceptions are explicitly non-required and justified, no stale review/artifact drift remains, and no PRD drift remains.`;
}

// Derived documents, regenerated from state.json on demand. Marking commands do
// not call this; `render` exists so a coordinator can refresh the views without
// mutating the run.
function renderViews(statePath, state) {
  const runDir = path.dirname(statePath);
  writeMarkdown(path.join(runDir, "checklist.md"), renderChecklist(state));
  if (state.executionPlan) {
    writeJson(path.join(runDir, "execution-plan.json"), state.executionPlan);
    writeMarkdown(path.join(runDir, "execution-plan.md"), renderExecutionPlan(state));
  }
  if (state.verificationPlan) {
    writeJson(path.join(runDir, "verification-plan.json"), state.verificationPlan);
    writeMarkdown(path.join(runDir, "verification-plan.md"), renderVerificationPlan(state));
  }
  if (!fs.existsSync(path.join(runDir, "context-notes.md"))) {
    writeMarkdown(path.join(runDir, "context-notes.md"), `# Context Notes\n\n- PRD: ${state.prdPath}\n`);
  }
  writeMarkdown(path.join(runDir, "verification.md"), renderVerification(state));
}

module.exports = {
  checkbox,
  evidenceText,
  artifactText,
  renderExecutionPlan,
  renderChecklist,
  renderVerificationPlan,
  formatCoverage,
  renderVerification,
  writeImplementationReport,
  renderRequirementsReviewPrompt,
  renderReviewPrompt,
  renderViews,
};
