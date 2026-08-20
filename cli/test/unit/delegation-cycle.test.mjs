// Standing delegation record + gate cycle cap.
// Measured 2026-08-20 (3 real $please runs): (a) two of three runs omitted
// the per-call --assume-human-findings flag, so gates blocked on findings the
// delegation had already answered - the flag lived only as skill prose
// (PRINCIPLES item 7); (b) gap-audit cycled 7-11 judged rounds per run
// because a PASS resets `attempts`, so a PASS -> cross-gate fix -> STALE ->
// re-judge loop was bounded by nothing (item 13). These tests pin the fixes:
// delegation recorded once as run state, and a cycle cap over judged non-PASS
// rounds that only a user grant reopens.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GateStore, gateStatus, grantGateBudget, recordDelegation, recordGateResult } from "../../dist/gates/store.js";
import { runDelegate, runGapAudit } from "../../dist/gates/commands.js";
import { loadConfig } from "../../dist/config.js";

const FIXTURES = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "fixtures", "prelint");

const FINDING = { area: "data", severity: "P1", missing: "m", recommendation: "r", requiresHuman: true };

function outcome(verdict) {
  return { kind: "verdict", verdict, findings: verdict === "BLOCK" ? [FINDING] : [], artifactPayload: {} };
}

function makeProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sasu-delegation-cycle-"));
}

test("delegate: empty evidence is refused - the quote is what makes fabrication falsifiable", () => {
  const store = new GateStore(makeProject(), "topic-a");
  assert.throws(() => recordDelegation(store, store.load(), "   "), /verbatim delegating message/);
});

test("delegate: records once, persists, and is visible to a reloaded store", () => {
  const projectRoot = makeProject();
  const delegation = runDelegate(projectRoot, "topic-a", "그냥 끝까지 해줘 /please");
  assert.equal(delegation.evidence, "그냥 끝까지 해줘 /please");
  const reloaded = new GateStore(projectRoot, "topic-a").load();
  assert.equal(reloaded.delegation.evidence, "그냥 끝까지 해줘 /please");
  // A re-invocation supersedes the record instead of stacking.
  runDelegate(projectRoot, "topic-a", "second invocation /please");
  assert.equal(new GateStore(projectRoot, "topic-a").load().delegation.evidence, "second invocation /please");
});

test("cycle cap: non-PASS rounds accumulate across PASS resets, so a stale-re-judge loop reaches a terminal cause", () => {
  const store = new GateStore(makeProject(), "topic-a");
  let state = store.load();
  const budget = 2; // cap = 6
  // Alternate BLOCK/PASS: `attempts` keeps resetting, so budgetExhausted
  // never fires - exactly the measured livelock shape. Only the BLOCK
  // rounds count toward the cap.
  for (let i = 0; i < 12; i += 1) {
    state = recordGateResult(store, state, "gap-audit", outcome(i % 2 === 0 ? "BLOCK" : "PASS"), []);
    assert.equal(gateStatus(state, "gap-audit", budget).budgetExhausted, false);
  }
  const view = gateStatus(state, "gap-audit", budget);
  assert.equal(view.roundsSinceGrant, 6, "only the 6 BLOCK rounds count");
  assert.equal(view.cycleCap, 6);
  assert.equal(view.cycleExhausted, true);
});

test("cycle cap: a healthy always-PASS history never trips (red-team 2026-08-20)", () => {
  const store = new GateStore(makeProject(), "topic-a");
  let state = store.load();
  for (let i = 0; i < 10; i += 1) {
    state = recordGateResult(store, state, "gap-audit", outcome("PASS"), []);
  }
  const view = gateStatus(state, "gap-audit", 2);
  assert.equal(view.roundsSinceGrant, 0);
  assert.equal(view.cycleExhausted, false);
});

test("cycle cap: admission refuses at $0 with its own cause, and records nothing", async () => {
  const projectRoot = makeProject();
  const store = new GateStore(projectRoot, "topic-a");
  const config = loadConfig(projectRoot);
  let state = store.load();
  // BLOCK,BLOCK,PASS cycles: attempts never reaches the fix budget, but the
  // non-PASS rounds accumulate to the cycle cap.
  for (let i = 0; gateStatus(state, "gap-audit", config.judge.retryBudget).roundsSinceGrant < config.judge.retryBudget * 3; i += 1) {
    assert.ok(i < 100, "cycle gauge must reach the cap - saturation here means it stopped counting");
    state = recordGateResult(store, state, "gap-audit", outcome(i % 3 === 2 ? "PASS" : "BLOCK"), []);
  }
  const qaLogPath = path.join(projectRoot, "qa-log.md");
  fs.copyFileSync(path.join(FIXTURES, "qa-clean.md"), qaLogPath);
  const before = JSON.stringify(new GateStore(projectRoot, "topic-a").load());
  const result = await runGapAudit(projectRoot, config, "topic-a", qaLogPath);
  assert.equal(result.ok, false);
  assert.equal(result.zeroJudgeCalls, true);
  assert.equal(result.error.code, "cycle-exhausted");
  assert.match(result.error.message, /not converging/);
  assert.equal(JSON.stringify(new GateStore(projectRoot, "topic-a").load()), before);
});

test("cycle cap: a user grant reopens headroom - rounds before the grant stop counting", () => {
  const store = new GateStore(makeProject(), "topic-a");
  let state = store.load();
  const budget = 2;
  for (let i = 0; i < 12; i += 1) {
    state = recordGateResult(store, state, "gap-audit", outcome(i % 2 === 0 ? "BLOCK" : "PASS"), []);
  }
  assert.equal(gateStatus(state, "gap-audit", budget).cycleExhausted, true);
  state = grantGateBudget(store, state, "gap-audit", "ㅇㅇ 계속 진행해", budget);
  const view = gateStatus(state, "gap-audit", budget);
  assert.equal(view.cycleExhausted, false);
  assert.equal(view.roundsSinceGrant, 0);
});

test("cycle cap: an unjudged gate never trips - the cap gauges rounds, not existence", () => {
  const store = new GateStore(makeProject(), "topic-a");
  const view = gateStatus(store.load(), "gap-audit", 0);
  assert.equal(view.cycleExhausted, false, "budget 0 must not make NOT_RUN terminal");
});
