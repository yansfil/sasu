import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../../dist/config.js";

function tempProject(configJson) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-config-"));
  if (configJson !== undefined) {
    fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
    fs.writeFileSync(path.join(dir, "agents", "config.json"), JSON.stringify(configJson));
  }
  return dir;
}

test("judge profiles default to Codex xhigh with capability-preserving Claude fallbacks", () => {
  const config = loadConfig(tempProject());
  assert.deepEqual(config.judge.profiles.routine, {
    primary: { backend: "codex", model: "gpt-5.6-luna", effort: "xhigh" },
    fallback: { backend: "claude", model: "claude-sonnet-5", effort: "xhigh" },
  });
  assert.deepEqual(config.judge.profiles["high-risk"], {
    primary: { backend: "codex", model: "gpt-5.6-sol", effort: "xhigh" },
    fallback: { backend: "claude", model: "claude-opus-5", effort: "xhigh" },
  });
  assert.equal(config.judge.retryBudget, 3);
  assert.equal(config.judge.fanout, true);
  assert.equal(config.verify.commandTimeoutMs, 600_000);
});

test("project config partially overrides one profile without repeating defaults", () => {
  const config = loadConfig(tempProject({
    judge: {
      profiles: {
        routine: {
          primary: { model: "gpt-project-routine", effort: "high" },
          fallback: null,
        },
        "high-risk": {
          fallback: { model: "claude-project-opus" },
        },
      },
      retryBudget: 5,
      fanout: false,
    },
    verify: { commandTimeoutMs: 1234 },
  }));
  assert.deepEqual(config.judge.profiles.routine, {
    primary: { backend: "codex", model: "gpt-project-routine", effort: "high" },
    fallback: null,
  });
  assert.deepEqual(config.judge.profiles["high-risk"].fallback, {
    backend: "claude",
    model: "claude-project-opus",
    effort: "xhigh",
  });
  assert.equal(config.judge.retryBudget, 5);
  assert.equal(config.judge.fanout, false);
  assert.equal(config.verify.commandTimeoutMs, 1234);
});

test("removed tier settings fail explicitly instead of being ignored", () => {
  assert.throws(() => loadConfig(tempProject({ judge: { backend: "codex" } })), /were removed/);
  assert.throws(() => loadConfig(tempProject({ judge: { tierModels: {} } })), /were removed/);
});

test("invalid profile targets and timeouts fail explicitly", () => {
  assert.throws(
    () => loadConfig(tempProject({ judge: { profiles: { routine: { primary: { effort: "turbo" } } } } })),
    /effort/,
  );
  assert.throws(
    () => loadConfig(tempProject({ judge: { profiles: { routine: { fallback: { backend: "codex" } } } } })),
    /must differ/,
  );
  assert.throws(() => loadConfig(tempProject({ judge: { retryBudget: -1 } })), /retryBudget/);
  assert.throws(() => loadConfig(tempProject({ judge: { timeoutMs: 0 } })), /timeoutMs/);
  assert.throws(() => loadConfig(tempProject({ verify: { commandTimeoutMs: 0 } })), /commandTimeoutMs/);
});

test("loadConfig rejects invalid JSON with a clear error", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-config-"));
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agents", "config.json"), "{broken");
  assert.throws(() => loadConfig(dir), /not valid JSON/);
});
