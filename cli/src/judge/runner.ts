import type { BackendName, JudgeProfile, JudgeTarget, SasuConfig } from "../config";
import { judgeProfileFor } from "../config";
import { AGENTIC_READ_MAX_ROUNDS, resolveBackend } from "./backends";
import { extractJsonObject, JudgeError, type JudgeCallRecord, type JudgeErrorCode, type JudgeRetry, type JudgeUsage } from "./types";

/**
 * Backends that failed authentication or runtime in THIS process.
 *
 * Process-scoped on purpose: a weekly rate limit resets on a wall clock the
 * harness does not own, so persisting the verdict would outlive its truth.
 * Within one verify run (minutes) it is exactly right.
 *
 * Measured on the 2026-08-27 crawler-arena run: the design lane's Codex
 * primary was rejected, the Claude fallback answered "You've hit your weekly
 * limit", and the lane ERRORed after 648s. Nothing stopped the next 23 judge
 * calls in that same run from paying the identical discovery again.
 *
 * Two scopes, because the two failure classes have different blast radii:
 * `judge-auth` is a property of the CLI's login state, so it condemns the
 * backend for every model at one strike. `judge-auth-or-runtime` also covers
 * an ordinary non-zero exit, which one bad prompt or one misconfigured model
 * name can produce, so it is keyed on backend+model and takes two strikes -
 * a routine-profile model failing must never disable the high-risk profile's
 * different model on the same backend.
 *
 * A success clears both scopes for its target: a backend that answers is
 * healthy by observation. The clear rescues a transient blip only while
 * calls are still dialling the primary - typically the straggler successes
 * of the same concurrent wave; once the skip engages, nothing dials the
 * primary again this process, which is accepted (the fallback exists and
 * the run is minutes long).
 */
const UNHEALTHY_STRIKES = 2;
const judgeHealth = new Map<string, number>();

const authKey = (backend: BackendName): string => `auth:${backend}`;
const runtimeKey = (backend: BackendName, model: string | null): string => `runtime:${backend}\0${model ?? ""}`;

function recordBackendFailure(backend: BackendName, model: string | null, code: JudgeErrorCode): void {
  if (code === "judge-auth") {
    judgeHealth.set(authKey(backend), UNHEALTHY_STRIKES);
    return;
  }
  if (code !== "judge-auth-or-runtime") return;
  const key = runtimeKey(backend, model);
  judgeHealth.set(key, (judgeHealth.get(key) ?? 0) + 1);
}

function recordBackendSuccess(backend: BackendName, model: string | null): void {
  judgeHealth.delete(authKey(backend));
  judgeHealth.delete(runtimeKey(backend, model));
}

/** The strike class that condemned this target, or null while it is healthy. */
function unhealthyCode(backend: BackendName, model: string | null): "judge-auth" | "judge-auth-or-runtime" | null {
  if ((judgeHealth.get(authKey(backend)) ?? 0) >= UNHEALTHY_STRIKES) return "judge-auth";
  if ((judgeHealth.get(runtimeKey(backend, model)) ?? 0) >= UNHEALTHY_STRIKES) return "judge-auth-or-runtime";
  return null;
}

/** Test seam: the ledger is process-scoped, so a suite must be able to clear it. */
export function resetJudgeHealth(): void {
  judgeHealth.clear();
}

/**
 * What the judge demonstrably did to gather evidence during one attempt.
 * `toolRounds: null` means the backend gave no signal - callers must treat
 * that as unknown, never as "read nothing", or a missing envelope field
 * would invalidate honest verdicts.
 */
export interface JudgeActivity {
  commands: string[];
  toolRounds: number | null;
}

export interface JudgeOutcome<T> {
  value: T;
  record: JudgeCallRecord;
}

