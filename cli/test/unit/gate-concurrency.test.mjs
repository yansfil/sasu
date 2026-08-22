import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../../dist/config.js";
import { runGapAudit } from "../../dist/gates/commands.js";
import { GateStore } from "../../dist/gates/store.js";
import { runImplementCommand } from "../../dist/implement/commands.js";

const STORE_MODULE = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "dist", "gates", "store.js");
const PRD_FIXTURE = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "fixtures", "prelint", "prd-clean.md");
const QA_FIXTURE = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "fixtures", "prelint", "qa-clean.md");

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-gate-concurrency-"));
  fs.mkdirSync(path.join(root, "agents"), { recursive: true });
  return root;
}

function childRecord(projectRoot, gate) {
  const code = `
    const { GateStore, recordGateResult } = require(${JSON.stringify(STORE_MODULE)});
    const store = new GateStore(${JSON.stringify(projectRoot)}, "topic-a");
    recordGateResult(store, store.load(), ${JSON.stringify(gate)},
      { kind: "verdict", verdict: "PASS", findings: [], artifactPayload: { gate: ${JSON.stringify(gate)} } },
      [{ purpose: ${JSON.stringify(`gate:${gate}`)}, backend: "stub", model: null, profile: "routine", startedAt: new Date().toISOString(), durationMs: 1, attempts: 1, outcome: "ok" }]);
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (exitCode) => exitCode === 0 ? resolve() : reject(new Error(`child ${gate} exited ${exitCode}: ${stderr}`)));
  });
}

test("run lock: the same gate is exclusive while different gates remain parallel", () => {
  const store = new GateStore(makeProject(), "topic-a");
  const releaseGap = store.tryAcquireRunLock("gap-audit");
  assert.ok(releaseGap);
  assert.equal(store.tryAcquireRunLock("gap-audit"), null, "a duplicate same-gate run is refused");
  const releaseSpec = store.tryAcquireRunLock("spec");
  assert.ok(releaseSpec, "a different gate has its own lock");
  assert.equal(store.isGateInFlight("gap-audit"), true);
  assert.equal(store.isGateInFlight("spec"), true);
  releaseSpec();
  releaseGap();
  assert.equal(store.isGateInFlight("gap-audit"), false);
});

test("run lock: a demonstrably dead same-host owner is recovered", () => {
  const store = new GateStore(makeProject(), "topic-a");
  fs.mkdirSync(store.locksDir, { recursive: true });
  fs.writeFileSync(
    path.join(store.locksDir, "gap-audit.run.lock"),
    JSON.stringify({ token: "dead", pid: 99_999_999, hostname: os.hostname(), startedAt: new Date().toISOString() }),
  );
  const release = store.tryAcquireRunLock("gap-audit");
  assert.ok(release, "dead owner lock should not wedge the gate forever");
  release();
});

test("gate command admission: a duplicate same-gate run stops before any judge call or state write", async () => {
  const root = makeProject();
  fs.copyFileSync(QA_FIXTURE, path.join(root, "qa-log.md"));
  const store = new GateStore(root, "topic-a");
  const release = store.tryAcquireRunLock("gap-audit");
  assert.ok(release);
  try {
    const result = await runGapAudit(root, loadConfig(root), "topic-a", "qa-log.md");
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "gate-in-flight");
    assert.equal(result.zeroJudgeCalls, true);
    assert.equal(fs.existsSync(store.statePath), false, "admission refusal must not invent a gate ledger row");
  } finally {
    release();
  }
});

test("atomic state transaction: simultaneous different-gate results both survive", async () => {
  const root = makeProject();
  await Promise.all([childRecord(root, "gap-audit"), childRecord(root, "spec")]);
  const stateText = fs.readFileSync(new GateStore(root, "topic-a").statePath, "utf8");
  const state = JSON.parse(stateText);
  assert.equal(state.gates["gap-audit"].verdict, "PASS");
  assert.equal(state.gates.spec.verdict, "PASS");
  assert.deepEqual(state.judgeCalls.map((record) => record.purpose).sort(), ["gate:gap-audit", "gate:spec"]);
});

test("implement start refuses while a PRD gate is in flight", async () => {
  const root = makeProject();
  const prdDir = path.join(root, "agents", "prd", "topic-a");
  fs.mkdirSync(prdDir, { recursive: true });
  fs.copyFileSync(PRD_FIXTURE, path.join(prdDir, "prd.md"));
  const store = new GateStore(root, "topic-a");
  const release = store.tryAcquireRunLock("spec");
  assert.ok(release);
  try {
    const result = await runImplementCommand(root, {
      positional: ["implement", "start"],
      flags: new Map([["prd", "agents/prd/topic-a/prd.md"]]),
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /PRD review still in flight \(spec\)/);
  } finally {
    release();
  }
});
