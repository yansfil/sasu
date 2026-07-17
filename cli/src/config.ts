import fs from "node:fs";
import path from "node:path";

export type Tier = "frugal" | "standard" | "frontier";
export type BackendName = "claude" | "codex" | "stub";

export interface JudgeConfig {
  backend: "auto" | BackendName;
  tierModels: {
    claude: Record<Tier, string | null>;
    codex: Record<Tier, string | null>;
  };
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

export interface CheckshirtConfig {
  judge: JudgeConfig;
  verify: VerifyConfig;
  configPath: string | null;
}

// Cross-vendor independence (D-12): the default backend is "auto" (first
// available binary, claude preferred). Judging with a different vendor than
// the implementing runtime is recommended in docs but not enforced in v1;
// consensus (v2) revisits enforcement.
const DEFAULT_JUDGE: JudgeConfig = {
  backend: "auto",
  tierModels: {
    claude: {
      // Frugal was claude-haiku-4-5 until live calibration (2026-07-17,
      // meeting-hub qa-log): on the exhaustive gap-scan prompt haiku spent
      // 11-20k output tokens per call (146-238s, brushing the 180s timeout)
      // and flipped verdicts across runs, while sonnet answered in ~7k
      // tokens (~80s) decisively - faster wall-clock at similar effective
      // cost. Pin haiku back via judge.tierModels.claude.frugal if desired.
      frugal: "claude-sonnet-5",
      standard: "claude-sonnet-5",
      frontier: "claude-opus-4-8",
    },
    // Codex models default to the user's own CLI default; overriding is
    // config-only because model catalogs vary by plan.
    codex: { frugal: null, standard: null, frontier: null },
  },
  // E2E calibration (2026-07-16) showed judges discover gaps progressively
  // across rounds, so 2 attempts starved good-faith fix loops; 3 is the
  // observed floor for reaching PASS on an honestly revised document. The
  // budget is advisory for autonomous loops - the CLI never locks a
  // user-instructed re-run.
  retryBudget: 3,
  timeoutMs: 180_000,
  fanout: true,
};

const DEFAULT_COMMAND_TIMEOUT_MS = 600_000;

export function loadConfig(projectRoot: string): CheckshirtConfig {
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
    tierModels?: Partial<JudgeConfig["tierModels"]>;
  };
  const verifyRaw = (raw["verify"] ?? {}) as Partial<VerifyConfig>;
  const judge: JudgeConfig = {
    backend: judgeRaw.backend ?? DEFAULT_JUDGE.backend,
    tierModels: {
      claude: { ...DEFAULT_JUDGE.tierModels.claude, ...(judgeRaw.tierModels?.claude ?? {}) },
      codex: { ...DEFAULT_JUDGE.tierModels.codex, ...(judgeRaw.tierModels?.codex ?? {}) },
    },
    retryBudget: judgeRaw.retryBudget ?? DEFAULT_JUDGE.retryBudget,
    timeoutMs: judgeRaw.timeoutMs ?? DEFAULT_JUDGE.timeoutMs,
    fanout: judgeRaw.fanout ?? DEFAULT_JUDGE.fanout,
  };
  if (!Number.isInteger(judge.retryBudget) || judge.retryBudget < 0) {
    throw new Error(`judge.retryBudget must be a non-negative integer, got: ${String(judge.retryBudget)}`);
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

export function tierModelFor(config: CheckshirtConfig, backend: BackendName, tier: Tier): string | null {
  if (backend === "stub") return null;
  return config.judge.tierModels[backend][tier];
}
