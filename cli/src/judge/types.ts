import type { BackendName, JudgeEffort, JudgeProfile } from "../config";

export type JudgeErrorCode =
  | "judge-binary-missing"
  | "judge-auth"
  | "judge-auth-or-runtime"
  | "judge-context-overflow"
  | "judge-timeout"
  | "judge-invalid-output";

export type JudgeFailureReason =
  | "prompt-only-shell"
  | "non-read-command"
  | "shell-composition"
  | "out-of-workspace"
  | "missing-allowlisted-path"
  | "turn-failed"
  | "missing-turn-completed"
  | "missing-json"
  | "empty-response"
  | "invalid-contract"
  | "input-too-large"
  | "read-budget-exceeded"
  | "unauditable-trace"
  | "evidence-access";

/**
 * Token spend reported by the backend for one judge call. Recorded verbatim
 * from the provider envelope: the 2026-08-27 crawler-arena investigation had
 * to replay a 575s judge call with a hand-built probe because nothing in
 * state.json said where the time went - the backends were already emitting
 * this and the harness discarded it (PRINCIPLES 9).
 */
export interface JudgeUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
}

/**
 * What the harness actually observed while ONE backend attempt ran.
 *
 * Written as it is observed rather than derived from the reply, because the
 * calls that most need explaining are the ones that never reply. The
 * 2026-09-10 verify-timeout benchmark had to rebuild 62-94 read commands and
 * 294,797-406,394 chars of read output with a temporary PATH shim: the
 * streaming audit observed every one of them and the record kept none, so a
 * read-volume abort and a model that simply never answered were the same
 * empty record.
 *
 * `null` never means zero. A field is null exactly when this backend cannot
 * attest that dimension, so "unmetered" stays distinguishable from "metered
 * and zero" (PRINCIPLES item 10: unavailable is unverified, not a value).
 */
export interface JudgeActivity {
  /** Audited read commands in trace order; null when the backend exposes no command trace. */
  commands: string[] | null;
  /**
   * Read operations attributable to this call, in the unit the harness read
   * budget is written in; null when the backend can attest neither a trace
   * nor a count. Codex counts audited command_execution events directly.
   * Claude counts the `tool_use` blocks in its stream-json trace, which is
   * exact rather than a bound: it is the tool calls themselves, not a turn
   * count they are inferred from. That distinction is measured - a turn can
   * carry many calls (20 reads in 2 API turns, 2026-09-10), and on the two
   * capped traces on disk `num_turns` reports 9 against 22 and 28 tool calls
   * (2026-09-11). An earlier version of this field was derived from
   * `num_turns - 1` and described itself as a lower bound for that reason.
   */
  readRounds: number | null;
  /**
   * The backend's own turn count, exactly as it reported it (claude
   * `num_turns`, one completion for the API backend). Recorded raw for cost
   * and latency accounting and for comparison against a turn cap; it is a
   * different question from "how much did this call read", and a backend that
   * answers in one turn having read nothing must not look like a reader.
   */
  modelTurns: number | null;
  /** Chars of read output the streaming audit metered; null when this backend streams no readable trace. */
  readOutputChars: number | null;
  /**
   * ms from the start of this backend invocation to the last observed read;
   * null when no read was observed. With the attempt's own duration this is
   * what separates "died carrying reads" from "read early, then never
   * answered": the benchmark's code #1 ended 0.0s after its last read
   * (read-volume abort) while code #2 spent its final 122.8s producing no
   * reads at all before the timeout.
   */
  msToLastRead: number | null;
}

/** A fresh sink: nothing observed yet, and nothing claimed about what will be. */
export function newJudgeActivity(): JudgeActivity {
  return { commands: null, readRounds: null, modelTurns: null, readOutputChars: null, msToLastRead: null };
}

/**
 * Whether an observation carries positive evidence that the judge read its
 * allowlisted source. Callers that gate on reading must not treat an
 * unmetered call as zero (a normal call by a backend that attests nothing
 * would be rejected) nor as satisfied (unverified reading would become a
 * PASS). Naming the three shapes here keeps that decision one judgment
 * instead of one truthiness expression per caller.
 */
