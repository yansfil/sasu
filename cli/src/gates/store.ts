import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  JUDGE_ERROR_LOOP_THRESHOLD,
  describeJudgeFailureCause,
  sameJudgeFailureCause,
  type Finding,
  type ReviewFinding,
  type ReviewResult,
  type GapVerdict,
  type JudgeCallRecord,
  type JudgeFailureCause,
} from "../judge/types";
import { gatesDirFor } from "../runs/paths";

export type GateId = "gap-audit" | "spec" | "verify";
export type PrdGateId = Extract<GateId, "gap-audit" | "spec">;

/**
 * A gate input pinned by content hash at the moment the gate ran.
 *
 * `document` inputs (the default) hash the markdown body only, so lifecycle
 * frontmatter flips do not stale a PASS. `qa-log` inputs hash the Decision
 * Register's decision cells only (PRD gate-loop R4): Raw Q&A anchors, Audit
 * History, frontmatter status, and the Register's bookkeeping cells are
 * outside the pin. The call site that reads a qa-log already knows it is one
 * (cli/src/gates/commands.ts readInputFile), so the kind rides along as
 * recorded fact rather than being re-guessed from the path or content later.
 * `evidence` inputs are the quick path's proof artifacts - logs, API dumps,
 * screenshots - and hash their raw bytes: every byte is substance there, and
 * a screenshot is not text.
 */
