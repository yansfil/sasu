"use strict";

const fs = require("fs");
const path = require("path");

const { writeMarkdown, NAMESPACE_ROOT } = require("./util");
const { hashGateInput } = require("./gate_freshness");
const { executionPlanSummary, reviewProfileName, finalReviewRequiredForState, effectiveReviewPolicy } = require("./state_data");
const { collectArtifacts } = require("./artifacts");
const { verifyGateStatus } = require("./reviews");
const { snapshotEntriesEqual } = require("./git");

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
    for (const deviation of state.deviations) {
      // Deduped verification_command deviations carry an occurrence counter
      // (see recordDeviation); surface repeats as a suffix instead of rows.
      const details = deviation.details || {};
      const repeats = typeof details.occurrences === "number" && details.occurrences > 1
        ? ` (×${details.occurrences}, last ${details.lastSeenAt || deviation.ts})`
        : "";
      lines.push(`- ${deviation.id}: ${deviation.type} - ${deviation.summary}${repeats}`);
    }
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
  // A blocked receipt must say why without a trip to gates.json: attempts
  // spent against the budget, and the findings that stopped the run.
  if (verifyGate.effective === "BLOCKED") {
    lines.push(`  - Attempts: ${verifyGate.attempts}/${verifyGate.budget}${verifyGate.budgetExhausted ? " (retry budget exhausted)" : ""}`);
    const findings = Array.isArray(verifyGate.findings) ? verifyGate.findings : [];
    for (const finding of findings) {
      lines.push(`  - Finding (${finding.severity || "?"} ${finding.area || "unknown"}): ${finding.missing || "no description recorded"}`);
    }
    if (!findings.length) lines.push("  - Findings: none recorded");
  }
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
  const timings = state.finalReceipt && state.finalReceipt.phaseTimings;
  if (timings) {
    // Human-readable budget check: is verification dwarfing implementation?
    // Only measured sums are printed; the un-measured remainder (agent turns,
    // user wait, browser QA) stays one honest lump.
    lines.push("", "## Timings", "");
    if (timings.wallClockSeconds !== null) lines.push(`- Wall clock (init -> receipt): ${timings.wallClockSeconds}s`);
    lines.push(`- Verification commands (measured): ${timings.measured.verificationCommandSeconds}s across ${timings.measured.verificationCommandRuns} run(s)`);
    lines.push(`- Judge calls (measured): ${timings.measured.judgeSeconds}s across ${timings.measured.judgeCalls} call(s)${timings.measured.verifyGateAttempts !== null ? `, verify gate attempts ${timings.measured.verifyGateAttempts}` : ""}`);
    if (timings.unattributedSeconds !== null) lines.push(`- Unattributed (agent turns + user wait + unlogged work): ${timings.unattributedSeconds}s`);
  }
  lines.push("", "## Final Receipt", "", "```json", JSON.stringify(state.finalReceipt, null, 2), "```", "");
  writeMarkdown(path.join(path.dirname(statePath), "implementation-result.md"), lines.join("\n"));
}

