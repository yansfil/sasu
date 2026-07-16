import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GateStore, gateStatus, overrideGate, recordGateResult } from "../../dist/gates/store.js";

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "checkshirt-store-"));
  return new GateStore(dir, "topic-a");
}

const BLOCK_FINDING = {
  area: "data",
  severity: "P0",
  missing: "retention undecided",
  recommendation: "decide retention",
  requiresHuman: true,
};

function blockOutcome() {
  return { kind: "verdict", verdict: "BLOCK", findings: [BLOCK_FINDING], artifactPayload: { findings: [BLOCK_FINDING] } };
}

test("state machine: BLOCK increments attempts and stays blocked", () => {
  const store = makeStore();
  let state = store.load();
  state = recordGateResult(store, state, "gap-audit", blockOutcome(), []);
  const view = gateStatus(state, "gap-audit", 2);
  assert.equal(view.effective, "BLOCKED");
  assert.equal(view.attempts, 1);
  assert.equal(view.budgetExhausted, false);
  assert.equal(view.requiresHuman, true);
});

test("state machine: retry budget exhaustion is flagged after budget BLOCKs", () => {
  const store = makeStore();
  let state = store.load();
  state = recordGateResult(store, state, "gap-audit", blockOutcome(), []);
  state = recordGateResult(store, state, "gap-audit", blockOutcome(), []);
  const view = gateStatus(state, "gap-audit", 2);
  assert.equal(view.budgetExhausted, true);
});

test("state machine: PASS resets attempts and closes the gate", () => {
  const store = makeStore();
  let state = store.load();
  state = recordGateResult(store, state, "spec", blockOutcome(), []);
  state = recordGateResult(store, state, "spec", { kind: "verdict", verdict: "PASS", findings: [], artifactPayload: {} }, []);
  const view = gateStatus(state, "spec", 2);
  assert.equal(view.effective, "PASS");
  assert.equal(view.attempts, 0);
});

test("state machine fail-closed: judge error records ERROR and stays blocked", () => {
  const store = makeStore();
  let state = store.load();
  state = recordGateResult(store, state, "verify", { kind: "error", message: "judge-binary-missing: no claude" }, []);
  const view = gateStatus(state, "verify", 2);
  assert.equal(view.effective, "BLOCKED");
  assert.equal(view.verdict, "ERROR");
  assert.equal(view.attempts, 1);
});

test("override requires a non-empty reason", () => {
  const store = makeStore();
  const state = store.load();
  assert.throws(() => overrideGate(store, state, "gap-audit", "   "), /reason/);
});

test("override unblocks the gate and records a user deviation", () => {
  const store = makeStore();
  let state = store.load();
  state = recordGateResult(store, state, "gap-audit", blockOutcome(), []);
  state = overrideGate(store, state, "gap-audit", "accepting the retention gap for a spike");
  const view = gateStatus(state, "gap-audit", 2);
  assert.equal(view.effective, "PASS");
  assert.equal(view.overridden, true);
  assert.equal(state.deviations.length, 1);
  assert.equal(state.deviations[0].by, "user");
  assert.match(state.deviations[0].reason, /retention/);
});

test("receipt fields: judge calls persist with backend, model, and attempts", () => {
  const store = makeStore();
  let state = store.load();
  const record = {
    at: new Date().toISOString(),
    backend: "stub",
    model: null,
    tier: "frugal",
    purpose: "gate:gap-audit",
    durationMs: 5,
    attempts: 1,
    outcome: "ok",
  };
  state = recordGateResult(store, state, "gap-audit", blockOutcome(), [record]);
  const reloaded = store.load();
  assert.equal(reloaded.judgeCalls.length, 1);
  assert.equal(reloaded.judgeCalls[0].backend, "stub");
  assert.equal(reloaded.judgeCalls[0].attempts, 1);
  assert.equal(reloaded.judgeCalls[0].purpose, "gate:gap-audit");
});

test("receipt fields: gate artifacts are written under agents/gates/<topic>/artifacts", () => {
  const store = makeStore();
  let state = store.load();
  state = recordGateResult(store, state, "gap-audit", blockOutcome(), []);
  const artifact = state.gates["gap-audit"].history.at(-1).artifact;
  assert.ok(artifact && artifact.includes(path.join("agents", "gates", "topic-a", "artifacts")));
  assert.ok(fs.existsSync(path.join(store.projectRoot, artifact)));
});

test("GateStore rejects non-kebab-case topic slugs", () => {
  assert.throws(() => new GateStore(os.tmpdir(), "Bad Slug"), /kebab-case/);
});