export interface GateInput {
  path: string;
  sha256: string;
  /**
   * How the pin is recomputed (cli/lib/gate_freshness.js hashGateInput):
   * `document` strips lifecycle bookkeeping, `qa-log` digests the Decision
   * Register's decision cells, `evidence` hashes raw bytes, and `config`
   * hashes raw bytes AND pins absence with a sentinel, because "no
   * agents/config.json" is itself a declaration about which checks run.
   */
  kind?: "document" | "qa-log" | "evidence" | "config";
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

/** Re-exported so the gate pins an input exactly the way staleness recomputes it. */
export function hashGateInput(absPath: string, kind: string | undefined): string | null {
  return freshnessLib.hashGateInput(absPath, kind);
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
 * holds for a judge reading a pinned diff, but mechanical commands read state
 * the vouched fingerprint cannot see (gitignored
 * node_modules/, build outputs, running servers - reproduced 2026-08-11: a
 * mechanical FAIL on a missing gitignored marker refused the rerun after the
 * legitimate out-of-tree fix). "human" covers a round closed only by
 * requiresHuman criteria; it is the user's to resolve, never refusable.
 */
export type VerifyFailedStage = "mechanical" | "evidence" | "human" | "semantic" | "declared-gap";

export interface GateRunSummary {
  at: string;
  verdict: "PASS" | "BLOCK" | "NEEDS_HUMAN" | "FAIL" | "ERROR";
  findingCount: number;
  requiresHuman: boolean;
  error: string | null;
  /** Structured backend failure class for an ERROR row. */
  judgeErrorCause?: JudgeFailureCause;
  artifact: string | null;
  /**
   * The diff this attempt's verdict was earned on, by sha256 (item 10: a
   * verdict names what it judged). Lets the FAIL-side rerun short-circuit
   * compare against the latest attempt even across PASS-reset cycles; rows
   * without it - other gates, a mechanical FAIL that never reached a diff,
   * pre-field files - simply never short-circuit.
   */
  judgedDiffSha256?: string | null;
  /** Stage that produced a non-PASS verdict; absent on PASS and on pre-field rows. */
  failedStage?: VerifyFailedStage;
  /** Judged-diff identity of the round: "git:<resolved base SHA>" or "injected" (test seam). */
  diffSource?: string;
  /** Mirror of GateRecord.usedLiveMaterial for this row (see that field's comment). */
  usedLiveMaterial?: boolean;
  /** Mirror of GateRecord.docKind for this row (see that field's comment). */
  docKind?: "prd" | "contract";
}

/**
 * Content-based tree fingerprint (cli/lib/git.js vouchedTreeFingerprint): the
 * files the verdict vouches for, hashed by blob content, commit-invariant,
 * and blind to harness bookkeeping. `mode` describes the vouched set so a
 * consumer can recompute the identical fingerprint later.
 */
export interface VouchedTreeFingerprint {
  vouched: string;
  entryCount: number;
  mode?: "full";
}


export interface GateRecord {
  fullReview?: ReviewResult;
  reviewFindings?: (ReviewFinding & { id: string })[];
  /**
   * PRD gates (gap-audit/spec) end a judged round in one of three states
   * derived from the open findings set alone: PASS (empty, sealed),
   * NEEDS_HUMAN (every open finding requires a human decision - the bundle
   * goes to the user and `gate answer` seals it without another judge call),
   * or BLOCK (at least one agent-fixable finding is open). There is no round
   * budget: the set can only shrink between reruns (see priorFindingsFor /
   * applyOpenSetContract in commands.ts), so the loop is bounded by the
   * document, not by a counter. Verify keeps PASS/FAIL. ERROR is a judge
   * failure on any gate.
   */
  verdict: "PASS" | "BLOCK" | "NEEDS_HUMAN" | "FAIL" | "ERROR" | null;
  /**
   * Fix-budget gauge: counts consecutive JUDGED non-PASS runs and RESETS to 0
   * on PASS. A judge ERROR deliberately does NOT move it - see
   * `consecutiveErrors`.
   */
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
  /**
   * Cumulative judged non-PASS rounds (BLOCK/FAIL; declared-gap and judge
   * ERROR excluded), never reset. Verify's legacy cycle cap and the audit read
   * this instead of `history` because history keeps only the last 20 rows.
   * Absent on older files; consumers read 0 (fail-open).
   */
  totalNonPassAttempts?: number;
  /**
   * Judge ERRORs since the last real verdict; ANY judged verdict (PASS, FAIL,
   * BLOCK) resets it to 0.
   *
   * The fix budget means "N chances to fix the findings and re-verify". A judge
   * that returns malformed output gives the agent NOTHING to fix, so charging
   * it to `attempts` pushes an honest run toward a false BLOCKED (measured
   * 2026-08-11, project modakbul, slug webhook-to-modakbul-server: 10 verify
   * attempts, 4 of them `judge-invalid-output (backend: claude): criteria
   * missing verdicts for AC1..AC3`, ZERO criterion FAILs across every round
   * that did return a verdict - and 3 spurious BLOCKEDs, with the agent then
   * spending review time proving the failures were the backend's).
   *
   * Not charging it cannot mean "retry forever" though (PRINCIPLES item 13: a
   * stage that cannot converge on its own needs a harness-owned bound), so this
   * counter is the separate gauge for the separate failure. It counts only a
   * structurally identical cause and is read against the harness-owned small
   * threshold, never the fix budget. Absent on pre-field files, which read as
   * 0 and are simply never terminal on this cause.
   */
  consecutiveErrors?: number;
  /** Failure class whose current consecutiveErrors streak is counting. */
  consecutiveErrorCause?: JudgeFailureCause;
  overridden: boolean;
  /**
   * PRD gates: the OPEN findings set after the last judged round - every
   * finding that still blocks (P0/P1) or needs a human decision, each with a
   * harness-assigned id (`F<n>`, never reused on this gate). A rerun's judge
   * receives exactly this set and may only echo ids from it, so the set is
   * the whole loop state. Verify: the failed criteria of the last round.
   */
  findings: Finding[];
  /**
   * PRD gates: findings recorded but not blocking - P2 advisories, findings
   * from a non-blocking lane (goal-scope, data-tech) that need no human
   * decision, and human findings assumed under a delegated run. Kept apart
   * from `findings` so an advisory can never re-enter the open set on a
   * later rerun as if it had blocked (2026-08-29: demoted P2s resurrected as
   * prior-unresolved one cycle later).
   */
  warnings?: Finding[];
  /** Next harness finding id on this gate; ids are never reused across reruns or reopens. */
  findingSeq?: number;
  /**
   * PRD gates: per-lane digest of the Decision Register's decision cells as
   * routed to that lane plus the gate's latest reopen evidence, pinned at
   * the last judged round. A rerun lane may
   * report a NEW finding only when its digest changed since (PRD gate-loop
   * R1): only changed decisions or a new user request admit new gaps, so an
   * unchanged lane gets no new line of questioning.
   */
  laneDigests?: Record<string, string>;
  lastRunAt: string | null;
  history: GateRunSummary[];
  /** Input documents hashed at the last verdict run; absent on pre-0.2 state files. */
  inputs?: GateInput[];
  /** sha256 of the verbatim delegated invocation included in a PRD judge prompt. */
  delegationSha256?: string;
  /**
   * sha256 of the exact diff the judge was shown at the last verdict run
   * (verify gate only). A PASS vouches for the change it judged, and both the
   * rerun short-circuit and the Stop-hook quick guard reproduce that diff
   * against the recorded base to detect code edited after the verdict.
   *
   * Replaced a vouched tree fingerprint, which answered a different question
   * ("did any file in the run's scope change") and answered it differently
   * depending on who asked - the gate recorded it whole-repo while the reviews
   * recorded it scoped, so unrelated churn staled a PASS that vouched for
   * untouched code (measured 2026-08-11 on project modakbul: gate 535 entries
   * fallback vs reviews 57 entries scoped, on one tree). See judgedDiffSha256
   * in cli/lib/git.js for what the pin covers and the one blind spot it accepts.
   *
   * Absent on pre-field files and on any record whose round never produced a
   * diff; null when git refused. Either way no consumer can compare, so those
   * records honestly earn one fresh re-run.
   */
  judgedDiffSha256?: string | null;
  /**
   * Verify gate only: the stage that produced the last non-PASS verdict. The
   * rerun short-circuit arms only on "semantic" (see VerifyFailedStage);
   * records without the field - other gates, pre-field files - never refuse.
   */
  failedStage?: VerifyFailedStage;
  /**
   * Verify gate only: identity of the judged diff the verdict was earned on -
   * "git:<base resolved to a commit SHA at record time>" or "injected" (the
   * diffText test seam). A rerun with a different base judges a DIFFERENT
   * diff (reproduced 2026-08-11: a corrected --base rerun that would PASS was
   * refused as inevitable), so the short-circuit requires this to match. The
   * pinned value is the RESOLVED SHA, never the ref string: refs move under
   * an unchanged worktree (reproduced 2026-08-11: `git branch -f start HEAD`
   * after a FAIL at `--base start`, and any WIP commit moving HEAD - the
   * commit-invariant fingerprint cannot see either), and a moved base means a
   * different judged diff. "injected" and any unresolved/legacy ref-string
   * form never arm the short-circuit.
   */
  diffSource?: string;
  /**
   * Verify gate only, stamped alongside failedStage on a non-PASS semantic
   * round: true when any judged lane rested on material the tree fingerprint
   * cannot see - a harness-run criterion `check:`, capture-produced evidence,
   * or an agentic lane Reading live files (gitignored
   * ones included). Such a FAIL is not reproducible-by-construction, so it
   * must never arm the rerun short-circuit (reproduced 2026-08-11 twice: a
   * capture, then a `check:`, of gitignored service-state "BROKEN" earned a
   * semantic FAIL; the live state was fixed out-of-tree and the rerun was
   * refused forever on the unchanged tree and stale pinned bytes). Records
   * without the field (pre-field files) cannot prove their material was
   * diff-only and never arm either.
   */
  usedLiveMaterial?: boolean;
  /**
   * Verify gate only: which document the round judged. The rerun short-circuit
   * reads the implement run's registered evidence only on the PRD path (that
   * is the only path that injects it), so both callers of the shared arming
   * predicate must agree on the doc kind or they disagree about whether a
   * rerun would be refused - reproduced 2026-08-11 on a quick run whose
   * same-slug implement state was touched after the FAIL: the gate refused the
   * rerun at $0 while the terminal predicate said "not terminal", which is the
   * original livelock verbatim (hook demanding a re-run the gate refuses).
   */
  docKind?: "prd" | "contract";
  /**
   * User-recorded budget grants (gap-audit/spec): each one reopened a fresh
   * fix budget at a terminal gauge, quoting the user's approval verbatim.
   * Mirrors implement's state.budgetGrants idea, not its machinery: these
   * gauges are stored (not replayed from history), so a grant resets them
   * directly and this array is the honest ledger of every reset
   * (PRINCIPLES item 10). `attemptCountBefore` quotes the cumulative
   * totalAttempts at grant time, which nothing ever resets.
   *
   * This ledger is a record, NOT enforcement: nothing binds `evidence` to
   * something the user provably said, and nothing can - the CLI has no
   * trusted channel to the conversation, and a refusal-time token would be
   * read back by the same agent it is meant to exclude. The user-only rule
   * is deliberately prose-guarded, exactly like `gate override`'s reason,
   * and the verbatim quote exists so a fabricated approval is a falsifiable
   * record the user can catch, not so the harness can catch it.
   */
  budgetGrants?: { at: string; evidence: string; attemptCountBefore: number; nonPassCountBefore?: number }[];
  /**
   * Human-consent findings converted to recorded assumptions under a
   * delegated run ($please): `evidence` quotes the user's invocation - the
   * standing decision to trade questions for veto-able assumptions - and
   * `findings` keeps each converted finding verbatim so the user can veto
   * after the fact. Same trust model as budgetGrants: a record, NOT
   * enforcement - nothing binds the evidence to a real invocation, and the
   * quote exists so a fabricated delegation is falsifiable by the USER.
   * P0 findings never land here; they still block (a P0 human finding means
   * invented consent or an unimplementable document, and pushing through
   * that is not an assumption).
   */
  humanAssumptions?: { at: string; evidence: string; findings: Finding[] }[];
  /**
   * PRD gates: the user's answers to a NEEDS_HUMAN bundle, recorded by
   * `gate answer`. `evidence` quotes the user's words verbatim and `findings`
   * keeps the bundle they answered, so the seal names what was decided by a
   * person and not by a judge. Same trust model as budgetGrants: a record the
   * user can falsify, not a check the harness can make.
   */
  humanAnswers?: { at: string; evidence: string; findings: Finding[]; question: string }[];
  /**
   * User-authorized review-cycle reopenings, kept as an append-only ledger.
   * The review cycle number is derived from this ledger (reopens + 1) and
   * nowhere else.
   */
  reviewReopens?: {
    at: string;
    evidence: string;
    cycleBefore: number;
    verdictBefore: GateRecord["verdict"];
  }[];
}

export interface GatesState {
  schema: 1;
  topic: string;
  gates: Record<GateId, GateRecord>;
  deviations: GateDeviation[];
  judgeCalls: JudgeCallRecord[];
  /**
   * Standing delegated-run record ($please): once written, every gap-audit
   * and spec run on this topic behaves as if --assume-human-findings carried
   * this evidence, without the agent re-passing the flag per call. Motivated
   * by measurement (2026-08-20, 3 please runs): the flag lived only as skill
   * prose, 2 of 3 runs omitted it, and each omission cost 4+ blocked judge
   * rounds on findings the delegation had already answered - a prose rule is
   * a request for discipline, not a guard (PRINCIPLES item 7). Same trust
   * model as budgetGrants: `evidence` quotes the user's own delegating
   * message so a fabricated delegation is falsifiable by the user; the
   * harness records, it does not verify.
   */
  delegation?: { at: string; evidence: string };
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
  readonly locksDir: string;

  constructor(projectRoot: string, topic: string) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(topic)) {
      throw new Error(`invalid topic slug: ${topic} (use kebab-case)`);
    }
    this.projectRoot = projectRoot;
    this.topic = topic;
    // Unified run layout; cli/src/runs/paths.ts is the
    // single authority so gates and implement can never disagree on identity.
    this.dir = gatesDirFor(projectRoot, topic);
    this.statePath = path.join(this.dir, "gates.json");
    this.artifactsDir = path.join(this.dir, "artifacts");
    this.locksDir = path.join(this.dir, ".locks");
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
    const state = JSON.parse(fs.readFileSync(this.statePath, "utf8")) as GatesState;
    // The bounded review lifecycle (full/closure/sealed/closure-blocked, round
    // counters) was retired by PRD gate-loop R2/R10 with no compatibility
    // read: a record still carrying it was written under a contract this CLI
    // no longer evaluates, and reading its verdict as if it were an open
    // findings set would silently coerce a spent closure into a live loop.
    // Refuse structurally, on the field's presence, so no retired value is
    // ever matched here.
    for (const [gate, record] of Object.entries(state.gates ?? {})) {
      if (record !== null && typeof record === "object" && "review" in record) {
        throw new Error(
          `${path.relative(this.projectRoot, this.statePath)} carries the retired bounded-review state on gate ${gate} (gates.${gate}.review); `
          + "this CLI has no compatibility read for it. Move the file aside (or delete the record's review key) and re-run the gate: "
          + "a PASS re-seals from the documents, a BLOCK re-derives its open findings from a fresh round.",
        );
      }
    }
    return state;
  }

