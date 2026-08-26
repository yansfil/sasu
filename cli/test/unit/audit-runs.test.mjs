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
import { GateStore, freshnessHash, recordGateResult, grantGateBudget } from "../../dist/gates/store.js";
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
  const inputPath = `${slug}-${gate}.md`;
  fs.writeFileSync(path.join(dir, inputPath), "stable input\n");
  let state = store.load();
  for (const v of verdicts) {
    state = recordGateResult(store, state, gate, {
      ...outcome(v),
      inputs: [{ path: inputPath, sha256: freshnessHash("stable input\n"), kind: "document" }],
    }, []);
  }
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
  // A legacy gates.json with 6 BLOCKs, PASS, 5 BLOCKs - the historical shape
  // the new writer prevents but the read-only auditor must still diagnose.
  const store = new GateStore(dir, "livelock");
  let state = recordGateResult(store, store.load(), "gap-audit", outcome("PASS"), []);
  const row = state.gates["gap-audit"].history[0];
  const verdicts = ["BLOCK", "BLOCK", "BLOCK", "BLOCK", "BLOCK", "BLOCK", "PASS", "BLOCK", "BLOCK", "BLOCK", "BLOCK", "BLOCK"];
  state.gates["gap-audit"].history = verdicts.map((verdict, index) => ({ ...row, verdict, at: new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString() }));
  state.gates["gap-audit"].verdict = "BLOCK";
  state.gates["gap-audit"].totalAttempts = verdicts.length;
  state.gates["gap-audit"].totalNonPassAttempts = verdicts.filter((verdict) => verdict !== "PASS").length;
  state.gates["gap-audit"].budgetGrants = [{ at: row.at, evidence: "keep going", attemptCountBefore: 5, nonPassCountBefore: 5 }];
  delete state.gates["gap-audit"].review;
  store.save(state);
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
  store2.save(s2);
  s2 = recordGateResult(store2, s2, "gap-audit", outcome("BLOCK"), []);
  fs.writeFileSync(path.join(dir2, "agents", "runs", "delegated", "state.json"), JSON.stringify({ schema: 3, status: "in_progress", prd: { approval: { source: "conversation", evidence: "x" } } }));
  const result2 = runAudit(dir2, config);
  assert.equal(result2.findings.some((f) => f.rule === "delegation-not-recorded"), false);
});

test("ledger: a fingerprint is reported once, tracked afterwards, and --include-seen re-prints it", () => {
  const dir = makeProject();
  const config = loadConfig(dir);
  const store = new GateStore(dir, "grants");
  let state = store.load();
  for (let i = 0; i < config.judge.retryBudget; i += 1) {
    state = recordGateResult(store, state, "spec", {
      kind: "error",
      message: "backend down",
      cause: { code: "judge-auth-or-runtime", backend: "codex", reason: "turn-failed" },
    }, []);
  }
  grantGateBudget(store, state, "spec", "backend fixed; go on", config.judge.retryBudget);

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

/** Gives a single-round gate real judge timing; its verdict timestamp span stays zero. */
function stampSingleRoundJudgeDuration(dir, slug, minutes) {
  const file = path.join(dir, "agents", "runs", slug, "gates", "gates.json");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  const passRound = state.gates["gap-audit"].history[0];
  const artifact = JSON.parse(fs.readFileSync(path.join(dir, passRound.artifact), "utf8"));
  artifact.judge = { durationMs: minutes * 60_000 };
  fs.writeFileSync(path.join(dir, passRound.artifact), JSON.stringify(artifact));
  fs.writeFileSync(file, JSON.stringify(state));
}

test("timelines report unconditionally, even on a run with zero findings", () => {
  const dir = makeProject();
  record(dir, "quiet", "gap-audit", ["PASS"]);
  const config = loadConfig(dir);
  const result = runAudit(dir, config);
  assert.equal(result.findings.length, 0, "no rule tripped");
  assert.equal(result.timelines.length, 1, "the timeline is still reported");
  assert.equal(result.timelines[0].slug, "quiet");
  assert.equal(result.timelines[0].gate, "gap-audit");
  assert.equal(result.timelines[0].verdict, "PASS");
  assert.equal(result.timelines[0].rounds, 1);
});

test("timeline keeps the post-PASS tail visible instead of ending at first PASS", () => {
  const dir = makeProject();
  const store = new GateStore(dir, "tail");
  const state = recordGateResult(store, store.load(), "gap-audit", outcome("PASS"), []);
  const row = state.gates["gap-audit"].history[0];
  const start = new Date("2026-08-01T00:00:00.000Z");
  state.gates["gap-audit"].history = [
    { ...row, verdict: "BLOCK", at: start.toISOString() },
    { ...row, verdict: "PASS", at: new Date(start.getTime() + 5 * 60_000).toISOString() },
    { ...row, verdict: "BLOCK", at: new Date(start.getTime() + 20 * 60_000).toISOString() },
  ];
  state.gates["gap-audit"].verdict = "BLOCK";
  state.gates["gap-audit"].totalAttempts = 3;
  state.gates["gap-audit"].totalNonPassAttempts = 2;
  delete state.gates["gap-audit"].review;
  store.save(state);
  const result = runAudit(dir, loadConfig(dir), { includeSeen: true });
  const timeline = result.timelines[0];
  assert.equal(timeline.firstPassDurationMinutes, 5);
  assert.equal(timeline.durationMinutes, 20, "the 15-minute post-PASS tail remains visible");
  assert.ok(result.findings.some((finding) => finding.rule === "post-pass-reblock"), "one post-PASS reblock now trips the rule");
});

test("slow-gate-timeline: a gate 3x+ this scan's median for its type fires even with a healthy round count", () => {
  const dir = makeProject();
  const config = loadConfig(dir);
  // Four single-round PASSes: three fast, one 6x the group's median. Verdict
  // timestamps alone are all 0-minute spans; artifact judge timing catches it.
  for (const slug of ["fast-a", "fast-b", "fast-c", "slow-one"]) {
    record(dir, slug, "gap-audit", ["PASS"]);
  }
  stampSingleRoundJudgeDuration(dir, "fast-a", 5);
  stampSingleRoundJudgeDuration(dir, "fast-b", 5);
  stampSingleRoundJudgeDuration(dir, "fast-c", 5);
  stampSingleRoundJudgeDuration(dir, "slow-one", 30);

  const result = runAudit(dir, config, { includeSeen: true });
  const hit = result.findings.find((f) => f.rule === "slow-gate-timeline" && f.slug === "slow-one");
  assert.ok(hit, result.findings.map((f) => `${f.slug}:${f.rule}`).join(","));
  assert.equal(hit.classification, "design-question");
  assert.deepEqual(hit.principles, [2, 9]);
  assert.equal(hit.evidence.ratio, 6);
  assert.equal(result.findings.some((f) => f.rule === "slow-gate-timeline" && f.slug !== "slow-one"), false, "the fast ones must not also fire");
});

test("slow-gate-timeline needs at least 3 same-gate samples before computing a median", () => {
  const dir = makeProject();
  const config = loadConfig(dir);
  record(dir, "alone-a", "gap-audit", ["PASS"]);
  record(dir, "alone-b", "gap-audit", ["PASS"]);
  stampSingleRoundJudgeDuration(dir, "alone-a", 5);
  stampSingleRoundJudgeDuration(dir, "alone-b", 60);
  const result = runAudit(dir, config, { includeSeen: true });
  assert.equal(result.findings.some((f) => f.rule === "slow-gate-timeline"), false, "only 2 samples - no baseline yet");
});
