import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { freshnessHash, GateStore, gateStatus, overrideGate, recordGateResult } from "../../dist/gates/store.js";

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

function passWithInput(store, docName, content) {
  fs.writeFileSync(path.join(store.projectRoot, docName), content);
  return recordGateResult(
    store,
    store.load(),
    "spec",
    {
      kind: "verdict",
      verdict: "PASS",
      findings: [],
      inputs: [{ path: docName, sha256: freshnessHash(content) }],
      artifactPayload: {},
    },
    [],
  );
}

test("freshness: a PASS stays PASS while the input document is unchanged", () => {
  const store = makeStore();
  const state = passWithInput(store, "prd.md", "# PRD v1\n");
  const view = gateStatus(state, "spec", 2, store.projectRoot);
  assert.equal(view.effective, "PASS");
  assert.equal(view.stale, false);
  assert.deepEqual(view.staleInputs, []);
});

test("freshness: editing the input document after a PASS turns the gate STALE", () => {
  const store = makeStore();
  const state = passWithInput(store, "prd.md", "# PRD v1\n");
  fs.writeFileSync(path.join(store.projectRoot, "prd.md"), "# PRD v2 (edited after the gate)\n");
  const view = gateStatus(state, "spec", 2, store.projectRoot);
  assert.equal(view.effective, "STALE");
  assert.equal(view.stale, true);
  assert.deepEqual(view.staleInputs, [{ path: "prd.md", reason: "changed" }]);
});

test("freshness: a deleted input document is reported as missing", () => {
  const store = makeStore();
  const state = passWithInput(store, "prd.md", "# PRD v1\n");
  fs.rmSync(path.join(store.projectRoot, "prd.md"));
  const view = gateStatus(state, "spec", 2, store.projectRoot);
  assert.equal(view.effective, "STALE");
  assert.deepEqual(view.staleInputs, [{ path: "prd.md", reason: "missing" }]);
});

test("freshness: an overridden gate is a user deviation, never STALE", () => {
  const store = makeStore();
  let state = store.load();
  state = recordGateResult(store, state, "spec", blockOutcome(), []);
  state = overrideGate(store, state, "spec", "user accepts the gap");
  const view = gateStatus(state, "spec", 2, store.projectRoot);
  assert.equal(view.effective, "PASS");
  assert.equal(view.stale, false);
});

test("freshness: pre-0.2 state files without inputs never report STALE", () => {
  const store = makeStore();
  let state = store.load();
  state = recordGateResult(
    store,
    state,
    "spec",
    { kind: "verdict", verdict: "PASS", findings: [], artifactPayload: {} },
    [],
  );
  delete state.gates.spec.inputs; // simulate a state file written before freshness existed
  const view = gateStatus(state, "spec", 2, store.projectRoot);
  assert.equal(view.effective, "PASS");
  assert.equal(view.stale, false);
});

test("freshness: frontmatter lifecycle flips do not stale the gate", () => {
  const store = makeStore();
  const v1 = '---\nstatus: "draft"\nhuman_approval: "pending"\n---\n\n# PRD: demo\n\n- R1. behavior\n';
  const state = passWithInput(store, "prd.md", v1);
  const v2 = '---\nstatus: "ready"\nhuman_approval: "approved"\n---\n\n# PRD: demo\n\n- R1. behavior\n';
  fs.writeFileSync(path.join(store.projectRoot, "prd.md"), v2);
  const view = gateStatus(state, "spec", 2, store.projectRoot);
  assert.equal(view.effective, "PASS");
  assert.equal(view.stale, false);
});

test("freshness: recording the gate's own Audit History entry does not stale the gate", () => {
  const store = makeStore();
  const v1 = "# Interview Log: demo\n\n## Raw Q&A\n\n### Q1: x\n- answer: yes\n\n## Audit History\n\n### Audit 1\n- result: pass\n";
  const state = passWithInput(store, "qa-log.md", v1);
  const v2 = `${v1}\n### Audit 2\n- type: gap-audit-gate\n- result: pass\n`;
  fs.writeFileSync(path.join(store.projectRoot, "qa-log.md"), v2);
  const view = gateStatus(state, "spec", 2, store.projectRoot);
  assert.equal(view.effective, "PASS");
  assert.equal(view.stale, false);
});

test("freshness: substance edits still stale the gate even with frontmatter present", () => {
  const store = makeStore();
  const v1 = '---\nstatus: "draft"\n---\n\n# PRD: demo\n\n- R1. old behavior\n\n## Audit History\n\n- none\n';
  const state = passWithInput(store, "prd.md", v1);
  const v2 = '---\nstatus: "draft"\n---\n\n# PRD: demo\n\n- R1. NEW behavior\n\n## Audit History\n\n- none\n';
  fs.writeFileSync(path.join(store.projectRoot, "prd.md"), v2);
  const view = gateStatus(state, "spec", 2, store.projectRoot);
  assert.equal(view.effective, "STALE");
  assert.deepEqual(view.staleInputs, [{ path: "prd.md", reason: "changed" }]);
});

test("freshness: Audit History stripping stops at the next section", () => {
  const audit = "## Audit History\n\n### Audit 1\n- result: pass\n\n## Checkpoint And Sweep History\n\n- checkpoint 1\n";
  const withExtraAudit = "## Audit History\n\n### Audit 1\n- result: pass\n\n### Audit 2\n- result: pass\n\n## Checkpoint And Sweep History\n\n- checkpoint 1\n";
  assert.equal(freshnessHash(audit), freshnessHash(withExtraAudit));
  const changedNeighbor = audit.replace("checkpoint 1", "checkpoint 2");
  assert.notEqual(freshnessHash(audit), freshnessHash(changedNeighbor));
});

test("freshness: omitting projectRoot skips the staleness check (in-memory callers)", () => {
  const store = makeStore();
  const state = passWithInput(store, "prd.md", "# PRD v1\n");
  fs.rmSync(path.join(store.projectRoot, "prd.md"));
  const view = gateStatus(state, "spec", 2);
  assert.equal(view.effective, "PASS");
  assert.equal(view.stale, false);
});
