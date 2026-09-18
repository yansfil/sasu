#!/usr/bin/env node

// Observer Stop hook: confirms a handover to the supervisor tick (D-10).
//
// Registered for Claude Code and Codex by the installer. It reads the Stop
// payload from stdin, exits 0 on every path, never prints a decision, and
// asks launchd to run a tick now only when this session is the recorded
// Observer of an indexed run. Everything it decides lives in
// cli/src/supervisor/stop-hook.ts so it can be tested without a hook runtime.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readStdin() {
  try { return fs.readFileSync(0, "utf8"); } catch { return ""; }
}

async function main() {
  let payload = {};
  try { payload = JSON.parse(readStdin() || "{}"); } catch { payload = {}; }
  const [{ handleStop }, { launchAgentSpec }, { hookLogPath }, { appendLog }] = await Promise.all([
    import(path.join(repoRoot, "cli", "dist", "supervisor", "stop-hook.js")),
    import(path.join(repoRoot, "cli", "dist", "supervisor", "commands.js")),
    import(path.join(repoRoot, "cli", "dist", "supervisor", "paths.js")),
    import(path.join(repoRoot, "cli", "dist", "supervisor", "tick.js")),
  ]);
  const outcome = handleStop(payload, { spec: launchAgentSpec() });
  appendLog(hookLogPath(), { event: "supervisor.stop-hook", at: new Date().toISOString(), ...outcome });
}

main().catch(() => {
  // A hook that fails must not fail the session; the log line above is the
  // only place a failure is meant to land, and a failure to log is silent.
}).finally(() => { process.exitCode = 0; });
