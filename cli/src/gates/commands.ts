import fs from "node:fs";
import path from "node:path";
import { laneEffortFor, type SasuConfig } from "../config";
import { effectiveJudgeProfile, runJudge, judgeCallRecordFrom } from "../judge/runner";
import {
  JudgeError,
  describeJudgeFailureCause,
  judgeFailureCause,
  validateGapVerdict,
  type Finding,
  type GapVerdict,
  type JudgeCallRecord,
} from "../judge/types";
import { prelintPrdCitedQuestions, prelintPrdDecisionIds, runPrelint, type PrelintResult } from "./prelint";

import {
  GAP_AUDIT_LANES,
  SPEC_LANES,
  gapAuditPrompt,
  specGatePrompt,
  type JudgeLane,
  type PriorFinding,
} from "./prompts";
import { appendAuditEntry, appendQaEntry, refreshBookkeeping, replaceQaLog, setQaLogStatus, type AuditEntryInput } from "../interview/qalog";
import {
  answerPrdGate,
  clearDelegation,
  GateStore,
  gateStatus,
  grantGateBudget,
  recordDelegation,
  hashGateInput,
  overrideGate,
  reopenPrdGate,
  recordGateResult,
  sha256Of,
  specReferral,
  admitSpecReferral,
  staleInputsFor,
  type GateId,
  type GateInput,
  type GatesState,
  type GateRecord,
  type GateStatusView,
} from "./store";

