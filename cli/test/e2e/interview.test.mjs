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

function makeCodexTranscript(dir, sessionId) {
  const file = path.join(dir, `${sessionId}.jsonl`);
  const records = [
    { type: "session_meta", payload: { id: sessionId } },
    {
      type: "response_item",
      payload: { type: "message", role: "user", id: "u0", content: [{ type: "input_text", text: "begin" }] },
    },
  ];
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return file;
}

function appendCodexTurn(file, asked, answer, number = 1) {
  const records = [
    {
      type: "response_item",
      payload: { type: "message", role: "assistant", id: `a${number}`, content: [{ type: "output_text", text: asked }] },
    },
    { type: "event_msg", payload: { type: "task_complete" } },
    {
      type: "response_item",
      payload: { type: "message", role: "user", id: `u${number}`, content: [{ type: "input_text", text: answer }] },
    },
  ];
  fs.appendFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function runCli(cwd, args, { stub } = {}) {
  const env = { ...process.env };
  for (const key of ["CODEX_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID"]) {
    delete env[key];
  }
  if (stub) {
    env.SASU_JUDGE_BACKEND = "stub";
    env.SASU_JUDGE_STUB_FILE = stub;
  } else {
    delete env.SASU_JUDGE_BACKEND;
    delete env.SASU_JUDGE_STUB_FILE;
  }
  return spawnSync("node", [CLI, ...args], { cwd, encoding: "utf8", env });
}

test("question limit is persisted, surfaced at the boundary, and preserves an extra captured turn", () => {
  const dir = makeProject();
  const transcript = makeCodexTranscript(dir, "limited-session");
  const invalid = runCli(dir, [
    "interview", "init", "--slug", "invalid-limit", "--topic", "Invalid", "--where", "greenfield",
    "--packs", "ux", "--question-limit", "0", "--transcript", transcript,
  ]);
  assert.equal(invalid.status, 2, invalid.stdout + invalid.stderr);
  assert.match(invalid.stderr, /--question-limit must be a positive integer/);

  const init = runCli(dir, [
    "interview", "init", "--slug", "limited", "--topic", "Limited interview", "--where", "greenfield",
    "--packs", "ux", "--question-limit", "1", "--transcript", transcript, "--json",
  ]);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  assert.equal(JSON.parse(init.stdout).cursor.questionLimit, 1);

  appendCodexTurn(transcript, "Only question?", "first answer");
  const atLimit = runCli(dir, ["interview", "sync", "--slug", "limited", "--transcript", transcript, "--json"]);
  assert.equal(atLimit.status, 0, atLimit.stdout + atLimit.stderr);
  const reached = JSON.parse(atLimit.stdout);
  assert.equal(reached.cursor.questionBudgetReached, true);
  assert.equal(reached.cursor.questionBudgetExceeded, false);
  assert.equal(reached.cursor.checkpointDue, true);

  appendCodexTurn(transcript, "Question beyond limit?", "second answer", 2);
  const exceeded = runCli(dir, ["interview", "sync", "--slug", "limited", "--transcript", transcript, "--json"]);
  assert.equal(exceeded.status, 0, exceeded.stdout + exceeded.stderr);
  const preserved = JSON.parse(exceeded.stdout);
  assert.equal(preserved.ok, true);
  assert.equal(preserved.cursor.questionBudgetExceeded, true);
  assert.deepEqual(preserved.detail.imported, ["Q2"]);
  assert.equal(preserved.drift.some((finding) => finding.rule === "qa-question-limit-exceeded"), false);
});

test("a full interview turn syncs from the transcript and the gate prelint accepts the result", (t) => {
  const dir = makeProject();
  const transcript = makeCodexTranscript(dir, "retry-session");
  const init = runCli(dir, [
    "interview", "init",
    "--slug", "retry-flow",
    "--topic", "Settings retry",
    "--where", "brownfield",
    "--packs", "ux, verification",
    "--understanding", "failed saves need a retry path",
    "--transcript", transcript,
  ]);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  assert.match(init.stdout, /created agents\/interview\/retry-flow\/qa-log\.md/);

  appendCodexTurn(transcript, "What happens when a save fails?", "keep input, show retry");
  const sync = runCli(dir, ["interview", "sync", "--slug", "retry-flow", "--transcript", transcript, "--json"]);
  assert.equal(sync.status, 0, sync.stdout + sync.stderr);
  const parsed = JSON.parse(sync.stdout);
  assert.deepEqual(parsed.detail.imported, ["Q1"]);
  assert.deepEqual(parsed.cursor.outstandingNormalization, ["Q1"]);
  assert.deepEqual(parsed.drift, []);

  // Checkpoint normalization links the imported raw answer to its material decision.
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
  const qaLog = path.join(dir, "agents", "interview", "retry-flow", "qa-log.md");
  fs.writeFileSync(qaLog, fs.readFileSync(qaLog, "utf8").replace("- decision_ids: none", "- decision_ids: D-01"));

  const checkpoint = runCli(dir, ["interview", "checkpoint", "--slug", "retry-flow", "--normalized", "pending"]);
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
  const transcript = makeCodexTranscript(dir, "coherence-session");
  runCli(dir, [
    "interview", "init", "--slug", "coh", "--topic", "Task app", "--where", "greenfield", "--packs", "ux",
    "--transcript", transcript,
  ]);

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
  const missing = runCli(dir, ["interview", "sync"]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /missing required --slug/);
  const unknown = runCli(dir, ["interview", "bogus", "--slug", "retry-flow"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown interview subcommand/);
});
