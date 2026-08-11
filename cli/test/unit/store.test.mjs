import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { freshnessHash, GateStore, gateStatus, overrideGate, recordGateResult, sha256Of } from "../../dist/gates/store.js";

const require = createRequire(import.meta.url);
const { vouchedTreeFingerprint } = require(
  path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "lib", "git.js"),
);

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-store-"));
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
  // Fail-closed, but on the judge's own gauge: the fix budget is untouched
  // because a broken judge produced no findings to fix.
  assert.equal(view.attempts, 0);
  assert.equal(view.consecutiveErrors, 1);
  assert.equal(view.budgetExhausted, false);
  assert.equal(view.judgeErrorLoop, false);
});

test("totalAttempts accumulates across every run while the budget gauge resets on PASS", () => {
  const store = makeStore();
  let state = store.load();
  const fail = () => ({ kind: "verdict", verdict: "FAIL", findings: [], artifactPayload: {} });
  state = recordGateResult(store, state, "verify", fail(), []);
  state = recordGateResult(store, state, "verify", fail(), []);
  state = recordGateResult(store, state, "verify", { kind: "verdict", verdict: "PASS", findings: [], artifactPayload: {} }, []);
  assert.equal(state.gates.verify.attempts, 0, "the retry-budget gauge still resets on PASS");
  assert.equal(state.gates.verify.totalAttempts, 3, "every real run counts, the PASS included");
  // A judge error is a run that spent real work (fail-closed D-15): it counts
  // in the cumulative ledger, but never in the FIX budget - it produced nothing
  // to fix.
  state = recordGateResult(store, state, "verify", { kind: "error", message: "judge broke" }, []);
  assert.equal(state.gates.verify.attempts, 0, "the fix budget is not spent by a judge malfunction");
  assert.equal(state.gates.verify.totalAttempts, 4, "the honest run count still moves");
  assert.equal(state.gates.verify.history.at(-1).verdict, "ERROR", "and the history row is still written");
});

// The measured incident, replayed (2026-08-11, project modakbul, slug
// webhook-to-modakbul-server): 10 verify attempts, 4 of them
// `judge-invalid-output (backend: claude): criteria missing verdicts for AC1,
// AC2, AC3`, and every round that DID answer returned 13/13 criteria PASS - the
// gate never found one real defect, yet the run went BLOCKED three times.
// Both halves of the fix are pinned here: the errors must not spend the fix
// budget, and they must still terminate.
test("a judge-error loop spends no fix budget, keeps the honest record, and still terminates", () => {
  const store = makeStore();
  const budget = 3;
  const judgeError = () => ({ kind: "error", message: "judge-invalid-output (backend: claude): criteria missing verdicts for: AC1, AC2, AC3" });
  let state = store.load();

  // One real FAIL first: this one DID hand the agent findings, so it is the one
  // thing allowed to charge the budget.
  state = recordGateResult(store, state, "verify", { kind: "verdict", verdict: "FAIL", findings: [], artifactPayload: {} }, []);
  assert.equal(gateStatus(state, "verify", budget).attempts, 1);

  for (let i = 1; i <= budget; i += 1) {
    state = recordGateResult(store, state, "verify", judgeError(), []);
    const view = gateStatus(state, "verify", budget);
    assert.equal(view.attempts, 1, `error ${i}: the fix budget stays where the last real verdict left it`);
    assert.equal(view.consecutiveErrors, i, `error ${i}: the error streak is the gauge that moves`);
    assert.equal(view.effective, "BLOCKED", `error ${i}: ERROR is never a PASS`);
    assert.equal(view.budgetExhausted, false, `error ${i}: a receipt must never claim a budget it did not spend`);
    assert.equal(view.judgeErrorLoop, i >= budget, `error ${i}: terminal only once the streak reaches the bound`);
  }

  // Terminal, and distinguishable from the other two causes: attempts read the
  // honest 1/3, so `budgetExhausted` stays false and only `judgeErrorLoop` is
  // set. (`rerunRefused` lives in the gate commands layer and never arms on
  // ERROR - a broken judge says nothing about the tree.)
  const terminal = gateStatus(state, "verify", budget);
  assert.equal(terminal.judgeErrorLoop, true);
  assert.equal(terminal.attempts, 1);
  assert.equal(terminal.budgetExhausted, false);
  assert.equal("rerunRefused" in terminal, false);

  // Every run is still in the ledger: 1 FAIL + 3 ERRORs, none of them lost.
  const record = store.load().gates.verify;
  assert.equal(record.totalAttempts, budget + 1);
  assert.equal(record.history.length, budget + 1);
  assert.equal(record.history.filter((row) => row.verdict === "ERROR").length, budget);
  assert.ok(record.history.at(-1).error.includes("judge-invalid-output"));

  // A judge that answers again clears the streak - including with a FAIL, since
  // what the streak counts is whether the question got answered at all. The
  // next fix round then charges the budget normally.
  state = recordGateResult(store, state, "verify", { kind: "verdict", verdict: "FAIL", findings: [], artifactPayload: {} }, []);
  const recovered = gateStatus(state, "verify", budget);
  assert.equal(recovered.consecutiveErrors, 0);
  assert.equal(recovered.judgeErrorLoop, false);
  assert.equal(recovered.attempts, 2, "the fix budget resumes from where the real verdicts left it");
});