export type ReadEvidence = "observed" | "none-observed" | "unmetered";

export function readEvidence(activity: JudgeActivity): ReadEvidence {
  // Read-unit signals only. `modelTurns` is deliberately absent: the API
  // backend reports one turn having read nothing at all, so counting turns
  // here would let a call with no read surface present itself as a reader.
  if ((activity.commands?.length ?? 0) > 0 || (activity.readRounds ?? 0) > 0 || (activity.readOutputChars ?? 0) > 0) return "observed";
  if (activity.commands === null && activity.readRounds === null && activity.readOutputChars === null) return "unmetered";
  return "none-observed";
}

/**
 * One rejected attempt inside a judge call. `attempts: 2` alone cannot answer
 * "why 2" - the rejection reason lived only in the in-memory retry preamble
 * and evaporated when the retry succeeded.
 */
export interface JudgeRetry {
  at: string;
  backend: BackendName;
  model: string | null;
  code: JudgeErrorCode;
  reason: JudgeFailureReason | null;
  /**
   * This attempt's ordinal on its own backend: 1 was sent the bare prompt, 2
   * was sent the previous rejection as a correction sentence. The position in
   * `retries` cannot answer that - a fallback crossing resets both the
   * attempt counter and the correction text, so the second entry in the array
   * is a first attempt whenever the backend changed.
   *
   * Needed to read `discarded` at all: a second-attempt reply was written by a
   * judge that had already been told what was wrong, so mixing the two into
   * one rate answers a question nobody asked.
   *
   * Entries recorded before this field existed do not carry it. Absent is
   * unknown, not 1 - reading it as 1 would pour every old record into exactly
   * the half of the split this field was added to separate. That is every
   * record on disk today: 23 of 23 retry entries in the benchmark copies have
   * no `attempt`, 3 of them read-budget rejections (2026-09-11; a lower bound,
   * since operational records outside those copies were not counted).
   */
  attempt: number;
  /** Bounded diagnostic; the full text reaches only the in-memory retry preamble. */
  detail: string;
  durationMs: number;
  /**
   * What this rejected attempt was observed doing. Per attempt on purpose:
   * summing a call's attempts hid exactly the sequence the benchmark needed
   * ("attempt 1 aborted on 406,394 read chars, attempt 2 timed out").
   */
  observation: JudgeActivity;
  /**
   * What the rejected reply turned out to contain, when the rejection was
   * decided without ever looking at it. Only the read-budget check does that,
   * and that is exactly the case nobody could answer: four production
   * rejections discarded 533-596s of judge work each and the records cannot
   * say whether the discarded text was a usable review (2026-09-10,
   * agents/benchmarks/paperwork-delivery-20260910/results).
   *
   * Recording, never acceptance. The rejection is unchanged; this only makes
   * "was it worth keeping" a question the records can answer later.
   *
   * Later, and not before: the rejections already on disk have no `discarded`
   * either, because they were decided without reading the text. This answers
   * for runs after it lands and says nothing about the 2,645s already thrown
   * away - having the field is not having the answer.
   */
  discarded?: DiscardedOutput;
}

/**
 * A bounded verdict on a reply the harness threw away without reading.
 *
 * `problem` ends in U+2026 when it was cut, so a reader counting rejection
 * causes can tell a short reason from the front of a long one.
 */
export interface DiscardedOutput {
  /** Whether a JSON object could be extracted from the reply at all. */
  parsed: boolean;
  /** The caller's contract verdict; absent when nothing parsed. */
  contract?: "accepted" | "rejected";
  /** Bounded rejection reason, when the contract refused it. */
  problem?: string;
}

export const JUDGE_ERROR_LOOP_THRESHOLD = 3;

export interface JudgeFailureCause {
  code: string;
  backend: string;
  reason: string | null;
}

export function judgeFailureCause(error: JudgeError): JudgeFailureCause {
  return { code: error.code, backend: error.backend, reason: error.reason };
}

export function sameJudgeFailureCause(left: JudgeFailureCause | null | undefined, right: JudgeFailureCause): boolean {
  return left?.code === right.code && left.backend === right.backend && left.reason === right.reason;
}

