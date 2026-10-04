// Runs below the real pane provider. Native Herdr identity is inherited,
// never supplied by the test coordinator or copied from another pane.
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const request = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const env = { ...process.env, ...(request.env || {}) };
for (const key of Object.keys(request.env || {})) if (/^(HERDR_|HIDE_CAP_REF|CLAUDE_SESSION_ID|CLAUDE_CODE_SESSION_ID)/.test(key)) throw new Error("native caller identity cannot be overridden");
const run = spawnSync(request.binary, request.argv, { cwd: request.cwd, input: request.input, env, encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 });
const response = { status: run.status, signal: run.signal, stdout: run.stdout || "", stderr: run.stderr || "", error: run.error?.message || null };
fs.writeFileSync(`${request.response}.pending`, JSON.stringify(response));
fs.renameSync(`${request.response}.pending`, request.response);
process.exit(run.status === 0 ? 0 : 1);
