import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { CheckshirtConfig } from "../config";
import { runJudge, judgeCallRecordFrom } from "../judge/runner";
import {
  JudgeError,
  validateGapVerdict,
  validateSemanticVerdict,
  type Finding,
  type GapVerdict,
  type JudgeCallRecord,
} from "../judge/types";
import { runMechanical, type MechanicalResult } from "../mechanical";
import { gapAuditPrompt, semanticVerifyPrompt, specGatePrompt } from "./prompts";
import {
  freshnessHash,
  GateStore,
  gateStatus,
  overrideGate,
  recordGateResult,
  type GateId,
  type GateInput,
  type GateStatusView,
} from "./store";

export interface GateCommandResult {
  ok: boolean;
  status: GateStatusView;
  mechanical?: MechanicalResult;
  criteria?: { id: string; verdict: "PASS" | "FAIL"; reason: string }[];
  error?: { code: string; message: string; recovery: string };
}

function readTextFile(projectRoot: string, filePath: string, label: string): string {
  const resolved = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
  return fs.readFileSync(resolved, "utf8");
}

interface InputFile {
  content: string;
  input: GateInput;
}

/** Read a gate input document and pin its freshness hash (body substance, not lifecycle bookkeeping). */
function readInputFile(projectRoot: string, filePath: string, label: string): InputFile {
  const content = readTextFile(projectRoot, filePath, label);
  const resolved = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
  return { content, input: { path: path.relative(projectRoot, resolved), sha256: freshnessHash(content) } };
}

function overrideRecovery(topic: string, gate: GateId): string {
  return `To proceed anyway, the USER (never the agent) may run: checkshirt gate override --slug ${topic} --gate ${gate} --reason "<why>"`;
}

/**
 * Prior-round findings for the delta re-judgment contract: only carried when
 * the last run actually blocked, so a fresh document is judged fresh.
 */
function priorFindingsFor(state: ReturnType<GateStore["load"]>, gate: GateId) {
  const record = state.gates[gate];
  if (!record || record.verdict === null || record.verdict === "PASS") return [];
  return record.findings.map((f) => ({ severity: f.severity, area: f.area, missing: f.missing }));
}

/**
 * Mechanical convergence rule for re-runs (anti progressive-discovery): only
 * an unresolved prior finding or a NEW P0 may block. Any other new finding is
 * demoted to a non-blocking P2 advisory - recorded, never gate-holding. This
 * moves the convergence guarantee from prompt hope to CLI enforcement.
 */
export function applyRerunConvergence(judged: GapVerdict): {
  verdict: "PASS" | "BLOCK";
  findings: Finding[];
  demotedCount: number;
} {
  const findings: Finding[] = [];
  let blocking = 0;
  let demotedCount = 0;
  for (const finding of judged.findings) {
    const canBlock = finding.origin === "prior-unresolved" || (finding.origin === "new" && finding.severity === "P0");
    if (canBlock && finding.severity !== "P2") {
      blocking += 1;
      findings.push(finding);
    } else if (finding.severity === "P2") {
      findings.push(finding);
    } else {
      demotedCount += 1;
      findings.push({
        ...finding,
        severity: "P2",
        requiresHuman: false,
        recommendation: `[auto-demoted: new non-P0 finding on a re-run cannot block] ${finding.recommendation}`,
      });
    }
  }
  return { verdict: blocking > 0 ? "BLOCK" : "PASS", findings, demotedCount };
}

function runGapListGate(
  projectRoot: string,
  config: CheckshirtConfig,
  topic: string,
  gate: Extract<GateId, "gap-audit" | "spec">,
  buildPrompt: (priorFindings: { severity: string; area: string; missing: string }[]) => string,
  purpose: string,
  inputs: GateInput[],
): GateCommandResult {
  const store = new GateStore(projectRoot, topic);
  let state = store.load();
  const records: JudgeCallRecord[] = [];
  try {
    const priorFindings = priorFindingsFor(state, gate);
    const isRerun = priorFindings.length > 0;
    const outcome = runJudge(config, purpose, "frugal", buildPrompt(priorFindings), (value) =>
      validateGapVerdict(value, { requireOrigin: isRerun }),
    );
    records.push(outcome.record);
    const converged = isRerun ? applyRerunConvergence(outcome.value) : { ...outcome.value, demotedCount: 0 };
    state = recordGateResult(
      store,
      state,
      gate,
      {
        kind: "verdict",
        verdict: converged.verdict,
        findings: converged.findings,
        inputs,
        artifactPayload: {
          verdict: converged.verdict,
          judgedVerdict: outcome.value.verdict,
          demotedCount: converged.demotedCount,
          findings: converged.findings,
          inputs,
          judge: outcome.record,
        },
      },
      records,
    );
    const status = gateStatus(state, gate, config.judge.retryBudget, projectRoot);
    return { ok: status.effective === "PASS", status };
  } catch (error) {
    return recordJudgeFailure(store, state, gate, config, error, records, topic);
  }
}

