import type { SasuConfig, Tier } from "../config";
import { tierModelFor } from "../config";
import { resolveBackend, resolveFallbackBackend } from "./backends";
import { extractJsonObject, JudgeError, type JudgeCallRecord } from "./types";

export interface JudgeOutcome<T> {
  value: T;
  record: JudgeCallRecord;
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
  tier: Tier,
  prompt: string,
  validate: (value: unknown) => T | string,
  options: { effort?: string; images?: string[]; agentic?: boolean; cwd?: string } = {},
): Promise<JudgeOutcome<T>> {
  let backend = resolveBackend(config.judge.backend);
  let model = tierModelFor(config, backend.name, tier);
  let startedAt = Date.now();
  let attempts = 0;
  let lastProblem = "";
  let fallback: JudgeCallRecord["fallback"];
  let fallbackUsed = false;
  while (attempts < 2) {
    attempts += 1;
    const retryPreamble =
      attempts === 1
        ? ""
        : `Your previous reply was rejected: ${lastProblem}. Reply with ONLY the JSON object, no prose, no code fences.\n\n`;
    let text: string;
    try {
      text = (
        await backend.run(retryPreamble + prompt, {
          model,
          timeoutMs: config.judge.timeoutMs,
          purpose,
          ...(options.effort !== undefined ? { effort: options.effort } : {}),
          ...(options.images !== undefined ? { images: options.images } : {}),
          ...(options.agentic !== undefined ? { agentic: options.agentic } : {}),
          ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        })
      ).text;
    } catch (error) {
      if (error instanceof JudgeError) {
        const canFallback = error.code === "judge-auth" || error.code === "judge-auth-or-runtime";
        const fallbackBackend = !fallbackUsed && canFallback ? resolveFallbackBackend(backend) : null;
        if (fallbackBackend !== null) {
          fallbackUsed = true;
          fallback = {
            at: new Date(startedAt).toISOString(),
            backend: backend.name,
            model,
            durationMs: Date.now() - startedAt,
            outcome: error.code,
          };
          backend = fallbackBackend;
          model = tierModelFor(config, backend.name, tier);
          startedAt = Date.now();
          attempts = 0;
          lastProblem = "";
          continue;
        }
        throw Object.assign(error, {
          record: makeRecord(backend.name, model, tier, purpose, startedAt, attempts, error.code, fallback),
        });
      }
      throw error;
    }
    const parsed = extractJsonObject(text);
    if (parsed === null) {
      lastProblem = "no JSON object found in output";
      continue;
    }
    const validated = validate(parsed);
    if (typeof validated === "string") {
      lastProblem = validated;
      continue;
    }
    return {
      value: validated,
      record: makeRecord(backend.name, model, tier, purpose, startedAt, attempts, "ok", fallback),
    };
  }
  const error = new JudgeError("judge-invalid-output", backend.name, lastProblem);
  throw Object.assign(error, {
    record: makeRecord(backend.name, model, tier, purpose, startedAt, attempts, error.code, fallback),
  });
}

function makeRecord(
  backend: JudgeCallRecord["backend"],
  model: string | null,
  tier: Tier,
  purpose: string,
  startedAt: number,
  attempts: number,
  outcome: JudgeCallRecord["outcome"],
  fallback?: JudgeCallRecord["fallback"],
): JudgeCallRecord {
  return {
    at: new Date(startedAt).toISOString(),
    backend,
    model,
    tier,
    purpose,
    durationMs: Date.now() - startedAt,
    attempts,
    outcome,
    ...(fallback !== undefined ? { fallback } : {}),
  };
}

export function judgeCallRecordFrom(error: unknown): JudgeCallRecord | null {
  if (error instanceof JudgeError && "record" in error) {
    return (error as JudgeError & { record: JudgeCallRecord }).record;
  }
  return null;
}