  save(state: GatesState): void {
    const release = this.acquireStateLock();
    try {
      this.saveUnlocked(state);
    } finally {
      release();
    }
  }

  /**
   * Serialize a read-modify-write transaction and always reload inside it.
   * Different gates may judge in parallel, so accepting the caller's old
   * snapshot here would let the last finisher erase the first one's result.
   */
  update(mutator: (state: GatesState) => void): GatesState {
    const release = this.acquireStateLock();
    try {
      const state = this.load();
      mutator(state);
      this.saveUnlocked(state);
      return state;
    } finally {
      release();
    }
  }

  /** Same-gate judge admission lock. Different gate IDs remain parallel. */
  tryAcquireRunLock(gate: GateId): (() => void) | null {
    return this.tryAcquireLock(this.runLockPath(gate), true);
  }

  isGateInFlight(gate: GateId): boolean {
    const lockPath = this.runLockPath(gate);
    if (!fs.existsSync(lockPath)) return false;
    if (this.removeDeadOwnerLock(lockPath)) return false;
    return true;
  }

  writeArtifact(gate: GateId, payload: unknown): string {
    fs.mkdirSync(this.artifactsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(this.artifactsDir, `${gate}-${stamp}-${crypto.randomUUID().slice(0, 8)}.json`);
    fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { flag: "wx" });
    return path.relative(this.projectRoot, file);
  }

