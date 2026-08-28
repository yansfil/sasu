// Command-audit abort regression. The isolated codex judge used to run to
// completion before its JSONL command trace was checked, so one disallowed
// command discarded the whole call AFTER paying for it: the 2026-08-27
// crawler-arena design lane burned 565s and 646s that way, and the
// replacement judge then needed 89s and 2s. The audit now streams, and the
// first violating command kills the call.
//
// Two things must hold together, which is why this drives a real process
// rather than the pure auditor: the call must end long before the judge would
// have, and the kill must surface as the audit's own judge-invalid-output
// reason, never as the judge-timeout its SIGTERM would otherwise look like.
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

const HANG_SECONDS = 10;
const TIMEOUT_MS = 8000;

/**
 * Traced commands contain single quotes, so the trace goes to a file and the
 * fake binary cats it. Inlining it into the shell script would silently
 * rewrite the command the audit is supposed to see.
 */
function writeFakeCodex(binDir, command, { hang = false } = {}) {
  const tracePath = path.join(binDir, "trace.jsonl");
  fs.writeFileSync(tracePath, `${JSON.stringify({ type: "item.completed", item: { type: "command_execution", command } })}\n`);
  const verdictPath = path.join(binDir, "verdict.json");
  fs.writeFileSync(verdictPath, '{"verdict":"PASS","findings":[]}');
  const tail = hang
    ? `/bin/sleep ${HANG_SECONDS}\n`
    : 'last=""\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "--output-last-message" ]; then last="$2"; shift 2; else shift; fi\ndone\ncat ' +
      JSON.stringify(verdictPath) + ' > "$last"\n';
  const fake = path.join(binDir, "codex");
  fs.writeFileSync(fake, `#!/bin/sh\ncat ${JSON.stringify(tracePath)}\n${tail}`);
  fs.chmodSync(fake, 0o755);
}