test("a legacy record with no error-streak field is never terminal on the judge-error cause", () => {
  const store = makeStore();
  let state = store.load();
  state = recordGateResult(store, state, "verify", { kind: "error", message: "judge broke" }, []);
  delete state.gates.verify.consecutiveErrors; // a gates.json written before the field existed
  const view = gateStatus(state, "verify", 1, store.projectRoot);
  assert.equal(view.consecutiveErrors, 0);
  assert.equal(view.judgeErrorLoop, false, "no streak recorded, no terminal claim");
  assert.equal(view.effective, "BLOCKED", "still fail-closed on the ERROR verdict itself");
});

test("a stale error streak under a later real verdict cannot fake a judge-error loop", () => {
  const store = makeStore();
  let state = store.load();
  state = recordGateResult(store, state, "verify", { kind: "verdict", verdict: "FAIL", findings: [], artifactPayload: {} }, []);
  // Simulates a mixed-dist write: an older recordGateResult rewrote the verdict
  // without knowing the streak field, stranding it under a verdict it does not
  // describe. Same defensive posture as the short-circuit's stamp-consistency
  // check - the terminal claim needs the verdict to agree.
  state.gates.verify.consecutiveErrors = 9;
  assert.equal(gateStatus(state, "verify", 2).judgeErrorLoop, false);
});

test("a verdict's history row names the tree it was earned on", () => {
  const store = makeStore();
  let state = store.load();
  const fingerprint = { vouched: "abc123", entryCount: 2, mode: "fallback" };
  state = recordGateResult(
    store,
    state,
    "verify",
    { kind: "verdict", verdict: "FAIL", findings: [], artifactPayload: {}, treeFingerprint: fingerprint },
    [],
  );
  assert.deepEqual(state.gates.verify.history.at(-1).treeFingerprint, fingerprint);
});