function persistedFallbackReason(
  error: JudgeError,
): string {
  const outcome = error.code;
  if (outcome === "judge-auth") return "primary judge authentication failed";
  if (outcome === "judge-auth-or-runtime") return "primary judge authentication or runtime failed";
  if (outcome === "judge-timeout") return "primary judge timed out";
  if (outcome !== "judge-invalid-output") return "primary judge failed before producing a usable verdict";

  // The exact detail still reaches the one in-memory retry, but durable state
  // is formatted from a structured backend/validator category. Provider text,
  // commands, paths, and secrets never need message-prefix parsing here.
  switch (error.reason) {
    case "prompt-only-shell": return "command-audit: prompt-only judge executed a shell command";
    case "non-read-command": return "command-audit: isolated judge used a non-read command";
    case "shell-composition": return "command-audit: isolated judge used unsafe shell syntax or expansion";
    case "out-of-workspace": return "command-audit: isolated judge attempted an out-of-workspace path";
    case "missing-allowlisted-path": return "command-audit: isolated judge named no allowlisted evidence path";
    case "tool-surface": return "tool-surface: codex tool failed";
    case "missing-json": return "response-validation: no JSON object found";
    case "empty-response": return "response-validation: judge returned no usable message";
    case "read-budget-exceeded": return "read-budget: isolated judge exceeded the harness read budget";
    case "unauditable-trace": return "command-audit: judge emitted a trace line too large to audit";
    default: break;
  }
  return "response-validation: judge output did not satisfy the required contract";
}

/** Effective project profile after the test/diagnostic backend override. */
export function effectiveJudgeProfile(config: SasuConfig, profile: JudgeProfile): { primary: JudgeTarget; fallback: JudgeTarget | null } {
  const configured = judgeProfileFor(config, profile);
  const override = process.env["SASU_JUDGE_BACKEND"] as BackendName | undefined;
  if (override !== undefined && override !== "claude" && override !== "codex" && override !== "stub") {
    throw new Error(`SASU_JUDGE_BACKEND must be claude, codex, or stub, got: ${override}`);
  }
  const configuredTargets = [configured.primary, configured.fallback].filter((target): target is JudgeTarget => target !== null);
  const overriddenPrimary = override === undefined
    ? null
    : configuredTargets.find((target) => target.backend === override) ?? {
        ...configured.primary,
        backend: override,
        ...(override === "stub" ? { model: null } : {}),
      };
  return override === undefined
    ? configured
    : {
        primary: overriddenPrimary!,
        fallback: override === "stub"
          ? null
          : configuredTargets.find((target) => target.backend !== override) ?? null,
      };
}

/**
 * One-shot judge call with the D-16 output defense: schema validation plus
 * exactly one retry on invalid output. Backend/model/attempt counts are
 * returned for receipt recording; the caller persists them. Async so lane
 * fan-out can run several judges concurrently; the per-call timeout and
 * retry semantics are unchanged.
 */
