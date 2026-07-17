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
import { runPrelint, type PrelintResult } from "./prelint";
import {
  GAP_AUDIT_LANES,
  SPEC_LANES,
  gapAuditPrompt,
  semanticVerifyPrompt,
  specGatePrompt,
  type JudgeLane,
  type PriorFinding,
} from "./prompts";
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
  /** Deterministic pre-judge lint result; separate from judge findings by design (D-10). */
  prelint?: PrelintResult;
  mechanical?: MechanicalResult;
  criteria?: { id: string; verdict: "PASS" | "FAIL"; reason: string }[];
  error?: { code: string; message: string; recovery: string };
}

/**
 * A prelint failure blocks without touching gate state: no judge call, no
 * attempt consumed, no verdict recorded (D-02). The status view reflects
 * whatever the gate's last judged state was.
 */
function prelintBlock(
  projectRoot: string,
  config: CheckshirtConfig,
  topic: string,
  gate: GateId,
  prelint: PrelintResult,
): GateCommandResult {
  const store = new GateStore(projectRoot, topic);
  return { ok: false, status: gateStatus(store.load(), gate, config.judge.retryBudget, projectRoot), prelint };
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

/**
 * Reasoning-effort cap for lane judges. A lane owns a narrow scope, so a low
 * budget preserved mine detection in calibration while cutting a ~52s call
 * to ~13s. The single-judge path (judge.fanout: false) keeps the backend's
 * default effort. Claude-only; codex/stub backends ignore it.
 */
const LANE_EFFORT = "low";

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

/**
 * Mechanical lane merge (PRD judge-fanout R3, D-08): union of lane findings,
 * normalized-string dedupe keeping the higher severity, and a verdict derived
 * purely from the merged findings - any blocking-grade (P0/P1) finding means
 * BLOCK, an all-advisory (or empty) merge means PASS. Near-duplicates phrased
 * differently across lanes are an accepted tradeoff observed in calibration.
 */
export function mergeLaneFindings(lanes: { laneId: string; findings: Finding[] }[]): {
  verdict: "PASS" | "BLOCK";
  findings: Finding[];
  dedupedCount: number;
  laneFindingCounts: Record<string, number>;
} {
  const severityRank: Record<string, number> = { P0: 0, P1: 1, P2: 2 };
  const seen = new Map<string, Finding>();
  const laneFindingCounts: Record<string, number> = {};
  let dedupedCount = 0;
  for (const lane of lanes) {
    laneFindingCounts[lane.laneId] = lane.findings.length;
    for (const finding of lane.findings) {
      const key = finding.missing
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
      const existing = seen.get(key);
      if (!existing) {
        seen.set(key, finding);
      } else {
        dedupedCount += 1;
        if ((severityRank[finding.severity] ?? 3) < (severityRank[existing.severity] ?? 3)) {
          seen.set(key, finding);
        }
      }
    }
  }
  const findings = [...seen.values()];
  const verdict = findings.some((f) => f.severity !== "P2") ? "BLOCK" : "PASS";
  return { verdict, findings, dedupedCount, laneFindingCounts };
}

/**
 * Route prior findings to lanes for the re-run convergence contract (D-09):
 * a prior finding goes to every lane whose areaHints match its area; a
 * finding matching no lane goes to every lane so it cannot be dropped.
 */
export function routePriorFindings(
  priorFindings: PriorFinding[],
  lanes: JudgeLane[],
): Map<string, PriorFinding[]> {
  const routed = new Map<string, PriorFinding[]>(lanes.map((lane) => [lane.id, []]));
  for (const finding of priorFindings) {
    const area = finding.area.toLowerCase();
    const matches = lanes.filter((lane) => lane.areaHints.some((hint) => area.includes(hint)));
    for (const lane of matches.length > 0 ? matches : lanes) {
      routed.get(lane.id)!.push(finding);
    }
  }
  return routed;
}

async function runGapListGate(
  projectRoot: string,
  config: CheckshirtConfig,
  topic: string,
  gate: Extract<GateId, "gap-audit" | "spec">,
  buildPrompt: (
    priorFindings: PriorFinding[],
    options: { lane?: JudgeLane; laneCount?: number; rerun?: boolean },
  ) => string,
  purpose: string,
  inputs: GateInput[],
): Promise<GateCommandResult> {
  const store = new GateStore(projectRoot, topic);
  let state = store.load();
  const records: JudgeCallRecord[] = [];
  try {
    const priorFindings = priorFindingsFor(state, gate);
    // Convergence applies to EVERY re-run, including one after a PASS went
    // STALE: the E2E rehearsal (2026-07-17) showed a harmless post-PASS
    // append producing fresh P1 blockers on re-judgment. Once a document has
    // passed, only an unresolved prior finding or a new P0 may re-block it.
    const isRerun = state.gates[gate] !== undefined && state.gates[gate].verdict !== null;

    if (!config.judge.fanout) {
      // Single-judge path, unchanged (judge.fanout: false escape hatch, R5).
      const outcome = await runJudge(config, purpose, "frugal", buildPrompt(priorFindings, { rerun: isRerun }), (value) =>
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
    }

    // Lane-parallel fan-out (R1/R2): narrow judges run concurrently and the
    // CLI merges mechanically. One fan-out round is one gate attempt.
    // Lanes run at low effort: calibration showed judge wall time is a flat
    // per-call reasoning budget (a full-effort lane costs as much as the
    // exhaustive single judge), so the narrow scope is paired with a small
    // budget - that pairing, not parallelism alone, is what halves the gate.
    const lanes = gate === "gap-audit" ? GAP_AUDIT_LANES : SPEC_LANES;
    const routedPrior = routePriorFindings(priorFindings, lanes);
    const settled = await Promise.all(
      lanes.map(async (lane) => {
        try {
          const outcome = await runJudge(
            config,
            `${purpose}:lane:${lane.id}`,
            "frugal",
            buildPrompt(routedPrior.get(lane.id) ?? [], { lane, laneCount: lanes.length, rerun: isRerun }),
            (value) => validateGapVerdict(value, { requireOrigin: isRerun }),
            { effort: LANE_EFFORT },
          );
          return { laneId: lane.id, outcome, error: null };
        } catch (error) {
          return { laneId: lane.id, outcome: null, error };
        }
      }),
    );
    for (const lane of settled) {
      if (lane.outcome) records.push(lane.outcome.record);
      else {
        const failureRecord = judgeCallRecordFrom(lane.error);
        if (failureRecord) records.push(failureRecord);
      }
    }
    const failures = settled.filter((lane) => lane.error !== null);
    if (failures.length > 0) {
      // Fail-closed on any lane failure (D-08/D-13/D-14): rate limits,
      // timeouts, and invalid output all land here, named by lane.
      const first = failures[0]!.error;
      const code = first instanceof JudgeError ? first.code : "judge-auth-or-runtime";
      const backend = first instanceof JudgeError ? first.backend : "claude";
      const detail = first instanceof Error ? first.message : String(first);
      const laneList = failures.map((lane) => lane.laneId).join(", ");
      const laneError = new JudgeError(code, backend, `lane failed [${laneList}]: ${detail}`);
      return recordJudgeFailure(store, state, gate, config, laneError, records, topic);
    }
    const merged = mergeLaneFindings(
      settled.map((lane) => ({ laneId: lane.laneId, findings: lane.outcome!.value.findings })),
    );
    const converged = isRerun
      ? applyRerunConvergence({ verdict: merged.verdict, findings: merged.findings })
      : { verdict: merged.verdict, findings: merged.findings, demotedCount: 0 };
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
          judgedVerdict: merged.verdict,
          demotedCount: converged.demotedCount,
          dedupedCount: merged.dedupedCount,
          findings: converged.findings,
          lanes: settled.map((lane) => ({
            laneId: lane.laneId,
            verdict: lane.outcome!.value.verdict,
            findingCount: lane.outcome!.value.findings.length,
            judge: lane.outcome!.record,
          })),
          inputs,
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

export async function runGapAudit(
  projectRoot: string,
  config: CheckshirtConfig,
  topic: string,
  qaLogPath: string,
): Promise<GateCommandResult> {
  const qaLog = readInputFile(projectRoot, qaLogPath, "qa-log");
  const prelint = runPrelint("qa-log", qaLog.content);
  if (!prelint.ok) return prelintBlock(projectRoot, config, topic, "gap-audit", prelint);
  const result = await runGapListGate(
    projectRoot,
    config,
    topic,
    "gap-audit",
    (prior, options) => gapAuditPrompt(qaLog.content, prior, options),
    "gate:gap-audit",
    [qaLog.input],
  );
  return { ...result, prelint };
}

export async function runSpecGate(
  projectRoot: string,
  config: CheckshirtConfig,
  topic: string,
  prdPath: string,
  qaLogPath: string,
): Promise<GateCommandResult> {
  const prd = readInputFile(projectRoot, prdPath, "prd");
  const qaLog = readInputFile(projectRoot, qaLogPath, "qa-log");
  const prelint = runPrelint("prd", prd.content);
  if (!prelint.ok) return prelintBlock(projectRoot, config, topic, "spec", prelint);
  const result = await runGapListGate(
    projectRoot,
    config,
    topic,
    "spec",
    (prior, options) => specGatePrompt(prd.content, qaLog.content, prior, options),
    "gate:spec",
    [prd.input, qaLog.input],
  );
  return { ...result, prelint };
}

export interface VerifyOptions {
  prdPath?: string;
  criteria?: { id: string; text: string }[];
  diffFile?: string;
  baseRef?: string;
  skipMechanical?: boolean;
}

export async function runVerifyGate(
  projectRoot: string,
  config: CheckshirtConfig,
  topic: string,
  options: VerifyOptions,
): Promise<GateCommandResult> {
  const store = new GateStore(projectRoot, topic);
  let state = store.load();
  const records: JudgeCallRecord[] = [];
  // Read the PRD up front so a bad --prd path fails before any command spend,
  // and its hash is pinned for freshness tracking. The diff is deliberately
  // not a freshness input: it changes with every fix loop by design.
  const prdFile = options.prdPath !== undefined ? readInputFile(projectRoot, options.prdPath, "prd") : null;
  const inputs = prdFile ? [prdFile.input] : [];

  // Stage 0: PRD prelint ($0, D-06). The judge reads this PRD's acceptance
  // criteria, so a structurally broken PRD blocks before the mechanical
  // commands even run - there is no point testing code against a broken
  // contract, and the fix loop must stay free.
  let prelint: PrelintResult | undefined;
  if (prdFile) {
    prelint = runPrelint("prd", prdFile.content);
    if (!prelint.ok) return prelintBlock(projectRoot, config, topic, "verify", prelint);
  }

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
      return { ok: false, status: gateStatus(state, "verify", config.judge.retryBudget, projectRoot), prelint, mechanical };
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
    const outcome = await runJudge(
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
    return { ok: status.effective === "PASS", status, prelint, mechanical, criteria: outcome.value.criteria };
  } catch (error) {
    return { ...recordJudgeFailure(store, state, "verify", config, error, records, topic), prelint };
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
