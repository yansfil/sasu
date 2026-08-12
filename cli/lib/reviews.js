"use strict";

const fs = require("fs");
const path = require("path");

const { cwd, resolveProjectPath, toProjectRelative, canonicalPath, sha256File, sha256Text, escapeRegExp, harnessCommand } = require("./util");
const { vouchedTreeFingerprintForState, vouchedFingerprintsMatch, primaryWorktreeRoot, worktreeSnapshot } = require("./git");
const { judgeRetryBudget } = require("./config");
const { isVerificationRequiredForDone, verificationPlanSummary, executionPlanSummary, latestEvidenceTimestamp, finalReviewRequiredForState } = require("./state_data");
const { extractSection, parseMarkdownTableRow, isTableSeparator, pendingPreWork } = require("./prd_parser");
const { verificationContractHash } = require("./planning");
const { hashGateInput } = require("./gate_freshness");
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
    if (includeRequirementsFidelityReview) {
      violations.push(...requirementsFidelityReviewFreshnessViolations(state));
      violations.push(...requirementsFidelityReviewInputViolations(state));
    }
    if (includeFinalReview) violations.push(...finalReviewFreshnessViolations(state));
    violations.push(...reviewWorktreeSnapshotViolations(state, {
      includeRequirementsFidelityReview,
      includeFinalReview,
    }));
    return violations;
  }

/**
 * The verdict the reviewer stated for its OWN report, read leniently.
 *
 * Scoped by structure, not by phrasing (PRINCIPLES item 11): both report
 * templates put the report's own verdict in the preamble above the first `##`
 * heading, and restate it in the `Verdict` section. A `Status:` line anywhere
 * else describes something else - the final-review skeleton literally asks for
 * `- Status: <recorded status>` under `Fidelity Review Checked`, so a
 * whole-file scan would read a FAILing final review's citation of a PASSing
 * fidelity review as a self-contradiction and reject a valid report.
 *
 * Within that scope, only lines whose FIRST token is a verdict label count, so
 * a per-item line (`- V2: Judgment: FAIL`, `| V3 | FAIL |`) is never mistaken
 * for the verdict. Emphasis, bullets, code spans, trailing punctuation and
 * trailing prose are stripped: `**Status:** PASS ✅` and `Status: PASS (with
 * one advisory)` state the same verdict as `Status: PASS`.
 *
 * A line that names BOTH verdicts is the unfilled skeleton (`Status: PASS |
 * FAIL`) and states nothing; it is reported as ambiguous, never read as PASS.
 */
const REVIEW_VERDICT_LABEL = /^\s*(?:[-*+]\s+)?[*_`]{0,2}(?:Status|Verdict)[*_`]{0,2}\s*[:：]\s*(.+)$/i;