export async function runJudge<T>(
  config: SasuConfig,
  purpose: string,
  profile: JudgeProfile,
  prompt: string,
  validate: (value: unknown, activity: JudgeActivity) => T | string,
  options: { images?: string[]; agentic?: boolean; cwd?: string; evidencePaths?: string[] } = {},
): Promise<JudgeOutcome<T>> {
  const selected = effectiveJudgeProfile(config, profile);
  let target: JudgeTarget = selected.primary;
  let backend = resolveBackend(target.backend);
  // An image must be an attachment, not bytes emitted by a Read tool. Claude
  // has no attachment surface, so choose the configured attachment-capable
  // fallback before the call rather than exposing a context-size lottery.
  const visualEvidence = (options.images?.length ?? 0) > 0;
  if (visualEvidence && !backend.attachments) {
    const attachmentFallback = selected.fallback !== null && resolveBackend(selected.fallback.backend).attachments
      ? selected.fallback
      : null;
    if (attachmentFallback === null) {
      throw new JudgeError("judge-invalid-output", backend.name, "visual evidence requires an attachment-capable judge; configure Codex for this profile");
    }
    target = attachmentFallback;
    backend = resolveBackend(target.backend);
  }
  let fallback: JudgeCallRecord["fallback"];
  // A backend that already failed auth/runtime in this process will fail the
  // same way again; starting there only pays its latency to rediscover that.
  // Same shape as the attachment swap above - choose before the call rather
  // than after N callers have each eaten the discovery.
  const primaryUnhealthy = unhealthyCode(target.backend, target.model);
  if (primaryUnhealthy !== null && selected.fallback !== null && unhealthyCode(selected.fallback.backend, selected.fallback.model) === null) {
    const candidate = resolveBackend(selected.fallback.backend);
    const capable = candidate.available()
      && (options.agentic !== true || candidate.agentic)
      && (!visualEvidence || candidate.attachments);
    if (capable) {
      fallback = {
        at: new Date().toISOString(),
        backend: target.backend,
        model: target.model,
        effort: target.effort,
        durationMs: 0,
        attempts: 0,
        outcome: primaryUnhealthy,
        reason: primaryUnhealthy === "judge-auth"
          ? "primary judge skipped: it already failed authentication in this run"
          : "primary judge skipped: it already failed authentication or runtime in this run",
      };
      target = selected.fallback;
      backend = candidate;
    }
  }
  if (options.agentic === true && !backend.agentic) {
    throw new Error(`judge requires isolated read-only evidence access; ${backend.name} cannot provide it for profile ${profile}`);
  }
  let startedAt = Date.now();
  let attempts = 0;
  let lastProblem = "";
  let activityCommands: string[] = [];
  let fallbackUsed = target.backend !== selected.primary.backend;
  const useFallback = (error: JudgeError): boolean => {
    const fallbackTarget = !fallbackUsed ? selected.fallback : null;
    if (fallbackTarget === null) return false;
    const fallbackBackend = resolveBackend(fallbackTarget.backend);
    if (!fallbackBackend.available()) return false;
    // Refusing a known-dead fallback surfaces the primary's real error now
    // instead of after a second full-latency call proves what this process
    // already knows.
    if (unhealthyCode(fallbackTarget.backend, fallbackTarget.model) !== null) return false;
    // A fallback must be able to see the same proof surface. Dropping isolated
    // evidence access or image visibility would turn backend recovery into a
    // different judgment with missing inputs.
    if (options.agentic === true && !fallbackBackend.agentic) return false;
    if ((options.images?.length ?? 0) > 0 && !fallbackBackend.attachments) return false;
    fallbackUsed = true;
    fallback = {
      at: new Date(startedAt).toISOString(),
      backend: backend.name,
      model: target.model,
      effort: target.effort,
      durationMs: Date.now() - startedAt,
      attempts,
      outcome: error.code,
      reason: persistedFallbackReason(error),
    };
    target = fallbackTarget;
    backend = fallbackBackend;
    startedAt = Date.now();
    attempts = 0;
    lastProblem = "";
    activityCommands = [];
    return true;
  };
  let attemptActivity: JudgeActivity = { commands: [], toolRounds: null };
  // Persisted answer to "why attempts=N": one entry per rejected attempt,
  // across the primary and any fallback. The full detail still drives the
  // in-memory retry preamble; the record keeps a bounded copy.
  const retries: JudgeRetry[] = [];
  let usage: JudgeUsage | undefined;
  let attemptStartedAt = Date.now();
  const retryOrFallback = (error: JudgeError): void => {
    // Every unusable judge response crosses this one boundary. Backend
    // command-audit rejection, missing JSON, and schema rejection must not
    // acquire three subtly different attempt or fallback contracts - and it
    // is therefore also the one place the health ledger can learn anything.
    recordBackendFailure(backend.name, target.model, error.code);
    // A rejected attempt's spend must never be persisted as the call's usage:
    // the field is documented as the answering attempt's.
    usage = undefined;
    retries.push({
      at: new Date(attemptStartedAt).toISOString(),
      backend: backend.name,
      model: target.model,
      code: error.code,
      reason: error.reason,
      detail: error.detail.slice(0, 300),
      durationMs: Date.now() - attemptStartedAt,
    });
    if (error.code === "judge-invalid-output" && attempts < 2) {
      lastProblem = error.detail;
      return;
    }
    const canFallback = error.code === "judge-auth"
      || error.code === "judge-auth-or-runtime"
      || error.code === "judge-timeout"
      || error.code === "judge-invalid-output";
    if (canFallback && useFallback(error)) return;
    throw Object.assign(error, {
      record: makeRecord(backend.name, target, profile, purpose, startedAt, attempts, error.code, fallback, activityCommands, retries, usage),
    });
  };
  while (true) {
    attempts += 1;
    attemptStartedAt = Date.now();
    // Usage belongs to the answering attempt only; a stale value from an
    // attempt whose reply was later rejected must not be recorded as the
    // call's spend.
    usage = undefined;
    const retryPreamble =
      attempts === 1
        ? ""
        : `Your previous attempt was rejected: ${lastProblem}. Correct that specific problem, then reply with only the JSON object, no prose, no code fences.\n\n`;
    let text: string;
    try {
      const result = await backend.run(retryPreamble + prompt, {
        model: target.model,
        timeoutMs: config.judge.timeoutMs,
        purpose,
        effort: target.effort,
        ...(options.images !== undefined ? { images: options.images } : {}),
        ...(options.agentic !== undefined ? { agentic: options.agentic } : {}),
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.evidencePaths !== undefined ? { evidencePaths: options.evidencePaths } : {}),
      });
      text = result.text;
      usage = result.usage;
      activityCommands.push(...(result.activity?.commands ?? []));
      attemptActivity = {
        commands: result.activity?.commands ?? [],
        toolRounds:
          result.activity?.toolRounds ??
          (result.activity !== undefined ? result.activity.commands.length : null),
      };
    } catch (error) {
      if (error instanceof JudgeError) {
        // The creator-assist baseline recorded 27/56 acceptance calls crossing
        // to the slower fallback after a command-audit rejection; none gave
        // the primary the repair attempt schema-invalid JSON already received.
        retryOrFallback(error);
        continue;
      }
      throw error;
    }
    // Read-budget backstop for every agentic surface. Codex is bounded
    // mid-flight by the streaming auditor (kill before paying the next model
    // turn); Claude's surface exposes only num_turns after the fact, so the
    // post-hoc check is the strongest instrument that path admits
    // (PRINCIPLES 1). Without it, two codex budget aborts would cross the
    // call to an UNBOUNDED claude read - reproducing on the fallback exactly
    // the 575s over-reading the budget exists to stop. null stays unknown,
    // never "read nothing".
    if (options.agentic === true && attemptActivity.toolRounds !== null && attemptActivity.toolRounds > AGENTIC_READ_MAX_ROUNDS) {
      retryOrFallback(new JudgeError(
        "judge-invalid-output",
        backend.name,
        `judge used ${attemptActivity.toolRounds} tool rounds against a limit of ${AGENTIC_READ_MAX_ROUNDS}; batch reads and inspect only the paths the criterion needs`,
        "read-budget-exceeded",
      ));
      continue;
    }
    const parsed = extractJsonObject(text);
    if (parsed === null) {
      retryOrFallback(new JudgeError("judge-invalid-output", backend.name, "no JSON object found in output", "missing-json"));
      continue;
    }
    const validated = validate(parsed, attemptActivity);
    if (typeof validated === "string") {
      retryOrFallback(new JudgeError("judge-invalid-output", backend.name, validated, "invalid-contract"));
      continue;
    }
    recordBackendSuccess(backend.name, target.model);
    return {
      value: validated,
      record: makeRecord(backend.name, target, profile, purpose, startedAt, attempts, "ok", fallback, activityCommands, retries, usage),
    };
  }
}

function makeRecord(
  backend: JudgeCallRecord["backend"],
  target: JudgeTarget,
  profile: JudgeProfile,
  purpose: string,
  startedAt: number,
  attempts: number,
  outcome: JudgeCallRecord["outcome"],
  fallback?: JudgeCallRecord["fallback"],
  activityCommands: string[] = [],
  retries: JudgeRetry[] = [],
  usage?: JudgeUsage,
): JudgeCallRecord {
  return {
    at: new Date(startedAt).toISOString(),
    backend,
    model: target.model,
    profile,
    effort: target.effort,
    purpose,
    durationMs: Date.now() - startedAt,
    attempts,
    outcome,
    ...(activityCommands.length > 0 ? { activity: { commands: activityCommands } } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(retries.length > 0 ? { retries } : {}),
    ...(fallback !== undefined ? { fallback } : {}),
  };
}

export function judgeCallRecordFrom(error: unknown): JudgeCallRecord | null {
  if (error instanceof JudgeError && "record" in error) {
    return (error as JudgeError & { record: JudgeCallRecord }).record;
  }
  return null;
}
