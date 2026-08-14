// Terminal-cause admission check + user budget grants for gap-audit/spec.
// Measured 2026-08-14 (creator-assist, exploration-collection-depth):
// gap-audit ran 9 attempts against retryBudget 8 because budgetExhausted was
// a status flag no run path read - each rerun lawfully re-blocked on fresh
// requiresHuman findings and the PRINCIPLES-item-13 round cap bounded
// nothing. These tests pin the enforcement: an exhausted gate refuses at $0,
// and only a user's recorded verbatim approval reopens the budget.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GateStore, gateStatus, grantGateBudget, recordGateResult } from "../../dist/gates/store.js";
import { runGapAudit } from "../../dist/gates/commands.js";
import { loadConfig } from "../../dist/config.js";

const FIXTURES = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "fixtures", "prelint");

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

function makeProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sasu-gate-budget-"));
}

function exhaust(store, gate, budget) {
  let state = store.load();
  for (let i = 0; i < budget; i += 1) {
    state = recordGateResult(store, state, gate, blockOutcome(), []);
  }
  return state;
}

test("grant: refused while the fix budget is still live", () => {
  const store = new GateStore(makeProject(), "topic-a");
  let state = store.load();
  state = recordGateResult(store, state, "gap-audit", blockOutcome(), []);
  assert.throws(() => grantGateBudget(store, state, "gap-audit", "keep going", 3), /not exhausted/);
});

test("grant: refused with empty evidence even at a terminal gauge", () => {
  const store = new GateStore(makeProject(), "topic-a");
  const state = exhaust(store, "gap-audit", 2);
  assert.throws(() => grantGateBudget(store, state, "gap-audit", "   ", 2), /verbatim approval/);
});

test("grant: at exhaustion it records the evidence, resets the gauge, and persists", () => {
  const store = new GateStore(makeProject(), "topic-a");
  let state = exhaust(store, "gap-audit", 2);
  assert.equal(gateStatus(state, "gap-audit", 2).budgetExhausted, true);
  state = grantGateBudget(store, state, "gap-audit", "ㅇㅇ 한 라운드 더 진행해", 2);
  const view = gateStatus(state, "gap-audit", 2);
  assert.equal(view.budgetExhausted, false);
  assert.equal(view.attempts, 0);
  assert.equal(view.grants, 1);
  assert.equal(view.effective, "BLOCKED", "a grant reopens the budget, never the verdict");
  const reloaded = new GateStore(store.projectRoot, "topic-a").load();
  const grants = reloaded.gates["gap-audit"].budgetGrants;
  assert.equal(grants.length, 1);
  assert.equal(grants[0].evidence, "ㅇㅇ 한 라운드 더 진행해");
  assert.equal(grants[0].attemptCountBefore, 2, "quotes cumulative totalAttempts, which a grant never resets");
});

test("grant: clears a judge-error loop the same way", () => {
  const store = new GateStore(makeProject(), "topic-a");
  let state = store.load();
  for (let i = 0; i < 2; i += 1) {
    state = recordGateResult(store, state, "spec", { kind: "error", message: "backend down" }, []);
  }
  assert.equal(gateStatus(state, "spec", 2).judgeErrorLoop, true);
  state = grantGateBudget(store, state, "spec", "backend fixed, go again", 2);
  assert.equal(gateStatus(state, "spec", 2).judgeErrorLoop, false);
});

test("admission: an exhausted gap-audit refuses at $0 before any judge call", async () => {
  const projectRoot = makeProject();
  const store = new GateStore(projectRoot, "topic-a");
  const config = loadConfig(projectRoot);
  exhaust(store, "gap-audit", config.judge.retryBudget);
  const qaLogPath = path.join(projectRoot, "qa-log.md");
  fs.copyFileSync(path.join(FIXTURES, "qa-clean.md"), qaLogPath);
  const before = JSON.stringify(new GateStore(projectRoot, "topic-a").load());
  const result = await runGapAudit(projectRoot, config, "topic-a", qaLogPath);
  assert.equal(result.ok, false);
  assert.equal(result.zeroJudgeCalls, true);
  assert.equal(result.error.code, "budget-exhausted");
  assert.match(result.error.message, /no judge was called/);
  assert.match(result.error.recovery, /--grant-budget/);
  assert.match(result.error.recovery, /gate override/);
  const after = JSON.stringify(new GateStore(projectRoot, "topic-a").load());
  assert.equal(after, before, "a refused run must not consume an attempt or record anything");
});

test("admission: a judge-error loop refuses the same way with its own cause", async () => {
  const projectRoot = makeProject();
  const store = new GateStore(projectRoot, "topic-a");
  const config = loadConfig(projectRoot);
  let state = store.load();
  for (let i = 0; i < config.judge.retryBudget; i += 1) {
    state = recordGateResult(store, state, "gap-audit", { kind: "error", message: "backend down" }, []);
  }
  const qaLogPath = path.join(projectRoot, "qa-log.md");
  fs.copyFileSync(path.join(FIXTURES, "qa-clean.md"), qaLogPath);
  const result = await runGapAudit(projectRoot, config, "topic-a", qaLogPath);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "judge-error-loop");
});