export function describeJudgeFailureCause(cause: JudgeFailureCause): string {
  return `${cause.backend}/${cause.code}${cause.reason === null ? "" : `/${cause.reason}`}`;
}

export interface JudgeAdvisory {
  code: "judge-backend-advisory";
  backend: BackendName;
  message: string;
}

export class JudgeError extends Error {
  readonly code: JudgeErrorCode;
  readonly backend: BackendName;
  readonly detail: string;
  readonly reason: JudgeFailureReason | null;

  constructor(code: JudgeErrorCode, backend: BackendName, detail: string, reason: JudgeFailureReason | null = null) {
    super(`${code} (backend: ${backend}): ${detail}`);
    this.code = code;
    this.backend = backend;
    this.detail = detail;
    this.reason = reason;
  }
}

/**
 * How this call's screenshots reached the judge. Recorded whenever a call
 * carried any, because the two ways of delivering them are not the same
 * guarantee.
 *
 * `attached` means the images are in the request whatever the judge decides.
 * `workspace-readable` means they were copied into the read-only workspace and
 * the judge had to open them: measured possible on claude 2026-09-10
 * (agents/benchmarks/claude-image-read-20260910/report.md, 4/4 on a token that
 * exists only in pixels). Whether the judge did open them is answerable from
 * its trace and simply is not recorded here: a `tool_use` block carries the
 * path it read, and the imgfirst1 production trace names 8 image reads among
 * its 44 tool calls (2026-09-11). So a reader of this field alone cannot tell
 * a verdict that studied the screenshots from one that never opened them, and
 * must weigh it knowing that (PRINCIPLES item 10) - but that is this record
 * being narrow, not the backend being silent, and per-image evidence is
 * buildable without new capability.
 *
 * The two deliveries also differ in what they spend. `attached` consumes no
 * read rounds; `workspace-readable` is paid out of the read budget, and how
 * much varies rather than being one round per image - in uncensored
 * 2026-09-10 reviews one run took 3 images in a single round and another took
 * 8 images across 8 (agents/benchmarks/max-turns-20260910). Nothing here says
 * which happened, because this envelope reports only a total read count.
 *
 * That is a statement about rounds and about nothing else. The wall-clock cost
 * of those rounds was measured too and is not summarised here, because the
 * same measurement puts a single-image round at a few seconds and a
 * three-image round at over a minute; one number for both would mislead
 * whichever way it was rounded.
 *
 * `verifiedSeen` tracks `delivery` exactly across today's backends, and is
 * recorded separately because that is a fact about today's backends rather
 * than a definition - a backend that both reads its workspace and streams a
 * trace could deliver `workspace-readable` with `verifiedSeen: true`. Until
 * one exists, do not read them as independent signals.
 */
export interface VisualEvidenceRecord {
  images: number;
  delivery: "attached" | "workspace-readable";
  verifiedSeen: boolean;
}

export interface JudgeCallRecord {
  at: string;
  backend: BackendName;
  model: string | null;
  profile: JudgeProfile;
  effort: JudgeEffort;
  purpose: string;
  durationMs: number;
  /**
   * Parse-retry attempts WITHIN this single judge invocation (1 = clean first
   * reply, 2 = one schema-rejected reply was retried). Not the gate's
   * fix-and-regate attempts counter in gates.json - that counts whole runs.
   */
  attempts: number;
  outcome: "ok" | JudgeErrorCode;
  /** Non-fatal backend notices observed during this invocation. */
  advisories?: JudgeAdvisory[];
  /**
   * What the harness observed during the answering attempt, or during the
   * fatal one when this call failed. Absent only when no attempt ran, so an
   * observed-nothing call and an unobserved one are no longer the same
   * missing key. Earlier attempts keep their own `retries[].observation`.
   */
  activity?: JudgeActivity;
  /** How screenshots reached this judge, when the call carried any. */
  visualEvidence?: VisualEvidenceRecord;
  /** Provider-reported token spend of the answering attempt, when exposed. */
  usage?: JudgeUsage;
  /** Every rejected attempt, in order, across the primary and any fallback. */
  retries?: JudgeRetry[];
  /** A backend failure that was recovered by one cross-vendor fallback. */
  fallback?: {
    at: string;
    backend: BackendName;
    model: string | null;
    effort: JudgeEffort;
    durationMs: number;
    /** Calls made to the rejected backend before crossing vendors. */
    attempts: number;
    outcome: JudgeErrorCode;
    /** Bounded diagnostic category for the rejection that caused fallback. */
    reason: string;
  };
}

