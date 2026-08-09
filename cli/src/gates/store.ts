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

export interface GateRunSummary {
  at: string;
  verdict: "PASS" | "BLOCK" | "FAIL" | "ERROR";
  findingCount: number;
  requiresHuman: boolean;
  error: string | null;
  artifact: string | null;
}

export interface GateRecord {
  verdict: "PASS" | "BLOCK" | "FAIL" | "ERROR" | null;
  attempts: number;
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
  treeFingerprint?: { headSha: string | null; statusHash: string } | null;
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

export interface GateStatusView {
  gate: GateId;
  verdict: GateRecord["verdict"];
  effective: "PASS" | "STALE" | "BLOCKED" | "NOT_RUN";
  stale: boolean;
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
function staleInputsFor(projectRoot: string, record: GateRecord): StaleInput[] {
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
  // Staleness applies only to a judged PASS. An overridden gate is a recorded
  // user deviation and stands until a new run replaces it.
  const staleInputs =
    projectRoot !== undefined && record.verdict === "PASS" && !record.overridden
      ? staleInputsFor(projectRoot, record)
      : [];
  const stale = staleInputs.length > 0;
  return {
    gate,
    verdict: record.verdict,
    effective: passed ? (stale ? "STALE" : "PASS") : record.verdict === null ? "NOT_RUN" : "BLOCKED",
    stale,
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
        treeFingerprint?: { headSha: string | null; statusHash: string } | null;
      }
    | { kind: "error"; message: string },
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
    record.attempts = outcome.verdict === "PASS" ? 0 : record.attempts + 1;
    summary = {
      at,
      verdict: outcome.verdict,
      findingCount: outcome.findings.length,
      requiresHuman: outcome.findings.some((f) => f.requiresHuman),
      error: null,
      artifact,
    };
  } else {
    // Fail-closed (D-15): a judge failure counts as a blocked run, never a pass.
    record.verdict = "ERROR";
    record.attempts += 1;
    summary = { at, verdict: "ERROR", findingCount: 0, requiresHuman: false, error: outcome.message, artifact: null };
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
