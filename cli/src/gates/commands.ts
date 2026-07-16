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
  type JudgeCallRecord,
} from "../judge/types";
import { runMechanical, type MechanicalResult } from "../mechanical";
import { gapAuditPrompt, semanticVerifyPrompt, specGatePrompt } from "./prompts";
import { GateStore, gateStatus, overrideGate, recordGateResult, type GateId, type GateStatusView } from "./store";

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

function overrideRecovery(topic: string, gate: GateId): string {
  return `To proceed anyway, the USER (never the agent) may run: checkshirt gate override --slug ${topic} --gate ${gate} --reason "<why>"`;
}

function runGapListGate(
  projectRoot: string,
  config: CheckshirtConfig,
  topic: string,
  gate: Extract<GateId, "gap-audit" | "spec">,
  prompt: string,
  purpose: string,
): GateCommandResult {
  const store = new GateStore(projectRoot, topic);
  let state = store.load();
  const records: JudgeCallRecord[] = [];
  try {
    const outcome = runJudge(config, purpose, "frugal", prompt, validateGapVerdict);
    records.push(outcome.record);
    state = recordGateResult(
      store,
      state,
      gate,
      {
        kind: "verdict",
        verdict: outcome.value.verdict,
        findings: outcome.value.findings,
        artifactPayload: { verdict: outcome.value.verdict, findings: outcome.value.findings, judge: outcome.record },
      },
      records,
    );
    const status = gateStatus(state, gate, config.judge.retryBudget);
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
  const qaLog = readTextFile(projectRoot, qaLogPath, "qa-log");
  return runGapListGate(projectRoot, config, topic, "gap-audit", gapAuditPrompt(qaLog), "gate:gap-audit");
}

export function runSpecGate(
  projectRoot: string,
  config: CheckshirtConfig,
  topic: string,
  prdPath: string,
  qaLogPath: string,
): GateCommandResult {
  const prd = readTextFile(projectRoot, prdPath, "prd");
  const qaLog = readTextFile(projectRoot, qaLogPath, "qa-log");
  return runGapListGate(projectRoot, config, topic, "spec", specGatePrompt(prd, qaLog), "gate:spec");
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
          artifactPayload: { stage: "mechanical", runs: mechanical.runs },
        },
        records,
      );
      return { ok: false, status: gateStatus(state, "verify", config.judge.retryBudget), mechanical };
    }
  }

  // Stage 2: semantic judge over the diff.
  const criteria = options.criteria ?? extractAcceptanceCriteria(readTextFile(projectRoot, options.prdPath ?? "", "prd"));
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
        artifactPayload: {
          stage: "semantic",
          verdict: outcome.value.verdict,
          criteria: outcome.value.criteria,
          mechanical: mechanical?.runs ?? "skipped",
          judge: outcome.record,
        },
      },
      records,
    );
    const status = gateStatus(state, "verify", config.judge.retryBudget);
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
    status: gateStatus(state, gate, config.judge.retryBudget),
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
  return gateStatus(state, gate, Number.MAX_SAFE_INTEGER);
}

export function readGateStatus(
  projectRoot: string,
  config: CheckshirtConfig,
  topic: string,
): Record<GateId, GateStatusView> & { judgeCallCount: number } {
  const store = new GateStore(projectRoot, topic);
  const state = store.load();
  return {
    "gap-audit": gateStatus(state, "gap-audit", config.judge.retryBudget),
    spec: gateStatus(state, "spec", config.judge.retryBudget),
    verify: gateStatus(state, "verify", config.judge.retryBudget),
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
