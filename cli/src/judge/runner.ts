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
  const useFallback = (outcome: Exclude<JudgeCallRecord["outcome"], "ok">): boolean => {
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
      outcome,
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
  while (true) {
    attempts += 1;
    const retryPreamble =
      attempts === 1
        ? ""
        : `Your previous reply was rejected: ${lastProblem}. Reply with ONLY the JSON object, no prose, no code fences.\n\n`;
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
        const canFallback = error.code === "judge-auth" || error.code === "judge-auth-or-runtime" || error.code === "judge-timeout" || error.code === "judge-invalid-output";
        if (canFallback && useFallback(error.code)) continue;
        throw Object.assign(error, {
          record: makeRecord(backend.name, target, profile, purpose, startedAt, attempts, error.code, fallback, activityCommands),
        });
      }
      throw error;
    }
    const parsed = extractJsonObject(text);
    if (parsed === null) {
      lastProblem = "no JSON object found in output";
      if (attempts >= 2) {
        const error = new JudgeError("judge-invalid-output", backend.name, lastProblem);
        if (useFallback(error.code)) continue;
        throw Object.assign(error, {
          record: makeRecord(backend.name, target, profile, purpose, startedAt, attempts, error.code, fallback, activityCommands),
        });
      }
      continue;
    }
    const validated = validate(parsed, attemptActivity);
    if (typeof validated === "string") {
      lastProblem = validated;
      if (attempts >= 2) {
        const error = new JudgeError("judge-invalid-output", backend.name, lastProblem);
        if (useFallback(error.code)) continue;
        throw Object.assign(error, {
          record: makeRecord(backend.name, target, profile, purpose, startedAt, attempts, error.code, fallback, activityCommands),
        });
      }
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