  private saveUnlocked(state: GatesState): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const temporary = `${this.statePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx" });
      fs.renameSync(temporary, this.statePath);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  private runLockPath(gate: GateId): string {
    return path.join(this.locksDir, `${gate}.run.lock`);
  }

  private acquireStateLock(): () => void {
    const lockPath = path.join(this.locksDir, "state.lock");
    const deadline = Date.now() + 5_000;
    while (true) {
      const release = this.tryAcquireLock(lockPath, true);
      if (release !== null) return release;
      if (Date.now() >= deadline) {
        throw new Error(`gate state is busy: timed out waiting for ${path.relative(this.projectRoot, lockPath)}`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }

  private tryAcquireLock(lockPath: string, recoverDeadOwner: boolean): (() => void) | null {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const token = crypto.randomUUID();
    const metadata = {
      token,
      pid: process.pid,
      hostname: os.hostname(),
      topic: this.topic,
      startedAt: new Date().toISOString(),
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        fs.writeFileSync(lockPath, `${JSON.stringify(metadata)}\n`, { flag: "wx" });
        return () => {
          try {
            const current = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { token?: string };
            if (current.token === token) fs.unlinkSync(lockPath);
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
          }
        };
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        if (!recoverDeadOwner || !this.removeDeadOwnerLock(lockPath)) return null;
      }
    }
    return null;
  }

  /** Recover only a demonstrably dead PID on this host. Live and remote locks stand. */
  private removeDeadOwnerLock(lockPath: string): boolean {
    let owner: { pid?: unknown; hostname?: unknown; token?: unknown };
    try {
      owner = JSON.parse(fs.readFileSync(lockPath, "utf8")) as typeof owner;
    } catch {
      return false;
    }
    if (owner.hostname !== os.hostname() || !Number.isInteger(owner.pid)) return false;
    try {
      process.kill(owner.pid as number, 0);
      return false;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) return false;
    }
    try {
      const latest = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { token?: unknown };
      if (latest.token !== owner.token) return false;
      fs.unlinkSync(lockPath);
      return true;
    } catch {
      return false;
    }
  }
}

const gitLib = require("../../lib/git.js") as {
  judgedDiffSha256: (projectRoot: string, baseRef: string | undefined) => string | null;
};


export interface GateStatusView {
  gate: GateId;
  /** Topic slug the view belongs to, so a printed recovery command names the real run. */
  topic: string;
  verdict: GateRecord["verdict"];
  effective: "PASS" | "STALE" | "BLOCKED" | "NEEDS_HUMAN" | "NOT_RUN";
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
  /** Verify-only fix-budget terminal; always false for bounded PRD review. */
  budgetExhausted: boolean;
  /** Judge ERRORs since the last real verdict (GateRecord.consecutiveErrors). */
  consecutiveErrors: number;
  /** Harness-owned backend streak bound, independent from the fix budget. */
  judgeErrorThreshold: number;
  /** Human-readable structured cause behind the active error streak. */
  judgeErrorCause: string | null;
  /**
   * Third terminal cause, beside `budgetExhausted` and the gate-commands-owned
   * `rerunRefused`: the judge backend has failed three times in a row with the
   * same structured cause and without returning a verdict. Distinct on purpose
   * (PRINCIPLES item 10 -
   * a record names what actually happened): a spent fix budget means the agent
   * had N sets of findings and could not close them, while this means it never
   * got one. Reported honestly as attempts 0/N plus this flag, never as a faked
   * exhaustion, exactly as `rerunRefused` is.
   */
  judgeErrorLoop: boolean;
  /** Verify-only judged non-PASS rounds since the last user grant. */
  roundsSinceGrant: number | null;
  /** Verify-only hard bound on roundsSinceGrant, derived as 3x the fix budget. */
  cycleCap: number | null;
  /**
   * Verify-only whole-run terminal. PRD gates use the explicit full/closure
   * lifecycle instead, so this heuristic is always false for them.
   */
  cycleExhausted: boolean;
  requiresHuman: boolean;
  /** PRD gates: the open findings set (see GateRecord.findings). */
  findings: Finding[];
  /** PRD gates: recorded advisories that do not block (see GateRecord.warnings). */
  warnings: Finding[];
  /** Count of user budget grants recorded on this gate (GateRecord.budgetGrants). */
  grants: number;
  /** Human-consent findings assumed under a delegated run (GateRecord.humanAssumptions), summed across rounds. */
  assumedHumanFindings: number;
  /** PRD review cycle: user-evidenced reopens + 1; null for verify. */
  reviewCycle: number | null;
  /** PRD gates: a judged PASS. Sealed to the pinned inputs until a user-evidenced reopen. */
  sealed: boolean;
  /** A sealed PASS whose pinned input changed needs an explicit user-evidenced `gate reopen`. */
  reopenRequired: boolean;
  /** A judge process currently owns this topic/gate admission lock. */
  inFlight: boolean;
}

/** PRD review cycle number: one plus the user-evidenced reopens on the record. */
export function reviewCycleOf(record: GateRecord): number {
  return (record.reviewReopens?.length ?? 0) + 1;
}

/** A PRD gate is sealed exactly when its last judged verdict is PASS. */
export function isSealed(record: GateRecord): boolean {
  return record.verdict === "PASS";
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

export function gateStatus(
  state: GatesState,
  gate: GateId,
  budget: number,
  projectRoot?: string,
  inFlight = false,
): GateStatusView {
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
  // A delegated invocation is a semantic PRD-gate input even though it is
  // stored in gates.json rather than a project document. The first live
  // Observer drive (2026-08-23) proved why: spec rejected an explicit
  // "do not commit" constraint because it saw the older qa-log but not the
  // later /please message. Pin the exact message so changing or clearing the
  // source invalidates the verdict just like changing a document does.
  if (gate !== "verify" && record.verdict !== null && !record.overridden) {
    const currentDelegation = state.delegation?.evidence;
    if (currentDelegation !== undefined) {
      if (record.delegationSha256 === undefined) {
        if (passed) staleInputs.push({ path: "<delegated-invocation>", reason: "unverifiable" });
      } else if (sha256Of(currentDelegation) !== record.delegationSha256) {
        staleInputs.push({ path: "<delegated-invocation>", reason: "changed" });
      }
    } else if (record.delegationSha256 !== undefined) {
      staleInputs.push({ path: "<delegated-invocation>", reason: "missing" });
    }
  }
  // The diff a PASS was earned on is part of what the PASS vouches for, so the
  // same check the Stop hook makes has to be visible here too - an agent that
  // reads `gate status` must not see a live PASS the harness treats as dead.
  // Both readers derive it from cli/lib/git.js, so they cannot disagree.
  if (passed && projectRoot !== undefined && record.verdict === "PASS") {
    const raw = record.judgedDiffSha256;
    const pin = typeof raw === "string" && raw !== "" ? raw : null;
    // No git base, no reproduction: the injected-diff test seam has no
    // provenance to re-derive, so it makes no claim either way - the same
    // reading ARMABLE_DIFF_SOURCE takes when it refuses to arm.
    const base = typeof record.diffSource === "string" && record.diffSource.startsWith("git:") ? record.diffSource.slice(4) : null;
    if (pin !== null) {
      // A pin with no git base cannot be reproduced (the injected-diff test
      // seam has no provenance), so it makes no claim either way - the same
      // reading ARMABLE_DIFF_SOURCE takes when it refuses to arm.
      if (base !== null) {
        const current = gitLib.judgedDiffSha256(projectRoot, base);
        if (current !== null && current !== pin) staleInputs.push({ path: "<judged-diff>", reason: "changed" });
      }
    } else if ((raw !== undefined && raw !== null && raw !== "") || "treeFingerprint" in record) {
      // Something was pinned that this reader cannot compare: a malformed
      // value, or a pre-field gates.json carrying the retired tree fingerprint.
      // Either way the PASS was earned under a rule we can no longer evaluate,
      // so it earns one honest re-run instead of being trusted silently (item
      // 10). Deliberately NOT gated on a git base: measured on real
      // pre-migration files (agents/gates/tetris-game, saju-reading,
      // 2026-08-11) the legacy records carry no diffSource at all, so requiring
      // one let exactly the records this branch exists for read as live.
      // `treeFingerprint` is read positionally rather than declared, because
      // declaring it would keep the retired concept alive in the type for one
      // migration read.
      staleInputs.push({ path: "<judged-diff>", reason: "unverifiable" });
    }
  }
  // `stale` only downgrades an otherwise-passing gate; on a blocked gate the
  // list is informational and must not turn BLOCKED into STALE.
  const stale = passed && staleInputs.length > 0;
  // Backend survival and fix iteration answer different questions. The former
  // stops after a small harness-owned streak of the same structured cause; the
  // latter remains project-configurable because it prices actual fix rounds.
  // `verdict === "ERROR"` keeps a streak written by one dist from being read as
  // terminal under a verdict written by another (PRINCIPLES items 10 and 13).
  const consecutiveErrors = Number.isInteger(record.consecutiveErrors) ? (record.consecutiveErrors as number) : 0;
  const rawErrorCause = record.consecutiveErrorCause;
  const errorCause = rawErrorCause !== undefined
    && typeof rawErrorCause.code === "string"
    && typeof rawErrorCause.backend === "string"
    && (typeof rawErrorCause.reason === "string" || rawErrorCause.reason === null)
      ? rawErrorCause
      : null;
  // Cycle gauge: judged NON-PASS rounds since the last grant. Counting only
  // non-PASS rounds (unlike `attempts`, which a PASS resets) bounds the
  // PASS->STALE->re-judge livelock - its blocked rounds accumulate across the
  // PASSes - while a healthy slug whose every re-run PASSes never trips
  // (red-team 2026-08-20: the first cut counted PASSes too, so a long-lived
  // document re-verified ~15 times would have been refused as "not
  // converging" on a history that converged every time). Read from the
  // dedicated cumulative counter, NOT from `history`: history keeps 20 rows,
  // so a history-derived gauge saturates below the cap and bounds nothing.
  // A legacy grant without nonPassCountBefore falls back to
  // attemptCountBefore, which counts MORE rounds (PASSes too) and therefore
  // only ever under-counts the gauge - fail-open, never a false terminal.
  const totalNonPass = Number.isInteger(record.totalNonPassAttempts) ? (record.totalNonPassAttempts as number) : 0;
  const lastGrant = record.budgetGrants?.length ? record.budgetGrants[record.budgetGrants.length - 1]! : null;
  const grantBase = lastGrant === null ? 0 : Number.isInteger(lastGrant.nonPassCountBefore) ? (lastGrant.nonPassCountBefore as number) : Math.min(lastGrant.attemptCountBefore, totalNonPass);
  const roundsSinceGrant = Math.max(0, totalNonPass - grantBase);
  const cycleCap = budget * 3;
  const prdGate = gate !== "verify";
  const sealed = prdGate && isSealed(record);
  return {
    gate,
    topic: state.topic,
    verdict: record.verdict,
    effective: passed
      ? (stale ? "STALE" : "PASS")
      : record.verdict === null
        ? "NOT_RUN"
        : record.verdict === "NEEDS_HUMAN"
          ? "NEEDS_HUMAN"
          : "BLOCKED",
    stale,
    inputsDrifted: staleInputs.length > 0,
    staleInputs,
    overridden: record.overridden,
    attempts: record.attempts,
    budget,
    // PRD semantic work is bounded by the two-phase lifecycle, not a numeric
    // retry gauge. Backend errors use the separate harness-owned threshold.
    budgetExhausted: !prdGate && !passed && record.attempts >= budget && record.verdict !== null,
    consecutiveErrors,
    judgeErrorThreshold: JUDGE_ERROR_LOOP_THRESHOLD,
    judgeErrorCause: errorCause === null ? null : describeJudgeFailureCause(errorCause),
    judgeErrorLoop: !passed
      && record.verdict === "ERROR"
      && errorCause !== null
      && consecutiveErrors >= JUDGE_ERROR_LOOP_THRESHOLD,
    roundsSinceGrant: prdGate ? null : roundsSinceGrant,
    cycleCap: prdGate ? null : cycleCap,
    cycleExhausted: !prdGate && budget > 0 && record.verdict !== null && roundsSinceGrant >= cycleCap,
    requiresHuman: record.findings.some((f) => f.requiresHuman),
    findings: record.findings,
    warnings: record.warnings ?? [],
    grants: record.budgetGrants?.length ?? 0,
    assumedHumanFindings: (record.humanAssumptions ?? []).reduce((sum, entry) => sum + entry.findings.length, 0),
    reviewCycle: prdGate ? reviewCycleOf(record) : null,
    sealed,
    reopenRequired: sealed && stale,
    inFlight,
  };
}

/**
 * Record the user's delegating invocation once for the whole run. The record
 * is immutable after its first write: a 2026-08-23 live Observer drive showed
 * an Implementor replacing the real invocation with "dummy" while assembling
 * a later gate command. Same-value retries are idempotent, but changing the
 * semantic source requires a new topic/run instead of rewriting history.
 */
export function recordDelegation(store: GateStore, _state: GatesState, evidence: string): GatesState {
  const trimmed = evidence.trim();
  if (trimmed === "") {
    throw new Error("gate delegate requires the user's verbatim delegating message (e.g. their $please invocation)");
  }
  return store.update((state) => {
    if (state.delegation !== undefined) {
      if (state.delegation.evidence === trimmed) return;
      throw new Error(
        "gate delegation is already bound to this topic's original invocation; choose a new topic slug instead of replacing it",
      );
    }
    state.delegation = { at: new Date().toISOString(), evidence: trimmed };
  });
}

/** A run's semantic source is append-only; revocation starts a new topic. */
export function clearDelegation(store: GateStore, _state: GatesState): GatesState {
  void store;
  throw new Error("gate delegation cannot be cleared in place; choose a new topic slug for a different invocation");
}

/**
 * Record explicit approval to retry a terminal failure gauge.
 * Verify may reopen an exhausted fix budget or judge-error streak; PRD gates
 * may retry only a repaired judge backend and never gain semantic rounds.
 */
export function grantGateBudget(store: GateStore, _state: GatesState, gate: GateId, evidence: string, budget: number): GatesState {
  const trimmed = evidence.trim();
  if (trimmed === "") {
    throw new Error("--grant-budget requires the user's verbatim approval text");
  }
  return store.update((state) => {
    const view = gateStatus(state, gate, budget);
    const grantable = gate === "verify"
      ? view.budgetExhausted || view.judgeErrorLoop || view.cycleExhausted
      : view.judgeErrorLoop;
    if (!grantable) {
      const recovery = gate === "verify"
        ? `the ${gate} fix budget is not exhausted; run the gate without it`
        : `${gate} semantic review is not reopened by a budget grant; a new user decision is recorded with 'sasu gate reopen --gate ${gate} --evidence "<the user's words>"'`;
      throw new Error(`--grant-budget refused: ${recovery}`);
    }
    const record = state.gates[gate]!;
    record.budgetGrants = [
      ...(record.budgetGrants ?? []),
      {
        at: new Date().toISOString(),
        evidence: trimmed,
        attemptCountBefore: record.totalAttempts ?? 0,
        nonPassCountBefore: record.totalNonPassAttempts ?? 0,
      },
    ];
    record.attempts = 0;
    record.consecutiveErrors = 0;
    delete record.consecutiveErrorCause;
    state.gates[gate] = record;
  });
}