export interface Finding {
  /**
   * Harness-assigned id on PRD-gate findings (`F<n>`, cli/src/gates/store.ts
   * recordGateResult). A rerun judge echoes it to report a prior finding as
   * still open; a finding it returns without one is new. Absent on verify
   * criteria findings and on freshly judged output before it is recorded.
   */
  id?: string;
  area: string;
  severity: "P0" | "P1" | "P2";
  missing: string;
  recommendation: string;
  requiresHuman: boolean;
  /** Resolution authority is independent of impact. Missing on legacy replies: fail closed. */
  disposition?: "agent_fix" | "delegated_assumption" | "human_authority";
}

export interface GapVerdict {
  verdict: "PASS" | "BLOCK";
  findings: Finding[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export function validateGapVerdict(value: unknown): GapVerdict | string {
  if (!isRecord(value)) return "output is not a JSON object";
  const verdict = asString(value["verdict"]);
  if (verdict !== "PASS" && verdict !== "BLOCK") return `verdict must be PASS or BLOCK, got: ${String(value["verdict"])}`;
  if (!Array.isArray(value["findings"])) return "findings must be an array";
  const findings: Finding[] = [];
  for (const [i, f] of (value["findings"] as unknown[]).entries()) {
    if (!isRecord(f)) return `findings[${i}] is not an object`;
    const severity = asString(f["severity"]);
    if (severity !== "P0" && severity !== "P1" && severity !== "P2") return `findings[${i}].severity must be P0|P1|P2`;
    const area = asString(f["area"]);
    const missing = asString(f["missing"]);
    if (area === null || missing === null || missing.trim() === "") return `findings[${i}] needs area and missing strings`;
    // An echoed prior-finding id; any other shape is treated as "no id" by
    // the open-set contract (commands.ts applyOpenSetContract), never as an
    // error - the judge's job is the judgment, the harness owns the ids.
    const id = asString(f["id"]);
    const requiresHuman = f["requiresHuman"];
    if (typeof requiresHuman !== "boolean") return `findings[${i}].requiresHuman must be a boolean`;
    const disposition = f["disposition"];
    if (disposition !== undefined && disposition !== "agent_fix" && disposition !== "delegated_assumption" && disposition !== "human_authority") {
      return `findings[${i}].disposition must be agent_fix|delegated_assumption|human_authority`;
    }
    findings.push({
      area,
      severity,
      missing,
      recommendation: asString(f["recommendation"]) ?? "",
      requiresHuman,
      ...(disposition !== undefined ? { disposition } : {}),
      ...(id !== null && id.trim() !== "" ? { id: id.trim() } : {}),
    });
  }
  if (verdict === "BLOCK" && findings.length === 0) return "BLOCK verdict requires at least one finding";
  if (verdict === "PASS" && findings.some((f) => f.severity !== "P2")) {
    return "PASS verdict cannot carry P0/P1 findings";
  }
  return { verdict, findings };
}

/**
 * Judge replies sometimes wrap JSON in prose or code fences despite
 * instructions. Extract the first balanced JSON object conservatively.
 */
export function extractJsonObject(text: string): unknown | null {
  const trimmed = text.trim();
  const direct = tryParse(trimmed);
  if (direct !== undefined) return direct;
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence && fence[1] !== undefined) {
    const fenced = tryParse(fence[1].trim());
    if (fenced !== undefined) return fenced;
  }
  const start = trimmed.indexOf("{");
  if (start === -1) return null;
  for (let end = trimmed.length; end > start; end -= 1) {
    if (trimmed[end - 1] !== "}") continue;
    const candidate = tryParse(trimmed.slice(start, end));
    if (candidate !== undefined) return candidate;
  }
  return null;
}

function tryParse(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
