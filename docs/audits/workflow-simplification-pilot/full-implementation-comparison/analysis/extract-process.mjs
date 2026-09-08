#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function fail(message) {
  process.stderr.write(`extract-process: ${message}\n`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const valueFor = (flag) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : null;
};
const configPath = valueFor("--config");
const outPath = valueFor("--out");
if (!configPath || !outPath) fail("usage: node extract-process.mjs --config <inputs.json> --out <metrics.json>");

const config = JSON.parse(fs.readFileSync(path.resolve(configPath), "utf8"));
if (!Array.isArray(config.runs) || config.runs.length === 0) fail("config.runs must contain at least one run");

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const isoMs = (value) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const elapsed = (start, end) => {
  const left = isoMs(start);
  const right = isoMs(end);
  return left === null || right === null ? null : Math.max(0, right - left);
};
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const readJsonl = (file) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
const preparationCorrectionValue = config.preparationCorrectionPath && fs.existsSync(config.preparationCorrectionPath)
  ? readJson(config.preparationCorrectionPath)
  : null;

function transcriptFor(sessionId, explicitPath) {
  if (explicitPath) return path.resolve(explicitPath);
  const root = "/Users/hoyeonlee/.codex/sessions";
  const result = spawnSync("rg", ["--files", root], { encoding: "utf8" });
  if (result.status !== 0) fail(`cannot enumerate Codex transcripts: ${result.stderr.trim()}`);
  const suffix = `${sessionId}.jsonl`;
  const matches = result.stdout.split("\n").filter((file) => file.endsWith(suffix));
  if (matches.length !== 1) fail(`expected one transcript for ${sessionId}, found ${matches.length}`);
  return matches[0];
}

function commandText(payload) {
  return String(payload.input ?? payload.arguments ?? "");
}

function broadKind(name, command) {
  const text = `${name} ${command}`;
  if (/benchmark_report\.js[^\n]*(?:prepare-run|start)\b/.test(text)) return "preparation";
  if (/(?:\bsasu\b|\bcli\.js\b)[^\n]*\b(?:implement\s+)?(?:init|start)\b/.test(text)) return "preparation";
  if (/(?:\bsasu\b|\bcli\.js\b)[^\n]*\b(?:implement\s+)?(?:finalize|review)\b/.test(text)) return "finalization";
  if (/(?:\bsasu\b|\bcli\.js\b)[^\n]*\b(?:implement\s+)?verify\b/.test(text)) return "verify-wrapper";
  if (/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|check|build|lint)\b|\bnode\s+--test\b|\bnpx\s+(?:tsc|playwright)\b|\bpytest\b|\bcargo\s+test\b/.test(text)) return "focused-checks";
  if (/apply_patch|writeFile|\.write_text\(|\btee\b|cat\s*>|cat\s+>\s*|\b(?:Edit|Write)\b/.test(text)) return "mutation";
  if (/SKILL\.md|benchmark\.json|prd\.md|\bgit\s+(?:status|diff|show)\b|\b(?:sed|cat|rg|jq)\b/.test(text)) return "observation";
  return "other";
}

function actionLabel(raw) {
  if (raw.includes("/usr/bin/trash") && raw.includes("implement finalize")) return "trash stale temp files, then finalize";
  if (/\brm\s+-f\b/.test(raw) && raw.includes("implement finalize")) return "rejected rm cleanup, then finalize";
  if (raw.includes("implement finalize")) return "implement finalize";
  if (raw.includes("df -h") || raw.includes("df -i")) return "filesystem and stale-temp diagnostics";
  if (raw.includes("implement verify")) return "implement verify";
  return "other observed tool call";
}

function unionMs(intervals) {
  const ordered = intervals
    .map(({ startedAt, finishedAt }) => [isoMs(startedAt), isoMs(finishedAt)])
    .filter(([start, end]) => start !== null && end !== null && end >= start)
    .sort((left, right) => left[0] - right[0]);
  let total = 0;
  let active = null;
  for (const interval of ordered) {
    if (!active || interval[0] > active[1]) {
      if (active) total += active[1] - active[0];
      active = [...interval];
    } else active[1] = Math.max(active[1], interval[1]);
  }
  if (active) total += active[1] - active[0];
  return total;
}