/**
 * Open the next PRD review cycle on a user's recorded words. Any judged
 * verdict may be reopened - a sealed PASS whose author wants a change
 * reviewed, a NEEDS_HUMAN bundle the user answered by changing the document,
 * a BLOCK the user re-decided (PRD gate-loop D-07: a reopen against a sealed
 * log used to exit 1, and the user's words were lost). Only an unjudged gate
 * has nothing to reopen.
 */
export function reopenPrdGate(store: GateStore, gate: PrdGateId, evidence: string): GatesState {
  const trimmed = evidence.trim();
  if (trimmed === "") throw new Error("gate reopen requires the user's verbatim approval or change request");
  const release = store.tryAcquireRunLock(gate);
  if (release === null) throw new Error(`${gate} is currently in flight; wait for that judge run to finish before reopening it`);
  try {
    return store.update((state) => {
      const record = state.gates[gate] ?? { ...EMPTY_GATE };
      if (record.verdict === null) {
        throw new Error(`gate reopen refused: ${gate} has no judged verdict to reopen; run the gate first`);
      }
      const at = new Date().toISOString();
      record.reviewReopens = [
        ...(record.reviewReopens ?? []),
        { at, evidence: trimmed, cycleBefore: reviewCycleOf(record), verdictBefore: record.verdict },
      ];
      record.verdict = null;
      record.attempts = 0;
      record.consecutiveErrors = 0;
      delete record.consecutiveErrorCause;
      record.overridden = false;
      // The open findings set and the lane digests survive the reopen: the
      // next round is a delta re-judgment of exactly what was still open,
      // against exactly the decisions that changed since. Erasing the set is
      // what turned every reopened cycle into a fresh exhaustive review
      // (2026-08-29 audit). A sealed PASS has an empty set by definition.
      record.lastRunAt = null;
      delete record.inputs;
      delete record.delegationSha256;
      delete record.judgedDiffSha256;
      delete record.failedStage;
      delete record.diffSource;
      delete record.usedLiveMaterial;
      delete record.docKind;
      state.gates[gate] = record;
    });
  } finally {
    release();
  }
}

