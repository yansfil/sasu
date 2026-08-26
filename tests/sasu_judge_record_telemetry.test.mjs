// Judge-record telemetry regression. The 2026-08-27 crawler-arena
// investigation had to rebuild a 575s judge call with a hand-written probe
// because state.json could not answer "where did the time go": the backends
// were already emitting token usage and the retry reason lived only in the
// in-memory preamble. Both now land on the persisted record.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const require = createRequire(import.meta.url);
const runnerPath = path.join(repoRoot, "cli", "dist", "judge", "runner.js");
const configPath = path.join(repoRoot, "cli", "dist", "config.js");
const typesPath = path.join(repoRoot, "cli", "dist", "judge", "types.js");

function withBackend(binDir, backend, fn) {
  const previousBackend = process.env.SASU_JUDGE_BACKEND;
  const previousPath = process.env.PATH;
  process.env.SASU_JUDGE_BACKEND = backend;
  process.env.PATH = `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previousBackend === undefined) delete process.env.SASU_JUDGE_BACKEND;
      else process.env.SASU_JUDGE_BACKEND = previousBackend;
      process.env.PATH = previousPath;
    });
}

test("a codex judge call records provider usage and every rejected attempt", { skip: !fs.existsSync(runnerPath) && "cli/dist not built" }, async () => {
  const { runJudge, resetJudgeHealth } = require(runnerPath);
  const { loadConfig } = require(configPath);
  const { validateGapVerdict } = require(typesPath);
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-fakebin-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-proj-"));
  const goodVerdict = path.join(binDir, "verdict.json");
  fs.writeFileSync(goodVerdict, '{"verdict":"PASS","findings":[]}');
  const usageLine = path.join(binDir, "usage.jsonl");
  fs.writeFileSync(usageLine, `${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 42124, cached_input_tokens: 8960, output_tokens: 163, reasoning_output_tokens: 110 } })}\n`);
  const cursor = path.join(binDir, "cursor");
  // Call 1 answers prose (no JSON object): rejected as missing-json and
  // retried. Call 2 answers the contract. Both calls emit a turn.completed
  // usage event on stdout, the way codex --json does.
  fs.writeFileSync(path.join(binDir, "codex"), `#!/bin/sh
last=""
prompt=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then last="$arg"; fi
  prev="$arg"
  prompt="$arg"
done
case "$prompt" in
  *"Reply with exactly: OK"*)
    printf '%s' OK > "$last"
    printf '%s\\n' '{"type":"turn.completed","usage":{}}'
    exit 0
  ;;
esac
n=$(cat ${JSON.stringify(cursor)} 2>/dev/null || echo 0)
n=$((n+1))
echo "$n" > ${JSON.stringify(cursor)}
cat ${JSON.stringify(usageLine)}
if [ "$n" = 1 ]; then printf 'I cannot decide.' > "$last"; else cat ${JSON.stringify(goodVerdict)} > "$last"; fi
`);
  fs.chmodSync(path.join(binDir, "codex"), 0o755);
  const config = loadConfig(project);
  config.judge.timeoutMs = 8000;
  resetJudgeHealth();
  try {
    await withBackend(binDir, "codex", async () => {
      const outcome = await runJudge(config, "regression:telemetry:codex", "routine", "prompt", validateGapVerdict);
      assert.equal(outcome.record.attempts, 2);
      assert.deepEqual(outcome.record.usage, {
        inputTokens: 42124,
        cachedInputTokens: 8960,
        outputTokens: 163,
        reasoningOutputTokens: 110,
      }, "the answering attempt's provider usage must be recorded verbatim");
      assert.equal(outcome.record.retries.length, 1, "one rejected attempt must leave one retry entry");
      const retry = outcome.record.retries[0];
      assert.equal(retry.backend, "codex");
      assert.equal(retry.code, "judge-invalid-output");
      assert.equal(retry.reason, "missing-json");
      assert.ok(retry.durationMs >= 0);
      assert.ok(retry.detail.length <= 300, "the persisted detail must stay bounded");
    });
  } finally {
    resetJudgeHealth();
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("a claude judge call records envelope usage, and a clean call records no retries", { skip: !fs.existsSync(runnerPath) && "cli/dist not built" }, async () => {
  const { runJudge, resetJudgeHealth } = require(runnerPath);
  const { loadConfig } = require(configPath);
  const { validateGapVerdict } = require(typesPath);
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-fakebin-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-proj-"));
  const envelope = JSON.stringify({
    result: JSON.stringify({ verdict: "PASS", findings: [] }),
    num_turns: 1,
    usage: { input_tokens: 1200, output_tokens: 90, cache_read_input_tokens: 800 },
  });
  fs.writeFileSync(path.join(binDir, "claude"), `#!/bin/sh\nprintf '%s' '${envelope.replace(/'/g, "'\\''")}'\n`);
  fs.chmodSync(path.join(binDir, "claude"), 0o755);
  const config = loadConfig(project);
  config.judge.timeoutMs = 8000;
  resetJudgeHealth();
  try {
    await withBackend(binDir, "claude", async () => {
      const outcome = await runJudge(config, "regression:telemetry:claude", "routine", "prompt", validateGapVerdict);
      assert.equal(outcome.record.attempts, 1);
      assert.deepEqual(outcome.record.usage, { inputTokens: 1200, outputTokens: 90, cachedInputTokens: 800 });
      assert.equal(outcome.record.retries, undefined, "a clean call must not grow an empty retries field");
    });
  } finally {
    resetJudgeHealth();
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});
