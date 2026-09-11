import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

// The global sasu shim runs this repository's cli/dist directly, and tsc
// emits JavaScript even for source that does not compile. On 2026-09-10 a
// build from mid-edit source left dist/judge/runner.js throwing at load and
// every sasu command died. A failed build must leave the last good dist.
test("a build that does not produce a runnable CLI leaves the previous dist in place", () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-build-atomic-"));
  const cli = path.join(copy, "cli");
  fs.mkdirSync(cli);
  for (const entry of ["src", "lib", "scripts", "tsconfig.json", "package.json"]) {
    fs.cpSync(path.join(repoRoot, "cli", entry), path.join(cli, entry), { recursive: true });
  }
  fs.symlinkSync(path.join(repoRoot, "cli", "node_modules"), path.join(cli, "node_modules"));
  const build = () => spawnSync("npm", ["--prefix", cli, "run", "build"], { encoding: "utf8" });
  const contractVersion = () => spawnSync(process.execPath, [path.join(cli, "dist", "cli.js"), "--contract-version"], { encoding: "utf8" });

  const good = build();
  assert.equal(good.status, 0, good.stdout + good.stderr);
  const before = contractVersion();
  assert.equal(before.status, 0, before.stderr);

  // A duplicate declaration is what the incident's mid-edit source produced:
  // tsc reports it and still emits JavaScript that throws at load.
  fs.appendFileSync(path.join(cli, "src", "judge", "runner.ts"), "\nconst visualEvidence = 1;\nconst visualEvidence = 2;\n");
  const broken = build();
  assert.notEqual(broken.status, 0, "a build from source that does not compile must fail");
  const after = contractVersion();
  assert.equal(after.status, 0, `the previous dist must still run: ${after.stderr}`);
  assert.equal(after.stdout, before.stdout);
  assert.equal(fs.existsSync(path.join(cli, "dist.staging")), false, "no staging directory is left behind");
  fs.rmSync(copy, { recursive: true, force: true });
});
