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
}

export interface VerifyConfig {
  commands: Partial<Record<"test" | "lint" | "build" | "typecheck", string>>;
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
      frugal: "claude-haiku-4-5",
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
};

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
  };
  if (!Number.isInteger(judge.retryBudget) || judge.retryBudget < 0) {
    throw new Error(`judge.retryBudget must be a non-negative integer, got: ${String(judge.retryBudget)}`);
  }
  return {
    judge,
    verify: { commands: { ...(verifyRaw.commands ?? {}) } },
    configPath: found,
  };
}

export function tierModelFor(config: CheckshirtConfig, backend: BackendName, tier: Tier): string | null {
  if (backend === "stub") return null;
  return config.judge.tierModels[backend][tier];
}
