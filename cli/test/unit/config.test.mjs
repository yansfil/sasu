import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, tierModelFor } from "../../dist/config.js";

function tempProject(configJson) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-config-"));
  if (configJson !== undefined) {
    fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
    fs.writeFileSync(path.join(dir, "agents", "config.json"), JSON.stringify(configJson));
  }
  return dir;
}

test("tier-config default mapping: frugal defaults to sonnet-class after the 2026-07-17 latency calibration", () => {
  const config = loadConfig(tempProject());
  assert.equal(tierModelFor(config, "claude", "frugal"), "claude-sonnet-5");
  assert.equal(tierModelFor(config, "claude", "standard"), "claude-sonnet-5");
  assert.equal(tierModelFor(config, "claude", "frontier"), "claude-opus-4-8");
  assert.equal(config.judge.retryBudget, 3);
  assert.equal(config.judge.backend, "auto");
  assert.equal(config.judge.fanout, true, "fan-out is the default gate path");
  assert.equal(config.verify.commandTimeoutMs, 600_000, "mechanical commands default to a 10-minute timeout");
});

test("tier-config override: judge.fanout=false and verify.commandTimeoutMs are honored", () => {
  const config = loadConfig(tempProject({ judge: { fanout: false }, verify: { commandTimeoutMs: 1234 } }));
  assert.equal(config.judge.fanout, false);
  assert.equal(config.verify.commandTimeoutMs, 1234);
});

test("tier-config rejects a non-positive commandTimeoutMs", () => {
  assert.throws(() => loadConfig(tempProject({ verify: { commandTimeoutMs: 0 } })), /commandTimeoutMs/);
});

test("tier-config override: agents/config.json overrides tier models and retry budget", () => {
  const config = loadConfig(
    tempProject({
      judge: {
        backend: "codex",
        retryBudget: 5,
        tierModels: { claude: { standard: "claude-opus-4-8" }, codex: { standard: "gpt-5.2" } },
      },
    }),
  );
  assert.equal(config.judge.backend, "codex");
  assert.equal(config.judge.retryBudget, 5);
  assert.equal(tierModelFor(config, "claude", "standard"), "claude-opus-4-8");
  assert.equal(tierModelFor(config, "claude", "frugal"), "claude-sonnet-5", "unset tiers keep their defaults");
  assert.equal(tierModelFor(config, "codex", "standard"), "gpt-5.2");
});

test("tier-config rejects a negative retry budget", () => {
  assert.throws(() => loadConfig(tempProject({ judge: { retryBudget: -1 } })), /retryBudget/);
});

test("loadConfig rejects invalid JSON with a clear error", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-config-"));
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agents", "config.json"), "{broken");
  assert.throws(() => loadConfig(dir), /not valid JSON/);
});
