import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Finding, GapVerdict, JudgeCallRecord } from "../judge/types";

export type GateId = "gap-audit" | "spec" | "verify";

/**
 * A gate input pinned by content hash at the moment the gate ran.
 *
 * `document` inputs (the default) hash the markdown body only, so lifecycle
 * frontmatter flips do not stale a PASS. `evidence` inputs are the quick
 * path's proof artifacts - logs, API dumps, screenshots - and hash their raw
 * bytes: every byte is substance there, and a screenshot is not text.
 */
export interface GateInput {
  path: string;
  sha256: string;
  kind?: "document" | "evidence";
}

export interface StaleInput {
  path: string;
  reason: "changed" | "missing" | "unverifiable";
}

export function sha256Of(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

// Canonical freshness implementation lives in cli/lib/gate_freshness.js so the
// Stop-hook quick guard (plain JS, no dist dependency) hashes identically.
const freshnessLib = require("../../lib/gate_freshness.js") as {
  FRESHNESS_CONTRACT_VERSION: number;
  freshnessHash: (content: string) => string;
  hashGateInput: (absPath: string, kind: string | undefined) => string | null;
};

export const FRESHNESS_CONTRACT_VERSION = freshnessLib.FRESHNESS_CONTRACT_VERSION;

export function freshnessHash(content: string): string {
  return freshnessLib.freshnessHash(content);
}

export interface GateDeviation {
  at: string;
  gate: GateId;
  reason: string;
  by: "user";
}

/**
 * Which verify stage produced a non-PASS verdict. The rerun short-circuit may
 * arm ONLY on "semantic": the "identical tree ⇒ identical verdict" premise
 * holds for a judge reading a pinned diff, but mechanical commands and PRD
 * oracles read state the vouched fingerprint cannot see (gitignored
 * node_modules/, build outputs, running servers - reproduced 2026-08-11: a
 * mechanical FAIL on a missing gitignored marker refused the rerun after the
 * legitimate out-of-tree fix). "human" covers a round closed only by
 * requiresHuman criteria; it is the user's to resolve, never refusable.
 */
export type VerifyFailedStage = "mechanical" | "evidence" | "oracle" | "human" | "semantic";

export interface GateRunSummary {
  at: string;
  verdict: "PASS" | "BLOCK" | "FAIL" | "ERROR";
  findingCount: number;
  requiresHuman: boolean;
  error: string | null;
  artifact: string | null;
  /**
   * The vouched tree this attempt's verdict was earned on (item 10: a verdict
   * names its tree). Lets the FAIL-side rerun short-circuit compare against
   * the latest attempt even across PASS-reset cycles; entries without it
   * (pre-2nd-wave files) simply never short-circuit.
   */
  treeFingerprint?: VouchedTreeFingerprint | null;
  /** Stage that produced a non-PASS verdict; absent on PASS and on pre-field rows. */
  failedStage?: VerifyFailedStage;
  /** Judged-diff identity of the round: "git:<base>" or "injected" (test seam). */
  diffSource?: string;
}

/**
 * Content-based tree fingerprint (cli/lib/git.js vouchedTreeFingerprint): the
 * files the verdict vouches for, hashed by blob content, commit-invariant,
 * and blind to harness bookkeeping. `mode`/`scopeGlobs` describe the vouched
 * set so a consumer can recompute the identical fingerprint later.
 */
export interface VouchedTreeFingerprint {
  vouched: string;
  entryCount: number;
  mode?: "scoped" | "fallback";
  scopeGlobs?: string[];
}

/**
 * Pre-consolidation fingerprint shape still present in recorded gates.json
 * files in the wild. Never written anymore and never matches a current
 * fingerprint, so a PASS carrying it reads as STALE (one honest re-run)
 * instead of crashing or passing on stale proof.
 */
export interface LegacyTreeFingerprint {
  headSha: string | null;
  statusHash: string;
}

export interface GateRecord {
  verdict: "PASS" | "BLOCK" | "FAIL" | "ERROR" | null;
  /** Retry-budget gauge: counts consecutive non-PASS runs and RESETS to 0 on PASS. */
  attempts: number;
  /**
   * Cumulative run counter: every recorded outcome - PASS, FAIL, BLOCK, and
   * judge ERROR alike - increments it, and nothing ever resets it. Exists
   * because receipts reported the budget gauge as if it were cumulative and
   * three live-session receipts all showed 0 attempts on gates that had
   * actually run (the gauge had just been reset by the final PASS). Absent on
   * pre-2nd-wave gates.json files; consumers report null there, never a guess.
   */
  totalAttempts?: number;
  overridden: boolean;
  findings: Finding[];
  lastRunAt: string | null;
  history: GateRunSummary[];
  /** Input documents hashed at the last verdict run; absent on pre-0.2 state files. */
  inputs?: GateInput[];
  /**
   * Worktree fingerprint captured at the last verdict run (verify gate only):
   * a PASS vouches for the tree it was earned on, and the Stop-hook quick
   * guard recomputes this to detect code edited after the pass. Null when the
   * project is not a git checkout.
   */
  treeFingerprint?: VouchedTreeFingerprint | LegacyTreeFingerprint | null;
  /**
   * Verify gate only: the stage that produced the last non-PASS verdict. The
   * rerun short-circuit arms only on "semantic" (see VerifyFailedStage);
   * records without the field - other gates, pre-field files - never refuse.
   */
  failedStage?: VerifyFailedStage;
  /**
   * Verify gate only: identity of the judged diff the verdict was earned on -
   * "git:<resolved base ref>" or "injected" (the diffText test seam). A rerun
   * with a different base judges a DIFFERENT diff (reproduced 2026-08-11: a
   * corrected --base rerun that would PASS was refused as inevitable), so the
   * short-circuit requires this to match; "injected" never arms it.
   */
  diffSource?: string;
}

export interface GatesState {
  schema: 1;
  topic: string;
  gates: Record<GateId, GateRecord>;
  deviations: GateDeviation[];
  judgeCalls: JudgeCallRecord[];
}

const EMPTY_GATE: GateRecord = {
  verdict: null,
  attempts: 0,
  overridden: false,
  findings: [],
  lastRunAt: null,
  history: [],
};

export class GateStore {
  readonly projectRoot: string;
  readonly topic: string;
  readonly dir: string;
  readonly statePath: string;
  readonly artifactsDir: string;

  constructor(projectRoot: string, topic: string) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(topic)) {
      throw new Error(`invalid topic slug: ${topic} (use kebab-case)`);
    }
    this.projectRoot = projectRoot;
    this.topic = topic;
    this.dir = path.join(projectRoot, "agents", "gates", topic);
    this.statePath = path.join(this.dir, "gates.json");
    this.artifactsDir = path.join(this.dir, "artifacts");
  }

  load(): GatesState {
    if (!fs.existsSync(this.statePath)) {
      return {
        schema: 1,
        topic: this.topic,
        gates: {
          "gap-audit": { ...EMPTY_GATE },
          spec: { ...EMPTY_GATE },
          verify: { ...EMPTY_GATE },
        },
        deviations: [],
        judgeCalls: [],
      };
    }
    return JSON.parse(fs.readFileSync(this.statePath, "utf8")) as GatesState;
  }

  save(state: GatesState): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  writeArtifact(gate: GateId, payload: unknown): string {
    fs.mkdirSync(this.artifactsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(this.artifactsDir, `${gate}-${stamp}.json`);
    fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
    return path.relative(this.projectRoot, file);
  }
}

