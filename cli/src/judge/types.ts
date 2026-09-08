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

export interface ReviewFinding {
  kind: "defect" | "advisory" | "human-confirmation";
  requirementRefs: string[];
  problem: string;
  evidenceRefs: string[];
  nextAction: string;
  priorFindingId?: string;
  human?: { sourceRef: string; quote: string; timing: "post-completion" | "prerequisite" };
}

export interface ReviewDisposition {
  findingId: string;
  status: "resolved" | "open";
  reason: string;
  evidenceRefs: string[];
}

export interface ReviewResult {
  summary: string;
  findings: ReviewFinding[];
  priorDispositions: ReviewDisposition[];
}

export interface ReviewValidationContext {
  requirementRefs: readonly string[];
  evidenceRefs: readonly string[];
  priorFindingIds: readonly string[];
  humanSources?: Readonly<Record<string, string>>;
}

/** The harness validates structure and references; semantic sufficiency belongs to the independent reviewer. */
export function validateReviewResult(value: unknown, context: ReviewValidationContext): ReviewResult | string {
  if (!isRecord(value)) return "review output is not a JSON object";
  if ("criteria" in value || "verdict" in value) return "retired per-criterion/verdict output; return summary, findings and priorDispositions";
  const text = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
  const refs = (v: unknown, allowed: readonly string[]): v is string[] => Array.isArray(v) && v.every((r) => text(r) && allowed.includes(r)) && new Set(v).size === v.length;
  if (!text(value.summary)) return "summary must be a non-empty string";
  if (!Array.isArray(value.findings)) return "findings must be an array";
  if (!Array.isArray(value.priorDispositions)) return "priorDispositions must be an array";
  const findings: ReviewFinding[] = [];
  const continued = new Set<string>();
  for (const [i, finding] of value.findings.entries()) {
    if (!isRecord(finding)) return `findings[${i}] must be an object`;
    const { kind, problem, nextAction, priorFindingId, human } = finding;
    if (kind !== "defect" && kind !== "advisory" && kind !== "human-confirmation") return `findings[${i}].kind must be defect|advisory|human-confirmation`;
    if (!text(problem) || !text(nextAction)) return `findings[${i}] requires concrete problem and nextAction`;
    if (!refs(finding.requirementRefs, context.requirementRefs)) return `findings[${i}].requirementRefs contains invalid, duplicate or unknown references`;
    if (!refs(finding.evidenceRefs, context.evidenceRefs)) return `findings[${i}].evidenceRefs contains invalid, duplicate or unknown references`;
    if (kind === "defect" && finding.evidenceRefs.length === 0) return `findings[${i}] defect requires concrete evidence or a contract reference describing absent evidence`;
    if (priorFindingId !== undefined) {
      if (!text(priorFindingId) || !context.priorFindingIds.includes(priorFindingId) || continued.has(priorFindingId)) return `findings[${i}].priorFindingId is unknown or repeated`;
      continued.add(priorFindingId);
    }
    if (kind === "human-confirmation") {
      if (!isRecord(human) || !text(human.sourceRef) || !text(human.quote) || (human.timing !== "post-completion" && human.timing !== "prerequisite")) return `findings[${i}].human requires sourceRef, original quote and timing`;
      if (context.humanSources !== undefined && (!Object.prototype.hasOwnProperty.call(context.humanSources, human.sourceRef) || !context.humanSources[human.sourceRef]!.includes(human.quote))) return `findings[${i}].human must cite a known source and its exact original quote`;
    } else if (human !== undefined) return `findings[${i}].human is only valid for human-confirmation`;
    findings.push({ kind, requirementRefs: finding.requirementRefs, problem, evidenceRefs: finding.evidenceRefs, nextAction,
      ...(priorFindingId !== undefined ? { priorFindingId: priorFindingId as string } : {}),
      ...(human !== undefined ? { human: human as NonNullable<ReviewFinding["human"]> } : {}),
    });
  }
  const dispositions: ReviewDisposition[] = [];
  const seen = new Set<string>();
  for (const [i, disposition] of value.priorDispositions.entries()) {
    if (!isRecord(disposition)) return `priorDispositions[${i}] must be an object`;
    const { findingId, status, reason, evidenceRefs } = disposition;
    if (!text(findingId) || !context.priorFindingIds.includes(findingId) || seen.has(findingId)) return `priorDispositions[${i}].findingId is unknown or repeated`;
    if (status !== "resolved" && status !== "open") return `priorDispositions[${i}].status must be resolved|open`;
    if (!text(reason) || !refs(evidenceRefs, context.evidenceRefs) || evidenceRefs.length === 0) return `priorDispositions[${i}] requires a reason and valid evidence references`;
    if (status === "resolved" && continued.has(findingId)) return `priorDispositions[${i}] resolves a finding still returned as open`;
    seen.add(findingId);
    dispositions.push({ findingId, status, reason, evidenceRefs });
  }
  const missing = context.priorFindingIds.filter((id) => !seen.has(id));
  if (missing.length > 0) return `priorDispositions missing explicit disposition for: ${missing.join(", ")}`;
  return { summary: value.summary, findings, priorDispositions: dispositions };
}

export function reviewResultSchema(): string {
  return `Return one JSON object with this shape, and no per-requirement PASS array or overall verdict:
{"summary":"whole-contract assessment","findings":[{"kind":"defect|advisory|human-confirmation","requirementRefs":[],"problem":"specific unmet contract or concrete concern","evidenceRefs":[],"nextAction":"required fix or optional improvement","priorFindingId":"only when continuing an existing finding","human":{"sourceRef":"source of human authority","quote":"verbatim source words","timing":"post-completion|prerequisite"}}],"priorDispositions":[{"findingId":"existing open ID","status":"resolved|open","reason":"what changed or remains wrong","evidenceRefs":[]}]}
Omit priorFindingId for a new finding. Include human only for human-confirmation, where it is required.
Every existing open finding needs an explicit disposition; disappearance is not resolution.
A defect must cite concrete evidence or the contract reference whose required evidence is absent.
Small missing requirements are defects. Optional improvements are advisory.
A newly found omission in an unchanged file is still a defect when supported by contract and counterevidence.
Do not convert an implementation defect or missing access into post-completion human confirmation.`;
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
