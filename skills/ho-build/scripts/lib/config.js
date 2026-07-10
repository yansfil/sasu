"use strict";

const fs = require("fs");
const path = require("path");

const { PROJECT_CONFIG_PATH, LEGACY_PROJECT_CONFIG_PATH, resolveReadRel, resolveProjectPath, canonicalPath, readJson, stringArray, commandArray, safeBranchSegment } = require("./util");
const { currentBranch } = require("./git");

function readProjectConfig(projectRoot) {
  const configRel = resolveReadRel(projectRoot, PROJECT_CONFIG_PATH, LEGACY_PROJECT_CONFIG_PATH);
  const configPath = path.join(projectRoot, configRel);
  if (!fs.existsSync(configPath)) return {};
  const parsed = readJson(configPath);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${configRel} must contain a JSON object`);
  }
  return parsed;
}

function normalizeDeliveryConfig(projectRoot, options, projectConfig, slug) {
  const deliveryInput = projectConfig && typeof projectConfig.delivery === "object" && projectConfig.delivery
    ? projectConfig.delivery
    : {};
  const worktreeInput = projectConfig && typeof projectConfig.worktree === "object" && projectConfig.worktree
    ? projectConfig.worktree
    : {};
  const mode = String(options.delivery || deliveryInput.mode || deliveryInput.default || "local").trim().toLowerCase();
  if (!["local", "pr"].includes(mode)) throw new Error(`Unsupported delivery mode '${mode}'. Expected local or pr.`);
  const branchPrefix = String(deliveryInput.branchPrefix || "prd").replace(/\/+$/g, "") || "prd";
  const branch = String(options.branch || deliveryInput.branch || `${branchPrefix}/${slug}`).trim();
  const stagingInput = deliveryInput.staging && typeof deliveryInput.staging === "object"
    ? deliveryInput.staging
    : {};
  const repoName = path.basename(canonicalPath(projectRoot));
  const worktreeRoot = worktreeInput.root
    ? resolveProjectPath(String(worktreeInput.root), projectRoot)
    : path.resolve(projectRoot, "..", `${repoName}.worktrees`);
  const worktreePath = worktreeInput.path
    ? resolveProjectPath(String(worktreeInput.path), projectRoot)
    : path.join(worktreeRoot, safeBranchSegment(branch));
  return {
    schema: "hoyeon.delivery.v1",
    mode,
    branch,
    baseBranch: String(deliveryInput.baseBranch || currentBranch(projectRoot) || "main"),
    prTemplate: deliveryInput.prTemplate ? String(deliveryInput.prTemplate) : null,
    ci: {
      watch: deliveryInput.ci && typeof deliveryInput.ci === "object" && deliveryInput.ci.watch !== undefined
        ? Boolean(deliveryInput.ci.watch)
        : mode === "pr",
      maxFixAttempts: Number.isFinite(Number(deliveryInput.ci && deliveryInput.ci.maxFixAttempts))
        ? Number(deliveryInput.ci.maxFixAttempts)
        : 2,
    },
    staging: {
      include: stringArray(stagingInput.include),
      exclude: stringArray(stagingInput.exclude),
    },
    worktree: {
      enabled: Boolean(worktreeInput.enabled),
      path: worktreePath,
      root: worktreeRoot,
      link: stringArray(worktreeInput.link),
      copy: stringArray(worktreeInput.copy),
      setup: commandArray(worktreeInput.setup),
    },
    configPath: fs.existsSync(path.join(projectRoot, PROJECT_CONFIG_PATH)) ? PROJECT_CONFIG_PATH : null,
  };
}

// Execution behavior is sequential/atomic by default. Parallel ready-group
// suggestions are opt-in through `agents/config.json` `execution.parallel` (or
// `--parallel` at init), so a simple run never carries parallel scaffolding and
// a user who wants it turns it on via prd-setup.
function normalizeExecutionConfig(projectConfig, options) {
  const input = projectConfig && typeof projectConfig.execution === "object" && projectConfig.execution
    ? projectConfig.execution
    : {};
  const flag = options ? options.parallel : undefined;
  const parallel = flag !== undefined
    ? flag === true || String(flag).toLowerCase() === "true"
    : Boolean(input.parallel);
  return { schema: "hoyeon.execution.v1", parallel };
}

function classifyReviewProfile(input, explicitProfile, configProfile) {
  const explicit = String(explicitProfile || "").trim();
  if (explicit) {
    if (!["trivial", "standard", "high-risk"].includes(explicit)) {
      throw new Error("--review-profile must be trivial, standard, or high-risk");
    }
    return { profile: explicit, source: "explicit", reason: "set by --review-profile" };
  }
  const configured = String(configProfile || "").trim().toLowerCase();
  if (configured && configured !== "auto") {
    if (!["trivial", "standard", "high-risk"].includes(configured)) {
      throw new Error("config review.profile must be trivial, standard, high-risk, or auto");
    }
    return { profile: configured, source: "config", reason: `set by ${PROJECT_CONFIG_PATH} review.profile` };
  }
  const tasks = input.tasks || [];
  const acceptanceCriteria = input.acceptanceCriteria || [];
  const verification = input.verification || [];
  const haystack = [
    input.technicalStructure,
    input.implementationNotes,
    ...tasks.map(item => item.text || item.title || ""),
    ...acceptanceCriteria.map(item => item.text || item.title || ""),
    ...verification.map(item => item.text || item.passIntent || item.title || ""),
  ].join("\n").toLowerCase();
  if (/\b(db|database|migration|schema|auth|security|payment|billing|credential|secret|production|external|live api|provider|pii|token|deploy|rollback)\b/.test(haystack)) {
    return { profile: "high-risk", source: "auto", reason: "risk keywords found in PRD structure, tasks, ACs, or verification" };
  }
  if (tasks.length <= 2 && acceptanceCriteria.length <= 5 && verification.length <= 3) {
    return { profile: "trivial", source: "auto", reason: "small PRD surface with at most 2 tasks, 5 ACs, and 3 verification items" };
  }
  return { profile: "standard", source: "auto", reason: "default profile for non-trivial work without high-risk signals" };
}

module.exports = {
  readProjectConfig,
  normalizeDeliveryConfig,
  normalizeExecutionConfig,
  classifyReviewProfile,
};