export function runGapAudit(
  projectRoot: string,
  config: CheckshirtConfig,
  topic: string,
  qaLogPath: string,
): GateCommandResult {
  const qaLog = readInputFile(projectRoot, qaLogPath, "qa-log");
  return runGapListGate(
    projectRoot,
    config,
    topic,
    "gap-audit",
    (prior) => gapAuditPrompt(qaLog.content, prior),
    "gate:gap-audit",
    [qaLog.input],
  );
}

export function runSpecGate(
  projectRoot: string,
  config: CheckshirtConfig,
  topic: string,
  prdPath: string,
  qaLogPath: string,
): GateCommandResult {
  const prd = readInputFile(projectRoot, prdPath, "prd");
  const qaLog = readInputFile(projectRoot, qaLogPath, "qa-log");
  return runGapListGate(
    projectRoot,
    config,
    topic,
    "spec",
    (prior) => specGatePrompt(prd.content, qaLog.content, prior),
    "gate:spec",
    [prd.input, qaLog.input],
  );
}

export interface VerifyOptions {
  prdPath?: string;
  criteria?: { id: string; text: string }[];
  diffFile?: string;
  baseRef?: string;
  skipMechanical?: boolean;
}

export function runVerifyGate(
  projectRoot: string,
  config: CheckshirtConfig,
  topic: string,
  options: VerifyOptions,
): GateCommandResult {
  const store = new GateStore(projectRoot, topic);
  let state = store.load();
  const records: JudgeCallRecord[] = [];
  // Read the PRD up front so a bad --prd path fails before any command spend,
  // and its hash is pinned for freshness tracking. The diff is deliberately
  // not a freshness input: it changes with every fix loop by design.
  const prdFile = options.prdPath !== undefined ? readInputFile(projectRoot, options.prdPath, "prd") : null;
  const inputs = prdFile ? [prdFile.input] : [];

  // Stage 1: mechanical ($0). A failure here never reaches the judge (UX-02).
  let mechanical: MechanicalResult | undefined;
  if (!options.skipMechanical) {
    mechanical = runMechanical(projectRoot, config);
    if (!mechanical.ok) {
      state = recordGateResult(
        store,
        state,
        "verify",
        {
          kind: "verdict",
          verdict: "FAIL",
          findings: mechanical.runs
            .filter((r) => !r.ok)
            .map((r) => ({
              area: "mechanical",
              severity: "P0" as const,
              missing: `${r.kind} failed (exit ${r.exitCode}): ${r.command}`,
              recommendation: "Fix the failing check and re-run checkshirt verify.",
              requiresHuman: false,
            })),
          inputs,
          artifactPayload: { stage: "mechanical", runs: mechanical.runs },
        },
        records,
      );
      return { ok: false, status: gateStatus(state, "verify", config.judge.retryBudget, projectRoot), mechanical };
    }
  }

  // Stage 2: semantic judge over the diff.
  if (!options.criteria && !prdFile) {
    throw new Error("prd not found: pass --prd <path> so acceptance criteria can be extracted");
  }
  const criteria = options.criteria ?? extractAcceptanceCriteria(prdFile!.content);
  if (criteria.length === 0) {
    throw new Error("no acceptance criteria found (expected '## 7. Acceptance Criteria' with '- AC#.' items)");
  }
  const diff = options.diffFile
    ? readTextFile(projectRoot, options.diffFile, "diff file")
    : gitDiff(projectRoot, options.baseRef);
  if (diff.trim() === "") {
    throw new Error("empty diff: nothing to verify (use --base <ref> or --diff-file <path>)");
  }
  try {
    const outcome = runJudge(
      config,
      "gate:verify-semantic",
      "standard",
      semanticVerifyPrompt(diff, criteria),
      (value) => validateSemanticVerdict(value, criteria.map((c) => c.id)),
    );
    records.push(outcome.record);
    const findings: Finding[] = outcome.value.criteria
      .filter((c) => c.verdict === "FAIL")
      .map((c) => ({
        area: "semantic",
        severity: "P0" as const,
        missing: `${c.id}: ${c.reason}`,
        recommendation: "Address the criterion and re-run checkshirt verify.",
        requiresHuman: false,
      }));
    state = recordGateResult(
      store,
      state,
      "verify",
      {
        kind: "verdict",
        verdict: outcome.value.verdict === "PASS" ? "PASS" : "FAIL",
        findings,
        inputs,
        artifactPayload: {
          stage: "semantic",
          verdict: outcome.value.verdict,
          criteria: outcome.value.criteria,
          mechanical: mechanical?.runs ?? "skipped",
          inputs,
          judge: outcome.record,
        },
      },
      records,
    );
    const status = gateStatus(state, "verify", config.judge.retryBudget, projectRoot);
    return { ok: status.effective === "PASS", status, mechanical, criteria: outcome.value.criteria };
  } catch (error) {
    return recordJudgeFailure(store, state, "verify", config, error, records, topic);
  }
}