function clippedUnionMs(intervals, startAt, endAt) {
  const start = isoMs(startAt);
  const end = isoMs(endAt);
  if (start === null || end === null) return null;
  return unionMs(intervals.flatMap((item) => {
    const left = Math.max(start, isoMs(item.startedAt) ?? start);
    const right = Math.min(end, isoMs(item.finishedAt) ?? end);
    return right > left ? [{ startedAt: new Date(left).toISOString(), finishedAt: new Date(right).toISOString() }] : [];
  }));
}

function interval(startedAt, finishedAt) {
  return startedAt && finishedAt ? { startedAt, finishedAt } : null;
}

function overlapsWithin(intervals, windows) {
  return intervals.flatMap((item) => windows.flatMap((window) => {
    const left = Math.max(isoMs(item.startedAt) ?? 0, isoMs(window.startedAt) ?? 0);
    const right = Math.min(isoMs(item.finishedAt) ?? 0, isoMs(window.finishedAt) ?? 0);
    return right > left ? [{ startedAt: new Date(left).toISOString(), finishedAt: new Date(right).toISOString() }] : [];
  }));
}

function walk(value, visit, pointer = "") {
  if (!value || typeof value !== "object") return;
  visit(value, pointer);
  for (const [key, child] of Object.entries(value)) walk(child, visit, `${pointer}/${key}`);
}

function stateIntervals(state) {
  const suites = [];
  const judges = [];
  const rawAttempts = state.verificationAttempts ?? state.attempts ?? [];
  const attempts = rawAttempts.map((value) => ({
    id: value.id ?? null,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    durationMs: value.durationMs ?? elapsed(value.startedAt, value.finishedAt),
    verdict: value.verdict ?? null,
    phase: value.phase ?? null,
    error: value.error ?? null,
  }));
  const seenSuite = new Set();
  const seenJudge = new Set();
  walk(state, (value, pointer) => {
    const looksMechanical = value.command && value.startedAt && value.finishedAt && typeof value.exitCode === "number";
    if (looksMechanical) {
      const key = `${value.startedAt}:${value.finishedAt}:${value.command}`;
      if (!seenSuite.has(key)) {
        seenSuite.add(key);
        suites.push({ pointer, command: value.command, startedAt: value.startedAt, finishedAt: value.finishedAt, durationMs: value.durationMs ?? elapsed(value.startedAt, value.finishedAt), exitCode: value.exitCode, status: value.status ?? null });
      }
    }
    const looksJudge = value.judge && value.startedAt && value.finishedAt && typeof value.durationMs === "number";
    if (looksJudge) {
      const key = `${value.startedAt}:${value.finishedAt}:${pointer}`;
      if (!seenJudge.has(key)) {
        seenJudge.add(key);
        judges.push({ pointer, startedAt: value.startedAt, finishedAt: value.finishedAt, durationMs: value.durationMs, verdict: value.verdict ?? null, error: value.error ?? null, backend: value.judge.backend ?? null, model: value.judge.model ?? null, effort: value.judge.effort ?? value.judge.reasoningEffort ?? null, attempts: value.judge.attempts ?? 1, retries: value.judge.retries ?? [], outcome: value.judge.outcome ?? null, usage: value.judge.usage ?? null });
      }
    }
  });
  attempts.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  suites.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  judges.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  return { attempts, suites, judges };
}

