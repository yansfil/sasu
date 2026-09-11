import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { commandCompositionDefect } = require("../lib/prd_parser.js") as { commandCompositionDefect(command: string): string | null };

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
   * Override for every measured lane budget. Null - the default - means each
   * lane uses the budget measured for it (LANE_EFFORT below), which is what a
   * project should want; set it only to pin one budget across every lane
   * listed there, and say why.
   */
  laneEffort: JudgeEffort | null;
  /**
   * Read rounds an agentic judge may spend on a non-exploring call before its
   * reply is discarded (backends.ts AGENTIC_READ_MAX_ROUNDS carries the
   * measurements behind the default). Rounds only: claude's API-turn cap is
   * a different unit and stays at its own constant.
   */
  readMaxRounds: number;
}

/**
 * 29 was set on 2026-09-04 as a provisional bound to measure against; the
 * 2026-09-10 Task Factory pilot measured claude fallback Code reviews at 34,
 * 36 and 38 rounds in two repositories, all rejected here, and all passing
 * once the bound was 60. That is why the bound is a project setting and not
 * only a constant: the knee depends on the repository under review.
 */
export const DEFAULT_READ_MAX_ROUNDS = 29;

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
// calls use the inexpensive high-throughput model at the same reasoning budget
// as every other judge. High-risk changes upgrade the model, while an scoped
// evidence workspace and audited command trace constrain source reads.
//
// 2026-09-11: the four budgets moved xhigh -> high by user decision, taken
// after the verify-latency investigation reported that wall is essentially
// fixed on the input side (eight levers measured 0) and that the reasoning
// budget is the only remaining lever on it. That provenance matters the same
// way AGENTIC_READ_MAX_OUTPUT_CHARS's does: a measurement alone cannot move
// these back, because no measurement put them at xhigh either.
//
// The direction agrees with every budget sweep this repo actually ran. high is
// the measured knee on both OPEN-search lanes below (xhigh bought 2.1x the
// time for FEWER findings on spec), and the implement review asks a CLOSED
// question - does this implementation satisfy this contract - which is the
// shape where LANE_EFFORT already sits at medium. What was never swept is
// these profiles themselves, so the expected cost is stated as a risk and not
// as a number: a budget drop can only lose findings, and the planted-defect
// rate on this path is already 0 of 11 for claude and 1 of 2 for codex
// (2026-09-11 B18 census). Re-measure detection here before trusting the
// saving; the 2026-09-15 pre-registered run is the first chance.
const DEFAULT_JUDGE: JudgeConfig = {
  profiles: {
    routine: {
      primary: { backend: "codex", model: "gpt-5.6-luna", effort: "high" },
      fallback: { backend: "claude", model: "claude-sonnet-5", effort: "high" },
    },
    "high-risk": {
      primary: { backend: "codex", model: "gpt-5.6-sol", effort: "high" },
      fallback: { backend: "claude", model: "claude-opus-5", effort: "high" },
    },
  },
  // 2026-08-13: raised from 3 after a real run exhausted the budget on two
  // legitimate fix rounds plus one deterministic pre-judge failure. The
  // bound exists to stop unconverging fix loops (PRINCIPLES #13), not to
  // punish honest iteration; 5 keeps the loop finite while surviving one
  // clumsy attempt.
  retryBudget: 5,
  laneEffort: null,
  readMaxRounds: DEFAULT_READ_MAX_ROUNDS,
  // A timeout burns the full cap on primary AND fallback with nothing to show,
  // so the cap must sit well above a real completion, not near it.
  //
  // 2026-08-13 creator-assist exploration-settings run: with ~145KB of diff
  // per lane at xhigh effort, Codex Luna finished in 159-165s while Claude
  // Sonnet 5 xhigh timed out at the old 180s cap 7 times out of 7. Those two
  // numbers were measured at xhigh, which is no longer the shipped budget, so
  // they now bound the worst case rather than describe the common one.
  //
  // 2026-09-11: raised 600s -> 900s by user decision. The measurement that
  // makes 600 the wrong number is from the verify-latency investigation: one
  // codex review on the B18 census path ran 606,338ms and was killed at the
  // cap, which is a legitimate attempt lost to a bound it missed by 1.1%. A
  // cap a real completion lands within 1% of is not a cap on runaway calls,
  // it is a coin flip on finishing, and the loss is the whole call twice over.
  // 900s is 1.48x that observed completion. Raising it cannot make a fast call
  // slow; what it costs is how long a genuinely hung call holds the lane, and
  // that is bounded by the lease rather than by this number.
  timeoutMs: 900_000,
  fanout: true,
};

