import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../../dist/config.js";
import { resolveMechanicalCommands, runMechanical } from "../../dist/mechanical.js";

function tempProject({ config, packageJson } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "checkshirt-mech-"));
  if (config !== undefined) {
    fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
    fs.writeFileSync(path.join(dir, "agents", "config.json"), JSON.stringify(config));
  }
  if (packageJson !== undefined) {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(packageJson));
  }
  return dir;
}

test("config-declared verify commands win over manifest detection", () => {
  const dir = tempProject({
    config: { verify: { commands: { test: "node -e \"process.exit(0)\"" } } },
    packageJson: { scripts: { test: "should-not-run" } },
  });
  const { resolved, configSuggestion } = resolveMechanicalCommands(dir, loadConfig(dir));
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].source, "config");
  assert.equal(configSuggestion, null);
});

test("manifest detection suggests recording commands into config", () => {
  const dir = tempProject({ packageJson: { scripts: { test: "echo t", lint: "echo l" } } });
  const { resolved, configSuggestion } = resolveMechanicalCommands(dir, loadConfig(dir));
  assert.equal(resolved.length, 2);
  assert.ok(resolved.every((c) => c.source === "detected"));
  assert.deepEqual(Object.keys(configSuggestion).sort(), ["lint", "test"]);
});

test("runMechanical passes on exit 0 and records runs", () => {
  const dir = tempProject({ config: { verify: { commands: { test: "node -e \"process.exit(0)\"" } } } });
  const result = runMechanical(dir, loadConfig(dir));
  assert.equal(result.ok, true);
  assert.equal(result.runs.length, 1);
  assert.equal(result.runs[0].ok, true);
});

test("runMechanical fails fast on the first failing command", () => {
  const dir = tempProject({
    config: {
      verify: {
        commands: {
          test: "node -e \"console.error('boom'); process.exit(3)\"",
          build: "node -e \"process.exit(0)\"",
        },
      },
    },
  });
  const result = runMechanical(dir, loadConfig(dir));
  assert.equal(result.ok, false);
  assert.equal(result.runs.length, 1);
  assert.equal(result.runs[0].exitCode, 3);
  assert.match(result.runs[0].tail, /boom/);
});

test("no commands anywhere yields an empty resolution", () => {
  const dir = tempProject({});
  const { resolved, configSuggestion } = resolveMechanicalCommands(dir, loadConfig(dir));
  assert.equal(resolved.length, 0);
  assert.equal(configSuggestion, null);
});
