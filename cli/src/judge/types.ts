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
  /** Bounded diagnostic; the full text reaches only the in-memory retry preamble. */
  detail: string;
  durationMs: number;
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
  /** Audited shell reads made by an agentic backend, when exposed. */
  activity?: {
    commands: string[];
  };
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
}

export interface GapVerdict {
  verdict: "PASS" | "BLOCK";
  findings: Finding[];
}

export interface CriterionVerdict {
  id: string;
  verdict: "PASS" | "FAIL";
  reason: string;
  /**
   * What the judge actually looked at for this verdict: file/hunk names or
   * artifact paths (an empty evidence list on an approval is treated as a
   * verification failure, not a pass). Enforced for
   * PASS verdicts by validateSemanticVerdict; a FAIL may stand on absence,
   * which has no artifact to cite.
   */
  evidence: string;
}

export interface SemanticVerdict {
  verdict: "PASS" | "FAIL";
  criteria: CriterionVerdict[];
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
    findings.push({
      area,
      severity,
      missing,
      recommendation: asString(f["recommendation"]) ?? "",
      requiresHuman,
      ...(id !== null && id.trim() !== "" ? { id: id.trim() } : {}),
    });
  }
  if (verdict === "BLOCK" && findings.length === 0) return "BLOCK verdict requires at least one finding";
  if (verdict === "PASS" && findings.some((f) => f.severity !== "P2")) {
    return "PASS verdict cannot carry P0/P1 findings";
  }
  return { verdict, findings };
}

export function validateSemanticVerdict(value: unknown, expectedIds: string[]): SemanticVerdict | string {
  if (!isRecord(value)) return "output is not a JSON object";
  const verdict = asString(value["verdict"]);
  if (verdict !== "PASS" && verdict !== "FAIL") return `verdict must be PASS or FAIL, got: ${String(value["verdict"])}`;
  if (!Array.isArray(value["criteria"])) return "criteria must be an array";
  const criteria: CriterionVerdict[] = [];
  for (const [i, c] of (value["criteria"] as unknown[]).entries()) {
    if (!isRecord(c)) return `criteria[${i}] is not an object`;
    const id = asString(c["id"]);
    const cv = asString(c["verdict"]);
    const reason = asString(c["reason"]) ?? "";
    const evidence = (asString(c["evidence"]) ?? "").trim();
    if (id === null) return `criteria[${i}].id must be a string`;
    if (cv !== "PASS" && cv !== "FAIL") return `criteria[${i}].verdict must be PASS or FAIL`;
    // A PASS must name what it rests on; rejecting it here routes through the
    // runner's one-retry loop, so a judge that forgot the field gets exactly
    // one chance to cite its sources before the call fails as invalid output.
    if (cv === "PASS" && evidence === "") {
      return `criteria[${i}] (${id}) is a PASS with empty evidence; cite the file/hunk or artifact the verdict rests on`;
    }
    criteria.push({ id, verdict: cv, reason, evidence });
  }
  const returned = new Set(criteria.map((c) => c.id));
  const missing = expectedIds.filter((id) => !returned.has(id));
  if (missing.length > 0) return `criteria missing verdicts for: ${missing.join(", ")}`;
  const anyFail = criteria.some((c) => c.verdict === "FAIL");
  if (verdict === "PASS" && anyFail) return "verdict PASS contradicts FAIL criteria";
  if (verdict === "FAIL" && !anyFail) return "verdict FAIL requires at least one FAIL criterion";
  return { verdict, criteria };
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
