import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../../dist/config.js";
import { AGENTIC_READ_MAX_ROUNDS, CLAUDE_MAX_API_TURNS, claudeIsolatedReadPreamble, claudePrintArgs, codexIsolatedReadPreamble } from "../../dist/judge/backends.js";
import { runJudge } from "../../dist/judge/runner.js";
import { validateGapVerdict } from "../../dist/judge/types.js";

function projectWith(judge) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-read-rounds-"));
  fs.mkdirSync(path.join(root, "agents"));
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({ judge }));
  return root;
}

async function withStub(fn) {
  const stubFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sasu-read-rounds-stub-")), "stub.json");
  fs.writeFileSync(stubFile, JSON.stringify({ verdict: "PASS", findings: [] }));
  const previous = { backend: process.env.SASU_JUDGE_BACKEND, file: process.env.SASU_JUDGE_STUB_FILE, rounds: process.env.SASU_JUDGE_STUB_READ_ROUNDS };
  process.env.SASU_JUDGE_BACKEND = "stub";
  process.env.SASU_JUDGE_STUB_FILE = stubFile;
  try {
    return await fn();
  } finally {
    for (const [key, value] of [["SASU_JUDGE_BACKEND", previous.backend], ["SASU_JUDGE_STUB_FILE", previous.file], ["SASU_JUDGE_STUB_READ_ROUNDS", previous.rounds]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// The 2026-09-10 Task Factory pilot: with codex quota-blocked, claude fallback
// Code reviews in two repositories read 34, 36 and 38 rounds and every one was
// rejected at the hard-coded 29; a scratch build at 60 passed both. The bound
// is now the project's `judge.readMaxRounds`, default unchanged.
test("judge.readMaxRounds raises the read-round budget a non-exploring agentic judge is held to", async () => {
  assert.equal(loadConfig(projectWith({})).judge.readMaxRounds, AGENTIC_READ_MAX_ROUNDS, "the default is the measured constant");
  assert.equal(loadConfig(projectWith({ readMaxRounds: 60 })).judge.readMaxRounds, 60);
  for (const bad of [0, -1, 2.5, "60"]) {
    assert.throws(() => loadConfig(projectWith({ readMaxRounds: bad })), /judge\.readMaxRounds must be a positive integer/, String(bad));
  }

  await withStub(async () => {
    process.env.SASU_JUDGE_STUB_READ_ROUNDS = "35";
    const rejected = await runJudge(loadConfig(projectWith({})), "read-rounds:default", "routine", "prompt", validateGapVerdict, { agentic: true })
      .then(() => null, (error) => error);
    assert.ok(rejected, "35 rounds against the default budget is still a rejection");
    assert.equal(rejected.reason, "read-budget-exceeded");
    assert.match(rejected.detail, /limit of 29/);

    const accepted = await runJudge(loadConfig(projectWith({ readMaxRounds: 60 })), "read-rounds:raised", "routine", "prompt", validateGapVerdict, { agentic: true });
    assert.equal(accepted.value.verdict, "PASS", "the same 35 rounds pass under the project's raised budget");
    assert.equal(accepted.record.activity.readRounds, 35);
  });

  // The judge is told the bound it actually runs under. claude's API-turn cap
  // is a different unit (one turn carries many reads) and does not move.
  assert.match(codexIsolatedReadPreamble(60), /beyond 60 read commands/);
  assert.match(claudeIsolatedReadPreamble(60), /limits this call to 60 reads/);
  assert.match(claudeIsolatedReadPreamble(60), new RegExp(`stops the call after ${CLAUDE_MAX_API_TURNS} turns`));
  const args = claudePrintArgs({ model: null, agentic: true });
  assert.equal(args[args.indexOf("--max-turns") + 1], String(CLAUDE_MAX_API_TURNS));
});
