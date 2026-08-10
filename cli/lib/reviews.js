"use strict";

const fs = require("fs");
const path = require("path");

const { cwd, resolveProjectPath, toProjectRelative, canonicalPath, sha256File, sha256Text, normalizeRelPath, escapeRegExp } = require("./util");
const { worktreeSnapshot, snapshotMaterializedInHead, snapshotEntriesEqual, snapshotPathMatches, primaryWorktreeRoot } = require("./git");
const { isVerificationRequiredForDone, verificationPlanSummary, executionPlanSummary, latestEvidenceTimestamp, finalReviewRequiredForState } = require("./state_data");
const { extractSection, parseMarkdownTableRow, isTableSeparator } = require("./prd_parser");
const { verificationContractHash } = require("./planning");
const { collectArtifacts, inspectArtifact, verificationEvidenceKindViolations, unregisteredArtifactViolations } = require("./artifacts");

function validateArtifacts(statePath, state, options = {}) {
  const includeRequirementsFidelityReview = options.includeRequirementsFidelityReview !== false;
  const includeFinalReview = options.includeFinalReview !== false;
  const violations = [];
  for (const entry of collectArtifacts(state)) {
    const artifact = entry.artifact || {};
    if (!artifact.path) {
      violations.push(`${entry.ownerKind} ${entry.ownerId} has artifact without path`);
      continue;
    }
    try {
      const abs = resolveProjectPath(artifact.path, state.projectRoot || cwd());
      const info = inspectArtifact(abs, artifact.kind || "file");
      if (artifact.sha256 && artifact.sha256 !== info.sha256) {
        violations.push(`${entry.ownerKind} ${entry.ownerId} artifact ${artifact.artifactId || artifact.path} hash changed`);
      }
    } catch (error) {
      violations.push(`${entry.ownerKind} ${entry.ownerId} artifact invalid: ${error.message}`);
    }
  }
  const requirementsReview = state.requirementsFidelityReview;
  if (includeRequirementsFidelityReview && requirementsReview && requirementsReview.reportPath) {
    try {
      const abs = resolveProjectPath(requirementsReview.reportPath, state.projectRoot || cwd());
      inspectArtifact(abs, "log");
      if (requirementsReview.reportSha256 && requirementsReview.reportSha256 !== sha256File(abs)) {
        violations.push("Requirements fidelity review report hash changed");
      }
    } catch (error) {
      violations.push(`Requirements fidelity review report invalid: ${error.message}`);
    }
  }
  const finalReview = state.finalReview;
    if (includeFinalReview && finalReview && finalReview.reportPath) {
    try {
      const abs = resolveProjectPath(finalReview.reportPath, state.projectRoot || cwd());
      inspectArtifact(abs, "log");
      if (finalReview.reportSha256 && finalReview.reportSha256 !== sha256File(abs)) {
        violations.push("Final review report hash changed");
      }
    } catch (error) {
      violations.push(`Final review report invalid: ${error.message}`);
    }
    }
    violations.push(...unregisteredArtifactViolations(statePath, state));
    violations.push(...verificationEvidenceKindViolations(state));
    if (includeRequirementsFidelityReview) violations.push(...requirementsFidelityReviewFreshnessViolations(state));
    if (includeFinalReview) violations.push(...finalReviewFreshnessViolations(state));
    violations.push(...reviewWorktreeSnapshotViolations(state, {
      includeRequirementsFidelityReview,
      includeFinalReview,
    }));
    return violations;
  }

function assertReviewReportStatus(reportAbs, status) {
  const expected = status === "pass" ? "PASS" : "FAIL";
  const text = fs.readFileSync(reportAbs, "utf8");
  const match = text.match(/^\s*Status:\s*(PASS|FAIL)\s*$/im);
  if (!match) {
    throw new Error(`Review report must include a standalone 'Status: ${expected}' line`);
  }
  if (match[1].toUpperCase() !== expected) {
    throw new Error(`Review report status ${match[1].toUpperCase()} does not match --status ${status}`);
  }
}