// Layering principle: each layer sees only what only it can see. The spec
// gate's fidelity lane already judged "every material decision in the
// interview log is represented in the PRD without distortion" at PRD time,
// and that PASS is hash-pinned to both documents. When the pin still matches
// the files on disk, making the fidelity reviewer re-read the whole qa-log
// re-buys a settled judgment: in an audited run the reviewer re-read a
// 37k-char qa-log and found zero issues the gate had not already caught.
// Returns the spec-gate record when the qa-log→PRD leg is settled (verdict
// PASS, not overridden, every recorded input hash still matching disk via
// the canonical hashGateInput - never a reimplemented hash), else null.
function settledSpecGate(state) {
  const projectRoot = state.projectRoot || process.cwd();
  if (!state.topicSlug) return null;
  const gatesPath = path.join(projectRoot, "agents", "gates", state.topicSlug, "gates.json");
  if (!fs.existsSync(gatesPath)) return null;
  let record;
  try {
    const gatesState = JSON.parse(fs.readFileSync(gatesPath, "utf8"));
    record = gatesState.gates && gatesState.gates.spec;
  } catch {
    return null;
  }
  if (!record || record.verdict !== "PASS" || record.overridden === true) return null;
  if (!Array.isArray(record.inputs) || record.inputs.length === 0) return null;
  // The narrowed mandate claims the qa-log→PRD leg is settled, so the qa-log
  // itself must be among the pinned inputs. The CLI's own spec runs always
  // pin [prd, qaLog], but the whole point of hash-checking the record is
  // distrusting it - a hand-written PASS pinning only the PRD must not
  // silence the full read while the qa-log drifts unpinned.
  if (!record.inputs.some(input => input && typeof input.path === "string" && /qa-log|interview|intake/i.test(input.path))) {
    return null;
  }
  for (const input of record.inputs) {
    if (!input || !input.path || !input.sha256) return null;
    let hash;
    try {
      hash = hashGateInput(path.join(projectRoot, input.path), input.kind);
    } catch {
      return null;
    }
    if (hash === null || hash !== input.sha256) return null;
  }
  return { lastRunAt: record.lastRunAt || null, inputs: record.inputs };
}

