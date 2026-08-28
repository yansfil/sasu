import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { ApiBackend } from "../../dist/judge/api-backend.js";

/**
 * The api backend talks to a real socket in every test below. A mocked fetch
 * would prove the code calls itself correctly and nothing about the wire: SSE
 * framing, chunk boundaries, and HTTP status handling are exactly where this
 * backend can be wrong, so the tests exercise an actual server.
 */
async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function sse(res, events) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
}

const VERDICT = '{"verdict":"PASS","findings":[]}';

const textStream = (text) => [
  { type: "message_start", message: { usage: { input_tokens: 1200, output_tokens: 0, cache_read_input_tokens: 900 } } },
  { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "deliberating about the verdict" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "text" } },
  ...[...text].map((ch) => ({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: ch } })),
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42 } },
  { type: "message_stop" },
];

test("accumulates text deltas into the verdict and never mixes in thinking", async () => {
  const result = await withServer((req, res) => sse(res, textStream(VERDICT)), (baseUrl) =>
    new ApiBackend().run("judge this", { model: "claude-opus-5", timeoutMs: 10_000, baseUrl }));
  assert.equal(result.text, VERDICT);
  assert.doesNotMatch(result.text, /deliberating/);
});

test("records the provider's reported usage including cache reads", async () => {
  const result = await withServer((req, res) => sse(res, textStream(VERDICT)), (baseUrl) =>
    new ApiBackend().run("judge this", { model: "claude-opus-5", timeoutMs: 10_000, baseUrl }));
  assert.equal(result.usage.inputTokens, 1200);
  assert.equal(result.usage.cachedInputTokens, 900);
  assert.equal(result.usage.outputTokens, 42);
});

test("sends the effort ceiling and adaptive thinking, never a token budget", async () => {
  let body;
  await withServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => { body = JSON.parse(raw); sse(res, textStream(VERDICT)); });
  }, (baseUrl) => new ApiBackend().run("judge this", { model: "claude-opus-5", effort: "medium", timeoutMs: 10_000, baseUrl }));
  assert.equal(body.output_config.effort, "medium");
  assert.equal(body.thinking.type, "adaptive");
  // budget_tokens is rejected outright by the models this backend targets.
  assert.equal(body.thinking.budget_tokens, undefined);
  assert.equal(body.stream, true);
});

test("a loopback origin needs no credential, so a local proxy can own the upstream one", async () => {
  const saved = { key: process.env.ANTHROPIC_API_KEY, token: process.env.ANTHROPIC_AUTH_TOKEN };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  try {
    let headers;
    const result = await withServer((req, res) => { headers = req.headers; sse(res, textStream(VERDICT)); },
      (baseUrl) => new ApiBackend().run("judge this", { model: "claude-opus-5", timeoutMs: 10_000, baseUrl }));
    assert.equal(result.text, VERDICT);
    assert.equal(headers["x-api-key"], undefined);
    assert.equal(headers.authorization, undefined);
  } finally {
    if (saved.key !== undefined) process.env.ANTHROPIC_API_KEY = saved.key;
    if (saved.token !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = saved.token;
  }
});

test("a remote origin without any credential fails as judge-auth before dialling", async () => {
  const saved = { key: process.env.ANTHROPIC_API_KEY, token: process.env.ANTHROPIC_AUTH_TOKEN };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  try {
    await assert.rejects(
      () => new ApiBackend().run("judge this", { model: "claude-opus-5", timeoutMs: 10_000, baseUrl: "https://api.anthropic.com" }),
      (error) => error.code === "judge-auth",
    );
  } finally {
    if (saved.key !== undefined) process.env.ANTHROPIC_API_KEY = saved.key;
    if (saved.token !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = saved.token;
  }
});

test("401 is an auth failure and 429 is a runtime failure, so only the latter is a fallback-worthy blip", async () => {
  for (const [status, code] of [[401, "judge-auth"], [403, "judge-auth"], [429, "judge-auth-or-runtime"], [500, "judge-auth-or-runtime"]]) {
    await withServer((req, res) => { res.writeHead(status, { "content-type": "application/json" }); res.end('{"error":{"message":"nope"}}'); },
      async (baseUrl) => {
        await assert.rejects(
          () => new ApiBackend().run("judge this", { model: "claude-opus-5", timeoutMs: 10_000, baseUrl }),
          (error) => {
            assert.equal(error.code, code, `status ${status} must classify as ${code}`);
            return true;
          },
        );
      });
  }
});

test("a refusal is a judge failure, not an empty verdict silently accepted", async () => {
  await withServer((req, res) => sse(res, [
    { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: "message_delta", delta: { stop_reason: "refusal", stop_details: { category: "cyber" } } },
    { type: "message_stop" },
  ]), async (baseUrl) => {
    await assert.rejects(
      () => new ApiBackend().run("judge this", { model: "claude-opus-5", timeoutMs: 10_000, baseUrl }),
      (error) => error.code === "judge-invalid-output",
    );
  });
});

test("an SSE event split across chunk boundaries is still parsed", async () => {
  const events = textStream(VERDICT);
  const payload = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const result = await withServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    // Deliberately cut mid-event: a framing bug hides when every write is a
    // whole event, which is not how a real socket delivers them.
    for (let i = 0; i < payload.length; i += 7) res.write(payload.slice(i, i + 7));
    res.end();
  }, (baseUrl) => new ApiBackend().run("judge this", { model: "claude-opus-5", timeoutMs: 10_000, baseUrl }));
  assert.equal(result.text, VERDICT);
});

test("the request deadline aborts a server that never answers", async () => {
  await withServer((req, res) => { /* hang forever */ }, async (baseUrl) => {
    await assert.rejects(
      () => new ApiBackend().run("judge this", { model: "claude-opus-5", timeoutMs: 300, baseUrl }),
      (error) => error.code === "judge-timeout",
    );
  });
});

test("the backend refuses agentic evidence access rather than judging without it", async () => {
  await assert.rejects(
    () => new ApiBackend().run("judge this", { model: "claude-opus-5", timeoutMs: 10_000, baseUrl: "http://127.0.0.1:1", agentic: true }),
    /cannot provide isolated read-only evidence access/,
  );
});