/**
 * Review-report validation runs in two tiers.
 *
 * Hard rejections (throw) are only what a machine can own without judging
 * prose: the report exists non-empty (inspectArtifact at the call sites), the
 * standalone Status line matches --status, and a FAIL carries at least one
 * finding line. Record-level checks outside prose structure - report
 * path/hash recording, fidelity-precedes-final ordering, freshness - stay
 * hard where they already live.
 *
 * Everything about the report's SHAPE - section presence, bullet/entry
 * floors, Coverage Judgment label grammar, per-V# mentions, placeholder
 * heuristics - is advisory: it is still computed but RETURNED as
 * structureWarnings for the command to print, never a rejection. Structure
 * validation of LLM prose is a losing arms race (this file was already a
 * ledger of carve-outs: table traces, plain label lines, code-span
 * placeholder exemptions), and in an audited run the format validator
 * rejected a semantically valid report 5 times over formatting alone,
 * costing 8 turns.
 */
function assertFinalReviewReport(reportAbs, status, state) {
  assertReviewReportStatus(reportAbs, status);
  const text = fs.readFileSync(reportAbs, "utf8");
  const violations = [];
  const warnings = [];
  for (const heading of ["Fidelity Review Checked", "Findings", "Artifact Audit", "Deviation Audit", "Verdict"]) {
    if (!meaningfulReviewSection(extractSection(text, heading))) {
      warnings.push(`Final review section '${heading}' is missing or empty`);
    }
  }
  // The final review audits the requirements fidelity review as the primary
  // semantic proof; it deliberately does not repeat a per-V# checklist (the
  // fidelity report already enforces one), and the harness stores the fidelity
  // report hash itself, so no sha citation is demanded from the reviewer.
  const fidelity = state.requirementsFidelityReview;
  if (status === "pass") {
    if (!fidelity || fidelity.status !== "pass") {
      violations.push("Final review cannot pass before a recorded passing requirements fidelity review");
    } else {
      const recordedAt = Date.parse(fidelity.recordedAt || "");
      const reportMtime = fs.statSync(reportAbs).mtimeMs;
      if (Number.isFinite(recordedAt) && reportMtime + 2000 < recordedAt) {
        violations.push("Final review report was written before the requirements fidelity review was recorded; run the independent final reviewer after the fidelity review is recorded");
      }
    }
    if (/\b(?:TODO|TBD|FIXME)\b/i.test(text)) {
      warnings.push("Passing final review should not contain TODO, TBD, or FIXME placeholders");
    }
  }
  if (status === "fail" && reviewBulletCount(extractSection(text, "Findings")) < 1) {
    violations.push("Failing final review must include at least one finding");
  }
  if (violations.length) {
    throw new Error(`Invalid final review report:\n- ${violations.join("\n- ")}`);
  }
  return warnings;
}