/**
 * Per-gate lane reasoning budget, measured rather than assumed.
 *
 * A lane's budget is not a property of the harness, it is a property of the
 * QUESTION the gate asks, and the three gates ask different ones (PRINCIPLES
 * 6). Measured 2026-08-28/29 with cli/scripts/effort_sweep.mjs and a planted
 * verify contract; full runs under cli/test/fixtures/calibration/results/.
 *
 * gap-audit ("which decision is missing?") is an OPEN search, so budget buys
 * coverage. On a real 626-line interview log, three runs each:
 *   medium  28s  2.7 findings  2 of 6 themes reproduced
 *   high    92s  5.7 findings  6 of 6      <- knee
 *   xhigh  236s  6.3 findings  5 of 6
 *
 * spec ("did the PRD distort the log, are the criteria observable?") is the
 * same shape but saturates sooner. On a real 279-line PRD, three runs each:
 *   medium  28s  1.0 findings
 *   high    86s  4.0 findings                <- knee
 *   xhigh  182s  3.3 findings   2.1x the time for FEWER findings
 *
 * verify ("does this diff satisfy this criterion?") is a CLOSED comparison -
 * the answer is in the diff, so extra budget has nothing to find. Against a
 * contract carrying three deliberately false criteria:
 *   medium  251s  caught 3 of 3, zero false positives   <- sufficient
 *   high    330s  caught 3 of 3, zero false positives
 * and on an all-true contract medium reached the same PASS in 124s where high
 * took 237s. Sample is one contract, one run per budget: re-measure before
 * treating verify's number as firmly as the other two.
 *
 * Both planted-mine fixtures detect every mine at every budget from medium up
 * and so cannot rank budgets at all - scored alone they always nominate the
 * cheapest option, and for gap-audit and spec that option is wrong. These
 * numbers come from real documents.
 *
 */
export const LANE_EFFORT: Record<"gap-audit" | "spec" | "verify", JudgeEffort> = {
  "gap-audit": "high",
  spec: "high",
  verify: "medium",
};

/** The budget a lane spends: the project's override, else the measured default. */
export function laneEffortFor(config: SasuConfig, lane: keyof typeof LANE_EFFORT): JudgeEffort {
  return config.judge.laneEffort ?? LANE_EFFORT[lane];
}

const DEFAULT_COMMAND_TIMEOUT_MS = 600_000;
const PROFILE_NAMES: JudgeProfile[] = ["routine", "high-risk"];
/** Every selectable backend. Exported so no second list can drift from it. */
export const BACKENDS: BackendName[] = ["claude", "codex", "api", "stub"];
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
    readMaxRounds: judgeRaw.readMaxRounds ?? DEFAULT_JUDGE.readMaxRounds,
  };
  if (!Number.isInteger(judge.readMaxRounds) || judge.readMaxRounds <= 0) {
    throw new Error(`judge.readMaxRounds must be a positive integer, got: ${String(judge.readMaxRounds)}`);
  }
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
  for (const [kind, command] of Object.entries(verifyRaw.commands ?? {})) {
    if (typeof command !== "string" || command.trim() === "") {
      throw new Error(`verify.commands.${kind} must be a non-empty string`);
    }
    // One command per entry, no shell composition: the same rule a PRD
    // `check:` cell obeys, owned by prd_parser.js so config and cell cannot
    // drift (prd-template R2). Refused here, at the one place every consumer
    // loads config, rather than taught to each runner.
    const composition = commandCompositionDefect(command);
    if (composition !== null) {
      throw new Error(
        `verify.commands.${kind} ${composition}; split it into separate entries or one runner invocation, got: ${command}`,
      );
    }
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