function withCodexOnly(binDir, fn) {
  const previousBackend = process.env.SASU_JUDGE_BACKEND;
  const previousPath = process.env.PATH;
  // Only the fake codex is reachable, so no fallback can mask the contract.
  process.env.SASU_JUDGE_BACKEND = "codex";
  process.env.PATH = `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previousBackend === undefined) delete process.env.SASU_JUDGE_BACKEND;
      else process.env.SASU_JUDGE_BACKEND = previousBackend;
      process.env.PATH = previousPath;
    });
}

test("a disallowed judge command kills the call instead of being audited after it", { skip: !fs.existsSync(runnerPath) && "cli/dist not built" }, async () => {
  const { runJudge, resetJudgeHealth } = require(runnerPath);
  const { loadConfig } = require(configPath);
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-fakebin-"));
  // Emits one violating trace line, then hangs. Nothing but the streaming
  // audit can end this call before the timeout.
  writeFakeCodex(binDir, "/bin/zsh -lc 'cat /etc/passwd'", { hang: true });
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-proj-"));
  const config = loadConfig(project);
  config.judge.timeoutMs = TIMEOUT_MS;
  resetJudgeHealth();
  try {
    await withCodexOnly(binDir, async () => {
      const startedAt = Date.now();
      await assert.rejects(
        () => runJudge(config, "regression:command-audit", "routine", "prompt", () => "never valid", {
          agentic: true,
          cwd: project,
          evidencePaths: [],
        }),
        (error) => {
          assert.equal(error.code, "judge-invalid-output", `SIGTERM must not be reported as a timeout (got ${error.code})`);
          assert.equal(error.reason, "non-read-command");
          assert.match(error.detail, /cat \/etc\/passwd/);
          return true;
        },
      );
      const elapsed = Date.now() - startedAt;
      // One retry is allowed inside runJudge, so the budget is two aborted
      // calls - still far below one hung judge, let alone one timeout.
      assert.ok(elapsed < HANG_SECONDS * 1000, `audit must end the call before the judge does; took ${elapsed}ms`);
    });
  } finally {
    resetJudgeHealth();
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("an allowed judge command is not aborted by the streaming audit", { skip: !fs.existsSync(runnerPath) && "cli/dist not built" }, async () => {
  const { runJudge, resetJudgeHealth } = require(runnerPath);
  const { loadConfig } = require(configPath);
  const { validateGapVerdict } = require(typesPath);
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-fakebin-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-proj-"));
  fs.writeFileSync(path.join(project, "evidence.md"), "fixture evidence\n");
  writeFakeCodex(binDir, "sed -n '1,10p' evidence.md");
  const config = loadConfig(project);
  config.judge.timeoutMs = TIMEOUT_MS;
  resetJudgeHealth();
  try {
    await withCodexOnly(binDir, async () => {
      const outcome = await runJudge(config, "regression:command-audit-clean", "routine", "prompt", validateGapVerdict, {
        agentic: true,
        cwd: project,
        evidencePaths: ["evidence.md"],
      });
      assert.equal(outcome.record.outcome, "ok");
      assert.equal(outcome.record.attempts, 1);
      assert.deepEqual(outcome.record.activity?.commands, ["sed -n '1,10p' evidence.md"]);
    });
  } finally {
    resetJudgeHealth();
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("a judge binary that traps SIGTERM is still killed within the escalation grace", { skip: !fs.existsSync(runnerPath) && "cli/dist not built" }, async () => {
  const { runJudge, resetJudgeHealth } = require(runnerPath);
  const { loadConfig } = require(configPath);
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-fakebin-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-proj-"));
  // Emits one violating trace line, traps SIGTERM, and sleeps far past the
  // timeout. Only the SIGKILL escalation can end this call.
  const tracePath = path.join(binDir, "trace.jsonl");
  fs.writeFileSync(tracePath, `${JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "/bin/zsh -lc 'cat /etc/passwd'" } })}\n`);
  const fake = path.join(binDir, "codex");
  fs.writeFileSync(fake, `#!/bin/sh\ntrap '' TERM\ncat ${JSON.stringify(tracePath)}\n/bin/sleep 60\n`);
  fs.chmodSync(fake, 0o755);
  const config = loadConfig(project);
  config.judge.timeoutMs = TIMEOUT_MS;
  resetJudgeHealth();
  try {
    await withCodexOnly(binDir, async () => {
      const startedAt = Date.now();
      await assert.rejects(
        () => runJudge(config, "regression:sigkill-escalation", "routine", "prompt", () => "never valid", {
          agentic: true,
          cwd: project,
          evidencePaths: [],
        }),
        (error) => {
          assert.equal(error.code, "judge-invalid-output");
          assert.equal(error.reason, "non-read-command");
          return true;
        },
      );
      const elapsed = Date.now() - startedAt;
      // Two aborted attempts, each SIGTERM + 2s SIGKILL grace, plus overhead.
      // A trapped SIGTERM without escalation would sit the full 60s sleep.
      assert.ok(elapsed < 15_000, `SIGKILL escalation must end a TERM-trapping judge; took ${elapsed}ms`);
    });
  } finally {
    resetJudgeHealth();
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("exceeding the agentic read budget aborts the call with its own reason", { skip: !fs.existsSync(runnerPath) && "cli/dist not built" }, async () => {
  const { runJudge, resetJudgeHealth } = require(runnerPath);
  const { loadConfig } = require(configPath);
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-fakebin-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-proj-"));
  fs.writeFileSync(path.join(project, "evidence.md"), "fixture evidence\n");
  // 17 individually allowed reads: one past AGENTIC_READ_MAX_ROUNDS (16).
  // Every command passes the allowlist, so only the budget can abort this.
  const tracePath = path.join(binDir, "trace.jsonl");
  const line = JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "sed -n '1,10p' evidence.md", aggregated_output: "fixture evidence\n" } });
  fs.writeFileSync(tracePath, Array.from({ length: 17 }, () => line).join("\n") + "\n");
  const fake = path.join(binDir, "codex");
  fs.writeFileSync(fake, `#!/bin/sh\ncat ${JSON.stringify(tracePath)}\n/bin/sleep ${HANG_SECONDS}\n`);
  fs.chmodSync(fake, 0o755);
  const config = loadConfig(project);
  config.judge.timeoutMs = TIMEOUT_MS;
  resetJudgeHealth();
  try {
    await withCodexOnly(binDir, async () => {
      const startedAt = Date.now();
      await assert.rejects(
        () => runJudge(config, "regression:read-budget", "routine", "prompt", () => "never valid", {
          agentic: true,
          cwd: project,
          evidencePaths: ["evidence.md"],
        }),
        (error) => {
          assert.equal(error.code, "judge-invalid-output");
          assert.equal(error.reason, "read-budget-exceeded", `expected the budget to abort, got ${error.reason}: ${error.detail}`);
          assert.match(error.detail, /17 read rounds/);
          return true;
        },
      );
      assert.ok(Date.now() - startedAt < HANG_SECONDS * 1000, "the budget abort must not wait for the judge");
    });
  } finally {
    resetJudgeHealth();
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("a newline-less flood aborts the call as unauditable instead of blinding the audit", { skip: !fs.existsSync(runnerPath) && "cli/dist not built" }, async () => {
  const { runJudge, resetJudgeHealth } = require(runnerPath);
  const { loadConfig } = require(configPath);
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-fakebin-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-proj-"));
  // 2MB with no newline trips the pending-line cap. The call must fail
  // closed there: an audited call whose trace cannot be attested is void,
  // and dropping the line instead would blind both the allowlist and the
  // read budget to whatever it carried.
  const floodPath = path.join(binDir, "flood.bin");
  fs.writeFileSync(floodPath, "x".repeat(2 * 1024 * 1024));
  const tracePath = path.join(binDir, "trace.jsonl");
  fs.writeFileSync(tracePath, `\n${JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "/bin/zsh -lc 'cat /etc/passwd'" } })}\n`);
  const fake = path.join(binDir, "codex");
  fs.writeFileSync(fake, `#!/bin/sh\ncat ${JSON.stringify(floodPath)}\ncat ${JSON.stringify(tracePath)}\n/bin/sleep ${HANG_SECONDS}\n`);
  fs.chmodSync(fake, 0o755);
  const config = loadConfig(project);
  config.judge.timeoutMs = TIMEOUT_MS;
  resetJudgeHealth();
  try {
    await withCodexOnly(binDir, async () => {
      await assert.rejects(
        () => runJudge(config, "regression:pending-line-cap", "routine", "prompt", () => "never valid", {
          agentic: true,
          cwd: project,
          evidencePaths: [],
        }),
        (error) => {
          assert.equal(error.code, "judge-invalid-output");
          assert.equal(error.reason, "unauditable-trace", `expected fail-closed on the oversized line, got ${error.reason}`);
          return true;
        },
      );
    });
  } finally {
    resetJudgeHealth();
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("a single oversized read event cannot evade the read budget", { skip: !fs.existsSync(runnerPath) && "cli/dist not built" }, async () => {
  const { runJudge, resetJudgeHealth } = require(runnerPath);
  const { loadConfig } = require(configPath);
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-fakebin-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-proj-"));
  fs.writeFileSync(path.join(project, "evidence.md"), "fixture evidence\n");
  // Adversarial probe 2026-08-28: one allowlisted command whose
  // aggregated_output makes the trace line >1MB used to be dropped unparsed
  // by the pending-line cap - counted toward neither the round budget nor the
  // char budget, completing clean. It must fail closed instead.
  const tracePath = path.join(binDir, "trace.jsonl");
  fs.writeFileSync(tracePath, `${JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "sed -n '1,10p' evidence.md", aggregated_output: "x".repeat(2 * 1024 * 1024) } })}\n`);
  const verdictPath = path.join(binDir, "verdict.json");
  fs.writeFileSync(verdictPath, '{"verdict":"PASS","findings":[]}');
  const fake = path.join(binDir, "codex");
  fs.writeFileSync(fake, `#!/bin/sh\ncat ${JSON.stringify(tracePath)}\nlast=""\nprev=""\nfor arg in "$@"; do\n  if [ "$prev" = "--output-last-message" ]; then last="$arg"; fi\n  prev="$arg"\ndone\ncat ${JSON.stringify(verdictPath)} > "$last"\n`);
  fs.chmodSync(fake, 0o755);
  const config = loadConfig(project);
  config.judge.timeoutMs = TIMEOUT_MS;
  resetJudgeHealth();
  try {
    await withCodexOnly(binDir, async () => {
      await assert.rejects(
        () => runJudge(config, "regression:budget-evasion", "routine", "prompt", () => "never valid", {
          agentic: true,
          cwd: project,
          evidencePaths: ["evidence.md"],
        }),
        (error) => {
          assert.equal(error.code, "judge-invalid-output");
          assert.equal(error.reason, "unauditable-trace", `the oversized event must fail closed, got ${error.reason}: ${error.detail}`);
          return true;
        },
      );
    });
  } finally {
    resetJudgeHealth();
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("an agentic claude judge that over-reads is rejected by the post-hoc round budget", { skip: !fs.existsSync(runnerPath) && "cli/dist not built" }, async () => {
  const { runJudge, resetJudgeHealth } = require(runnerPath);
  const { loadConfig } = require(configPath);
  const { validateGapVerdict } = require(typesPath);
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-fakebin-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-proj-"));
  fs.writeFileSync(path.join(project, "evidence.md"), "fixture evidence\n");
  // Claude has no streaming trace; num_turns is the only read signal its
  // surface admits. 25 turns = 24 tool rounds, past the 16-round budget. A
  // budget living only on the codex stream would route exactly the
  // over-reading calls to this unbounded path.
  const envelope = JSON.stringify({ result: JSON.stringify({ verdict: "PASS", findings: [] }), num_turns: 25 });
  fs.writeFileSync(path.join(binDir, "claude"), `#!/bin/sh\nprintf '%s' '${envelope.replace(/'/g, "'\\''")}'\n`);
  fs.chmodSync(path.join(binDir, "claude"), 0o755);
  const config = loadConfig(project);
  config.judge.timeoutMs = TIMEOUT_MS;
  // Claude primary with NO fallback, declared in config rather than via a
  // PATH game: the node dir on PATH can carry a real codex (the hermes node
  // does), and a reachable fallback would mask the rejection under its own
  // failure.
  config.judge.profiles.routine = { primary: { backend: "claude", model: null, effort: "xhigh" }, fallback: null };
  const previousBackend = process.env.SASU_JUDGE_BACKEND;
  const previousPath = process.env.PATH;
  delete process.env.SASU_JUDGE_BACKEND;
  process.env.PATH = `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
  resetJudgeHealth();
  try {
    await assert.rejects(
      () => runJudge(config, "regression:claude-read-budget", "routine", "prompt", validateGapVerdict, {
        agentic: true,
        cwd: project,
        evidencePaths: ["evidence.md"],
      }),
      (error) => {
        assert.equal(error.code, "judge-invalid-output");
        assert.equal(error.reason, "read-budget-exceeded", `expected the post-hoc budget, got ${error.reason}: ${error.detail}`);
        assert.match(error.detail, /24 tool rounds/);
        return true;
      },
    );
  } finally {
    if (previousBackend === undefined) delete process.env.SASU_JUDGE_BACKEND;
    else process.env.SASU_JUDGE_BACKEND = previousBackend;
    process.env.PATH = previousPath;
    resetJudgeHealth();
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});