export function recordGateResult(
  store: GateStore,
  _state: GatesState,
  gate: GateId,
  outcome:
    | {
        kind: "verdict";
        verdict: GapVerdict["verdict"] | "NEEDS_HUMAN" | "FAIL";
        review?: ReviewResult;
        reviewFindings?: (ReviewFinding & { id?: string })[];
        /** Open concrete findings. */
        findings: Finding[];
        /** PRD gates: recorded advisories (see GateRecord.warnings). */
        warnings?: Finding[];
        /** PRD gates: per-lane decision-cell digests pinned with this verdict (see GateRecord.laneDigests). */
        laneDigests?: Record<string, string>;
        artifactPayload: unknown;
        inputs?: GateInput[];
        /** PRD-gate semantic source pin; omitted when no delegation was present. */
        delegationSha256?: string;
        /** New records only carry the vouched shape; legacy shapes exist solely in already-written files. */
        judgedDiffSha256?: string | null;
        /** Verify gate only: stage behind a non-PASS verdict (ignored on PASS). */
        failedStage?: VerifyFailedStage;
        /** Verify gate only: judged-diff identity ("git:<resolved SHA>" | "injected"). */
        diffSource?: string;
        /** Verify gate only: non-PASS round judged live material (see GateRecord field). */
        usedLiveMaterial?: boolean;
        /** Verify gate only: which document the round judged (see GateRecord field). */
        docKind?: "prd" | "contract";
        /** Delegated-run conversion this round performed (see GateRecord.humanAssumptions). */
        humanAssumption?: { evidence: string; findings: Finding[] };
      }
    | { kind: "error"; message: string; cause: JudgeFailureCause; artifactPayload?: unknown },
  judgeRecords: JudgeCallRecord[],
): GatesState {
  const at = new Date().toISOString();
  return store.update((state) => {
    const record = state.gates[gate] ?? { ...EMPTY_GATE };
    const prdGate = gate !== "verify";
    if (prdGate && isSealed(record)) {
      throw new Error(`${gate} review cycle ${reviewCycleOf(record)} is sealed; reopen it before recording another result`);
    }
    // Write the artifact only after admission has been checked against the
    // latest serialized state. A refused duplicate must leave neither a state
    // row nor an orphan artifact claiming that another review happened.
    const artifact = outcome.kind === "verdict"
      ? store.writeArtifact(gate, { at, gate, ...((outcome.artifactPayload as object) ?? {}) })
      : outcome.artifactPayload !== undefined
        ? store.writeArtifact(gate, {
            at,
            gate,
            stage: "judge-error",
            error: outcome.message,
            cause: outcome.cause,
            ...(outcome.artifactPayload as object),
          })
        : null;
    // A new judged result supersedes any earlier user override. The deviation
    // remains in history, but it must not turn a later BLOCK/FAIL/ERROR into an
    // effective PASS.
    record.overridden = false;
    let summary: GateRunSummary;
    if (outcome.kind === "verdict") {
    record.verdict = outcome.verdict;
    if (outcome.review !== undefined) {
      record.fullReview = outcome.review;
      let seq = record.findingSeq ?? 0;
      record.reviewFindings = (outcome.reviewFindings ?? []).map((finding) => ({ ...finding, id: finding.id ?? `F${++seq}` }));
      record.findingSeq = seq;
    }

    if (prdGate) {
      // Harness-assigned finding ids: a rerun judge echoes them to say "still
      // open", so they must be stable and never reused on this gate. Findings
      // that arrive with an id already carry a prior round's.
      let seq = record.findingSeq ?? 0;
      const stamp = (finding: Finding): Finding => {
        if (typeof finding.id === "string" && finding.id !== "") return finding;
        seq += 1;
        return { ...finding, id: `F${seq}` };
      };
      record.findings = outcome.findings.map(stamp);
      record.warnings = (outcome.warnings ?? []).map(stamp);
      record.findingSeq = seq;
      if (outcome.laneDigests !== undefined) record.laneDigests = outcome.laneDigests;
    } else {
      record.findings = outcome.findings;
      record.warnings = outcome.warnings ?? [];
    }
    record.inputs = outcome.inputs ?? [];
    if (outcome.delegationSha256 !== undefined) record.delegationSha256 = outcome.delegationSha256;
    else delete record.delegationSha256;
    record.judgedDiffSha256 = outcome.judgedDiffSha256 ?? null;
    // Stamped only when the caller says so, and a failedStage never survives a
    // PASS: a lingering "semantic" under a later verdict would let the rerun
    // short-circuit refuse on a stage that did not produce this record.
    const failedStage = outcome.verdict !== "PASS" ? outcome.failedStage : undefined;
    if (failedStage !== undefined) record.failedStage = failedStage;
    else delete record.failedStage;
    if (outcome.diffSource !== undefined) record.diffSource = outcome.diffSource;
    else delete record.diffSource;
    // Same lifecycle as failedStage: the live-material stamp describes a
    // non-PASS round only, and must never survive under a verdict it did not
    // describe (the short-circuit trusts it).
    const usedLiveMaterial = outcome.verdict !== "PASS" ? outcome.usedLiveMaterial : undefined;
    if (usedLiveMaterial !== undefined) record.usedLiveMaterial = usedLiveMaterial;
    else delete record.usedLiveMaterial;
    // Same lifecycle again: the doc kind describes the round the stamps came
    // from, so the terminal predicate reads implement evidence on exactly the
    // path the gate itself did.
    const docKind = outcome.verdict !== "PASS" ? outcome.docKind : undefined;
    if (docKind !== undefined) record.docKind = docKind;
    else delete record.docKind;
    // A declared gap is an evidenced blocked handoff, not another failed fix
    // attempt. It keeps the gate closed but cannot consume a budget whose job
    // is to bound attempts to fix newly discovered findings.
    record.attempts = outcome.verdict === "PASS"
      ? 0
      : failedStage === "declared-gap"
        ? record.attempts
        : record.attempts + 1;
    // Cumulative twin of the gauge above: every real run counts, PASS included,
    // and nothing resets it (see the GateRecord field comment).
    record.totalAttempts = (record.totalAttempts ?? 0) + 1;
    // Cycle-cap ledger: cumulative judged non-PASS rounds, never reset. Kept
    // as its own counter because `history` is capped at 20 rows (below), so a
    // gauge derived from history saturates and the cap silently stops
    // bounding anything past 20 rounds - measured during this change's own
    // red-team fix (101 alternating rounds plateaued at 14/15).
    if (outcome.verdict !== "PASS" && failedStage !== "declared-gap") {
      record.totalNonPassAttempts = (record.totalNonPassAttempts ?? 0) + 1;
    }
    // ANY judged verdict clears the error streak, FAIL and BLOCK included: the
    // judge answered the question, which is the whole thing the streak counts.
    record.consecutiveErrors = 0;
    delete record.consecutiveErrorCause;
    if (outcome.humanAssumption !== undefined && outcome.humanAssumption.findings.length > 0) {
      record.humanAssumptions = [
        ...(record.humanAssumptions ?? []),
        { at, evidence: outcome.humanAssumption.evidence, findings: outcome.humanAssumption.findings },
      ];
    }
    summary = {
      at,
      verdict: outcome.verdict,
      findingCount: outcome.findings.length,
      requiresHuman: outcome.findings.some((f) => f.requiresHuman),
      error: null,
      artifact,
      judgedDiffSha256: outcome.judgedDiffSha256 ?? null,
      ...(failedStage !== undefined ? { failedStage } : {}),
      ...(outcome.diffSource !== undefined ? { diffSource: outcome.diffSource } : {}),
      // Mirrored onto the history row so the arming-time stamp-consistency
      // check (commands.ts) can prove record and row came from one write.
      ...(usedLiveMaterial !== undefined ? { usedLiveMaterial } : {}),
      ...(docKind !== undefined ? { docKind } : {}),
    };
    } else {
    // Fail-closed (D-15): a judge failure counts as a blocked run, never a pass.
    // The run still produced real work before the judge broke - commands ran,
    // artifacts were pinned - so that evidence is written out rather than lost
    // with the failed call.
    record.verdict = "ERROR";
    // ERROR is a fact about the judge, not the tree or a stage: stale
    // stage/diff stamps under it would misdescribe this record (item 10), and
    // ERROR never arms the short-circuit anyway.
    delete record.failedStage;
    delete record.diffSource;
    delete record.usedLiveMaterial;
    delete record.docKind;
    // `attempts` is deliberately untouched: it is the FIX budget, and a judge
    // that never returned a verdict handed the agent nothing to fix, so
    // charging it there converts a backend malfunction into a false BLOCKED
    // (measured 2026-08-11, modakbul/webhook-to-modakbul-server: 4 of 10 verify
    // attempts lost to judge-invalid-output, 0 criterion FAILs in any round
    // that did answer, 3 spurious BLOCKEDs). The run stays fully recorded
    // anyway - ERROR verdict, cumulative counter, history row - because the
    // budget is a gauge, not the ledger (PRINCIPLES item 10).
    record.totalAttempts = (record.totalAttempts ?? 0) + 1;
    // The bound that keeps "does not spend the budget" from meaning "retries
    // forever" (PRINCIPLES item 13): only an identical structured backend
    // cause grows the streak. A different failure starts a new diagnosis at 1.
    record.consecutiveErrors = sameJudgeFailureCause(record.consecutiveErrorCause, outcome.cause)
      ? (record.consecutiveErrors ?? 0) + 1
      : 1;
    record.consecutiveErrorCause = outcome.cause;
    summary = {
      at,
      verdict: "ERROR",
      findingCount: 0,
      requiresHuman: false,
      error: outcome.message,
      judgeErrorCause: outcome.cause,
      artifact,
    };
    }
    record.lastRunAt = at;
    record.history = [...record.history.slice(-19), summary];
    state.gates[gate] = record;
    state.judgeCalls = [...state.judgeCalls, ...judgeRecords];
  });
}

