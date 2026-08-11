import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { SasuConfig } from "../config";
import { resolveBackend } from "../judge/backends";
import { runJudge, judgeCallRecordFrom } from "../judge/runner";
import {
  JudgeError,
  validateGapVerdict,
  validateSemanticVerdict,
  type CriterionVerdict,
  type Finding,
  type GapVerdict,
  type JudgeCallRecord,
} from "../judge/types";
import { runMechanical, type MechanicalResult, type ResolvedCommand } from "../mechanical";
import { EVIDENCE_MAX_BYTES, parseContract, type ParsedContract } from "./contract";
import { runPrelint, type PrelintResult } from "./prelint";
import {
  GAP_AUDIT_LANES,
  SPEC_LANES,
  VERIFY_DIFF_MAX_CHARS,
  agenticSemanticVerifyPrompt,
  gapAuditPrompt,
  semanticVerifyPrompt,
  specGatePrompt,
  type CheckResult,
  type EvidenceMaterial,
  type JudgeLane,
  type PriorFinding,
} from "./prompts";
import {
  freshnessHash,
  GateStore,
  gateStatus,
  overrideGate,
  recordGateResult,
  sha256Of,
  type GateId,
  type GateInput,
  type GateStatusView,
  type VouchedTreeFingerprint,
} from "./store";

export interface GateCommandResult {
  ok: boolean;
  status: GateStatusView;
  /** Deterministic pre-judge lint result; separate from judge findings by design (D-10). */
  prelint?: PrelintResult;
  mechanical?: MechanicalResult;
  /** Per-criterion verdicts: the judge's for judged criteria, the harness's for oracle-backed ones. */
  criteria?: CriterionVerdict[];
  /**
   * Changed files no task's Scope glob claims (only computed when the PRD
   * declares any Scope): the mechanized first step of the unmapped-scope
   * hard-stop - a loud warning today, not yet a block.
   */
  unscopedFiles?: string[];
  /**
   * Everything the receipt has to quote, so it can be written from this output
   * alone instead of reaching into gate state: what was pinned, which criteria
   * the judge actually saw, and what the judge said before the human lane was
   * folded in.
   */
  inputs?: GateInput[];
  evidence?: Omit<EvidenceMaterial, "text">[];
  checks?: CheckResult[];
  judgedCriteriaIds?: string[];
  judgedVerdict?: "PASS" | "FAIL";
  /**
   * True when the verify gate passed without a single judge call (every AC
   * oracle-backed): the record is honest, but the receipt must be able to say
   * "no model ever read this diff" without re-deriving it from lane counts.
   */
  zeroJudgeCalls?: boolean;
  /**
   * Set when the verify gate resolved ZERO mechanical commands without
   * --skip-mechanical: an empty runs list looks like success, but it means the
   * promised $0 pre-judge filter was silently inactive (audited run 2026-08:
   * package.json lived under app/, nothing was detected, and every failure was
   * discovered by the paid judge instead).
   */
  mechanicalWarning?: string;
  error?: { code: string; message: string; recovery: string };
}

/**
 * A prelint failure blocks without touching gate state: no judge call, no
 * attempt consumed, no verdict recorded (D-02). The status view reflects
 * whatever the gate's last judged state was.
 */
function prelintBlock(
  projectRoot: string,
  config: SasuConfig,
  topic: string,
  gate: GateId,
  prelint: PrelintResult,
): GateCommandResult {
  const store = new GateStore(projectRoot, topic);
  return { ok: false, status: gateStatus(store.load(), gate, config.judge.retryBudget, projectRoot), prelint };
}

/**
 * Non-blocking prelint advisories go to stderr the way the gate's other
 * warnings do: the document may legitimately mean what it says (never a
 * block), but the author must hear it before the verdict, not after.
 */
