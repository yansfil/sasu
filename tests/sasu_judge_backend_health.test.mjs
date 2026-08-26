// Backend health ledger regression. On the 2026-08-27 crawler-arena run the
// design lane's Claude fallback answered "You've hit your weekly limit" - a
// fact every later judge call in that same run was free to rediscover at full
// latency. The process now remembers a backend that failed authentication or
// runtime, and later calls start on the healthy side instead of paying the
// dead one first.
//
// Scoped to the process on purpose. A rate limit resets on a wall clock the
// harness does not own, so persisting the verdict would outlive its truth.
//
// The two strike thresholds are the contract under test. `judge-auth` is
// definitionally not per-call state, so one is enough. `judge-auth-or-runtime`
// also covers an ordinary non-zero exit, which one bad prompt can produce, so
// it takes two independent calls before the backend itself is blamed - and
// classifyFailure only ever returns `judge-auth` for Claude, so a failing
// Codex always takes the two-strike path.
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

const SKIPPED = /^primary judge skipped: it already failed authentication( or runtime)? in this run$/;

function writeShell(file, body) {
  fs.writeFileSync(file, `#!/bin/sh\n${body}`);
  fs.chmodSync(file, 0o755);
}

// Every fake codex must speak the runner's protocol: answer the one-shot
// preflight canary with OK, and terminate real turns with turn.completed.
const CODEX_PREFLIGHT_PRELUDE = `last=""
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
`;

/** Records that it was asked, then answers. */
function writeAnsweringClaude(binDir, callLog) {
  writeShell(
    path.join(binDir, "claude"),
    `echo call >> ${JSON.stringify(callLog)}\nprintf '%s' '{"result":"{\\"verdict\\":\\"PASS\\",\\"findings\\":[]}"}'\n`,
  );
}

function writeAnsweringCodex(binDir, callLog) {
  const verdict = path.join(binDir, "verdict.json");
  fs.writeFileSync(verdict, '{"verdict":"PASS","findings":[]}');
  writeShell(
    path.join(binDir, "codex"),
    `${CODEX_PREFLIGHT_PRELUDE}echo call >> ${JSON.stringify(callLog)}\ncat ${JSON.stringify(verdict)} > "$last"\nprintf '%s\\n' '{"type":"turn.completed","usage":{}}'\n`,
  );
}

function callCount(callLog) {
  return fs.existsSync(callLog) ? fs.readFileSync(callLog, "utf8").split("\n").filter(Boolean).length : 0;
}

