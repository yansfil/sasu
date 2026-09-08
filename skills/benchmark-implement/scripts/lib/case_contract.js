"use strict";

const path = require("node:path");
const CASE_SCHEMA = "sasu.benchmark-case.v4";
const LAST_SUPPORTED_COMMIT = "488d3cc7d6e99742e7f68a1680fcb101710c8e20";
const TERMINAL_STATUSES = new Set(["complete", "complete-pending-human", "blocked"]);
const STAGES = new Set(["start", "verification", "mechanical", "review", "risk", "finalize"]);

function assertSchema(value, expected, label) {
  if (value?.schema !== expected) {
    throw new Error(`${label} received schema ${value?.schema ?? "missing"}; expected ${expected}; last supported commit ${LAST_SUPPORTED_COMMIT}. Start a new run with the current contract.`);
  }
}

function validateStringArray(value, field, { nonempty = false } = {}) {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim())) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
  if (nonempty && value.length === 0) throw new Error(`${field} must not be empty`);
  return [...new Set(value)];
}

function validateRelativePath(value, field) {
  if (typeof value !== "string" || !value.trim() || path.isAbsolute(value)) {
    throw new Error(`${field} must be a non-empty relative path`);
  }
  const normalized = path.normalize(value.trim());
  if (normalized === "." || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`${field} must stay inside the project`);
  }
  if (normalized.split(path.sep).includes(".git")) {
    throw new Error(`${field} must not target .git`);
  }
  return normalized;
}

function validateCase(contract) {
  assertSchema(contract, CASE_SCHEMA, "case");
  if (typeof contract.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(contract.id)) {
    throw new Error("case.id must use lowercase letters, digits, and hyphens");
  }
  if (typeof contract.prd !== "string" || !contract.prd.trim()) throw new Error("case.prd is required");
  if (!contract.environment || typeof contract.environment !== "object") {
    throw new Error("case.environment is required");
  }
  if (contract.environment.mode !== "fresh-worktree") {
    throw new Error("environment.mode must be fresh-worktree");
  }
  if (typeof contract.environment.baseRef !== "string" || !contract.environment.baseRef.trim()) {
    throw new Error("environment.baseRef is required");
  }
  const mustBeAbsent = validateStringArray(
    contract.environment.mustBeAbsent,
    "environment.mustBeAbsent",
    { nonempty: true },
  );
  mustBeAbsent.forEach((value, index) => validateRelativePath(value, `environment.mustBeAbsent[${index}]`));
  if (!contract.expected || typeof contract.expected !== "object") throw new Error("case.expected is required");
  const terminalStatuses = validateStringArray(
    contract.expected.terminalStatuses,
    "expected.terminalStatuses",
    { nonempty: true },
  );
  const requiredStages = validateStringArray(contract.expected.requiredStages || [], "expected.requiredStages");
  const forbiddenStages = validateStringArray(contract.expected.forbiddenStages || [], "expected.forbiddenStages");
  for (const status of terminalStatuses) {
    if (!TERMINAL_STATUSES.has(status)) throw new Error(`unknown expected terminal status: ${status}`);
  }
  for (const stage of [...requiredStages, ...forbiddenStages]) {
    if (!STAGES.has(stage)) throw new Error(`unknown expected stage: ${stage}`);
  }
  if (contract.expected.maxVerifyAttempts !== undefined
      && (!Number.isInteger(contract.expected.maxVerifyAttempts) || contract.expected.maxVerifyAttempts < 0)) {
    throw new Error("expected.maxVerifyAttempts must be a non-negative integer");
  }
  if (contract.expected.falseCompleteAllowed !== false) {
    throw new Error("expected.falseCompleteAllowed must be false");
  }
  if (!contract.evaluation || typeof contract.evaluation !== "object") {
    throw new Error("evaluation is required");
  }
  if (contract.evaluation.required !== true) {
    throw new Error("evaluation.required must be true");
  }
  if (!["complete", "partial", "unavailable"].includes(contract.evaluation.requiredCoverage)) {
    throw new Error("evaluation.requiredCoverage must be complete, partial, or unavailable");
  }
  for (const field of ["claudeCode", "codex"]) {
    if (typeof contract.evaluation.models?.[field] !== "string" || !contract.evaluation.models[field].trim()) {
      throw new Error(`evaluation.models.${field} is required`);
    }
  }
  return contract;
}


module.exports = { CASE_SCHEMA, STAGES, assertSchema, validateCase };
