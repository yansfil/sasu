import fs from "node:fs";
import path from "node:path";
import type { Finding, GapVerdict, JudgeCallRecord } from "../judge/types";

export type GateId = "gap-audit" | "spec" | "verify";

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
  effective: "PASS" | "BLOCKED" | "NOT_RUN";
  overridden: boolean;
  attempts: number;
  budget: number;
  budgetExhausted: boolean;
  requiresHuman: boolean;
  findings: Finding[];
}

export function gateStatus(state: GatesState, gate: GateId, budget: number): GateStatusView {
  const record = state.gates[gate] ?? { ...EMPTY_GATE };
  const passed = record.verdict === "PASS" || record.overridden;
  return {
    gate,
    verdict: record.verdict,
    effective: passed ? "PASS" : record.verdict === null ? "NOT_RUN" : "BLOCKED",
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
    | { kind: "verdict"; verdict: GapVerdict["verdict"] | "FAIL"; findings: Finding[]; artifactPayload: unknown }
    | { kind: "error"; message: string },
  judgeRecords: JudgeCallRecord[],
): GatesState {
  const record = state.gates[gate] ?? { ...EMPTY_GATE };
  const at = new Date().toISOString();
  let summary: GateRunSummary;
  if (outcome.kind === "verdict") {
    const artifact = store.writeArtifact(gate, { at, gate, ...((outcome.artifactPayload as object) ?? {}) });
    record.verdict = outcome.verdict;
    record.findings = outcome.findings;
    record.attempts = outcome.verdict === "PASS" ? 0 : record.attempts + 1;
    if (outcome.verdict === "PASS") record.overridden = false;
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