function transcriptMetrics(sessionId, explicitPath) {
  const transcript = transcriptFor(sessionId, explicitPath);
  const records = readJsonl(transcript);
  const meta = records.find((record) => record.type === "session_meta")?.payload ?? {};
  const contexts = records.filter((record) => record.type === "turn_context").map((record) => ({ timestamp: record.timestamp, turnId: record.payload?.turn_id ?? null, model: record.payload?.model ?? null, effort: record.payload?.effort ?? null, cwd: record.payload?.cwd ?? null }));
  const handoff = records.find((record) => record.type === "response_item" && record.payload?.type === "message" && record.payload?.role === "user")?.timestamp ?? null;
  const turns = [];
  for (const record of records) {
    if (record.type !== "event_msg") continue;
    if (record.payload?.type === "task_started") turns.push({ turnId: record.payload.turn_id ?? null, startedAt: record.timestamp, finishedAt: null });
    if (record.payload?.type === "task_complete") {
      const open = [...turns].reverse().find((turn) => !turn.finishedAt);
      if (open) open.finishedAt = record.timestamp;
    }
  }
  const calls = new Map();
  const failures = [];
  for (const record of records) {
    const payload = record.payload ?? {};
    if (record.type === "response_item" && ["custom_tool_call", "function_call"].includes(payload.type)) {
      const raw = commandText(payload);
      calls.set(payload.call_id, { id: payload.call_id, name: payload.name ?? null, raw, startedAt: record.timestamp, finishedAt: null, broadKind: broadKind(payload.name, raw) });
    } else if (record.type === "response_item" && ["custom_tool_call_output", "function_call_output"].includes(payload.type)) {
      const call = calls.get(payload.call_id);
      if (call) call.finishedAt = record.timestamp;
      const outputText = JSON.stringify(payload.output ?? "");
      if (/Script failed|Rejected\(/.test(outputText)) failures.push({ at: record.timestamp, kind: "tool-rejection", callId: payload.call_id, action: call ? actionLabel(call.raw) : "unknown tool call" });
    } else if (record.type === "event_msg" && payload.type === "item_completed" && payload.item?.type === "CommandExecution") {
      const item = payload.item;
      if (typeof item.exit_code === "number" && item.exit_code !== 0) {
        failures.push({ at: record.timestamp, kind: "command", exitCode: item.exit_code, command: Array.isArray(item.command) ? item.command.join(" ") : String(item.command ?? ""), cwd: item.cwd ?? null });
      }
    }
  }
  const usageTimeline = records.filter((record) => record.type === "token_usage_record" && record.payload?.thread_token_usage).map((record) => ({ timestamp: record.timestamp, usage: record.payload.thread_token_usage }));
  const turnGaps = turns.slice(1).flatMap((turn, index) => {
    const prior = turns[index];
    return prior.finishedAt ? [{ priorTurnId: prior.turnId, nextTurnId: turn.turnId, startedAt: prior.finishedAt, finishedAt: turn.startedAt, durationMs: elapsed(prior.finishedAt, turn.startedAt) }] : [];
  });
  return { transcript, transcriptSha256: sha256(fs.readFileSync(transcript)), sessionId: meta.id ?? sessionId, cwd: meta.cwd ?? null, nativeCliVersion: meta.cli_version ?? null, handoffAt: handoff, contexts, turns, turnGaps, executorModels: [...new Set(contexts.map((entry) => `${entry.model}:${entry.effort}`))], usageTimeline, toolIntervals: [...calls.values()], commandFailures: failures };
}

function phaseForTool(item, firstAttemptStart) {
  if (["preparation", "finalization", "verify-wrapper"].includes(item.broadKind)) return item.broadKind;
  if (item.broadKind === "focused-checks") return "focused-checks";
  if (item.broadKind === "mutation") return !firstAttemptStart || item.startedAt < firstAttemptStart ? "initial-implementation" : "repairs";
  if (item.broadKind === "observation") return !firstAttemptStart || item.startedAt < firstAttemptStart ? "preparation" : "repairs";
  return "unattributed-tool";
}

function completionAt(state, receipt) {
  return state?.completion?.completedAt ?? state?.completedAt ?? state?.finalizedAt ?? receipt?.completedAt ?? receipt?.finalizedAt ?? null;
}

function gitIdentity(root) {
  if (!root) return null;
  const result = spawnSync("git", ["show", "-s", "--format=%H%n%T", "HEAD"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) return { error: result.stderr.trim() || `git exited ${result.status}` };
  const [commit, tree] = result.stdout.trim().split("\n");
  return { commit, tree };
}

function nativeReport(file) {
  if (!file || !fs.existsSync(file)) return null;
  const bytes = fs.readFileSync(file);
  const value = JSON.parse(bytes);
  return { file, sha256: sha256(bytes), schema: value.schema ?? value.contractVersion ?? null, value };
}

function analyzeRun(input) {
  const native = transcriptMetrics(input.sessionId, input.transcriptPath);
  const state = input.statePath && fs.existsSync(input.statePath) ? readJson(input.statePath) : null;
  const receipt = input.receiptPath && fs.existsSync(input.receiptPath) ? readJson(input.receiptPath) : null;
  const stateData = state ? stateIntervals(state) : { attempts: [], suites: [], judges: [] };
  const handoffAt = input.handoffAt ?? native.handoffAt;
  const startedAt = state?.createdAt ?? state?.startedAt ?? stateData.attempts[0]?.startedAt ?? null;
  const finishedAt = completionAt(state, receipt);
  const firstAttemptStart = stateData.attempts[0]?.startedAt ?? null;
  const lastAttemptFinish = stateData.attempts.at(-1)?.finishedAt ?? null;
  const phasedTools = native.toolIntervals.map((item) => ({ ...item, phase: phaseForTool(item, firstAttemptStart) }));
  const executorUsageRecord = finishedAt
    ? native.usageTimeline.filter((entry) => entry.timestamp <= finishedAt).at(-1)
    : native.usageTimeline.at(-1);
  const byPhase = {};
  for (const phase of ["preparation", "initial-implementation", "focused-checks", "repairs", "finalization", "verify-wrapper", "unattributed-tool"]) {
    const intervals = phasedTools.filter((item) => item.phase === phase);
    byPhase[phase] = { calls: intervals.length, wallUnionMs: unionMs(intervals), resourceSumMs: intervals.reduce((sum, item) => sum + (elapsed(item.startedAt, item.finishedAt) ?? 0), 0) };
  }
  byPhase["required-suite"] = { calls: stateData.suites.length, wallUnionMs: unionMs(stateData.suites), resourceSumMs: stateData.suites.reduce((sum, item) => sum + (item.durationMs ?? 0), 0) };
  byPhase["independent-judge"] = { calls: stateData.judges.reduce((sum, item) => sum + (item.attempts ?? 1), 0), lanes: stateData.judges.length, wallUnionMs: unionMs(stateData.judges), resourceSumMs: stateData.judges.reduce((sum, item) => sum + (item.durationMs ?? 0), 0) };
  const totalWindowMs = finishedAt ? elapsed(handoffAt, finishedAt) : null;
  const preparationWindow = interval(handoffAt, startedAt);
  const preVerifyWindow = interval(startedAt, firstAttemptStart);
  const repairWindows = stateData.attempts.slice(0, -1).flatMap((attempt, index) => {
    const next = stateData.attempts[index + 1];
    return attempt.verdict !== "PASS" && interval(attempt.finishedAt, next.startedAt) ? [interval(attempt.finishedAt, next.startedAt)] : [];
  });
  const finalizationWindow = interval(lastAttemptFinish, finishedAt);
  const focusedIntervals = phasedTools.filter((item) => item.phase === "focused-checks");
  const focusedPreVerify = preVerifyWindow ? overlapsWithin(focusedIntervals, [preVerifyWindow]) : [];
  const focusedRepairs = overlapsWithin(focusedIntervals, repairWindows);
  const preparationMs = preparationWindow ? elapsed(preparationWindow.startedAt, preparationWindow.finishedAt) : null;
  const preVerifyMs = preVerifyWindow ? elapsed(preVerifyWindow.startedAt, preVerifyWindow.finishedAt) : null;
  const repairWindowMs = repairWindows.reduce((sum, item) => sum + elapsed(item.startedAt, item.finishedAt), 0);
  const focusedWallMs = unionMs([...focusedPreVerify, ...focusedRepairs]);
  const initialImplementationMs = preVerifyMs === null ? null : Math.max(0, preVerifyMs - unionMs(focusedPreVerify));
  const repairsMs = Math.max(0, repairWindowMs - unionMs(focusedRepairs));
  const finalizationMs = finalizationWindow ? elapsed(finalizationWindow.startedAt, finalizationWindow.finishedAt) : null;
  const evidenceIntervals = [...stateData.suites, ...stateData.judges];
  const categorizedIntervals = [preparationWindow, preVerifyWindow, ...repairWindows, finalizationWindow, ...evidenceIntervals].filter(Boolean);
  const categorizedUnionMs = finishedAt ? clippedUnionMs(categorizedIntervals, handoffAt, finishedAt) : null;
  const wallClockBreakdown = {
    preparationMs,
    initialImplementationMs,
    focusedChecksMs: focusedWallMs,
    requiredSuitesMs: unionMs(stateData.suites),
    independentJudgeMs: unionMs(stateData.judges),
    repairsMs,
    finalizationMs,
    suiteJudgeOverlapMs: unionMs(stateData.suites) + unionMs(stateData.judges) - unionMs(evidenceIntervals),
    unattributedMs: totalWindowMs === null || categorizedUnionMs === null ? null : Math.max(0, totalWindowMs - categorizedUnionMs),
    note: "Preparation, pre-verify implementation, repair gaps, and finalization use state boundaries. Focused checks are removed from implementation or repair windows. Suite and judge time uses interval unions; leftover time inside verification attempts is unattributed.",
  };
  const preparationFailure = native.commandFailures.find((failure) => failure.command?.includes("benchmark_report.js") && failure.command.includes("prepare-run")) ?? null;
  const preparationRetry = preparationFailure
    ? phasedTools.find((item) => item.startedAt > preparationFailure.at && item.raw.includes("benchmark_report.js") && item.raw.includes("prepare-run"))
    : null;
  const correctionAt = preparationCorrectionValue?.records?.some((record) => record.version === input.version)
    ? preparationCorrectionValue.at
    : null;
  const preparationBreakdown = preparationFailure ? {
    handoffToFailureMs: elapsed(handoffAt, preparationFailure.at),
    failureAt: preparationFailure.at,
    failureToCorrectionMs: correctionAt ? elapsed(preparationFailure.at, correctionAt) : null,
    correctionAt,
    correctionToRetryMs: preparationRetry && correctionAt ? elapsed(correctionAt, preparationRetry.startedAt) : null,
    failureToRetryMs: preparationRetry ? elapsed(preparationFailure.at, preparationRetry.startedAt) : null,
    retryAt: preparationRetry?.startedAt ?? null,
    retryToRunStartMs: preparationRetry ? elapsed(preparationRetry.startedAt, startedAt) : null,
    allocatedRunBeforeRetry: preparationCorrectionValue?.allocatedRun ?? null,
  } : null;
  const coarsePhases = {
    handoffToStateStartMs: elapsed(handoffAt, startedAt),
    stateStartToFirstVerifyMs: elapsed(startedAt, firstAttemptStart),
    verificationAttemptWallMs: stateData.attempts.reduce((sum, attempt) => sum + (attempt.durationMs ?? 0), 0),
    interAttemptRecoveryMs: repairWindowMs,
    finalVerifyToReceiptMs: finishedAt ? elapsed(lastAttemptFinish, finishedAt) : null,
    verificationNested: {
      requiredSuiteWallUnionMs: unionMs(stateData.suites),
      requiredSuiteResourceSumMs: stateData.suites.reduce((sum, item) => sum + (item.durationMs ?? 0), 0),
      judgeWallUnionMs: unionMs(stateData.judges),
      judgeResourceSumMs: stateData.judges.reduce((sum, item) => sum + (item.durationMs ?? 0), 0),
    },
  };
  const postFinalVerifyEvents = finishedAt && lastAttemptFinish
    ? phasedTools.filter((item) => item.startedAt >= lastAttemptFinish && item.startedAt <= finishedAt).map((item) => ({
      startedAt: item.startedAt,
      finishedAt: item.finishedAt,
      phase: item.phase,
      action: actionLabel(item.raw),
      failure: native.commandFailures.find((failure) => failure.callId === item.id || failure.command === item.raw) ?? null,
    }))
    : [];
  return {
    version: input.version,
    expectedContract: input.contract,
    status: state?.status ?? "STATE_NOT_AVAILABLE",
    complete: Boolean(finishedAt && receipt),
    blocker: finishedAt ? null : input.blocker ?? "run has no finalized receipt timestamp",
    clocks: {
      handoffAt,
      cliRunStartedAt: startedAt,
      receiptFinalizedAt: finishedAt,
      requestToReceiptMs: totalWindowMs,
      runToReceiptMs: finishedAt ? elapsed(startedAt, finishedAt) : null,
      observedToNowMs: finishedAt ? null : elapsed(handoffAt, new Date().toISOString()),
      wallClockBreakdown,
      preparationBreakdown,
      coarsePhases,
      postFinalVerifyEvents,
    },
    phases: byPhase,
    verification: stateData,
    failures: {
      transcriptCommands: native.commandFailures,
      verificationAttempts: stateData.attempts.filter((attempt) => attempt.verdict !== "PASS"),
      suites: stateData.suites.filter((suite) => suite.exitCode !== 0),
      judges: stateData.judges.filter((judge) => judge.verdict === "ERROR" || judge.error),
    },
    executor: {
      sessionId: native.sessionId,
      transcript: native.transcript,
      transcriptSha256: native.transcriptSha256,
      cwd: native.cwd,
      nativeCliVersion: native.nativeCliVersion,
      modelEffort: native.executorModels,
      usage: executorUsageRecord?.usage ?? null,
      usageBoundaryAt: executorUsageRecord?.timestamp ?? null,
      usageBoundary: finishedAt ? "last cumulative session usage record at or before receipt" : "latest cumulative session usage record for incomplete run",
      turns: native.turns,
      interTurnGaps: native.turnGaps,
      provenance: {
        expectedSkillPaths: input.expectedSkillPaths ?? [],
        observedExactSkillReads: (input.expectedSkillPaths ?? []).map((expected) => ({ expected, observed: native.toolIntervals.some((item) => item.raw.includes(expected) || item.raw.includes(path.relative(native.cwd ?? "/", expected))) })),
        expectedCliPath: input.expectedCliPath ?? null,
        observedPinnedCliUse: input.expectedCliPath ? native.toolIntervals.some((item) => item.raw.includes(input.expectedCliPath)) : null,
      },
    },
    judge: {
      backendModels: [...new Set(stateData.judges.map((item) => `${item.backend}:${item.model}:${item.effort ?? "unknown-effort"}`))],
      usage: stateData.judges.reduce((total, item) => {
        for (const [source, target] of [["inputTokens", "inputTokens"], ["outputTokens", "outputTokens"], ["cachedInputTokens", "cachedInputTokens"], ["reasoningOutputTokens", "reasoningOutputTokens"]]) total[target] += item.usage?.[source] ?? 0;
        return total;
      }, { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0 }),
      usageCoverage: {
        lanesWithUsage: stateData.judges.filter((item) => item.usage).length,
        lanesWithoutUsage: stateData.judges.filter((item) => !item.usage).length,
        actualCallsRepresentedByUsage: stateData.judges.filter((item) => item.usage).reduce((sum, item) => sum + (item.attempts ?? 1), 0),
        actualCallsWithoutUsage: stateData.judges.filter((item) => !item.usage).reduce((sum, item) => sum + (item.attempts ?? 1), 0),
      },
    },
    source: {
      launcherRoot: input.launcherRoot ?? null,
      launcherIdentity: gitIdentity(input.launcherRoot),
      workingRoot: input.workingRoot ?? null,
      statePath: input.statePath ?? null,
      receiptPath: input.receiptPath ?? null,
      fileHashes: Object.fromEntries(Object.entries(input.sourceFiles ?? {}).map(([name, file]) => [name, { file, sha256: fs.existsSync(file) ? sha256(fs.readFileSync(file)) : null }])),
    },
    receipt: receipt ? {
      schema: receipt.schema ?? null,
      status: receipt.status ?? null,
      completedAt: receipt.completedAt ?? null,
      sourceFingerprint: receipt.sourceFingerprint ?? null,
      completionFingerprint: receipt.completionFingerprint ?? null,
      verificationAttemptId: receipt.verificationAttemptId ?? null,
    } : null,
    metadataPathDiscrepancy: input.predictedStatePath && input.statePath && path.resolve(input.predictedStatePath) !== path.resolve(input.statePath)
      ? { predictedStatePath: input.predictedStatePath, actualStatePath: input.statePath, preserved: true }
      : null,
    nativeReport: nativeReport(input.nativeReportPath),
  };
}

function behaviorTexts(prdPath) {
  if (!prdPath || !fs.existsSync(prdPath)) return null;
  return fs.readFileSync(prdPath, "utf8").split("\n").flatMap((line) => {
    if (!/^\|\s*B\d+\s*\|/.test(line)) return [];
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    return [{ id: cells[0], text: cells[1] }];
  });
}

const runs = config.runs.map(analyzeRun);
const behaviorSets = Object.fromEntries(config.runs.map((run) => [run.version, behaviorTexts(run.prdPath)]));
const behaviorValues = Object.values(behaviorSets).filter(Boolean);
const result = {
  schema: "sasu.full-implementation-process-analysis.v1",
  generatedAt: new Date().toISOString(),
  scope: "Observable assistant and tool events plus CLI state and receipt fields. Reasoning content is not read or reported.",
  comparisonBoundary: {
    exploratoryPairOnly: true,
    implementationSpeedEstimate: false,
    nativeReportsCrossSchemaComparable: false,
    note: "Old benchmark-run/report v1 and new v2 remain intact under nativeReport. This analysis normalizes clocks and counts from transcripts and states without presenting either native report as schema-compatible with the other.",
  },
  semanticAnchor: {
    behaviorTexts: behaviorSets,
    sixTextsExactlyEqual: behaviorValues.length === 2 && JSON.stringify(behaviorValues[0]) === JSON.stringify(behaviorValues[1]),
    sharedProductBaseExpected: config.sharedProductBase ?? null,
    starterHashes: config.starterHashes ?? null,
  },
  preparationCorrection: preparationCorrectionValue
    ? { file: config.preparationCorrectionPath, sha256: sha256(fs.readFileSync(config.preparationCorrectionPath)), value: preparationCorrectionValue }
    : null,
  nativeReportAttempts: (config.nativeReportAttempts ?? []).map((file) => ({
    file,
    sha256: sha256(fs.readFileSync(file)),
    value: readJson(file),
  })),
  runs,
};
result.outputHashComparison = Object.fromEntries([...new Set(runs.flatMap((run) => Object.keys(run.source.fileHashes)))].map((name) => {
  const hashes = Object.fromEntries(runs.map((run) => [run.version, run.source.fileHashes[name]?.sha256 ?? null]));
  return [name, { hashes, exactlyEqual: runs.length === 2 && new Set(Object.values(hashes)).size === 1 }];
}));
if (config.runs.length === 2) {
  const [left, right] = config.runs;
  result.outputRelationships = {};
  for (const name of [...new Set([...Object.keys(left.sourceFiles ?? {}), ...Object.keys(right.sourceFiles ?? {})])]) {
    const leftFile = left.sourceFiles?.[name];
    const rightFile = right.sourceFiles?.[name];
    if (!leftFile || !rightFile || !fs.existsSync(leftFile) || !fs.existsSync(rightFile)) continue;
    const leftBytes = fs.readFileSync(leftFile);
    const rightBytes = fs.readFileSync(rightFile);
    result.outputRelationships[name] = {
      leftBytes: leftBytes.length,
      rightBytes: rightBytes.length,
      exactlyEqual: leftBytes.equals(rightBytes),
      rightStartsWithExactLeftBytes: rightBytes.length >= leftBytes.length && rightBytes.subarray(0, leftBytes.length).equals(leftBytes),
    };
  }
}

fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.writeFileSync(path.resolve(outPath), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ out: path.resolve(outPath), runs: runs.map((run) => ({ version: run.version, status: run.status, complete: run.complete, blocker: run.blocker })) }, null, 2)}\n`);
