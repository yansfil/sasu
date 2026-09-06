// Judge-error budget for PRD gates. Semantic review is bounded by the open
// findings set (PRD gate-loop R1/R2), not by a round count; --grant-budget
// may only retry a backend that returned no verdict.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GateStore, gateStatus, grantGateBudget, recordGateResult } from "../../dist/gates/store.js";
import { runGapAudit } from "../../dist/gates/commands.js";
import { loadConfig } from "../../dist/config.js";
import { JUDGE_ERROR_LOOP_THRESHOLD } from "../../dist/judge/types.js";

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

function judgeErrorOutcome() {
  return {
    kind: "error",
    message: "backend down",
    cause: { code: "judge-auth-or-runtime", backend: "codex", reason: "turn-failed" },
  };
}

function makeProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sasu-gate-budget-"));
}

test("grant: never touches a PRD semantic review that is merely blocked", () => {
  const store = new GateStore(makeProject(), "topic-a");
  let state = store.load();
  state = recordGateResult(store, state, "gap-audit", blockOutcome(), []);
  state = recordGateResult(store, state, "gap-audit", blockOutcome(), []);
  assert.equal(gateStatus(state, "gap-audit", 2).effective, "BLOCKED");
  assert.throws(() => grantGateBudget(store, state, "gap-audit", "keep going", 2), /semantic review is not reopened/);
});

test("grant: refused with empty evidence at a judge-error terminal", () => {
  const store = new GateStore(makeProject(), "topic-a");
  let state = store.load();
  for (let i = 0; i < JUDGE_ERROR_LOOP_THRESHOLD; i += 1) {
    state = recordGateResult(store, state, "gap-audit", judgeErrorOutcome(), []);
  }
  assert.throws(() => grantGateBudget(store, state, "gap-audit", "   ", 2), /verbatim approval/);
});

test("grant: after a judge-error loop it records evidence and preserves the semantic phase", () => {
  const store = new GateStore(makeProject(), "topic-a");
  let state = store.load();
  for (let i = 0; i < JUDGE_ERROR_LOOP_THRESHOLD; i += 1) {
    state = recordGateResult(store, state, "gap-audit", judgeErrorOutcome(), []);
  }
  assert.equal(gateStatus(state, "gap-audit", 99).judgeErrorLoop, true, "backend threshold is independent from fix budget");
  state = grantGateBudget(store, state, "gap-audit", "백엔드 고쳤으니 다시 실행해", 2);
  const view = gateStatus(state, "gap-audit", 2);
  assert.equal(view.judgeErrorLoop, false);
  assert.equal(view.sealed, false, "a grant retries the backend; it does not seal or reopen anything");
  assert.equal(view.reviewCycle, 1);
  assert.equal(view.grants, 1);
  const reloaded = new GateStore(store.projectRoot, "topic-a").load();
  const grants = reloaded.gates["gap-audit"].budgetGrants;
  assert.equal(grants.length, 1);
  assert.equal(grants[0].evidence, "백엔드 고쳤으니 다시 실행해");
  assert.equal(grants[0].attemptCountBefore, JUDGE_ERROR_LOOP_THRESHOLD, "quotes cumulative totalAttempts, which a grant never resets");
});

test("grant: clears a judge-error loop the same way", () => {
  const store = new GateStore(makeProject(), "topic-a");
  let state = store.load();
  for (let i = 0; i < JUDGE_ERROR_LOOP_THRESHOLD; i += 1) {
    state = recordGateResult(store, state, "spec", judgeErrorOutcome(), []);
  }
  assert.equal(gateStatus(state, "spec", 2).judgeErrorLoop, true);
  state = grantGateBudget(store, state, "spec", "backend fixed, go again", 2);
  assert.equal(gateStatus(state, "spec", 2).judgeErrorLoop, false);
});

test("admission: a judge-error loop refuses the same way with its own cause", async () => {
  const projectRoot = makeProject();
  const store = new GateStore(projectRoot, "topic-a");
  const config = loadConfig(projectRoot);
  let state = store.load();
  for (let i = 0; i < JUDGE_ERROR_LOOP_THRESHOLD; i += 1) {
    state = recordGateResult(store, state, "gap-audit", judgeErrorOutcome(), []);
  }
  const qaLogPath = path.join(projectRoot, "qa-log.md");
  fs.copyFileSync(path.join(FIXTURES, "qa-clean.md"), qaLogPath);
  const result = await runGapAudit(projectRoot, config, "topic-a", qaLogPath);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "judge-error-loop");
});
