// Per-call judge timeout regression (PRD judge-fanout D-13/AC4): the async
// parallel refactor of the checkshirt judge runner must keep enforcing
// judge.timeoutMs on every individual call. A judge binary that hangs past
// the timeout must surface as a typed judge-timeout error, quickly.
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

test("checkshirt judge calls time out per call after the async refactor", { skip: !fs.existsSync(runnerPath) && "cli/dist not built" }, async () => {
  const { runJudge } = require(runnerPath);
  const { loadConfig } = require(configPath);
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "checkshirt-fakebin-"));
  const fakeClaude = path.join(binDir, "claude");
  fs.writeFileSync(fakeClaude, "#!/bin/sh\n/bin/sleep 5\n");
  fs.chmodSync(fakeClaude, 0o755);
  const emptyProject = fs.mkdtempSync(path.join(os.tmpdir(), "checkshirt-proj-"));
  const config = loadConfig(emptyProject);
  config.judge.timeoutMs = 300;

  const previousBackend = process.env.CHECKSHIRT_JUDGE_BACKEND;
  const previousPath = process.env.PATH;
  process.env.CHECKSHIRT_JUDGE_BACKEND = "claude";
  process.env.PATH = `${binDir}:${path.dirname(process.execPath)}`;
  try {
    const startedAt = Date.now();
    await assert.rejects(
      () => runJudge(config, "regression:timeout", "frugal", "prompt", () => "never valid"),
      (error) => error.code === "judge-timeout",
    );
    assert.ok(Date.now() - startedAt < 4000, "timeout must fire well before the hung binary exits");
  } finally {
    if (previousBackend === undefined) delete process.env.CHECKSHIRT_JUDGE_BACKEND;
    else process.env.CHECKSHIRT_JUDGE_BACKEND = previousBackend;
    process.env.PATH = previousPath;
  }
});
