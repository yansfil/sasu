import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

// agents/config.json is the only project knob surface, and the setup skill is
// where an operator learns what it accepts. judge.timeoutMs had been
// configurable for weeks with no mention there, so the 2026-09-10 pilot
// reported it as missing; a key the loader accepts and the skill does not name
// is a setting nobody can find.
test("every judge, verify and worktree key the config loader accepts is documented in the setup skill", async () => {
  const { loadConfig } = await import(path.join(repoRoot, "cli", "dist", "config.js"));
  const config = loadConfig(fs.mkdtempSync(path.join(os.tmpdir(), "sasu-config-docs-")));
  const skill = fs.readFileSync(path.join(repoRoot, "skills", "sasu-setup", "SKILL.md"), "utf8");
  const undocumented = [];
  for (const section of ["judge", "verify", "worktree"]) {
    for (const key of Object.keys(config[section])) {
      if (!skill.includes(`\`${section}.${key}`)) undocumented.push(`${section}.${key}`);
    }
  }
  assert.deepEqual(undocumented, [], "these accepted keys are not named in skills/sasu-setup/SKILL.md");
});