const { vouchedTreeFingerprint, vouchedFingerprintsMatch } = require("../../lib/git.js") as {
  vouchedTreeFingerprint: (options: {
    projectRoot: string;
    slug?: string | null;
    scopeGlobs?: string[] | null;
  }) => VouchedTreeFingerprint | null;
  vouchedFingerprintsMatch: (recorded: unknown, current: unknown) => boolean;
};

/**
 * Recompute the tree fingerprint under the exact vouched set the record was
 * earned with: the record's own scopeGlobs when present, fallback mode
 * otherwise. A legacy record has no scope descriptor and recomputes in
 * fallback mode - irrelevant to the verdict, since a legacy shape never
 * matches anything.
 */
export function currentTreeFingerprint(
  projectRoot: string,
  slug: string | undefined,
  recorded: GateRecord["treeFingerprint"],
): VouchedTreeFingerprint | null {
  try {
    const scopeGlobs =
      recorded !== null && typeof recorded === "object" && "scopeGlobs" in recorded && Array.isArray(recorded.scopeGlobs)
        ? recorded.scopeGlobs
        : null;
    return vouchedTreeFingerprint({ projectRoot, slug: slug ?? null, scopeGlobs });
  } catch {
    return null;
  }
}

export interface GateStatusView {
  gate: GateId;
  verdict: GateRecord["verdict"];
  effective: "PASS" | "STALE" | "BLOCKED" | "NOT_RUN";
  /** True only when drift downgrades an otherwise-passing gate. */
  stale: boolean;
  /**
   * True whenever `staleInputs` is non-empty, including on a blocked gate that
   * cannot be "stale" but whose recorded artifacts no longer match disk. A
   * consumer branching on `stale` alone would miss that.
   */
  inputsDrifted: boolean;
  staleInputs: StaleInput[];
  overridden: boolean;
  attempts: number;
  budget: number;
  budgetExhausted: boolean;
  requiresHuman: boolean;
  findings: Finding[];
}