/**
 * Seal a NEEDS_HUMAN bundle on the user's recorded answer without another
 * judge call (PRD gate-loop R2/AC4). The bundle's findings were, by the
 * judge's own labelling, closable only by a human decision, so the judge has
 * nothing further to say once that decision exists; re-consulting it is what
 * the old loop did and what ended in overrides. The caller pins the inputs
 * as they stand at answer time: the document edits that record the
 * decision (Register rows, PRD text) happen BEFORE this call, so the seal
 * vouches for the document the user's answer landed in.
 */
export function answerPrdGate(
  store: GateStore,
  gate: PrdGateId,
  evidence: string,
  inputs: GateInput[],
  question: string,
): GatesState {
  const trimmed = evidence.trim();
  if (trimmed === "") throw new Error("gate answer requires the user's verbatim answer to the open human questions");
  const release = store.tryAcquireRunLock(gate);
  if (release === null) throw new Error(`${gate} is currently in flight; wait for that judge run to finish before answering it`);
  try {
    return store.update((state) => {
      const record = state.gates[gate] ?? { ...EMPTY_GATE };
      if (record.verdict !== "NEEDS_HUMAN") {
        throw new Error(
          `gate answer refused: ${gate} is ${record.verdict ?? "not run"}, not NEEDS_HUMAN; only a bundle of human questions is sealed by an answer`,
        );
      }
      const at = new Date().toISOString();
      record.humanAnswers = [...(record.humanAnswers ?? []), { at, evidence: trimmed, findings: record.findings, question }];
      record.verdict = "PASS";
      record.findings = [];
      record.inputs = inputs;
      record.attempts = 0;
      record.overridden = false;
      record.lastRunAt = at;
      record.totalAttempts = (record.totalAttempts ?? 0) + 1;
      record.history = [
        ...record.history.slice(-19),
        { at, verdict: "PASS", findingCount: 0, requiresHuman: false, error: null, artifact: null, judgedDiffSha256: null },
      ];
      state.gates[gate] = record;
    });
  } finally {
    release();
  }
}

export function overrideGate(store: GateStore, _state: GatesState, gate: GateId, reason: string): GatesState {
  const trimmed = reason.trim();
  if (trimmed === "") {
    throw new Error("override requires a non-empty --reason");
  }
  return store.update((state) => {
    const record = state.gates[gate] ?? { ...EMPTY_GATE };
    record.overridden = true;
    state.gates[gate] = record;
    state.deviations = [...state.deviations, { at: new Date().toISOString(), gate, reason: trimmed, by: "user" }];
  });
}
