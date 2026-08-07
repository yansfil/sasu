"use strict";

const fs = require("fs");
const path = require("path");

const { PROJECT_CONFIG_PATH, resolveProjectPath, canonicalPath, readJson, stringArray, commandArray, safeBranchSegment } = require("./util");
const { currentBranch } = require("./git");

function readProjectConfig(projectRoot) {
  const configPath = path.join(projectRoot, PROJECT_CONFIG_PATH);
  if (!fs.existsSync(configPath)) return {};
  const parsed = readJson(configPath);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${PROJECT_CONFIG_PATH} must contain a JSON object`);
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
    ci: {
      watch: deliveryInput.ci && typeof deliveryInput.ci === "object" && deliveryInput.ci.watch !== undefined
        ? Boolean(deliveryInput.ci.watch)
        : mode === "pr",
      maxFixAttempts: Number.isFinite(Number(deliveryInput.ci && deliveryInput.ci.maxFixAttempts))
        ? Number(deliveryInput.ci.maxFixAttempts)
        : 2,
      // Ship reads these from state.delivery.ci; dropping them here silently
      // pinned every pipeline to the built-in 240s/15s watch defaults.
      ...(Number.isFinite(Number(deliveryInput.ci && deliveryInput.ci.timeoutSeconds))
        ? { timeoutSeconds: Number(deliveryInput.ci.timeoutSeconds) }
        : {}),
      ...(Number.isFinite(Number(deliveryInput.ci && deliveryInput.ci.intervalSeconds))
        ? { intervalSeconds: Number(deliveryInput.ci.intervalSeconds) }
        : {}),
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

function reviewProfileResult(profile, source, reason, signals = []) {
  return {
    profile,
    source,
    reason,
    signals,
  };
}

function classifyReviewProfile(input, explicitProfile, configProfile) {
  const candidates = [];
  const rank = { trivial: 0, standard: 1, "high-risk": 2 };
  const explicit = String(explicitProfile || "").trim().toLowerCase();
  if (explicit) {
    if (!["trivial", "standard", "high-risk"].includes(explicit)) {
      throw new Error("--review-profile must be trivial, standard, or high-risk");
    }
    candidates.push(reviewProfileResult(explicit, "explicit", "set as a safety floor by --review-profile"));
  }
  const configured = String(configProfile || "").trim().toLowerCase();
  if (configured && configured !== "auto") {
    if (!["trivial", "standard", "high-risk"].includes(configured)) {
      throw new Error("config review.profile must be trivial, standard, high-risk, or auto");
    }
    candidates.push(reviewProfileResult(configured, "config", `set as a safety floor by ${PROJECT_CONFIG_PATH} review.profile`));
  }
  const declared = String(input && input.reviewProfile || "").trim().toLowerCase();
  if (declared) {
    if (!["trivial", "standard", "high-risk"].includes(declared)) {
      throw new Error("PRD frontmatter review_profile must be trivial, standard, or high-risk");
    }
    const rationale = String(input && input.reviewRationale || "").trim();
    if (!rationale) {
      throw new Error("PRD frontmatter review_rationale is required when review_profile is declared");
    }
    candidates.push(reviewProfileResult(declared, "prd", rationale, [`PRD semantic assessment: ${rationale}`]));
  }
  if (candidates.length) {
    const sourcePriority = { explicit: 2, config: 1, prd: 0 };
    candidates.sort((left, right) => rank[right.profile] - rank[left.profile]
      || sourcePriority[right.source] - sourcePriority[left.source]);
    const selected = candidates[0];
    if (candidates.length > 1) {
      selected.reason = `${selected.reason}; effective profile is the strongest declared safety floor`;
      selected.signals = Array.from(new Set([
        ...candidates.flatMap(candidate => candidate.signals || []),
        `Review profile floors: ${candidates.map(candidate => `${candidate.source}=${candidate.profile}`).join(", ")}`,
      ]));
    }
    return selected;
  }
  return reviewProfileResult(
    "standard",
    "default",
    "no semantic review profile was declared; standard is the safe fallback",
  );
}

module.exports = {
  readProjectConfig,
  normalizeDeliveryConfig,
  normalizeExecutionConfig,
  classifyReviewProfile,
};
