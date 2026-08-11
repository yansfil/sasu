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
  CHECK_TAIL_RENDER_MAX_CHARS,
  EVIDENCE_RENDER_MAX_CHARS,
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
  type SettledCriterion,
} from "./prompts";
import {
  currentTreeFingerprint,
  freshnessHash,
  GateStore,
  gateStatus,
  hashGateInput,
  overrideGate,
  recordGateResult,
  sha256Of,
  staleInputsFor,
  type GateId,
  type GateInput,
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

const { vouchedTreeFingerprint, vouchedFingerprintsMatch, summarizeFingerprintDiff } = require("../../lib/git.js") as {
  vouchedTreeFingerprint: (options: {
    projectRoot: string;
    slug?: string | null;
    includeEntries?: boolean;
  }) => (VouchedTreeFingerprint & { entries?: [string, string][] }) | null;
  vouchedFingerprintsMatch: (recorded: unknown, current: unknown) => boolean;
  summarizeFingerprintDiff: (before: unknown, after: unknown) => { total: number; paths: string[]; text: string } | null;
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
const { shellLikeTokens, commandsMatchContract, coverageFromText } = require("../../lib/inference.js") as {
  shellLikeTokens: (command: string) => string[];
  commandsMatchContract: (actual: string, expected: string) => boolean;
  coverageFromText: (text: string) => { requirements: string[]; acceptanceCriteria: string[]; tasks: string[] };
};
// One walk over the implement run's registered evidence (tasks, ACs, V rows):
// the same collector finalize's artifact validation reads, so the gate and the
// implement layer can never disagree about what "registered" means.
const { collectArtifacts } = require("../../lib/artifacts.js") as {
  collectArtifacts: (state: ImplementStateLite) => { ownerKind: "task" | "ac" | "verification"; ownerId: string; artifact: ImplementArtifact }[];
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

/** A registered artifact entry as state_store.attachArtifact writes it; verify-run adds command/exitCode. */
interface ImplementArtifact {
  kind?: string;
  path?: string;
  command?: string;
  exitCode?: number;
  description?: string;
  createdAt?: string;
}

/**
 * The slice of an implement run's state.json the gate reads. The dependency is
 * deliberately read-only, one-way, and optional: the gate layer otherwise
 * knows nothing about implement state, and a repo that never ran implement
 * (or a corrupt state file) must behave exactly as before.
 */
interface ImplementStateLite {
  tasks?: { id?: string; title?: string; status?: string; acceptanceCriteria?: string[]; artifacts?: ImplementArtifact[] }[];
  acceptanceCriteria?: { id?: string; requirements?: string[]; artifacts?: ImplementArtifact[] }[];
  verification?: { id?: string; text?: string; matrix?: { covers?: string }; artifacts?: ImplementArtifact[] }[];
  projectRoot?: string;
  runDir?: string;
  /** Bumped by every harness write (marks, verify-run, registered artifacts); the rerun short-circuit reads it as "any new evidence since the last attempt?". */
  updatedAt?: string;
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
  currentFingerprint: VouchedTreeFingerprint;
  mode: string;
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
 * Arms ONLY on a semantic-stage FAIL/BLOCK: mechanical commands, oracles, and
 * the evidence/human lanes read state the vouched fingerprint cannot see, so
 * their FAILs pin their tree (item 10) but never refuse a rerun; records
 * without the stage/diff stamps (pre-field files) never refuse either.
 * Deliberate exclusions: PASS needs no twin (a fresh PASS is already reported
 * live by gateStatus freshness); ERROR is a fact about the judge, not the
 * tree, so an identical-tree retry is legitimate; an overridden record is a
 * standing user decision the harness must not re-litigate. Identical
 * fingerprints mean identical vouched content in scoped and fallback mode
 * alike (recomputed under the record's own scope via currentTreeFingerprint).
 */
function armedRerunRefusal(
  projectRoot: string,
  topic: string,
  verifyRecord: GateRecord | undefined,
  implementState: ImplementStateLite | null,
  currentDiffSource: string | null,
): RerunRefusal | null {
  if (verifyRecord === undefined) return null;
  if (verifyRecord.verdict !== "FAIL" && verifyRecord.verdict !== "BLOCK") return null;
  if (verifyRecord.overridden) return null;
  if (!verifyRecord.treeFingerprint) return null;
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
  // Two legitimate rerun triggers live OUTSIDE the vouched tree (the whole
  // agents/ namespace is excluded from it by design), so each must break the
  // short-circuit on its own: the pinned input documents and evidence files
  // (a quick contract lives under agents/quick/**), and the implement run's
  // registered evidence (any new verify-run/oracle observation or mark bumps
  // agents/implement/<slug>/state.json's updatedAt). A record without pinned
  // inputs cannot prove its documents are unchanged and never
  // short-circuits; an explicitly-empty pin list has nothing to drift.
  const staleInputs =
    verifyRecord.inputs !== undefined && verifyRecord.inputs.length > 0 ? staleInputsFor(projectRoot, verifyRecord) : [];
  if (verifyRecord.inputs === undefined || staleInputs.length > 0) return null;
  const evidenceUnchanged =
    implementState === null
    || (typeof implementState.updatedAt === "string"
      && verifyRecord.lastRunAt !== null
      && implementState.updatedAt <= verifyRecord.lastRunAt);
  if (!evidenceUnchanged) return null;
  const currentFingerprint = currentTreeFingerprint(projectRoot, topic, verifyRecord.treeFingerprint);
  if (currentFingerprint === null || !vouchedFingerprintsMatch(verifyRecord.treeFingerprint, currentFingerprint)) return null;
  const mode =
    typeof verifyRecord.treeFingerprint === "object"
    && "mode" in verifyRecord.treeFingerprint
    && typeof verifyRecord.treeFingerprint.mode === "string"
      ? verifyRecord.treeFingerprint.mode
      : "fallback";
  return { currentFingerprint, mode };
}

/**
 * Terminal-predicate half of the disputed-FAIL livelock fix: when the refusal
 * is armed on the current state, the remaining retry budget is unspendable by
 * construction - an identical `sasu verify` call exits with the refusal - so
 * the gate is terminally blocked NOW, not after N ritual reruns (reproduced
 * 2026-08-11 on quick: semantic FAIL at attempts 1/3, identical rerun refused
 * at $0, attempts frozen below the budget, the budget-exhausted honest exit
 * unreachable while the Stop hook demanded "fix and re-run"). Consumed by
 * cli/lib/reviews.js (verifyGateStatus.rerunRefused) and the quick Stop hook;
 * conservative on any failure - false means "only budgetExhausted ends the
 * loop", never a wrongly-opened exit.
 */
export function verifyRerunWouldBeRefused(projectRoot: string, topic: string): boolean {
  try {
    const state = new GateStore(projectRoot, topic).load();
    const record = state.gates.verify;
    // Feed the predicate the evidence the recorded round itself judged: only
    // the PRD path injects the implement run's registered evidence, so reading
    // it for a contract round would answer "not terminal" about a rerun the
    // gate refuses (the original livelock - see the docKind field comment).
    const implementState = record?.docKind === "prd" ? readImplementState(projectRoot, topic) : null;
    return armedRerunRefusal(projectRoot, topic, record, implementState, null) !== null;
  } catch {
    return false;
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

  // Judged-diff identity of THIS call, stamped on every recorded round below
  // and required to match by the rerun short-circuit: --base changes which
  // diff is judged (the harness's own empty-diff/oversized-diff recovery
  // advice tells the agent to change it - reproduced 2026-08-11: a corrected
  // --base rerun that would PASS was refused as inevitable), and an injected
  // diff (the diffText test seam) has no git provenance at all, so a record
  // carrying "injected" must never refuse anything. The git form pins the
  // base RESOLVED to a commit SHA (see resolveGitDiffSource).
  const diffSource = options.diffText !== undefined ? "injected" : resolveGitDiffSource(projectRoot, options.baseRef);

  // FAIL-side rerun short-circuit ($0): re-asking the identical SEMANTIC
  // question - the judge reading the same judged diff (same resolved base,
  // identical vouched tree) against identical pinned inputs with no new
  // implement evidence - can only reproduce the recorded verdict; it would
  // burn a retry-budget attempt and a judge round to learn nothing. Same
  // refusal class as the open-task guard above: thrown BEFORE any spend, so
  // no attempt is recorded, no judge call is made, and no history row
  // appears. The arming conditions live in armedRerunRefusal (shared with
  // the terminal-blocked predicate the finalize/Stop-hook exits read).
  const refusal = armedRerunRefusal(projectRoot, topic, state.gates.verify, implementState, diffSource);
  if (refusal !== null) {
    const verifyRecord = state.gates.verify!;
    const findingLines = verifyRecord.findings.slice(0, 5).map((f) => `  - ${f.missing}`);
    const omitted = verifyRecord.findings.length > 5 ? `\n  (+${verifyRecord.findings.length - 5} more)` : "";
    throw new Error(
      `verify gate rerun short-circuit: the last attempt (${verifyRecord.lastRunAt ?? "unknown time"}) recorded a semantic-judge ${verifyRecord.verdict} `
        + `on this exact judged diff (${verifyRecord.diffSource}) and tree (${refusal.mode}-mode vouched fingerprint ${refusal.currentFingerprint.vouched}, ${refusal.currentFingerprint.entryCount} entries), `
        + `and the pinned inputs and implement evidence are unchanged, so re-judging the identical semantic question can only reproduce that verdict. Recorded findings:\n`
        + `${findingLines.join("\n") || "  (none recorded)"}${omitted}\n`
        + `Change the code under judgment (or the contract/PRD/registered evidence), or point --base at the commit the work actually started from, and re-run. `
        // The refusal is also the terminal signal (see verifyRerunWouldBeRefused):
        // while it is armed the remaining retry budget is unspendable, so
        // "keep re-running until the budget runs out" is not a path and the
        // honest blocked close-out must be named right here - the component
        // that refuses is the one that has to say what is left.
        + `If you cannot fix the findings, close the run out honestly as blocked instead of re-running: `
        + `attempts ${verifyRecord.attempts}/${config.judge.retryBudget} stay as recorded, and the gate counts as the blocker. `
        + `To force a re-judgment anyway, the USER (never the agent) may run: `
        + `sasu gate override --slug ${topic} --gate verify --reason "<why>". `
        + `No gate attempt was recorded and no judge call was made.`,
    );
  }

  // Every recorded verdict pins the tree it was earned on (PRINCIPLES item
  // 10): the short-circuit above compares against this pin, so a FAIL that
  // skipped it would make the next identical re-run unrefusable. Best-effort
  // by design - a non-git project records null and every guard skips the
  // comparison.
  const treeFingerprintNow = (): VouchedTreeFingerprint | null => {
    try {
      return vouchedTreeFingerprint({ projectRoot, slug: topic });
    } catch {
      return null;
    }
  };

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
          // Pinned even on this early FAIL (item 10: every outcome names its
          // tree) - but the stage stamp keeps it from ever refusing a rerun:
          // mechanical commands read state the fingerprint cannot see.
          treeFingerprint: treeFingerprintNow(),
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
    const zeroJudgeFingerprint = treeFingerprintNow();
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
        // Oracle and human-lane FAILs both resolve outside what the semantic
        // judge sees (an oracle reads live out-of-tree state; a human criterion
        // waits on the user), so neither stage may ever refuse a rerun.
        failedStage: oracleFindings.length > 0 ? "oracle" : "human",
        diffSource,
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
          diffSource,
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

  // PRD-path evidence injection: the implement run's registered artifacts and
  // verify-run logs reach the judge through the same structure the quick path
  // uses (collectEvidence material/checks). Evidence enters as PROMPT MATERIAL
  // only - the judged diff's agents/** exclusion is untouched - and every
  // injected file is hash-pinned below so changing it stales the PASS.
  let backendAttachments = false;
  try {
    backendAttachments = resolveBackend(config.judge.backend).attachments;
  } catch {
    backendAttachments = false;
  }
  const judgedIdSet = new Set(judgedCriteria.map((c) => c.id));
  const injected =
    docKind === "prd" && implementState !== null
      ? collectImplementEvidence(
          projectRoot,
          implementState,
          judgedIdSet,
          new Set(freshPasses.map((entry) => entry.verificationId)),
          backendAttachments,
        )
      : EMPTY_INJECTED;
  // Contract-evidence precedent (collectEvidence pins into lane.inputs): every
  // file the judge saw joins the input pins, so freshness stays honest.
  const judgeInputs = [...allInputs, ...injected.inputs];

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
  const assembledLanes = laneCriteria.map((criteriaSlice, index) => {
    const ids = new Set(criteriaSlice.map((c) => c.id));
    const quickMaterial = lane ? lane.material.filter((item) => ids.has(item.criterionId)) : [];
    // Injected implement evidence: items routed to this lane's criteria plus
    // lane-wide (ambiguously-owned) items, deduped by path so one artifact
    // covering several of the lane's criteria rides once - but keeping EVERY
    // criterion label. The dedupe used to keep only the first entry's id, so
    // an artifact proving AC2+AC4 rendered as [AC2] alone and the judge read
    // AC4's proof as absent.
    const laneEntryByPath = new Map<string, InjectedMaterial>();
    for (const item of injected.material) {
      if (!(item.laneWide === true || ids.has(item.criterionId))) continue;
      const existing = laneEntryByPath.get(item.path);
      if (existing === undefined) {
        laneEntryByPath.set(item.path, item);
      } else if (!existing.criterionId.split(", ").includes(item.criterionId)) {
        laneEntryByPath.set(item.path, { ...existing, criterionId: `${existing.criterionId}, ${item.criterionId}` });
      }
    }
    const laneInjectedAll = [...laneEntryByPath.values()];
    // Scale guard: injected text past the per-lane budget is dropped whole and
    // counted; the prompt announces the count (never a silent absence). Images
    // ride as attachments under their own per-file budget, not prompt bytes.
    const laneInjected: InjectedMaterial[] = [];
    let injectedTextBytes = 0;
    let omittedEvidenceCount = 0;
    for (const item of laneInjectedAll) {
      const cost = item.text !== undefined ? item.text.length : 0;
      if (cost > 0 && injectedTextBytes + cost > INJECTED_EVIDENCE_LANE_MAX_BYTES) {
        omittedEvidenceCount += 1;
        continue;
      }
      injectedTextBytes += cost;
      laneInjected.push(item);
    }
    const material = [...quickMaterial, ...laneInjected];
    // Image attachments are rebuilt per lane from the material that carries
    // them, so a lane ships only the screenshots its own criteria pinned.
    const images = [
      ...new Set([
        ...quickMaterial.filter((item) => item.attachedImage).map((item) => path.join(projectRoot, item.path)),
        ...laneInjected.flatMap((item) => (item.imagePath !== undefined ? [item.imagePath] : [])),
      ]),
    ];
    const laneGlobs = anyDeclaredScope ? scopeForLane(criteriaSlice, scopedTasks) : null;
    const scoped = laneGlobs !== null ? filterDiffByGlobs(diff, laneGlobs) : null;
    // A scoped diff with zero matching files would show the judge nothing and
    // fail every criterion as absent; fall back to the full curated diff and
    // say so in the artifact, because empty-by-scope is far more often a glob
    // mistake than a real no-op.
    const scopeFellBack = scoped !== null && scoped.text.trim() === "";
    const laneDiff = scoped !== null && !scopeFellBack ? scoped.text : diff;
    const agentic = laneDiff.length > VERIFY_DIFF_MAX_CHARS;
    // Injected check TAILS ride the same per-lane budget as material text:
    // dozens of V-row command logs used to render up to 8KB each with no cap,
    // adding unmeasured hundreds of KB past the budget the material obeys. A
    // tail past the budget is dropped whole and flagged (tailOmitted) - the
    // check row itself (command, exit code, provenance) is small, bounded, and
    // is the part the judge rests a verdict on, so it always rides.
    const laneInjectedChecks: InjectedCheck[] = [];
    let omittedTailCount = 0;
    for (const check of injected.checks.filter((c) => c.laneWide === true || ids.has(c.criterionId))) {
      // Cost is what actually renders: checkSection clamps every tail to
      // CHECK_TAIL_RENDER_MAX_CHARS, so charging raw bytes would over-drop.
      const cost = Math.min(check.tail.length, CHECK_TAIL_RENDER_MAX_CHARS);
      if (cost > 0 && injectedTextBytes + cost > INJECTED_EVIDENCE_LANE_MAX_BYTES) {
        omittedTailCount += 1;
        laneInjectedChecks.push({ ...check, tail: "", tailOmitted: true });
      } else {
        injectedTextBytes += cost;
        laneInjectedChecks.push(check);
      }
    }
    const laneLiveChecks = checkResults.filter((c) => ids.has(c.criterionId));
    const laneChecks = [...laneLiveChecks, ...laneInjectedChecks];
    // Does this lane's prompt rest on anything the tree fingerprint cannot
    // see? Derived from the assembled payload rather than from a list of
    // producers, because the enumeration went stale the moment it was written:
    // it named capture commands and agentic lanes, and missed criterion
    // `check:` commands, whose live output rides into the lane under prompt
    // text saying the harness "observed the running system". A FAIL earned on
    // a gitignored service reading BROKEN then armed the rerun refusal, so
    // fixing the service could never be observed (reproduced 2026-08-11).
    // Live sources, one per prompt input: a lane the agentic judge reads live
    // files for; a harness-run check (executed this round, or reused from a
    // fresh pass whose original run read live state); capture-produced
    // evidence; and settled oracle tails, OR-ed in below once the oracles have
    // run. Injected implement logs are NOT live: they are files, hash-pinned
    // into judgeInputs, so a changed log stales the record instead.
    // Adding a new prompt input means deciding here whether it is live.
    const liveMaterial =
      agentic || laneLiveChecks.length > 0 || material.some((item) => item.producedBy !== undefined);
    return {
      laneId: String(index + 1),
      // A single lane IS the old exhaustive call, so it keeps the historical
      // purpose; receipts and telemetry written against it stay comparable.
      purpose: laneCount > 1 ? `gate:verify-semantic:lane:${index + 1}` : "gate:verify-semantic",
      criteria: criteriaSlice,
      index,
      material,
      laneInjected,
      laneInjectedChecks,
      omittedEvidenceCount,
      // Budget accounting handed to the prompt-assembly pass below, where the
      // settled oracle tails (built only after the oracles run) are charged
      // against the remainder of the same per-lane budget.
      injectedTextBytes,
      omittedTailCount,
      laneChecks,
      liveMaterial,
      laneDiff,
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
  const oversized = assembledLanes.filter((vl) => vl.agentic);
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
  // Oracle outcomes ride into every lane as settled context: the harness
  // already decided those criteria with a stronger instrument, and the judge
  // must see what it proved instead of doubting it from the diff. Prompts are
  // therefore built HERE, after the oracles ran - the only data dependency
  // that moved prompt assembly below the no-judgment exits.
  const settledContext: SettledCriterion[] = oracleOutcomes.map((outcome) => ({
    criterionId: outcome.id,
    note: outcome.reason,
    ...(outcome.tail !== undefined && outcome.tail !== "" ? { tail: outcome.tail } : {}),
  }));
  const verifyLanes = assembledLanes.map((vl) => {
    // Settled oracle TAILS are charged against the remainder of the lane's
    // injected-evidence budget (same rule as check tails above): the settled
    // note line always rides - the judge must know the criterion is decided -
    // and only the unbounded tail is droppable, whole and flagged.
    let injectedTextBytes = vl.injectedTextBytes;
    let omittedTailCount = vl.omittedTailCount;
    const laneSettled: SettledCriterion[] = settledContext.map((item) => {
      if (item.tail === undefined) return item;
      const cost = Math.min(item.tail.length, CHECK_TAIL_RENDER_MAX_CHARS);
      if (injectedTextBytes + cost > INJECTED_EVIDENCE_LANE_MAX_BYTES) {
        omittedTailCount += 1;
        return { criterionId: item.criterionId, note: item.note, tailOmitted: true };
      }
      injectedTextBytes += cost;
      return item;
    });
    const laneOptions = {
      mechanicalRan: options.skipMechanical !== true,
      ...(laneCount > 1 ? { lane: { index: vl.index + 1, count: laneCount } } : {}),
      ...(laneSettled.length > 0 ? { settled: laneSettled } : {}),
      ...(vl.omittedEvidenceCount > 0 ? { omittedEvidenceCount: vl.omittedEvidenceCount } : {}),
    };
    const prompt = vl.agentic
      ? agenticSemanticVerifyPrompt(diffStatFromText(vl.laneDiff), vl.criteria, vl.material, vl.laneChecks, laneOptions)
      : semanticVerifyPrompt(vl.laneDiff, vl.criteria, vl.material, vl.laneChecks, laneOptions);
    // An oracle tail is arbitrary live output: it can differ on the next round
    // while the outcome stays met, so it makes the lane's prompt live. A
    // tail-less settled note cannot - if the outcome itself flipped, the round
    // would be an oracle FAIL, which never arms.
    const liveMaterial = vl.liveMaterial || laneSettled.some((item) => item.tail !== undefined);
    return { ...vl, omittedTailCount, prompt, liveMaterial };
  });
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
    // What the judge saw beyond the diff (paths + hashes + owner, never
    // content): the artifact answers "was AC4's screenshot ever shown" the
    // same way judgedCriteriaIds answers "was AC4 ever sent".
    ...(vl.laneInjected.length > 0 || vl.laneInjectedChecks.length > 0 || vl.omittedEvidenceCount > 0 || vl.omittedTailCount > 0
      ? {
          injected: {
            evidence: vl.laneInjected.map((item) => ({
              criterionId: item.criterionId,
              path: item.path,
              sha256: item.sha256,
              bytes: item.bytes,
              ...(item.attachedImage === true ? { attachedImage: true } : {}),
              ...(item.truncated === true ? { truncated: true } : {}),
            })),
            checks: vl.laneInjectedChecks.map((c) => ({
              criterionId: c.criterionId,
              command: c.command,
              exitCode: c.exitCode,
              ...(c.path !== undefined ? { path: c.path } : {}),
              ...(c.tailOmitted === true ? { tailOmitted: true } : {}),
            })),
            ...(vl.omittedEvidenceCount > 0 ? { omittedCount: vl.omittedEvidenceCount } : {}),
            // Check/settled tails dropped by the per-lane budget (entries kept).
            ...(vl.omittedTailCount > 0 ? { omittedTailCount: vl.omittedTailCount } : {}),
          },
        }
      : {}),
  }));
  // Receipt/artifact evidence roster: the quick lane's pins plus every
  // injected artifact summary (content stripped, hashes kept).
  const evidenceSummary: Omit<EvidenceMaterial, "text">[] = [
    ...(lane ? lane.artifacts : []),
    ...injected.material.map(({ text: _text, imagePath: _imagePath, laneWide: _laneWide, ...summary }) => summary),
  ];
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
    // recomputes this to catch code edited after a PASS, and the rerun
    // short-circuit compares a FAIL's pin against the next call's tree.
    const treeFingerprint = treeFingerprintNow();
    // An unjudged human criterion keeps the gate closed even when every judged
    // one passed: nobody has confirmed it yet, and the honest report of that
    // is a blocking requiresHuman finding, not a PASS. A failed oracle closes
    // it the same way - the harness observed the criterion unmet.
    const passed = judgedVerdict === "PASS" && humanLane.length === 0 && oracleFindings.length === 0;
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
        inputs: judgeInputs,
        treeFingerprint,
        // The stage that closed the gate, most-out-of-tree first: any failed
        // oracle means live state the fingerprint cannot see, so the record
        // must never refuse a rerun; an open human criterion is the user's to
        // resolve; only a pure judge FAIL over this pinned diff is the
        // deterministic "semantic" case the short-circuit may refuse.
        failedStage: oracleFindings.length > 0 ? "oracle" : judgedVerdict === "FAIL" ? "semantic" : "human",
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
          // Artifacts the injection could NOT show the judge, with reasons:
          // the record must distinguish "never registered" from "registered
          // but unshowable" (missing, binary, uncontained, unattachable).
          ...(injected.omitted.length > 0 ? { injectionOmitted: injected.omitted } : {}),
          mechanical: mechanicalRecord(),
          treeFingerprint,
          ...(unscopedFiles.length > 0 ? { unscopedFiles } : {}),
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
      ...(unscopedFiles.length > 0 ? { unscopedFiles } : {}),
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
      ...(injected.omitted.length > 0 ? { injectionOmitted: injected.omitted } : {}),
      mechanical: mechanicalRecord(),
      ...(oracleOutcomes.length > 0 ? { oracle: oracleOutcomes } : {}),
      ...(unscopedFiles.length > 0 ? { unscopedFiles } : {}),
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

// --- PRD-path evidence injection (implement-run artifacts -> judge lanes) ---

/**
 * Per-lane budget for injected implement-run evidence text. Deliberately the
 * same number as the quick path's per-file cap (EVIDENCE_MAX_BYTES, 64KB): one
 * budget concept governs how much proof text a judge reads on either path, and
 * it stays well under the 160k-char diff budget so evidence never crowds the
 * change out of the judge's attention (the audited 2026-08 run showed
 * documents ahead of code doing exactly that). Past the budget, whole
 * artifacts are omitted with an explicit count in the prompt - never silently.
 */
const INJECTED_EVIDENCE_LANE_MAX_BYTES = EVIDENCE_MAX_BYTES;

/** Injected prompt material with routing metadata the lane assembly needs. */
type InjectedMaterial = EvidenceMaterial & {
  /** Absolute path for image attachments (EvidenceMaterial.path stays project-relative). */
  imagePath?: string;
  /** Owner maps to no criterion at all: shown to every lane rather than dropped. */
  laneWide?: boolean;
};
type InjectedCheck = CheckResult & { path?: string; laneWide?: boolean };

interface InjectedEvidence {
  material: InjectedMaterial[];
  checks: InjectedCheck[];
  /** Hash pins for every injected file: a changed evidence file stales the PASS. */
  inputs: GateInput[];
  /** Artifacts the gate could not show the judge, named with the reason - honesty for the payload. */
  omitted: { ownerId: string; path: string; reason: string }[];
}

const EMPTY_INJECTED: InjectedEvidence = { material: [], checks: [], inputs: [], omitted: [] };

/**
 * Head+tail excerpt whose TOTAL length (marker included) stays <= cap -
 * clampDocument semantics on raw bytes. The marker room is reserved up front
 * so a max-size excerpt still fits a budget of the same number; without the
 * reservation, an excerpt cut "to the cap" overflowed the per-lane budget by
 * its own marker and the whole artifact was dropped instead of shown.
 */
function boundedTextExcerpt(raw: Buffer, cap: number): { text: string; truncated: boolean } {
  if (raw.length <= cap) return { text: raw.toString("utf8"), truncated: false };
  const marker = (omitted: number) =>
    `\n\n[... TRUNCATED ${omitted} bytes for judge input budget; the full file's hash is pinned in the gate record ...]\n\n`;
  const half = Math.max(1, Math.floor((cap - marker(raw.length).length) / 2));
  const head = raw.subarray(0, half).toString("utf8");
  const tailText = raw.subarray(raw.length - half).toString("utf8");
  return { text: `${head}${marker(raw.length - 2 * half)}${tailText}`, truncated: true };
}

/**
 * Gather the implement run's registered evidence for the PRD-path judge lanes.
 *
 * The quick path already injects per-AC harness evidence; on the PRD path the
 * same proof exists - registered artifacts and verify-run logs in
 * agents/implement/<slug>/state.json - but the judge never saw it, so live
 * reruns showed lanes BLOCKing runtime criteria and sessions rebuilding ad-hoc
 * verification. This wires the recorded evidence into the existing injection
 * structure instead of adding any new PRD grammar.
 *
 * Routing: an artifact reaches the lanes owning its criterion ids. Owner -> AC
 * mapping mirrors the planner's own coverage rule (planning.js
 * buildCoverageMatrix): an AC owns its artifacts directly, a task's artifacts
 * follow its Covers ACs, and a V row's follow its Covers ACs plus any AC that
 * shares a covered R#. An owner that maps to SOME criterion but none that is
 * judged (oracle-settled or human-lane) is skipped - those criteria are
 * decided by a stronger authority. An owner that maps to NO criterion at all
 * is ambiguous and goes to every lane rather than being dropped.
 *
 * Fail-open like readImplementState: a damaged entry is skipped (recorded in
 * `omitted`), and a collector-level failure degrades to no injection - the
 * gate must behave exactly as before on repos without usable implement state.
 */
function collectImplementEvidence(
  projectRoot: string,
  implementState: ImplementStateLite,
  judgedIds: Set<string>,
  freshVerificationIds: Set<string>,
  canAttach: boolean,
): InjectedEvidence {
  const out: InjectedEvidence = { material: [], checks: [], inputs: [], omitted: [] };
  try {
    const acRequirements = new Map<string, string[]>();
    for (const ac of implementState.acceptanceCriteria ?? []) {
      if (typeof ac?.id === "string") acRequirements.set(ac.id, Array.isArray(ac.requirements) ? ac.requirements : []);
    }
    const taskAcs = new Map<string, string[]>();
    for (const task of implementState.tasks ?? []) {
      if (typeof task?.id === "string") taskAcs.set(task.id, Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria : []);
    }
    const verificationCovers = new Map<string, string[]>();
    for (const item of implementState.verification ?? []) {
      if (typeof item?.id !== "string") continue;
      const covers = coverageFromText(item.matrix?.covers ?? item.text ?? "");
      const acIds = new Set(covers.acceptanceCriteria);
      for (const [acId, requirements] of acRequirements) {
        if (requirements.some((requirement) => covers.requirements.includes(requirement))) acIds.add(acId);
      }
      verificationCovers.set(item.id, [...acIds]);
    }
    const ownerAcIds = (ownerKind: string, ownerId: string): string[] =>
      ownerKind === "ac" ? [ownerId] : ownerKind === "task" ? (taskAcs.get(ownerId) ?? []) : (verificationCovers.get(ownerId) ?? []);

    const pinned = new Set<string>();
    const entries = collectArtifacts(implementState);
    // Latest-log selection per (owner, command): mark.js verify-run writes one
    // timestamped command-log path per execution, so same-path supersede never
    // collapses them and a V row accumulated EVERY historical run - old exit-1
    // rows rode into the judge beside the current exit-0 row with no ordering,
    // and every one was fully read first. Only the newest run of a command is
    // the row's current result; older runs are history, skipped before any
    // file I/O and named in `omitted` so the selection stays auditable.
    const isCommandLogArtifact = (artifact: ImplementArtifact | undefined): boolean =>
      artifact !== undefined
      && artifact.kind === "command-log"
      && typeof artifact.command === "string"
      && artifact.command !== ""
      && typeof artifact.exitCode === "number";
    const commandLogKey = (entry: { ownerKind: string; ownerId: string; artifact: ImplementArtifact }): string =>
      `${entry.ownerKind}\0${String(entry.ownerId ?? "?")}\0${entry.artifact.command}`;
    const latestLogIndex = new Map<string, number>();
    // Rank on "will actually be injected", not merely "is newest": a log that
    // the loop below rejects must not take its command's row down with it. The
    // first version of this ranked on recency alone, so a missing newest run
    // dropped BOTH rows (the older as "superseded", the newer as "file not
    // found") and the judge silently lost a check it had seen; ranking on
    // existence alone moved the same harm one step over (a 0-byte newest log -
    // what `tsc --noEmit` writes on success - beat a log with real output, then
    // lost to the empty check). Every byte-count rejection is decided here from
    // one stat, so the winner is a log that can be shown. Content rejections
    // (binary, unreadable) still need the read and stay in the loop; a log file
    // holding NUL bytes is not a shape this harness produces.
    const survivingLogs = new Set<number>();
    entries.forEach((entry, index) => {
      if (!isCommandLogArtifact(entry.artifact)) return;
      const relPath = typeof entry.artifact.path === "string" ? entry.artifact.path : "";
      if (relPath === "") return;
      const resolved = path.join(projectRoot, relPath);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(resolved);
      } catch {
        return;
      }
      if (stat.size === 0 || containmentProblem(projectRoot, resolved) !== null) return;
      survivingLogs.add(index);
      const key = commandLogKey(entry);
      const prev = latestLogIndex.get(key);
      // createdAt is ISO-8601 (lexically ordered); a missing or equal stamp
      // falls back to state order, where the later registration wins.
      if (prev === undefined || String(entry.artifact.createdAt ?? "") >= String(entries[prev]!.artifact.createdAt ?? "")) {
        latestLogIndex.set(key, index);
      }
    });

    for (const [index, entry] of entries.entries()) {
      const artifact = entry.artifact;
      const relPath = typeof artifact?.path === "string" ? artifact.path : "";
      if (relPath === "") continue;
      const ownerId = String(entry.ownerId ?? "?");
      try {
        // A log whose file is gone was never ranked, so it falls through to the
        // stat below and is reported as missing rather than as superseded.
        if (isCommandLogArtifact(artifact) && survivingLogs.has(index) && latestLogIndex.get(commandLogKey(entry)) !== index) {
          out.omitted.push({ ownerId, path: relPath, reason: "superseded by a newer run of the same command" });
          continue;
        }
        const mapped = ownerAcIds(entry.ownerKind, ownerId);
        const judgedTargets = mapped.filter((id) => judgedIds.has(id));
        // Owned by criteria a stronger authority already settled (oracle or
        // human lane): the artifact would only duplicate a decided verdict.
        if (mapped.length > 0 && judgedTargets.length === 0) continue;
        const laneWide = mapped.length === 0;
        const targets = laneWide ? [ownerId] : judgedTargets;

        const resolved = path.join(projectRoot, relPath);
        // Stat before read: emptiness and the image attachment budget are
        // byte-count decisions, so an empty file or an oversized screenshot
        // is omitted without paying to read it (V rows accumulate large
        // artifacts; reading megabytes just to drop them was pure waste).
        // A skipped-without-read artifact is not pinned - the judge never saw
        // it, and injectionOmitted names it with its reason.
        let stat: fs.Stats;
        try {
          stat = fs.statSync(resolved);
        } catch {
          out.omitted.push({ ownerId, path: relPath, reason: "file not found" });
          continue;
        }
        // Same containment rule as the quick evidence lane: whatever the gate
        // ships to an external judge must really live inside the project.
        const containment = containmentProblem(projectRoot, resolved);
        if (containment !== null) {
          out.omitted.push({ ownerId, path: relPath, reason: containment });
          continue;
        }
        if (stat.size === 0) {
          out.omitted.push({ ownerId, path: relPath, reason: "file is empty" });
          continue;
        }
        const isImage = IMAGE_EXTENSIONS.has(path.extname(relPath).toLowerCase());
        if (isImage && !canAttach) {
          out.omitted.push({ ownerId, path: relPath, reason: "judge backend has no image attachment support" });
          continue;
        }
        if (isImage && stat.size > IMAGE_MAX_BYTES) {
          out.omitted.push({ ownerId, path: relPath, reason: `image is ${stat.size} bytes, over the ${IMAGE_MAX_BYTES}-byte attachment budget` });
          continue;
        }
        const raw = fs.readFileSync(resolved);
        const sha256 = sha256Of(raw);
        if (!pinned.has(relPath)) {
          pinned.add(relPath);
          out.inputs.push({ path: relPath, sha256, kind: "evidence" });
        }

        if (isCommandLogArtifact(artifact)) {
          if (raw.includes(0)) {
            out.omitted.push({ ownerId, path: relPath, reason: "binary content" });
            continue;
          }
          // Recorded, not "just now": the provenance stamps WHEN the check
          // ran (the row's recorded time, so an old pass cannot masquerade as
          // current) and whether its pass is still fresh on the current tree,
          // so the judge can weigh a possibly-stale log honestly.
          const freshness =
            entry.ownerKind === "verification"
              ? freshVerificationIds.has(ownerId)
                ? "; its pass is still fresh on the current tree"
                : "; the tree may have changed since"
              : "";
          const recordedAt =
            typeof artifact.createdAt === "string" && artifact.createdAt !== "" ? ` at ${artifact.createdAt}` : "";
          const provenance = `the implement harness ran \`${artifact.command}\` earlier in the run (verify-run recorded on ${ownerId}${recordedAt}${freshness})`;
          const tail = raw.toString("utf8").split("\n").slice(-30).join("\n");
          for (const target of targets) {
            out.checks.push({
              criterionId: target,
              command: artifact.command!,
              exitCode: artifact.exitCode!,
              tail,
              provenance,
              path: relPath,
              ...(laneWide ? { laneWide: true } : {}),
            });
          }
          continue;
        }

        // Honest authority split: the harness hashed this file, it did not
        // collect it - a plain record-artifact registration is the implementing
        // session's own bytes and must never wear harness-collected framing
        // (evidenceSection routes producedBy-less items to the REGISTERED
        // section for the same reason).
        const provenance = `registered as ${artifact.kind ?? "file"} evidence by the implementing session (owner ${ownerId}); origin not verified by the harness - weigh accordingly`;
        if (isImage) {
          // No second copy of the attachability/budget rule here: both are
          // byte-count decisions, so they are settled from the stat above
          // before anything is read (PRINCIPLES item 3 - one rule, one site).
          for (const target of targets) {
            out.material.push({
              criterionId: target,
              path: relPath,
              sha256,
              bytes: raw.length,
              attachedImage: true,
              provenance,
              imagePath: resolved,
              ...(laneWide ? { laneWide: true } : {}),
            });
          }
          continue;
        }
        if (raw.includes(0)) {
          out.omitted.push({ ownerId, path: relPath, reason: "binary content" });
          continue;
        }
        // Oversized text is excerpted, not blocked: the quick path blocks so
        // its AUTHOR shrinks the file, but implement bookkeeping has no author
        // in this loop to push back on (PRINCIPLES item 7) - the honest move
        // is a marked excerpt plus the full-file hash pin. The excerpt is cut
        // to the render clamp exactly, so evidenceSection never re-truncates
        // it and its explicit byte marker survives into the prompt.
        const { text, truncated } = boundedTextExcerpt(raw, EVIDENCE_RENDER_MAX_CHARS);
        for (const target of targets) {
          out.material.push({
            criterionId: target,
            path: relPath,
            sha256,
            bytes: raw.length,
            text,
            provenance,
            ...(truncated ? { truncated: true } : {}),
            ...(laneWide ? { laneWide: true } : {}),
          });
        }
      } catch {
        out.omitted.push({ ownerId, path: relPath, reason: "unreadable" });
      }
    }
  } catch {
    return EMPTY_INJECTED;
  }
  return out;
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
  /** Bounded, prefixed (~changed/+added/-removed) vouched paths the digest guard saw move; only present on a violation. */
  changedPaths?: string[];
  met: boolean;
  reason: string;
  evidence: string;
  /**
   * Bounded stdout/stderr tail of the oracle command. Kept (not discarded
   * after the substring test) so judge lanes can see WHAT the oracle observed,
   * not just that it passed - the missing context that made judges BLOCK
   * runtime criteria in live reruns.
   */
  tail?: string;
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
    // Entries ride along (free - already computed internally) so a violation
    // can name WHICH paths moved instead of reporting a bare boolean.
    const before = vouchedTreeFingerprint({ projectRoot, slug, includeEntries: true });
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
    const after = vouchedTreeFingerprint({ projectRoot, slug, includeEntries: true });
    const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || result.signal === "SIGTERM";
    const exitCode = timedOut ? 124 : (result.status ?? 1);
    const stdout = result.stdout ?? "";
    const expectMatched = oracle.expect ? stdout.includes(oracle.expect) : true;
    // Same bounded-tail convention as the mechanical stage (runMechanical):
    // last 30 lines of combined output, enough for a judge to see what the
    // oracle observed without unbounded prompt growth.
    const combinedOutput = [stdout, result.stderr ?? ""].filter((part) => part !== "").join("\n");
    const tail = combinedOutput === "" ? "" : combinedOutput.split("\n").slice(-30).join("\n");
    const digestViolation = Boolean(before && after && !vouchedFingerprintsMatch(before, after));
    const digestDiff = digestViolation ? summarizeFingerprintDiff(before, after) : null;
    const met = exitCode === 0 && expectMatched && !digestViolation;
    const reason =
      digestViolation && exitCode === 0
        ? `oracle command mutated the workspace during verification (digest guard: ${digestDiff !== null ? digestDiff.text : "changed paths unavailable"}): \`${command}\``
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
      ...(digestDiff !== null ? { changedPaths: digestDiff.paths } : {}),
      met,
      reason,
      evidence: `harness executed \`${command}\` (exit ${exitCode})`,
      ...(tail !== "" ? { tail } : {}),
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
