/**
 * Messages-API judge backend.
 *
 * The document gates (gap-audit, spec) hand the judge a prompt and read back
 * one JSON verdict. Nothing in that contract needs a CLI session, a working
 * directory, or a tool loop - `codex exec` and `claude -p` were paying for a
 * whole agent harness to run a single completion, which is also why
 * JUDGE_SUBPROCESS_ENV had to exist at all (a judge subprocess would otherwise
 * fire the project's own Stop hook inside itself). Over HTTP that failure mode
 * cannot occur: there is no session, so there are no hooks.
 *
 * Raw fetch, not the Anthropic SDK, because `cli/package.json` declares zero
 * runtime dependencies and one POST does not justify breaking that. The wire
 * shape below is the documented Messages API; `baseUrl` lets the same code
 * reach api.anthropic.com or any Messages-compatible origin without the
 * harness learning what sits behind it.
 *
 * Streaming is not optional here. Recorded lanes on this repo's own gates have
 * run 540s at xhigh (2026-08-28 implement-check artifacts); a non-streaming
 * POST of that length is a request-timeout lottery, and the stall guard below
 * needs per-chunk arrival times to distinguish "thinking" from "dead".
 */
import type { JudgeAdvisory, JudgeUsage } from "./types";
import { JudgeError } from "./types";
import type { BackendRunOptions, BackendRunResult, JudgeBackend } from "./backends";

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_BASE_URL = "https://api.anthropic.com";
/**
 * Verdicts are a small JSON object, but thinking tokens are billed against
 * this ceiling too - a cap sized for the answer alone truncates the reply at
 * high effort and the call fails validation instead of the budget.
 */
const MAX_TOKENS = 32_000;
/**
 * No upstream bytes for this long means the connection is dead, not slow. A
 * thinking model streams ping/delta events well inside this window, so the
 * guard fires on genuinely stalled sockets without capping honest long turns
 * (the overall deadline stays the caller's timeoutMs).
 */
const STALL_MS = 120_000;

const NO_TOOLS_PREAMBLE =
  "You are a one-shot judge. Every document you need is already included in this prompt; answer directly from it.\n\n";

function baseUrlOf(options: BackendRunOptions): string {
  const configured = options.baseUrl ?? process.env["SASU_JUDGE_API_BASE_URL"] ?? DEFAULT_BASE_URL;
  return configured.replace(/\/+$/, "");
}

/**
 * Loopback origins are the local-proxy case, where the proxy owns the upstream
 * credential and the harness has none to send. Requiring a key there would
 * make the backend unusable for exactly the deployment it was generalized for.
 */
function isLoopback(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

function authHeaders(baseUrl: string): Record<string, string> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  const authToken = process.env["ANTHROPIC_AUTH_TOKEN"];
  if (apiKey !== undefined && apiKey !== "") return { "x-api-key": apiKey };
  if (authToken !== undefined && authToken !== "") {
    // OAuth credentials travel as a bearer token and need the oauth beta.
    return { authorization: `Bearer ${authToken}`, "anthropic-beta": "oauth-2025-04-20" };
  }
  if (isLoopback(baseUrl)) return {};
  throw new JudgeError(
    "judge-auth",
    "api",
    "no Messages-API credential: set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN, or point judge.baseUrl at a local proxy that owns the credential",
  );
}

interface StreamAccumulation {
  text: string;
  usage: JudgeUsage | undefined;
  stopReason: string | null;
  refusal: string | null;
}

/**
 * Consume one Messages SSE stream into the answer text.
 *
 * Only top-level `text` deltas are accumulated: thinking deltas are reasoning,
 * not the verdict, and appending them would hand the JSON extractor a document
 * with prose wrapped around it.
 */
async function consumeStream(response: Response, stallMs: number): Promise<StreamAccumulation> {
  const body = response.body;
  if (body === null) throw new JudgeError("judge-invalid-output", "api", "Messages stream had no body", "empty-response");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const acc: StreamAccumulation = { text: "", usage: undefined, stopReason: null, refusal: null };
  let blockIsText = false;

  try {
    while (true) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new JudgeError("judge-timeout", "api", `Messages stream stalled: no bytes for ${Math.round(stallMs / 1000)}s`)),
            stallMs,
          ).unref?.(),
        ),
      ]);
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let cut = buffer.indexOf("\n\n");
      while (cut >= 0) {
        const rawEvent = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        cut = buffer.indexOf("\n\n");
        const dataLine = rawEvent.split("\n").find((line) => line.startsWith("data:"));
        if (dataLine === undefined) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>;
        } catch {
          continue;
        }
        const type = event["type"];
        if (type === "content_block_start") {
          const block = event["content_block"] as { type?: unknown } | undefined;
          blockIsText = block?.type === "text";
        } else if (type === "content_block_delta") {
          const delta = event["delta"] as { type?: unknown; text?: unknown } | undefined;
          if (blockIsText && delta?.type === "text_delta" && typeof delta.text === "string") acc.text += delta.text;
        } else if (type === "content_block_stop") {
          blockIsText = false;
        } else if (type === "message_delta") {
          const delta = event["delta"] as { stop_reason?: unknown } | undefined;
          if (typeof delta?.stop_reason === "string") acc.stopReason = delta.stop_reason;
          const details = (event["delta"] as { stop_details?: { category?: unknown } } | undefined)?.stop_details;
          if (typeof details?.category === "string") acc.refusal = details.category;
          // The FINAL usage lands here, not on message_start: that opening
          // event carries zeros for input_tokens on the real API and through a
          // proxy alike (measured 2026-08-28 against opencodex: message_start
          // said input_tokens 0, message_delta said 37). Reading only
          // output_tokens here threw away the input count and, worse,
          // cache_read_input_tokens - the one number that says whether prompt
          // caching is working at all. Later values win field by field.
          const usage = event["usage"] as Record<string, unknown> | undefined;
          if (usage !== undefined) acc.usage = mergeUsage(acc.usage, usage);
        } else if (type === "message_start") {
          const usage = (event["message"] as { usage?: Record<string, unknown> } | undefined)?.usage;
          if (usage !== undefined) acc.usage = mergeUsage(acc.usage, usage);
        } else if (type === "error") {
          const error = event["error"] as { message?: unknown; type?: unknown } | undefined;
          throw classifyApiError(response.status, String(error?.message ?? "stream error"));
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* the stream is already torn down */
    }
  }
  return acc;
}

