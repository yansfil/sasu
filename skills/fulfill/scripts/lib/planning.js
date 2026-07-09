"use strict";

/** @typedef {import("./types").State} State */


const { nowIso, cwd, toProjectRelative, sha256Text, uniqueMatches } = require("./util");
const { isVerificationRequiredForDone, verificationIsClosedForAccounting, verificationPlanSummary, verificationPlanBlocksImplementation, executionPlanSummary, executionPlanBlocksImplementation, finalReviewRequiredForState } = require("./state_data");
const { inferVerificationMode } = require("./prd_parser");
const { repoSignals, classifyVerification, commandFromText, commandForMode, coverageFromText, artifactsForVerification, passCriteriaFromText, toolForVerification, targetForVerification, plannedCheckStatus, plannerNotes, hasAppStartupSignal } = require("./inference");

/** @param {State} state */
function taskGraphSummary(state) {
  const graph = state.taskGraph && state.taskGraph.schema === "hoyeon.prd-implement.taskgraph.v2"
    ? state.taskGraph
    : buildTaskGraph(state);
  return {
    status: graph.status || "unknown",
    nodeCount: graph.summary ? graph.summary.nodeCount : (graph.nodes || []).length,
    edgeCount: graph.summary ? graph.summary.edgeCount : (graph.edges || []).length,
    openNodeCount: graph.summary ? graph.summary.openNodeCount : (graph.nodes || []).filter(node => !node.closed).length,
    blockingGapCount: graph.summary ? graph.summary.blockingGapCount : verificationPlanSummary(state).blockingGapCount,
    generatedAt: graph.generatedAt,
  };
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
  const checks = state.verification.map((verification, index) => {
	    const mode = inferVerificationMode(verification, state.testModeContract || []);
	    const category = classifyVerification(verification, mode);
	    const explicitCommand = verification.matrix && !verification.matrix.method
	      ? null
	      : commandFromText(verification.text);
	    const command = category === "command" || category === "automated"
	      ? explicitCommand || commandForMode(mode, category, signals)
	      : null;
	    const covers = coverageFromText(verification.text);
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
      target: targetForVerification(category, signals),
      covers,
      artifactKinds: artifacts,
      passCriteria,
      requiredForDone: isVerificationRequiredForDone(verification),
      canBeBlocked: verification.matrix ? Boolean(verification.matrix.canBeBlocked) : false,
      testMode: mode ? mode.mode : null,
      testModeContract: mode || null,
      contract: verification.matrix || null,
      contractHash: sha256Text(JSON.stringify({
        id: verification.id,
        text: verification.text,
        matrix: verification.matrix || null,
      })),
      status: plannedCheckStatus({ verification, category, command, covers, artifacts, mode }),
      notes: plannerNotes({ verification, category, command, covers, signals, mode }),
    };
  });
  const coverage = buildCoverageMatrix(state, checks);
  const gaps = buildVerificationGaps(state, checks, coverage, signals);
  return {
    schema: "hoyeon.prd-implement.verification-plan.v1",
    status: gaps.some(gap => gap.severity === "blocking") ? "needs_review" : "ready",
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

/**
 * @param {State} state
 * @param {string} statePath
 * @returns {import("./types").ExecutionPlan}
 */
function buildExecutionPlan(state, statePath) {
  const previous = state.executionPlan && Array.isArray(state.executionPlan.nodes)
    ? new Map(state.executionPlan.nodes.map(node => [node.id, node]))
    : new Map();
  const gaps = [];
  const nodes = [];
  const taskToNodeId = new Map();
  for (const [index, task] of (state.tasks || []).entries()) {
    taskToNodeId.set(task.id, `N${index + 1}`);
  }

  for (const [index, task] of (state.tasks || []).entries()) {
    const id = `N${index + 1}`;
    const prior = previous.get(id) || {};
    const writeScope = inferWriteScope(task, state);
    const risk = inferRisk(task, state);
    const dependsOn = inferDependsOn(task, state, taskToNodeId, index);
    const covers = executionCoverageForTask(state, task);
    if (writeScope.length === 0) {
      gaps.push({
        severity: "warning",
        code: "missing_write_scope",
        item: task.id,
        message: "Write scope could not be inferred; node is not parallel-safe until the coordinator narrows scope",
      });
    }
    if ((task.requirements || []).length === 0) {
      gaps.push({
        severity: "warning",
        code: "task_without_requirement",
        item: task.id,
        message: "Task has no explicit requirement mapping",
      });
    }
    if (covers.acceptanceCriteria.length === 0) {
      gaps.push({
        severity: "warning",
        code: "task_without_acceptance_mapping",
        item: task.id,
        message: "Task has no acceptance-criterion mapping",
      });
    }
    nodes.push({
      id,
      kind: "implementation",
      sourceTask: task.id,
      title: task.title,
      dependsOn,
      writeScope,
      covers,
      parallelSafe: risk !== "high" && writeScope.length > 0,
      risk,
      owner: prior.owner || null,
      status: prior.status || "pending",
      evidence: Array.isArray(prior.evidence) ? prior.evidence : [],
      artifacts: Array.isArray(prior.artifacts) ? prior.artifacts : [],
    });
  }

  if ((state.tasks || []).length === 0) {
    gaps.push({
      severity: "blocking",
      code: "no_prd_tasks",
      item: "Tasks",
      message: "PRD section 13 produced no implementation tasks",
    });
  }

	  const rollups = { tasks: {} };
	  for (const task of state.tasks || []) {
	    const node = nodes.find(candidate => candidate.sourceTask === task.id);
	    rollups.tasks[task.id] = {
	      nodes: node ? [node.id] : [],
	      acceptanceCriteria: node ? node.covers.acceptanceCriteria : task.acceptanceCriteria || [],
	      verification: node ? node.covers.verification : [],
	    };
	  }
	  addExecutionGraphQualityGaps(nodes, gaps);
	  const traceMatrix = buildTraceMatrix(state, nodes, rollups);

	  return {
    schema: "hoyeon.prd-implement.execution-plan.v1",
    status: gaps.some(gap => gap.severity === "blocking") ? "needs_review" : "ready",
    generatedAt: nowIso(),
    prdPath: state.prdPath,
    statePath: toProjectRelative(statePath, state.projectRoot || cwd()),
	    nodes,
	    rollups,
	    traceMatrix,
	    gaps,
	  };
	}

function buildTraceMatrix(state, nodes, rollups) {
  const verificationById = new Map((state.verification || []).map(item => [item.id, item]));
  return (state.tasks || []).map(task => {
    const rollup = rollups.tasks[task.id] || { nodes: [], acceptanceCriteria: [], verification: [] };
    const requiredVerification = rollup.verification.filter(id => {
      const item = verificationById.get(id);
      return item ? isVerificationRequiredForDone(item) : true;
    });
    const optionalVerification = rollup.verification.filter(id => !requiredVerification.includes(id));
    return {
      taskId: task.id,
      nodeIds: rollup.nodes || [],
      requirements: task.requirements || [],
      acceptanceCriteria: rollup.acceptanceCriteria || [],
      verification: rollup.verification || [],
      requiredVerification,
      optionalVerification,
      nodeStatuses: (rollup.nodes || []).map(id => {
        const node = nodes.find(candidate => candidate.id === id);
        return { id, status: node ? node.status : "missing" };
      }),
    };
  });
}

function refreshExecutionTraceMatrix(state) {
  if (!state.executionPlan || !state.executionPlan.rollups || !Array.isArray(state.executionPlan.nodes)) return;
  state.executionPlan.traceMatrix = buildTraceMatrix(state, state.executionPlan.nodes, state.executionPlan.rollups);
}

function addExecutionGraphQualityGaps(nodes, gaps) {
  if (nodes.length >= 5 && nodes.every(node => !node.dependsOn || node.dependsOn.length === 0)) {
    gaps.push({
      severity: "warning",
      code: "weak_graph_no_dependencies",
      item: "execution-plan",
      message: "Execution plan has five or more nodes and no dependencies; confirm this is genuinely parallelizable or record a deviation",
    });
  }
  const scopeCounts = new Map();
  for (const node of nodes) {
    const key = (node.writeScope || []).join("\n") || "unknown";
    scopeCounts.set(key, (scopeCounts.get(key) || 0) + 1);
  }
  for (const [scope, count] of scopeCounts.entries()) {
    if (nodes.length >= 4 && count >= Math.ceil(nodes.length * 0.75)) {
      gaps.push({
        severity: "warning",
        code: "weak_graph_repeated_write_scope",
        item: "execution-plan",
        message: `Most execution nodes share the same write scope (${scope === "unknown" ? "unknown" : scope}); narrow scopes before relying on parallel guidance`,
      });
      break;
    }
  }
  if (nodes.length >= 4 && nodes.every(node => node.risk === "high" && node.parallelSafe === false)) {
    gaps.push({
      severity: "warning",
      code: "weak_graph_all_high_risk",
      item: "execution-plan",
      message: "All execution nodes are high risk and not parallel-safe; treat ready guidance as sequential only",
    });
  }
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

function inferWriteScope(task, state) {
  const taskHints = extractPathHints(task.text || task.title || "");
  if (taskHints.length) return taskHints;
  const structureHints = extractPathHints([
    state.technicalStructure || "",
    state.implementationNotes || "",
  ].join("\n"));
  return structureHints;
}

function extractPathHints(text) {
  const hints = [];
  const add = value => {
    const normalized = normalizePathHint(value);
    if (!normalized || !isPotentialPathHint(normalized)) return;
    if (!hints.includes(normalized)) hints.push(normalized);
  };
  for (const match of String(text || "").matchAll(/`([^`]+)`/g)) add(match[1]);
  for (const match of String(text || "").matchAll(/(?:^|\s)((?:\.{1,2}\/|\/)?[A-Za-z0-9_.@가-힣-]+(?:\/[A-Za-z0-9_.@가-힣-]+)*\.[A-Za-z0-9]{1,8})/g)) {
    add(match[1]);
  }
  for (const match of String(text || "").matchAll(/(?:^|\s)(\/[A-Za-z0-9_.@가-힣-]+(?:\/[A-Za-z0-9_.@가-힣-]+)+)/g)) {
    add(match[1]);
  }
  return hints.slice(0, 12);
}

function normalizePathHint(value) {
  return String(value || "")
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/[),.;:]+$/g, "");
}

function isPotentialPathHint(value) {
  const text = String(value || "").trim();
  if (!text || /^https?:\/\//i.test(text)) return false;
  if (/^(?:pnpm|npm|yarn|bun|pytest|python|node|go|cargo|make|docker|docker-compose)\b/i.test(text)) return false;
  if (/^(?:R|AC|T|V)\d+$/i.test(text)) return false;
  return text.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(text);
}

function inferRisk(task, state) {
  const text = `${task.text || ""}\n${state.technicalStructure || ""}`
    .split(/\r?\n/)
    .filter(line => {
      const lower = line.toLowerCase();
      const sensitive = /(auth|rls|migration|migrate|database|postgres|supabase|sql|schema|security|credential|secret|config|env|production|prod data|billing|permission|권한|마이그레이션|보안)/.test(lower);
      const negated = /\b(no|none|without|not|does not|is not|없음|아님|불필요)\b/.test(lower);
      return !(sensitive && negated);
    })
    .join("\n")
    .toLowerCase();
  if (/(auth|rls|migration|migrate|database|postgres|supabase|sql|schema|security|credential|secret|config|env|production|prod data|billing|permission|권한|마이그레이션|보안)/.test(text)) {
    return "high";
  }
  if (/(api|server|service|integration|browser|runtime|route|endpoint|db|data|external|서버|브라우저|라우트)/.test(text)) {
    return "medium";
  }
  return "low";
}

function inferDependsOn(task, state, taskToNodeId, index) {
  const dependencies = [];
  for (const taskId of uniqueMatches(task.text || "", /\bT\d+\b/gi)) {
    if (taskId === task.id) continue;
    const nodeId = taskToNodeId.get(taskId);
    if (nodeId && !dependencies.includes(nodeId)) dependencies.push(nodeId);
  }
  if (dependencies.length === 0 && index > 0 && /\b(after|following|depends on|blocked by|이후|다음|뒤에|완료 후)\b/i.test(task.text || "")) {
    dependencies.push(`N${index}`);
  }
  return dependencies;
}

function readyExecutionPlan(state) {
  const plan = state.executionPlan;
  const planSummary = executionPlanSummary(state);
  const verificationSummary = verificationPlanSummary(state);
  if (!plan || !Array.isArray(plan.nodes)) {
    return {
      readySequential: [],
      readyParallelGroups: [],
      parallelEnabled: Boolean(state.execution && state.execution.parallel),
      blocked: [{ id: "EP0", waitingFor: verificationPlanBlocksImplementation(state) ? ["VP0"] : ["plan-execution"] }],
      plan: planSummary,
    };
  }
  const nodesById = new Map(plan.nodes.map(node => [node.id, node]));
  const blocked = [];
  const ready = [];
  for (const node of plan.nodes) {
    if (!["pending", "in_progress"].includes(node.status)) continue;
    const waitingFor = [];
    if (verificationSummary.status !== "ready" || verificationSummary.blockingGapCount > 0) waitingFor.push("VP0");
    if (plan.status !== "ready" || planSummary.blockingGapCount > 0) waitingFor.push("EP0");
    for (const depId of node.dependsOn || []) {
      const dep = nodesById.get(depId);
      if (!dep || dep.status !== "complete") waitingFor.push(depId);
    }
    if (waitingFor.length) blocked.push({ id: node.id, waitingFor: Array.from(new Set(waitingFor)) });
    else ready.push(node);
  }
  const parallelEnabled = Boolean(state.execution && state.execution.parallel);
  return {
    readySequential: ready.map(node => node.id),
    readyParallelGroups: parallelEnabled ? buildParallelGroups(ready) : [],
    parallelEnabled,
    blocked,
    plan: planSummary,
  };
}

function buildParallelGroups(readyNodes) {
  const candidates = readyNodes.filter(node => {
    if (!node.parallelSafe) return false;
    if (!["low", "medium"].includes(node.risk)) return false;
    return Array.isArray(node.writeScope) && node.writeScope.length > 0;
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
    if (group.length > 1) groups.push(group.map(node => node.id));
  }
  return groups;
}

function writeScopesOverlap(left = [], right = []) {
  for (const a of left) {
    for (const b of right) {
      if (a === b) return true;
      if (a.startsWith("TBD:") || b.startsWith("TBD:")) return true;
      if (a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) return true;
    }
  }
  return false;
}

function rollupTasksFromExecutionPlan(state, options = {}) {
  const recordEvidence = options.recordEvidence !== false;
  const plan = state.executionPlan;
  if (!plan || !plan.rollups || !plan.rollups.tasks) return;
  const nodesById = new Map((plan.nodes || []).map(node => [node.id, node]));
  const acById = new Map((state.acceptanceCriteria || []).map(ac => [ac.id, ac]));
  const verificationById = new Map((state.verification || []).map(item => [item.id, item]));
  for (const task of state.tasks || []) {
    if (["blocked", "deferred"].includes(task.status)) continue;
    const rollup = plan.rollups.tasks[task.id];
    if (!rollup || !rollup.nodes || rollup.nodes.length === 0) continue;
    const nodes = rollup.nodes.map(id => nodesById.get(id)).filter(Boolean);
    if (nodes.some(node => node.status === "blocked")) {
      task.status = "blocked";
      if (recordEvidence && !task.evidence.some(entry => /Execution roll-up/.test(entry.text))) {
        task.evidence.push({ ts: nowIso(), text: `Execution roll-up: blocked by ${nodes.filter(node => node.status === "blocked").map(node => node.id).join(", ")}` });
      }
      continue;
    }
	    const allNodesComplete = nodes.length > 0 && nodes.every(node => node.status === "complete");
	    const mappedAcs = (rollup.acceptanceCriteria || []).map(id => acById.get(id)).filter(Boolean);
	    const mappedVerification = (rollup.verification || []).map(id => verificationById.get(id)).filter(Boolean);
	    const acsMet = mappedAcs.every(ac => ac.status === "met");
	    const verificationClosed = mappedVerification.every(item => verificationIsClosedForAccounting(item));
	    if (allNodesComplete && acsMet && verificationClosed) {
	      task.status = "complete";
	      if (recordEvidence && !task.evidence.some(entry => /Execution roll-up/.test(entry.text))) {
	        task.evidence.push({
	          ts: nowIso(),
	          text: `Execution roll-up: ${nodes.map(node => node.id).join(", ")} complete; ACs ${mappedAcs.map(ac => ac.id).join(", ") || "none"} met; required Verification ${mappedVerification.filter(item => isVerificationRequiredForDone(item)).map(item => item.id).join(", ") || "none"} passed.`,
	        });
	      }
	    } else if (task.status === "complete") {
	      task.status = "in_progress";
	      if (recordEvidence) task.evidence.push({
	        ts: nowIso(),
	        text: "Execution roll-up reopened: mapped ACs must be met and all required Verification items must pass before task completion.",
	      });
	    } else if (nodes.some(node => ["in_progress", "complete"].includes(node.status)) && task.status === "pending") {
	      task.status = "in_progress";
	    }
  }
}

/** @param {State} state */
function buildTaskGraph(state) {
  const verificationPlan = verificationPlanSummary(state);
  const executionPlan = executionPlanSummary(state);
  const graph = createTaskGraphBuilder();
  const tasks = state.tasks || [];
  const acceptanceCriteria = state.acceptanceCriteria || [];
  const verificationItems = state.verification || [];
  const executionNodes = state.executionPlan && Array.isArray(state.executionPlan.nodes) ? state.executionPlan.nodes : [];

  addPlanGateNodes(graph, verificationPlan, executionPlan);
  addTaskRollupNodes(graph, tasks);
  addExecutionGraphNodes(graph, executionNodes);
  addAcceptanceCriterionNodes(graph, acceptanceCriteria);
  addVerificationGraphNodes(graph, state, tasks, acceptanceCriteria, verificationItems);
  addReviewAndReceiptNodes(graph, state, [...tasks, ...executionNodes, ...acceptanceCriteria, ...verificationItems]);

  const { nodes, edges } = graph;
  return {
    schema: "hoyeon.prd-implement.taskgraph.v2",
    generatedAt: nowIso(),
    prdPath: state.prdPath,
    status: state.finalReceipt
      ? "complete"
      : verificationPlanBlocksImplementation(state)
        ? "blocked_by_verification_plan"
        : executionPlanBlocksImplementation(state)
          ? "blocked_by_execution_plan"
          : "active",
    summary: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      openNodeCount: nodes.filter(node => !node.closed).length,
      blockingGapCount: verificationPlan.blockingGapCount + executionPlan.blockingGapCount,
      executionNodeCount: executionPlan.nodeCount,
      openExecutionNodeCount: executionPlan.openNodeCount,
    },
    nodes,
    edges: edges.map(({ key, ...edge }) => edge),
  };
}

function createTaskGraphBuilder() {
  const nodes = [];
  const edges = [];
  return {
    nodes,
    edges,
    addNode(node) {
      nodes.push({
        ...node,
        evidenceCount: Array.isArray(node.evidence) ? node.evidence.length : node.evidenceCount || 0,
        artifactCount: Array.isArray(node.artifacts) ? node.artifacts.length : node.artifactCount || 0,
      });
    },
    addEdge(from, to, type, reason) {
      if (!from || !to || from === to) return;
      const key = `${from}->${to}:${type}`;
      if (edges.some(edge => edge.key === key)) return;
      edges.push({ key, from, to, type, reason });
    },
  };
}

function addPlanGateNodes(graph, verificationPlan, executionPlan) {
  graph.addNode({
    id: "VP0",
    kind: "verification_plan",
    title: "Generate and resolve verification plan",
    status: verificationPlan.status,
    closed: verificationPlan.status === "ready" && verificationPlan.blockingGapCount === 0,
    blockingGapCount: verificationPlan.blockingGapCount,
    checkCount: verificationPlan.checkCount,
  });
  graph.addNode({
    id: "EP0",
    kind: "execution_plan",
    title: "Generate execution plan from PRD tasks",
    status: executionPlan.status,
    closed: executionPlan.status === "ready" && executionPlan.blockingGapCount === 0,
    blockingGapCount: executionPlan.blockingGapCount,
    nodeCount: executionPlan.nodeCount,
  });
  graph.addEdge("VP0", "EP0", "unblocks", "execution planning starts after verification planning");
}

function addTaskRollupNodes(graph, tasks) {
  for (const task of tasks) {
    graph.addNode({
      id: task.id,
      kind: "task_rollup",
      title: task.title,
      status: task.status,
      closed: task.status === "complete",
      requirements: task.requirements || [],
      acceptanceCriteria: task.acceptanceCriteria || [],
      evidence: task.evidence || [],
      artifacts: task.artifacts || [],
    });
  }
}

function addExecutionGraphNodes(graph, executionNodes) {
  for (const node of executionNodes) {
    graph.addNode({
      id: node.id,
      kind: "execution_node",
      title: node.title,
      status: node.status,
      closed: node.status === "complete",
      sourceTask: node.sourceTask,
      dependsOn: node.dependsOn || [],
      writeScope: node.writeScope || [],
      parallelSafe: node.parallelSafe,
      risk: node.risk,
      owner: node.owner || null,
      covers: node.covers || { requirements: [], acceptanceCriteria: [], verification: [] },
      evidence: node.evidence || [],
      artifacts: node.artifacts || [],
    });
    graph.addEdge("EP0", node.id, "unblocks", "execution node comes from the execution plan");
    graph.addEdge(node.sourceTask, node.id, "decomposes_to", "PRD task is executed through this implementation node");
    for (const depId of node.dependsOn || []) graph.addEdge(depId, node.id, "depends_on", "execution dependency");
    for (const acId of (node.covers && node.covers.acceptanceCriteria) || []) graph.addEdge(node.id, acId, "satisfies", "execution node covers this acceptance criterion");
    for (const verificationId of (node.covers && node.covers.verification) || []) graph.addEdge(node.id, verificationId, "verified_by", "execution node is proven by this verification item");
  }
}

function addAcceptanceCriterionNodes(graph, acceptanceCriteria) {
  for (const ac of acceptanceCriteria) {
    graph.addNode({
      id: ac.id,
      kind: "acceptance_criterion",
      title: ac.title,
      status: ac.status,
      closed: ac.status === "met",
      requirements: ac.requirements || [],
      evidence: ac.evidence || [],
      artifacts: ac.artifacts || [],
    });
  }
}

function addVerificationGraphNodes(graph, state, tasks, acceptanceCriteria, verificationItems) {
  const checksByVerificationId = new Map();
  for (const check of (state.verificationPlan && state.verificationPlan.checks) || []) {
    checksByVerificationId.set(check.verificationId, check);
  }
  for (const verification of verificationItems) {
    const check = checksByVerificationId.get(verification.id);
    const covers = check ? check.covers : coverageFromText(verification.text || "");
    graph.addNode({
      id: verification.id,
      kind: "verification",
      title: verification.title,
      status: verification.status,
      closed: verificationIsClosedForAccounting(verification),
      level: verification.level,
      category: check ? check.category : null,
      tool: check ? check.tool : null,
      requiredForDone: isVerificationRequiredForDone(verification),
      covers,
      evidence: verification.evidence || [],
      artifacts: verification.artifacts || [],
    });
    graph.addEdge("VP0", verification.id, "plans", "verification check comes from the verification plan");
    for (const taskId of covers.tasks || []) graph.addEdge(taskId, verification.id, "verified_by", "verification covers this task");
    for (const acId of covers.acceptanceCriteria || []) graph.addEdge(acId, verification.id, "verified_by", "verification covers this acceptance criterion");
    for (const reqId of covers.requirements || []) {
      for (const task of tasks.filter(item => (item.requirements || []).includes(reqId))) {
        graph.addEdge(task.id, verification.id, "verified_by", `verification covers ${reqId}`);
      }
      for (const ac of acceptanceCriteria.filter(item => (item.requirements || []).includes(reqId))) {
        graph.addEdge(ac.id, verification.id, "verified_by", `verification covers ${reqId}`);
      }
    }
  }
}

function addReviewAndReceiptNodes(graph, state, reviewedItems) {
  graph.addNode({
    id: "REQ_FIDELITY_REVIEW",
    kind: "requirements_fidelity_review",
    title: "Requirements fidelity review",
    status: state.requirementsFidelityReview ? state.requirementsFidelityReview.status : "pending",
    closed: Boolean(state.requirementsFidelityReview && state.requirementsFidelityReview.status === "pass"),
    evidenceCount: state.requirementsFidelityReview ? 1 : 0,
    artifactCount: state.requirementsFidelityReview && state.requirementsFidelityReview.reportPath ? 1 : 0,
  });
  const finalReviewRequired = finalReviewRequiredForState(state);
  graph.addNode({
    id: "REVIEW",
    kind: "final_review",
    title: "Adversarial final review",
    status: state.finalReview ? state.finalReview.status : finalReviewRequired ? "pending" : "skipped",
    closed: finalReviewRequired ? Boolean(state.finalReview && state.finalReview.status === "pass") : true,
    requiredForDone: finalReviewRequired,
    evidenceCount: state.finalReview ? 1 : 0,
    artifactCount: state.finalReview && state.finalReview.reportPath ? 1 : 0,
  });
  graph.addNode({
    id: "FINALIZE",
    kind: "receipt",
    title: "Final receipt",
    status: state.finalReceipt ? state.finalReceipt.status : "pending",
    closed: Boolean(state.finalReceipt),
    evidenceCount: state.finalReceipt ? 1 : 0,
    artifactCount: state.finalReceipt ? 1 : 0,
  });

  for (const item of reviewedItems) {
    graph.addEdge(item.id, "REQ_FIDELITY_REVIEW", "requirements_review_input", "requirements reviewer must audit this item against original user intent and PRD decisions");
    graph.addEdge(item.id, "REVIEW", "review_input", "final reviewer must audit this item and its evidence");
  }
  graph.addEdge("REQ_FIDELITY_REVIEW", "REVIEW", "review_input", finalReviewRequired
    ? "final reviewer must audit the requirements fidelity verdict"
    : "trivial profile skips mandatory final review after requirements fidelity passes");
  graph.addEdge("REVIEW", "FINALIZE", "gates", finalReviewRequired
    ? "receipt can be written only after passing final review"
    : "receipt can be written after requirements fidelity review and mechanical gates pass");
}

function plannedCommandForVerification(state, verificationId) {
  const check = ((state.verificationPlan && state.verificationPlan.checks) || [])
    .find(candidate => String(candidate.verificationId).toUpperCase() === String(verificationId).toUpperCase());
  if (check && check.command) return check.command;
  const item = (state.verification || [])
    .find(candidate => String(candidate.id).toUpperCase() === String(verificationId).toUpperCase());
  return item ? commandFromText(item.text || "") : null;
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
  for (const verification of verifications) for (const id of uniqueMatches(verification.text || "", /\bAC\d+\b/gi)) referencedAc.add(id.toUpperCase());
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
    for (const verification of verifications) for (const id of uniqueMatches(verification.text || "", /\bR\d+\b/gi)) referencedR.add(id.toUpperCase());
    for (const ac of acs) for (const id of uniqueMatches(ac.text || "", /\bR\d+\b/gi)) referencedR.add(id.toUpperCase());
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
    if (check.status === "needs_command") {
      gaps.push({
        severity: "blocking",
        code: "command-missing",
        item: check.id,
        message: `${check.id}/${check.verificationId} needs a concrete command or approved verifier`,
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
	    if (check.status === "needs_artifact") {
	      gaps.push({
	        severity: "blocking",
	        code: "artifact-missing",
	        item: check.id,
	        message: `${check.id}/${check.verificationId} has no explicit artifact requirement`,
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
	    const nodeId = ready.readySequential[0];
	    const node = state.executionPlan.nodes.find(item => item.id === nodeId);
	    return { kind: "execution_node", item: node };
	  }
	  const ac = state.acceptanceCriteria.find(item => !["met", "not_met", "blocked"].includes(item.status));
	  if (ac) return { kind: "ac", item: ac };
	  const verification = state.verification.find(item => !verificationIsClosedForAccounting(item));
	  if (verification) return { kind: "verification", item: verification };
	  const task = state.tasks.find(item => !["complete", "deferred", "blocked"].includes(item.status));
	  if (task) return { kind: "task_rollup", item: task };
	  if (!state.requirementsFidelityReview || state.requirementsFidelityReview.status !== "pass") {
	    return {
	      kind: "requirements_fidelity_review",
	      item: {
	        id: "REQ_FIDELITY_REVIEW",
	        title: "Run read-only requirements fidelity review before final adversarial review",
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
// full execution-node object (writeScope, covers, evidence history) is large and
// unchanged between marks; callers that need the whole graph run `status`.
function nextBrief(state) {
  const next = nextItem(state);
  if (!next) return null;
  return { kind: next.kind, id: next.item.id, title: next.item.title, status: next.item.status };
}

module.exports = {
  taskGraphSummary,
  verificationContractHash,
  buildVerificationPlan,
  buildExecutionPlan,
  buildTraceMatrix,
  refreshExecutionTraceMatrix,
  addExecutionGraphQualityGaps,
  executionCoverageForTask,
  inferWriteScope,
  extractPathHints,
  normalizePathHint,
  isPotentialPathHint,
  inferRisk,
  inferDependsOn,
  readyExecutionPlan,
  buildParallelGroups,
  writeScopesOverlap,
  rollupTasksFromExecutionPlan,
  buildTaskGraph,
  plannedCommandForVerification,
  buildCoverageMatrix,
  structuralParseGaps,
  buildVerificationGaps,
  nextItem,
  nextBrief,
};
