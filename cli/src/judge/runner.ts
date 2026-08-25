import type { BackendName, JudgeProfile, JudgeTarget, SasuConfig } from "../config";
import { judgeProfileFor } from "../config";
import { resolveBackend } from "./backends";
import { extractJsonObject, JudgeError, type JudgeCallRecord } from "./types";

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
  if (options.agentic === true && !backend.agentic) {
    throw new Error(`judge requires isolated read-only evidence access; ${backend.name} cannot provide it for profile ${profile}`);
  }
  let startedAt = Date.now();
  let attempts = 0;
  let lastProblem = "";
  let activityCommands: string[] = [];
  let fallback: JudgeCallRecord["fallback"];
  let fallbackUsed = target.backend !== selected.primary.backend;
  const useFallback = (error: JudgeError): boolean => {
    const fallbackTarget = !fallbackUsed ? selected.fallback : null;
    if (fallbackTarget === null) return false;
    const fallbackBackend = resolveBackend(fallbackTarget.backend);
    if (!fallbackBackend.available()) return false;
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
  const retryOrFallback = (error: JudgeError): void => {
    // Every unusable judge response crosses this one boundary. Backend
    // command-audit rejection, missing JSON, and schema rejection must not
    // acquire three subtly different attempt or fallback contracts.
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
      record: makeRecord(backend.name, target, profile, purpose, startedAt, attempts, error.code, fallback, activityCommands),
    });
  };
  while (true) {
    attempts += 1;
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
    return {
      value: validated,
      record: makeRecord(backend.name, target, profile, purpose, startedAt, attempts, "ok", fallback, activityCommands),
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
    ...(fallback !== undefined ? { fallback } : {}),
  };
}

export function judgeCallRecordFrom(error: unknown): JudgeCallRecord | null {
  if (error instanceof JudgeError && "record" in error) {
    return (error as JudgeError & { record: JudgeCallRecord }).record;
  }
  return null;
}
