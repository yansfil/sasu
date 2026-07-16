// Live judge smoke (PRD V4): one real one-shot call per backend.
// Costs subscription tokens (approved in PRD §4.2). Local-only; requires
// logged-in `claude` and `codex` binaries. Safe probe: a minimal fixed
// judgment prompt, tools disallowed / read-only sandbox, no writes.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runJudge } from "../../dist/judge/runner.js";
import { validateGapVerdict } from "../../dist/judge/types.js";
import { loadConfig } from "../../dist/config.js";

const TINY_LOG = `# Interview Log: smoke

## Decision Register

| ID | Kind | Area | Decision / fact | Priority | Source / owner | Status | PRD mapping / revisit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| D-01 | decision | scope | Build a CLI that prints "hello" and exits 0 | P0 | user | resolved | R1 |

## Raw Q&A

### Q1: scope
- answer: a hello-world CLI, no flags, no config, exit code 0.
`;

const PROMPT = `You are an independent interview-closure judge.
The interview below fully decides a trivial hello-world CLI. There are no material gaps.

Reply with ONLY a JSON object, no prose, no code fences:
{"verdict":"PASS"|"BLOCK","findings":[{"area":"...","severity":"P0"|"P1"|"P2","missing":"...","recommendation":"...","requiresHuman":true|false}]}

INTERVIEW LOG:
---
${TINY_LOG}
---`;

function configForBackend(backend) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "checkshirt-smoke-"));
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agents", "config.json"), JSON.stringify({ judge: { backend } }));
  return loadConfig(dir);
}

test("live claude -p returns schema-valid gate JSON", { timeout: 240_000 }, () => {
  delete process.env.CHECKSHIRT_JUDGE_BACKEND;
  const outcome = runJudge(configForBackend("claude"), "smoke:claude", "frugal", PROMPT, validateGapVerdict);
  assert.ok(["PASS", "BLOCK"].includes(outcome.value.verdict));
  assert.equal(outcome.record.backend, "claude");
  assert.equal(outcome.record.model, "claude-haiku-4-5");
  console.log(`claude smoke: verdict=${outcome.value.verdict} attempts=${outcome.record.attempts} durationMs=${outcome.record.durationMs}`);
});

test("live codex exec returns schema-valid gate JSON", { timeout: 240_000 }, () => {
  delete process.env.CHECKSHIRT_JUDGE_BACKEND;
  const outcome = runJudge(configForBackend("codex"), "smoke:codex", "frugal", PROMPT, validateGapVerdict);
  assert.ok(["PASS", "BLOCK"].includes(outcome.value.verdict));
  assert.equal(outcome.record.backend, "codex");
  console.log(`codex smoke: verdict=${outcome.value.verdict} attempts=${outcome.record.attempts} durationMs=${outcome.record.durationMs}`);
});