/**
 * Freshness check: a PASS earned on an input document that has since changed
 * is not a live PASS. Compares the current file content against the hashes
 * recorded at the passing run.
 */
export function staleInputsFor(projectRoot: string, record: GateRecord): StaleInput[] {
  if (!record.inputs || record.inputs.length === 0) {
    return [{ path: "<unrecorded>", reason: "unverifiable" }];
  }
  const stale: StaleInput[] = [];
  for (const input of record.inputs) {
    const hash = freshnessLib.hashGateInput(path.join(projectRoot, input.path), input.kind);
    if (hash === null) stale.push({ path: input.path, reason: "missing" });
    else if (hash !== input.sha256) stale.push({ path: input.path, reason: "changed" });
  }
  return stale;
}

export function gateStatus(state: GatesState, gate: GateId, budget: number, projectRoot?: string): GateStatusView {
  const record = state.gates[gate] ?? { ...EMPTY_GATE };
  const passed = record.verdict === "PASS" || record.overridden;
  // Freshness is reported for any judged verdict, not just a PASS. A quick run
  // that ends on a requiresHuman finding is still handed to a person with its
  // evidence attached, so silently accepting a swapped artifact there would
  // leave the one document a human reads unpinned. An overridden gate is a
  // recorded user deviation and stands until a new run replaces it.
  const staleInputs =
    projectRoot !== undefined && record.verdict !== null && !record.overridden
      ? // "unverifiable" exists to distrust a pre-0.2 PASS with no recorded
        // inputs; on a blocked gate it is noise, not a warning.
        staleInputsFor(projectRoot, record).filter((input) => passed || input.reason !== "unverifiable")
      : [];
  // The tree a PASS was earned on is part of what the PASS vouches for, so the
  // same check the Stop hook makes has to be visible here too - an agent that
  // reads `gate status` must not see a live PASS the harness treats as dead.
  // A legacy-shaped fingerprint never matches (vouchedFingerprintsMatch), so
  // pre-consolidation PASSes surface as STALE and earn one honest re-run.
  if (passed && projectRoot !== undefined && record.verdict === "PASS" && record.treeFingerprint) {
    const current = currentTreeFingerprint(projectRoot, state.topic, record.treeFingerprint);
    if (current && !vouchedFingerprintsMatch(record.treeFingerprint, current)) {
      staleInputs.push({ path: "<worktree>", reason: "changed" });
    }
  }
  // `stale` only downgrades an otherwise-passing gate; on a blocked gate the
  // list is informational and must not turn BLOCKED into STALE.
  const stale = passed && staleInputs.length > 0;
  return {
    gate,
    verdict: record.verdict,
    effective: passed ? (stale ? "STALE" : "PASS") : record.verdict === null ? "NOT_RUN" : "BLOCKED",
    stale,
    inputsDrifted: staleInputs.length > 0,
    staleInputs,
    overridden: record.overridden,
    attempts: record.attempts,
    budget,
    budgetExhausted: !passed && record.attempts >= budget && record.verdict !== null,
    requiresHuman: record.findings.some((f) => f.requiresHuman),
    findings: record.findings,
  };
}