function renderRequirementsReviewPrompt(context) {
  const { state, statePath, reportPath } = context;
  const intentTrace = state.intentTrace || {};
  const policy = effectiveReviewPolicy(state);
  const ownershipGuidance = policy.fidelityOwner === "independent"
    ? "Review policy: standard. You are the single fresh independent read-only semantic reviewer for this run. Base the verdict on the raw PRD, state, diff, and registered artifacts, not on a coordinator-provided conclusion. The coordinator alone records your report in harness state."
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
  // Conditional qa-log depth (see settledSpecGate for the layering rationale
  // and the 37k-read-zero-findings datum): only a fresh, non-overridden
  // spec-gate PASS whose pinned inputs still match disk narrows the mandate.
  const specGate = settledSpecGate(state);
  const qaLogGuidance = specGate
    ? `- The qa-log→PRD leg is settled: the spec gate's fidelity lane PASSed on these exact documents (last run ${specGate.lastRunAt || "unrecorded"}; pinned inputs still matching disk: ${specGate.inputs.map(input => `\`${input.path}\` sha256 ${input.sha256.slice(0, 12)}`).join(", ")}), already judging that every material decision in the interview log is represented in the PRD without distortion. Do NOT re-read the full qa-log: read the PRD's Decision Traceability section plus the implementation and registered evidence, and judge the PRD→implementation leg. Escape hatch: if anything in the PRD's decision trace looks inconsistent or truncated, the spec record looks suspicious, or a decision's provenance is unclear, fall back to reading the canonical qa-log in full.`
    : `- When an intake source is \`qa-log.md\`, read the complete file, including Current Understanding, Decision Register, material Raw Q&A entries (Decision Packet content lives in each entry's immediate_notes field), UX Scenario Cards, objections, evidence, and audit findings. Do not rely on a summary or parsed decision sample.`;
  return `You are the requirements fidelity reviewer for a PRD implementation.

${ownershipGuidance}

${uxGuidance}

Your job is to verify that the implementation still satisfies the user's original intent, accepted decisions, rejected alternatives, and PRD contract. Be strict. Find semantic drift, missing user-visible behavior, diluted acceptance criteria, hidden scope, and "technically complete but not what the user asked for" failures.

Do not implement fixes. Do not mark anything complete. Review only.
Harness-owned mechanical gates already enforce tracked completion, required verification status, artifact registration, hash integrity, freshness, and receipt eligibility. Do not rerun the complete test suite or recompute every hash unless the recorded evidence is inconsistent, missing, or suspicious.

Role boundary with the sasu verify gate: the gate independently judges the diff against every acceptance criterion and records per-criterion verdicts under \`${NAMESPACE_ROOT}/gates/<topic-slug>/\`. Do not re-derive code-vs-AC satisfaction verdicts from the diff - that lane is the gate's, and duplicating it slows the run without adding independence. Your lane is everything the gate cannot see: the intent lineage from the original conversation through the PRD to the implementation, decision provenance, recorded deviations, and whether the registered evidence actually proves the intent behind each criterion. The two reviews may run concurrently on frozen code; neither consumes the other's output.

Source of truth:
- PRD: \`${state.prdPath}\`
- State JSON: \`${statePath}\` - the single machine record: tasks, acceptance criteria, verification items with evidence and artifacts, the execution and verification plans, and recorded deviations all live here.
- Context notes: \`${state.runDir}/context-notes.md\`
- Artifact manifest: \`${state.runDir}/artifacts/manifest.jsonl\`
- Rehearsal ledger: \`${state.runDir}/rehearsals.jsonl\` (may be absent) - side-door Bash runs of contract commands the harness observer recorded, exit codes included. A required check whose official pass shows no failure anywhere in its history is a signal worth weighing, not an automatic finding: confirm the check exercises what it claims to protect.
- Git diff/worktree: inspect current repository state
- Original intent sources: read the PRD frontmatter and sections for \`source_intake\`, \`source_clarity\`, Pre-Work, Human Decisions, Scope, Non-Goals, Requirements, Acceptance Criteria, Risks, Guardrails, and any referenced \`${NAMESPACE_ROOT}/interview/**\` files that exist (legacy \`${NAMESPACE_ROOT}/intake/**\` or \`${NAMESPACE_ROOT}/clarify/**\` paths may appear in older PRDs).
${qaLogGuidance}
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
11. Every recorded deviation in \`state.deviations\` (approval overrides, equivalent-command substitutions, out-of-order completions, write-scope drift, review-policy changes) is acceptable against the user's intent; on trivial and standard profiles this review is the only place a deviation is ever judged.

Write the report to:
\`${reportPath}\`

This is an absolute path inside the current run checkout. Write the file at exactly this absolute path; never use a relative path, because the editing tool may resolve it against a different checkout. If the report was accidentally created elsewhere, move the existing file with \`mv\` instead of re-authoring its content.

Use the section headings and the Coverage Judgment label keys exactly as written below; they are the recommended skeleton, and the harness reports deviations from it as advisory structure warnings. Only the standalone Status line (and at least one finding when the status is FAIL) is enforced mechanically. Write all prose, findings, and values in the user's language.

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

## Deviation Audit

- <deviation id>: <acceptable | not acceptable> - <why> (or "- none recorded")

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
- State JSON: \`${statePath}\` - the single machine record: tasks, acceptance criteria, verification items with evidence and artifacts, the execution and verification plans, and recorded deviations all live here.
- Context notes: \`${state.runDir}/context-notes.md\`
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
7. Nothing was recorded after the reviews (staleness), ready parallel groups (if used) had disjoint write scopes, and the final report does not overclaim beyond what a human could verify from the PRD, state, and artifacts.

Write the report to:
\`${reportPath}\`

This is an absolute path inside the current run checkout. Write the file at exactly this absolute path; never use a relative path, because the editing tool may resolve it against a different checkout. If the report was accidentally created elsewhere, move the existing file with \`mv\` instead of re-authoring its content.

Use the section headings exactly as written below; they are the recommended skeleton, and the harness reports deviations from it as advisory structure warnings. Only the standalone Status line (and at least one finding when the status is FAIL) is enforced mechanically. Write all prose in the user's language.

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

// The run directory carries no derived view files: state.json is the single
// machine record and `status` renders it on demand. Only the coordinator's
// free-form notes file needs a one-time seed.
function ensureContextNotes(statePath, state) {
  const runDir = path.dirname(statePath);
  if (!fs.existsSync(path.join(runDir, "context-notes.md"))) {
    writeMarkdown(path.join(runDir, "context-notes.md"), `# Context Notes\n\n- PRD: ${state.prdPath}\n`);
  }
}

module.exports = {
  writeImplementationReport,
  renderRequirementsReviewPrompt,
  renderReviewPrompt,
  ensureContextNotes,
};
