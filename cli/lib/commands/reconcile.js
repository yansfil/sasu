"use strict";

const fs = require("fs");
const path = require("path");

const { nowIso, cwd, resolveProjectPath, toProjectRelative, appendJsonl, sha256Text } = require("../util");
const { recordDeviation, markCompletionReviewsStale, countState } = require("../state_data");
const { stripFrontmatter } = require("../prd_parser");
const { buildVerificationPlan, buildExecutionPlan, verificationContractHash, rollupTasksFromExecutionPlan, nextBrief } = require("../planning");
const { loadState, syncActive, persistStateAndArtifacts } = require("../state_store");
const { parsePrdContract } = require("./init");

// A verification item is part of the PRD contract unless the rules engine
// injected it; injected items survive reconcile untouched.
function isRulesInjectedVerification(item) {
  return Boolean(item && (item.source === "rules_injection" || item.sourceRuleId));
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

// The identity of an item across a PRD edit is its ID; the fingerprint decides
// whether recorded progress is still talking about the same obligation.
function itemFingerprint(kind, item) {
  if (kind === "verification") {
    return JSON.stringify({
      text: normalizeText(item.text),
      level: item.level || null,
      matrix: item.matrix || null,
    });
  }
  return normalizeText(item.text);
}

function reconcileList(kind, existingList, incomingList, changes) {
  const existingById = new Map(existingList.map(item => [String(item.id).toUpperCase(), item]));
  const incomingIds = new Set();
  const merged = [];
  for (const incoming of incomingList) {
    const id = String(incoming.id).toUpperCase();
    incomingIds.add(id);
    const prior = existingById.get(id);
    if (!prior) {
      changes.added.push({ kind, id: incoming.id });
      merged.push(incoming);
      continue;
    }
    if (itemFingerprint(kind, prior) === itemFingerprint(kind, incoming)) {
      changes.unchanged += 1;
      merged.push(prior);
      continue;
    }
    changes.changed.push({ kind, id: incoming.id, previousStatus: prior.status });
    merged.push({
      ...incoming,
      status: "pending",
      evidence: [
        ...(prior.evidence || []),
        {
          ts: nowIso(),
          text: `PRD reconcile: definition changed; status reset from '${prior.status}' to 'pending'. Previous text: ${normalizeText(prior.text)}`,
        },
      ],
      artifacts: prior.artifacts || [],
    });
  }
  for (const prior of existingList) {
    if (!incomingIds.has(String(prior.id).toUpperCase())) {
      changes.removed.push({ kind, id: prior.id, item: prior });
    }
  }
  return merged;
}

// Reconcile the run with an edited PRD without destroying recorded progress.
// Items are matched by ID: unchanged definitions keep status, evidence, and
// artifacts; changed definitions reset to pending with an audit note; removed
// items are archived in the ledger. This replaces init --force for PRD-edit
// recovery, which wipes every mark and forces a full re-marking pass.
function cmdReconcile(options) {
  const { statePath, state } = loadState(options);
  const projectRoot = state.projectRoot || cwd();
  const prdAbs = resolveProjectPath(state.prdPath, projectRoot);
  if (!fs.existsSync(prdAbs)) throw new Error(`PRD not found: ${prdAbs}`);
  const prdText = fs.readFileSync(prdAbs, "utf8");
  const newSha = sha256Text(prdText);
  const previousSha = state.prdSnapshot ? state.prdSnapshot.sha256 : null;
  if (previousSha === newSha) {
    process.stdout.write(JSON.stringify({
      ok: true,
      changed: false,
      message: "PRD snapshot already matches the PRD file; nothing to reconcile.",
      prdSha256: newSha,
    }, null, 2) + "\n");
    return;
  }

  const parsed = stripFrontmatter(prdText);
  const contract = parsePrdContract(parsed, projectRoot);
  const changes = { added: [], changed: [], removed: [], unchanged: 0 };

  state.tasks = reconcileList("task", state.tasks || [], contract.tasks, changes);
  state.acceptanceCriteria = reconcileList("ac", state.acceptanceCriteria || [], contract.acceptanceCriteria, changes);
  state.requirements = reconcileList("requirement", state.requirements || [], contract.requirements, changes);
  const injectedVerification = (state.verification || []).filter(isRulesInjectedVerification);
  const prdVerification = reconcileList(
    "verification",
    (state.verification || []).filter(item => !isRulesInjectedVerification(item)),
    contract.verification,
    changes,
  );
  state.verification = [...prdVerification, ...injectedVerification];
  state.testModeContract = contract.testModeContract;
  state.intentTrace = contract.intentTrace;
  state.technicalStructure = contract.technicalStructure;
  state.implementationNotes = contract.implementationNotes;
  state.prdStatus = parsed.frontmatter.status || state.prdStatus || null;
  state.prdSnapshot = {
    path: toProjectRelative(prdAbs, projectRoot),
    sha256: newSha,
    taskIds: contract.tasks.map(item => item.id),
    acceptanceCriteriaIds: contract.acceptanceCriteria.map(item => item.id),
    requirementIds: contract.requirements.map(item => item.id),
    verificationIds: contract.verification.map(item => item.id),
    testModeIds: contract.testModeContract.map(item => item.id),
    decisionTraceHash: contract.intentTrace.prdDecisionTraceHash,
    verificationContractHash: verificationContractHash({
      verification: contract.verification,
      testModeContract: contract.testModeContract,
    }),
  };

  const changedTaskIds = new Set(changes.changed.filter(entry => entry.kind === "task").map(entry => String(entry.id).toUpperCase()));
  state.verificationPlan = buildVerificationPlan(state, statePath);
  if (state.executionPlan) {
    const priorNodesByTask = new Map((state.executionPlan.nodes || []).map(node => [node.sourceTask, node]));
    state.executionPlan = buildExecutionPlan(state, statePath);
    for (const node of state.executionPlan.nodes || []) {
      const prior = priorNodesByTask.get(node.sourceTask);
      if (!prior) continue;
      node.status = changedTaskIds.has(String(node.sourceTask).toUpperCase()) ? "pending" : prior.status;
      node.owner = prior.owner || null;
      node.evidence = Array.isArray(prior.evidence) ? prior.evidence : [];
      node.artifacts = Array.isArray(prior.artifacts) ? prior.artifacts : [];
      node.dependsOn = Array.isArray(prior.dependsOn) ? prior.dependsOn : node.dependsOn;
      node.writeScope = Array.isArray(prior.writeScope) ? prior.writeScope : node.writeScope;
      node.parallelSafe = prior.parallelSafe === true;
      node.risk = prior.risk || node.risk;
    }
  }
  rollupTasksFromExecutionPlan(state);

  const materialChange = changes.added.length > 0 || changes.changed.length > 0 || changes.removed.length > 0;
  const reason = String(options.reason || "").trim() ||
    (materialChange
      ? "PRD edited during the run; state reconciled without resetting recorded progress"
      : "PRD text edited without contract-item changes; snapshot refreshed");
  const deviation = recordDeviation(state, "prd_reconciled", "PRD", reason, {
    previousSha256: previousSha,
    sha256: newSha,
    added: changes.added.map(entry => `${entry.kind}:${entry.id}`),
    changed: changes.changed.map(entry => `${entry.kind}:${entry.id}`),
    removed: changes.removed.map(entry => `${entry.kind}:${entry.id}`),
  });
  if (materialChange) {
    markCompletionReviewsStale(state, "PRD contract items changed during reconcile");
  }
  state.updatedAt = nowIso();
  persistStateAndArtifacts(statePath, state);
  appendJsonl(path.join(path.dirname(statePath), "ledger.jsonl"), {
    ts: nowIso(),
    event: "prd_reconciled",
    previousSha256: previousSha,
    sha256: newSha,
    added: changes.added.map(entry => `${entry.kind}:${entry.id}`),
    changed: changes.changed.map(entry => `${entry.kind}:${entry.id}`),
    unchanged: changes.unchanged,
    // Removed items are archived here in full so their evidence trail survives
    // even though they leave state.json.
    removed: changes.removed,
    deviationId: deviation.id,
  });
  syncActive(statePath, state);

  process.stdout.write(JSON.stringify({
    ok: true,
    changed: true,
    added: changes.added.map(entry => `${entry.kind}:${entry.id}`),
    changedItems: changes.changed.map(entry => `${entry.kind}:${entry.id}`),
    removed: changes.removed.map(entry => `${entry.kind}:${entry.id}`),
    unchanged: changes.unchanged,
    reviewsMarkedStale: materialChange,
    deviationId: deviation.id,
    counts: countState(state),
    next: nextBrief(state),
  }, null, 2) + "\n");
}

module.exports = {
  cmdReconcile,
  reconcileList,
  itemFingerprint,
};