function recordJudgeFailure(
  store: GateStore,
  state: ReturnType<GateStore["load"]>,
  gate: GateId,
  config: CheckshirtConfig,
  error: unknown,
  records: JudgeCallRecord[],
  topic: string,
): GateCommandResult {
  if (!(error instanceof JudgeError)) throw error;
  const failureRecord = judgeCallRecordFrom(error);
  if (failureRecord) records.push(failureRecord);
  state = recordGateResult(store, state, gate, { kind: "error", message: error.message }, records);
  const recoveryByCode: Record<string, string> = {
    "judge-binary-missing": "Install the judge CLI (claude or codex) or set judge.backend in agents/config.json.",
    "judge-auth-or-runtime": "Check the judge CLI login/auth status and re-run.",
    "judge-timeout": "Re-run; if it persists, raise judge.timeoutMs in agents/config.json.",
    "judge-invalid-output": "Re-run; if it persists, try a stronger tier model via judge.tierModels.",
  };
  return {
    ok: false,
    status: gateStatus(state, gate, config.judge.retryBudget, store.projectRoot),
    error: {
      code: error.code,
      message: error.message,
      recovery: `${recoveryByCode[error.code] ?? "Re-run after fixing the cause."} ${overrideRecovery(topic, gate)}`,
    },
  };
}

export function runOverride(
  projectRoot: string,
  topic: string,
  gate: GateId,
  reason: string,
): GateStatusView {
  const store = new GateStore(projectRoot, topic);
  const state = overrideGate(store, store.load(), gate, reason);
  return gateStatus(state, gate, Number.MAX_SAFE_INTEGER, projectRoot);
}

export function readGateStatus(
  projectRoot: string,
  config: CheckshirtConfig,
  topic: string,
): Record<GateId, GateStatusView> & { judgeCallCount: number } {
  const store = new GateStore(projectRoot, topic);
  const state = store.load();
  return {
    "gap-audit": gateStatus(state, "gap-audit", config.judge.retryBudget, projectRoot),
    spec: gateStatus(state, "spec", config.judge.retryBudget, projectRoot),
    verify: gateStatus(state, "verify", config.judge.retryBudget, projectRoot),
    judgeCallCount: state.judgeCalls.length,
  };
}

export function extractAcceptanceCriteria(prdContent: string): { id: string; text: string }[] {
  const lines = prdContent.split("\n");
  const criteria: { id: string; text: string }[] = [];
  let inSection = false;
  let current: { id: string; text: string } | null = null;
  for (const line of lines) {
    if (/^##\s+7\./.test(line) || /^##\s+Acceptance Criteria/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s/.test(line)) break;
    if (!inSection) continue;
    const match = line.match(/^-\s+(AC\d+)\.\s+(.*)$/);
    if (match && match[1] !== undefined && match[2] !== undefined) {
      current = { id: match[1], text: match[2].trim() };
      criteria.push(current);
    } else if (current && /^\s+\S/.test(line)) {
      current.text += ` ${line.trim()}`;
    } else {
      current = null;
    }
  }
  return criteria;
}

function gitDiff(projectRoot: string, baseRef: string | undefined): string {
  const args = baseRef ? ["diff", baseRef, "--", "."] : ["diff", "HEAD", "--", "."];
  return execFileSync("git", args, { cwd: projectRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}
