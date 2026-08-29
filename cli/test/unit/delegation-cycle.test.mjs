// Standing delegation record + bounded PRD review cycles.
// Measured 2026-08-20: delegated runs lost their assumption mode and PRD
// gates cycled 7-15 times. The product contract now permits one exhaustive
// verdict and, only after BLOCK, one closure verdict. PASS seals the cycle;
// only user-evidenced reopen starts another one (PRINCIPLES 2, 7, 10, 13).
// A reopened blocked cycle keeps its findings ledger so the next round is a
// delta re-judgment, not a fresh exhaustive review (2026-08-29 audit: the
// erased ledger made 5/5 reopened cycles die unconverged, ending in override).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GateStore, gateStatus, recordDelegation, recordGateResult, reopenPrdGate, sha256Of } from "../../dist/gates/store.js";
import { priorFindingsFor, runDelegate, runGapAudit } from "../../dist/gates/commands.js";
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
  const retried = runDelegate(projectRoot, "topic-a", "그냥 끝까지 해줘 /please");
  assert.deepEqual(retried, delegation, "same-value retries preserve the original record and timestamp");
  assert.throws(
    () => runDelegate(projectRoot, "topic-a", "second invocation /please"),
    /already bound.*original invocation/,
  );
  assert.equal(new GateStore(projectRoot, "topic-a").load().delegation.evidence, "그냥 끝까지 해줘 /please");
});

test("a delegated PRD verdict is pinned to the invocation that the judge received", () => {
  const projectRoot = makeProject();
  const store = new GateStore(projectRoot, "topic-a");
  recordDelegation(store, store.load(), "$please first constraint");
  let state = recordGateResult(store, store.load(), "spec", {
    kind: "verdict",
    verdict: "PASS",
    findings: [],
    inputs: [],
    delegationSha256: sha256Of("$please first constraint"),
    artifactPayload: {},
  }, []);

  assert.equal(gateStatus(state, "spec", 3).stale, false);
  state = store.update((current) => {
    current.delegation = { at: new Date().toISOString(), evidence: "$please changed constraint" };
  });
  const changed = gateStatus(state, "spec", 3);
  assert.equal(changed.stale, true);
  assert.deepEqual(changed.staleInputs, [{ path: "<delegated-invocation>", reason: "changed" }]);
});

test("review cycle: a first-pass PASS seals after one semantic round", () => {
  const store = new GateStore(makeProject(), "topic-a");
  let state = store.load();
  state = recordGateResult(store, state, "gap-audit", outcome("PASS"), []);
  const view = gateStatus(state, "gap-audit", 5);
  assert.equal(view.reviewPhase, "sealed");
  assert.equal(view.reviewRound, 1);
  assert.equal(view.sealed, true);
});

test("review cycle: BLOCK opens one closure round and closure PASS seals", () => {
  const store = new GateStore(makeProject(), "topic-a");
  let state = store.load();
  state = recordGateResult(store, state, "spec", outcome("BLOCK"), []);
  assert.equal(gateStatus(state, "spec", 5).reviewPhase, "closure");
  state = recordGateResult(store, state, "spec", outcome("PASS"), []);
  const view = gateStatus(state, "spec", 5);
  assert.equal(view.reviewPhase, "sealed");
  assert.equal(view.reviewRound, 2);
});

test("review cycle: closure BLOCK is terminal and a third command costs zero judge calls", async () => {
  const projectRoot = makeProject();
  const store = new GateStore(projectRoot, "topic-a");
  const config = loadConfig(projectRoot);
  let state = store.load();
  state = recordGateResult(store, state, "gap-audit", outcome("BLOCK"), []);
  state = recordGateResult(store, state, "gap-audit", outcome("BLOCK"), []);
  const qaLogPath = path.join(projectRoot, "qa-log.md");
  fs.copyFileSync(path.join(FIXTURES, "qa-clean.md"), qaLogPath);
  const before = JSON.stringify(new GateStore(projectRoot, "topic-a").load());
  const result = await runGapAudit(projectRoot, config, "topic-a", qaLogPath);
  assert.equal(result.ok, false);
  assert.equal(result.zeroJudgeCalls, true);
  assert.equal(result.error.code, "closure-exhausted");
  assert.match(result.error.message, /no judge was called/);
  assert.equal(JSON.stringify(new GateStore(projectRoot, "topic-a").load()), before);
});

test("review cycle: user-evidenced reopen starts a fresh cycle and preserves its ledger", () => {
  const store = new GateStore(makeProject(), "topic-a");
  let state = store.load();
  state = recordGateResult(store, state, "gap-audit", outcome("BLOCK"), []);
  state = recordGateResult(store, state, "gap-audit", outcome("BLOCK"), []);
  state = reopenPrdGate(store, "gap-audit", "요구사항을 바꿨으니 다시 봐줘");
  const view = gateStatus(state, "gap-audit", 5);
  assert.equal(view.reviewCycle, 2);
  assert.equal(view.reviewPhase, "full");
  assert.equal(view.reviewRound, 0);
  assert.equal(view.effective, "NOT_RUN");
  assert.equal(state.gates["gap-audit"].reviewReopens[0].evidence, "요구사항을 바꿨으니 다시 봐줘");
});

test("review cycle: reopening a blocked cycle carries its findings as the delta ledger", () => {
  const store = new GateStore(makeProject(), "topic-a");
  let state = store.load();
  state = recordGateResult(store, state, "gap-audit", outcome("BLOCK"), []);
  state = recordGateResult(store, state, "gap-audit", outcome("BLOCK"), []);
  state = reopenPrdGate(store, "gap-audit", "그 지적들 반영했으니 다시 봐줘");
  assert.deepEqual(state.gates["gap-audit"].findings, [FINDING]);
  assert.deepEqual(
    priorFindingsFor(state, "gap-audit"),
    [{ severity: FINDING.severity, area: FINDING.area, missing: FINDING.missing }],
    "the carried ledger reaches the next round's judge even though the verdict was reset",
  );
});

test("review cycle: demoted P2 advisories never re-enter the ledger with blocking eligibility", () => {
  const store = new GateStore(makeProject(), "topic-a");
  let state = store.load();
  state = recordGateResult(store, state, "gap-audit", {
    kind: "verdict",
    verdict: "BLOCK",
    findings: [
      FINDING,
      { area: "scope", severity: "P2", missing: "demoted", recommendation: "[auto-demoted] r", requiresHuman: false },
    ],
    artifactPayload: {},
  }, []);
  assert.deepEqual(
    priorFindingsFor(state, "gap-audit").map((f) => f.area),
    [FINDING.area],
    "only blocking-grade findings carry; a P2 that could not block must not resurrect as prior-unresolved",
  );
});

test("review cycle: reopening a sealed cycle carries no findings forward", () => {
  const store = new GateStore(makeProject(), "topic-a");
  let state = store.load();
  state = recordGateResult(store, state, "gap-audit", {
    kind: "verdict",
    verdict: "PASS",
    findings: [{ ...FINDING, severity: "P2", requiresHuman: false }],
    artifactPayload: {},
  }, []);
  state = reopenPrdGate(store, "gap-audit", "한 가지만 더 추가하자");
  assert.deepEqual(state.gates["gap-audit"].findings, []);
  assert.equal(gateStatus(state, "gap-audit", 5).reviewCycle, 2);
});

test("review cycle: reopen is refused before a cycle is terminal", () => {
  const store = new GateStore(makeProject(), "topic-a");
  assert.throws(() => reopenPrdGate(store, "gap-audit", "다시 봐줘"), /not terminal/);
});
