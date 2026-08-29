// Lane reasoning budget.
//
// `cli/src/gates/commands.ts` asserted for months that "lanes run at low
// effort ... that pairing, not parallelism alone, is what halves the gate",
// but nothing in the code ever lowered it: runJudge read the profile effort
// and had no override parameter, so every lane spent the exhaustive judge's
// budget. The 2026-08-28 implement-check artifacts show all four lanes at
// xhigh, which is the shape of a rule that lived only in prose (PRINCIPLES 7).
//
// These tests hold the wire that closes it: an override must reach the
// backend AND the persisted record, because a record that reports the profile
// budget while the call spent another one is a lie about what was paid.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const require = createRequire(import.meta.url);
const runnerPath = path.join(repoRoot, "cli", "dist", "judge", "runner.js");
const configPath = path.join(repoRoot, "cli", "dist", "config.js");
const typesPath = path.join(repoRoot, "cli", "dist", "judge", "types.js");
const built = fs.existsSync(runnerPath);

/** A fake `codex` that records the effort it was invoked with, then answers. */
function fakeCodexBin() {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-effort-bin-"));
  fs.writeFileSync(path.join(binDir, "codex"), `#!/bin/sh
last=""
prompt=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then last="$arg"; fi
  case "$arg" in
    model_reasoning_effort=*) printf '%s\\n' "$arg" >> "${binDir}/efforts.txt" ;;
  esac
  prev="$arg"
  prompt="$arg"
done
case "$prompt" in
  *"Reply with exactly: OK"*) printf '%s' OK > "$last"; printf '%s\\n' '{"type":"turn.completed","usage":{}}'; exit 0 ;;
esac
printf '%s' '{"verdict":"PASS","findings":[]}' > "$last"
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}'
exit 0
`.replace(/\$\{binDir\}/g, binDir), { mode: 0o755 });
  return binDir;
}

async function withBackend(binDir, fn) {
  const previous = { backend: process.env.SASU_JUDGE_BACKEND, path: process.env.PATH };
  process.env.SASU_JUDGE_BACKEND = "codex";
  process.env.PATH = `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
  try {
    return await fn();
  } finally {
    if (previous.backend === undefined) delete process.env.SASU_JUDGE_BACKEND;
    else process.env.SASU_JUDGE_BACKEND = previous.backend;
    process.env.PATH = previous.path;
  }
}

/** Efforts the fake backend saw, preflight canary included. */
function observedEfforts(binDir) {
  const file = path.join(binDir, "efforts.txt");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").map((line) => line.replace("model_reasoning_effort=", "").replace(/"/g, ""));
}

test("a caller's lane effort reaches the backend and the persisted record", { skip: !built && "cli/dist not built" }, async () => {
  const { runJudge, resetJudgeHealth } = require(runnerPath);
  const { loadConfig } = require(configPath);
  const { validateGapVerdict } = require(typesPath);
  const binDir = fakeCodexBin();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-effort-proj-"));
  await withBackend(binDir, async () => {
    resetJudgeHealth();
    const config = loadConfig(project);
    assert.equal(config.judge.profiles.routine.primary.effort, "xhigh", "fixture assumes the shipped profile budget");
    const outcome = await runJudge(config, "test:lane", "routine", "judge this", (v) => validateGapVerdict(v, {}), { effort: "medium" });
    assert.equal(outcome.record.effort, "medium", "the record must report the budget actually spent, not the profile's");
    assert.ok(observedEfforts(binDir).every((e) => e === "medium"), `backend saw: ${observedEfforts(binDir).join(",")}`);
  });
});

test("without an override the profile budget is still used", { skip: !built && "cli/dist not built" }, async () => {
  const { runJudge, resetJudgeHealth } = require(runnerPath);
  const { loadConfig } = require(configPath);
  const { validateGapVerdict } = require(typesPath);
  const binDir = fakeCodexBin();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-effort-proj-"));
  await withBackend(binDir, async () => {
    resetJudgeHealth();
    const config = loadConfig(project);
    const outcome = await runJudge(config, "test:lane", "routine", "judge this", (v) => validateGapVerdict(v, {}));
    assert.equal(outcome.record.effort, "xhigh");
    assert.ok(observedEfforts(binDir).every((e) => e === "xhigh"), `backend saw: ${observedEfforts(binDir).join(",")}`);
  });
});

test("an unconfigured project gets each gate's own measured budget, not one shared number", { skip: !built && "cli/dist not built" }, () => {
  const { loadConfig, laneEffortFor, LANE_EFFORT } = require(configPath);
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-effort-proj-"));
  const config = loadConfig(project);
  assert.equal(config.judge.laneEffort, null, "no override by default");
  // The three gates ask different questions and were measured separately;
  // collapsing them to one value is the assumption this test exists to stop.
  assert.equal(laneEffortFor(config, "gap-audit"), "high");
  assert.equal(laneEffortFor(config, "spec"), "high");
  assert.equal(laneEffortFor(config, "verify"), "medium");
  assert.notEqual(LANE_EFFORT["verify"], LANE_EFFORT["gap-audit"], "verify's budget is measured, not inherited");
});

test("judge.laneEffort pins every gate to one budget when a project sets it", { skip: !built && "cli/dist not built" }, () => {
  const { loadConfig, laneEffortFor } = require(configPath);
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-effort-proj-"));
  fs.mkdirSync(path.join(project, "agents"), { recursive: true });
  fs.writeFileSync(path.join(project, "agents", "config.json"), JSON.stringify({ judge: { laneEffort: "xhigh" } }));
  const config = loadConfig(project);
  for (const gate of ["gap-audit", "spec", "verify"]) {
    assert.equal(laneEffortFor(config, gate), "xhigh", `${gate} must honour the pin`);
  }
});

test("judge.laneEffort accepts a valid budget and rejects anything else", { skip: !built && "cli/dist not built" }, () => {
  const { loadConfig } = require(configPath);
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-effort-proj-"));
  fs.mkdirSync(path.join(project, "agents"), { recursive: true });
  const write = (value) => fs.writeFileSync(path.join(project, "agents", "config.json"), JSON.stringify({ judge: { laneEffort: value } }));

  write("medium");
  assert.equal(loadConfig(project).judge.laneEffort, "medium");
  write(null);
  assert.equal(loadConfig(project).judge.laneEffort, null);
  write("cheap");
  assert.throws(() => loadConfig(project), /judge\.laneEffort must be null or one of/);
});
