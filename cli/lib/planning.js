"use strict";

/** @typedef {import("./types").State} State */

const path = require("path");

const { SELF_PATH, nowIso, cwd, toProjectRelative, sha256Text, formatCommandArgs } = require("./util");
const { invariantsForWriteScopes } = require("./rules");
const { isVerificationRequiredForDone, verificationIsClosedForAccounting, verificationPlanSummary, verificationPlanBlocksImplementation, executionPlanSummary, executionPlanBlocksImplementation, finalReviewRequiredForState, independentFidelityRequiredForState } = require("./state_data");
const { inferVerificationMode, coverageFromText } = require("./prd_parser");
const { repoSignals, classifyVerification, commandForMode, artifactsForVerification, passCriteriaFromText, toolForVerification, targetForVerification, plannedCheckStatus, plannerNotes, hasAppStartupSignal } = require("./inference");

function commandFromMatrixMethod(method) {
  const value = String(method || "").trim();
  const codeSpan = value.match(/^`([^`]+)`$/);
  return codeSpan ? codeSpan[1].trim() : value;
}

function verificationContractHash(state) {
  return sha256Text(JSON.stringify({
    verification: (state.verification || []).map(item => ({
      id: item.id,
      level: item.level,
      text: item.text,
      source: item.source,
      matrix: item.matrix || null,
    })),
    testModeContract: state.testModeContract || [],
  }));
}

/**
 * @param {State} state
 * @param {string} statePath
 * @returns {import("./types").VerificationPlan}
 */
function buildVerificationPlan(state, statePath) {
  const projectRoot = state.projectRoot || cwd();
  const signals = repoSignals(projectRoot);
  const priorChecks = new Map((((state.verificationPlan && state.verificationPlan.checks) || []))
    .map(check => [String(check.verificationId).toUpperCase(), check]));
  const checks = state.verification.map((verification, index) => {
    const mode = inferVerificationMode(verification, state.testModeContract || []);
    const category = classifyVerification(verification, mode);
    const contractHash = sha256Text(JSON.stringify({
      id: verification.id,
      text: verification.text,
      matrix: verification.matrix || null,
    }));
    const prior = priorChecks.get(String(verification.id).toUpperCase());
    const preserved = prior && prior.contractHash === contractHash ? prior : null;
    const injectedCommand = verification.source === "rules_injection" && verification.matrix && verification.matrix.method
      ? commandFromMatrixMethod(verification.matrix.method)
      : null;
    const inferredCommand = commandForMode(mode, category, signals);
    const command = category === "command" || category === "automated"
      ? injectedCommand || (preserved && preserved.command) || inferredCommand
      : null;
    const commandCwd = command
      ? injectedCommand
        ? "."
        : preserved && preserved.command === command
          ? preserved.cwd || "."
          : signals.packageRoot || "."
      : null;
    const covers = coverageFromText([
      verification.matrix && verification.matrix.covers,
      verification.text,
    ].filter(Boolean).join(" "));
    const artifacts = artifactsForVerification(verification, category, mode);
    const passCriteria = verification.matrix && verification.matrix.passCriteria
      ? verification.matrix.passCriteria
      : passCriteriaFromText(verification.text, category);
    return {
      id: `VP${index + 1}`,
      verificationId: verification.id,
      level: verification.level,
      source: verification.source || "verification_item",
      category,
      tool: toolForVerification(category, signals),
      command,
      cwd: commandCwd,
      bindingSource: command
        ? injectedCommand
          ? "rules"
          : preserved && preserved.command === command
            ? preserved.bindingSource || "verify-run"
            : "repository"
        : null,
      target: targetForVerification(category, signals),
      covers,
      artifactKinds: artifacts,
      passCriteria,
      requiredForDone: isVerificationRequiredForDone(verification),
      canBeBlocked: verification.matrix ? Boolean(verification.matrix.canBeBlocked) : false,
      testMode: mode ? mode.mode : null,
      testModeContract: mode || null,
      contract: verification.matrix || null,
      contractHash,
      status: plannedCheckStatus({ verification, category, command, covers, artifacts, mode }),
      notes: plannerNotes({ verification, category, command, covers, signals, mode }),
    };
  });
  const coverage = buildCoverageMatrix(state, checks);
  const gaps = buildVerificationGaps(state, checks, coverage, signals);
  const contractBlocking = gaps.some(gap => gap.severity === "blocking" && gap.phase !== "binding");
  const bindingBlocking = gaps.some(gap => gap.severity === "blocking" && gap.phase === "binding");
  return {
    schema: "hoyeon.prd-implement.verification-plan.v1",
    status: contractBlocking ? "needs_review" : bindingBlocking ? "needs_binding" : "ready",
    generatedAt: nowIso(),
    prdPath: state.prdPath,
    prdSha256: state.prdSnapshot ? state.prdSnapshot.sha256 : null,
    verificationContractHash: verificationContractHash(state),
    statePath: toProjectRelative(statePath, projectRoot),
    environment: {
      packageManager: signals.packageManager,
      packageScripts: signals.packageScripts,
      browserTool: "chromux",
      serverStrategy: signals.dockerComposeFiles.length
        ? `docker-compose available: ${signals.dockerComposeFiles.join(", ")}`
        : signals.packageScripts.includes("dev")
          ? `${signals.packageManager || "npm"} dev`
          : "no dev server script detected",
      serviceStrategy: signals.dockerComposeFiles.length ? "prefer docker-compose for service dependencies" : "use repo-local dev/test commands; ask if services are required",
      dbStrategy: signals.hasSupabase ? "local/sandbox Supabase or non-production DB with query-log artifact" : "no DB surface detected",
    },
    checks,
    coverage,
    gaps,
  };
}

// Applies the optional agent-authored task plan onto `state.tasks` and returns
// the plan metadata. Executor fields live on the task itself; the plan document
// carries only status, provenance, and gaps.
/**
 * @param {State} state
 * @param {string} statePath
 * @returns {import("./types").ExecutionPlan}
 */
function buildExecutionPlan(state, statePath, taskPlan = null) {
  const gaps = [];
  const taskPlanProvided = taskPlan !== null;
  const taskIds = new Set((state.tasks || []).map(task => String(task.id).toUpperCase()));

  for (const task of state.tasks || []) {
    const declared = taskPlanProvided && Object.prototype.hasOwnProperty.call(taskPlan, String(task.id).toUpperCase())
      ? normalizeTaskPlanEntry(task.id, taskPlan[String(task.id).toUpperCase()], state, taskIds)
      : null;
    if (declared) {
      task.dependsOn = declared.dependsOn;
      task.writeScope = declared.writeScope;
      task.parallelSafe = declared.parallelSafe;
      task.risk = declared.risk;
    } else if (taskPlanProvided) {
      // An explicit plan that omits a task means "keep it conservatively
      // sequential", not "keep whatever an earlier plan declared".
      task.dependsOn = [];
      task.writeScope = [];
      task.parallelSafe = false;
      task.risk = "medium";
    } else {
      task.dependsOn = Array.isArray(task.dependsOn) ? task.dependsOn : [];
      task.writeScope = normalizeWriteScopes(task.writeScope || [], state.projectRoot);
      task.parallelSafe = task.parallelSafe === true;
      task.risk = task.risk || "medium";
    }
    if (task.owner === undefined) task.owner = null;
    if (!task.status) task.status = "pending";
    if (!Array.isArray(task.evidence)) task.evidence = [];
    if (!Array.isArray(task.artifacts)) task.artifacts = [];

    if ((task.requirements || []).length === 0) {
      gaps.push({
        severity: "warning",
        code: "task_without_requirement",
        item: task.id,
        message: "Task has no explicit requirement mapping",
      });
    }
    if (executionCoverageForTask(state, task).acceptanceCriteria.length === 0) {
      gaps.push({
        severity: "warning",
        code: "task_without_acceptance_mapping",
        item: task.id,
        message: "Task has no acceptance-criterion mapping",
      });
    }
  }

  const unscopedParallelTasks = (state.tasks || [])
    .filter(task => state.execution && state.execution.parallel && task.writeScope.length === 0)
    .map(task => task.id);
  if (unscopedParallelTasks.length) {
    gaps.push({
      severity: "warning",
      code: "missing_write_scope",
      item: unscopedParallelTasks.join(","),
      message: `Parallel execution is enabled, but ${unscopedParallelTasks.join(", ")} have no agent-declared write scope and remain sequential`,
    });
  }

  if ((state.tasks || []).length === 0) {
    gaps.push({
      severity: "blocking",
      code: "no_prd_tasks",
      item: "Tasks",
      message: "PRD section 8 (PRD-Level Tasks) produced no implementation tasks",
    });
  }

  const dependencyCycle = findDependencyCycle(state.tasks || []);
  if (dependencyCycle.length) {
    gaps.push({
      severity: "blocking",
      code: "execution_dependency_cycle",
      item: "execution-plan",
      message: `Execution task plan contains a dependency cycle: ${dependencyCycle.join(" -> ")}`,
    });
  }

  return {
    schema: "hoyeon.prd-implement.execution-plan.v2",
    status: gaps.some(gap => gap.severity === "blocking") ? "needs_review" : "ready",
    generatedAt: nowIso(),
    prdPath: state.prdPath,
    statePath: toProjectRelative(statePath, state.projectRoot || cwd()),
    // A rebuild without an explicit plan preserves each task's executor fields,
    // so the provenance flag must survive the rebuild too.
    taskPlanApplied: taskPlanProvided || Boolean(state.executionPlan && state.executionPlan.taskPlanApplied),
    gaps,
  };
}

// Derived on demand for the rendered execution plan; never stored, so it can
// never disagree with the tasks it summarizes.
function buildTraceMatrix(state) {
  const verificationById = new Map((state.verification || []).map(item => [item.id, item]));
  return (state.tasks || []).map(task => {
    const covers = executionCoverageForTask(state, task);
    const requiredVerification = covers.verification.filter(id => {
      const item = verificationById.get(id);
      return item ? isVerificationRequiredForDone(item) : true;
    });
    return {
      taskId: task.id,
      status: task.status,
      requirements: covers.requirements,
      acceptanceCriteria: covers.acceptanceCriteria,
      verification: covers.verification,
      requiredVerification,
      optionalVerification: covers.verification.filter(id => !requiredVerification.includes(id)),
    };
  });
}

function executionCoverageForTask(state, task) {
  const requirements = Array.from(new Set(task.requirements || []));
  const acceptanceCriteria = Array.from(new Set([
    ...(task.acceptanceCriteria || []),
    ...(state.acceptanceCriteria || [])
      .filter(ac => (ac.requirements || []).some(id => requirements.includes(id)))
      .map(ac => ac.id),
  ]));
  const verification = [];
  for (const item of state.verification || []) {
    const check = ((state.verificationPlan && state.verificationPlan.checks) || [])
      .find(candidate => candidate.verificationId === item.id);
    const covers = check ? check.covers : coverageFromText(item.text || "");
    const matchesTask = (covers.tasks || []).includes(task.id);
    const matchesAc = (covers.acceptanceCriteria || []).some(id => acceptanceCriteria.includes(id));
    const matchesRequirement = (covers.requirements || []).some(id => requirements.includes(id));
    if (matchesTask || matchesAc || matchesRequirement) verification.push(item.id);
  }
  return {
    requirements,
    acceptanceCriteria,
    verification: Array.from(new Set(verification)),
  };
}

function normalizeTaskPlanEntry(taskId, entry, state, taskIds) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`Task plan ${taskId} must be an object`);
  }
  const risk = String(entry.risk || "medium").trim().toLowerCase();
  if (!["low", "medium", "high"].includes(risk)) {
    throw new Error(`Task plan ${taskId}.risk must be low, medium, or high`);
  }
  const writeScope = normalizeWriteScopes(entry.writeScope || [], state.projectRoot);
  const parallelSafe = entry.parallelSafe === true;
  if (parallelSafe && writeScope.length === 0) {
    throw new Error(`Task plan ${taskId} cannot be parallelSafe without a writeScope`);
  }
  if (parallelSafe && risk === "high") {
    throw new Error(`Task plan ${taskId} cannot be parallelSafe with high risk`);
  }
  if (entry.dependsOn !== undefined && !Array.isArray(entry.dependsOn)) {
    throw new Error(`Task plan ${taskId}.dependsOn must be an array`);
  }
  const dependsOn = [];
  for (const raw of entry.dependsOn || []) {
    const dependency = String(raw || "").trim().toUpperCase();
    if (!taskIds.has(dependency)) {
      throw new Error(`Task plan ${taskId} has unknown dependency '${raw}'`);
    }
    if (dependency === String(taskId).toUpperCase()) {
      throw new Error(`Task plan ${taskId} cannot depend on itself`);
    }
    if (!dependsOn.includes(dependency)) dependsOn.push(dependency);
  }
  return { writeScope, parallelSafe, risk, dependsOn };
}

function normalizeWriteScopes(scopes, projectRoot) {
  if (!Array.isArray(scopes)) throw new Error("writeScope must be an array of repository-relative paths");
  const root = path.resolve(projectRoot || cwd());
  const normalized = [];
  for (const raw of scopes) {
    const value = String(raw || "").trim();
    if (!value) continue;
    if (path.isAbsolute(value)) {
      throw new Error(`writeScope '${value}' must be repository-relative`);
    }
    if (/[*?[\]]/.test(value)) {
      throw new Error(`writeScope '${value}' must name a concrete file or directory, not a glob`);
    }
    const absolute = path.resolve(root, value);
    const relative = path.relative(root, absolute);
    if (!relative || relative === ".") {
      if (!normalized.includes(".")) normalized.push(".");
      continue;
    }
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
      throw new Error(`writeScope '${value}' escapes the project root`);
    }
    const repoRelative = relative.split(path.sep).join("/");
    if (!normalized.includes(repoRelative)) normalized.push(repoRelative);
  }
  return normalized;
}

function findDependencyCycle(items) {
  const byId = new Map(items.map(item => [String(item.id).toUpperCase(), item]));
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  const visit = id => {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }
    if (visited.has(id)) return [];
    visiting.add(id);
    stack.push(id);
    const item = byId.get(id);
    for (const dependency of item && item.dependsOn || []) {
      const cycle = visit(String(dependency).toUpperCase());
      if (cycle.length) return cycle;
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return [];
  };
  for (const item of items) {
    const cycle = visit(String(item.id).toUpperCase());
    if (cycle.length) return cycle;
  }
  return [];
}

function readyExecutionPlan(state) {
  const plan = state.executionPlan;
  const planSummary = executionPlanSummary(state);
  if (!plan) {
    return {
      readySequential: [],
      readyParallelGroups: [],
      parallelEnabled: Boolean(state.execution && state.execution.parallel),
      blocked: [{ id: "EP0", waitingFor: verificationPlanBlocksImplementation(state) ? ["VP0"] : ["plan-execution"] }],
      plan: planSummary,
    };
  }
  const tasksById = new Map((state.tasks || []).map(task => [String(task.id).toUpperCase(), task]));
  const blocked = [];
  const ready = [];
  for (const task of state.tasks || []) {
    if (!["pending", "in_progress"].includes(task.status)) continue;
    const waitingFor = [];
    if (verificationPlanBlocksImplementation(state)) waitingFor.push("VP0");
    if (plan.status !== "ready" || planSummary.blockingGapCount > 0) waitingFor.push("EP0");
    for (const depId of task.dependsOn || []) {
      const dep = tasksById.get(String(depId).toUpperCase());
      if (!dep || dep.status !== "complete") waitingFor.push(depId);
    }
    if (waitingFor.length) blocked.push({ id: task.id, waitingFor: Array.from(new Set(waitingFor)) });
    else ready.push(task);
  }
  const parallelEnabled = Boolean(state.execution && state.execution.parallel);
  return {
    readySequential: ready.map(task => task.id),
    readyParallelGroups: parallelEnabled ? buildParallelGroups(ready) : [],
    parallelEnabled,
    blocked,
    plan: planSummary,
  };
}

function buildParallelGroups(readyTasks) {
  const candidates = readyTasks.filter(task => {
    if (!task.parallelSafe) return false;
    if (!["low", "medium"].includes(task.risk)) return false;
    return Array.isArray(task.writeScope) && task.writeScope.length > 0;
  });
  const groups = [];
  let remaining = [...candidates];
  while (remaining.length) {
    const group = [remaining.shift()];
    remaining = remaining.filter(candidate => {
      const compatible = group.every(member => !writeScopesOverlap(member.writeScope, candidate.writeScope));
      if (compatible) group.push(candidate);
      return !compatible;
    });
    if (group.length > 1) groups.push(group.map(task => task.id));
  }
  return groups;
}

function writeScopesOverlap(left = [], right = []) {
  for (const a of left) {
    for (const b of right) {
      const normalizedA = scopeComparisonKey(a);
      const normalizedB = scopeComparisonKey(b);
      if (!normalizedA || !normalizedB) return true;
      if (normalizedA === "." || normalizedB === ".") return true;
      if (normalizedA === normalizedB) return true;
      if (normalizedA.startsWith(`${normalizedB}/`) || normalizedB.startsWith(`${normalizedA}/`)) return true;
    }
  }
  return false;
}

function scopeComparisonKey(value) {
  const text = String(value || "").trim().replace(/\\/g, "/");
  if (!text || text.startsWith("TBD:")) return null;
  const normalized = path.posix.normalize(`/${text}`).replace(/^\/+/, "") || ".";
  return process.platform === "darwin" ? normalized.toLowerCase() : normalized;
}

function plannedCommandForVerification(state, verificationId) {
  const check = ((state.verificationPlan && state.verificationPlan.checks) || [])
    .find(candidate => String(candidate.verificationId).toUpperCase() === String(verificationId).toUpperCase());
  if (check && check.command) return check.command;
  return null;
}

function plannedBindingForVerification(state, verificationId) {
  const check = ((state.verificationPlan && state.verificationPlan.checks) || [])
    .find(candidate => String(candidate.verificationId).toUpperCase() === String(verificationId).toUpperCase());
  if (!check) return null;
  return {
    check,
    command: check.command || null,
    cwd: check.cwd || ".",
  };
}

function buildCoverageMatrix(state, checks) {
  const coverage = {};
  for (const ac of state.acceptanceCriteria) {
    const coveredBy = checks
      .filter(check => check.covers.acceptanceCriteria.includes(ac.id) || check.covers.requirements.some(id => ac.requirements.includes(id)))
      .map(check => check.id);
    coverage[ac.id] = {
      title: ac.title,
      requirements: ac.requirements || [],
      coveredBy,
      status: coveredBy.length ? "covered" : "uncovered",
    };
  }
  return coverage;
}

// Structural integrity of the parsed PRD. Exact-heading parsing degrades
// silently to empty arrays, and IDs referenced in one section may never be
// defined in another. These are blocking because they mean whole gates would
// otherwise vacuously pass (e.g. zero Acceptance Criteria enforced) or a user
// decision recorded only as an R#/AC# would drop out with no trace.
function structuralParseGaps(state) {
  const gaps = [];
  const tasks = state.tasks || [];
  const acs = state.acceptanceCriteria || [];
  const verifications = state.verification || [];
  const requirements = state.requirements || [];

  // The stateless readiness precheck runs this too, so a PRD whose Tasks
  // section failed to parse blocks before approval, not at plan-execution.
  if (tasks.length === 0) {
    gaps.push({
      severity: "blocking",
      code: "no_prd_tasks",
      item: "Tasks",
      message: "PRD section 8 (PRD-Level Tasks) produced no implementation tasks; check the heading text and bullet IDs",
    });
  }
  if (tasks.length > 0 && acs.length === 0) {
    gaps.push({
      severity: "blocking",
      code: "acceptance-section-empty",
      item: "acceptance-criteria",
      message: "PRD-Level Tasks parsed but no Acceptance Criteria were parsed; check the '## 7. Acceptance Criteria' heading text and bullet IDs",
    });
  }
  if (tasks.length > 0 && verifications.length === 0) {
    gaps.push({
      severity: "blocking",
      code: "verification-section-empty",
      item: "verification",
      message: "PRD-Level Tasks parsed but no Verification items were parsed; check the '## 9. Verification Contract' / Required Agent Verification table",
    });
  }

  const acIds = new Set(acs.map(item => String(item.id).toUpperCase()));
  const referencedAc = new Set();
  for (const task of tasks) for (const id of task.acceptanceCriteria || []) referencedAc.add(String(id).toUpperCase());
  for (const verification of verifications) {
    for (const id of coverageFromText(verification.text || "").acceptanceCriteria) referencedAc.add(id.toUpperCase());
  }
  if (acs.length > 0) {
    for (const id of referencedAc) {
      if (!acIds.has(id)) {
        gaps.push({
          severity: "blocking",
          code: "dangling-ac-reference",
          item: id,
          message: `${id} is referenced by a task or verification item but is not defined in Acceptance Criteria`,
        });
      }
    }
  }

  if (requirements.length > 0) {
    const referencedR = new Set();
    for (const task of tasks) for (const id of task.requirements || []) referencedR.add(String(id).toUpperCase());
    for (const verification of verifications) {
      for (const id of coverageFromText(verification.text || "").requirements) referencedR.add(id.toUpperCase());
    }
    for (const ac of acs) {
      for (const id of coverageFromText(ac.text || "").requirements) referencedR.add(id.toUpperCase());
    }
    for (const requirement of requirements) {
      if (!referencedR.has(String(requirement.id).toUpperCase())) {
        gaps.push({
          severity: "blocking",
          code: "requirement-uncovered",
          item: requirement.id,
          message: `${requirement.id} is defined in Requirements but is not covered by any task, acceptance criterion, or verification item`,
        });
      }
    }
  }

  return gaps;
}

// Words that make a verification check likely to read or write a database.
// Intentionally broad: the gap is a non-blocking warning that tells the agent
// to confirm the target is disposable before running, not a classifier.
const DB_TOUCH_PATTERN = /\b(migrat\w*|seed\w*|db|database|sql|psql|drizzle|prisma|supabase|neon|postgres\w*|mysql|sqlite|mongo\w*|redis)\b/i;

function buildVerificationGaps(state, checks, coverage, signals) {
  const gaps = structuralParseGaps(state);
  for (const [acId, item] of Object.entries(coverage)) {
    if (!item.coveredBy.length) {
      gaps.push({
        severity: "blocking",
        code: "acceptance-uncovered",
        item: acId,
        message: `${acId} has no verification check mapped by AC/R coverage IDs`,
      });
    }
  }
  for (const check of checks) {
    if (check.status === "needs_binding") {
      gaps.push({
        severity: "blocking",
        phase: "binding",
        code: "verification-binding-missing",
        item: check.id,
        message: `${check.id}/${check.verificationId} has no repository command binding yet; run verify-run after the implementation creates the verifier`,
      });
    }
    if (check.status === "needs_coverage_mapping") {
      gaps.push({
        severity: "blocking",
        code: "coverage-missing",
        item: check.id,
        message: `${check.id}/${check.verificationId} has no R/AC/T coverage mapping`,
      });
    }
    if (check.status === "needs_evidence_strategy") {
      gaps.push({
        severity: "blocking",
        code: "evidence-strategy-missing",
        item: check.id,
        message: `${check.id}/${check.verificationId} mode does not imply an evidence strategy`,
      });
    }
    const contractValues = check.contract ? Object.values(check.contract).filter(value => typeof value === "string").join(" ") : "";
    const contractText = `${check.level || ""} ${contractValues} ${check.passCriteria || ""} ${check.target || ""}`.toLowerCase();
    if ((check.category === "api" || /external|live|credential|secret|pii|phone|production/.test(contractText)) && check.contract) {
      if (!check.contract.safeProbe) {
        gaps.push({
          severity: "warning",
          code: "external-safe-probe-missing",
          item: check.id,
          message: `${check.id}/${check.verificationId} touches API/external/live behavior but has no Safe Probe column`,
        });
      }
      if (!check.contract.sensitiveDataPolicy) {
        gaps.push({
          severity: "warning",
          code: "sensitive-data-policy-missing",
          item: check.id,
          message: `${check.id}/${check.verificationId} touches API/external/live behavior but has no Sensitive Data Policy column`,
        });
      }
    }
    const verificationItem = (state.verification || []).find(entry => entry.id === check.verificationId);
    const dbHaystack = [check.command, check.passCriteria, check.target, verificationItem ? verificationItem.text : ""]
      .filter(Boolean).join(" ");
    if (DB_TOUCH_PATTERN.test(dbHaystack) || (check.artifactKinds || []).includes("db")) {
      gaps.push({
        severity: "warning",
        code: "db-safety",
        item: check.id,
        message: `${check.id}/${check.verificationId} appears to touch a database. Before running it, confirm the connection target is a disposable local or branch database, never production data; a production connection string in a test or migration path is a hard stop.`,
      });
    }
  }
  if (checks.some(check => check.category === "browser") && !hasAppStartupSignal(signals)) {
    gaps.push({
      severity: "warning",
      code: "browser-server-missing",
      item: "environment",
      message: "Browser QA is required but no obvious app startup was detected (no dev/start/serve/preview script or docker-compose); confirm a startup command before browser verification",
    });
  }
  if (checks.some(check => check.category === "server") && !signals.dockerComposeFiles.length) {
    gaps.push({
      severity: "warning",
      code: "compose-missing",
      item: "environment",
      message: "Server/service verification exists but no docker-compose file was detected; use equivalent local service startup if available",
    });
  }
  return gaps;
}

// Build (or rebuild) the execution plan and inject scope-matched learned-rule
// invariants as verification items. Init runs this automatically for the
// default sequential case; `plan-execution` reruns it to apply an explicit
// task plan or to replan after PRD task changes.
function applyExecutionPlan(state, statePath, taskPlanTasks = null) {
  state.executionPlan = buildExecutionPlan(state, statePath, taskPlanTasks);
  const injectedRules = injectRuleVerification(state);
  if (injectedRules.length && state.verificationPlan) {
    state.verificationPlan = buildVerificationPlan(state, statePath);
    state.executionPlan = buildExecutionPlan(state, statePath, taskPlanTasks);
  }
  return injectedRules;
}

// Best-effort learned-rule injection (R11 of the agents-remember contract):
// invariants whose triggers prefix-overlap any task write scope become
// verification items, so passing them is part of the receipt. The exact,
// changed-file-based enforcement stays with the ship gate; this match is
// conservative and says so in the injected item text.
function injectRuleVerification(state) {
  const projectRoot = state.projectRoot || cwd();
  const tasks = state.tasks || [];
  const scopes = tasks
    .flatMap(task => Array.isArray(task.writeScope) ? task.writeScope : [])
    .filter(scope => typeof scope === "string" && !scope.startsWith("TBD:"));
  let matched;
  try {
    matched = invariantsForWriteScopes(projectRoot, scopes);
  } catch {
    // An unreadable rules tree must not block planning; doctor reports it.
    return [];
  }
  const injected = [];
  for (const rule of matched) {
    if (state.verification.some(item => item.sourceRuleId === rule.id)) continue;
    const coveredTasks = tasks
      .filter(task => {
        try {
          return invariantsForWriteScopes(projectRoot, task.writeScope || [])
            .some(candidate => candidate.id === rule.id);
        } catch {
          return false;
        }
      })
      .map(task => task.id)
      .filter(Boolean);
    const nextIndex = state.verification.filter(item => item.source === "rules_injection").length + 1;
    const manual = rule.check.type === "manual";
    const method = rule.check.type === "command"
      ? rule.check.run
      : rule.check.type === "grep"
        ? formatCommandArgs([
          process.execPath,
          SELF_PATH,
          "rules",
          "check",
          "--id",
          rule.id,
          "--all",
        ])
        : `human confirmation: ${rule.check.confirm}`;
    const item = {
      id: `RV${nextIndex}`,
      level: "rule",
      title: `Learned invariant ${rule.id}`,
      text: `${rule.summary} (auto-injected: write scope overlaps trigger ${rule.trigger.paths.join(", ")}; full targeted check required, changed files rechecked at deliver)`,
      status: "pending",
      evidence: [],
      artifacts: [],
      source: "rules_injection",
      sourceRuleId: rule.id,
      testMode: manual ? "human" : "build/static",
      matrix: {
        mode: manual ? "human" : "build/static",
        covers: coveredTasks.length ? coveredTasks.join(", ") : rule.id,
        method,
        artifact: manual ? "none" : "command-log",
        passCriteria: manual ? rule.check.confirm : "check passes (exit 0 / pattern expectation holds)",
        environment: "local shell",
        requiredForDone: !manual,
        requiredForDoneRaw: manual ? "no" : "yes",
        canBeBlocked: manual,
        canBeBlockedRaw: manual ? "yes" : "no",
        safeProbe: "none (local check)",
        liveProof: "command log",
        sideEffect: "none",
        sensitiveDataPolicy: "no secrets",
      },
    };
    state.verification.push(item);
    injected.push(item);
  }
  return injected;
}

function nextItem(state) {
  if (verificationPlanBlocksImplementation(state)) {
    const summary = verificationPlanSummary(state);
    return {
      kind: "verification_plan",
      item: {
        id: "VP0",
        title: `Resolve verification plan gaps before implementation (${summary.blockingGapCount} blocking)`,
        status: summary.status,
      },
    };
  }
  if (executionPlanBlocksImplementation(state)) {
    const summary = executionPlanSummary(state);
    return {
      kind: "execution_plan",
      item: {
        id: "EP0",
        title: `Generate or resolve execution plan before implementation (${summary.blockingGapCount} blocking)`,
        status: summary.status,
      },
    };
  }
  const ready = readyExecutionPlan(state);
  if (ready.readySequential.length) {
    const readyId = ready.readySequential[0];
    return { kind: "task", item: state.tasks.find(item => item.id === readyId) };
  }
  const ac = state.acceptanceCriteria.find(item => !["met", "not_met", "blocked"].includes(item.status));
  if (ac) return { kind: "ac", item: ac };
  const verification = state.verification.find(item => !verificationIsClosedForAccounting(item));
  if (verification) return { kind: "verification", item: verification };
  // A task can be open yet absent from `ready` when it waits on a blocked or
  // deferred dependency. Surface it rather than advancing to the review gates,
  // which finalize would reject anyway.
  const task = state.tasks.find(item => !["complete", "deferred", "blocked"].includes(item.status));
  if (task) return { kind: "task", item: task };
  if (!state.requirementsFidelityReview || state.requirementsFidelityReview.status !== "pass") {
    const independent = independentFidelityRequiredForState(state);
    return {
      kind: "requirements_fidelity_review",
      item: {
        id: "REQ_FIDELITY_REVIEW",
        title: independent
          ? "Run fresh independent combined fidelity review before finalizing receipt"
          : `Run requirements fidelity review before ${finalReviewRequiredForState(state) ? "final adversarial review" : "finalizing receipt"}`,
        status: state.requirementsFidelityReview ? state.requirementsFidelityReview.status : "pending",
      },
    };
  }
  if (!finalReviewRequiredForState(state)) return null;
  if (!state.finalReview || state.finalReview.status !== "pass") {
    return {
      kind: "final_review",
      item: {
        id: "REVIEW",
        title: "Run final adversarial review before finalizing receipt",
        status: state.finalReview ? state.finalReview.status : "pending",
      },
    };
  }
  return null;
}

// Compact view of the next required item for per-mutation command output. The
// full task object (writeScope, evidence history, artifacts) is large and mostly
// unchanged between marks; callers that need all of it run `status`.
function nextBrief(state) {
  const next = nextItem(state);
  if (!next) return null;
  return { kind: next.kind, id: next.item.id, title: next.item.title, status: next.item.status };
}

module.exports = {
  DB_TOUCH_PATTERN,
  applyExecutionPlan,
  verificationContractHash,
  buildVerificationPlan,
  buildExecutionPlan,
  buildTraceMatrix,
  executionCoverageForTask,
  normalizeWriteScopes,
  findDependencyCycle,
  readyExecutionPlan,
  buildParallelGroups,
  writeScopesOverlap,
  plannedCommandForVerification,
  plannedBindingForVerification,
  buildCoverageMatrix,
  structuralParseGaps,
  buildVerificationGaps,
  nextItem,
  nextBrief,
};
