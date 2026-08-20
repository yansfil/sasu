import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { SasuConfig } from "../config";
import { resolveBackend } from "../judge/backends";
import { effectiveJudgeProfile, runJudge, judgeCallRecordFrom } from "../judge/runner";
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
import type { ImplementState } from "../implement/types";
import { implementStatePathFor } from "../runs/paths";
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
  grantGateBudget,
  recordDelegation,
  hashGateInput,
  overrideGate,
  recordGateResult,
  sha256Of,
  staleInputsFor,
  type GateId,
  type GateInput,
  type GatesState,
  type GateRecord,
  type GateStatusView,
  type VouchedTreeFingerprint,
} from "./store";

export interface GateCommandResult {
  ok: boolean;
  status: GateStatusView;
  /** Deterministic pre-judge lint result; separate from judge findings by design (D-10). */
  prelint?: PrelintResult;
  mechanical?: MechanicalResult;
  /** Per-criterion semantic verdicts returned by the judge. */
  criteria?: CriterionVerdict[];
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
   * True when no semantic judge call was possible, such as a human-only
   * result. The receipt can report that fact without re-deriving it from
   * lane counts.
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
 * Delegated-run disposition (--assume-human-findings): the user's $please
 * invocation is a standing decision to trade questions for recorded,
 * veto-able assumptions, and this extends that trade to the gate's
 * human-consent findings. The judge still runs and every finding is still
 * produced and recorded (item 1: proof is never cut) - what changes is the
 * disposition: a non-P0 requiresHuman finding no longer blocks, it is
 * demoted to an advisory P2 whose recommendation names the assumption, and
 * the original finding lands verbatim in GateRecord.humanAssumptions with
 * the invocation as evidence.
 *
 * The P0 floor is deliberate and it is the only severity line that matters
 * here: enforceHumanBlocking promotes every human finding to at least P1,
 * so P1+requiresHuman IS the normal consent question ("which delivery
 * scope?", "which retention default?") - exactly the class the user
 * delegated. P0+requiresHuman means invented consent or an unimplementable
 * document; converting that would push through the corruption the gate
 * exists to stop, so it still blocks.
 *
 * Who may turn this on is prose-guarded like --grant-budget and
 * --allow-unapproved-prd (see 5644260): the CLI has no trusted channel to
 * the conversation, so the guard is the recorded verbatim invocation the
 * user can falsify, not a harness check. What leaves with this addition
 * (item 4): the please-mode mid-run question round-trip on human findings,
 * and please's skill prose instructing agents to stop and relay them.
 */
export function assumeHumanFindings(
  converged: { verdict: "PASS" | "BLOCK"; findings: Finding[] },
): { verdict: "PASS" | "BLOCK"; findings: Finding[]; assumed: Finding[] } {
  const assumed: Finding[] = [];
  const findings = converged.findings.map((finding) => {
    if (!finding.requiresHuman || finding.severity === "P0") return finding;
    assumed.push(finding);
    return {
      ...finding,
      severity: "P2" as const,
      requiresHuman: false,
      recommendation:
        `[assumed under the recorded delegated invocation: record the chosen default in Decision Traceability; the user may veto] ${finding.recommendation}`,
    };
  });
  return {
    verdict: findings.some((finding) => finding.severity !== "P2") ? "BLOCK" : "PASS",
    findings,
    assumed,
  };
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
  options?: { grantBudgetEvidence?: string; assumeHumanEvidence?: string },
): Promise<GateCommandResult> {
  const store = new GateStore(projectRoot, topic);
  let state = store.load();
  if (options?.grantBudgetEvidence !== undefined) {
    state = grantGateBudget(store, state, gate, options.grantBudgetEvidence, config.judge.retryBudget);
  }
  if (options?.assumeHumanEvidence?.trim() === "") {
    throw new Error("--assume-human-findings requires the user's verbatim delegated invocation (e.g. their $please message)");
  }
  // Standing delegation recorded via `sasu gate delegate` applies to every
  // run on the topic; an explicit per-call flag still wins so a one-off
  // invocation can carry fresher evidence.
  const assumeEvidence = options?.assumeHumanEvidence?.trim() ?? state.delegation?.evidence;
  // Terminal-cause admission check, mirroring `implement verify`: a spent fix
  // budget or a judge-error streak refuses the run BEFORE any judge call.
  // Without it the budget was a status flag the loop never read - measured
  // 2026-08-14 (creator-assist, exploration-collection-depth): gap-audit ran
  // 9 attempts against retryBudget 8, each rerun lawfully re-blocking on
  // fresh requiresHuman findings, so the round cap PRINCIPLES item 13
  // demands existed on paper and bounded nothing.
  const before = gateStatus(state, gate, config.judge.retryBudget, projectRoot);
  if (before.budgetExhausted || before.judgeErrorLoop || before.cycleExhausted) {
    const cause = before.budgetExhausted
      ? `fix budget exhausted (${before.attempts}/${before.budget} judged non-PASS rounds)`
      : before.judgeErrorLoop
        ? `judge failed ${before.consecutiveErrors} times in a row without a verdict`
        : `cycle cap reached (${before.roundsSinceGrant}/${before.cycleCap} judged rounds, PASSes included): the fix loop is not converging`;
    return {
      ok: false,
      status: before,
      zeroJudgeCalls: true,
      error: {
        code: before.budgetExhausted ? "budget-exhausted" : before.judgeErrorLoop ? "judge-error-loop" : "cycle-exhausted",
        message: `${gate} refused: ${cause}; no judge was called`,
        recovery:
          `hand the recorded findings to the user. If the user explicitly approves another round, record their words verbatim: `
          + `sasu gate ${gate} ... --grant-budget "<the user's words>". `
          + overrideRecovery(topic, gate),
      },
    };
  }
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
      const outcome = await runJudge(config, purpose, "routine", buildPrompt(priorFindings, { rerun: isRerun }), (value) =>
        validateGapVerdict(value, { requireOrigin: isRerun }),
      );
      records.push(outcome.record);
      const humanSafe = enforceHumanBlocking(outcome.value);
      const convergedRaw = isRerun ? applyRerunConvergence(humanSafe) : { ...humanSafe, demotedCount: 0 };
      const converged = assumeEvidence !== undefined ? { ...convergedRaw, ...assumeHumanFindings(convergedRaw) } : { ...convergedRaw, assumed: [] };
      state = recordGateResult(
        store,
        state,
        gate,
        {
          kind: "verdict",
          verdict: converged.verdict,
          findings: converged.findings,
          inputs,
          ...(assumeEvidence !== undefined ? { humanAssumption: { evidence: assumeEvidence, findings: converged.assumed } } : {}),
          artifactPayload: {
            verdict: converged.verdict,
            judgedVerdict: outcome.value.verdict,
            demotedCount: converged.demotedCount,
            assumedHumanFindings: converged.assumed,
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
            "routine",
            buildPrompt(routedPrior.get(lane.id) ?? [], { lane, laneCount: lanes.length, rerun: isRerun }),
            (value) => validateGapVerdict(value, { requireOrigin: isRerun }),
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
    const convergedRaw = isRerun
      ? applyRerunConvergence({ verdict: merged.verdict, findings: merged.findings })
      : { verdict: merged.verdict, findings: merged.findings, demotedCount: 0 };
    const converged = assumeEvidence !== undefined ? { ...convergedRaw, ...assumeHumanFindings(convergedRaw) } : { ...convergedRaw, assumed: [] };
    state = recordGateResult(
      store,
      state,
      gate,
      {
        kind: "verdict",
        verdict: converged.verdict,
        findings: converged.findings,
        inputs,
        ...(assumeEvidence !== undefined ? { humanAssumption: { evidence: assumeEvidence, findings: converged.assumed } } : {}),
        artifactPayload: {
          verdict: converged.verdict,
          judgedVerdict: merged.verdict,
          demotedCount: converged.demotedCount,
          dedupedCount: merged.dedupedCount,
          assumedHumanFindings: converged.assumed,
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
  gateOptions?: { grantBudgetEvidence?: string; assumeHumanEvidence?: string },
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
    gateOptions,
  );
  return { ...result, prelint };
}

export async function runSpecGate(
  projectRoot: string,
  config: SasuConfig,
  topic: string,
  prdPath: string,
  qaLogPath: string,
  gateOptions?: { grantBudgetEvidence?: string; assumeHumanEvidence?: string },
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
    gateOptions,
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

/**
 * The open-task guard's slice of an implement run's state.json. The dependency
 * is deliberately read-only, one-way, and optional: the gate layer otherwise
 * knows nothing about implement state, and a repo that never ran implement
 * (or a corrupt state file) must behave exactly as before. The shape is
 * derived from the implement module's own schema so it can never drift from
 * what `sasu implement` actually writes.
 */
type ImplementStateSlice = Partial<Pick<ImplementState, "tasks">>;

function readImplementState(projectRoot: string, topic: string): ImplementStateSlice | null {
  try {
    // Same slug, same run: resolved by the shared run-layout authority so the
    // guard reads exactly the state `sasu implement` writes (legacy included).
    const statePath = implementStatePathFor(projectRoot, topic);
    if (!fs.existsSync(statePath)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return parsed !== null && typeof parsed === "object" ? (parsed as ImplementStateSlice) : null;
  } catch {
    // Unreadable implement state is doctor's problem, never the gate's.
    return null;
  }
}

/**
 * Judged-diff identity for a git-derived diff: the base RESOLVED to a commit
 * SHA at record time, never the ref string. A ref string names a pointer, not
 * a diff - reproduced 2026-08-11: after a FAIL recorded at `--base start`,
 * `git branch -f start HEAD` moved the ref with the worktree untouched, and
 * the ref-string comparison refused a rerun whose judged diff no longer
 * contained the failing hunk; the default base HEAD moves the same way on any
 * WIP commit (which the commit-invariant tree fingerprint cannot see either).
 * An unresolvable base records an `unresolved` form that never matches
 * ARMABLE_DIFF_SOURCE, so it can never arm a refusal.
 */
function resolveGitDiffSource(projectRoot: string, baseRef: string | undefined): string {
  const base = baseRef ?? "HEAD";
  try {
    const sha = execFileSync("git", ["rev-parse", "--verify", `${base}^{commit}`], {
      cwd: projectRoot,
      encoding: "utf8",
      // A probe must stay silent. execFileSync forwards the child's stderr to
      // the parent by default, which printed a bare "fatal: Needed a single
      // revision" ahead of the real gitDiff error on a bogus --base.
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (/^[0-9a-f]{40,64}$/.test(sha)) return `git:${sha}`;
  } catch {
    // Fall through: gitDiff below fails loudly on a truly bogus base; the
    // identity just degrades to a form that never refuses anything.
  }
  return `git:unresolved:${base}`;
}

/**
 * The only diffSource forms allowed to arm the rerun short-circuit: a base
 * pinned to a commit SHA (40-hex sha1 / 64-hex sha256 repos). Legacy records
 * carry ref strings ("git:HEAD", "git:start") which cannot prove the judged
 * diff is still the same one, so they read as unmatched and never refuse -
 * the safe default for pre-SHA-pinning files.
 */
const ARMABLE_DIFF_SOURCE = /^git:[0-9a-f]{40,64}$/;

interface RerunRefusal {
  /** The pin both the recorded verdict and the current tree agree on. */
  judgedDiffSha256: string;
}

/**
 * Would re-running the recorded verify round be refused on the current state?
 *
 * One predicate, two consumers (implemented once by design): `runVerifyGate`
 * asks it with THIS call's diffSource before spending anything, and the
 * terminal-blocked exits (finalize / review-record / the Stop hooks, via
 * verifyRerunWouldBeRefused) ask the identical-rerun form with
 * currentDiffSource null - "would an identical rerun be refused" is the
 * honest question those callers can answer without a caller-supplied base.
 *
 * Arms ONLY on a semantic-stage FAIL/BLOCK: mechanical commands and the
 * evidence/human lanes read state the vouched fingerprint cannot see, so
 * their FAILs pin their tree (item 10) but never refuse a rerun; records
 * without the stage/diff stamps (pre-field files) never refuse either.
 * Deliberate exclusions: PASS needs no twin (a fresh PASS is already reported
 * live by gateStatus freshness); ERROR is a fact about the judge, not the
 * tree, so an identical-tree retry is legitimate; an overridden record is a
 * standing user decision the harness must not re-litigate. Identical
 * fingerprints mean identical full curated repository content (reproduced
 * against the record's own pinned base via judgedDiffSha256).
 */
function armedRerunRefusal(
  projectRoot: string,
  topic: string,
  verifyRecord: GateRecord | undefined,
  currentDiffSource: string | null,
): RerunRefusal | null {
  if (verifyRecord === undefined) return null;
  if (verifyRecord.verdict !== "FAIL" && verifyRecord.verdict !== "BLOCK") return null;
  if (verifyRecord.overridden) return null;
  if (typeof verifyRecord.judgedDiffSha256 !== "string" || verifyRecord.judgedDiffSha256 === "") return null;
  if (verifyRecord.failedStage !== "semantic") return null;
  // A round that judged live material (capture output, agentic file reads)
  // is not reproducible-by-construction; only an explicit false may arm.
  // Records without the stamp cannot prove their material was diff-only, so
  // the safe default is not arming (see the GateRecord field comment).
  if (verifyRecord.usedLiveMaterial !== false) return null;
  // Without the doc-kind stamp the two callers cannot agree on whether the
  // implement run's evidence is part of the judged material, and a predicate
  // that disagrees with the gate is the livelock. No stamp, no refusal.
  if (verifyRecord.docKind === undefined) return null;
  if (verifyRecord.diffSource === undefined || !ARMABLE_DIFF_SOURCE.test(verifyRecord.diffSource)) return null;
  if (currentDiffSource !== null && verifyRecord.diffSource !== currentDiffSource) return null;
  // Defensive stamp-consistency check: an older dist's recordGateResult
  // rewrites verdict/findings/lastRunAt without knowing the stage/diff/live
  // stamps, stranding stale stamps under a verdict they did not describe -
  // and this reader would then trust them. The latest history row and the
  // record are written together by a stamp-aware dist, so any disagreement
  // (timestamp, verdict, or stamps) means mixed-dist writes: do not arm.
  const lastRow = Array.isArray(verifyRecord.history) ? verifyRecord.history[verifyRecord.history.length - 1] : undefined;
  if (
    lastRow === undefined
    || lastRow.at !== verifyRecord.lastRunAt
    || lastRow.verdict !== verifyRecord.verdict
    || lastRow.failedStage !== verifyRecord.failedStage
    || lastRow.diffSource !== verifyRecord.diffSource
    || lastRow.usedLiveMaterial !== verifyRecord.usedLiveMaterial
    || lastRow.docKind !== verifyRecord.docKind
  ) {
    return null;
  }
  // One legitimate rerun trigger lives OUTSIDE the vouched tree (the whole
  // agents/ namespace is excluded from it by design), so it must break the
  // short-circuit on its own: the pinned input documents and evidence files
  // (a quick contract lives under agents/quick/**). A record without pinned
  // inputs cannot prove its documents are unchanged and never
  // short-circuits; an explicitly-empty pin list has nothing to drift.
  const staleInputs =
    verifyRecord.inputs !== undefined && verifyRecord.inputs.length > 0 ? staleInputsFor(projectRoot, verifyRecord) : [];
  if (verifyRecord.inputs === undefined || staleInputs.length > 0) return null;
  // The question the verdict actually answered: would the judge be handed the
  // identical diff? ARMABLE_DIFF_SOURCE has already proved the base is pinned to
  // a resolved SHA, so reproducing the diff against it and comparing the hash
  // covers every file the judge saw and nothing it did not. A null answer means
  // git refused (a base that has since left the checkout): no proof, no refusal.
  const currentJudgedDiffSha256 = gitLib.judgedDiffSha256(projectRoot, verifyRecord.diffSource.slice(4));
  if (currentJudgedDiffSha256 === null || currentJudgedDiffSha256 !== verifyRecord.judgedDiffSha256) return null;
  return { judgedDiffSha256: currentJudgedDiffSha256 };
}

/**
 * Terminal-predicate half of the disputed-FAIL livelock fix: when the refusal
 * is armed on the current state, the remaining retry budget is unspendable by
 * construction - an identical `sasu verify` call exits with the refusal - so
 * the gate is terminally blocked NOW, not after N ritual reruns (reproduced
 * 2026-08-11 on quick: semantic FAIL at attempts 1/3, identical rerun refused
 * at $0, attempts frozen below the budget, the budget-exhausted honest exit
 * unreachable while the Stop hook demanded "fix and re-run"). The public form
 * of armedRerunRefusal, pinned by cli/test/unit/verify-fanout.test.mjs;
 * conservative on any failure - false means "only budgetExhausted ends the
 * loop", never a wrongly-opened exit.
 */
export function verifyRerunWouldBeRefused(projectRoot: string, topic: string): boolean {
  try {
    const state = new GateStore(projectRoot, topic).load();
    return armedRerunRefusal(projectRoot, topic, state.gates.verify, null) !== null;
  } catch {
    return false;
  }
}

interface VerifyLane {
  laneId: string;
  purpose: string;
  criteria: { id: string; text: string }[];
  index: number;
  material: EvidenceMaterial[];
  laneChecks: CheckResult[];
  liveMaterial: boolean;
  laneDiff: string;
  images: string[];
  diffChars: number;
  agentic: boolean;
  prompt: string;
}

/**
 * Semantic fan-out (mirrors the gap-audit lane pattern): the exhaustive
 * single call concentrated every criterion plus the whole diff into one
 * 75-137s prompt, so criteria are partitioned into criterion-scoped lanes
 * that run concurrently. Every lane still receives the full curated diff;
 * only criterion ownership is partitioned.
 * judge.fanout: false is the same escape hatch the gap-list gates honor.
 */
function assembleVerifyLanes(input: {
  projectRoot: string;
  config: SasuConfig;
  judgedCriteria: { id: string; text: string }[];
  diff: string;
  lane: EvidenceLane | null;
  checkResults: CheckResult[];
  skipMechanical: boolean;
}): {
  verifyLanes: VerifyLane[];
  laneCount: number;
  promptSha256: string;
  lanesManifest: { laneId: string; criteriaIds: string[]; promptSha256: string; diffChars: number; agenticFallback: boolean }[];
} {
  const { projectRoot, config, judgedCriteria, diff, lane, checkResults } = input;
  const laneCriteria = config.judge.fanout ? partitionVerifyCriteria(judgedCriteria) : [judgedCriteria];
  const laneCount = laneCriteria.length;
  // An oversized lane diff falls back to the read-only agentic judge instead
  // of hard-erroring - but only on a backend that can grant read tools; the
  // capability is checked once so every lane takes the same path.
  let backendAgentic = false;
  try {
    backendAgentic = resolveBackend(effectiveJudgeProfile(config, "routine").primary.backend).agentic;
  } catch {
    backendAgentic = false;
  }
  const assembledLanes = laneCriteria.map((criteriaSlice, index) => {
    const ids = new Set(criteriaSlice.map((c) => c.id));
    const material = lane ? lane.material.filter((item) => ids.has(item.criterionId)) : [];
    // Image attachments are rebuilt per lane from the material that carries
    // them, so a lane ships only the screenshots its own criteria pinned.
    const images = [
      ...new Set(material.filter((item) => item.attachedImage).map((item) => path.join(projectRoot, item.path))),
    ];
    const laneDiff = diff;
    const agentic = laneDiff.length > VERIFY_DIFF_MAX_CHARS;
    const laneChecks = checkResults.filter((c) => ids.has(c.criterionId));
    // Does this lane's prompt rest on anything the tree fingerprint cannot
    // see? Derived from the assembled payload rather than from a list of
    // producers, because the enumeration went stale the moment it was written:
    // it named capture commands and agentic lanes, and missed criterion
    // `check:` commands, whose live output rides into the lane under prompt
    // text saying the harness "observed the running system". A FAIL earned on
    // a gitignored service reading BROKEN then armed the rerun refusal, so
    // fixing the service could never be observed (reproduced 2026-08-11).
    // Live sources, one per prompt input: a lane the agentic judge reads live
    // files for; a harness-run check executed this round; capture-produced
    // evidence.
    // Adding a new prompt input means deciding here whether it is live.
    const liveMaterial =
      agentic || laneChecks.length > 0 || material.some((item) => item.producedBy !== undefined);
    return {
      laneId: String(index + 1),
      // A single lane IS the old exhaustive call, so it keeps the historical
      // purpose; receipts and telemetry written against it stay comparable.
      purpose: laneCount > 1 ? `gate:verify-semantic:lane:${index + 1}` : "gate:verify-semantic",
      criteria: criteriaSlice,
      index,
      material,
      laneChecks,
      liveMaterial,
      laneDiff,
      images,
      diffChars: laneDiff.length,
      agentic,
    };
  });
  // A backend that cannot run the agentic judge keeps the original contract
  // for oversized input: fail the command up front, before any judge call or
  // recorded outcome, so no retry-budget attempt is charged.
  const oversized = assembledLanes.filter((vl) => vl.agentic);
  if (oversized.length > 0 && !backendAgentic) {
    const worst = Math.max(...oversized.map((vl) => vl.diffChars));
    throw new Error(
      `diff is ${worst} chars, over the ${VERIFY_DIFF_MAX_CHARS}-char judge input budget, and the routine primary backend cannot run isolated evidence access. No judgment ran and no retry attempt was spent. Point --base at the commit you started from or split the change into independently reviewable work.`,
    );
  }
  const verifyLanes = assembledLanes.map((vl) => {
    const laneOptions = {
      mechanicalRan: !input.skipMechanical,
      ...(laneCount > 1 ? { lane: { index: vl.index + 1, count: laneCount } } : {}),
    };
    const prompt = vl.agentic
      ? agenticSemanticVerifyPrompt(diffStatFromText(vl.laneDiff), vl.criteria, vl.material, vl.laneChecks, laneOptions)
      : semanticVerifyPrompt(vl.laneDiff, vl.criteria, vl.material, vl.laneChecks, laneOptions);
    return { ...vl, prompt };
  });
  // One auditable hash of everything sent this round: the lane prompts joined
  // in lane order. For a single lane this is byte-identical to the old
  // single-prompt hash contract.
  const promptSha256 = sha256Of(verifyLanes.map((vl) => vl.prompt).join("\n"));
  const lanesManifest = verifyLanes.map((vl) => ({
    laneId: vl.laneId,
    criteriaIds: vl.criteria.map((c) => c.id),
    promptSha256: sha256Of(vl.prompt),
    // Every lane receives the same full curated diff; criterion partitioning
    // changes judgment ownership, never the evidence surface.
    diffChars: vl.diffChars,
    agenticFallback: vl.agentic,
  }));
  return { verifyLanes, laneCount, promptSha256, lanesManifest };
}

/**
 * Run every lane's semantic judge concurrently and settle the round: judge
 * call records are appended to `records` (success or failure alike), and a
 * single erroring lane fails the whole round closed (same rule as the
 * gap-audit fan-out) - a partial set of lane verdicts is not a verdict.
 */
async function settleVerifyLanes(
  projectRoot: string,
  config: SasuConfig,
  verifyLanes: VerifyLane[],
  laneCount: number,
  records: JudgeCallRecord[],
): Promise<{ lane: VerifyLane; outcome: { value: { verdict: "PASS" | "FAIL"; criteria: CriterionVerdict[] }; record: JudgeCallRecord } }[]> {
  const settled = await Promise.all(
    verifyLanes.map(async (vl) => {
      try {
        const outcome = await runJudge(
          config,
          vl.purpose,
          "routine",
          vl.prompt,
          (value, activity) => {
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
            // An agentic lane gets no diff body - only criteria backed by an
            // inlined check or artifact can honestly PASS without a file
            // read. A known-zero read trace under an unbacked PASS goes back
            // through the invalid-output ladder; an unknown trace never
            // rejects (absence of a signal is not evidence of absence).
            if (vl.agentic && activity.commands.length === 0 && activity.toolRounds === 0) {
              const backed = new Set([
                ...vl.laneChecks.map((c) => c.criterionId),
                ...vl.material.map((m) => m.criterionId),
              ]);
              const unbacked = own.filter((c) => c.verdict === "PASS" && !backed.has(c.id));
              if (unbacked.length > 0) {
                return `criteria ${unbacked.map((c) => c.id).join(", ")} passed with no inlined proof and no recorded file read - read the files you cite as evidence, then judge again`;
              }
            }
            return { verdict: own.some((c) => c.verdict === "FAIL") ? ("FAIL" as const) : ("PASS" as const), criteria: own };
          },
          {
            ...(vl.images.length > 0 ? { images: vl.images } : {}),
            // Oversized lane: the judge reads the tree itself (read-only)
            // instead of receiving the diff inline; see the lane assembly.
            ...(vl.agentic ? {
              agentic: true,
              evidencePaths: splitDiffByFile(vl.laneDiff).map((block) => block.path),
            } : {}),
            // Anchor evidence resolution to the project root. Agentic
            // backends copy exact evidencePaths into isolation.
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
    const first = failures[0]!.error;
    const code = first instanceof JudgeError ? first.code : "judge-auth-or-runtime";
    const backend = first instanceof JudgeError ? first.backend : "claude";
    const detail = first instanceof JudgeError ? first.detail : first instanceof Error ? first.message : String(first);
    const laneList = failures.map((settledLane) => settledLane.lane.laneId).join(", ");
    throw new JudgeError(code, backend, laneCount > 1 ? `lane failed [${laneList}]: ${detail}` : detail);
  }
  return settled.map((settledLane) => ({ lane: settledLane.lane, outcome: settledLane.outcome! }));
}

/**
 * The contract has one grammar: its own parser owns criteria extraction so
 * the evidence lane and the judge can never disagree about what AC3 is.
 */
function resolveVerifyCriteria(
  options: VerifyOptions,
  docKind: "prd" | "contract",
  docFile: InputFile | null,
  contract: ParsedContract | null,
): { id: string; text: string }[] {
  const criteria =
    options.criteria ?? (contract ? contract.criteria.map((c) => ({ id: c.id, text: c.text })) : extractAcceptanceCriteria(docFile!.content));
  if (criteria.length === 0) {
    throw new Error(
      docKind === "contract"
        ? "no acceptance criteria found (expected '## Acceptance Criteria' with '- AC#.' items)"
        : "no acceptance criteria found (expected '## 7. Acceptance Criteria' with '- AC#.' items)",
    );
  }
  return criteria;
}

/**
 * judgedDiff answers null when git itself refuses (a bogus base, a non-git
 * directory), which used to surface as a raw execFileSync throw; the message
 * has to name the base because that is the argument the caller controls.
 */
function resolveJudgedDiff(projectRoot: string, options: VerifyOptions): string {
  const diff = options.diffText ?? gitLib.judgedDiff(projectRoot, options.baseRef);
  if (diff === null) {
    throw new Error(
      `could not read the diff against ${options.baseRef ?? "HEAD"}: git refused. Point --base at a commit that exists in this checkout.`,
    );
  }
  if (diff.trim() === "") {
    throw new Error(
      `empty diff: nothing to verify against ${options.baseRef ?? "HEAD"}. Implement the change first, or point --base at the commit you started from. Note that gitignored files are invisible here even when they exist.`,
    );
  }
  return diff;
}

/** The quick contract's declared check/capture commands, as mechanical-stage entries. */
function contractMechanicalCommands(contract: ParsedContract): ResolvedCommand[] {
  const commands: ResolvedCommand[] = [];
  for (const check of contract.checks) {
    commands.push({ kind: "check", command: check.command, source: "contract" });
  }
  for (const criterion of contract.criteria) {
    for (const check of criterion.checks) {
      commands.push({ kind: "check", command: check.command, source: "contract", criterionIds: [criterion.id] });
    }
    for (const capture of criterion.captures) {
      commands.push({ kind: "capture", command: capture.command, source: "contract", criterionIds: [criterion.id] });
    }
  }
  return commands;
}

/**
 * FAIL-side rerun short-circuit ($0): re-asking the identical SEMANTIC
 * question - the judge reading the same judged diff (same resolved base,
 * identical vouched tree) against identical pinned inputs - can only
 * reproduce the recorded verdict; it would burn a retry-budget attempt and a
 * judge round to learn nothing. Same refusal class as the open-task guard:
 * thrown BEFORE any spend. The arming conditions live in armedRerunRefusal
 * (shared with the terminal-blocked predicate the finalize/Stop-hook exits
 * read).
 */
function enforceRerunShortCircuit(
  projectRoot: string,
  config: SasuConfig,
  topic: string,
  verifyRecord: GateRecord | undefined,
  diffSource: string,
): void {
  const refusal = armedRerunRefusal(projectRoot, topic, verifyRecord, diffSource);
  if (refusal === null) return;
  const record = verifyRecord!;
  const findingLines = record.findings.slice(0, 5).map((f) => `  - ${f.missing}`);
  const omitted = record.findings.length > 5 ? `\n  (+${record.findings.length - 5} more)` : "";
  throw new Error(
    `verify gate rerun short-circuit: the last attempt (${record.lastRunAt ?? "unknown time"}) recorded a semantic-judge ${record.verdict} `
      + `on this exact judged diff (base ${record.diffSource}, diff sha256 ${refusal.judgedDiffSha256.slice(0, 12)}), `
      + `and the pinned inputs are unchanged, so re-judging the identical semantic question can only reproduce that verdict. Recorded findings:\n`
      + `${findingLines.join("\n") || "  (none recorded)"}${omitted}\n`
      + `Change the code under judgment (or the contract/PRD), or point --base at the commit the work actually started from, and re-run. `
      // The refusal is also the terminal signal (see verifyRerunWouldBeRefused):
      // while it is armed the remaining retry budget is unspendable, so
      // "keep re-running until the budget runs out" is not a path and the
      // honest blocked close-out must be named right here - the component
      // that refuses is the one that has to say what is left.
      + `If you cannot fix the findings, close the run out honestly as blocked instead of re-running: `
      + `attempts ${record.attempts}/${config.judge.retryBudget} stay as recorded, and the gate counts as the blocker. `
      + `To force a re-judgment anyway, the USER (never the agent) may run: `
      + `sasu gate override --slug ${topic} --gate verify --reason "<why>". `
      + `No gate attempt was recorded and no judge call was made.`,
  );
}

/**
 * Open-task guard ($0, PRD path only): the gate judges the diff against the
 * PRD's COMPLETE acceptance criteria, so a call while implement tasks are
 * still pending fails legitimately and burns the retry budget.
 * Refusal is a thrown error, same class as the empty-diff check: no gate
 * attempt is recorded and no budget is spent. complete/blocked tasks never
 * block - blocked and partial handoffs legitimately run without a gate PASS.
 */
function enforceOpenTaskGuard(projectRoot: string, topic: string, allowOpenTasks: boolean): void {
  const implementState = readImplementState(projectRoot, topic);
  // Shape-tolerant like readImplementState itself: valid JSON with a non-array
  // tasks field must degrade to "no guard", not crash the gate.
  const implementTasks = Array.isArray(implementState?.tasks) ? implementState.tasks : [];
  const openTasks = implementTasks.filter((task) => task?.status === "pending");
  if (openTasks.length === 0) return;
  const shown = openTasks
    .slice(0, 8)
    .map((task) => `${task.id ?? "?"}${task.title ? ` (${task.title})` : ""}`)
    .join(", ");
  const suffix = openTasks.length > 8 ? `, +${openTasks.length - 8} more` : "";
  if (!allowOpenTasks) {
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
  // The project config DECLARES the mechanical checks this gate runs, so it is
  // a judged input, not bookkeeping: after agents/** left the vouched
  // fingerprint entirely, adding a failing verify.commands.test to
  // agents/config.json no longer staled a PASS, and the newly declared check
  // never ran before completion (reproduced 2026-08-11). Pinned whole rather
  // than as a verify-only slice because staleInputsFor recomputes hashes from
  // the file on disk - a slice hash could never match - so unrelated config
  // edits stale the gate too. That is the honest direction, and config edits
  // are rare and deliberate.
  //
  // Pinned ALWAYS, present or not: "no config" declares "run the detected
  // defaults", so its absence is a fact the verdict rests on. The `config`
  // kind's absent sentinel (cli/lib/gate_freshness.js) is what lets an absent
  // pin stay fresh while a config created after the PASS reads stale.
  const configRel = path.join("agents", "config.json");
  inputs.push({
    path: configRel,
    sha256: hashGateInput(path.join(projectRoot, configRel), "config")!,
    kind: "config",
  });

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

  if (docKind === "prd") enforceOpenTaskGuard(projectRoot, topic, options.allowOpenTasks === true);

  // Judged-diff identity of THIS call, stamped on every recorded round below
  // and required to match by the rerun short-circuit: --base changes which
  // diff is judged (the harness's own empty-diff/oversized-diff recovery
  // advice tells the agent to change it - reproduced 2026-08-11: a corrected
  // --base rerun that would PASS was refused as inevitable), and an injected
  // diff (the diffText test seam) has no git provenance at all, so a record
  // carrying "injected" must never refuse anything. The git form pins the
  // base RESOLVED to a commit SHA (see resolveGitDiffSource).
  const diffSource = options.diffText !== undefined ? "injected" : resolveGitDiffSource(projectRoot, options.baseRef);

  // FAIL-side rerun short-circuit ($0): thrown BEFORE any spend, so no
  // attempt is recorded, no judge call is made, and no history row appears.
  enforceRerunShortCircuit(projectRoot, config, topic, state.gates.verify, diffSource);

  // Stage 1: mechanical ($0). A failure here never reaches the judge (UX-02).
  // The quick contract's own check and capture commands join this stage: the
  // harness owns their execution timing, which is what makes a capture fresh
  // rather than something the agent submitted whenever it looked good.
  const contract = docKind === "contract" && docFile ? parseContract(docFile.content) : null;
  const contractCommands = contract ? contractMechanicalCommands(contract) : [];

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
  if (!options.skipMechanical || contractCommands.some((cmd) => cmd.kind === "capture")) {
    const commandsToRun = options.skipMechanical ? contractCommands.filter((cmd) => cmd.kind === "capture") : contractCommands;
    mechanical = runMechanical(projectRoot, config, commandsToRun, {
      skipProjectCommands: options.skipMechanical === true,
    });
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
          // No judged-diff pin: this FAIL happened before the diff was even
          // produced, so there is nothing a pin could vouch for. That is the
          // honest record (item 10) - the base is still stamped in diffSource,
          // and the stage stamp already keeps a mechanical FAIL from ever
          // refusing a rerun, since those commands read state no pin can see.
          failedStage: "mechanical",
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
      ? "verify resolved ZERO mechanical commands: the $0 pre-judge filter (tests/lint/build) is INACTIVE and every failure will be discovered by the judge instead. Add a safe command/automated row to the PRD verification plan, declare agents/config.json verify.commands, or place a supported manifest at the project root."
      : undefined;
  if (mechanicalWarning !== undefined) {
    process.stderr.write(`sasu: WARNING: ${mechanicalWarning}\n`);
  }
  const warningField = mechanicalWarning !== undefined ? { mechanicalWarning } : {};

  // Stage 2: semantic judge over the diff.
  if (!options.criteria && !docFile) {
    throw new Error("no acceptance-criteria source: pass --prd <path> or --contract <path>");
  }
  const criteria = resolveVerifyCriteria(options, docKind, docFile, contract);
  const diff = resolveJudgedDiff(projectRoot, options);
  // The oversized-diff guard lives at per-lane assembly. Every lane receives
  // the full curated diff and falls back to the read-only agentic judge when
  // the backend supports one.

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
        // Deliberately NO treeFingerprint pin: the fix for a missing or
        // oversized evidence artifact may live under agents/** - bookkeeping
        // the vouched fingerprint is blind to - so pinning here would let the
        // rerun short-circuit swallow the very fix its findings ask for. An
        // evidence-lane FAIL therefore never short-circuits (the stage stamp
        // says the same thing explicitly).
        failedStage: "evidence",
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
  // back as requiresHuman findings, which the Stop hook lets the agent hand
  // to the user.
  const humanLane = lane ? lane.humanFindings : [];
  const judgedCriteria = criteria.filter(
    (c) => !(lane !== null && lane.humanCriterionIds.has(c.id)),
  );
  const evidenceInputs = lane ? lane.inputs : [];
  const allInputs = [...inputs, ...evidenceInputs];

  if (judgedCriteria.length === 0) {
    // Human-only criteria cannot be certified by the semantic judge. Record a
    // closed, externally visible failure without inventing a mechanical
    // substitute for product judgment.
    const zeroJudgeFindings = [...humanLane];
    const judgedDiffSha256 = gitLib.judgedDiffHash(diff);
    const failedStage = "human";
    state = recordGateResult(
      store,
      state,
      "verify",
      {
        kind: "verdict",
        verdict: "FAIL",
        findings: zeroJudgeFindings,
        inputs: allInputs,
        judgedDiffSha256,
        failedStage,
        diffSource,
        usedLiveMaterial: false,
        docKind,
        artifactPayload: {
          stage: failedStage,
          verdict: "FAIL",
          findings: zeroJudgeFindings,
          judgedCriteriaIds: [],
          evidence: lane ? lane.artifacts : [],
          mechanical: mechanicalRecord(),
          judgedDiffSha256,
          diffSource,
          inputs: allInputs,
        },
      },
      records,
    );
    return {
      ok: false,
      status: gateStatus(state, "verify", config.judge.retryBudget, projectRoot),
      prelint,
      mechanical,
      ...warningField,
      criteria: [],
      inputs: allInputs,
      evidence: lane ? lane.artifacts : [],
      checks: collectCheckResults(),
      judgedCriteriaIds: [],
      zeroJudgeCalls: true,
    };
  }

  // Criterion-scoped checks reach the judge as evidence for their criterion;
  // a run-wide check has no criterion to name and stays a gate-only signal.
  const checkResults = collectCheckResults();

  const judgeInputs = allInputs;

  const { verifyLanes, laneCount, promptSha256, lanesManifest } = assembleVerifyLanes({
    projectRoot,
    config,
    judgedCriteria,
    diff,
    lane,
    checkResults,
    skipMechanical: options.skipMechanical === true,
  });
  // Receipt/artifact evidence roster: the quick lane's pins (content
  // stripped, hashes kept).
  const evidenceSummary: Omit<EvidenceMaterial, "text">[] = lane ? lane.artifacts : [];
  const judgedCriteriaIds = judgedCriteria.map((c) => c.id);
  try {
    const settled = await settleVerifyLanes(projectRoot, config, verifyLanes, laneCount, records);
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
    findings.push(...humanLane);
    // Pin the tree the verdict was earned on; the Stop-hook quick guard
    // recomputes this to catch code edited after a PASS, and the rerun
    // short-circuit compares a FAIL's pin against the next call's tree.
    const judgedDiffSha256 = gitLib.judgedDiffHash(diff);
    // An unjudged human criterion keeps the gate closed even when every judged
    // one passed: nobody has confirmed it yet, and the honest report of that
    // is a blocking requiresHuman finding, not a PASS.
    const passed = judgedVerdict === "PASS" && humanLane.length === 0;
    // Live-material stamp for the rerun short-circuit (see the GateRecord
    // field comment). One lane resting on live material is enough: the round's
    // verdict is the merge of every lane, so it is reproducible-by-construction
    // only if all of them are. Each lane decides this from its own assembled
    // payload (see `liveMaterial` at lane assembly).
    //
    // A capture counts even when its material reached no judged lane: an image
    // capture on a backend without attachments is routed to the human lane, so
    // the lane-derived flag misses it, yet the command re-runs every round and
    // regenerating it (after fixing whatever it captures out of tree) is a
    // legitimate reason to re-run the gate.
    const usedLiveMaterial =
      verifyLanes.some((vl) => vl.liveMaterial) || contractCommands.some((cmd) => cmd.kind === "capture");
    // Document-order verdict list for the receipt. Human criteria have no
    // verdict to quote; their findings carry the unresolved judgment.
    const verdictByIdAll = new Map<string, CriterionVerdict>(
      mergedCriteria.map((c) => [c.id, c] as const),
    );
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
        inputs: judgeInputs,
        judgedDiffSha256,
        // Only a pure semantic failure is reproducible from the pinned diff.
        // Human and declared-gap failures depend on evidence outside the judge.
        failedStage: judgedVerdict === "FAIL"
          ? "semantic"
          : "human",
        diffSource,
        usedLiveMaterial,
        docKind,
        // One fan-out round is one gate attempt: recordGateResult runs once
        // per round no matter how many lanes it took (gap-audit's rule).
        artifactPayload: {
          stage: "semantic",
          verdict: passed ? "PASS" : "FAIL",
          judgedVerdict,
          diffSource,
          usedLiveMaterial,
          criteria: resultCriteria,
          humanLane,
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
          judgedDiffSha256,
          inputs: judgeInputs,
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
      inputs: judgeInputs,
      evidence: evidenceSummary,
      checks: checkResults,
      judgedCriteriaIds,
      judgedVerdict,
    };
  } catch (error) {
    // A broken judge round does not erase the run's real work: the receipt
    // contract holds on this path too, minus the verdicts nobody produced.
    const failurePayload = {
      judgedCriteriaIds,
      promptSha256,
      diffSource,
      lanes: lanesManifest,
      checks: checkResults,
      evidence: evidenceSummary,
      mechanical: mechanicalRecord(),
      inputs: judgeInputs,
    };
    return {
      ...recordJudgeFailure(store, state, "verify", config, error, records, topic, failurePayload),
      prelint,
      mechanical,
      ...warningField,
      criteria: [],
      inputs: judgeInputs,
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
    canAttach = resolveBackend(effectiveJudgeProfile(config, "routine").primary.backend).attachments;
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
            reason: `image evidence (${artifact.path}) cannot be shown to the routine primary judge backend, which has no attachment support`,
            fix: `Review ${artifact.path} yourself and report the result, or configure judge.profiles.routine.primary.backend as "codex" in agents/config.json.`,
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
    "judge-binary-missing": "Install the configured judge CLI or change the profile primary/fallback in agents/config.json.",
    "judge-auth": "The Claude judge was not authenticated and Codex fallback was unavailable. Log in to Claude or install/log in to Codex, then re-run.",
    "judge-auth-or-runtime": "Check the judge CLI login/auth status and re-run.",
    "judge-context-overflow": "The judge prompt exceeded its context window. Reduce the evidence or prompt scope, then re-run.",
    "judge-timeout": "Re-run; if it persists, raise judge.timeoutMs in agents/config.json.",
    "judge-invalid-output": "Re-run; if it persists, change the model in judge.profiles.routine or judge.profiles.high-risk.",
  };
  const status = gateStatus(state, gate, config.judge.retryBudget, store.projectRoot);
  // Same rule the rerun short-circuit follows: the component that ends the loop
  // is the one that has to say what is left. Every recovery line above says
  // "re-run", which is the right advice for one broken judge call and the wrong
  // advice once the backend has failed `budget` times in a row - that is the
  // spin PRINCIPLES item 13 bounds, and the honest exit has to be named here
  // rather than left to the agent's patience.
  const recovery = status.judgeErrorLoop
    ? `The judge has now failed ${status.consecutiveErrors} times in a row without returning a verdict, so this is a backend failure, not a verification failure: `
      + `the fix budget is untouched (attempts ${status.attempts}/${status.budget}) because there were never any findings to fix. `
      + `${recoveryByCode[error.code] ?? "Fix the cause and re-run."} If the backend cannot be fixed here, close the run out honestly as blocked - the gate counts as the blocker and the receipt records the judge-error loop as the cause. `
      + `${overrideRecovery(topic, gate)}`
    : `${recoveryByCode[error.code] ?? "Re-run after fixing the cause."} ${overrideRecovery(topic, gate)}`;
  return {
    ok: false,
    status,
    error: { code: error.code, message: error.message, recovery },
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
): Record<GateId, GateStatusView> & { judgeCallCount: number; delegation: GatesState["delegation"] | null } {
  const store = new GateStore(projectRoot, topic);
  const state = store.load();
  return {
    "gap-audit": gateStatus(state, "gap-audit", config.judge.retryBudget, projectRoot),
    spec: gateStatus(state, "spec", config.judge.retryBudget, projectRoot),
    verify: gateStatus(state, "verify", config.judge.retryBudget, projectRoot),
    judgeCallCount: state.judgeCalls.length,
    delegation: state.delegation ?? null,
  };
}

/** CLI seam for `sasu gate delegate`: record the standing delegated-run evidence. */
export function runDelegate(projectRoot: string, topic: string, evidence: string): { at: string; evidence: string } {
  const store = new GateStore(projectRoot, topic);
  const state = recordDelegation(store, store.load(), evidence);
  return state.delegation!;
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
 * The diff-exclusion rule and the diff itself now live in cli/lib/git.js: the
 * gate produces the diff it judges and the freshness consumers reproduce it to
 * ask whether that judgment still describes the tree, and one rule with two
 * implementations is the freshness deadlock (PRINCIPLES item 3). Re-exported
 * here because this is where callers already import it from.
 */
const gitLib = require("../../lib/git.js") as {
  isExcludedFromDiff: (file: string) => boolean;
  judgedDiff: (projectRoot: string, baseRef: string | undefined) => string | null;
  judgedDiffSha256: (projectRoot: string, baseRef: string | undefined) => string | null;
  judgedDiffHash: (diffText: string) => string;
};

export const isExcludedFromDiff = gitLib.isExcludedFromDiff;

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