export interface GateCommandResult {
  ok: boolean;
  status: GateStatusView;
  /** Deterministic pre-judge lint result; separate from judge findings by design (D-10). */
  prelint?: PrelintResult;
  inputs?: GateInput[];
  zeroJudgeCalls?: boolean;
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

/**
 * Read a gate input document and pin its freshness hash by kind, through the
 * same function staleness recomputes with (hashGateInput): a pin computed
 * one way and recomputed another would make every PASS born STALE. `label`
 * doubles as the GateInput kind when it names "qa-log".
 */
function readInputFile(projectRoot: string, filePath: string, label: string): InputFile {
  const content = readTextFile(projectRoot, filePath, label);
  const resolved = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
  const kind = label === "qa-log" ? ("qa-log" as const) : undefined;
  const sha256 = hashGateInput(resolved, kind);
  if (sha256 === null) throw new Error(`${label} not found: ${filePath}`);
  return {
    content,
    input: {
      path: path.relative(projectRoot, resolved),
      sha256,
      ...(kind !== undefined ? { kind } : {}),
    },
  };
}

function overrideRecovery(topic: string, gate: GateId): string {
  return `To proceed anyway, the USER (never the agent) may run: sasu gate override --slug ${topic} --gate ${gate} --reason "<why>"`;
}

/**
 * The open findings set carried into a rerun (PRD gate-loop R1): every
 * finding still open on the record, by harness id. Only a PASS empties it;
 * a reopen keeps it (see reopenPrdGate). Findings without an id cannot be
 * echoed by a judge, so they cannot be carried - a record written by this
 * CLI always stamps one (recordGateResult).
 */
export function priorFindingsFor(state: ReturnType<GateStore["load"]>, gate: GateId): PriorFinding[] {
  const record = state.gates[gate];
  if (!record || record.verdict === "PASS") return [];
  return record.findings
    .filter((f): f is Finding & { id: string } => typeof f.id === "string" && f.id !== "")
    .map((f) => ({ id: f.id, severity: f.severity, area: f.area, missing: f.missing }));
}

/**
 * Authority is independent of impact. Normalize the compatibility flag from
 * disposition without changing the judge's severity; old replies fail closed.
 */
export function enforceHumanBlocking(judged: GapVerdict): GapVerdict {
  const findings = judged.findings.map((raw) => {
    const disposition = raw.disposition ?? (raw.requiresHuman ? "human_authority" : undefined);
    const finding = { ...raw, ...(disposition === undefined ? {} : { disposition }), requiresHuman: disposition === undefined ? raw.requiresHuman : disposition !== "agent_fix" };
    return finding;
  });
  return { verdict: findings.some((finding) => finding.severity !== "P2" || finding.requiresHuman) ? "BLOCK" : "PASS", findings };
}

/**
 * Delegated-run disposition (--assume-human-findings): the user's $please
 * invocation is a standing decision to trade questions for recorded,
 * veto-able assumptions, and this extends that trade to the gate's
 * human-consent findings. The judge still runs and every finding is still
 * produced and recorded (item 1: proof is never cut) - what changes is the
 * disposition: an explicitly delegable reversible finding no longer blocks,
 * while its severity is preserved in the advisory and
 * the original finding lands verbatim in GateRecord.humanAssumptions with
 * the invocation as evidence.
 *
 * Authority is a separate structured disposition; an old requiresHuman
 * reply without it stays blocked rather than guessing whether it is safe.
 * Hard authority remains blocking at every severity, including P2.
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
  const findings = converged.findings.filter((finding) => {
    if (finding.disposition !== "delegated_assumption") return true;
    assumed.push(finding);
    return false;
  });
  return {
    verdict: findings.some((finding) => finding.severity !== "P2" || finding.requiresHuman) ? "BLOCK" : "PASS",
    findings,
    assumed,
  };
}

/**
 * Mechanical lane merge (PRD judge-fanout R3, D-08): union of lane findings,
 * normalized-string dedupe keeping the higher severity, and a verdict derived
 * purely from the merged findings - any blocking-grade (P0/P1) finding means
 * BLOCK, an all-advisory (or empty) merge means PASS. Near-duplicates phrased
 * differently across lanes are an accepted tradeoff observed in calibration.
 *
 * Lane blocking (PRD gate-loop R3): a finding reported only by non-blocking
 * lanes and needing no human decision is returned in `advisories` instead of
 * `findings`, so it is recorded but cannot hold the gate. A requiresHuman
 * finding is never an advisory, whichever lane reported it. Lanes without a
 * `blocking` flag are blocking.
 *
 * Severity floor (PRINCIPLES item 13): a P0 is never an advisory either. The
 * warning lanes were demoted because their P1 scope noise cost cycles, but
 * data-tech covers credentials, storage, and migrations, so a demonstrated
 * P0 there (a leaked secret, an irreversible migration) marked
 * requiresHuman:false would otherwise ride a PASS (gate-loop verify risk
 * lane RF3, 2026-09-06).
 */
export function mergeLaneFindings(lanes: { laneId: string; findings: Finding[]; blocking?: boolean }[]): {
  verdict: "PASS" | "BLOCK";
  findings: Finding[];
  advisories: Finding[];
  dedupedCount: number;
  laneFindingCounts: Record<string, number>;
} {
  const severityRank: Record<string, number> = { P0: 0, P1: 1, P2: 2 };
  const seen = new Map<string, { finding: Finding; blocking: boolean }>();
  const laneFindingCounts: Record<string, number> = {};
  let dedupedCount = 0;
  for (const lane of lanes) {
    const laneBlocking = lane.blocking ?? true;
    laneFindingCounts[lane.laneId] = lane.findings.length;
    for (const rawFinding of lane.findings) {
      const finding = enforceHumanBlocking({ verdict: "PASS", findings: [rawFinding] }).findings[0]!;
      // An echoed prior finding keeps its id as the identity; a new one is
      // identified by its normalized text, which is what catches the same
      // gap phrased twice across lanes.
      const key = finding.id !== undefined
        ? `id:${finding.id}`
        : `text:${finding.missing.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()}`;
      const existing = seen.get(key);
      if (!existing) {
        seen.set(key, { finding, blocking: laneBlocking });
      } else {
        dedupedCount += 1;
        const findingRank = severityRank[finding.severity] ?? 3;
        const existingRank = severityRank[existing.finding.severity] ?? 3;
        const preferred =
          findingRank < existingRank
            ? finding
            : existingRank < findingRank
              ? existing.finding
              : finding.requiresHuman && !existing.finding.requiresHuman
                ? finding
                : existing.finding;
        const combined = enforceHumanBlocking({
          verdict: "PASS",
          findings: [{
            ...preferred,
            requiresHuman: existing.finding.requiresHuman || finding.requiresHuman,
            // A duplicate must retain the strongest authority boundary, independently of impact.
            disposition: [existing.finding, finding].some((f) => f.disposition === "human_authority" || (f.disposition === undefined && f.requiresHuman))
              ? "human_authority"
              : [existing.finding, finding].some((f) => f.disposition === "agent_fix" || (f.disposition === undefined && !f.requiresHuman))
                ? "agent_fix"
                : "delegated_assumption",
          }],
        }).findings[0]!;
        seen.set(key, { finding: combined, blocking: existing.blocking || laneBlocking });
      }
    }
  }
  const findings: Finding[] = [];
  const advisories: Finding[] = [];
  for (const entry of seen.values()) {
    if (entry.blocking || entry.finding.requiresHuman || entry.finding.severity === "P0") findings.push(entry.finding);
    else advisories.push(entry.finding);
  }
  const verdict = findings.some((f) => f.severity !== "P2" || f.requiresHuman) ? "BLOCK" : "PASS";
  return { verdict, findings, advisories, dedupedCount, laneFindingCounts };
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

interface RegisterRowLite {
  id: string;
  kind: string;
  area: string;
  text: string;
  priority: string;
  source: string;
  status: string;
  mapping: string;
}

const registerLib = require("../../lib/qa_register.js") as {
  parseRegisterRows: (content: string) => RegisterRowLite[] | null;
  decisionDigest: (rows: RegisterRowLite[]) => string;
};

/**
 * Per-lane digest of the Decision Register's decision cells, routed to lanes
 * exactly the way prior findings are (areaHints; an unmatched row reaches
 * every lane). Pinned at every judged round and compared on the rerun: the
 * lanes whose digest changed are the only ones allowed a new finding (PRD
 * gate-loop R1). Spec lanes hint on review axes rather than document areas,
 * so every row reaches both of them and any decision change licenses both.
 * A missing Register digests to the empty set rather than throwing: its
 * absence is already a prelint block before any judge runs.
 */
export function laneDecisionDigests(qaLogContent: string, lanes: JudgeLane[]): Record<string, string> {
  const rows = registerLib.parseRegisterRows(qaLogContent) ?? [];
  const routed = new Map<string, RegisterRowLite[]>(lanes.map((lane) => [lane.id, []]));
  for (const row of rows) {
    const area = row.area.toLowerCase();
    const matches = lanes.filter((lane) => lane.areaHints.some((hint) => area.includes(hint)));
    for (const lane of matches.length > 0 ? matches : lanes) routed.get(lane.id)!.push(row);
  }
  return Object.fromEntries(lanes.map((lane) => [lane.id, registerLib.decisionDigest(routed.get(lane.id)!)]));
}

/** The single-judge path pins one digest over the whole Register under this lane id. */
export const SINGLE_JUDGE_LANE_ID = "all";

export interface JudgedLane {
  laneId: string;
  blocking: boolean;
  findings: Finding[];
  /** Rerun only: this lane's Decision Register rows changed since the pinned round. */
  decisionsChanged: boolean;
}

export interface OpenSetOutcome {
  verdict: "PASS" | "BLOCK" | "NEEDS_HUMAN";
  /** The open set: blocking (P0/P1) and human-decision findings. */
  findings: Finding[];
  /** Recorded advisories: P2 notes, non-blocking-lane findings, assumed human findings. */
  warnings: Finding[];
  /** Prior findings no lane echoed - resolved by the revision. */
  resolved: PriorFinding[];
  /** New findings from lanes whose decisions did not change - discarded, recorded in the artifact only. */
  dropped: Finding[];
  /** Human findings converted to assumptions under a delegated run. */
  assumed: Finding[];
  judgedVerdict: "PASS" | "BLOCK";
  dedupedCount: number;
  laneFindingCounts: Record<string, number>;
}

/**
 * The open-set contract (PRD gate-loop R1-R3), applied mechanically to what
 * the lanes returned:
 *  1. On a rerun, a finding echoing a prior id is that prior finding, still
 *     open. A finding with no (or an unknown) id is new, and is kept only if
 *     its lane's decisions changed; otherwise it is dropped. So the open set
 *     is a subset of the prior set plus the changed lanes' additions, and an
 *     unchanged document converges by construction. Fresh hard authority and
 *     the severity floor are exceptions: a new P0 is admitted from any lane, because a PRD edit
 *     made to close a spec finding can introduce a security or destructive
 *     defect without touching the Decision Register, and a bound that drops
 *     a reported P0 is not convergence but blindness (RF4, 2026-09-06). A
 *     judge that invents a fresh P0 every round is the human's call to
 *     override, and that costs the same one round it always did.
 *  2. Lanes merge with dedupe; non-blocking-lane findings become warnings
 *     unless they need a human decision.
 *  3. Under a delegated run, explicitly reversible choices become assumptions.
 *  4. The verdict is a pure function of the open set: empty -> PASS, all
 *     requiresHuman -> NEEDS_HUMAN (one bundle for the user), else BLOCK.
 */
export function applyOpenSetContract(input: {
  gate?: "gap-audit" | "spec";
  prior: PriorFinding[];
  lanes: JudgedLane[];
  rerun: boolean;
  assumeEvidence?: string;
}): OpenSetOutcome {
  const priorIds = new Set(input.prior.map((f) => f.id));
  const dropped: Finding[] = [];
  const echoed = new Set<string>();
  const admitted = input.lanes.map((lane) => {
    const findings: Finding[] = [];
    for (const raw of lane.findings) {
      // Normalize legacy authority before admission, not only after merging:
      // otherwise an unchanged lane can silently discard a real authority gap.
      const finding = enforceHumanBlocking({ verdict: "PASS", findings: [raw] }).findings[0]!;
      if (!input.rerun) {
        // A first round hands out no ids; anything the judge invented is noise.
        const { id: _ignored, ...fresh } = finding;
        findings.push(fresh);
        continue;
      }
      if (finding.id !== undefined && priorIds.has(finding.id)) {
        echoed.add(finding.id);
        findings.push(finding);
        continue;
      }
      const { id: _unknown, ...fresh } = finding;
      if (lane.decisionsChanged || fresh.severity === "P0" || fresh.disposition === "human_authority") findings.push(fresh);
      else dropped.push(fresh);
    }
    return { laneId: lane.laneId, blocking: lane.blocking, findings };
  });
  const merged = mergeLaneFindings(admitted);
  const disposed = input.assumeEvidence !== undefined
    ? assumeHumanFindings({ verdict: merged.verdict, findings: merged.findings })
    : { verdict: merged.verdict, findings: merged.findings, assumed: [] as Finding[] };
  const open = disposed.findings.filter((f) => f.severity !== "P2" || f.requiresHuman);
  const warnings = [
    ...disposed.findings.filter((f) => f.severity === "P2" && !f.requiresHuman),
    ...merged.advisories,
    ...disposed.assumed.map((finding) => ({ ...finding, requiresHuman: false, recommendation: `[agent-owned assumption under the recorded delegation; record the chosen default in Decisions; user may veto] ${finding.recommendation}` })),
  ];
  const verdict: OpenSetOutcome["verdict"] = open.length === 0
    ? "PASS"
    : input.gate !== "spec" && open.every((f) => f.requiresHuman)
      ? "NEEDS_HUMAN"
      : "BLOCK";
  return {
    verdict,
    findings: open,
    warnings,
    resolved: input.prior.filter((f) => !echoed.has(f.id)),
    dropped,
    assumed: disposed.assumed,
    judgedVerdict: merged.verdict,
    dedupedCount: merged.dedupedCount,
    laneFindingCounts: merged.laneFindingCounts,
  };
}

/**
 * Record a PRD-gate round in the judged qa-log's Audit History and move its
 * lifecycle status (PRD gate-loop R5): gap-audit PASS completes the log,
 * nothing else touches the status here (reopen reactivates it in runReopen).
 * The log is re-read right before the append so the compare-and-swap only
 * ever fails on a genuinely concurrent write, not on the minutes the judge
 * took. Both the Audit History section and the status line are outside the
 * decision-cell pin, so this write never stales the verdict it records.
 */
function recordQaLogAudit(
  projectRoot: string,
  qaLogInput: GateInput | undefined,
  gate: Extract<GateId, "gap-audit" | "spec">,
  entry: Omit<AuditEntryInput, "type">,
): void {
  if (qaLogInput === undefined) return;
  const file = path.join(projectRoot, qaLogInput.path);
  const original = fs.readFileSync(file, "utf8");
  let updated = appendAuditEntry(original, { ...entry, type: gate === "gap-audit" ? "gap-audit-gate" : "spec-gate" }).content;
  if (gate === "gap-audit" && (entry.result === "pass" || entry.result === "answered")) {
    updated = setQaLogStatus(updated, "complete");
  }
  replaceQaLog(file, original, refreshBookkeeping(updated));
}

/** A referral may reopen only its existing canonical source, never a substitute log. */
function assertReferralQaLog(projectRoot: string, state: ReturnType<GateStore["load"]>, input: GateInput): void {
  if (specReferral(state) === null) return;
  const specInput = state.gates.spec?.inputs?.find((candidate) => candidate.kind === "qa-log");
  if (specInput === undefined) throw new Error("Spec referral has no pinned qa-log; restore its canonical source record before gap-audit");
  const gapInput = state.gates["gap-audit"]?.inputs?.find((candidate) => candidate.kind === "qa-log");
  const actual = fs.realpathSync(path.resolve(projectRoot, input.path));
  for (const pinned of [specInput, ...(gapInput === undefined ? [] : [gapInput])]) {
    if (actual !== fs.realpathSync(path.resolve(projectRoot, pinned.path))) {
      throw new Error(`Spec referral qa-log mismatch: use --qa-log ${pinned.path}; a referral cannot replace its canonical interview log`);
    }
  }
}

function auditEntryFor(state: GatesState, gate: Extract<GateId, "gap-audit" | "spec">, result: AuditEntryInput["result"], note?: string): Omit<AuditEntryInput, "type"> {
  const record = state.gates[gate];
  return {
    result,
    at: record.lastRunAt ?? new Date().toISOString(),
    cycle: (record.reviewReopens?.length ?? 0) + 1,
    open: record.findings,
    warnings: record.warnings ?? [],
    artifact: record.history.at(-1)?.artifact ?? null,
    ...(note !== undefined ? { note } : {}),
  };
}

async function runGapListGate(
  projectRoot: string,
  config: SasuConfig,
  topic: string,
  gate: Extract<GateId, "gap-audit" | "spec">,
  buildPrompt: (
    priorFindings: PriorFinding[],
    options: { lane?: JudgeLane; laneCount?: number; rerun?: boolean; decisionsChanged?: boolean; delegationEvidence?: string; reopenEvidence?: string },
  ) => string,
  purpose: string,
  inputs: GateInput[],
  qaLogContent: string,
  options?: { grantBudgetEvidence?: string; assumeHumanEvidence?: string },
): Promise<GateCommandResult> {
  const store = new GateStore(projectRoot, topic);
  const explicitAssumptionEvidence = options?.assumeHumanEvidence?.trim();
  if (explicitAssumptionEvidence === "") {
    throw new Error("--assume-human-findings requires the user's verbatim delegated invocation (e.g. their $please message)");
  }
  const delegationAtAdmission = store.load().delegation?.evidence;
  if (
    explicitAssumptionEvidence !== undefined
    && delegationAtAdmission !== undefined
    && explicitAssumptionEvidence !== delegationAtAdmission
  ) {
    throw new Error(
      "--assume-human-findings conflicts with the topic's stored delegation; omit the flag and use the original recorded invocation",
    );
  }
  const releaseRunLock = store.tryAcquireRunLock(gate);
  if (releaseRunLock === null) {
    const state = store.load();
    return {
      ok: false,
      status: gateStatus(state, gate, config.judge.retryBudget, projectRoot, true),
      zeroJudgeCalls: true,
      error: {
        code: "gate-in-flight",
        message: `${gate} refused: another judge run already owns this topic/gate; no judge was called`,
        recovery: "Wait for the in-flight gate to finish, then read `sasu gate status` before deciding whether another command is needed.",
      },
    };
  }
  try {
    let state = store.load();
    const referral = specReferral(state);
    if (gate === "spec" && referral !== null && (state.gates["gap-audit"]?.reviewedSpecReferral !== referral.sha256 || gateStatus(state, "gap-audit", config.judge.retryBudget, projectRoot).effective !== "PASS")) {
      return {
        ok: false, status: gateStatus(state, gate, config.judge.retryBudget, projectRoot), zeroJudgeCalls: true,
        error: { code: "gap-audit-required", message: "Spec is waiting for gap-audit to resolve its authority referral; no judge was called", recovery: `Run sasu gate gap-audit --slug ${topic} --qa-log ${inputs.find((input) => input.kind === "qa-log")!.path}, then repair the PRD and resume spec.` },
      };
    }
    if (gate === "gap-audit" && referral !== null) {
      const pending = state.gates["gap-audit"]?.reviewedSpecReferral !== referral.sha256;
      const qaLog = inputs.find((input) => input.kind === "qa-log");
      if (qaLog === undefined) throw new Error("Spec referral requires a qa-log input");
      assertReferralQaLog(projectRoot, state, qaLog);
      const file = path.resolve(projectRoot, qaLog.path);
      const original = pending ? fs.readFileSync(file, "utf8") : undefined;
      // Reactivate only after admission succeeds. A refused referral must not
      // change the document, and an unfinished re-audit must not look complete.
      state = admitSpecReferral(store, referral.sha256);
      if (original !== undefined) {
        const active = setQaLogStatus(original, "active");
        if (active !== original) replaceQaLog(file, original, refreshBookkeeping(active));
      }
    }
    if (options?.grantBudgetEvidence !== undefined) {
      state = grantGateBudget(store, state, gate, options.grantBudgetEvidence, config.judge.retryBudget);
    }
    // The standing record is the one semantic source for the whole topic. A
    // per-call flag may repeat it for an older caller, but must never replace
    // it (2026-08-23 live Observer drive: the agent passed fabricated "dummy"
    // evidence during spec closure and otherwise would have erased the user's
    // no-commit constraint).
    const assumeEvidence = state.delegation?.evidence ?? explicitAssumptionEvidence;
    const delegationEvidence = state.delegation?.evidence;
    const delegationSha256 = delegationEvidence === undefined ? undefined : sha256Of(delegationEvidence);
    const before = gateStatus(state, gate, config.judge.retryBudget, projectRoot);
    // A sealed PASS is cached: unchanged pinned inputs mean nothing to judge.
    // Changed inputs need the user's words (gate reopen); the judge is never
    // re-consulted on the agent's initiative.
    if (before.sealed) {
      if (!before.stale) return { ok: true, status: before, zeroJudgeCalls: true };
      return {
        ok: false,
        status: before,
        zeroJudgeCalls: true,
        error: {
          code: "reopen-required",
          message: `${gate} cycle ${before.reviewCycle} is sealed but its judged input changed; no judge was called`,
          recovery: `If the user wants the changed document reviewed, record their words with: sasu gate reopen --slug ${topic} --gate ${gate} --evidence "<the user's words>". Otherwise restore the sealed input.`,
        },
      };
    }
    if (before.judgeErrorLoop) {
      return {
        ok: false,
        status: before,
        zeroJudgeCalls: true,
        error: {
          code: "judge-error-loop",
          message: `${gate} refused: judge failed ${before.consecutiveErrors}/${before.judgeErrorThreshold} times in a row with cause ${before.judgeErrorCause ?? "unknown"} and without a verdict; no judge was called`,
          recovery: `Repair the judge, then record the user's approval to retry the broken backend with --grant-budget. ${overrideRecovery(topic, gate)}`,
        },
      };
    }
    const records: JudgeCallRecord[] = [];
    try {
      const record = state.gates[gate];
      const reopenEvidence = record?.reviewReopens?.at(-1)?.evidence;
      const priorFindings = priorFindingsFor(state, gate);
      // A rerun is any round after a judged one on this gate, reopen or not:
      // the pinned lane digests exist exactly when a round was judged, and
      // they are what the rerun compares against. A judge ERROR pins nothing,
      // so the next round after one is judged the way the failed round was.
      const pinnedDigests = record?.laneDigests;
      const isRerun = pinnedDigests !== undefined;
      const lanes = config.judge.fanout
        ? (gate === "gap-audit" ? GAP_AUDIT_LANES : SPEC_LANES)
        : null;
      const laneDigests = lanes === null
        ? { [SINGLE_JUDGE_LANE_ID]: registerLib.decisionDigest(registerLib.parseRegisterRows(qaLogContent) ?? []) }
        : laneDecisionDigests(qaLogContent, lanes);
      // Reopen approvals belong to the gate ledger, not synthesized interview
      // answers: that write staled the sibling PASS (2026-09-07). Still judge
      // the user's words. A substantive request can reveal an unrecorded
      // decision, and its finding must survive delta admission exactly once.
      if (reopenEvidence !== undefined) {
        for (const laneId of Object.keys(laneDigests)) {
          laneDigests[laneId] = sha256Of(JSON.stringify([laneDigests[laneId], reopenEvidence]));
        }
      }
      if (gate === "gap-audit" && referral !== null) {
        for (const laneId of Object.keys(laneDigests)) laneDigests[laneId] = sha256Of(JSON.stringify([laneDigests[laneId], referral.sha256]));
      }
      const promptWithReferral = (prompt: string): string => gate === "gap-audit" && referral !== null
        ? `${prompt}\nSPEC AUTHORITY REFERRAL (review only these new authority gaps plus the prior open set; this is not user consent):\n${JSON.stringify(referral.findings)}\nResolve against the interview evidence. Only gap-audit may return a user decision bundle.\n`
        : prompt;
      const decisionsChanged = (laneId: string): boolean =>
        isRerun && pinnedDigests[laneId] !== laneDigests[laneId];
      const effort = laneEffortFor(config, gate);

      let judged: JudgedLane[];
      let laneArtifacts: unknown[];
      if (lanes === null) {
        // Single-judge path (judge.fanout: false escape hatch, R5): one call,
        // every finding blocking-eligible, one digest over the whole Register.
        const outcome = await runJudge(
          config,
          purpose,
          "routine",
          promptWithReferral(buildPrompt(priorFindings, { rerun: isRerun, decisionsChanged: decisionsChanged(SINGLE_JUDGE_LANE_ID), delegationEvidence, reopenEvidence })),
          validateGapVerdict,
          { effort },
        );
        records.push(outcome.record);
        judged = [{ laneId: SINGLE_JUDGE_LANE_ID, blocking: true, findings: outcome.value.findings, decisionsChanged: decisionsChanged(SINGLE_JUDGE_LANE_ID) }];
        laneArtifacts = [{ laneId: SINGLE_JUDGE_LANE_ID, verdict: outcome.value.verdict, findingCount: outcome.value.findings.length, judge: outcome.record }];
      } else {
        // Lane-parallel fan-out (R1/R2): narrow judges run concurrently and the
        // CLI merges mechanically. One fan-out round is one gate attempt.
        //
        // Lanes run at the profile budget unless judge.laneEffort lowers it.
        // The older claim here - "lanes run at low effort ... judge wall time is
        // a flat per-call reasoning budget" - was wrong twice over, and both
        // halves were re-measured on 2026-08-28 (cli/scripts/effort_sweep.mjs):
        //   - It was never wired. runJudge had no override, so every lane spent
        //     the profile's xhigh (the 2026-08-28 implement-check artifacts show
        //     all four lanes at xhigh).
        //   - Wall time is NOT flat per call. On a real 626-line qa-log one
        //     fan-out round took 15s at low, 34s at medium, 85s at high; recorded
        //     production lanes ranged 23s-540s at one effort. Time tracks how
        //     much the judge finds, not a fixed budget.
        // Lowering it is therefore a real speed lever AND a real detection
        // tradeoff: at low the same document PASSed with one P2, while high
        // reported a P0 side-effect/authority gap. The budget is config, not a
        // constant, because that tradeoff belongs to the project (PRINCIPLES 9).
        const routedPrior = routePriorFindings(priorFindings, lanes);
        const settled = await Promise.all(
          lanes.map(async (lane) => {
            try {
              const outcome = await runJudge(
                config,
                `${purpose}:lane:${lane.id}`,
                "routine",
                promptWithReferral(buildPrompt(routedPrior.get(lane.id) ?? [], {
                  lane,
                  laneCount: lanes.length,
                  rerun: isRerun,
                  decisionsChanged: decisionsChanged(lane.id),
                  delegationEvidence,
                  reopenEvidence,
                })),
                validateGapVerdict,
                { effort },
              );
              return { lane, outcome, error: null };
            } catch (error) {
              return { lane, outcome: null, error };
            }
          }),
        );
        for (const entry of settled) {
          if (entry.outcome) records.push(entry.outcome.record);
          else {
            const failureRecord = judgeCallRecordFrom(entry.error);
            if (failureRecord) records.push(failureRecord);
          }
        }
        const failures = settled.filter((entry) => entry.error !== null);
        if (failures.length > 0) {
          // Fail-closed on any lane failure (D-08/D-13/D-14): rate limits,
          // timeouts, and invalid output all land here, named by lane.
          const first = failures[0]!.error;
          const code = first instanceof JudgeError ? first.code : "judge-auth-or-runtime";
          const backend = first instanceof JudgeError ? first.backend : "claude";
          const reason = first instanceof JudgeError ? first.reason : null;
          const detail = first instanceof Error ? first.message : String(first);
          const laneList = failures.map((entry) => entry.lane.id).join(", ");
          const laneError = new JudgeError(code, backend, `lane failed [${laneList}]: ${detail}`, reason);
          return recordJudgeFailure(store, state, gate, config, laneError, records, topic, undefined, inputs.find((input) => input.kind === "qa-log"));
        }
        judged = settled.map((entry) => ({
          laneId: entry.lane.id,
          blocking: entry.lane.blocking,
          findings: entry.outcome!.value.findings,
          decisionsChanged: decisionsChanged(entry.lane.id),
        }));
        laneArtifacts = settled.map((entry) => ({
          laneId: entry.lane.id,
          blocking: entry.lane.blocking,
          decisionsChanged: decisionsChanged(entry.lane.id),
          verdict: entry.outcome!.value.verdict,
          findingCount: entry.outcome!.value.findings.length,
          judge: entry.outcome!.record,
        }));
      }

      const outcome = applyOpenSetContract({ gate, prior: priorFindings, lanes: judged, rerun: isRerun, assumeEvidence });
      if (outcome.dropped.length > 0) {
        process.stderr.write(
          `sasu: ${gate}: ${outcome.dropped.length} new finding(s) from lanes whose decisions did not change were discarded (recorded in the round artifact)\n`,
        );
      }
      state = recordGateResult(
        store,
        state,
        gate,
        {
          kind: "verdict",
          verdict: outcome.verdict,
          findings: outcome.findings,
          warnings: outcome.warnings,
          laneDigests,
          inputs,
          ...(gate === "gap-audit" && referral !== null ? { reviewedSpecReferral: referral.sha256 } : {}),
          ...(delegationSha256 !== undefined ? { delegationSha256 } : {}),
          ...(assumeEvidence !== undefined ? { humanAssumption: { evidence: assumeEvidence, findings: outcome.assumed } } : {}),
          artifactPayload: {
            verdict: outcome.verdict,
            ...(gate === "gap-audit" && referral !== null ? { specReferral: referral } : {}),
            judgedVerdict: outcome.judgedVerdict,
            rerun: isRerun,
            dedupedCount: outcome.dedupedCount,
            assumedHumanFindings: outcome.assumed,
            findings: outcome.findings,
            warnings: outcome.warnings,
            resolvedFindings: outcome.resolved,
            droppedFindings: outcome.dropped,
            lanes: laneArtifacts,
            laneDigests,
            inputs,
            ...(delegationSha256 !== undefined ? { delegationSha256 } : {}),
          },
        },
        records,
      );
      recordQaLogAudit(
        projectRoot,
        inputs.find((input) => input.kind === "qa-log"),
        gate,
        auditEntryFor(state, gate, outcome.verdict === "PASS" ? "pass" : outcome.verdict === "NEEDS_HUMAN" ? "needs-human" : "block"),
      );
      const status = gateStatus(state, gate, config.judge.retryBudget, projectRoot);
      return { ok: status.effective === "PASS", status };
    } catch (error) {
      return recordJudgeFailure(store, state, gate, config, error, records, topic, undefined, inputs.find((input) => input.kind === "qa-log"));
    }
  } finally {
    releaseRunLock();
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
  const state = new GateStore(projectRoot, topic).load();
  // Check before prelint too: prelint failures are persisted gate mutations.
  assertReferralQaLog(projectRoot, state, qaLog.input);
  const delegated = state.delegation !== undefined || Boolean(gateOptions?.assumeHumanEvidence?.trim());
  const prelint = runPrelint("qa-log", qaLog.content, delegated);
  if (!prelint.ok) return prelintBlock(projectRoot, config, topic, "gap-audit", prelint);
  emitPrelintWarnings(prelint);
  const result = await runGapListGate(
    projectRoot,
    config,
    topic,
    "gap-audit",
    (prior, options) => gapAuditPrompt(qaLog.content, prior, options),
    "gate:gap-audit",
    [qaLog.input],
    qaLog.content,
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
  // Cross-document rule: the spec gate alone holds both documents, and the
  // judge's dominant P0 class was a PRD citing an invented D-id (red-team
  // 2026-08-20, 6 real spec P0s). A dangling citation blocks here at $0
  // instead of costing a judge round.
  const cross = prelintPrdDecisionIds(prd.content, qaLog.content);
  if (!cross.ok) return prelintBlock(projectRoot, config, topic, "spec", cross);
  // Same shape, one level deeper (PRD gate-loop R8): a cited Q turn must
  // hold the user's answer, not just exist.
  const cited = prelintPrdCitedQuestions(prd.content, qaLog.content);
  if (!cited.ok) return prelintBlock(projectRoot, config, topic, "spec", cited);
  emitPrelintWarnings(prelint);
  const result = await runGapListGate(
    projectRoot,
    config,
    topic,
    "spec",
    (prior, options) => specGatePrompt(prd.content, qaLog.content, prior, options),
    "gate:spec",
    [prd.input, qaLog.input],
    qaLog.content,
    gateOptions,
  );
  return { ...result, prelint };
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
  qaLogInput?: GateInput,
): GateCommandResult {
  if (!(error instanceof JudgeError)) throw error;
  const failureRecord = judgeCallRecordFrom(error);
  if (failureRecord) records.push(failureRecord);
  state = recordGateResult(
    store,
    state,
    gate,
    {
      kind: "error",
      message: error.message,
      cause: judgeFailureCause(error),
      ...(artifactPayload !== undefined ? { artifactPayload } : {}),
    },
    records,
  );
  if (gate !== "verify") {
    recordQaLogAudit(store.projectRoot, qaLogInput, gate, auditEntryFor(state, gate, "error", error.message));
  }
  // The auth recovery is built from the failure record, never hardcoded to a
  // topology. 2026-08-27 modakbul gap-audit: the primary was Codex (failed at
  // preflight) and Claude was the fallback that terminally failed, but this
  // line was a fixed "Claude judge ... Codex fallback was unavailable"
  // sentence - the operator was sent to repair the wrong backend.
  // A merged lane error carries no record of its own; the per-lane failure
  // records already collected do, so the abandoned-backend note reads the
  // most recent failing record that crossed a fallback.
  const abandoned = failureRecord?.fallback
    ?? [...records].reverse().find((entry) => entry.outcome !== "ok" && entry.fallback !== undefined)?.fallback;
  const abandonedNote = abandoned === undefined
    ? ""
    : ` The ${abandoned.backend} judge was already abandoned first (${abandoned.reason}).`;
  const authRecovery = (failed: string): string =>
    `The ${error.backend} judge ${failed}.${abandonedNote} Log in to or repair the named backend(s), then re-run.`;
  const recoveryByCode: Record<string, string> = {
    "judge-binary-missing": "Install the configured judge CLI or change the profile primary/fallback in agents/config.json.",
    "judge-auth": authRecovery("was not authenticated"),
    "judge-auth-or-runtime": authRecovery("failed authentication or runtime"),
    "judge-context-overflow": "The judge prompt exceeded its context window. Reduce the evidence or prompt scope, then re-run.",
    "judge-timeout": "Re-run; if it persists, raise judge.timeoutMs in agents/config.json.",
    "judge-invalid-output": "Re-run; if it persists, change the model in judge.profiles.routine or judge.profiles.high-risk.",
  };
  const status = gateStatus(state, gate, config.judge.retryBudget, store.projectRoot);
  // Same rule the rerun short-circuit follows: the component that ends the loop
  // is the one that has to say what is left. Every recovery line above says
  // "re-run", which is the right advice for one broken judge call and the wrong
  // advice once the same backend failure reaches its dedicated threshold - that is the
  // spin PRINCIPLES item 13 bounds, and the honest exit has to be named here
  // rather than left to the agent's patience.
  const recovery = status.judgeErrorLoop
    ? `The judge has now failed ${status.consecutiveErrors}/${status.judgeErrorThreshold} times in a row with the same cause (${status.judgeErrorCause ?? describeJudgeFailureCause(judgeFailureCause(error))}) and without returning a verdict, so this is a backend failure, not a verification failure: `
      + `the fix budget is untouched (attempts ${status.attempts}/${status.budget}) because there were never any findings to fix. `
      + `${recoveryByCode[error.code] ?? "Fix the cause and re-run."} If the backend cannot be fixed here, close the run out honestly as blocked - the gate state records the judge-error loop as the cause. `
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

/**
 * CLI seam for the only operation that opens a new gap/spec review cycle.
 * The approval/change request already lives in the reopen ledger and is
 * supplied directly to the next judge. Do not turn an operational approval
 * into a synthetic interview answer: both gates pin those answers. Actual
 * requirement changes still enter Raw Q&A and the Decision Register through
 * the interview workflow, which remains available on the reactivated log.
 */
export function runReopen(
  projectRoot: string,
  config: SasuConfig,
  topic: string,
  gate: Extract<GateId, "gap-audit" | "spec">,
  evidence: string,
): GateStatusView {
  const store = new GateStore(projectRoot, topic);
  const record = store.load().gates[gate];
  const qaLogInput = (record?.inputs ?? []).find((input) => input.kind === "qa-log");
  if (record !== undefined && record.verdict !== null && qaLogInput === undefined) {
    throw new Error(`gate reopen refused: ${gate} has no pinned qa-log input to record the user's words in; re-run the gate first`);
  }
  const state = reopenPrdGate(store, gate, evidence);
  const qaLogFile = path.join(projectRoot, qaLogInput!.path);
  const original = fs.readFileSync(qaLogFile, "utf8");
  const reactivated = setQaLogStatus(original, "active");
  const audited = appendAuditEntry(reactivated, {
    ...auditEntryFor(state, gate, "reopened", "The gate's reviewReopens ledger records the user's approval or change request; operational reopening requires no interview sync."),
    type: gate === "gap-audit" ? "gap-audit-gate" : "spec-gate",
  }).content;
  replaceQaLog(qaLogFile, original, refreshBookkeeping(audited));
  return gateStatus(state, gate, config.judge.retryBudget, projectRoot);
}

/**
 * CLI seam for `sasu gate answer`: record the user's answer to a NEEDS_HUMAN
 * bundle as a new Raw Q&A turn of the pinned qa-log, then seal the gate
 * PASS on the inputs as they stand now - no judge call (PRD gate-loop R2,
 * AC4). The agent records the decisions the answer implies (Register rows,
 * PRD text) BEFORE this command; the seal pins whatever it finds.
 */
export function runAnswer(
  projectRoot: string,
  config: SasuConfig,
  topic: string,
  gate: Extract<GateId, "gap-audit" | "spec">,
  evidence: string,
): GateStatusView {
  if (gate === "spec") throw new Error("gate answer --gate spec is retired: run gap-audit to resolve the authority referral, then resume spec");
  const store = new GateStore(projectRoot, topic);
  const record = store.load().gates[gate];
  if (record === undefined || record.verdict !== "NEEDS_HUMAN") {
    throw new Error(
      `gate answer refused: ${gate} is ${record?.verdict ?? "not run"}, not NEEDS_HUMAN; only a bundle of human questions is sealed by an answer`,
    );
  }
  if (evidence.trim() === "") throw new Error("gate answer requires the user's verbatim answer to the open human questions");
  const qaLogInput = (record.inputs ?? []).find((input) => input.kind === "qa-log");
  if (qaLogInput === undefined) {
    throw new Error(`gate answer refused: ${gate} has no pinned qa-log input to record the answer in; re-run the gate first`);
  }
  const qaLogFile = path.join(projectRoot, qaLogInput.path);
  const original = fs.readFileSync(qaLogFile, "utf8");
  const question = record.findings
    .map((finding) => `${finding.id ?? "?"} [${finding.severity}/${finding.area}] ${finding.missing}${finding.recommendation ? ` (${finding.recommendation})` : ""}`)
    .join("\n");
  const at = new Date().toISOString();
  const appended = appendQaEntry(original, {
    label: `${gate} human decision bundle (${record.findings.map((finding) => finding.id ?? "?").join(", ")})`,
    route: "user-decision",
    decisionIds: [],
    sourceRef: `gate:${gate}:answer:${at}`,
    asked: question,
    recommended: "none",
    answer: evidence.trim(),
    notes: "Recorded by sasu gate answer from the user's own words; normalize the decisions it carries into the Decision Register.",
  });
  replaceQaLog(qaLogFile, original, refreshBookkeeping(appended.content));
  const inputs = (record.inputs ?? []).map((input) => {
    const sha256 = hashGateInput(path.join(projectRoot, input.path), input.kind);
    if (sha256 === null) throw new Error(`gate answer refused: pinned input is missing: ${input.path}`);
    return { ...input, sha256 };
  });
  const state = answerPrdGate(store, gate, evidence, inputs, question);
  recordQaLogAudit(projectRoot, qaLogInput, gate, auditEntryFor(state, gate, "answered", `Q${appended.qNumber} records the user's answer to the bundle`));
  return gateStatus(state, gate, config.judge.retryBudget, projectRoot);
}

export function readGateStatus(
  projectRoot: string,
  config: SasuConfig,
  topic: string,
): Record<"gap-audit" | "spec", GateStatusView> & { judgeCallCount: number; delegation: GatesState["delegation"] | null } {
  const store = new GateStore(projectRoot, topic);
  const state = store.load();
  return {
    "gap-audit": gateStatus(state, "gap-audit", config.judge.retryBudget, projectRoot, store.isGateInFlight("gap-audit")),
    spec: gateStatus(state, "spec", config.judge.retryBudget, projectRoot, store.isGateInFlight("spec")),
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

/** CLI seam for `sasu gate delegate --clear`: revoke the stored delegation. */
export function runDelegateClear(projectRoot: string, topic: string): { cleared: boolean } {
  const store = new GateStore(projectRoot, topic);
  const state = store.load();
  const had = state.delegation !== undefined;
  clearDelegation(store, state);
  return { cleared: had };
}