function assertRequirementsFidelityReport(reportAbs, status, state) {
  assertReviewReportStatus(reportAbs, status);
  const text = fs.readFileSync(reportAbs, "utf8");
  const requiredSections = [
    "Intent Sources Read",
    "Decision Trace",
    "Findings",
    "Verification Intent Checklist",
    "Coverage Judgment",
    "Deviation Audit",
    "Verdict",
  ];
  const violations = [];
  const warnings = [];
  for (const heading of requiredSections) {
    const section = extractSection(text, heading);
    if (!meaningfulReviewSection(section)) {
      warnings.push(`Requirements fidelity report section '${heading}' is missing or empty`);
    }
  }

  const intentSources = extractSection(text, "Intent Sources Read");
  if (reviewBulletCount(intentSources) < 1) {
    warnings.push("Requirements fidelity report Intent Sources Read should list at least one bullet like '- agents/prd/<slug>/prd.md'");
  }

  const decisionTrace = extractSection(text, "Decision Trace");
  // Advise a small floor of traced entries rather than one bullet per parsed
  // decision: a PRD with many decisions should not force the reviewer to
  // enumerate dozens of bullets, and a table trace is valid. The reviewer owns
  // how thoroughly to group; the coverage judgment below is the real gate.
  const decisionCount = state.intentTrace ? state.intentTrace.decisionCount || 0 : 0;
  const expectedDecisionCount = Math.min(Math.max(1, decisionCount), 3);
  const decisionTraceEntryCount = reviewEntryCount(decisionTrace);
  if (decisionTraceEntryCount < expectedDecisionCount) {
    warnings.push(`Requirements fidelity report Decision Trace should include at least ${expectedDecisionCount} traced decision/proposal entr${expectedDecisionCount === 1 ? "y" : "ies"}; found ${decisionTraceEntryCount}. Each entry is a bullet like '- <decision>: <where it landed> | gap: none' or a markdown table row`);
  }

  const coverage = extractSection(text, "Coverage Judgment");
  // The bullet is formatting, not substance: a plain `Label: judgment` line at
  // line start carries the same claim. Every warning message below spells out
  // a literally-conforming line for the same reason.
  for (const label of ["Requirements", "Acceptance Criteria", "User-visible behavior", "Non-goals and rejected options", "Human verification"]) {
    const re = new RegExp(`^\\s*(?:[-*]\\s*)?${escapeRegExp(label)}\\s*:\\s*\\S`, "im");
    if (!re.test(coverage)) warnings.push(`Requirements fidelity report Coverage Judgment should include a line '${label}: <judgment>' (leading bullet '-' optional)`);
  }

  const verificationChecklist = extractSection(text, "Verification Intent Checklist");
  for (const verification of state.verification || []) {
    if (!isVerificationRequiredForDone(verification)) continue;
    const re = new RegExp(`\\b${escapeRegExp(verification.id)}\\b`, "i");
    if (!re.test(verificationChecklist)) {
      warnings.push(`Requirements fidelity report Verification Intent Checklist should mention required verification ${verification.id}, e.g. '- ${verification.id}: Pass Intent: <intent>; Artifacts checked: <path>; Judgment: PASS; Gap: none'`);
    }
  }

  if (status === "pass") {
    // Strip fenced and inline code so legitimate generics/tags (`Array<string>`,
    // `<button>`) do not read as unfilled template placeholders. Only angle
    // tokens that carry a placeholder-style separator (space, slash, hash, or
    // hyphen) after a leading letter are treated as leftover `<topic-slug>`-style
    // markers.
    const prose = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
    const hasLeftoverPlaceholder = /<[A-Za-z][^>\n]*[ \/#-][^>\n]*>/.test(prose);
    if (/\b(?:TODO|TBD|FIXME)\b/i.test(prose) || hasLeftoverPlaceholder) {
      warnings.push("Passing requirements fidelity report should not contain leftover <template> placeholders, TODO, TBD, or FIXME; replace each with real content, or wrap literal angle-bracket text in backticks (code spans are exempt)");
    }
    const unresolvedGap = decisionTrace
      .split(/\r?\n/)
      .some(line => /\bgap\s*:\s*(?=\S)(?!none\b|no\b|n\/a\b|없음\b|-+\s*$).+/i.test(line.trim()));
    if (unresolvedGap) {
      warnings.push("Passing requirements fidelity report Decision Trace contains a non-none gap");
    }
  }

  if (status === "fail" && reviewBulletCount(extractSection(text, "Findings")) < 1) {
    violations.push("Failing requirements fidelity report must include at least one finding");
  }

  if (violations.length) {
    throw new Error(`Invalid requirements fidelity report:\n- ${violations.join("\n- ")}`);
  }
  return warnings;
}

function meaningfulReviewSection(section) {
  const cleaned = String(section || "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
  if (!cleaned) return false;
  if (/<[^>\n]+>/.test(cleaned) && cleaned.split(/\s+/).length < 12) return false;
  return true;
}

function reviewBulletCount(section) {
  return String(section || "")
    .split(/\r?\n/)
    .filter(line => /^\s*[-*]\s+\S/.test(line.trim()))
    .length;
}

// Count decision entries whether the reviewer used bullets or a markdown table,
// so a concise or tabular trace is not mechanically rejected. Table header rows
// may be counted too; that leniency is intentional.
function reviewEntryCount(section) {
  let count = 0;
  for (const raw of String(section || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (/^[-*]\s+\S/.test(line)) {
      count += 1;
    } else if (/^\|.*\|$/.test(line)) {
      const cells = parseMarkdownTableRow(line);
      if (!isTableSeparator(cells) && cells.some(cell => /[A-Za-z0-9]/.test(cell))) count += 1;
    }
  }
  return count;
}

function finalReviewFreshnessViolations(state) {
  const review = state.finalReview;
  if (!review || !review.recordedAt || review.status !== "pass") return [];
  const reviewedAt = Date.parse(review.recordedAt);
  if (!Number.isFinite(reviewedAt)) return ["Final review recordedAt is invalid"];
  const requirementsReview = state.requirementsFidelityReview;
  if (requirementsReview && requirementsReview.status === "pass" && requirementsReview.recordedAt) {
    const requirementsReviewedAt = Date.parse(requirementsReview.recordedAt);
    if (Number.isFinite(requirementsReviewedAt) && requirementsReviewedAt > reviewedAt) {
      return ["Final review is stale: requirements fidelity review was recorded after final review"];
    }
  }
  const latest = latestEvidenceTimestamp(state);
  if (latest && latest.time > reviewedAt) {
    return [`Final review is stale: ${latest.label} was recorded after final review`];
  }
  return [];
}

function requirementsFidelityReviewFreshnessViolations(state) {
  const review = state.requirementsFidelityReview;
  if (!review || !review.recordedAt || !["pass", "fail"].includes(review.status)) return [];
  const reviewedAt = Date.parse(review.recordedAt);
  if (!Number.isFinite(reviewedAt)) return ["Requirements fidelity review recordedAt is invalid"];
  const latest = latestEvidenceTimestamp(state);
  if (latest && latest.time > reviewedAt) {
    return [`Requirements fidelity review is stale: ${latest.label} was recorded after requirements fidelity review`];
  }
  return [];
}

function reviewWorktreeSnapshotViolations(state, options = {}) {
  const includeRequirementsFidelityReview = options.includeRequirementsFidelityReview !== false;
  const includeFinalReview = options.includeFinalReview !== false;
  const violations = [];
  const current = worktreeSnapshot(state);
  if (!current) return violations;
  const check = (review, label) => {
    if (!review || !["pass", "fail"].includes(review.status) || !review.worktreeSnapshot) return;
    const headChanged = Boolean(review.worktreeSnapshot.headSha && current.headSha
      && review.worktreeSnapshot.headSha !== current.headSha);
    if ((headChanged || review.worktreeSnapshot.statusHash !== current.statusHash)
      && !reviewSnapshotMatchesCurrent(review.worktreeSnapshot, current, state)) {
      violations.push(`${label} is stale: worktree source snapshot changed after review`);
    }
  };
  if (includeRequirementsFidelityReview) check(state.requirementsFidelityReview, "Requirements fidelity review");
  if (includeFinalReview) check(state.finalReview, "Final review");
  return violations;
}

function reviewSnapshotMatchesCurrent(savedSnapshot, currentSnapshot, state) {
  const projectRoot = state.projectRoot || cwd();
  // A commit that leaves the working tree clean would otherwise produce an
  // identical status snapshot; comparing HEAD catches commit-only source changes
  // after a review. Only enforced when both snapshots recorded a HEAD (backward
  // compatible with snapshots captured before this field existed).
  if (savedSnapshot && currentSnapshot && savedSnapshot.headSha && currentSnapshot.headSha
    && savedSnapshot.headSha !== currentSnapshot.headSha) {
    return snapshotMaterializedInHead(savedSnapshot, currentSnapshot, state);
  }
  const savedEntries = Array.isArray(savedSnapshot && savedSnapshot.entries) ? savedSnapshot.entries : [];
  const currentEntries = Array.isArray(currentSnapshot && currentSnapshot.entries) ? currentSnapshot.entries : [];
  const savedByPath = new Map(savedEntries.map(entry => [normalizeRelPath(entry.path), entry]));
  const currentByPath = new Map(currentEntries.map(entry => [normalizeRelPath(entry.path), entry]));

  for (const saved of savedEntries) {
    const rel = normalizeRelPath(saved.path);
    const current = currentByPath.get(rel);
    if (current) {
      if (!snapshotEntriesEqual(saved, current)) return false;
      continue;
    }
    if (!snapshotPathMatches(saved, path.join(projectRoot, rel))) return false;
  }

  for (const current of currentEntries) {
    const rel = normalizeRelPath(current.path);
    const saved = savedByPath.get(rel);
    if (!saved) return false;
    if (!snapshotEntriesEqual(saved, current)) return false;
  }

  return true;
}

function completionReadiness(statePath, state, options = {}) {
  const violations = completionViolations(statePath, state, options);
  return {
    receiptEligible: violations.length === 0 && Boolean(state.finalReceipt),
    finalizationEligible: violations.length === 0,
    violationCount: violations.length,
    violations,
  };
}

// The sasu verify gate judges the run diff against the PRD acceptance
// criteria. Completion refuses a gate that ran and failed (BLOCKED) or whose
// passing inputs changed afterward (STALE). A gate that never ran does not
// block - offline and test runs stay possible - but its status is stamped
// into the receipt so a skipped gate is visible, never silent.
function verifyGateStatus(state) {
  const projectRoot = state.projectRoot || cwd();
  if (!state.topicSlug) return { effective: "NOT_RUN", verdict: null, overridden: false, lastRunAt: null };
  const gatesPath = path.join(projectRoot, "agents", "gates", state.topicSlug, "gates.json");
  if (!fs.existsSync(gatesPath)) return { effective: "NOT_RUN", verdict: null, overridden: false, lastRunAt: null };
  let gatesState;
  try {
    gatesState = JSON.parse(fs.readFileSync(gatesPath, "utf8"));
  } catch {
    return { effective: "NOT_RUN", verdict: null, overridden: false, lastRunAt: null, unreadable: true };
  }
  try {
    const store = require("../dist/gates/store.js");
    const view = store.gateStatus(gatesState, "verify", 0, projectRoot);
    const record = (gatesState.gates && gatesState.gates.verify) || {};
    return { effective: view.effective, verdict: view.verdict, overridden: view.overridden, staleInputs: view.staleInputs, lastRunAt: record.lastRunAt || null };
  } catch {
    // CLI dist not built: fall back to the recorded verdict without freshness.
    const record = (gatesState.gates && gatesState.gates.verify) || {};
    const passed = record.verdict === "PASS" || record.overridden === true;
    return {
      effective: passed ? "PASS" : record.verdict == null ? "NOT_RUN" : "BLOCKED",
      verdict: record.verdict || null,
      overridden: record.overridden === true,
      lastRunAt: record.lastRunAt || null,
      freshnessUnverified: true,
    };
  }
}

function verifyGateViolations(state) {
  const gate = verifyGateStatus(state);
  if (gate.effective === "BLOCKED") {
    return [`Verify gate is BLOCKED (verdict ${gate.verdict}); fix the cited findings and re-run \`sasu verify\`, or have the user record an override`];
  }
  if (gate.effective === "STALE") {
    return ["Verify gate PASS is stale: its input documents changed after the passing run; re-run `sasu verify` against the current diff"];
  }
  return [];
}

function completionViolations(statePath, state, options = {}) {
  const includeFinalReview = options.includeFinalReview !== false;
  const includeRequirementsFidelityReview = options.includeRequirementsFidelityReview !== false;
  const violations = [];
  violations.push(...prdSnapshotViolations(statePath, state));
  violations.push(...verifyGateViolations(state));
  const verificationPlan = verificationPlanSummary(state);
  if (verificationPlan.status === "missing") {
    violations.push("Verification plan is missing");
  } else if (verificationPlan.blockingGapCount > 0) {
    violations.push(`Verification plan has ${verificationPlan.blockingGapCount} blocking gap(s)`);
  }
  const executionPlan = executionPlanSummary(state);
  if (executionPlan.status === "missing") {
    violations.push("Execution plan is missing");
  } else if (executionPlan.blockingGapCount > 0) {
    violations.push(`Execution plan has ${executionPlan.blockingGapCount} blocking gap(s)`);
  }
  for (const task of state.tasks) {
    if (task.status !== "complete") violations.push(`Task ${task.id} is ${task.status}`);
    if (!task.evidence.length) violations.push(`Task ${task.id} has no evidence`);
  }
  const coveragePlan = state.verificationPlan;
  const checksById = coveragePlan && Array.isArray(coveragePlan.checks)
    ? new Map(coveragePlan.checks.map(check => [check.id, check]))
    : new Map();
  const verificationById = new Map((state.verification || []).map(item => [item.id, item]));
  for (const ac of state.acceptanceCriteria) {
    if (ac.status !== "met") violations.push(`Acceptance ${ac.id} is ${ac.status}`);
    if (!ac.evidence.length) violations.push(`Acceptance ${ac.id} has no evidence`);
    // An oracle-backed AC satisfies coverage through its oracle, not a V row
    // (the planner, prelint, and gen-prd all promise no V-row mapping is
    // needed; demanding one here deadlocked finalize for every run that used
    // the documented feature). But the exemption is earned only by evidence:
    // met must rest on a harness-recorded passing oracle observation
    // (cmdOracleRun stamps ac.oracleObservation), because met status alone
    // can be reached by drift or a hand-edited state file.
    if (ac.oracle && typeof ac.oracle === "object") {
      if (ac.status === "met" && !(ac.oracleObservation && ac.oracleObservation.met === true)) {
        violations.push(`Acceptance ${ac.id} is met but its declared oracle has no recorded passing observation; run oracle-run --id ${ac.id} so the harness observes the pass`);
      }
      continue;
    }
    // Mechanical backstop for the skill's promise that every AC is provably
    // closed: prose evidence alone cannot complete an AC whose entire
    // verification coverage was skipped or blocked.
    if (ac.status === "met" && coveragePlan && coveragePlan.coverage && coveragePlan.coverage[ac.id]) {
      const anyCoveringPass = (coveragePlan.coverage[ac.id].coveredBy || []).some(checkId => {
        const check = checksById.get(checkId);
        const verification = check ? verificationById.get(check.verificationId) : null;
        return Boolean(verification && verification.status === "pass");
      });
      if (!anyCoveringPass) violations.push(`Acceptance ${ac.id} is met but none of its covering verification items passed`);
    }
  }
    for (const verification of state.verification) {
      if (isVerificationRequiredForDone(verification)) {
        if (verification.status !== "pass") violations.push(`Required verification ${verification.id} is ${verification.status}`);
      } else if (!["pass", "skipped", "blocked"].includes(verification.status)) {
        violations.push(`Optional verification ${verification.id} is ${verification.status}`);
      }
      if (!verification.evidence.length) violations.push(`Verification ${verification.id} has no evidence`);
      if (verification.status === "pass" && (!verification.artifacts || verification.artifacts.length === 0)) {
        violations.push(`Verification ${verification.id} has no artifact-backed evidence`);
      }
  }
  violations.push(...validateArtifacts(statePath, state, {
    includeRequirementsFidelityReview,
    includeFinalReview,
  }));
  if (includeRequirementsFidelityReview) {
    if (!state.requirementsFidelityReview || state.requirementsFidelityReview.status !== "pass") {
      violations.push("Requirements fidelity review has not passed");
    } else if (!state.requirementsFidelityReview.reportPath) {
      violations.push("Requirements fidelity review has no report path");
    }
  }
  if (includeFinalReview && finalReviewRequiredForState(state)) {
    if (!state.finalReview || state.finalReview.status !== "pass") {
      violations.push("Final adversarial review has not passed");
    } else if (!state.finalReview.reportPath) {
      violations.push("Final adversarial review has no report path");
    }
  }
    return violations;
  }

function prdSnapshotViolations(statePath, state) {
  const snapshot = state.prdSnapshot;
  if (!snapshot) return [];
  const violations = [];
  try {
    const prdAbs = resolveProjectPath(state.prdPath, state.projectRoot || cwd());
    const currentText = fs.readFileSync(prdAbs, "utf8");
    if (snapshot.sha256 && snapshot.sha256 !== sha256Text(currentText)) {
      violations.push("PRD file changed after implementation state was initialized; run `reconcile` to refresh the snapshot while preserving recorded marks (init --force is only for a user-requested clean restart)");
    }
  } catch (error) {
    violations.push(`PRD snapshot cannot be validated: ${error.message}`);
  }
  const taskIds = (state.tasks || []).map(item => item.id).join(",");
  const snapshotTaskIds = (snapshot.taskIds || []).join(",");
  if (snapshotTaskIds && taskIds !== snapshotTaskIds) violations.push("State task IDs differ from PRD snapshot task IDs");
  const acIds = (state.acceptanceCriteria || []).map(item => item.id).join(",");
  const snapshotAcIds = (snapshot.acceptanceCriteriaIds || []).join(",");
  if (snapshotAcIds && acIds !== snapshotAcIds) violations.push("State acceptance IDs differ from PRD snapshot acceptance IDs");
  const prdVerification = (state.verification || [])
    .filter(item => item.source !== "rules_injection" && !item.sourceRuleId);
  const verificationIds = prdVerification.map(item => item.id).join(",");
  const snapshotVerificationIds = (snapshot.verificationIds || []).join(",");
  if (snapshotVerificationIds && verificationIds !== snapshotVerificationIds) violations.push("State verification IDs differ from PRD snapshot verification IDs");
  if (snapshot.verificationContractHash && snapshot.verificationContractHash !== verificationContractHash({
    ...state,
    verification: prdVerification,
  })) {
    violations.push("State verification contract hash differs from PRD snapshot");
  }
  return violations;
}

function requirementsFidelityHandoffViolations(state) {
  const review = state.requirementsFidelityReview;
  if (!review) return ["Requirements fidelity review must be recorded before blocked/partial finalization"];
  const violations = [];
  if (!["pass", "fail"].includes(review.status)) {
    violations.push(`Requirements fidelity review status must be pass or fail before blocked/partial finalization; got ${review.status || "unknown"}`);
  }
  if (!review.reportPath) violations.push("Requirements fidelity review has no report path");
  if (!review.summary) violations.push("Requirements fidelity review has no summary");
  if (!review.recordedAt) violations.push("Requirements fidelity review has no recordedAt timestamp");
  if (review.reportPath) {
    try {
      const abs = resolveProjectPath(review.reportPath, state.projectRoot || cwd());
      inspectArtifact(abs, "log");
      if (review.reportSha256 && review.reportSha256 !== sha256File(abs)) {
        violations.push("Requirements fidelity review report hash changed");
      }
    } catch (error) {
      violations.push(`Requirements fidelity review report invalid: ${error.message}`);
    }
  }
  violations.push(...requirementsFidelityReviewFreshnessViolations(state));
  violations.push(...reviewWorktreeSnapshotViolations(state));
  return violations;
}

// Symmetric to requirementsFidelityHandoffViolations for the final
// adversarial review: on a high-risk profile, partial/blocked finalization is
// still a handoff of high-risk work, so the independent final review must
// have HAPPENED and its verdict must land in the receipt. A recorded fail is
// acceptable - the receipt then carries the adverse verdict honestly - but a
// missing review means a high-risk change reaches the PR with zero
// independent scrutiny, which is exactly the hole this closes. Non-high-risk
// profiles never require the final review, so they are untouched.
function finalReviewHandoffViolations(state) {
  if (!finalReviewRequiredForState(state)) return [];
  const review = state.finalReview;
  if (!review) {
    return ["Final adversarial review must be recorded before blocked/partial finalization on a high-risk profile (a recorded fail is acceptable); run `review-prompt` then `review-record`"];
  }
  const violations = [];
  if (!["pass", "fail"].includes(review.status)) {
    violations.push(`Final adversarial review status must be pass or fail before blocked/partial finalization; got ${review.status || "unknown"}; run \`review-prompt\` then \`review-record\``);
  }
  if (!review.reportPath) violations.push("Final adversarial review has no report path");
  if (!review.summary) violations.push("Final adversarial review has no summary");
  if (!review.recordedAt) violations.push("Final adversarial review has no recordedAt timestamp");
  if (review.reportPath) {
    try {
      const abs = resolveProjectPath(review.reportPath, state.projectRoot || cwd());
      inspectArtifact(abs, "log");
      if (review.reportSha256 && review.reportSha256 !== sha256File(abs)) {
        violations.push("Final adversarial review report hash changed");
      }
    } catch (error) {
      violations.push(`Final adversarial review report invalid: ${error.message}`);
    }
  }
  violations.push(...finalReviewFreshnessViolations(state));
  return violations;
}

function assertAllowedStatus(kind, status) {
  const allowed = {
    task: ["pending", "in_progress", "complete", "deferred", "blocked"],
    ac: ["pending", "met", "not_met", "blocked"],
    verification: ["pending", "pass", "fail", "skipped", "blocked"],
  }[kind];
  if (!allowed.includes(status)) throw new Error(`Invalid ${kind} status '${status}'. Allowed: ${allowed.join(", ")}`);
}

function prdCopyDriftWarnings(state) {
  const projectRoot = state.projectRoot || cwd();
  const primary = primaryWorktreeRoot(projectRoot);
  if (!primary || canonicalPath(primary) === canonicalPath(projectRoot)) return [];
  const prdPath = state.prdPath || (state.prdSnapshot && state.prdSnapshot.path);
  if (!prdPath || path.isAbsolute(prdPath)) return [];
  const worktreePrd = path.join(projectRoot, prdPath);
  const primaryPrd = path.join(primary, prdPath);
  if (!fs.existsSync(worktreePrd) || !fs.existsSync(primaryPrd)) return [];
  const worktreeHash = sha256File(worktreePrd);
  const primaryHash = sha256File(primaryPrd);
  if (worktreeHash === primaryHash) return [];
  return [`PRD copy drift: ${toProjectRelative(primaryPrd, primary)} in primary checkout differs from worktree source of truth ${toProjectRelative(worktreePrd, projectRoot)}`];
}

module.exports = {
  validateArtifacts,
  assertReviewReportStatus,
  assertFinalReviewReport,
  assertRequirementsFidelityReport,
  meaningfulReviewSection,
  reviewBulletCount,
  reviewEntryCount,
  finalReviewFreshnessViolations,
  requirementsFidelityReviewFreshnessViolations,
  reviewWorktreeSnapshotViolations,
  reviewSnapshotMatchesCurrent,
  completionReadiness,
  completionViolations,
  verifyGateStatus,
  verifyGateViolations,
  prdSnapshotViolations,
  requirementsFidelityHandoffViolations,
  finalReviewHandoffViolations,
  assertAllowedStatus,
  prdCopyDriftWarnings,
};
