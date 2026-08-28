// The api backend as runJudge sees it.
//
// cli/test/unit/api-backend.test.mjs proves the backend speaks the wire
// correctly in isolation. That is not the same claim as "a project configured
// with backend: api gets a verdict": profile selection, the diagnostic
// override, fallback routing, and record-keeping all sit between the config
// and the socket, and each of them had to learn the new backend exists.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const require = createRequire(import.meta.url);
const runnerPath = path.join(repoRoot, "cli", "dist", "judge", "runner.js");
const configPath = path.join(repoRoot, "cli", "dist", "config.js");
const typesPath = path.join(repoRoot, "cli", "dist", "judge", "types.js");
const built = fs.existsSync(runnerPath);

function verdictServer(onRequest) {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      onRequest?.(JSON.parse(raw), req.headers);
      const events = [
        { type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: '{"verdict":"PASS","findings":[]}' } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 12 } },
        { type: "message_stop" },
      ];
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
  });
  return server;
}

async function withServer(onRequest, run) {
  const server = verdictServer(onRequest);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function projectWith(judge) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-api-proj-"));
  fs.mkdirSync(path.join(project, "agents"), { recursive: true });
  fs.writeFileSync(path.join(project, "agents", "config.json"), JSON.stringify({ judge }));
  return project;
}

test("a project configured for backend api gets a verdict through runJudge", { skip: !built && "cli/dist not built" }, async () => {
  const { runJudge, resetJudgeHealth } = require(runnerPath);
  const { loadConfig } = require(configPath);
  const { validateGapVerdict } = require(typesPath);
  let seen;
  await withServer((body) => { seen = body; }, async (baseUrl) => {
    resetJudgeHealth();
    const project = projectWith({
      profiles: { routine: { primary: { backend: "api", model: "claude-opus-5", effort: "high", baseUrl }, fallback: null } },
    });
    const config = loadConfig(project);
    const outcome = await runJudge(config, "test:api", "routine", "judge this", (v) => validateGapVerdict(v, {}));
    assert.equal(outcome.value.verdict, "PASS");
    assert.equal(outcome.record.backend, "api");
    assert.equal(outcome.record.model, "claude-opus-5");
    assert.equal(outcome.record.effort, "high");
    assert.equal(outcome.record.usage.inputTokens, 100);
    assert.equal(seen.output_config.effort, "high", "the configured budget must reach the wire");
  });
});

test("a lane effort override reaches the api wire, not just the record", { skip: !built && "cli/dist not built" }, async () => {
  const { runJudge, resetJudgeHealth } = require(runnerPath);
  const { loadConfig } = require(configPath);
  const { validateGapVerdict } = require(typesPath);
  let seen;
  await withServer((body) => { seen = body; }, async (baseUrl) => {
    resetJudgeHealth();
    const project = projectWith({
      profiles: { routine: { primary: { backend: "api", model: "claude-opus-5", effort: "xhigh", baseUrl }, fallback: null } },
    });
    const outcome = await runJudge(loadConfig(project), "test:api", "routine", "judge this", (v) => validateGapVerdict(v, {}), { effort: "medium" });
    assert.equal(seen.output_config.effort, "medium");
    assert.equal(outcome.record.effort, "medium");
  });
});

test("an unreachable api primary falls back to the configured other backend", { skip: !built && "cli/dist not built" }, async () => {
  const { runJudge, resetJudgeHealth } = require(runnerPath);
  const { loadConfig } = require(configPath);
  const { validateGapVerdict } = require(typesPath);
  resetJudgeHealth();
  // The stub answers only from a file it is pointed at; without it the stub
  // reports itself unavailable and the fallback would be skipped for the wrong
  // reason, making this test pass or fail on the wrong mechanism.
  const stubFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sasu-api-stub-")), "verdict.json");
  fs.writeFileSync(stubFile, '{"verdict":"PASS","findings":[]}');
  process.env.SASU_JUDGE_STUB_FILE = stubFile;
  // Port 1 on loopback refuses instantly: a dead proxy must degrade to the
  // fallback backend rather than take the whole gate down with it.
  const project = projectWith({
    profiles: {
      routine: {
        primary: { backend: "api", model: "claude-opus-5", effort: "high", baseUrl: "http://127.0.0.1:1" },
        fallback: { backend: "stub", model: null, effort: "high" },
      },
    },
  });
  try {
    const outcome = await runJudge(loadConfig(project), "test:api", "routine", "judge this", (v) => validateGapVerdict(v, {}));
    assert.equal(outcome.record.backend, "stub", "the fallback must answer");
    assert.equal(outcome.record.fallback.backend, "api");
    assert.match(outcome.record.fallback.reason, /judge/i);
  } finally {
    delete process.env.SASU_JUDGE_STUB_FILE;
  }
});

test("SASU_JUDGE_BACKEND accepts every backend the config accepts", { skip: !built && "cli/dist not built" }, () => {
  const { effectiveJudgeProfile } = require(runnerPath);
  const { loadConfig, BACKENDS } = require(configPath);
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-api-proj-"));
  const config = loadConfig(project);
  const previous = process.env.SASU_JUDGE_BACKEND;
  try {
    for (const backend of BACKENDS) {
      process.env.SASU_JUDGE_BACKEND = backend;
      assert.equal(effectiveJudgeProfile(config, "routine").primary.backend, backend, `${backend} must be selectable`);
    }
    process.env.SASU_JUDGE_BACKEND = "gemini";
    assert.throws(() => effectiveJudgeProfile(config, "routine"), /SASU_JUDGE_BACKEND must be one of/);
  } finally {
    if (previous === undefined) delete process.env.SASU_JUDGE_BACKEND;
    else process.env.SASU_JUDGE_BACKEND = previous;
  }
});
