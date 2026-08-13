import fs from "node:fs";
import path from "node:path";

export type JudgeProfile = "routine" | "high-risk";
export type BackendName = "claude" | "codex" | "stub";
export type JudgeEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface JudgeTarget {
  backend: BackendName;
  model: string | null;
  effort: JudgeEffort;
}

export interface JudgeProfileConfig {
  primary: JudgeTarget;
  fallback: JudgeTarget | null;
}

export interface JudgeConfig {
  profiles: Record<JudgeProfile, JudgeProfileConfig>;
  retryBudget: number;
  timeoutMs: number;
  /** Lane-parallel fan-out for the gap-list gates; false restores the single-judge path. */
  fanout: boolean;
}

export interface VerifyConfig {
  commands: Partial<Record<"test" | "lint" | "build" | "typecheck", string>>;
  /** Per-command timeout for mechanical verify runs; a hung suite fails closed instead of hanging the gate. */
  commandTimeoutMs: number;
}

export interface SasuConfig {
  judge: JudgeConfig;
  verify: VerifyConfig;
  configPath: string | null;
}

// Model strength and review risk are separate from evidence access. Routine
// calls use the inexpensive high-throughput model at the same xhigh reasoning
// budget as every other judge. High-risk changes upgrade the model, while an
// scoped evidence workspace and audited command trace constrain source reads.
const DEFAULT_JUDGE: JudgeConfig = {
  profiles: {
    routine: {
      primary: { backend: "codex", model: "gpt-5.6-luna", effort: "xhigh" },
      fallback: { backend: "claude", model: "claude-sonnet-5", effort: "xhigh" },
    },
    "high-risk": {
      primary: { backend: "codex", model: "gpt-5.6-sol", effort: "xhigh" },
      fallback: { backend: "claude", model: "claude-opus-5", effort: "xhigh" },
    },
  },
  retryBudget: 3,
  // 2026-08-13 creator-assist exploration-settings run: with ~145KB of diff
  // per lane at xhigh effort, Codex Luna finished in 159-165s while Claude
  // Sonnet 5 xhigh timed out at the old 180s cap 7 times out of 7. A timeout
  // burns the full cap on primary AND fallback with nothing to show, so the
  // cap must sit well above a real completion, not near it.
  timeoutMs: 600_000,
  fanout: true,
};

const DEFAULT_COMMAND_TIMEOUT_MS = 600_000;
const PROFILE_NAMES: JudgeProfile[] = ["routine", "high-risk"];
const BACKENDS: BackendName[] = ["claude", "codex", "stub"];
const EFFORTS: JudgeEffort[] = ["low", "medium", "high", "xhigh", "max"];

type RawTarget = Partial<JudgeTarget>;
type RawProfile = { primary?: RawTarget; fallback?: RawTarget | null };

function mergeTarget(base: JudgeTarget, raw: RawTarget | undefined, label: string): JudgeTarget {
  const target = { ...base, ...(raw ?? {}) };
  if (!BACKENDS.includes(target.backend)) throw new Error(`${label}.backend must be claude, codex, or stub`);
  if (target.model !== null && (typeof target.model !== "string" || target.model.trim() === "")) {
    throw new Error(`${label}.model must be a non-empty string or null`);
  }
  if (!EFFORTS.includes(target.effort)) throw new Error(`${label}.effort must be one of: ${EFFORTS.join(", ")}`);
  return target;
}

function mergeProfile(base: JudgeProfileConfig, raw: RawProfile | undefined, label: string): JudgeProfileConfig {
  const primary = mergeTarget(base.primary, raw?.primary, `${label}.primary`);
  const fallback = raw?.fallback === null
    ? null
    : mergeTarget(base.fallback ?? base.primary, raw?.fallback, `${label}.fallback`);
  if (fallback !== null && fallback.backend === primary.backend) {
    throw new Error(`${label}.fallback.backend must differ from primary.backend`);
  }
  return { primary, fallback };
}

export function loadConfig(projectRoot: string): SasuConfig {
  const configPath = path.join(projectRoot, "agents", "config.json");
  let raw: Record<string, unknown> = {};
  let found: string | null = null;
  if (fs.existsSync(configPath)) {
    try {
      raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
      found = configPath;
    } catch {
      throw new Error(`agents/config.json is not valid JSON: ${configPath}`);
    }
  }
  const judgeRaw = (raw["judge"] ?? {}) as Partial<JudgeConfig> & {
    backend?: unknown;
    tierModels?: unknown;
    profiles?: Partial<Record<JudgeProfile, RawProfile>>;
  };
  if (judgeRaw.backend !== undefined || judgeRaw.tierModels !== undefined) {
    throw new Error("judge.backend and judge.tierModels were removed; configure judge.profiles.routine/high-risk");
  }
  const unknownProfiles = Object.keys(judgeRaw.profiles ?? {}).filter((name) => !PROFILE_NAMES.includes(name as JudgeProfile));
  if (unknownProfiles.length > 0) throw new Error(`unknown judge profile(s): ${unknownProfiles.join(", ")}`);
  const verifyRaw = (raw["verify"] ?? {}) as Partial<VerifyConfig>;
  const judge: JudgeConfig = {
    profiles: {
      routine: mergeProfile(DEFAULT_JUDGE.profiles.routine, judgeRaw.profiles?.routine, "judge.profiles.routine"),
      "high-risk": mergeProfile(DEFAULT_JUDGE.profiles["high-risk"], judgeRaw.profiles?.["high-risk"], "judge.profiles.high-risk"),
    },
    retryBudget: judgeRaw.retryBudget ?? DEFAULT_JUDGE.retryBudget,
    timeoutMs: judgeRaw.timeoutMs ?? DEFAULT_JUDGE.timeoutMs,
    fanout: judgeRaw.fanout ?? DEFAULT_JUDGE.fanout,
  };
  if (!Number.isInteger(judge.retryBudget) || judge.retryBudget < 0) {
    throw new Error(`judge.retryBudget must be a non-negative integer, got: ${String(judge.retryBudget)}`);
  }
  if (!Number.isInteger(judge.timeoutMs) || judge.timeoutMs <= 0) {
    throw new Error(`judge.timeoutMs must be a positive integer, got: ${String(judge.timeoutMs)}`);
  }
  const commandTimeoutMs = verifyRaw.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  if (!Number.isInteger(commandTimeoutMs) || commandTimeoutMs <= 0) {
    throw new Error(`verify.commandTimeoutMs must be a positive integer, got: ${String(commandTimeoutMs)}`);
  }
  return {
    judge,
    verify: { commands: { ...(verifyRaw.commands ?? {}) }, commandTimeoutMs },
    configPath: found,
  };
}

export function judgeProfileFor(config: SasuConfig, profile: JudgeProfile): JudgeProfileConfig {
  return config.judge.profiles[profile];
}
