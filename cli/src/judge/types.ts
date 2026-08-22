import type { BackendName, JudgeEffort, JudgeProfile } from "../config";

export type JudgeErrorCode =
  | "judge-binary-missing"
  | "judge-auth"
  | "judge-auth-or-runtime"
  | "judge-context-overflow"
  | "judge-timeout"
  | "judge-invalid-output";

export class JudgeError extends Error {
  readonly code: JudgeErrorCode;
  readonly backend: BackendName;
  readonly detail: string;

  constructor(code: JudgeErrorCode, backend: BackendName, detail: string) {
    super(`${code} (backend: ${backend}): ${detail}`);
    this.code = code;
    this.backend = backend;
    this.detail = detail;
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
  /** Audited shell reads made by an agentic backend, when exposed. */
  activity?: {
    commands: string[];
  };
  /** A backend failure that was recovered by one cross-vendor fallback. */
  fallback?: {
    at: string;
    backend: BackendName;
    model: string | null;
    effort: JudgeEffort;
    durationMs: number;
    outcome: JudgeErrorCode;
  };
}

export interface Finding {
  area: string;
  severity: "P0" | "P1" | "P2";
  missing: string;
  recommendation: string;
  requiresHuman: boolean;
  /** Present on re-run judgments only (delta contract): where this finding came from. */
  origin?: "prior-unresolved" | "new";
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

export function validateGapVerdict(value: unknown, options: { requireOrigin?: boolean } = {}): GapVerdict | string {
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
    const origin = asString(f["origin"]);
    if (options.requireOrigin && origin !== "prior-unresolved" && origin !== "new") {
      return `findings[${i}].origin must be "prior-unresolved" or "new" on a re-run judgment`;
    }
    const requiresHuman = f["requiresHuman"];
    if (typeof requiresHuman !== "boolean") return `findings[${i}].requiresHuman must be a boolean`;
    findings.push({
      area,
      severity,
      missing,
      recommendation: asString(f["recommendation"]) ?? "",
      requiresHuman,
      ...(origin === "prior-unresolved" || origin === "new" ? { origin } : {}),
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
