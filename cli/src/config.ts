import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type JudgeProfile = "routine" | "high-risk";
export type BackendName = "claude" | "codex" | "api" | "stub";
export type JudgeEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface JudgeTarget {
  backend: BackendName;
  model: string | null;
  effort: JudgeEffort;
  /**
   * Messages-API origin for the `api` backend. Null means the Anthropic API.
   * A local proxy is reached by naming its origin here and nothing else: the
   * harness knows one wire protocol, never a vendor's proxy, so swapping the
   * upstream stays a config string rather than a code path (PRINCIPLES 7).
   */
  baseUrl?: string | null;
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
  /**
   * Reasoning budget for ONE document-gate lane, overriding the profile's.
   * Null means "use the profile effort" - the pre-measurement behavior.
   *
   * A lane judges one narrow axis of a document, which is not the same job as
   * the exhaustive single judge the profile effort was chosen for. Measured
   * 2026-08-28 on this repo's calibration fixtures (cli/scripts/effort_sweep.mjs):
   * see the sweep result committed under cli/test/fixtures/calibration/results/.
   */
  laneEffort: JudgeEffort | null;
}

export interface VerifyConfig {
  commands: Partial<Record<"test" | "lint" | "build" | "typecheck", string>>;
  /** Per-command timeout for mechanical verify runs; a hung suite fails closed instead of hanging the gate. */
  commandTimeoutMs: number;
}

/**
 * Worktree isolation for implement runs. This is the SAME config surface the
 * ship/sasu-setup skills already interview for (worktree.enabled/root/link/
 * copy/setup) - promoted from skill-doc prose to code so the harness, not the
 * agent, creates and prepares the worktree (PRINCIPLES 7). `enabled: true`
 * isolates every run; `false` still isolates a run whose target tree already
 * hosts an active in-place run (one working tree, one active run).
 */
export interface WorktreeConfig {
  enabled: boolean;
  /** Worktree parent directory; null means `../<repo-basename>.worktrees`. */
  root: string | null;
  /** Read-only shared files symlinked from the record tree (.env, certs). */
  link: string[];
  /** Files the app writes to, copied per worktree (.dev.vars, local DBs). */
  copy: string[];
  /** One-time preparation commands run in the new worktree (pnpm install). */
  setup: string[];
}

export interface SasuConfig {
  judge: JudgeConfig;
  verify: VerifyConfig;
  worktree: WorktreeConfig;
  /**
   * Principle repository roots declared by the project (each contains a
   * ROOT.md whose domain table names the principle documents). Paths are
   * expanded (`~`) and normalized at load time; an empty list means the
   * project declares no principles and `sasu principles list` returns no
   * domains rather than failing.
   */
  principles: string[];
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
  // 2026-08-13: raised from 3 after a real run exhausted the budget on two
  // legitimate fix rounds plus one deterministic pre-judge failure. The
  // bound exists to stop unconverging fix loops (PRINCIPLES #13), not to
  // punish honest iteration; 5 keeps the loop finite while surviving one
  // clumsy attempt.
  retryBudget: 5,
  laneEffort: null,
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
const BACKENDS: BackendName[] = ["claude", "codex", "api", "stub"];
const EFFORTS: JudgeEffort[] = ["low", "medium", "high", "xhigh", "max"];

type RawTarget = Partial<JudgeTarget>;
type RawProfile = { primary?: RawTarget; fallback?: RawTarget | null };

function mergeTarget(base: JudgeTarget, raw: RawTarget | undefined, label: string): JudgeTarget {
  const target = { ...base, ...(raw ?? {}) };
  if (!BACKENDS.includes(target.backend)) throw new Error(`${label}.backend must be one of: ${BACKENDS.join(", ")}`);
  if (target.baseUrl !== undefined && target.baseUrl !== null && (typeof target.baseUrl !== "string" || target.baseUrl.trim() === "")) {
    throw new Error(`${label}.baseUrl must be a non-empty string or null`);
  }
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
    laneEffort: judgeRaw.laneEffort ?? DEFAULT_JUDGE.laneEffort,
  };
  if (judge.laneEffort !== null && !EFFORTS.includes(judge.laneEffort)) {
    throw new Error(`judge.laneEffort must be null or one of: ${EFFORTS.join(", ")}`);
  }
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
  const worktreeRaw = (raw["worktree"] ?? {}) as Partial<WorktreeConfig>;
  const stringList = (value: unknown, label: string): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
      throw new Error(`${label} must be an array of non-empty strings`);
    }
    return value as string[];
  };
  const principlesRaw = raw["principles"];
  const principles = stringList(principlesRaw, "principles").map((entry) => expandHomePath(entry));
  const worktree: WorktreeConfig = {
    enabled: worktreeRaw.enabled ?? false,
    root: worktreeRaw.root ?? null,
    link: stringList(worktreeRaw.link, "worktree.link"),
    copy: stringList(worktreeRaw.copy, "worktree.copy"),
    setup: stringList(worktreeRaw.setup, "worktree.setup"),
  };
  if (typeof worktree.enabled !== "boolean") throw new Error("worktree.enabled must be a boolean");
  if (worktree.root !== null && (typeof worktree.root !== "string" || worktree.root.trim() === "")) {
    throw new Error("worktree.root must be a non-empty string or null");
  }
  return {
    judge,
    verify: { commands: { ...(verifyRaw.commands ?? {}) }, commandTimeoutMs },
    worktree,
    principles,
    configPath: found,
  };
}

export function expandHomePath(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function judgeProfileFor(config: SasuConfig, profile: JudgeProfile): JudgeProfileConfig {
  return config.judge.profiles[profile];
}
