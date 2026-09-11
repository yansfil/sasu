// Build the CLI without ever leaving a broken dist behind.
//
// The global `sasu` shim execs this repository's cli/dist/cli.js (the
// same-repo skew defense from PRD D-06), and tsc emits JavaScript even when
// the source does not type-check. On 2026-09-10 a build from mid-edit source
// replaced dist/judge/runner.js with a file that threw "Identifier
// 'visualEvidence' has already been declared" at load, and because cli.ts
// requires the whole command graph eagerly, every sasu command on the
// machine died until someone rebuilt from good source. So the compiler
// writes to a staging directory, the result must answer --contract-version
// (which loads that whole graph), and only then does it replace dist. A
// failed compile or probe reports itself and leaves the previous dist as it
// was.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const cliDir = path.resolve(import.meta.dirname, "..");
const dist = path.join(cliDir, "dist");
const staging = path.join(cliDir, "dist.staging");
const previous = path.join(cliDir, "dist.previous");

fs.rmSync(staging, { recursive: true, force: true });
const compiled = spawnSync(process.execPath, [path.join(cliDir, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json", "--outDir", staging], { cwd: cliDir, stdio: "inherit" });
if (compiled.status !== 0) {
  fs.rmSync(staging, { recursive: true, force: true });
  console.error(`build: tsc exited ${compiled.status ?? "without a status"}; dist was not replaced`);
  process.exit(compiled.status ?? 1);
}
const probe = spawnSync(process.execPath, [path.join(staging, "cli.js"), "--contract-version"], { cwd: cliDir, encoding: "utf8" });
if (probe.status !== 0) {
  fs.rmSync(staging, { recursive: true, force: true });
  console.error(`build: the compiled CLI does not start (${(probe.stderr || probe.stdout).trim()}); dist was not replaced`);
  process.exit(1);
}
fs.rmSync(previous, { recursive: true, force: true });
if (fs.existsSync(dist)) fs.renameSync(dist, previous);
fs.renameSync(staging, dist);
fs.rmSync(previous, { recursive: true, force: true });
