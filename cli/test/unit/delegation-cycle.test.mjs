// Standing delegation record + PRD review cycles.
// Measured 2026-08-20: delegated runs lost their assumption mode and PRD
// gates cycled 7-15 times. The round budget that replaced that loop was
// retired in turn (PRD gate-loop R2, 2026-09-03: every recorded reopen was a
// button press, not a decision); the loop is now bounded by the open
// findings set, which a rerun can only shrink. PASS seals the cycle; only a
// user-evidenced reopen starts another one, and it keeps the open set so the
// next round is a delta re-judgment (2026-08-29 audit: an erased ledger made
// 5/5 reopened cycles die unconverged, ending in override).
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

test("review cycle: a PASS seals, a BLOCK stays open, and no round count exists", () => {
  const store = new GateStore(makeProject(), "topic-a");
  let state = store.load();
  state = recordGateResult(store, state, "spec", outcome("BLOCK"), []);
  let view = gateStatus(state, "spec", 5);
  assert.equal(view.sealed, false);
  assert.equal(view.effective, "BLOCKED");
  assert.equal(view.reviewCycle, 1);
  state = recordGateResult(store, state, "spec", outcome("BLOCK"), []);
  state = recordGateResult(store, state, "spec", outcome("BLOCK"), []);
  assert.equal(gateStatus(state, "spec", 5).effective, "BLOCKED", "a third BLOCK is just another round");
  state = recordGateResult(store, state, "spec", outcome("PASS"), []);
  view = gateStatus(state, "spec", 5);
  assert.equal(view.sealed, true);
  assert.equal(view.effective, "PASS");
  assert.equal("reviewRound" in view, false);
  assert.equal("closureExhausted" in view, false);
});

test("review cycle: a sealed PASS is cached and a further gate command costs zero judge calls", async () => {
  const projectRoot = makeProject();
  const store = new GateStore(projectRoot, "topic-a");
  const config = loadConfig(projectRoot);
  const qaLogPath = path.join(projectRoot, "qa-log.md");
  fs.copyFileSync(path.join(FIXTURES, "qa-clean.md"), qaLogPath);
  const { hashGateInput } = await import("../../dist/gates/store.js");
  let state = store.load();
  state = recordGateResult(store, state, "gap-audit", {
    ...outcome("PASS"),
    inputs: [{ path: "qa-log.md", sha256: hashGateInput(qaLogPath, "qa-log"), kind: "qa-log" }],
  }, []);
  const before = JSON.stringify(new GateStore(projectRoot, "topic-a").load());
  const result = await runGapAudit(projectRoot, config, "topic-a", qaLogPath);
  assert.equal(result.ok, true);
  assert.equal(result.zeroJudgeCalls, true);
  assert.equal(JSON.stringify(new GateStore(projectRoot, "topic-a").load()), before);
});

test("review cycle: user-evidenced reopen opens the next cycle from any judged verdict and keeps the open set", () => {
  const store = new GateStore(makeProject(), "topic-a");
  let state = store.load();
  state = recordGateResult(store, state, "gap-audit", outcome("BLOCK"), []);
  state = reopenPrdGate(store, "gap-audit", "요구사항을 바꿨으니 다시 봐줘");
  const view = gateStatus(state, "gap-audit", 5);
  assert.equal(view.reviewCycle, 2);
  assert.equal(view.sealed, false);
  assert.equal(view.effective, "NOT_RUN");
  assert.equal(state.gates["gap-audit"].reviewReopens[0].evidence, "요구사항을 바꿨으니 다시 봐줘");
  assert.equal(state.gates["gap-audit"].reviewReopens[0].verdictBefore, "BLOCK");
  assert.deepEqual(state.gates["gap-audit"].findings.map((f) => f.id), ["F1"], "the open set survives the reopen");
  assert.deepEqual(
    priorFindingsFor(state, "gap-audit"),
    [{ id: "F1", severity: FINDING.severity, area: FINDING.area, missing: FINDING.missing }],
    "the carried set reaches the next round's judge even though the verdict was reset",
  );
});

test("review cycle: warnings never re-enter the open set on a reopen", () => {
  const store = new GateStore(makeProject(), "topic-a");
  let state = store.load();
  state = recordGateResult(store, state, "gap-audit", {
    kind: "verdict",
    verdict: "BLOCK",
    findings: [FINDING],
    warnings: [{ area: "scope", severity: "P2", missing: "advisory", recommendation: "r", requiresHuman: false }],
    artifactPayload: {},
  }, []);
  state = reopenPrdGate(store, "gap-audit", "그 지적들 반영했으니 다시 봐줘");
  assert.deepEqual(priorFindingsFor(state, "gap-audit").map((f) => f.area), [FINDING.area]);
});

test("review cycle: reopening a sealed PASS succeeds and carries an empty open set", () => {
  const store = new GateStore(makeProject(), "topic-a");
  let state = store.load();
  state = recordGateResult(store, state, "gap-audit", { ...outcome("PASS"), warnings: [{ ...FINDING, severity: "P2", requiresHuman: false }] }, []);
  state = reopenPrdGate(store, "gap-audit", "한 가지만 더 추가하자");
  assert.deepEqual(state.gates["gap-audit"].findings, []);
  assert.equal(state.gates["gap-audit"].reviewReopens[0].verdictBefore, "PASS");
  assert.equal(gateStatus(state, "gap-audit", 5).reviewCycle, 2);
});

test("review cycle: reopen is refused before any verdict exists", () => {
  const store = new GateStore(makeProject(), "topic-a");
  assert.throws(() => reopenPrdGate(store, "gap-audit", "다시 봐줘"), /no judged verdict to reopen/);
});