function emitPrelintWarnings(prelint: PrelintResult): void {
  for (const advisory of prelint.warnings ?? []) {
    const where = advisory.line !== null ? `:${advisory.line}` : "";
    process.stderr.write(`sasu: WARNING: prelint ${advisory.rule}${where}: ${advisory.missing} ${advisory.recommendation}\n`);
  }
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

/**
 * Deterministic criterion partition for the verify fan-out: stable document
 * order, lane sizes balanced under a cap of 8, last lane may be smaller
 * (27 criteria -> 7/7/7/6). The cap exists because the audited single call
 * concentrated 27 criteria plus the whole diff into one prompt and the judge's
 * attention visibly ran out; 6-8 criteria is the scope one lane can hold.
 */
export const VERIFY_LANE_MAX_CRITERIA = 8;

export function partitionVerifyCriteria<T>(criteria: T[]): T[][] {
  if (criteria.length === 0) return [];
  const laneCount = Math.ceil(criteria.length / VERIFY_LANE_MAX_CRITERIA);
  const size = Math.ceil(criteria.length / laneCount);
  const lanes: T[][] = [];
  for (let i = 0; i < criteria.length; i += size) lanes.push(criteria.slice(i, i + size));
  return lanes;
}

function overrideRecovery(topic: string, gate: GateId): string {
  return `To proceed anyway, the USER (never the agent) may run: sasu gate override --slug ${topic} --gate ${gate} --reason "<why>"`;
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
 * A finding that explicitly requires a human decision can never remain a P2
 * advisory. Normalizing it to P1 keeps all fresh and re-run paths fail-closed
 * even when a judge underestimates its severity.
 */
export function enforceHumanBlocking(judged: GapVerdict): GapVerdict {
  const findings = judged.findings.map((finding) =>
    finding.requiresHuman && finding.severity === "P2"
      ? {
          ...finding,
          severity: "P1" as const,
          recommendation: `[promoted: explicit human decision required] ${finding.recommendation}`,
        }
      : finding,
  );
  return { verdict: findings.some((finding) => finding.severity !== "P2") ? "BLOCK" : "PASS", findings };
}

/**
 * Mechanical convergence rule for re-runs (anti progressive-discovery): an
 * unresolved prior finding, a NEW P0, or a finding that needs explicit human
 * agreement may block. Other new non-human P1 findings are demoted to P2 so a
 * re-run cannot grow an endless autonomous checklist.
 */
export function applyRerunConvergence(judged: GapVerdict): {
  verdict: "PASS" | "BLOCK";
  findings: Finding[];
  demotedCount: number;
} {
  const findings: Finding[] = [];
  let blocking = 0;
  let demotedCount = 0;
  for (const finding of enforceHumanBlocking(judged).findings) {
    const canBlock =
      finding.origin === "prior-unresolved"
      || (finding.origin === "new" && (finding.severity === "P0" || finding.requiresHuman));
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
    for (const rawFinding of lane.findings) {
      const finding = enforceHumanBlocking({ verdict: "PASS", findings: [rawFinding] }).findings[0]!;
      const key = finding.missing
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
      const existing = seen.get(key);
      if (!existing) {
        seen.set(key, finding);
      } else {
        dedupedCount += 1;
        const findingRank = severityRank[finding.severity] ?? 3;
        const existingRank = severityRank[existing.severity] ?? 3;
        const preferred =
          findingRank < existingRank
            ? finding
            : existingRank < findingRank
              ? existing
              : finding.requiresHuman && !existing.requiresHuman
                ? finding
                : existing;
        const combined = enforceHumanBlocking({
          verdict: "PASS",
          findings: [{ ...preferred, requiresHuman: existing.requiresHuman || finding.requiresHuman }],
        }).findings[0]!;
        seen.set(key, combined);
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
  config: SasuConfig,
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
    // passed, only an unresolved prior finding, a new P0, or a finding that
    // requires explicit human agreement may re-block it.
    const isRerun = state.gates[gate] !== undefined && state.gates[gate].verdict !== null;

    if (!config.judge.fanout) {
      // Single-judge path, unchanged (judge.fanout: false escape hatch, R5).
      const outcome = await runJudge(config, purpose, "frugal", buildPrompt(priorFindings, { rerun: isRerun }), (value) =>
        validateGapVerdict(value, { requireOrigin: isRerun }),
      );
      records.push(outcome.record);
      const humanSafe = enforceHumanBlocking(outcome.value);
      const converged = isRerun ? applyRerunConvergence(humanSafe) : { ...humanSafe, demotedCount: 0 };
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
  config: SasuConfig,
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
  config: SasuConfig,
  topic: string,
  prdPath: string,
  qaLogPath: string,
): Promise<GateCommandResult> {
  const prd = readInputFile(projectRoot, prdPath, "prd");
  const qaLog = readInputFile(projectRoot, qaLogPath, "qa-log");
  const prelint = runPrelint("prd", prd.content);
  if (!prelint.ok) return prelintBlock(projectRoot, config, topic, "spec", prelint);
  emitPrelintWarnings(prelint);
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
  /**
   * Quick-path contract document: replaces the PRD as the acceptance-criteria
   * source and runs the lighter contract prelint instead of the full PRD lint.
   * Mutually exclusive with prdPath.
   */
  contractPath?: string;
  criteria?: { id: string; text: string }[];
  /**
   * Internal diff-injection seam for tests, deliberately never exposed as a
   * CLI flag: the judged diff must come from git, so the implementing agent
   * cannot curate what the judge sees (the old --diff-file escape hatch).
   */
  diffText?: string;
  baseRef?: string;
  skipMechanical?: boolean;
  /**
   * Proceed (with a stderr warning) even when the slug's implement run still
   * has pending/in_progress tasks. Without it the gate refuses a mid-run call
   * outright: judging a diff against the COMPLETE acceptance criteria while
   * tasks are open fails legitimately and burns the retry budget.
   */
  allowOpenTasks?: boolean;
}

const { vouchedTreeFingerprint, vouchedFingerprintsMatch } = require("../../lib/git.js") as {
  vouchedTreeFingerprint: (options: { projectRoot: string; slug?: string | null }) => VouchedTreeFingerprint | null;
  vouchedFingerprintsMatch: (recorded: unknown, current: unknown) => boolean;
};

// One §7/§8 grammar for oracle tails and Scope globs: the TS gate reads the
// same lib parser the implement state does (runners.js precedent in prelint).
export interface AcOracle {
  kind: "check" | "artifact";
  command?: string;
  expect?: string | null;
  path?: string;
}
export interface ScopedTask {
  id: string;
  scopeGlobs: string[];
  acceptanceCriteria: string[];
  requirements: string[];
}
const { parseAcOracle, parsePrdTasksForScoping } = require("../../lib/prd_parser.js") as {
  parseAcOracle: (text: string) => AcOracle | null;
  parsePrdTasksForScoping: (prdContent: string) => ScopedTask[];
};
// Same broad DB heuristic the implement planner warns with (db-safety gap):
// oracle commands run on the harness clock, so the "confirm the target is
// disposable" nudge must fire here too.
const { DB_TOUCH_PATTERN } = require("../../lib/planning.js") as { DB_TOUCH_PATTERN: RegExp };
// One execution semantics for oracle commands: the harness's oracle-run
// tokenizes with shellLikeTokens and spawns WITHOUT a shell, so the gate must
// too (same shared-lib pattern as prd_parser above). The two executors used
// to diverge (gate: shell:true) and the same declared Check command could
// PASS at the gate while the harness recorded not_met.
const { shellLikeTokens, commandsMatchContract } = require("../../lib/inference.js") as {
  shellLikeTokens: (command: string) => string[];
  commandsMatchContract: (actual: string, expected: string) => boolean;
};
// Fresh-pass reuse shares finalize's rule (one predicate, two consumers): a
// verify-run pass pinned to an identical tree fingerprint already proves what
// the mechanical stage would re-prove by running the same command again.
const { freshVerifyRunPasses } = require("../../lib/fresh_pass.js") as {
  freshVerifyRunPasses: (
    state: ImplementStateLite,
    projectRoot: string,
  ) => { verificationId: string; command: string; logPath: string | null }[];
};

/**
 * The slice of an implement run's state.json the gate reads. The dependency is
 * deliberately read-only, one-way, and optional: the gate layer otherwise
 * knows nothing about implement state, and a repo that never ran implement
 * (or a corrupt state file) must behave exactly as before.
 */
interface ImplementStateLite {
  tasks?: { id?: string; title?: string; status?: string }[];
  verification?: unknown[];
  projectRoot?: string;
  runDir?: string;
}

function readImplementState(projectRoot: string, topic: string): ImplementStateLite | null {
  try {
    const statePath = path.join(projectRoot, "agents", "implement", topic, "state.json");
    if (!fs.existsSync(statePath)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return parsed !== null && typeof parsed === "object" ? (parsed as ImplementStateLite) : null;
  } catch {
    // Unreadable implement state is doctor's problem, never the gate's.
    return null;
  }
}

export async function runVerifyGate(
  projectRoot: string,
  config: SasuConfig,
  topic: string,
  options: VerifyOptions,
): Promise<GateCommandResult> {
  const store = new GateStore(projectRoot, topic);
  let state = store.load();
  const records: JudgeCallRecord[] = [];
  if (options.prdPath !== undefined && options.contractPath !== undefined) {
    throw new Error("pass either --prd or --contract, not both");
  }
  // Read the AC-source document up front so a bad path fails before any
  // command spend, and its hash is pinned for freshness tracking. The diff is
  // deliberately not a freshness input: it changes with every fix loop by
  // design; code drift after a PASS is caught by the tree fingerprint instead.
  const docKind: "prd" | "contract" = options.contractPath !== undefined ? "contract" : "prd";
  const docPath = options.contractPath ?? options.prdPath;
  const docFile = docPath !== undefined ? readInputFile(projectRoot, docPath, docKind) : null;
  const inputs = docFile ? [docFile.input] : [];

  // Stage 0: document prelint ($0, D-06). The judge reads this document's
  // acceptance criteria, so a structurally broken document blocks before the
  // mechanical commands even run - there is no point testing code against a
  // broken contract, and the fix loop must stay free.
  let prelint: PrelintResult | undefined;
  if (docFile) {
    prelint = runPrelint(docKind, docFile.content);
    if (!prelint.ok) return prelintBlock(projectRoot, config, topic, "verify", prelint);
    emitPrelintWarnings(prelint);
  }

  // Open-task guard ($0, PRD path only): the gate judges the diff against the
  // PRD's COMPLETE acceptance criteria, so a call while implement tasks are
  // still pending/in_progress fails legitimately and burns the retry budget.
  // Refusal is a thrown error, same class as the empty-diff check below: no
  // gate attempt is recorded and no budget is spent. complete/blocked/deferred
  // tasks never block - blocked and partial handoffs legitimately run without
  // a gate PASS, and a deferral is a recorded decision.
  const implementState = docKind === "prd" ? readImplementState(projectRoot, topic) : null;
  // Shape-tolerant like readImplementState itself: valid JSON with a non-array
  // tasks field must degrade to "no guard", not crash the gate.
  const implementTasks = Array.isArray(implementState?.tasks) ? implementState.tasks : [];
  const openTasks = implementTasks.filter(
    (task) => task?.status === "pending" || task?.status === "in_progress",
  );
  if (openTasks.length > 0) {
    const shown = openTasks
      .slice(0, 8)
      .map((task) => `${task.id ?? "?"}${task.title ? ` (${task.title})` : ""}`)
      .join(", ");
    const suffix = openTasks.length > 8 ? `, +${openTasks.length - 8} more` : "";
    if (!options.allowOpenTasks) {
      throw new Error(
        `implement run '${topic}' still has ${openTasks.length} open task(s): ${shown}${suffix}. ` +
          `The verify gate judges the diff against the complete acceptance criteria, so a mid-run call fails legitimately and burns the retry budget. ` +
          `Finish the tasks (or mark them blocked/deferred with evidence), then re-run. ` +
          `Pass --allow-open-tasks only when judging an intentionally partial diff. No gate attempt was recorded.`,
      );
    }
    process.stderr.write(
      `sasu: WARNING: proceeding despite ${openTasks.length} open implement task(s) (${shown}${suffix}) because --allow-open-tasks was passed. Missing acceptance criteria will fail and spend a retry-budget attempt.\n`,
    );
  }

  // Stage 1: mechanical ($0). A failure here never reaches the judge (UX-02).
  // The quick contract's own check and capture commands join this stage: the
  // harness owns their execution timing, which is what makes a capture fresh
  // rather than something the agent submitted whenever it looked good.
  const contract = docKind === "contract" && docFile ? parseContract(docFile.content) : null;
  const contractCommands: ResolvedCommand[] = [];
  if (contract) {
    for (const check of contract.checks) {
      contractCommands.push({ kind: "check", command: check.command, source: "contract" });
    }
    for (const criterion of contract.criteria) {
      for (const check of criterion.checks) {
        contractCommands.push({ kind: "check", command: check.command, source: "contract", criterionIds: [criterion.id] });
      }
      for (const capture of criterion.captures) {
        contractCommands.push({ kind: "capture", command: capture.command, source: "contract", criterionIds: [criterion.id] });
      }
    }
  }

  let mechanical: MechanicalResult | undefined;
  /**
   * Criterion-scoped command results, shared by the judge prompt and every
   * settled return. Attribution, not command kind, decides membership: a
   * criterion check that collided with a configured command survives the
   * dedupe under the project's kind, and filtering on kind there would
   * silently delete the very proof the criterion declared.
   */
  const collectCheckResults = (): CheckResult[] =>
    (mechanical?.runs ?? []).flatMap((run) =>
      (run.criterionIds ?? []).map((criterionId) => ({ criterionId, command: run.command, exitCode: run.exitCode, tail: run.tail })),
    );
  /**
   * What the artifact records for the mechanical stage. "none-detected" is
   * deliberately distinct from an empty runs list: zero resolved commands is
   * not a passing stage, it is a stage that never existed, and the artifact
   * must not let the two read the same.
   */
  const mechanicalRecord = (): MechanicalResult["runs"] | "skipped" | "none-detected" =>
    mechanical === undefined ? "skipped" : mechanical.runs.length === 0 ? "none-detected" : mechanical.runs;
  // Captures are evidence production, not a project check: skipping the
  // mechanical stage must not silently leave the judge with a stale artifact,
  // so a contract with captures always runs them.
  // Fresh-pass reuse: a project command the implement harness already ran to a
  // digest-guard-clean pass on THIS exact tree fingerprint is skipped, with
  // the reused verification stamped on the run (never silent). Fail-open by
  // construction - no implement state, no git, or any drift means every
  // command runs exactly as before.
  const freshPasses = implementState ? freshVerifyRunPasses(implementState, projectRoot) : [];
  const freshPassFor =
    freshPasses.length > 0
      ? (cmd: ResolvedCommand) => {
          const hit = freshPasses.find((entry) => commandsMatchContract(entry.command, cmd.command));
          return hit ? { verificationId: hit.verificationId, logPath: hit.logPath } : null;
        }
      : undefined;
  if (!options.skipMechanical || contractCommands.some((cmd) => cmd.kind === "capture")) {
    const commandsToRun = options.skipMechanical ? contractCommands.filter((cmd) => cmd.kind === "capture") : contractCommands;
    mechanical = runMechanical(projectRoot, config, commandsToRun, {
      skipProjectCommands: options.skipMechanical === true,
      ...(freshPassFor !== undefined ? { freshPassFor } : {}),
    });
    const reused = mechanical.runs.filter((run) => run.freshPass !== undefined);
    if (reused.length > 0) {
      process.stderr.write(
        `sasu: mechanical: reused ${reused.length} fresh verify-run pass(es) instead of re-running: ${reused
          .map((run) => `${run.freshPass!.verificationId} (${run.command})`)
          .join(", ")}\n`,
      );
    }
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
              recommendation: "Fix the failing check and re-run sasu verify.",
              requiresHuman: false,
            })),
          inputs,
          artifactPayload: { stage: "mechanical", runs: mechanical.runs },
        },
        records,
      );
      return {
        ok: false,
        status: gateStatus(state, "verify", config.judge.retryBudget, projectRoot),
        prelint,
        mechanical,
        criteria: [],
        inputs,
        evidence: [],
        checks: collectCheckResults(),
        judgedCriteriaIds: [],
      };
    }
  }

  // The mechanical stage resolving zero commands is not a pass, it is an
  // absence: nothing filtered the change before the paid judge. Warn loudly
  // but do not block - a docs-only or scripts-only project legitimately has
  // no test command, and the judge can still do its job.
  const mechanicalWarning =
    options.skipMechanical !== true && mechanical !== undefined && mechanical.runs.length === 0
      ? "verify resolved ZERO mechanical commands: the $0 pre-judge filter (tests/lint/build) is INACTIVE and every failure will be discovered by the judge instead. Declare commands in agents/config.json under verify.commands (e.g. {\"verify\":{\"commands\":{\"test\":\"cd app && npm test\"}}}) - auto-detection only sees a package.json/pyproject.toml/Cargo.toml/go.mod at the project root."
      : undefined;
  if (mechanicalWarning !== undefined) {
    process.stderr.write(`sasu: WARNING: ${mechanicalWarning}\n`);
  }
  const warningField = mechanicalWarning !== undefined ? { mechanicalWarning } : {};

  // Stage 2: semantic judge over the diff.
  if (!options.criteria && !docFile) {
    throw new Error("no acceptance-criteria source: pass --prd <path> or --contract <path>");
  }
  // The contract has one grammar: its own parser owns criteria extraction so
  // the evidence lane and the judge can never disagree about what AC3 is.
  const criteria =
    options.criteria ?? (contract ? contract.criteria.map((c) => ({ id: c.id, text: c.text })) : extractAcceptanceCriteria(docFile!.content));
  if (criteria.length === 0) {
    throw new Error(
      docKind === "contract"
        ? "no acceptance criteria found (expected '## Acceptance Criteria' with '- AC#.' items)"
        : "no acceptance criteria found (expected '## 7. Acceptance Criteria' with '- AC#.' items)",
    );
  }
  const diff = options.diffText ?? gitDiff(projectRoot, options.baseRef);
  if (diff.trim() === "") {
    throw new Error(
      `empty diff: nothing to verify against ${options.baseRef ?? "HEAD"}. Implement the change first, or point --base at the commit you started from. Note that gitignored files are invisible here even when they exist.`,
    );
  }
  // The oversized-diff guard moved to the per-lane assembly below: a lane may
  // shrink under the budget via PRD Scope globs, and an oversized lane falls
  // back to the agentic judge when the backend supports one.

  // AC oracle stage (PRD path): criteria whose bullet declares a machine
  // oracle (Check:/Artifact: tail) are settled by the harness right here -
  // exit codes, output substrings, and file existence, no judge. They leave
  // the judge lanes the same way human-lane criteria do: already decided,
  // by a stronger authority than a model reading a diff.
  const oracleTargets =
    docKind === "prd"
      ? criteria.flatMap((c) => {
          const oracle = parseAcOracle(c.text);
          return oracle ? [{ id: c.id, text: c.text, oracle }] : [];
        })
      : [];
  const oracleCriterionIds = new Set(oracleTargets.map((c) => c.id));
  // Parsed now, EXECUTED later: oracle commands are side effects spent on the
  // world, so they run only after every no-judgment exit is behind us - the
  // evidence lane block and, on the judged path, the oversized-diff hard
  // error (which used to throw after oracles had already executed, with
  // nothing recorded to show for them). Which criteria are oracle-backed is
  // pure parsing and is decided here either way.
  const settleOracles = (): { oracleOutcomes: OracleOutcome[]; oracleFindings: Finding[]; oracleCriteria: CriterionVerdict[] } => {
    const oracleStage = oracleTargets.length > 0 ? runAcOracles(projectRoot, config, oracleTargets, topic) : null;
    const oracleOutcomes = oracleStage ? oracleStage.outcomes : [];
    for (const warning of oracleStage ? oracleStage.warnings : []) {
      process.stderr.write(`sasu: WARNING: ${warning}\n`);
    }
    const oracleFindings: Finding[] = oracleOutcomes
      .filter((outcome) => !outcome.met)
      .map((outcome) => ({
        area: "oracle",
        severity: "P0" as const,
        missing: `${outcome.id}: ${outcome.reason}`,
        recommendation:
          outcome.digestViolation === true
            ? "The oracle command must not modify the workspace; make it read-only or fix the declaration."
            : "Make the PRD-declared oracle check pass and re-run sasu verify.",
        requiresHuman: false,
      }));
    const oracleCriteria: CriterionVerdict[] = oracleOutcomes.map((outcome) => ({
      id: outcome.id,
      verdict: outcome.met ? ("PASS" as const) : ("FAIL" as const),
      reason: outcome.reason,
      evidence: outcome.evidence,
    }));
    return { oracleOutcomes, oracleFindings, oracleCriteria };
  };

  // Stage 1b: collect the evidence lane. A declared artifact that is missing
  // or oversized blocks here, before the judge call, the same way a broken
  // document does - an absent proof is not a judgment problem.
  const lane = contract ? collectEvidence(projectRoot, contract, config) : null;
  if (lane && lane.findings.length > 0) {
    state = recordGateResult(
      store,
      state,
      "verify",
      {
        kind: "verdict",
        verdict: "FAIL",
        findings: lane.findings,
        inputs,
        artifactPayload: { stage: "evidence", findings: lane.findings, inputs, mechanical: mechanicalRecord() },
      },
      records,
    );
    // The receipt contract is the same on every settled path: report what was
    // judged (nothing), what was pinned, and what ran.
    return {
      ok: false,
      status: gateStatus(state, "verify", config.judge.retryBudget, projectRoot),
      prelint,
      mechanical,
      ...warningField,
      criteria: [],
      inputs,
      evidence: [],
      checks: collectCheckResults(),
      judgedCriteriaIds: [],
    };
  }

  // Criteria whose proof no judge can see - declared human, or an attached
  // image on a backend that cannot attach - never reach the judge. They come
  // back as requiresHuman findings, which the Stop hook already lets the agent
  // hand to the user. Oracle-backed criteria leave the lanes the same way:
  // the harness already settled them mechanically above.
  const humanLane = lane ? lane.humanFindings : [];
  const judgedCriteria = criteria.filter(
    (c) => !(lane !== null && lane.humanCriterionIds.has(c.id)) && !oracleCriterionIds.has(c.id),
  );
  const evidenceInputs = lane ? lane.inputs : [];
  const allInputs = [...inputs, ...evidenceInputs];

  if (judgedCriteria.length === 0) {
    // Nothing left for a judge: every criterion is human-verified or
    // oracle-settled. All-oracle-pass is an honest zero-LLM-call PASS (the
    // ouroboros $0 tier); any human criterion or failed oracle keeps the
    // gate closed.
    const { oracleOutcomes, oracleFindings, oracleCriteria } = settleOracles();
    const zeroJudgeFindings = [...oracleFindings, ...humanLane];
    const zeroJudgePassed = zeroJudgeFindings.length === 0 && oracleCriteria.length > 0;
    // An all-oracle PASS is honest but easy to mistake for a judged one: say
    // loudly, on the record and on stderr, that no model ever saw this diff.
    if (zeroJudgePassed) {
      process.stderr.write(
        "sasu: NOTE: verify gate PASSED with ZERO judge calls - every AC was oracle-backed; the semantic judge never saw this diff.\n",
      );
    }
    let zeroJudgeFingerprint: VouchedTreeFingerprint | null = null;
    try {
      zeroJudgeFingerprint = vouchedTreeFingerprint({ projectRoot, slug: topic });
    } catch {
      zeroJudgeFingerprint = null;
    }
    state = recordGateResult(
      store,
      state,
      "verify",
      {
        kind: "verdict",
        verdict: zeroJudgePassed ? "PASS" : "FAIL",
        findings: zeroJudgeFindings,
        inputs: allInputs,
        treeFingerprint: zeroJudgeFingerprint,
        artifactPayload: {
          stage: humanLane.length > 0 ? "human-lane" : "oracle",
          verdict: zeroJudgePassed ? "PASS" : "FAIL",
          findings: zeroJudgeFindings,
          judgedCriteriaIds: [],
          oracle: oracleOutcomes,
          criteria: oracleCriteria,
          evidence: lane ? lane.artifacts : [],
          mechanical: mechanicalRecord(),
          treeFingerprint: zeroJudgeFingerprint,
          ...(zeroJudgePassed ? { zeroJudgeCalls: true } : {}),
          inputs: allInputs,
        },
      },
      records,
    );
    return {
      ok: zeroJudgePassed && gateStatus(state, "verify", config.judge.retryBudget, projectRoot).effective === "PASS",
      status: gateStatus(state, "verify", config.judge.retryBudget, projectRoot),
      prelint,
      mechanical,
      ...warningField,
      // No judge ran: the per-criterion verdicts are the oracle's, and the
      // receipt for a human close rests on the findings and the artifacts.
      criteria: oracleCriteria,
      inputs: allInputs,
      evidence: lane ? lane.artifacts : [],
      checks: collectCheckResults(),
      judgedCriteriaIds: [],
      ...(zeroJudgePassed ? { zeroJudgeCalls: true } : {}),
    };
  }

  // Criterion-scoped checks reach the judge as evidence for their criterion;
  // a run-wide check has no criterion to name and stays a gate-only signal.
  const checkResults = collectCheckResults();

  // PRD-declared lane scoping (4a): tasks' Scope globs, resolved through the
  // AC -> Covers-task chain, decide which slice of the curated diff each lane
  // sees. Files in the diff that no declared glob claims surface as a warning
  // (mechanized first step of the unmapped-scope hard-stop; not blocking yet).
  const scopedTasks = docKind === "prd" && docFile !== null ? parsePrdTasksForScoping(docFile.content) : [];
  const anyDeclaredScope = scopedTasks.some((task) => task.scopeGlobs.length > 0);
  const declaredGlobs = scopedTasks.flatMap((task) => task.scopeGlobs);
  // The unscoped-files warning fires only when EVERY task declared a Scope:
  // with a partial declaration a file outside the declared globs may simply
  // belong to a Scope-less task (T1 `Scope: src/**` plus a docs task with no
  // Scope warned on every docs file the docs task legitimately owned), so
  // ownership is ambiguous and the warning would be noise.
  const everyTaskDeclaredScope = scopedTasks.length > 0 && scopedTasks.every((task) => task.scopeGlobs.length > 0);
  const unscopedFiles = everyTaskDeclaredScope
    ? splitDiffByFile(diff)
        .map((block) => block.path)
        .filter((file) => !declaredGlobs.some((glob) => matchesScopeGlob(file, glob)))
    : [];
  if (unscopedFiles.length > 0) {
    process.stderr.write(
      `sasu: WARNING: ${unscopedFiles.length} changed file(s) fall under no task's Scope glob: ${unscopedFiles.join(", ")}. Every change should belong to a declared task scope; extend a task's Scope or explain the file.\n`,
    );
  }

  // Semantic fan-out (mirrors the gap-audit lane pattern): the exhaustive
  // single call concentrated every criterion plus the whole diff into one
  // 75-137s prompt, so criteria are partitioned into criterion-scoped lanes
  // that run concurrently over the (per-lane scoped) curated diff.
  // judge.fanout: false is the same escape hatch the gap-list gates honor.
  const laneCriteria = config.judge.fanout ? partitionVerifyCriteria(judgedCriteria) : [judgedCriteria];
  const laneCount = laneCriteria.length;
  // An oversized lane diff falls back to the read-only agentic judge instead
  // of hard-erroring - but only on a backend that can grant read tools; the
  // capability is checked once so every lane takes the same path.
  let backendAgentic = false;
  try {
    backendAgentic = resolveBackend(config.judge.backend).agentic;
  } catch {
    backendAgentic = false;
  }
  const verifyLanes = laneCriteria.map((criteriaSlice, index) => {
    const ids = new Set(criteriaSlice.map((c) => c.id));
    const material = lane ? lane.material.filter((item) => ids.has(item.criterionId)) : [];
    // Image attachments are rebuilt per lane from the material that carries
    // them, so a lane ships only the screenshots its own criteria pinned.
    const images = [...new Set(material.filter((item) => item.attachedImage).map((item) => path.join(projectRoot, item.path)))];
    const laneGlobs = anyDeclaredScope ? scopeForLane(criteriaSlice, scopedTasks) : null;
    const scoped = laneGlobs !== null ? filterDiffByGlobs(diff, laneGlobs) : null;
    // A scoped diff with zero matching files would show the judge nothing and
    // fail every criterion as absent; fall back to the full curated diff and
    // say so in the artifact, because empty-by-scope is far more often a glob
    // mistake than a real no-op.
    const scopeFellBack = scoped !== null && scoped.text.trim() === "";
    const laneDiff = scoped !== null && !scopeFellBack ? scoped.text : diff;
    const agentic = laneDiff.length > VERIFY_DIFF_MAX_CHARS;
    const laneOptions = {
      mechanicalRan: options.skipMechanical !== true,
      ...(laneCount > 1 ? { lane: { index: index + 1, count: laneCount } } : {}),
    };
    const laneChecks = checkResults.filter((c) => ids.has(c.criterionId));
    const prompt = agentic
      ? agenticSemanticVerifyPrompt(diffStatFromText(laneDiff), criteriaSlice, material, laneChecks, laneOptions)
      : semanticVerifyPrompt(laneDiff, criteriaSlice, material, laneChecks, laneOptions);
    return {
      laneId: String(index + 1),
      // A single lane IS the old exhaustive call, so it keeps the historical
      // purpose; receipts and telemetry written against it stay comparable.
      purpose: laneCount > 1 ? `gate:verify-semantic:lane:${index + 1}` : "gate:verify-semantic",
      criteria: criteriaSlice,
      prompt,
      images,
      // Audit trail: which paths this lane was scoped to (null = full diff),
      // whether scoping fell back, and whether the lane went agentic.
      scope: scopeFellBack ? null : laneGlobs,
      scopeFellBack,
      diffChars: laneDiff.length,
      agentic,
    };
  });
  // A backend that cannot run the agentic judge keeps the original contract
  // for oversized input: fail the command up front, before any judge call or
  // recorded outcome, so no retry-budget attempt is charged.
  const oversized = verifyLanes.filter((vl) => vl.agentic);
  if (oversized.length > 0 && !backendAgentic) {
    const worst = Math.max(...oversized.map((vl) => vl.diffChars));
    throw new Error(
      `diff is ${worst} chars, over the ${VERIFY_DIFF_MAX_CHARS}-char judge input budget, and the ${config.judge.backend} judge backend cannot run the read-only agentic fallback. No judgment ran and no retry attempt was spent. Narrow the change under judgment: declare task Scope globs in the PRD so each lane judges only its own files, point --base at the commit you started from, or split the change.`,
    );
  }
  // Every no-judgment exit is behind us: NOW spend the oracle side effects
  // (see settleOracles - they used to run before the oversized hard error).
  // The agentic fallback path still reaches this line, so oversized-but-
  // capable rounds run their oracles exactly as before.
  const { oracleOutcomes, oracleFindings, oracleCriteria } = settleOracles();
  // One auditable hash of everything sent this round: the lane prompts joined
  // in lane order. For a single lane this is byte-identical to the old
  // single-prompt hash contract.
  const promptSha256 = sha256Of(verifyLanes.map((vl) => vl.prompt).join("\n"));
  const lanesManifest = verifyLanes.map((vl) => ({
    laneId: vl.laneId,
    criteriaIds: vl.criteria.map((c) => c.id),
    promptSha256: sha256Of(vl.prompt),
    // Auditability (4a/4b): what slice of the diff this lane received and how.
    scope: vl.scope,
    ...(vl.scopeFellBack ? { scopeFellBack: true } : {}),
    diffChars: vl.diffChars,
    agenticFallback: vl.agentic,
  }));
  const evidenceSummary = lane ? lane.artifacts : [];
  const judgedCriteriaIds = judgedCriteria.map((c) => c.id);
  try {
    const settled = await Promise.all(
      verifyLanes.map(async (vl) => {
        try {
          const outcome = await runJudge(
            config,
            vl.purpose,
            // Tier stays "standard" per lane: verify caught a real production
            // bug at this tier, and the fan-out win is latency and attention
            // scope, not model cost. Multi-lane rounds pair the narrow scope
            // with the low effort budget (the calibrated fan-out speed lever,
            // see LANE_EFFORT); a single-lane round is the old exhaustive call
            // and keeps the backend's default effort.
            "standard",
            vl.prompt,
            (value) => {
              const laneIds = vl.criteria.map((c) => c.id);
              const validated = validateSemanticVerdict(value, laneIds);
              if (typeof validated === "string") return validated;
              // A lane's verdict counts for exactly its own criteria. Judges
              // were already tolerated over-answering before the fan-out (e.g.
              // echoing a human-lane criterion), so a foreign id is dropped
              // rather than rejected - but it must never leak into the merge,
              // and the lane's verdict is re-derived from its own criteria so
              // a foreign FAIL cannot fail a lane it does not belong to.
              const allowed = new Set(laneIds);
              const own = validated.criteria.filter((c) => allowed.has(c.id));
              return { verdict: own.some((c) => c.verdict === "FAIL") ? ("FAIL" as const) : ("PASS" as const), criteria: own };
            },
            {
              ...(vl.images.length > 0 ? { images: vl.images } : {}),
              ...(laneCount > 1 ? { effort: LANE_EFFORT } : {}),
              // Oversized lane: the judge reads the tree itself (read-only)
              // instead of receiving the diff inline; see the lane assembly.
              ...(vl.agentic ? { agentic: true } : {}),
              // Anchor the judge process to the project root, not the
              // caller's cwd: `sasu verify` from a subdirectory otherwise
              // hands the agentic judge a working directory where the
              // diff-stat's repo-relative paths do not resolve. (Codex builds
              // its own empty work root and ignores this.)
              cwd: projectRoot,
            },
          );
          return { lane: vl, outcome, error: null as unknown };
        } catch (error) {
          return { lane: vl, outcome: null, error };
        }
      }),
    );
    for (const settledLane of settled) {
      if (settledLane.outcome) records.push(settledLane.outcome.record);
      else {
        const failureRecord = judgeCallRecordFrom(settledLane.error);
        if (failureRecord) records.push(failureRecord);
      }
    }
    const failures = settled.filter((settledLane) => settledLane.error !== null);
    if (failures.length > 0) {
      // A single erroring lane fails the whole round closed (same rule as the
      // gap-audit fan-out): a partial set of lane verdicts is not a verdict.
      const first = failures[0]!.error;
      const code = first instanceof JudgeError ? first.code : "judge-auth-or-runtime";
      const backend = first instanceof JudgeError ? first.backend : "claude";
      const detail = first instanceof JudgeError ? first.detail : first instanceof Error ? first.message : String(first);
      const laneList = failures.map((settledLane) => settledLane.lane.laneId).join(", ");
      throw new JudgeError(code, backend, laneCount > 1 ? `lane failed [${laneList}]: ${detail}` : detail);
    }
    // Mechanical merge in document order: lanes own disjoint slices, so the
    // union is exactly one verdict per judged criterion, and the overall
    // judged verdict is PASS only when every lane passed.
    const verdictById = new Map(settled.flatMap((settledLane) => settledLane.outcome!.value.criteria.map((c) => [c.id, c] as const)));
    const mergedCriteria = judgedCriteria.map((c) => verdictById.get(c.id)!);
    const judgedVerdict: "PASS" | "FAIL" = settled.every((settledLane) => settledLane.outcome!.value.verdict === "PASS")
      ? "PASS"
      : "FAIL";
    const findings: Finding[] = mergedCriteria
      .filter((c) => c.verdict === "FAIL")
      .map((c) => ({
        area: "semantic",
        severity: "P0" as const,
        missing: `${c.id}: ${c.reason}`,
        recommendation: "Address the criterion and re-run sasu verify.",
        requiresHuman: false,
      }));
    findings.push(...oracleFindings);
    findings.push(...humanLane);
    // Pin the tree the verdict was earned on; the Stop-hook quick guard
    // recomputes this to catch code edited after a PASS. Best-effort: a
    // non-git project records null and the guard skips the comparison.
    let treeFingerprint: VouchedTreeFingerprint | null = null;
    try {
      treeFingerprint = vouchedTreeFingerprint({ projectRoot, slug: topic });
    } catch {
      treeFingerprint = null;
    }
    // An unjudged human criterion keeps the gate closed even when every judged
    // one passed: nobody has confirmed it yet, and the honest report of that
    // is a blocking requiresHuman finding, not a PASS. A failed oracle closes
    // it the same way - the harness observed the criterion unmet.
    const passed = judgedVerdict === "PASS" && humanLane.length === 0 && oracleFindings.length === 0;
    // Document-order verdict list for the receipt: judged criteria carry the
    // judge's verdicts, oracle-backed ones the harness's; human criteria have
    // no verdict to quote (their findings carry the story).
    const verdictByIdAll = new Map<string, CriterionVerdict>([
      ...mergedCriteria.map((c) => [c.id, c] as const),
      ...oracleCriteria.map((c) => [c.id, c] as const),
    ]);
    const resultCriteria = criteria.flatMap((c) => {
      const verdict = verdictByIdAll.get(c.id);
      return verdict !== undefined ? [verdict] : [];
    });
    state = recordGateResult(
      store,
      state,
      "verify",
      {
        kind: "verdict",
        verdict: passed ? "PASS" : "FAIL",
        findings,
        inputs: allInputs,
        treeFingerprint,
        // One fan-out round is one gate attempt: recordGateResult runs once
        // per round no matter how many lanes it took (gap-audit's rule).
        artifactPayload: {
          stage: "semantic",
          verdict: passed ? "PASS" : "FAIL",
          judgedVerdict,
          criteria: resultCriteria,
          humanLane,
          ...(oracleOutcomes.length > 0 ? { oracle: oracleOutcomes } : {}),
          // What the judge was actually shown, so "AC4 was never sent" is an
          // auditable fact rather than something you re-derive from the code.
          judgedCriteriaIds,
          promptSha256,
          // Per-lane judge records replace the old top-level `judge` key, the
          // same shape shift the gap-audit fan-out made to its artifact.
          lanes: settled.map((settledLane, index) => ({
            ...lanesManifest[index]!,
            verdict: settledLane.outcome!.value.verdict,
            judge: settledLane.outcome!.record,
          })),
          checks: checkResults,
          evidence: evidenceSummary,
          mechanical: mechanicalRecord(),
          treeFingerprint,
          ...(unscopedFiles.length > 0 ? { unscopedFiles } : {}),
          inputs: allInputs,
        },
      },
      records,
    );
    const status = gateStatus(state, "verify", config.judge.retryBudget, projectRoot);
    return {
      ok: status.effective === "PASS",
      status,
      prelint,
      mechanical,
      ...warningField,
      criteria: resultCriteria,
      inputs: allInputs,
      evidence: evidenceSummary,
      checks: checkResults,
      judgedCriteriaIds,
      judgedVerdict,
      ...(unscopedFiles.length > 0 ? { unscopedFiles } : {}),
    };
  } catch (error) {
    // A broken judge round does not erase the run's real work: the receipt
    // contract holds on this path too, minus the verdicts nobody produced.
    const failurePayload = {
      judgedCriteriaIds,
      promptSha256,
      lanes: lanesManifest,
      checks: checkResults,
      evidence: evidenceSummary,
      mechanical: mechanicalRecord(),
      ...(oracleOutcomes.length > 0 ? { oracle: oracleOutcomes } : {}),
      ...(unscopedFiles.length > 0 ? { unscopedFiles } : {}),
      inputs: allInputs,
    };
    return {
      ...recordJudgeFailure(store, state, "verify", config, error, records, topic, failurePayload),
      prelint,
      mechanical,
      ...warningField,
      criteria: [],
      inputs: allInputs,
      evidence: evidenceSummary,
      checks: checkResults,
      judgedCriteriaIds,
    };
  }
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
/** Attachment budget for image evidence; the inline text cap does not apply to images. */
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Why an evidence path may not be readable as project content.
 *
 * The lexical contract lint only sees the string that was written, and the
 * evidence lane ships whatever it reads to an external judge, so containment
 * is decided here on the real file. Two link kinds defeat a naive check and
 * are both refused: a symlink leaving the tree (visible via realpath) and a
 * hard link to an outside file (invisible to realpath - the link IS a real
 * directory entry inside the project, so it is caught by its link count).
 */
function containmentProblem(projectRoot: string, resolved: string): string | null {
  let stat: fs.Stats;
  try {
    const realRoot = fs.realpathSync(projectRoot);
    const realTarget = fs.realpathSync(resolved);
    const rel = path.relative(realRoot, realTarget);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return "resolves outside the project";
    stat = fs.statSync(realTarget);
  } catch {
    return "cannot be resolved to a real file inside the project";
  }
  if (stat.isFile() && stat.nlink > 1) {
    return "is a hard link, so its content may live outside the project";
  }
  return null;
}

interface EvidenceLane {
  /** Blocking defects: a declared artifact that is missing, empty, or oversized. */
  findings: Finding[];
  /** Criteria no judge can settle, reported as requiresHuman. */
  humanFindings: Finding[];
  /** Ids behind humanFindings, so the judge's criteria list is filtered by identity, not by string matching. */
  humanCriterionIds: Set<string>;
  /**
   * Every artifact the run pinned, including ones no judge could read. The
   * receipt quotes this: a screenshot handed to a person still needs its hash
   * on the record, and `material` only holds what the judge was shown.
   */
  artifacts: Omit<EvidenceMaterial, "text">[];
  material: EvidenceMaterial[];
  images: string[];
  inputs: GateInput[];
}

/**
 * Gather the contract's evidence lane after the harness ran its commands.
 *
 * Everything collected here is hashed into the PASS pin, so changing a log or
 * a screenshot after the fact stales the verdict exactly like editing the
 * contract does. Text rides inline in the judge prompt; images ride as
 * attachments when the backend supports them and become a human handoff when
 * it does not - the escalation ladder never silently drops a criterion.
 */
function collectEvidence(projectRoot: string, contract: ParsedContract, config: SasuConfig): EvidenceLane {
  const lane: EvidenceLane = {
    findings: [],
    humanFindings: [],
    humanCriterionIds: new Set(),
    artifacts: [],
    material: [],
    images: [],
    inputs: [],
  };
  const pinned = new Set<string>();
  let canAttach = false;
  try {
    canAttach = resolveBackend(config.judge.backend).attachments;
  } catch {
    // No backend resolvable: the judge call downstream reports it properly.
    canAttach = false;
  }

  const blocking = (criterionId: string, missing: string, recommendation: string): Finding => ({
    area: "evidence",
    severity: "P0",
    missing: `${criterionId}: ${missing}`,
    recommendation,
    requiresHuman: false,
  });

  for (const criterion of contract.criteria) {
    if (criterion.human !== null) {
      lane.humanCriterionIds.add(criterion.id);
      lane.humanFindings.push({
        area: "human-verification",
        severity: "P0",
        missing: `${criterion.id}: declared human-verified - ${criterion.human}`,
        recommendation: `Confirm ${criterion.id} yourself and report the result; no judge can settle it.`,
        requiresHuman: true,
      });
      continue;
    }

    const artifacts: { path: string; producedBy?: string }[] = [
      ...criterion.evidence.map((item) => ({ path: item.path })),
      ...criterion.captures.map((item) => ({ path: item.path, producedBy: item.command })),
    ];
    let unjudgeable: { path: string; reason: string; fix: string } | null = null;

    for (const artifact of artifacts) {
      const resolved = path.join(projectRoot, artifact.path);
      if (!fs.existsSync(resolved)) {
        lane.findings.push(
          blocking(
            criterion.id,
            artifact.producedBy
              ? `capture command succeeded but produced no artifact at ${artifact.path}`
              : `evidence file not found: ${artifact.path}`,
            artifact.producedBy
              ? "Fix the capture command so it writes the declared path, or correct the path."
              : "Produce the evidence file (prefer a command the harness can run) or correct the path.",
          ),
        );
        continue;
      }
      // Containment is decided on the RESOLVED path, not the written one: the
      // contract's lexical prelint stops `..` and absolute paths, but a
      // symlink inside the project is spelled like any other relative path and
      // would hand an arbitrary host file to the judge backend.
      const containment = containmentProblem(projectRoot, resolved);
      if (containment !== null) {
        lane.findings.push(
          blocking(
            criterion.id,
            `evidence path ${containment}: ${artifact.path}`,
            "Evidence must be an ordinary file whose content lives inside the project; symlinks out of the tree and hard links are refused. Copy the proving excerpt in, or prove it with a check command.",
          ),
        );
        continue;
      }
      const bytes = fs.statSync(resolved).size;
      if (bytes === 0) {
        lane.findings.push(blocking(criterion.id, `evidence file is empty: ${artifact.path}`, "An empty artifact proves nothing; produce real output or drop the declaration."));
        continue;
      }

      const isImage = IMAGE_EXTENSIONS.has(path.extname(artifact.path).toLowerCase());
      if (isImage && bytes > IMAGE_MAX_BYTES) {
        lane.findings.push(
          blocking(
            criterion.id,
            `image evidence is ${bytes} bytes, over the ${IMAGE_MAX_BYTES}-byte attachment budget: ${artifact.path}`,
            "Capture a smaller region or downscale the image in the capture command.",
          ),
        );
        continue;
      }
      const raw = fs.readFileSync(resolved);
      const sha256 = sha256Of(raw);
      if (!pinned.has(artifact.path)) {
        pinned.add(artifact.path);
        lane.inputs.push({ path: artifact.path, sha256, kind: "evidence" });
      }
      lane.artifacts.push({
        criterionId: criterion.id,
        path: artifact.path,
        sha256,
        bytes,
        ...(artifact.producedBy !== undefined ? { producedBy: artifact.producedBy } : {}),
      });

      if (isImage) {
        // Provenance, not format, is what makes an image judgeable: the
        // harness must have produced it on this run. An image handed over as
        // `evidence:` could be any age, and the judge cannot tell.
        if (artifact.producedBy === undefined) {
          unjudgeable = {
            path: artifact.path,
            reason: `image evidence (${artifact.path}) was not produced by a capture command, so its freshness is unproven`,
            fix: `Declare it as capture: \`<command that produces it>\` -> ${artifact.path} so the harness makes it on its own clock, or review it yourself and report the result.`,
          };
          continue;
        }
        if (!canAttach) {
          unjudgeable = {
            path: artifact.path,
            reason: `image evidence (${artifact.path}) cannot be shown to the ${config.judge.backend} judge backend, which has no attachment support`,
            fix: `Review ${artifact.path} yourself and report the result, or set judge.backend to "codex" in agents/config.json so the judge can see it.`,
          };
          continue;
        }
        lane.images.push(resolved);
        lane.material.push({
          criterionId: criterion.id,
          path: artifact.path,
          sha256,
          bytes,
          attachedImage: true,
          producedBy: artifact.producedBy,
        });
        continue;
      }
      if (bytes > EVIDENCE_MAX_BYTES) {
        lane.findings.push(
          blocking(
            criterion.id,
            `evidence file is ${bytes} bytes, over the ${EVIDENCE_MAX_BYTES}-byte inline budget: ${artifact.path}`,
            "Reduce it to the proving excerpt, or turn the check into a `## Checks` command the harness runs (evidence tier 1).",
          ),
        );
        continue;
      }
      // Inlining a binary would put mojibake in front of the judge and read as
      // evidence of nothing. Only text and recognized images have a lane.
      if (raw.includes(0)) {
        lane.findings.push(
          blocking(
            criterion.id,
            `evidence file is binary, not text: ${artifact.path}`,
            artifact.producedBy
              ? "A captured artifact must be an image the judge can look at or text it can read. Make the command write one of those, or prove the criterion with a check command."
              : "Inline evidence must be readable text. Capture an image for something visual, or prove the criterion with a check command.",
          ),
        );
        continue;
      }
      lane.material.push({
        criterionId: criterion.id,
        path: artifact.path,
        sha256,
        bytes,
        text: raw.toString("utf8"),
        ...(artifact.producedBy !== undefined ? { producedBy: artifact.producedBy } : {}),
      });
    }

    if (unjudgeable !== null) {
      lane.humanCriterionIds.add(criterion.id);
      lane.humanFindings.push({
        area: "human-verification",
        severity: "P0",
        missing: `${criterion.id}: ${unjudgeable.reason}`,
        recommendation: unjudgeable.fix,
        requiresHuman: true,
      });
    }
  }

  return lane;
}

function recordJudgeFailure(
  store: GateStore,
  state: ReturnType<GateStore["load"]>,
  gate: GateId,
  config: SasuConfig,
  error: unknown,
  records: JudgeCallRecord[],
  topic: string,
  artifactPayload?: unknown,
): GateCommandResult {
  if (!(error instanceof JudgeError)) throw error;
  const failureRecord = judgeCallRecordFrom(error);
  if (failureRecord) records.push(failureRecord);
  state = recordGateResult(
    store,
    state,
    gate,
    { kind: "error", message: error.message, ...(artifactPayload !== undefined ? { artifactPayload } : {}) },
    records,
  );
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
  config: SasuConfig,
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

/**
 * Machine-generated dependency lockfiles, by basename, at any depth. They are
 * enormous, carry no evidence for any acceptance criterion, and in the audited
 * run (2026-08) a nested app/pnpm-lock.yaml alone was worth tens of thousands
 * of diff chars that crowded the code out of the judge's window.
 */
const DIFF_EXCLUDED_LOCKFILES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "composer.lock",
  "Gemfile.lock",
];

/**
 * The single exclusion predicate for the judge's diff, applied to BOTH sides
 * (tracked pathspecs and the untracked listing - they previously disagreed,
 * and agents/prd + agents/interview leaked into the tracked diff). The whole
 * agents/ namespace is out: the PRD, qa-log, contract, and evidence artifacts
 * are already pinned as gate inputs, and the gate's own past verdict JSONs
 * sort alphabetically ahead of most app code, so replaying any of it into the
 * diff shows the judge documents instead of the change under judgment.
 */
export function isExcludedFromDiff(file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  if (normalized === "agents" || normalized.startsWith("agents/")) return true;
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  return DIFF_EXCLUDED_LOCKFILES.includes(base);
}

/** The same exclusions as git pathspecs, so the tracked diff is curated by git itself. */
const DIFF_EXCLUDE_PATHSPECS = [
  ":(exclude)agents",
  ...DIFF_EXCLUDED_LOCKFILES.map((name) => `:(glob,exclude)**/${name}`),
];

// --- PRD-declared lane scoping (4a) ---
//
// The trust rule: which slice of the diff a judge lane sees is decided by the
// vetted PRD's `Scope:` declarations and derived here by the harness - never
// picked by the implementer at verification time (the reason the --diff-file
// flag no longer exists; diffText remains as a test-only seam the CLI never
// exposes).

/**
 * Minimal glob dialect for §8 Scope tails, owned by cli/lib/scope_match.js
 * (the lib-side freshness scoping in git.js reads the same module, so the two
 * consumers can never drift). Re-exported here so gate-internal callers and
 * the dist/gates/commands.js test imports keep their path.
 */
export const { matchesScopeGlob } = require("../../lib/scope_match.js") as {
  matchesScopeGlob: (file: string, glob: string) => boolean;
};

interface DiffFileBlock {
  /** Path of the change (b-side; a-side for deletions). */
  path: string;
  text: string;
}

/** Split a curated unified diff into per-file blocks on `diff --git` headers. */
export function splitDiffByFile(diff: string): DiffFileBlock[] {
  const blocks: DiffFileBlock[] = [];
  const headerRe = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/;
  let current: DiffFileBlock | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (current) {
      current.text = buffer.join("\n");
      blocks.push(current);
    }
    buffer = [];
  };
  for (const line of diff.split("\n")) {
    const header = line.match(headerRe);
    if (header) {
      flush();
      const aPath = header[1]!;
      const bPath = header[2]!;
      current = { path: bPath === "dev/null" ? aPath : bPath, text: "" };
    }
    if (current) buffer.push(line);
  }
  flush();
  return blocks;
}

/** Keep only the file blocks whose path matches any of the globs. */
export function filterDiffByGlobs(diff: string, globs: string[]): { text: string; files: string[] } {
  const kept = splitDiffByFile(diff).filter((block) => globs.some((glob) => matchesScopeGlob(block.path, glob)));
  return { text: kept.map((block) => block.text).join("\n"), files: kept.map((block) => block.path) };
}

/**
 * Lane scope from the AC -> Covers-task chain: the union of Scope globs of
 * every task covering any of the lane's criteria (directly by AC id, or via a
 * requirement the AC references - the same chain the prelint coverage rule
 * walks). Scoping applies ONLY when every covering task of every lane
 * criterion declared a Scope; a single undeclared task, or a criterion no
 * task covers (a global-invariant AC), keeps the lane on the full curated
 * diff - narrowing on partial declarations would hide evidence the
 * undeclared work may have touched.
 */
export function scopeForLane(
  criteria: { id: string; text: string }[],
  tasks: ScopedTask[],
): string[] | null {
  const globs = new Set<string>();
  for (const criterion of criteria) {
    // Case-insensitive + uppercased to match the lib parser, which uppercases
    // every R ref: a bullet writing "r3" must ride the same coverage chain.
    const referencedRequirements = new Set((criterion.text.match(/\br\d+\b/gi) ?? []).map((ref) => ref.toUpperCase()));
    const covering = tasks.filter(
      (task) =>
        task.acceptanceCriteria.includes(criterion.id)
        || task.requirements.some((requirement) => referencedRequirements.has(requirement)),
    );
    if (covering.length === 0) return null;
    if (covering.some((task) => task.scopeGlobs.length === 0)) return null;
    for (const task of covering) for (const glob of task.scopeGlobs) globs.add(glob);
  }
  return globs.size > 0 ? [...globs] : null;
}

/**
 * Diff-stat for the agentic fallback prompt: file list plus added/removed line
 * counts, computed from the diff text itself so an injected test diff and a
 * git-generated one produce the same summary shape.
 */
export function diffStatFromText(diff: string): string {
  const blocks = splitDiffByFile(diff);
  const lines = blocks.map((block) => {
    let added = 0;
    let removed = 0;
    for (const line of block.text.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
      else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
    }
    return `${block.path} | +${added} -${removed}`;
  });
  return `${lines.join("\n")}\n${blocks.length} file(s) changed`;
}

// --- AC oracle stage (5c) ---

export interface OracleOutcome {
  id: string;
  kind: "check" | "artifact";
  command?: string;
  path?: string;
  exitCode?: number;
  expectMatched?: boolean;
  digestViolation?: boolean;
  met: boolean;
  reason: string;
  evidence: string;
}

/**
 * Execute the PRD-declared AC oracles on the harness clock (ouroboros
 * AcceptanceCriterionSpec, scaled down): exit 0 plus optional stdout substring
 * for `Check:`, file existence for `Artifact:`. Check commands get the same
 * workspace digest guard as verify-run - an oracle that mutates the tree to
 * pass is recorded as a violation, not a pass.
 *
 * Exported so tests can pin executor parity with the harness's cmdOracleRun.
 */
export function runAcOracles(
  projectRoot: string,
  config: SasuConfig,
  targets: { id: string; text: string; oracle: AcOracle }[],
  slug?: string,
): { outcomes: OracleOutcome[]; warnings: string[] } {
  const outcomes: OracleOutcome[] = [];
  const warnings: string[] = [];
  for (const target of targets) {
    const oracle = target.oracle;
    if (oracle.kind === "artifact") {
      const artifactPath = oracle.path ?? "";
      const exists = artifactPath !== "" && fs.existsSync(path.join(projectRoot, artifactPath));
      outcomes.push({
        id: target.id,
        kind: "artifact",
        path: artifactPath,
        met: exists,
        reason: exists ? `declared artifact ${artifactPath} exists (harness-observed)` : `declared artifact ${artifactPath} does not exist`,
        evidence: `harness checked existence of ${artifactPath}`,
      });
      continue;
    }
    const command = oracle.command ?? "";
    if (DB_TOUCH_PATTERN.test(command)) {
      warnings.push(
        `${target.id}: oracle command appears to touch a database (\`${command}\`). Confirm the connection target is a disposable local or branch database, never production data.`,
      );
    }
    // Slug scopes the guard's vouched set so a concurrent session editing its
    // own agents/prd/<other>/** during the oracle window cannot falsely trip
    // this oracle's digest check (mark.js oracle-run passes the same).
    const before = vouchedTreeFingerprint({ projectRoot, slug });
    // Harness semantics, verbatim: shellLikeTokens + shell:false. The PRD
    // oracle grammar never promised shell operators, so
    // `test -f README.md && grep -c Test README.md` hands "&&" to `test` as a
    // literal argument (non-zero) in BOTH executors instead of passing here
    // and failing in oracle-run. Authors who want a shell write it
    // explicitly: `bash -c "..."` (prelint warns on bare operators).
    const tokens = shellLikeTokens(command);
    const result = spawnSync(tokens[0] ?? command, tokens.slice(1), {
      cwd: projectRoot,
      shell: false,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: config.verify.commandTimeoutMs,
      env: process.env,
    });
    const after = vouchedTreeFingerprint({ projectRoot, slug });
    const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || result.signal === "SIGTERM";
    const exitCode = timedOut ? 124 : (result.status ?? 1);
    const stdout = result.stdout ?? "";
    const expectMatched = oracle.expect ? stdout.includes(oracle.expect) : true;
    const digestViolation = Boolean(before && after && !vouchedFingerprintsMatch(before, after));
    const met = exitCode === 0 && expectMatched && !digestViolation;
    const reason =
      digestViolation && exitCode === 0
        ? `oracle command mutated the workspace during verification (digest guard): \`${command}\``
        : met
          ? `harness ran \`${command}\`: exit 0${oracle.expect ? `, output contained "${oracle.expect}"` : ""}`
          : `harness ran \`${command}\`: exit ${exitCode}${oracle.expect && !expectMatched ? `, output did not contain "${oracle.expect}"` : ""}`;
    outcomes.push({
      id: target.id,
      kind: "check",
      command,
      exitCode,
      expectMatched,
      digestViolation,
      met,
      reason,
      evidence: `harness executed \`${command}\` (exit ${exitCode})`,
    });
  }
  return { outcomes, warnings };
}

/**
 * The change under judgment, including files the run created.
 *
 * `git diff` only knows about tracked paths, so a new module - the most common
 * shape of a small task - would be invisible to the judge, and a run that only
 * adds files would produce no diff at all. Untracked files are therefore
 * rendered as add-diffs and appended. Both sides are curated by
 * isExcludedFromDiff (see its comment for what is out and why).
 */
function gitDiff(projectRoot: string, baseRef: string | undefined): string {
  const tracked = execFileSync("git", ["diff", baseRef ?? "HEAD", "--", ".", ...DIFF_EXCLUDE_PATHSPECS], {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
    .split("\0")
    .filter((file) => file !== "" && !isExcludedFromDiff(file));
  const additions: string[] = [];
  for (const file of untracked) {
    try {
      // --no-index exits 1 when the files differ, which is always here.
      execFileSync("git", ["diff", "--no-index", "--", "/dev/null", file], {
        cwd: projectRoot,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch (error) {
      const stdout = (error as { stdout?: string }).stdout;
      if (typeof stdout === "string" && stdout.trim() !== "") additions.push(stdout);
    }
  }
  return [tracked, ...additions].filter((part) => part.trim() !== "").join("\n");
}