test("failedStage and diffSource ride the record and history row; PASS and ERROR clear the stage", () => {
  const store = makeStore();
  let state = store.load();
  const fail = { kind: "verdict", verdict: "FAIL", findings: [], artifactPayload: {}, failedStage: "semantic", diffSource: "git:HEAD" };
  state = recordGateResult(store, state, "verify", fail, []);
  assert.equal(state.gates.verify.failedStage, "semantic");
  assert.equal(state.gates.verify.diffSource, "git:HEAD");
  assert.equal(state.gates.verify.history.at(-1).failedStage, "semantic");
  assert.equal(state.gates.verify.history.at(-1).diffSource, "git:HEAD");

  // A PASS never carries a failedStage, even if a caller passes one: a
  // lingering "semantic" under a later record would let the rerun
  // short-circuit refuse on a stage that did not produce it.
  state = recordGateResult(
    store,
    state,
    "verify",
    { kind: "verdict", verdict: "PASS", findings: [], artifactPayload: {}, failedStage: "semantic", diffSource: "git:HEAD" },
    [],
  );
  assert.equal(state.gates.verify.failedStage, undefined);
  assert.equal(state.gates.verify.diffSource, "git:HEAD", "diffSource is provenance, kept on PASS too");
  assert.equal(state.gates.verify.history.at(-1).failedStage, undefined);

  // ERROR is a fact about the judge, not a stage or a diff: both stamps clear.
  state = recordGateResult(store, state, "verify", fail, []);
  state = recordGateResult(store, state, "verify", { kind: "error", message: "judge broke" }, []);
  assert.equal(state.gates.verify.failedStage, undefined);
  assert.equal(state.gates.verify.diffSource, undefined);

  // Round-trip through disk: a rerun in a later process reads the same stamps.
  state = recordGateResult(store, state, "verify", fail, []);
  const reloaded = store.load();
  assert.equal(reloaded.gates.verify.failedStage, "semantic");
  assert.equal(reloaded.gates.verify.diffSource, "git:HEAD");
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

test("a new BLOCK supersedes an earlier override", () => {
  const store = makeStore();
  let state = store.load();
  state = recordGateResult(store, state, "gap-audit", blockOutcome(), []);
  state = overrideGate(store, state, "gap-audit", "temporary user exception");
  state = recordGateResult(store, state, "gap-audit", blockOutcome(), []);
  const view = gateStatus(state, "gap-audit", 3);
  assert.equal(view.effective, "BLOCKED");
  assert.equal(view.overridden, false);
  assert.equal(state.deviations.length, 1, "the historical deviation remains recorded");
});

test("a new judge ERROR supersedes an earlier override", () => {
  const store = makeStore();
  let state = store.load();
  state = recordGateResult(store, state, "gap-audit", blockOutcome(), []);
  state = overrideGate(store, state, "gap-audit", "temporary user exception");
  state = recordGateResult(store, state, "gap-audit", { kind: "error", message: "judge-timeout" }, []);
  const view = gateStatus(state, "gap-audit", 3);
  assert.equal(view.effective, "BLOCKED");
  assert.equal(view.verdict, "ERROR");
  assert.equal(view.overridden, false);
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

test("freshness: a PASS recorded under the previous input contract becomes STALE", () => {
  const store = makeStore();
  const content = "# PRD v1\n";
  fs.writeFileSync(path.join(store.projectRoot, "prd.md"), content);
  const state = recordGateResult(
    store,
    store.load(),
    "spec",
    {
      kind: "verdict",
      verdict: "PASS",
      findings: [],
      inputs: [{ path: "prd.md", sha256: sha256Of(content.trim()) }],
      artifactPayload: {},
    },
    [],
  );
  const view = gateStatus(state, "spec", 2, store.projectRoot);
  assert.equal(view.effective, "STALE");
  assert.deepEqual(view.staleInputs, [{ path: "prd.md", reason: "changed" }]);
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

test("freshness: legacy PASS records without input hashes are STALE and unverifiable", () => {
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
  assert.equal(view.effective, "STALE");
  assert.equal(view.stale, true);
  assert.deepEqual(view.staleInputs, [{ path: "<unrecorded>", reason: "unverifiable" }]);
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

// --- verify-gate tree fingerprint freshness (vouchedTreeFingerprint) ---

function makeGitStore() {
  const store = makeStore();
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: store.projectRoot, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  };
  fs.writeFileSync(path.join(store.projectRoot, "app.js"), "render()\n");
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
  return store;
}

// Mirrors the real verdict flow: the doc input exists, then the fingerprint
// pins the tree, then the verdict is recorded (the gate's own gates.json and
// artifact writes land after the fingerprint, exactly as in runVerifyGate).
function passWithTreeFingerprint(store, treeFingerprint) {
  fs.writeFileSync(path.join(store.projectRoot, "prd.md"), "# PRD v1\n");
  return recordGateResult(
    store,
    store.load(),
    "verify",
    {
      kind: "verdict",
      verdict: "PASS",
      findings: [],
      inputs: [{ path: "prd.md", sha256: freshnessHash("# PRD v1\n") }],
      treeFingerprint:
        treeFingerprint === undefined
          ? vouchedTreeFingerprint({ projectRoot: store.projectRoot, slug: store.topic })
          : treeFingerprint,
      artifactPayload: {},
    },
    [],
  );
}

test("tree freshness: a verify PASS stays live on the unchanged tree and survives a commit of that tree", () => {
  const store = makeGitStore();
  fs.writeFileSync(path.join(store.projectRoot, "app.js"), "render(); persist()\n");
  const state = passWithTreeFingerprint(store);
  assert.equal(gateStatus(state, "verify", 2, store.projectRoot).effective, "PASS");

  // A benign commit of the exact content the PASS was earned on must not
  // stale it: the fingerprint is content-based, not HEAD-based.
  const git = (...args) => spawnSync("git", args, { cwd: store.projectRoot, encoding: "utf8" });
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "land");
  assert.equal(gateStatus(state, "verify", 2, store.projectRoot).effective, "PASS");
});

test("tree freshness: editing code after the PASS turns it STALE; gate bookkeeping does not", () => {
  const store = makeGitStore();
  const state = passWithTreeFingerprint(store);

  // The gate's own artifact/state writes (this store's dir) are bookkeeping.
  fs.mkdirSync(path.join(store.projectRoot, "agents", "gates", store.topic), { recursive: true });
  fs.writeFileSync(path.join(store.projectRoot, "agents", "gates", store.topic, "extra.json"), "{}");
  assert.equal(gateStatus(state, "verify", 2, store.projectRoot).effective, "PASS",
    "gate bookkeeping must never stale the gate (circular invalidation)");

  fs.writeFileSync(path.join(store.projectRoot, "app.js"), "render(); editedAfterPass()\n");
  const view = gateStatus(state, "verify", 2, store.projectRoot);
  assert.equal(view.effective, "STALE");
  assert.ok(view.staleInputs.some((input) => input.path === "<worktree>" && input.reason === "changed"));
});

test("tree freshness: legacy and malformed recorded fingerprints read as STALE, never crash, never PASS", () => {
  for (const legacy of [
    { headSha: "abc123", statusHash: "deadbeef" }, // pre-consolidation shape
    { headSha: null, statusHash: "deadbeef" },
    {},
    "garbage-string",
  ]) {
    const store = makeGitStore();
    const state = passWithTreeFingerprint(store);
    state.gates.verify.treeFingerprint = legacy; // simulate an already-written old gates.json
    const view = gateStatus(state, "verify", 2, store.projectRoot);
    assert.equal(view.effective, "STALE", `${JSON.stringify(legacy)} must downgrade to STALE`);
  }
  // A null fingerprint (non-git project at record time) still skips the check.
  const store = makeGitStore();
  const state = passWithTreeFingerprint(store, null);
  assert.equal(gateStatus(state, "verify", 2, store.projectRoot).effective, "PASS");
});
