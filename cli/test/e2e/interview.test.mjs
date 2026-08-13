import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "dist", "cli.js");

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-interview-e2e-"));
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  return dir;
}

function runCli(cwd, args, { stub } = {}) {
  const env = { ...process.env };
  if (stub) {
    env.SASU_JUDGE_BACKEND = "stub";
    env.SASU_JUDGE_STUB_FILE = stub;
  } else {
    delete env.SASU_JUDGE_BACKEND;
    delete env.SASU_JUDGE_STUB_FILE;
  }
  return spawnSync("node", [CLI, ...args], { cwd, encoding: "utf8", env });
}

test("a full interview turn is two chained commands and the gate prelint accepts the result", (t) => {
  const dir = makeProject();
  const init = runCli(dir, [
    "interview", "init",
    "--slug", "retry-flow",
    "--topic", "Settings retry",
    "--where", "brownfield",
    "--packs", "ux, verification",
    "--understanding", "failed saves need a retry path",
  ]);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  assert.match(init.stdout, /created agents\/interview\/retry-flow\/qa-log\.md/);

  // per-turn shape: register the decision, then log the turn
  const decision = runCli(dir, [
    "interview", "decision",
    "--slug", "retry-flow",
    "--id", "D-01",
    "--kind", "decision",
    "--area", "UX/design",
    "--text", "Failed save exposes retry and preserves input",
    "--priority", "P0",
    "--source", "user, Q1",
    "--status", "resolved",
    "--mapping", "R1/AC1/V1",
  ]);
  assert.equal(decision.status, 0, decision.stdout + decision.stderr);

  const log = runCli(dir, [
    "interview", "log",
    "--slug", "retry-flow",
    "--label", "Failed save behavior",
    "--asked", "What happens when a save fails?",
    "--recommended", "Keep the input and offer retry",
    "--answer", "keep input, show retry",
    "--decision-ids", "D-01",
    "--next-question", "ask about permission-denied state",
    "--json",
  ]);
  assert.equal(log.status, 0, log.stdout + log.stderr);
  const parsed = JSON.parse(log.stdout);
  assert.equal(parsed.detail.logged, "Q1");
  assert.deepEqual(parsed.cursor.outstandingNormalization, ["Q1"]);
  assert.deepEqual(parsed.drift, []);

  const checkpoint = runCli(dir, ["interview", "checkpoint", "--slug", "retry-flow", "--normalized", "Q1"]);
  assert.equal(checkpoint.status, 0, checkpoint.stdout + checkpoint.stderr);

  const status = runCli(dir, ["interview", "status", "--slug", "retry-flow", "--json"]);
  assert.equal(status.status, 0, status.stdout + status.stderr);
  const view = JSON.parse(status.stdout);
  assert.equal(view.cursor.questionCount, 1);
  assert.deepEqual(view.detail.openMaterial, []);

  // the gap-audit gate's own prelint accepts the CLI-written document
  const stubFile = path.join(dir, "stub.json");
  fs.writeFileSync(stubFile, JSON.stringify({ verdict: "PASS", findings: [] }));
  const gate = runCli(dir, ["gate", "gap-audit", "--slug", "retry-flow", "--qa-log", "agents/interview/retry-flow/qa-log.md"], {
    stub: stubFile,
  });
  assert.equal(gate.status, 0, gate.stdout + gate.stderr);
  assert.doesNotMatch(gate.stdout, /\[prelint\] FAIL/);
});

test("interview coherence is advisory: skips when thin, judges when seeded, never writes gate state", (t) => {
  const dir = makeProject();
  runCli(dir, ["interview", "init", "--slug", "coh", "--topic", "Task app", "--where", "greenfield", "--packs", "ux"]);

  // thin interview: skipped, exit 0, no judge call
  const thin = runCli(dir, ["interview", "coherence", "--slug", "coh", "--json"]);
  assert.equal(thin.status, 0, thin.stdout + thin.stderr);
  assert.equal(JSON.parse(thin.stdout).skipped, true);

  for (let i = 1; i <= 3; i += 1) {
    runCli(dir, [
      "interview", "decision", "--slug", "coh",
      "--id", `D-0${i}`, "--kind", "decision", "--area", "ux",
      "--text", `decision ${i}`, "--priority", "P1", "--source", "user", "--status", "resolved",
    ]);
  }

  const stubFile = path.join(dir, "stub.json");
  fs.writeFileSync(stubFile, JSON.stringify({ verdict: "PASS", findings: [] }));
  const judged = runCli(dir, ["interview", "coherence", "--slug", "coh", "--json"], { stub: stubFile });
  assert.equal(judged.status, 0, judged.stdout + judged.stderr);
  const view = JSON.parse(judged.stdout);
  assert.equal(view.skipped, false);
  assert.equal(view.verdict, "PASS");
  assert.equal(view.resolvedCount, 3);
  assert.equal(typeof view.durationMs, "number");
  // advisory contract: no gate directory for the topic
  assert.equal(fs.existsSync(path.join(dir, "agents", "runs", "coh")), false);

  // text mode reports the timing
  const text = runCli(dir, ["interview", "coherence", "--slug", "coh"], { stub: stubFile });
  assert.match(text.stdout, /\[interview:coherence\] coherent \(3 resolved decisions judged in [\d.]+s\)/);
});

test("usage errors exit 2 and unknown subcommands are rejected", () => {
  const dir = makeProject();
  const missing = runCli(dir, ["interview", "log", "--slug", "retry-flow"]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /missing required --label/);
  const unknown = runCli(dir, ["interview", "bogus", "--slug", "retry-flow"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown interview subcommand/);
});
