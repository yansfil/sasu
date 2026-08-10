import type { SasuConfig, Tier } from "../config";
import { tierModelFor } from "../config";
import { resolveBackend } from "./backends";
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
  const backend = resolveBackend(config.judge.backend);
  const model = tierModelFor(config, backend.name, tier);
  const startedAt = Date.now();
  let attempts = 0;
  let lastProblem = "";
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
        throw Object.assign(error, {
          record: makeRecord(backend.name, model, tier, purpose, startedAt, attempts, error.code),
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
      record: makeRecord(backend.name, model, tier, purpose, startedAt, attempts, "ok"),
    };
  }
  const error = new JudgeError("judge-invalid-output", backend.name, lastProblem);
  throw Object.assign(error, {
    record: makeRecord(backend.name, model, tier, purpose, startedAt, attempts, error.code),
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
  };
}

export function judgeCallRecordFrom(error: unknown): JudgeCallRecord | null {
  if (error instanceof JudgeError && "record" in error) {
    return (error as JudgeError & { record: JudgeCallRecord }).record;
  }
  return null;
}
