// L1 run auditor: deterministic rules over recorded gate state, plus the
// fingerprint ledger that makes the auditing loop itself converge
// (PRINCIPLES item 13 applied to the auditor). Each rule fires on a synthetic
// run shaped like the real 2026-08-20 incidents and stays silent on a
// healthy run.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAudit } from "../../dist/audit/runs.js";
import { GateStore, recordGateResult, grantGateBudget } from "../../dist/gates/store.js";
import { loadConfig } from "../../dist/config.js";

const FINDING = { area: "data", severity: "P1", missing: "m", recommendation: "r", requiresHuman: true };

function outcome(verdict) {
  return { kind: "verdict", verdict, findings: verdict === "PASS" ? [] : [FINDING], artifactPayload: {} };
}

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-audit-"));
  fs.mkdirSync(path.join(dir, "agents", "runs"), { recursive: true });
  return dir;
}

function record(dir, slug, gate, verdicts) {
  const store = new GateStore(dir, slug);
  let state = store.load();
  for (const v of verdicts) state = recordGateResult(store, state, gate, outcome(v), []);
  return state;
}

test("healthy run: first-try PASSes produce zero findings", () => {
  const dir = makeProject();
  record(dir, "healthy", "gap-audit", ["PASS"]);
  const config = loadConfig(dir);
  const result = runAudit(dir, config);
  assert.deepEqual(result.findings, []);
  assert.equal(result.newFindings, 0);
});

test("excessive-rounds and post-pass-reblock fire on the measured livelock shape", () => {
  const dir = makeProject();
  const config = loadConfig(dir);
  // 6 BLOCKs, PASS, 4 BLOCKs - the ai-creators-night-waitlist shape.
  const store = new GateStore(dir, "livelock");
  let state = store.load();
  for (const v of ["BLOCK", "BLOCK", "BLOCK", "BLOCK", "BLOCK", "PASS", "BLOCK", "BLOCK", "BLOCK", "BLOCK", "BLOCK", "BLOCK"]) {
    if (state.gates["gap-audit"].attempts >= config.judge.retryBudget) {
      state = grantGateBudget(store, state, "gap-audit", "keep going", config.judge.retryBudget);
    }
    state = recordGateResult(store, state, "gap-audit", outcome(v), []);
  }
  const result = runAudit(dir, config);
  const rules = result.findings.map((f) => f.rule).sort();
  assert.ok(rules.includes("excessive-rounds"), rules.join(","));
  assert.ok(rules.includes("post-pass-reblock"), rules.join(","));
  assert.ok(rules.includes("budget-grant-used"), rules.join(","));
  const excessive = result.findings.find((f) => f.rule === "excessive-rounds");
  assert.equal(excessive.classification, "design-question");
  assert.deepEqual(excessive.principles, [2, 13]);
});

test("delegation-not-recorded fires only for a conversation-approved run without a stored delegation", () => {
  const dir = makeProject();
  const config = loadConfig(dir);
  record(dir, "delegated", "gap-audit", ["BLOCK", "PASS"]);
  // Implement state marking the run as conversation-approved ($please).
  const stateFile = path.join(dir, "agents", "runs", "delegated", "state.json");
  fs.writeFileSync(stateFile, JSON.stringify({ schema: 3, status: "in_progress", prd: { approval: { source: "conversation", evidence: "그냥 끝까지 해줘 /please" } } }));
  const result = runAudit(dir, config);
  const hit = result.findings.find((f) => f.rule === "delegation-not-recorded");
  assert.ok(hit, result.findings.map((f) => f.rule).join(","));
  assert.equal(hit.classification, "mechanical-fix-candidate");

  // Same shape WITH a stored delegation: rule stays silent.
  const dir2 = makeProject();
  const store2 = new GateStore(dir2, "delegated");
  let s2 = store2.load();
  s2.delegation = { at: new Date().toISOString(), evidence: "그냥 끝까지 해줘 /please" };
  s2 = recordGateResult(store2, s2, "gap-audit", outcome("BLOCK"), []);
  fs.writeFileSync(path.join(dir2, "agents", "runs", "delegated", "state.json"), JSON.stringify({ schema: 3, status: "in_progress", prd: { approval: { source: "conversation", evidence: "x" } } }));
  const result2 = runAudit(dir2, config);
  assert.equal(result2.findings.some((f) => f.rule === "delegation-not-recorded"), false);
});

test("ledger: a fingerprint is reported once, tracked afterwards, and --include-seen re-prints it", () => {
  const dir = makeProject();
  const config = loadConfig(dir);
  record(dir, "grants", "spec", ["BLOCK", "BLOCK", "BLOCK", "BLOCK", "BLOCK"]);
  const store = new GateStore(dir, "grants");
  grantGateBudget(store, store.load(), "spec", "go on", config.judge.retryBudget);

  const first = runAudit(dir, config);
  assert.ok(first.newFindings > 0);
  const second = runAudit(dir, config);
  assert.equal(second.newFindings, 0, "second sweep converges");
  assert.deepEqual(second.findings, [], "tracked findings are not re-reported by default");
  const third = runAudit(dir, config, { includeSeen: true });
  assert.ok(third.findings.length > 0);
  assert.ok(third.findings.every((f) => f.seen === true));

  const ledger = JSON.parse(fs.readFileSync(path.join(dir, "agents", "runs", ".audit", "ledger.json"), "utf8"));
  for (const entry of Object.values(ledger.findings)) assert.equal(entry.status, "reported");
});