function withBins(binDir, backend, fn) {
  const previousBackend = process.env.SASU_JUDGE_BACKEND;
  const previousPath = process.env.PATH;
  if (backend === undefined) delete process.env.SASU_JUDGE_BACKEND;
  else process.env.SASU_JUDGE_BACKEND = backend;
  process.env.PATH = `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previousBackend === undefined) delete process.env.SASU_JUDGE_BACKEND;
      else process.env.SASU_JUDGE_BACKEND = previousBackend;
      process.env.PATH = previousPath;
    });
}

function fixture() {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-fakebin-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-proj-"));
  const { loadConfig } = require(configPath);
  const config = loadConfig(project);
  config.judge.timeoutMs = 8000;
  return { binDir, project, config, cleanup: () => {
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  } };
}

test("a judge backend that failed authentication is skipped by the next call in the same run", { skip: !fs.existsSync(runnerPath) && "cli/dist not built" }, async () => {
  const { runJudge, resetJudgeHealth } = require(runnerPath);
  const { validateGapVerdict } = require(typesPath);
  const { binDir, config, cleanup } = fixture();
  const claudeLog = path.join(binDir, "claude-calls.log");
  const codexLog = path.join(binDir, "codex-calls.log");
  // Claude primary, logged out; Codex fallback answers. classifyFailure maps
  // "Not logged in" to judge-auth, which is one strike and enough.
  writeShell(path.join(binDir, "claude"), `echo call >> ${JSON.stringify(claudeLog)}\nprintf '%s' '{"is_error":true,"result":"Not logged in. Please run /login."}'\n`);
  writeAnsweringCodex(binDir, codexLog);
  // Claude primary is declared in config: SASU_JUDGE_BACKEND is a diagnostic
  // pin that drops the fallback, and this scenario needs the fallback.
  const { routine } = config.judge.profiles;
  config.judge.profiles.routine = { primary: routine.fallback, fallback: routine.primary };
  resetJudgeHealth();
  try {
    await withBins(binDir, undefined, async () => {
      const first = await runJudge(config, "regression:health:auth-1", "routine", "prompt", validateGapVerdict);
      assert.equal(first.record.backend, "codex", "the first call must recover through the fallback");
      assert.equal(first.record.fallback.outcome, "judge-auth");
      assert.doesNotMatch(first.record.fallback.reason, SKIPPED, "the first call really did pay for the dead primary");
      assert.equal(callCount(claudeLog), 1);

      const second = await runJudge(config, "regression:health:auth-2", "routine", "prompt", validateGapVerdict);
      assert.equal(second.record.backend, "codex");
      assert.match(second.record.fallback.reason, SKIPPED, "one auth failure is enough to stop dialling the primary");
      assert.equal(second.record.fallback.durationMs, 0, "a skipped primary costs no wall clock");
      assert.equal(callCount(claudeLog), 1, "the dead primary must not be dialled again");
      assert.equal(callCount(codexLog), 2, "the healthy backend still answers every call");
    });
  } finally {
    resetJudgeHealth();
    cleanup();
  }
});

test("a judge backend that failed runtime is skipped only after a second independent call", { skip: !fs.existsSync(runnerPath) && "cli/dist not built" }, async () => {
  const { runJudge, resetJudgeHealth } = require(runnerPath);
  const { validateGapVerdict } = require(typesPath);
  const { binDir, config, cleanup } = fixture();
  const claudeLog = path.join(binDir, "claude-calls.log");
  const codexLog = path.join(binDir, "codex-calls.log");
  // Codex primary exits non-zero, which is never classified as auth. One bad
  // prompt can do that, so the backend is not blamed until it does it twice.
  writeShell(path.join(binDir, "codex"), `echo call >> ${JSON.stringify(codexLog)}\nexit 99\n`);
  writeAnsweringClaude(binDir, claudeLog);
  resetJudgeHealth();
  try {
    await withBins(binDir, undefined, async () => {
      for (const round of [1, 2]) {
        const outcome = await runJudge(config, `regression:health:runtime-${round}`, "routine", "prompt", validateGapVerdict);
        assert.equal(outcome.record.backend, "claude");
        assert.doesNotMatch(outcome.record.fallback.reason, SKIPPED, `round ${round} must still give the primary its chance`);
      }
      assert.equal(callCount(codexLog), 2, "two independent calls are what earns the verdict");

      const third = await runJudge(config, "regression:health:runtime-3", "routine", "prompt", validateGapVerdict);
      assert.match(third.record.fallback.reason, SKIPPED);
      assert.equal(callCount(codexLog), 2, "the third call must not dial the twice-failed primary");
      assert.equal(callCount(claudeLog), 3);
    });
  } finally {
    resetJudgeHealth();
    cleanup();
  }
});

test("a fallback known dead in this run is not dialled again to prove it", { skip: !fs.existsSync(runnerPath) && "cli/dist not built" }, async () => {
  const { runJudge, resetJudgeHealth } = require(runnerPath);
  const { validateGapVerdict } = require(typesPath);
  const { binDir, config, cleanup } = fixture();
  const claudeLog = path.join(binDir, "claude-calls.log");
  // Both sides dead: Codex primary exits non-zero, the Claude fallback is
  // rate limited exactly as it was on 2026-08-27.
  writeShell(path.join(binDir, "codex"), "exit 99\n");
  writeShell(
    path.join(binDir, "claude"),
    `echo call >> ${JSON.stringify(claudeLog)}\nprintf '%s' '{"is_error":true,"result":"You have hit your weekly limit"}'\nexit 1\n`,
  );
  resetJudgeHealth();
  try {
    await withBins(binDir, undefined, async () => {
      for (const round of [1, 2]) {
        await assert.rejects(() => runJudge(config, `regression:health:dead-${round}`, "routine", "prompt", validateGapVerdict));
      }
      assert.equal(callCount(claudeLog), 2, "the fallback must really have been tried twice");

      await assert.rejects(
        () => runJudge(config, "regression:health:dead-3", "routine", "prompt", validateGapVerdict),
        (error) => {
          // The primary's own error surfaces now, instead of after a second
          // full-latency call proves what this process already knows.
          assert.equal(error.backend, "codex");
          return true;
        },
      );
      assert.equal(callCount(claudeLog), 2, "a fallback known dead in this run must not be dialled again");
    });
  } finally {
    resetJudgeHealth();
    cleanup();
  }
});

test("a runtime failure on one codex model does not disable another codex model", { skip: !fs.existsSync(runnerPath) && "cli/dist not built" }, async () => {
  const { runJudge, resetJudgeHealth } = require(runnerPath);
  const { validateGapVerdict } = require(typesPath);
  const { binDir, config, cleanup } = fixture();
  const claudeLog = path.join(binDir, "claude-calls.log");
  const codexLog = path.join(binDir, "codex-calls.log");
  const verdict = path.join(binDir, "verdict.json");
  fs.writeFileSync(verdict, '{"verdict":"PASS","findings":[]}');
  const routineModel = config.judge.profiles.routine.primary.model;
  const highRiskModel = config.judge.profiles["high-risk"].primary.model;
  assert.notEqual(routineModel, highRiskModel, "the fixture depends on the two profiles naming different codex models");
  // Fails only for the routine model; the high-risk model answers. The strike
  // must land on backend+model, not the backend, or a routine misconfiguration
  // silently downgrades every high-risk judgment to the fallback vendor.
  writeShell(
    path.join(binDir, "codex"),
    `${CODEX_PREFLIGHT_PRELUDE}model=""\nprev=""\nfor arg in "$@"; do\n  if [ "$prev" = "--model" ]; then model="$arg"; fi\n  prev="$arg"\ndone\necho "$model" >> ${JSON.stringify(codexLog)}\nif [ "$model" = ${JSON.stringify(routineModel)} ]; then exit 99; fi\ncat ${JSON.stringify(verdict)} > "$last"\nprintf '%s\\n' '{"type":"turn.completed","usage":{}}'\n`,
  );
  writeAnsweringClaude(binDir, claudeLog);
  resetJudgeHealth();
  try {
    await withBins(binDir, undefined, async () => {
      for (const round of [1, 2]) {
        const outcome = await runJudge(config, `regression:health:model-scope-${round}`, "routine", "prompt", validateGapVerdict);
        assert.equal(outcome.record.backend, "claude", `round ${round} must recover through the fallback`);
      }
      const highRisk = await runJudge(config, "regression:health:model-scope-hr", "high-risk", "prompt", validateGapVerdict);
      assert.equal(highRisk.record.backend, "codex", "the high-risk model never failed and must still be dialled");
      assert.equal(highRisk.record.fallback, undefined, "no fallback record: the healthy model answered directly");
      const dialled = fs.readFileSync(codexLog, "utf8").split("\n").filter(Boolean);
      assert.deepEqual(dialled, [routineModel, routineModel, highRiskModel]);
    });
  } finally {
    resetJudgeHealth();
    cleanup();
  }
});

test("a success clears runtime strikes so a transient blip cannot condemn the backend", { skip: !fs.existsSync(runnerPath) && "cli/dist not built" }, async () => {
  const { runJudge, resetJudgeHealth } = require(runnerPath);
  const { validateGapVerdict } = require(typesPath);
  const { binDir, config, cleanup } = fixture();
  const codexLog = path.join(binDir, "codex-calls.log");
  const claudeLog = path.join(binDir, "claude-calls.log");
  const verdict = path.join(binDir, "verdict.json");
  fs.writeFileSync(verdict, '{"verdict":"PASS","findings":[]}');
  // Sequenced fake: fail, answer, fail, answer. Without the success reset,
  // calls 1 and 3 are two strikes and call 4 would skip a backend that is
  // demonstrably answering (fan-out makes such interleavings routine).
  const cursor = path.join(binDir, "cursor");
  writeShell(
    path.join(binDir, "codex"),
    `${CODEX_PREFLIGHT_PRELUDE}echo call >> ${JSON.stringify(codexLog)}\nn=$(cat ${JSON.stringify(cursor)} 2>/dev/null || echo 0)\nn=$((n+1))\necho "$n" > ${JSON.stringify(cursor)}\nif [ $((n % 2)) = 1 ]; then exit 99; fi\ncat ${JSON.stringify(verdict)} > "$last"\nprintf '%s\\n' '{"type":"turn.completed","usage":{}}'\n`,
  );
  writeAnsweringClaude(binDir, claudeLog);
  resetJudgeHealth();
  try {
    await withBins(binDir, undefined, async () => {
      // Calls 1 and 2: codex fails (strike), claude recovers.
      const first = await runJudge(config, "regression:health:reset-1", "routine", "prompt", validateGapVerdict);
      assert.equal(first.record.backend, "claude");
      // Call 2: codex answers (fake call 2 is even) - strike must clear.
      const second = await runJudge(config, "regression:health:reset-2", "routine", "prompt", validateGapVerdict);
      assert.equal(second.record.backend, "codex");
      // Call 3: codex fails again (one strike after the clear), claude recovers.
      const third = await runJudge(config, "regression:health:reset-3", "routine", "prompt", validateGapVerdict);
      assert.equal(third.record.backend, "claude");
      assert.doesNotMatch(third.record.fallback.reason, SKIPPED, "one strike after a success must still dial the primary");
      // Call 4: codex answers - never skipped along the way.
      const fourth = await runJudge(config, "regression:health:reset-4", "routine", "prompt", validateGapVerdict);
      assert.equal(fourth.record.backend, "codex");
      assert.equal(callCount(codexLog), 4, "the primary must be dialled on every call");
    });
  } finally {
    resetJudgeHealth();
    cleanup();
  }
});