function statedReviewVerdicts(text) {
  const body = String(text).replace(/```[\s\S]*?```/g, "");
  const scopes = [body.split(/\r?\n#{2,}\s/)[0], extractSection(body, "Verdict")];
  const verdicts = [];
  const ambiguous = [];
  for (const raw of scopes.join("\n").split(/\r?\n/)) {
    const match = raw.match(REVIEW_VERDICT_LABEL);
    if (!match) continue;
    const value = match[1].replace(/[`*_~]/g, "").trim();
    const hasPass = /\bPASS\b/i.test(value);
    const hasFail = /\bFAIL\b/i.test(value);
    if (hasPass && hasFail) {
      ambiguous.push(raw.trim());
    } else if (hasPass || hasFail) {
      verdicts.push({ line: raw.trim(), verdict: hasPass ? "PASS" : "FAIL" });
    }
  }
  return { verdicts, ambiguous };
}

/**
 * The verdict lives in exactly one place: the recorded `--status`. The report
 * is cross-checked against it, never required to restate it in a fixed shape.
 *
 * The old check demanded a standalone `^Status: PASS$` line and rejected
 * anything else, which made the same fact a hand-maintained duplicate of the
 * flag. In a real run (2026-08-11, modakbul/webhook-to-modakbul-server) the
 * agent patched its own fidelity report with python heredoc string
 * replacement four times (+66m, +85m, +97m, +129m) to satisfy that shape -
 * editing evidence to satisfy a mechanical check, one step from forging it.
 *
 * What survives is the only part that was ever proof: a report that STATES a
 * verdict contradicting the recorded one is rejected, and the lenient reader
 * above now catches contradictions in shapes the strict regex silently missed
 * (`**Status:** FAIL`, `Status: FAIL - see findings`). What leaves is the
 * shape requirement: a report that states no verdict is recorded under the
 * flag with an advisory warning, because the flag already carries it.
 */
function assertReviewReportVerdict(reportAbs, status) {
  const expected = status === "pass" ? "PASS" : "FAIL";
  const text = fs.readFileSync(reportAbs, "utf8");
  const stated = statedReviewVerdicts(text);
  const contradiction = stated.verdicts.find(entry => entry.verdict !== expected);
  if (contradiction) {
    throw new Error(`Review report states '${contradiction.line}' but --status ${status} was recorded. Record the verdict the report actually reached; do not edit the report to match the flag.`);
  }
  const warnings = [];
  if (!stated.verdicts.length) {
    warnings.push(stated.ambiguous.length
      ? `Review report leaves the skeleton verdict line unfilled ('${stated.ambiguous[0]}'); --status ${status} is the recorded verdict`
      : `Review report states no verdict line (e.g. 'Status: ${expected}'); --status ${status} is the recorded verdict`);
  }
  return warnings;
}

/**
 * Review-report validation runs in two tiers.
 *
 * Hard rejections (throw) are only what a machine can own without judging
 * prose: the report exists non-empty (inspectArtifact at the call sites), no
 * stated verdict contradicts --status (assertReviewReportVerdict - a
 * contradiction check, not a shape check), and a FAIL carries at least one
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
  const text = fs.readFileSync(reportAbs, "utf8");
  const violations = [];
  const warnings = [...assertReviewReportVerdict(reportAbs, status)];
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
  const warnings = [...assertReviewReportVerdict(reportAbs, status)];
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

/**
 * The severity vocabulary the harness compares, and the floor that separates a
 * finding a run may carry from one it may not.
 *
 * Declaring this in the review report passes the item 7 test because the
 * harness executes a comparison on the value. `MINOR` is a claim the reviewer
 * makes and the harness acts on -
 * it becomes a recorded follow-up instead of another review round - and
 * `BLOCKER`/`MAJOR` is a claim the harness holds the recording to.
 *
 * The parse is deliberately lenient about everything except the token, and the
 * generated reviewer prompt teaches these three words, so this is a value the
 * harness declared rather than prose it guesses at (item 11).
 */
const REVIEW_SEVERITIES = ["BLOCKER", "MAJOR", "MINOR"];

/**
 * Severities the report STATES for its findings, in order.
 *
 * What this deliberately does not do is decide which bullets are findings. A
 * passing report conventionally writes `- none: no material findings`, and any
 * rule that counted bullets as findings would reject it - that is the same
 * prose-shape enforcement that pushed agents into rewriting reports to satisfy a
 * formatter, deleted for exactly that reason. So the harness reads only what the
 * reviewer explicitly labelled, and stays silent about the rest: an unlabelled
 * bullet is not deferrable and not a contradiction, which is the behaviour that
 * was already there.
 */
function statedFindingSeverities(text) {
  const section = extractSection(String(text || ""), "Findings");
  const found = [];
  for (const raw of section.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // A severity is read only where it is a LABEL, never wherever the word
    // appears: either keyed (`Severity: MINOR`, `**Severity:** minor`,
    // `(severity=Major)`) or leading the bullet or table cell (`- MINOR - the
    // copy is terse`). Matching the bare word anywhere read "the team plans a
    // major refactor later" as a MAJOR finding - detection built from how one
    // sentence happens to be phrased is the coin flip item 11 names, so this
    // keys on position instead.
    const keyed = line.match(/severity\s*[:=]\s*\**\s*\b(BLOCKER|MAJOR|MINOR)\b/i);
    const leading = line.match(/^(?:[-*]|\|)\s*\**\s*\b(BLOCKER|MAJOR|MINOR)\b/i);
    const match = keyed || leading;
    if (!match) continue;
    const severity = match[1].toUpperCase();
    // A label with nothing after it is a skeleton row, not a finding.
    const rest = line.slice(match.index + match[0].length).replace(/^[\s:*_|\]).-]+/, "").trim();
    found.push({ severity, text: rest || line });
  }
  return found;
}

/**
 * Reject a `pass` recording that contradicts a severity the report itself
 * stated, and return the findings the run may carry instead.
 *
 * A contradiction check, never a shape check: nothing here demands that a report
 * label anything. Labelling is how a reviewer claims a finding is minor enough
 * to defer, so a report that labels nothing simply has nothing to defer - the
 * pre-existing behaviour, with no new rejection and therefore no new pressure to
 * edit the report to satisfy the harness.
 */
function reviewSeverityViolations(text, status) {
  if (status !== "pass") return { violations: [], followUps: [] };
  const stated = statedFindingSeverities(text);
  const blocking = stated.filter(entry => entry.severity !== "MINOR");
  if (blocking.length) {
    return {
      violations: [
        `Review report states ${blocking.length} ${blocking.length === 1 ? "finding" : "findings"} at ${[...new Set(blocking.map(entry => entry.severity))].join("/")} `
        + `("${blocking[0].text.slice(0, 120)}"), which contradicts recording a pass. `
        + `Fix them and re-review, or record the honest verdict with --status fail. `
        + `Only findings the report itself labels MINOR may be carried as follow-up items.`,
      ],
      followUps: [],
    };
  }
  return { violations: [], followUps: stated };
}

/**
 * The follow-up items this run is carrying, derived from the live review records
 * rather than stored again beside them (item 10: one record, no ledger that can
 * drift). They are superseded along with their round automatically, because they
 * live on the record the round replaced.
 */
function openReviewFollowUps(state) {
  const out = [];
  for (const [kind, review] of [["fidelity", state.requirementsFidelityReview], ["final", state.finalReview]]) {
    for (const item of (review && review.followUps) || []) {
      out.push({ kind, severity: item.severity, text: item.text });
    }
  }
  return out;
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

// Every stale-review violation ends in the two commands that clear it. The
// pair is the fix, not the diagnosis: an agent told only "the review is stale"
// has to guess whether to re-run the reviewer or just re-record the same file.
const RERUN_FINAL_REVIEW = `re-run the reviewer (\`${harnessCommand()} review-prompt\`) and re-record it (\`${harnessCommand()} review-record --status pass|fail --report <path> --summary "<verdict>"\`)`;
const RERUN_FIDELITY_REVIEW = `re-run the reviewer (\`${harnessCommand()} requirements-review-prompt\`) and re-record it (\`${harnessCommand()} requirements-review-record --status pass|fail --report <path> --summary "<verdict>"\`)`;

// Collect every staleness cause rather than returning on the first: a
// rejection that names one of two reasons is a second round-trip by
// construction (see the finalize probing incident in commands/review.js).
function finalReviewFreshnessViolations(state) {
  const review = state.finalReview;
  if (!review || !review.recordedAt || review.status !== "pass") return [];
  const reviewedAt = Date.parse(review.recordedAt);
  if (!Number.isFinite(reviewedAt)) return [`Final review recordedAt is invalid; ${RERUN_FINAL_REVIEW}`];
  const violations = [];
  // The final review's first job is auditing the requirements fidelity review, so
  // it goes stale when the record it audited changes - and only then.
  //
  // This used to be a pure clock comparison: fidelity recorded later than final
  // meant final was stale, without looking at content or tree. The tree is
  // already checked separately (reviewWorktreeSnapshotViolations still pins the
  // final review's source fingerprint), so the only case the clock uniquely
  // caught was fidelity being RE-RECORDED on the same tree - and when that
  // re-record reaches the same conclusion from the same report, nothing final
  // audited moved. Measured 2026-08-11 on project modakbul: ten fidelity
  // recordings, one survivor, and every one of the nine was a condition that
  // could kill a final review for no change at all.
  //
  // Same shape as the gate pinning its inputs and (after the fidelity review's
  // own input pin) one level up: record what you audited, compare that. A record
  // written before the pin existed cannot say what it audited, so it earns one
  // honest re-record rather than being trusted - the reading every other
  // unverifiable pin in this harness gets.
  const audited = review.auditedFidelity;
  const fidelity = state.requirementsFidelityReview;
  if (!audited || typeof audited !== "object") {
    violations.push(`Final review does not record which requirements fidelity verdict it audited, so its freshness cannot be checked; ${RERUN_FINAL_REVIEW}`);
  } else if (!fidelity) {
    violations.push(`Final review audited a requirements fidelity review that is no longer recorded; ${RERUN_FINAL_REVIEW}`);
  } else {
    const changed = [];
    if (fidelity.status !== audited.status) changed.push(`its verdict is now ${fidelity.status} (was ${audited.status})`);
    if ((fidelity.reportSha256 || null) !== (audited.reportSha256 || null)) changed.push("its report changed");
    if (changed.length) {
      violations.push(`Final review is stale: the requirements fidelity review it audited is not the one on record - ${changed.join(" and ")}; ${RERUN_FINAL_REVIEW}`);
    }
  }
  const latest = latestEvidenceTimestamp(state);
  if (latest && latest.time > reviewedAt) {
    violations.push(`Final review is stale: ${latest.label} was recorded after final review; ${RERUN_FINAL_REVIEW}`);
  }
  return violations;
}

function requirementsFidelityReviewFreshnessViolations(state) {
  const review = state.requirementsFidelityReview;
  if (!review || !review.recordedAt || !["pass", "fail"].includes(review.status)) return [];
  const reviewedAt = Date.parse(review.recordedAt);
  if (!Number.isFinite(reviewedAt)) return [`Requirements fidelity review recordedAt is invalid; ${RERUN_FIDELITY_REVIEW}`];
  const latest = latestEvidenceTimestamp(state);
  if (latest && latest.time > reviewedAt) {
    return [`Requirements fidelity review is stale: ${latest.label} was recorded after requirements fidelity review; ${RERUN_FIDELITY_REVIEW}`];
  }
  return [];
}

/**
 * What the requirements fidelity review actually reads, pinned by content hash
 * the same way the verify gate pins its inputs (hashGateInput, the one canonical
 * hash - never a reimplementation).
 *
 * The division of labour this restores was already written down:
 * reviews-and-finalization.md says the gate owns the per-criterion code-vs-AC
 * judgment from the diff while the fidelity review owns intent lineage, decision
 * provenance, deviations, and whether the REGISTERED EVIDENCE proves the intent -
 * and that the two never consume each other's results. The freshness rule did not
 * know that: it pinned the fidelity review to the whole source tree, so every bug
 * fix invalidated a review whose subject had not moved. Measured 2026-08-11 on
 * project modakbul, a run recorded ten fidelity reviews where one survived.
 *
 * So the pin covers the documents and artifacts on that axis: the PRD, the
 * interview log(s) the intent trace was built from, and every registered evidence
 * artifact. Source files are deliberately NOT in the list - they are the verify
 * gate's subject, and that gate pins the exact diff it judged.
 *
 * This narrows what can invalidate a fidelity review; it does not remove a
 * check. The change under judgment is still pinned, by the gate. The known hole
 * is unchanged and worth naming: a fix that quietly adds scope the PRD never
 * described is caught only if the agent records the deviation (a deviation moves
 * `latestEvidenceTimestamp`, which re-stales the review) or the gate's
 * unscoped-file warning is read. An agent that neither records nor is asked slips
 * through - that was already true before this change, and closing it needs a
 * different instrument than a tree fingerprint that fired on everything.
 *
 * Thinnest-watched combination in the system, stated here so the next person does
 * not have to re-derive it: a run whose verify gate NEVER RAN, on a profile that
 * does not require the final adversarial review. Nothing then pins that run's
 * source tree at finalize - the gate's judged-diff pin does not exist, the final
 * review's tree pin does not exist, and this review is on the intent axis. That
 * is honest rather than a regression (such a run has no code judgment at all, and
 * its receipt says so with a NOT_RUN gate; what was removed is a trigger that hid
 * the absence by making a reviewer who never reads code re-read it). But it is
 * the combination to reach for first if this ever needs another instrument, and
 * the instrument belongs on the gate or on delivery, not back on this review.
 */
function fidelityReviewInputs(state) {
  const projectRoot = state.projectRoot || cwd();
  const inputs = [];
  const seen = new Set();
  const pin = (rel, kind) => {
    if (!rel || seen.has(rel)) return;
    seen.add(rel);
    const sha256 = hashGateInput(path.join(projectRoot, rel), kind);
    inputs.push({ path: rel, kind, sha256 });
  };
  pin(state.prdPath, "prd");
  for (const source of (state.intentTrace && state.intentTrace.sources) || []) {
    if (source && typeof source.path === "string") pin(source.path, "intent-source");
  }
  for (const entry of collectArtifacts(state)) {
    if (entry.artifact && typeof entry.artifact.path === "string") pin(entry.artifact.path, "evidence");
  }
  return inputs;
}

/**
 * How many paths a delta scope names before it summarizes the rest. The list is
 * for a reader, not a checksum: the count is always exact (`changedTotal`), and
 * the prompt says how many it left out so a truncated list can never read as a
 * complete one.
 */
const REVIEW_DELTA_PATH_LIMIT = 20;

function reviewDeltaLabels(before, after) {
  const labels = [];
  let unchanged = 0;
  for (const [rel, signature] of after) {
    if (!before.has(rel)) labels.push(`+${rel}`);
    else if (before.get(rel) !== signature) labels.push(`~${rel}`);
    else unchanged += 1;
  }
  for (const rel of before.keys()) if (!after.has(rel)) labels.push(`-${rel}`);
  // Sorted, not insertion-ordered: rendering the same scope twice has to produce
  // the same prompt, and the input sets come from a Map and a git status walk.
  labels.sort();
  return { labels, unchanged };
}

// Everything snapshotEntriesEqual compares except the path, which is the key.
function snapshotEntrySignature(entry) {
  return JSON.stringify([
    entry.status || "",
    entry.sha256 || null,
    entry.bytes ?? null,
    entry.kind ?? null,
    entry.executable ?? null,
    entry.symlinkTarget ?? null,
  ]);
}

/**
 * What a review round is entitled to look at: the whole contract (round 1, or
 * any round whose narrowing cannot be proven), or only what moved since the
 * previous round on the same axis.
 *
 * PRINCIPLES item 13 names a delta contract as one of the three admissible
 * bounds on a loop that cannot converge, and this is it. The reason it belongs
 * in code rather than in the reviewer's instructions is item 7: the harness
 * WRITES these prompts, so "look only at the delta" as prose is a request the
 * reviewer may ignore, while handing it a prompt that contains only the delta is
 * a bound. The verify gate already works this way (`priorFindingsFor`, the delta
 * re-judgment contract); reviews were the stage still re-deriving from scratch
 * every round (item 12: import the idea, not the machinery).
 *
 * Two rules keep the narrowing honest, and they matter more than the saving:
 *
 * - A delta exists only when the harness can prove one. No baseline, no pin on
 *   the baseline, or a comparison the harness cannot compute means the round is
 *   FULL and the prompt says which of those it was. Silently narrowing is the
 *   dangerous failure here, so every fallback carries its reason outward.
 * - The narrowing is the harness's default, never a ceiling. The prompt tells the
 *   reviewer what it is not being shown and how to widen; a reviewer that widens
 *   and says so in its report is behaving correctly.
 *
 * The axes narrow against their own pins, the same ones their freshness rules
 * use - a delta measured against anything else would let a review pass over a
 * change its own staleness rule would catch:
 *
 * - fidelity: the pinned input set (PRD, intent sources, registered evidence).
 *   Content-hashed, so this is exact and survives a commit.
 * - final: the dirty-tree snapshot it recorded, which names paths - but only
 *   while HEAD has not moved. A commit empties the dirty set without reverting
 *   anything, so a moved HEAD means the path list would be a fiction and the
 *   round drops to full. The vouched fingerprint stays the freshness authority;
 *   the snapshot only names paths for the prompt.
 *
 * @param {State} state
 * @param {"fidelity"|"final"} axis
 */
function reviewRoundScope(state, axis) {
  const field = axis === "fidelity" ? "requirementsFidelityReview" : "finalReview";
  const superseded = Array.isArray(state.supersededReviews) ? state.supersededReviews : [];
  const priorRounds = superseded.filter(entry => entry && entry.kind === axis).length;
  const baseline = state[field];
  const round = priorRounds + (baseline ? 1 : 0) + 1;
  const full = reason => ({ kind: "full", axis, round, ...(reason ? { reason } : {}) });

  // `stale` belongs here as much as pass and fail do - it is the COMMON baseline.
  // A review goes stale exactly when something it vouched for moved, which is the
  // usual reason a second round exists at all, and the record keeps its report,
  // its pins, and the reason it went stale. Excluding it would have left the
  // delta contract unreachable on the one path that needs it most.
  if (!baseline || !["pass", "fail", "stale"].includes(baseline.status)) {
    return full(round === 1 ? null : "no previous round on this axis is on record to compare against");
  }
  const baselineSummary = {
    status: baseline.status,
    reportPath: baseline.reportPath || null,
    reportSha256: baseline.reportSha256 || null,
    recordedAt: baseline.recordedAt || null,
    ...(baseline.staleReason ? { staleReason: baseline.staleReason } : {}),
  };

  let delta;
  let extra = {};
  if (axis === "fidelity") {
    if (!Array.isArray(baseline.inputs) || baseline.inputs.length === 0) {
      return full("the previous round pinned no inputs, so what changed since it cannot be proven");
    }
    const before = new Map(baseline.inputs
      .filter(input => input && typeof input.path === "string")
      .map(input => [input.path, input.sha256 || null]));
    const after = new Map(fidelityReviewInputs(state).map(input => [input.path, input.sha256 || null]));
    delta = reviewDeltaLabels(before, after);
  } else {
    const recorded = baseline.worktreeSnapshot;
    if (!recorded || !Array.isArray(recorded.entries)) {
      return full("the previous round recorded no source snapshot, so what changed since it cannot be proven");
    }
    const current = worktreeSnapshot(state);
    if (!current) return full("the project is not a git checkout, so the source delta cannot be enumerated");
    if ((recorded.headSha || null) !== (current.headSha || null)) {
      return full("HEAD moved since the previous round, so the dirty-tree comparison cannot enumerate what changed");
    }
    const before = new Map(recorded.entries.map(entry => [entry.path, snapshotEntrySignature(entry)]));
    const after = new Map(current.entries.map(entry => [entry.path, snapshotEntrySignature(entry)]));
    delta = reviewDeltaLabels(before, after);
    const audited = baseline.auditedFidelity;
    const fidelity = state.requirementsFidelityReview;
    extra = {
      auditedFidelityMoved: audited && typeof audited === "object" && fidelity
        ? fidelity.status !== audited.status || (fidelity.reportSha256 || null) !== (audited.reportSha256 || null)
        : null,
    };
  }

  // Deviations recorded since the baseline, on both axes: a deviation is the one
  // intent-axis change no content pin can see (see fidelityReviewInputs' named
  // hole - a fix that adds unrecorded scope is caught only through the deviation
  // it records), so a delta that dropped them would narrow past its own guard.
  // `null` means the baseline carries no timestamp to compare against, and the
  // prompt then puts every deviation back in scope rather than guessing.
  const deviations = Array.isArray(state.deviations) ? state.deviations : [];
  const newDeviations = baselineSummary.recordedAt === null
    ? null
    : deviations
      .filter(entry => entry && typeof entry.ts === "string" && entry.ts > baselineSummary.recordedAt)
      .map(entry => `${entry.id} ${entry.type}: ${entry.summary}`);

  return {
    kind: "delta",
    axis,
    round,
    baseline: baselineSummary,
    changed: delta.labels.slice(0, REVIEW_DELTA_PATH_LIMIT),
    changedTotal: delta.labels.length,
    unchanged: delta.unchanged,
    newDeviations,
    ...extra,
  };
}

/**
 * Re-hash a fidelity review's pinned inputs and report the ones that moved.
 *
 * A review recorded before the pin existed has no `inputs` and cannot be checked
 * this way; it is not treated as stale here, because the time-based rule
 * (`requirementsFidelityReviewFreshnessViolations`) still covers new evidence and
 * new deviations for those records. An input the harness cannot read now (deleted
 * artifact) is drift, not an excuse.
 */
function requirementsFidelityReviewInputViolations(state) {
  const review = state.requirementsFidelityReview;
  if (!review || !["pass", "fail"].includes(review.status)) return [];
  if (!Array.isArray(review.inputs) || review.inputs.length === 0) return [];
  const projectRoot = state.projectRoot || cwd();
  const drifted = [];
  for (const input of review.inputs) {
    if (!input || typeof input.path !== "string") continue;
    const current = hashGateInput(path.join(projectRoot, input.path), input.kind);
    if (current === null) drifted.push(`${input.path} is missing`);
    else if (current !== input.sha256) drifted.push(`${input.path} changed`);
  }
  if (!drifted.length) return [];
  return [`Requirements fidelity review is stale: ${drifted.join(", ")} after the review; ${RERUN_FIDELITY_REVIEW}`];
}

/**
 * Review freshness against the tree: a recorded pass/fail review vouches for
 * the vouched fingerprint pinned at record time (review-record stamps
 * `vouchedTreeFingerprint` next to the audit-only worktreeSnapshot). The
 * fingerprint is commit-invariant and blind to harness bookkeeping, so a
 * benign `git commit`, a verify re-run, or another run's state writes no
 * longer stale a review - only source or spec-doc changes do. Reviews
 * recorded before this contract (worktreeSnapshot only, no vouched field)
 * cannot prove freshness and read as stale; records with neither field are
 * non-git-era records with nothing pinned, which were never checked.
 */
function reviewWorktreeSnapshotViolations(state, options = {}) {
  const includeFinalReview = options.includeFinalReview !== false;
  const violations = [];
  let current = null;
  let currentComputed = false;
  const check = (review, label, rerunHint) => {
    if (!review || !["pass", "fail"].includes(review.status)) return;
    if (!review.worktreeSnapshot && !review.vouchedTreeFingerprint) return;
    if (!currentComputed) {
      current = vouchedTreeFingerprintForState(state);
      currentComputed = true;
    }
    if (!current) return; // not a git checkout: no tree signal to compare
    if (!vouchedFingerprintsMatch(review.vouchedTreeFingerprint, current)) {
      violations.push(`${label} is stale: worktree source snapshot changed after review; ${rerunHint}`);
    }
  };
  // The fidelity review is deliberately absent: its subject is the intent axis,
  // pinned by fidelityReviewInputs. The final adversarial review stays, because
  // reading the code IS its mandate.
  if (includeFinalReview) check(state.finalReview, "Final review", RERUN_FINAL_REVIEW);
  return violations;
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
//
// The snapshot carries attempts/budget/budgetExhausted/findings so a blocked
// receipt can say WHY it is blocked without a second record: gates.json stays
// the source, the receipt stamps what it said at finalize time. The budget is
// the real configured one (judgeRetryBudget), never 0 - passing 0 made
// budgetExhausted true for every blocked gate and therefore meaningless.
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
  const budget = judgeRetryBudget(projectRoot);
  const record = (gatesState.gates && gatesState.gates.verify) || {};
  try {
    const store = require("../dist/gates/store.js");
    const view = store.gateStatus(gatesState, "verify", budget, projectRoot);
    return {
      effective: view.effective,
      verdict: view.verdict,
      overridden: view.overridden,
      staleInputs: view.staleInputs,
      lastRunAt: record.lastRunAt || null,
      attempts: view.attempts,
      budget: view.budget,
      budgetExhausted: view.budgetExhausted,
      // Third terminal cause, carried through so the receipt can name it: the
      // judge backend never returned a verdict `budget` times running. It is
      // NOT budgetExhausted - attempts stays the honest 0/N - so every consumer
      // needs the flag itself, not a derivation from the numbers.
      consecutiveErrors: view.consecutiveErrors,
      judgeErrorLoop: view.judgeErrorLoop,
      rerunRefused: verifyRerunRefused(projectRoot, state.topicSlug),
      // The base the refused verdict was judged against, so the terminal cause
      // can name the corrected---base move instead of implying nothing is left
      // to try (see verifyGateTerminalCause).
      diffSource: record.diffSource || null,
      findings: view.findings,
    };
  } catch {
    // CLI dist not built: fall back to the recorded verdict without freshness.
    return verifyGateFallbackStatus(record, budget);
  }
}

// Second terminal cause beside a spent budget: the gate's own rerun
// short-circuit would refuse an identical `sasu verify` at $0, so the
// remaining attempts are unspendable and the budget can never reach
// exhaustion (reproduced 2026-08-11 on quick: semantic FAIL at attempts 1/3,
// identical rerun refused, the Stop hook still demanding "fix and re-run" -
// a livelock whose only exit was a user override the agent cannot perform).
//
// The predicate itself is NOT reimplemented here: cli/src/gates/commands.ts
// owns the arming conditions the short-circuit uses, and this is the one call
// into it (PRINCIPLES item 3 - the freshness deadlock came from three copies
// of one rule). No dist means no predicate: false, so only budgetExhausted
// ends the loop, which is the conservative reading (a wrongly-closed exit
// costs a user override; a wrongly-opened one lets a run give up early).
//
// Cost: armedRerunRefusal exits on the cheap record fields first and only a
// FAIL/BLOCK record with consistent semantic stamps reaches the input hashes
// and the tree fingerprint. Measured 2026-08-11 on this repo (142 vouched
// entries): ~50ms for the fingerprint, so at most ~100ms per status/Stop turn
// while a FAIL stands - the same cost the Stop guard already pays on the PASS
// path, and $0 on every other verdict.
function verifyRerunRefused(projectRoot, topicSlug) {
  if (!topicSlug) return false;
  try {
    const gateCommands = require("../dist/gates/commands.js");
    return gateCommands.verifyRerunWouldBeRefused(projectRoot, topicSlug) === true;
  } catch {
    return false;
  }
}

// No-dist twin of gateStatus in cli/src/gates/store.ts, minus freshness (no
// dist means no fingerprint code to call): same verdict/attempt arithmetic,
// including budgetExhausted = !passed && attempts >= budget && verdict != null.
// Kept as its own pure function so tests/gate_status_parity.test.mjs can
// drive both derivations over identical fixtures - a comment was the only
// thing pinning the twins together before, and this predicate now decides
// when the blocked-receipt exit opens (verifyGateTerminallyBlocked).
function verifyGateFallbackStatus(record, budget) {
  const passed = record.verdict === "PASS" || record.overridden === true;
  const attempts = Number.isInteger(record.attempts) ? record.attempts : 0;
  const consecutiveErrors = Number.isInteger(record.consecutiveErrors) ? record.consecutiveErrors : 0;
  return {
    effective: passed ? "PASS" : record.verdict == null ? "NOT_RUN" : "BLOCKED",
    verdict: record.verdict || null,
    overridden: record.overridden === true,
    lastRunAt: record.lastRunAt || null,
    attempts,
    budget,
    budgetExhausted: !passed && attempts >= budget && record.verdict != null,
    // Derived here too, unlike rerunRefused: a judge-error streak is pure
    // arithmetic over fields the record already carries, so the no-dist branch
    // can read it exactly as gateStatus does. Leaving it out would strand a run
    // whose only terminal cause is a broken judge backend - the one situation
    // where the dist build being unloadable is least surprising.
    consecutiveErrors,
    judgeErrorLoop: !passed && record.verdict === "ERROR" && consecutiveErrors > 0 && consecutiveErrors >= budget,
    // Deliberately not derived here: "would an identical rerun be refused"
    // needs the tree fingerprint and the input pins, i.e. exactly the dist
    // code this branch exists because it cannot load. Only budgetExhausted
    // ends the loop without dist (see verifyRerunRefused).
    rerunRefused: false,
    findings: Array.isArray(record.findings) ? record.findings : [],
    freshnessUnverified: true,
  };
}

// THE terminal predicate. Terminal means the gate ran, failed, and the
// autonomous fix loop has no move left that could change the verdict:
//
//   BLOCKED and (budget exhausted OR an identical rerun would be refused
//                OR the judge never returned a verdict `budget` times running)
//
// The retry budget means "N chances to fix and re-verify", not "N identical
// retries". When the rerun short-circuit is armed on the current state, every
// remaining attempt is unspendable by construction - `sasu verify` exits with
// the refusal at $0 without recording an attempt - so attempts can never grow
// to the budget and a budget-only predicate is unreachable. That was the
// livelock (reproduced 2026-08-11 on quick, FAIL at attempts 1/3): complete
// refused, blocked refused, rerun refused, override the only exit.
//
// finalize --status blocked accepts the gate itself as the blocker on exactly
// this predicate, the review-record commands stop letting the gate veto an
// honest review on exactly this predicate, and the Stop hooks stop demanding a
// re-run on exactly this predicate - the exits of the deadlock must never
// disagree about when the gate stops arguing (see the circular-rejection
// incident in the review-record commands). `rerunRefused` never fabricates
// budgetExhausted: the receipt keeps reporting attempts 1/N honestly and names
// the refusal as the separate cause (PRINCIPLES item 10).
//
// `judgeErrorLoop` is the third disjunct and the only one where the gate never
// answered the question at all: the judge backend failed `budget` times running,
// so there are no findings to fix and attempts is honestly 0/N. Without it the
// run has state but no exit - a broken backend cannot be fixed from inside the
// fix loop, and charging its failures to the fix budget was the false BLOCKED
// this pair of changes exists to stop (measured 2026-08-11, modakbul: 4 of 10
// verify attempts lost to judge-invalid-output, 0 criterion FAILs).
function verifyGateTerminallyBlocked(gate) {
  return gate.effective === "BLOCKED"
    && (gate.budgetExhausted === true || gate.rerunRefused === true || gate.judgeErrorLoop === true);
}

// Why the gate is terminal, in the words the agent must act on. Kept next to
// the predicate so the two can never name different causes.
//
// "Terminal" means an IDENTICAL re-run is refused - never that no move remains.
// The cause therefore names the base the verdict was judged against: a FAIL
// earned at the wrong --base (a WIP commit, a moved branch ref) is one
// corrected re-run away from PASSing, and telling the agent to close out
// blocked instead would be the cheap unearned exit (reproduced 2026-08-11:
// `--base HEAD` hid a committed half of the work, the judge FAILed, and the
// terminal predicate reported the loop over while `--base <start>` PASSed).
function verifyGateTerminalCause(gate) {
  const base = typeof gate.diffSource === "string" && gate.diffSource.startsWith("git:")
    ? `, judged against base ${gate.diffSource.slice(4, 16)}`
    : "";
  if (gate.budgetExhausted === true) return `its ${gate.budget}-attempt retry budget is exhausted${base}`;
  // Named apart from a spent budget because the two mean opposite things to the
  // agent (PRINCIPLES item 10): a spent budget says the findings were real and
  // could not be closed, this says there were never any findings. No base is
  // cited - an ERROR run has no judged diff to cite one from (recordGateResult
  // clears diffSource on that path) - and the fix budget is reported untouched.
  if (gate.judgeErrorLoop === true) {
    return `the judge backend failed ${gate.consecutiveErrors} times in a row without returning a verdict, so no criterion was ever judged `
      + `(the fix budget is untouched at attempts ${gate.attempts}/${gate.budget} because there were never any findings to fix). `
      + `This is a backend failure, not a verification failure: fixing the judge configuration re-arms verification`;
  }
  return `an identical re-run is refused on this unchanged tree (attempts ${gate.attempts}/${gate.budget}${base}; the remaining budget is unspendable). `
    + `Changing the code under judgment re-arms verification; so does pointing --base at the commit the work actually started from, if the verdict was judged against the wrong one`;
}

function verifyGateViolations(state, options = {}) {
  const gate = verifyGateStatus(state);
  if (gate.effective === "BLOCKED") {
    // Recording an honest review is a prerequisite of the blocked receipt,
    // not a completion claim: once the gate is terminal the callers that opt
    // in (the review-record commands) are heading to `finalize --status
    // blocked`, which itself demands the recorded review - so the gate must
    // not veto the record. With budget remaining the veto stands: attempts
    // are left to spend, fix and re-verify first.
    if (options.allowTerminallyBlockedVerifyGate === true && verifyGateTerminallyBlocked(gate)) {
      return [];
    }
    // Once the gate is terminal, "fix and re-run" is a dead instruction; point
    // at the real exits so the deadlock names its own escape (finalize refuses
    // --status complete either way). A refused rerun differs from a spent
    // budget in one way that matters to the agent: the code CAN still change,
    // and a tree change is what re-arms verification - so name that move
    // first, because it is the only one that could still reach a PASS.
    if (!verifyGateTerminallyBlocked(gate)) {
      return [`Verify gate is BLOCKED (verdict ${gate.verdict}); fix the cited findings and re-run \`sasu verify\`, or have the user record an override`];
    }
    // The three terminal causes differ in exactly one way that matters here:
    // which move, if any, could still reach a PASS. A spent budget has none. A
    // refused rerun has a tree change. A judge-error loop has a judge that can
    // be repaired - so name that, or the agent reads "terminal" as "give up" on
    // a run whose acceptance criteria were never actually judged.
    const exits = "finalize honestly with --status blocked (the receipt stamps the gate snapshot), or have the user record an override";
    const preamble = `Verify gate is BLOCKED (verdict ${gate.verdict}) and ${verifyGateTerminalCause(gate)}`;
    if (gate.budgetExhausted === true) return [`${preamble}; completion is impossible - ${exits}`];
    if (gate.judgeErrorLoop === true) {
      return [`${preamble}; repair the judge (see the recovery line from the last \`sasu verify\`) and re-run to get a real verdict, or ${exits}`];
    }
    return [`${preamble}; re-running \`sasu verify\` unchanged exits with the refusal, so change the code under judgment (a tree change re-arms verification) or ${exits}`];
  }
  if (gate.effective === "STALE") {
    return ["Verify gate PASS is stale: its input documents changed after the passing run; re-run `sasu verify` against the current diff"];
  }
  return [];
}

// Every completion blocker names the command that clears it, at the point
// that produces it. The alternative - a mapper that pattern-matches finished
// violation text back to a remedy - keys on phrasing and silently loses the
// remedy the moment a message is reworded (PRINCIPLES item 11). Producing the
// pair together also carries the remedy to every consumer for free: the Stop
// hook and the goal guard read the same strings (hooks.js).
function completionViolations(statePath, state, options = {}) {
  const includeFinalReview = options.includeFinalReview !== false;
  const includeRequirementsFidelityReview = options.includeRequirementsFidelityReview !== false;
  const H = harnessCommand();
  const violations = [];
  violations.push(...prdSnapshotViolations(statePath, state));
  // PRD §4 is the prerequisite the run was supposed to settle before touching
  // code: an item nobody disposed of is a setup step (a created channel, a set
  // environment variable) that may simply not exist. The Stop hook already
  // refuses the first task mark while any item is `pending`, but a hook only
  // guards turns that end - the receipt is the record, so the refusal has to
  // live here too or a finalize reached another way stamps "done" over an
  // unasked question (2026-08-11, modakbul: three human-only §4.1 items went
  // undisposed and the missing Slack channel and Vercel variable surfaced four
  // hours later). `human` and `agent` are dispositions, not completions: the
  // agent owning an item is an answer, so only `pending` blocks.
  const pending = pendingPreWork(state);
  if (pending.length) {
    violations.push(`${pending.length} PRD §4 pre-work item(s) are still undisposed (${pending.map(item => item.id).join(", ")}); batch-ask the user about the human ones, then record each with \`${H} mark --kind prework --id <ID> --status <human|agent|resolved> --evidence "<what settles it>"\``);
  }
  violations.push(...verifyGateViolations(state, {
    allowTerminallyBlockedVerifyGate: options.allowTerminallyBlockedVerifyGate === true,
  }));
  const verificationPlan = verificationPlanSummary(state);
  if (verificationPlan.status === "missing") {
    violations.push(`Verification plan is missing; run \`${H} plan-verification\``);
  } else if (verificationPlan.blockingGapCount > 0) {
    const action = verificationPlan.contractBlockingGapCount > 0
      ? `fix the PRD semantic verification contract, then re-run \`${H} reconcile\``
      : `bind each implementation verifier with \`${H} verify-run --id <Vn> [--cwd <dir>] -- <command...>\``;
    violations.push(`Verification plan has ${verificationPlan.blockingGapCount} blocking gap(s); read them in \`${H} status\`, then ${action}`);
  }
  const executionPlan = executionPlanSummary(state);
  if (executionPlan.status === "missing") {
    violations.push(`Execution plan is missing; run \`${H} plan-execution\``);
  } else if (executionPlan.blockingGapCount > 0) {
    violations.push(`Execution plan has ${executionPlan.blockingGapCount} blocking gap(s); read them in \`${H} status\`, fix the PRD tasks or dependencies, run \`${H} reconcile\`, then \`${H} plan-execution\``);
  }
  for (const task of state.tasks) {
    if (task.status !== "complete") violations.push(`Task ${task.id} is ${task.status}; finish it, then \`${H} mark --kind task --id ${task.id} --status complete --evidence "<what proves it>"\``);
    if (!task.evidence.length) violations.push(`Task ${task.id} has no evidence; re-run \`${H} mark --kind task --id ${task.id} --status ${task.status} --evidence "<what proves it>"\``);
  }
  const coveragePlan = state.verificationPlan;
  const checksById = coveragePlan && Array.isArray(coveragePlan.checks)
    ? new Map(coveragePlan.checks.map(check => [check.id, check]))
    : new Map();
  const verificationById = new Map((state.verification || []).map(item => [item.id, item]));
  for (const ac of state.acceptanceCriteria) {
    if (ac.status !== "met") {
      violations.push(`Acceptance ${ac.id} is ${ac.status}; satisfy it, then \`${H} mark --kind ac --id ${ac.id} --status met --evidence "<what proves it>"\``);
    }
    if (!ac.evidence.length) violations.push(`Acceptance ${ac.id} has no evidence; re-run \`${H} mark --kind ac --id ${ac.id} --status ${ac.status} --evidence "<what proves it>"\``);
    // Mechanical backstop for the skill's promise that every AC is provably
    // closed: prose evidence alone cannot complete an AC whose entire
    // verification coverage was skipped or blocked.
    if (ac.status === "met" && coveragePlan && coveragePlan.coverage && coveragePlan.coverage[ac.id]) {
      const coveredBy = coveragePlan.coverage[ac.id].coveredBy || [];
      const anyCoveringPass = coveredBy.some(checkId => {
        const check = checksById.get(checkId);
        const verification = check ? verificationById.get(check.verificationId) : null;
        return Boolean(verification && verification.status === "pass");
      });
      const coveringVerificationIds = Array.from(new Set(coveredBy
        .map(checkId => (checksById.get(checkId) || {}).verificationId)
        .filter(Boolean)));
      if (!anyCoveringPass) {
        violations.push(`Acceptance ${ac.id} is met but none of its covering verification items passed; pass one of ${coveringVerificationIds.length ? coveringVerificationIds.join(", ") : coveredBy.join(", ") || "its covering checks"} with \`${H} verify-run --id <Vn> -- <command>\`, or mark ${ac.id} not_met`);
      }
    }
  }
    for (const verification of state.verification) {
      if (isVerificationRequiredForDone(verification)) {
        if (verification.status !== "pass") violations.push(`Required verification ${verification.id} is ${verification.status}; make it pass with \`${H} verify-run --id ${verification.id} -- <command>\` (non-command proof: \`${H} record-artifact --id ${verification.id} ...\` then \`${H} mark --kind verification --id ${verification.id} --status pass --evidence "<what proves it>"\`)`);
      } else if (!["pass", "skipped", "blocked"].includes(verification.status)) {
        violations.push(`Optional verification ${verification.id} is ${verification.status}; run \`${H} verify-run --id ${verification.id} -- <command>\`, or dispose of it with \`${H} mark --kind verification --id ${verification.id} --status skipped --evidence "<why it is not needed>"\``);
      }
      if (!verification.evidence.length) violations.push(`Verification ${verification.id} has no evidence; run \`${H} verify-run --id ${verification.id} -- <command>\`, or \`${H} mark --kind verification --id ${verification.id} --status ${verification.status} --evidence "<what proves it>"\``);
      if (verification.status === "pass" && (!verification.artifacts || verification.artifacts.length === 0)) {
        violations.push(`Verification ${verification.id} has no artifact-backed evidence; register one with \`${H} record-artifact --id ${verification.id} --kind screenshot|log|browser|api|db|file --path <path> --description "<what it proves>"\``);
      }
  }
  violations.push(...validateArtifacts(statePath, state, {
    includeRequirementsFidelityReview,
    includeFinalReview,
  }));
  if (includeRequirementsFidelityReview) {
    if (!state.requirementsFidelityReview || state.requirementsFidelityReview.status !== "pass") {
      violations.push(`Requirements fidelity review has not passed (currently ${(state.requirementsFidelityReview && state.requirementsFidelityReview.status) || "not recorded"}); ${RERUN_FIDELITY_REVIEW}`);
    } else if (!state.requirementsFidelityReview.reportPath) {
      violations.push(`Requirements fidelity review has no report path; re-record it with \`${H} requirements-review-record --status pass --report <path> --summary "<verdict>"\``);
    }
  }
  if (includeFinalReview && finalReviewRequiredForState(state)) {
    if (!state.finalReview || state.finalReview.status !== "pass") {
      violations.push(`Final adversarial review has not passed (currently ${(state.finalReview && state.finalReview.status) || "not recorded"}); ${RERUN_FINAL_REVIEW}`);
    } else if (!state.finalReview.reportPath) {
      violations.push(`Final adversarial review has no report path; re-record it with \`${H} review-record --status pass --report <path> --summary "<verdict>"\``);
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
  if (!review) return [`Requirements fidelity review must be recorded before blocked/partial finalization (a recorded fail is acceptable); ${RERUN_FIDELITY_REVIEW}`];
  const violations = [];
  const rerecord = `re-record it with \`${harnessCommand()} requirements-review-record --status pass|fail --report <path> --summary "<verdict>"\``;
  if (!["pass", "fail"].includes(review.status)) {
    violations.push(`Requirements fidelity review status must be pass or fail before blocked/partial finalization; got ${review.status || "unknown"}; ${rerecord}`);
  }
  if (!review.reportPath) violations.push(`Requirements fidelity review has no report path; ${rerecord}`);
  if (!review.summary) violations.push(`Requirements fidelity review has no summary; ${rerecord}`);
  if (!review.recordedAt) violations.push(`Requirements fidelity review has no recordedAt timestamp; ${rerecord}`);
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
  violations.push(...requirementsFidelityReviewInputViolations(state));
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
    return [`Final adversarial review must be recorded before blocked/partial finalization on a high-risk profile (a recorded fail is acceptable); run \`review-prompt\` then \`review-record\`: ${RERUN_FINAL_REVIEW}`];
  }
  const violations = [];
  const rerecord = `re-record it with \`${harnessCommand()} review-record --status pass|fail --report <path> --summary "<verdict>"\``;
  if (!["pass", "fail"].includes(review.status)) {
    violations.push(`Final adversarial review status must be pass or fail before blocked/partial finalization; got ${review.status || "unknown"}; run \`review-prompt\` then \`review-record\``);
  }
  if (!review.reportPath) violations.push(`Final adversarial review has no report path; ${rerecord}`);
  if (!review.summary) violations.push(`Final adversarial review has no summary; ${rerecord}`);
  if (!review.recordedAt) violations.push(`Final adversarial review has no recordedAt timestamp; ${rerecord}`);
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
  statedReviewVerdicts,
  assertReviewReportVerdict,
  assertFinalReviewReport,
  assertRequirementsFidelityReport,
  meaningfulReviewSection,
  reviewBulletCount,
  statedFindingSeverities,
  openReviewFollowUps,
  reviewSeverityViolations,
  REVIEW_SEVERITIES,
  reviewEntryCount,
  finalReviewFreshnessViolations,
  requirementsFidelityReviewFreshnessViolations,
  requirementsFidelityReviewInputViolations,
  fidelityReviewInputs,
  reviewRoundScope,
  REVIEW_DELTA_PATH_LIMIT,
  reviewWorktreeSnapshotViolations,
  completionReadiness,
  completionViolations,
  verifyGateStatus,
  verifyGateFallbackStatus,
  verifyRerunRefused,
  verifyGateTerminallyBlocked,
  verifyGateTerminalCause,
  verifyGateViolations,
  prdSnapshotViolations,
  requirementsFidelityHandoffViolations,
  finalReviewHandoffViolations,
  assertAllowedStatus,
  prdCopyDriftWarnings,
};