/**
 * Fold one envelope's usage into what is known so far. A field is taken only
 * when the envelope actually reports it, so a later event's zeros for fields
 * it does not carry cannot erase an earlier real count.
 */
function mergeUsage(current: JudgeUsage | undefined, reported: Record<string, unknown>): JudgeUsage {
  const merged: JudgeUsage = current ?? { inputTokens: 0, outputTokens: 0 };
  const take = (key: string): number | undefined => {
    const value = reported[key];
    return typeof value === "number" ? value : undefined;
  };
  const input = take("input_tokens");
  const output = take("output_tokens");
  const cached = take("cache_read_input_tokens");
  return {
    ...merged,
    ...(input !== undefined && input > 0 ? { inputTokens: input } : {}),
    ...(output !== undefined && output > 0 ? { outputTokens: output } : {}),
    ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
  };
}

function classifyApiError(status: number, detail: string): JudgeError {
  if (status === 401 || status === 403) return new JudgeError("judge-auth", "api", `Messages API rejected the credential (${status}): ${detail}`);
  if (status === 408 || status === 504) return new JudgeError("judge-timeout", "api", `Messages API timed out (${status}): ${detail}`);
  // 429 and 5xx are transient upstream conditions; they must reach the
  // caller's fallback path rather than be retried as a bad verdict.
  return new JudgeError("judge-auth-or-runtime", "api", `Messages API error (${status}): ${detail}`);
}

export class ApiBackend implements JudgeBackend {
  name = "api" as const;
  binary = "";
  /** Images ride as base64 content blocks; the wire format has a slot for them. */
  attachments = true;
  /** No tool loop by construction - that is the whole point of this backend. */
  agentic = false;

  available(): boolean {
    // Reachability is a per-call fact (a proxy may be down), so `available`
    // answers only "is this backend configured at all". A configured-but-dead
    // origin surfaces as a real error with its cause, not as a silent skip.
    return true;
  }

  async run(prompt: string, options: BackendRunOptions): Promise<BackendRunResult> {
    if (options.agentic === true) {
      throw new Error("the api backend cannot provide isolated read-only evidence access");
    }
    const baseUrl = baseUrlOf(options);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": ANTHROPIC_VERSION,
      ...authHeaders(baseUrl),
    };
    const content: unknown[] = [];
    for (const image of options.images ?? []) {
      const { readFileSync } = await import("node:fs");
      const ext = image.toLowerCase().endsWith(".jpg") || image.toLowerCase().endsWith(".jpeg") ? "jpeg" : "png";
      content.push({
        type: "image",
        source: { type: "base64", media_type: `image/${ext}`, data: readFileSync(image).toString("base64") },
      });
    }
    content.push({ type: "text", text: NO_TOOLS_PREAMBLE + prompt });

    const body = {
      model: options.model ?? "claude-opus-5",
      max_tokens: MAX_TOKENS,
      stream: true,
      // Adaptive thinking with an effort ceiling is the current contract:
      // budget_tokens is rejected outright on the models this targets.
      thinking: { type: "adaptive" },
      ...(options.effort !== undefined ? { output_config: { effort: options.effort } } : {}),
      messages: [{ role: "user", content }],
    };

    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), options.timeoutMs);
    deadline.unref?.();
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(deadline);
      if (controller.signal.aborted) {
        throw new JudgeError("judge-timeout", "api", `Messages API call exceeded ${options.timeoutMs}ms`);
      }
      throw new JudgeError("judge-auth-or-runtime", "api", `Messages API unreachable at ${baseUrl}: ${String((error as Error).message ?? error)}`);
    }

    try {
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw classifyApiError(response.status, detail.slice(0, 300));
      }
      const acc = await consumeStream(response, Math.min(STALL_MS, options.timeoutMs));
      const advisories: JudgeAdvisory[] = [];
      if (acc.stopReason === "refusal") {
        throw new JudgeError("judge-invalid-output", "api", `judge declined the request (${acc.refusal ?? "unspecified"})`, "empty-response");
      }
      if (acc.stopReason === "max_tokens") {
        // A truncated verdict usually fails JSON extraction anyway; naming the
        // real cause here stops the retry from chasing a phantom schema bug.
        advisories.push({ code: "judge-backend-advisory", backend: "api", message: `verdict hit the ${MAX_TOKENS}-token ceiling and may be incomplete` });
      }
      if (acc.text.trim() === "") {
        throw new JudgeError("judge-invalid-output", "api", "Messages API returned no text content", "empty-response");
      }
      return {
        text: acc.text,
        ...(acc.usage !== undefined ? { usage: acc.usage } : {}),
        ...(advisories.length > 0 ? { advisories } : {}),
        activity: { commands: [], toolRounds: 1 },
      };
    } finally {
      clearTimeout(deadline);
    }
  }
}