export function recordGateResult(
  store: GateStore,
  state: GatesState,
  gate: GateId,
  outcome:
    | {
        kind: "verdict";
        verdict: GapVerdict["verdict"] | "FAIL";
        findings: Finding[];
        artifactPayload: unknown;
        inputs?: GateInput[];
        /** New records only carry the vouched shape; legacy shapes exist solely in already-written files. */
        treeFingerprint?: VouchedTreeFingerprint | null;
        /** Verify gate only: stage behind a non-PASS verdict (ignored on PASS). */
        failedStage?: VerifyFailedStage;
        /** Verify gate only: judged-diff identity ("git:<base>" | "injected"). */
        diffSource?: string;
      }
    | { kind: "error"; message: string; artifactPayload?: unknown },
  judgeRecords: JudgeCallRecord[],
): GatesState {
  const record = state.gates[gate] ?? { ...EMPTY_GATE };
  const at = new Date().toISOString();
  // A new judged result supersedes any earlier user override. The deviation
  // remains in history, but it must not turn a later BLOCK/FAIL/ERROR into an
  // effective PASS.
  record.overridden = false;
  let summary: GateRunSummary;
  if (outcome.kind === "verdict") {
    const artifact = store.writeArtifact(gate, { at, gate, ...((outcome.artifactPayload as object) ?? {}) });
    record.verdict = outcome.verdict;
    record.findings = outcome.findings;
    record.inputs = outcome.inputs ?? [];
    record.treeFingerprint = outcome.treeFingerprint ?? null;
    // Stamped only when the caller says so, and a failedStage never survives a
    // PASS: a lingering "semantic" under a later verdict would let the rerun
    // short-circuit refuse on a stage that did not produce this record.
    const failedStage = outcome.verdict !== "PASS" ? outcome.failedStage : undefined;
    if (failedStage !== undefined) record.failedStage = failedStage;
    else delete record.failedStage;
    if (outcome.diffSource !== undefined) record.diffSource = outcome.diffSource;
    else delete record.diffSource;
    record.attempts = outcome.verdict === "PASS" ? 0 : record.attempts + 1;
    // Cumulative twin of the gauge above: every real run counts, PASS included,
    // and nothing resets it (see the GateRecord field comment).
    record.totalAttempts = (record.totalAttempts ?? 0) + 1;
    summary = {
      at,
      verdict: outcome.verdict,
      findingCount: outcome.findings.length,
      requiresHuman: outcome.findings.some((f) => f.requiresHuman),
      error: null,
      artifact,
      treeFingerprint: outcome.treeFingerprint ?? null,
      ...(failedStage !== undefined ? { failedStage } : {}),
      ...(outcome.diffSource !== undefined ? { diffSource: outcome.diffSource } : {}),
    };
  } else {
    // Fail-closed (D-15): a judge failure counts as a blocked run, never a pass.
    // The run still produced real work before the judge broke - commands ran,
    // artifacts were pinned - so that evidence is written out rather than lost
    // with the failed call.
    const artifact =
      outcome.artifactPayload !== undefined
        ? store.writeArtifact(gate, { at, gate, stage: "judge-error", error: outcome.message, ...(outcome.artifactPayload as object) })
        : null;
    record.verdict = "ERROR";
    // ERROR is a fact about the judge, not the tree or a stage: stale
    // stage/diff stamps under it would misdescribe this record (item 10), and
    // ERROR never arms the short-circuit anyway.
    delete record.failedStage;
    delete record.diffSource;
    record.attempts += 1;
    record.totalAttempts = (record.totalAttempts ?? 0) + 1;
    summary = { at, verdict: "ERROR", findingCount: 0, requiresHuman: false, error: outcome.message, artifact };
  }
  record.lastRunAt = at;
  record.history = [...record.history.slice(-19), summary];
  state.gates[gate] = record;
  state.judgeCalls = [...state.judgeCalls, ...judgeRecords];
  store.save(state);
  return state;
}

export function overrideGate(store: GateStore, state: GatesState, gate: GateId, reason: string): GatesState {
  const trimmed = reason.trim();
  if (trimmed === "") {
    throw new Error("override requires a non-empty --reason");
  }
  const record = state.gates[gate] ?? { ...EMPTY_GATE };
  record.overridden = true;
  state.gates[gate] = record;
  state.deviations = [...state.deviations, { at: new Date().toISOString(), gate, reason: trimmed, by: "user" }];
  store.save(state);
  return state;
}
